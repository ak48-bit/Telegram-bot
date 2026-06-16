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
    `/add_agent A001 Name — Create Agent\n` +
    `/list_agents — View All Agents\n` +
    `/list_promoters — View All Promoters\n` +
    `/list_players — View All Players\n` +
    `/block_agent A001 — Block Agent\n` +
    `/block_promoter B001 — Block Promoter\n` +
    `/change_player_owner TGID B001 — Change Player Owner\n` +
    `/list_pending — Pending Game IDs\n` +
    `/approve_game TGID — Approve\n` +
    `/reject_game TGID — Reject\n` +
    `/list_agent_applications — Pending Agent Applications\n` +
    `/approve_agent Code — Approve Agent\n` +
    `/reject_agent Code — Reject Agent\n` +
    `/export_players — Export All Players`,
    { parse_mode: 'HTML' }
  );
}

// /add_agent A001 Leo
async function handleAddAgent(ctx) {
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    if (parts.length === 1) {
      const session = require('../services/session');
      session.set(ctx.from.id, { action: 'create_agent_code', data: {}, userRole: 'admin', cancelAudit: 'step_create_agent_cancelled' });
      await audit.log(ctx.from.id, 'admin', 'step_create_agent_started', null, null, {});
      return ctx.reply('Please enter Agent Code:');
    }
    return ctx.reply('Format: <code>/add_agent A001 Leo</code>', { parse_mode: 'HTML' });
  }
  const agentCode = parts[1];
  const name = parts.slice(2).join(' ');

  // 检查 code 唯一
  const exists = await db.query('SELECT 1 FROM agents WHERE agent_code = $1', [agentCode]);
  if (exists.rows.length > 0) {
    return ctx.reply(`❌ Agent Code <code>${agentCode}</code> already exists.`, { parse_mode: 'HTML' });
  }

  // 创建 agent 记录（先不绑定 telegram_id），approval_status = approved
  await db.query(
    `INSERT INTO agents (agent_code, name, created_by_admin_id, status, approval_status)
     VALUES ($1, $2, $3, 'pending', 'approved')`,
    [agentCode, name, ctx.from.id]
  );

  // 生成一次性绑定 token
  const token = await createInviteToken('agent_bind', agentCode, ctx.from.id);
  const link = `https://t.me/${BOT_USERNAME}?start=bind_agent_${token}`;

  await audit.log(ctx.from.id, 'admin', 'create_agent', 'agent', agentCode, { name, token });

  return ctx.reply(
    `👥 <b>Admin Create Agent</b>\n\n` +
    `<code>/add_agent ${agentCode} ${name}</code>\n\n` +
    `✅ Agent Created Successfully\n` +
    `Agent Code：<code>${agentCode}</code>\n` +
    `Name：${name}\n\n` +
    `📋 Agent Bot Link：\n` +
    `${link}\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `⚠️ No expiry, unlimited use\n\n` +
    `<i>After binding, Agent must use /set_promo to submit their Affiliate Link.</i>`,
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
  if (res.rows.length === 0) return ctx.reply('No agents yet.');

  const lines = ['<b>📋 All Agents</b>\n'];
  for (const r of res.rows) {
    const status = { active: '✅', blocked: '🚫', pending: '⏳' }[r.status] || '❓';
    const tg = r.telegram_id ? `<code>${r.telegram_id}</code>` : 'Not bound';
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
  if (res.rows.length === 0) return ctx.reply('No promoters yet.');

  const lines = ['<b>📋 All Promoters</b>\n'];
  for (const r of res.rows) {
    const status = { active: '✅', blocked: '🚫', pending: '⏳' }[r.status] || '❓';
    const tg = r.telegram_id ? `<code>${r.telegram_id}</code>` : 'Not bound';
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

  if (res.rows.length === 0) return ctx.reply('No players yet.');

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
  if (parts.length < 2) return ctx.reply('Format: <code>/block_agent A001</code>', { parse_mode: 'HTML' });
  const code = parts[1];
  const res = await db.query('UPDATE agents SET status = $1 WHERE agent_code = $2', ['blocked', code]);
  if (res.rowCount === 0) return ctx.reply(`❌ Agent <code>${code}</code> not found.`, { parse_mode: 'HTML' });

  // 同时更新 users 表
  const ag = await db.query('SELECT telegram_id FROM agents WHERE agent_code = $1', [code]);
  if (ag.rows[0]?.telegram_id) {
    await db.query("UPDATE users SET status = 'blocked' WHERE telegram_id = $1", [ag.rows[0].telegram_id]);
  }

  await audit.log(ctx.from.id, 'admin', 'block_agent', 'agent', code);
  return ctx.reply(`🚫 Agent <code>${code}</code> blocked.`, { parse_mode: 'HTML' });
}

// /block_promoter B001
async function handleBlockPromoter(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: <code>/block_promoter B001</code>', { parse_mode: 'HTML' });
  const code = parts[1];
  const res = await db.query('UPDATE promoters SET status = $1 WHERE promoter_code = $2', ['blocked', code]);
  if (res.rowCount === 0) return ctx.reply(`❌ Promoter <code>${code}</code> not found.`, { parse_mode: 'HTML' });

  const pm = await db.query('SELECT telegram_id FROM promoters WHERE promoter_code = $1', [code]);
  if (pm.rows[0]?.telegram_id) {
    await db.query("UPDATE users SET status = 'blocked' WHERE telegram_id = $1", [pm.rows[0].telegram_id]);
  }

  await audit.log(ctx.from.id, 'admin', 'block_promoter', 'promoter', code);
  return ctx.reply(`🚫 Promoter <code>${code}</code> blocked.`, { parse_mode: 'HTML' });
}

// /change_player_owner 123456789 B001
async function handleChangePlayerOwner(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply('Format: <code>/change_player_owner TGID B001</code>', { parse_mode: 'HTML' });
  }
  const tgId = parseInt(parts[1]);
  const promoterCode = parts[2];

  if (!tgId) return ctx.reply('❌ Invalid Telegram ID.');

  // 查找目标 Promoter
  const pm = await db.query('SELECT * FROM promoters WHERE promoter_code = $1', [promoterCode]);
  if (pm.rows.length === 0) return ctx.reply(`❌ Promoter <code>${promoterCode}</code> not found.`, { parse_mode: 'HTML' });

  const promoter = pm.rows[0];

  // 查找 Player
  const player = await db.query('SELECT * FROM players WHERE telegram_id = $1', [tgId]);
  if (player.rows.length === 0) return ctx.reply(`❌ 玩家 TG <code>${tgId}</code> not found.`, { parse_mode: 'HTML' });

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
    `✅ 玩家 <code>${tgId}</code> owner updated → Promoter <code>${promoterCode}</code>`,
    { parse_mode: 'HTML' }
  );
}

// /export_players
async function handleExportPlayers(ctx) {
  try {
    const csv = await exportAllPlayers();
    await exportWithSummary(ctx, csv, 'All Players Export');
    await audit.log(ctx.from.id, 'admin', 'export_players', 'players', 'all');
  } catch (e) {
    console.error('[Export]', e);
    return ctx.reply('Export failed: ' + e.message);
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
  if (parts.length < 2) return ctx.reply('Format: <code>/approve_game TGID</code>', { parse_mode: 'HTML' });
  const tgId = parseInt(parts[1]);
  if (!tgId) return ctx.reply('Invalid Telegram ID.');
  const res = await db.query(
    `UPDATE players SET game_id_status = 'approved', updated_at = NOW() WHERE telegram_id = $1 AND game_id IS NOT NULL`,
    [tgId]
  );
  if (res.rowCount === 0) return ctx.reply(`Player not found <code>${tgId}</code> 或Not submitted Game ID。`, { parse_mode: 'HTML' });
  await audit.log(ctx.from.id, 'admin', 'approve_game', 'player', String(tgId));
  return ctx.reply(`✅ Review Approved`, { parse_mode: 'HTML' });
}

// /reject_game 1259096820
async function handleRejectGame(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: <code>/reject_game TGID</code>', { parse_mode: 'HTML' });
  const tgId = parseInt(parts[1]);
  if (!tgId) return ctx.reply('Invalid Telegram ID.');
  const res = await db.query(
    `UPDATE players SET game_id_status = 'rejected', updated_at = NOW() WHERE telegram_id = $1 AND game_id IS NOT NULL`,
    [tgId]
  );
  if (res.rowCount === 0) return ctx.reply(`Player not found <code>${tgId}</code> 或Not submitted Game ID。`, { parse_mode: 'HTML' });
  await audit.log(ctx.from.id, 'admin', 'reject_game', 'player', String(tgId));
  return ctx.reply(`❌ Rejected`, { parse_mode: 'HTML' });
}

// /relink_agent AgentCode
async function handleRelinkAgent(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: <code>/relink_agent AgentCode</code>', { parse_mode: 'HTML' });
  const code = parts[1];
  const ag = await db.query('SELECT * FROM agents WHERE agent_code = $1', [code]);
  if (ag.rows.length === 0) return ctx.reply(`Agent <code>${code}</code> not found.`, { parse_mode: 'HTML' });
  await db.query(`UPDATE invite_tokens SET is_used = TRUE WHERE code = $1 AND type = 'agent_bind' AND is_used = FALSE`, [code]);
  const token = await createInviteToken('agent_bind', code, ctx.from.id);
  const link = `https://t.me/${BOT_USERNAME}?start=bind_agent_${token}`;
  await audit.log(ctx.from.id, 'admin', 'relink_agent', 'agent', code);
  return ctx.reply(`🔗 <b>Agent Binding Link (New)</b>\n\nCode：<code>${code}</code>\n\n<code>${link}</code>\n\n⚠️ Old link invalidated. No expiry, unlimited use.`, { parse_mode: 'HTML' });
}

