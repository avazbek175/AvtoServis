const { db, DEFAULT_SETTINGS } = require('./db');

const VALID_KEYS = Object.keys(DEFAULT_SETTINGS);

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return JSON.parse(DEFAULT_SETTINGS[key]);
  try {
    return JSON.parse(row.value);
  } catch {
    return JSON.parse(DEFAULT_SETTINGS[key]);
  }
}

function setSetting(key, value) {
  if (!VALID_KEYS.includes(key)) {
    const err = new Error(`Unknown settings key: ${key}`);
    err.status = 400;
    throw err;
  }
  let parsed = value;
  if (typeof value !== 'object') {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(parsed));
  return parsed;
}

function getAllSettings() {
  const out = {};
  for (const key of VALID_KEYS) out[key] = getSetting(key);
  return out;
}

module.exports = { getSetting, setSetting, getAllSettings, VALID_KEYS };