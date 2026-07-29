import json, urllib.request, urllib.error, time, subprocess, sys, re, io, os, shutil, tempfile
from datetime import datetime

# Fix encoding for Windows console (skip in headless/pythonw mode)
if sys.stdout and sys.stdout.buffer:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
if sys.stderr and sys.stderr.buffer:
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ── Telegram credentials — lazy, from _platform_config ──
# These are set to None at import time; real values loaded on listener start.
TOKEN = None
CHAT_ID = 0
API = ""

def _init_telegram():
    global TOKEN, CHAT_ID, API
    token, chat_id = _plat_cfg.get_telegram_credentials() if _plat_cfg else (None, None)
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not configured")
    TOKEN = token
    CHAT_ID = chat_id
    API = f"https://api.telegram.org/bot{TOKEN}"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PUSH_SCRIPT = os.path.join(SCRIPT_DIR, "push_update.py")
PUSH_EN_SCRIPT = os.path.join(SCRIPT_DIR, "push_update_en.py")
LOG_FILE = os.path.join(SCRIPT_DIR, "bot_log.txt")
LOCK_FILE = os.path.join(tempfile.gettempdir(), "bot_listener_lock.txt")
HEARTBEAT_FILE = os.path.join(tempfile.gettempdir(), "bot_heartbeat.txt")
LAST_PUSH_DATE_FILE = os.path.join(SCRIPT_DIR, "_last_auto_push.txt")
LAST_WEEKLY_DATE_FILE = os.path.join(SCRIPT_DIR, "_last_weekly_push.txt")
LAST_MONTHLY_DATE_FILE = os.path.join(SCRIPT_DIR, "_last_monthly_push.txt")
sys.path.insert(0, SCRIPT_DIR)
try:
    import _bot_data
except ImportError as e:
    _bot_data = None
    print(f"Warning: _bot_data not available: {e}")

# ── Platform config ──
try:
    import _platform_config as _plat_cfg
except ImportError as e:
    _plat_cfg = None
    print(f"Warning: _platform_config not available: {e}")


def acquire_lock():
    """Prevent multiple bot instances from running simultaneously."""
    if os.path.exists(LOCK_FILE):
        with open(LOCK_FILE, "r") as f:
            old_pid = f.read().strip()
        try:
            import ctypes
            PROC_CODE = ctypes.c_ulong()
            h = ctypes.windll.kernel32.OpenProcess(0x0400, False, int(old_pid))
            if h:
                ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(PROC_CODE))
                ctypes.windll.kernel32.CloseHandle(h)
                if PROC_CODE.value == 259:  # STILL_ACTIVE
                    log(f"已有 Bot 实例在运行 (PID {old_pid})，退出")
                    return False
        except Exception:
            pass
    with open(LOCK_FILE, "w") as f:
        f.write(str(os.getpid()))
    return True


def release_lock():
    try:
        if os.path.exists(LOCK_FILE):
            os.remove(LOCK_FILE)
    except Exception:
        pass


def log(msg):
    with open(LOG_FILE, "a", encoding="utf-8") as lf:
        lf.write(f"[{datetime.now()}] {msg}\n")
    print(f"[{datetime.now()}] {msg}")


def write_heartbeat():
    try:
        with open(HEARTBEAT_FILE, "w") as f:
            f.write(datetime.now().isoformat())
    except Exception:
        pass


def check_scheduled_push():
    """Check if it's time for the daily/weekly/monthly scheduled push. Returns True if any push was done."""
    try:
        cfg = load_config()
        push_time = cfg.get("schedule", {}).get("daily_push_time", "21:07")
        now = datetime.now()
        current_time = now.strftime("%H:%M")
        today = now.strftime("%Y-%m-%d")

        pushed = False

        # ── Daily push at configured time ──
        if current_time == push_time:
            if not os.path.exists(LAST_PUSH_DATE_FILE):
                os.makedirs(os.path.dirname(LAST_PUSH_DATE_FILE), exist_ok=True)
            with open(LAST_PUSH_DATE_FILE, "a+") as f:
                f.seek(0)
                last_date = f.read().strip()
            if last_date != today:
                with open(LAST_PUSH_DATE_FILE, "w") as f:
                    f.write(today)
                log(f"Scheduled daily push triggered at {current_time}")
                output = run_push()
                log(f"Scheduled push done: {output[:200]}")
                pushed = True
                _post_push_actions()

        # ── Weekly report: Monday 09:07 ──
        if now.weekday() == 0 and current_time == "09:07":
            if not os.path.exists(LAST_WEEKLY_DATE_FILE):
                os.makedirs(os.path.dirname(LAST_WEEKLY_DATE_FILE), exist_ok=True)
            with open(LAST_WEEKLY_DATE_FILE, "a+") as f:
                f.seek(0)
                last_weekly = f.read().strip()
            if last_weekly != today:
                with open(LAST_WEEKLY_DATE_FILE, "w") as f:
                    f.write(today)
                log(f"Weekly report triggered")
                send_message("📊 本周一自动周报，正在生成上周数据...")
                output = run_push(date=(now.replace(day=now.day-7)).strftime("%Y-%m-%d"))
                log(f"Weekly push done: {output[:200]}")
                pushed = True

        # ── Monthly report: 1st of month at 09:13 ──
        if now.day == 1 and current_time == "09:13":
            if not os.path.exists(LAST_MONTHLY_DATE_FILE):
                os.makedirs(os.path.dirname(LAST_MONTHLY_DATE_FILE), exist_ok=True)
            with open(LAST_MONTHLY_DATE_FILE, "a+") as f:
                f.seek(0)
                last_monthly = f.read().strip()
            if last_monthly != today:
                with open(LAST_MONTHLY_DATE_FILE, "w") as f:
                    f.write(today)
                log(f"Monthly report triggered")
                send_message("📆 本月首日自动月报，正在生成上月汇总...")
                prev_month = f"{now.year}-{now.month-1:02d}" if now.month > 1 else f"{now.year-1}-12"
                output = run_push(month=prev_month)
                log(f"Monthly push done: {output[:200]}")
                pushed = True

        return pushed
    except Exception as e:
        log(f"Scheduled push error: {e}")
        return False


def _post_push_actions():
    """Actions to run after any push: anomaly alerts + pin summary."""
    try:
        _send_anomaly_alerts()
    except Exception as e:
        log(f"Anomaly alert error: {e}")
    try:
        _pin_push_summary()
    except Exception as e:
        log(f"Pin summary error: {e}")


def _send_anomaly_alerts():
    """After push, check data for anomalies and send alerts."""
    if _bot_data is None:
        return
    data = _bot_data.get_today_data()
    if not data:
        return
    alerts = _bot_data.get_anomaly_alerts(data)
    if alerts:
        msg = "⚠️ <b>异常告警</b>\n" + "\n".join(alerts)
        send_message(msg)
    else:
        log("Anomaly check: all sites OK")


