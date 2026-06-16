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
  // Step 1: basic URL validation + domain check
  const basic = validateAndNormalize(raw, allowedDomains);
  if (!basic.valid) return basic;

  // Step 2: check HTTPS requirement
  try {
    const u = new URL(basic.original);
    if (!allowHttp && u.protocol !== 'https:') {
      return { valid: false, error: 'Invalid affiliate link format.' };
    }
  } catch {
    return { valid: false, error: 'Invalid affiliate link format.' };
  }

  // Step 3: check r parameter
  try {
    const u = new URL(basic.original);
    const rValues = u.searchParams.getAll('r');
    if (rValues.length !== 1) {
      return { valid: false, error: 'Invalid affiliate link format.' };
    }
    const rVal = rValues[0];
    if (rVal.length < 3 || rVal.length > 64) {
      return { valid: false, error: 'Invalid affiliate link format.' };
    }
    if (!/^[A-Za-z0-9_-]+$/.test(rVal)) {
      return { valid: false, error: 'Invalid affiliate link format.' };
    }
  } catch {
    return { valid: false, error: 'Invalid affiliate link format.' };
  }

  // Step 4: check for forbidden content in the URL
  const rawLower = basic.original.toLowerCase();
  if (/[@\s<>]/.test(basic.original) || /javascript:/i.test(rawLower) || /data:/i.test(rawLower) || /[一-鿿]/.test(basic.original)) {
    return { valid: false, error: 'Invalid affiliate link format.' };
  }

  return basic; // { valid: true, normalized, original }
}

module.exports = { normalizeLink, isDomainAllowed, validateAndNormalize, validatePromoterLink };
