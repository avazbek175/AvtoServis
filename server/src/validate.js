/**
 * Server-side validation for settings values.
 *
 * Anything that ends up in the browser as an attribute value (href, src, CSS
 * colour) must be validated here — client-side checks are a convenience, this is
 * the actual defence, because the API is reachable directly.
 */

// Characters browsers strip or ignore while parsing a URL scheme. Anything
// containing them is rejected outright instead of being "cleaned up", because the
// cleaning rules differ per browser (e.g. `\x01javascript:` executes in Chrome).
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
// `jav&#x09;ascript:` and friends: HTML entities are decoded before the browser
// parses the URL, so reject anything entity-shaped in the scheme position.
const HTML_ENTITY = /&(#x?[0-9a-f]+|[a-z]+);?/i;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const SAFE_SCHEMES = new Set(['http', 'https']);

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * A value is usable as an href/src only if it is a relative reference or uses an
 * explicitly allowed scheme. `javascript:`, `data:`, `vbscript:`, `blob:`,
 * `file:` and friends are rejected.
 */
function isSafeUrl(value) {
  if (value === undefined || value === null) return true; // absent field, nothing to render
  if (typeof value !== 'string') return false;

  const raw = value.trim();
  if (!raw) return true; // empty renders no link
  if (CONTROL_CHARS.test(raw)) return false;

  // Percent-decode before inspecting the scheme so `%6a%61vascript:` cannot slip
  // through, then re-check the decoded form for controls.
  let probe = raw;
  try {
    probe = decodeURIComponent(raw);
  } catch {
    return false; // malformed percent-encoding
  }
  if (CONTROL_CHARS.test(probe) || HTML_ENTITY.test(probe)) return false;

  const candidate = probe.trim().replace(/\\/g, '/');
  const scheme = SCHEME.exec(candidate);
  if (!scheme) {
    // No scheme: a relative reference (/contact), a fragment (#services) or a
    // query (?x=1). Reject protocol-relative URLs, they escape the allowlist
    // through the host instead of the scheme.
    return !candidate.startsWith('//');
  }
  return SAFE_SCHEMES.has(scheme[1].toLowerCase());
}

/** `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` — nothing else. */
function isHexColor(value) {
  return typeof value === 'string' && HEX_COLOR.test(value.trim());
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * Per-key validators. Runs before anything is persisted, so a rejected payload
 * leaves the stored settings untouched. Unknown keys are rejected by the caller.
 */
const VALIDATORS = {
  hero(value) {
    const v = requireObject(value);
    if (!isSafeUrl(v.button_link)) {
      throw new ValidationError('Tugma havolasi noto\'g\'ri. Faqat https://, http:// yoki / bilan boshlanadigan havolalar ruxsat etiladi');
    }
    return value;
  },
  contact(value) {
    const v = requireObject(value);
    if (!isSafeUrl(v.map_link)) {
      throw new ValidationError('Xarita havolasi noto\'g\'ri. Faqat https://, http:// yoki / bilan boshlanadigan havolalar ruxsat etiladi');
    }
    for (const field of ['telegram', 'instagram']) {
      if (v[field] && !isSafeUrl(String(v[field]))) {
        throw new ValidationError(`${field} havolasi noto\'g\'ri. Faqat https://, http:// yoki / bilan boshlanadigan havolalar ruxsat etiladi`);
      }
    }
    return value;
  },
  site(value) {
    const v = requireObject(value);
    for (const field of ['telegram', 'instagram']) {
      if (v[field] && !isSafeUrl(String(v[field]))) {
        throw new ValidationError(`${field} havolasi noto\'g\'ri. Faqat https://, http:// yoki / bilan boshlanadigan havolalar ruxsat etiladi`);
      }
    }
    return value;
  },
  design(value) {
    const v = requireObject(value);
    for (const field of ['primary_color', 'secondary_color']) {
      if (v[field] === undefined || v[field] === null || v[field] === '') continue;
      if (!isHexColor(v[field])) {
        throw new ValidationError(`${field} noto\'g\'ri. #RGB, #RRGGBB yoki #RRGGBBAA formatida bo\'lishi kerak`);
      }
    }
    return value;
  },
};

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('Sozlamalar obyekti kutilgan edi');
  }
  return value;
}

/** Throws ValidationError (400) when the settings payload is unsafe. */
function validateSettings(key, value) {
  const validator = VALIDATORS[key];
  return validator ? validator(value) : value;
}

module.exports = { isSafeUrl, isHexColor, validateSettings, ValidationError };
