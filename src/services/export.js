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
      TO_CHAR(p.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
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
      TO_CHAR(p.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
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
  const buf = Buffer.from(csv, 'utf-8');
  await ctx.replyWithDocument(
    { source: buf, filename },
    { caption: `📋 ${filename} — ${new Date().toISOString().slice(0, 10)}` }
  ).catch(async (err) => {
    console.error('[sendCSV]', err.message);
    await ctx.reply(`📋 <b>Export</b>\n<pre>${csv.slice(0, 3800)}</pre>`, { parse_mode: 'HTML' });
  });
}

/**
 * 生成摘要 + 发送文件 + 表格
 */
async function exportWithSummary(ctx, csv, title) {
  const rows = csv.split('\n').filter(Boolean);
  const headers = rows[0]?.split(',') || [];
  const data = rows.slice(1);

  // 统计
  const total = data.length;
  const byPromoter = {};
  const byAgent = {};
  const byStatus = { pending: 0, approved: 0, rejected: 0 };
  data.forEach(line => {
    const cols = line.split(',');
    const pm = cols[4] || '-';
    const ag = cols[6] || '-';
    const st = cols[3] || 'pending';
    byPromoter[pm] = (byPromoter[pm] || 0) + 1;
    byAgent[ag] = (byAgent[ag] || 0) + 1;
    if (byStatus[st] !== undefined) byStatus[st]++;
  });

  // 摘要
  let summary = `📊 <b>${title}</b>\n`;
  summary += `━━━━━━━━━━━━━━\n`;
  summary += `🎮 总玩家：<b>${total}</b>\n`;
  summary += `✅ 已通过：${byStatus.approved} | ⏳ 待审核：${byStatus.pending} | ❌ 未通过：${byStatus.rejected}\n`;
  summary += `\n<b>按 Promoter：</b>\n`;
  for (const [pm, n] of Object.entries(byPromoter).slice(0, 10)) {
    summary += `  <code>${pm}</code>: ${n} 人\n`;
  }
  summary += `\n<b>按 Agent：</b>\n`;
  for (const [ag, n] of Object.entries(byAgent)) {
    summary += `  <code>${ag}</code>: ${n} 人\n`;
  }

  // 表格（最多展示20行）
  const display = data.slice(0, 20).map(line => {
    const cols = line.split(',');
    return `${cols[0]?.padEnd(12) || '-'} ${cols[1]?.padEnd(15) || '-'} ${cols[2]?.padEnd(12) || '-'} ${cols[3]?.padEnd(10) || '-'} ${cols[5]?.padEnd(12) || '-'} ${cols[7]?.padEnd(8) || '-'}`;
  });

  summary += `\n<b>📋 最近记录：</b>\n`;
  summary += `<pre>TG_ID        Username        GameID       Status     Promoter     Agent\n`;
  summary += display.map(d => d.slice(0, 90)).join('\n');
  summary += `</pre>`;
  if (total > 20) summary += `<i>... 还有 ${total - 20} 条，详见 CSV 文件</i>\n`;

  await ctx.reply(summary, { parse_mode: 'HTML' });

  // 发送 CSV 文件
  await sendCSV(ctx, csv, title.replace(/\s/g, '_') + '.csv');
}

module.exports = { exportAllPlayers, exportPlayersByAgent, sendCSV, exportWithSummary };
