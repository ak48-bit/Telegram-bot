const db = require('../db');
const { createInviteToken } = require('../services/token');
const audit = require('../services/audit');
const { exportAllPlayers, sendCSV, exportWithSummary } = require('../services/export');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';

async function handleAdmin(ctx) {
  const stats = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM agents) AS agents,
      (SELECT COUNT(*) FROM agents WHERE status = 'active') AS active_agents,
      (SELECT COUNT(*) FROM agents WHERE status = 'blocked') AS blocked_agents,
      (SELECT COUNT(*) FROM promoters) AS promoters,
      (SELECT COUNT(*) FROM promoters WHERE status = 'active') AS active_promoters,
      (SELECT COUNT(*) FROM promoters WHERE status = 'blocked') AS blocked_promoters,
      (SELECT COUNT(*) FROM players) AS players,
      (SELECT COUNT(*) FROM players WHERE created_at::date = CURRENT_DATE) AS today_players,
      (SELECT COUNT(*) FROM players WHERE game_id IS NOT NULL AND game_id_status = 'pending') AS pending_games
  `);
  const s = stats.rows[0];
  return ctx.reply(
    `📊 <b>Admin Dashboard</b>\n\n` +
    `👥 <b>Agents:</b> ${s.active_agents} active / ${s.blocked_agents} blocked / ${s.agents} total\n` +
    `👤 <b>Promoters:</b> ${s.active_promoters} active / ${s.blocked_promoters} blocked / ${s.promoters} total\n` +
    `🎮 <b>Players:</b> ${s.players} total | 🆕 Today: ${s.today_players}\n` +
    `⏳ <b>Pending Approvals:</b> ${s.pending_games || 0}\n\n` +
    `<b>Commands:</b>\n` +
    `/add_agent A001 Name — 创建 Agent\n` +
    `/list_agents — 查看所有 Agent\n` +
    `/list_promoters — 查看所有 Promoter\n` +
    `/list_players — 查看所有 Player\n` +
    `/block_agent A001 — 封禁 Agent\n` +
    `/block_promoter B001 — 封禁 Promoter\n` +
    `/change_player_owner TGID B001 — 修改玩家归属\n` +
    `/list_pending — 待审核 Game ID\n` +
    `/approve_game TGID — 通过审核\n` +
    `/reject_game TGID — 拒绝审核\n` +
    `/export_players — 导出全部玩家`,
    { parse_mode: 'HTML' }
  );
}

// /add_agent A001 Leo
async function handleAddAgent(ctx) {
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply('格式：<code>/add_agent A001 Leo</code>', { parse_mode: 'HTML' });
  }
  const agentCode = parts[1];
  const name = parts.slice(2).join(' ');

  // 检查 code 唯一
  const exists = await db.query('SELECT 1 FROM agents WHERE agent_code = $1', [agentCode]);
  if (exists.rows.length > 0) {
    return ctx.reply(`❌ Agent Code <code>${agentCode}</code> 已存在。`, { parse_mode: 'HTML' });
  }

  // 创建 agent 记录（先不绑定 telegram_id）
  await db.query(
    `INSERT INTO agents (agent_code, name, created_by_admin_id, status)
     VALUES ($1, $2, $3, 'pending')`,
    [agentCode, name, ctx.from.id]
  );

  // 生成一次性绑定 token
  const token = await createInviteToken('agent_bind', agentCode, ctx.from.id);
  const link = `https://t.me/${BOT_USERNAME}?start=bind_agent_${token}`;

  // 自动生成 Agent Affiliate Link
  const domain = (process.env.ALLOWED_DOMAINS || '90jilia2.com').split(',')[0].trim();
  const agentPromo = `http://${domain}/?r=${agentCode}`;
  await db.query(`UPDATE agents SET promo_url = $1 WHERE agent_code = $2`, [agentPromo, agentCode]);

  await audit.log(ctx.from.id, 'admin', 'create_agent', 'agent', agentCode, { name, token });

  return ctx.reply(
    `👥 <b>Admin Create Agent</b>\n\n` +
    `<code>/add_agent ${agentCode} ${name}</code>\n\n` +
    `✅ Agent Created Successfully\n` +
    `Agent Code：<code>${agentCode}</code>\n` +
    `Name：${name}\n\n` +
    `Agent Affiliate Link：\n` +
    `${agentPromo}\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `📋 Agent Bot Link：\n` +
    `${link}\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `⚠️ One-time use only, valid for 48 hours`,
    { parse_mode: 'HTML' }
  );
}

