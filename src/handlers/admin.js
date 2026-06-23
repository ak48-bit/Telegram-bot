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
      (SELECT COUNT(*) FROM agents WHERE approval_status = 'pending') AS pending_agents,
      (SELECT COUNT(*) FROM promoters) AS promoters,
      (SELECT COUNT(*) FROM promoters WHERE status = 'active') AS active_promoters,
      (SELECT COUNT(*) FROM promoters WHERE status = 'blocked') AS blocked_promoters,
      (SELECT COUNT(*) FROM players) AS players,
      (SELECT COUNT(*) FROM players WHERE created_at::date = CURRENT_DATE) AS today_players,
      (SELECT COUNT(*) FROM players WHERE game_id IS NOT NULL) AS submitted_games
  `);
  const s = stats.rows[0];
  return ctx.reply(
    `📊 <b>Admin Dashboard</b>\n\n` +
    `👥 Agents: ${s.active_agents} active / ${s.blocked_agents} blocked / ${s.agents} total\n` +
    `👤 Promoters: ${s.active_promoters} active / ${s.blocked_promoters} blocked / ${s.promoters} total\n` +
    `🎮 Players: ${s.players} total | 🆕 Today: ${s.today_players}\n` +
    `⏳ Pending Agent Apps: ${s.pending_agents || 0} | 🎮 Submitted Game IDs: ${s.submitted_games || 0}\n\n` +
    `<b>Quick Actions:</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '🕓 Pending Agent Apps', callback_data: 'admin_panel_list_agent_apps' }],
        [{ text: '👥 Agent List', callback_data: 'cmd:/list_agents' }, { text: '👤 Promoter List', callback_data: 'cmd:/list_promoters' }],
        [{ text: '🎮 Player List', callback_data: 'cmd:/list_players' }, { text: '🎮 Submitted Game IDs', callback_data: 'cmd:/list_pending' }],
        [{ text: '⚙️ System Status', callback_data: 'cmd:/system_status' }, { text: '🧾 Audit Log', callback_data: 'cmd:/audit_recent' }],
        [{ text: '🔍 Query Help', callback_data: 'admin_panel_find_help' }],
        [{ text: '📤 Export Players', callback_data: 'admin_panel_export_confirm' }],
      ]}
    }
  );
}

// Admin panel button handler
async function handleAdminPanelButtons(ctx, data) {
  switch (data) {
    case 'admin_panel_list_agent_apps':
      return handleListAgentApplications(ctx);
    case 'admin_panel_find_help':
      return ctx.editMessageText(
        '🔍 <b>Query Commands</b>\n\n' +
        '<code>/find_player &lt;TGID or Game ID&gt;</code>\n' +
        '<code>/find_promoter &lt;Promoter Code&gt;</code>\n' +
        '<code>/find_agent &lt;Agent Code&gt;</code>\n\n' +
        '<b>Export:</b>\n' +
        '<code>/export_players</code> — Export all players\n\n' +
        '<i>Please type the command manually.</i>',
        { parse_mode: 'HTML' }
      ).catch(() => {});
    case 'admin_panel_export_confirm':
      return ctx.editMessageText(
        '📤 <b>Confirm Export</b>\n\n' +
        'Export all player data to CSV?\n' +
        'This action will be logged.',
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '✅ Confirm Export', callback_data: 'admin_export_players_confirm' },
            { text: '❌ Cancel', callback_data: 'admin_panel_cancel' }
          ]] }
        }
      ).catch(() => {});
    case 'admin_panel_cancel':
      return ctx.editMessageText('Cancelled.').catch(() => {});
    default:
      return ctx.answerCbQuery('Unknown action').catch(() => {});
  }
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

  // Validate Agent Code format
  if (!config.AGENT_CODE_REGEX.test(agentCode)) {
    return ctx.reply('Invalid Agent Code format.\nAllowed: 3-20 characters, letters, numbers, underscore, hyphen only.\nExample: /add_agent TestA01 TestAgent', { parse_mode: 'HTML' });
  }
  const reservedLower = config.RESERVED_AGENT_CODES.map(c => c.toLowerCase());
  if (reservedLower.includes(agentCode.toLowerCase())) {
    return ctx.reply('Invalid Agent Code format.\nThis code is reserved. Please choose a different one.', { parse_mode: 'HTML' });
  }
  // Validate Agent Name format
  if (!name || name.length < 2 || name.length > 30) {
    return ctx.reply('Invalid Agent Name format.\n2-30 characters required.\nExample: /add_agent TestA01 TestAgent', { parse_mode: 'HTML' });
  }

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
  const botLink = `https://t.me/${BOT_USERNAME}?start=bind_agent_${token}`;
  const manualCmd = `/start bind_agent_${token}`;

  await audit.log(ctx.from.id, 'admin', 'create_agent', 'agent', agentCode, { name });

  // Card 1: Admin confirmation
  await ctx.reply(
    `👥 <b>Admin Create Agent</b>\n\n` +
    `✅ Agent Created Successfully\n\n` +
    `Agent Code：<code>${agentCode}</code>\n` +
    `Name：${name}\n` +
    `Status：<b>Waiting for Agent binding</b>\n\n` +
    `<b>Admin Next Step：</b>\n` +
    `Forward the Agent Binding Card below to the Agent.`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '👥 Agent List', callback_data: 'cmd:/list_agents' }],
        [{ text: '📊 Admin Panel', callback_data: 'cmd:/admin' }],
      ]}
    }
  );

  // Card 2: Agent binding card (forwardable)
  return ctx.reply(
    `🔗 <b>Agent Binding Card</b>\n\n` +
    `Agent Code：<code>${agentCode}</code>\n` +
    `Name：${name}\n\n` +
    `Please bind your Telegram account to this Agent profile.\n\n` +
    `<b>Binding Method：</b>\n\n` +
    `<b>🆕 New Telegram user：</b>\n` +
    `Click the <b>Bind Agent</b> button below.\n\n` +
    `<b>📋 If you have opened this Bot before：</b>\n` +
    `Copy and send the Manual command below to the Bot.\n\n` +
    `<b>Manual command：</b>\n<code>${manualCmd}</code>\n\n` +
    `Bot Binding Link：\n${botLink}\n\n` +
    `⚠️ One-time identity binding link. Valid 72h.\n` +
    `Do not share in groups. Invalid after use.`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[
        { text: '🔗 Bind Agent', url: botLink }
      ]] }
    }
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

