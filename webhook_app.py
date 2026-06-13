#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
PH90 WFH Bonus Bot — Cloud 24/7 (Render + Supabase PostgreSQL)
- 电脑关了也跑
- 数据永久不会丢
"""

import json, urllib.request, time, os, sys
from urllib.parse import urlparse, parse_qs
from flask import Flask, request, jsonify
import psycopg2
import psycopg2.extras

# ╔══════════════════════════════════════════════════════════════╗
# ║              【部署前只改这6处，其他不动】                    ║
# ╚══════════════════════════════════════════════════════════════╝

# 【1】Bot Token — @BotFather 给的
BOT_TOKEN = "8328734578:AAGlSQXuiSQ-25dOW8rsx0sIfOX0oNLEJ8c"

# 【2】Bot 用户名 — 不要 @
BOT_USERNAME = "PH90WFH_Bonus_bot"

# 【3】允许的推广域名
ALLOWED_DOMAINS = ["90jilia2.com", "www.90jilia2.com"]

# 【4】奖励名称
DEFAULT_REWARD = "Free Spins + Signup Bonus"

# 【5】Render 部署后给的 URL — 设为环境变量，部署时填
RENDER_APP_URL = os.environ.get("RENDER_APP_URL", "")

# 【6】Supabase 数据库连接 URL — 设为环境变量，部署时填
#     从 Supabase → Settings → Database → Connection string → URI
DATABASE_URL = os.environ.get("DATABASE_URL", "")

# ╔══════════════════════════════════════════════════════════════╗
# ║                     ★ 以上全改 ★                            ║
# ╚══════════════════════════════════════════════════════════════╝

PAGE_SIZE = 30

SHARE_TEXT_EN = """🎰 **{reward}** — Claim Now!

👉 Tap the link below to get your exclusive reward
{link}

