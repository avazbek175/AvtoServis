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
/**
 * Advisory lock key for migrations.
 *
 * Every Vercel instance runs the migration on cold start. Without a lock two
 * instances read the same `schema_migrations` state, both decide a file is
 * pending, and both try to apply it. That surfaces as `tuple concurrently
 * updated`, duplicate-key errors on `schema_migrations`, or a half-applied
 * schema. Any arbitrary but stable 64-bit key works; the value only has to be
 * unique within this database.
 */
const MIGRATION_LOCK_ID = 728411905517;

async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  const applied = [];
  // Held for the whole run and released when the client is returned to the
  // pool, so a crashed migration cannot leave the lock stuck.
  let locked = false;
  try {
    // Wait rather than fail: the winner finishes in seconds, and a losing
    // instance must still end up on a migrated schema.
    await client.query('SELECT pg_advisory_lock($1)', [String(MIGRATION_LOCK_ID)]);
    locked = true;

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
        // ON CONFLICT keeps a re-run from failing if the bookkeeping row was
        // written by an earlier attempt whose transaction later aborted.
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [file]);
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
    if (locked) {
      // Best effort: the lock is also released when the connection closes.
      await client.query('SELECT pg_advisory_unlock($1)', [String(MIGRATION_LOCK_ID)]).catch(() => {});
    }
    client.release();
  }
}

/**
 * Columns the application reads or writes, per table.
 *
 * Checking table names alone is not enough: `CREATE TABLE IF NOT EXISTS`
 * silently skips an existing table regardless of its columns, so a database
 * created from an older schema passes a name check and then fails with
 * `column "key" of relation "settings" does not exist`. Verifying the columns
 * turns that into a precise, actionable startup error.
 */
const EXPECTED_COLUMNS = {
  users: ['id', 'full_name', 'username', 'email', 'password_hash', 'role', 'permissions', 'is_active', 'created_at'],
  master_applications: ['id', 'full_name', 'phone', 'email', 'username', 'password_hash', 'specialty', 'message', 'status', 'rejection_reason', 'created_at', 'reviewed_at', 'reviewed_by'],
  services: ['id', 'name', 'description', 'benefits', 'image', 'icon', 'price', 'sort_order', 'is_active', 'created_at'],
  settings: ['key', 'value'],
  media: ['id', 'filename', 'original_name', 'mime', 'size', 'object_key', 'created_at'],
  sessions: ['token_id', 'user_id', 'created_at', 'expires_at'],
  work_logs: ['id', 'master_id', 'title', 'customer_name', 'customer_phone', 'car_brand', 'car_model', 'car_number', 'service_type', 'description', 'start_date', 'end_date', 'price', 'status', 'is_public', 'notes', 'created_at', 'updated_at'],
  work_log_images: ['id', 'work_log_id', 'image_path', 'original_filename', 'object_key', 'created_at'],
};

/**
 * Read-only check used on boot so a misconfigured or partially migrated
 * database reports the real problem instead of failing later inside a route.
 *
 * Returns a list of problems rather than a boolean so the operator is told
 * which table and which column is wrong.
 */
async function checkSchema() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
    `);
    const present = new Map();
    for (const row of rows) {
      if (!present.has(row.table_name)) present.set(row.table_name, new Set());
      present.get(row.table_name).add(row.column_name);
    }

    const problems = [];
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const actual = present.get(table);
      if (!actual) {
        problems.push({ table, problem: 'table missing' });
        continue;
      }
      const missing = columns.filter((c) => !actual.has(c));
      if (missing.length) {
        problems.push({ table, problem: 'columns missing', missing });
      }
    }
    return { ok: problems.length === 0, problems };
  } finally {
    client.release();
  }
}

module.exports = { migrate, checkSchema, MIGRATIONS_DIR, EXPECTED_COLUMNS };
