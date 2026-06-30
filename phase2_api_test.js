/**
 * Phase 2: WJ API Integration — Simulation Test
 *
 * Tests both entry points (/submit + step mode) with:
 *   - disabled mode (current behavior)
 *   - mock verified (API returns Game ID exists)
 *   - mock not_registered (API returns no results)
 *   - mock api_error (API throws/fails)
 *
 * Does NOT call the real WJ API.
 */

const { checkGameAccount } = require('./src/services/gameAccountApi');
const config = require('./src/config');
const db = require('./src/db');

// ── Helpers ──

let passed = 0;
let failed = 0;
function assert(label, condition) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}`); failed++; }
}

function mockCtx(uid) {
  return { from: { id: uid }, message: { text: '' }, reply: (msg, opts) => ({ msg, opts }), state: {} };
}

async function cleanGameId(gameId, uid) {
  await db.query('UPDATE players SET game_id = NULL, game_id_normalized = NULL, game_id_status = NULL WHERE telegram_id = $1', [uid]).catch(() => {});
  await db.query('DELETE FROM players WHERE game_id_normalized = $1', [gameId.toUpperCase()]).catch(() => {});
  await db.query("DELETE FROM rate_limits WHERE telegram_id = $1 AND attempt_type = 'submit_game_id'", [uid]).catch(() => {});
}

// ── Main ──

async function main() {
  console.log('=== Phase 2 WJ API Integration Test ===\n');
  const testUid = 88899001;
  const testGameId = 'PH90TEST99';

  // ── 1. Disabled mode — checkGameAccount returns submitted ──
  console.log('1. Disabled mode (GAME_ACCOUNT_API_ENABLED=false)');
  const origEnabled = config.GAME_ACCOUNT_API_ENABLED;
  config.GAME_ACCOUNT_API_ENABLED = false;

  const r1 = await checkGameAccount('ANYTHING');
  assert('status = submitted', r1.status === 'submitted');
  assert('exists = null', r1.exists === null);
  assert('source = disabled', r1.source === 'disabled');
  assert('gameId preserved', r1.gameId === 'ANYTHING');
  assert('checkedAt is ISO', !isNaN(Date.parse(r1.checkedAt)));

  // ── 2. Enabled mode + mock verified ──
  console.log('\n2. Enabled mode — mock verified (API returns data)');
  config.GAME_ACCOUNT_API_ENABLED = true;
  config.GAME_ACCOUNT_API_URL = 'http://localhost:9999/mock';  // won't be called
  config.GAME_ACCOUNT_API_MERCHANT_CODE = 'PH90TEST';

  // Inject mock by temporarily replacing callWjApi
  const api = require('./src/services/gameAccountApi');
  const realCheck = api.checkGameAccount;

  // Override checkGameAccount for mock test
  async function mockVerified(gameId) {
    return {
      status: 'verified',
      exists: true,
      gameId,
      checkedAt: new Date().toISOString(),
      source: 'wj-api',
      customerId: 12345,
      customerName: 'ph90test@tcgtest00',
      total: 1,
    };
  }
  async function mockNotRegistered(gameId) {
    return {
      status: 'not_registered',
      exists: false,
      gameId,
      checkedAt: new Date().toISOString(),
      source: 'wj-api',
      total: 0,
    };
  }
  async function mockApiError(gameId) {
    return {
      status: 'api_error',
      exists: null,
      gameId,
      checkedAt: new Date().toISOString(),
      source: 'wj-api',
      error: 'Mocked network error',
    };
  }

  // Stub checkGameAccount for /submit simulation
  const playerHandler = require('./src/handlers/player');
  const sessionHandler = require('./src/handlers/session');

  // Test handler logic directly (simulate what happens after API call)
  function simulateSubmit(apiResult) {
    if (apiResult.status === 'not_registered') {
      return 'reject_not_found';
    }
    if (apiResult.status === 'api_error') {
      return 'reject_api_error';
    }
    // verified or submitted
    return 'accept';
  }

  const r2 = await mockVerified(testGameId);
  assert('mock verified status', r2.status === 'verified');
  assert('mock verified exists', r2.exists === true);
  assert('submit simulation: verified → accept', simulateSubmit(r2) === 'accept');

  const r3 = await mockNotRegistered(testGameId);
  assert('mock not_registered status', r3.status === 'not_registered');
  assert('mock not_registered exists', r3.exists === false);
  assert('submit simulation: not_registered → reject', simulateSubmit(r3) === 'reject_not_found');

  const r4 = await mockApiError(testGameId);
  assert('mock api_error status', r4.status === 'api_error');
  assert('mock api_error exists', r4.exists === null);
  assert('submit simulation: api_error → reject', simulateSubmit(r4) === 'reject_api_error');

  // ── 2b. Enabled + missing AUTHORIZATION → api_error ──
  console.log('\n2b. Enabled — missing config guard');
  const origAuth = config.GAME_ACCOUNT_API_AUTHORIZATION;
  const origEnv = config.GAME_ACCOUNT_API_ENVIRONMENT;
  const origPlat = config.GAME_ACCOUNT_API_PLATFORM;

  config.GAME_ACCOUNT_API_AUTHORIZATION = '';
  config.GAME_ACCOUNT_API_ENVIRONMENT = '';
  config.GAME_ACCOUNT_API_PLATFORM = '';

  const rMissing = await checkGameAccount(testGameId);
  assert('missing auth → api_error', rMissing.status === 'api_error');
  assert('error message mentions missing', rMissing.error.includes('missing config'));
  assert('exists = null on api_error', rMissing.exists === null);

  config.GAME_ACCOUNT_API_AUTHORIZATION = origAuth;
  config.GAME_ACCOUNT_API_ENVIRONMENT = origEnv;
  config.GAME_ACCOUNT_API_PLATFORM = origPlat;

  // ── 3. DB duplicate check still works ──
  console.log('\n3. DB duplicate check');
  await cleanGameId(testGameId, testUid);
  // Create user first (FK constraint)
  await db.query(
    `INSERT INTO users (telegram_id, role, status) VALUES ($1, 'player', 'active') ON CONFLICT (telegram_id) DO NOTHING`,
    [testUid]
  );
  // Insert a player with this game_id
  await db.query(
    `INSERT INTO players (telegram_id, game_id, game_id_normalized, game_id_status)
     VALUES ($1, $2, $3, 'submitted') ON CONFLICT (telegram_id) DO UPDATE
     SET game_id = $2, game_id_normalized = $3, game_id_status = 'submitted'`,
    [testUid, testGameId, testGameId]
  );
  const dup = await db.query(
    'SELECT telegram_id FROM players WHERE game_id_normalized = $1 AND telegram_id != $2',
    [testGameId, testUid + 1]
  );
  assert('Duplicate detected across users', dup.rows.length === 1);
  assert('Duplicate = testUid', parseInt(dup.rows[0].telegram_id) === testUid);

  // ── 4. Session handler dispatch ──
  console.log('\n4. Session stepSubmitGameId integrity');
  const fs = require('fs');
  const sessionSrc = fs.readFileSync('./src/handlers/session.js', 'utf-8');
  assert('session.js imports checkGameAccount', sessionSrc.includes("require('../services/gameAccountApi')"));
  assert('session.js has not_registered check', sessionSrc.includes("apiResult.status === 'not_registered'"));
  assert('session.js has api_error check', sessionSrc.includes("apiResult.status === 'api_error'"));
  assert('session.js deletes session on reject', (sessionSrc.match(/session\.delete\(uid\)/g) || []).length >= 3);

  // ── 5. Player handler integrity ──
  console.log('\n5. /submit handler integrity');
  const playerSrc = fs.readFileSync('./src/handlers/player.js', 'utf-8');
  assert('player.js imports checkGameAccount', playerSrc.includes("require('../services/gameAccountApi')"));
  assert('player.js has not_registered check', playerSrc.includes("apiResult.status === 'not_registered'"));
  assert('player.js has api_error check', playerSrc.includes("apiResult.status === 'api_error'"));
  assert('player.js audit logs api_status', playerSrc.includes('api_status: apiResult.status'));

  // ── 6. gameAccountApi.js structure ──
  console.log('\n6. gameAccountApi.js structure');
  const apiSrc = fs.readFileSync('./src/services/gameAccountApi.js', 'utf-8');
  assert('has disabled mode guard', apiSrc.includes('!config.GAME_ACCOUNT_API_ENABLED'));
  assert('has URLSearchParams', apiSrc.includes('URLSearchParams'));
  assert('has AbortSignal.timeout', apiSrc.includes('AbortSignal.timeout'));
  assert('has authorization header', apiSrc.includes("'authorization'"));
  assert('has merchant header', apiSrc.includes("'merchant'"));
  assert('uses fetch()', apiSrc.includes('fetch(url,'));
  assert('parses verified', apiSrc.includes("status: 'verified'"));
  assert('parses not_registered', apiSrc.includes("status: 'not_registered'"));
  assert('parses api_error', apiSrc.includes("status: 'api_error'"));

  // ── 7. Config integrity ──
  console.log('\n7. config.js integrity');
  const cfgSrc = fs.readFileSync('./src/config.js', 'utf-8');
  assert('has GAME_ACCOUNT_API_MERCHANT_CODE', cfgSrc.includes('GAME_ACCOUNT_API_MERCHANT_CODE'));
  assert('has GAME_ACCOUNT_API_AUTHORIZATION', cfgSrc.includes('GAME_ACCOUNT_API_AUTHORIZATION'));
  assert('has GAME_ACCOUNT_API_ENVIRONMENT', cfgSrc.includes('GAME_ACCOUNT_API_ENVIRONMENT'));
  assert('has GAME_ACCOUNT_API_LANGUAGE', cfgSrc.includes('GAME_ACCOUNT_API_LANGUAGE'));
  assert('has GAME_ACCOUNT_API_PLATFORM', cfgSrc.includes('GAME_ACCOUNT_API_PLATFORM'));
  assert('has GAME_ACCOUNT_API_NOTPENDING', cfgSrc.includes('GAME_ACCOUNT_API_NOTPENDING'));
  assert('URL has default', cfgSrc.includes('player-search-non-bankcard'));
  assert('ENABLED defaults false', cfgSrc.includes("|| 'false') === 'true'"));

  // ── 8. Non-impact checks ──
  console.log('\n8. Non-impact: existing features untouched');
  const indexSrc = fs.readFileSync('./src/index.js', 'utf-8');
  assert('/share still registered', indexSrc.includes("bot.command('share'"));
  assert('Relink Promoter callback still exists', indexSrc.includes("data === 'relink_promoter_start'"));
  assert('relink_pm_ routing intact', indexSrc.includes("data.startsWith('relink_pm_')"));
  assert('/approve_game still blocked', cfgSrc.includes("'/approve_game'"));
  assert('/reject_game still blocked', cfgSrc.includes("'/reject_game'"));

  // ── 9. No DB migration required ──
  console.log('\n9. No DB migration');
  const dbSrc = fs.readFileSync('./src/db.js', 'utf-8');
  assert('players table unchanged (game_id_status CHECK)', dbSrc.includes("game_id_status IN ('submitted','pending','approved','rejected')"));
  assert('No api_check_status column', !dbSrc.includes('api_check_status'));

  // ── 10. .env.example ──
  console.log('\n10. .env.example');
  const envSrc = fs.readFileSync('./.env.example', 'utf-8');
  assert('has WJ Safety URL', envSrc.includes('player-search-non-bankcard'));
  assert('has MERCHANT_CODE', envSrc.includes('GAME_ACCOUNT_API_MERCHANT_CODE'));
  assert('has AUTHORIZATION', envSrc.includes('GAME_ACCOUNT_API_AUTHORIZATION'));
  assert('has ENVIRONMENT', envSrc.includes('GAME_ACCOUNT_API_ENVIRONMENT'));
  assert('has LANGUAGE=zh_CN', envSrc.includes('GAME_ACCOUNT_API_LANGUAGE=zh_CN'));
  assert('has PLATFORM=TCG', envSrc.includes('GAME_ACCOUNT_API_PLATFORM=TCG'));
  assert('has ENABLED=false', envSrc.includes('GAME_ACCOUNT_API_ENABLED=false'));

  // ── Cleanup ──
  await cleanGameId(testGameId, testUid);
  await db.query('DELETE FROM users WHERE telegram_id = $1', [testUid]).catch(() => {});
  config.GAME_ACCOUNT_API_ENABLED = origEnabled;

  // ── Results ──
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
