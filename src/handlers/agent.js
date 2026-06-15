const db = require('../db');
const { createInviteToken } = require('../services/token');
const audit = require('../services/audit');
const { exportPlayersByAgent, sendCSV, exportWithSummary } = require('../services/export');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';

async function handleAgent(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query(
    `SELECT a.*, u.first_name FROM agents a JOIN users u ON a.telegram_id = u.telegram_id WHERE a.telegram_id = $1`,
    [uid]
  );
  if (ag.rows.length === 0) return ctx.reply('Agent identity not bound.');

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

  // 获取名下 Promoter 列表（含 Telegram 信息）
  const pms = await db.query(
    `SELECT pm.promoter_code, pm.name, pm.status, pm.telegram_id,
            u.username, u.first_name
     FROM promoters pm
     LEFT JOIN users u ON pm.telegram_id = u.telegram_id
     WHERE pm.agent_id = $1
     ORDER BY pm.created_at DESC`,
    [a.id]
  );

  let pmList = '';
  for (const pm of pms.rows) {
    const statusIcon = { active: '✅', blocked: '🚫', pending: '⏳' }[pm.status] || '❓';
    const statusText = { active: 'Active', blocked: 'Blocked', pending: 'Pending' }[pm.status] || 'Unknown';
    const tgLine = pm.telegram_id
      ? `Telegram：@${pm.username || '-'}\nTelegram ID：<code>${pm.telegram_id}</code>`
      : `Telegram：Not bound\nBinding link: <code>/relink_pm ${pm.promoter_code}</code>`;
    const promoLine = pm.promo_url ? `Promoter Link：<code>${pm.promo_url}</code>` : 'Promoter Link：';
    pmList += `\nAgent：<code>${pm.promoter_code}</code> ${pm.name}\n${tgLine}\nStatus：${statusIcon} ${statusText}\n${promoLine}\n`;
  }

  return ctx.reply(
    `🏢 <b>Agent Panel</b>\n\n` +
    `Agent Code：<code>${a.agent_code}</code>\n` +
    `Name：${a.name}\n\n` +
    `Promoters：${s.promoters} total\n` +
    `Players：${s.players} total | 🆕 Today: ${s.today_players}\n\n` +
    `<b>Promoter List：</b>` + (pmList || '\nNo Promoters') + '\n' +
    `<b>Commands:</b>\n` +
    `/my_link — View Affiliate Link\n` +
    `/set_promo — Set Affiliate Link\n` +
    `/add_promoter B001 Name — Create Promoter\n` +
    `/list_my_promoters — View Promoters\n` +
    `/relink_pm B001 — Regenerate Promoter Binding Link\n` +
    `/list_my_players — View Players\n` +
    `/export_my_players — Export Players`,
    { parse_mode: 'HTML' }
  );
}

// /add_promoter B001 Tom
async function handleAddPromoter(ctx) {
  const uid = ctx.from.id;

  // 查找 Agent
  const ag = await db.query('SELECT * FROM agents WHERE telegram_id = $1 AND status = $2', [uid, 'active']);
  if (ag.rows.length === 0) return ctx.reply('Agent identity not bound or blocked.');

  const agent = ag.rows[0];
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply('Format: <code>/add_promoter B001 Tom</code>', { parse_mode: 'HTML' });
  }

  const promoterCode = parts[1];
  const name = parts.slice(2).join(' ');

  // 检查 promoter_code 唯一
  const exists = await db.query('SELECT 1 FROM promoters WHERE promoter_code = $1', [promoterCode]);
  if (exists.rows.length > 0) {
    return ctx.reply(`❌ Promoter Code <code>${promoterCode}</code> already exists.`, { parse_mode: 'HTML' });
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

  // 自动生成 Promoter Affiliate Link
  const domain = (process.env.ALLOWED_DOMAINS || '90jilia2.com').split(',')[0].trim();
  const promoUrl = `http://${domain}/?r=${promoterCode}`;
  await db.query(`UPDATE promoters SET promo_url = $1 WHERE promoter_code = $2`, [promoUrl, promoterCode]);

  await audit.log(uid, 'agent', 'create_promoter', 'promoter', promoterCode, { name, token });

  return ctx.reply(
    `👥 <b>Agent Creates a Promoter</b>\n\n` +
    `<code>/add_promoter ${promoterCode} ${name}</code>\n\n` +
    `✅ Promoter Created Successfully\n` +
    `Promoter Code：<code>${promoterCode}</code>\n` +
    `Name：${name}\n\n` +
    `Promoter Affiliate Link：\n` +
    `${promoUrl}\n\n` +
    `Promoter Bot Link：\n` +
    `${link}\n\n` +
    `⚠️ One-time use only, valid for 48 hours`,
    { parse_mode: 'HTML' }
  );
}

