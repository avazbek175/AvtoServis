const { Pool, types } = require('pg');

// int8 (bigint) is returned as a string by node-postgres. Every bigint in this
// schema is either a COUNT(*) or a millisecond timestamp, both far below
// Number.MAX_SAFE_INTEGER, so converting keeps the JSON API numeric
// (COUNT(*) must not become "5" in admin/health responses).
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

// numeric (OID 1700) also arrives as a string by default. The inventory ledger
// stores stock and money in NUMERIC so PostgreSQL does the arithmetic exactly;
// without this parser those exact values would reach the JSON API as strings
// ("23.5" instead of 23.5) and every consumer would have to remember to coerce.
// The widest numeric in the schema is NUMERIC(12,3), i.e. under 10^12, which is
// exactly representable as a double, so nothing is lost in transport.
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

const connectionString = String(process.env.DATABASE_URL || '').trim();

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is required. Set it to a PostgreSQL connection string, ' +
      'e.g. postgresql://user:password@host:5432/avtoservis'
  );
}

// Managed PostgreSQL (Vercel Postgres, Neon, Supabase, ...) requires TLS;
// a local cluster usually does not offer it.
function resolveSsl() {
  const explicit = String(process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (explicit === 'disable' || explicit === 'false' || explicit === '0') return false;
  if (explicit === 'require' || explicit === 'true' || explicit === '1') return { rejectUnauthorized: false };
  if (/sslmode=/.test(connectionString)) return undefined; // node-postgres parses it
  if (/(localhost|127\.0\.0\.1|\/tmp|\.sock)/.test(connectionString)) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 10000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
  ssl: resolveSsl(),
  // Serverless: do not keep the process alive just because of idle pool clients.
  allowExitOnIdle: true,
});

pool.on('error', (err) => {
  // An idle client can be killed by the provider at any time. The pool recovers
  // on the next query, so this must not crash the function.
  console.error('[db] idle client error:', err.message);
});

/**
 * Rewrites SQLite-style `?` placeholders into PostgreSQL `$1, $2, ...`.
 *
 * Keeping the original SQL text in the routes means the queries stay readable and
 * reviewable; only the wire format changes. Characters inside string literals,
 * quoted identifiers and comments are left untouched.
 */
function toPgPlaceholders(sql) {
  let out = '';
  let index = 0;
  let param = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      out += ch;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        out += ch + next;
        i++;
      } else {
        out += ch;
      }
      continue;
    }
    if (inSingle) {
      out += ch;
      if (ch === "'") {
        if (next === "'") {
          out += next;
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === '?') {
      param++;
      out += '$' + param;
      index++;
      continue;
    }
    out += ch;
  }

  if (inSingle || inDouble || inBlockComment) {
    throw new Error('Unterminated SQL literal in query: ' + sql.slice(0, 80));
  }
  return out;
}

/** Query on a pooled connection. */
async function query(text, params = []) {
  return pool.query(text, params);
}

/**
 * Builds the `get/all/run/one` statement API on top of any `runner`
 * (the pool itself, or a single client inside a transaction).
 *
 * Keeping one implementation means a query written inside `db.transaction()`
 * behaves exactly like one written outside it.
 */
function statement(runner, sql) {
  const run = (params) => runner(sql, params);
  return {
    sql,
    get: async (p = []) => (await run(p)).rows[0],
    all: async (p = []) => (await run(p)).rows,
    run: async (p = []) => {
      const res = await run(p);
      return { changes: res.rowCount, rows: res.rows };
    },
    /** For INSERT/UPDATE/DELETE ... RETURNING: resolves to the first row. */
    one: async (p = []) => (await run(p)).rows[0],
  };
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
async function transaction(fn) {
  const client = await pool.connect();
  const scoped = {
    /** Parameterised query on this transaction's connection. */
    query: (text, params = []) => client.query(text, params),
    /** Same `?` -> `$n` conversion and get/all/run/one API as `db.prepare`. */
    prepare: (sql) => {
      const stmt = statement((s, p) => client.query(s, p), toPgPlaceholders(sql));
      const wrap = (fn) => async (...params) => fn(params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
      return { sql: stmt.sql, get: wrap(stmt.get), all: wrap(stmt.all), run: wrap(stmt.run), one: wrap(stmt.one) };
    },
    raw: (text) => client.query(text),
  };
  try {
    await client.query('BEGIN');
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection is already broken; releasing it is enough */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, transaction, statement, toPgPlaceholders, connectionString };
