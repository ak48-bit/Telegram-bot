"""Comparison Push — Day-over-Day and Month-over-Month data comparison.
/compare       → auto-detect current file, compare vs previous day and previous month
/compare_date  → specify exact date, read from archive
"""

import os, sys, json, io, hashlib, shutil
from datetime import datetime, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from PIL import Image, ImageDraw, ImageFont
import openpyxl

with open(os.path.join(SCRIPT_DIR, "config.json"), "r", encoding="utf-8") as f:
    CFG = json.load(f)

DATA_FOLDER = CFG.get("data_folder", SCRIPT_DIR)
ARCHIVE_DIR = os.path.join(SCRIPT_DIR, "data", "comparison_archive")
GEN_DIR = os.path.join(SCRIPT_DIR, "data", "generated")
os.makedirs(ARCHIVE_DIR, exist_ok=True)
os.makedirs(GEN_DIR, exist_ok=True)

FONT_PATH = "C:/Windows/Fonts/msyh.ttc"
FONT_BOLD_PATH = "C:/Windows/Fonts/msyhbd.ttc"

NEW_MAP = {"现场人数": 4, "转线上人数": 5, "线上人数": 6, "人均开发": 7,
           "总注册": 8, "总开发人数": 9, "首存金额": 10,
           "充值人数": 19, "复存人数": 20, "存款": 21, "提款": 22, "存提差": 23}
OLD_MAP = {"现场人数": 3, "转线上人数": None, "线上人数": 5, "人均开发": 6,
           "总注册": 7, "总开发人数": 8, "首存金额": 9,
           "充值人数": 18, "复存人数": 19, "存款": 20, "提款": 21, "存提差": 22}
LABELS = list(NEW_MAP.keys())


def _get_map(ws):
    return NEW_MAP if "Onsite HC" in str(ws.cell(row=3, column=4).value or "") else OLD_MAP


def _find_total_row(ws):
    for r in range(1, ws.max_row + 1):
        for c in (1, 2, 3):
            if str(ws.cell(row=r, column=c).value or "").strip() == "总":
                return r
    return None


def _read_internal_date(filepath):
    """Extract internal data cutoff date from Excel.
    Priority:
      1. Parse 汇总 sheet title: '菲律宾 07月01-25' → 2026-07-25
         If only month found ('菲律宾 07月01-'), use month + scan sheets for latest day
      2. Scan platform sheets for latest data row with non-zero FTD
      3. Fallback: datetime cells in rows 1-5
    Returns 'YYYY-MM-DD' or None."""
    import re
    if not os.path.isfile(filepath):
        return None
    wb = openpyxl.load_workbook(filepath, data_only=True)
    ws = wb[wb.sheetnames[0]]
    year = datetime.now().year

    # 1. Parse title text
    for r in range(1, 4):
        for c in range(1, 6):
            v = str(ws.cell(row=r, column=c).value or "")
            # Full pattern: '07月01-25'
            m = re.search(r'(\d{1,2})\s*月\s*\d{1,2}\s*[-–—]\s*(\d{1,2})', v)
            if m:
                wb.close()
                return f"{year}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
            # Partial pattern: '07月01-' (month only, need to find day from sheets)
            m2 = re.search(r'(\d{1,2})\s*月', v)
            if m2:
                month = int(m2.group(1))
                # Scan platform sheets for latest day in this month
                latest_day = _find_latest_day_in_month(wb, year, month)
                if latest_day:
                    wb.close()
                    return f"{year}-{month:02d}-{latest_day:02d}"

    # 2. Fallback: datetime cells
    for r in range(1, 6):
        for c in range(1, 6):
            dv = ws.cell(row=r, column=c).value
            if dv and hasattr(dv, 'strftime'):
                wb.close()
                return dv.strftime('%Y-%m-%d')

    # 3. Platform sheets
    latest_day = _find_latest_day_in_month(wb, year, None)
    wb.close()
    if latest_day:
        today = datetime.now()
        return f"{year}-{today.month:02d}-{latest_day:02d}"
    return None


def _find_latest_day_in_month(wb, year, month):
    """Scan platform sheets for the latest day with real business data.
    Checks: register(col7), FTD(col8), FTD amount(col20), depositors(col11),
            deposit(col23), withdraw(col24). At least one must be non-zero."""
    import re
    latest_day = 0
    for sn in wb.sheetnames:
        if not re.match(r'^(PH|BD|MM)\d', sn):
            continue
        try:
            pws = wb[sn]
            for row_idx in range(pws.max_row, 5, -1):
                d = pws.cell(row=row_idx, column=1).value
                if not d or not hasattr(d, 'strftime'):
                    continue
                if month is not None and d.month != month:
                    continue
                # Check multiple business fields — at least one non-zero
                fields = [pws.cell(row=row_idx, column=c).value for c in (7, 8, 20, 11, 23, 24)]
                has_data = False
                for v in fields:
                    try:
                        if v is not None and float(v) != 0:
                            has_data = True
                            break
                    except (ValueError, TypeError):
                        pass
                if has_data and d.day > latest_day:
                    latest_day = d.day
        except Exception:
            continue
    return latest_day if latest_day > 0 else None


