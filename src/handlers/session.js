/**
 * Handles step-by-step input flows using in-memory session.
 * Each command's "old format" handler is called when the step completes.
 */
const session = require('../services/session');
const audit = require('../services/audit');
const { validateAndNormalize, validatePromoterLink } = require('../services/normalize');
const { createInviteToken } = require('../services/token');
const db = require('../db');
const config = require('../config');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';
const GAME_ID_REGEX = new RegExp(config.GAME_ID_REGEX);
const AGENT_CODE_REGEX = config.AGENT_CODE_REGEX;
const RESERVED_AGENT_CODES = config.RESERVED_AGENT_CODES.map(c => c.toLowerCase());

// ── Main entry: called when user sends text while in a session ──
async function handleSessionMessage(ctx, s) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();

  // If user sends another /command while in session
  if (text.startsWith('/')) {
    return ctx.reply('You have an unfinished action. Please complete it or send /cancel.');
  }

  switch (s.action) {
    case 'apply_agent_code':
      return stepApplyAgentCode(ctx, s, text);
    case 'apply_agent_name':
      return stepApplyAgentName(ctx, s, text);
    case 'create_agent_code':
      return stepCreateAgentCode(ctx, s, text);
    case 'create_agent_name':
      return stepCreateAgentName(ctx, s, text);
    case 'create_promoter_code':
      return stepCreatePromoterCode(ctx, s, text);
    case 'create_promoter_name':
      return stepCreatePromoterName(ctx, s, text);
    case 'create_promoter_link':
      return stepCreatePromoterLink(ctx, s, text);
    case 'set_agent_link':
      return stepSetAgentLink(ctx, s, text);
    case 'set_player_link':
      return stepSetPlayerLink(ctx, s, text);
    case 'submit_game_id':
      return stepSubmitGameId(ctx, s, text);
    default:
      session.delete(uid);
      return ctx.reply('Session expired. Please start again.');
  }
}

// ── Callback handler for Confirm/Cancel buttons ──
async function handleSessionCallback(ctx) {
  const cb = ctx.callbackQuery;
  const uid = cb.from.id;
  const s = session.get(uid);

  if (!s) {
    await ctx.answerCbQuery('Session expired').catch(() => {});
    return ctx.editMessageText('Session expired. Please start again.').catch(() => {});
  }

  // Verify telegram_id matches
  if (cb.from.id !== s.telegramId) {
    await ctx.answerCbQuery('Not your session').catch(() => {});
    return;
  }

  const data = cb.data;
  if (data === 'session_cancel') {
    session.delete(uid);
    await audit.log(uid, s.userRole || 'unknown', s.cancelAudit || 'step_cancelled', null, null).catch(() => {});
    await ctx.answerCbQuery('Cancelled').catch(() => {});
    return ctx.editMessageText('Cancelled.').catch(() => {});
  }

  if (data === 'session_confirm') {
    // Execute the actual action
    await ctx.answerCbQuery('Confirmed').catch(() => {});
    return executeConfirmedAction(ctx, s);
  }
}

