/**
 * Escape user/dynamic data for Telegram HTML parse_mode.
 * Only escape variables — never escape HTML tags like <b>, <code>, <i>.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * PostgreSQL error code helpers
 */
function isUniqueViolation(error) {
  return error && error.code === '23505';
}

function isForeignKeyViolation(error) {
  return error && error.code === '23503';
}

function isCheckViolation(error) {
  return error && error.code === '23514';
}

module.exports = { escapeHtml, isUniqueViolation, isForeignKeyViolation, isCheckViolation };
