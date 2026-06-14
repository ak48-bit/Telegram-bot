const db = require('../db');
const audit = require('../services/audit');

// /submit PH90123456
async function handleSubmit(ctx) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('Format: <code>/submit PH90123456</code>', { parse_mode: 'HTML' });
  }
  const gameId = parts[1];

  // 检查玩家
  const player = await db.query('SELECT * FROM players WHERE telegram_id = $1', [uid]);
  if (player.rows.length === 0) {
    return ctx.reply('Please enter through a referral link first.');
  }

  // 自动去重：检查 game_id 是否已被提交
  const dup = await db.query(
    `SELECT telegram_id FROM players WHERE game_id = $1 AND telegram_id != $2`, [gameId, uid]
  );
  if (dup.rows.length > 0) {
    return ctx.reply(
      `⚠️ <b>Duplicate Game ID</b>\n\n` +
      `Game ID：<code>${gameId}</code>\n` +
      `This Game ID has already been submitted by another player.`,
      { parse_mode: 'HTML' }
    );
  }

  // 自动通过
  await db.query(
    `UPDATE players SET game_id = $1, game_id_status = 'approved', updated_at = NOW() WHERE telegram_id = $2`,
    [gameId, uid]
  );

  await audit.log(uid, 'player', 'submit_game_id', 'player', String(uid), { game_id: gameId });

  return ctx.reply(
    `🎮 <b>Submit Game ID</b>\n\n` +
    `<code>/submit ${gameId}</code>\n\n` +
    `✅ Submitted Successfully\n` +
    `Game ID：<code>${gameId}</code>\n` +
    `Status：Approved ✅`,
    { parse_mode: 'HTML' }
  );
}

// /my
async function handlePlayerMy(ctx) {
  const uid = ctx.from.id;
  const player = await db.query(
    `SELECT p.*, pm.promoter_code, pm.name AS promoter_name, a.agent_code, a.name AS agent_name
     FROM players p
     LEFT JOIN promoters pm ON p.promoter_id = pm.id
     LEFT JOIN agents a ON p.agent_id = a.id
     WHERE p.telegram_id = $1`,
    [uid]
  );

  if (player.rows.length === 0) {
    return ctx.reply('No referral source bound. Please enter through a referral link.');
  }

  const p = player.rows[0];
  const statusText = { pending: 'Pending Review...⏳', approved: 'Approved ✅', rejected: 'Rejected ❌' };
  const st = statusText[p.game_id_status] || 'Not submitted';

  return ctx.reply(
    `🎮\n\n` +
    `Telegram：@${ctx.from.username || '-'}\n` +
    `Telegram ID：<code>${uid}</code>\n` +
    `Game ID：<code>${p.game_id || 'Not submitted'}</code>\n` +
    `Status：${st}\n\n` +
    `👤 Promoter：${p.promoter_name || '-'} (${p.promoter_code || '-'})`,
    { parse_mode: 'HTML' }
  );
}

module.exports = { handleSubmit, handlePlayerMy };