def _pin_push_summary():
    """Pin a short summary message after push."""
    if _bot_data is None:
        return
    data = _bot_data.get_today_data()
    if not data:
        return
    summary = _bot_data.get_push_summary_text(data)
    result = send_message(summary)
    # Try to pin the message if it was sent successfully
    if result.get("ok") and result.get("result"):
        msg_id = result["result"]["message_id"]
        api_call("pinChatMessage", {"chat_id": CHAT_ID, "message_id": msg_id, "disable_notification": True})


PUSH_HIJACK_SCRIPT = os.path.join(SCRIPT_DIR, "push_hijack.py")

def _send_photo_file(filepath, caption=None):
    """Send a PNG image file to Telegram. Uses existing stable multipart format."""
    if not os.path.isfile(filepath):
        log(f"send_photo_file: file not found: {filepath}")
        return False
    boundary = "----WebKitFormBoundary" + os.urandom(8).hex()
    body = io.BytesIO()
    body.write(f"--{boundary}\r\n".encode())
    body.write(f'Content-Disposition: form-data; name="chat_id"\r\n\r\n'.encode())
    body.write(f"{CHAT_ID}\r\n".encode())
    if caption:
        body.write(f"--{boundary}\r\n".encode())
        body.write(f'Content-Disposition: form-data; name="caption"\r\n\r\n'.encode())
        body.write(f"{caption}\r\n".encode('utf-8'))
    body.write(f"--{boundary}\r\n".encode())
    body.write(f'Content-Disposition: form-data; name="photo"; filename="screenshot.png"\r\n'.encode())
    body.write(f"Content-Type: image/png\r\n\r\n".encode())
    with open(filepath, "rb") as f:
        body.write(f.read())
    body.write(f"\r\n--{boundary}--\r\n".encode())
    body.seek(0)
    url = f"{API}/sendPhoto"
    req = urllib.request.Request(url, data=body.read(),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read()).get("ok", False)
    except Exception as e:
        log(f"send_photo_file error: {e}")
        return False


def _send_hijack_comparison(target_date=None, dry_run=False):
    """Generate and send PH33 comparison combined image.
    Args: target_date='2026-07-26' or None (uses today).
    Returns dict with result details."""
    import hijack_comparison_push as hcp
    from datetime import datetime as _dt
    if target_date is None:
        target_date = _dt.now().strftime('%Y-%m-%d')

    result = {"success": False, "dry_run": dry_run, "target_date": target_date, "steps": []}

    ok, err, img_bytes, caption, meta = hcp.generate_hijack_comparison(target_date)
    if not ok:
        result["error"] = err
        if not dry_run: send_message(f"PH33对比生成失败: {err}")
        return result

    fpath = os.path.join(SCRIPT_DIR, 'data', 'generated', f'hijack_compare_{target_date}.png')
    os.makedirs(os.path.dirname(fpath), exist_ok=True)
    with open(fpath, 'wb') as f: f.write(img_bytes)

    result["steps"].append({
        "order": 2, "type": "hijack_comparison",
        "path": fpath, "size": len(img_bytes),
        "month_available": meta.get("month_available"),
        "sent": False
    })

    if not dry_run:
        sent = _send_photo_file(fpath, caption)
        result["steps"][-1]["sent"] = sent
        if not sent:
            send_message(f"⚠️ PH33对比图发送失败")

    result["success"] = True
    return result


def run_en_push():
    """Run the English version push script."""
    try:
        cmd = [sys.executable, PUSH_EN_SCRIPT]
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120,
            cwd=SCRIPT_DIR
        )
        return result.stdout.strip()
    except Exception as e:
        return f"EN push failed: {e}"


