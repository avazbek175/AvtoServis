/**
 * Render-time URL guard (client).
 *
 * The server rejects unsafe URLs on write, but rows saved before that validation
 * existed would still be rendered from the database. This is the second layer:
 * anything not provably safe is dropped, and the caller falls back to a safe value.
 */

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const SAFE_SCHEMES = new Set(['http', 'https']);

export function isSafeUrl(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;

  const raw = value.trim();
  if (!raw) return true;
  if (CONTROL_CHARS.test(raw)) return false;

  let probe = raw;
  try {
    probe = decodeURIComponent(raw);
  } catch {
    return false;
  }
  if (CONTROL_CHARS.test(probe)) return false;

  const candidate = probe.trim().replace(/\\/g, '/');
  const scheme = SCHEME.exec(candidate);
  if (!scheme) return !candidate.startsWith('//');
  return SAFE_SCHEMES.has(scheme[1].toLowerCase());
}

/** Returns the value when it is safe to place in href/src, otherwise undefined. */
export function safeHref(value) {
  return isSafeUrl(value) ? value : undefined;
}
