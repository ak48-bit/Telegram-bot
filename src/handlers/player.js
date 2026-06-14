const db = require('../db');
const audit = require('../services/audit');

// /submit PH90123456
async function handleSubmit(ctx) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('格式：<code>/submit PH90123456</code>', { parse_mode: 'HTML' });
  }
  const gameId = parts[1];

  // 检查玩家
  const player = await db.query('SELECT * FROM players WHERE telegram_id = $1', [uid]);
  if (player.rows.length === 0) {
    return ctx.reply('请先通过推广链接进入 Bot。');
  }

  // 更新 game_id
  await db.query(
    `UPDATE players SET game_id = $1, game_id_status = 'pending', updated_at = NOW() WHERE telegram_id = $2`,
    [gameId, uid]
  );

  await audit.log(uid, 'player', 'submit_game_id', 'player', String(uid), { game_id: gameId });

  return ctx.reply(
    `✅ <b>提交成功</b>\n\n` +
    `你的游戏 ID：<code>${gameId}</code>\n` +
    `状态：<b>等待审核</b>`,
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
    return ctx.reply('你还没有绑定推广来源。请通过推广链接进入 Bot。');
  }

  const p = player.rows[0];
  const statusText = { pending: 'Pending Review...⏳', approved: 'Approved ✅', rejected: 'Rejected ❌' };

  return ctx.reply(
    `🎮 <b>Player 面板</b>\n\n` +
    `Telegram：@${ctx.from.username || '-'}\n` +
    `Telegram ID：<code>${uid}</code>\n` +
    `Game ID：<code>${p.game_id || '未提交'}</code>\n` +
    `Status：${statusText[p.game_id_status] || 'Not submitted'}\n\n` +
    `👤 Promoter：${p.promoter_name || '-'} (${p.promoter_code || '-'})`,
    { parse_mode: 'HTML' }
  );
}

module.exports = { handleSubmit, handlePlayerMy };
