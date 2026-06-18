const db = require('../db');
const { createInviteToken } = require('../services/token');
const audit = require('../services/audit');
const { exportPlayersByAgent, exportWithSummary } = require('../services/export');
const { validateAndNormalize, validatePromoterLink } = require('../services/normalize');
const config = require('../config');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';

async function handleAgent(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query(
    `SELECT a.*, u.first_name FROM agents a JOIN users u ON a.telegram_id = u.telegram_id WHERE a.telegram_id = $1`,
    [uid]
  );
  if (ag.rows.length === 0) return ctx.reply('Agent not bound.');

  const a = ag.rows[0];
  const stats = await db.query(
    `SELECT (SELECT COUNT(*) FROM promoters WHERE agent_id = $1) AS promoters,
            (SELECT COUNT(*) FROM promoters WHERE agent_id = $1 AND status = 'active') AS active_promoters,
            (SELECT COUNT(*) FROM players WHERE agent_id = $1) AS players,
            (SELECT COUNT(*) FROM players WHERE agent_id = $1 AND created_at::date = CURRENT_DATE) AS today_players,
            (SELECT COUNT(*) FROM players WHERE agent_id = $1 AND game_id IS NOT NULL) AS submitted_players`,
    [a.id]
  );
  const s = stats.rows[0];
  const pms = await db.query(
    `SELECT pm.promoter_code, pm.name, pm.status, pm.telegram_id, pm.player_affiliate_link_original, pm.link_status, u.username
     FROM promoters pm LEFT JOIN users u ON pm.telegram_id = u.telegram_id
     WHERE pm.agent_id = $1 ORDER BY pm.created_at DESC`, [a.id]
  );

  let pmList = '';
  for (const pm of pms.rows) {
    const statusIcon = { active: '✅', blocked: '🚫', pending: '⏳' }[pm.status] || '❓';
    const statusText = { active: 'Active', blocked: 'Blocked', pending: 'Pending' }[pm.status] || 'Unknown';
    const tgLine = pm.telegram_id
      ? `Telegram：@${pm.username || '-'}\nTelegram ID：<code>${pm.telegram_id}</code>`
      : `Telegram：Not bound\nBinding link: <code>/relink_pm ${pm.promoter_code}</code>`;
    const linkStatusIcon = pm.link_status === 'BOUND' ? '✅' : '⚠️';
    const linkLine = pm.player_affiliate_link_original
      ? `Affiliate Link：${pm.player_affiliate_link_original}\nLink Status：${linkStatusIcon} ${pm.link_status || 'NOT_SUBMITTED'}`
      : `Affiliate Link：Not Set\nLink Status：${linkStatusIcon} ${pm.link_status || 'NOT_SUBMITTED'}\n<i>Use /update_promoter_link ${pm.promoter_code} &lt;link&gt;</i>`;
    pmList += `\nPromoter：<code>${pm.promoter_code}</code> ${pm.name}\n${tgLine}\nStatus：${statusIcon} ${statusText}\n${linkLine}\n`;
  }

  const agentLinkLine = a.link_status === 'BOUND'
    ? `Agent Link：\n${a.agent_link_original || '-'}`
    : `Agent Link：NOT_SUBMITTED — /set_agent_link`;

  return ctx.reply(
    `👥 <b>Agent</b>\n\n` +
    `Agent Code：<code>${a.agent_code}</code>\n` +
    `Name：${a.name}\n` +
    `${agentLinkLine}\n` +
    `Promoters：${s.promoters} total (${s.active_promoters} active)\n` +
    `Players：${s.players} total | 🆕 Today: ${s.today_players} | 🎮 Submitted: ${s.submitted_players}\n\n` +
    `<b>Promoter List：</b>` + (pmList || '\nNo Promoters') + '\n' +
    ``,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '📊 Refresh', callback_data: 'cmd:/agent' }, { text: '➕ Add Promoter', callback_data: 'cmd:/add_promoter' }],
        [{ text: '🔗 Set Agent Link', callback_data: 'cmd:/set_agent_link' }, { text: '📋 My Link', callback_data: 'cmd:/my_agent_link' }],
        [{ text: '👥 My Promoters', callback_data: 'cmd:/list_my_promoters' }, { text: '🎮 My Players', callback_data: 'cmd:/list_my_players' }],
      ]}
    }
  );
}

