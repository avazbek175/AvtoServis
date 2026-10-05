const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const auth = require('../auth');
const storage = require('../storage');
const { getSetting, setSetting, getAllSettings, VALID_KEYS } = require('../settings');
const { validateSettings } = require('../validate');
const { uploadsDir } = require('../paths');

const router = require('../asyncRoute').wrapRouter(express.Router());
router.use(auth.authenticate);

const MAX_IMAGE_SIZE = 6 * 1024 * 1024;
const SANITIZE = /[^a-zA-Z0-9._-]/g;

function uniqueFilename(original) {
  const ext = path.extname(original || '').toLowerCase().slice(0, 10);
  const base = path.basename(original || 'file', ext).replace(SANITIZE, '-').slice(0, 40) || 'file';
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}${ext}`;
}

const disk = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
});

const upload = multer({
  // R2 configured -> the file is buffered in memory and pushed straight to the
  // bucket, so no temporary file is written. This is required on a serverless
  // host whose filesystem is read-only. Disk storage stays for local dev
  // without R2.
  storage: storage.enabled ? multer.memoryStorage() : disk,
  limits: { fileSize: MAX_IMAGE_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!storage.isValidMime(file.mimetype)) {
      // Multer passes plain Errors through untouched, so `status` is what makes
      // the global error handler answer 400 instead of a generic 500.
      const err = new Error('Faqat JPG, PNG, WEBP, AVIF rasmlari ruxsat etiladi');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

function mediaUrl(item) {
  return item.object_key ? storage.publicUrl(item.object_key) : `/api/media/${item.filename}`;
}

async function referencedUrlStrings() {
  const refs = new Set();
  for (const section of Object.values(await getAllSettings())) {
    for (const v of Object.values(section)) {
      if (typeof v === 'string' && v) refs.add(v);
    }
  }
  for (const s of await db.prepare('SELECT image FROM services').all()) {
    if (s.image) refs.add(s.image);
  }
  return refs;
}

async function safeDeleteR2Url(url) {
  if (!storage.isR2Url(url)) return;
  const key = storage.keyFromUrl(url);
  if (!key) return;
  const refs = await referencedUrlStrings();
  if (refs.has(String(url))) return;
  const inMedia = await db.prepare('SELECT COUNT(*) c FROM media WHERE object_key = ?').get(key);
  const inWork = await db.prepare('SELECT COUNT(*) c FROM work_log_images WHERE object_key = ?').get(key);
  if (Number(inMedia.c) + Number(inWork.c) > 0) return;
  await storage.remove(key).catch(() => {});
}

router.post('/uploads', auth.authorizePermission('media'), upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Fayl yuklanmadi' });

  // With memoryStorage there is no filename on disk; the DB row still needs a
  // stable name because /api/media/:filename is the non-R2 fallback URL.
  const filename = req.file.filename || uniqueFilename(req.file.originalname);
  const removeLocal = () => {
    if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
  };

  let objectKey = '';
  try {
    const prefix = storage.normalizePrefix((req.body && req.body.prefix) || 'gallery');

    if (storage.enabled) {
      objectKey = storage.makeKey(prefix, req.file.mimetype);
      await storage.upload({ key: objectKey, mime: req.file.mimetype, body: req.file.buffer });
      removeLocal();
    }

    // RETURNING replaces SQLite's last_insert_rowid().
    const row = await db
      .prepare('INSERT INTO media (filename, original_name, mime, size, object_key) VALUES (?, ?, ?, ?, ?) RETURNING id, filename, original_name, mime, size, object_key')
      .one(filename, req.file.originalname, req.file.mimetype, req.file.size, objectKey);
    const url = objectKey ? storage.publicUrl(objectKey) : `/api/media/${filename}`;
    res.status(201).json({ media: { ...row, url }, url });
  } catch (err) {
    // Either the R2 push or the metadata insert failed: undo the successful half
    // so no orphan object and no row without a file is left behind.
    removeLocal();
    if (objectKey) await storage.remove(objectKey).catch(() => {});
    next(err);
  }
});

router.get('/media', auth.authorizePermission('media'), async (req, res) => {
  const items = await db.prepare('SELECT id, filename, original_name, mime, size, object_key, created_at FROM media ORDER BY id DESC').all();
  res.json({ media: items.map((m) => ({ ...m, url: mediaUrl(m) })) });
});

router.delete('/media/:id', auth.authorizePermission('media'), async (req, res, next) => {
  const item = await db.prepare('SELECT * FROM media WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Media topilmadi' });

  const refs = await referencedUrlStrings();
  if (refs.has(`/api/media/${item.filename}`) || (item.object_key && refs.has(storage.publicUrl(item.object_key)))) {
    return res.status(409).json({ error: 'Bu rasm saytda ishlatilmoqda. Avval boshqa rasmni tanlang' });
  }

  await db.prepare('DELETE FROM media WHERE id = ?').run(Number(req.params.id));
  try {
    if (item.object_key) {
      await storage.remove(item.object_key);
    } else {
      const filePath = path.join(uploadsDir, item.filename);
      await fs.promises.unlink(filePath).catch(() => {});
    }
  } catch (err) {
    next(err);
    return;
  }
  res.json({ ok: true });
});

router.get('/services', auth.authorizePermission('services'), async (req, res) => {
  const services = await db
    .prepare('SELECT * FROM services ORDER BY sort_order ASC, id ASC')
    .all();
  res.json({ services });
});

router.post('/services', auth.authorizePermission('services'), async (req, res) => {
  const { name, description, benefits, image, icon, price, sort_order, is_active } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Xizmat nomi kiritilishi shart' });

  const maxOrder = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM services').get();
  const service = await db
    .prepare(`INSERT INTO services (name, description, benefits, image, icon, price, sort_order, is_active)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .one(String(name).trim(), String(description || ''), String(benefits || ''), String(image || ''), String(icon || 'wrench'), String(price || ''), Number.isInteger(sort_order) ? sort_order : Number(maxOrder.m) + 1, is_active === false ? 0 : 1);
  res.status(201).json({ service });
});

