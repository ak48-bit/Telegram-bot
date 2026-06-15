const db = require('../db');
const { createInviteToken } = require('../services/token');
const audit = require('../services/audit');
const { exportPlayersByAgent, exportWithSummary } = require('../services/export');
const { validateAndNormalize } = require('../services/normalize');
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
            (SELECT COUNT(*) FROM players WHERE agent_id = $1) AS players,
            (SELECT COUNT(*) FROM players WHERE agent_id = $1 AND created_at::date = CURRENT_DATE) AS today_players`,
    [a.id]
  );
  const s = stats.rows[0];
  const pms = await db.query(
    `SELECT pm.promoter_code, pm.name, pm.status, pm.telegram_id, pm.player_affiliate_link_original, u.username
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
    const linkLine = pm.player_affiliate_link_original ? `Player Link：${pm.player_affiliate_link_original}` : 'Player Link：Not Submitted';
    pmList += `\nAgent：<code>${pm.promoter_code}</code> ${pm.name}\n${tgLine}\nStatus：${statusIcon} ${statusText}\n${linkLine}\n`;
  }

  const agentLinkLine = a.link_status === 'BOUND'
    ? `Agent Link：\n${a.agent_link_original || '-'}`
    : `Agent Link：NOT_SUBMITTED — /set_agent_link`;

  return ctx.reply(
    `👥 <b>Agent</b>\n\n` +
    `Agent Code：<code>${a.agent_code}</code>\n` +
    `Name：${a.name}\n` +
    `${agentLinkLine}\n` +
    `Promoters：${s.promoters} total\n` +
    `Players：${s.players} total | 🆕 Today: ${s.today_players}\n\n` +
    `<b>Promoter List：</b>` + (pmList || '\nNo Promoters') + '\n' +
    `/my_agent_link | /set_agent_link | /add_promoter | /relink_pm | /list_my_promoters | /list_my_players | /export_my_players`,
    { parse_mode: 'HTML' }
  );
}

// /add_promoter
async function handleAddPromoter(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query('SELECT * FROM agents WHERE telegram_id = $1 AND status = $2', [uid, 'active']);
  if (ag.rows.length === 0) return ctx.reply('Agent not bound or blocked.');
  const agent = ag.rows[0];
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 3) return ctx.reply('Format: <code>/add_promoter B001 Tom</code>', { parse_mode: 'HTML' });
  const promoterCode = parts[1];
  const name = parts.slice(2).join(' ');

  const exists = await db.query('SELECT 1 FROM promoters WHERE promoter_code = $1', [promoterCode]);
  if (exists.rows.length > 0) return ctx.reply('This account already exists.', { parse_mode: 'HTML' });

  await db.query(
    `INSERT INTO promoters (promoter_code, agent_id, name, created_by_agent_id, status) VALUES ($1,$2,$3,$4,'pending')`,
    [promoterCode, agent.id, name, uid]
  );

  const token = await createInviteToken('promoter_bind', promoterCode, uid);
  const link = `https://t.me/${BOT_USERNAME}?start=bind_promoter_${token}`;
  await audit.log(uid, 'agent', 'create_promoter', 'promoter', promoterCode, { name });

  return ctx.reply(
    `👥 <b>Agent Creates a Promoter</b>\n\n` +
    `<code>/add_promoter ${promoterCode} ${name}</code>\n\n` +
    `✅ Promoter Created Successfully\n` +
    `Promoter Code：<code>${promoterCode}</code>\n` +
    `Name：${name}\n\n` +
    `Promoter Bot Link：\n${link}\n\n` +
    `⚠️ One-time use, 48h valid. After binding, use /set_player_link.`,
    { parse_mode: 'HTML' }
  );
}

// /set_agent_link http://domain/?r=code
async function handleSetAgentLink(ctx) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: <code>/set_agent_link http://domain/?r=your_code</code>', { parse_mode: 'HTML' });
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
    lines.push(`${status} <code>${r.promoter_code}</code> — ${r.name} | Players: ${countRes.rows[0].count} | TG: ${tg}`);
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
  const link = `https://t.me/${BOT_USERNAME}?start=bind_promoter_${token}`;
  await audit.log(uid, 'agent', 'relink_promoter', 'promoter', code);
  return ctx.reply(`🔗 <b>Promoter Binding Link (New)</b>\n\nCode：<code>${code}</code>\nName：${pm.rows[0].name}\n\n<code>${link}</code>\n\n⚠️ Old link invalidated. One-time use, 48h valid.`, { parse_mode: 'HTML' });
}

// /set_promo — legacy redirect
async function handleAgentSetPromoCompat(ctx) {
  return handleSetAgentLink(ctx);
}

module.exports = {
  handleAgent, handleAddPromoter, handleListMyPromoters,
  handleListMyPlayers, handleExportMyPlayers, handleRelinkPromoter,
  handleSetAgentLink, handleMyAgentLink, handleAgentSetPromoCompat,
};
