"""Security check — shows env var status WITHOUT leaking any values."""
import os, sys, json

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

def _cfg():
    try:
        with open(os.path.join(SCRIPT_DIR, "config.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

print("=" * 50)
print("WFHDP Bot — Environment Security Check")
print("=" * 50)

# ── Telegram Bot Token ──
print(f"TELEGRAM_BOT_TOKEN: {'configured' if os.environ.get('TELEGRAM_BOT_TOKEN', '').strip() else 'missing'}")

# ── Telegram Chat ID ──
print(f"TELEGRAM_CHAT_ID: {'configured' if os.environ.get('TELEGRAM_CHAT_ID', '').strip() else 'missing'}")

# ── DATA_FOLDER ──
df = os.environ.get("DATA_FOLDER", "").strip()
if df:
    print(f"DATA_FOLDER: {df} (from env, exists={os.path.isdir(df)})")
else:
    df = _cfg().get("data_folder", "")
    print(f"DATA_FOLDER: {df} (from config.json, exists={os.path.isdir(df) if df else False})")

# ── ADMIN_TELEGRAM_IDS ──
admin_env = os.environ.get("ADMIN_TELEGRAM_IDS", "").strip()
if admin_env:
    n = len([x for x in admin_env.split(",") if x.strip()])
    print(f"ADMIN_TELEGRAM_IDS: {n} ID(s) (from env)")
else:
    ids = _cfg().get("admin_telegram_ids", [])
    print(f"ADMIN_TELEGRAM_IDS: {len(ids)} ID(s) (from config.json)")

# ── Excel File ──
print()
print("--- Excel File ---")
aef = _cfg().get("active_excel_file", "")
df_path = os.environ.get("DATA_FOLDER", _cfg().get("data_folder", ""))
full = os.path.join(df_path, aef) if df_path and aef else ""
print(f"active_excel_file: {aef or 'not set'}")
if full:
    print(f"Full path: {full}")
    print(f"File exists: {'yes' if os.path.isfile(full) else 'NO'}")
else:
    print("Cannot resolve full path (data_folder missing)")

# ── Config Info ──
print()
print("--- Config ---")
print(f"config_version: {_cfg().get('config_version', 'N/A')}")
print(f"updated_at: {_cfg().get('updated_at', 'N/A')}")

# ── Platforms ──
print()
print("--- Platforms ---")
try:
    import _platform_config as p
    dev = p.get_development_platforms()
    hij = p.get_hijack_platforms()
    dis = p.get_disabled_platforms()
    all_cfg = set(p.get_all_configured_platforms())
    idle = sorted(all_cfg - set(dev + hij + dis))
    print(f"Development: {len(dev)}")
    print(f"Hijack:      {len(hij)}")
    print(f"Disabled:    {len(dis)}")
    if idle:
        print(f"Idle:        {len(idle)}")
except Exception as e:
    print(f"Error: {e}")

print()
print("=" * 50)
