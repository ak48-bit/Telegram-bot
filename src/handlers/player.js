const db = require('../db');
const audit = require('../services/audit');
const config = require('../config');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';

// Game ID: 3-32 chars, A-Z a-z 0-9 only
const GAME_ID_REGEX = /^[A-Za-z0-9]{3,32}$/;

// /submit
async function handleSubmit(ctx) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    const session = require('../services/session');
    session.set(uid, { action: 'submit_game_id', data: {}, userRole: 'player' });
    await audit.log(uid, 'player', 'step_submit_game_id_started', null, null, {});
    return ctx.reply('Please enter your Game ID:');
  }
  const raw = parts[1];
  const gameId = raw.trim().toUpperCase();

  // Validate format
  if (!GAME_ID_REGEX.test(raw.trim())) {
    await audit.log(uid, 'player', 'submit_game_id_invalid', 'player', String(uid), { game_id: raw });
    return ctx.reply('Invalid Game ID. Use 3-32 letters or numbers only.');
  }

  // Rate limit: per minute
  const rateMin = await db.query(
    `SELECT COUNT(*) FROM rate_limits WHERE telegram_id = $1 AND attempt_type = 'submit_game_id' AND created_at > NOW() - INTERVAL '1 minute'`,
    [uid]
  );
  if (parseInt(rateMin.rows[0].count) >= config.SUBMIT_RATE_LIMITS.perMinute) {
    await audit.log(uid, 'player', 'submit_game_id_rate_limited', 'player', String(uid), { reason: 'per_minute' });
    return ctx.reply('Too many submissions. Please try again later.');
  }
  const rateHour = await db.query(
    `SELECT COUNT(*) FROM rate_limits WHERE telegram_id = $1 AND attempt_type = 'submit_game_id' AND created_at > NOW() - INTERVAL '1 hour'`,
    [uid]
  );
  if (parseInt(rateHour.rows[0].count) >= config.SUBMIT_RATE_LIMITS.perHour) {
    await audit.log(uid, 'player', 'submit_game_id_rate_limited', 'player', String(uid), { reason: 'per_hour' });
    return ctx.reply('Too many submissions. Please try again later.');
  }
  await db.query(`INSERT INTO rate_limits (telegram_id, attempt_type) VALUES ($1, 'submit_game_id')`, [uid]);

  const player = await db.query(
    `SELECT p.*, pm.status AS pm_status, a.status AS ag_status
     FROM players p
     LEFT JOIN promoters pm ON p.promoter_id = pm.id
     LEFT JOIN agents a ON p.agent_id = a.id
     WHERE p.telegram_id = $1`, [uid]
  );
  if (player.rows.length === 0) {
    return ctx.reply('Please enter through a valid Bot Share Link first.');
  }
  const p = player.rows[0];

  if (p.pm_status === 'blocked' || p.ag_status === 'blocked') {
    await audit.log(uid, 'player', 'submit_game_id_blocked_line', 'player', String(uid));
    return ctx.reply('This referral line has been suspended. Please contact customer service.');
  }

  if (p.game_id_status === 'approved') {
    await audit.log(uid, 'player', 'submit_game_id_already_approved', 'player', String(uid), { game_id: gameId });
    return ctx.reply('Your Game ID has already been approved and cannot be changed.');
  }

  const dup = await db.query(
    `SELECT telegram_id FROM players WHERE game_id_normalized = $1 AND telegram_id != $2`, [gameId, uid]
  );
  if (dup.rows.length > 0) {
    await audit.log(uid, 'player', 'submit_game_id_duplicate', 'player', String(uid), { game_id: gameId });
    return ctx.reply('This Game ID has already been submitted.');
  }

  await db.query(
    `UPDATE players SET game_id = $1, game_id_normalized = $2, game_id_status = 'pending', updated_at = NOW() WHERE telegram_id = $3`,
    [gameId, gameId, uid]
  );
  await audit.log(uid, 'player', 'submit_game_id', 'player', String(uid), { game_id: gameId });

  return ctx.reply(
    `🎮 <b>Submit Game ID</b>\n\n<code>/submit ${gameId}</code>\n\n✅ Submitted Successfully\nGame ID：<code>${gameId}</code>\nStatus：Pending Review ⏳\n\n<i>Please wait for Admin review.</i>`,
    { parse_mode: 'HTML' }
  );
}

// /my
async function handlePlayerMy(ctx) {
  const uid = ctx.from.id;
  const player = await db.query(
    `SELECT p.*, pm.promoter_code, pm.name AS promoter_name, a.agent_code, a.name AS agent_name
     FROM players p LEFT JOIN promoters pm ON p.promoter_id = pm.id LEFT JOIN agents a ON p.agent_id = a.id
     WHERE p.telegram_id = $1`, [uid]
  );
  if (player.rows.length === 0) return ctx.reply('No referral source bound. Enter through a Bot Share Link.');
  const p = player.rows[0];
  const statusText = { pending: 'Pending Review...⏳', approved: 'Approved ✅', rejected: 'Rejected ❌' };
  const st = statusText[p.game_id_status] || 'Not submitted';
  return ctx.reply(
    `🎮\n\nTelegram：@${ctx.from.username || '-'}\nTelegram ID：<code>${uid}</code>\nGame ID：<code>${p.game_id || 'Not submitted'}</code>\nStatus：${st}\n\n👤 Promoter：${p.promoter_name || '-'} (${p.promoter_code || '-'})`,
    { parse_mode: 'HTML' }
  );
}

// /share — Player shares their promoter's Bot Share link
async function handlePlayerShare(ctx) {
  const uid = ctx.from.id;
  const player = await db.query(
    `SELECT p.*, pm.promoter_code, pm.player_affiliate_link_original, pm.player_referral_token
     FROM players p
     JOIN promoters pm ON p.promoter_id = pm.id
     WHERE p.telegram_id = $1`, [uid]
  );
  if (player.rows.length === 0) {
    return ctx.reply('You do not have a referral source yet. Please enter through a valid activity link.');
  }
  const p = player.rows[0];
  const botLink = `https://t.me/${BOT_USERNAME}?start=p_${p.player_referral_token}`;

  let msg = `📋 <b>Share Activity</b>\n\nShare this activity link with your friends.\n\n`;
  msg += `🤖 <b>Bot Entry Link：</b>\n${botLink}\n`;
  if (p.player_affiliate_link_original) {
    msg += `\n🎮 <b>Game Registration Link：</b>\n${p.player_affiliate_link_original}\n`;
  }
  msg += `\nYour friends can enter the Bot and follow the activity instructions.\n`;
  msg += `Rewards are claimed in-game according to the activity rules.`;
  return ctx.reply(msg, { parse_mode: 'HTML' });
}

module.exports = { handleSubmit, handlePlayerMy, handlePlayerShare };
