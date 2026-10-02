const { db, DEFAULT_SETTINGS } = require('./db');

const VALID_KEYS = Object.keys(DEFAULT_SETTINGS);

function unknownKeyError(key) {
  const err = new Error(`Unknown settings key: ${key}`);
  err.status = 400;
  return err;
}

/**
 * Fills in keys that are missing from a stored settings object.
 *
 * The admin panel and the public site read the same contract, so a setting added
 * to DEFAULT_SETTINGS after a site was first set up must still be visible with its
 * default (e.g. `contact.show`). Stored values are never overwritten, so existing
 * content survives the upgrade without a data migration.
 */
function withDefaults(key, stored) {
  const defaults = DEFAULT_SETTINGS[key];
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return stored;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return stored;
  const out = { ...defaults };
  for (const [k, v] of Object.entries(stored)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function getSetting(key) {
  if (!VALID_KEYS.includes(key)) throw unknownKeyError(key);
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return JSON.parse(DEFAULT_SETTINGS[key]);
  try {
    return withDefaults(key, JSON.parse(row.value));
  } catch {
    return JSON.parse(DEFAULT_SETTINGS[key]);
  }
}

async function setSetting(key, value) {
  if (!VALID_KEYS.includes(key)) throw unknownKeyError(key);
  let parsed = value;
  if (typeof value !== 'object') {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  }
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(parsed));
  return parsed;
}

async function getAllSettings() {
  const out = {};
  for (const key of VALID_KEYS) out[key] = await getSetting(key);
  return out;
}

module.exports = { getSetting, setSetting, getAllSettings, VALID_KEYS };