def _read_total_row(filepath):
    if not os.path.isfile(filepath):
        raise FileNotFoundError(f"文件不存在: {os.path.basename(filepath)}")
    wb = openpyxl.load_workbook(filepath, data_only=True)
    ws = wb[wb.sheetnames[0]]
    col_map = _get_map(ws)
    total_row = _find_total_row(ws)
    if total_row is None:
        wb.close()
        raise ValueError(f"未找到 '总' 行: {os.path.basename(filepath)}")
    data = {}
    for label in LABELS:
        c = col_map.get(label)
        if c is None: data[label] = None; continue
        v = ws.cell(row=total_row, column=c).value
        try: data[label] = float(v) if v is not None else 0.0
        except (ValueError, TypeError): data[label] = 0.0
    wb.close()
    return data


def _find_latest(data_folder, keyword, exclude_kw=None):
    best, best_mtime = None, 0
    for f in os.listdir(data_folder):
        if not f.endswith('.xlsx') or f.startswith('~$'): continue
        if keyword not in f: continue
        if exclude_kw and exclude_kw in f: continue
        path = os.path.join(data_folder, f)
        mtime = os.path.getmtime(path)
        if mtime > best_mtime: best_mtime = mtime; best = path
    return best


def _snapshot(src_path, archive_key):
    """Save snapshot. Returns (dest_path, warning_or_None)."""
    date_str = _read_internal_date(src_path)
    if not date_str:
        date_str = datetime.now().strftime('%Y-%m-%d')
    dest = os.path.join(ARCHIVE_DIR, f"{archive_key}_{date_str}.xlsx")
    with open(src_path, 'rb') as f:
        src_md5 = hashlib.md5(f.read()).hexdigest()
    if os.path.isfile(dest):
        with open(dest, 'rb') as f:
            if hashlib.md5(f.read()).hexdigest() == src_md5:
                return dest, None
        return dest, f"今天历史快照已存在，实时Excel已更新（MD5不同），是否覆盖？"
    shutil.copy2(src_path, dest)
    return dest, None


def _archive_path(category, date_str):
    return os.path.join(ARCHIVE_DIR, f"{category}_{date_str}.xlsx")


def _date_label(date_str):
    """'2026-07-25' → '7月25日'"""
    try:
        d = datetime.strptime(date_str, '%Y-%m-%d')
        return f"{d.month}月{d.day}日"
    except: return date_str


# ── Calculation / formatting ──

def _calc(cur, prev):
    if cur is None or prev is None: return 0, None, "—"
    diff = cur - prev
    if prev == 0: return diff, None, "—"
    pct = (diff / prev) * 100
    return diff, pct, "↑" if diff > 0 else ("↓" if diff < 0 else "—")


def _fmt_val(label, val):
    if val is None: return "—"
    if "人数" in label or "注册" in label or "开发" in label: return f"{int(round(val)):,}"
    if "人均" in label: return f"{val:,.2f}"
    return f"{val:,.2f}"


def _fmt_diff(label, diff):
    if "人数" in label or "注册" in label or "开发" in label: return f"{int(round(diff)):+,}"
    if "人均" in label: return f"{diff:+,.2f}"
    return f"{diff:+,.2f}"


def _fmt_pct(pct):
    return "—" if pct is None else f"{pct:+.1f}%"


# ── Image builder ──