// /add_promoter <code> <name> <affiliate_link>
async function handleAddPromoter(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query('SELECT * FROM agents WHERE telegram_id = $1 AND status = $2', [uid, 'active']);
  if (ag.rows.length === 0) return ctx.reply('Agent not bound or blocked.');
  const agent = ag.rows[0];
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 4) {
    if (parts.length === 1) {
      const session = require('../services/session');
      const audit = require('../services/audit');
      session.set(uid, { action: 'create_promoter_code', data: {}, userRole: 'agent', cancelAudit: 'step_create_promoter_cancelled' });
      await audit.log(uid, 'agent', 'step_create_promoter_started', null, null, {});
      return ctx.reply('Please enter Promoter Code:');
    }
    return ctx.reply(
      'Usage:\n/add_promoter <code> <name> <affiliate_link>\n\nExample:\n/add_promoter Tom01 Tom https://90jilia2.com/?r=Tom01Link',
      { parse_mode: 'HTML' }
    );
  }
  const promoterCode = parts[1];
  const name = parts[2];
  const rawLink = parts.slice(3).join('');

  // Validate promoter code: 3-20 chars, A-Za-z0-9_-, no reserved words
  const PM_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/;
  const reservedCodes = config.RESERVED_AGENT_CODES.map(c => c.toLowerCase());
  if (!PM_CODE_REGEX.test(promoterCode) || reservedCodes.includes(promoterCode.toLowerCase())) {
    return ctx.reply('Invalid Promoter Code format.', { parse_mode: 'HTML' });
  }

  // Validate name: no spaces, A-Za-z0-9_- only, 2-30 chars
  const PROMOTER_NAME_REGEX = /^[A-Za-z0-9_-]{2,30}$/;
  if (!name || !PROMOTER_NAME_REGEX.test(name)) {
    return ctx.reply(
      'Invalid Promoter Name format.\nPlease use 2-30 characters: letters, numbers, underscore or hyphen only.\n\nUsage:\n/add_promoter <code> <name> <affiliate_link>\n\nExample:\n/add_promoter Tom01 Tom https://90jilia2.com/?r=Tom01Link',
      { parse_mode: 'HTML' }
    );
  }

  // Check code unique
  const exists = await db.query('SELECT 1 FROM promoters WHERE promoter_code = $1', [promoterCode]);
  if (exists.rows.length > 0) return ctx.reply('This account already exists.', { parse_mode: 'HTML' });

  // Validate affiliate link
  const result = validatePromoterLink(rawLink, config.ALLOWED_DOMAINS);
  if (!result.valid) {
    await audit.log(uid, 'agent', 'submit_invalid_link', 'promoter', promoterCode, { url: rawLink });
    return ctx.reply('Invalid affiliate link format.');
  }

  // Check normalized link unique
  const dup = await db.query(
    'SELECT promoter_code FROM promoters WHERE player_affiliate_link_normalized = $1',
    [result.normalized]
  );
  if (dup.rows.length > 0) {
    await audit.log(uid, 'agent', 'submit_duplicate_link', 'promoter', promoterCode, { url: result.normalized, conflict: dup.rows[0].promoter_code });
    return ctx.reply('This affiliate link has already been used.');
  }

  // Generate unique player_referral_token
  const crypto = require('crypto');
  let playerReferralToken;
  let tokenConflict = true;
  while (tokenConflict) {
    playerReferralToken = crypto.randomBytes(16).toString('hex');
    const tokCheck = await db.query('SELECT 1 FROM promoters WHERE player_referral_token = $1', [playerReferralToken]);
    if (tokCheck.rows.length === 0) tokenConflict = false;
  }

  // Create promoter with link (link_status = BOUND)
  await db.query(
    `INSERT INTO promoters (promoter_code, agent_id, name, created_by_agent_id, created_by_telegram_id, player_affiliate_link_original, player_affiliate_link_normalized, player_referral_token, link_status, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'BOUND','pending')`,
    [promoterCode, agent.id, name, agent.id, uid, result.original, result.normalized, playerReferralToken]
  );

  const bindToken = await createInviteToken('promoter_bind', promoterCode, uid);
  const botLink = `https://t.me/${BOT_USERNAME}?start=bind_promoter_${bindToken}`;
  const manualCmd = `/start bind_promoter_${bindToken}`;
  await audit.log(uid, 'agent', 'agent_create_promoter_with_link', 'promoter', promoterCode, { name, link: result.normalized });

  return ctx.reply(
    `👥 <b>Agent Creates a Promoter</b>\n\n` +
    `✅ Promoter Created Successfully\n` +
    `Promoter Code：<code>${promoterCode}</code>\n` +
    `Name：${name}\n` +
    `Affiliate Link：${result.original}\n` +
    `Link Status：BOUND\n\n` +
    `<b>📋 Send this to Promoter：</b>\n\n` +
    `<code>${manualCmd}</code>\n\n` +
    `⚠️ One-time identity binding link. Valid 72h.\n` +
    `Do not share in groups. Invalid after use.\n\n` +
    `<i>If the button below is not clickable, copy the command above and send it to the Promoter's Telegram chat.</i>`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[
        { text: '🔗 Bind Promoter', url: botLink }
      ]] }
    }
  );
}