def run_hijack_push(mode="data", dry_run=False, target_date=None):
    """Run the hijack push script. Returns unified dict with steps.
    dry_run=True: generates images via --dry-run flag, no Telegram API calls."""
    if not dry_run and not TOKEN:
        _init_telegram()
    try:
        def _run_summary_only():
            """Run push_hijack.py hijack --summary-only --output-json. Returns parsed JSON dict."""
            cmd = [sys.executable, PUSH_HIJACK_SCRIPT, "hijack",
                   "--summary-only", "--output-json"]
            if dry_run:
                cmd.append("--dry-run")
            if target_date:
                cmd.extend(["--target-date", target_date])
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, cwd=SCRIPT_DIR)
            out = r.stdout.strip()
            if r.returncode != 0 and "only available on Windows" in (out + r.stderr):
                return {"success": False, "error": "此功能仅支持 Windows", "raw": out}
            try:
                import json as _json
                return _json.loads(out)
            except Exception:
                return {"success": False, "error": f"JSON parse failed (exit {r.returncode})", "raw": out[:200]}

        if target_date is None:
            from datetime import datetime as _dt
            target_date = _dt.now().strftime('%Y-%m-%d')

        base_result = {"success": True, "dry_run": dry_run, "target_date": target_date, "steps": []}

        def _add_step(order, stype, path=None, size=None, sent=False, **extra):
            step = {"order": order, "type": stype, "sent": sent}
            if path: step["path"] = path
            if size: step["size"] = size
            step.update(extra)
            base_result["steps"].append(step)

        if mode == "hijack":
            # ── Phase 1: Generate ALL assets first ──
            sum_result = _run_summary_only()
            if not sum_result.get("success"):
                base_result["success"] = False
                base_result["error"] = sum_result.get("error", "unknown")
                return base_result

            sd = sum_result.get("summary", {})
            ss_path = sd.get("path", "")
            ss_size = sd.get("size", 0) if sd.get("size") else 0
            xlsx_path = sum_result.get("xlsx", {}).get("path", "")

            comp = _send_hijack_comparison(target_date=target_date, dry_run=True)  # Always generate, never send here
            comp_ok = comp.get("success", False)

            # Verify all assets exist before any send
            missing = []
            if not ss_path or not os.path.isfile(ss_path): missing.append("summary")
            if comp_ok:
                for cs in comp.get("steps", []):
                    cp = cs.get("path", "")
                    if cp and not os.path.isfile(cp): missing.append(cs.get("type", "comparison"))
            else:
                missing.append("comparison")
            if not xlsx_path or not os.path.isfile(xlsx_path): missing.append("xlsx")

            if missing and not dry_run:
                base_result["success"] = False
                base_result["error"] = f"Preflight failed — missing: {', '.join(missing)}"
                log(f"PH33 push preflight failed: {missing}")
                return base_result

            # ── Phase 2: All assets ready, send in order ──
            if not dry_run:
                _send_photo_file(ss_path)

            _add_step(1, "hijack_summary", path=ss_path, size=ss_size,
                      source_file=sd.get("source_file"), sent=not dry_run)

            if comp_ok:
                for cs in comp.get("steps", []):
                    cp = cs.get("path", "")
                    if not dry_run and cp and os.path.isfile(cp):
                        _send_photo_file(cp)
                    cs["order"] = len(base_result["steps"]) + 1
                    cs["sent"] = not dry_run
                    base_result["steps"].append(cs)
            else:
                base_result["success"] = False
                base_result["error"] = comp.get("error", "comparison generation failed")

            if not dry_run and xlsx_path and os.path.isfile(xlsx_path):
                from push_hijack import send_document as _hj_send_doc
                _hj_send_doc(xlsx_path)
            _add_step(len(base_result["steps"]) + 1, "xlsx", path=xlsx_path,
                      sent=not dry_run, skipped_in_dry_run=dry_run)

            # ── Archive snapshot (only after all 3 sends succeeded, only in non-dry-run) ──
            if dry_run:
                base_result["archive_success"] = None
                base_result["archive_status"] = "skipped_dry_run"
            elif not base_result["success"] or not xlsx_path or not os.path.isfile(xlsx_path):
                base_result["archive_success"] = False
                base_result["archive_status"] = "skipped_send_failed"
            else:
                try:
                    import hashlib
                    data_date = sd.get("data_date")
                    if not data_date:
                        base_result["archive_success"] = False
                        base_result["archive_status"] = "missing_data_date"
                        base_result["archive_error"] = "missing_excel_data_date"
                        log("PH33 archive failed: missing Excel data_date")
                    elif target_date and data_date != target_date:
                        base_result["archive_success"] = False
                        base_result["archive_status"] = "data_date_mismatch"
                        base_result["archive_error"] = f"expected={target_date} actual={data_date}"
                        log(f"PH33 archive failed: data_date mismatch target={target_date} actual={data_date}")
                    else:
                        archive_dest = os.path.join(SCRIPT_DIR, "data", "comparison_archive",
                                                    f"hijack_{data_date}.xlsx")
                        os.makedirs(os.path.dirname(archive_dest), exist_ok=True)
                        base_result["archive_path"] = archive_dest
                        base_result["archive_source_date"] = data_date

                        if os.path.isfile(archive_dest):
                            with open(xlsx_path, "rb") as f_src:
                                src_sha = hashlib.sha256(f_src.read()).hexdigest()
                            with open(archive_dest, "rb") as f_dst:
                                dst_sha = hashlib.sha256(f_dst.read()).hexdigest()
                            if src_sha == dst_sha:
                                base_result["archive_success"] = True
                                base_result["archive_status"] = "already_exists_same"
                            else:
                                base_result["success"] = False
                                base_result["push_success"] = True
                                base_result["archive_success"] = False
                                base_result["archive_status"] = "conflict"
                                base_result["archive_error"] = f"SHA diff: src={src_sha[:12]} dst={dst_sha[:12]}"
                                log(f"PH33 archive conflict: {archive_dest}")
                        else:
                            shutil.copy2(xlsx_path, archive_dest)
                            base_result["archive_success"] = True
                            base_result["archive_status"] = "created"
                            log(f"PH33 snapshot archived: hijack_{data_date}.xlsx")
                except Exception as e:
                    base_result["success"] = False
                    base_result["archive_success"] = False
                    base_result["archive_status"] = "error"
                    base_result["archive_error"] = str(e)
                    log(f"PH33 archive error: {e}")

            return base_result

        elif mode == "hr":
            ok, out = _run_subprocess("hr")
            base_result["success"] = ok
            _add_step(1, "hijack_hr", sent=not dry_run, output=out[:200])
            return base_result

        elif mode == "all_hijack":
            import time as _t
            for m in ["data", "hijack", "hr"]:
                ok, out = _run_subprocess(m)
                if not ok: base_result["success"] = False
                _add_step(len(base_result["steps"]) + 1, m, sent=not dry_run, output=out[:200])
                if m == "hijack":
                    comp = _send_hijack_comparison(target_date=target_date, dry_run=dry_run)
                    if comp.get("success"):
                        for s in comp.get("steps", []):
                            s["order"] = len(base_result["steps"]) + 1
                            base_result["steps"].append(s)
                if m != "hr":
                    _t.sleep(2)
            return base_result

        else:  # "data"
            ok, out = _run_subprocess("data")
            base_result["success"] = ok
            _add_step(1, "data", sent=not dry_run, output=out[:200])
            return base_result

    except Exception as e:
        return {"success": False, "error": str(e), "dry_run": dry_run, "target_date": target_date, "steps": []}


def api_call(method, payload):
    url = f"{API}/{method}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        body = resp.read()
        if not isinstance(body, (str, bytes, bytearray)):
            log(f"api_call unexpected body type: {type(body)}")
            return {"ok": False, "description": f"unexpected body type: {type(body)}"}
        return json.loads(body)
    except urllib.error.HTTPError as e:
        log(f"api_call HTTPError: {e.code} {e.reason}")
        return {"ok": False, "description": f"HTTP {e.code}"}
    except Exception as e:
        log(f"api_call error: {e}")
        return {"ok": False, "description": str(e)}


def send_message(text, reply_markup=None):
    payload = {"chat_id": CHAT_ID, "text": text}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    try:
        result = api_call("sendMessage", payload)
        if not result.get("ok"):
            log(f"sendMessage FAIL: {result.get('description')}")
        return result
    except Exception as e:
        import traceback
        log(f"sendMessage EXCEPTION: {e}\n{traceback.format_exc()}")
        return {"ok": False}


def answer_callback(callback_id, text=""):
    api_call("answerCallbackQuery", {"callback_query_id": callback_id, "text": text})


def run_push(date=None, month=None, sections=None):
    try:
        cmd = [sys.executable, PUSH_SCRIPT]
        if month:
            cmd.append(f"--month={month}")
        elif date:
            cmd.append(f"--date={date}")
        if sections:
            cmd.append(f"--sections={sections}")
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120,
            cwd=r"C:\Users\ak481\OneDrive\Desktop\ak 线上办公部门skills建议和调用"
        )
        return result.stdout.strip()
    except Exception as e:
        return f"执行失败: {e}"


# Read DATA_FOLDER: env var → config.json → hardcoded fallback
def _resolve_data_folder():
    env_val = os.environ.get("DATA_FOLDER", "").strip()
    if env_val:
        return env_val
    try:
        import json as _json
        _cfg_path = os.path.join(SCRIPT_DIR, "config.json")
        if os.path.exists(_cfg_path):
            with open(_cfg_path, "r", encoding="utf-8") as _f:
                _cfg_tmp = _json.load(_f)
            cfg_val = _cfg_tmp.get("data_folder", "").strip()
            if cfg_val:
                return cfg_val
    except Exception:
        pass
    return r"C:\Users\ak481\OneDrive\Desktop\新建文件夹"

DATA_FOLDER = _resolve_data_folder()
BACKUP_DIR = os.path.join(DATA_FOLDER, "备份")


def download_telegram_file(file_id, save_path):
    """Download a file from Telegram using its file_id."""
    # Step 1: get file path
    gf_url = f"{API}/getFile"
    gf_data = json.dumps({"file_id": file_id}).encode("utf-8")
    gf_req = urllib.request.Request(gf_url, data=gf_data, headers={"Content-Type": "application/json"})
    gf_resp = json.loads(urllib.request.urlopen(gf_req, timeout=10).read())
    if not gf_resp.get("ok"):
        return None, gf_resp.get("description", "getFile failed")
    file_path = gf_resp["result"]["file_path"]

    # Step 2: download
    dl_url = f"https://api.telegram.org/file/bot{TOKEN}/{file_path}"
    with urllib.request.urlopen(dl_url, timeout=60) as resp:
        with open(save_path, "wb") as f:
            shutil.copyfileobj(resp, f)
    return save_path, None


