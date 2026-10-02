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
    console.error(`[migrate] schema incomplete: ${status.missing} table(s) missing`);
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