router.put('/services/:id', auth.authorizePermission('services'), async (req, res, next) => {
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Xizmat topilmadi' });

  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : existing.name;
  if (!name) return res.status(400).json({ error: 'Xizmat nomi kiritilishi shart' });

  const sort_order = Number.isInteger(b.sort_order) ? b.sort_order : existing.sort_order;
  const is_active = b.is_active !== undefined ? (b.is_active ? 1 : 0) : existing.is_active;

  const service = await db.prepare(`UPDATE services SET
      name = ?, description = ?, benefits = ?, image = ?, icon = ?, price = ?, sort_order = ?, is_active = ?
    WHERE id = ?
    RETURNING *`)
    .one(
      name,
      b.description !== undefined ? String(b.description) : existing.description,
      b.benefits !== undefined ? String(b.benefits) : existing.benefits,
      b.image !== undefined ? String(b.image) : existing.image,
      b.icon !== undefined ? String(b.icon) : existing.icon,
      b.price !== undefined ? String(b.price) : existing.price,
      sort_order,
      is_active,
      id
    );

  if (existing.image && b.image !== undefined && String(b.image) !== String(existing.image)) {
    try {
      await safeDeleteR2Url(existing.image);
    } catch (err) {
      next(err);
      return;
    }
  }

  res.json({ service });
});

router.patch('/services/reorder', auth.authorizePermission('services'), async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Noto\'g\'ri so\'rov' });
  // All-or-nothing: a partially applied reorder would leave the list scrambled.
  const stmt = 'UPDATE services SET sort_order = ? WHERE id = ?';
  await db.transaction(async (t) => {
    for (let idx = 0; idx < ids.length; idx++) {
      await t.prepare(stmt).run(idx + 1, Number(ids[idx]));
    }
  });
  res.json({ ok: true });
});

router.delete('/services/:id', auth.authorizePermission('services'), async (req, res, next) => {
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Xizmat topilmadi' });
  await db.prepare('DELETE FROM services WHERE id = ?').run(id);
  if (existing.image) {
    try {
      await safeDeleteR2Url(existing.image);
    } catch (err) {
      next(err);
      return;
    }
  }
  res.json({ ok: true });
});

router.get('/settings', auth.authorizePermission('content'), (req, res) => {
  res.json({ settings: getAllSettings(), keys: Object.keys(getAllSettings()) });
});

router.get('/settings/:key', auth.authorizePermission('content'), async (req, res) => {
  const key = req.params.key;
  if (!VALID_KEYS.includes(key)) return res.status(404).json({ error: 'Noma\'lum sozlamalar' });
  res.json({ settings: await getSetting(key) });
});