// /list_pending — deprecated: Game ID review is disabled
async function handleListPending(ctx) {
  // Show submitted Game IDs for record only (no review needed)
  const res = await db.query(
    `SELECT p.telegram_id, u.username, p.game_id, pm.promoter_code, pm.name AS promoter_name,
            a.agent_code, p.game_id_status, p.created_at
     FROM players p
     LEFT JOIN promoters pm ON p.promoter_id = pm.id
     LEFT JOIN agents a ON p.agent_id = a.id
     LEFT JOIN users u ON p.telegram_id = u.telegram_id
     WHERE p.game_id IS NOT NULL
     ORDER BY p.created_at DESC LIMIT 30`
  );
  if (res.rows.length === 0) return ctx.reply('No Game IDs submitted yet.');
  const lines = ['🎮 <b>Submitted Game IDs (record only)</b>\n'];
  for (const r of res.rows) {
    lines.push(`TG: <code>${r.telegram_id}</code> | Game ID: <code>${r.game_id}</code> | ${r.game_id_status}`);
  }
  lines.push('\n<i>Game ID review is disabled. Submitted Game IDs are for record only.</i>');
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// /approve_game — deprecated: Game ID review is disabled
async function handleApproveGame(ctx) {
  return ctx.reply('Game ID review is disabled.\nSubmitted Game IDs are for record only.\nUse /list_players or /export_players to view submitted Game IDs.', { parse_mode: 'HTML' });
}

// /reject_game — deprecated: Game ID review is disabled
async function handleRejectGame(ctx) {
  return ctx.reply('Game ID review is disabled.\nSubmitted Game IDs are for record only.\nUse /list_players or /export_players to view submitted Game IDs.', { parse_mode: 'HTML' });
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
  const botLink = `https://t.me/${BOT_USERNAME}?start=bind_agent_${token}`;
  const manualCmd = `/start bind_agent_${token}`;
  await audit.log(ctx.from.id, 'admin', 'relink_agent', 'agent', code);
  return ctx.reply(
    `🔗 <b>Agent Binding Link (New)</b>\n\n` +
    `Code：<code>${code}</code>\n\n` +
    `<b>📋 Send this to Agent：</b>\n\n` +
    `<code>${manualCmd}</code>\n\n` +
    `⚠️ Old link invalidated.\n` +
    `⚠️ One-time identity binding link. Valid 72h.\n` +
    `Do not share in groups. Invalid after use.\n\n` +
    `<i>If the button below is not clickable, copy the command above and send it to the Agent.</i>`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[
        { text: '🔗 Bind Agent', url: botLink }
      ]] }
    }
  );
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
  return ctx.reply(`✅ Promoter <code>${code}</code> link reset to NOT_SUBMITTED. Agent should use /update_promoter_link to set a new link.`, { parse_mode: 'HTML' });
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

// /block_player <tgid>
async function handleBlockPlayer(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: /block_player TGID');
  const tgId = parseInt(parts[1]);
  if (!tgId) return ctx.reply('Invalid TG ID.');
  await db.query("UPDATE users SET status = 'blocked' WHERE telegram_id = $1", [tgId]);
  await audit.log(ctx.from.id, 'admin', 'block_player', 'player', String(tgId));
  return ctx.reply(`🚫 Player ${tgId} blocked.`);
}

