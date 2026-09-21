const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'avtoservis.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'master' CHECK (role IN ('super_admin', 'master')),
    permissions TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS master_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    specialty TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    rejection_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    reviewed_by INTEGER,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    benefits TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT 'wrench',
    price TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS work_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    master_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    car_brand TEXT NOT NULL DEFAULT '',
    car_model TEXT NOT NULL DEFAULT '',
    car_number TEXT NOT NULL DEFAULT '',
    service_type TEXT NOT NULL DEFAULT 'Diagnostika',
    description TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL DEFAULT '',
    end_date TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Jarayonda' CHECK (status IN ('Jarayonda', 'Tugallangan')),
    is_public INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (master_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS work_log_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_log_id INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    original_filename TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (work_log_id) REFERENCES work_logs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_work_logs_master ON work_logs(master_id);
  CREATE INDEX IF NOT EXISTS idx_work_logs_status ON work_logs(status);
  CREATE INDEX IF NOT EXISTS idx_work_logs_service ON work_logs(service_type);
  CREATE INDEX IF NOT EXISTS idx_work_logs_public ON work_logs(is_public, status);
  CREATE INDEX IF NOT EXISTS idx_work_images_log ON work_log_images(work_log_id);
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_pending_username
    ON master_applications(username) WHERE status IN ('pending', 'approved');
  CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_pending_email
    ON master_applications(email) WHERE status IN ('pending', 'approved');
`);

const DEFAULT_MASTER_PERMISSIONS = ['content', 'services', 'media'];

function migrate() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!row) return;
  const oldSql = row.sql || '';
  const needsRecreate = !oldSql.includes('super_admin') || !oldSql.includes('full_name') || !oldSql.includes('permissions');
  if (!needsRecreate) return;

  const fkWasOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1;
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE users RENAME TO users_old;');
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'master' CHECK (role IN ('super_admin', 'master')),
        permissions TEXT NOT NULL DEFAULT '[]',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const rows = db.prepare('SELECT * FROM users_old').all();
    const ins = db.prepare(
      'INSERT INTO users (id, full_name, username, email, password_hash, role, permissions, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    let firstAdminDone = false;
    for (const r of rows) {
      let role = r.role;
      let permissions = '[]';
      if (role === 'admin') {
        if (!firstAdminDone) {
          firstAdminDone = true;
          role = 'super_admin';
        } else {
          role = 'master';
        }
      }
      if (role === 'master') permissions = JSON.stringify(DEFAULT_MASTER_PERMISSIONS);
      ins.run(
        r.id,
        r.full_name || r.username || '',
        r.username,
        r.email,
        r.password_hash,
        role,
        permissions,
        r.is_active,
        r.created_at
      );
    }
    db.exec('DROP TABLE users_old;');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${fkWasOn ? 'ON' : 'OFF'};`);
  }
}

migrate();

const DEFAULT_SETTINGS = {
  site: {
    name: 'AvtoServis',
    logo: '',
    favicon: '',
    phone: '+998 90 123 45 67',
    email: 'info@avtoservis.uz',
    telegram: 'https://t.me/avtoservis',
    instagram: 'https://instagram.com/avtoservis',
    address: 'Toshkent sh., Chilonzor tumani, 12-mavze',
    working_hours: 'Dushanba – Shanba: 09:00 – 19:00',
  },
  hero: {
    title: 'Avtomobilingiz uchun professional xizmat',
    subtitle: 'Tajribali ustalar, zamonaviy uskunalar va sifatli ehtiyot qismlar. Avtomobilingiz ishonchli qo\'llarda.',
    background_image: '',
    button_text: 'Xizmatlar',
    button_link: '#services',
    show: true,
  },
  about: {
    title: 'Biz haqimizda',
    description: 'AvtoServis — avtomobillarga texnik xizmat ko\'rsatish bo\'yicha yuqori malakali mutaxassislar jamoasi. Biz zamonaviy diagnostika uskunalari bilan ishlaymiz va har bir mijozga individual yondashamiz.',
    image: '',
    experience: 10,
    experience_label: 'Yillik tajriba',
    show: true,
  },
  contact: {
    phone: '+998 90 123 45 67',
    telegram: 'https://t.me/avtoservis',
    instagram: 'https://instagram.com/avtoservis',
    address: 'Toshkent sh., Chilonzor tumani, 12-mavze',
    email: 'info@avtoservis.uz',
    working_hours: 'Dushanba – Shanba: 09:00 – 19:00\nYakshanba: dam olish kuni',
    map_link: '',
  },
  design: {
    primary_color: '#e11d2e',
    secondary_color: '#0f1722',
    font_family: 'Manrope',
    show_services: true,
    show_about: true,
  },
  footer: {
    text: 'AvtoServis — avtomobilingizga sifatli texnik xizmat.',
    copyright: '© 2026 AvtoServis. Barcha huquqlar himoyalangan.',
  },
  worklog: {
    public_show: false,
  },
};

const getDefault = (key) => {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown settings key: ${key}`);
  return JSON.stringify(DEFAULT_SETTINGS[key]);
};

function seed() {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  );
  for (const key of Object.keys(DEFAULT_SETTINGS)) upsert.run(key, getDefault(key));

  const count = db.prepare('SELECT COUNT(*) AS c FROM services').get().c;
  if (count === 0) {
    const insert = db.prepare(
      `INSERT INTO services (name, description, benefits, image, icon, price, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    );
    const services = [
      ['Mator xodovoy', 'Dvigatel va xodovoy qismlarni ta\'mirlash bo\'yicha to\'liq xizmat: kapital va joriy ta\'mirlash, moy va filtrlarni almashtirish.', 'Sifatli ehtiyot qismlar|Kafolatli ta\'mirlash|Tajribali ustalar', '', 'engine', '', 1],
      ['Diagnostika', 'Kompyuter diagnostikasi yordamida avtomobilingizning barcha tizimlarini tekshiramiz.', 'Xatolarni aniq aniqlash|Tezkor natija|Sizga qulay vaqt', '', 'diagnostic', '', 2],
      ['Programma', 'Avtomobil tizimlarini sozlash, chip tuning va dasturiy ta\'minotni yangilash xizmatlari.', 'Quvvat oshishi|Yoqilg\'i tejalishi|Tizim barqarorligi', '', 'chip', '', 3],
      ['Elektrik', 'Avtomobil elektr qismlarini diagnostika qilish va ta\'mirlash: starter, generator, simlar.', 'Zamonaviy uskunalar|Aniq sababni topish|Ishonchli ta\'mirlash', '', 'bolt', '', 4],
      ['Moy almashtirish', 'Dvigatel moyi va filtrlarini tez va sifatli almashtirish. Barcha turdagi moylar.', 'Moy turini tanlashda yordam|Tez xizmat|Toza ish joyi', '', 'oil', '', 5],
    ];
    for (const s of services) insert.run(...s);
  }
}

function resetSettings() {
  const del = db.prepare('DELETE FROM settings');
  del.run();
  seed();
}

module.exports = { db, DEFAULT_SETTINGS, DEFAULT_MASTER_PERMISSIONS, seed, resetSettings };

if (require.main === module) {
  seed();
  console.log('[db] Seeded. Users:', db.prepare('SELECT COUNT(*) c FROM users').get().c, 'Services:', db.prepare('SELECT COUNT(*) c FROM services').get().c);
}