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

# ── State directory (marker files): Railway → /data (Volume), Windows → SCRIPT_DIR ──
try:
    import _runtime as _rt_state
    _STATE_DIR = _rt_state.resolve_data_root() if _rt_state.is_railway() else SCRIPT_DIR
except ImportError:
    _STATE_DIR = SCRIPT_DIR

LAST_PUSH_DATE_FILE = os.path.join(_STATE_DIR, "_last_auto_push.txt")
LAST_WEEKLY_DATE_FILE = os.path.join(_STATE_DIR, "_last_weekly_push.txt")
LAST_MONTHLY_DATE_FILE = os.path.join(_STATE_DIR, "_last_monthly_push.txt")


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


def _business_now():
    """Return current datetime in business timezone (UTC+8).
    Primary: ZoneInfo('Asia/Manila'). Fallback: UTC + 8h (never depends on local TZ)."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Asia/Manila"))
    except Exception:
        from datetime import timezone, timedelta as _td
        return datetime.now(timezone.utc).astimezone(timezone(_td(hours=8)))


def check_scheduled_push():
    """Check if it's time for the daily/weekly/monthly scheduled push. Returns True if any push was done.
    All time comparisons use business timezone (UTC+8), NOT server local time."""
    try:
        cfg = load_config()
        push_time = cfg.get("schedule", {}).get("daily_push_time", "21:07")
        now = _business_now()
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
    """Generate PH33 comparison. target_date must be explicit YYYY-MM-DD string."""
    import hijack_comparison_push as hcp
    if target_date is None:
        return {"success": False, "error": "target_date required", "dry_run": dry_run, "steps": [], "target_date": None}

    result = {"success": False, "dry_run": dry_run, "target_date": target_date, "steps": []}

    ok, err, img_bytes, caption, meta = hcp.generate_hijack_comparison(target_date)

    # Copy metadata
    for k in ('requested_target_date','resolved_target_date','source_data_date',
              'yesterday_date','month_date','yesterday_available','month_available','missing_snapshots'):
        if meta and k in meta: result[k] = meta[k]

    if not ok:
        result["error"] = err
        if not dry_run: send_message(f"PH33对比生成失败: {err}")
        return result

    import _runtime as _rt_h
    fpath = os.path.join(_rt_h.generated_dir(), f'hijack_compare_{target_date}.png')
    os.makedirs(os.path.dirname(fpath), exist_ok=True)
    with open(fpath, 'wb') as f: f.write(img_bytes)

    result["steps"].append({
        "order": 2, "type": "hijack_comparison",
        "path": fpath, "size": len(img_bytes),
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
        def _resolve_renderer():
            """HIJACK_RENDERER: auto | com | pillow. Returns 'com' or 'pillow'."""
            import _runtime as _rt
            choice = os.environ.get("HIJACK_RENDERER", "auto").strip().lower()
            if choice == "pillow":
                return "pillow"
            if choice == "com":
                return "com"
            # auto: Windows→com, Linux→pillow
            return "pillow" if _rt.is_railway() or not _rt.IS_WINDOWS else "com"

        def _run_summary_only():
            """Generate PH33 summary.
            Windows default: push_hijack.py COM screenshot.
            Railway/Linux: pure Pillow renderer.
            Returns unified dict with path/size/data_date."""
            renderer = _resolve_renderer()
            import _runtime as _rt

            if renderer == "pillow":
                # Resolve hijack excel via active_month
                try:
                    import _platform_config as _pc
                    hpath, hfname, hdate, herrs = _pc.get_active_excel("hijack")
                    if not hpath:
                        return {"success": False, "error": f"劫持Excel不可用: {'; '.join(herrs)}"}
                except Exception as e:
                    return {"success": False, "error": f"劫持Excel解析失败: {str(e)[:60]}"}
                import hijack_summary_renderer as _hr
                r = _hr.render_hijack_summary(hpath)
                if not r.get("success"):
                    return {"success": False, "error": r.get("error", "pillow renderer failed")}
                return {
                    "success": True, "renderer": "pillow",
                    "summary": {
                        "path": r["path"], "size": r["size"],
                        "width": r["width"], "height": r["height"],
                        "source_file": hpath, "data_date": r.get("data_date"),
                        "sent": False,
                    },
                    "xlsx": {"path": hpath, "sent": False},
                    "data_date": r.get("data_date"),
                }

            # COM (Windows)
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

        base_result = {"success": True, "dry_run": dry_run, "target_date": target_date, "steps": []}

        def _add_step(order, stype, **extra):
            step = {"order": order, "type": stype, "sent": False}
            step.update(extra)
            base_result["steps"].append(step)

        if mode == "hijack":
            # ── Phase 1: Generate summary, resolve date ──
            sum_result = _run_summary_only()
            if not sum_result.get("success"):
                base_result["success"] = False
                base_result["error"] = sum_result.get("error", "unknown")
                base_result["requested_target_date"] = target_date
                base_result["source_data_date"] = sum_result.get("data_date")
                base_result["resolved_target_date"] = None
                return base_result

            sd = sum_result.get("summary", {})
            ss_path = sd.get("path", "")
            ss_size = sd.get("size", 0) if sd.get("size") else 0
            xlsx_path = sum_result.get("xlsx", {}).get("path", "")
            source_data_date = sd.get("data_date")
            base_result["source_data_date"] = source_data_date

            # Resolve target_date: use caller's value, or Excel's data_date
            if target_date is None:
                if not source_data_date:
                    base_result["success"] = False
                    base_result["error"] = "Cannot resolve target_date: Excel data_date missing"
                    return base_result
                resolved_target_date = source_data_date
            else:
                if source_data_date and target_date != source_data_date:
                    base_result["success"] = False
                    base_result["error"] = "Target date does not match source data date"
                    base_result["requested_target_date"] = target_date
                    base_result["source_data_date"] = source_data_date
                    return base_result
                resolved_target_date = target_date

            base_result["requested_target_date"] = target_date
            base_result["resolved_target_date"] = resolved_target_date
            base_result["target_date"] = resolved_target_date

            # ── Phase 2: Generate comparison (always, even if snapshots missing) ──
            comp = _send_hijack_comparison(target_date=resolved_target_date, dry_run=True)
            comp_path = ""
            comp_size = 0
            if comp.get("success"):
                for cs in comp.get("steps", []):
                    if cs.get("path"):
                        comp_path = cs["path"]
                        comp_size = cs.get("size", 0)
                        break

            # ── Phase 3: Always produce 3 steps ──
            _add_step(1, "hijack_summary", path=ss_path, size=ss_size,
                      source_file=sd.get("source_file"))

            _add_step(2, "hijack_comparison",
                      path=comp_path, size=comp_size,
                      success=comp.get("success", False),
                      error=comp.get("error"),
                      missing_snapshots=comp.get("missing_snapshots", []))

            _add_step(3, "xlsx", path=xlsx_path, skipped_in_dry_run=dry_run)

            # ── Phase 4: Preflight & send ──
            if dry_run:
                pass  # All sent=False already
            else:
                # Preflight: summary + xlsx must exist; comparison is optional
                missing = []
                if not ss_path or not os.path.isfile(ss_path): missing.append("summary")
                if not xlsx_path or not os.path.isfile(xlsx_path): missing.append("xlsx")
                if missing:
                    base_result["success"] = False
                    base_result["error"] = f"Preflight failed — missing: {', '.join(missing)}"
                    log(f"PH33 push preflight failed: {missing}")
                    return base_result

                # Send in order
                _send_photo_file(ss_path)
                base_result["steps"][0]["sent"] = True

                if comp.get("success"):
                    for cs in comp.get("steps", []):
                        cp = cs.get("path", "")
                        if cp and os.path.isfile(cp):
                            _send_photo_file(cp)
                    base_result["steps"][1]["sent"] = True

                from push_hijack import send_document as _hj_send_doc
                _hj_send_doc(xlsx_path)
                base_result["steps"][2]["sent"] = True

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
                        import _runtime as _rt_ar
                        archive_dest = os.path.join(_rt_ar.archive_dir(),
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


def _esc_html(s):
    """Escape HTML-special characters for Telegram HTML parse mode."""
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def send_message(text, reply_markup=None, target_chat_id=None):
    destination = target_chat_id if target_chat_id is not None else CHAT_ID
    payload = {"chat_id": destination, "text": text, "parse_mode": "HTML"}
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
            cwd=SCRIPT_DIR
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
    try:
        import _runtime as _rt_d
        return _rt_d.excel_dir()
    except ImportError:
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


def handle_document(msg, target_chat_id=None):
    """Process a document uploaded to the group/private chat.
    Secure upload: admin-only, sanitized name, .xlsx only, openpyxl verify,
    type + data_date validation, atomic replace, backup, temp staging."""
    doc = msg.get("document", {})
    file_name = doc.get("file_name", "")
    file_id = doc.get("file_id", "")
    file_size = doc.get("file_size", 0)
    sender_id = str(msg.get("from", {}).get("id", ""))

    if not file_name or not file_id:
        return

    # ── Admin-only upload ──
    try:
        admin_ids = [str(a) for a in _plat_cfg.get_admin_ids()]
    except Exception:
        admin_ids = []
    if not admin_ids or sender_id not in admin_ids:
        send_message("❌ 上传仅允许管理员执行", target_chat_id=target_chat_id)
        return

    # ── Sanitize filename ──
    file_name = os.path.basename(file_name.replace("\\", "/"))
    if not file_name or file_name in (".", "..") or ".." in file_name:
        send_message("⚠️ 无效文件名，已拒绝", target_chat_id=target_chat_id)
        return

    # ── .xlsx only (reject .xls) ──
    if not file_name.lower().endswith('.xlsx'):
        send_message("⚠️ 仅接受 .xlsx 文件（拒绝 .xls）", target_chat_id=target_chat_id)
        return

    # ── Archive import detection (SETUP_MODE only, strict filename pattern) ──
    _archive_m = re.match(r'^(development|hijack)_(\d{4}-\d{2}-\d{2})\.xlsx$', file_name)
    if _archive_m:
        _handle_archive_import(file_name, file_id, file_size,
                               _archive_m.group(1), _archive_m.group(2),
                               sender_id, target_chat_id)
        return

    size_mb = file_size / (1024 * 1024)
    log(f"Document from {sender_id}: {file_name} ({size_mb:.1f} MB)")
    if size_mb > 20:
        send_message("⚠️ 文件超过 20MB，已拒绝", target_chat_id=target_chat_id)
        return

    # ── Resolve final target + temp staging ──
    try:
        import _runtime as _rt
        uploads_dir = os.path.join(_rt.resolve_data_root(), "uploads")
        excel_final_dir = _rt.excel_dir()
        backups_final = _rt.backups_dir()
    except Exception:
        uploads_dir = os.path.join(DATA_FOLDER, "uploads")
        excel_final_dir = DATA_FOLDER
        backups_final = BACKUP_DIR

    os.makedirs(uploads_dir, exist_ok=True)
    os.makedirs(excel_final_dir, exist_ok=True)
    os.makedirs(backups_final, exist_ok=True)

    tmp_path = os.path.join(uploads_dir, f".upload_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{file_name}")
    final_path = os.path.join(excel_final_dir, file_name)

    # ── Download to temp ──
    send_message(f"📥 正在接收 {_esc_html(file_name)} ...", target_chat_id=target_chat_id)
    saved, err = download_telegram_file(file_id, tmp_path)
    if err or not saved or not os.path.isfile(tmp_path):
        log(f"Upload download failed: {err}")
        send_message("❌ 下载失败，已清理临时文件", target_chat_id=target_chat_id)
        _safe_remove(tmp_path)
        return

    # ── openpyxl verify ──
    try:
        import openpyxl
        wb = openpyxl.load_workbook(tmp_path, data_only=True)
        wb.close()
    except Exception as e:
        log(f"Upload invalid xlsx: {e}")
        send_message("❌ 文件不是有效的 xlsx，已拒绝", target_chat_id=target_chat_id)
        _safe_remove(tmp_path)
        return

    # ── Detect type: development vs hijack ──
    is_dev = '线上办公数据汇总' in file_name and '劫持' not in file_name
    is_hij = '劫持' in file_name and '办公数据汇总' in file_name
    if is_dev and is_hij:
        is_dev, is_hij = False, False
    if not (is_dev or is_hij):
        log(f"Upload type unknown: {file_name}")
        send_message("⚠️ 无法识别文件类型（development/hijack），已拒绝", target_chat_id=target_chat_id)
        _safe_remove(tmp_path)
        return

    # ── data_date validation ──
    try:
        import _platform_config as _pc
        data_date = _pc._detect_data_date(tmp_path)
    except Exception:
        data_date = None
    if not data_date:
        log(f"Upload data_date unidentifiable: {file_name}")
        send_message("⚠️ 无法识别内部 data_date，已拒绝", target_chat_id=target_chat_id)
        _safe_remove(tmp_path)
        return

    # ── Verify filename matches type ──
    if is_dev and '劫持' in file_name:
        send_message("❌ 文件名含「劫持」但判定为开发，已拒绝", target_chat_id=target_chat_id)
        _safe_remove(tmp_path)
        return
    if is_hij and '劫持' not in file_name:
        send_message("❌ 劫持文件必须包含「劫持」字样，已拒绝", target_chat_id=target_chat_id)
        _safe_remove(tmp_path)
        return

    # ── Backup existing formal file (FAIL-CLOSED: block replace if backup fails) ──
    is_overwrite = os.path.exists(final_path)
    if is_overwrite:
        try:
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            shutil.copy2(final_path, os.path.join(backups_final, f"{ts}_{file_name}"))
            log(f"Upload backup: {ts}_{file_name}")
        except Exception as e:
            log(f"Upload backup FAILED, abort replace: {e}")
            send_message("❌ 备份失败，正式文件未改动（Fail-Closed）",
                         target_chat_id=target_chat_id)
            _safe_remove(tmp_path)
            return

    # ── Atomic replace ──
    try:
        os.replace(tmp_path, final_path)
    except Exception as e:
        log(f"Upload os.replace failed: {e}")
        send_message("❌ 文件替换失败，正式文件未改动", target_chat_id=target_chat_id)
        _safe_remove(tmp_path)
        return

    log(f"Upload saved: {final_path} data_date={data_date} type={'dev' if is_dev else 'hij'}")
    send_message(f"✅ 已接收并保存: {_esc_html(file_name)}\n"
                 f"类型: {'开发' if is_dev else '劫持'}\n"
                 f"data_date: <code>{data_date}</code>",
                 target_chat_id=target_chat_id)


def _handle_archive_import(file_name, file_id, file_size, archive_type, archive_date,
                            sender_id, target_chat_id):
    """Import a comparison archive snapshot (.xlsx) into /data/comparison_archive/.

    Strict requirements (ALL must pass):
      - RAILWAY_SETUP_MODE=1
      - Telegram private chat (enforced by caller)
      - sender_id in ADMIN_TELEGRAM_IDS (enforced by caller)
      - filename matches: development_YYYY-MM-DD.xlsx or hijack_YYYY-MM-DD.xlsx
      - openpyxl can open the file
      - internal data_date matches filename YYYY-MM-DD exactly
      - no WRONG_DATE / WRONG_RANGE / quarantine files accepted

    Dedup: SHA256 compare if target exists.
      - same SHA → already_exists_same (skip)
      - different SHA → conflict (reject)
      - not exists → created

    Never triggers: /compare, business push, auto-archive, active Excel replace.
    """
    import hashlib

    # ── SETUP_MODE guard ──
    try:
        import _runtime as _rt_a
        if not _rt_a.is_setup_mode():
            send_message("❌ Archive 导入仅在 SETUP_MODE 下可用\n"
                         "当前 RAILWAY_SETUP_MODE ≠ 1",
                         target_chat_id=target_chat_id)
            return
    except ImportError:
        send_message("❌ 无法检测运行模式，导入已拒绝", target_chat_id=target_chat_id)
        return

    # ── Resolve archive directory ──
    try:
        archive_dir = _rt_a.archive_dir()
    except Exception:
        archive_dir = os.path.join(SCRIPT_DIR, "data", "comparison_archive")
    os.makedirs(archive_dir, exist_ok=True)

    dest_path = os.path.join(archive_dir, file_name)

    # ── Download to temp ──
    tmp_path = os.path.join(tempfile.gettempdir(),
                            f".archive_import_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{file_name}")
    send_message(f"📥 正在接收 archive: {_esc_html(file_name)} ...", target_chat_id=target_chat_id)
    saved, err = download_telegram_file(file_id, tmp_path)
    if err or not saved or not os.path.isfile(tmp_path):
        log(f"Archive import download failed: {err}")
        send_message("❌ 下载失败，已清理临时文件", target_chat_id=target_chat_id)
        _safe_remove(tmp_path)
        return
    try:
        # ── openpyxl validate + detect internal data_date ──
        try:
            import openpyxl
            wb = openpyxl.load_workbook(tmp_path, data_only=True)
            wb.close()
        except Exception as e:
            log(f"Archive import invalid xlsx: {e}")
            send_message("❌ 文件不是有效的 xlsx，已拒绝", target_chat_id=target_chat_id)
            return

        import _platform_config as _pc
        internal_date = _pc._detect_data_date(tmp_path)

        if not internal_date:
            log(f"Archive import: internal date not found (expected {archive_date})")
            send_message(f"❌ 内部 data_date 不匹配\n"
                         f"文件名日期: <code>{archive_date}</code>\n"
                         f"内部日期: 未找到",
                         target_chat_id=target_chat_id)
            return

        if internal_date != archive_date:
            log(f"Archive import: date mismatch file={archive_date} internal={internal_date}")
            send_message(f"❌ 内部 data_date 与文件名不一致\n"
                         f"文件名日期: <code>{archive_date}</code>\n"
                         f"内部日期: <code>{internal_date}</code>\n"
                         f"拒绝导入（疑似 WRONG_DATE）",
                         target_chat_id=target_chat_id)
            return

        # ── SHA256 + place ──
        with open(tmp_path, "rb") as f:
            src_sha = hashlib.sha256(f.read()).hexdigest()

        if os.path.isfile(dest_path):
            with open(dest_path, "rb") as f:
                dst_sha = hashlib.sha256(f.read()).hexdigest()
            if src_sha == dst_sha:
                status = "already_exists_same"
                log(f"Archive import: {file_name} already exists (same SHA)")
                send_message(f"ℹ️ 快照已存在，内容相同\n"
                             f"文件: <code>{_esc_html(file_name)}</code>\n"
                             f"类型: {archive_type}\n"
                             f"data_date: <code>{archive_date}</code>\n"
                             f"大小: {file_size:,} bytes\n"
                             f"SHA256: <code>{src_sha[:12]}</code>\n"
                             f"状态: <b>already_exists_same</b>",
                             target_chat_id=target_chat_id)
            else:
                status = "conflict"
                log(f"Archive import: {file_name} CONFLICT (SHA differs)")
                send_message(f"🚫 快照冲突 — 拒绝覆盖\n"
                             f"文件: <code>{_esc_html(file_name)}</code>\n"
                             f"类型: {archive_type}\n"
                             f"data_date: <code>{archive_date}</code>\n"
                             f"大小: {file_size:,} bytes\n"
                             f"源 SHA256: <code>{src_sha[:12]}</code>\n"
                             f"目标 SHA256: <code>{dst_sha[:12]}</code>\n"
                             f"状态: <b>conflict</b>",
                             target_chat_id=target_chat_id)
        else:
            shutil.move(tmp_path, dest_path)
            status = "created"
            log(f"Archive import: {file_name} created SHA={src_sha[:12]}")
            send_message(f"✅ 快照已归档\n"
                         f"文件: <code>{_esc_html(file_name)}</code>\n"
                         f"类型: {archive_type}\n"
                         f"data_date: <code>{archive_date}</code>\n"
                         f"大小: {file_size:,} bytes\n"
                         f"SHA256: <code>{src_sha[:12]}</code>\n"
                         f"状态: <b>created</b>",
                         target_chat_id=target_chat_id)
    finally:
        _safe_remove(tmp_path)


def _archive_status_cmd(target_chat_id=None):
    """Admin command: /archive_status — show comparison_archive inventory.
    Uses active Excel data_date (NOT datetime.now()) as comparison baseline."""
    import _runtime as _rt_a
    from datetime import datetime, timedelta

    try:
        archive_dir = _rt_a.archive_dir()
    except Exception:
        archive_dir = os.path.join(SCRIPT_DIR, "data", "comparison_archive")

    if not os.path.isdir(archive_dir):
        send_message("📂 comparison_archive 目录不存在", target_chat_id=target_chat_id)
        return

    all_files = sorted([f for f in os.listdir(archive_dir)
                        if f.endswith('.xlsx') and not f.startswith('.')])

    dev_files = [f for f in all_files if f.startswith("development_")]
    hij_files = [f for f in all_files if f.startswith("hijack_")]
    other_files = [f for f in all_files
                   if not f.startswith("development_") and not f.startswith("hijack_")]

    # Quarantine
    quar_dir = os.path.join(archive_dir, "quarantine")
    quar_files = []
    if os.path.isdir(quar_dir):
        quar_files = sorted([f for f in os.listdir(quar_dir) if f.endswith('.xlsx')])

    lines = ["📂 **comparison_archive 状态**\n"]

    # ── Helper: compute yesterday & last-month-same-day from a data_date ──
    def _calc_targets(data_date_str):
        """Given 'YYYY-MM-DD', return (yesterday_str, last_month_same_day_str)."""
        dt = datetime.strptime(data_date_str, '%Y-%m-%d')
        yesterday = dt - timedelta(days=1)
        yday = yesterday.strftime('%Y-%m-%d')
        # Last month same day
        if dt.month == 1:
            lm = dt.replace(year=dt.year - 1, month=12)
        else:
            lm = dt.replace(month=dt.month - 1)
        try:
            lm_same = lm.replace(day=dt.day)
        except ValueError:
            lm_same = lm.replace(day=28)
        return yday, lm_same.strftime('%Y-%m-%d')

    # ── Per-kind builder ──
    def _kind_section(kind, label, archive_files):
        """Build lines for one kind (development/hijack)."""
        sec = [f"**【{label}】**"]
        import _platform_config as _pc

        # Resolve active Excel data_date
        active_path, active_fname, active_dd, active_errs = _pc.get_active_excel(kind)
        if active_dd:
            sec.append(f"当前 data_date: <code>{active_dd}</code>")
            yday, lm_day = _calc_targets(active_dd)
            target_yday = f"{kind}_{yday}.xlsx"
            target_lm = f"{kind}_{lm_day}.xlsx"
            sec.append(f"昨日目标 ({yday}): {'✅' if target_yday in all_files else '❌ 缺失'}")
            sec.append(f"上月同日 ({lm_day}): {'✅' if target_lm in all_files else '❌ 缺失'}")
            sec.append(f"快照数量: {len(archive_files)} 份")
            if archive_files:
                first = archive_files[0].replace(f"{kind}_", "").replace(".xlsx", "")
                last = archive_files[-1].replace(f"{kind}_", "").replace(".xlsx", "")
                sec.append(f"范围: {first} → {last}")
        elif active_errs:
            sec.append(f"⚠️ 无法识别 data_date: {active_errs[0] if active_errs else '未知错误'}")
        else:
            sec.append("⚠️ 无法识别 data_date（未找到 active Excel）")
        return sec

    lines.extend(_kind_section("development", "Development", dev_files))
    lines.append("")
    lines.extend(_kind_section("hijack", "Hijack", hij_files))

    # Other / anomaly files
    if other_files:
        lines.append(f"\n⚠️ 非标准文件 ({len(other_files)}):")
        for of in other_files[:10]:
            op = os.path.join(archive_dir, of)
            size = os.path.getsize(op) if os.path.isfile(op) else 0
            lines.append(f"  {of} ({size:,} bytes)")

    if quar_files:
        lines.append(f"\n🔒 Quarantine ({len(quar_files)}):")
        for qf in quar_files[:5]:
            qp = os.path.join(quar_dir, qf)
            lines.append(f"  {qf} ({os.path.getsize(qp):,} bytes)")

    send_message("\n".join(lines), target_chat_id=target_chat_id)


def _safe_remove(path):
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception:
        pass


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


CONFIG_FILE = os.path.join(SCRIPT_DIR, "config.json")


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
        send_message("用法: /set &lt;key&gt; &lt;value&gt;\n如: /set daily_push_time 21:30\n"
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
        # Also update Windows scheduled task (skip on Railway/Linux)
        try:
            import _runtime
            if _runtime.is_railway():
                send_message("Railway环境不支持Windows计划任务，请使用Railway Cron或Bot内部调度配置")
                return
        except ImportError:
            pass
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

                    # Admin read-only commands allowed in private chat.
                    # Business push commands remain group-only.
                    ADMIN_PRIVATE_COMMANDS = {
                        "/status", "/状态",
                        "/data_status", "/数据状态",
                        "/snapshot_check", "/快照检查",
                        "/compare_check", "/对比检查",
                        "/archive_status", "/归档状态",
                    }
                    _cmd_raw = text.split()[0].lower().split("@")[0] if text else ""
                    chat_id = chat.get("id")
                    chat_type = chat.get("type")

                    is_target_group = (chat_id == CHAT_ID)
                    is_private_admin_command = (
                        chat_type == "private"
                        and _cmd_raw in ADMIN_PRIVATE_COMMANDS
                    )

                    # Setup mode: allow admin private-chat / target-group document upload
                    try:
                        import _runtime as _rt
                        _in_setup = _rt.is_setup_mode()
                    except Exception:
                        _in_setup = False
                    is_private_document = (chat_type == "private" and "document" in msg)
                    is_setup_admin_upload = (
                        _in_setup and (is_private_document or is_target_group)
                    )

                    if not is_target_group and not is_private_admin_command and not is_setup_admin_upload:
                        # ── Explicit denial: admin push commands in private chat ──
                        _PUSH_COMMANDS = {"/compare", "/compare_date", "/数据对比", "/指定对比"}
                        if chat_type == "private" and _cmd_raw in _PUSH_COMMANDS:
                            sender_id_priv = str(msg.get("from", {}).get("id", ""))
                            try:
                                admins_priv = [str(a) for a in (_plat_cfg.get_admin_ids() if _plat_cfg else [])]
                            except Exception:
                                admins_priv = []
                            if admins_priv and sender_id_priv in admins_priv:
                                send_message("⚠️ 此命令仅允许在目标业务群中使用\n请切换到业务群发送",
                                             target_chat_id=chat_id)
                                continue
                        continue

                    # Replies for private chat go back to the private chat;
                    # group replies stay in the business group.
                    reply_chat_id = chat_id if (is_private_admin_command or is_private_document) else CHAT_ID

                    # Non-admin private command → explicit denial to that private chat
                    if is_private_admin_command or is_private_document:
                        sender_id_priv = str(msg.get("from", {}).get("id", ""))
                        admins_priv = [str(a) for a in (_plat_cfg.get_admin_ids() if _plat_cfg else [])]
                        if not admins_priv or sender_id_priv not in admins_priv:
                            send_message("❌ 权限不足，仅 Admin 可执行此操作",
                                         target_chat_id=reply_chat_id)
                            continue

                    user = msg.get("from", {}).get("first_name", "用户")

                    # ── Document upload (Excel files) ──
                    if "document" in msg:
                        handle_document(msg, target_chat_id=reply_chat_id)
                        continue

                    if not text:
                        continue

                    cmd = text.split()[0].lower().split("@")[0]

                    # ── Setup mode: block all business push/compare commands ──
                    try:
                        import _runtime as _rt
                        _in_setup = _rt.is_setup_mode()
                    except Exception:
                        _in_setup = False
                    _SETUP_BLOCKED = {
                        "/push", "/推送", "/daily", "/monthly", "/hijack",
                        "/push2", "/数据截图", "/push3", "/劫持办公",
                        "/push4", "/劫持人事", "/compare", "/数据对比",
                        "/compare_date", "/指定对比",
                    }
                    if _in_setup and cmd in _SETUP_BLOCKED:
                        send_message("🛠 <b>SETUP MODE</b>\n\n"
                                     "当前为 Railway 初始化模式。\n"
                                     "仅允许管理员上传 Excel 文件。\n"
                                     "请先上传开发与劫持 Excel，再用 /data_status 验证，"
                                     "完成后将 RAILWAY_SETUP_MODE 改为 0 并 redeploy。",
                                     target_chat_id=reply_chat_id)
                        continue

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

                    elif cmd in ("/status", "/状态"):
                        if _plat_cfg is None:
                            send_message("❌ 平台配置模块未加载", target_chat_id=reply_chat_id)
                            continue
                        sender_id = str(msg.get("from", {}).get("id", ""))
                        admin_ids = [str(a) for a in _plat_cfg.get_admin_ids()]
                        if not admin_ids:
                            send_message("❌ 尚未配置 Admin Telegram ID，状态命令已禁用",
                                         target_chat_id=reply_chat_id)
                            continue
                        if sender_id not in admin_ids:
                            send_message("❌ 权限不足，仅 Admin 可执行此操作",
                                         target_chat_id=reply_chat_id)
                            continue
                        try:
                            status_text = _plat_cfg.format_bot_status(DATA_FOLDER)
                            send_message(status_text, target_chat_id=reply_chat_id)
                        except Exception as e:
                            log(f"/status error: {e}")
                            send_message("❌ 状态获取失败", target_chat_id=reply_chat_id)

                    elif cmd in ("/snapshot_check", "/快照检查"):
                        if _plat_cfg is None:
                            send_message("❌ 平台配置模块未加载", target_chat_id=reply_chat_id)
                            continue
                        sender_id = str(msg.get("from", {}).get("id", ""))
                        admin_ids = [str(a) for a in _plat_cfg.get_admin_ids()]
                        if not admin_ids:
                            send_message("❌ 尚未配置 Admin Telegram ID，快照检查命令已禁用",
                                         target_chat_id=reply_chat_id)
                            continue
                        if sender_id not in admin_ids:
                            send_message("❌ 权限不足，仅 Admin 可执行此操作",
                                         target_chat_id=reply_chat_id)
                            continue
                        try:
                            status_text = _plat_cfg.format_snapshot_check(DATA_FOLDER)
                            send_message(status_text, target_chat_id=reply_chat_id)
                        except Exception as e:
                            log(f"/snapshot_check error: {e}")
                            send_message("❌ 快照检查失败", target_chat_id=reply_chat_id)

                    elif cmd in ("/data_status", "/数据状态"):
                        if _plat_cfg is None:
                            send_message("❌ 平台配置模块未加载", target_chat_id=reply_chat_id)
                            continue
                        sender_id = str(msg.get("from", {}).get("id", ""))
                        admin_ids = [str(a) for a in _plat_cfg.get_admin_ids()]
                        if not admin_ids:
                            send_message("❌ 尚未配置 Admin Telegram ID，数据状态命令已禁用",
                                         target_chat_id=reply_chat_id)
                            continue
                        if sender_id not in admin_ids:
                            send_message("❌ 权限不足，仅 Admin 可执行此操作",
                                         target_chat_id=reply_chat_id)
                            continue
                        try:
                            status_text = _plat_cfg.format_data_status(DATA_FOLDER)
                            send_message(status_text, target_chat_id=reply_chat_id)
                        except Exception as e:
                            log(f"/data_status error: {e}")
                            send_message("❌ 数据状态获取失败", target_chat_id=reply_chat_id)

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
                            send_message("❌ 管理员名单未配置，此功能已禁用",
                                         target_chat_id=reply_chat_id); continue
                        if sender_id not in admin_ids:
                            send_message("❌ 权限不足，仅管理员可执行",
                                         target_chat_id=reply_chat_id); continue
                        try:
                            import comparison_push as cp
                            status_text = cp.check_comparison_status()
                            send_message(status_text, target_chat_id=reply_chat_id)
                        except Exception as e:
                            log(f"Compare check error: {e}")
                            send_message(f"❌ 状态检查失败: {e}", target_chat_id=reply_chat_id)

                    elif cmd in ("/archive_status", "/归档状态"):
                        sender_id = str(msg.get("from", {}).get("id", ""))
                        admin_ids = [str(a) for a in (_plat_cfg.get_admin_ids() if _plat_cfg else [])]
                        if not admin_ids:
                            send_message("❌ 管理员名单未配置，此功能已禁用",
                                         target_chat_id=reply_chat_id); continue
                        if sender_id not in admin_ids:
                            send_message("❌ 权限不足，仅管理员可执行",
                                         target_chat_id=reply_chat_id); continue
                        try:
                            _archive_status_cmd(target_chat_id=reply_chat_id)
                        except Exception as e:
                            log(f"Archive status error: {e}")
                            send_message(f"❌ Archive 状态检查失败: {e}", target_chat_id=reply_chat_id)

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
                        send_message("📚 <b>WFHDPbot 使用说明</b>\n"
                                     "━━━━━━━━━━━━━━━━\n\n"
                                     "📊 <b>数据推送</b>\n"
                                     "├ /push — 推送1(文本)\n"
                                     "├ /push2 — 推送2(数据截图+Excel)\n"
                                     "├ /push3 — 推送3(劫持办公)\n"
                                     "├ /push4 — 推送4(劫持人事)\n"
                                     "├ /hijack — 推送2+3+4全部\n"
                                     "├ /compare — 数据对比\n"
                                     "├ /compare_date &lt;日期&gt; — 指定日期对比\n"
                                     "└ 推送 / 推送5月6日 / 整个4月\n\n"
                                     "🛠 <b>状态查询</b>\n"
                                     "├ /status — Bot 状态\n"
                                     "├ /data_status — 数据状态\n"
                                     "├ /snapshot_check — 快照检查\n"
                                     "├ /compare_check — 对比可用性\n"
                                     "├ /platforms — 平台配置\n"
                                     "└ /files — 数据文件列表\n\n"
                                     "🏆 <b>排行查询</b>\n"
                                     "├ 排名 — 站点排行榜\n"
                                     "└ 排名roi / 排名充提差\n\n"
                                     "📤 <b>上传文件</b>\n"
                                     "└ 直接拖 .xlsx 文件到群组，Bot 自动下载保存\n\n"
                                     "⚙️ <b>管理配置</b>\n"
                                     "├ /menu — 按钮菜单\n"
                                     "├ /config — 查看配置\n"
                                     "├ /set daily_push_time 21:30\n"
                                     "├ /toggle daily_table — 开关模块\n"
                                     "├ /reload_config — 重载配置(Admin)\n"
                                     "└ /en — 英文版推送")

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
    import os as _os
    # Railway smoke test mode: run preflight only, no polling, no Telegram
    if _os.environ.get("RAILWAY_SMOKE_TEST", "").strip() == "1":
        try:
            import _runtime
            sys.exit(_runtime.run_smoke_test())
        except ImportError:
            print("[ERROR] _runtime not importable")
            sys.exit(1)
    main()
