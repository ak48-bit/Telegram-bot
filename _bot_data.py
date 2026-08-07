"""Bot data helper — lightweight Excel reader for bot commands.
No PIL/Telegram dependency. Reads platform config from config.json via _platform_config."""

import os, openpyxl
from datetime import datetime

# ── Unified platform config ──
import _platform_config as _plat

ALL_PLATFORMS = _plat.get_development_platforms()
DAILY_ROW_MAP = _plat.get_daily_row_map()
PH_PLATFORMS  = _plat.get_platforms_by_region("PH")
BD_PLATFORMS  = _plat.get_platforms_by_region("BD")
MM_PLATFORMS  = _plat.get_platforms_by_region("MM")

# Unified data dir via _runtime (Windows + Railway)
try:
    import _runtime as _rt
    DATA_FOLDER = _rt.excel_dir()
except ImportError:
    DATA_FOLDER = r"C:\Users\ak481\OneDrive\Desktop\新建文件夹"


def _find_daily_file():
    """Find the current month's main data file."""
    now = datetime.now()
    patterns = [
        f"{now.strftime('%y')}年{now.strftime('%m')}月 线上办公数据汇总.xlsx",
    ]
    for f in sorted(os.listdir(DATA_FOLDER), reverse=True):
        if not f.endswith('.xlsx') or '副本' in f or 'Copy' in f or f.startswith('~$'):
            continue
        for pat in patterns:
            if pat in f:
                return os.path.join(DATA_FOLDER, f)
        # Fuzzy match
        if f"{now.strftime('%y')}年{now.month}月" in f and '线上办公数据汇总' in f:
            return os.path.join(DATA_FOLDER, f)
    return None


def _cell_float(ws, row, col):
    """Safely read a numeric cell. Returns 0 for None/error values."""
    v = ws.cell(row=row, column=col).value
    if v is None:
        return 0
    if isinstance(v, str) and ('DIV' in v or 'VALUE' in v):
        return 0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0


def get_today_data():
    """Read today's ground push data. Returns {site: dict} or None."""
    path = _find_daily_file()
    if not path:
        return None
    wb = openpyxl.load_workbook(path, data_only=True)

    # Find the daily summary sheet
    target_sn = None
    for sn in wb.sheetnames:
        if sn == "当日汇总" or "汇总" in sn:
            try:
                ws_test = wb[sn]
                hdr = ws_test.cell(row=4, column=1).value
                if hdr and "DATE" in str(hdr).upper():
                    target_sn = sn
                    break
            except Exception:
                continue
    if target_sn is None and len(wb.sheetnames) > 3:
        target_sn = wb.sheetnames[3]
    if target_sn is None:
        wb.close()
        return None

    ws = wb[target_sn]
    site_rows = DAILY_ROW_MAP  # from unified config

    today = {}
    for name, row in site_rows.items():
        c = lambda col: _cell_float(ws, row, col)
        ftd = int(c(7))
        reg = int(c(6))
        dps_ppl = int(c(10))
        wdr_ppl = int(c(11))
        ftd_amt = c(19)
        total_dps = c(22)
        total_wdr = c(23)
        diff = c(24)
        roi = c(27) or 0
        roas = c(26) or 0
        new_cust_avg = c(14) if c(14) else (ftd_amt / ftd if ftd > 0 else 0)
        conversion = ftd / reg if reg > 0 else 0
        office = int(c(2))
        online = int(c(3))
        level1_ftd = int(c(9))
        level1_dps = c(17)
        level1_wdr = c(18)

        d = {
            "name": name, "register": reg, "ftd": ftd,
            "dps_ppl": dps_ppl, "wdr_ppl": wdr_ppl,
            "ftd_amount": ftd_amt, "total_dps": total_dps, "total_wdr": total_wdr,
            "diff": diff, "new_cust_avg": new_cust_avg,
            "roi": roi, "roas": roas,
            "conversion": conversion,
            "office": office, "online": online,
            "total_hc": office + online,
            "level1_ftd": level1_ftd,
            "level1_dps": level1_dps,
            "level1_wdr": level1_wdr,
        }
        d["status"] = _evaluate_status(d)
        d["fraud_risks"] = _evaluate_fraud_risks(d)
        d["tips"] = _get_tips(d)
        today[name] = d

    wb.close()
    return today


def _evaluate_status(d):
    """Rate site status: critical, warning, ok."""
    if d["ftd"] == 0:
        return "critical"
    if d["roi"] < 0 and d["ftd"] < 10:
        return "critical"
    if d["roi"] < 0 or d["ftd"] < 10:
        return "warning"
    wdr_rate = d["total_wdr"] / d["total_dps"] if d["total_dps"] > 0 else 0
    if wdr_rate > 0.9:
        return "critical"
    return "ok"


def _evaluate_fraud_risks(d):
    risks = []
    if d["register"] > 0 and d["ftd"] > 0:
        if d["conversion"] > 0.7:
            risks.append(f"注册转首存率={d['conversion']:.0%}(>70%红线)")
    if d["total_dps"] > 0 and d["ftd"] > 0:
        wdr_rate = d["total_wdr"] / d["total_dps"]
        if wdr_rate > 0.9:
            risks.append(f"提款率={wdr_rate:.0%}(>90%红线)")
        diff_ratio = d["diff"] / d["total_dps"]
        if diff_ratio < 0.1:
            risks.append(f"存提差占比={diff_ratio:.0%}(<10%红线)")
    return risks