def handle_document(msg):
    """Process a document sent to the group. Download .xlsx files to data folder."""
    doc = msg.get("document", {})
    file_name = doc.get("file_name", "")
    file_id = doc.get("file_id", "")
    file_size = doc.get("file_size", 0)
    user = msg.get("from", {}).get("first_name", "用户")

    if not file_name or not file_id:
        return

    # Only accept Excel files
    if not file_name.lower().endswith(('.xlsx', '.xls')):
        send_message(f"⚠️ {user}，我只接受 .xlsx Excel 文件，收到的是: {file_name}")
        return

    size_mb = file_size / (1024 * 1024)
    log(f"Document from {user}: {file_name} ({size_mb:.1f} MB)")

    if size_mb > 20:
        send_message(f"⚠️ 文件 {file_name} 太大 ({size_mb:.1f}MB)，请控制在 20MB 以内")
        return

    save_path = os.path.join(DATA_FOLDER, file_name)
    is_overwrite = os.path.exists(save_path)

    if is_overwrite:
        # Backup old file before overwriting
        try:
            os.makedirs(BACKUP_DIR, exist_ok=True)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_name = f"{ts}_{file_name}"
            # Clean up old backups (>7 days)
            for old_backup in sorted(os.listdir(BACKUP_DIR)):
                if old_backup.endswith('.xlsx'):
                    try:
                        old_date = old_backup[:8]  # YYYYMMDD
                        if len(old_date) == 8 and (datetime.now() - datetime.strptime(old_date, "%Y%m%d")).days > 7:
                            os.remove(os.path.join(BACKUP_DIR, old_backup))
                            log(f"Cleaned old backup: {old_backup}")
                    except Exception:
                        pass
            shutil.copy2(save_path, os.path.join(BACKUP_DIR, backup_name))
            log(f"Backed up to: {backup_name}")
        except Exception as e:
            log(f"Backup error: {e}")
        send_message(f"⚠️ 文件 {file_name} 已存在，正在覆盖...")

    send_message(f"📥 正在接收 {user} 上传的 {file_name} ...")

    saved, err = download_telegram_file(file_id, save_path)

    if err:
        log(f"Download failed: {err}")
        send_message(f"❌ 下载失败: {err}")
        return

    log(f"Saved: {save_path}")
    overwrite_note = " (已覆盖旧文件)" if is_overwrite else ""

    # Auto-detect: if this is a main data file, auto-trigger push
    # Normalize brackets/spacing for matching
    _fn = file_name.replace("（", " ").replace("）", " ").replace("(", " ").replace(")", " ")
    auto_push = any(kw in _fn for kw in ['线上办公数据汇总', '线上人事数据汇总'])

    send_message(f"✅ 已接收并保存: {file_name}{overwrite_note}\n"
                 f"文件大小: {size_mb:.1f} MB\n"
                 f"存放位置: 新建文件夹\\{file_name}")

    if auto_push:
        log(f"Auto-push triggered after upload: {file_name}")
        send_message(f"⚡ 检测到数据文件更新，自动推送中...")
        output = run_push()
        log(f"Auto-push done: {output[:200]}")


def parse_date(text):
    """Extract date from Chinese text patterns. Returns 'YYYY-MM-DD' or None."""
    now = datetime.now()
    year = str(now.year)

    # Pattern 1: "5月6日" or "5月6号"
    m = re.search(r'(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]', text)
    if m:
        month = m.group(1).zfill(2)
        day = m.group(2).zfill(2)
        return f"{year}-{month}-{day}"

    # Pattern 2: "5.6" or "5/6"
    m = re.search(r'(?<!\d)(\d{1,2})[./](\d{1,2})(?!\d)', text)
    if m:
        month = m.group(1).zfill(2)
        day = m.group(2).zfill(2)
        return f"{year}-{month}-{day}"

    # Pattern 3: "0506" (4-digit MMDD)
    m = re.search(r'(?<!\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)', text)
    if m:
        month = m.group(1)
        day = m.group(2)
        return f"{year}-{month}-{day}"

    return None


def parse_month_only(text):
    """Extract month-only patterns for full-month queries. Returns 'YYYY-MM' or None."""
    now = datetime.now()
    year = str(now.year)

    # Pattern: "整个4月", "4月汇总", "4月份", "4月份数据", "4月全部", "4月总计"
    m = re.search(r'(?:整个|整月)?(\d{1,2})\s*月\s*(?:份|汇总|全部|总计|数据|$)', text)
    if m:
        month = m.group(1).zfill(2)
        return f"{year}-{month}"

    # Pattern: "4月" at end or standalone
    m = re.search(r'(?<!\d)(\d{1,2})\s*月(?!\s*\d)', text)
    if m:
        month = m.group(1).zfill(2)
        return f"{year}-{month}"

    return None


def parse_query(text):
    """Extract query intent: ('month', 'YYYY-MM') or ('date', 'YYYY-MM-DD') or None."""
    # "查4月", "查询5月", "查看3月数据"
    m = re.search(r'(?:查|查询|查看)\s*(\d{1,2})\s*月', text)
    if m:
        now = datetime.now()
        month = m.group(1).zfill(2)
        return ('month', f"{now.year}-{month}")
    # "/query 4" or "/query 5"
    m = re.search(r'/query\s+(\d{1,2})', text)
    if m:
        now = datetime.now()
        month = m.group(1).zfill(2)
        return ('month', f"{now.year}-{month}")
    # "查5月6日", "查看5.6"
    parsed_date = parse_date(text)
    if parsed_date and ('查' in text or '查询' in text or '查看' in text):
        return ('date', parsed_date)
    return None


CONFIG_FILE = r"C:\Users\ak481\OneDrive\Desktop\ak 线上办公部门skills建议和调用\config.json"


def load_config():
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config(cfg):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def show_config():
    cfg = load_config()
    lines = ["📋 **当前配置**\n"]
    for k, v in cfg.get("titles", {}).items():
        lines.append(f"标题_{k}: {v}")
    lines.append(f"推送时间: {cfg.get('schedule', {}).get('daily_push_time', '21:07')}")
    for k, v in cfg.get("sections", {}).items():
        icon = "✅" if v else "❌"
        lines.append(f"{icon} {k}")
    send_message("\n".join(lines))


