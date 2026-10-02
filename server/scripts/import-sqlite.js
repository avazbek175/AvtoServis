/**
 * One-way data migration: SQLite -> PostgreSQL.
 *
 * Reads an existing `avtoservis.db` and copies every row into PostgreSQL,
 * preserving primary keys so foreign keys stay valid. Safe to re-run: rows are
 * upserted on their primary key, and nothing in the source file is modified or
 * deleted.
 *
 *   npm run db:import-sqlite -- --file ../data/avtoservis.db --dry-run
 *   npm run db:import-sqlite -- --file ../data/avtoservis.db
 *
 * The target database must already be migrated (`npm run db:migrate`).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { query, transaction, toPgPlaceholders } = require('../src/db/pool');
const { migrate } = require('../src/db/migrate');

function parseArgs(argv) {
  const out = { file: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file' || argv[i] === '-f') out.file = argv[++i] || '';
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const sourceFile = path.resolve(args.file || path.join(__dirname, '..', 'data', 'avtoservis.db'));

if (!fs.existsSync(sourceFile)) {
  console.error(`[import] SQLite file not found: ${sourceFile}`);
  process.exit(1);
}

// Table order respects foreign keys. Sessions are skipped: they are short-lived
// and every existing browser is forced to log in again after the switch.
const TABLES = [
  { name: 'users', pk: 'id' },
  { name: 'master_applications', pk: 'id' },
  { name: 'services', pk: 'id' },
  { name: 'settings', pk: 'key' },
  { name: 'media', pk: 'id' },
  { name: 'work_logs', pk: 'id' },
  { name: 'work_log_images', pk: 'id' },
];

async function migrateFirst() {
  await migrate({ log: (m) => console.log(m) });
}

async function run() {
  console.log(`[import] source: ${sourceFile}`);
  console.log(`[import] target: ${new URL(require('../src/db/pool').connectionString).pathname}`);
  await migrateFirst();

  const src = new DatabaseSync(sourceFile, { readOnly: true });
  const summary = [];

  try {
    for (const table of TABLES) {
      const exists = src
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table.name);
      if (!exists) {
        summary.push([table.name, 0, 'table missing']);
        continue;
      }

      const rows = src.prepare(`SELECT * FROM ${table.name}`).all();
      if (!rows.length) {
        summary.push([table.name, 0, 'empty']);
        continue;
      }

      if (args.dryRun) {
        summary.push([table.name, rows.length, 'dry-run, not written']);
        continue;
      }

      const columns = Object.keys(rows[0]);
      const sql = toPgPlaceholders(
        `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ` +
          `ON CONFLICT (${table.pk}) DO UPDATE SET ${columns
            .filter((c) => c !== table.pk)
            .map((c) => `${c} = EXCLUDED.${c}`)
            .join(', ')}`
      );

      // One transaction per table: a failure cannot leave half a table imported,
      // and re-running resumes from the table boundary.
      await transaction(async (t) => {
        for (const row of rows) {
          await t.query(sql, columns.map((c) => row[c]));
        }
        // Identity sequences start at 1 and would collide with the imported ids
        // on the next INSERT, so advance each one past the highest id present.
        if (table.pk === 'id') {
          await t.raw(
            `SELECT setval(pg_get_serial_sequence('${table.name}', 'id'), COALESCE((SELECT MAX(id) FROM ${table.name}), 1))`
          );
        }
      });

      summary.push([table.name, rows.length, 'imported']);
    }
  } finally {
    src.close();
  }

  for (const [name, count, note] of summary) {
    console.log(`[import] ${name.padEnd(22)} ${String(count).padStart(6)} rows  ${note}`);
  }

  const { rows } = await query(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM services) AS services,
            (SELECT COUNT(*) FROM work_logs) AS work_logs,
            (SELECT COUNT(*) FROM settings) AS settings`
  );
  console.log('[import] target now holds:', rows[0]);
  console.log(args.dryRun ? '[import] dry run finished, nothing was written' : '[import] done');
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[import] failed: ${err.message}`);
    process.exit(1);
  });