// /list_agents
async function handleListAgents(ctx) {
  const res = await db.query(
    `SELECT a.*, u.username, u.first_name
     FROM agents a LEFT JOIN users u ON a.telegram_id = u.telegram_id
     ORDER BY a.created_at DESC`
  );
  if (res.rows.length === 0) return ctx.reply('暂无 Agent。');

  const lines = ['<b>📋 All Agents</b>\n'];
  for (const r of res.rows) {
    const status = { active: '✅', blocked: '🚫', pending: '⏳' }[r.status] || '❓';
    const tg = r.telegram_id ? `<code>${r.telegram_id}</code>` : '未绑定';
    lines.push(`${status} <code>${r.agent_code}</code> — ${r.name} | TG: ${tg}`);
  }
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// /list_promoters
async function handleListPromoters(ctx) {
  const res = await db.query(
    `SELECT pm.*, a.agent_code, u.username, u.first_name
     FROM promoters pm
     LEFT JOIN agents a ON pm.agent_id = a.id
     LEFT JOIN users u ON pm.telegram_id = u.telegram_id
     ORDER BY pm.created_at DESC LIMIT 50`
  );
  if (res.rows.length === 0) return ctx.reply('暂无 Promoter。');

  const lines = ['<b>📋 All Promoters</b>\n'];
  for (const r of res.rows) {
    const status = { active: '✅', blocked: '🚫', pending: '⏳' }[r.status] || '❓';
    const tg = r.telegram_id ? `<code>${r.telegram_id}</code>` : '未绑定';
    lines.push(`${status} <code>${r.promoter_code}</code> — ${r.name} | Agent: ${r.agent_code} | TG: ${tg}`);
  }
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// /list_players [page]
async function handleListPlayers(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  let page = 1;
  if (parts.length >= 2) page = parseInt(parts[1]) || 1;
  const limit = 30;
  const offset = (page - 1) * limit;

  const count = await db.query('SELECT COUNT(*) FROM players');
  const total = parseInt(count.rows[0].count);
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const res = await db.query(
    `SELECT p.*, pm.promoter_code, pm.name AS promoter_name, a.agent_code, a.name AS agent_name, u.username
     FROM players p
     LEFT JOIN promoters pm ON p.promoter_id = pm.id
     LEFT JOIN agents a ON p.agent_id = a.id
     LEFT JOIN users u ON p.telegram_id = u.telegram_id
     ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  if (res.rows.length === 0) return ctx.reply('暂无 Player。');

  const lines = [`<b>📋 All Players</b> — Page ${page}/${totalPages} (Total: ${total})\n`];
  for (const r of res.rows) {
    const tg = r.telegram_id ? `<code>${r.telegram_id}</code>` : '-';
    const un = r.username ? `@${r.username}` : '-';
    lines.push(`${un} | TG: ${tg} | PM: ${r.promoter_code || '-'} | Agent: ${r.agent_code || '-'} | GameID: ${r.game_id || '-'}`);
  }
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// /block_agent A001
async function handleBlockAgent(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('格式：<code>/block_agent A001</code>', { parse_mode: 'HTML' });
  const code = parts[1];
  const res = await db.query('UPDATE agents SET status = $1 WHERE agent_code = $2', ['blocked', code]);
  if (res.rowCount === 0) return ctx.reply(`❌ Agent <code>${code}</code> 未找到。`, { parse_mode: 'HTML' });

  // 同时更新 users 表
  const ag = await db.query('SELECT telegram_id FROM agents WHERE agent_code = $1', [code]);
  if (ag.rows[0]?.telegram_id) {
    await db.query("UPDATE users SET status = 'blocked' WHERE telegram_id = $1", [ag.rows[0].telegram_id]);
  }

  await audit.log(ctx.from.id, 'admin', 'block_agent', 'agent', code);
  return ctx.reply(`🚫 Agent <code>${code}</code> 已封禁。`, { parse_mode: 'HTML' });
}

// /block_promoter B001
async function handleBlockPromoter(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('格式：<code>/block_promoter B001</code>', { parse_mode: 'HTML' });
  const code = parts[1];
  const res = await db.query('UPDATE promoters SET status = $1 WHERE promoter_code = $2', ['blocked', code]);
  if (res.rowCount === 0) return ctx.reply(`❌ Promoter <code>${code}</code> 未找到。`, { parse_mode: 'HTML' });

  const pm = await db.query('SELECT telegram_id FROM promoters WHERE promoter_code = $1', [code]);
  if (pm.rows[0]?.telegram_id) {
    await db.query("UPDATE users SET status = 'blocked' WHERE telegram_id = $1", [pm.rows[0].telegram_id]);
  }

  await audit.log(ctx.from.id, 'admin', 'block_promoter', 'promoter', code);
  return ctx.reply(`🚫 Promoter <code>${code}</code> 已封禁。`, { parse_mode: 'HTML' });
}

// /change_player_owner 123456789 B001
async function handleChangePlayerOwner(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply('格式：<code>/change_player_owner TGID B001</code>', { parse_mode: 'HTML' });
  }
  const tgId = parseInt(parts[1]);
  const promoterCode = parts[2];

  if (!tgId) return ctx.reply('❌ 无效的 Telegram ID。');

  // 查找目标 Promoter
  const pm = await db.query('SELECT * FROM promoters WHERE promoter_code = $1', [promoterCode]);
  if (pm.rows.length === 0) return ctx.reply(`❌ Promoter <code>${promoterCode}</code> 未找到。`, { parse_mode: 'HTML' });

  const promoter = pm.rows[0];

  // 查找 Player
  const player = await db.query('SELECT * FROM players WHERE telegram_id = $1', [tgId]);
  if (player.rows.length === 0) return ctx.reply(`❌ 玩家 TG <code>${tgId}</code> 未找到。`, { parse_mode: 'HTML' });

  const oldPromoter = player.rows[0].promoter_id;
  const oldAgent = player.rows[0].agent_id;

  // 更新归属
  await db.query(
    `UPDATE players SET promoter_id = $1, agent_id = $2, updated_at = NOW() WHERE telegram_id = $3`,
    [promoter.id, promoter.agent_id, tgId]
  );

  await audit.log(ctx.from.id, 'admin', 'change_player_owner', 'player', String(tgId), {
    old_promoter_id: oldPromoter,
    old_agent_id: oldAgent,
    new_promoter_id: promoter.id,
    new_agent_id: promoter.agent_id,
  });

  return ctx.reply(
    `✅ 玩家 <code>${tgId}</code> 归属已更新 → Promoter <code>${promoterCode}</code>`,
    { parse_mode: 'HTML' }
  );
}

// /export_players
async function handleExportPlayers(ctx) {
  try {
    const csv = await exportAllPlayers();
    await exportWithSummary(ctx, csv, '全部玩家数据导出');
    await audit.log(ctx.from.id, 'admin', 'export_players', 'players', 'all');
  } catch (e) {
    console.error('[Export]', e);
    return ctx.reply('导出失败：' + e.message);
  }
}

// /list_pending — 查看待审核的 Game ID
async function handleListPending(ctx) {
  const res = await db.query(
    `SELECT p.telegram_id, u.username, p.game_id, pm.promoter_code, pm.name AS promoter_name,
            a.agent_code, p.created_at
     FROM players p
     LEFT JOIN promoters pm ON p.promoter_id = pm.id
     LEFT JOIN agents a ON p.agent_id = a.id
     LEFT JOIN users u ON p.telegram_id = u.telegram_id
     WHERE p.game_id IS NOT NULL AND p.game_id_status = 'pending'
     ORDER BY p.created_at DESC LIMIT 30`
  );
  if (res.rows.length === 0) return ctx.reply('✅ No pending Game IDs.');
  const lines = ['<b>⏳ Pending Review：</b>\n'];
  for (const r of res.rows) {
    lines.push(`Telegram：@${r.username || '-'}\nTelegram ID：<code>${r.telegram_id}</code>\nGame ID：<code>${r.game_id}</code>\n`);
  }
  lines.push(`<code>/approve_game TGID</code>\n✅ Review Approved\n\n<code>/reject_game TGID</code>\n❌ Rejected`);
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// /approve_game 1259096820
async function handleApproveGame(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('格式：<code>/approve_game TGID</code>', { parse_mode: 'HTML' });
  const tgId = parseInt(parts[1]);
  if (!tgId) return ctx.reply('无效的 Telegram ID。');
  const res = await db.query(
    `UPDATE players SET game_id_status = 'approved', updated_at = NOW() WHERE telegram_id = $1 AND game_id IS NOT NULL`,
    [tgId]
  );
  if (res.rowCount === 0) return ctx.reply(`未找到玩家 <code>${tgId}</code> 或未提交 Game ID。`, { parse_mode: 'HTML' });
  await audit.log(ctx.from.id, 'admin', 'approve_game', 'player', String(tgId));
  return ctx.reply(`✅ Review Approved`, { parse_mode: 'HTML' });
}

// /reject_game 1259096820
async function handleRejectGame(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('格式：<code>/reject_game TGID</code>', { parse_mode: 'HTML' });
  const tgId = parseInt(parts[1]);
  if (!tgId) return ctx.reply('无效的 Telegram ID。');
  const res = await db.query(
    `UPDATE players SET game_id_status = 'rejected', updated_at = NOW() WHERE telegram_id = $1 AND game_id IS NOT NULL`,
    [tgId]
  );
  if (res.rowCount === 0) return ctx.reply(`未找到玩家 <code>${tgId}</code> 或未提交 Game ID。`, { parse_mode: 'HTML' });
  await audit.log(ctx.from.id, 'admin', 'reject_game', 'player', String(tgId));
  return ctx.reply(`❌ Rejected`, { parse_mode: 'HTML' });
}

module.exports = {
  handleAdmin, handleAddAgent, handleListAgents, handleListPromoters,
  handleListPlayers, handleBlockAgent, handleBlockPromoter,
  handleChangePlayerOwner, handleExportPlayers,
  handleListPending, handleApproveGame, handleRejectGame,
};
