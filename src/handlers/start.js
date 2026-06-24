const { escapeHtml, isUniqueViolation } = require('../services/escapeHtml');
const db = require('../db');
// Token validation now done inline in handleBindToken (transactional)
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
  // Short links: p_A01_<AgentCode>, p_B01_<PromoterCode>, p_C001_<PlayerShareCode>
  if (payload.startsWith('p_A01_') || payload.startsWith('p_B01_') || payload.startsWith('p_C001_')) {
    return handleShortLink(ctx, payload, uid);
  }
  // Legacy: p_<random_token>
  if (payload.startsWith('p_')) {
    return handlePlayerEntry(ctx, payload, uid);
  }
  return handlePlainStart(ctx, user);
}

// ═══ Token Binding ═══
async function handleBindToken(ctx, payload, uid) {
  const token = payload.replace(/^(bind_agent_|bind_promoter_)/, '');
  const expectedType = payload.startsWith('bind_agent_') ? 'agent_bind' : 'promoter_bind';
  const crypto = require('crypto');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // Agent binding: ONE transaction — token FOR UPDATE → agent FOR UPDATE → bind → mark used → check rowCount
  if (expectedType === 'agent_bind') {
    const client = await db.pool.connect();
    let code;
    try {
      await client.query('BEGIN');
      const tRec = await client.query('SELECT type, code, is_used, expires_at FROM invite_tokens WHERE token_hash = $1 FOR UPDATE', [tokenHash]);
      if (tRec.rows.length === 0) { await client.query('ROLLBACK'); client.release(); return ctx.reply('This binding link is invalid.'); }
      const t = tRec.rows[0];
      if (t.type !== 'agent_bind') { await client.query('ROLLBACK'); client.release(); return ctx.reply('This binding link is invalid.'); }
      if (t.is_used) { await client.query('ROLLBACK'); client.release(); return ctx.reply('This binding link has already been used.'); }
      if (new Date(t.expires_at) <= new Date()) { await client.query('ROLLBACK'); client.release(); return ctx.reply('This binding link has expired.'); }
      code = t.code;
      const ex = await client.query('SELECT agent_code FROM agents WHERE telegram_id = $1', [uid]);
      if (ex.rows.length > 0) { await client.query('ROLLBACK'); client.release(); return ctx.reply('Your TG is already bound to Agent ' + ex.rows[0].agent_code, { parse_mode: 'HTML' }); }
      const ag = await client.query('SELECT id, telegram_id, status FROM agents WHERE agent_code = $1 FOR UPDATE', [code]);
      if (ag.rows.length === 0) { await client.query('ROLLBACK'); client.release(); return ctx.reply('Agent record not found.'); }
      const bt = ag.rows[0].telegram_id ? String(ag.rows[0].telegram_id) : null;
      const ct = String(uid);
      if (bt && bt !== ct) { await client.query('ROLLBACK'); client.release(); await audit.log(uid,'agent','agent_bind_already_bound','agent',code); return ctx.reply('This Agent account is already bound.'); }
      if (bt === ct) {
        await client.query('ROLLBACK'); client.release();
        return ctx.reply('Agent Already Bound\nCode: ' + code + '\n\nNext Step: Create Promoter', { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{text:'Add Promoter',callback_data:'cmd:/add_promoter'}],[{text:'Agent Panel',callback_data:'cmd:/agent'}]]}});
      }
      await client.query("UPDATE users SET role='agent',status='active',updated_at=NOW() WHERE telegram_id=$1",[uid]);
      const ua = await client.query("UPDATE agents SET telegram_id=$1,status='active',updated_at=NOW() WHERE agent_code=$2 AND (telegram_id IS NULL OR telegram_id=$1)",[uid,code]);
      if (ua.rowCount === 0) { await client.query('ROLLBACK'); client.release(); await audit.log(uid,'agent','agent_bind_failed','agent',code); return ctx.reply('Binding failed.'); }
      const tu = await client.query("UPDATE invite_tokens SET is_used=TRUE,used_by_telegram_id=$1,used_at=NOW() WHERE token_hash=$2 AND is_used=FALSE",[uid,tokenHash]);
      if (tu.rowCount !== 1) { await client.query('ROLLBACK'); client.release(); return ctx.reply('This binding link has already been used.'); }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(()=>{}); client.release(); throw e; }
    client.release();
    await audit.log(uid, 'agent', 'agent_bind', 'agent', code);
    for (const adminId of config.ADMIN_IDS) {
      try { await ctx.telegram.sendMessage(adminId, 'Agent Binding Completed\nCode: ' + code + '\nTG: ' + uid + '\nStatus: Bound', { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{text:'Agent List',callback_data:'cmd:/list_agents'}],[{text:'Admin Panel',callback_data:'cmd:/admin'}]]}}); } catch (e) {}
    }
    return ctx.reply('Agent Bound Successfully!\n\nCode: ' + code + '\n\nNext Step: Create Promoter', { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{text:'Add Promoter',callback_data:'cmd:/add_promoter'}],[{text:'My Promoters',callback_data:'cmd:/list_my_promoters'},{text:'My Players',callback_data:'cmd:/list_my_players'}],[{text:'Agent Panel',callback_data:'cmd:/agent'}]]}});
  }

  // Promoter binding: ONE transaction
  if (expectedType === 'promoter_bind') {
    const client = await db.pool.connect();
    let pmCode;
    try {
      await client.query('BEGIN');
      const tRec = await client.query('SELECT type, code, is_used, expires_at FROM invite_tokens WHERE token_hash = $1 FOR UPDATE', [tokenHash]);
      if (tRec.rows.length === 0) { await client.query('ROLLBACK'); client.release(); return ctx.reply('This binding link is invalid.'); }
      const t = tRec.rows[0];
      if (t.type !== 'promoter_bind') { await client.query('ROLLBACK'); client.release(); return ctx.reply('This binding link is invalid.'); }
      if (t.is_used) { await client.query('ROLLBACK'); client.release(); return ctx.reply('This binding link has already been used.'); }
      if (new Date(t.expires_at) <= new Date()) { await client.query('ROLLBACK'); client.release(); return ctx.reply('This binding link has expired.'); }
      pmCode = t.code;
      const ex = await client.query('SELECT promoter_code FROM promoters WHERE telegram_id = $1', [uid]);
      if (ex.rows.length > 0) { await client.query('ROLLBACK'); client.release(); return ctx.reply('Your TG is already bound to Promoter ' + ex.rows[0].promoter_code, { parse_mode: 'HTML' }); }
      const pm = await client.query('SELECT id, telegram_id, status, agent_id FROM promoters WHERE promoter_code = $1 FOR UPDATE', [pmCode]);
      if (pm.rows.length === 0) { await client.query('ROLLBACK'); client.release(); return ctx.reply('Promoter record not found.'); }
      const bt = pm.rows[0].telegram_id ? String(pm.rows[0].telegram_id) : null;
      const ct = String(uid);
      if (bt && bt !== ct) { await client.query('ROLLBACK'); client.release(); await audit.log(uid,'promoter','promoter_bind_already_bound','promoter',pmCode); return ctx.reply('This Promoter account is already bound.'); }
      const agInfo = await client.query('SELECT agent_code FROM agents WHERE id = $1', [pm.rows[0].agent_id]);
      if (bt === ct) {
        await client.query('ROLLBACK'); client.release();
        return ctx.reply('Promoter Already Bound\nCode: ' + pmCode + '\nAgent: ' + (agInfo.rows[0]?.agent_code||'-') + '\n\nBot Share: https://t.me/' + BOT_USERNAME + '?start=p_B01_' + pmCode, { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{text:'Share',callback_data:'cmd:/share'},{text:'My Links',callback_data:'cmd:/my_link'}],[{text:'My Players',callback_data:'cmd:/my_players'},{text:'Today',callback_data:'cmd:/my_today'}]]}});
      }
      await client.query("UPDATE users SET role='promoter',status='active',updated_at=NOW() WHERE telegram_id=$1",[uid]);
      const up = await client.query("UPDATE promoters SET telegram_id=$1,status='active',updated_at=NOW() WHERE promoter_code=$2 AND (telegram_id IS NULL OR telegram_id=$1)",[uid,pmCode]);
      if (up.rowCount === 0) { await client.query('ROLLBACK'); client.release(); await audit.log(uid,'promoter','promoter_bind_failed','promoter',pmCode); return ctx.reply('Binding failed.'); }
      const tu = await client.query("UPDATE invite_tokens SET is_used=TRUE,used_by_telegram_id=$1,used_at=NOW() WHERE token_hash=$2 AND is_used=FALSE",[uid,tokenHash]);
      if (tu.rowCount !== 1) { await client.query('ROLLBACK'); client.release(); return ctx.reply('This binding link has already been used.'); }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(()=>{}); client.release(); throw e; }
    client.release();
    await audit.log(uid, 'promoter', 'promoter_bind', 'promoter', pmCode);
    const agentTg = await db.query('SELECT a.telegram_id FROM agents a JOIN promoters p ON p.agent_id = a.id WHERE p.promoter_code = $1', [pmCode]);
    if (agentTg.rows[0]?.telegram_id) {
      try { await ctx.telegram.sendMessage(agentTg.rows[0].telegram_id, 'Promoter Binding Completed\nCode: ' + pmCode + '\nTG: ' + uid + '\nStatus: Bound', { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{text:'My Promoters',callback_data:'cmd:/list_my_promoters'}],[{text:'Agent Panel',callback_data:'cmd:/agent'}]]}}); } catch (e) {}
    }
    const pmFull = await db.query('SELECT player_affiliate_link_original FROM promoters WHERE promoter_code = $1', [pmCode]);
    const affLink = pmFull.rows[0]?.player_affiliate_link_original || '';
    const botShareLink = 'https://t.me/' + BOT_USERNAME + '?start=p_B01_' + pmCode;
    let msg = 'Promoter Bound Successfully!\n\nCode: ' + pmCode + '\nAgent: ' + (agInfo.rows[0]?.agent_code||'-') + '\n\n';
    if (affLink) msg += 'Affiliate Link:\n' + affLink + '\n\n';
    msg += 'Bot Share Link:\n' + botShareLink + '\n\nNext Step: Send the Bot Share Link to players.';
    return ctx.reply(msg, { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{text:'Share',callback_data:'cmd:/share'},{text:'My Links',callback_data:'cmd:/my_link'}],[{text:'My Players',callback_data:'cmd:/my_players'},{text:'Today',callback_data:'cmd:/my_today'}]]}});
  }

  return ctx.reply('This binding link is invalid.');
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

