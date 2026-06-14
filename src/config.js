const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  DATABASE_URL: process.env.DATABASE_URL || '',
  SECRET_TOKEN: process.env.SECRET_TOKEN || 'change_me',
  RENDER_APP_URL: process.env.RENDER_APP_URL || '',
  ALLOWED_DOMAINS: (process.env.ALLOWED_DOMAINS || '').split(',').map(d => d.trim()).filter(Boolean),
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean),
  PORT: parseInt(process.env.PORT || '5000', 10),
  TOKEN_EXPIRY_HOURS: 48,
};

module.exports = config;