router.put('/settings/:key', auth.authorizePermission('content'), async (req, res, next) => {
  const key = req.params.key;
  if (!VALID_KEYS.includes(key)) {
    return res.status(400).json({ error: 'Noma\'lum sozlamalar kaliti' });
  }
  if (key === 'worklog' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  }
  const value = req.body && req.body.value !== undefined ? req.body.value : req.body;
  try {
    // Validation happens before anything is written, so a rejected payload can
    // never reach the database or the rendered page.
    validateSettings(key, value);
    const prev = await getSetting(key);
    const saved = await setSetting(key, value);

    const collectStrings = (obj, acc) => {
      if (!obj || typeof obj !== 'object') return acc;
      for (const v of Object.values(obj)) {
        if (typeof v === 'string') acc.push(v);
        else if (v && typeof v === 'object') collectStrings(v, acc);
      }
      return acc;
    };
    const dropped = collectStrings(prev, []).filter(
      (u) => storage.isR2Url(u) && !collectStrings(saved, []).includes(u)
    );
    for (const url of new Set(dropped)) {
      await safeDeleteR2Url(url);
    }
    res.json({ settings: saved });
  } catch (err) {
    if (err.status && err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.get('/users', auth.authorize('super_admin'), async (req, res) => {
  const users = await db
    .prepare('SELECT id, full_name, username, email, role, permissions, is_active, created_at FROM users ORDER BY CASE role WHEN \'super_admin\' THEN 0 ELSE 1 END, id ASC')
    .all();
  res.json({ users });
});

router.post('/users', auth.authorize('super_admin'), async (req, res) => {
  const b = req.body || {};
  const full_name = String(b.full_name || '').trim();
  const username = String(b.username || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!full_name || full_name.length < 3) {
    return res.status(400).json({ error: 'Ism va familiya kiritilishi shart (kamida 3 belgi)' });
  }
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Barcha maydonlar to\'ldirilishi shart' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Parol kamida 8 belgidan iborat bo\'lishi kerak' });
  }
  if (b.role && b.role !== 'master') {
    return res.status(400).json({ error: 'Faqat usta roli yaratilishi mumkin' });
  }
  const permissions = sanitizePermissions(b.permissions);

  const hash = auth.hashPassword(password);
  try {
    const user = await db
      .prepare('INSERT INTO users (full_name, username, email, password_hash, role, permissions, is_active) VALUES (?, ?, ?, ?, \'master\', ?, ?) RETURNING id, full_name, username, email, role, permissions, is_active, created_at')
      .one(full_name, username, email, hash, JSON.stringify(permissions), b.is_active === false ? 0 : 1);
    res.status(201).json({ user });
  } catch (err) {
    // 23505 = unique_violation (SQLite: UNIQUE constraint failed)
    if (err.code === '23505' || String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username yoki email band' });
    }
    throw err;
  }
});

router.put('/users/:id', auth.authorize('super_admin'), async (req, res) => {
  const id = Number(req.params.id);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

  const b = req.body || {};
  const full_name = b.full_name !== undefined ? String(b.full_name).trim() : user.full_name;
  const username = b.username !== undefined ? String(b.username).trim() : user.username;
  const email = b.email !== undefined ? String(b.email).trim().toLowerCase() : user.email;
  const role = b.role !== undefined ? b.role : user.role;
  if (role && !['super_admin', 'master'].includes(role)) return res.status(400).json({ error: 'Rol noto\'g\'ri' });

  if (user.role === 'super_admin') {
    if (id === req.user.id) {
      if (role !== 'super_admin') return res.status(403).json({ error: 'Super admin rolni o\'ziga o\'zgartira olmaydi' });
      if (b.is_active !== undefined && !b.is_active) return res.status(403).json({ error: 'Super adminni bloklab bo\'lmaydi' });
    } else {
      return res.status(403).json({ error: 'Boshqa super adminni o\'zgartirib bo\'lmaydi' });
    }
  }
  if (role === 'super_admin') {
    return res.status(403).json({ error: 'Yana bitta super admin yaratib bo\'lmaydi' });
  }

  const is_active = b.is_active !== undefined ? (b.is_active ? 1 : 0) : user.is_active;
  const permissions = b.permissions !== undefined ? JSON.stringify(sanitizePermissions(b.permissions)) : user.permissions;

  let passwordChanged = false;
  if (b.password) {
    if (String(b.password).length < 8) return res.status(400).json({ error: 'Parol kamida 8 belgidan iborat bo\'lishi kerak' });
    const hash = auth.hashPassword(String(b.password));
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    passwordChanged = true;
  }

  const updated = await db
    .prepare('UPDATE users SET full_name = ?, username = ?, email = ?, role = ?, permissions = ?, is_active = ? WHERE id = ? RETURNING id, full_name, username, email, role, permissions, is_active, created_at')
    .one(full_name, username, email, role, permissions, is_active, id);
  // An admin-set password is a reset: every session opened with the old password dies.
  if (!is_active || passwordChanged) await auth.revokeUserSessions(id);
  res.json({ user: updated });
});

router.delete('/users/:id', auth.authorize('super_admin'), async (req, res) => {
  const id = Number(req.params.id);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  if (user.role === 'super_admin') {
    const saCount = await db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'super_admin' AND is_active = 1").get();
    if (Number(saCount.c) <= 1) return res.status(409).json({ error: 'Oxirgi super adminni o\'chirib bo\'lmaydi' });
    return res.status(403).json({ error: 'Super adminni o\'chirib bo\'lmaydi' });
  }
  await auth.revokeUserSessions(id);
  await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

function sanitizePermissions(perms) {
  const valid = ['content', 'services', 'media'];
  if (!Array.isArray(perms)) return ['content', 'services', 'media'];
  return [...new Set(perms.filter((p) => valid.includes(p)))];
}

function publicApplication(app) {
  return {
    id: app.id,
    full_name: app.full_name,
    phone: app.phone,
    email: app.email,
    username: app.username,
    specialty: app.specialty,
    message: app.message,
    status: app.status,
    rejection_reason: app.rejection_reason,
    created_at: app.created_at,
    reviewed_at: app.reviewed_at,
    reviewed_by: app.reviewed_by,
    reviewed_by_name: app.reviewed_by_name || '',
  };
}

router.get('/applications', auth.authorize('super_admin'), async (req, res) => {
  const status = String(req.query.status || '');
  let rows;
  if (['pending', 'approved', 'rejected'].includes(status)) {
    rows = await db.prepare(`SELECT a.*, u.full_name AS reviewed_by_name FROM master_applications a LEFT JOIN users u ON u.id = a.reviewed_by WHERE a.status = ? ORDER BY a.created_at DESC, a.id DESC`).all(status);
  } else {
    rows = await db.prepare('SELECT a.*, u.full_name AS reviewed_by_name FROM master_applications a LEFT JOIN users u ON u.id = a.reviewed_by ORDER BY a.created_at DESC, a.id DESC').all();
  }
  res.json({ applications: rows.map(publicApplication) });
});

router.post('/applications/:id/approve', auth.authorize('super_admin'), async (req, res) => {
  const id = Number(req.params.id);
  const app = await db.prepare('SELECT * FROM master_applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Ariza topilmadi' });
  if (app.status !== 'pending') {
    return res.status(400).json({ error: 'Bu ariza allaqachon ko\'rib chiqilgan' });
  }
  const taken = await db
    .prepare("SELECT COUNT(*) c FROM users WHERE username = ? OR email = ?")
    .get(app.username, app.email);
  if (Number(taken.c) > 0) {
    return res.status(409).json({ error: 'Bu login yoki email allaqachon band' });
  }

  // Creating the user and marking the application approved must both happen or
  // neither, so they share one transaction.
  let user;
  try {
    await db.transaction(async (t) => {
      user = await t
        .prepare("INSERT INTO users (full_name, username, email, password_hash, role, permissions, is_active) VALUES (?, ?, ?, ?, 'master', ?, 1) RETURNING id, full_name, username, email, role, is_active, created_at")
        .one(
          app.full_name,
          app.username,
          app.email,
          app.password_hash,
          JSON.stringify(['content', 'services', 'media'])
        );
      await t
        .prepare("UPDATE master_applications SET status = 'approved', reviewed_at = app_now(), reviewed_by = ? WHERE id = ?")
        .run(req.user.id, id);
    });
  } catch (err) {
    if (err.code === '23505' || String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username yoki email band' });
    }
    throw err;
  }
  const updated = await db
    .prepare('SELECT a.*, u.full_name AS reviewed_by_name FROM master_applications a LEFT JOIN users u ON u.id = a.reviewed_by WHERE a.id = ?')
    .get(id);
  res.json({ user, application: publicApplication(updated) });
});

router.post('/applications/:id/reject', auth.authorize('super_admin'), async (req, res) => {
  const id = Number(req.params.id);
  const app = await db.prepare('SELECT * FROM master_applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Ariza topilmadi' });
  if (app.status !== 'pending') {
    return res.status(400).json({ error: 'Bu ariza allaqachon ko\'rib chiqilgan' });
  }
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  await db
    .prepare("UPDATE master_applications SET status = 'rejected', rejection_reason = ?, reviewed_at = app_now(), reviewed_by = ? WHERE id = ?")
    .run(reason, req.user.id, id);
  const updated = await db
    .prepare('SELECT a.*, u.full_name AS reviewed_by_name FROM master_applications a LEFT JOIN users u ON u.id = a.reviewed_by WHERE a.id = ?')
    .get(id);
  res.json({ application: publicApplication(updated) });
});

router.post('/change-password', async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'Barcha maydonlar to\'ldirilishi shart' });
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  if (!auth.verifyPassword(String(current_password), user.password_hash)) {
    return res.status(401).json({ error: 'Joriy parol noto\'g\'ri' });
  }
  if (String(new_password).length < 8) return res.status(400).json({ error: 'Yangi parol kamida 8 belgidan iborat bo\'lishi kerak' });
  const hash = auth.hashPassword(String(new_password));
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  // A password change must invalidate every existing session, including the one
  // that performed the change: a stolen cookie must not survive a reset.
  await auth.revokeUserSessions(req.user.id);
  auth.clearAuthCookie(res);
  res.json({ ok: true, reauth: true });
});

