const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const auth = require('../auth');
const storage = require('../storage');

const router = require('../asyncRoute').wrapRouter(express.Router());
router.use(auth.authenticate);

const WORK_DIR = require('../paths').workDir;
const SERVICE_TYPES = ['Mator xodovoy', 'Diagnostika', 'Programma', 'Elektrik', 'Moy almashtirish'];
const STATUSES = ['Jarayonda', 'Tugallangan'];
const MAX_WORK_IMAGES = 15;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const WORK_LIST_FIELDS = `
  w.id, w.master_id, w.title, w.customer_name, w.customer_phone, w.car_brand, w.car_model,
  w.car_number, w.service_type, w.description, w.start_date, w.end_date, w.price, w.status,
  w.is_public, w.notes, w.created_at, w.updated_at, u.full_name AS master_name`;

function ensureWorkDir() {
  if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });
}

function isSA(user) {
  return !!user && user.role === 'super_admin';
}

function toFlag(value) {
  return Number(value) ? 1 : 0;
}

async function loadWork(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id)) return null;
  return db
    .prepare(`SELECT ${WORK_LIST_FIELDS} FROM work_logs w LEFT JOIN users u ON u.id = w.master_id WHERE w.id = ?`)
    .get(id);
}

function canAccess(req, work) {
  if (!work) return false;
  if (isSA(req.user)) return true;
  return work.master_id === req.user.id;
}

async function imagesFor(workId) {
  return db
    .prepare('SELECT id, image_path, original_filename FROM work_log_images WHERE work_log_id = ? ORDER BY id ASC')
    .all(workId);
}

async function decorate(row) {
  if (!row) return null;
  const w = { ...row, is_public: row.is_public ? 1 : 0, price: Number(row.price) || 0 };
  w.images = await imagesFor(w.id);
  return w;
}

const SANITIZE = /[^a-zA-Z0-9._-]/g;
function uniqueWorkFilename(original) {
  const ext = path.extname(original || '').toLowerCase();
  const base = path.basename(original || 'work', ext).replace(SANITIZE, '-').slice(0, 40) || 'work';
  return `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}${ext}`;
}

