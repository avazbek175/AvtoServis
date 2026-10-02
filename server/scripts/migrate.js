#!/usr/bin/env node
/**
 * Applies pending migrations to DATABASE_URL.
 *
 * Usage: npm run db:migrate -w server
 */
require('dotenv').config();
const { migrate, checkSchema } = require('../src/db/migrate');
const { pool } = require('../src/db/pool');

async function main() {
  const applied = await migrate();
  const status = await checkSchema();
  if (!status.ok) {
    // Naming the table and the columns turns a cryptic runtime failure into
    // something the operator can act on directly.
    for (const p of status.problems) {
      if (p.problem === 'table missing') {
        console.error(`[migrate] table "${p.table}" is missing`);
      } else {
        console.error(`[migrate] table "${p.table}" is missing column(s): ${p.missing.join(', ')}`);
      }
    }
    process.exitCode = 1;
    return;
  }
  console.log(applied.length ? `[migrate] done (${applied.length} applied)` : '[migrate] nothing to do');
}

main()
  .catch((err) => {
    console.error('[migrate] error:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
