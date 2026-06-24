const { escapeHtml, isUniqueViolation } = require('../services/escapeHtml');
const db = require('../db');
const audit = require('../services/audit');
const { validateAndNormalize } = require('../services/normalize');
const config = require('../config');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';

// Ensure unique player_referral_token — generates if missing
async function ensurePlayerReferralToken(promoterId, currentToken) {
  if (currentToken) return currentToken;
  const crypto = require('crypto');
  while (true) {
    const token = crypto.randomBytes(16).toString('hex');
    const exists = await db.query('SELECT 1 FROM promoters WHERE player_referral_token = $1', [token]);
    if (exists.rows.length === 0) {
      await db.query('UPDATE promoters SET player_referral_token = $1 WHERE id = $2', [token, promoterId]);
      return token;
    }
  }
}

async function handlePromoter(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query(
    `SELECT pm.*, a.agent_code, a.name AS agent_name FROM promoters pm JOIN agents a ON pm.agent_id = a.id
     WHERE pm.telegram_id = $1 AND pm.status = 'active'`, [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound or blocked.');

  const p = pm.rows[0];
  const stats = await db.query(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today,
            COUNT(*) FILTER (WHERE game_id IS NOT NULL) AS submitted
     FROM players WHERE promoter_id = $1`, [p.id]
  );
  const s = stats.rows[0];

  const linkLine = p.link_status === 'BOUND'
    ? `Player Affiliate Link：\n${p.player_affiliate_link_original}`
    : 'Player Affiliate Link：Not Set\n<i>Please contact your Agent.</i>';

  return ctx.reply(
    `📢 <b>Promoter</b>\n\n` +
    `Upline Agent：<code>${p.agent_code}</code>\n\n` +
    `Promoter Code：<code>${p.promoter_code}</code>\n` +
    `Name：${p.name}\n` +
    `Telegram：@${ctx.from.username || '-'}\n` +
    `Telegram ID：<code>${uid}</code>\n` +
    `${linkLine}\n` +
    `Link Status：${p.link_status || 'NOT_SUBMITTED'}\n\n` +
    `Players：${s.total} total | 🆕 Today: ${s.today} | 🎮 Submitted: ${s.submitted}\n\n` +
    `<i>Your link is managed by your Agent.</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '📣 Share', callback_data: 'cmd:/share' }, { text: '🔗 My Links', callback_data: 'cmd:/my_link' }],
        [{ text: '🎮 My Players', callback_data: 'cmd:/my_players' }, { text: '📅 Today', callback_data: 'cmd:/my_today' }],
      ]}
    }
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

  // Short Bot Share link: p_B01_<PromoterCode>
  const link = `https://t.me/${BOT_USERNAME}?start=p_B01_${p.promoter_code}`;

  let msg = `📢 <b>Promoter Affiliate Link</b>\n\nPromoter Code：<code>${p.promoter_code}</code>\n` +
    `Source Code：B01-${p.promoter_code}\n`;
  if (p.link_status === 'BOUND' && p.player_affiliate_link_original) {
    msg += `Player Affiliate Link：\n${p.player_affiliate_link_original}\n`;
  } else {
    msg += `Player Affiliate Link：<i>Not Set — Please contact your Agent</i>\n`;
  }
  msg += `\n<b>Players Bot Share Link：</b>\n${link}\n\n1️⃣ Link set by Agent → 2️⃣ Send bot link to players`;
  return ctx.reply(msg, { parse_mode: 'HTML' });
}

// /set_player_link — DENIED: Promoters can no longer self-submit links
async function handleSetPlayerLink(ctx) {
  const uid = ctx.from.id;
  await audit.log(uid, 'promoter', 'promoter_set_promo_denied', 'promoter', null);
  return ctx.reply(
    'Promoter link is managed by your Agent.\nPlease contact your Agent if you need to update your link.'
  );
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
  const pm = await db.query('SELECT id FROM promoters WHERE telegram_id = $1 AND status = $2', [uid, 'active']);
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound or blocked.');
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
  const pm = await db.query('SELECT id, promoter_code FROM promoters WHERE telegram_id = $1 AND status = $2', [uid, 'active']);
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound or blocked.');
  const stats = await db.query(
    `SELECT COUNT(*) AS today, COUNT(*) FILTER (WHERE game_id IS NOT NULL) AS submitted
     FROM players WHERE promoter_id = $1 AND created_at::date = CURRENT_DATE`, [pm.rows[0].id]
  );
  const s = stats.rows[0];
  return ctx.reply(
    `📅 <b>Today — ${new Date().toISOString().slice(0, 10)}</b>\n\n` +
    `Code：<code>${pm.rows[0].promoter_code}</code>\n\n` +
    `🆕 Today：<b>${s.today}</b>\n📝 Submitted：<b>${s.submitted}</b>`,
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
    await audit.log(uid, 'promoter', 'promoter_link_missing_contact_agent', 'promoter', p.promoter_code);
    return ctx.reply(
      'Your Promoter link has not been set.\nPlease contact your Agent.',
      { parse_mode: 'HTML' }
    );
  }

  // Short Bot Share link
  const link = `https://t.me/${BOT_USERNAME}?start=p_B01_${p.promoter_code}`;

  let msg = `📋 <b>Promoter Sharing Message</b>\n\n  Copy and send to players：\n\n`;
  msg += `  🎮 Register & Join\n`;
  msg += `  ━━━━━━━━━━━━━━━\n`;
  msg += `  Game Registration Link：\n  ${p.player_affiliate_link_original}\n\n`;
  msg += `  📋 Bot Entry Link：\n  ${link}\n`;
  msg += `  ━━━━━━━━━━━━━━━\n`;
  msg += `  📱 Register via the game link above\n`;
  msg += `  🤖 Then open the Bot link to submit your Game ID\n`;
  msg += `  📢 Share with friends — rewards claimed in-game`;
  return ctx.reply(msg, { parse_mode: 'HTML' });
}

module.exports = {
  handlePromoter, handleMyLink, handleMyPlayers, handleMyToday,
  handleSetPlayerLink, handleSetPromoCompat, handleShare,
};
