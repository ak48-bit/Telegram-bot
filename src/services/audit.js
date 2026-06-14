const db = require('../db');

async function log(actorTelegramId, actorRole, action, targetType = null, targetId = null, detail = {}) {
  await db.query(
    `INSERT INTO audit_logs (actor_telegram_id, actor_role, action, target_type, target_id, detail_json)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actorTelegramId, actorRole, action, targetType, targetId ? String(targetId) : null, JSON.stringify(detail)]
  );
}

module.exports = { log };
