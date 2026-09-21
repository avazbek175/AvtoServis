const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const auth = require('../auth');
const { getSetting, setSetting, getAllSettings } = require('../settings');

const router = express.Router();
router.use(auth.authenticate);

const MAX_IMAGE_SIZE = 6 * 1024 * 1024;
const SANITIZE = /[^a-zA-Z0-9._-]/g;

function uniqueFilename(original) {
  const ext = path.extname(original || '').toLowerCase().slice(0, 10);
  const base = path.basename(original || 'file', ext).replace(SANITIZE, '-').slice(0, 40) || 'file';
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}${ext}`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', '..', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = /^image\/(png|jpe?g|webp|gif|svg\+xml|avif)$/;
    if (!allowed.test(file.mimetype)) return cb(new Error('Faqat rasm fayllari ruxsat etiladi'));
    cb(null, true);
  },
});

router.post('/uploads', auth.authorizePermission('media'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fayl yuklanmadi' });
  const info = db
    .prepare('INSERT INTO media (filename, original_name, mime, size) VALUES (?, ?, ?, ?)')
    .run(req.file.filename, req.file.originalname, req.file.mimetype, req.file.size);
  const filename = req.file.filename;
  res.status(201).json({ media: { id: info.lastInsertRowid, filename, original_name: req.file.originalname, mime: req.file.mimetype, size: req.file.size }, url: `/api/media/${filename}` });
});

router.get('/media', auth.authorizePermission('media'), (req, res) => {
  const items = db.prepare('SELECT id, filename, original_name, mime, size, created_at FROM media ORDER BY id DESC').all();
  res.json({ media: items });
});

router.delete('/media/:id', auth.authorizePermission('media'), (req, res) => {
  const item = db.prepare('SELECT filename FROM media WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Media topilmadi' });

  const inSettings = Object.values(getAllSettings()).some(
    (sect) => Object.values(sect).some((v) => typeof v === 'string' && v.includes(`/api/media/${item.filename}`))
  );
  const inServices = db.prepare('SELECT COUNT(*) c FROM services WHERE image = ?').get(`/api/media/${item.filename}`).c;
  if (inSettings || inServices > 0) {
    return res.status(409).json({ error: 'Bu rasm saytda ishlatilmoqda. Avval boshqa rasmni tanlang' });
  }

  db.prepare('DELETE FROM media WHERE id = ?').run(Number(req.params.id));
  const filePath = path.join(__dirname, '..', '..', 'uploads', item.filename);
  fs.promises.unlink(filePath).catch(() => {});
  res.json({ ok: true });
});

router.get('/services', auth.authorizePermission('services'), (req, res) => {
  const services = db
    .prepare('SELECT * FROM services ORDER BY sort_order ASC, id ASC')
    .all();
  res.json({ services });
});

router.post('/services', auth.authorizePermission('services'), (req, res) => {
  const { name, description, benefits, image, icon, price, sort_order, is_active } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Xizmat nomi kiritilishi shart' });

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM services').get().m;
  const info = db
    .prepare(`INSERT INTO services (name, description, benefits, image, icon, price, sort_order, is_active)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(String(name).trim(), String(description || ''), String(benefits || ''), String(image || ''), String(icon || 'wrench'), String(price || ''), Number.isInteger(sort_order) ? sort_order : maxOrder + 1, is_active === false ? 0 : 1);
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ service });
});

router.put('/services/:id', auth.authorizePermission('services'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Xizmat topilmadi' });

  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : existing.name;
  if (!name) return res.status(400).json({ error: 'Xizmat nomi kiritilishi shart' });

  const sort_order = Number.isInteger(b.sort_order) ? b.sort_order : existing.sort_order;
  const is_active = b.is_active !== undefined ? (b.is_active ? 1 : 0) : existing.is_active;

  db.prepare(`UPDATE services SET
      name = ?, description = ?, benefits = ?, image = ?, icon = ?, price = ?, sort_order = ?, is_active = ?
    WHERE id = ?`)
    .run(
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
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  res.json({ service });
});

router.patch('/services/reorder', auth.authorizePermission('services'), (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Noto\'g\'ri so\'rov' });
  const stmt = db.prepare('UPDATE services SET sort_order = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    ids.forEach((id, idx) => stmt.run(idx + 1, Number(id)));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
});