// /set_agent_link http://domain/?r=code
async function handleSetAgentLink(ctx) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    const session = require('../services/session');
    session.set(uid, { action: 'set_agent_link', data: {}, userRole: 'agent' });
    await audit.log(uid, 'agent', 'step_set_agent_link_started', null, null, {});
    return ctx.reply('Please send your Agent Promotion Link:');
  }
  const raw = parts[1];

  const result = validateAndNormalize(raw, config.ALLOWED_DOMAINS);
  if (!result.valid) {
    await audit.log(uid, 'agent', 'set_agent_link_invalid', 'agent', null, { url: raw });
    return ctx.reply('Invalid link format.');
  }

  const ag = await db.query('SELECT * FROM agents WHERE telegram_id = $1', [uid]);
  if (ag.rows.length === 0) return ctx.reply('Agent not bound.');
  const agent = ag.rows[0];

  if (agent.link_status === 'BOUND' && agent.agent_link_normalized) {
    await audit.log(uid, 'agent', 'set_agent_link_duplicate_own', 'agent', agent.agent_code, { url: raw });
    return ctx.reply('You have already bound your Agent Promotion Link.');
  }

  const dup = await db.query(
    'SELECT agent_code FROM agents WHERE agent_link_normalized = $1 AND telegram_id != $2',
    [result.normalized, uid]
  );
  if (dup.rows.length > 0) {
    await audit.log(uid, 'agent', 'set_agent_link_duplicate_link', 'agent', agent.agent_code, { url: raw, conflict: dup.rows[0].agent_code });
    return ctx.reply('This link has already been used.');
  }

  await db.query(
    `UPDATE agents SET agent_link_original = $1, agent_link_normalized = $2, link_status = 'BOUND', updated_at = NOW() WHERE telegram_id = $3`,
    [result.original, result.normalized, uid]
  );
  await audit.log(uid, 'agent', 'set_agent_link_success', 'agent', agent.agent_code, { url: result.normalized });

  return ctx.reply('Submitted Successfully\nAgent Link Bound Successfully');
}

// /my_agent_link
async function handleMyAgentLink(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query('SELECT agent_code, agent_link_original, link_status FROM agents WHERE telegram_id = $1', [uid]);
  if (ag.rows.length === 0) return ctx.reply('Agent not bound.');
  const a = ag.rows[0];
  let msg = `👥 <b>Agent Affiliate Link</b>\n\nAgent Code：<code>${a.agent_code}</code>\n`;
  if (a.link_status === 'BOUND' && a.agent_link_original) {
    msg += `Agent Link：\n${a.agent_link_original}\n`;
  } else {
    msg += `Agent Link：<i>Not Submitted — /set_agent_link</i>\n`;
  }
  return ctx.reply(msg, { parse_mode: 'HTML' });
}

