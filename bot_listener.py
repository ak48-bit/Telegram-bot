import json, urllib.request, urllib.error, time, subprocess, sys, re, io, os, shutil, tempfile
from datetime import datetime

# Fix encoding for Windows console
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

TOKEN = "8731392429:AAFb6QywB4NG4TDTmeOtzDbS7IR_G95JzAI"
CHAT_ID = -1003899337250
API = f"https://api.telegram.org/bot{TOKEN}"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PUSH_SCRIPT = os.path.join(SCRIPT_DIR, "push_update.py")
LOG_FILE = os.path.join(SCRIPT_DIR, "bot_log.txt")
LOCK_FILE = os.path.join(tempfile.gettempdir(), "bot_listener_lock.txt")


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


DATA_FOLDER = r"C:\Users\ak481\OneDrive\Desktop\新建文件夹"


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
        send_message(f"⚠️ 文件 {file_name} 已存在，正在覆盖...")

    send_message(f"📥 正在接收 {user} 上传的 {file_name} ...")

    saved, err = download_telegram_file(file_id, save_path)

    if err:
        log(f"Download failed: {err}")
        send_message(f"❌ 下载失败: {err}")
        return

    log(f"Saved: {save_path}")
    overwrite_note = " (已覆盖旧文件)" if is_overwrite else ""

    # Offer quick push
    keyboard = {
        "inline_keyboard": [
            [{"text": "📊 立即推送最新数据", "callback_data": "push_all"}],
            [{"text": "📋 查看菜单", "callback_data": "menu"}],
        ]
    }
    send_message(f"✅ 已接收并保存: {file_name}{overwrite_note}\n"
                 f"文件大小: {size_mb:.1f} MB\n"
                 f"存放位置: 新建文件夹\\{file_name}",
                 reply_markup=keyboard)


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
            [{"text": "📊 推送全部数据", "callback_data": "push_all"}],
            [{"text": "📅 线上办公数据汇总", "callback_data": "daily"}],
            [{"text": "📆 当月累计汇总", "callback_data": "monthly"}],
            [{"text": "🛡️ 劫持汇总+人事", "callback_data": "hijack"}],
            [{"text": "⚙️ 配置管理", "callback_data": "cfg_menu"}, {"text": "📋 指令说明", "callback_data": "help"}],
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
        log("Bot listener started")
        offset = 0
        while True:
            try:
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
                                         "  /toggle daily_table — 开关模块")
                            continue

                        # ── Push actions ──
                        if cb_data == "push_all":
                            answer_callback(cb_id, "正在生成全部数据...")
                            send_message(f"⚡ {cb_user} 触发推送全部数据...")
                            output = run_push(sections="daily_table,monthly_table,hijack_office,hijack_hr,dod_comparison,anomaly_alerts,fraud_alerts")
                            print(f"[{datetime.now()}] Push all done: {output[:200]}")
                            continue

                        if cb_data == "daily":
                            answer_callback(cb_id, "正在生成地推数据...")
                            send_message(f"⚡ {cb_user} 触发地推数据推送...")
                            output = run_push(sections="daily_table,dod_comparison,anomaly_alerts,fraud_alerts")
                            print(f"[{datetime.now()}] Daily push done: {output[:200]}")
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
                        files = sorted([f for f in os.listdir(DATA_FOLDER) if f.endswith('.xlsx') and '副本' not in f and 'Copy' not in f])
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

                    elif cmd == "/help":
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
                                     "  /menu — 按钮菜单\n"
                                     "  /config — 查看配置\n"
                                     "  /set daily_push_time 21:30\n"
                                     "  /set title_daily 新标题\n"
                                     "  /toggle daily_table — 开关模块")

                    elif cmd == "/start":
                        send_message("已就绪。发送 /menu 打开菜单，或直接说：\n• 推送 — 推送最新数据\n• 推送 5月6日 — 推送指定日期")

            except Exception as e:
                log(f"Poll error: {e}")
                time.sleep(5)
    finally:
        release_lock()


if __name__ == "__main__":
    main()
