require('dotenv').config();
const { Telegraf } = require('telegraf');
const config = require('./config');
const { initDB } = require('./db');
const { ensureUser, checkBlocked, requireRole } = require('./middleware/auth');
const { handleStart } = require('./handlers/start');
const { handleApplyAgent } = require('./handlers/start');
const {
  handleAdmin, handleAddAgent, handleListAgents, handleListPromoters,
  handleListPlayers, handleBlockAgent, handleBlockPromoter, handleBlockPlayer,
  handleUnblockAgent, handleUnblockPromoter, handleUnblockPlayer,
  handleChangePlayerOwner, handleExportPlayers,
  handleListPending, handleApproveGame, handleRejectGame,
  handleRelinkAgent, handleResetAgentLink, handleResetPlayerLink,
  handleListAgentApplications, handleApproveAgent, handleRejectAgent,
  handleApproveAgentCb, handleRejectAgentCb,
  handleSystemStatus, handleAuditRecent,
  handleFindPlayer, handleFindPromoter, handleFindAgent,
  handleAdminPanelButtons,
} = require('./handlers/admin');
const {
  handleAgent, handleAddPromoter, handleListMyPromoters,
  handleListMyPlayers, handleExportMyPlayers, handleRelinkPromoter,
  handleSetAgentLink, handleMyAgentLink, handleAgentSetPromoCompat,
  handleUpdatePromoterLink,
} = require('./handlers/agent');
const {
  handlePromoter, handleMyLink, handleMyPlayers, handleMyToday,
  handleSetPlayerLink, handleSetPromoCompat, handleShare,
} = require('./handlers/promoter');
const { handleSubmit, handlePlayerMy } = require('./handlers/player');

const bot = new Telegraf(config.BOT_TOKEN);
const startupTime = new Date().toISOString();

bot.use(ensureUser);
bot.use(checkBlocked);

// Generic
bot.start(handleStart);
bot.command('apply_agent', async (ctx) => {
  return handleApplyAgent(ctx, ctx.from.id);
});
bot.command('ping', async (ctx) => ctx.reply('pong 🚀'));
bot.command('my', requireRole('player', 'admin', 'agent', 'promoter'), handlePlayerMy);

// Admin
bot.command('admin', requireRole('admin'), handleAdmin);
bot.command('add_agent', requireRole('admin'), handleAddAgent);
bot.command('list_agents', requireRole('admin'), handleListAgents);
bot.command('list_promoters', requireRole('admin'), handleListPromoters);
bot.command('list_players', requireRole('admin'), handleListPlayers);
bot.command('block_agent', requireRole('admin'), handleBlockAgent);
bot.command('block_promoter', requireRole('admin'), handleBlockPromoter);
bot.command('block_player', requireRole('admin'), handleBlockPlayer);
bot.command('unblock_agent', requireRole('admin'), handleUnblockAgent);
bot.command('unblock_promoter', requireRole('admin'), handleUnblockPromoter);
bot.command('unblock_player', requireRole('admin'), handleUnblockPlayer);
bot.command('change_player_owner', requireRole('admin'), handleChangePlayerOwner);
bot.command('export_players', requireRole('admin'), handleExportPlayers);
bot.command('list_pending', requireRole('admin'), handleListPending);
bot.command('approve_game', requireRole('admin'), handleApproveGame);
bot.command('reject_game', requireRole('admin'), handleRejectGame);
bot.command('relink_agent', requireRole('admin'), handleRelinkAgent);
bot.command('reset_agent_link', requireRole('admin'), handleResetAgentLink);
bot.command('reset_player_link', requireRole('admin'), handleResetPlayerLink);
bot.command('list_agent_applications', requireRole('admin'), handleListAgentApplications);
bot.command('approve_agent', requireRole('admin'), handleApproveAgent);
bot.command('reject_agent', requireRole('admin'), handleRejectAgent);
bot.command('system_status', requireRole('admin'), handleSystemStatus);
bot.command('audit_recent', requireRole('admin'), handleAuditRecent);
bot.command('find_player', requireRole('admin'), handleFindPlayer);
bot.command('find_promoter', requireRole('admin'), handleFindPromoter);
bot.command('find_agent', requireRole('admin'), handleFindAgent);

