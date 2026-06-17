const db = require('../db');
const { useInviteToken } = require('../services/token');
const audit = require('../services/audit');
const config = require('../config');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';
const ENABLE_LEGACY = config.ENABLE_LEGACY_PLAYER_LINK;

async function handleStart(ctx) {
  const payload = ctx.startPayload || '';
  const uid = ctx.from.id;
  const user = ctx.state.user;

  if (payload === 'apply_agent') {
    return handleApplyAgent(ctx, uid);
  }
  if (payload.startsWith('bind_agent_') || payload.startsWith('bind_promoter_')) {
    return handleBindToken(ctx, payload, uid);
  }
  if (payload.startsWith('p_')) {
    return handlePlayerEntry(ctx, payload, uid);
  }
  return handlePlainStart(ctx, user);
}

// ═══ Token Binding ═══
async function handleBindToken(ctx, payload, uid) {
  const token = payload.replace(/^(bind_agent_|bind_promoter_)/, '');
  const expectedType = payload.startsWith('bind_agent_') ? 'agent_bind' : 'promoter_bind';
  try {
    const result = await useInviteToken(token, uid, expectedType);
    if (!result || !result.type) {
      if (result?.reason === 'used') {
        return ctx.reply('⚠️ This binding link has already been used.\n\nBinding links are one-time use only.\nContact your upline for a new link.');
      }
      if (result?.reason === 'expired') {
        return ctx.reply('⚠️ This binding link has expired.\n\nContact your upline for a new link.');
      }
      if (result?.reason === 'type_mismatch') {
        return ctx.reply('⚠️ This binding link is invalid.\n\nContact your upline for a new link.');
      }
      return ctx.reply('⚠️ This binding link is invalid.\n\nContact your upline for a new link.');
    }
    const { type, code } = result;
    if (type === 'agent_bind') {
      // Check agent record and prevent overwriting another user's binding
      const agentRec = await db.query(
        'SELECT id, telegram_id, status, approval_status FROM agents WHERE agent_code = $1', [code]
      );
      if (agentRec.rows.length === 0) {
        return ctx.reply('Agent record not found.');
      }
      const boundTg = agentRec.rows[0].telegram_id ? String(agentRec.rows[0].telegram_id) : null;
      const curTg = String(uid);
      if (boundTg && boundTg !== curTg) {
        await audit.log(uid, 'agent', 'agent_bind_already_bound', 'agent', code);
        return ctx.reply('This Agent account is already bound. Contact Admin.');
      }
      // If already bound to this uid, show panel directly
      if (boundTg === curTg) {
        const { cmdButtons } = require('../services/cmdButtons');
        return ctx.reply(
          `👥 <b>Agent Already Bound</b>\n\nAgent Code：<code>${code}</code>`,
          { parse_mode: 'HTML', reply_markup: cmdButtons([
            ['/agent', '📊 Agent Panel'], ['/set_agent_link', '🔗 Set Agent Link'],
            ['/add_promoter', '➕ Add Promoter'], ['/list_my_promoters', '👥 My Promoters'],
            ['/list_my_players', '🎮 My Players'], ['/my_agent_link', '📋 My Link'],
          ])}
        );
      }
      const updUser = await db.query(`UPDATE users SET role = 'agent', status = 'active', updated_at = NOW() WHERE telegram_id = $1`, [uid]);
      const updAgent = await db.query(`UPDATE agents SET telegram_id = $1, status = 'active', updated_at = NOW() WHERE agent_code = $2 AND (telegram_id IS NULL OR telegram_id = $1)`, [uid, code]);
      if (updAgent.rowCount === 0) {
        await audit.log(uid, 'agent', 'agent_bind_failed', 'agent', code);
        return ctx.reply('Binding failed. Contact Admin.');
      }
      await audit.log(uid, 'agent', 'agent_bind', 'agent', code);
      const { cmdButtons } = require('../services/cmdButtons');
      return ctx.reply(
        `👥 <b>Agent Bound Successfully!</b>\n\nAgent Code：<code>${code}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: cmdButtons([
            ['/agent', '📊 Agent Panel'],
            ['/set_agent_link', '🔗 Set Agent Link'],
            ['/add_promoter', '➕ Add Promoter'],
            ['/list_my_promoters', '👥 My Promoters'],
            ['/list_my_players', '🎮 My Players'],
            ['/my_agent_link', '📋 My Link'],
          ])
        }
      );
    }
    if (type === 'promoter_bind') {
      // Check promoter record and prevent overwriting another user's binding
      const pmRec = await db.query(
        'SELECT id, telegram_id, status, agent_id FROM promoters WHERE promoter_code = $1', [code]
      );
      if (pmRec.rows.length === 0) {
        return ctx.reply('Promoter record not found.');
      }
      const boundPmTg = pmRec.rows[0].telegram_id ? String(pmRec.rows[0].telegram_id) : null;
      const curPmTg = String(uid);
      if (boundPmTg && boundPmTg !== curPmTg) {
        await audit.log(uid, 'promoter', 'promoter_bind_already_bound', 'promoter', code);
        return ctx.reply('This Promoter account is already bound. Contact Agent.');
      }
      // Get agent_code for display
      const agInfo = await db.query('SELECT agent_code FROM agents WHERE id = $1', [pmRec.rows[0].agent_id]);
      if (boundPmTg === curPmTg) {
        return ctx.reply(
          `📢 <b>Promoter Already Bound</b>\n\nPromoter Code：<code>${code}</code>\nAssigned Agent：${agInfo.rows[0]?.agent_code || '-'}\n\nCommands：/promoter | /my_link | /my_players | /share`,
          { parse_mode: 'HTML' }
        );
      }
      await db.query(`UPDATE users SET role = 'promoter', status = 'active', updated_at = NOW() WHERE telegram_id = $1`, [uid]);
      const updPm = await db.query(`UPDATE promoters SET telegram_id = $1, status = 'active', updated_at = NOW() WHERE promoter_code = $2 AND (telegram_id IS NULL OR telegram_id = $1)`, [uid, code]);
      if (updPm.rowCount === 0) {
        await audit.log(uid, 'promoter', 'promoter_bind_failed', 'promoter', code);
        return ctx.reply('Binding failed. Contact Admin.');
      }
      await audit.log(uid, 'promoter', 'promoter_bind', 'promoter', code);
      return ctx.reply(
        `📢 <b>Promoter Bound Successfully!</b>\n\nPromoter Code：<code>${code}</code>\nAssigned Agent：${agInfo.rows[0]?.agent_code || '-'}\n\nYour Promoter link has been set by your Agent.\nYou can now use /share to get your sharing message.\n\nCommands：/promoter | /my_link | /my_players | /share`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (e) {
    console.error('[BindToken]', e);
    return ctx.reply('System error, contact admin.');
  }
}

// ═══ Player Entry via Random Token ═══
async function handlePlayerEntry(ctx, payload, uid) {
  const rawToken = payload.replace(/^p_/, '');
  // Check if legacy code (old format p_Code)
  if (ENABLE_LEGACY) {
    const legacyPm = await db.query('SELECT * FROM promoters WHERE promoter_code = $1', [rawToken]);
    if (legacyPm.rows.length > 0) {
      return handlePlayerBind(ctx, uid, legacyPm.rows[0], rawToken);
    }
  }
  // New random token lookup
  const pm = await db.query(
    `SELECT pm.*, a.agent_code FROM promoters pm JOIN agents a ON pm.agent_id = a.id WHERE pm.player_referral_token = $1`, [rawToken]
  );
  if (pm.rows.length === 0) return ctx.reply('Invalid referral link.');
  return handlePlayerBind(ctx, uid, pm.rows[0], rawToken);
}

async function handlePlayerBind(ctx, uid, promoter, payload) {
  if (promoter.status === 'blocked') return ctx.reply('This referral link has been suspended.');
  const ag = await db.query('SELECT status FROM agents WHERE id = $1', [promoter.agent_id]);
  if (ag.rows.length > 0 && ag.rows[0].status === 'blocked') return ctx.reply('This referral link has been suspended.');

  const existing = await db.query('SELECT * FROM players WHERE telegram_id = $1', [uid]);
  if (existing.rows.length > 0) {
    const oldPm = await db.query('SELECT promoter_code FROM promoters WHERE id = $1', [existing.rows[0].promoter_id]);
    await audit.log(uid, 'player', 'player_relink_blocked', 'promoter', oldPm.rows[0]?.promoter_code, { attempted: promoter.promoter_code });
    return ctx.reply(
      `⚠️ You already have a referral source.\n\nCurrent Promoter：<code>${oldPm.rows[0]?.promoter_code || 'N/A'}</code>\n\nTo change, contact customer service.`
    );
  }

  // Prevent Admin/Agent/Promoter from being downgraded to Player
  const currentUser = await db.query('SELECT role FROM users WHERE telegram_id = $1', [uid]);
  if (currentUser.rows.length > 0) {
    const role = currentUser.rows[0].role;
    if (role === 'admin' || role === 'agent' || role === 'promoter') {
      await audit.log(uid, role, 'player_bind_denied_role', 'promoter', promoter.promoter_code);
      return ctx.reply('This referral link is for players only.');
    }
  }

  await db.query(
    `INSERT INTO players (telegram_id, username, first_name, last_name, promoter_id, agent_id, first_start_payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [uid, ctx.from.username, ctx.from.first_name, ctx.from.last_name, promoter.id, promoter.agent_id, payload]
  );
  await db.query(`UPDATE users SET role = 'player', updated_at = NOW() WHERE telegram_id = $1`, [uid]);
  await audit.log(uid, 'player', 'player_linked', 'promoter', promoter.promoter_code, { promoter_id: promoter.id, agent_id: promoter.agent_id });

  return ctx.reply(
    `🎰 <b>Welcome!</b>\nReferral Source：<code>${promoter.promoter_code}</code>\n\nAvailable Commands：/submit YourGameID | /my | /share`,
    { parse_mode: 'HTML' }
  );
}

// ═══ Plain /start ═══
async function handlePlainStart(ctx, user) {
  const texts = {
    admin: `👑 <b>Admin Panel</b>\n\n/admin — Admin Menu`,
    agent: `👥 <b>Agent Panel</b>\n\n/agent — View Menu`,
    promoter: `📢 <b>Promoter Panel</b>\n\n/promoter — View Menu`,
    player: `🎮 <b>Player Panel</b>\n\n/submit YourGameID — Submit Game ID\n/my — View Info\n/share — Share activity link`,
  };
  return ctx.reply(texts[user.role] || `🤖 <b>Welcome!</b>\n\nIf you have a referral link, please use it to enter.`);
}

// ═══ Agent Self-Application ═══
async function handleApplyAgent(ctx, uid) {
  const session = require('../services/session');
  const audit = require('../services/audit');

  try {
    // Rate limit: per minute
    const rateRes = await db.query(
      `SELECT COUNT(*) FROM rate_limits WHERE telegram_id = $1 AND attempt_type = 'apply_agent' AND created_at > NOW() - INTERVAL '1 minute'`,
      [uid]
    );
    if (parseInt(rateRes.rows[0].count) >= config.AGENT_APPLY_RATE_LIMITS.perMinute) {
      await audit.log(uid, 'player', 'agent_application_rate_limited', null, null, { attempt_type: 'apply_agent_per_minute' });
      return ctx.reply('Too many attempts. Please try again later.');
    }

    // Record rate limit
    await db.query(`INSERT INTO rate_limits (telegram_id, attempt_type) VALUES ($1, 'apply_agent')`, [uid]);

    // Check if already an approved agent
    const existingApproved = await db.query(
      `SELECT agent_code FROM agents WHERE telegram_id = $1 AND approval_status = 'approved'`, [uid]
    );
    if (existingApproved.rows.length > 0) {
      await audit.log(uid, 'agent', 'agent_application_duplicate_user', 'agent', existingApproved.rows[0].agent_code);
      return ctx.reply('You already have an Agent account.');
    }

    // Check if already has a pending application
    const existingPending = await db.query(
      `SELECT agent_code FROM agents WHERE telegram_id = $1 AND approval_status = 'pending'`, [uid]
    );
    if (existingPending.rows.length > 0) {
      await audit.log(uid, 'player', 'agent_application_duplicate_pending', 'agent', existingPending.rows[0].agent_code);
      return ctx.reply('You already have a pending Agent application.\nPlease wait for Admin review.');
    }

    // Check rejected rate limit (max 3 per day)
    const rejectedCount = await db.query(
      `SELECT COUNT(*) FROM audit_logs WHERE actor_telegram_id = $1 AND action = 'reject_agent_application' AND created_at > NOW() - INTERVAL '1 day'`,
      [uid]
    );
    if (parseInt(rejectedCount.rows[0].count) >= 3) {
      await audit.log(uid, 'player', 'agent_application_rate_limited', null, null, { attempt_type: 'rejected_daily_limit' });
      return ctx.reply('Too many attempts. Please try again later.');
    }

    // Start Step Mode
    await audit.log(uid, 'player', 'agent_application_started', null, null);
    session.set(uid, { action: 'apply_agent_code', data: {}, userRole: 'player', cancelAudit: 'step_apply_agent_cancelled' });

    return ctx.reply(
      `👥 <b>Agent Application</b>\n\nPlease submit your Agent Code.\n\nExample:\nLeo01`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('[handleApplyAgent]', e.message, e.stack);
    return ctx.reply('[apply_agent step1 error] ' + e.message).catch(() => {});
  }
}

module.exports = { handleStart, handleApplyAgent };