// /reset_agent_link AgentCode
async function handleResetAgentLink(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: <code>/reset_agent_link AgentCode</code>', { parse_mode: 'HTML' });
  const code = parts[1];
  const ag = await db.query('SELECT * FROM agents WHERE agent_code = $1', [code]);
  if (ag.rows.length === 0) return ctx.reply(`Agent <code>${code}</code> not found.`, { parse_mode: 'HTML' });
  await db.query(`UPDATE agents SET agent_link_original = NULL, agent_link_normalized = NULL, link_status = 'NOT_SUBMITTED', updated_at = NOW() WHERE agent_code = $1`, [code]);
  await audit.log(ctx.from.id, 'admin', 'reset_agent_link', 'agent', code);
  return ctx.reply(`✅ Agent <code>${code}</code> link reset to NOT_SUBMITTED. Agent can now re-submit with /set_agent_link.`, { parse_mode: 'HTML' });
}

// /reset_player_link PromoterCode
async function handleResetPlayerLink(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: <code>/reset_player_link PromoterCode</code>', { parse_mode: 'HTML' });
  const code = parts[1];
  const pm = await db.query('SELECT * FROM promoters WHERE promoter_code = $1', [code]);
  if (pm.rows.length === 0) return ctx.reply(`Promoter <code>${code}</code> not found.`, { parse_mode: 'HTML' });
  await db.query(`UPDATE promoters SET player_affiliate_link_original = NULL, player_affiliate_link_normalized = NULL, link_status = 'NOT_SUBMITTED', updated_at = NOW() WHERE promoter_code = $1`, [code]);
  await audit.log(ctx.from.id, 'admin', 'reset_player_link', 'promoter', code);
  return ctx.reply(`✅ Promoter <code>${code}</code> link reset to NOT_SUBMITTED. Promoter can re-submit with /set_player_link.`, { parse_mode: 'HTML' });
}