// Agent
bot.command('agent', requireRole('agent'), handleAgent);
bot.command('add_promoter', requireRole('agent'), handleAddPromoter);
bot.command('list_my_promoters', requireRole('agent'), handleListMyPromoters);
bot.command('list_my_players', requireRole('agent'), handleListMyPlayers);
bot.command('export_my_players', requireRole('agent'), handleExportMyPlayers);
bot.command('relink_pm', requireRole('agent'), handleRelinkPromoter);
bot.command('set_agent_link', requireRole('agent'), handleSetAgentLink);
bot.command('my_agent_link', requireRole('agent'), handleMyAgentLink);
bot.command('update_promoter_link', requireRole('agent'), handleUpdatePromoterLink);

// Agent + Promoter shared legacy
bot.command('set_promo', requireRole('agent', 'promoter'), async (ctx) => {
  if (ctx.state.user.role === 'agent') return handleAgentSetPromoCompat(ctx);
  return handleSetPromoCompat(ctx);
});
bot.command('my_link', requireRole('agent', 'promoter'), async (ctx) => {
  if (ctx.state.user.role === 'agent') return handleMyAgentLink(ctx);
  return handleMyLink(ctx);
});

// Promoter
bot.command('promoter', requireRole('promoter'), handlePromoter);
bot.command('my_players', requireRole('promoter'), handleMyPlayers);
bot.command('my_today', requireRole('promoter'), handleMyToday);
bot.command('set_player_link', requireRole('promoter'), handleSetPlayerLink);
bot.command('share', requireRole('promoter'), handleShare);

// Player
bot.command('submit', requireRole('player', 'admin', 'agent', 'promoter'), handleSubmit);

// Session middleware
const session = require('./services/session');
const { handleSessionMessage, handleSessionCallback } = require('./handlers/session');

bot.use(async (ctx, next) => {
  if (ctx.callbackQuery) return next();
  if (!ctx.message || !ctx.message.text) return next();
  const uid = ctx.from?.id;
  if (!uid) return next();
  const s = session.get(uid);
  if (s) {
    try {
      return await handleSessionMessage(ctx, s);
    } catch (e) {
      console.error('[SESSION ERROR]', e.message);
      return ctx.reply('Session error. Please try again.').catch(() => {});
    }
  }
  return next();
});

// /cancel
bot.command('cancel', async (ctx) => {
  const uid = ctx.from.id;
  if (session.has(uid)) {
    session.delete(uid);
    return ctx.reply('Cancelled. Send the command again to restart.');
  }
  return ctx.reply('No active session to cancel.');
});

// /help
bot.command('help', async (ctx) => {
  const user = ctx.state.user;
  const isAdmin = config.ADMIN_IDS.includes(ctx.from.id);
  let text = '';
  if (isAdmin) {
    text = '<b>Admin:</b> /admin /system_status /audit_recent\n/find_player /find_promoter /find_agent\n/add_agent /list_agents /list_promoters /list_players\n/list_agent_applications /approve_agent /reject_agent\n/block_agent /block_promoter /block_player\n/unblock_agent /unblock_promoter /unblock_player\n/change_player_owner /export_players\n/list_pending /approve_game /reject_game\n';
  }
  if (user.role === 'agent') {
    text += '\n<b>Agent:</b> /agent /add_promoter /update_promoter_link\n/list_my_promoters /list_my_players /export_my_players\n/set_agent_link /my_agent_link /relink_pm\n';
  }
  if (user.role === 'promoter') {
    text += '\n<b>Promoter:</b> /promoter /my_link /share /my_players /my_today\n';
  }
  text += '\n<b>Player:</b> /submit /my\n';
  text += '\n<b>General:</b> /start apply_agent /cancel /help';
  return ctx.reply(text, { parse_mode: 'HTML' });
});

// ── Callback Handler ──

