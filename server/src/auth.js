const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const ROLES = ['super_admin', 'master'];

const SECRET_FILE = require('./paths').secretFile;
let secret = '';

function ensureSecret() {
  if (secret) return secret;

  // On Vercel the app directory is read-only and each instance has its own
  // filesystem, so a generated secret.key would invalidate every cookie issued by
  // any other instance (and change on each cold start). JWT_SECRET must be set
  // there; the file stays as the local fallback.
  const fromEnv = String(process.env.JWT_SECRET || '').trim();
  if (fromEnv) {
    secret = fromEnv;
    return secret;
  }

  const dir = path.dirname(SECRET_FILE);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(SECRET_FILE)) {
      secret = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    } else {
      secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    }
  } catch (err) {
    // A read-only filesystem (serverless) or a missing directory must produce a
    // clear message instead of a raw EACCES/ENOENT stack trace.
    throw new Error(
      'JWT_SECRET could not be loaded from ' + SECRET_FILE + ' (' + err.message + '). ' +
        'Set the JWT_SECRET environment variable to a fixed random value.'
    );
  }
  return secret;
}

/**
 * Production must have an explicit JWT_SECRET.
 *
 * Generating one per instance would silently sign cookies with a different key
 * on every cold start, so users would be logged out at random and no session
 * could ever be validated across instances.
 */
function assertProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  if (String(process.env.JWT_SECRET || '').trim()) return;
  throw new Error(
    'JWT_SECRET is required in production. Generate one with: openssl rand -hex 48'
  );
}

const COOKIE_NAME = 'avtoservis_token';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

async function pruneSessions() {
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

async function createSessionToken(user) {
  ensureSecret();
  const tokenId = crypto.randomUUID();
  const expiresAt = Date.now() + MAX_AGE;
  await db
    .prepare('INSERT INTO sessions (token_id, user_id, expires_at) VALUES (?, ?, ?) RETURNING token_id')
    .one(tokenId, user.id, expiresAt);
  const token = jwt.sign(
    { uid: user.id, role: user.role, jti: tokenId },
    secret,
    { expiresIn: '7d' }
  );
  return token;
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function readToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return req.cookies && req.cookies[COOKIE_NAME];
}

function decodePayload(token) {
  ensureSecret();
  return jwt.verify(token, secret);
}

async function revokeToken(req) {
  const token = readToken(req);
  if (!token) return;
  try {
    const payload = decodePayload(token);
    if (payload && payload.jti) {
      await db.prepare('DELETE FROM sessions WHERE token_id = ?').run(payload.jti);
    }
  } catch {
  }
}

async function revokeUserSessions(userId) {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

async function authenticate(req, res, next) {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = decodePayload(token);
    if (!payload || !payload.jti) return res.status(401).json({ error: 'Invalid session' });

    const session = await db
      .prepare('SELECT expires_at FROM sessions WHERE token_id = ? AND user_id = ?')
      .get(payload.jti, payload.uid);
    if (!session || Number(session.expires_at) < Date.now()) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    const user = await db
      .prepare('SELECT id, full_name, role, permissions, is_active FROM users WHERE id = ?')
      .get(payload.uid);
    if (!user || !user.is_active) {
      await db.prepare('DELETE FROM sessions WHERE token_id = ?').run(payload.jti);
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Account unavailable' });
    }

    req.user = { id: user.id, full_name: user.full_name, role: user.role, permissions: parsePermissions(user) };
    req.tokenId = payload.jti;
    next();
  } catch {
    // Unchanged from the SQLite version: any failure to validate the token
    // results in a rejected request and a cleared cookie.
    clearAuthCookie(res);
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
}

function parsePermissions(user) {
  try {
    const p = JSON.parse(user.permissions || '[]');
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function hasPermission(user, scope) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  return Array.isArray(user.permissions) && user.permissions.includes(scope);
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

function authorizePermission(scope) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!hasPermission(req.user, scope)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

// `pruneSessions` is deliberately NOT started at module load: this module is
// required before migrations run, so the query would fail with
// "relation sessions does not exist". index.js calls it after startup instead.

module.exports = {
  COOKIE_NAME,
  ROLES,
  hashPassword,
  verifyPassword,
  createSessionToken,
  setAuthCookie,
  clearAuthCookie,
  revokeToken,
  revokeUserSessions,
  authenticate,
  authorize,
  authorizePermission,
  hasPermission,
  pruneSessions,
  assertProductionConfig,
  MAX_AGE,
};