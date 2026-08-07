"""Runtime environment helpers — Windows + Railway Linux compatibility.

Centralizes:
  - platform detection (IS_WINDOWS / IS_RAILWAY / RUNTIME_ENV)
  - unified data directory resolution
  - font resolution (Windows YaHei / Linux Noto / DejaVu fallback)
  - instance count detection (PowerShell on Windows / psutil on Linux)
  - startup preflight + smoke test

No module should hardcode its own font paths or data dirs.
"""

import os
import sys

# ══════════════════════════════════════════════════════════════════════
#  Platform detection
# ══════════════════════════════════════════════════════════════════════

IS_WINDOWS = (sys.platform == "win32")
IS_RAILWAY = os.environ.get("RAILWAY_ENVIRONMENT") is not None
RUNTIME_ENV = os.environ.get("RUNTIME_ENV", "").strip().lower()


def is_setup_mode():
    """RAILWAY_SETUP_MODE=1 → setup mode: upload only, no push/compare/archive."""
    return os.environ.get("RAILWAY_SETUP_MODE", "").strip() == "1"


def is_railway():
    """Railway if env var set, or RUNTIME_ENV=railway (testable)."""
    if IS_RAILWAY:
        return True
    return RUNTIME_ENV == "railway"


def runtime_label():
    if is_railway():
        return "Railway Linux"
    return "Windows" if IS_WINDOWS else "Linux"


# ══════════════════════════════════════════════════════════════════════
#  Unified data directory
# ══════════════════════════════════════════════════════════════════════

DEFAULT_WINDOWS_DATA = r"C:\Users\ak481\OneDrive\Desktop\新建文件夹"
RAILWAY_DATA_ROOT = "/data"


