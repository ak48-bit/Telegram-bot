/**
 * Platform Game Registration Check Service
 *
 * Called AFTER a player submits their Game ID. Queries the WJ Safety backend
 * to determine whether the Game ID is registered, then updates the player's
 * DB record with the result.
 *
 * Does NOT block submission — always returns a result, never throws.
 */

const config = require('../config');
const db = require('../db');

const API_URL = 'https://www.wj-safety.com/tac/api/relay/get/player-search-non-bankcard';
const API_TIMEOUT_MS = 10000;

/**
 * Check a Game ID against the WJ backend and return a standardized result.
 *
 * @param {string} gameId
 * @returns {Promise<object>} { status, customerId?, customerName?, nickname?, activeFlag?, error? }
 */
async function checkGameRegistration(gameId) {
  // Guard: credentials missing → pending_check
  if (!config.WJ_API_AUTHORIZATION) {
    return { status: 'pending_check', error: 'WJ_API_AUTHORIZATION not configured' };
  }

  const params = new URLSearchParams();
  params.set('merchantCode', 'ph90tlbf5');
  params.set('isWildcard', 'false');
  params.set('size', '10');
  params.set('page', '1');
  params.set('sortType', 'desc');
  params.set('pageable', 'true');
  params.set('data', gameId);
  params.set('searchCode', 'USERNAME');

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Authorization': config.WJ_API_AUTHORIZATION,
  };
  if (config.WJ_API_COOKIE) headers['Cookie'] = config.WJ_API_COOKIE;

  const signal = AbortSignal.timeout(API_TIMEOUT_MS);

  try {
    const response = await fetch(API_URL + '?' + params.toString(), {
      method: 'GET',
      headers,
      signal,
    });

    if (!response.ok) {
      console.error(`[PlatformCheck] HTTP ${response.status} for ${gameId}`);
      return { status: 'api_error', error: `HTTP ${response.status}` };
    }

    const data = await response.json();

    if (data.success === true && data.value && data.value.total > 0 && Array.isArray(data.value.list) && data.value.list.length > 0) {
      const first = data.value.list[0];
      return {
        status: 'registered',
        customerId: first.customerId != null ? String(first.customerId) : null,
        customerName: first.customerName || null,
        nickname: first.nickname || null,
        activeFlag: first.activeFlag != null ? String(first.activeFlag) : null,
        raw: data,
      };
    }

    if (data.success === true && data.value && data.value.total === 0) {
      return { status: 'not_found', raw: data };
    }

    // Unexpected shape
    console.error('[PlatformCheck] Unexpected response:', JSON.stringify(data).slice(0, 300));
    return { status: 'api_error', error: 'Unexpected response shape' };
  } catch (err) {
    console.error('[PlatformCheck] Error:', err.message);
    return { status: 'api_error', error: err.message };
  }
}

/**
 * Check registration AND persist result to DB for a player.
 *
 * @param {number|string} telegramId
 * @param {string} gameId
 */
async function checkAndPersistRegistration(telegramId, gameId) {
  const result = await checkGameRegistration(gameId);

  try {
    await db.query(
      `UPDATE players SET
         registration_status = $1,
         registration_checked_at = NOW(),
         platform_customer_id = $2,
         platform_customer_name = $3,
         platform_nickname = $4,
         platform_active_flag = $5,
         registration_error = $6,
         registration_raw_response = $7
       WHERE telegram_id = $8`,
      [
        result.status,
        result.customerId || null,
        result.customerName || null,
        result.nickname || null,
        result.activeFlag || null,
        result.error || null,
        result.raw ? JSON.stringify(result.raw) : null,
        telegramId,
      ]
    );
  } catch (e) {
    console.error('[PlatformCheck] DB update failed:', e.message);
  }

  return result;
}

/**
 * Manual check — returns result and syncs the player's DB record if found.
 *
 * @param {string} gameId
 * @returns {Promise<object>} { result, syncedPlayers }
 */
async function manualCheck(gameId) {
  const result = await checkGameRegistration(gameId);

  // Sync any players with this game_id_normalized
  const players = await db.query(
    'SELECT telegram_id FROM players WHERE game_id_normalized = $1',
    [gameId.toUpperCase()]
  );

  for (const p of players.rows) {
    try {
      await db.query(
        `UPDATE players SET
           registration_status = $1,
           registration_checked_at = NOW(),
           platform_customer_id = $2,
           platform_customer_name = $3,
           platform_nickname = $4,
           platform_active_flag = $5,
           registration_error = $6,
           registration_raw_response = $7
         WHERE telegram_id = $8`,
        [
          result.status,
          result.customerId || null,
          result.customerName || null,
          result.nickname || null,
          result.activeFlag || null,
          result.error || null,
          result.raw ? JSON.stringify(result.raw) : null,
          p.telegram_id,
        ]
      );
    } catch (e) {
      console.error('[PlatformCheck] Sync failed for', p.telegram_id, e.message);
    }
  }

  return { result, syncedPlayers: players.rows.length };
}

module.exports = { checkGameRegistration, checkAndPersistRegistration, manualCheck };
