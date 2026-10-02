/**
 * Login rate limiting.
 *
 * Deliberately dependency-free and scoped to `POST /api/auth/login` only —
 * password reset, master application and admin approval flows must never share
 * this budget, otherwise one noisy client could lock out unrelated operations.
 *
 * Two independent buckets are counted, both keyed on *failed* logins:
 *   - per account (username/email): stops brute force against a single account
 *     even when the attacker rotates IPs.
 *   - per IP: stops credential stuffing / password spraying from one host.
 * The per-IP budget is several times larger than the per-account one, so a single
 * attacker cannot lock every other account out from the same network, and a
 * legitimate user who mistypes their password a couple of times is not blocked.
 *
 * A successful login clears both buckets for that account+IP pair.
 */

const WINDOW_MS = () => positiveInt(process.env.LOGIN_RATE_WINDOW_MS, 15 * 60 * 1000);
const ACCOUNT_MAX = () => positiveInt(process.env.LOGIN_RATE_LIMIT_MAX, 10);
const IP_MAX = () => positiveInt(process.env.LOGIN_RATE_LIMIT_IP_MAX, ACCOUNT_MAX() * 5);

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const buckets = new Map();

function prune(now) {
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}

function hit(key, now) {
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + WINDOW_MS() };
    buckets.set(key, fresh);
    return fresh;
  }
  existing.count += 1;
  return existing;
}

function clear(key) {
  buckets.delete(key);
}

/** Client IP as seen by Express (honours `trust proxy` when configured). */
function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Normalized login identifier so "Ali" and "ali " share one bucket. */
function accountKey(req) {
  const raw = req.body && req.body.username;
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

function status(key) {
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= Date.now()) return { blocked: false, remaining: Infinity };
  return {
    blocked: entry.count >= limitFor(key),
    remaining: Math.max(0, limitFor(key) - entry.count),
    resetAt: entry.resetAt,
    retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)),
  };
}

function limitFor(key) {
  return key.startsWith('ip:') ? IP_MAX() : ACCOUNT_MAX();
}

const accountBucket = (id) => `account:${id}`;
const ipBucket = (ip) => `ip:${ip}`;

/** Middleware guarding the login route. */
function loginRateLimit(req, res, next) {
  const now = Date.now();
  if (buckets.size > 5000) prune(now);

  const ip = clientIp(req);
  const keys = [ipBucket(ip), accountBucket(accountKey(req))];
  const blocked = keys.map((k) => ({ key: k, ...status(k) })).find((s) => s.blocked);

  if (blocked) {
    res.set('Retry-After', String(blocked.retryAfterSec));
    return res.status(429).json({
      error: 'Juda ko\'p urinish. Biroz kutib turing va qayta yuboring.',
      retryAfter: blocked.retryAfterSec,
    });
  }
  next();
}

/** Call after a failed login attempt. */
function recordFailure(req) {
  const now = Date.now();
  hit(ipBucket(clientIp(req)), now);
  hit(accountBucket(accountKey(req)), now);
}

/**
 * Call after a successful login.
 *
 * Only the account bucket is cleared. Clearing the per-IP bucket as well would
 * let anyone holding one valid credential reset the credential-stuffing limit for
 * their whole IP.
 */
function recordSuccess(req) {
  clear(accountBucket(accountKey(req)));
}

module.exports = {
  loginRateLimit,
  recordFailure,
  recordSuccess,
  clientIp,
  accountKey,
  limits: { accountMax: ACCOUNT_MAX, ipMax: IP_MAX, windowMs: WINDOW_MS },
  __reset: () => buckets.clear(),
};