// /list_agent_applications
async function handleListAgentApplications(ctx) {
  await audit.log(ctx.from.id, 'admin', 'list_agent_applications', null, null);
  const res = await db.query(
    `SELECT agent_code, name, telegram_id, username, created_at
     FROM agents WHERE approval_status = 'pending'
     ORDER BY created_at ASC`
  );
  if (res.rows.length === 0) {
    return ctx.reply('No pending Agent applications.');
  }

  const lines = ['👥 <b>Pending Agent Applications</b>\n'];
  for (let i = 0; i < res.rows.length; i++) {
    const r = res.rows[i];
    const un = r.username ? `@${r.username}` : '-';
    const tg = r.telegram_id ? `<code>${r.telegram_id}</code>` : '-';
    const appliedAt = r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16) : '-';
    lines.push(
      `${i + 1}. <b>Agent Code:</b> <code>${r.agent_code}</code>\n` +
      `   <b>Name:</b> ${r.name}\n` +
      `   <b>Telegram ID:</b> ${tg}\n` +
      `   <b>Username:</b> ${un}\n` +
      `   <b>Applied At:</b> ${appliedAt}\n`
    );
  }
  lines.push('\n<b>Approve:</b>\n<code>/approve_agent &lt;code&gt;</code>');
  lines.push('\n<b>Reject:</b>\n<code>/reject_agent &lt;code&gt;</code>');

  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// /approve_agent <agent_code>