def handle_set(args_text):
    """Handle /set command: /set key value"""
    parts = args_text.strip().split(None, 1)
    if len(parts) < 2:
        send_message("用法: /set <key> <value>\n如: /set daily_push_time 21:30\n"
                     "可设置项:\n"
                     "  daily_push_time (如 21:30)\n"
                     "  title_daily (标题文本)\n"
                     "  title_monthly\n"
                     "  title_hijack_office\n"
                     "  title_hijack_hr")
        return
    key, value = parts[0], parts[1]
    cfg = load_config()

    if key == "daily_push_time":
        cfg["schedule"]["daily_push_time"] = value
        # Also update Windows scheduled task
        import subprocess
        bat = r'C:\Users\ak481\OneDrive\Desktop\ak 线上办公部门skills建议和调用\_daily_push.bat'
        ps_cmd = f'schtasks /create /tn "线上办公数据推送" /tr "{bat}" /sc daily /st {value} /f'
        subprocess.run(ps_cmd, shell=True, capture_output=True)
        send_message(f"✅ 推送时间已改为 {value}，定时任务已更新")

    elif key.startswith("title_"):
        title_key = key[6:]  # remove "title_" prefix
        # Map to config keys
        key_map = {"daily": "daily", "monthly": "monthly",
                   "hijack_office": "hijack_office", "hijack_hr": "hijack_hr"}
        if title_key in key_map:
            cfg["titles"][key_map[title_key]] = value
            send_message(f"✅ 标题已改为: {value}")
        else:
            send_message(f"❌ 未知标题键: {title_key}")

    else:
        send_message(f"❌ 未知配置项: {key}")

    save_config(cfg)


def handle_toggle(args_text):
    """Handle /toggle command: /toggle section_name"""
    section = args_text.strip()
    cfg = load_config()
    sections = cfg.get("sections", {})
    if section in sections:
        sections[section] = not sections[section]
        state = "开启" if sections[section] else "关闭"
        send_message(f"✅ {section} 已{state}")
        save_config(cfg)
    else:
        keys = "\n".join(sections.keys())
        send_message(f"可用开关:\n{keys}")


def show_menu():
    keyboard = {
        "inline_keyboard": [
            [{"text": "🚀 推送全部(1+2+3+4)", "callback_data": "push_all"}],
            [{"text": "1️⃣ 文本推送", "callback_data": "daily"}, {"text": "2️⃣ 数据截图", "callback_data": "push2"}],
            [{"text": "3️⃣ 劫持办公", "callback_data": "push3"}, {"text": "4️⃣ 劫持人事", "callback_data": "push4"}],
            [{"text": "📆 当月累计汇总", "callback_data": "monthly"}, {"text": "🏆 站点排名", "callback_data": "ranking"}],
            [{"text": "🇬🇧 English Push", "callback_data": "en"}, {"text": "⚙️ 配置管理", "callback_data": "cfg_menu"}],
            [{"text": "📋 指令说明", "callback_data": "help"}],
        ]
    }
    send_message("📋 **数据推送菜单**\n选择一个操作：", reply_markup=keyboard)


def show_config_menu():
    try:
        cfg = load_config()
        sections = cfg.get("sections", {})
        titles = cfg.get("titles", {})

        # Build toggle buttons for each section
        toggle_buttons = []
        for key, label in [("daily_table", "日报表"), ("monthly_table", "月报表"),
                           ("hijack_office", "劫持汇总"), ("hijack_hr", "劫持人事"),
                           ("dod_comparison", "环比分析"), ("anomaly_alerts", "异常告警"),
                           ("fraud_alerts", "风控告警")]:
            state = "✅" if sections.get(key, True) else "❌"
            toggle_buttons.append({"text": f"{state} {label}", "callback_data": f"tgl_{key}"})

        # Arrange in rows of 2
        btn_rows = []
        for i in range(0, len(toggle_buttons), 2):
            row = toggle_buttons[i:i+2]
            btn_rows.append(row)

        keyboard = {
            "inline_keyboard": btn_rows + [
                [{"text": "✏️ 改标题(用/set)", "callback_data": "cfg_titles"},
                 {"text": "⏰ 改时间(用/set)", "callback_data": "cfg_time"}],
                [{"text": "🔙 返回主菜单", "callback_data": "menu"}],
            ]
        }

        push_time = cfg.get("schedule", {}).get("daily_push_time", "21:07")
        info = []
        for k, v in titles.items():
            info.append(f"  {k}: {v}")
        send_message(f"Config Management\n\nTitles:\n" + "\n".join(info) +
                     f"\n\nPush Time: {push_time}\n\nToggle sections:",
                     reply_markup=keyboard)
    except Exception as e:
        print(f"Config menu error: {e}")
        import traceback
        traceback.print_exc()


