const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const storage = require('../storage');

const router = express.Router();
const uploadsDir = path.join(__dirname, '..', '..', 'uploads');

router.get('/:filename', (req, res) => {
  const filename = path.basename(String(req.params.filename)).replace(/[\\/]/g, '');
  const row = db.prepare('SELECT object_key FROM media WHERE filename = ?').get(filename);

  if (row && row.object_key && storage.enabled) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.redirect(302, storage.publicUrl(row.object_key));
  }

  const filePath = path.join(uploadsDir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Fayl topilmadi' });

  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
  };
  const ext = path.extname(filename).toLowerCase();
  res.set('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;