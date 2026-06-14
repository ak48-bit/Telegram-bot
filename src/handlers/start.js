const db = require('../db');
const { useInviteToken } = require('../services/token');
const audit = require('../services/audit');
const config = require('../config');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';

async function handleStart(ctx) {
  const payload = ctx.startPayload || '';
  const uid = ctx.from.id;
  const user = ctx.state.user;

  // ── 1. 一次性绑定 Token（Agent / Promoter） ──
  if (payload.startsWith('bind_agent_') || payload.startsWith('bind_promoter_')) {
    return handleBindToken(ctx, payload, uid);
  }

  // ── 2. 玩家通过推广链接进入 (p_XXXX) ──
  if (payload.startsWith('p_')) {
    return handlePlayerEntry(ctx, payload, uid);
  }

  // ── 3. 普通 /start ──
  return handlePlainStart(ctx, user);
}

// ═══════════════ Token 绑定 ═══════════════

async function handleBindToken(ctx, payload, uid) {
  const token = payload.replace(/^(bind_agent_|bind_promoter_)/, '');

  try {
    const result = await useInviteToken(token, uid);

    if (!result) {
      return ctx.reply(
        '⛔ 此绑定链接无效或已过期。\n\n' +
        '可能原因：\n' +
        '• 链接已被使用\n' +
        '• 链接已过期（有效期48小时）\n' +
        '• 链接被撤销\n\n' +
        '请联系你的上级重新获取绑定链接。'
      );
    }

    const { type, code } = result;

    if (type === 'agent_bind') {
      // 绑定 Agent 身份
      await db.query(
        `UPDATE users SET role = 'agent', status = 'active', updated_at = NOW()
         WHERE telegram_id = $1`,
        [uid]
      );
      await db.query(
        `UPDATE agents SET telegram_id = $1, status = 'active', updated_at = NOW()
         WHERE agent_code = $2`,
        [uid, code]
      );
      await audit.log(uid, 'agent', 'agent_bind', 'agent', code);

      return ctx.reply(
        `👥 <b>Agent Clicks Binding Link</b>\n\n` +
        `🎉 Agent Bound Successfully!\n` +
        `Agent Code：<code>${code}</code>\n\n` +
        `Available Commands：/agent | /add_promoter | /list_my_promoters | /list_my_players`,
        { parse_mode: 'HTML' }
      );
    }

    if (type === 'promoter_bind') {
      // 绑定 Promoter 身份
      const pm = await db.query(
        `SELECT pm.id, pm.agent_id, a.agent_code, a.name AS agent_name
         FROM promoters pm JOIN agents a ON pm.agent_id = a.id
         WHERE pm.promoter_code = $1`, [code]
      );
      if (pm.rows.length === 0) {
        return ctx.reply('⛔ 未找到 Promoter 记录。');
      }
      await db.query(
        `UPDATE users SET role = 'promoter', status = 'active', updated_at = NOW()
         WHERE telegram_id = $1`,
        [uid]
      );
      await db.query(
        `UPDATE promoters SET telegram_id = $1, status = 'active', updated_at = NOW()
         WHERE promoter_code = $2`,
        [uid, code]
      );
      await audit.log(uid, 'promoter', 'promoter_bind', 'promoter', code);

      const p = pm.rows[0];

      return ctx.reply(
        `📢 <b>Promoter Clicks Binding Link</b>\n\n` +
        `🎉 Promoter Bound Successfully!\n` +
        `Promoter Code：<code>${code}</code>\n` +
        `Assigned Agent：${p.agent_code}\n\n` +
        `Available Commands：/promoter | /set_promo | /my_link | /my_players | /share`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (e) {
    console.error('[BindToken]', e);
    return ctx.reply('系统错误，请联系管理员。');
  }
}

// ═══════════════ 玩家通过推广链接进入 ═══════════════

async function handlePlayerEntry(ctx, payload, uid) {
  const promoterCode = payload.replace(/^p_/, '');

  // 查找 Promoter
  const pm = await db.query(
    `SELECT pm.*, a.agent_code, a.name AS agent_name
     FROM promoters pm
     JOIN agents a ON pm.agent_id = a.id
     WHERE pm.promoter_code = $1`,
    [promoterCode]
  );

  if (pm.rows.length === 0) {
    return ctx.reply('⛔ 推广链接无效。');
  }

  const promoter = pm.rows[0];

  // 检查 Promoter 是否被封禁
  if (promoter.status === 'blocked') {
    return ctx.reply('🚫 该推广链接已暂停。');
  }

  // 检查 Agent 是否被封禁
  const ag = await db.query('SELECT status FROM agents WHERE id = $1', [promoter.agent_id]);
  if (ag.rows.length > 0 && ag.rows[0].status === 'blocked') {
    return ctx.reply('🚫 该推广链接已暂停。');
  }

  // 检查玩家是否已绑定过来源
  const existing = await db.query(
    `SELECT * FROM players WHERE telegram_id = $1`, [uid]
  );

  if (existing.rows.length > 0) {
    const p = existing.rows[0];
    // 已经绑定过 — 不允许自动修改
    const oldPm = await db.query(
      `SELECT promoter_code FROM promoters WHERE id = $1`, [p.promoter_id]
    );
    return ctx.reply(
      `⚠️ 你已经绑定过推广来源。\n\n` +
      `当前归属 Promoter：<code>${oldPm.rows[0]?.promoter_code || 'N/A'}</code>\n\n` +
      `如需修改归属，请联系客服。`
    );
  }

  // 第一次绑定 — 锁定来源
  await db.query(
    `INSERT INTO players (telegram_id, username, first_name, last_name, promoter_id, agent_id, first_start_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [uid, ctx.from.username, ctx.from.first_name, ctx.from.last_name, promoter.id, promoter.agent_id, payload]
  );

  // 更新 users 表 role 为 player
  await db.query(
    `UPDATE users SET role = 'player', updated_at = NOW() WHERE telegram_id = $1`, [uid]
  );

  await audit.log(uid, 'player', 'player_linked', 'promoter', promoterCode, {
    promoter_id: promoter.id,
    agent_id: promoter.agent_id,
  });

  return ctx.reply(
    `🎰 <b>Welcome！</b>\n` +
    `Referral Source：<code>${promoterCode}</code>\n\n` +
    `Available Commands：/submit PH90xxxx | /my`,
    { parse_mode: 'HTML' }
  );
}

// ═══════════════ 普通 /start ═══════════════

async function handlePlainStart(ctx, user) {
  const roleTexts = {
    admin: `👑 <b>Admin 面板</b>\n\n/admin — 管理菜单`,
    agent: `🏢 <b>Agent 面板</b>\n\n/agent — 查看菜单`,
    promoter: `📢 <b>Promoter 面板</b>\n\n/promoter — 查看菜单`,
    player: `🎮 <b>玩家面板</b>\n\n/submit 游戏ID — 提交游戏 ID\n/my — 查看我的资料`,
  };

  const text = roleTexts[user.role] ||
    `🤖 <b>欢迎使用推广 Bot</b>\n\n如果你有推广链接，请通过链接进入。`;

  return ctx.reply(text, { parse_mode: 'HTML' });
}

module.exports = { handleStart };
