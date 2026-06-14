const db = require('../db');
const { createInviteToken } = require('../services/token');
const audit = require('../services/audit');
const { exportPlayersByAgent, sendCSV } = require('../services/export');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';

async function handleAgent(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query(
    `SELECT a.*, u.first_name FROM agents a JOIN users u ON a.telegram_id = u.telegram_id WHERE a.telegram_id = $1`,
    [uid]
  );
  if (ag.rows.length === 0) return ctx.reply('你还没有绑定 Agent 身份。');

  const a = ag.rows[0];
  const stats = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM promoters WHERE agent_id = $1) AS promoters,
       (SELECT COUNT(*) FROM promoters WHERE agent_id = $1 AND status = 'active') AS active_promoters,
       (SELECT COUNT(*) FROM players WHERE agent_id = $1) AS players,
       (SELECT COUNT(*) FROM players WHERE agent_id = $1 AND created_at::date = CURRENT_DATE) AS today_players
    `, [a.id]
  );
  const s = stats.rows[0];

  return ctx.reply(
    `🏢 <b>Agent Menu</b>\n\n` +
    `🏷️ Code：<code>${a.agent_code}</code>\n` +
    `👤 Name：${a.name}\n\n` +
    `📊 Promoters: ${s.active_promoters} active / ${s.promoters} total\n` +
    `🎮 Players: ${s.players} total | 🆕 Today: ${s.today_players}\n\n` +
    `<b>Commands:</b>\n` +
    `/add_promoter B001 Name — 创建 Promoter\n` +
    `/list_my_promoters — 查看下级 Promoter\n` +
    `/list_my_players — 查看线下玩家\n` +
    `/export_my_players — 导出玩家`,
    { parse_mode: 'HTML' }
  );
}

// /add_promoter B001 Tom
async function handleAddPromoter(ctx) {
  const uid = ctx.from.id;

  // 查找 Agent
  const ag = await db.query('SELECT * FROM agents WHERE telegram_id = $1 AND status = $2', [uid, 'active']);
  if (ag.rows.length === 0) return ctx.reply('你还没有绑定 Agent 身份或已被封禁。');

  const agent = ag.rows[0];
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply('格式：<code>/add_promoter B001 Tom</code>', { parse_mode: 'HTML' });
  }

  const promoterCode = parts[1];
  const name = parts.slice(2).join(' ');

  // 检查 promoter_code 唯一
  const exists = await db.query('SELECT 1 FROM promoters WHERE promoter_code = $1', [promoterCode]);
  if (exists.rows.length > 0) {
    return ctx.reply(`❌ Promoter Code <code>${promoterCode}</code> 已存在。`, { parse_mode: 'HTML' });
  }

  // 创建 promoter
  await db.query(
    `INSERT INTO promoters (promoter_code, agent_id, name, created_by_agent_id, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [promoterCode, agent.id, name, uid]
  );

  // 生成绑定 token
  const token = await createInviteToken('promoter_bind', promoterCode, uid);
  const link = `https://t.me/${BOT_USERNAME}?start=bind_promoter_${token}`;

  await audit.log(uid, 'agent', 'create_promoter', 'promoter', promoterCode, { name, token });

  return ctx.reply(
    `✅ <b>Promoter 创建成功</b>\n\n` +
    `🏷️ Code：<code>${promoterCode}</code>\n` +
    `👤 Name：${name}\n` +
    `🏢 Agent：${agent.agent_code}\n\n` +
    `<b>🔗 绑定链接（发给 Promoter）：</b>\n` +
    `<code>${link}</code>\n\n` +
    `⚠️ 此链接只能使用一次，有效期48小时。`,
    { parse_mode: 'HTML' }
  );
}

// /list_my_promoters
async function handleListMyPromoters(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query('SELECT id FROM agents WHERE telegram_id = $1', [uid]);
  if (ag.rows.length === 0) return ctx.reply('未绑定 Agent。');

  const res = await db.query(
    `SELECT pm.*, u.username, u.first_name
     FROM promoters pm LEFT JOIN users u ON pm.telegram_id = u.telegram_id
     WHERE pm.agent_id = $1 ORDER BY pm.created_at DESC`,
    [ag.rows[0].id]
  );
  if (res.rows.length === 0) return ctx.reply('暂无 Promoter。');

  const lines = ['<b>📋 My Promoters</b>\n'];
  for (const r of res.rows) {
    const status = { active: '✅', blocked: '🚫', pending: '⏳' }[r.status] || '❓';
    const tg = r.telegram_id ? `<code>${r.telegram_id}</code>` : '未绑定';
    const countRes = await db.query(
      'SELECT COUNT(*) FROM players WHERE promoter_id = $1', [r.id]
    );
    const pc = countRes.rows[0].count;
    lines.push(`${status} <code>${r.promoter_code}</code> — ${r.name} | Players: ${pc} | TG: ${tg}`);
  }
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// /list_my_players [page]
async function handleListMyPlayers(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query('SELECT id FROM agents WHERE telegram_id = $1', [uid]);
  if (ag.rows.length === 0) return ctx.reply('未绑定 Agent。');

  const parts = ctx.message.text.trim().split(/\s+/);
  let page = 1;
  if (parts.length >= 2) page = parseInt(parts[1]) || 1;
  const limit = 30;
  const offset = (page - 1) * limit;

  const count = await db.query('SELECT COUNT(*) FROM players WHERE agent_id = $1', [ag.rows[0].id]);
  const total = parseInt(count.rows[0].count);
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const res = await db.query(
    `SELECT p.*, pm.promoter_code, pm.name AS promoter_name, u.username
     FROM players p
     LEFT JOIN promoters pm ON p.promoter_id = pm.id
     LEFT JOIN users u ON p.telegram_id = u.telegram_id
     WHERE p.agent_id = $1
     ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
    [ag.rows[0].id, limit, offset]
  );

  if (res.rows.length === 0) return ctx.reply('暂无玩家。');

  const lines = [`<b>📋 My Players</b> — Page ${page}/${totalPages} (Total: ${total})\n`];
  for (const r of res.rows) {
    const un = r.username ? `@${r.username}` : '-';
    lines.push(`${un} | TG: <code>${r.telegram_id}</code> | PM: ${r.promoter_code || '-'} | GameID: ${r.game_id || '-'}`);
  }
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// /export_my_players
async function handleExportMyPlayers(ctx) {
  try {
    const csv = await exportPlayersByAgent(ctx.from.id);
    await sendCSV(ctx, csv, `players_agent_${Date.now()}.csv`);
    await audit.log(ctx.from.id, 'agent', 'export_players', 'players', 'my_line');
  } catch (e) {
    console.error('[Export Agent]', e);
    return ctx.reply('导出失败。');
  }
}

module.exports = {
  handleAgent, handleAddPromoter, handleListMyPromoters,
  handleListMyPlayers, handleExportMyPlayers,
};
