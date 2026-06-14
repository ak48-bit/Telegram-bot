require('dotenv').config();
const { Telegraf } = require('telegraf');
const config = require('./config');
const { initDB } = require('./db');
const { ensureUser, checkBlocked, requireRole } = require('./middleware/auth');
const { handleStart } = require('./handlers/start');
const {
  handleAdmin, handleAddAgent, handleListAgents, handleListPromoters,
  handleListPlayers, handleBlockAgent, handleBlockPromoter,
  handleChangePlayerOwner, handleExportPlayers,
  handleListPending, handleApproveGame, handleRejectGame,
} = require('./handlers/admin');
const {
  handleAgent, handleAddPromoter, handleListMyPromoters,
  handleListMyPlayers, handleExportMyPlayers, handleRelinkPromoter,
} = require('./handlers/agent');
const {
  handlePromoter, handleMyLink, handleMyPlayers, handleMyToday, handleSetPromo, handleShare,
} = require('./handlers/promoter');
const { handleSubmit, handlePlayerMy } = require('./handlers/player');

// ── 初始化 Bot ──────────────────────────────────────────────────
const bot = new Telegraf(config.BOT_TOKEN);

// ── 全局中间件 ──────────────────────────────────────────────────
bot.use(ensureUser);
bot.use(checkBlocked);

// ── 通用命令 ─────────────────────────────────────────────────────
bot.start(handleStart);
bot.command('my', requireRole('player', 'admin', 'agent', 'promoter'), handlePlayerMy);

// ── Admin 命令 ───────────────────────────────────────────────────
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

// ── Agent 命令 ───────────────────────────────────────────────────
bot.command('agent', requireRole('agent'), handleAgent);
bot.command('add_promoter', requireRole('agent'), handleAddPromoter);
bot.command('list_my_promoters', requireRole('agent'), handleListMyPromoters);
bot.command('list_my_players', requireRole('agent'), handleListMyPlayers);
bot.command('export_my_players', requireRole('agent'), handleExportMyPlayers);
bot.command('relink_pm', requireRole('agent'), handleRelinkPromoter);

// ── Promoter 命令 ────────────────────────────────────────────────
bot.command('promoter', requireRole('promoter'), handlePromoter);
bot.command('my_link', requireRole('promoter'), handleMyLink);
bot.command('my_players', requireRole('promoter'), handleMyPlayers);
bot.command('my_today', requireRole('promoter'), handleMyToday);
bot.command('set_promo', requireRole('promoter'), handleSetPromo);
bot.command('share', requireRole('promoter'), handleShare);

// ── Player 命令 ──────────────────────────────────────────────────
bot.command('submit', requireRole('player', 'admin', 'agent', 'promoter'), handleSubmit);

// ── 全局错误处理 ────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error('[TELEGRAF ERROR]', err.message);
  ctx.reply('系统错误，请稍后重试。').catch(() => {});
});

// ── 启动 ─────────────────────────────────────────────────────────
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

    // 中间件过滤 webhook (Express-like for Render)
    const express = require('express');
    const app = express();
    app.use(express.json());

    // Webhook 验证
    app.post('/webhook', (req, res) => {
      if (req.headers['x-telegram-bot-api-secret-token'] !== config.SECRET_TOKEN) {
        return res.status(403).json({ ok: false, error: 'unauthorized' });
      }
      // 立即响应 Telegram，避免超时重试
      res.sendStatus(200);
      // 异步处理 update
      setImmediate(() => {
        bot.handleUpdate(req.body).catch(err => console.error('[WEBHOOK ASYNC]', err.message));
      });
    });

    app.get('/', (_, res) => res.send('Bot is running 24/7 🚀'));

    app.listen(config.PORT, () => {
      console.log(`[START] Webhook server on port ${config.PORT}`);
    });
  } else {
    // 本地开发：polling 模式
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('[START] Polling mode...');
    bot.launch();
  }
}

start().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

// 优雅退出
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