// /unblock_agent <code>
async function handleUnblockAgent(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: /unblock_agent CODE');
  const code = parts[1];
  const ag = await db.query('SELECT telegram_id FROM agents WHERE agent_code = $1', [code]);
  if (ag.rows.length === 0) return ctx.reply('Agent not found.');
  await db.query("UPDATE agents SET status = 'active' WHERE agent_code = $1", [code]);
  if (ag.rows[0].telegram_id) {
    await db.query("UPDATE users SET status = 'active' WHERE telegram_id = $1", [ag.rows[0].telegram_id]);
  }
  await audit.log(ctx.from.id, 'admin', 'unblock_agent', 'agent', code);
  return ctx.reply(`✅ Agent ${code} unblocked.`);
}

// /unblock_promoter <code>
async function handleUnblockPromoter(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: /unblock_promoter CODE');
  const code = parts[1];
  const pm = await db.query('SELECT telegram_id FROM promoters WHERE promoter_code = $1', [code]);
  if (pm.rows.length === 0) return ctx.reply('Promoter not found.');
  await db.query("UPDATE promoters SET status = 'active' WHERE promoter_code = $1", [code]);
  if (pm.rows[0].telegram_id) {
    await db.query("UPDATE users SET status = 'active' WHERE telegram_id = $1", [pm.rows[0].telegram_id]);
  }
  await audit.log(ctx.from.id, 'admin', 'unblock_promoter', 'promoter', code);
  return ctx.reply(`✅ Promoter ${code} unblocked.`);
}

// /unblock_player <tgid>
async function handleUnblockPlayer(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: /unblock_player TGID');
  const tgId = parseInt(parts[1]);
  if (!tgId) return ctx.reply('Invalid TG ID.');
  await db.query("UPDATE users SET status = 'active' WHERE telegram_id = $1", [tgId]);
  await audit.log(ctx.from.id, 'admin', 'unblock_player', 'player', String(tgId));
  return ctx.reply(`✅ Player ${tgId} unblocked.`);
}