def build_comparison_image(title, subtitle, cur_data, prev_data, cutoff_note=None):
    font_title = ImageFont.truetype(FONT_BOLD_PATH, 18)
    font_sub = ImageFont.truetype(FONT_PATH, 14)
    font_hdr = ImageFont.truetype(FONT_BOLD_PATH, 13)
    font_body = ImageFont.truetype(FONT_PATH, 12)
    font_footer = ImageFont.truetype(FONT_PATH, 10)
    font_cutoff = ImageFont.truetype(FONT_PATH, 11)

    headers = ["指标", "当前日", "对比日", "增减值", "增减比例", "变化"]
    col_widths = [140, 120, 120, 120, 100, 60]
    rows = []
    for label in LABELS:
        diff, pct, arrow = _calc(cur_data.get(label, 0), prev_data.get(label, 0))
        rows.append((label,
                     _fmt_val(label, cur_data.get(label, 0)),
                     _fmt_val(label, prev_data.get(label, 0)),
                     _fmt_diff(label, diff), _fmt_pct(pct), arrow))

    row_h, hdr_h, title_h, sub_h = 28, 32, 42, 26
    cut_h = 28 if cutoff_note else 0
    total_w = sum(col_widths)
    total_h = title_h + sub_h + hdr_h + len(rows) * row_h + cut_h + 28

    DARK_BLUE = (31, 56, 100); LIGHT_BLUE = (220, 235, 252); WHITE = (255, 255, 255)
    GREEN_BG = (235, 255, 235); RED_BG = (255, 235, 235); GRAY_BG = (245, 245, 245)
    DARK = (33, 37, 41); GRAY = (140, 140, 140)
    YELLOW_BG = (255, 255, 220); ORANGE = (180, 120, 0)

    img = Image.new("RGB", (total_w, total_h), WHITE)
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, total_w - 1, title_h], fill=DARK_BLUE)
    tw = font_title.getbbox(title)[2]
    draw.text(((total_w - tw) // 2, 10), title, fill=WHITE, font=font_title)
    y = title_h
    draw.rectangle([0, y, total_w - 1, y + sub_h], fill=LIGHT_BLUE)
    sw = font_sub.getbbox(subtitle)[2]
    draw.text(((total_w - sw) // 2, y + 4), subtitle, fill=DARK, font=font_sub)
    y += sub_h
    x = 0
    for ci, h in enumerate(headers):
        cw = col_widths[ci]
        draw.rectangle([x, y, x + cw - 1, y + hdr_h], fill=DARK_BLUE)
        tw = font_hdr.getbbox(h)[2]
        draw.text((x + (cw - tw) // 2, y + 7), h, fill=WHITE, font=font_hdr)
        x += cw
    y += hdr_h
    for ri, row in enumerate(rows):
        arrow = row[5]
        bg = GREEN_BG if arrow == "↑" else (RED_BG if arrow == "↓" else (GRAY_BG if ri % 2 == 0 else WHITE))
        x = 0
        for ci, val in enumerate(row):
            cw = col_widths[ci]
            draw.rectangle([x, y, x + cw - 1, y + row_h], fill=bg, outline=(230, 230, 230))
            tw = font_body.getbbox(str(val))[2]
            draw.text((x + (cw - tw) // 2, y + 5), str(val), fill=DARK, font=font_body)
            x += cw
        y += row_h
    if cutoff_note:
        draw.rectangle([0, y, total_w - 1, y + cut_h], fill=YELLOW_BG)
        dw = font_cutoff.getbbox(cutoff_note)[2]
        draw.text(((total_w - dw) // 2, y + 4), cutoff_note, fill=ORANGE, font=font_cutoff)
        y += cut_h
    footer = f"@WFHDPbot | {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    draw.text((10, y + 2), footer, fill=GRAY, font=font_footer)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ── Main generation ──

def generate_comparison(target_date_str=None):
    """Generate comparison. If target_date_str is given (YYYY-MM-DD), use archive.
    Otherwise auto-detect from current live file."""
    errors = []

    if target_date_str:
        # /compare_date mode: read from archive
        cur_date = target_date_str
        try:
            cur_dt = datetime.strptime(cur_date, '%Y-%m-%d')
            prev_day_dt = cur_dt - timedelta(days=1)
            prev_month_dt = cur_dt.replace(month=cur_dt.month - 1) if cur_dt.month > 1 else cur_dt.replace(year=cur_dt.year - 1, month=12)
        except:
            return False, f"日期格式错误: {target_date_str}", [], ""

        cur_path = _archive_path("development", cur_date)
        prev_day_path = _archive_path("development", prev_day_dt.strftime('%Y-%m-%d'))
        prev_month_path = _archive_path("development", prev_month_dt.strftime('%Y-%m-%d'))

        cur_label = _date_label(cur_date)
        prev_label = _date_label(prev_day_dt.strftime('%Y-%m-%d'))
        month_label = _date_label(prev_month_dt.strftime('%Y-%m-%d'))

    else:
        # /compare mode: auto-detect from live file
        live_path = _find_latest(DATA_FOLDER, "线上办公数据汇总", "劫持")
        if not live_path:
            return False, "未找到当前实时开发Excel", [], ""

        cur_date = _read_internal_date(live_path)
        if not cur_date:
            return False, "无法读取实时Excel内部日期", [], ""

        # Snapshot live file
        _snapshot(live_path, "development")
        hij_path = _find_latest(DATA_FOLDER, "劫持（线上办公数据汇总）")
        if hij_path:
            _snapshot(hij_path, "hijack")

        cur_path = live_path
        try:
            cur_dt = datetime.strptime(cur_date, '%Y-%m-%d')
            prev_day_dt = cur_dt - timedelta(days=1)
            prev_month_dt = cur_dt.replace(month=cur_dt.month - 1) if cur_dt.month > 1 else cur_dt.replace(year=cur_dt.year - 1, month=12)
        except:
            return False, f"内部日期解析失败: {cur_date}", [], ""

        prev_day_path = _archive_path("development", prev_day_dt.strftime('%Y-%m-%d'))
        prev_month_path = _archive_path("development", prev_month_dt.strftime('%Y-%m-%d'))

        cur_label = _date_label(cur_date)
        prev_label = _date_label(prev_day_dt.strftime('%Y-%m-%d'))
        month_label = _date_label(prev_month_dt.strftime('%Y-%m-%d'))

    # Collect files
    files = {}
    for key, path, label in [("cur", cur_path, cur_label),
                              ("prev_day", prev_day_path, prev_label),
                              ("prev_month", prev_month_path, month_label)]:
        if not os.path.isfile(path):
            errors.append(f"缺少文件: {label} ({os.path.basename(path)})")
        else:
            files[key] = path

    if errors:
        return False, "\n".join(errors), [], ""

    # Read data
    data = {}
    for key in files:
        try:
            data[key] = _read_total_row(files[key])
        except Exception as e:
            errors.append(f"读取失败 {os.path.basename(files[key])}: {e}")
    if errors:
        return False, "\n".join(errors), [], ""

    cur = data["cur"]; prev_day = data["prev_day"]; prev_month = data["prev_month"]

    # Images
    results = []
    cutoff = None
    if CFG.get("comparison", {}).get("previous_day_cutoff_note"):
        cutoff = (f"⚠️ 标注为「{prev_label}」的源文件，工作簿内部【汇总】截止日显示为22日。"
                  f"本次仍按用户指定名称列为{prev_label}。")

    img1 = build_comparison_image(
        f"线上办公数据对比 — {cur_label} vs {prev_label}",
        f"数据口径：{cur_label} 与 {prev_label} 当日汇总「总」行对比",
        cur, prev_day, cutoff_note=cutoff)
    results.append((img1, f"📊 {cur_label} vs {prev_label}"))

    img2 = build_comparison_image(
        f"线上办公数据对比 — {cur_label} vs {month_label}",
        f"数据口径：{cur_label} 与 {month_label} 当日汇总「总」行对比",
        cur, prev_month)
    results.append((img2, f"📊 {cur_label} vs {month_label}"))

    # Conclusion
    def _pct(cur_d, prev_d, label):
        cv = cur_d.get(label, 0); pv = prev_d.get(label, 0)
        if cv is None or pv is None: return f"• {label}数据不可用"
        diff, pct, arrow = _calc(cv, pv)
        if pct is None: return f"• {label}无法计算（对比日数值为0）"
        direction = "增长" if pct > 0 else ("下降" if pct < 0 else "持平")
        return f"• {label}{direction} {abs(pct):.1f}%"

    conclusion = (
        f"📊 线上办公数据对比结论\n\n"
        f"【{cur_label} vs {prev_label}】\n"
        f"{_pct(cur, prev_day, '总开发人数')}\n"
        f"{_pct(cur, prev_day, '首存金额')}\n"
        f"{_pct(cur, prev_day, '存提差')}\n"
        f"{_pct(cur, prev_day, '人均开发')}\n\n"
        f"【{cur_label} vs {month_label}】\n"
        f"{_pct(cur, prev_month, '线上人数')}\n"
        f"{_pct(cur, prev_month, '人均开发')}\n"
        f"{_pct(cur, prev_month, '总开发人数')}\n"
    )
    _, wdr_pct, _ = _calc(cur.get("提款", 0), prev_month.get("提款", 0))
    _, diff_pct, _ = _calc(cur.get("存提差", 0), prev_month.get("存提差", 0))
    if wdr_pct is not None and diff_pct is not None and wdr_pct > 0 and diff_pct < 0:
        conclusion += f"• 提款增长较快，导致存提差下降 {abs(diff_pct):.1f}%"
    elif wdr_pct is not None and diff_pct is not None:
        conclusion += f"• 提款变化 {wdr_pct:+.1f}%，存提差变化 {diff_pct:+.1f}%"
    else:
        conclusion += "• 提款与存提差无法计算"

    return True, "", results, conclusion


def send_comparison(send_photo_fn, send_message_fn, target_date=None):
    ok, error, images, conclusion = generate_comparison(target_date)
    if not ok:
        send_message_fn(f"❌ 数据对比生成失败:\n{error}")
        return
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    os.makedirs(GEN_DIR, exist_ok=True)
    for i, (img_bytes, caption) in enumerate(images):
        fname = f"comparison_{ts}_{i+1}.png"
        with open(os.path.join(GEN_DIR, fname), "wb") as f:
            f.write(img_bytes)
    for img_bytes, caption in images:
        try:
            send_photo_fn(img_bytes, caption)
        except Exception as e:
            send_message_fn(f"⚠️ 图片发送失败: {e}")
    send_message_fn(conclusion)