def _get_tips(d):
    tips = []
    if d["ftd"] == 0:
        tips.append("FTD归零，立刻联系了解原因")
    if 0 < d["ftd"] < 10:
        tips.append("FTD个位数，关注渠道质量")
    if d["roi"] < 0:
        tips.append("ROI为负，控制成本或提升转化")
    if d.get("wdr_ppl", 0) > d.get("dps_ppl", 0):
        tips.append("提款>充值，检查套利风险")
    if d["register"] > 0 and d["ftd"] > 0 and d["conversion"] < 0.1:
        tips.append(f"注册转化率仅{d['conversion']:.0%}，优化注册渠道")
    if not tips:
        tips.append("数据正常，保持运营节奏")
    return tips


def fmt_k(v):
    if abs(v) >= 1_000_000:
        return f"{v/1_000_000:.1f}M"
    if abs(v) >= 1_000:
        return f"{v/1_000:.0f}K"
    return f"{v:,.0f}"


def fmt_k_signed(v):
    """Format with sign: negative shows -, positive shows number only (no +)."""
    s = fmt_k(v)
    return s  # fmt_k already produces -55K for negatives, 250K for positives


def get_region_summary(data):
    """Returns (ph_ftd, ph_ftd_amt, ph_diff, bd_ftd, bd_diff, mm_ftd, mm_diff, total_ftd, total_diff)."""
    ph_sites = PH_PLATFORMS   # from unified config (active only)
    bd_sites = BD_PLATFORMS
    mm_sites = MM_PLATFORMS

    ph_ftd = sum(data[s]["ftd"] for s in ph_sites if s in data)
    ph_ftd_amt = sum(data[s]["ftd_amount"] for s in ph_sites if s in data)
    ph_diff = sum(data[s]["diff"] for s in ph_sites if s in data)
    bd_ftd = sum(data[s]["ftd"] for s in bd_sites if s in data)
    bd_diff = sum(data[s]["diff"] for s in bd_sites if s in data)
    mm_ftd = sum(data[s]["ftd"] for s in mm_sites if s in data)
    mm_diff = sum(data[s]["diff"] for s in mm_sites if s in data)
    total_ftd = ph_ftd + bd_ftd + mm_ftd
    total_diff = ph_diff + bd_diff + mm_diff
    return ph_ftd, ph_ftd_amt, ph_diff, bd_ftd, bd_diff, mm_ftd, mm_diff, total_ftd, total_diff


def get_push_summary_text(data):
    """Short summary for confirmation/pin message."""
    ph_ftd, ph_ftd_amt, ph_diff, bd_ftd, bd_diff, mm_ftd, mm_diff, total_ftd, total_diff = get_region_summary(data)

    anomalies = []
    for name in ALL_PLATFORMS:
        if name in data and data[name]["status"] in ("critical", "warning"):
            anomalies.append(name)

    lines = [
        f"📊 日报已推送",
        f"菲区 FTD={ph_ftd} | 充提差 {fmt_k_signed(ph_diff)}",
        f"孟区 FTD={bd_ftd} | 充提差 {fmt_k_signed(bd_diff)}",
        f"缅区 FTD={mm_ftd} | 充提差 {fmt_k_signed(mm_diff)}",
        f"总计 FTD={total_ftd} | 充提差 {fmt_k_signed(total_diff)}",
    ]
    if anomalies:
        lines.append(f"⚠️ 关注站点: {', '.join(anomalies)}")
    else:
        lines.append("✅ 全部站点正常")
    return "\n".join(lines)


def get_anomaly_alerts(data):
    """Returns list of critical/warning alerts that should trigger notification."""
    alerts = []
    for name in ALL_PLATFORMS:
        if name not in data:
            continue
        d = data[name]
        if d["status"] == "critical":
            reasons = [t for t in d["tips"] if t != "数据正常，保持运营节奏"]
            alert = f"🔴 {name}: {'; '.join(reasons)}"
            if d.get("fraud_risks"):
                alert += f" | 🚨 {'; '.join(d['fraud_risks'])}"
            alerts.append(alert)
        elif d["status"] == "warning":
            reasons = [t for t in d["tips"] if t != "数据正常，保持运营节奏"]
            alert = f"🟡 {name}: {'; '.join(reasons)}"
            if d.get("fraud_risks"):
                alert += f" | 🚨 {'; '.join(d['fraud_risks'])}"
            alerts.append(alert)
    return alerts


def get_rankings(data, sort_by="ftd"):
    """Return platforms ranked by the given metric. sort_by: 'ftd', 'roi', 'diff', 'register', 'conversion'."""
    items = [(name, d) for name, d in data.items() if name in ALL_PLATFORMS]
    if sort_by == "ftd":
        items.sort(key=lambda x: x[1]["ftd"], reverse=True)
    elif sort_by == "roi":
        items.sort(key=lambda x: x[1]["roi"], reverse=True)
    elif sort_by == "diff":
        items.sort(key=lambda x: x[1]["diff"], reverse=True)
    elif sort_by == "register":
        items.sort(key=lambda x: x[1]["register"], reverse=True)
    elif sort_by == "conversion":
        items.sort(key=lambda x: x[1]["conversion"], reverse=True)

    result = []
    for rank, (name, d) in enumerate(items, 1):
        icon = {1: "🥇", 2: "🥈", 3: "🥉"}.get(rank, f"{rank}.")
        status_icon = {"critical": "🔴", "warning": "🟡", "ok": "🟢"}.get(d["status"], "")
        result.append({
            "rank": rank, "name": name, "icon": icon, "status_icon": status_icon,
            "ftd": d["ftd"], "roi": d["roi"], "diff": d["diff"],
            "register": d["register"], "conversion": d["conversion"],
            "total_dps": d["total_dps"], "total_wdr": d["total_wdr"],
        })
    return result
