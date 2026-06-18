const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function initDB() {
  const oldCheck = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'ref_code'`
  );
  if (oldCheck.rows.length > 0) {
    console.log('[DB] Old Python bot users table — renaming to users_old');
    await query('ALTER TABLE IF EXISTS users RENAME TO users_old').catch(() => {});
  }

  const sql = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('admin','agent','promoter','player')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','pending')),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agents (
      id SERIAL PRIMARY KEY,
      agent_code TEXT UNIQUE NOT NULL,
      telegram_id BIGINT UNIQUE REFERENCES users(telegram_id),
      name TEXT NOT NULL,
      agent_link_original TEXT,
      agent_link_normalized TEXT,
      link_status TEXT DEFAULT 'NOT_SUBMITTED' CHECK (link_status IN ('NOT_SUBMITTED','BOUND')),
      status TEXT DEFAULT 'active' CHECK (status IN ('active','blocked','pending')),
      created_by_admin_id BIGINT REFERENCES users(telegram_id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS promoters (
      id SERIAL PRIMARY KEY,
      promoter_code TEXT UNIQUE NOT NULL,
      telegram_id BIGINT UNIQUE REFERENCES users(telegram_id),
      agent_id INTEGER REFERENCES agents(id),
      name TEXT NOT NULL,
      player_affiliate_link_original TEXT,
      player_affiliate_link_normalized TEXT,
      player_referral_token TEXT UNIQUE,
      link_status TEXT DEFAULT 'NOT_SUBMITTED' CHECK (link_status IN ('NOT_SUBMITTED','BOUND')),
      status TEXT DEFAULT 'active' CHECK (status IN ('active','blocked','pending')),
      created_by_agent_id BIGINT REFERENCES users(telegram_id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL REFERENCES users(telegram_id),
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      promoter_id INTEGER REFERENCES promoters(id),
      agent_id INTEGER REFERENCES agents(id),
      game_id TEXT,
      game_id_normalized TEXT,
      game_id_status TEXT DEFAULT 'submitted' CHECK (game_id_status IN ('submitted','pending','approved','rejected')),
      first_start_payload TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invite_tokens (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('agent_bind','promoter_bind')),
      code TEXT NOT NULL,
      created_by BIGINT NOT NULL,
      used_by_telegram_id BIGINT,
      is_used BOOLEAN DEFAULT FALSE,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      used_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      actor_telegram_id BIGINT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail_json JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      attempt_type TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_code ON agents(agent_code);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_promoters_code ON promoters(promoter_code);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_link_norm ON agents(agent_link_normalized);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_promoters_link_norm ON promoters(player_affiliate_link_normalized);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_promoters_ref_token ON promoters(player_referral_token);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_players_game_id_norm ON players(game_id_normalized);
    CREATE INDEX IF NOT EXISTS idx_promoters_agent ON promoters(agent_id);
    CREATE INDEX IF NOT EXISTS idx_players_promoter ON players(promoter_id);
    CREATE INDEX IF NOT EXISTS idx_players_agent ON players(agent_id);
    CREATE INDEX IF NOT EXISTS idx_players_telegram ON players(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_invite_tokens_token ON invite_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_telegram_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

    ${config.ADMIN_IDS.map(id => `
    INSERT INTO users (telegram_id, role, status) VALUES (${id}, 'admin', 'active')
    ON CONFLICT (telegram_id) DO UPDATE SET role = 'admin', status = 'active';
    `).join('')}
  `;
  await query(sql);

  // Migration: add new columns (IF NOT EXISTS = idempotent, real errors will throw)
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_link_original TEXT");
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_link_normalized TEXT");
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS link_status TEXT DEFAULT 'NOT_SUBMITTED'");
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'approved'");
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS username TEXT");
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS applied_by_telegram_id BIGINT");
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS approved_by BIGINT");
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP");
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS rejected_by BIGINT");
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP");
  await query("ALTER TABLE promoters ADD COLUMN IF NOT EXISTS player_affiliate_link_original TEXT");
  await query("ALTER TABLE promoters ADD COLUMN IF NOT EXISTS player_affiliate_link_normalized TEXT");
  await query("ALTER TABLE promoters ADD COLUMN IF NOT EXISTS player_referral_token TEXT");
  await query("ALTER TABLE promoters ADD COLUMN IF NOT EXISTS link_status TEXT DEFAULT 'NOT_SUBMITTED'");
  await query("ALTER TABLE promoters ADD COLUMN IF NOT EXISTS created_by_agent_id BIGINT");
  await query("ALTER TABLE promoters ADD COLUMN IF NOT EXISTS created_by_telegram_id BIGINT");
  // Drop FK on created_by_agent_id if it references users(telegram_id) — we store agents.id now
  await query("ALTER TABLE promoters DROP CONSTRAINT IF EXISTS promoters_created_by_agent_id_fkey").catch(() => {});
  await query("ALTER TABLE players ADD COLUMN IF NOT EXISTS game_id_normalized TEXT");
  await query("ALTER TABLE players ADD COLUMN IF NOT EXISTS player_share_code TEXT");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_players_share_code ON players(player_share_code)");
  // Add 'submitted' to game_id_status CHECK constraint
  await query("ALTER TABLE players DROP CONSTRAINT IF EXISTS players_game_id_status_check").catch(() => {});
  await query("ALTER TABLE players ADD CONSTRAINT players_game_id_status_check CHECK (game_id_status IN ('submitted','pending','approved','rejected'))").catch(() => {});
  await query("ALTER TABLE invite_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_tokens_hash ON invite_tokens(token_hash)");

  // Sessions table for persistent step-mode flows
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      flow_name TEXT NOT NULL,
      step TEXT NOT NULL,
      payload_json JSONB DEFAULT '{}',
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_telegram ON sessions(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);

  // Migrate old data — fail on conflict so admin can resolve manually
  const agentConflicts = await query(
    `SELECT agent_link_original, COUNT(*) FROM agents WHERE agent_link_original IS NOT NULL AND agent_link_normalized IS NULL GROUP BY agent_link_original HAVING COUNT(*) > 1`
  );
  if (agentConflicts.rows.length > 0) {
    console.error('[DB] FATAL: Duplicate agent_link_original detected. Resolve manually then restart.');
    agentConflicts.rows.forEach(r => console.error('  DUPLICATE:', r.agent_link_original, 'x' + r.count));
    throw new Error('Duplicate agent_link_original — cannot auto-migrate.');
  }
  await query("UPDATE agents SET agent_link_normalized = agent_link_original WHERE agent_link_original IS NOT NULL AND agent_link_normalized IS NULL");

  const pmConflicts = await query(
    `SELECT player_affiliate_link_original, COUNT(*) FROM promoters WHERE player_affiliate_link_original IS NOT NULL AND player_affiliate_link_normalized IS NULL GROUP BY player_affiliate_link_original HAVING COUNT(*) > 1`
  );
  if (pmConflicts.rows.length > 0) {
    console.error('[DB] FATAL: Duplicate player_affiliate_link_original detected. Resolve manually then restart.');
    pmConflicts.rows.forEach(r => console.error('  DUPLICATE:', r.player_affiliate_link_original, 'x' + r.count));
    throw new Error('Duplicate player_affiliate_link_original — cannot auto-migrate.');
  }
  await query("UPDATE promoters SET player_affiliate_link_normalized = player_affiliate_link_original WHERE player_affiliate_link_original IS NOT NULL AND player_affiliate_link_normalized IS NULL");

  const gameConflicts = await query(
    `SELECT UPPER(TRIM(game_id)) AS norm, COUNT(*) FROM players WHERE game_id IS NOT NULL AND game_id_normalized IS NULL GROUP BY UPPER(TRIM(game_id)) HAVING COUNT(*) > 1`
  );
  if (gameConflicts.rows.length > 0) {
    console.error('[DB] FATAL: Duplicate game_id detected after normalization. Resolve manually then restart.');
    gameConflicts.rows.forEach(r => console.error('  DUPLICATE:', r.norm, 'x' + r.count));
    throw new Error('Duplicate game_id — cannot auto-migrate.');
  }
  await query("UPDATE players SET game_id_normalized = UPPER(TRIM(game_id)) WHERE game_id IS NOT NULL AND game_id_normalized IS NULL");

  // Generate missing player_referral_tokens
  const crypto = require('crypto');
  const missing = await query("SELECT id FROM promoters WHERE player_referral_token IS NULL");
  for (const r of missing.rows) {
    const token = crypto.randomBytes(16).toString('hex');
    await query("UPDATE promoters SET player_referral_token = $1 WHERE id = $2", [token, r.id]);
  }

  // Ensure indexes (IF NOT EXISTS = idempotent, real errors will throw)
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_link_norm ON agents(agent_link_normalized)");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_promoters_link_norm ON promoters(player_affiliate_link_normalized)");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_promoters_ref_token ON promoters(player_referral_token)");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_players_game_id_norm ON players(game_id_normalized)");
  await query("CREATE INDEX IF NOT EXISTS idx_agents_approval ON agents(approval_status)");
  await query("CREATE INDEX IF NOT EXISTS idx_rate_limits_telegram ON rate_limits(telegram_id, attempt_type)");
  await query("CREATE INDEX IF NOT EXISTS idx_rate_limits_created ON rate_limits(created_at)");

  console.log('[DB] Schema migration completed.');
}

module.exports = { query, pool, initDB };
