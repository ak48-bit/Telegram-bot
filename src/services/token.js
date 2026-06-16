const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

const TTL_HOURS = config.INVITE_TOKEN_TTL_HOURS || 72;

/**
 * Generate a cryptographically random token. Only SHA-256 hash stored in DB.
 * @param {string} type — 'agent_bind' | 'promoter_bind'
 * @param {string} code — agent_code or promoter_code
 * @param {number} createdBy — creator telegram_id
 * @returns {string} plaintext token (for the link — never stored in DB)
 */
async function createInviteToken(type, code, createdBy) {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

  // Store only hash — plaintext token never persisted
  await db.query(
    `INSERT INTO invite_tokens (token_hash, type, code, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [hash, type, code, createdBy, expiresAt]
  );

  return token;
}

/**
 * Use a binding token — verify hash + type, mark as used.
 * @param {string} plainToken — the raw token from the URL
 * @param {number} telegramId — user's telegram_id
 * @param {string} expectedType — 'agent_bind' | 'promoter_bind'
 * @returns {object} — { type, code, reason } where reason is 'ok'|'used'|'expired'|'type_mismatch'|'invalid'
 */
async function useInviteToken(plainToken, telegramId, expectedType) {
  const hash = crypto.createHash('sha256').update(plainToken).digest('hex');
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `SELECT * FROM invite_tokens
       WHERE token_hash = $1 AND type = $2 AND is_used = FALSE AND expires_at > NOW()
       FOR UPDATE`,
      [hash, expectedType]
    );

    if (res.rows.length === 0) {
      // Check why: used, expired, or type mismatch
      const check = await client.query(
        `SELECT is_used, type, expires_at FROM invite_tokens WHERE token_hash = $1`, [hash]
      );
      await client.query('ROLLBACK');
      if (check.rows.length === 0) return { type: null, code: null, reason: 'invalid' };
      const r = check.rows[0];
      if (r.is_used) return { type: null, code: null, reason: 'used' };
      if (new Date(r.expires_at) <= new Date()) return { type: null, code: null, reason: 'expired' };
      return { type: null, code: null, reason: 'type_mismatch' };
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