def _load_config_data_folder():
    """Read data_folder from config.json if present."""
    try:
        import json
        cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
        if os.path.isfile(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                return json.load(f).get("data_folder", "")
    except Exception:
        pass
    return ""


def resolve_data_root():
    """Top-level data root.
    Priority: DATA_FOLDER env → Railway /data → config.json → Windows default.
    """
    env_val = os.environ.get("DATA_FOLDER", "").strip()
    if env_val:
        return env_val.rstrip("\\/")

    if is_railway():
        return RAILWAY_DATA_ROOT

    cfg_val = _load_config_data_folder()
    if cfg_val:
        return cfg_val.rstrip("\\/")

    if IS_WINDOWS:
        return DEFAULT_WINDOWS_DATA

    return RAILWAY_DATA_ROOT


def _project_data_dir():
    """Project-local data dir (Windows keeps existing behavior)."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def excel_dir():
    """Directory for uploaded/live Excel files.
    Priority: explicit DATA_FOLDER (as-is) → Railway /data/excel → Windows 新建文件夹."""
    env_val = os.environ.get("DATA_FOLDER", "").strip()
    if env_val:
        return env_val.rstrip("\\/")
    if is_railway():
        return os.path.join(RAILWAY_DATA_ROOT, "excel")
    cfg_val = _load_config_data_folder()
    if cfg_val:
        return cfg_val.rstrip("\\/")
    if IS_WINDOWS:
        return DEFAULT_WINDOWS_DATA
    return os.path.join(RAILWAY_DATA_ROOT, "excel")


def archive_dir():
    """Directory for comparison_archive snapshots.
    Windows → project data/comparison_archive (existing).
    Railway → /data/comparison_archive."""
    if is_railway():
        return os.path.join(RAILWAY_DATA_ROOT, "comparison_archive")
    return os.path.join(_project_data_dir(), "comparison_archive")


def generated_dir():
    """Directory for generated images.
    Windows → project data/generated (existing).
    Railway → /data/generated."""
    if is_railway():
        return os.path.join(RAILWAY_DATA_ROOT, "generated")
    return os.path.join(_project_data_dir(), "generated")


def backups_dir():
    """Directory for upload backups.
    Windows → 新建文件夹/备份 (existing).
    Railway → /data/backups."""
    if is_railway():
        return os.path.join(RAILWAY_DATA_ROOT, "backups")
    return os.path.join(excel_dir(), "备份")


def ensure_dirs():
    """Create all data subdirs if missing. Returns list of created paths."""
    created = []
    for d in (excel_dir(), archive_dir(), generated_dir(), backups_dir()):
        try:
            os.makedirs(d, exist_ok=True)
            created.append(d)
        except Exception:
            pass
    return created


# ══════════════════════════════════════════════════════════════════════
#  Font resolution
# ══════════════════════════════════════════════════════════════════════

CANDIDATES_REGULAR = [
    os.environ.get("FONT_PATH", ""),
    r"C:\Windows\Fonts\msyh.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
CANDIDATES_BOLD = [
    os.environ.get("FONT_BOLD_PATH", ""),
    r"C:\Windows\Fonts\msyhbd.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def _first_existing(candidates):
    for p in candidates:
        if p and os.path.isfile(p):
            return p
    return None


def font_path():
    """Resolve regular font path, or None if none available."""
    return _first_existing(CANDIDATES_REGULAR)


def font_bold_path():
    """Resolve bold font path, or None if none available."""
    return _first_existing(CANDIDATES_BOLD)


def check_fonts():
    """Preflight fonts. Returns (ok, message)."""
    reg = font_path()
    bold = font_bold_path()
    if not reg or not bold:
        return False, f"字体缺失: regular={reg} bold={bold}"
    try:
        from PIL import ImageFont
        ImageFont.truetype(reg, 12)
        ImageFont.truetype(bold, 12)
    except Exception as e:
        return False, f"字体无法加载: {str(e)[:60]}"
    return True, f"字体OK: {os.path.basename(reg)}"


# ══════════════════════════════════════════════════════════════════════
#  Instance count detection
# ══════════════════════════════════════════════════════════════════════

def instance_count():
    """Count running bot_listener.py instances.
    Windows: PowerShell (existing).
    Linux: psutil if available, else '未检查'.
    """
    if IS_WINDOWS and not is_railway():
        try:
            import subprocess
            r = subprocess.run(
                ['powershell', '-NoProfile', '-Command',
                 "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python3.13.exe' -and $_.CommandLine -like '*bot_listener*' }).Count"],
                capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip().isdigit():
                return r.stdout.strip()
        except Exception:
            pass
        return "未检查"
    # Linux / Railway
    try:
        import psutil
        count = 0
        for proc in psutil.process_iter(['name', 'cmdline']):
            try:
                cmd = proc.info.get('cmdline') or []
                if any('bot_listener.py' in c for c in cmd):
                    count += 1
            except Exception:
                continue
        return str(count)
    except ImportError:
        return "未检查"


# ══════════════════════════════════════════════════════════════════════
#  Startup preflight + smoke test
# ══════════════════════════════════════════════════════════════════════

def startup_preflight():
    """Verify all prerequisites. Returns list of (level, message).
    level: OK / WARN / ERROR
    """
    results = []

    # Credentials
    for var in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"):
        if os.environ.get(var, "").strip():
            results.append(("OK", f"{var}: 已配置"))
        else:
            results.append(("ERROR", f"{var}: 未配置"))

    admin = os.environ.get("ADMIN_TELEGRAM_IDS", "").strip()
    if admin:
        results.append(("OK", "ADMIN_TELEGRAM_IDS: 已配置"))
    else:
        results.append(("WARN", "ADMIN_TELEGRAM_IDS: 未配置（管理命令禁用）"))

    # Directories writable
    ensure_dirs()
    for label, d in (("数据", excel_dir()), ("归档", archive_dir()),
                     ("生成", generated_dir()), ("备份", backups_dir())):
        try:
            os.makedirs(d, exist_ok=True)
            test = os.path.join(d, ".write_test")
            with open(test, "w") as f:
                f.write("1")
            os.remove(test)
            results.append(("OK", f"{label}目录可写: {d}"))
        except Exception as e:
            results.append(("ERROR", f"{label}目录不可写: {d} ({str(e)[:40]})"))

    # active_month.json validity
    setup_mode = is_setup_mode()
    try:
        import _platform_config as pc
        path, fname, date, errs = pc.get_active_excel("development")
        if path:
            results.append(("OK", f"active_month development: {fname} ({date})"))
        elif setup_mode:
            results.append(("WARN", "active_month development: 缺失（SETUP MODE 可上传）"))
        else:
            results.append(("ERROR", f"active_month development: {'; '.join(errs)}"))
        hpath, hfname, hdate, herrs = pc.get_active_excel("hijack")
        if hpath:
            results.append(("OK", f"active_month hijack: {hfname} ({hdate})"))
        elif setup_mode:
            results.append(("WARN", "active_month hijack: 缺失（SETUP MODE 可上传）"))
        else:
            results.append(("ERROR", f"active_month hijack: {'; '.join(herrs)}"))
    except Exception as e:
        results.append(("ERROR", f"active_month 解析异常: {str(e)[:60]}"))

    # Fonts
    ok, msg = check_fonts()
    results.append(("OK" if ok else "ERROR", f"字体: {msg}"))

    # win32com — Linux must not import it
    if not IS_WINDOWS:
        results.append(("OK", "平台: Linux，不加载 win32com"))

    # Dependencies
    deps = []
    for mod in ("openpyxl", "PIL"):
        try:
            __import__(mod)
            deps.append(f"{mod}:OK")
        except ImportError:
            deps.append(f"{mod}:MISSING")
    results.append(("OK", f"依赖: {', '.join(deps)}"))

    return results


def run_smoke_test():
    """RAILWAY_SMOKE_TEST=1 → run preflight, print, exit 0/1. No Telegram."""
    results = startup_preflight()
    for level, msg in results:
        print(f"[{level}] {msg}")
    errors = [m for l, m in results if l == "ERROR"]
    print(f"RESULT: {'FAIL' if errors else 'PASS'} ({len(results)} checks, {len(errors)} errors)")
    return 1 if errors else 0
