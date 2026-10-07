const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');
const { withAdvisoryXactLock } = require('./advisory');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

/**
 * Advisory lock key for migrations.
 *
 * Every Vercel instance migrates on cold start. Without a lock two of them read
 * the same `schema_migrations` state, both decide a file is pending, and both
 * apply it, which surfaces as `tuple concurrently updated`, duplicate rows, or a
 * half-applied schema. Any stable 64-bit key works; it only has to be unique
 * within this database. The lock itself is transaction-scoped -- see
 * db/advisory.js for why a session lock must not be used with a pooled client.
 */
const MIGRATION_LOCK_ID = 728411905517;

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

/**
 * Files that still need to run, read without any lock.
 *
 * This is the path every cold start takes once the schema is current, and it must
 * stay lock-free: taking a lock just to discover there is nothing to do would make
 * unrelated instances contend on every single boot.
 *
 * `to_regclass` is used instead of catching 42P01, so a first boot on an empty
 * database does not log a `relation "schema_migrations" does not exist` error.
 */
async function pendingFiles(client, files) {
  const { rows } = await client.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS present");
  if (!rows[0].present) return files;
  const done = await appliedVersions(client);
  return files.filter((f) => !done.has(f));
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
 * Each file is applied in its own transaction together with its bookkeeping row,
 * so a failure leaves the schema exactly as it was and re-running is safe. The
 * serialization lock is transaction-scoped and taken inside that same
 * transaction, which means PostgreSQL releases it on COMMIT or ROLLBACK.
 *
 * Concurrent instances re-check `schema_migrations` under the lock, so a file is
 * applied once no matter how many instances boot at the same moment.
 */
async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  const applied = [];
  try {
    const files = migrationFiles();
    if (!files.length) {
      log('[migrate] no migration files found');
      return [];
    }

    const pending = await pendingFiles(client, files);
    if (!pending.length) {
      log(`[migrate] already up to date (${files.length} files)`);
      return [];
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const didApply = await withAdvisoryXactLock(
        client,
        MIGRATION_LOCK_ID,
        async () => {
          // app_now() must exist before schema_migrations uses it as a default.
          // It is created under the lock: concurrent `CREATE OR REPLACE FUNCTION`
          // on the same function is not safe (it fails with XX000/23505), and
          // instances only reach this point when they have work to do.
          await client.query(`
            CREATE OR REPLACE FUNCTION app_now() RETURNS text
              LANGUAGE sql VOLATILE AS $$
                SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
              $$;
          `);
          await ensureMigrationsTable(client);
          // Re-read under the lock: a concurrent instance may have just applied
          // this file while we were waiting for it.
          if ((await appliedVersions(client)).has(file)) return false;
          await client.query(sql);
          // ON CONFLICT keeps a re-run from failing if the bookkeeping row was
          // written by an earlier attempt whose transaction later aborted.
          await client.query(
            'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
            [file]
          );
          return true;
        },
        { name: 'migration' }
      ).catch((err) => {
        // Keep `code` so withDbRetry() can still tell a transient database
        // failure from a genuine SQL error.
        const wrapped = new Error(`[migrate] ${file} failed: ${err.message}`);
        if (err.code) wrapped.code = err.code;
        throw wrapped;
      });

      if (didApply) {
        applied.push(file);
        log(`[migrate] applied ${file}`);
      }
    }

    return applied;
  } finally {
    // Nothing is held across this point: the lock died with its transaction.
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
  inventory_products: ['id', 'name', 'type', 'brand', 'viscosity', 'unit', 'package_size', 'current_quantity', 'minimum_quantity', 'cost_price', 'markup_amount', 'is_active', 'created_at', 'updated_at'],
  inventory_movements: ['id', 'product_id', 'movement_type', 'quantity', 'before_quantity', 'after_quantity', 'reference_type', 'reference_id', 'admin_id', 'note', 'created_at'],
  service_materials: ['id', 'work_log_id', 'product_id', 'quantity', 'movement_id', 'created_at'],
  inventory_audit_logs: ['id', 'product_id', 'action', 'admin_id', 'admin_name', 'metadata', 'created_at'],
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

module.exports = { migrate, checkSchema, MIGRATIONS_DIR, EXPECTED_COLUMNS, MIGRATION_LOCK_ID };
