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
  try {
    const result = await useInviteToken(token, uid);
    if (!result) {
      return ctx.reply('This binding link is invalid or expired.\n\nPossible reasons:\n• Link invalid\n• Link expired\n• Link revoked\n\nContact your upline for a new link.');
    }
    const { type, code } = result;
    if (type === 'agent_bind') {
      await db.query(`UPDATE users SET role = 'agent', status = 'active', updated_at = NOW() WHERE telegram_id = $1`, [uid]);
      await db.query(`UPDATE agents SET telegram_id = $1, status = 'active', updated_at = NOW() WHERE agent_code = $2`, [uid, code]);
      await audit.log(uid, 'agent', 'agent_bind', 'agent', code);
      return ctx.reply(
        `👥 <b>Agent Bound Successfully!</b>\n\nAgent Code：<code>${code}</code>\n\n⚠️ Use /set_agent_link to submit your Agent Link.\n\nCommands：/agent | /add_promoter | /list_my_promoters | /list_my_players | /my_agent_link | /set_agent_link | /relink_pm`,
        { parse_mode: 'HTML' }
      );
    }
    if (type === 'promoter_bind') {
      const pm = await db.query(
        `SELECT pm.id, pm.agent_id, a.agent_code FROM promoters pm JOIN agents a ON pm.agent_id = a.id WHERE pm.promoter_code = $1`, [code]
      );
      if (pm.rows.length === 0) return ctx.reply('Promoter record not found.');
      await db.query(`UPDATE users SET role = 'promoter', status = 'active', updated_at = NOW() WHERE telegram_id = $1`, [uid]);
      await db.query(`UPDATE promoters SET telegram_id = $1, status = 'active', updated_at = NOW() WHERE promoter_code = $2`, [uid, code]);
      await audit.log(uid, 'promoter', 'promoter_bind', 'promoter', code);
      return ctx.reply(
        `📢 <b>Promoter Bound Successfully!</b>\n\nPromoter Code：<code>${code}</code>\nAssigned Agent：${pm.rows[0].agent_code}\n\n⚠️ Use /set_player_link to submit your Player Link.\n\nCommands：/promoter | /my_link | /set_player_link | /my_players | /share`,
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

  await db.query(
    `INSERT INTO players (telegram_id, username, first_name, last_name, promoter_id, agent_id, first_start_payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [uid, ctx.from.username, ctx.from.first_name, ctx.from.last_name, promoter.id, promoter.agent_id, payload]
  );
  await db.query(`UPDATE users SET role = 'player', updated_at = NOW() WHERE telegram_id = $1`, [uid]);
  await audit.log(uid, 'player', 'player_linked', 'promoter', promoter.promoter_code, { promoter_id: promoter.id, agent_id: promoter.agent_id });

  return ctx.reply(
    `🎰 <b>Welcome!</b>\nReferral Source：<code>${promoter.promoter_code}</code>\n\nAvailable Commands：/submit PH90xxxx | /my`,
    { parse_mode: 'HTML' }
  );
}

// ═══ Plain /start ═══
async function handlePlainStart(ctx, user) {
  const texts = {
    admin: `👑 <b>Admin Panel</b>\n\n/admin — Admin Menu`,
    agent: `👥 <b>Agent Panel</b>\n\n/agent — View Menu`,
    promoter: `📢 <b>Promoter Panel</b>\n\n/promoter — View Menu`,
    player: `🎮 <b>Player Panel</b>\n\n/submit GameID — Submit Game ID\n/my — View Info`,
  };
  return ctx.reply(texts[user.role] || `🤖 <b>Welcome!</b>\n\nIf you have a referral link, please use it to enter.`);
}

module.exports = { handleStart };
