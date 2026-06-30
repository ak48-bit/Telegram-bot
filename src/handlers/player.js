const { escapeHtml, isUniqueViolation } = require('../services/escapeHtml');
const db = require('../db');
const audit = require('../services/audit');
const config = require('../config');
const { checkGameAccount } = require('../services/gameAccountApi');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';

const GAME_ID_REGEX = new RegExp(config.GAME_ID_REGEX);

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

  // Only block if player actually has a Game ID — game_id_status alone is not enough
  // (game_id may have been cleared by admin while status remains 'submitted')
  const hasGameId = !!(p.game_id_normalized || p.game_id);
  if (hasGameId && ['submitted', 'approved'].includes(p.game_id_status)) {
    await audit.log(uid, 'player', 'submit_game_id_already_submitted', 'player', String(uid), { game_id: gameId });
    return ctx.reply('Your Game ID has already been submitted and cannot be changed.');
  }

  const dup = await db.query(
    `SELECT telegram_id FROM players WHERE game_id_normalized = $1 AND telegram_id != $2`, [gameId, uid]
  );
  if (dup.rows.length > 0) {
    await audit.log(uid, 'player', 'submit_game_id_duplicate', 'player', String(uid), { game_id: gameId });
    return ctx.reply('This Game ID has already been submitted.');
  }

  // ── Phase 2: Verify Game ID against WJ backend API ──
  const apiResult = await checkGameAccount(gameId);

  if (apiResult.status === 'not_registered') {
    await audit.log(uid, 'player', 'submit_game_id_not_registered', 'player', String(uid), { game_id: gameId, source: apiResult.source });
    return ctx.reply(
      '❌ Game ID not found.\nPlease make sure you have registered your game account first, then submit again.'
    );
  }

  if (apiResult.status === 'api_error') {
    await audit.log(uid, 'player', 'submit_game_id_api_error', 'player', String(uid), { game_id: gameId, error: apiResult.error });
    return ctx.reply(
      '⚠️ Verification is temporarily unavailable.\nPlease try again later.'
    );
  }
  // verified or submitted (disabled mode) → proceed

  try {
    await db.query(
      `UPDATE players SET game_id = $1, game_id_normalized = $2, game_id_status = 'submitted',
             player_share_code = COALESCE(player_share_code, $2), updated_at = NOW() WHERE telegram_id = $3`,
      [gameId, gameId, uid]
    );
  } catch (e) {
    if (isUniqueViolation(e)) {
      return ctx.reply('This Game ID has already been submitted. Please check and try again.');
    }
    throw e;
  }
  await audit.log(uid, 'player', 'submit_game_id', 'player', String(uid), { game_id: gameId, api_status: apiResult.status, source: apiResult.source });

  const verifiedText = apiResult.status === 'verified'
    ? '\n✅ Game ID verified successfully.\nYour account has been found in the game backend.'
    : '\n✅ Game ID submitted successfully.';
  return ctx.reply(
    `🎮 <b>Game ID Submitted</b>\n\n<code>/submit ${escapeHtml(gameId)}</code>\n${verifiedText}\nYour participation information has been recorded.\nRewards are claimed in-game according to the activity rules.`,
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
  const statusText = { submitted: 'Submitted ✅', approved: 'Recorded ✅', pending: 'Recorded ✅', rejected: 'Recorded' };
  const st = statusText[p.game_id_status] || 'Not submitted';
  return ctx.reply(
    `🎮\n\nTelegram：@${escapeHtml(ctx.from.username || '-')}\nTelegram ID：<code>${uid}</code>\nGame ID：<code>${escapeHtml(p.game_id || 'Not submitted')}</code>\nStatus：${st}\n\n👤 Promoter：${escapeHtml(p.promoter_name || '-')} (${escapeHtml(p.promoter_code || '-')})`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '📝 Submit Game ID', callback_data: 'cmd:/submit' }],
        [{ text: '👤 My Info', callback_data: 'cmd:/my' }, { text: '📣 Share Bot Link', callback_data: 'cmd:/share' }],
      ]}
    }
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

  // Ensure player_share_code — use game_id_normalized, or generate unique code
  let shareCode = p.player_share_code;
  if (!shareCode) {
    shareCode = p.game_id_normalized;
    if (!shareCode) {
      const crypto = require('crypto');
      shareCode = crypto.randomBytes(8).toString('hex');
    }
    await db.query('UPDATE players SET player_share_code = $1 WHERE telegram_id = $2', [shareCode, uid]);
  }

  const botLink = `https://t.me/${BOT_USERNAME}?start=p_C001_${shareCode}`;

  let msg = `📋 <b>Share Activity</b>\n\nShare this activity link with your friends.\n\n`;
  msg += `Source Code：C001-${shareCode}\n`;
  msg += `🤖 <b>Bot Entry Link：</b>\n${botLink}\n`;
  if (p.player_affiliate_link_original) {
    msg += `\n🎮 <b>Game Registration Link：</b>\n${p.player_affiliate_link_original}\n`;
  }
  msg += `\nYour friends can enter the Bot and follow the activity instructions.\n`;
  msg += `Rewards are claimed in-game according to the activity rules.`;
  return ctx.reply(msg, { parse_mode: 'HTML' });
}

module.exports = { handleSubmit, handlePlayerMy, handlePlayerShare };