// With R2 configured the bytes go straight from memory to the bucket: no
// temporary file is created at all, which is what makes uploads work on a
// serverless host whose filesystem is read-only. The local-disk path is kept
// only for development without R2.
const workUpload = multer({
  storage: storage.enabled
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => {
          ensureWorkDir();
          cb(null, WORK_DIR);
        },
        filename: (req, file, cb) => cb(null, uniqueWorkFilename(file.originalname)),
      }),
  limits: { fileSize: MAX_IMAGE_SIZE, files: 10 },
  fileFilter: (req, file, cb) => {
    if (!storage.isValidMime(file.mimetype)) {
      const err = new Error('Faqat JPG, JPEG, PNG, WEBP, AVIF ruxsat etiladi');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

function validateWorkBody(b) {
  const service_type = String(b.service_type || '').trim();
  const status = String(b.status || 'Jarayonda').trim();
  const price = Number(b.price === '' || b.price === null || b.price === undefined ? 0 : b.price);
  const title = String(b.title || '').trim();
  if (!title) return { error: 'Ish nomi kiritilishi shart' };
  if (title.length > 200) return { error: 'Ish nomi juda uzun' };
  if (!SERVICE_TYPES.includes(service_type)) return { error: 'Xizmat turi noto\'g\'ri' };
  if (!STATUSES.includes(status)) return { error: 'Ish holati noto\'g\'ri' };
  if (!Number.isFinite(price) || price < 0 || price > 1e12) return { error: 'Narx noto\'g\'ri' };
  const clean = (v, n) => String(v || '').trim().slice(0, n);
  return {
    title,
    customer_name: clean(b.customer_name, 150),
    customer_phone: clean(b.customer_phone, 40),
    car_brand: clean(b.car_brand, 80),
    car_model: clean(b.car_model, 80),
    car_number: clean(b.car_number, 30),
    service_type,
    description: clean(b.description, 5000),
    start_date: clean(b.start_date, 20),
    end_date: clean(b.end_date, 20),
    price,
    status,
    notes: clean(b.notes, 2000),
  };
}

router.get('/', async (req, res) => {
  const conds = [];
  const params = [];
  if (!isSA(req.user)) {
    conds.push('w.master_id = ?');
    params.push(req.user.id);
  } else if (String(req.query.master_id || '').trim()) {
    conds.push('w.master_id = ?');
    params.push(Number(req.query.master_id));
  }
  if (String(req.query.service_type || '').trim()) {
    conds.push('w.service_type = ?');
    params.push(String(req.query.service_type));
  }
  if (String(req.query.status || '').trim()) {
    conds.push('w.status = ?');
    params.push(String(req.query.status));
  }
  if (String(req.query.date_from || '').trim()) {
    conds.push('(w.created_at)::date >= (? )::date');
    params.push(String(req.query.date_from));
  }
  if (String(req.query.date_to || '').trim()) {
    conds.push('(w.created_at)::date <= (? )::date');
    params.push(String(req.query.date_to));
  }
  if (String(req.query.q || '').trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    // ILIKE keeps SQLite's case-insensitive LIKE behaviour.
    conds.push('(w.title ILIKE ? OR w.customer_name ILIKE ? OR w.car_model ILIKE ? OR w.car_brand ILIKE ?)');
    params.push(like, like, like, like);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await db
    .prepare(`SELECT ${WORK_LIST_FIELDS} FROM work_logs w LEFT JOIN users u ON u.id = w.master_id ${where} ORDER BY w.created_at DESC, w.id DESC`)
    .all(params);
  const out = [];
  for (const row of rows) out.push(await decorate(row));
  res.json({ worklogs: out });
});

router.get('/stats', async (req, res) => {
  const conds = [];
  const params = [];
  if (!isSA(req.user)) {
    conds.push('master_id = ?');
    params.push(req.user.id);
  } else if (String(req.query.master_id || '').trim()) {
    conds.push('master_id = ?');
    params.push(Number(req.query.master_id));
  }
  if (String(req.query.service_type || '').trim()) {
    conds.push('service_type = ?');
    params.push(String(req.query.service_type));
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const row = await db
    .prepare(`SELECT COUNT(*)::int total, COALESCE(SUM(CASE WHEN status = 'Tugallangan' THEN 1 ELSE 0 END), 0)::int completed, COALESCE(SUM(CASE WHEN status = 'Jarayonda' THEN 1 ELSE 0 END), 0)::int in_progress, COALESCE(SUM(CASE WHEN status = 'Tugallangan' THEN price ELSE 0 END), 0) earnings FROM work_logs ${where}`)
    .get(params);
  res.json({ stats: { total: row.total, completed: row.completed, inProgress: row.in_progress, earnings: Number(row.earnings) || 0 } });
});

router.post('/', async (req, res) => {
  let masterId;
  if (isSA(req.user)) {
    masterId = Number(req.body && req.body.master_id);
    // A missing or non-numeric master_id must be rejected here: passing it on
    // would reach PostgreSQL as NaN and abort the request with a 500.
    if (!Number.isInteger(masterId) || masterId <= 0) {
      return res.status(400).json({ error: 'Ish bajaruvchi ustani tanlang' });
    }
    const m = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'master'").get(masterId);
    if (!m) return res.status(400).json({ error: 'Ish bajaruvchi ustani tanlang' });
  } else {
    masterId = req.user.id;
  }
  const v = validateWorkBody(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const isPublic = isSA(req.user) ? (req.body.is_public ? 1 : 0) : 0;
  // RETURNING id replaces SQLite's last_insert_rowid().
  const created = await db
    .prepare(`INSERT INTO work_logs
      (master_id, title, customer_name, customer_phone, car_brand, car_model, car_number,
       service_type, description, start_date, end_date, price, status, notes, is_public)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`)
    .one(
      masterId, v.title, v.customer_name, v.customer_phone, v.car_brand, v.car_model, v.car_number,
      v.service_type, v.description, v.start_date, v.end_date, v.price, v.status, v.notes, isPublic
    );
  res.status(201).json({ work: await decorate(await loadWork(created.id)) });
});

router.get('/:id', async (req, res) => {
  const work = await loadWork(req.params.id);
  if (!work) return res.status(404).json({ error: 'Ish topilmadi' });
  if (!canAccess(req, work)) return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  res.json({ work: await decorate(work) });
});

router.put('/:id', async (req, res) => {
  const work = await loadWork(req.params.id);
  if (!work) return res.status(404).json({ error: 'Ish topilmadi' });
  if (!canAccess(req, work)) return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  const b = req.body || {};
  const currentPublic = work.is_public ? 1 : 0;
  if ('is_public' in b && !isSA(req.user) && toFlag(b.is_public) !== currentPublic) {
    return res.status(403).json({ error: 'Faqat super admin saytda ko\'rsatishni sozlashi mumkin' });
  }
  const v = validateWorkBody(b);
  if (v.error) return res.status(400).json({ error: v.error });
  const isPublic = 'is_public' in b ? toFlag(b.is_public) : currentPublic;
  // Must be awaited: the response body is re-read from the database right after,
  // so an unawaited write would return the previous values.
  await db.prepare(`UPDATE work_logs SET
      title = ?, customer_name = ?, customer_phone = ?, car_brand = ?, car_model = ?, car_number = ?,
      service_type = ?, description = ?, start_date = ?, end_date = ?, price = ?, status = ?, notes = ?,
      is_public = ?, updated_at = app_now()
    WHERE id = ?`)
    .run(
      v.title, v.customer_name, v.customer_phone, v.car_brand, v.car_model, v.car_number,
      v.service_type, v.description, v.start_date, v.end_date, v.price, v.status, v.notes,
      isPublic, work.id
    );
  res.json({ work: await decorate(await loadWork(work.id)) });
});

router.delete('/:id', async (req, res, next) => {
  const work = await loadWork(req.params.id);
  if (!work) return res.status(404).json({ error: 'Ish topilmadi' });
  if (!canAccess(req, work)) return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  // Read the object keys before the delete: the rows are removed by ON DELETE CASCADE.
  const images = await db.prepare('SELECT image_path, object_key FROM work_log_images WHERE work_log_id = ?').all(work.id);
  await db.prepare('DELETE FROM work_logs WHERE id = ?').run(work.id);
  try {
    for (const img of images) {
      if (img.object_key) {
        await storage.remove(img.object_key);
      } else {
        await fs.promises.unlink(path.join(WORK_DIR, img.image_path)).catch(() => {});
      }
    }
  } catch (err) {
    next(err);
    return;
  }
  res.json({ ok: true });
});

async function ownedWork(req, res, next) {
  try {
    const work = await loadWork(req.params.id);
    if (!work) return res.status(404).json({ error: 'Ish topilmadi' });
    if (!canAccess(req, work)) return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    req.work = work;
    next();
  } catch (err) {
    next(err);
  }
}

router.post('/:id/images', ownedWork, (req, res) => {
  workUpload.array('files', 10)(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Rasm juda katta (maks 5MB)' });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'Bitta so\'rovda ko\'pi bilan 10 ta rasm yuboriladi' });
      if (err.status === 400 && err.message) return res.status(400).json({ error: err.message });
      if (err.message && err.message.startsWith('Faqat')) return res.status(400).json({ error: err.message });
      return res.status(400).json({ error: 'Rasm yuklashda xatolik' });
    }
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'Rasm yuklanmadi' });

    const removeLocal = () => {
      for (const f of files) {
        if (f.path) fs.promises.unlink(f.path).catch(() => {});
      }
    };

    const count = await db.prepare('SELECT COUNT(*) c FROM work_log_images WHERE work_log_id = ?').get(req.work.id);
    if (Number(count.c) + files.length > MAX_WORK_IMAGES) {
      removeLocal();
      return res.status(400).json({ error: `Bitta ishga ko'pi bilan ${MAX_WORK_IMAGES} ta rasm qo'shish mumkin` });
    }

    // Keys created during this request, so a half-finished batch can be undone.
    const uploadedKeys = [];
    const insertedIds = [];
    try {
      for (const f of files) {
        const imagePath = f.filename || uniqueWorkFilename(f.originalname);
        let objectKey = '';
        if (storage.enabled) {
          // Work-log images are not public content: they use the private key
          // prefix (and the private bucket when one is configured), so they can
          // only be read through /api/workimages/:filename.
          objectKey = storage.makePrivateKey(f.mimetype);
          await storage.upload({ key: objectKey, mime: f.mimetype, body: f.buffer });
          uploadedKeys.push(objectKey);
        }
        const row = await db
          .prepare('INSERT INTO work_log_images (work_log_id, image_path, original_filename, object_key) VALUES (?, ?, ?, ?) RETURNING id')
          .one(req.work.id, imagePath, f.originalname, objectKey);
        insertedIds.push(row.id);
      }
      res.status(201).json({ images: await imagesFor(req.work.id) });
    } catch (e) {
      // Nothing may be left half-attached: drop the R2 objects and the metadata
      // rows created by this request, then remove any local temp files.
      for (const id of insertedIds) {
        await db.prepare('DELETE FROM work_log_images WHERE id = ?').run(id).catch(() => {});
      }
      for (const key of uploadedKeys) {
        await storage.remove(key).catch(() => {});
      }
      removeLocal();
      next(e);
    }
  });
});

router.delete('/images/:imageId', async (req, res, next) => {
  const imageId = Number(req.params.imageId);
  if (!Number.isInteger(imageId)) return res.status(400).json({ error: 'Noto\'g\'ri rasm ID' });
  const img = await db.prepare('SELECT * FROM work_log_images WHERE id = ?').get(imageId);
  if (!img) return res.status(404).json({ error: 'Rasm topilmadi' });
  const work = await db.prepare('SELECT id, master_id FROM work_logs WHERE id = ?').get(img.work_log_id);
  if (!work) return res.status(404).json({ error: 'Ish topilmadi' });
  if (!canAccess(req, work)) return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  await db.prepare('DELETE FROM work_log_images WHERE id = ?').run(img.id);
  try {
    if (img.object_key) {
      await storage.remove(img.object_key);
    } else {
      await fs.promises.unlink(path.join(WORK_DIR, img.image_path)).catch(() => {});
    }
  } catch (err) {
    next(err);
    return;
  }
  res.json({ ok: true, images: await imagesFor(work.id) });
});

module.exports = router;