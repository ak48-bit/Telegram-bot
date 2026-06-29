const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  DATABASE_URL: process.env.DATABASE_URL || '',
  SECRET_TOKEN: process.env.SECRET_TOKEN || '',
  RENDER_APP_URL: process.env.RENDER_APP_URL || '',
  ALLOWED_DOMAINS: (process.env.ALLOWED_DOMAINS || '').split(',').map(d => d.trim()).filter(Boolean),
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean),
  GAME_ID_REGEX: process.env.GAME_ID_REGEX || '^[A-Za-z0-9]{3,32}$',
  ENABLE_LEGACY_PLAYER_LINK: (process.env.ENABLE_LEGACY_PLAYER_LINK || 'false') === 'true',
  PORT: parseInt(process.env.PORT || '5000', 10),
  TOKEN_EXPIRY_HOURS: 48,
  INVITE_TOKEN_TTL_HOURS: 72,

  // Agent self-application config
  RESERVED_AGENT_CODES: [
    'admin', 'admin01', 'boss', 'system', 'support', 'official',
    'test', 'root', 'owner', 'ph90', 'agent', 'promoter',
  ],
  AGENT_CODE_REGEX: /^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/,
  AGENT_NAME_REGEX: /^[^\s<>@\/](.{1,28}[^\s<>@\/])?$/,
  AGENT_APPLY_RATE_LIMITS: {
    perMinute: 3,
    perHour: 5,
    perDay: 3,
  },

  // Game ID submit rate limits
  SUBMIT_RATE_LIMITS: {
    perMinute: 3,
    perHour: 10,
  },

  // ── Game Account API (Phase 1: disabled, Phase 2: real API) ──
  GAME_ACCOUNT_API_ENABLED: (process.env.GAME_ACCOUNT_API_ENABLED || 'false') === 'true',
  GAME_ACCOUNT_API_URL: process.env.GAME_ACCOUNT_API_URL || '',
  GAME_ACCOUNT_API_METHOD: process.env.GAME_ACCOUNT_API_METHOD || 'POST',
  GAME_ACCOUNT_API_KEY: process.env.GAME_ACCOUNT_API_KEY || '',
  GAME_ACCOUNT_API_TIMEOUT_MS: parseInt(process.env.GAME_ACCOUNT_API_TIMEOUT_MS || '8000', 10),

  // Command button whitelist — which commands can be triggered via cmd: callback
  CALLBACK_COMMAND_WHITELIST: {
    admin: ['/admin', '/add_agent', '/list_agents', '/list_promoters', '/list_players',
            '/list_agent_applications', '/list_pending',
            '/system_status', '/audit_recent'],
    agent: ['/agent', '/add_promoter', '/list_my_promoters', '/list_my_players',
            '/my_agent_link', '/export_my_players', '/set_agent_link'],
    promoter: ['/promoter', '/my_link', '/share', '/my_players', '/my_today'],
    player: ['/my', '/submit', '/share'],
  },

  // High-risk commands NEVER allowed via cmd: callback (must use dedicated handlers with params)
  CALLBACK_BLOCKED_COMMANDS: [
    '/change_player_owner', '/block_agent', '/block_promoter', '/block_player',
    '/unblock_agent', '/unblock_promoter', '/unblock_player',
    '/reset_agent_link', '/reset_player_link', '/relink_agent', '/relink_pm',
    '/approve_agent', '/reject_agent', '/approve_game', '/reject_game',
    '/export_players', '/broadcast',
  ],

  // Promoter name regex (no spaces)
  PROMOTER_NAME_REGEX: /^[A-Za-z0-9_-]{2,30}$/,

  // Startup time
  STARTUP_TIME: new Date().toISOString(),
};

function validateConfig() {
  const errors = [];
  if (!config.BOT_TOKEN) errors.push('BOT_TOKEN is required');
  if (!config.DATABASE_URL) errors.push('DATABASE_URL is required');
  if (!config.SECRET_TOKEN || config.SECRET_TOKEN === 'change_me') {
    errors.push('SECRET_TOKEN is required and cannot be the default value');
  }
  if (!Array.isArray(config.ADMIN_IDS) || config.ADMIN_IDS.length === 0) {
    errors.push('ADMIN_IDS must contain at least one Telegram ID');
  }
  if (errors.length) {
    throw new Error('[CONFIG ERROR] ' + errors.join('; '));
  }
}

config.validateConfig = validateConfig;

module.exports = config;
