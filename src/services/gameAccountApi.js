/**
 * Game Account API Service
 *
 * Checks whether a submitted Game ID is:
 *   1. Already registered in the game backend
 *   2. Whether the phone number is verified
 *
 * Phase 1 (current): Mock / disabled mode.
 *   - When GAME_ACCOUNT_API_ENABLED=false, returns a disabled/mock result.
 *   - Does NOT call any external API.
 *   - Does NOT change the current "submitted" record flow.
 *
 * Phase 2 (future): When GAME_ACCOUNT_API_ENABLED=true and a real API
 *   URL / key is configured, replace checkGameAccount() with the real
 *   HTTP call and response parsing.
 */

const config = require('../config');

/**
 * Status values returned by this service (mirrors migration proposal):
 *   submitted               – default, API not called
 *   api_checking            – API call in-flight (future async mode)
 *   verified                – registered + phone verified
 *   registered_unverified   – registered but phone NOT verified
 *   not_registered          – Game ID not found in backend
 *   api_error               – API timeout / network error / invalid response
 */

/**
 * Check a Game ID against the backend account API.
 *
 * Phase 1 behaviour:
 *   - Returns { status: 'submitted', source: 'disabled', ... } immediately.
 *   - If GAME_ACCOUNT_API_ENABLED=true but no real implementation exists,
 *     throws a clear error so no partial data is persisted.
 *
 * @param {string} gameId — Normalized Game ID (already trimmed & uppercased by caller)
 * @returns {Promise<{status: string, gameId: string, checkedAt: string, source: string, registered: boolean|null, phoneVerified: boolean|null}>}
 */
async function checkGameAccount(gameId) {
  if (!config.GAME_ACCOUNT_API_ENABLED) {
    return {
      status: 'submitted',
      gameId,
      checkedAt: new Date().toISOString(),
      source: 'disabled',
      registered: null,
      phoneVerified: null,
    };
  }

  // ── Phase 2: real API call placeholder ──
  // TODO: Replace this block with actual fetch() / axios call.
  //
  // Example (do NOT uncomment until Phase 2):
  //   const response = await fetch(config.GAME_ACCOUNT_API_URL, {
  //     method: config.GAME_ACCOUNT_API_METHOD,
  //     headers: {
  //       'Content-Type': 'application/json',
  //       'Authorization': `Bearer ${config.GAME_ACCOUNT_API_KEY}`,
  //     },
  //     body: JSON.stringify({ game_id: gameId }),
  //     signal: AbortSignal.timeout(config.GAME_ACCOUNT_API_TIMEOUT_MS),
  //   });
  //   if (!response.ok) {
  //     return { status: 'api_error', gameId, ... };
  //   }
  //   const data = await response.json();
  //   return parseApiResponse(data, gameId);

  throw new Error(
    'GAME_ACCOUNT_API_ENABLED=true but no API URL or implementation configured. ' +
    'Set GAME_ACCOUNT_API_URL and GAME_ACCOUNT_API_KEY to proceed to Phase 2.'
  );
}

module.exports = { checkGameAccount };
