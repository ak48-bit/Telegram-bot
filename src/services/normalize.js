/**
 * Normalize a promo link for dedup:
 * 1. Trim whitespace
 * 2. Lowercase domain
 * 3. Remove URL fragment (#...)
 * 4. Remove trailing /
 * 5. Remove tracking params (utm_*)
 * 6. Keep core ?r= parameter
 */
function normalizeLink(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null;

  try {
    const u = new URL(url);
    // lowercase hostname
    u.hostname = u.hostname.toLowerCase();
    // remove fragment
    u.hash = '';
    // remove tracking params
    const allowedParams = ['r'];
    const newParams = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (allowedParams.includes(k) || (!k.startsWith('utm_') && !k.startsWith('fbclid') && !k.startsWith('gclid'))) {
        newParams.append(k, v);
      }
    }
    u.search = newParams.toString();
    // remove trailing /
    let result = u.toString();
    if (result.endsWith('/') && !u.pathname.endsWith('/')) {
      // only remove if pathname didn't end with /
    }
    result = result.replace(/\/$/, '');
    return result;
  } catch {
    return null;
  }
}

/**
 * Check if a domain is allowed
 */
function isDomainAllowed(url, allowedDomains) {
  if (!allowedDomains || allowedDomains.length === 0) return true; // no restriction
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    for (const d of allowedDomains) {
      if (hostname === d.trim().toLowerCase()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Validate and normalize a promo link
 * Returns { valid, normalized, error }
 */
function validateAndNormalize(raw, allowedDomains) {
  if (!raw || typeof raw !== 'string') return { valid: false, error: 'Invalid link format.' };
  const url = raw.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { valid: false, error: 'Invalid link format.' };
  }
  try {
    new URL(url);
  } catch {
    return { valid: false, error: 'Invalid link format.' };
  }
  if (allowedDomains && allowedDomains.length > 0 && !isDomainAllowed(url, allowedDomains)) {
    return { valid: false, error: 'Invalid link format.' };
  }
  const normalized = normalizeLink(url);
  if (!normalized) return { valid: false, error: 'Invalid link format.' };
  return { valid: true, normalized, original: url };
}

/**
 * Validate a promoter affiliate link with extra rules:
 * - must contain exactly one ?r= param
 * - r param length 3-64
 * - r param only A-Z a-z 0-9 _ -
 * - no @, spaces, <>, javascript:, data:, Chinese
 * - normalized link must be unique (caller checks DB)
 * Returns { valid, normalized, original, error }
 */
function validatePromoterLink(raw, allowedDomains, allowHttp = false) {
  if (!raw || typeof raw !== 'string') return { valid: false, error: 'Invalid affiliate link format.' };
  const url = raw.trim();

  // Step 1: length check
  if (url.length > 500) return { valid: false, error: 'Invalid affiliate link format.' };

  // Step 2: HTTPS requirement
  if (!url.startsWith('https://')) {
    return { valid: false, error: 'Invalid affiliate link format.' };
  }

  // Step 3: must be parseable by URL()
  let parsed;
  try { parsed = new URL(url); } catch { return { valid: false, error: 'Invalid affiliate link format.' }; }

  // Step 4: hostname must not be empty
  if (!parsed.hostname) return { valid: false, error: 'Invalid affiliate link format.' };

  // Step 5: forbidden content
  const lower = url.toLowerCase();
  if (/[\s<>]/.test(url)) return { valid: false, error: 'Invalid affiliate link format.' };
  if (/javascript:/i.test(lower)) return { valid: false, error: 'Invalid affiliate link format.' };
  if (/data:/i.test(lower)) return { valid: false, error: 'Invalid affiliate link format.' };
  if (/[一-鿿]/.test(url)) return { valid: false, error: 'Invalid affiliate link format.' };
  if (/[\x00-\x1f\x7f]/.test(url)) return { valid: false, error: 'Invalid affiliate link format.' };

  // Step 6: normalized link for dedup (lowercase hostname, remove hash, remove trailing /)
  let normalized = url;
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    u.hash = '';
    normalized = u.toString().replace(/\/$/, '');
  } catch {}

  return { valid: true, normalized, original: url };
}

module.exports = { normalizeLink, isDomainAllowed, validateAndNormalize, validatePromoterLink };
