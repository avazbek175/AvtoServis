const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT app_now()
    )
  `);
}

async function appliedVersions(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Applies every migration that has not run yet.
 *
 * Each file runs in its own transaction together with the bookkeeping row, so a
 * failure leaves the schema exactly as it was and re-running is safe. Files are
 * applied in filename order and never re-applied.
 */
async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  const applied = [];
  try {
    // app_now() must exist before schema_migrations uses it as a default.
    await client.query(`
      CREATE OR REPLACE FUNCTION app_now() RETURNS text
        LANGUAGE sql VOLATILE AS $$
          SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
        $$;
    `);

    const files = migrationFiles();
    if (!files.length) {
      log('[migrate] no migration files found');
      return [];
    }

    await client.query('BEGIN');
    await ensureMigrationsTable(client);
    await client.query('COMMIT');

    const done = await appliedVersions(client);
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`[migrate] ${file} failed: ${err.message}`);
      }
    }

    if (!applied.length) log(`[migrate] already up to date (${files.length} files)`);
    return applied;
  } finally {
    client.release();
  }
}

/**
 * Cheap read-only check used on boot so a misconfigured deployment reports the
 * real problem instead of failing later with "relation does not exist".
 */
async function checkSchema() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT COUNT(*)::int AS missing
      FROM (VALUES ('users'),('sessions'),('settings'),('services'),
                   ('work_logs'),('work_log_images'),('media'),('master_applications'))
             AS expected(name)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = expected.name
      )
    `);
    return { ok: Number(rows[0].missing) === 0, missing: Number(rows[0].missing) };
  } finally {
    client.release();
  }
}

module.exports = { migrate, checkSchema, MIGRATIONS_DIR };
