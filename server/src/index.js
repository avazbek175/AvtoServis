require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { seed } = require('./db');
const { migrate, checkSchema } = require('./db/migrate');
const auth = require('./auth');

const authRouter = require('./routes/auth');
const publicRouter = require('./routes/public');
const adminRouter = require('./routes/admin');
const mediaRouter = require('./routes/media');
const worklogsRouter = require('./routes/worklogs');
const workimagesRouter = require('./routes/workimages');
const { createCorsOptions, ConfigurationError } = require('./cors');

const app = express();

/**
 * Connection-level failures worth retrying during startup.
 *
 * A cold start on a serverless host can race the provider's own failover or
 * exhaust the connection pool while a neighbouring instance is migrating,
 * which surfaces as `Connection terminated due to connection timeout` or a
 * socket reset. Those are transient. A schema or SQL error is not, and must
 * fail immediately so the real message is not hidden behind retries.
 */
const TRANSIENT_DB_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  '57P01',   // admin_shutdown
  '57P02',   // crash_shutdown
  '57P03',   // cannot_connect_now
  '08000', '08003', '08006', '08001', '08004', // connection exceptions
  '53300',   // too_many_connections
]);

function isTransientDbError(err) {
  if (!err) return false;
  if (TRANSIENT_DB_CODES.has(err.code)) return true;
  // node-postgres surfaces a dropped socket as this message with no code.
  return /Connection terminated|connection timeout|Client has encountered a connection error|timeout exceeded when trying to connect|server closed the connection/i.test(
    String(err.message || '')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn`, retrying only transient connection failures. */
async function withDbRetry(fn, { attempts = 3, baseDelayMs = 500, log = console.error } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransientDbError(err)) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      log(`[db] transient connection failure (${err.code || err.message}), retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

/**
 * Schema + defaults must be in place before the first request is served.
 *
 * Both steps are idempotent and guarded by an advisory lock inside `migrate()`,
 * so this is safe on every cold start even when several instances boot at once.
 * They are chained into a single promise the request layer awaits, instead of
 * being fired off and forgotten, which would let the first query race the
 * migration and fail with "relation does not exist".
 */
const ready = withDbRetry(() => migrate())
  .then(() => withDbRetry(() => seed()))
  // Expired-session cleanup needs the sessions table, so it runs here rather
  // than at module load. It is opportunistic and never blocks startup.
  .then(() => auth.pruneSessions().catch((err) => console.error('[auth] session prune failed:', err.message)));

/**
 * Holds every request until the schema and default settings exist.
 *
 * Without this gate a request that arrives during the first cold start would
 * hit an unmigrated database and fail with "relation does not exist".
 * A startup failure is reported as 503 on every route rather than being an
 * unhandled rejection, so the process stays up and the provider can retry.
 */
app.use((req, res, next) => {
  ready.then(
    () => next(),
    (err) => {
      console.error('[db] startup failed: ' + err.message);
      // A pre-existing table with an incompatible shape is the usual cause on a
      // migrated database. Naming the table and columns turns an opaque
      // "column key does not exist" into something actionable.
      withDbRetry(checkSchema)
        .then((status) => {
          if (status.ok) {
            console.error('[db] schema check passed, so the failure is not a missing table or column');
          } else {
            for (const p of status.problems) {
              if (p.problem === 'table missing') {
                console.error(`[db] table "${p.table}" is missing — run: npm run db:migrate -w server`);
              } else {
                console.error(
                  `[db] table "${p.table}" is missing column(s): ${p.missing.join(', ')} — ` +
                    'an older schema is present; run: npm run db:migrate -w server'
                );
              }
            }
          }
        })
        .catch(() => {})
        .finally(() => res.status(503).json({ error: 'Database is not ready' }));
    }
  );
});
const PORT = process.env.PORT || 4000;

// Misconfiguration must fail loudly at boot instead of degrading into an
// unauthenticated "allow any origin" API or a per-instance JWT secret that logs
// everyone out on the next cold start.
let corsPolicy;
try {
  corsPolicy = createCorsOptions();
  auth.assertProductionConfig();
} catch (err) {
  if (err instanceof ConfigurationError) {
    console.error('[config] ' + err.message);
    process.exit(1);
  }
  console.error('[config] ' + err.message);
  process.exit(1);
}

app.disable('x-powered-by');

// Only trust X-Forwarded-For when explicitly told to; otherwise req.ip is the
// real peer address and a client cannot spoof its own rate-limit bucket.
const trustProxy = String(process.env.TRUST_PROXY || '').trim();
if (trustProxy) {
  app.set('trust proxy', /^(true|1)$/i.test(trustProxy) ? true : isNaN(Number(trustProxy)) ? trustProxy : Number(trustProxy));
}

app.use(corsPolicy.guard);
app.use(cors(corsPolicy.options));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/public', publicRouter);
app.use('/api/admin', adminRouter);
app.use('/api/media', mediaRouter);
app.use('/api/admin/worklogs', worklogsRouter);
app.use('/api/workimages', workimagesRouter);

const uploadsDir = require('./paths').uploadsDir;

// Work-log images live in `uploads/work` and may belong to private work logs.
// They must only be reachable through /api/workimages/:filename, which enforces
// per-work-log authorization. Serving the whole uploads directory statically would
// expose them at /uploads/work/<file> without any check, so that prefix is
// rejected before the static handler runs. All other uploads stay public.
const PRIVATE_UPLOAD_DIRS = ['work'];

function isPrivateUploadPath(requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(requestPath || ''));
  } catch {
    return true;
  }
  const normalized = path.posix
    .normalize(decoded.replace(/\\/g, '/'))
    .replace(/^\/+/, '')
    .toLowerCase();
  return PRIVATE_UPLOAD_DIRS.some((dir) => normalized === dir || normalized.startsWith(dir + '/'));
}

app.use('/uploads', (req, res, next) => {
  if (isPrivateUploadPath(req.path)) {
    return res.status(404).json({ error: 'Fayl topilmadi' });
  }
  next();
});
app.use('/uploads', express.static(uploadsDir));

// Public liveness probe. It must not leak business data (row counts, versions,
// hostnames), so anything detailed lives behind the authenticated admin endpoint.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Fayl juda katta (maks 6MB)' : 'Fayl yuklash xatosi';
    return res.status(400).json({ error: msg });
  }
  // Validation errors carry `status`/`statusCode` in the 4xx range and are safe to
  // surface. Anything else is treated as a server fault so no internals leak.
  const raw = Number(err.status || err.statusCode);
  const status = Number.isInteger(raw) && raw >= 400 && raw < 500 ? raw : 500;
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

// Single-process deployment (e.g. `npm start` with the client built): serve the
// SPA from the same origin. On Vercel the client is a separate service with its
// own root directory, so there is no client/dist here and routing is handled by
// the rewrite rules in vercel.json instead.
const isVercel = Boolean(process.env.VERCEL);
const distPath = path.join(__dirname, '..', '..', 'client', 'dist');
if (process.env.NODE_ENV === 'production' && !isVercel) {
  app.use(express.static(distPath));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Vercel invokes the exported Express app and supplies its own listener, so
// binding a port here would hang or crash the function.
if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;