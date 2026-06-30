/**
 * Game Account API Service
 *
 * Checks whether a submitted Game ID is registered in the WJ Safety backend.
 *
 * Phase 1 (disabled): GAME_ACCOUNT_API_ENABLED=false → no external calls,
 *   returns { status: 'submitted', source: 'disabled' } immediately.
 *
 * Phase 2 (enabled):  GAME_ACCOUNT_API_ENABLED=true  → calls
 *   GET https://www.wj-safety.com/tac/api/relay/get/player-search-non-bankcard
 *   with query params and header-based auth (no cookies).
 */

const config = require('../config');

/**
 * Status values:
 *   submitted       – API not called (disabled mode, current behavior)
 *   verified        – Game ID found in WJ backend (success === true, total > 0)
 *   not_registered  – Game ID NOT found (success === true, total === 0)
 *   api_error       – network error / timeout / bad response
 */

// ── Disabled mode (Phase 1 compat) ──

function disabledResult(gameId) {
  return {
    status: 'submitted',
    exists: null,
    gameId,
    checkedAt: new Date().toISOString(),
    source: 'disabled',
  };
}

// ── Response parsers ──

function parseVerified(data, gameId) {
  const list = data.value?.list;
  const first = Array.isArray(list) && list.length > 0 ? list[0] : null;
  return {
    status: 'verified',
    exists: true,
    gameId,
    checkedAt: new Date().toISOString(),
    source: 'wj-api',
    customerId: first?.customerId ?? null,
    customerName: first?.customerName ?? null,
    total: data.value?.total ?? 0,
    raw: data,
  };
}

function parseNotRegistered(data, gameId) {
  return {
    status: 'not_registered',
    exists: false,
    gameId,
    checkedAt: new Date().toISOString(),
    source: 'wj-api',
    total: 0,
    raw: data,
  };
}

function apiErrorResult(gameId, error) {
  return {
    status: 'api_error',
    exists: null,
    gameId,
    checkedAt: new Date().toISOString(),
    source: 'wj-api',
    error: String(error),
  };
}

// ── WJ API call ──

async function callWjApi(gameId) {
  const params = new URLSearchParams();
  params.set('merchantCode', config.GAME_ACCOUNT_API_MERCHANT_CODE);
  params.set('isWildcard', 'false');
  params.set('size', '10');
  params.set('page', '1');
  params.set('sortType', 'desc');
  params.set('pageable', 'true');
  params.set('data', gameId);
  params.set('searchCode', 'USERNAME');

  const url = `${config.GAME_ACCOUNT_API_URL}?${params.toString()}`;

  const headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'authorization': config.GAME_ACCOUNT_API_AUTHORIZATION,
    'environment': config.GAME_ACCOUNT_API_ENVIRONMENT,
    'language': config.GAME_ACCOUNT_API_LANGUAGE,
    'merchant': config.GAME_ACCOUNT_API_MERCHANT_CODE,
    'merchantcode': config.GAME_ACCOUNT_API_MERCHANT_CODE,
    'notpending': config.GAME_ACCOUNT_API_NOTPENDING,
    'platform': config.GAME_ACCOUNT_API_PLATFORM,
  };

  // Optional headers — only sent when non-empty (anti-403)
  if (config.GAME_ACCOUNT_API_REFERER) headers['referer'] = config.GAME_ACCOUNT_API_REFERER;
  if (config.GAME_ACCOUNT_API_ORIGIN) headers['origin'] = config.GAME_ACCOUNT_API_ORIGIN;
  if (config.GAME_ACCOUNT_API_COOKIE) headers['cookie'] = config.GAME_ACCOUNT_API_COOKIE;
  if (config.GAME_ACCOUNT_API_USER_AGENT) headers['user-agent'] = config.GAME_ACCOUNT_API_USER_AGENT;
  if (config.GAME_ACCOUNT_API_TAC_TRACE_ID) headers['tac-trace-id'] = config.GAME_ACCOUNT_API_TAC_TRACE_ID;

  const signal = AbortSignal.timeout(config.GAME_ACCOUNT_API_TIMEOUT_MS);

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal,
  });

  if (!response.ok) {
    let bodySnippet = '';
    try {
      const text = await response.text();
      bodySnippet = text.slice(0, 500);
    } catch (_) { /* ignore body read errors */ }
    console.error(`[GameAccountAPI] HTTP ${response.status} body: ${bodySnippet}`);
    throw new Error(`WJ API returned HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data || typeof data.success === 'undefined') {
    console.error('[GameAccountAPI] Unrecognized response:', JSON.stringify(data).slice(0, 500));
    throw new Error('WJ API returned unrecognized response structure');
  }

  return data;
}

// ── Public API ──

/**
 * Check a Game ID against the WJ backend.
 *
 * @param {string} gameId — Normalized Game ID (already trimmed & uppercased by caller)
 * @returns {Promise<object>}
 *   { status: 'submitted'|'verified'|'not_registered'|'api_error',
 *     exists: boolean|null, gameId, checkedAt, source, ... }
 */
async function checkGameAccount(gameId) {
  // ── Disabled mode: no external calls ──
  if (!config.GAME_ACCOUNT_API_ENABLED) {
    return disabledResult(gameId);
  }

  // ── Guard: require essential config ──
  const missing = [];
  if (!config.GAME_ACCOUNT_API_URL) missing.push('URL');
  if (!config.GAME_ACCOUNT_API_MERCHANT_CODE) missing.push('MERCHANT_CODE');
  if (!config.GAME_ACCOUNT_API_AUTHORIZATION) missing.push('AUTHORIZATION');
  if (!config.GAME_ACCOUNT_API_ENVIRONMENT) missing.push('ENVIRONMENT');
  if (!config.GAME_ACCOUNT_API_PLATFORM) missing.push('PLATFORM');
  if (missing.length > 0) {
    const msg = `missing config: ${missing.join(', ')}`;
    console.error(`[GameAccountAPI] ${msg}`);
    return apiErrorResult(gameId, msg);
  }

  // ── Call WJ API ──
  try {
    const data = await callWjApi(gameId);

    if (data.success === true && data.value && data.value.total > 0) {
      return parseVerified(data, gameId);
    }

    if (data.success === true && data.value && data.value.total === 0) {
      return parseNotRegistered(data, gameId);
    }

    // Unrecognized success shape — treat as error
    console.error('[GameAccountAPI] Unexpected response shape:', JSON.stringify(data).slice(0, 500));
    return apiErrorResult(gameId, 'Unrecognized API response');
  } catch (err) {
    console.error('[GameAccountAPI] Error checking Game ID:', gameId, err.message);
    return apiErrorResult(gameId, err.message);
  }
}

module.exports = { checkGameAccount };
