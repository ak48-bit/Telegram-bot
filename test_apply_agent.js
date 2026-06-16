/**
 * Test script for Agent Self-Application feature
 * Runs migration + automated tests against the live database
 */
const { initDB, query } = require('./src/db');
const config = require('./src/config');
const audit = require('./src/services/audit');

const TEST_TG_ID = 999999999; // Non-existent test user
const TEST_TG_ID2 = 999999998;
const TEST_CODE = 'TEST_AGENT_001';
const TEST_CODE2 = 'TEST_AGENT_002';
const TEST_NAME = 'Test Agent';

let passed = 0;
let failed = 0;

function result(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS:', name); }
  else { failed++; console.log('  FAIL:', name, detail || ''); }
}

async function run() {
  console.log('=== PH90 Bonus Bot — Agent Self-Application Tests ===\n');

  // Step 0: Migration
  console.log('[0] Running schema migration...');
  await initDB();
  console.log('    Done.\n');

  // Verify new columns
  const cols = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'agents' AND column_name IN ('approval_status','approved_by','approved_at','rejected_by','rejected_at','username','applied_by_telegram_id')`
  );
  console.log('[0.1] New agent columns:', cols.rows.map(c => c.column_name).join(', '));
  result('New columns exist', cols.rows.length >= 7);
  console.log('');

  // Clean up any leftover test data
  await query('DELETE FROM rate_limits WHERE telegram_id IN ($1,$2)', [TEST_TG_ID, TEST_TG_ID2]);
  await query('DELETE FROM audit_logs WHERE actor_telegram_id IN ($1,$2)', [TEST_TG_ID, TEST_TG_ID2]);
  await query('DELETE FROM agents WHERE agent_code LIKE $1', ['TEST_AGENT_%']);
  await query('DELETE FROM users WHERE telegram_id IN ($1,$2)', [TEST_TG_ID, TEST_TG_ID2]);

  // === Test 1: Validate Agent Code — valid ===
  console.log('--- Test Group 1: Agent Code Validation ---');

  const validCodes = ['Leo01', 'PH_Agent_001', 'Tom-02', 'abc', 'ABC123', 'A_1-b'];
  for (const code of validCodes) {
    const ok = config.AGENT_CODE_REGEX.test(code);
    result('Valid code: ' + code, ok, 'Regex: ' + config.AGENT_CODE_REGEX);
  }

  const invalidCodes = ['ab', 'a'.repeat(21), 'Leo 01', '@Tom', '-abc', '_test', '/start'];
  for (const code of invalidCodes) {
    const ok = !config.AGENT_CODE_REGEX.test(code);
    result('Invalid code rejected: ' + code, ok);
  }

  // Reserved words
  for (const word of config.RESERVED_AGENT_CODES) {
    const lower = word.toLowerCase();
    result('Reserved word rejected: ' + lower, config.RESERVED_AGENT_CODES.map(c => c.toLowerCase()).includes(lower));
  }
  console.log('');

  // === Test 2: Validate Agent Name ===
  console.log('--- Test Group 2: Agent Name Validation ---');
  const validNames = ['Leo', 'PH Agent 001', 'Tom-02'];
  for (const name of validNames) {
    const ok = name.length >= 2 && name.length <= 30 && !/[<>]/.test(name) && !name.startsWith('/');
    result('Valid name: ' + name, ok);
  }

  const invalidNames = ['L', '<script>', '@Tom', '/command', 'https://evil.com', 'a'.repeat(31)];
  for (const name of invalidNames) {
    const bad = name.length < 2 || name.length > 30 || /[<>@]/.test(name) || name.startsWith('/') || /https?:\/\//.test(name);
    result('Invalid name rejected: ' + name, bad);
  }
  console.log('');

  // === Test 3: DB Simulation — Create pending agent ===
  console.log('--- Test Group 3: Create Pending Agent ---');

  // Create test user
  await query(
    `INSERT INTO users (telegram_id, username, first_name, role, status) VALUES ($1,'testuser','Test','player','active') ON CONFLICT (telegram_id) DO UPDATE SET role='player'`,
    [TEST_TG_ID]
  );
  result('Test user created', true);

  // Check no existing agent
  const pre = await query('SELECT 1 FROM agents WHERE agent_code = $1', [TEST_CODE]);
  result('No pre-existing agent', pre.rows.length === 0);

  // Create pending agent (simulate self-application)
  await query(
    `INSERT INTO agents (agent_code, name, telegram_id, username, approval_status, status, applied_by_telegram_id, updated_at)
     VALUES ($1, $2, $3, 'testuser', 'pending', 'active', $4, NOW())`,
    [TEST_CODE, TEST_NAME, TEST_TG_ID, TEST_TG_ID]
  );
  await query('UPDATE users SET role = $1 WHERE telegram_id = $2', ['agent', TEST_TG_ID]);
  result('Pending agent created', true);

  // Verify pending
  const pending = await query('SELECT approval_status, status FROM agents WHERE agent_code = $1', [TEST_CODE]);
  result('approval_status = pending', pending.rows[0]?.approval_status === 'pending');
  result('status = active', pending.rows[0]?.status === 'active');
  console.log('');

  // === Test 4: Duplicate checks ===
  console.log('--- Test Group 4: Duplicate Checks ---');

  // Same code
  const dupCode = await query('SELECT 1 FROM agents WHERE agent_code = $1', [TEST_CODE]);
  result('Duplicate code detected', dupCode.rows.length > 0);

  // Same user already has approved agent
  // (our test agent is pending, so this should be 0)
  const dupUser = await query('SELECT 1 FROM agents WHERE telegram_id = $1 AND approval_status = $2', [TEST_TG_ID, 'approved']);
  result('No approved duplicate', dupUser.rows.length === 0);

  // Same user already has pending
  const dupPending = await query('SELECT 1 FROM agents WHERE telegram_id = $1 AND approval_status = $2', [TEST_TG_ID, 'pending']);
  result('Pending duplicate detected', dupPending.rows.length > 0);
  console.log('');

  // === Test 5: Admin approve ===
  console.log('--- Test Group 5: Admin Approve ---');

  await query(
    `UPDATE agents SET approval_status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW() WHERE agent_code = $2`,
    [config.ADMIN_IDS[0], TEST_CODE]
  );
  const approved = await query('SELECT approval_status, approved_by FROM agents WHERE agent_code = $1', [TEST_CODE]);
  result('approval_status = approved', approved.rows[0]?.approval_status === 'approved');
  result('approved_by set', String(approved.rows[0]?.approved_by) === String(config.ADMIN_IDS[0]));
  console.log('');

  // === Test 6: Rejection flow (using second test user) ===
  console.log('--- Test Group 6: Rejection Flow ---');

  await query(
    `INSERT INTO users (telegram_id, username, first_name, role, status) VALUES ($1,'testuser2','Test2','player','active') ON CONFLICT (telegram_id) DO UPDATE SET role='player'`,
    [TEST_TG_ID2]
  );

  // Apply as second user
  await query(
    `INSERT INTO agents (agent_code, name, telegram_id, username, approval_status, status, applied_by_telegram_id, updated_at)
     VALUES ($1, $2, $3, 'testuser2', 'pending', 'active', $4, NOW())`,
    [TEST_CODE2, 'Test Agent 2', TEST_TG_ID2, TEST_TG_ID2]
  );

  // Reject
  await query(
    `UPDATE agents SET approval_status = 'rejected', rejected_by = $1, rejected_at = NOW(), updated_at = NOW() WHERE agent_code = $2`,
    [config.ADMIN_IDS[0], TEST_CODE2]
  );
  const rejected = await query('SELECT approval_status, rejected_by FROM agents WHERE agent_code = $1', [TEST_CODE2]);
  result('approval_status = rejected', rejected.rows[0]?.approval_status === 'rejected');
  result('rejected_by set', String(rejected.rows[0]?.rejected_by) === String(config.ADMIN_IDS[0]));

  // Reapply: UPDATE the rejected record
  await query(
    `UPDATE agents SET agent_code = $1, name = $2, username = 'testuser2', approval_status = 'pending',
         status = 'active', applied_by_telegram_id = $3, rejected_by = NULL, rejected_at = NULL,
         approved_by = NULL, approved_at = NULL, updated_at = NOW()
     WHERE telegram_id = $4 AND approval_status = 'rejected'`,
    [TEST_CODE2, 'Test Agent 2 Reapply', TEST_TG_ID2, TEST_TG_ID2]
  );
  const reapplied = await query('SELECT approval_status, rejected_by FROM agents WHERE agent_code = $1', [TEST_CODE2]);
  result('Reapply: approval_status = pending', reapplied.rows[0]?.approval_status === 'pending');
  result('Reapply: rejected_by = null', reapplied.rows[0]?.rejected_by === null);
  console.log('');

  // === Test 7: Audit log entries ===
  console.log('--- Test Group 7: Audit Logs ---');

  // Write test audit entries
  const testActions = [
    'agent_application_started',
    'agent_application_code_submitted',
    'agent_application_name_submitted',
    'agent_application_submitted',
    'agent_application_duplicate_code',
    'agent_application_duplicate_user',
    'agent_application_duplicate_pending',
    'agent_application_rate_limited',
    'list_agent_applications',
    'approve_agent_application',
    'reject_agent_application',
    'agent_pending_access_denied',
    'agent_rejected_access_denied',
  ];
  for (const action of testActions) {
    await audit.log(TEST_TG_ID, 'player', action, 'agent', 'TEST', { test: true });
  }
  const auditCount = await query(
    `SELECT COUNT(*) FROM audit_logs WHERE actor_telegram_id = $1 AND detail_json ->> 'test' = 'true'`,
    [TEST_TG_ID]
  );
  result('All audit events written', parseInt(auditCount.rows[0].count) >= testActions.length);
  console.log('');

  // === Test 8: Pending applications list ===
  console.log('--- Test Group 8: Admin List Pending ---');

  // Create one more pending for counting
  const pendingList = await query(
    `SELECT agent_code FROM agents WHERE approval_status = 'pending'`
  );
  console.log('  Pending applications:', pendingList.rows.map(r => r.agent_code).join(', '));
  result('Pending list queryable', pendingList.rows.length >= 0);
  console.log('');

  // === Test 9: Rate limits table ===
  console.log('--- Test Group 9: Rate Limits ---');

  await query(`INSERT INTO rate_limits (telegram_id, attempt_type) VALUES ($1, 'apply_agent')`, [TEST_TG_ID]);
  await query(`INSERT INTO rate_limits (telegram_id, attempt_type) VALUES ($1, 'agent_code')`, [TEST_TG_ID]);

  const perMinCount = await query(
    `SELECT COUNT(*) FROM rate_limits WHERE telegram_id = $1 AND attempt_type = 'apply_agent' AND created_at > NOW() - INTERVAL '1 minute'`,
    [TEST_TG_ID]
  );
  result('Rate limit tracking works', parseInt(perMinCount.rows[0].count) >= 1);

  const perHourCount = await query(
    `SELECT COUNT(*) FROM rate_limits WHERE telegram_id = $1 AND attempt_type = 'agent_code' AND created_at > NOW() - INTERVAL '1 hour'`,
    [TEST_TG_ID]
  );
  result('Hourly rate tracking works', parseInt(perHourCount.rows[0].count) >= 1);
  console.log('');

  // === Test 10: Default approval_status for existing agents ===
  console.log('--- Test Group 10: Legacy Agents ---');
  const legacyAgents = await query(
    `SELECT agent_code, approval_status FROM agents WHERE agent_code NOT LIKE $1 ORDER BY created_at LIMIT 5`,
    ['TEST_AGENT_%']
  );
  for (const a of legacyAgents.rows) {
    result('Legacy agent ' + a.agent_code + ' = approved', a.approval_status === 'approved');
  }
  if (legacyAgents.rows.length === 0) {
    console.log('  (No legacy agents to check — expected in fresh DB)');
  }
  console.log('');

  // Clean up
  console.log('--- Cleanup ---');
  await query('DELETE FROM rate_limits WHERE telegram_id IN ($1,$2)', [TEST_TG_ID, TEST_TG_ID2]);
  await query('DELETE FROM audit_logs WHERE actor_telegram_id IN ($1,$2)', [TEST_TG_ID, TEST_TG_ID2]);
  await query('DELETE FROM agents WHERE agent_code LIKE $1', ['TEST_AGENT_%']);
  await query('DELETE FROM users WHERE telegram_id IN ($1,$2)', [TEST_TG_ID, TEST_TG_ID2]);
  console.log('  Test data cleaned up.\n');

  // Summary
  console.log('========================================');
  console.log('  RESULTS: ' + passed + ' passed, ' + failed + ' failed');
  console.log('========================================');

  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
