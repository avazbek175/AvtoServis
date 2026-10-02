const { pool, query, transaction, statement, toPgPlaceholders } = require('./pool');

const { DEFAULT_SETTINGS, DEFAULT_MASTER_PERMISSIONS } = require('./defaults');

/**
 * Query facade.
 *
 * Call sites keep the familiar `db.prepare(sql).get(...)` shape so route code
 * stays readable; the methods are async because PostgreSQL has no synchronous API.
 * `?` placeholders are rewritten to `$n` automatically.
 *
 * SQLite-isms deliberately NOT emulated (they are ported properly instead):
 *   - `last_insert_rowid()`  -> `.one()` with `RETURNING id`
 *   - `INSERT OR REPLACE`    -> `INSERT ... ON CONFLICT ... DO UPDATE`
 *   - `datetime('now')`      -> `app_now()` (migrations/001_init.sql)
 *   - `BEGIN`/`COMMIT`       -> `db.transaction(async (t) => { ... })`
 */

// Opt-in statement counter (DB_TRACE_QUERIES=1) used by the N+1 regression test.
const stats = { count: 0, enabled: process.env.DB_TRACE_QUERIES === '1' };

function flatten(params) {
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

function prepare(sql) {
  if (stats.enabled) stats.count++;
  const stmt = statement((text, params) => query(text, params), toPgPlaceholders(sql));
  // Accept both `stmt.get(a, b)` and `stmt.get([a, b])` so call sites can pass
  // spread params or a ready-made array.
  const wrap = (fn) => async (...params) => fn(flatten(params));
  return {
    sql: stmt.sql,
    get: wrap(stmt.get),
    all: wrap(stmt.all),
    run: wrap(stmt.run),
    /** For INSERT/UPDATE/DELETE ... RETURNING: resolves to the first row. */
    one: wrap(stmt.one),
  };
}

/** Statement with no parameters (schema checks, diagnostics). */
function prepareRaw(sql) {
  return {
    get: async () => (await query(sql)).rows[0],
    all: async () => (await query(sql)).rows,
  };
}

const counter = {
  get: () => stats.count,
  reset: () => {
    stats.count = 0;
  },
  enabled: () => stats.enabled,
};

// Exposed on `db` so the diagnostics route can read the counter without
// importing this module's internals.
const db = {
  prepare,
  prepareRaw,
  transaction,
  query,
  pool,
  __getQueryCount: counter.get,
  __resetQueryCount: counter.reset,
  __traceEnabled: counter.enabled,
};
async function seed() {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    await query(
      toPgPlaceholders('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING'),
      [key, JSON.stringify(DEFAULT_SETTINGS[key])]
    );
  }

  const { rows } = await query('SELECT COUNT(*) AS c FROM services');
  if (Number(rows[0].c) === 0) {
    const services = [
      ['Mator xodovoy', 'Dvigatel va xodovoy qismlarni ta\'mirlash bo\'yicha to\'liq xizmat: kapital va joriy ta\'mirlash, moy va filtrlarni almashtirish.', 'Sifatli ehtiyot qismlar|Kafolatli ta\'mirlash|Tajribali ustalar', '', 'engine', '', 1],
      ['Diagnostika', 'Komputer diagnostikasi yordamida avtomobilingizning barcha tizimlarini tekshiramiz.', 'Xatolarni aniq aniqlash|Tezkor natija|Sizga qulay vaqt', '', 'diagnostic', '', 2],
      ['Programma', 'Avtomobil tizimlarini sozlash, chip tuning va dasturiy ta\'minotni yangilash xizmatlari.', 'Quvvat oshishi|Yoqilgan\'i tejalishi|Tizim barqarorligi', '', 'chip', '', 3],
      ['Elektrik', 'Avtomobil elektr qismlarini diagnostika qilish va ta\'mirlash: starter, generator, simlar.', 'Zamonaviy uskunalar|Aniq sababni topish|Ishonchli ta\'mirlash', '', 'bolt', '', 4],
      ['Moy almashtirish', 'Dvigatel moyi va filtrlarni tez va sifatli almashtirish. Barcha turdagi moylar.', 'Moy turini tanlashda yordam|Tez xizmat|Toza ish joyi', '', 'oil', '', 5],
    ];
    for (const s of services) {
      await query(
        toPgPlaceholders(
          'INSERT INTO services (name, description, benefits, image, icon, price, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
        ),
        s
      );
    }
  }
}

async function resetSettings() {
  await query('DELETE FROM settings');
  await seed();
}

module.exports = { db, counter, pool, query, transaction, prepare, DEFAULT_SETTINGS, DEFAULT_MASTER_PERMISSIONS, seed, resetSettings };
