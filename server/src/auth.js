const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const ROLES = ['super_admin', 'master'];

const SECRET_FILE = path.join(__dirname, '..', 'data', 'secret.key');
let secret = '';

function ensureSecret() {
  if (secret) return secret;
  const dir = path.dirname(SECRET_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(SECRET_FILE)) {
    secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  } else {
    secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  }
  return secret;
}

const COOKIE_NAME = 'avtoservis_token';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function createSessionToken(user) {
  ensureSecret();
  const tokenId = crypto.randomUUID();
  const expiresAt = Date.now() + MAX_AGE;
  db.prepare('INSERT INTO sessions (token_id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenId, user.id, expiresAt);
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

function revokeToken(req) {
  const token = readToken(req);
  if (!token) return;
  try {
    const payload = decodePayload(token);
    if (payload && payload.jti) {
      db.prepare('DELETE FROM sessions WHERE token_id = ?').run(payload.jti);
    }
  } catch {
  }
}

function revokeUserSessionsExcept(userId, keepTokenId) {
  if (keepTokenId) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_id != ?').run(userId, keepTokenId);
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

function revokeUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function authenticate(req, res, next) {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = decodePayload(token);
    if (!payload || !payload.jti) return res.status(401).json({ error: 'Invalid session' });

    const session = db
      .prepare('SELECT expires_at FROM sessions WHERE token_id = ? AND user_id = ?')
      .get(payload.jti, payload.uid);
    if (!session || session.expires_at < Date.now()) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    const user = db
      .prepare('SELECT id, full_name, role, permissions, is_active FROM users WHERE id = ?')
      .get(payload.uid);
    if (!user || !user.is_active) {
      db.prepare('DELETE FROM sessions WHERE token_id = ?').run(payload.jti);
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Account unavailable' });
    }

    req.user = { id: user.id, full_name: user.full_name, role: user.role, permissions: parsePermissions(user) };
    req.tokenId = payload.jti;
    next();
  } catch {
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

pruneSessions();

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
  revokeUserSessionsExcept,
  authenticate,
  authorize,
  authorizePermission,
  hasPermission,
  MAX_AGE,
};