// ═══ Short Link Handlers ═══
async function handleShortLink(ctx, payload, uid) {
  // Prevent Admin/Agent/Promoter from becoming Player via short links
  const currentUser = await db.query('SELECT role FROM users WHERE telegram_id = $1', [uid]);
  if (currentUser.rows.length > 0) {
    const role = currentUser.rows[0].role;
    if (role === 'admin' || role === 'agent' || role === 'promoter') {
      return ctx.reply('This referral link is for players only.');
    }
  }

  if (payload.startsWith('p_B01_')) {
    const promoterCode = payload.replace('p_B01_', '');
    const pm = await db.query(
      `SELECT pm.*, a.status AS ag_status FROM promoters pm JOIN agents a ON pm.agent_id = a.id WHERE pm.promoter_code = $1`, [promoterCode]
    );
    if (pm.rows.length === 0) return ctx.reply('Invalid referral link.');
    if (pm.rows[0].status === 'blocked' || pm.rows[0].ag_status === 'blocked') {
      return ctx.reply('This referral link has been suspended.');
    }
    await audit.log(uid, 'player', 'player_linked_short_b01', 'promoter', promoterCode);
    return handlePlayerBindShort(ctx, uid, pm.rows[0]);
  }

  if (payload.startsWith('p_C001_')) {
    const shareCode = payload.replace('p_C001_', '');
    // Find player by game_id_normalized or player_share_code
    let player = await db.query('SELECT * FROM players WHERE game_id_normalized = $1', [shareCode.toUpperCase()]);
    if (player.rows.length === 0) {
      player = await db.query('SELECT * FROM players WHERE player_share_code = $1', [shareCode]);
    }
    if (player.rows.length === 0) return ctx.reply('Invalid referral link.');
    const src = player.rows[0];
    if (!src.promoter_id || !src.agent_id) {
      await audit.log(uid, 'player', 'short_referral_player_source_missing', 'player', shareCode);
      return ctx.reply('Invalid referral link.');
    }
    const pm = await db.query(
      `SELECT pm.*, a.status AS ag_status FROM promoters pm JOIN agents a ON pm.agent_id = a.id WHERE pm.id = $1`, [src.promoter_id]
    );
    if (pm.rows.length === 0 || pm.rows[0].status === 'blocked' || pm.rows[0].ag_status === 'blocked') {
      return ctx.reply('This referral link has been suspended.');
    }
    await audit.log(uid, 'player', 'player_linked_short_c001', 'player', shareCode, { via_player: String(src.telegram_id) });
    return handlePlayerBindShort(ctx, uid, pm.rows[0]);
  }

  if (payload.startsWith('p_A01_')) {
    // Agent entry — informational only, don't create player
    const agentCode = payload.replace('p_A01_', '');
    const ag = await db.query('SELECT * FROM agents WHERE agent_code = $1 AND status = $2', [agentCode, 'active']);
    if (ag.rows.length === 0) return ctx.reply('Invalid referral link.');
    return ctx.reply(
      `👥 <b>Agent：${agentCode}</b>\n\nPlease enter through a Promoter Bot Share Link to participate.\nContact your Promoter for the correct link.`,
      { parse_mode: 'HTML' }
    );
  }

  return ctx.reply('Invalid referral link.');
}

async function handlePlayerBindShort(ctx, uid, promoter) {
  // Prevent Admin/Agent/Promoter from being downgraded to Player
  const currentUser = await db.query('SELECT role FROM users WHERE telegram_id = $1', [uid]);
  if (currentUser.rows.length > 0) {
    const role = currentUser.rows[0].role;
    if (role === 'admin' || role === 'agent' || role === 'promoter') {
      return ctx.reply('This account already has a management role and cannot be bound as a player.');
    }
  }
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
    [uid, ctx.from.username, ctx.from.first_name, ctx.from.last_name, promoter.id, promoter.agent_id, 'short_' + promoter.promoter_code]
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
    player: `🎮 <b>Player Panel</b>`,
    player_opts: {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '📝 Submit Game ID', callback_data: 'cmd:/submit' }],
        [{ text: '👤 My Info', callback_data: 'cmd:/my' }, { text: '📣 Share Bot Link', callback_data: 'cmd:/share' }],
      ]}
    },
  };
  const opts = texts[user.role + '_opts'] || {};
  return ctx.reply(texts[user.role] || `🤖 <b>Welcome!</b>\n\nIf you have a referral link, please use it to enter.`, opts);
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