// Detailed health for monitoring, authenticated and super-admin only. The public
// /api/health deliberately returns nothing but { status: 'ok' }.
router.get('/health', auth.authorize('super_admin'), async (req, res) => {
  res.json({
    status: 'ok',
    users: (await db.prepare('SELECT COUNT(*) c FROM users').get()).c,
    services: (await db.prepare('SELECT COUNT(*) c FROM services').get()).c,
    sessions: (await db.prepare('SELECT COUNT(*) c FROM sessions WHERE expires_at >= ?').get(Date.now())).c,
  });
});

// Optional query counter (DB_TRACE_QUERIES=1) used by the N+1 regression test.
router.get('/diagnostics/queries', auth.authorize('super_admin'), (req, res) => {
  if (!db.__getQueryCount) return res.status(404).json({ error: 'Query tracing yoqilgan (DB_TRACE_QUERIES=1)' });
  res.json({ count: db.__getQueryCount() });
});

router.post('/diagnostics/queries/reset', auth.authorize('super_admin'), (req, res) => {
  if (!db.__resetQueryCount) return res.status(404).json({ error: 'Query tracing yoqilgan (DB_TRACE_QUERIES=1)' });
  db.__resetQueryCount();
  res.json({ ok: true });
});

router.get('/dashboard', async (req, res) => {
  const totalServices = (await db.prepare('SELECT COUNT(*) c FROM services').get()).c;
  const activeServices = (await db.prepare('SELECT COUNT(*) c FROM services WHERE is_active = 1').get()).c;
  const masters = (await db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'master'").get()).c;
  const mediaCount = (await db.prepare('SELECT COUNT(*) c FROM media').get()).c;
  const mastersActive = (await db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'master' AND is_active = 1").get()).c;
  const sections = ['site', 'hero', 'about', 'contact', 'footer'];
  const [hero, about, design] = await Promise.all([
    getSetting('hero'),
    getSetting('about'),
    getSetting('design'),
  ]);
  const visible = {
    hero: hero.show !== false,
    about: about.show !== false && design.show_about !== false,
    services: design.show_services !== false,
  };
  for (const k of sections) {
    const s = await getSetting(k);
    if (s.show !== undefined) visible[k] = s.show !== false;
  }
  // Debt ledger figures are aggregated by PostgreSQL over the live rows
  // (deleted_at IS NULL). If the ledger tables are absent this must not break the
  // whole dashboard, so the query is allowed to fail into zeroes.
  let debtStats = { total: 0, outstanding: 0, debtors: 0, createdToday: 0 };
  try {
    const d = await db
      .prepare(
        `SELECT
           COUNT(*)                                        AS total,
           COALESCE(SUM(GREATEST(remaining_amount, 0)), 0) AS outstanding,
           COUNT(*) FILTER (WHERE created_at >= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')::text) AS createdToday
         FROM debts WHERE deleted_at IS NULL`
      )
      .get();
    debtStats = {
      total: Number(d.total),
      outstanding: Number(d.outstanding),
      debtors: Number(d.total),
      createdToday: Number(d.createdToday),
    };
  } catch {
    /* ledger not migrated yet */
  }
  const stats = {
    totalServices,
    activeServices,
    masters,
    mastersActive,
    mediaCount,
    debtTotal: debtStats.total,
    debtOutstanding: debtStats.outstanding,
    debtTotalDebtors: debtStats.debtors,
    debtCreatedToday: debtStats.createdToday,
  };
  if (req.user.role === 'super_admin') {
    stats.pendingApplications = (await db.prepare("SELECT COUNT(*) c FROM master_applications WHERE status = 'pending'").get()).c;
  }
  res.json({ stats, visible });
});

module.exports = router;