async function executeConfirmedAction(ctx, s) {
  const uid = s.telegramId;
  const orig = ctx.callbackQuery.message.text || '';

  switch (s.action) {
    case 'confirm_create_agent': {
      const { agentCode, name } = s.data;
      const exists = await db.query('SELECT 1 FROM agents WHERE agent_code = $1', [agentCode]);
      if (exists.rows.length > 0) {
        session.delete(uid);
        return ctx.editMessageText(`Agent Code ${agentCode} already exists.`).catch(() => {});
      }
      await db.query(`INSERT INTO agents (agent_code, name, created_by_admin_id, status, approval_status) VALUES ($1,$2,$3,'pending','approved')`, [agentCode, name, uid]);
      const token = await createInviteToken('agent_bind', agentCode, uid);
      const link = `https://t.me/${BOT_USERNAME}?start=bind_agent_${token}`;
      await audit.log(uid, 'admin', 'step_create_agent_confirmed', 'agent', agentCode, { name });
      session.delete(uid);
      return ctx.editMessageText(
        `Agent Created Successfully\nAgent Code: ${agentCode}\nName: ${name}\n\nAgent Bot Link:\n${link}\n\n⚠️ No expiry, unlimited use.\nAfter binding, use /set_agent_link.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    case 'confirm_create_promoter': {
      const { promoterCode, name, affiliateLink, affiliateLinkNormalized, agentId } = s.data;
      const exists = await db.query('SELECT 1 FROM promoters WHERE promoter_code = $1', [promoterCode]);
      if (exists.rows.length > 0) {
        session.delete(uid);
        return ctx.editMessageText('This account already exists.').catch(() => {});
      }
      // Find agent_id from telegram_id
      const ag = await db.query('SELECT id FROM agents WHERE telegram_id = $1', [uid]);
      const actualAgentId = agentId || (ag.rows[0]?.id);
      await db.query(
        `INSERT INTO promoters (promoter_code, agent_id, name, created_by_agent_id, created_by_telegram_id, player_affiliate_link_original, player_affiliate_link_normalized, link_status, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'BOUND','pending')`,
        [promoterCode, actualAgentId, name, actualAgentId, uid, affiliateLink, affiliateLinkNormalized]
      );
      const token = await createInviteToken('promoter_bind', promoterCode, uid);
      const botLink = `https://t.me/${BOT_USERNAME}?start=bind_promoter_${token}`;
      const manualCmd = `/start bind_promoter_${token}`;
      await audit.log(uid, 'agent', 'agent_create_promoter_with_link', 'promoter', promoterCode, { name, link: affiliateLinkNormalized });
      session.delete(uid);
      return ctx.editMessageText(
        `✅ Promoter Created Successfully\nPromoter Code: ${promoterCode}\nName: ${name}\nAffiliate Link: ${affiliateLink}\nLink Status: BOUND\n\n📋 Send this to Promoter:\n\n${manualCmd}\n\n⚠️ One-time identity binding link. Valid 72h.`,
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [[
            { text: '🔗 Bind Promoter', url: botLink }
          ]] }
        }
      ).catch(() => {});
    }

    default:
      session.delete(uid);
      return ctx.editMessageText('Session expired. Please start again.').catch(() => {});
  }
}

// ── Step handlers ──

async function stepCreateAgentCode(ctx, s, text) {
  const code = text.trim();
  if (!code) return ctx.reply('Please enter a valid Agent Code.');
  const exists = await db.query('SELECT 1 FROM agents WHERE agent_code = $1', [code]);
  if (exists.rows.length > 0) return ctx.reply(`Agent Code ${code} already exists. Please enter a different one.`);
  session.set(ctx.from.id, { ...s, action: 'create_agent_name', data: { agentCode: code } });
  return ctx.reply('Please enter Agent Name:');
}

async function stepCreateAgentName(ctx, s, text) {
  const name = text.trim();
  if (!name) return ctx.reply('Please enter a valid Agent Name.');
  session.set(ctx.from.id, { ...s, action: 'confirm_create_agent', data: { ...s.data, name } });
  return ctx.reply(
    `Confirm Create Agent?\n\nAgent Code: ${s.data.agentCode}\nName: ${name}`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Confirm', callback_data: 'session_confirm' },
      { text: '❌ Cancel', callback_data: 'session_cancel' }
    ]] } }
  );
}

async function stepCreatePromoterCode(ctx, s, text) {
  const code = text.trim();
  if (!code) return ctx.reply('Please enter a valid Promoter Code.');
  const exists = await db.query('SELECT 1 FROM promoters WHERE promoter_code = $1', [code]);
  if (exists.rows.length > 0) return ctx.reply(`Promoter Code ${code} already exists. Please enter a different one.`);
  session.set(ctx.from.id, { ...s, action: 'create_promoter_name', data: { promoterCode: code } });
  return ctx.reply('Please enter Promoter Name:');
}