// Whitelist enforcement for cmd: callbacks
function isCallbackCommandAllowed(role, cmd) {
  // Block high-risk commands
  if (config.CALLBACK_BLOCKED_COMMANDS.includes(cmd)) return false;
  // Check role whitelist
  const whitelist = config.CALLBACK_COMMAND_WHITELIST[role];
  if (!whitelist) return false;
  return whitelist.includes(cmd);
}

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  const uid = ctx.callbackQuery.from.id;

  if (data === 'session_confirm' || data === 'session_cancel') {
    return handleSessionCallback(ctx);
  }

  // Command buttons: cmd:/agent → whitelist verification + re-auth
  if (data.startsWith('cmd:')) {
    const cmd = data.slice(4);
    // Re-read user from DB for fresh role/status
    const db = require('./db');
    const user = await db.query('SELECT role, status FROM users WHERE telegram_id = $1', [uid]).then(r => r.rows[0]).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('User not found').catch(() => {});
      return;
    }
    if (user.status === 'blocked') {
      await ctx.answerCbQuery('Account blocked').catch(() => {});
      return;
    }
    // Check approval_status for agents
    if (user.role === 'agent') {
      const ag = await db.query('SELECT approval_status FROM agents WHERE telegram_id = $1', [uid]).then(r => r.rows[0]).catch(() => null);
      if (ag?.approval_status === 'pending') {
        await ctx.answerCbQuery('Application pending review').catch(() => {});
        return;
      }
      if (ag?.approval_status === 'rejected') {
        await ctx.answerCbQuery('Application rejected').catch(() => {});
        return;
      }
    }
    // Whitelist check
    if (!isCallbackCommandAllowed(user.role, cmd)) {
      await require('./services/audit').log(uid, user.role, 'callback_blocked', null, cmd);
      await ctx.answerCbQuery('Permission denied').catch(() => {});
      return;
    }
    await ctx.answerCbQuery().catch(() => {});
    // Route via handleUpdate
    const fakeMsg = {
      message_id: ctx.callbackQuery.message.message_id,
      from: ctx.callbackQuery.from,
      chat: ctx.callbackQuery.message.chat,
      date: Math.floor(Date.now() / 1000),
      text: cmd,
      entities: [{ type: 'bot_command', offset: 0, length: cmd.length }]
    };
    return bot.handleUpdate({ update_id: Date.now(), message: fakeMsg });
  }

  // Inline approve/reject agent buttons — re-verify admin
  if (data.startsWith('approve_agent_') || data.startsWith('reject_agent_')) {
    if (!config.ADMIN_IDS.includes(uid)) {
      await ctx.answerCbQuery('Admin only').catch(() => {});
      return;
    }
    await ctx.answerCbQuery().catch(() => {});
    if (data.startsWith('approve_agent_')) {
      return handleApproveAgentCb(ctx, data.replace('approve_agent_', ''));
    }
    return handleRejectAgentCb(ctx, data.replace('reject_agent_', ''));
  }

  // Admin panel buttons
  if (data.startsWith('admin_panel_')) {
    if (!config.ADMIN_IDS.includes(uid)) {
      await ctx.answerCbQuery('Admin only').catch(() => {});
      return;
    }
    await ctx.answerCbQuery().catch(() => {});
    return handleAdminPanelButtons(ctx, data);
  }

  // Players pagination
  if (data.startsWith('players_')) {
    const parts = data.split('_', 3);
    if (parts.length >= 3) {
      const { handleListMyPlayers } = require('./handlers/agent');
      await handleListMyPlayers({ chat: ctx.callbackQuery.message.chat, from: ctx.callbackQuery.from }, parseInt(parts[2]));
    }
  }

  await ctx.answerCbQuery().catch(() => {});
});

// Error
bot.catch((err, ctx) => {
  console.error('[TELEGRAF ERROR]', err.message);
  ctx.reply('System error, please try again later.').catch(() => {});
});

// ── Express App ──
async function start() {
  console.log('[INIT] Connecting to database...');
  await initDB();

  if (config.RENDER_APP_URL) {
    const webhookUrl = `${config.RENDER_APP_URL}/webhook`;
    await bot.telegram.setWebhook(webhookUrl, {
      secret_token: config.SECRET_TOKEN,
      drop_pending_updates: true,
    });
    console.log(`[WEBHOOK] Set to ${webhookUrl}`);

    const express = require('express');
    const app = express();
    app.use(express.json());

    // /health — public, no auth, for UptimeRobot
    app.get('/health', async (_, res) => {
      try {
        const { query } = require('./db');
        await query('SELECT 1');
        res.json({ ok: true, db: 'connected', time: new Date().toISOString(), service: 'PH90 Bonus Bot' });
      } catch (e) {
        res.json({ ok: false, db: 'error', time: new Date().toISOString() });
      }
    });

    // /webhook — requires SECRET_TOKEN
    app.post('/webhook', (req, res) => {
      if (req.headers['x-telegram-bot-api-secret-token'] !== config.SECRET_TOKEN) {
        return res.status(403).json({ ok: false, error: 'unauthorized' });
      }
      res.status(200).json({ ok: true });
      setImmediate(() => {
        bot.handleUpdate(req.body).catch(err => console.error('[WEBHOOK ASYNC]', err.message));
      });
    });

    app.get('/', (_, res) => res.send('Bot is running 24/7 🚀'));
    app.listen(config.PORT, () => console.log(`[START] Webhook server on port ${config.PORT}`));
  } else {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('[START] Polling mode...');
    bot.launch();
  }
}

start().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = { startupTime };
