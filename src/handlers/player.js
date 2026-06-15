const db = require('../db');
const audit = require('../services/audit');
const config = require('../config');

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
  if (!GAME_ID_REGEX.test(gameId)) {
    await audit.log(uid, 'player', 'submit_game_id_invalid', 'player', String(uid), { game_id: raw });
    return ctx.reply('Invalid Game ID format.');
  }

  // Check player exists
  const player = await db.query('SELECT * FROM players WHERE telegram_id = $1', [uid]);
  if (player.rows.length === 0) {
    return ctx.reply('Please enter through a valid Bot Share Link first.');
  }

  // Check duplicate (normalized)
  const dup = await db.query(
    `SELECT telegram_id FROM players WHERE game_id_normalized = $1 AND telegram_id != $2`, [gameId, uid]
  );
  if (dup.rows.length > 0) {
    await audit.log(uid, 'player', 'submit_game_id_duplicate', 'player', String(uid), { game_id: gameId });
    return ctx.reply('This Game ID has already been submitted.');
  }

  // Save — auto-approved
  await db.query(
    `UPDATE players SET game_id = $1, game_id_normalized = $2, game_id_status = 'approved', updated_at = NOW() WHERE telegram_id = $3`,
    [gameId, gameId, uid]
  );
  await audit.log(uid, 'player', 'submit_game_id', 'player', String(uid), { game_id: gameId });

  return ctx.reply(
    `🎮 <b>Submit Game ID</b>\n\n<code>/submit ${gameId}</code>\n\n✅ Submitted Successfully\nGame ID：<code>${gameId}</code>\nStatus：Approved ✅`,
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

module.exports = { handleSubmit, handlePlayerMy };