async function stepCreatePromoterName(ctx, s, text) {
  const name = text.trim();
  const PROMOTER_NAME_REGEX = /^[A-Za-z0-9_-]{2,30}$/;
  if (!name || !PROMOTER_NAME_REGEX.test(name)) {
    return ctx.reply('Invalid Promoter Name format.\nPlease use 2-30 characters: letters, numbers, underscore or hyphen only.');
  }
  session.set(ctx.from.id, { ...s, action: 'create_promoter_link', data: { ...s.data, name } });
  return ctx.reply('Please enter Promoter Affiliate Link:\n\nExample:\nhttps://90jilia2.com/?r=Tom01Link');
}

async function stepCreatePromoterLink(ctx, s, text) {
  const uid = ctx.from.id;
  const raw = text.trim();
  const result = validatePromoterLink(raw, config.ALLOWED_DOMAINS);
  if (!result.valid) {
    await audit.log(uid, 'agent', 'submit_invalid_link', 'promoter', s.data.promoterCode, { url: raw });
    return ctx.reply('Invalid affiliate link format.');
  }

  // Check link uniqueness
  const dup = await db.query(
    'SELECT promoter_code FROM promoters WHERE player_affiliate_link_normalized = $1',
    [result.normalized]
  );
  if (dup.rows.length > 0) {
    await audit.log(uid, 'agent', 'submit_duplicate_link', 'promoter', s.data.promoterCode, { url: result.normalized, conflict: dup.rows[0].promoter_code });
    return ctx.reply('This affiliate link has already been used.');
  }

  session.set(ctx.from.id, {
    ...s,
    action: 'confirm_create_promoter',
    data: { ...s.data, affiliateLink: result.original, affiliateLinkNormalized: result.normalized }
  });
  return ctx.reply(
    `Confirm Create Promoter?\n\nPromoter Code: ${s.data.promoterCode}\nName: ${s.data.name}\nAffiliate Link: ${result.original}\nLink Status: BOUND`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Confirm', callback_data: 'session_confirm' },
      { text: '❌ Cancel', callback_data: 'session_cancel' }
    ]] } }
  );
}

async function stepSetAgentLink(ctx, s, text) {
  const uid = ctx.from.id;
  const raw = text.trim();
  const result = validateAndNormalize(raw, config.ALLOWED_DOMAINS);
  if (!result.valid) {
    await audit.log(uid, 'agent', 'set_agent_link_invalid', 'agent', null, { url: raw });
    session.delete(uid);
    return ctx.reply('Invalid link format.');
  }
  const ag = await db.query('SELECT * FROM agents WHERE telegram_id = $1', [uid]);
  const agent = ag.rows[0];
  if (agent.link_status === 'BOUND' && agent.agent_link_normalized) {
    await audit.log(uid, 'agent', 'set_agent_link_duplicate_own', 'agent', agent.agent_code, { url: raw });
    session.delete(uid);
    return ctx.reply('You have already bound your Agent Promotion Link.');
  }
  const dup = await db.query('SELECT agent_code FROM agents WHERE agent_link_normalized = $1 AND telegram_id != $2', [result.normalized, uid]);
  if (dup.rows.length > 0) {
    await audit.log(uid, 'agent', 'set_agent_link_duplicate_link', 'agent', agent.agent_code, { url: raw });
    session.delete(uid);
    return ctx.reply('This link has already been used.');
  }
  await db.query(`UPDATE agents SET agent_link_original = $1, agent_link_normalized = $2, link_status = 'BOUND', updated_at = NOW() WHERE telegram_id = $3`, [result.original, result.normalized, uid]);
  await audit.log(uid, 'agent', 'set_agent_link_success', 'agent', agent.agent_code, { url: result.normalized });
  session.delete(uid);
  return ctx.reply('Submitted Successfully\nAgent Link Bound Successfully');
}

async function stepSetPlayerLink(ctx, s, text) {
  const uid = ctx.from.id;
  // Denied: Promoters can no longer self-submit links
  await audit.log(uid, 'promoter', 'promoter_set_promo_denied', 'promoter', null);
  session.delete(uid);
  return ctx.reply(
    'Promoter link is managed by your Agent.\nPlease contact your Agent if you need to update your link.'
  );
}

