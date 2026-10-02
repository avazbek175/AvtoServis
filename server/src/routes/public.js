const express = require('express');
const { db } = require('../db');
const { getAllSettings, getSetting } = require('../settings');

const router = require('../asyncRoute').wrapRouter(express.Router());

router.get('/settings', async (req, res) => {
  res.json({ settings: await getAllSettings() });
});

router.get('/worklogs', async (req, res) => {
  const enabled = (await getSetting('worklog')).public_show === true;
  if (!enabled) return res.json({ enabled: false, worklogs: [] });
  const rows = await db
    .prepare(`SELECT w.id, w.title, w.service_type, w.car_brand, w.car_model, w.description, w.created_at, u.full_name AS master_name
              FROM work_logs w JOIN users u ON u.id = w.master_id
              WHERE w.is_public = 1 AND w.status = 'Tugallangan'
              ORDER BY w.created_at DESC, w.id DESC`)
    .all();

  // One extra query for all images instead of one per worklog (was an N+1 loop).
  const imagesByWork = new Map();
  if (rows.length) {
    const placeholders = rows.map(() => '?').join(',');
    const images = await db
      .prepare(`SELECT id, work_log_id, image_path FROM work_log_images
                WHERE work_log_id IN (${placeholders}) ORDER BY id ASC`)
      .all(rows.map((w) => w.id));
    for (const img of images) {
      const list = imagesByWork.get(img.work_log_id);
      if (list) list.push({ id: img.id, image_path: img.image_path });
      else imagesByWork.set(img.work_log_id, [{ id: img.id, image_path: img.image_path }]);
    }
  }

  const list = rows.map((w) => ({ ...w, images: imagesByWork.get(w.id) || [] }));
  res.json({ enabled: true, worklogs: list });
});

router.get('/services', async (req, res) => {
  const services = await db
    .prepare('SELECT id, name, description, benefits, image, icon, price FROM services WHERE is_active = 1 ORDER BY sort_order ASC, id ASC')
    .all();
  res.json({ services });
});

router.get('/services/:id', async (req, res) => {
  const service = await db
    .prepare('SELECT id, name, description, benefits, image, icon, price FROM services WHERE id = ? AND is_active = 1')
    .get(Number(req.params.id));
  if (!service) return res.status(404).json({ error: 'Xizmat topilmadi' });
  res.json({ service });
});

module.exports = router;
