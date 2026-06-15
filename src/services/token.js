const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

/**
 * 生成一次性绑定 token
 * @param {string} type — 'agent_bind' | 'promoter_bind'
 * @param {string} code — agent_code 或 promoter_code
 * @param {number} createdBy — 创建者 telegram_id
 */
async function createInviteToken(type, code, createdBy) {
  const token = crypto.randomBytes(24).toString('hex');
  // 永不过期（10年后），仅一次性使用限制
  const expiresAt = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);

  await db.query(
    `INSERT INTO invite_tokens (token, type, code, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [token, type, code, createdBy, expiresAt]
  );

  return token;
}

/**
 * 使用一次性绑定 token
 * @param {string} token
 * @param {number} telegramId — 使用者 telegram_id
 * @returns {object|null} — { type, code } 或 null
 */
async function useInviteToken(token, telegramId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `SELECT * FROM invite_tokens
       WHERE token = $1 AND is_used = FALSE AND expires_at > NOW()
       FOR UPDATE`,
      [token]
    );

    if (res.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const row = res.rows[0];
    await client.query(
      `UPDATE invite_tokens SET is_used = TRUE, used_by_telegram_id = $1, used_at = NOW()
       WHERE id = $2`,
      [telegramId, row.id]
    );

    await client.query('COMMIT');
    return { type: row.type, code: row.code, createdBy: row.created_by };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { createInviteToken, useInviteToken };
