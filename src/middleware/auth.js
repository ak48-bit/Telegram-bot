const db = require('../db');
const config = require('../config');

/**
 * 确保用户已在 users 表中注册
 */
async function ensureUser(ctx, next) {
  if (!ctx.from) return next();
  const { id, username, first_name, last_name } = ctx.from;
  try {
    await db.query(
      `INSERT INTO users (telegram_id, username, first_name, last_name, last_seen_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET
         username = COALESCE(EXCLUDED.username, users.username),
         first_name = COALESCE(EXCLUDED.first_name, users.first_name),
         last_name = COALESCE(EXCLUDED.last_name, users.last_name),
         last_seen_at = NOW(),
         updated_at = NOW()`,
      [id, username, first_name, last_name]
    );
    ctx.state.user = await db.query(
      `SELECT * FROM users WHERE telegram_id = $1`, [id]
    ).then(r => r.rows[0]);
  } catch (e) {
    console.error('[ensureUser] DB error:', e.message);
    return ctx.reply('System is temporarily unavailable. Please try again later.').catch(() => {});
  }
  return next();
}

/**
 * 检查用户是否被封禁
 */
async function checkBlocked(ctx, next) {
  if (ctx.state.user?.status === 'blocked') {
    return ctx.reply('🚫 Your account has been blocked。');
  }
  return next();
}

/**
 * 权限中间件工厂
 */
function requireRole(...roles) {
  return async (ctx, next) => {
    const user = ctx.state.user;
    if (!user) return ctx.reply('Please /start first.');
    if (!roles.includes(user.role)) {
      const audit = require('../services/audit');
      audit.log(user.telegram_id, user.role, 'no_permission', null, null, { attempted_roles: roles }).catch(() => {});
      return ctx.reply('No permission.');
    }
    // 额外：检查 agent/promoter 的 status
    if (user.role === 'agent') {
      const ag = await db.query('SELECT status, approval_status FROM agents WHERE telegram_id = $1', [user.telegram_id]);
      if (ag.rows.length === 0) {
        return ctx.reply('Agent profile not found. Please contact Admin.');
      }
      if (ag.rows[0].status === 'blocked') {
        return ctx.reply('🚫 Your Agent account has been blocked.');
      }
      if (ag.rows[0].approval_status === 'pending') {
        const audit = require('../services/audit');
        audit.log(user.telegram_id, 'agent', 'agent_pending_access_denied', 'agent', null).catch(() => {});
        return ctx.reply('Your Agent application is still pending review.');
      }
      if (ag.rows[0].approval_status === 'rejected') {
        const audit = require('../services/audit');
        audit.log(user.telegram_id, 'agent', 'agent_rejected_access_denied', 'agent', null).catch(() => {});
        return ctx.reply('Your Agent application was rejected. Please contact Admin.');
      }
    }
    if (user.role === 'promoter') {
      const pm = await db.query('SELECT status FROM promoters WHERE telegram_id = $1', [user.telegram_id]);
      if (pm.rows.length === 0) {
        return ctx.reply('Promoter profile not found. Please contact Agent.');
      }
      if (pm.rows[0].status === 'blocked') {
        return ctx.reply('🚫 Your Promoter account has been blocked.');
      }
    }
    return next();
  };
}

module.exports = { ensureUser, checkBlocked, requireRole };