// /list_my_promoters
async function handleListMyPromoters(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query('SELECT id FROM agents WHERE telegram_id = $1', [uid]);
  if (ag.rows.length === 0) return ctx.reply('Agent not bound.');
  const res = await db.query(
    `SELECT pm.*, u.username FROM promoters pm LEFT JOIN users u ON pm.telegram_id = u.telegram_id WHERE pm.agent_id = $1 ORDER BY pm.created_at DESC`,
    [ag.rows[0].id]
  );
  if (res.rows.length === 0) return ctx.reply('No promoters yet.');
  const lines = ['<b>My Promoters</b>\n'];
  for (const r of res.rows) {
    const status = { active: '✅', blocked: '🚫', pending: '⏳' }[r.status] || '❓';
    const tg = r.telegram_id ? `<code>${r.telegram_id}</code>` : 'Not bound';
    const countRes = await db.query('SELECT COUNT(*) FROM players WHERE promoter_id = $1', [r.id]);
    const todayRes = await db.query('SELECT COUNT(*) FROM players WHERE promoter_id = $1 AND created_at::date = CURRENT_DATE', [r.id]);
    const linkIcon = r.link_status === 'BOUND' ? '✅' : '⚠️';
    const linkInfo = r.player_affiliate_link_original ? `${r.player_affiliate_link_original}` : 'Not Set';
    lines.push(`${status} <code>${r.promoter_code}</code> — ${r.name}\n   Link: ${linkIcon} ${linkInfo}\n   Players: ${countRes.rows[0].count} total | 🆕 Today: ${todayRes.rows[0].count} | TG: ${tg}`);
  }
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// /list_my_players
async function handleListMyPlayers(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query('SELECT id FROM agents WHERE telegram_id = $1', [uid]);
  if (ag.rows.length === 0) return ctx.reply('Agent not bound.');
  const parts = ctx.message.text.trim().split(/\s+/);
  let page = 1;
  if (parts.length >= 2) page = parseInt(parts[1]) || 1;
  const limit = 30;
  const offset = (page - 1) * limit;
  const count = await db.query('SELECT COUNT(*) FROM players WHERE agent_id = $1', [ag.rows[0].id]);
  const total = parseInt(count.rows[0].count);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const res = await db.query(
    `SELECT p.*, pm.promoter_code, pm.name AS promoter_name, u.username FROM players p
     LEFT JOIN promoters pm ON p.promoter_id = pm.id LEFT JOIN users u ON p.telegram_id = u.telegram_id
     WHERE p.agent_id = $1 ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
    [ag.rows[0].id, limit, offset]
  );
  if (res.rows.length === 0) return ctx.reply('No players yet.');
  const lines = [`<b>My Players</b> — Page ${page}/${totalPages} (Total: ${total})\n`];
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
    await exportWithSummary(ctx, csv, 'Agent Players Export');
    await audit.log(ctx.from.id, 'agent', 'export_players', 'players', 'my_line');
  } catch (e) {
    console.error('[Export Agent]', e);
    return ctx.reply('Export failed: ' + e.message);
  }
}

// /relink_pm
async function handleRelinkPromoter(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query('SELECT * FROM agents WHERE telegram_id = $1', [uid]);
  if (ag.rows.length === 0) return ctx.reply('Agent not bound.');
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: <code>/relink_pm B001</code>', { parse_mode: 'HTML' });
  const code = parts[1];
  const pm = await db.query('SELECT * FROM promoters WHERE promoter_code = $1 AND agent_id = $2', [code, ag.rows[0].id]);
  if (pm.rows.length === 0) return ctx.reply(`Promoter <code>${code}</code> not found or not under you.`, { parse_mode: 'HTML' });
  await db.query(`UPDATE invite_tokens SET is_used = TRUE WHERE code = $1 AND type = 'promoter_bind' AND is_used = FALSE`, [code]);
  const token = await createInviteToken('promoter_bind', code, uid);
  const botLink = `https://t.me/${BOT_USERNAME}?start=bind_promoter_${token}`;
  const manualCmd = `/start bind_promoter_${token}`;
  await audit.log(uid, 'agent', 'relink_promoter', 'promoter', code);
  return ctx.reply(
    `🔗 <b>Promoter Binding Link (New)</b>\n\n` +
    `Code：<code>${code}</code>\n` +
    `Name：${pm.rows[0].name}\n\n` +
    `<b>📋 Send this to Promoter：</b>\n\n` +
    `<code>${manualCmd}</code>\n\n` +
    `⚠️ Old link invalidated.\n` +
    `⚠️ One-time identity binding link. Valid 72h.\n` +
    `Do not share in groups. Invalid after use.\n\n` +
    `<i>If the button below is not clickable, copy the command above and send it to the Promoter's Telegram chat.</i>`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[
        { text: '🔗 Bind Promoter', url: botLink }
      ]] }
    }
  );
}

