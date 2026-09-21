const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const auth = require('../auth');
const { getSetting } = require('../settings');

const router = express.Router();
const WORK_DIR = path.join(__dirname, '..', '..', 'uploads', 'work');

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

router.get('/:filename', (req, res) => {
  const filename = path.basename(String(req.params.filename)).replace(/[\\/]/g, '');
  const img = db.prepare('SELECT work_log_id FROM work_log_images WHERE image_path = ?').get(filename);
  const filePath = path.join(WORK_DIR, filename);
  if (!img || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Fayl topilmadi' });

  const work = db.prepare('SELECT master_id, is_public FROM work_logs WHERE id = ?').get(img.work_log_id);
  if (!work) return res.status(404).json({ error: 'Fayl topilmadi' });

  const allowPublic = work.is_public === 1 && getSetting('worklog').public_show === true;
  if (allowPublic) return serve();

  auth.authenticate(req, res, () => {
    if (!req.user || (req.user.role !== 'super_admin' && req.user.id !== work.master_id)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    serve();
  });

  function serve() {
    const ext = path.extname(filename).toLowerCase();
    res.set('Content-Type', MIME[ext] || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  }
});

module.exports = router;