async function handleApproveAgent(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('Format: <code>/approve_agent AgentCode</code>', { parse_mode: 'HTML' });
  }
  const code = parts[1];

  const ag = await db.query(
    `SELECT * FROM agents WHERE agent_code = $1`, [code]
  );
  if (ag.rows.length === 0) {
    return ctx.reply('Agent application not found.');
  }
  if (ag.rows[0].approval_status !== 'pending') {
    return ctx.reply('Agent application is not pending.');
  }

  const now = new Date();
  await db.query(
    `UPDATE agents SET approval_status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW() WHERE agent_code = $2`,
    [ctx.from.id, code]
  );

  await audit.log(ctx.from.id, 'admin', 'approve_agent_application', 'agent', code);

  // Notify the applicant with command buttons
  const applicantTgId = ag.rows[0].telegram_id;
  if (applicantTgId) {
    try {
      const { cmdButtons } = require('../services/cmdButtons');
      await ctx.telegram.sendMessage(applicantTgId,
        `✅ <b>Agent Approved.</b>\n\n` +
        `Agent Code: <code>${code}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: cmdButtons([
            ['/agent', '📊 Agent Panel'],
            ['/add_promoter', '➕ Add Promoter'],
            ['/set_agent_link', '🔗 Set Agent Link'],
            ['/my_agent_link', '📋 My Link'],
            ['/list_my_promoters', '👥 My Promoters'],
            ['/list_my_players', '🎮 My Players'],
          ])
        }
      );
    } catch (e) {
      console.error(`[Notify Applicant ${applicantTgId}] Failed:`, e.message);
    }
  }

  return ctx.reply(
    `✅ Agent approved successfully.\nAgent Code: <code>${code}</code>`,
    { parse_mode: 'HTML' }
  );
}

// /reject_agent <agent_code>
async function handleRejectAgent(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('Format: <code>/reject_agent AgentCode</code>', { parse_mode: 'HTML' });
  }
  const code = parts[1];

  const ag = await db.query(
    `SELECT * FROM agents WHERE agent_code = $1`, [code]
  );
  if (ag.rows.length === 0) {
    return ctx.reply('Agent application not found.');
  }
  if (ag.rows[0].approval_status !== 'pending') {
    return ctx.reply('Agent application is not pending.');
  }

  await db.query(
    `UPDATE agents SET approval_status = 'rejected', rejected_by = $1, rejected_at = NOW(), updated_at = NOW() WHERE agent_code = $2`,
    [ctx.from.id, code]
  );

  await audit.log(ctx.from.id, 'admin', 'reject_agent_application', 'agent', code);

  // Notify the applicant
  const applicantTgId = ag.rows[0].telegram_id;
  if (applicantTgId) {
    try {
      await ctx.telegram.sendMessage(applicantTgId,
        `❌ <b>Agent Application Rejected.</b>\n\nPlease contact Admin.`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error(`[Notify Applicant ${applicantTgId}] Failed:`, e.message);
    }
  }

  return ctx.reply(
    `✅ Agent application rejected.\nAgent Code: <code>${code}</code>`,
    { parse_mode: 'HTML' }
  );
}

// Callback version: admin clicks inline Approve button
async function handleApproveAgentCb(ctx, code) {
  const uid = ctx.callbackQuery.from.id;
  const ag = await db.query('SELECT * FROM agents WHERE agent_code = $1', [code]);
  if (ag.rows.length === 0) {
    return ctx.editMessageText('Agent application not found.').catch(() => {});
  }
  if (ag.rows[0].approval_status !== 'pending') {
    return ctx.editMessageText('Agent application is not pending.').catch(() => {});
  }
  await db.query(
    `UPDATE agents SET approval_status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW() WHERE agent_code = $2`,
    [uid, code]
  );
  await audit.log(uid, 'admin', 'approve_agent_application', 'agent', code);
  // Notify applicant with command buttons
  if (ag.rows[0].telegram_id) {
    try {
      const { cmdButtons } = require('../services/cmdButtons');
      await ctx.telegram.sendMessage(ag.rows[0].telegram_id,
        `✅ <b>Agent Approved.</b>\n\nAgent Code: <code>${code}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: cmdButtons([
            ['/agent', '📊 Agent Panel'],
            ['/add_promoter', '➕ Add Promoter'],
            ['/set_agent_link', '🔗 Set Agent Link'],
            ['/my_agent_link', '📋 My Link'],
            ['/list_my_promoters', '👥 My Promoters'],
            ['/list_my_players', '🎮 My Players'],
          ])
        }
      );
    } catch (e) {
      console.error(`[Notify ${ag.rows[0].telegram_id}] Failed:`, e.message);
    }
  }
  // Edit original notification
  return ctx.editMessageText(
    `✅ <b>Approved</b>\n\nAgent Code: <code>${code}</code>\nName: ${ag.rows[0].name}\nApproved by: Admin`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
}

