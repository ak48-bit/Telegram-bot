/**
 * Handles step-by-step input flows using in-memory session.
 * Each command's "old format" handler is called when the step completes.
 */
const session = require('../services/session');
const audit = require('../services/audit');
const { validateAndNormalize } = require('../services/normalize');
const { createInviteToken } = require('../services/token');
const db = require('../db');
const config = require('../config');

const BOT_USERNAME = process.env.BOT_USERNAME || 'PH90WFH_Bonus_bot';
const GAME_ID_REGEX = new RegExp(config.GAME_ID_REGEX);

// ── Main entry: called when user sends text while in a session ──
async function handleSessionMessage(ctx, s) {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();

  // If user sends another /command while in session
  if (text.startsWith('/')) {
    return ctx.reply('You have an unfinished action. Please complete it or send /cancel.');
  }

  switch (s.action) {
    case 'create_agent_code':
      return stepCreateAgentCode(ctx, s, text);
    case 'create_agent_name':
      return stepCreateAgentName(ctx, s, text);
    case 'create_promoter_code':
      return stepCreatePromoterCode(ctx, s, text);
    case 'create_promoter_name':
      return stepCreatePromoterName(ctx, s, text);
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
      await db.query(`INSERT INTO agents (agent_code, name, created_by_admin_id, status) VALUES ($1,$2,$3,'pending')`, [agentCode, name, uid]);
      const token = await createInviteToken('agent_bind', agentCode, uid);
      const link = `https://t.me/${BOT_USERNAME}?start=bind_agent_${token}`;
      await audit.log(uid, 'admin', 'step_create_agent_confirmed', 'agent', agentCode, { name });
      session.delete(uid);
      return ctx.editMessageText(
        `Agent Created Successfully\nAgent Code: ${agentCode}\nName: ${name}\n\nAgent Bot Link:\n${link}\n\n⚠️ One-time use, no expiry.\nAfter binding, use /set_agent_link.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    case 'confirm_create_promoter': {
      const { promoterCode, name, agentId } = s.data;
      const exists = await db.query('SELECT 1 FROM promoters WHERE promoter_code = $1', [promoterCode]);
      if (exists.rows.length > 0) {
        session.delete(uid);
        return ctx.editMessageText('This account already exists.').catch(() => {});
      }
      await db.query(`INSERT INTO promoters (promoter_code, agent_id, name, created_by_agent_id, status) VALUES ($1,$2,$3,$4,'pending')`, [promoterCode, agentId, name, uid]);
      const token = await createInviteToken('promoter_bind', promoterCode, uid);
      const link = `https://t.me/${BOT_USERNAME}?start=bind_promoter_${token}`;
      await audit.log(uid, 'agent', 'step_create_promoter_confirmed', 'promoter', promoterCode, { name });
      session.delete(uid);
      return ctx.editMessageText(
        `Promoter Created Successfully\nPromoter Code: ${promoterCode}\nName: ${name}\n\nPromoter Bot Link:\n${link}\n\n⚠️ One-time use, no expiry. After binding, use /set_player_link.`,
        { parse_mode: 'HTML' }
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
  if (!name) return ctx.reply('Please enter a valid Promoter Name.');
  session.set(ctx.from.id, { ...s, action: 'confirm_create_promoter', data: { ...s.data, name } });
  return ctx.reply(
    `Confirm Create Promoter?\n\nPromoter Code: ${s.data.promoterCode}\nName: ${name}`,
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
  const raw = text.trim();
  const result = validateAndNormalize(raw, config.ALLOWED_DOMAINS);
  if (!result.valid) {
    await audit.log(uid, 'promoter', 'set_player_link_invalid', 'promoter', null, { url: raw });
    session.delete(uid);
    return ctx.reply('Invalid link format.');
  }
  const pm = await db.query('SELECT * FROM promoters WHERE telegram_id = $1', [uid]);
  const promoter = pm.rows[0];
  if (promoter.link_status === 'BOUND' && promoter.player_affiliate_link_normalized) {
    await audit.log(uid, 'promoter', 'set_player_link_duplicate_own', 'promoter', promoter.promoter_code, { url: raw });
    session.delete(uid);
    return ctx.reply('You have already submitted your Player Affiliate Link.');
  }
  const dup = await db.query('SELECT promoter_code FROM promoters WHERE player_affiliate_link_normalized = $1 AND telegram_id != $2', [result.normalized, uid]);
  if (dup.rows.length > 0) {
    await audit.log(uid, 'promoter', 'set_player_link_duplicate_link', 'promoter', promoter.promoter_code, { url: raw });
    session.delete(uid);
    return ctx.reply('This link has already been used.');
  }
  await db.query(`UPDATE promoters SET player_affiliate_link_original = $1, player_affiliate_link_normalized = $2, link_status = 'BOUND', updated_at = NOW() WHERE telegram_id = $3`, [result.original, result.normalized, uid]);
  await audit.log(uid, 'promoter', 'set_player_link_success', 'promoter', promoter.promoter_code, { url: result.normalized });
  session.delete(uid);
  return ctx.reply('Submitted Successfully\nPromoter Link Bound Successfully');
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

module.exports = { handleSessionMessage, handleSessionCallback };
