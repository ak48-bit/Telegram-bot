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

# ╔══════════════════════════════════════════════════════════════╗
# ║              配置区 — 环境变量 + 常量                        ║
# ╚══════════════════════════════════════════════════════════════╝

# 【1】Bot Token — 从环境变量读取（Render → Environment）
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")

# 【2】Bot 用户名 — 不要 @
BOT_USERNAME = "PH90WFH_Bonus_bot"

# 【2.5】管理员 Telegram ID 列表
ADMIN_IDS = [5228288204, 7393739670]

# 【3】允许的推广域名（逗号分隔，环境变量 ALLOWED_DOMAINS）
ALLOWED_DOMAINS = [d.strip() for d in os.environ.get("ALLOWED_DOMAINS", "").split(",") if d.strip()]

# 【4】奖励名称（环境变量 DEFAULT_REWARD）
DEFAULT_REWARD = os.environ.get("DEFAULT_REWARD", "Free Spins + Signup Bonus")

# 【5】Render 部署后给的 URL — 设为环境变量，部署时填
RENDER_APP_URL = os.environ.get("RENDER_APP_URL", "")

# 【6】Supabase 数据库连接 URL — 从环境变量读取（Render → Environment）
DATABASE_URL = os.environ.get("DATABASE_URL", "")

# 【7】Webhook Secret Token — 防止伪造消息
SECRET_TOKEN = os.environ.get("SECRET_TOKEN", "ph90_bonus_bot_2026")

# ╔══════════════════════════════════════════════════════════════╗
# ║                     配置区结束                              ║
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

def is_admin(uid):
    return uid in ADMIN_IDS

