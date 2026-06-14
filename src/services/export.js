const db = require('../db');

function buildCSV(rows) {
  if (!rows || rows.length === 0) return 'No data.';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => {
      const v = r[h] != null ? String(r[h]) : '';
      return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(','));
  }
  return lines.join('\n');
}

async function exportAllPlayers() {
  const res = await db.query(`
    SELECT
      p.telegram_id AS player_telegram_id,
      u.username AS player_username,
      p.game_id,
      p.game_id_status,
      pm.promoter_code,
      pm.name AS promoter_name,
      a.agent_code,
      a.name AS agent_name,
      p.created_at
    FROM players p
    LEFT JOIN promoters pm ON p.promoter_id = pm.id
    LEFT JOIN agents a ON p.agent_id = a.id
    LEFT JOIN users u ON p.telegram_id = u.telegram_id
    ORDER BY p.created_at DESC
  `);
  return buildCSV(res.rows);
}

async function exportPlayersByAgent(agentTelegramId) {
  const agent = await db.query(
    `SELECT id, agent_code FROM agents WHERE telegram_id = $1`,
    [agentTelegramId]
  );
  if (agent.rows.length === 0) return 'Agent not found.';

  const res = await db.query(`
    SELECT
      p.telegram_id AS player_telegram_id,
      u.username AS player_username,
      p.game_id,
      p.game_id_status,
      pm.promoter_code,
      pm.name AS promoter_name,
      a.agent_code,
      a.name AS agent_name,
      p.created_at
    FROM players p
    LEFT JOIN promoters pm ON p.promoter_id = pm.id
    LEFT JOIN agents a ON p.agent_id = a.id
    LEFT JOIN users u ON p.telegram_id = u.telegram_id
    WHERE p.agent_id = $1
    ORDER BY p.created_at DESC
  `, [agent.rows[0].id]);
  return buildCSV(res.rows);
}

async function sendCSV(ctx, csv, filename) {
  const buf = Buffer.from('﻿' + csv, 'utf-8');
  await ctx.replyWithDocument(
    { source: buf, filename },
    { caption: `📋 ${filename} — ${new Date().toISOString().slice(0, 10)}` }
  );
}

module.exports = { exportAllPlayers, exportPlayersByAgent, sendCSV };