// /system_status
async function handleSystemStatus(ctx) {
  const startupTime = require('../index').startupTime || 'unknown';
  let dbStatus = 'connected';
  try { await db.query('SELECT 1'); } catch (e) { dbStatus = 'error: ' + e.message; }
  const stats = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM agents) AS agents,
      (SELECT COUNT(*) FROM agents WHERE approval_status = 'pending') AS pending_agents,
      (SELECT COUNT(*) FROM promoters) AS promoters,
      (SELECT COUNT(*) FROM players) AS players,
      (SELECT COUNT(*) FROM players WHERE game_id IS NOT NULL) AS submitted_games
  `);
  const s = stats.rows[0];
  return ctx.reply(
    `⚙️ <b>System Status</b>\n\n` +
    `🟢 Bot: Running\n` +
    `🗄️ DB: ${dbStatus}\n` +
    `🕐 Time: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}\n` +
    `🚀 Started: ${startupTime.replace('T', ' ').slice(0, 19)}\n\n` +
    `👥 Agents: ${s.agents} (${s.pending_agents} pending)\n` +
    `👤 Promoters: ${s.promoters}\n` +
    `🎮 Players: ${s.players} (${s.submitted_games} submitted Game IDs)`,
    { parse_mode: 'HTML' }
  );
}

// /audit_recent
async function handleAuditRecent(ctx) {
  await audit.log(ctx.from.id, 'admin', 'audit_recent', null, null);
  const logs = await db.query(
    `SELECT created_at, actor_telegram_id, actor_role, action, target_type, target_id
     FROM audit_logs ORDER BY created_at DESC LIMIT 20`
  );
  if (logs.rows.length === 0) return ctx.reply('No audit logs.');
  const lines = ['<b>🧾 Recent Audit Logs</b>\n'];
  for (const r of logs.rows) {
    const ts = r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19) : '-';
    lines.push(`<i>${ts}</i> | <code>${r.actor_telegram_id}</code> | ${r.actor_role} | ${r.action} | ${r.target_type || '-'}:${r.target_id || '-'}`);
  }
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// /find_player <tgid_or_gameid>
async function handleFindPlayer(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: /find_player TGID_or_GameID');
  const query1 = parts[1];
  const isNum = /^\d+$/.test(query1);
  let player;
  if (isNum) {
    player = await db.query(
      `SELECT p.*, pm.promoter_code, pm.name AS promoter_name, a.agent_code, a.name AS agent_name, u.username
       FROM players p LEFT JOIN promoters pm ON p.promoter_id = pm.id LEFT JOIN agents a ON p.agent_id = a.id LEFT JOIN users u ON p.telegram_id = u.telegram_id
       WHERE p.telegram_id = $1`, [parseInt(query1)]
    );
  }
  if (!player || player.rows.length === 0) {
    player = await db.query(
      `SELECT p.*, pm.promoter_code, pm.name AS promoter_name, a.agent_code, a.name AS agent_name, u.username
       FROM players p LEFT JOIN promoters pm ON p.promoter_id = pm.id LEFT JOIN agents a ON p.agent_id = a.id LEFT JOIN users u ON p.telegram_id = u.telegram_id
       WHERE UPPER(p.game_id) = $1`, [query1.toUpperCase()]
    );
  }
  if (player.rows.length === 0) return ctx.reply('Player not found.');
  const p = player.rows[0];
  return ctx.reply(
    `🔍 <b>Player Found</b>\n\n` +
    `TG ID: <code>${p.telegram_id}</code>\n` +
    `Username: @${p.username || '-'}\n` +
    `Game ID: <code>${p.game_id || '-'}</code>\n` +
    `Status: ${p.game_id_status || '-'}\n` +
    `Promoter: ${p.promoter_code || '-'} (${p.promoter_name || '-'})\n` +
    `Agent: ${p.agent_code || '-'} (${p.agent_name || '-'})\n` +
    `Created: ${p.created_at ? new Date(p.created_at).toISOString().slice(0, 10) : '-'}`,
    { parse_mode: 'HTML' }
  );
}

// /find_promoter <code>
async function handleFindPromoter(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: /find_promoter CODE');
  const code = parts[1];
  const pm = await db.query(
    `SELECT pm.*, a.agent_code, a.name AS agent_name,
            (SELECT COUNT(*) FROM players WHERE promoter_id = pm.id) AS player_count,
            (SELECT COUNT(*) FROM players WHERE promoter_id = pm.id AND created_at::date = CURRENT_DATE) AS today_count
     FROM promoters pm LEFT JOIN agents a ON pm.agent_id = a.id WHERE pm.promoter_code = $1`, [code]
  );
  if (pm.rows.length === 0) return ctx.reply('Promoter not found.');
  const p = pm.rows[0];
  return ctx.reply(
    `🔍 <b>Promoter Found</b>\n\n` +
    `Code: <code>${p.promoter_code}</code>\n` +
    `Name: ${p.name}\n` +
    `Status: ${p.status} | Link: ${p.link_status || 'NOT_SUBMITTED'}\n` +
    `Agent: ${p.agent_code || '-'} (${p.agent_name || '-'})\n` +
    `TG ID: ${p.telegram_id || 'Not bound'}\n` +
    `Players: ${p.player_count} total | 🆕 Today: ${p.today_count}\n` +
    `Created: ${p.created_at ? new Date(p.created_at).toISOString().slice(0, 10) : '-'}`,
    { parse_mode: 'HTML' }
  );
}

// /find_agent <code>
async function handleFindAgent(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: /find_agent CODE');
  const code = parts[1];
  const ag = await db.query(
    `SELECT a.*,
            (SELECT COUNT(*) FROM promoters WHERE agent_id = a.id) AS promoter_count,
            (SELECT COUNT(*) FROM players WHERE agent_id = a.id) AS player_count
     FROM agents a WHERE a.agent_code = $1`, [code]
  );
  if (ag.rows.length === 0) return ctx.reply('Agent not found.');
  const a = ag.rows[0];
  return ctx.reply(
    `🔍 <b>Agent Found</b>\n\n` +
    `Code: <code>${a.agent_code}</code>\n` +
    `Name: ${a.name}\n` +
    `Status: ${a.status} | Approval: ${a.approval_status}\n` +
    `TG ID: ${a.telegram_id || 'Not bound'}\n` +
    `Promoters: ${a.promoter_count} | Players: ${a.player_count}\n` +
    `Created: ${a.created_at ? new Date(a.created_at).toISOString().slice(0, 10) : '-'}\n` +
    `Approved: ${a.approved_at ? new Date(a.approved_at).toISOString().slice(0, 10) : '-'}`,
    { parse_mode: 'HTML' }
  );
}

module.exports = {
  handleAdmin, handleAddAgent, handleListAgents, handleListPromoters,
  handleListPlayers, handleBlockAgent, handleBlockPromoter, handleBlockPlayer,
  handleUnblockAgent, handleUnblockPromoter, handleUnblockPlayer,
  handleChangePlayerOwner, handleExportPlayers,
  handleListPending, handleApproveGame, handleRejectGame,
  handleRelinkAgent, handleResetAgentLink, handleResetPlayerLink,
  handleListAgentApplications, handleApproveAgent, handleRejectAgent,
  handleApproveAgentCb, handleRejectAgentCb,
  handleSystemStatus, handleAuditRecent,
  handleFindPlayer, handleFindPromoter, handleFindAgent,
  handleAdminPanelButtons,
};