// /update_promoter_link <promoter_code> <affiliate_link>
async function handleUpdatePromoterLink(ctx) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply('Format: <code>/update_promoter_link &lt;promoter_code&gt; &lt;affiliate_link&gt;</code>', { parse_mode: 'HTML' });
  }
  const promoterCode = parts[1];
  const rawLink = parts.slice(2).join(' ');

  // Verify Agent owns this Promoter
  const ag = await db.query('SELECT id FROM agents WHERE telegram_id = $1 AND status = $2', [uid, 'active']);
  if (ag.rows.length === 0) return ctx.reply('Agent not bound or blocked.');

  const pm = await db.query(
    'SELECT * FROM promoters WHERE promoter_code = $1 AND agent_id = $2',
    [promoterCode, ag.rows[0].id]
  );
  if (pm.rows.length === 0) {
    await audit.log(uid, 'agent', 'agent_update_promoter_link_denied', 'promoter', promoterCode);
    return ctx.reply('You can only update promoters under your own Agent account.');
  }

  const promoter = pm.rows[0];

  // Validate link
  const result = validatePromoterLink(rawLink, config.ALLOWED_DOMAINS);
  if (!result.valid) {
    await audit.log(uid, 'agent', 'submit_invalid_link', 'promoter', promoterCode, { url: rawLink });
    return ctx.reply('Invalid affiliate link format.');
  }

  // Check if same as current link
  if (promoter.player_affiliate_link_normalized === result.normalized) {
    return ctx.reply(
      `Link unchanged.\n\nPromoter: <code>${promoterCode}</code>\nLink Status: BOUND`,
      { parse_mode: 'HTML' }
    );
  }

  // Check normalized link unique (exclude self)
  const dup = await db.query(
    'SELECT promoter_code FROM promoters WHERE player_affiliate_link_normalized = $1 AND promoter_code != $2',
    [result.normalized, promoterCode]
  );
  if (dup.rows.length > 0) {
    await audit.log(uid, 'agent', 'submit_duplicate_link', 'promoter', promoterCode, { url: result.normalized, conflict: dup.rows[0].promoter_code });
    return ctx.reply('This affiliate link has already been used.');
  }

  // Update
  await db.query(
    `UPDATE promoters SET player_affiliate_link_original = $1, player_affiliate_link_normalized = $2, link_status = 'BOUND', updated_at = NOW() WHERE promoter_code = $3`,
    [result.original, result.normalized, promoterCode]
  );
  await audit.log(uid, 'agent', 'agent_update_promoter_link', 'promoter', promoterCode, { link: result.normalized });

  // Notify promoter if bound
  if (promoter.telegram_id) {
    try {
      await ctx.telegram.sendMessage(promoter.telegram_id,
        'Your Promoter link has been updated by your Agent.\nUse /share to get the latest sharing message.'
      );
      await audit.log(uid, 'agent', 'promoter_link_updated_notify_success', 'promoter', promoterCode);
    } catch (e) {
      console.error(`[Notify Promoter ${promoter.telegram_id}] Failed:`, e.message);
      await audit.log(uid, 'agent', 'promoter_link_updated_notify_failed', 'promoter', promoterCode);
    }
  }

  return ctx.reply(
    `✅ Promoter link updated successfully.\n\nPromoter: <code>${promoterCode}</code>\nLink Status: BOUND`,
    { parse_mode: 'HTML' }
  );
}

// /set_promo — legacy redirect
async function handleAgentSetPromoCompat(ctx) {
  return handleSetAgentLink(ctx);
}

module.exports = {
  handleAgent, handleAddPromoter, handleListMyPromoters,
  handleListMyPlayers, handleExportMyPlayers, handleRelinkPromoter,
  handleSetAgentLink, handleMyAgentLink, handleAgentSetPromoCompat,
  handleUpdatePromoterLink,
};