async function stepSubmitGameId(ctx, s, text) {
  const uid = ctx.from.id;
  const raw = text.trim();
  const gameId = raw.toUpperCase();
  if (!GAME_ID_REGEX.test(gameId)) {
    await audit.log(uid, 'player', 'submit_game_id_invalid', 'player', String(uid), { game_id: raw });
    session.delete(uid);
    return ctx.reply('Invalid Game ID format.');
  }
  const player = await db.query('SELECT * FROM players WHERE telegram_id = $1', [uid]);
  if (player.rows.length === 0) {
    session.delete(uid);
    return ctx.reply('Please enter through a valid Bot Share Link first.');
  }
  const dup = await db.query(`SELECT telegram_id FROM players WHERE game_id_normalized = $1 AND telegram_id != $2`, [gameId, uid]);
  if (dup.rows.length > 0) {
    await audit.log(uid, 'player', 'submit_game_id_duplicate', 'player', String(uid), { game_id: gameId });
    session.delete(uid);
    return ctx.reply('This Game ID has already been submitted.');
  }
  await db.query(`UPDATE players SET game_id = $1, game_id_normalized = $2, game_id_status = 'approved', updated_at = NOW() WHERE telegram_id = $3`, [gameId, gameId, uid]);
  await audit.log(uid, 'player', 'submit_game_id', 'player', String(uid), { game_id: gameId });
  session.delete(uid);
  return ctx.reply(`🎮 <b>Submit Game ID</b>\n\n/submit ${gameId}\n\n✅ Submitted Successfully\nGame ID: <code>${gameId}</code>\nStatus: Approved ✅`, { parse_mode: 'HTML' });
}

// ── Agent Self-Application Step Handlers ──

async function stepApplyAgentCode(ctx, s, text) {
  const uid = ctx.from.id;
  const code = text.trim();

  // Validate format
  if (!AGENT_CODE_REGEX.test(code)) {
    return ctx.reply(
      'Invalid Agent Code format.\nPlease use 3-20 characters: letters, numbers, underscore or hyphen only.'
    );
  }

  // Check reserved words (case insensitive)
  if (RESERVED_AGENT_CODES.includes(code.toLowerCase())) {
    await audit.log(uid, 'player', 'agent_application_rate_limited', null, null, { attempt_type: 'reserved_code', code });
    return ctx.reply(
      'Invalid Agent Code format.\nPlease use 3-20 characters: letters, numbers, underscore or hyphen only.'
    );
  }

  // Check for @, spaces, Chinese, special chars, links
  if (/[@\s]/.test(code) || /[一-鿿]/.test(code) || code.startsWith('/') || /https?:\/\//i.test(code)) {
    return ctx.reply(
      'Invalid Agent Code format.\nPlease use 3-20 characters: letters, numbers, underscore or hyphen only.'
    );
  }

  // Check if code already exists
  const exists = await db.query('SELECT 1 FROM agents WHERE agent_code = $1', [code]);
  if (exists.rows.length > 0) {
    await audit.log(uid, 'player', 'agent_application_duplicate_code', 'agent', code);
    return ctx.reply('This Agent Code is already used.');
  }

  // Rate limit: per hour agent code attempts
  const rateRes = await db.query(
    `SELECT COUNT(*) FROM rate_limits WHERE telegram_id = $1 AND attempt_type = 'agent_code' AND created_at > NOW() - INTERVAL '1 hour'`,
    [uid]
  );
  if (parseInt(rateRes.rows[0].count) >= config.AGENT_APPLY_RATE_LIMITS.perHour) {
    await audit.log(uid, 'player', 'agent_application_rate_limited', null, null, { attempt_type: 'agent_code_per_hour' });
    return ctx.reply('Too many attempts. Please try again later.');
  }
  await db.query(`INSERT INTO rate_limits (telegram_id, attempt_type) VALUES ($1, 'agent_code')`, [uid]);

  await audit.log(uid, 'player', 'agent_application_code_submitted', 'agent', code);

  session.set(uid, { ...s, action: 'apply_agent_name', data: { ...s.data, agentCode: code } });
  return ctx.reply('Please submit your Agent Name.\n\nExample:\nLeo');
}

