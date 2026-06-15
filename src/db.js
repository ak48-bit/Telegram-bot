const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// 测试连接
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
  // 检测 + 备份旧 Python Bot 的 users 表（如果存在旧格式）
  const oldCheck = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'ref_code'`
  ).catch(() => ({ rows: [] }));

  if (oldCheck.rows.length > 0) {
    console.log('[DB] Old Python bot users table detected — renaming to users_old');
    await query('ALTER TABLE IF EXISTS users RENAME TO users_old').catch(() => {});
  }

  const sql = `
    -- 角色表
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

    -- Agent 详情
    CREATE TABLE IF NOT EXISTS agents (
      id SERIAL PRIMARY KEY,
      agent_code TEXT UNIQUE NOT NULL,
      telegram_id BIGINT UNIQUE REFERENCES users(telegram_id),
      name TEXT NOT NULL,
      promo_url TEXT,
      player_affiliate_link TEXT UNIQUE,
      link_status TEXT DEFAULT 'NOT_SUBMITTED' CHECK (link_status IN ('NOT_SUBMITTED','BOUND')),
      status TEXT DEFAULT 'active' CHECK (status IN ('active','blocked','pending')),
      created_by_admin_id BIGINT REFERENCES users(telegram_id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Promoter 详情
    CREATE TABLE IF NOT EXISTS promoters (
      id SERIAL PRIMARY KEY,
      promoter_code TEXT UNIQUE NOT NULL,
      telegram_id BIGINT UNIQUE REFERENCES users(telegram_id),
      agent_id INTEGER REFERENCES agents(id),
      name TEXT NOT NULL,
      promo_url TEXT,
      player_affiliate_link TEXT UNIQUE,
      link_status TEXT DEFAULT 'NOT_SUBMITTED' CHECK (link_status IN ('NOT_SUBMITTED','BOUND')),
      status TEXT DEFAULT 'active' CHECK (status IN ('active','blocked','pending')),
      created_by_agent_id BIGINT REFERENCES users(telegram_id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- 玩家详情
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL REFERENCES users(telegram_id),
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      promoter_id INTEGER REFERENCES promoters(id),
      agent_id INTEGER REFERENCES agents(id),
      game_id TEXT,
      game_id_status TEXT DEFAULT 'pending' CHECK (game_id_status IN ('pending','approved','rejected')),
      first_start_payload TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- 一次性绑定 Token
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

    -- 审计日志
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

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
    CREATE INDEX IF NOT EXISTS idx_agents_code ON agents(agent_code);
    CREATE INDEX IF NOT EXISTS idx_promoters_code ON promoters(promoter_code);
    CREATE INDEX IF NOT EXISTS idx_promoters_agent ON promoters(agent_id);
    CREATE INDEX IF NOT EXISTS idx_players_promoter ON players(promoter_id);
    CREATE INDEX IF NOT EXISTS idx_players_agent ON players(agent_id);
    CREATE INDEX IF NOT EXISTS idx_players_telegram ON players(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_invite_tokens_token ON invite_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_telegram_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

    -- 创建 admin 用户（如果不存在）
    ${config.ADMIN_IDS.map(id => `
    INSERT INTO users (telegram_id, role, status) VALUES (${id}, 'admin', 'active')
    ON CONFLICT (telegram_id) DO UPDATE SET role = 'admin', status = 'active';
    `).join('')}
  `;
  await query(sql);
  // 兼容旧表迁移
  await query('ALTER TABLE promoters ADD COLUMN IF NOT EXISTS promo_url TEXT').catch(() => {});
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS promo_url TEXT').catch(() => {});
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS player_affiliate_link TEXT").catch(() => {});
  await query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS link_status TEXT DEFAULT 'NOT_SUBMITTED'").catch(() => {});
  await query("UPDATE agents SET player_affiliate_link = promo_url, link_status = 'BOUND' WHERE promo_url IS NOT NULL AND player_affiliate_link IS NULL AND promo_url != ''").catch(() => {});
  await query("ALTER TABLE agents ADD CONSTRAINT IF NOT EXISTS unique_agent_player_link UNIQUE (player_affiliate_link)").catch(() => {});
  await query("ALTER TABLE promoters ADD COLUMN IF NOT EXISTS player_affiliate_link TEXT").catch(() => {});
  await query("ALTER TABLE promoters ADD COLUMN IF NOT EXISTS link_status TEXT DEFAULT 'NOT_SUBMITTED'").catch(() => {});
  // 迁移旧数据：如果 promo_url 有值但 player_affiliate_link 为空，迁移过去
  await query("UPDATE promoters SET player_affiliate_link = promo_url, link_status = 'BOUND' WHERE promo_url IS NOT NULL AND player_affiliate_link IS NULL AND promo_url != ''").catch(() => {});
  // 给 player_affiliate_link 加唯一约束（如果还没加）
  await query("ALTER TABLE promoters ADD CONSTRAINT IF NOT EXISTS unique_player_affiliate_link UNIQUE (player_affiliate_link)").catch(() => {});
  console.log('[DB] All tables initialized. Admins:', config.ADMIN_IDS);
}

module.exports = { query, pool, initDB };