💰 Sign up & Get Free Spins Instantly
📢 Share with friends — they get rewards too!
━━━━━━━━━━━━━━━━━
🔗 Ref: {ref_code}"""

# ── Flask ──────────────────────────────────────────────────────
app = Flask(__name__)

# ── PostgreSQL (Supabase) ──────────────────────────────────────

def get_db():
    """Connect to Supabase PostgreSQL."""
    return psycopg2.connect(DATABASE_URL)

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS users (
            telegram_id BIGINT PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            role TEXT DEFAULT 'player',
            ref_code TEXT,
            promo_url TEXT,
            invited_by BIGINT,
            invite_count INTEGER DEFAULT 0,
            notify INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT NOW()
        )
    ''')
    conn.commit()
    conn.close()

def db_get_user(tid):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT * FROM users WHERE telegram_id=%s", (tid,))
    row = c.fetchone()
    conn.close()
    if row:
        cols = ["telegram_id","username","first_name","role","ref_code",
                "promo_url","invited_by","invite_count","notify","created_at"]
        return dict(zip(cols, row))
    return None

def db_upsert_user(tid, **kw):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT 1 FROM users WHERE telegram_id=%s", (tid,))
    ex = c.fetchone()
    if ex:
        if not kw: conn.close(); return
        sets = ", ".join(f"{k}=%s" for k in kw)
        c.execute(f"UPDATE users SET {sets} WHERE telegram_id=%s",
                  list(kw.values())+[tid])
    else:
        kw["telegram_id"] = tid
        c.execute(f"INSERT INTO users ({','.join(kw.keys())}) VALUES ({','.join('%s' for _ in kw)})",
                  list(kw.values()))
    conn.commit(); conn.close()

def db_incr_invite(tid):
    conn = get_db(); c = conn.cursor()
    c.execute("UPDATE users SET invite_count=COALESCE(invite_count,0)+1 WHERE telegram_id=%s", (tid,))
    conn.commit(); conn.close()

def db_players(ref_code, limit=999):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT telegram_id,username,first_name,invited_by,created_at FROM users WHERE ref_code=%s AND role='player' ORDER BY created_at DESC LIMIT %s", (ref_code, limit))
    rows = c.fetchall(); conn.close()
    return [{"telegram_id":r[0],"username":r[1],"first_name":r[2],
             "invited_by":r[3],"created_at":str(r[4])} for r in rows]

def db_today_count(ref_code):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM users WHERE ref_code=%s AND role='player' AND created_at::date=CURRENT_DATE", (ref_code,))
    row = c.fetchone(); conn.close()
    return row[0] if row else 0

def db_find_agent(player_id):
    seen = set(); cur = player_id
    conn = get_db(); c = conn.cursor()
    while cur and cur not in seen:
        seen.add(cur)
        c.execute("SELECT * FROM users WHERE telegram_id=%s", (cur,))
        row = c.fetchone()
        if not row: conn.close(); return None
        cols = ["telegram_id","username","first_name","role","ref_code",
                "promo_url","invited_by","invite_count","notify","created_at"]
        u = dict(zip(cols, row))
        if u["role"] == "agent": conn.close(); return u
        cur = u.get("invited_by")
    conn.close(); return None

# ── URL Parser ──────────────────────────────────────────────────

def parse_promo_url(s):
    s = s.strip()
    if not s.startswith("http"): return None, "URL must start with http:// or https://"
    try: p = urlparse(s)
    except: return None, "Invalid URL format"
    if p.netloc.lower() not in ALLOWED_DOMAINS and "your-domain" not in p.netloc:
        # Only strict check if domains are configured
        if "【" not in ALLOWED_DOMAINS[0]:
            return None, f"Domain not allowed: {ALLOWED_DOMAINS}"
    qs = parse_qs(p.query)
    rc = qs.get("r", [None])[0]
    if not rc: return None, "Missing ?r= parameter"
    return rc, s

# ── Telegram API ────────────────────────────────────────────────

def tg(method, payload=None):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    data = json.dumps(payload, ensure_ascii=False).encode() if payload else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except: return None

def send(chat_id, text, pm="HTML", markup=None):
    p = {"chat_id":chat_id,"text":text,"parse_mode":pm,"disable_web_page_preview":True}
    if markup: p["reply_markup"] = markup
    return tg("sendMessage", p)

def answer_cb(cb_id, text=None):
    p = {"callback_query_id":cb_id}
    if text: p["text"]=text; p["show_alert"]=False
    return tg("answerCallbackQuery", p)

# ── Notification ────────────────────────────────────────────────

def notify_agent(agent, pname, puname):
    aid = agent["telegram_id"]; rc = agent.get("ref_code","N/A")
    tga = f"@{puname}" if puname else f"ID:{pname}"
    text = (f"<b>🔔 New Player Joined!</b>\n\n👤 {pname}\n📱 Telegram: {tga}\n"
            f"🏷️ Ref: <code>{rc}</code>\n🕐 {time.strftime('%Y-%m-%d %H:%M')}\n\n"
            f"<i>View: /players</i>")
    send(aid, text)

# ── Handlers ────────────────────────────────────────────────────

def handle_start(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    uname = frm.get("username",""); fname = frm.get("first_name",uname or "Player")
    text = msg.get("text","").strip()
    parts = text.split(); ref_id = None
    if len(parts)>=2:
        try: ref_id = int(parts[1])
        except: pass
    u = db_get_user(uid)
    if not u: db_upsert_user(uid, username=uname, first_name=fname, role="player")
    if ref_id and ref_id != uid:
        return handle_deep_link(cid, uid, uname, fname, ref_id)
    else:
        u = db_get_user(uid)
        if u and u.get("role")=="agent":
            link = f"https://t.me/{BOT_USERNAME}?start={uid}"
            tgd = f"@{u.get('username')}" if u.get("username") else f"ID:{uid}"
            send(cid, f"<b>🤖 PH90 WFH Bonus Bot</b>\n\n👤 {fname}\n📱 Telegram: {tgd}\n"
                 f"🏷️ Ref: <code>{u.get('ref_code','Not set')}</code>\n"
                 f"🔗 Reg: {u.get('promo_url','Not set')}\n📢 Share:\n{link}\n"
                 f"📊 Invites: {u.get('invite_count',0)}\n\n<b>Commands:</b> /my /players /share /daily /help")
        else:
            send(cid, f"<b>🤖 PH90 WFH Bonus Bot</b>\n\n👤 Hi {fname}!\n\n"
                 f"🎰 Get <b>{DEFAULT_REWARD}</b> through a referral link!\n\n"
                 f"<b>For Agents:</b>\n/bind http://www.your-domain.com/?r=your_code\n\n"
                 f"❓ Contact your agent for more info.")

def handle_deep_link(cid, uid, uname, fname, ref_id):
    inviter = db_get_user(ref_id)
    if not inviter: return send(cid, "<b>⚠️ Invalid Link</b>\n\nInviter not found.")
    agent = db_find_agent(ref_id)
    if not agent: return send(cid, "<b>⚠️ Agent Not Found</b>\n\nInviter hasn't bound yet.")
    ex = db_get_user(uid); is_new = not ex or not ex.get("invited_by")
    if is_new:
        db_upsert_user(uid, username=uname, first_name=fname, role="player",
                       invited_by=ref_id, ref_code=agent.get("ref_code"),
                       promo_url=agent.get("promo_url"))
        db_incr_invite(ref_id); notify_agent(agent, fname, uname)
    pl = f"https://t.me/{BOT_USERNAME}?start={uid}"
    send(cid, f"<b>🎰 Congrats! You got {DEFAULT_REWARD}!</b>\n\n👤 {fname}\n"
         f"🏷️ Ref: <code>{agent.get('ref_code','N/A')}</code>\n\n"
         f"<b>👇 3 Steps:</b>\n1️⃣ Tap below to register\n2️⃣ Get Free Spins + Bonus\n"
         f"3️⃣ Share the link with friends!\n\n{pl}\n\n📢 <b>Unlimited Sharing!</b>",
         reply_markup={"inline_keyboard":[[{"text":"🎮 Register & Claim",
            "url":agent.get("promo_url","https://your-domain.com")}]]})

def handle_bind(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    uname = frm.get("username",""); fname = frm.get("first_name",uname or "User")
    text = msg.get("text","").strip()
    parts = text.split(maxsplit=1)
    if len(parts)<2:
        return send(cid, "<b>⚠️ Please provide your promo link</b>\n\n"
                    "Format: /bind http://www.your-domain.com/?r=your_code\n\n"
                    "<i>Example: /bind http://www.your-domain.com/?r=YOUR_CODE</i>")
    rc, result = parse_promo_url(parts[1].strip())
    if not rc: return send(cid, f"<b>❌ Bind Failed</b>\n\n{result}")
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT telegram_id,first_name FROM users WHERE ref_code=%s AND telegram_id!=%s", (rc,uid))
    conflict = c.fetchone(); conn.close()
    if conflict: return send(cid, f"<b>⚠️ Ref Code Already Taken</b>\n\n"
                             f"<code>{rc}</code> already bound by {conflict[1]}.")
    db_upsert_user(uid, username=uname, first_name=fname, role="agent",
                   ref_code=rc, promo_url=result)
    link = f"https://t.me/{BOT_USERNAME}?start={uid}"
    tgd = f"@{uname}" if uname else f"ID:{uid}"
    send(cid, f"<b>✅ Bind Successful!</b>\n\n👤 {fname}\n📱 Telegram: {tgd}\n"
         f"🏷️ Ref: <code>{rc}</code>\n🔗 Reg: {result}\n📢 Share:\n{link}\n\n"
         f"<b>💡 Next:</b>\n• Copy Share Link → send to players\n"
         f"• New players = instant notification 🔔\n• /share /players /daily")

def handle_my(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    u = db_get_user(uid)
    if not u: return send(cid, "Send /start first!")
    link = f"https://t.me/{BOT_USERNAME}?start={uid}"
    if u.get("role")=="agent":
        rc = u.get("ref_code","N/A"); total = len(db_players(rc)); today = db_today_count(rc)
        tga = f"@{u.get('username')}" if u.get("username") else f"ID:{uid}"
        send(cid, f"<b>📊 My Stats</b>\n\n👤 {u.get('first_name','N/A')}\n📱 Telegram: {tga}\n"
             f"🏷️ Role: <b>Agent</b>\n🔖 Ref: <code>{rc}</code>\n🔗 Reg: {u.get('promo_url','N/A')}\n"
             f"📢 Share:\n{link}\n━━━━━━━━━━━━━━━━━\n📊 Total: {total}\n🆕 Today: {today}\n"
             f"━━━━━━━━━━━━━━━━━\n<b>More:</b> /players /share /daily")
    else:
        agent = db_find_agent(uid)
        ai = f"Ref: {agent.get('ref_code','N/A')}" if agent else "Not under any agent"
        send(cid, f"<b>📊 My Stats</b>\n\n👤 {u.get('first_name','N/A')}\n🏷️ Role: Player\n"
             f"{ai}\n📊 Invited: {u.get('invite_count',0)}\n📢 Share:\n{link}\n\n"
             f"<b>Commands:</b> /my /share /help")

def handle_players(msg, page=1):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    u = db_get_user(uid)
    if not u or u.get("role")!="agent": return send(cid, "Only agents. /bind first.")
    rc = u["ref_code"]; all_p = db_players(rc)
    total = len(all_p); tp = max(1,(total+PAGE_SIZE-1)//PAGE_SIZE); page = max(1,min(page,tp))
    if total==0:
        return send(cid, f"<b>📋 Player List</b>\n\n🏷️ Ref: <code>{rc}</code>\n"
                    f"📊 No players yet.\n\n<i>Send your Share Link!</i>")
    start = (page-1)*PAGE_SIZE; pp = all_p[start:start+PAGE_SIZE]
    lines = [f"<b>📋 Player List — {rc}</b>", f"📊 Total: {total}  |  Page {page}/{tp}\n"]
    for i,p in enumerate(pp, start+1):
        nm = p["first_name"] or "Anonymous"; tgi = p["telegram_id"]
        tg = f"@{p['username']}" if p.get("username") else f"ID:{tgi}"
        lines.append(f"{i}. {nm}  📱 {tg}  🆔 <code>{tgi}</code>  <i>{(p.get('created_at',''))[:16]}</i>")
    btns = []
    if tp>1:
        row = []
        if page>1: row.append({"text":"◀ Prev","callback_data":f"players_{rc}_{page-1}"})
        if page<tp: row.append({"text":"Next ▶","callback_data":f"players_{rc}_{page+1}"})
        if row: btns.append(row)
    send(cid, "\n".join(lines), reply_markup={"inline_keyboard":btns} if btns else None)

def handle_share(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    u = db_get_user(uid)
    if not u: return send(cid, "Send /start first!")
    rc = u.get("ref_code","N/A"); link = f"https://t.me/{BOT_USERNAME}?start={uid}"
    en = SHARE_TEXT_EN.format(reward=DEFAULT_REWARD, link=link, ref_code=rc)
    send(cid, f"<b>📢 Your Promo Text</b>\n\n{en}",
         reply_markup={"inline_keyboard":[[{"text":"📋 Copy Share Link","copy_text":{"text":link}}]]})

def handle_daily(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    u = db_get_user(uid)
    if not u or u.get("role")!="agent": return send(cid, "Only agents. /bind first.")
    rc = u["ref_code"]; today = db_today_count(rc); total = len(db_players(rc))
    link = f"https://t.me/{BOT_USERNAME}?start={uid}"
    mood = "🔥 Great momentum!" if today>0 else "💤 No new players yet. Share your link!"
    send(cid, f"<b>📅 Today — {time.strftime('%Y-%m-%d')}</b>\n\n🏷️ Ref: <code>{rc}</code>\n"
         f"━━━━━━━━━━━━━━━━━\n🆕 Today: <b>{today}</b>\n📊 Total: <b>{total}</b>\n"
         f"━━━━━━━━━━━━━━━━━\n{mood}\n\n📢 Share:\n{link}\n\n<b>Commands:</b> /players /share /my")

def handle_help(cid):
    send(cid, "<b>📋 Commands</b>\n\n<b>Agents:</b>\n/bind &lt;link&gt; — Bind promo link\n"
         "/my — Stats\n/players — Player list\n/share — Promo text\n/daily — Today\n\n"
         "<b>Players:</b>\n/start — Start\n/my — Stats\n/share — Share text\n/help — Help")

# ── Update Processor ────────────────────────────────────────────

def process_update(update):
    if "message" in update:
        msg = update["message"]; text = msg.get("text","").strip()
        if "new_chat_members" in msg:
            for m in msg.get("new_chat_members",[]):
                if m.get("is_bot") and str(m.get("id")) in BOT_TOKEN:
                    send(msg.get("chat",{}).get("id"),
                         "<b>🤖 PH90 WFH Bonus Bot is here!</b>\n\n"
                         "Agents: /bind your promo link\nPlayers: enter through a share link!")
            return
        if text.startswith("/start"): handle_start(msg)
        elif text.startswith("/bind"): handle_bind(msg)
        elif text.startswith("/players"): handle_players(msg)
        elif text.startswith("/share"): handle_share(msg)
        elif text.startswith("/daily"): handle_daily(msg)
        elif text.startswith("/my"): handle_my(msg)
        elif text.startswith("/help"): handle_help(msg.get("chat",{}).get("id"))
    elif "callback_query" in update:
        cb = update["callback_query"]; data = cb.get("data",""); cbid = cb.get("id")
        cbmsg = cb.get("message",{}); cbfrm = cb.get("from",{})
        if data.startswith("players_"):
            parts = data.split("_")
            if len(parts)>=3:
                handle_players({"chat":cbmsg.get("chat"),"from":cbfrm}, page=int(parts[-1]))
        answer_cb(cbid)

# ── Flask Routes ────────────────────────────────────────────────

@app.route("/")
def home():
    return "PH90 WFH Bonus Bot — 24/7 Cloud 🚀"

@app.route("/webhook", methods=["POST"])
def webhook():
    update = request.get_json()
    if update:
        try: process_update(update)
        except Exception as e: print(f"[ERROR] {e}")
    return jsonify({"ok": True})

# ── Startup ─────────────────────────────────────────────────────

def set_webhook():
    if not RENDER_APP_URL:
        print("[WEBHOOK] RENDER_APP_URL env var not set yet")
        return False
    url = f"{RENDER_APP_URL}/webhook"
    result = tg("setWebhook", {"url": url, "drop_pending_updates": True})
    ok = result and result.get("ok")
    print(f"[WEBHOOK] {url} → {'OK' if ok else result}")
    return ok

if __name__ == "__main__":
    print("[INIT] Connecting to Supabase PostgreSQL...")
    try:
        init_db()
        print("[INIT] Database ready")
    except Exception as e:
        print(f"[INIT] DB ERROR: {e}")
        print("[INIT] Check DATABASE_URL in webhook_app.py")

    set_webhook()
    port = int(os.environ.get("PORT", 5000))
    print(f"[START] Listening on port {port}")
    app.run(host="0.0.0.0", port=port)