def init_db():
    conn = None
    try:
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
                status TEXT DEFAULT 'active',
                created_at TIMESTAMP DEFAULT NOW()
            )
        ''')
        try:
            c.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'")
        except:
            pass
        # 确保 agent 的 ref_code 唯一（空字符串除外）
        try:
            c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_agent_ref ON users(ref_code) WHERE ref_code IS NOT NULL AND ref_code != '' AND role = 'agent'")
        except:
            pass
        conn.commit()
    finally:
        if conn: conn.close()

def db_get_user(tid):
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("SELECT * FROM users WHERE telegram_id=%s", (tid,))
        row = c.fetchone()
        if row:
            cols = ["telegram_id","username","first_name","role","ref_code",
                    "promo_url","invited_by","invite_count","notify","status","created_at"]
            return dict(zip(cols, row))
        return None
    finally:
        if conn: conn.close()

def db_upsert_user(tid, **kw):
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("SELECT 1 FROM users WHERE telegram_id=%s", (tid,))
        ex = c.fetchone()
        if ex:
            if not kw: return
            sets = ", ".join(f"{k}=%s" for k in kw)
            c.execute(f"UPDATE users SET {sets} WHERE telegram_id=%s",
                      list(kw.values())+[tid])
        else:
            kw["telegram_id"] = tid
            c.execute(f"INSERT INTO users ({','.join(kw.keys())}) VALUES ({','.join('%s' for _ in kw)})",
                      list(kw.values()))
        conn.commit()
    finally:
        if conn: conn.close()

def db_incr_invite(tid):
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("UPDATE users SET invite_count=COALESCE(invite_count,0)+1 WHERE telegram_id=%s", (tid,))
        conn.commit()
    finally:
        if conn: conn.close()

def db_players(ref_code, limit=999):
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("SELECT telegram_id,username,first_name,invited_by,created_at FROM users WHERE ref_code=%s AND role='player' ORDER BY created_at DESC LIMIT %s", (ref_code, limit))
        rows = c.fetchall()
        return [{"telegram_id":r[0],"username":r[1],"first_name":r[2],
                 "invited_by":r[3],"created_at":str(r[4])} for r in rows]
    finally:
        if conn: conn.close()

def db_today_count(ref_code):
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM users WHERE ref_code=%s AND role='player' AND created_at::date=CURRENT_DATE", (ref_code,))
        row = c.fetchone()
        return row[0] if row else 0
    finally:
        if conn: conn.close()

def db_global_stats():
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM users WHERE role='agent'")
        total_agents = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM users WHERE role='agent' AND status='active'")
        active_agents = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM users WHERE role='agent' AND status='pending'")
        pending_agents = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM users WHERE role='player'")
        total_players = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM users WHERE role='player' AND created_at::date=CURRENT_DATE")
        today_players = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM users WHERE role='player' AND created_at>=date_trunc('week',CURRENT_DATE)")
        week_players = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM users WHERE role='player' AND created_at>=date_trunc('month',CURRENT_DATE)")
        month_players = c.fetchone()[0]
        c.execute("""SELECT a.ref_code, a.first_name, COUNT(p.telegram_id) as pc
                     FROM users a LEFT JOIN users p ON p.ref_code = a.ref_code AND p.role = 'player'
                     WHERE a.role = 'agent' AND a.status = 'active'
                     GROUP BY a.ref_code, a.first_name ORDER BY pc DESC LIMIT 10""")
        top = c.fetchall()
        return {
            "total_agents": total_agents, "active_agents": active_agents,
            "pending_agents": pending_agents, "total_players": total_players,
            "today_players": today_players, "week_players": week_players,
            "month_players": month_players, "top": top
        }
    finally:
        if conn: conn.close()

def db_all_agent_ids():
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("SELECT telegram_id FROM users WHERE role='agent' AND status='active'")
        rows = c.fetchall()
        return [r[0] for r in rows]
    finally:
        if conn: conn.close()

def db_week_count(ref_code):
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM users WHERE ref_code=%s AND role='player' AND created_at>=date_trunc('week',CURRENT_DATE)", (ref_code,))
        row = c.fetchone()
        return row[0] if row else 0
    finally:
        if conn: conn.close()

def db_month_count(ref_code):
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM users WHERE ref_code=%s AND role='player' AND created_at>=date_trunc('month',CURRENT_DATE)", (ref_code,))
        row = c.fetchone()
        return row[0] if row else 0
    finally:
        if conn: conn.close()

def db_approve_agent(ref_code):
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("UPDATE users SET status='active' WHERE ref_code=%s AND role='agent'", (ref_code,))
        affected = c.rowcount; conn.commit()
        return affected > 0
    finally:
        if conn: conn.close()

def db_ban_agent(ref_code):
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("UPDATE users SET status='banned' WHERE ref_code=%s AND role='agent'", (ref_code,))
        affected = c.rowcount; conn.commit()
        return affected > 0
    finally:
        if conn: conn.close()

def db_find_agent(player_id):
    seen = set(); cur = player_id
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        while cur and cur not in seen:
            seen.add(cur)
            c.execute("SELECT * FROM users WHERE telegram_id=%s", (cur,))
            row = c.fetchone()
            if not row: return None
            cols = ["telegram_id","username","first_name","role","ref_code",
                    "promo_url","invited_by","invite_count","notify","status","created_at"]
            u = dict(zip(cols, row))
            if u["role"] == "agent": return u
            cur = u.get("invited_by")
        return None
    finally:
        if conn: conn.close()

# ── URL Parser ──────────────────────────────────────────────────

def parse_promo_url(s):
    s = s.strip()
    if not s.startswith("http"): return None, "URL must start with http:// or https://"
    try: p = urlparse(s)
    except: return None, "Invalid URL format"
    if ALLOWED_DOMAINS and p.netloc.lower() not in ALLOWED_DOMAINS:
        return None, f"Domain not allowed. Allowed: {', '.join(ALLOWED_DOMAINS)}"
    qs = parse_qs(p.query)
    rc = qs.get("r", [None])[0]
    if not rc: return None, "Missing ?r= parameter"
    return rc, s

# ── Telegram API ────────────────────────────────────────────────

def tg(method, payload=None, retries=3):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    data = json.dumps(payload, ensure_ascii=False).encode() if payload else None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers={"Content-Type":"application/json"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            if attempt == retries - 1:
                print(f"[TG ERROR] {method}: {e}")
                return None
            time.sleep(1)

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
            status = u.get("status","active")
            si = {"active":"✅ Active","pending":"⏳ Pending Review","banned":"🚫 Banned"}.get(status,"❓ Unknown")
            send(cid, f"<b>🤖 PH90 WFH Bonus Bot</b>\n\n👤 {fname}\n📱 Telegram: {tgd}\n"
                 f"🏷️ Ref: <code>{u.get('ref_code','Not set')}</code>\n"
                 f"🔗 Reg: {u.get('promo_url','Not set')}\n📢 Share:\n{link}\n"
                 f"📊 Invites: {u.get('invite_count',0)}\n📌 Status: {si}\n"
                 f"\n<b>Commands:</b> /my /players /share /daily /help")
        else:
            send(cid, f"<b>🤖 PH90 WFH Bonus Bot</b>\n\n👤 Hi {fname}!\n\n"
                 f"🎰 Get <b>{DEFAULT_REWARD}</b> through a referral link!\n\n"
                 f"<b>For Agents:</b>\n/bind your_promo_link\n\n"
                 f"❓ Contact your agent for more info.")

def handle_deep_link(cid, uid, uname, fname, ref_id):
    inviter = db_get_user(ref_id)
    if not inviter: return send(cid, "<b>⚠️ Invalid Link</b>\n\nInviter not found.")
    agent = db_find_agent(ref_id)
    if not agent: return send(cid, "<b>⚠️ Agent Not Found</b>\n\nInviter hasn't bound yet.")
    if agent.get("status") == "pending":
        return send(cid, "<b>⏳ Agent Not Yet Approved</b>\n\nYour inviter is pending admin review.\nPlease try again later.")
    if agent.get("status") == "banned":
        return send(cid, "<b>🚫 Link Disabled</b>\n\nThis referral link is no longer active.\nPlease contact admin for assistance.")
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
            "url":agent.get("promo_url","https://t.me")}]]})

def handle_bind(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    uname = frm.get("username",""); fname = frm.get("first_name",uname or "User")
    text = msg.get("text","").strip()
    parts = text.split(maxsplit=1)
    if len(parts)<2:
        return send(cid, "<b>⚠️ Please provide your promo link</b>\n\n"
                    "Format: /bind http://your-platform.com/?r=your_code")
    rc, result = parse_promo_url(parts[1].strip())
    if not rc: return send(cid, f"<b>❌ Bind Failed</b>\n\n{result}")
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("SELECT telegram_id,first_name FROM users WHERE ref_code=%s AND telegram_id!=%s", (rc,uid))
        conflict = c.fetchone()
    finally:
        if conn: conn.close()
    if conflict: return send(cid, f"<b>⚠️ Ref Code Already Taken</b>\n\n"
                             f"<code>{rc}</code> already bound by {conflict[1]}.")
    db_upsert_user(uid, username=uname, first_name=fname, role="agent",
                   ref_code=rc, promo_url=result, status="pending")
    link = f"https://t.me/{BOT_USERNAME}?start={uid}"
    tgd = f"@{uname}" if uname else f"ID:{uid}"
    # 通知所有管理员
    for aid in ADMIN_IDS:
        send(aid, f"<b>🔔 New Agent Registration</b>\n\n"
             f"👤 {fname} — {tgd}\n🏷️ Ref: <code>{rc}</code>\n\n"
             f"<i>Use /approve {rc} to activate</i>")
    send(cid, f"<b>✅ Bind Successful! — Awaiting Approval</b>\n\n👤 {fname}\n📱 Telegram: {tgd}\n"
         f"🏷️ Ref: <code>{rc}</code>\n🔗 Reg: {result}\n\n"
         f"<b>⏳ Status: Pending Review</b>\n"
         f"Your account will be reviewed by admin.\n"
         f"Once approved, your share link will become active.\n\n"
         f"<b>Commands:</b> /my /share /help")

def handle_my(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    u = db_get_user(uid)
    if not u: return send(cid, "Send /start first!")
    link = f"https://t.me/{BOT_USERNAME}?start={uid}"
    if u.get("role")=="agent":
        rc = u.get("ref_code","N/A"); total = len(db_players(rc)); today = db_today_count(rc)
        week = db_week_count(rc); month = db_month_count(rc)
        status = u.get("status","active")
        status_icon = {"active":"✅","pending":"⏳","banned":"🚫"}.get(status,"❓")
        tga = f"@{u.get('username')}" if u.get("username") else f"ID:{uid}"
        send(cid, f"<b>📊 My Stats</b>\n\n👤 {u.get('first_name','N/A')}\n📱 Telegram: {tga}\n"
             f"🏷️ Role: <b>Agent</b> {status_icon}\n🔖 Ref: <code>{rc}</code>\n🔗 Reg: {u.get('promo_url','N/A')}\n"
             f"📢 Share:\n{link}\n━━━━━━━━━━━━━━━━━\n🆕 Today: {today}\n📅 This Week: {week}\n"
             f"📆 This Month: {month}\n📊 Total: {total}\n"
             f"━━━━━━━━━━━━━━━━━\n<b>More:</b> /players /share /daily")
    else:
        agent = db_find_agent(uid)
        ai = f"Ref: {agent.get('ref_code','N/A')}" if agent else "Not under any agent"
        send(cid, f"<b>📊 My Stats</b>\n\n👤 {u.get('first_name','N/A')}\n🏷️ Role: Player\n"
             f"{ai}\n📊 Invited: {u.get('invite_count',0)}\n📢 Share:\n{link}\n\n"
             f"<b>Commands:</b> /my /share /help")

def handle_players(msg, page=1, search=None):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    u = db_get_user(uid)
    if not u or u.get("role")!="agent": return send(cid, "Only agents. /bind first.")
    # 解析命令: /players [keyword] [page]
    text = msg.get("text","").strip()
    parts = text.split()
    if search is None and len(parts) >= 2:
        # 检查最后一个参数是否为页码
        try:
            last_is_page = int(parts[-1])
            page = last_is_page
            if len(parts) >= 3:
                search = " ".join(parts[1:-1])
        except ValueError:
            # 最后不是数字，全部作为搜索词
            search = " ".join(parts[1:])
    rc = u["ref_code"]; all_p = db_players(rc)
    if search:
        s = search.lower()
        all_p = [p for p in all_p if s in (p.get("first_name") or "").lower() or s in (p.get("username") or "").lower() or s in str(p.get("telegram_id",""))]
    total = len(all_p); tp = max(1,(total+PAGE_SIZE-1)//PAGE_SIZE); page = max(1,min(page,tp))
    if total==0:
        hint = f"No players matching '{search}'." if search else "No players yet."
        return send(cid, f"<b>📋 Player List</b>\n\n🏷️ Ref: <code>{rc}</code>\n"
                    f"📊 {hint}\n\n<i>Send your Share Link!</i>")
    start = (page-1)*PAGE_SIZE; pp = all_p[start:start+PAGE_SIZE]
    title = f"<b>📋 Player List — {rc}</b>"
    if search: title += f" 🔍 \"{search}\""
    lines = [title, f"📊 Total: {total}  |  Page {page}/{tp}\n"]
    for i,p in enumerate(pp, start+1):
        nm = p["first_name"] or "Anonymous"; tgi = p["telegram_id"]
        tg = f"@{p['username']}" if p.get("username") else f"ID:{tgi}"
        lines.append(f"{i}. {nm}  📱 {tg}  🆔 <code>{tgi}</code>  <i>{(p.get('created_at',''))[:16]}</i>")
    btns = []
    if tp>1:
        row = []
        search_suffix = f"_{search[:20]}" if search else ""
        if page>1: row.append({"text":"◀ Prev","callback_data":f"players_{rc}_{page-1}{search_suffix}"})
        if page<tp: row.append({"text":"Next ▶","callback_data":f"players_{rc}_{page+1}{search_suffix}"})
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
    week = db_week_count(rc); month = db_month_count(rc)
    link = f"https://t.me/{BOT_USERNAME}?start={uid}"
    mood = "🔥 Great momentum!" if today>0 else "💤 No new players yet. Share your link!"
    send(cid, f"<b>📅 Daily Stats — {time.strftime('%Y-%m-%d')}</b>\n\n🏷️ Ref: <code>{rc}</code>\n"
         f"━━━━━━━━━━━━━━━━━\n🆕 Today: <b>{today}</b>\n📅 This Week: <b>{week}</b>\n"
         f"📆 This Month: <b>{month}</b>\n📊 Total: <b>{total}</b>\n"
         f"━━━━━━━━━━━━━━━━━\n{mood}\n\n📢 Share:\n{link}\n\n<b>Commands:</b> /players /share /my")

def handle_help(msg):
    chat = msg.get("chat",{}); cid = chat.get("id")
    uid = msg.get("from",{}).get("id")
    base = ("<b>📋 Commands</b>\n\n<b>Agents:</b>\n/bind &lt;link&gt; — Bind promo link\n"
            "/my — Stats\n/players [name] — Player list (search by name)\n/share — Promo text\n/daily — Today\n\n"
            "<b>Everyone:</b>\n/start — Start\n/top — Leaderboard\n/help — Help")
    if is_admin(uid):
        base += ("\n\n<b>🔧 Admin:</b>\n/admin — Dashboard\n/approve &lt;code&gt; — Approve agent\n"
                 "/ban &lt;code&gt; — Ban agent\n/unban &lt;code&gt; — Unban agent\n"
                 "/broadcast &lt;msg&gt; — Message all agents\n/export — Export agent data")
    send(cid, base)

# ── Admin Commands ──────────────────────────────────────────────

def handle_admin(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    if not is_admin(uid):
        return send(cid, "⛔ Admin only.")
    s = db_global_stats()
    top_lines = []
    for i, (rc, name, cnt) in enumerate(s["top"], 1):
        top_lines.append(f"{i}. <code>{rc}</code> — {name} ({cnt} players)")
    send(cid, f"<b>📊 Admin Dashboard</b>\n\n"
         f"👥 Agents: {s['active_agents']} active / {s['pending_agents']} pending / {s['total_agents']} total\n"
         f"👤 Players: {s['total_players']} total\n"
         f"━━━━━━━━━━━━━━━━━\n"
         f"🆕 Today: {s['today_players']}\n📅 This Week: {s['week_players']}\n"
         f"📆 This Month: {s['month_players']}\n"
         f"━━━━━━━━━━━━━━━━━\n"
         f"<b>🏆 Top 10 Agents:</b>\n" + "\n".join(top_lines) + "\n"
         f"━━━━━━━━━━━━━━━━━\n"
         f"<b>Admin:</b> /approve /ban /unban /broadcast")

def handle_broadcast(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    if not is_admin(uid):
        return send(cid, "⛔ Admin only.")
    text = msg.get("text","").strip()
    parts = text.split(maxsplit=1)
    if len(parts) < 2:
        return send(cid, "<b>Usage:</b> /broadcast Your message here")
    message = parts[1]
    agent_ids = db_all_agent_ids()
    success = 0; fail = 0
    for aid in agent_ids:
        r = send(aid, f"<b>📢 Admin Broadcast</b>\n\n{message}")
        if r and r.get("ok"): success += 1
        else: fail += 1
        time.sleep(0.3)
    send(cid, f"<b>📢 Broadcast Sent</b>\n\n✅ {success} delivered\n❌ {fail} failed\n📊 Total agents: {len(agent_ids)}")

def handle_approve(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    if not is_admin(uid):
        return send(cid, "⛔ Admin only.")
    text = msg.get("text","").strip()
    parts = text.split()
    if len(parts) < 2:
        return send(cid, "<b>Usage:</b> /approve &lt;ref_code&gt;")
    ref_code = parts[1]
    if db_approve_agent(ref_code):
        send(cid, f"✅ Agent <code>{ref_code}</code> approved! Share link is now active.")
    else:
        send(cid, f"❌ Agent <code>{ref_code}</code> not found or already approved.")

def handle_ban(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    if not is_admin(uid):
        return send(cid, "⛔ Admin only.")
    text = msg.get("text","").strip()
    parts = text.split()
    if len(parts) < 2:
        return send(cid, "<b>Usage:</b> /ban &lt;ref_code&gt;")
    ref_code = parts[1]
    if db_ban_agent(ref_code):
        send(cid, f"🚫 Agent <code>{ref_code}</code> banned.")
    else:
        send(cid, f"❌ Agent <code>{ref_code}</code> not found.")

def handle_unban(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    if not is_admin(uid):
        return send(cid, "⛔ Admin only.")
    text = msg.get("text","").strip()
    parts = text.split()
    if len(parts) < 2:
        return send(cid, "<b>Usage:</b> /unban &lt;ref_code&gt;")
    ref_code = parts[1]
    if db_approve_agent(ref_code):
        send(cid, f"✅ Agent <code>{ref_code}</code> unbanned / re-approved.")
    else:
        send(cid, f"❌ Agent <code>{ref_code}</code> not found.")

def handle_export(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id"); uid = frm.get("id")
    if not is_admin(uid):
        return send(cid, "⛔ Admin only.")
    conn = None
    try:
        conn = get_db(); c = conn.cursor()
        c.execute("SELECT ref_code, first_name, invite_count, status, created_at FROM users WHERE role='agent' ORDER BY invite_count DESC")
        rows = c.fetchall()
    finally:
        if conn: conn.close()
    if not rows:
        return send(cid, "No agents yet.")
    header = [f"<b>📋 Agent Export — {time.strftime('%Y-%m-%d %H:%M')}</b>\n"]
    header.append("<pre>")
    header.append(f"{'Ref':<12} {'Name':<16} {'Invites':>7} {'Status':<10} {'Since'}")
    header.append("-" * 65)
    rows_list = []
    for rc, name, cnt, st, ca in rows:
        ts = str(ca)[:10] if ca else "-"
        rows_list.append(f"{rc:<12} {(name or '-')[:15]:<16} {cnt or 0:>7} {(st or 'active'):<10} {ts}")
    footer = ["</pre>"]
    full = "\n".join(header + rows_list + footer)
    if len(full) > 4000:
        # 分段发送，每段都包 <pre>
        chunk_size = 35
        for i in range(0, len(rows_list), chunk_size):
            chunk = header + rows_list[i:i+chunk_size] + footer
            send(cid, "\n".join(chunk), pm="HTML")
    else:
        send(cid, full)

def handle_top(msg):
    chat = msg.get("chat",{}); frm = msg.get("from",{})
    cid = chat.get("id")
    s = db_global_stats()
    lines = [f"<b>🏆 Agent Leaderboard</b>\n"]
    for i, (rc, name, cnt) in enumerate(s["top"], 1):
        medal = {1:"🥇",2:"🥈",3:"🥉"}.get(i, f"{i}.")
        lines.append(f"{medal} <code>{rc}</code> — {name} ({cnt} players)")
    send(cid, "\n".join(lines) + "\n\n<b>Commands:</b> /my /daily /help")

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
        elif text.startswith("/help"): handle_help(msg)
        elif text.startswith("/admin"): handle_admin(msg)
        elif text.startswith("/broadcast"): handle_broadcast(msg)
        elif text.startswith("/approve"): handle_approve(msg)
        elif text.startswith("/ban"): handle_ban(msg)
        elif text.startswith("/unban"): handle_unban(msg)
        elif text.startswith("/top"): handle_top(msg)
        elif text.startswith("/export"): handle_export(msg)
    elif "callback_query" in update:
        cb = update["callback_query"]; data = cb.get("data",""); cbid = cb.get("id")
        cbmsg = cb.get("message",{}); cbfrm = cb.get("from",{})
        if data.startswith("players_"):
            parts = data.split("_", 3)  # players, rc, page, [search]
            if len(parts) >= 3:
                pg = int(parts[2])
                srch = parts[3] if len(parts) > 3 and parts[3] else None
                handle_players({"chat":cbmsg.get("chat"),"from":cbfrm}, page=pg, search=srch)
        answer_cb(cbid)

# ── Flask Routes ────────────────────────────────────────────────

@app.route("/")
def home():
    return "PH90 WFH Bonus Bot — 24/7 Cloud 🚀"

@app.route("/debug")
def debug():
    conn = None
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM users")
        count = c.fetchone()[0]
        return jsonify({"db": "ok", "user_count": count})
    except Exception as e:
        return jsonify({"db": "error", "detail": str(e)})
    finally:
        if conn: conn.close()

@app.route("/webhook", methods=["POST"])
def webhook():
    # 验证 Telegram Secret Token
    if request.headers.get("X-Telegram-Bot-Api-Secret-Token") != SECRET_TOKEN:
        return jsonify({"ok": False, "error": "unauthorized"}), 403
    update = request.get_json()
    if update:
        try:
            process_update(update)
        except Exception as e:
            import traceback
            print(f"[ERROR] {e}")
            traceback.print_exc()
            return jsonify({"ok": False, "error": str(e)})
    return jsonify({"ok": True})

# ── Startup ─────────────────────────────────────────────────────

def set_webhook():
    if not RENDER_APP_URL:
        print("[WEBHOOK] RENDER_APP_URL env var not set yet")
        return False
    url = f"{RENDER_APP_URL}/webhook"
    result = tg("setWebhook", {"url": url, "secret_token": SECRET_TOKEN, "drop_pending_updates": True})
    ok = result and result.get("ok")
    print(f"[WEBHOOK] {url} → {'OK' if ok else result}")
    return ok

# 初始化数据库（gunicorn 不发 __main__，所以放外面）
print("[INIT] Connecting to Supabase PostgreSQL...")
try:
    init_db()
    print("[INIT] Database ready")
except Exception as e:
    print(f"[INIT] DB ERROR: {e}")

# 启动时设置 webhook
if RENDER_APP_URL:
    set_webhook()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"[START] Listening on port {port}")
    app.run(host="0.0.0.0", port=port)
