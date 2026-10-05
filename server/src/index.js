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
const debtsRouter = require('./routes/debts').router;
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
 * A failed attempt must not be remembered forever. `ready` used to be a single
 * promise created at import time, which made one failed cold start fatal for the
 * whole life of the instance: every later request saw the same rejected promise
 * and answered 503, even after the database had become perfectly healthy again.
 * On a serverless host that is very visible, because requests are spread over many
 * instances -- some of which booted successfully and answer 200 while the ones
 * that lost the startup race answer 503 indefinitely.
 *
 * The state below is therefore self-healing: a success is latched, but a failure
 * only records the error and a backoff deadline, so a later request retries the
 * sequence. Attempts are single-flighted, so concurrent requests trigger one run.
 */
const STARTUP_RETRY_BASE_MS = Number(process.env.DB_STARTUP_RETRY_MS || 1000);
const STARTUP_RETRY_MAX_MS = Number(process.env.DB_STARTUP_RETRY_MAX_MS || 30000);

const startup = {
  ready: false,
  inFlight: null,
  lastError: null,
  failures: 0,
  nextAttemptAt: 0,
};

/**
 * Removes anything credential-shaped from text that is about to be logged.
 *
 * PostgreSQL connection errors can echo the connection target, and a caller can
 * pass any error object, so the URL userinfo and `password=` parameters are
 * masked before the message reaches the log.
 */
function sanitizeDbMessage(value) {
  return String(value == null ? '' : value)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***@')
    .replace(/(password\s*=\s*)("?)[^\s&"']+\2/gi, '$1***')
    .replace(/\b(sslkey|sslcert|sslpassword)=[^\s&]+/gi, '$1=***');
}

/** Names the failing stage so the log says which step broke, not just that one did. */
function startupFailureText(err) {
  const stage = (err && err.startupStage) || 'startup';
  const code = (err && err.code) ? String(err.code) : 'no code';
  const detail = sanitizeDbMessage((err && err.message) || err);
  const attempts = err && err.attempts ? ` after ${err.attempts} attempt(s)` : '';
  const statement = err && err.position ? ` (statement position ${err.position})` : '';
  return `[db] startup failed during ${stage}${attempts}: ${code} ${detail}${statement}`;
}

/** Runs one stage and records its name on the error for the log above. */
async function startupStage(name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && typeof err === 'object' && !err.startupStage) err.startupStage = name;
    throw err;
  }
}

async function runStartupSequence() {
  await startupStage('migrate', () => withDbRetry(() => migrate()));
  await startupStage('seed', () => withDbRetry(() => seed()));
  // Expired-session cleanup needs the sessions table, so it runs here rather
  // than at module load. It is opportunistic and never blocks startup.
  await auth.pruneSessions().catch((err) => console.error('[auth] session prune failed:', sanitizeDbMessage(err.message)));
}

/**
 * Resolves once the database is migrated and seeded, rejects while it is not.
 *
 * On failure the reason is logged once with the real PostgreSQL error, and the
 * schema check is re-run so a mismatched table is still named explicitly. Both
 * happen per failed attempt rather than per request, so a broken instance does
 * not spam the database.
 */
function ensureReady() {
  if (startup.ready) return Promise.resolve();
  if (startup.inFlight) return startup.inFlight;

  const now = Date.now();
  if (startup.lastError && now < startup.nextAttemptAt) return Promise.reject(startup.lastError);

  const attempt = (async () => {
    await runStartupSequence();
    startup.failures = 0;
    startup.lastError = null;
    startup.nextAttemptAt = 0;
    startup.ready = true;
  })()
    .then(() => {
      startup.inFlight = null;
    })
    .catch((err) => {
      startup.inFlight = null;
      startup.ready = false;
      startup.failures += 1;
      const delay = Math.min(STARTUP_RETRY_BASE_MS * 2 ** (startup.failures - 1), STARTUP_RETRY_MAX_MS);
      startup.nextAttemptAt = Date.now() + delay;
      console.error(startupFailureText(err));
      // Supplementary only: the real PostgreSQL error is already logged above.
      withDbRetry(checkSchema)
        .then((status) => {
          if (status.ok) return;
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
        })
        .catch(() => {});
      throw err;
    });

  // The middleware below is the only consumer, and it only attaches when the
  // first request arrives. Without this the boot-time rejection is unhandled and
  // Node kills the function before it can serve its own 503.
  attempt.catch(() => {});
  startup.inFlight = attempt;
  return attempt;
}

/**
 * Holds every request until the schema and default settings exist.
 *
 * Without this gate a request that arrives during the first cold start would
 * hit an unmigrated database and fail with "relation does not exist".
 * A startup failure is reported as 503 on every route rather than being an
 * unhandled rejection, so the process stays up, the provider can retry, and the
 * next request after the backoff re-runs migrate and seed.
 */
app.use((req, res, next) => {
  ensureReady().then(
    () => next(),
    () => res.status(503).json({ error: 'Database is not ready' })
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
// Debt ledger. Mounted after auth.authenticate inside the router, so every
// endpoint requires an admin session; there is no public path to this data.
app.use('/api/admin/debts', debtsRouter);
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
  // `err.expose` is the escape hatch for a deliberate 5xx whose message is meant
  // for the operator (e.g. "DEBT_DELETE_PASS_KEY is not configured"), which would
  // otherwise be flattened into an unhelpful generic 500.
  const raw = Number(err.status || err.statusCode);
  const deliberate = err.expose === true;
  const status = Number.isInteger(raw) && raw >= 400 && (raw < 500 || deliberate) ? raw : 500;
  res.status(status).json({ error: status >= 500 && !deliberate ? 'Internal server error' : err.message });
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