async function stepApplyAgentName(ctx, s, text) {
  const uid = ctx.from.id;
  const name = text.trim();

  // Validate name
  if (!name || name.length < 2 || name.length > 30) {
    return ctx.reply(
      'Invalid Agent Name format.\nPlease submit a normal display name, 2-30 characters.'
    );
  }

  // Check for links, @, <>, commands, scripts
  if (/https?:\/\//i.test(name) || /@/.test(name) || /[<>]/.test(name) ||
      name.startsWith('/') || /javascript:/i.test(name) || /data:/i.test(name) ||
      /<script/i.test(name)) {
    return ctx.reply(
      'Invalid Agent Name format.\nPlease submit a normal display name, 2-30 characters.'
    );
  }

  const { agentCode } = s.data;

  // Validate the formatted name doesn't look like a command
  if (name.startsWith('/')) {
    return ctx.reply(
      'Invalid Agent Name format.\nPlease submit a normal display name, 2-30 characters.'
    );
  }

  await audit.log(uid, 'player', 'agent_application_name_submitted', 'agent', agentCode, { name });

  // Create or update the pending agent record
  // Handle reapplication: if user has a rejected record, update it instead of inserting
  const existingRejected = await db.query(
    `SELECT id, agent_code FROM agents WHERE telegram_id = $1 AND approval_status = 'rejected'`,
    [uid]
  );
  if (existingRejected.rows.length > 0) {
    // Update the existing rejected record to pending with new details
    await db.query(
      `UPDATE agents SET agent_code = $1, name = $2, username = $3, approval_status = 'pending',
           status = 'active', applied_by_telegram_id = $4, rejected_by = NULL, rejected_at = NULL,
           approved_by = NULL, approved_at = NULL, updated_at = NOW()
       WHERE telegram_id = $5 AND approval_status = 'rejected'`,
      [agentCode, name, ctx.from.username || null, uid, uid]
    );
  } else {
    // Insert new pending agent record
    await db.query(
      `INSERT INTO agents (agent_code, name, telegram_id, username, approval_status, status, applied_by_telegram_id, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', 'active', $5, NOW())`,
      [agentCode, name, uid, ctx.from.username || null, uid]
    );
  }

  // Update user role to agent
  await db.query(`UPDATE users SET role = 'agent', updated_at = NOW() WHERE telegram_id = $1`, [uid]);

  await audit.log(uid, 'player', 'agent_application_submitted', 'agent', agentCode, { name, username: ctx.from.username });

  session.delete(uid);

  // Notify all admins with inline approve/reject buttons
  for (const adminId of config.ADMIN_IDS) {
    try {
      await ctx.telegram.sendMessage(adminId,
        `🆕 <b>New Agent Application</b>\n\n` +
        `Telegram ID: <code>${uid}</code>\n` +
        `Username: @${ctx.from.username || '-'}\n` +
        `Agent Code: <code>${agentCode}</code>\n` +
        `Agent Name: ${name}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Approve', callback_data: `approve_agent_${agentCode}` },
              { text: '❌ Reject', callback_data: `reject_agent_${agentCode}` }
            ]]
          }
        }
      );
    } catch (e) {
      console.error(`[Notify Admin ${adminId}] Failed:`, e.message);
    }
  }

  return ctx.reply(
    `✅ <b>Agent application submitted.</b>\n\n` +
    `Agent Code: <code>${agentCode}</code>\n` +
    `Agent Name: ${name}\n` +
    `Status: Pending Review\n\n` +
    `<i>Please wait for Admin approval.</i>`,
    { parse_mode: 'HTML' }
  );
}

module.exports = { handleSessionMessage, handleSessionCallback };
