const express = require('express');
const { db } = require('../db');
const { getAllSettings, getSetting } = require('../settings');

const router = express.Router();

router.get('/settings', (req, res) => {
  res.json({ settings: getAllSettings() });
});

router.get('/worklogs', (req, res) => {
  const enabled = getSetting('worklog').public_show === true;
  if (!enabled) return res.json({ enabled: false, worklogs: [] });
  const rows = db
    .prepare(`SELECT w.id, w.title, w.service_type, w.car_brand, w.car_model, w.description, w.created_at, u.full_name AS master_name
              FROM work_logs w JOIN users u ON u.id = w.master_id
              WHERE w.is_public = 1 AND w.status = 'Tugallangan'
              ORDER BY w.created_at DESC, w.id DESC`)
    .all();
  const list = rows.map((w) => ({
    ...w,
    images: db.prepare('SELECT id, image_path FROM work_log_images WHERE work_log_id = ? ORDER BY id ASC').all(w.id),
  }));
  res.json({ enabled: true, worklogs: list });
});

router.get('/services', (req, res) => {
  const services = db
    .prepare('SELECT id, name, description, benefits, image, icon, price FROM services WHERE is_active = 1 ORDER BY sort_order ASC, id ASC')
    .all();
  res.json({ services });
});

router.get('/services/:id', (req, res) => {
  const service = db
    .prepare('SELECT id, name, description, benefits, image, icon, price FROM services WHERE id = ? AND is_active = 1')
    .get(Number(req.params.id));
  if (!service) return res.status(404).json({ error: 'Xizmat topilmadi' });
  res.json({ service });
});

module.exports = router;