const db = require('../db');
const config = require('../config');

/**
 * 确保用户已在 users 表中注册
 */
async function ensureUser(ctx, next) {
  if (!ctx.from) return next();
  const { id, username, first_name, last_name } = ctx.from;
  await db.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = COALESCE(EXCLUDED.username, users.username),
       first_name = COALESCE(EXCLUDED.first_name, users.first_name),
       last_name = COALESCE(EXCLUDED.last_name, users.last_name),
       updated_at = NOW()`,
    [id, username, first_name, last_name]
  );
  ctx.state.user = await db.query(
    `SELECT * FROM users WHERE telegram_id = $1`, [id]
  ).then(r => r.rows[0]);
  return next();
}

/**
 * 检查用户是否被封禁
 */
async function checkBlocked(ctx, next) {
  if (ctx.state.user?.status === 'blocked') {
    return ctx.reply('🚫 你的账号已被封禁。');
  }
  return next();
}

/**
 * 权限中间件工厂
 */
function requireRole(...roles) {
  return async (ctx, next) => {
    const user = ctx.state.user;
    if (!user) return ctx.reply('请先 /start。');
    if (!roles.includes(user.role)) {
      return ctx.reply('⛔ 你没有权限执行此操作。');
    }
    // 额外：检查 agent/promoter 的 status
    if (user.role === 'agent') {
      const ag = await db.query('SELECT status FROM agents WHERE telegram_id = $1', [user.telegram_id]);
      if (ag.rows.length > 0 && ag.rows[0].status === 'blocked') {
        return ctx.reply('🚫 你的 Agent 账号已被封禁。');
      }
    }
    if (user.role === 'promoter') {
      const pm = await db.query('SELECT status FROM promoters WHERE telegram_id = $1', [user.telegram_id]);
      if (pm.rows.length > 0 && pm.rows[0].status === 'blocked') {
        return ctx.reply('🚫 你的 Promoter 账号已被封禁。');
      }
    }
    return next();
  };
}

module.exports = { ensureUser, checkBlocked, requireRole };
