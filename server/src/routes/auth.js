const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const auth = require('../auth');
const rateLimit = require('../rateLimit');

const router = require('../asyncRoute').wrapRouter(express.Router());

const PUBLIC_USER_FIELDS = 'id, full_name, username, email, role, is_active, created_at';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PG_UNIQUE_VIOLATION = '23505';

async function countSuperAdmins() {
  const row = await db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'super_admin'").get();
  return Number(row.c);
}

/**
 * Guards the first-super-admin bootstrap endpoint.
 *
 * On an empty database this route creates an account with full control, so on a
 * freshly deployed instance anyone could reach it and take the site over. In
 * production it therefore requires a secret that only the operator knows:
 *
 *   Authorization: Bearer <SETUP_SECRET>   (or the X-Setup-Secret header)
 *
 * If SETUP_SECRET is missing in production the endpoint stays closed (fail
 * closed) rather than falling back to open. The secret is never echoed in a
 * response or written to a log.
 */
function requireSetupSecret(req, res, next) {
  const configured = String(process.env.SETUP_SECRET || '').trim();

  if (!configured) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        error: 'Setup o\'chirilgan. Birinchi admin yaratish uchun SETUP_SECRET sozlang',
      });
    }
    // Development keeps the convenient local behaviour.
    return next();
  }

  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const provided = String(bearer || req.headers['x-setup-secret'] || '').trim();
  if (!provided) {
    return res.status(401).json({ error: 'Setup secret talab qilinadi' });
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!matches) {
    return res.status(403).json({ error: 'Setup secret noto\'g\'ri' });
  }
  return next();
}

// Only the login route is throttled — see rateLimit.js for why the budget is not shared.
router.post('/login', rateLimit.loginRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Login va parol kiritilishi shart' });
  }

  const user = await db
    .prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .get(String(username).trim(), String(username).trim());

  if (!user || !auth.verifyPassword(String(password), user.password_hash)) {
    rateLimit.recordFailure(req);
    return res.status(401).json({ error: 'Login yoki parol noto\'g\'ri' });
  }

  if (!user.is_active) {
    return res.status(403).json({ error: 'Hisob faolshtirilgan. Administrator bilan bog\'laning' });
  }

  rateLimit.recordSuccess(req);
  const token = await auth.createSessionToken(user);
  auth.setAuthCookie(res, token);

  res.json({ user: publicUser(user) });
});

router.post('/logout', async (req, res) => {
  await auth.revokeToken(req);
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', auth.authenticate, async (req, res) => {
  const user = await db.prepare('SELECT ' + PUBLIC_USER_FIELDS + ' FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.is_active) {
    auth.clearAuthCookie(res);
    return res.status(401).json({ error: 'Foydalanuvchi topilmadi' });
  }
  res.json({ user });
});

router.get('/setup-status', async (req, res) => {
  res.json({ needsSetup: (await countSuperAdmins()) === 0 });
});

router.post('/setup', requireSetupSecret, async (req, res) => {
  // Checked again after the secret so a valid secret cannot be replayed once an
  // admin exists; this also closes the endpoint automatically after first use.
  if ((await countSuperAdmins()) > 0) {
    return res.status(403).json({ error: 'Super admin allaqachon yaratilgan' });
  }

  const { full_name, username, email, password } = req.body || {};
  if (!full_name || !username || !email || !password) {
    return res.status(400).json({ error: 'Barcha maydonlar to\'ldirilishi shart' });
  }
  if (!String(full_name).trim() || String(full_name).trim().length < 3) {
    return res.status(400).json({ error: 'Ism va familiya kiritilishi shart (kamida 3 belgi)' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Parol kamida 8 belgidan iborat bo\'lishi kerak' });
  }
  const u = String(username).trim();
  const e = String(email).trim().toLowerCase();
  if (!USERNAME_RE.test(u)) {
    return res.status(400).json({ error: 'Username harf, raqam va _ dan iborat 3-30 belgi bo\'lishi kerak' });
  }
  if (!EMAIL_RE.test(e)) {
    return res.status(400).json({ error: 'Email noto\'g\'ri' });
  }
  try {
    const hash = auth.hashPassword(String(password));
    // RETURNING replaces SQLite's last_insert_rowid().
    const user = await db
      .prepare(
        "INSERT INTO users (full_name, username, email, password_hash, role, permissions, is_active) VALUES (?, ?, ?, ?, ?, '[]', 1) RETURNING " +
          PUBLIC_USER_FIELDS
      )
      .one(String(full_name).trim(), u, e, hash, 'super_admin');
    const token = await auth.createSessionToken(user);
    auth.setAuthCookie(res, token);
    return res.status(201).json({ user });
  } catch (err) {
    if (err && (err.code === PG_UNIQUE_VIOLATION || String(err.message).includes('UNIQUE'))) {
      return res.status(409).json({ error: 'Username yoki email band' });
    }
    throw err;
  }
});

router.post('/apply', async (req, res) => {
  const b = req.body || {};
  const full_name = String(b.full_name || '').trim();
  const phone = String(b.phone || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const specialty = String(b.specialty || '').trim();
  const message = String(b.message || '').trim();

  if (!full_name || full_name.length < 3) {
    return res.status(400).json({ error: 'Ism va familiya kiritilishi shart' });
  }
  if (!phone) {
    return res.status(400).json({ error: 'Telefon raqam kiritilishi shart' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Email noto\'g\'ri' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Login harf, raqam va _ dan iborat 3-30 belgi bo\'lishi kerak' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Parol kamida 8 belgidan iborat bo\'lishi kerak' });
  }
  if (!specialty) {
    return res.status(400).json({ error: 'Mutaxassisligingizni tanlang' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Qo\'shimcha ma\'lumot juda uzun' });
  }

  const existing = await db
    .prepare('SELECT COUNT(*) c FROM users WHERE username = ? OR email = ?')
    .get(username, email);
  if (Number(existing.c) > 0) {
    return res.status(409).json({ error: 'Bunday login yoki email allaqachon ro\'yxatdan o\'tgan' });
  }

  const dupe = await db
    .prepare("SELECT COUNT(*) c FROM master_applications WHERE status IN ('pending','approved') AND (username = ? OR email = ?)")
    .get(username, email);
  if (Number(dupe.c) > 0) {
    return res.status(409).json({ error: 'Bu login yoki email bo\'yicha ariza allaqachon yuborilgan' });
  }

  const hash = auth.hashPassword(password);
  const app = await db
    .prepare(
      "INSERT INTO master_applications (full_name, phone, email, username, password_hash, specialty, message, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING id, full_name, phone, email, username, specialty, message, status, created_at"
    )
    .one(full_name, phone, email, username, hash, specialty, message);
  res.status(201).json({ application: app });
});

function publicUser(u) {
  return { id: u.id, full_name: u.full_name, username: u.username, email: u.email, role: u.role, is_active: !!u.is_active, created_at: u.created_at };
}

module.exports = router;
