require('dotenv').config();
const { Telegraf } = require('telegraf');
const config = require('./config');
const { initDB } = require('./db');
const { ensureUser, checkBlocked, requireRole } = require('./middleware/auth');
const { handleStart } = require('./handlers/start');
const { handleApplyAgent } = require('./handlers/start');
const {
  handleAdmin, handleAddAgent, handleListAgents, handleListPromoters,
  handleListPlayers, handleBlockAgent, handleBlockPromoter,
  handleChangePlayerOwner, handleExportPlayers,
  handleListPending, handleApproveGame, handleRejectGame,
  handleRelinkAgent, handleResetAgentLink, handleResetPlayerLink,
  handleListAgentApplications, handleApproveAgent, handleRejectAgent,
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

bot.use(ensureUser);
bot.use(checkBlocked);

// Generic
bot.start(handleStart);
bot.command('apply_agent', async (ctx) => {
  return handleApplyAgent(ctx, ctx.from.id);
});
bot.command('ping', async (ctx) => {
  return ctx.reply('pong 🚀 deploy=' + require('../package.json').version);
});
bot.command('my', requireRole('player', 'admin', 'agent', 'promoter'), handlePlayerMy);

// Admin
bot.command('admin', requireRole('admin'), handleAdmin);
bot.command('add_agent', requireRole('admin'), handleAddAgent);
bot.command('list_agents', requireRole('admin'), handleListAgents);
bot.command('list_promoters', requireRole('admin'), handleListPromoters);
bot.command('list_players', requireRole('admin'), handleListPlayers);
bot.command('block_agent', requireRole('admin'), handleBlockAgent);
bot.command('block_promoter', requireRole('admin'), handleBlockPromoter);
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

// Session middleware — intercept messages when user is in a step-by-step flow
const session = require('./services/session');
const { handleSessionMessage, handleSessionCallback } = require('./handlers/session');

bot.use(async (ctx, next) => {
  if (ctx.callbackQuery) return next(); // let callback handler deal with it
  if (!ctx.message || !ctx.message.text) return next();
  const uid = ctx.from?.id;
  if (!uid) return next();
  const s = session.get(uid);
  if (s) {
    return handleSessionMessage(ctx, s);
  }
  return next();
});

// /cancel
bot.command('cancel', async (ctx) => {
  const uid = ctx.from.id;
  if (session.has(uid)) {
    session.delete(uid);
    return ctx.reply('Cancelled.');
  }
  return ctx.reply('No active session to cancel.');
});

// /help
bot.command('help', async (ctx) => {
  const user = ctx.state.user;
  const isAdmin = config.ADMIN_IDS.includes(ctx.from.id);
  let text = '';
  if (isAdmin) {
    text = '<b>Admin Commands:</b>\n/admin /add_agent /list_agents /list_promoters /list_players\n/list_agent_applications /approve_agent /reject_agent\n/block_agent /block_promoter /change_player_owner\n/export_players /list_pending /approve_game /reject_game\n/relink_agent /reset_agent_link /reset_player_link\n';
  }
  if (user.role === 'agent') {
    text += '\n<b>Agent Commands:</b>\n/agent /add_promoter /list_my_promoters /list_my_players\n/set_agent_link /my_agent_link /relink_pm /export_my_players\n/update_promoter_link &lt;code&gt; &lt;link&gt; — Update promoter link\n';
  }
  if (user.role === 'promoter') {
    text += '\n<b>Promoter Commands:</b>\n/promoter — View panel\n/my_link — View your link\n/share — Get sharing message\n/my_players — View summary\n/my_today — View today stats\n';
  }
  text += '\n<b>Player Commands:</b>\n/submit /my\n';
  text += '\n<b>General:</b>\n/start apply_agent — Apply to become an Agent\n/cancel — Cancel current action';
  return ctx.reply(text, { parse_mode: 'HTML' });
});

// Callback handler for Confirm/Cancel inline buttons
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  if (data === 'session_confirm' || data === 'session_cancel') {
    return handleSessionCallback(ctx);
  }
  // Pass through to existing callback handlers
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

// Startup
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
    app.get('/debug', async (_, res) => {
      try {
        const { query } = require('./db');
        const r = await query('SELECT NOW() as now, (SELECT COUNT(*) FROM users) as users');
        res.json({ ok: true, db: 'connected', time: r.rows[0].now, users: r.rows[0].users });
      } catch (e) {
        res.json({ ok: false, db: 'error: ' + e.message });
      }
    });
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