// Callback version: admin clicks inline Reject button
async function handleRejectAgentCb(ctx, code) {
  const uid = ctx.callbackQuery.from.id;
  const ag = await db.query('SELECT * FROM agents WHERE agent_code = $1', [code]);
  if (ag.rows.length === 0) {
    return ctx.editMessageText('Agent application not found.').catch(() => {});
  }
  if (ag.rows[0].approval_status !== 'pending') {
    return ctx.editMessageText('Agent application is not pending.').catch(() => {});
  }
  await db.query(
    `UPDATE agents SET approval_status = 'rejected', rejected_by = $1, rejected_at = NOW(), updated_at = NOW() WHERE agent_code = $2`,
    [uid, code]
  );
  await audit.log(uid, 'admin', 'reject_agent_application', 'agent', code);
  // Notify applicant
  if (ag.rows[0].telegram_id) {
    try {
      await ctx.telegram.sendMessage(ag.rows[0].telegram_id,
        `❌ <b>Agent Application Rejected.</b>\n\nPlease contact Admin.`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error(`[Notify ${ag.rows[0].telegram_id}] Failed:`, e.message);
    }
  }
  // Edit original notification
  return ctx.editMessageText(
    `❌ <b>Rejected</b>\n\nAgent Code: <code>${code}</code>\nName: ${ag.rows[0].name}\nRejected by: Admin`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
}

module.exports = {
  handleAdmin, handleAddAgent, handleListAgents, handleListPromoters,
  handleListPlayers, handleBlockAgent, handleBlockPromoter,
  handleChangePlayerOwner, handleExportPlayers,
  handleListPending, handleApproveGame, handleRejectGame,
  handleRelinkAgent, handleResetAgentLink, handleResetPlayerLink,
  handleListAgentApplications, handleApproveAgent, handleRejectAgent,
  handleApproveAgentCb, handleRejectAgentCb,
};
