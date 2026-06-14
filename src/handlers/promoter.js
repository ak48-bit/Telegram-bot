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
  if (pm.rows.length === 0) return ctx.reply('Promoter identity not bound or blocked.');

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
    ? `Promoter Affiliate Link：\n${p.promo_url}`
    : 'Promoter Affiliate Link：';

  return ctx.reply(
    `📢 <b>Promoter</b>\n\n` +
    `Upline Agent：<code>${p.agent_code}</code>\n\n` +
    `Promoter Code：<code>${p.promoter_code}</code>\n` +
    `Name：${p.name}\n` +
    `Telegram：@${ctx.from.username || '-'}\n` +
    `Telegram ID：<code>${uid}</code>\n` +
    `${promoLine}\n` +
    `Status：${p.promo_url ? '✅ Active' : 'Not Submitted — /set_promo'}\n\n` +
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
  if (pm.rows.length === 0) return ctx.reply('Promoter identity not bound.');

  const p = pm.rows[0];
  const link = `https://t.me/${BOT_USERNAME}?start=p_${p.promoter_code}`;

  let msg = `📢 <b>Promoter Affiliate Link</b>\n\n` +
    `Promoter Code：<code>${p.promoter_code}</code>\n`;
  if (p.promo_url) {
    msg += `Promoter Affiliate Link：\n${p.promo_url}\n`;
  } else {
    msg += `Promoter Affiliate Link：<i>Not submitted — /set_promo</i>\n`;
  }
  msg += `\n<b>Players Bot Share Link：</b>\n` +
    `${link}\n\n` +
    `1️⃣ Submit the Affiliate link first → 2️⃣ Copy the bot link and send it to players`;

  return ctx.reply(msg, { parse_mode: 'HTML' });
}

// /my_players [page]
async function handleMyPlayers(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query('SELECT id FROM promoters WHERE telegram_id = $1', [uid]);
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound.');

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

  if (res.rows.length === 0) return ctx.reply('No players yet.');

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
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound.');

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
    `📅 <b>Today Data — ${new Date().toISOString().slice(0, 10)}</b>\n\n` +
    `🏷️ Code：<code>${pm.rows[0].promoter_code}</code>\n\n` +
    `🆕 Today New: <b>${s.today}</b>\n` +
    `📝 Submitted GameID: <b>${s.submitted}</b>\n` +
    `✅ Approved: <b>${s.approved}</b>`,
    { parse_mode: 'HTML' }
  );
}

// /set_promo http://90jilia2.com/?r=ph90hk433
async function handleSetPromo(ctx) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: <code>/set_promo http://your-domain.com/?r=your_code</code>', { parse_mode: 'HTML' });
  const url = parts[1];
  if (!url.startsWith('http')) return ctx.reply('❌ URL must start with http:// or https://.');

  await db.query(
    `UPDATE promoters SET promo_url = $1, updated_at = NOW() WHERE telegram_id = $2`,
    [url, uid]
  );
  return ctx.reply(
    `📢 <b>Promoter Sets Up Promotion Link</b>\n\n` +
    `<code>/set_promo ${url}</code>\n\n` +
    `✅ Promoter Affiliate Link set!\n\n` +
    `${url}`,
    { parse_mode: 'HTML' }
  );
}

// /share — 生成分享文案
async function handleShare(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query(
    `SELECT * FROM promoters WHERE telegram_id = $1 AND status = 'active'`, [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound.');
  const p = pm.rows[0];
  const link = `https://t.me/${BOT_USERNAME}?start=p_${p.promoter_code}`;

  let msg = `📋 <b>Promoter Sharing Message</b>\n\n`;
  msg += `  Copy the following message and send it to players：\n\n`;
  msg += `  🎰 Share + Signup Reward\n`;
  msg += `  ━━━━━━━━━━━━━━━\n`;
  if (p.promo_url) {
    msg += `  Promoter Affiliate Link：\n  ${p.promo_url}\n\n`;
  }
  msg += `  📋 Promoter Bot Link：\n` +
    `  ${link}\n` +
    `  ━━━━━━━━━━━━━━━\n` +
    `  💰 Register and Get a Bonus | Share and Get Extra Rewards\n` +
    `  📢 Forward to your friends and claim together`;

  return ctx.reply(msg, { parse_mode: 'HTML' });
}

module.exports = { handlePromoter, handleMyLink, handleMyPlayers, handleMyToday, handleSetPromo, handleShare };