// /list_my_promoters
async function handleListMyPromoters(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query('SELECT id FROM agents WHERE telegram_id = $1', [uid]);
  if (ag.rows.length === 0) return ctx.reply('Not bound Agent。');

  const res = await db.query(
    `SELECT pm.*, u.username, u.first_name
     FROM promoters pm LEFT JOIN users u ON pm.telegram_id = u.telegram_id
     WHERE pm.agent_id = $1 ORDER BY pm.created_at DESC`,
    [ag.rows[0].id]
  );
  if (res.rows.length === 0) return ctx.reply('No Promoters。');

  const lines = ['<b>📋 My Promoters</b>\n'];
  for (const r of res.rows) {
    const status = { active: '✅', blocked: '🚫', pending: '⏳' }[r.status] || '❓';
    const tg = r.telegram_id ? `<code>${r.telegram_id}</code>` : 'Not bound';
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
  if (ag.rows.length === 0) return ctx.reply('Not bound Agent。');

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

  if (res.rows.length === 0) return ctx.reply('No players yet.');

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
    await exportWithSummary(ctx, csv, 'Agent Players Export');
    await audit.log(ctx.from.id, 'agent', 'export_players', 'players', 'my_line');
  } catch (e) {
    console.error('[Export Agent]', e);
    return ctx.reply('Export failed: ' + e.message);
  }
}

// /relink_pm B001 — Regenerate Promoter Binding Link
async function handleRelinkPromoter(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query('SELECT * FROM agents WHERE telegram_id = $1', [uid]);
  if (ag.rows.length === 0) return ctx.reply('Not bound Agent。');

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: <code>/relink_pm B001</code>', { parse_mode: 'HTML' });
  const code = parts[1];

  // 检查 Promoter 是否属于该 Agent
  const pm = await db.query(
    `SELECT * FROM promoters WHERE promoter_code = $1 AND agent_id = $2`,
    [code, ag.rows[0].id]
  );
  if (pm.rows.length === 0) return ctx.reply(`❌ Promoter <code>${code}</code> not found or not under you.`, { parse_mode: 'HTML' });

  // 禁用旧的未使用 token
  await db.query(
    `UPDATE invite_tokens SET is_used = TRUE WHERE code = $1 AND type = 'promoter_bind' AND is_used = FALSE`,
    [code]
  );

  // 生成新 token
  const token = await createInviteToken('promoter_bind', code, uid);
  const link = `https://t.me/${BOT_USERNAME}?start=bind_promoter_${token}`;

  await audit.log(uid, 'agent', 'relink_promoter', 'promoter', code);

  return ctx.reply(
    `🔗 <b>Promoter 绑定链接（新）</b>\n\n` +
    `🏷️ Code：<code>${code}</code>\n` +
    `👤 Name：${pm.rows[0].name}\n\n` +
    `<code>${link}</code>\n\n` +
    `⚠️ Old link invalidated. One-time use, 48h valid.`,
    { parse_mode: 'HTML' }
  );
}

// /my_link — Agent 查看自己的推广链接
async function handleAgentMyLink(ctx) {
  const uid = ctx.from.id;
  const ag = await db.query('SELECT agent_code, promo_url FROM agents WHERE telegram_id = $1', [uid]);
  if (ag.rows.length === 0) return ctx.reply('Agent not bound.');
  const a = ag.rows[0];
  let msg = `👥 <b>Agent Affiliate Link</b>\n\n` +
    `Agent Code：<code>${a.agent_code}</code>\n`;
  if (a.promo_url) {
    msg += `Agent Affiliate Link：\n${a.promo_url}\n`;
  } else {
    msg += `Agent Affiliate Link：<i>Not set — /set_promo</i>\n`;
  }
  msg += `\nShare this link with promoters or players.`;
  return ctx.reply(msg, { parse_mode: 'HTML' });
}

// /set_agent_promo http://domain/?r=code
async function handleAgentSetPromo(ctx) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) return ctx.reply('Format: <code>/set_promo http://domain/?r=your_code</code>', { parse_mode: 'HTML' });
  const url = parts[1];
  if (!url.startsWith('http')) return ctx.reply('URL must start with http:// or https://.');
  await db.query('UPDATE agents SET promo_url = $1 WHERE telegram_id = $2', [url, uid]);
  return ctx.reply(`✅ Agent Affiliate Link set!\n\n${url}`, { parse_mode: 'HTML' });
}

module.exports = {
  handleAgent, handleAddPromoter, handleListMyPromoters,
  handleListMyPlayers, handleExportMyPlayers,
  handleRelinkPromoter, handleAgentMyLink, handleAgentSetPromo,
};
