const db = require('../db');
const audit = require('../services/audit');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';

async function handlePromoter(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query(
    `SELECT pm.*, a.agent_code, a.name AS agent_name
     FROM promoters pm JOIN agents a ON pm.agent_id = a.id
     WHERE pm.telegram_id = $1 AND pm.status = 'active'`,
    [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('Promoter identity not bound or blocked.');

  const p = pm.rows[0];
  const stats = await db.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today,
            COUNT(*) FILTER (WHERE game_id_status = 'approved') AS approved
     FROM players WHERE promoter_id = $1`,
    [p.id]
  );
  const s = stats.rows[0];
  const linkStatus = p.link_status === 'BOUND'
    ? `Player Affiliate Link：\n${p.player_affiliate_link}`
    : 'Player Affiliate Link：Not Submitted — /set_promo';

  return ctx.reply(
    `📢 <b>Promoter</b>\n\n` +
    `Upline Agent：<code>${p.agent_code}</code>\n\n` +
    `Promoter Code：<code>${p.promoter_code}</code>\n` +
    `Name：${p.name}\n` +
    `Telegram：@${ctx.from.username || '-'}\n` +
    `Telegram ID：<code>${uid}</code>\n` +
    `${linkStatus}\n` +
    `Link Status：${p.link_status || 'NOT_SUBMITTED'}\n\n` +
    `Players：${s.total} total | 🆕 Today: ${s.today}\n\n` +
    `/my_link | /set_promo | /my_players | /my_today | /share`,
    { parse_mode: 'HTML' }
  );
}

// /my_link
async function handleMyLink(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query(
    `SELECT * FROM promoters WHERE telegram_id = $1 AND status = 'active'`, [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('Promoter identity not bound.');

  const p = pm.rows[0];
  const link = `https://t.me/${BOT_USERNAME}?start=p_${p.promoter_code}`;

  let msg = `📢 <b>Promoter Affiliate Link</b>\n\n` +
    `Promoter Code：<code>${p.promoter_code}</code>\n`;
  if (p.link_status === 'BOUND' && p.player_affiliate_link) {
    msg += `Player Affiliate Link：\n${p.player_affiliate_link}\n`;
  } else {
    msg += `Player Affiliate Link：<i>Not Submitted — /set_promo</i>\n`;
  }
  msg += `\n<b>Players Bot Share Link：</b>\n` +
    `${link}\n\n` +
    `1️⃣ Submit the Affiliate link first → 2️⃣ Copy the bot link and send it to players`;

  return ctx.reply(msg, { parse_mode: 'HTML' });
}

// /my_players [page]
async function handleMyPlayers(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query('SELECT id FROM promoters WHERE telegram_id = $1', [uid]);
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound.');

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

  if (res.rows.length === 0) return ctx.reply('No players yet.');

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
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound.');

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
    `📅 <b>Today Data — ${new Date().toISOString().slice(0, 10)}</b>\n\n` +
    `🏷️ Code：<code>${pm.rows[0].promoter_code}</code>\n\n` +
    `🆕 Today New: <b>${s.today}</b>\n` +
    `📝 Submitted GameID: <b>${s.submitted}</b>\n` +
    `✅ Approved: <b>${s.approved}</b>`,
    { parse_mode: 'HTML' }
  );
}

// /set_promo http://90jilia2.com/?r=ph90hk433
async function handleSetPromo(ctx) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('Format: <code>/set_promo http://your-domain.com/?r=your_code</code>', { parse_mode: 'HTML' });
  }
  const url = parts[1];

  // 1. 格式校验
  if (!url.startsWith('http')) {
    await audit.log(uid, 'promoter', 'submit_invalid_link', 'promoter', null, { url, reason: 'invalid_format' });
    return ctx.reply('Invalid link format.');
  }

  // 2. 查找当前 Promoter
  const pm = await db.query(
    `SELECT * FROM promoters WHERE telegram_id = $1`,
    [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound.');

  const promoter = pm.rows[0];

  // 3. 如果已经是 BOUND 且有链接 → 拒绝
  if (promoter.link_status === 'BOUND' && promoter.player_affiliate_link) {
    await audit.log(uid, 'promoter', 'submit_duplicate_own', 'promoter', promoter.promoter_code, { url });
    return ctx.reply('You have already submitted your Player Affiliate Link.');
  }

  // 4. 检查唯一性（其他 Promoter 是否已用）
  const dup = await db.query(
    `SELECT promoter_code FROM promoters WHERE player_affiliate_link = $1 AND telegram_id != $2`,
    [url, uid]
  );
  if (dup.rows.length > 0) {
    await audit.log(uid, 'promoter', 'submit_duplicate_link', 'promoter', promoter.promoter_code, { url, conflict_with: dup.rows[0].promoter_code });
    return ctx.reply('This link has already been used.');
  }

  // 5. 保存成功
  await db.query(
    `UPDATE promoters SET player_affiliate_link = $1, link_status = 'BOUND', updated_at = NOW() WHERE telegram_id = $2`,
    [url, uid]
  );
  await audit.log(uid, 'promoter', 'submit_link_success', 'promoter', promoter.promoter_code, { url });

  return ctx.reply('Submitted Successfully\nPromoter Link Bound Successfully');
}

// /share — 生成分享文案
async function handleShare(ctx) {
  const uid = ctx.from.id;
  const pm = await db.query(
    `SELECT * FROM promoters WHERE telegram_id = $1 AND status = 'active'`, [uid]
  );
  if (pm.rows.length === 0) return ctx.reply('Promoter not bound.');
  const p = pm.rows[0];
  const link = `https://t.me/${BOT_USERNAME}?start=p_${p.promoter_code}`;

  // 只有 BOUND 状态才显示完整分享文案
  if (p.link_status !== 'BOUND' || !p.player_affiliate_link) {
    return ctx.reply(
      `⚠️ You must submit your Player Affiliate Link first.\n\n` +
      `Use /set_promo to submit.`,
      { parse_mode: 'HTML' }
    );
  }

  let msg = `📋 <b>Promoter Sharing Message</b>\n\n`;
  msg += `  Copy the following message and send it to players：\n\n`;
  msg += `  🎰 Share + Signup Reward\n`;
  msg += `  ━━━━━━━━━━━━━━━\n`;
  msg += `  Promoter Affiliate Link：\n  ${p.player_affiliate_link}\n\n`;
  msg += `  📋 Promoter Bot Link：\n` +
    `  ${link}\n` +
    `  ━━━━━━━━━━━━━━━\n` +
    `  💰 Register and Get a Bonus | Share and Get Extra Rewards\n` +
    `  📢 Forward to your friends and claim together`;

  return ctx.reply(msg, { parse_mode: 'HTML' });
}

module.exports = { handlePromoter, handleMyLink, handleMyPlayers, handleMyToday, handleSetPromo, handleShare };