def main():
    if not acquire_lock():
        return
    try:
        _init_telegram()
    except RuntimeError as e:
        log(f"FATAL: {e}")
        release_lock()
        sys.exit(1)
    try:
        log("Bot listener started")

        # ── Startup self-check ──
        if _plat_cfg is not None:
            log("Running platform config startup check...")
            try:
                startup_warnings = _plat_cfg.startup_check(DATA_FOLDER)
                for w in startup_warnings:
                    log(w)
            except Exception as e:
                log(f"Startup check error: {e}")

        offset = 0
        last_heartbeat = 0
        while True:
            try:
                # Write heartbeat every 60 seconds for watchdog
                now_ts = time.time()
                if now_ts - last_heartbeat > 60:
                    write_heartbeat()
                    last_heartbeat = now_ts

                url = f"{API}/getUpdates?timeout=30&offset={offset}&allowed_updates=message,callback_query"
                resp = urllib.request.urlopen(url, timeout=35)
                data = json.loads(resp.read())
                for upd in data.get("result", []):
                    offset = upd["update_id"] + 1

                    # ── Callback queries (inline button taps) ──
                    cb = upd.get("callback_query")
                    if cb:
                        cb_data = cb.get("data", "")
                        cb_id = cb["id"]
                        cb_user = cb.get("from", {}).get("first_name", "用户")

                        log(f"Button: {cb_user} -> {cb_data}")

                        # ── Navigation / Config callbacks ──
                        if cb_data == "menu":
                            answer_callback(cb_id, "已刷新")
                            show_menu()
                            continue

                        if cb_data == "config":
                            answer_callback(cb_id, "加载配置...")
                            show_config()
                            continue

                        if cb_data == "cfg_menu":
                            answer_callback(cb_id, "打开配置")
                            show_config_menu()
                            continue

                        if cb_data == "cfg_titles":
                            answer_callback(cb_id, "查看说明")
                            send_message("✏️ 修改标题请用指令：\n/set title_daily 新名称\n/set title_monthly 新名称\n/set title_hijack_office 新名称\n/set title_hijack_hr 新名称")
                            continue

                        if cb_data == "cfg_time":
                            answer_callback(cb_id, "查看说明")
                            send_message("⏰ 修改推送时间：\n/set daily_push_time 21:30\n(格式 HH:MM，24小时制)")
                            continue

                        if cb_data.startswith("tgl_"):
                            section = cb_data[4:]
                            cfg = load_config()
                            sections = cfg.get("sections", {})
                            if section in sections:
                                sections[section] = not sections[section]
                                save_config(cfg)
                                state = "ON" if sections[section] else "OFF"
                                answer_callback(cb_id, f"{section}={state}")
                                show_config_menu()
                            continue

                        if cb_data == "help":
                            answer_callback(cb_id, "显示帮助")
                            send_message("📋 可用指令：\n\n"
                                         "📊 推送数据:\n"
                                         "  /push — 推送今日全部\n"
                                         "  推送 5月6日 — 指定日期\n"
                                         "  整个4月 — 整月汇总\n"
                                         "  今天的数据 — 今日数据\n"
                                         "  本月的汇总 — 本月汇总\n"
                                         "  /files — 查看已有数据文件\n\n"
                                         "📤 上传文件:\n"
                                         "  直接拖 .xlsx 文件到群组\n"
                                         "  Bot 自动下载保存\n\n"
                                         "⚙️ 修改配置:\n"
                                         "  /config — 查看配置\n"
                                         "  /set daily_push_time 21:30\n"
                                         "  /set title_daily 新标题\n"
                                         "  /toggle daily_table — 开关模块\n"
                                         "  排名 — 站点排行榜\n"
                                         "  排名roi — 按ROI排\n"
                                         "  /en — 英文版推送\n"
                                         "  /hijack — 劫持推送(截图+源文件)\n"
                                         "  /platforms — 查看平台配置状态\n"
                                         "  查4月 — 历史数据查询")
                            continue

                        # ── Push actions ──
                        if cb_data == "push_all":
                            answer_callback(cb_id, "正在生成全部数据...")
                            send_message(f"⚡ {cb_user} 触发推送全部数据...")
                            output = run_push(sections="daily_table,monthly_table,hijack_office,hijack_hr,dod_comparison,anomaly_alerts,fraud_alerts")
                            print(f"[{datetime.now()}] Push all done: {output[:200]}")
                            _post_push_actions()
                            continue

                        if cb_data == "daily":
                            answer_callback(cb_id, "正在生成地推数据...")
                            send_message(f"⚡ {cb_user} 触发地推数据推送...")
                            output = run_push(sections="daily_table,dod_comparison,anomaly_alerts,fraud_alerts")
                            print(f"[{datetime.now()}] Daily push done: {output[:200]}")
                            _post_push_actions()
                            continue

                        if cb_data == "monthly":
                            answer_callback(cb_id, "正在生成当月汇总...")
                            send_message(f"⚡ {cb_user} 触发当月累计汇总...")
                            output = run_push(sections="monthly_table")
                            print(f"[{datetime.now()}] Monthly push done: {output[:200]}")
                            continue

                        if cb_data == "hijack":
                            answer_callback(cb_id, "正在生成劫持数据...")
                            send_message(f"⚡ {cb_user} 触发劫持数据推送...")
                            output = run_push(sections="hijack_office,hijack_hr")
                            print(f"[{datetime.now()}] Hijack push done: {output[:200]}")
                            continue

                        if cb_data == "push2":
                            answer_callback(cb_id, "正在生成推送2-数据截图...")
                            send_message(f"⚡ {cb_user} 触发推送2-数据截图...")
                            output = run_hijack_push("data")
                            print(f"[{datetime.now()}] Push2 done: {output[:200]}")
                            continue

                        if cb_data == "push3":
                            answer_callback(cb_id, "正在生成推送3-劫持办公...")
                            send_message(f"⚡ {cb_user} 触发推送3-劫持办公...")
                            output = run_hijack_push("hijack")
                            print(f"[{datetime.now()}] Push3 done: {output[:200]}")
                            continue

                        if cb_data == "push4":
                            answer_callback(cb_id, "正在生成推送4-劫持人事...")
                            send_message(f"⚡ {cb_user} 触发推送4-劫持人事...")
                            output = run_hijack_push("hr")
                            print(f"[{datetime.now()}] Push4 done: {output[:200]}")
                            continue

                        if cb_data == "ranking":
                            answer_callback(cb_id, "正在生成排行榜...")
                            if _bot_data is None:
                                send_message("❌ 数据模块未加载")
                            else:
                                data = _bot_data.get_today_data()
                                if not data:
                                    send_message("❌ 未找到今日数据文件")
                                else:
                                    rankings = _bot_data.get_rankings(data, "ftd")
                                    lines = ["🏆 <b>站点排行榜 — 按FTD</b>\n"]
                                    for r in rankings:
                                        diff_str = _bot_data.fmt_k_signed(r["diff"])
                                        roi_str = f"{r['roi']:.1f}" if r["roi"] else "N/A"
                                        lines.append(f"{r['icon']} {r['status_icon']} <b>{r['name']}</b>  FTD={r['ftd']}  ROI={roi_str}  DIFF={diff_str}")
                                    lines.append(f"\n💡 试试：排名roi / 排名充提差")
                                    send_message("\n".join(lines))
                            continue

                        if cb_data == "en":
                            answer_callback(cb_id, "正在生成英文推送...")
                            send_message(f"🇬🇧 {cb_user} 触发英文版推送...")
                            output = run_en_push()
                            print(f"[{datetime.now()}] EN push done: {output[:200]}")
                            continue

                        continue

                    # ── Messages ──
                    msg = upd.get("message", {})
                    chat = msg.get("chat", {})
                    text = (msg.get("text") or msg.get("caption") or "").strip()

                    if chat.get("id") != CHAT_ID:
                        continue

                    user = msg.get("from", {}).get("first_name", "用户")

                    # ── Document upload (Excel files) ──
                    if "document" in msg:
                        handle_document(msg)
                        continue

                    if not text:
                        continue

                    cmd = text.split()[0].lower().split("@")[0]

                    # ── Date / Month-specific push: keywords + date/month ──
                    cfg = load_config()
                    date_keywords = cfg.get("triggers", {}).get("keywords", ["推送", "数据", "push", "更新"])
                    has_push_kw = any(kw in text for kw in date_keywords)
                    parsed_date = parse_date(text)
                    parsed_month = parse_month_only(text)

                    # "今天"/"今日" → today's date
                    if has_push_kw and not parsed_date and not parsed_month:
                        if re.search(r'今[天日]', text):
                            parsed_date = datetime.now().strftime("%Y-%m-%d")
                        elif re.search(r'本[个]?月|这个月', text):
                            parsed_month = datetime.now().strftime("%Y-%m")

                    if has_push_kw and parsed_month and not parsed_date:
                        # Month-only query like "整个4月" or "4月汇总"
                        print(f"[{datetime.now()}] Month push from {user}: {text} → {parsed_month}")
                        send_message(f"⚡ 正在推送 {parsed_month} 整月汇总数据...")
                        output = run_push(month=parsed_month)
                        print(f"[{datetime.now()}] Push done: {output[:200]}")
                        continue

                    if has_push_kw and parsed_date:
                        print(f"[{datetime.now()}] Date push from {user}: {text} → {parsed_date}")
                        send_message(f"⚡ 正在推送 {parsed_date} 的数据...")
                        output = run_push(date=parsed_date)
                        print(f"[{datetime.now()}] Push done: {output[:200]}")
                        continue

                    # ── History query: "查4月", "/query 4", "查看3月" ──
                    query = parse_query(text)
                    if query:
                        qtype, qval = query
                        if qtype == 'month':
                            send_message(f"🔍 正在查询 {qval} 整月数据...")
                            output = run_push(month=qval)
                            log(f"Query month {qval} by {user}: {output[:200]}")
                        else:
                            send_message(f"🔍 正在查询 {qval} 数据...")
                            output = run_push(date=qval)
                            log(f"Query date {qval} by {user}: {output[:200]}")
                        continue

                    # ── Regular commands ──
                    if cmd in ("/push", "/推送", "/daily", "/monthly", "/hijack"):
                        print(f"[{datetime.now()}] Command from {user}: {text}")
                        month_arg = parse_month_only(text)
                        date_arg = parse_date(text)
                        if month_arg and not date_arg:
                            msg_text = f"⚡ 正在推送 {month_arg} 整月汇总数据..."
                            send_message(msg_text)
                            output = run_push(month=month_arg)
                        elif date_arg:
                            msg_text = f"⚡ 正在推送 {date_arg} 的数据..."
                            send_message(msg_text)
                            output = run_push(date=date_arg)
                        else:
                            msg_text = "⚡ 收到指令，正在生成数据..."
                            send_message(msg_text)
                            output = run_push()
                        print(f"[{datetime.now()}] Push done: {output[:200]}")

                    elif cmd == "/menu":
                        print(f"[{datetime.now()}] Menu from {user}")
                        show_menu()

                    elif cmd == "/config":
                        show_config()

                    elif cmd == "/set":
                        args_text = text.split(None, 1)[1] if len(text.split(None, 1)) > 1 else ""
                        handle_set(args_text)

                    elif cmd == "/toggle":
                        args_text = text.split(None, 1)[1] if len(text.split(None, 1)) > 1 else ""
                        handle_toggle(args_text)

                    elif cmd == "/files":
                        # List available data files
                        files = sorted([f for f in os.listdir(DATA_FOLDER) if f.endswith('.xlsx') and '副本' not in f and 'Copy' not in f and not f.startswith('~$')])
                        main_files = [f for f in files if '线上办公数据汇总' in f and '劫持' not in f]
                        hj_office = [f for f in files if '劫持' in f and '办公数据汇总' in f]
                        hj_hr = [f for f in files if '劫持' in f and '人事数据汇总' in f]
                        msg_lines = ["📁 **数据文件列表**\n"]
                        if main_files:
                            msg_lines.append("📊 地推数据:")
                            for f in main_files:
                                msg_lines.append(f"  • {f}")
                        if hj_office:
                            msg_lines.append("\n🛡️ 劫持运营:")
                            for f in hj_office:
                                msg_lines.append(f"  • {f}")
                        if hj_hr:
                            msg_lines.append("\n👤 劫持人资:")
                            for f in hj_hr:
                                msg_lines.append(f"  • {f}")
                        if not files:
                            msg_lines.append("暂无数据文件，请上传 .xlsx 文件")
                        send_message("\n".join(msg_lines))

                    elif cmd in ("/platforms", "/平台"):
                        if _plat_cfg is None:
                            send_message("❌ 平台配置模块未加载")
                        else:
                            status_text = _plat_cfg.format_platform_status(DATA_FOLDER)
                            send_message(status_text)

                    elif cmd in ("/reload_config", "/重新加载配置"):
                        if _plat_cfg is None:
                            send_message("❌ 平台配置模块未加载")
                            continue
                        sender_id = str(msg.get("from", {}).get("id", ""))
                        admin_ids = [str(a) for a in _plat_cfg.get_admin_ids()]
                        if not admin_ids:
                            send_message("❌ 尚未配置 Admin Telegram ID，已拒绝重新加载配置。\n请在 config.json 的 admin_telegram_ids 中填入 Admin ID。")
                        elif sender_id not in admin_ids:
                            send_message("❌ 权限不足，仅 Admin 可执行此操作")
                        else:
                            ok, message, old_v, new_v = _plat_cfg.reload_config(DATA_FOLDER)
                            send_message(message)

                    elif cmd in ("/check_platform", "/检查平台"):
                        args_text = text.split(None, 1)[1] if len(text.split(None, 1)) > 1 else ""
                        code = args_text.strip()
                        if not code:
                            send_message("用法: /check_platform &lt;平台代码&gt;\n示例: /check_platform PH35")
                        elif _plat_cfg is None:
                            send_message("❌ 平台配置模块未加载")
                        else:
                            result = _plat_cfg.check_single_platform(code, DATA_FOLDER)
                            msg_text = _plat_cfg.format_check_result(result)
                            send_message(msg_text)

                    elif cmd in ("/compare_date", "/指定对比"):
                        sender_id = str(msg.get("from", {}).get("id", ""))
                        admin_ids = [str(a) for a in (_plat_cfg.get_admin_ids() if _plat_cfg else [])]
                        if not admin_ids:
                            send_message("❌ 管理员名单未配置，数据对比功能已禁用"); continue
                        if sender_id not in admin_ids:
                            send_message("❌ 权限不足，仅管理员可执行数据对比推送"); continue
                        args_text = text.split(None, 1)[1] if len(text.split(None, 1)) > 1 else ""
                        date_arg = args_text.strip()
                        if not date_arg:
                            send_message("用法: /compare_date YYYY-MM-DD\n示例: /compare_date 2026-07-25"); continue
                        try:
                            import comparison_push as cp
                            def _send_photo(img_bytes, caption):
                                boundary = "---boundary" + os.urandom(8).hex()
                                buf = io.BytesIO(); buf.write(img_bytes); buf.seek(0)
                                body = [f"--{boundary}".encode(),
                                        f'Content-Disposition: form-data; name="chat_id"\r\n\r\n{CHAT_ID}'.encode()]
                                if caption: body.append(f'Content-Disposition: form-data; name="caption"\r\n\r\n{caption}'.encode('utf-8'))
                                body.append(f"--{boundary}".encode())
                                body.append(f'Content-Disposition: form-data; name="photo"; filename="compare.png"\r\nContent-Type: image/png\r\n'.encode())
                                body.append(buf.read()); body.append(f"--{boundary}--".encode())
                                data = b"\r\n".join(body)
                                req = urllib.request.Request(f"https://api.telegram.org/bot{TOKEN}/sendPhoto", data=data)
                                for k, v in {"Content-Type": f"multipart/form-data; boundary={boundary}"}.items(): req.add_header(k, v)
                                urllib.request.urlopen(req, timeout=30)
                            cp.send_comparison(_send_photo, send_message, target_date=date_arg)
                        except Exception as e:
                            log(f"Compare error: {e}")
                            send_message(f"❌ 数据对比推送失败: {e}")

                    elif cmd in ("/compare_check", "/对比检查"):
                        sender_id = str(msg.get("from", {}).get("id", ""))
                        admin_ids = [str(a) for a in (_plat_cfg.get_admin_ids() if _plat_cfg else [])]
                        if not admin_ids:
                            send_message("❌ 管理员名单未配置，此功能已禁用"); continue
                        if sender_id not in admin_ids:
                            send_message("❌ 权限不足，仅管理员可执行"); continue
                        try:
                            import comparison_push as cp
                            status_text = cp.check_comparison_status()
                            send_message(status_text)
                        except Exception as e:
                            log(f"Compare check error: {e}")
                            send_message(f"❌ 状态检查失败: {e}")

                    elif cmd in ("/compare", "/数据对比"):
                        sender_id = str(msg.get("from", {}).get("id", ""))
                        admin_ids = [str(a) for a in (_plat_cfg.get_admin_ids() if _plat_cfg else [])]
                        if not admin_ids:
                            send_message("❌ 管理员名单未配置，数据对比功能已禁用")
                            continue
                        if sender_id not in admin_ids:
                            send_message("❌ 权限不足，仅管理员可执行数据对比推送")
                            continue
                        try:
                            import comparison_push as cp
                            def _send_photo(img_bytes, caption):
                                boundary = "---boundary" + os.urandom(8).hex()
                                buf = io.BytesIO()
                                buf.write(img_bytes)
                                buf.seek(0)
                                body = []
                                body.append(f"--{boundary}".encode())
                                body.append(f'Content-Disposition: form-data; name="chat_id"\r\n\r\n{CHAT_ID}'.encode())
                                body.append(f"--{boundary}".encode())
                                if caption:
                                    body.append(f'Content-Disposition: form-data; name="caption"\r\n\r\n{caption}'.encode('utf-8'))
                                body.append(f"--{boundary}".encode())
                                body.append(f'Content-Disposition: form-data; name="photo"; filename="compare.png"\r\nContent-Type: image/png\r\n'.encode())
                                body.append(buf.read())
                                body.append(f"--{boundary}--".encode())
                                data = b"\r\n".join(body)
                                req = urllib.request.Request(f"https://api.telegram.org/bot{TOKEN}/sendPhoto", data=data)
                                for k, v in {"Content-Type": f"multipart/form-data; boundary={boundary}"}.items():
                                    req.add_header(k, v)
                                urllib.request.urlopen(req, timeout=30)
                            cp.send_comparison(_send_photo, send_message)
                        except Exception as e:
                            log(f"Compare error: {e}")
                            send_message(f"❌ 数据对比推送失败: {e}")

                    elif cmd == "/help":
                        send_message("📋 可用指令：\n\n"
                                     "📊 推送数据:\n"
                                     "  /push — 推送1(文本)\n"
                                     "  /push2 — 推送2(数据截图+Excel)\n"
                                     "  /push3 — 推送3(劫持办公)\n"
                                     "  /push4 — 推送4(劫持人事)\n"
                                     "  /hijack — 推送2+3+4全部\n"
                                     "  推送 — 自动推送全部\n"
                                     "  推送 5月6日 — 指定日期\n"
                                     "  整个4月 — 整月汇总\n"
                                     "  查4月 — 查询历史\n"
                                     "  今天的数据 — 今日数据\n"
                                     "  本月的汇总 — 本月汇总\n"
                                     "  /files — 查看已有数据文件\n"
                                     "  排名 — 站点排行榜\n"
                                     "  排名roi — 按ROI排\n"
                                     "  /en — 英文版推送\n"
                                     "  /platforms — 查看平台配置\n\n"
                                     "📤 上传文件:\n"
                                     "  直接拖 .xlsx 文件到群组\n"
                                     "  Bot 自动下载保存\n\n"
                                     "⚙️ 修改配置:\n"
                                     "  /menu — 按钮菜单\n"
                                     "  /config — 查看配置\n"
                                     "  /set daily_push_time 21:30\n"
                                     "  /set title_daily 新标题\n"
                                     "  /toggle daily_table — 开关模块")

                    elif cmd == "/start":
                        send_message("已就绪。发送 /menu 打开菜单，或直接说：\n• 推送 — 推送最新数据\n• 推送 5月6日 — 推送指定日期\n• 查4月 — 查询历史数据\n• 排名 — 站点排行榜\n• /en — English push\n• 上传 .xlsx 文件 — 自动推送")

                    # ── Site ranking: "/rank", "排名", "排行榜", "/ranking" ──
                    elif cmd in ("/rank", "/ranking") or (text and text.strip() in ("排名", "排行榜", "对比")):
                        if _bot_data is None:
                            send_message("❌ 数据模块未加载，请检查 _bot_data.py")
                        else:
                            data = _bot_data.get_today_data()
                            if not data:
                                send_message("❌ 未找到今日数据文件")
                            else:
                                # Determine sort key from text
                                sort_by = "ftd"
                                if "roi" in text.lower() or "投产" in text:
                                    sort_by = "roi"
                                elif "diff" in text.lower() or "充提差" in text or "存提差" in text:
                                    sort_by = "diff"
                                elif "注册" in text:
                                    sort_by = "register"
                                elif "转化" in text:
                                    sort_by = "conversion"

                                rankings = _bot_data.get_rankings(data, sort_by)
                                label = {"ftd": "FTD", "roi": "ROI", "diff": "充提差", "register": "注册", "conversion": "转化率"}.get(sort_by, sort_by)
                                lines = [f"🏆 <b>站点排行榜 — 按{label}</b>\n"]
                                for r in rankings:
                                    diff_str = _bot_data.fmt_k_signed(r["diff"])
                                    roi_str = f"{r['roi']:.1f}" if r["roi"] else "N/A"
                                    lines.append(f"{r['icon']} {r['status_icon']} <b>{r['name']}</b>  FTD={r['ftd']}  ROI={roi_str}  DIFF={diff_str}")
                                lines.append(f"\n💡 试试：排名roi / 排名充提差 / 排名注册")
                                send_message("\n".join(lines))

                    # ── Push2/3/4 via text commands ──
                    elif cmd in ("/push2", "/数据截图") or text.strip() == "推送2":
                        log(f"Push2 from {user}")
                        send_message("⚡ 正在生成推送2-数据截图...")
                        output = run_hijack_push("data")
                        log(f"Push2 done: {output[:200]}")

                    elif cmd in ("/push3", "/劫持办公") or text.strip() == "推送3":
                        log(f"Push3 from {user}")
                        send_message("⚡ 正在生成推送3-劫持办公...")
                        output = run_hijack_push("hijack")
                        log(f"Push3 done: {output[:200]}")

                    elif cmd in ("/push4", "/劫持人事") or text.strip() == "推送4":
                        log(f"Push4 from {user}")
                        send_message("⚡ 正在生成推送4-劫持人事...")
                        output = run_hijack_push("hr")
                        log(f"Push4 done: {output[:200]}")

                    # ── Hijack push: "/hijack" (old compat, now runs all hijack pushes 2+3+4) ──
                    elif cmd == "/hijack" or text.strip() == "劫持推送":
                        log(f"Hijack push from {user}")
                        send_message("🛡️ 正在生成劫持推送（2+3+4）...")
                        output = run_hijack_push("all_hijack")
                        log(f"Hijack push done: {output[:200]}")

                    # ── English push: "/en" ──
                    elif cmd == "/en":
                        log(f"EN push from {user}")
                        send_message("🇬🇧 Generating English push...")
                        output = run_en_push()
                        log(f"EN push done: {output[:200]}")

            except Exception as e:
                log(f"Poll error: {e}")
                time.sleep(5)

            # Check for scheduled daily push after each polling cycle
            try:
                check_scheduled_push()
            except Exception:
                pass
    finally:
        release_lock()


if __name__ == "__main__":
    main()
