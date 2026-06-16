/**
 * Build inline keyboard buttons for command shortcuts.
 */
function cmdButtons(cmds) {
  // cmds: [['/agent', '📊 Agent Panel'], ['/share', 'Share'], ...]
  const rows = [];
  let row = [];
  for (const [cmd, label] of cmds) {
    row.push({ text: label, callback_data: 'cmd:' + cmd });
    if (row.length === 2) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  return { inline_keyboard: rows };
}

module.exports = { cmdButtons };
