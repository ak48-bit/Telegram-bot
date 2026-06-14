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
            COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today
     FROM players WHERE promoter_id = $1`,
    [p.id]
  );
  const s = stats.rows[0];

  return ctx.reply(
    `📢 <b>Promoter Menu</b>\n\n` +
    `🏷️ Code：<code>${p.promoter_code}</code>\n` +
    `👤 Name：${p.name}\n` +
    `🏢 Agent：${p.agent_code} (${p.agent_name})\n\n` +
    `🎮 My Players: ${s.total} total | 🆕 Today: ${s.today}\n\n` +
    `<b>Commands:</b>\n` +
    `/my_link — 获取推广链接\n` +
    `/my_players — 查看我的玩家\n` +
    `/my_today — 今日数据`,
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

  const link = `https://t.me/${BOT_USERNAME}?start=p_${pm.rows[0].promoter_code}`;

  return ctx.reply(
    `📢 <b>你的推广链接</b>\n\n` +
    `<code>${link}</code>\n\n` +
    `点击上方链接复制，发送给玩家即可。\n` +
    `玩家通过此链接进入 Bot，自动归到你名下。`,
    { parse_mode: 'HTML' }
  );
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

module.exports = { handlePromoter, handleMyLink, handleMyPlayers, handleMyToday };
