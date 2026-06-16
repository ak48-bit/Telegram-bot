const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

/**
 * Generate a cryptographically random token and store its SHA-256 hash.
 * @param {string} type — 'agent_bind' | 'promoter_bind'
 * @param {string} code — agent_code or promoter_code
 * @param {number} createdBy — creator telegram_id
 * @returns {string} plaintext token (for the link — never stored in DB)
 */
async function createInviteToken(type, code, createdBy) {
  // 32 bytes = 64 hex chars
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000); // 1 year

  await db.query(
    `INSERT INTO invite_tokens (token, token_hash, type, code, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [token, hash, type, code, createdBy, expiresAt]
  );

  return token;
}

/**
 * Use a binding token — verify hash, mark as used.
 * @param {string} plainToken — the raw token from the URL
 * @param {number} telegramId — user's telegram_id
 * @returns {object|null} — { type, code } or null
 */
async function useInviteToken(plainToken, telegramId) {
  const hash = crypto.createHash('sha256').update(plainToken).digest('hex');
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `SELECT * FROM invite_tokens
       WHERE token_hash = $1 AND is_used = FALSE AND expires_at > NOW()
       FOR UPDATE`,
      [hash]
    );

    if (res.rows.length === 0) {
      // Check if already used (give specific message)
      const used = await client.query(
        `SELECT 1 FROM invite_tokens WHERE token_hash = $1 AND is_used = TRUE`, [hash]
      );
      await client.query('ROLLBACK');
      if (used.rows.length > 0) return { type: null, code: null, reason: 'used' };
      return { type: null, code: null, reason: 'expired' };
    }

    const row = res.rows[0];
    await client.query(
      `UPDATE invite_tokens SET is_used = TRUE, used_by_telegram_id = $1, used_at = NOW()
       WHERE id = $2`,
      [telegramId, row.id]
    );

    await client.query('COMMIT');
    return { type: row.type, code: row.code, reason: 'ok' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { createInviteToken, useInviteToken };
