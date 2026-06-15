const db = require('../db');
const audit = require('../services/audit');
const { validateAndNormalize } = require('../services/normalize');
const config = require('../config');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';

async function handlePromoter(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query(
    `SELECT pm.*, a.agent_code, a.name AS agent_name FROM promoters pm JOIN agents a ON pm.agent_id = a.id
     WHERE pm.telegram_id = $1 AND pm.status = 'active'`, [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound or blocked.');

  const p = pm.rows[0];
  const stats = await db.query(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today FROM players WHERE promoter_id = $1`, [p.id]
  );
  const s = stats.rows[0];

  const linkLine = p.link_status === 'BOUND'
    ? `Player Affiliate Link：\n${p.player_affiliate_link_original}`
    : 'Player Affiliate Link：NOT_SUBMITTED — /set_player_link';

  return ctx.reply(
    `📢 <b>Promoter</b>\n\n` +
    `Upline Agent：<code>${p.agent_code}</code>\n\n` +
    `Promoter Code：<code>${p.promoter_code}</code>\n` +
    `Name：${p.name}\n` +
    `Telegram：@${ctx.from.username || '-'}\n` +
    `Telegram ID：<code>${uid}</code>\n` +
    `${linkLine}\n` +
    `Link Status：${p.link_status || 'NOT_SUBMITTED'}\n\n` +
    `Players：${s.total} total | 🆕 Today: ${s.today}\n\n` +
    `/my_link | /set_player_link | /my_players | /my_today | /share`,
    { parse_mode: 'HTML' }
  );
}

// /my_link — shows random token bot link
async function handleMyLink(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query(
    `SELECT * FROM promoters WHERE telegram_id = $1 AND status = 'active'`, [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound.');
  const p = pm.rows[0];

  // Ensure player_referral_token exists
  let token = p.player_referral_token;
  if (!token) {
    const crypto = require('crypto');
    token = crypto.randomBytes(16).toString('hex');
    await db.query('UPDATE promoters SET player_referral_token = $1 WHERE id = $2', [token, p.id]);
  }
  const link = `https://t.me/${BOT_USERNAME}?start=p_${token}`;

  let msg = `📢 <b>Promoter Affiliate Link</b>\n\nPromoter Code：<code>${p.promoter_code}</code>\n`;
  if (p.link_status === 'BOUND' && p.player_affiliate_link_original) {
    msg += `Player Affiliate Link：\n${p.player_affiliate_link_original}\n`;
  } else {
    msg += `Player Affiliate Link：<i>Not Submitted — /set_player_link</i>\n`;
  }
  msg += `\n<b>Players Bot Share Link：</b>\n${link}\n\n1️⃣ Submit link → 2️⃣ Send bot link to players`;
  return ctx.reply(msg, { parse_mode: 'HTML' });
}

// /set_player_link
async function handleSetPlayerLink(ctx) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    const session = require('../services/session');
    session.set(uid, { action: 'set_player_link', data: {}, userRole: 'promoter' });
    await audit.log(uid, 'promoter', 'step_set_player_link_started', null, null, {});
    return ctx.reply('Please send your Player Affiliate Link:');
  }
  const raw = parts[1];

  const result = validateAndNormalize(raw, config.ALLOWED_DOMAINS);
  if (!result.valid) {
    await audit.log(uid, 'promoter', 'set_player_link_invalid', 'promoter', null, { url: raw });
    return ctx.reply('Invalid link format.');
  }

  const pm = await db.query('SELECT * FROM promoters WHERE telegram_id = $1', [uid]);
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound.');
  const promoter = pm.rows[0];

  if (promoter.link_status === 'BOUND' && promoter.player_affiliate_link_normalized) {
    await audit.log(uid, 'promoter', 'set_player_link_duplicate_own', 'promoter', promoter.promoter_code, { url: raw });
    return ctx.reply('You have already submitted your Player Affiliate Link.');
  }

  const dup = await db.query(
    'SELECT promoter_code FROM promoters WHERE player_affiliate_link_normalized = $1 AND telegram_id != $2',
    [result.normalized, uid]
  );
  if (dup.rows.length > 0) {
    await audit.log(uid, 'promoter', 'set_player_link_duplicate_link', 'promoter', promoter.promoter_code, { url: raw, conflict: dup.rows[0].promoter_code });
    return ctx.reply('This link has already been used.');
  }

  await db.query(
    `UPDATE promoters SET player_affiliate_link_original = $1, player_affiliate_link_normalized = $2, link_status = 'BOUND', updated_at = NOW() WHERE telegram_id = $3`,
    [result.original, result.normalized, uid]
  );
  await audit.log(uid, 'promoter', 'set_player_link_success', 'promoter', promoter.promoter_code, { url: result.normalized });

  return ctx.reply('Submitted Successfully\nPromoter Link Bound Successfully');
}

// /set_promo — legacy redirect for both roles
async function handleSetPromoCompat(ctx) {
  const user = ctx.state.user;
  if (!user) return ctx.reply('No permission.');
  if (user.role === 'agent') {
    const { handleSetAgentLink } = require('./agent');
    return handleSetAgentLink(ctx);
  }
  if (user.role === 'promoter') {
    return handleSetPlayerLink(ctx);
  }
  return ctx.reply('No permission.');
}

// /my_players
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
    `SELECT p.*, u.username FROM players p LEFT JOIN users u ON p.telegram_id = u.telegram_id WHERE p.promoter_id = $1 ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
    [pm.rows[0].id, limit, offset]
  );
  if (res.rows.length === 0) return ctx.reply('No players yet.');
  const lines = [`<b>My Players</b> — Page ${page}/${totalPages} (Total: ${total})\n`];
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
    `SELECT COUNT(*) AS today, COUNT(*) FILTER (WHERE game_id IS NOT NULL) AS submitted,
            COUNT(*) FILTER (WHERE game_id_status = 'approved') AS approved
     FROM players WHERE promoter_id = $1 AND created_at::date = CURRENT_DATE`, [pm.rows[0].id]
  );
  const s = stats.rows[0];
  return ctx.reply(
    `📅 <b>Today — ${new Date().toISOString().slice(0, 10)}</b>\n\n` +
    `Code：<code>${pm.rows[0].promoter_code}</code>\n\n` +
    `🆕 Today：<b>${s.today}</b>\n📝 Submitted：<b>${s.submitted}</b>\n✅ Approved：<b>${s.approved}</b>`,
    { parse_mode: 'HTML' }
  );
}

// /share — only when BOUND
async function handleShare(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query(
    `SELECT * FROM promoters WHERE telegram_id = $1 AND status = 'active'`, [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound.');
  const p = pm.rows[0];

  if (p.link_status !== 'BOUND' || !p.player_affiliate_link_original) {
    return ctx.reply('⚠️ You must submit your Player Affiliate Link first.\n\nUse /set_player_link to submit.', { parse_mode: 'HTML' });
  }

  // Ensure player_referral_token
  let token = p.player_referral_token;
  if (!token) {
    const crypto = require('crypto');
    token = crypto.randomBytes(16).toString('hex');
    await db.query('UPDATE promoters SET player_referral_token = $1 WHERE id = $2', [token, p.id]);
  }
  const link = `https://t.me/${BOT_USERNAME}?start=p_${token}`;

  let msg = `📋 <b>Promoter Sharing Message</b>\n\n  Copy the following message and send it to players：\n\n`;
  msg += `  🎰 Share + Signup Reward\n`;
  msg += `  ━━━━━━━━━━━━━━━\n`;
  msg += `  Promoter Affiliate Link：\n  ${p.player_affiliate_link_original}\n\n`;
  msg += `  📋 Promoter Bot Link：\n  ${link}\n`;
  msg += `  ━━━━━━━━━━━━━━━\n`;
  msg += `  💰 Register and Get a Bonus | Share and Get Extra Rewards\n`;
  msg += `  📢 Forward to your friends and claim together`;
  return ctx.reply(msg, { parse_mode: 'HTML' });
}

module.exports = {
  handlePromoter, handleMyLink, handleMyPlayers, handleMyToday,
  handleSetPlayerLink, handleSetPromoCompat, handleShare,
};
