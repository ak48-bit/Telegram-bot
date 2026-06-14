const db = require('../db');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';

async function handlePromoter(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query(
    `SELECT pm.*, a.agent_code, a.name AS agent_name
     FROM promoters pm JOIN agents a ON pm.agent_id = a.id
     WHERE pm.telegram_id = $1 AND pm.status = 'active'`,
    [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('你还没有绑定 Promoter 身份或已被封禁。');

  const p = pm.rows[0];
  const stats = await db.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today,
            COUNT(*) FILTER (WHERE game_id_status = 'approved') AS approved
     FROM players WHERE promoter_id = $1`,
    [p.id]
  );
  const s = stats.rows[0];
  const promoLine = p.promo_url
    ? `Promoter Link：<code>${p.promo_url}</code>`
    : 'Promoter Link：';

  return ctx.reply(
    `📢 <b>Promoter 面板</b>\n\n` +
    `Upline Agent：<code>${p.agent_code}</code>\n\n` +
    `Promoter Code：<code>${p.promoter_code}</code>\n` +
    `Name：${p.name}\n` +
    `Telegram：@${ctx.from.username || '-'}\n` +
    `Telegram ID：<code>${uid}</code>\n` +
    `${promoLine}\n` +
    `Status：${p.promo_url ? '✅ Active' : '未提交 — /set_promo'}\n\n` +
    `Players：${s.total} total | 🆕 Today: ${s.today}\n\n` +
    `/set_promo | /my_link | /my_players | /my_today | /share`,
    { parse_mode: 'HTML' }
  );
}

// /my_link
async function handleMyLink(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query(
    `SELECT * FROM promoters WHERE telegram_id = $1 AND status = 'active'`, [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('你还没有绑定 Promoter 身份。');

  const p = pm.rows[0];
  const link = `https://t.me/${BOT_USERNAME}?start=p_${p.promoter_code}`;

  let msg = `📢 <b>开发员推广链接</b>\n\n` +
    `🏷️ 线上开发员 Code：<code>${p.promoter_code}</code>\n`;
  if (p.promo_url) {
    msg += `🔗 开发员推广链接：<code>${p.promo_url}</code>\n`;
  } else {
    msg += `🔗 开发员推广链接：<i>未提交 — /set_promo</i>\n`;
  }
  msg += `\n📋 <b>玩家推广链接（机器人链接）：</b>\n` +
    `<code>${link}</code>\n\n` +
    `1️⃣ 先提交开发员推广链接 → 2️⃣ 复制机器人链接发给玩家。\n\n` +
    `提交推广链接：<code>/set_promo http://域名/?r=你的码</code>`;

  return ctx.reply(msg, { parse_mode: 'HTML' });
}

// /my_players [page]
async function handleMyPlayers(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query('SELECT id FROM promoters WHERE telegram_id = $1', [uid]);
  if (pm.rows.length === 0) return ctx.reply('未绑定 Promoter。');

  const parts = ctx.message.text.trim().split(/\s+/);
  let page = 1;
  if (parts.length >= 2) page = parseInt(parts[1]) || 1;
  const limit = 30;
  const offset = (page - 1) * limit;

  const count = await db.query('SELECT COUNT(*) FROM players WHERE promoter_id = $1', [pm.rows[0].id]);
  const total = parseInt(count.rows[0].count);
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const res = await db.query(
    `SELECT p.*, u.username
     FROM players p LEFT JOIN users u ON p.telegram_id = u.telegram_id
     WHERE p.promoter_id = $1
     ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
    [pm.rows[0].id, limit, offset]
  );

  if (res.rows.length === 0) return ctx.reply('暂无玩家。');

  const lines = [`<b>📋 My Players</b> — Page ${page}/${totalPages} (Total: ${total})\n`];
  for (const r of res.rows) {
    const un = r.username ? `@${r.username}` : '-';
    lines.push(`${un} | TG: <code>${r.telegram_id}</code> | GameID: ${r.game_id || '-'} | ${r.game_id_status || 'pending'}`);
  }
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// /my_today
async function handleMyToday(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query('SELECT id, promoter_code FROM promoters WHERE telegram_id = $1', [uid]);
  if (pm.rows.length === 0) return ctx.reply('未绑定 Promoter。');

  const stats = await db.query(
    `SELECT COUNT(*) AS today,
            COUNT(*) FILTER (WHERE game_id IS NOT NULL) AS submitted,
            COUNT(*) FILTER (WHERE game_id_status = 'approved') AS approved
     FROM players
     WHERE promoter_id = $1 AND created_at::date = CURRENT_DATE`,
    [pm.rows[0].id]
  );
  const s = stats.rows[0];

  return ctx.reply(
    `📅 <b>今日数据 — ${new Date().toISOString().slice(0, 10)}</b>\n\n` +
    `🏷️ Code：<code>${pm.rows[0].promoter_code}</code>\n\n` +
    `🆕 今日新增：<b>${s.today}</b>\n` +
    `📝 已提交 GameID：<b>${s.submitted}</b>\n` +
    `✅ 已通过：<b>${s.approved}</b>`,
    { parse_mode: 'HTML' }
  );
}

// /set_promo http://90jilia2.com/?r=ph90hk433
async function handleSetPromo(ctx) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) return ctx.reply('格式：<code>/set_promo http://你的域名.com/?r=你的码</code>', { parse_mode: 'HTML' });
  const url = parts[1];
  if (!url.startsWith('http')) return ctx.reply('❌ 链接必须以 http:// 或 https:// 开头。');

  await db.query(
    `UPDATE promoters SET promo_url = $1, updated_at = NOW() WHERE telegram_id = $2`,
    [url, uid]
  );
  return ctx.reply(
    `✅ 推广链接已设置！\n\n🔗 <code>${url}</code>\n\n玩家通过你的 p_ 链接进入 Bot 后，将跳转到此链接。`,
    { parse_mode: 'HTML' }
  );
}

// /share — 生成分享文案
async function handleShare(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query(
    `SELECT * FROM promoters WHERE telegram_id = $1 AND status = 'active'`, [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('未绑定 Promoter。');
  const p = pm.rows[0];
  const link = `https://t.me/${BOT_USERNAME}?start=p_${p.promoter_code}`;

  let msg = `📋 <b>开发员分享文案</b>\n\n`;
  msg += `<b>复制以下文案发送给玩家：</b>\n\n`;
  msg += `🎰 Free Spins + Signup Bonus\n`;
  msg += `━━━━━━━━━━━━━━━\n`;

  if (p.promo_url) {
    msg += `🔗 开发员推广链接：\n<code>${p.promo_url}</code>\n\n`;
  }

  msg += `📋 玩家推广链接（机器人链接）：\n` +
    `<code>${link}</code>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `💰 注册即送 | 免费旋转\n` +
    `📢 转发给好友一起领\n\n` +
    `⚠️ 先设置开发员推广链接：<code>/set_promo http://域名/?r=你的码</code>`;

  return ctx.reply(msg, { parse_mode: 'HTML' });
}

module.exports = { handlePromoter, handleMyLink, handleMyPlayers, handleMyToday, handleSetPromo, handleShare };