router.delete('/services/:id', auth.authorizePermission('services'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Xizmat topilmadi' });
  db.prepare('DELETE FROM services WHERE id = ?').run(id);
  res.json({ ok: true });
});

router.get('/settings', auth.authorizePermission('content'), (req, res) => {
  res.json({ settings: getAllSettings(), keys: Object.keys(getAllSettings()) });
});

router.get('/settings/:key', auth.authorizePermission('content'), (req, res) => {
  const key = req.params.key;
  const { VALID_KEYS } = require('../settings');
  if (!VALID_KEYS.includes(key)) return res.status(404).json({ error: 'Noma\'lum sozlamalar' });
  res.json({ settings: getSetting(key) });
});

router.put('/settings/:key', auth.authorizePermission('content'), (req, res) => {
  const key = req.params.key;
  if (key === 'worklog' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  }
  const value = req.body && req.body.value !== undefined ? req.body.value : req.body;
  try {
    const saved = setSetting(key, value);
    res.json({ settings: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/users', auth.authorize('super_admin'), (req, res) => {
  const users = db
    .prepare('SELECT id, full_name, username, email, role, permissions, is_active, created_at FROM users ORDER BY CASE role WHEN \'super_admin\' THEN 0 ELSE 1 END, id ASC')
    .all();
  res.json({ users });
});

router.post('/users', auth.authorize('super_admin'), (req, res) => {
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
    const info = db
      .prepare('INSERT INTO users (full_name, username, email, password_hash, role, permissions, is_active) VALUES (?, ?, ?, ?, \'master\', ?, ?)')
      .run(full_name, username, email, hash, JSON.stringify(permissions), b.is_active === false ? 0 : 1);
    const user = db.prepare('SELECT id, full_name, username, email, role, permissions, is_active, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ user });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Username yoki email band' });
    throw err;
  }
});

router.put('/users/:id', auth.authorize('super_admin'), (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
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

  if (b.password) {
    if (String(b.password).length < 8) return res.status(400).json({ error: 'Parol kamida 8 belgidan iborat bo\'lishi kerak' });
    const hash = auth.hashPassword(String(b.password));
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  }

  db.prepare('UPDATE users SET full_name = ?, username = ?, email = ?, role = ?, permissions = ?, is_active = ? WHERE id = ?')
    .run(full_name, username, email, role, permissions, is_active, id);
  const updated = db.prepare('SELECT id, full_name, username, email, role, permissions, is_active, created_at FROM users WHERE id = ?').get(id);
  if (!is_active) auth.revokeUserSessions(id);
  res.json({ user: updated });
});

router.delete('/users/:id', auth.authorize('super_admin'), (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  if (user.role === 'super_admin') {
    const saCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'super_admin' AND is_active = 1").get().c;
    if (saCount <= 1) return res.status(409).json({ error: 'Oxirgi super adminni o\'chirib bo\'lmaydi' });
    return res.status(403).json({ error: 'Super adminni o\'chirib bo\'lmaydi' });
  }
  auth.revokeUserSessions(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
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

router.get('/applications', auth.authorize('super_admin'), (req, res) => {
  const status = String(req.query.status || '');
  let rows;
  if (['pending', 'approved', 'rejected'].includes(status)) {
    rows = db.prepare(`SELECT a.*, u.full_name AS reviewed_by_name FROM master_applications a LEFT JOIN users u ON u.id = a.reviewed_by WHERE a.status = ? ORDER BY a.created_at DESC, a.id DESC`).all(status);
  } else {
    rows = db.prepare('SELECT a.*, u.full_name AS reviewed_by_name FROM master_applications a LEFT JOIN users u ON u.id = a.reviewed_by ORDER BY a.created_at DESC, a.id DESC').all();
  }
  res.json({ applications: rows.map(publicApplication) });
});

router.post('/applications/:id/approve', auth.authorize('super_admin'), (req, res) => {
  const id = Number(req.params.id);
  const app = db.prepare('SELECT * FROM master_applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Ariza topilmadi' });
  if (app.status !== 'pending') {
    return res.status(400).json({ error: 'Bu ariza allaqachon ko\'rib chiqilgan' });
  }
  const taken = db
    .prepare("SELECT COUNT(*) c FROM users WHERE username = ? OR email = ?")
    .get(app.username, app.email).c;
  if (taken > 0) {
    return res.status(409).json({ error: 'Bu login yoki email allaqachon band' });
  }

  db.exec('BEGIN');
  try {
    const info = db
      .prepare("INSERT INTO users (full_name, username, email, password_hash, role, permissions, is_active) VALUES (?, ?, ?, ?, 'master', ?, 1)")
      .run(
        app.full_name,
        app.username,
        app.email,
        app.password_hash,
        JSON.stringify(['content', 'services', 'media'])
      );
    const user = db.prepare('SELECT id, full_name, username, email, role, is_active, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
    db.prepare("UPDATE master_applications SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?")
      .run(req.user.id, id);
    db.exec('COMMIT');
    res.json({ user, application: publicApplication(db.prepare('SELECT a.*, u.full_name AS reviewed_by_name FROM master_applications a LEFT JOIN users u ON u.id = a.reviewed_by WHERE a.id = ?').get(id)) });
  } catch (err) {
    db.exec('ROLLBACK');
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username yoki email band' });
    }
    throw err;
  }
});

router.post('/applications/:id/reject', auth.authorize('super_admin'), (req, res) => {
  const id = Number(req.params.id);
  const app = db.prepare('SELECT * FROM master_applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Ariza topilmadi' });
  if (app.status !== 'pending') {
    return res.status(400).json({ error: 'Bu ariza allaqachon ko\'rib chiqilgan' });
  }
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  db.prepare("UPDATE master_applications SET status = 'rejected', rejection_reason = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?")
    .run(reason, req.user.id, id);
  res.json({ application: publicApplication(db.prepare('SELECT a.*, u.full_name AS reviewed_by_name FROM master_applications a LEFT JOIN users u ON u.id = a.reviewed_by WHERE a.id = ?').get(id)) });
});

router.post('/change-password', (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'Barcha maydonlar to\'ldirilishi shart' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  if (!auth.verifyPassword(String(current_password), user.password_hash)) {
    return res.status(401).json({ error: 'Joriy parol noto\'g\'ri' });
  }
  if (String(new_password).length < 8) return res.status(400).json({ error: 'Yangi parol kamida 8 belgidan iborat bo\'lishi kerak' });
  const hash = auth.hashPassword(String(new_password));
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  auth.revokeUserSessionsExcept(req.user.id, req.tokenId);
  res.json({ ok: true });
});

router.get('/dashboard', (req, res) => {
  const totalServices = db.prepare('SELECT COUNT(*) c FROM services').get().c;
  const activeServices = db.prepare('SELECT COUNT(*) c FROM services WHERE is_active = 1').get().c;
  const masters = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'master'").get().c;
  const mediaCount = db.prepare('SELECT COUNT(*) c FROM media').get().c;
  const mastersActive = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'master' AND is_active = 1").get().c;
  const sections = ['site', 'hero', 'about', 'contact', 'footer'];
  const visible = {
    hero: getSetting('hero').show !== false,
    about: getSetting('about').show !== false && getSetting('design').show_about !== false,
    services: getSetting('design').show_services !== false,
  };
  for (const k of sections) {
    const s = getSetting(k);
    if (s.show !== undefined) visible[k] = s.show !== false;
  }
  const stats = { totalServices, activeServices, masters, mastersActive, mediaCount };
  if (req.user.role === 'super_admin') {
    stats.pendingApplications = db.prepare("SELECT COUNT(*) c FROM master_applications WHERE status = 'pending'").get().c;
  }
  res.json({ stats, visible });
});

module.exports = router;