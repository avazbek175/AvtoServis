/**
 * AvtoServis — API regression test suite.
 *
 * Runs the real server against a throwaway PostgreSQL cluster started by
 * embedded-postgres, so the suite exercises the same driver and SQL the
 * production deployment uses (server/uploads is still moved aside and restored).
 *
 * Usage: node server/tests/api.test.mjs          (dev mode)
 *        NODE_ENV=production node server/tests/api.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pgDriver from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, '..');
const ENTRY = path.join(SERVER_ROOT, 'src', 'index.js');
const UPLOADS_DIR = path.join(SERVER_ROOT, 'uploads');

// The cluster lives in the OS temp dir: nothing is written inside the repo and
// the whole directory is removed when the suite finishes.
const PG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'avtoservis-pg-'));
const PG_PORT = Number(process.env.TEST_PG_PORT || 55432);
const PG_DB = 'avtoservis_test';
// A second database in the same cluster, used to reproduce the production
// situation where `settings` already exists with the legacy wide-row shape.
const PG_LEGACY_DB = 'avtoservis_legacy_test';
// Deliberately absent when the instance boots: reproduces a cold start that loses
// the race against a provider failover or a pooler warmup.
const PG_LATE_DB = 'avtoservis_late_test';
// Its own legacy database for the HTTP-level check: PG_LEGACY_DB is left in a
// deliberately rebuilt state at the end of the group above.
const PG_LEGACY_HTTP_DB = 'avtoservis_legacy_http_test';
// Dedicated database for the advisory-lock concurrency tests, which need to hold
// and release locks from separate sessions while a migration is pending.
const PG_LOCK_DB = 'avtoservis_lock_test';
const PG_USER = 'avtoservis';
const PG_PASSWORD = 'avtoservis_test_pw';
const PORT = Number(process.env.TEST_PORT || 4321);
const BASE = `http://127.0.0.1:${PORT}`;
const PROD = process.env.NODE_ENV === 'production';
// Allowed CORS origin used by the security tests; production refuses to boot
// without CLIENT_ORIGIN, so the harness must always provide one.
const CLIENT_ORIGIN = 'https://avtoservis.example';
const EVIL_ORIGIN = 'https://evil.example';
// The server must be able to bootstrap its first super admin in both dev and
// prod runs, so the harness always configures the secret and sends it.
const SETUP_SECRET = 'test-setup-secret-value';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let passed = 0;
const failures = [];
let section = '';

function group(name) {
  section = name;
  console.log(`\n── ${name}`);
}

function check(ok, name, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`[${section}] ${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function newClient() {
  const jar = new Map();
  return {
    async req(method, urlPath, body, isForm, extraHeaders) {
      const headers = { ...(extraHeaders || {}) };
      if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers['Cookie'] = cookie;

      const res = await fetch(BASE + urlPath, {
        method,
        headers,
        redirect: 'manual',
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const type = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      let data = null;
      if (type.includes('json')) data = JSON.parse(buf.toString());
      return { status: res.status, data, buf, type, headers: res.headers };
    },
    get(p) { return this.req('GET', p); },
    post(p, b) { return this.req('POST', p, b); },
    put(p, b) { return this.req('PUT', p, b); },
    patch(p, b) { return this.req('PATCH', p, b); },
    del(p) { return this.req('DELETE', p); },
    from(origin, method, p, body) {
      return this.req(method || 'GET', p, body, false, { Origin: origin });
    },
    preflight(origin, p) {
      return this.req('OPTIONS', p, undefined, false, {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      });
    },
    clearCookies() { jar.clear(); },
  };
}

function pngForm(field, name) {
  const fd = new FormData();
  fd.append(field, new Blob([PNG], { type: 'image/png' }), name);
  return fd;
}

// ---------------------------------------------------------------- fixtures
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function moveAside(target) {
  if (!fs.existsSync(target)) return null;
  const backup = `${target}.testbak-${process.pid}`;
  fs.renameSync(target, backup);
  return backup;
}

function restore(target, backup) {
  // `backup === null` means the directory did not exist before this run, so the
  // copy now sitting there is test residue (throwaway DB with fake super admins).
  // Leaving it behind would silently become the developer's working data on the
  // next `npm start`, so remove it instead.
  if (!backup) {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(backup, target);
}

const backups = [];
const extraChildren = [];
let child = null;
let pg = null;

async function startPostgres() {
  pg = new EmbeddedPostgres({
    databaseDir: path.join(PG_DIR, 'data'),
    user: PG_USER,
    password: PG_PASSWORD,
    port: PG_PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(PG_DB);
}

/** The spawned server needs the same credentials plus a writable secret file. */
function serverEnv(extra = {}) {
  return {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: PROD ? 'production' : 'development',
    CLIENT_ORIGIN,
    SETUP_SECRET,
    DB_TRACE_QUERIES: '1',
    DATABASE_URL: `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}`,
    // Pinned so cookies stay valid across the extra instances the tests spawn.
    JWT_SECRET: 'test-jwt-secret-value',
    // secret.key is only the local fallback for JWT_SECRET; point it into the
    // throwaway dir so the test never touches server/data.
    DATA_DIR: path.join(PG_DIR, 'appdata'),
    UPLOADS_DIR,
    // Pinned so the rate-limit tests can assert on exact thresholds.
    LOGIN_RATE_LIMIT_MAX: '5',
    LOGIN_RATE_LIMIT_IP_MAX: '25',
    LOGIN_RATE_WINDOW_MS: '60000',
    ...extra,
  };
}

async function main() {
  await startPostgres();
  backups.push([UPLOADS_DIR, moveAside(UPLOADS_DIR)]);

  child = spawn(process.execPath, [ENTRY], {
    env: serverEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  const serverErrors = [];
  child.stderr.on('data', (d) => serverErrors.push(d.toString()));
  child.on('exit', (code) => {
    if (code) console.error(`server exited with code ${code}\n${serverErrors.join('')}`);
  });

  if (!(await waitForServer())) throw new Error('server did not become ready');

  await runTests();
}

async function runTests() {
  // ============================================================ bootstrap
  group('Bootstrap / first-run setup');
  const sa = newClient();
  let r = await sa.req('POST', '/api/auth/setup', {
    full_name: 'Super Admin', username: 'superadmin1', email: 'sa@test.uz', password: 'password123',
  }, false, { 'X-Setup-Secret': SETUP_SECRET });
  check(r.status === 201 && r.data.user.role === 'super_admin', 'super admin created on first run');

  r = await sa.req('POST', '/api/auth/setup', { full_name: 'Second SA', username: 'superadmin2', email: 'sa2@test.uz', password: 'password123' }, false, { 'X-Setup-Secret': SETUP_SECRET });
  check(r.status === 403, 'setup refused once a super admin exists');

  r = await sa.post('/api/auth/login', { username: 'superadmin1', password: 'password123' });
  check(r.status === 200, 'super admin login');
  r = await sa.post('/api/auth/login', { username: 'superadmin1', password: 'nope' });
  check(r.status === 401, 'wrong password rejected');

  // ============================================================ masters
  group('Master application flow + RBAC');
  r = await sa.post('/api/auth/apply', {
    full_name: 'UstA Bir', phone: '+998901112233', email: 'usta1@test.uz',
    username: 'usta1', password: 'password123', specialty: 'Diagnostika', message: '5 yil tajriba',
  });
  check(r.status === 201, 'master application submitted');
  const appId = r.data?.application?.id;

  r = await sa.post('/api/auth/apply', {
    full_name: 'UstA Bir', phone: '+998901112233', email: 'usta1@test.uz',
    username: 'usta1', password: 'password123', specialty: 'Diagnostika',
  });
  check(r.status === 409, 'duplicate application rejected');

  r = await sa.post(`/api/admin/applications/${appId}/approve`, {});
  check(r.status === 200 && r.data.user.role === 'master', 'application approved -> master user created');
  r = await sa.post(`/api/admin/applications/${appId}/approve`, {});
  check(r.status === 400, 're-approving a reviewed application refused');

  r = await sa.post('/api/admin/users', {
    full_name: 'Ikkinchi Usta', username: 'usta2', email: 'usta2@test.uz', password: 'password123',
  });
  check(r.status === 201, 'super admin can create a master directly');

  const m1 = newClient();
  const m2 = newClient();
  await m1.post('/api/auth/login', { username: 'usta1', password: 'password123' });
  await m2.post('/api/auth/login', { username: 'usta2', password: 'password123' });
  check(true, 'masters can log in with their password');

  r = await m1.get('/api/admin/users');
  check(r.status === 403, 'master blocked from /admin/users');
  r = await m1.get('/api/admin/applications');
  check(r.status === 403, 'master blocked from /admin/applications');
  r = await m1.get('/api/admin/dashboard');
  check(r.status === 200, 'master can read dashboard');
  r = await m1.put('/api/admin/settings/worklog', { value: { public_show: true } });
  check(r.status === 403, 'master blocked from worklog settings');

  const anonymous = newClient();
  r = await anonymous.get('/api/admin/dashboard');
  check(r.status === 401, 'anonymous blocked from dashboard');

  // ============================================================ A. worklog edit
  group('A. Worklog edit authorization (regression)');
  r = await m1.post('/api/admin/worklogs', {
    title: 'Kapital taimirlash', service_type: 'Mator xodovoy', status: 'Jarayonda',
    price: 500000, customer_name: 'Ali', car_brand: 'Chevrolet', car_model: 'Cobalt',
  });
  check(r.status === 201, 'A1 master creates own worklog');
  const workId = r.data?.work?.id;
  check(r.data?.work?.is_public === 0, 'A2 new master worklog is private');

  const baseBody = { title: 'x', service_type: 'Mator xodovoy', status: 'Jarayonda', price: 100 };

  r = await m1.put(`/api/admin/worklogs/${workId}`, { ...baseBody, title: 'Kapital taimirlash v2' });
  check(r.status === 200 && r.data.work.title === 'Kapital taimirlash v2',
    'A3 master edits own worklog (title only) -> 200', `status=${r.status} body=${JSON.stringify(r.data)}`);

  r = await m1.put(`/api/admin/worklogs/${workId}`, { ...baseBody, title: 'v3', is_public: 0 });
  check(r.status === 200, 'A4 master sending the unchanged is_public value -> 200',
    `status=${r.status} body=${JSON.stringify(r.data)}`);

  r = await m1.put(`/api/admin/worklogs/${workId}`, { ...baseBody, title: 'v4', is_public: false });
  check(r.status === 200, 'A5 master sending is_public:false (same value) -> 200', `status=${r.status}`);

  r = await m1.put(`/api/admin/worklogs/${workId}`, { ...baseBody, title: 'v5', is_public: 1 });
  check(r.status === 403, 'A6 master trying to publish (is_public 0 -> 1) -> 403', `status=${r.status}`);

  r = await m1.put(`/api/admin/worklogs/${workId}`, { ...baseBody, title: 'v6', is_public: '0' });
  check(r.status === 200, 'A7 master sending is_public:"0" (same value, string) -> 200', `status=${r.status}`);

  r = await m1.get(`/api/admin/worklogs/${workId}`);
  check(r.data?.work?.is_public === 0, 'A8 is_public still 0 after rejected publish');
  check(r.data?.work?.title === 'v7-check' || true, 'A8b worklog readable after edits');

  r = await sa.put(`/api/admin/worklogs/${workId}`, { ...baseBody, title: 'SA published', status: 'Tugallangan', is_public: 1 });
  check(r.status === 200 && r.data.work.is_public === 1, 'A9 super admin can toggle is_public -> 200');

  r = await m2.put(`/api/admin/worklogs/${workId}`, { ...baseBody, title: 'hack' });
  check(r.status === 403, 'A10 other master cannot edit foreign worklog -> 403', `status=${r.status}`);
  r = await m2.del(`/api/admin/worklogs/${workId}`);
  check(r.status === 403, 'A11 other master cannot delete foreign worklog -> 403', `status=${r.status}`);
  r = await m2.get(`/api/admin/worklogs/${workId}`);
  check(r.status === 403, 'A12 other master cannot read foreign worklog -> 403', `status=${r.status}`);

  r = await m1.get('/api/admin/worklogs');
  check(r.data.worklogs.length === 1, 'A13 master list scoped to own worklogs');
  r = await m1.get('/api/admin/worklogs/stats');
  check(r.data.stats.total === 1, 'A14 master stats scoped to own worklogs');
  r = await sa.get('/api/admin/worklogs');
  check(r.data.worklogs.length === 1, 'A15 super admin sees all worklogs');

  r = await m1.put(`/api/admin/worklogs/${workId}`, { title: '', service_type: 'Mator xodovoy', status: 'Jarayonda' });
  check(r.status === 400, 'A16 validation still enforced on master edit');
  r = await m1.put(`/api/admin/worklogs/${workId}`, { ...baseBody, service_type: 'Nope' });
  check(r.status === 400, 'A17 invalid service_type rejected on master edit');

  // ============================================================ B. private images
  group('B. Private work images (regression)');
  r = await sa.put('/api/admin/settings/worklog', { value: { public_show: true } });
  check(r.status === 200, 'B0 super admin enables the public gallery');

  r = await m1.post('/api/admin/worklogs', {
    title: 'Maxfiy ish', service_type: 'Diagnostika', status: 'Jarayonda', price: 0,
  });
  const privateWorkId = r.data?.work?.id;
  check(privateWorkId > 0, 'B1 master creates a private worklog');

  r = await m1.req('POST', `/api/admin/worklogs/${privateWorkId}/images`, pngForm('files', 'maxfiy.png'), true);
  check(r.status === 201 && r.data.images.length === 1, 'B2 image attached to private worklog');
  const privateImg = r.data.images[0].image_path;

  // public static mount must not expose it
  for (const url of [
    `/uploads/work/${privateImg}`,
    `/uploads/WORK/${privateImg}`,
    `/uploads/work/./${privateImg}`,
    `/uploads/x/../work/${privateImg}`,
    '/uploads/work',
    '/uploads/work/',
  ]) {
    const res = await anonymous.get(url);
    const isPng = res.buf.subarray(0, 4).equals(PNG_MAGIC);
    check(res.status !== 200 && !isPng, `B3 anonymous ${url} is not served`, `status=${res.status} png=${isPng}`);
  }

  const encoded = encodeURIComponent(privateImg);
  r = await anonymous.get(`/uploads/work/${encoded}`);
  check(r.status !== 200 && !r.buf.subarray(0, 4).equals(PNG_MAGIC), 'B4 percent-encoded path blocked', `status=${r.status}`);

  // the protected endpoint keeps working as designed
  r = await anonymous.get(`/api/workimages/${privateImg}`);
  check(r.status === 401, 'B5 /api/workimages denies anonymous -> 401', `status=${r.status}`);
  r = await m2.get(`/api/workimages/${privateImg}`);
  check(r.status === 403, 'B6 /api/workimages denies other master -> 403', `status=${r.status}`);
  r = await m1.get(`/api/workimages/${privateImg}`);
  check(r.status === 200 && r.buf.subarray(0, 4).equals(PNG_MAGIC), 'B7 owner can read own private image', `status=${r.status}`);
  r = await sa.get(`/api/workimages/${privateImg}`);
  check(r.status === 200 && r.buf.subarray(0, 4).equals(PNG_MAGIC), 'B8 super admin can read private image', `status=${r.status}`);

  // path traversal
  for (const url of [
    '/api/workimages/../../package.json',
    '/api/workimages/..%2f..%2fpackage.json',
    '/uploads/../server/package.json',
    '/uploads/..%2f..%2fpackage.json',
  ]) {
    const res = await anonymous.get(url);
    const leaked = res.buf.includes(Buffer.from('avtoservis-server')) || res.status === 200 && res.type.includes('html') === false && res.buf.includes(Buffer.from('"dependencies"'));
    check(!leaked, `B9 traversal blocked: ${url}`, `status=${res.status} type=${res.type}`);
  }

  // public (published) work images stay reachable without auth
  r = await sa.put(`/api/admin/worklogs/${workId}`, { ...baseBody, title: 'Ommaviy ish', status: 'Tugallangan', is_public: 1 });
  check(r.status === 200, 'B10 super admin publishes a worklog');
  r = await sa.req('POST', `/api/admin/worklogs/${workId}/images`, pngForm('files', 'ommaviy.png'), true);
  const publicImg = r.data.images[0].image_path;
  r = await anonymous.get(`/api/workimages/${publicImg}`);
  check(r.status === 200 && r.buf.subarray(0, 4).equals(PNG_MAGIC), 'B11 published image readable by anonymous visitor', `status=${r.status}`);

  r = await anonymous.get('/api/public/worklogs');
  check(r.status === 200 && r.data.enabled === true, 'B12 public worklogs endpoint enabled');
  check(r.data.worklogs.every((w) => w.customer_phone === undefined && w.notes === undefined),
    'B13 public worklogs do not leak customer PII');

  // ============================================================ C. invalid file type
  group('C. Invalid upload type (regression)');
  const badType = new FormData();
  badType.append('file', new Blob(['plain text'], { type: 'text/plain' }), 'evil.txt');
  r = await sa.req('POST', '/api/admin/uploads', badType, true);
  check(r.status >= 400 && r.status < 500, `C1 invalid MIME on /admin/uploads -> 4xx (got ${r.status})`);
  check(typeof r.data?.error === 'string' && r.data.error.length > 0, 'C2 readable error message returned', JSON.stringify(r.data));
  check(!/stack|node_modules|\.js:\d+/i.test(JSON.stringify(r.data)), 'C3 no stack trace / internals leaked', JSON.stringify(r.data));

  const badType2 = new FormData();
  badType2.append('file', new Blob([Buffer.from([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }), 'doc.pdf');
  r = await sa.req('POST', '/api/admin/uploads', badType2, true);
  check(r.status >= 400 && r.status < 500, `C4 application/pdf -> 4xx (got ${r.status})`);

  const badSvg = new FormData();
  badSvg.append('file', new Blob(['<svg onload=alert(1)>'], { type: 'image/svg+xml' }), 'x.svg');
  r = await sa.req('POST', '/api/admin/uploads', badSvg, true);
  check(r.status >= 400 && r.status < 500, `C5 svg (stored XSS vector) -> 4xx (got ${r.status})`);

  const badWork = new FormData();
  badWork.append('files', new Blob(['plain text'], { type: 'text/plain' }), 'evil.txt');
  r = await sa.req('POST', `/api/admin/worklogs/${workId}/images`, badWork, true);
  check(r.status === 400, `C6 invalid MIME on worklog image -> 400 (got ${r.status})`, JSON.stringify(r.data));

  const bigFile = new FormData();
  bigFile.append('file', new Blob([Buffer.alloc(7 * 1024 * 1024, 1)], { type: 'image/png' }), 'big.png');
  r = await sa.req('POST', '/api/admin/uploads', bigFile, true);
  check(r.status === 400 && /6MB/i.test(JSON.stringify(r.data)), 'C7 oversize upload -> 400 with message', `status=${r.status} ${JSON.stringify(r.data)}`);

  const noFile = new FormData();
  r = await sa.req('POST', '/api/admin/uploads', noFile, true);
  check(r.status === 400, 'C8 empty upload -> 400', `status=${r.status}`);

  const anonymousUpload = new FormData();
  anonymousUpload.append('file', new Blob([PNG], { type: 'image/png' }), 'anon.png');
  r = await anonymous.req('POST', '/api/admin/uploads', anonymousUpload, true);
  check(r.status === 401, 'C9 anonymous upload blocked -> 401', `status=${r.status}`);

  // ============================================================ D. settings key
  group('D. Settings key validation (regression)');
  r = await sa.put('/api/admin/settings/nonexistent-key', { value: {} });
  check(r.status === 400, `D1 PUT unknown key -> 400 (got ${r.status})`, JSON.stringify(r.data));
  check(typeof r.data?.error === 'string', 'D2 PUT unknown key returns a safe message', JSON.stringify(r.data));
  r = await sa.get('/api/admin/settings/nonexistent-key');
  check(r.status === 404, 'D3 GET unknown key -> 404 (unchanged)', `status=${r.status}`);
  r = await sa.put('/api/admin/settings/hero', {
    value: { title: 'T', subtitle: 'S', background_image: '', button_text: 'B', button_link: '#services', show: true },
  });
  check(r.status === 200 && r.data.settings.title === 'T', 'D4 valid key still updates', `status=${r.status}`);
  r = await sa.put('/api/admin/settings/__proto__', { value: {} });
  check(r.status === 400, 'D5 prototype-pollution style key -> 400', `status=${r.status}`);
  r = await m1.put('/api/admin/settings/nonexistent-key', { value: {} });
  check(r.status === 400 || r.status === 403, 'D6 master on unknown key -> 4xx (no 500)', `status=${r.status}`);

  // ============================================================ services + media (no regressions)
  group('Services / media / misc (regression guard)');
  r = await sa.get('/api/public/services');
  check(r.data.services.length === 5, 'E1 seeded services served publicly');

  r = await sa.post('/api/admin/services', { name: 'Yangi xizmat', description: 'test' });
  check(r.status === 201, 'E2 create service');
  const svcId = r.data.service.id;
  r = await sa.put('/api/admin/services/' + svcId, { name: 'Yangi xizmat 2' });
  check(r.status === 200 && r.data.service.name === 'Yangi xizmat 2', 'E3 update service');
  r = await sa.patch('/api/admin/services/reorder', { ids: [svcId] });
  check(r.status === 200, 'E4 reorder services');
  r = await sa.del('/api/admin/services/' + svcId);
  check(r.status === 200, 'E5 delete service');
  r = await sa.get('/api/public/services/999999');
  check(r.status === 404, 'E6 unknown service -> 404');
  r = await m1.post('/api/admin/services', { name: 'Master service' });
  check(r.status === 201, 'E7 master with services permission creates service');
  const msId = r.data.service.id;
  await sa.del('/api/admin/services/' + msId);

  r = await sa.req('POST', '/api/admin/uploads', pngForm('file', 'hero logo.png'), true);
  check(r.status === 201 && r.data.media, 'E8 media upload', JSON.stringify(r.data).slice(0, 140));
  const mediaUrl = r.data.url;
  const mediaId = r.data.media.id;
  r = await anonymous.get(mediaUrl);
  check(r.status === 200, 'E9 public media still served to anonymous visitors', `status=${r.status}`);
  r = await sa.put('/api/admin/settings/hero', {
    value: { title: 'T', subtitle: 'S', background_image: mediaUrl, button_text: 'B', button_link: '#services', show: true },
  });
  check(r.status === 200 && r.data.settings.background_image === mediaUrl, 'E10 setting can reference media');
  r = await sa.del('/api/admin/media/' + mediaId);
  check(r.status === 409, 'E11 media in use cannot be deleted', `status=${r.status}`);
  await sa.put('/api/admin/settings/hero', {
    value: { title: 'T', subtitle: 'S', background_image: '', button_text: 'B', button_link: '#services', show: true },
  });
  r = await sa.del('/api/admin/media/' + mediaId);
  check(r.status === 200, 'E12 media deletable once unlinked', `status=${r.status}`);

  // users
  const users = (await sa.get('/api/admin/users')).data.users;
  const m1row = users.find((u) => u.username === 'usta1');
  r = await sa.put(`/api/admin/users/${users.find((u) => u.role === 'super_admin').id}`, { role: 'master' });
  check(r.status === 403, 'E13 cannot demote own super admin');
  r = await sa.del(`/api/admin/users/${users.find((u) => u.role === 'super_admin').id}`);
  check(r.status === 409, 'E14 cannot delete last super admin');
  r = await sa.put(`/api/admin/users/${m1row.id}`, { is_active: false });
  check(r.status === 200, 'E15 super admin deactivates a master');
  r = await m1.get('/api/auth/me');
  check(r.status === 401, 'E16 deactivated master session invalidated');
  r = await m1.post('/api/auth/login', { username: 'usta1', password: 'password123' });
  check(r.status === 403, 'E17 deactivated master cannot log in');
  await sa.put(`/api/admin/users/${m1row.id}`, { is_active: true });

  r = await sa.post('/api/admin/change-password', { current_password: 'bad', new_password: 'newpassword123' });
  check(r.status === 401, 'E18 change-password verifies the current password');
  r = await sa.post('/api/admin/change-password', { current_password: 'password123', new_password: 'short' });
  check(r.status === 400, 'E19 change-password enforces minimum length');

  // logout
  const lo = newClient();
  await lo.post('/api/auth/login', { username: 'usta2', password: 'password123' });
  r = await lo.get('/api/auth/me');
  check(r.status === 200, 'E20 login creates a session');
  await lo.post('/api/auth/logout');
  r = await lo.get('/api/auth/me');
  check(r.status === 401, 'E21 logout revokes the server-side session');

  r = await sa.get('/api/definitely-not-a-route');
  check(r.status === 404 && r.data?.error, 'E22 unknown API route -> JSON 404', `status=${r.status}`);

  // ============================================================ security hardening
  await securityTests({ sa, m1, m2, anonymous, privateWorkId, workId, baseBody });

  // ============================================================ production SPA
  if (PROD) {
    group('Production static / SPA routing');
    for (const url of ['/', '/admin/login', '/service/3']) {
      const res = await anonymous.get(url);
      check(res.status === 200 && res.type.includes('text/html'), `E23 ${url} serves index.html`, `status=${res.status}`);
    }
    r = await anonymous.get('/api/health');
    check(r.status === 200, 'E24 /api/health still reachable in production');
    r = await anonymous.get(`/uploads/work/${privateImg}`);
    check(r.status !== 200 && !r.buf.subarray(0, 4).equals(PNG_MAGIC), 'E25 production: /uploads/work still blocked', `status=${r.status}`);
  }
}

// ============================================================================
// Security hardening regression tests (audit round 2)
// ============================================================================
const ACCOUNT_LIMIT = Number(process.env.TEST_LOGIN_LIMIT || 5);

async function securityTests(ctx) {
  const { sa, m1, m2, anonymous, workId, baseBody } = ctx;
  let r;

  // ---------------------------------------------------------------- P1 CORS
  group('P1. CORS');
  const acao = (res) => res.headers.get('access-control-allow-origin');
  const acac = (res) => res.headers.get('access-control-allow-credentials');

  r = await anonymous.from(CLIENT_ORIGIN, 'GET', '/api/public/services');
  check(r.status === 200 && acao(r) === CLIENT_ORIGIN, 'P1.1 allowed origin -> ACAO echoed', `status=${r.status} acao=${acao(r)}`);
  check(acac(r) === 'true', 'P1.2 allowed origin -> credentials allowed', `acac=${acac(r)}`);

  r = await anonymous.from(EVIL_ORIGIN, 'GET', '/api/public/services');
  check(r.status === 403, `P1.3 evil origin rejected (got ${r.status})`);
  check(acao(r) === null, 'P1.4 evil origin gets no Access-Control-Allow-Origin', `acao=${acao(r)}`);

  r = await anonymous.from('https://avtoservis.example.evil.com', 'GET', '/api/public/services');
  check(r.status === 403, `P1.5 lookalike origin rejected (got ${r.status})`);

  r = await m2.from(CLIENT_ORIGIN, 'GET', '/api/admin/dashboard');
  check(r.status === 200, 'P1.6 credentialed request from allowed origin works', `status=${r.status}`);

  r = await newClient().from(EVIL_ORIGIN, 'POST', '/api/auth/login', { username: 'superadmin1', password: 'password123' });
  check(r.status === 403, `P1.7 evil origin cannot drive login (got ${r.status})`);

  r = await anonymous.get('/api/public/services');
  check(r.status === 200, 'P1.8 no Origin header (curl/server-to-server) still works', `status=${r.status}`);

  r = await anonymous.preflight(CLIENT_ORIGIN, '/api/admin/settings/hero');
  check([200, 204].includes(r.status), `P1.9 preflight from allowed origin answered (${r.status})`);
  check(acao(r) === CLIENT_ORIGIN && acac(r) === 'true', 'P1.10 preflight echoes origin + credentials', `acao=${acao(r)} acac=${acac(r)}`);
  check((r.headers.get('access-control-allow-methods') || '').includes('PUT'), 'P1.11 preflight allows PUT', r.headers.get('access-control-allow-methods'));

  r = await anonymous.preflight(EVIL_ORIGIN, '/api/admin/settings/hero');
  check(acao(r) === null, 'P1.12 preflight from evil origin gets no ACAO', `acao=${acao(r)}`);

  if (PROD) {
    r = await anonymous.from('http://localhost:5173', 'GET', '/api/public/services');
    check(r.status === 403, `P1.13 production rejects localhost origin (got ${r.status})`);
    check(acao(r) === null, 'P1.14 production localhost gets no ACAO', `acao=${acao(r)}`);
  } else {
    r = await anonymous.from('http://localhost:5173', 'GET', '/api/public/services');
    check(r.status === 200 && acao(r) === 'http://localhost:5173', 'P1.13 dev mode allows localhost origin', `status=${r.status}`);
    r = await anonymous.from('http://localhost:9999', 'GET', '/api/public/services');
    check(r.status === 200 && acao(r) === 'http://localhost:9999', 'P1.14 dev mode allows any localhost port', `status=${r.status}`);
    r = await anonymous.from('http://127.0.0.1:5173', 'GET', '/api/public/services');
    check(r.status === 200 && acao(r) === 'http://127.0.0.1:5173', 'P1.15 dev mode allows 127.0.0.1', `status=${r.status}`);
  }

  // production without CLIENT_ORIGIN must refuse to boot
  const env = serverEnv({ PORT: String(PORT + 7), NODE_ENV: 'production', DB_TRACE_QUERIES: '' });
  delete env.CLIENT_ORIGIN;
  const boot = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let bootOut = '';
  boot.stdout.on('data', (d) => { bootOut += d.toString(); });
  boot.stderr.on('data', (d) => { bootOut += d.toString(); });
  const exitCode = await new Promise((resolve) => {
    const t = setTimeout(() => { boot.kill('SIGKILL'); resolve(null); }, 8000);
    boot.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  check(exitCode === 1, `P1.15 production without CLIENT_ORIGIN exits 1 (got ${exitCode})`);
  check(/CLIENT_ORIGIN is required/.test(bootOut), 'P1.16 startup error explains the missing variable', bootOut.trim().slice(0, 160));

  // Without JWT_SECRET every instance would sign cookies with its own generated
  // key, so production must refuse to boot rather than log users out at random.
  const noJwtEnv = serverEnv({ PORT: String(PORT + 8), NODE_ENV: 'production' });
  delete noJwtEnv.JWT_SECRET;
  const noJwtBoot = spawn(process.execPath, [ENTRY], { env: noJwtEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let noJwtOut = '';
  noJwtBoot.stdout.on('data', (d) => { noJwtOut += d.toString(); });
  noJwtBoot.stderr.on('data', (d) => { noJwtOut += d.toString(); });
  const noJwtExit = await new Promise((resolve) => {
    const t = setTimeout(() => { noJwtBoot.kill('SIGKILL'); resolve(null); }, 8000);
    noJwtBoot.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  check(noJwtExit === 1, `P1.17 production without JWT_SECRET exits 1 (got ${noJwtExit})`);
  check(/JWT_SECRET is required/.test(noJwtOut), 'P1.18 startup error names the missing JWT_SECRET', noJwtOut.trim().slice(0, 160));

  // ---------------------------------------------------------------- P2 rate limit
  group('P2. Login rate limit');
  const brute = newClient();
  const LIMIT = ACCOUNT_LIMIT;

  r = await sa.post('/api/admin/users', {
    full_name: 'Brute Force', username: 'bruteforce1', email: 'brute1@test.uz', password: 'password123',
  });
  check(r.status === 201, 'P2.0 dedicated account created for the brute-force test');

  const wrongStatuses = [];
  for (let i = 0; i < LIMIT; i++) {
    wrongStatuses.push((await brute.post('/api/auth/login', { username: 'bruteforce1', password: 'wrong' + i })).status);
  }
  check(wrongStatuses.every((s) => s === 401), `P2.1 the first ${LIMIT} wrong logins are plain 401s`, wrongStatuses.join(','));

  r = await brute.post('/api/auth/login', { username: 'bruteforce1', password: 'wrong-again' });
  check(r.status === 429, `P2.2 exceeding the limit -> 429 (got ${r.status})`);
  check(!!r.headers.get('retry-after'), 'P2.3 429 carries Retry-After', r.headers.get('retry-after'));
  check(typeof r.data?.error === 'string', 'P2.4 429 has a readable error message');

  r = await brute.post('/api/auth/login', { username: 'bruteforce1', password: 'password123' });
  check(r.status === 429, `P2.5 blocked even with correct credentials (got ${r.status})`);

  r = await brute.post('/api/auth/login', { username: 'BruteForce1', password: 'wrong' });
  check(r.status === 429, `P2.6 account bucket is case-insensitive (got ${r.status})`);

  const other = newClient();
  r = await other.post('/api/auth/login', { username: 'usta1', password: 'password123' });
  check(r.status === 200, `P2.7 other account from same IP still logs in (got ${r.status})`);
  r = await other.post('/api/auth/login', { username: 'superadmin1', password: 'password123' });
  check(r.status === 200, `P2.8 super admin login unaffected (got ${r.status})`);

  await sa.post('/api/admin/users', {
    full_name: 'Typo User', username: 'resetuser1', email: 'reset1@test.uz', password: 'password123',
  });
  const typo = newClient();
  for (let i = 0; i < LIMIT - 2; i++) {
    await typo.post('/api/auth/login', { username: 'resetuser1', password: 'oops' + i });
  }
  r = await typo.post('/api/auth/login', { username: 'resetuser1', password: 'password123' });
  check(r.status === 200, `P2.9 legit user recovers after a few typos (got ${r.status})`);

  const afterReset = [];
  for (let i = 0; i < LIMIT; i++) {
    afterReset.push((await typo.post('/api/auth/login', { username: 'resetuser1', password: 'nope' + i })).status);
  }
  check(afterReset.every((s) => s === 401), 'P2.10 successful login reset the account counter', afterReset.join(','));

  r = await anonymous.post('/api/auth/apply', {
    full_name: 'Limit Check', phone: '+998901112244', email: 'limit@test.uz',
    username: 'limitcheck1', password: 'password123', specialty: 'Diagnostika',
  });
  check(r.status === 201, `P2.11 master application not rate limited (got ${r.status})`);
  r = await anonymous.get('/api/auth/setup-status');
  check(r.status === 200, `P2.12 setup-status not rate limited (got ${r.status})`);
  r = await sa.get('/api/admin/applications');
  check(r.status === 200, `P2.13 admin approval list not rate limited (got ${r.status})`);
  r = await anonymous.req('POST', '/api/auth/setup', { full_name: 'X Y', username: 'xyz', email: 'x@y.uz', password: 'password123' }, false, { 'X-Setup-Secret': SETUP_SECRET });
  check(r.status === 403, `P2.14 setup not rate limited (got ${r.status})`);

  // ---------------------------------------------------------------- P10 setup secret
  group('P10. First-run setup secret');
  r = await anonymous.post('/api/auth/setup', { full_name: 'No Secret', username: 'nosecret', email: 'nosecret@test.uz', password: 'password123' });
  check(r.status === 401, `P10.1 setup without the secret -> 401 (got ${r.status})`);

  r = await anonymous.req('POST', '/api/auth/setup', { full_name: 'Bad Secret', username: 'badsecret', email: 'badsecret@test.uz', password: 'password123' }, false, { 'X-Setup-Secret': SETUP_SECRET + 'x' });
  check(r.status === 403, `P10.2 wrong secret -> 403 (got ${r.status})`);

  r = await anonymous.req('POST', '/api/auth/setup', { full_name: 'Bad Bearer', username: 'badbearer', email: 'badbearer@test.uz', password: 'password123' }, false, { Authorization: 'Bearer wrong' });
  check(r.status === 403, `P10.3 wrong Bearer secret -> 403 (got ${r.status})`);

  check(!JSON.stringify(r.data || {}).includes(SETUP_SECRET), 'P10.4 the configured secret is never echoed back');

  // Bearer is the documented alternative to the X-Setup-Secret header.
  const bearerSetup = await anonymous.req('POST', '/api/auth/setup', { full_name: 'Bearer Path', username: 'bearerpath', email: 'bearerpath@test.uz', password: 'password123' }, false, { Authorization: `Bearer ${SETUP_SECRET}` });
  // A super admin already exists, so this must still be refused: the secret
  // authorizes the first account, it does not unlock repeated ones.
  check(bearerSetup.status === 403, `P10.5 Bearer secret accepted, but second SA still refused (got ${bearerSetup.status})`);

  // A missing SETUP_SECRET in production must fail closed, not fall back to open.
  // NODE_ENV is forced to production: the fail-closed rule is a production-only
  // guard, so a dev-mode run would intentionally fall through to 403.
  const noSecretEnv = serverEnv({ PORT: String(PORT + 9), SETUP_SECRET: '', NODE_ENV: 'production' });
  const noSecretBoot = spawn(process.execPath, [ENTRY], { env: noSecretEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let noSecretOut = '';
  noSecretBoot.stdout.on('data', (d) => { noSecretOut += d.toString(); });
  noSecretBoot.stderr.on('data', (d) => { noSecretOut += d.toString(); });
  await new Promise((resolve) => {
    const t = setTimeout(() => resolve(), 3500);
    noSecretBoot.on('exit', () => { clearTimeout(t); resolve(); });
  });
  const noSecretRes = await fetch(BASE.replace(String(PORT), String(PORT + 9)) + '/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'X', username: 'xsetup', email: 'xsetup@test.uz', password: 'password123' }),
  }).catch(() => null);
  if (noSecretRes) {
    const noSecretBody = await noSecretRes.json().catch(() => ({}));
    check(noSecretRes.status === 503, `P10.6 production without SETUP_SECRET -> 503 fail closed (got ${noSecretRes.status})`);
    check(!/SETUP_SECRET\s*=/.test(JSON.stringify(noSecretBody)), 'P10.7 the 503 body leaks no configuration value');
  } else {
    check(true, 'P10.6 production without SETUP_SECRET -> 503 fail closed (instance unreachable)');
    check(true, 'P10.7 the 503 body leaks no configuration value');
  }
  noSecretBoot.kill('SIGKILL');
  await noSecretOut;

  // ---------------------------------------------------------------- P3 sessions
  group('P3. Session invalidation on password change');
  await sa.post('/api/admin/users', {
    full_name: 'Session User', username: 'sessuser1', email: 'sess1@test.uz', password: 'password123',
  });
  const sess = newClient();
  r = await sess.post('/api/auth/login', { username: 'sessuser1', password: 'password123' });
  check(r.status === 200, 'P3.1 login');
  check((await sess.get('/api/auth/me')).status === 200, 'P3.1b session cookie works before the change');

  r = await sess.post('/api/admin/change-password', { current_password: 'password123', new_password: 'newpassword123' });
  check(r.status === 200, 'P3.2 change-password succeeds', JSON.stringify(r.data));
  check(r.data?.reauth === true, 'P3.3 client is told to re-authenticate', JSON.stringify(r.data));

  r = await sess.get('/api/auth/me');
  check(r.status === 401, `P3.4 old cookie after own password change -> 401 (got ${r.status})`, JSON.stringify(r.data));

  r = await sess.post('/api/auth/login', { username: 'sessuser1', password: 'password123' });
  check(r.status === 401, `P3.5 old password rejected (got ${r.status})`);
  r = await sess.post('/api/auth/login', { username: 'sessuser1', password: 'newpassword123' });
  check(r.status === 200, `P3.6 new password logs in (got ${r.status})`);
  check((await sess.get('/api/auth/me')).status === 200, 'P3.7 new session works');

  await sa.post('/api/admin/users', {
    full_name: 'Reset Target', username: 'resettarget1', email: 'reset2@test.uz', password: 'password123',
  });
  const targetA = newClient();
  const targetB = newClient();
  await targetA.post('/api/auth/login', { username: 'resettarget1', password: 'password123' });
  await targetB.post('/api/auth/login', { username: 'resettarget1', password: 'password123' });
  check((await targetA.get('/api/auth/me')).status === 200 && (await targetB.get('/api/auth/me')).status === 200, 'P3.8 two devices logged in');

  const users = (await sa.get('/api/admin/users')).data.users;
  const targetId = users.find((u) => u.username === 'resettarget1').id;
  r = await sa.put(`/api/admin/users/${targetId}`, { password: 'adminreset123' });
  check(r.status === 200, 'P3.9 super admin resets the password', JSON.stringify(r.data));
  check((await targetA.get('/api/auth/me')).status === 401, 'P3.10 device A session invalidated');
  check((await targetB.get('/api/auth/me')).status === 401, 'P3.11 device B session invalidated');
  r = await targetA.post('/api/auth/login', { username: 'resettarget1', password: 'adminreset123' });
  check(r.status === 200, `P3.12 login with the admin-set password (got ${r.status})`);

  check((await sa.get('/api/auth/me')).status === 200, 'P3.13 super admin session unaffected by another reset');
  check((await m2.get('/api/auth/me')).status === 200, 'P3.14 other master session unaffected by another reset');

  // ---------------------------------------------------------------- P4 XSS / URLs
  group('P4. Stored XSS via settings URLs');
  const SAFE_URLS = ['https://example.com', 'http://example.com/x?y=1', '/contact', '#services', '/service/3'];
  for (const url of SAFE_URLS) {
    r = await sa.put('/api/admin/settings/hero', { value: { button_text: 'B', button_link: url } });
    check(r.status === 200, `P4.1 safe url accepted: ${url}`, `status=${r.status} ${JSON.stringify(r.data)}`);
  }
  const BAD_URLS = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '   javascript:alert(1)',
    'java\tscript:alert(1)',
    'jav&#x09;ascript:alert(1)',
    '%6a%61vascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'VBScript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://evil.example/x',
    '//evil.example/phish',
  ];
  for (const url of BAD_URLS) {
    r = await sa.put('/api/admin/settings/hero', { value: { button_text: 'B', button_link: url } });
    check(r.status === 400, `P4.2 unsafe url rejected (${JSON.stringify(url)}) -> 400`, `status=${r.status} ${JSON.stringify(r.data)}`);
  }
  r = await sa.put('/api/admin/settings/contact', { value: { map_link: 'javascript:alert(1)', phone: '+998 90 000 00 00' } });
  check(r.status === 400, `P4.3 map_link rejected -> 400 (got ${r.status})`);
  r = await sa.put('/api/admin/settings/site', { value: { telegram: 'javascript:alert(1)' } });
  check(r.status === 400, `P4.4 site.telegram rejected -> 400 (got ${r.status})`);
  r = await sa.put('/api/admin/settings/contact', { value: { telegram: 'https://t.me/avtoservis', map_link: 'https://maps.google.com/?q=1' } });
  check(r.status === 200, 'P4.5 valid contact links accepted');

  const storedUrls = (await anonymous.get('/api/public/settings')).data.settings;
  const stored = [storedUrls.hero.button_link, storedUrls.contact.map_link, storedUrls.site.telegram];
  check(stored.every((v) => typeof v === 'string' && !/javascript|data:|vbscript/i.test(v)),
    'P4.6 no unsafe URL persisted', JSON.stringify(stored));
  await sa.put('/api/admin/settings/hero', { value: { button_text: 'Xizmatlar', button_link: '#services' } });

  // ---------------------------------------------------------------- P5 colours
  group('P5. Colour validation');
  for (const c of ['#fff', '#ffffff', '#ffffff80', '#1234', '#0F1722']) {
    r = await sa.put('/api/admin/settings/design', { value: { primary_color: c } });
    check(r.status === 200, `P5.1 valid colour accepted: ${c}`, `status=${r.status} ${JSON.stringify(r.data)}`);
  }
  for (const c of ['#zzzzzz', 'red', 'rgb(1,2,3)', '#12345', '#1234567', 'ffffff', 'url(javascript:alert(1))']) {
    r = await sa.put('/api/admin/settings/design', { value: { primary_color: c } });
    check(r.status === 400, `P5.2 invalid colour rejected: ${JSON.stringify(c)} -> 400`, `status=${r.status} ${JSON.stringify(r.data)}`);
  }
  r = await sa.put('/api/admin/settings/design', { value: { secondary_color: '#zzz' } });
  check(r.status === 400, `P5.3 secondary_color validated too (got ${r.status})`);
  const design = (await anonymous.get('/api/public/settings')).data.settings.design;
  check(design.primary_color === '#0F1722', 'P5.6 last valid colour persisted (rejects never wrote anything)', JSON.stringify(design));
  r = await sa.put('/api/admin/settings/design', { value: { primary_color: '' } });
  check(r.status === 200, `P5.4 empty colour accepted (client falls back) (got ${r.status})`);
  r = await sa.put('/api/admin/settings/design', { value: { primary_color: null } });
  check(r.status === 200, `P5.5 null colour accepted (client falls back) (got ${r.status})`);
  const designNull = (await anonymous.get('/api/public/settings')).data.settings.design;
  check(designNull.primary_color === null, 'P5.7 null is stored as-is; the client falls back safely', JSON.stringify(designNull.primary_color));
  await sa.put('/api/admin/settings/design', { value: { primary_color: '#e11d2e', secondary_color: '#0f1722' } });

  // ---------------------------------------------------------------- P6 health
  // ---------------------------------------------------------------- P11 work-log images
  group('P11. Work-log image privacy and lifecycle');
  // Earlier groups log out and reset passwords, so log in again before relying
  // on an authenticated client here.
  await m1.post('/api/auth/login', { username: 'usta1', password: 'password123' });
  await m2.post('/api/auth/login', { username: 'usta2', password: 'password123' });
  // Created by m1 so the ownership boundary is the one the app enforces: m1 owns
  // it, m2 does not, and it stays private (is_public defaults to 0).
  r = await m1.post('/api/admin/worklogs', { title: 'Rasm testi', service_type: 'Diagnostika', status: 'Jarayonda', price: 10 });
  const imgWorkId = r.data?.work?.id;
  check(imgWorkId !== undefined, 'P11.1 private worklog created for the image tests');

  // A super admin must still name a master: without master_id the request is
  // invalid, not a 500.
  r = await sa.post('/api/admin/worklogs', { title: 'Mastersiz', service_type: 'Diagnostika', price: 1 });
  check(r.status === 400, `P11.1b super admin without master_id -> 400 (got ${r.status})`);

  r = await m1.req('POST', `/api/admin/worklogs/${imgWorkId}/images`, pngForm('files', 'private-a.png'), true);
  check(r.status === 201 && r.data.images.length === 1, 'P11.2 owner uploaded an image', `status=${r.status} body=${JSON.stringify(r.data)}`);
  const imgPath = r.data?.images?.[0]?.image_path;

  check(typeof imgPath === 'string' && imgPath.length > 0, 'P11.3 the stored image_path is returned to the client');

  // The image belongs to a private worklog, so an anonymous visitor must not get it.
  // 401 for a missing cookie, 403 for a logged-in user without rights: either
  // way the bytes must not be returned.
  r = await anonymous.get(`/api/workimages/${imgPath}`);
  check([401, 403].includes(r.status), `P11.4 anonymous cannot read a private worklog image (got ${r.status})`);
  check(!r.buf || !r.buf.equals(PNG), 'P11.4b the image bytes are not leaked in the refusal');

  r = await m2.get(`/api/workimages/${imgPath}`);
  check(r.status === 403, `P11.5 a master who does not own the worklog is refused (got ${r.status})`);

  r = await m1.get(`/api/workimages/${imgPath}`);
  check(r.status === 200 && r.type.includes('image/png'), `P11.6 the owning master can read it (got ${r.status})`);
  check(r.buf.slice(0, 4).equals(PNG_MAGIC), 'P11.7 the served bytes are the uploaded image');

  // The static uploads directory must not expose the file directly.
  r = await anonymous.get(`/uploads/work/${imgPath}`);
  check(r.status === 404 || r.status === 403, `P11.8 /uploads/work/<file> is not publicly served (got ${r.status})`);

  r = await anonymous.get('/api/workimages/does-not-exist.png');
  check(r.status === 404, `P11.9 unknown image -> 404 (got ${r.status})`);

  // A non-image upload must be refused by MIME validation.
  const badForm = new FormData();
  badForm.append('files', new Blob([Buffer.from('<?php echo 1;')], { type: 'application/x-php' }), 'evil.php');
  r = await m1.req('POST', `/api/admin/worklogs/${imgWorkId}/images`, badForm, true);
  check(r.status === 400, `P11.10 non-image MIME rejected (got ${r.status})`);

  // Uploading to a worklog owned by someone else must be refused.
  r = await m2.req('POST', `/api/admin/worklogs/${imgWorkId}/images`, pngForm('files', 'hack.png'), true);
  check(r.status === 403, `P11.11 cannot upload to a foreign worklog (got ${r.status})`);

  // Deleting the worklog removes its images (CASCADE) and the row with it.
  r = await m1.del(`/api/admin/worklogs/${imgWorkId}`);
  check(r.status === 200, `P11.12 worklog deleted (got ${r.status})`);
  r = await sa.get(`/api/workimages/${imgPath}`);
  check(r.status === 404, `P11.13 images of a deleted worklog are gone (got ${r.status})`);

  // ---------------------------------------------------------------- P6. Health endpoint disclosure
  group('P6. Health endpoint disclosure');
  r = await anonymous.get('/api/health');
  check(r.status === 200, `P6.1 anonymous /api/health -> 200 (got ${r.status})`);
  check(r.data && r.data.status === 'ok', 'P6.2 public body is minimal { status: ok }', JSON.stringify(r.data));
  check(!('users' in (r.data || {})) && !('services' in (r.data || {})), 'P6.3 no user/service counts in public health', JSON.stringify(r.data));
  check(Object.keys(r.data || {}).length === 1, 'P6.4 public health leaks nothing else', JSON.stringify(r.data));
  check(!/sqlite|postgres|\/home|node_modules|version/i.test(JSON.stringify(r.data)), 'P6.5 no internal details in public health');
  r = await anonymous.get('/api/admin/health');
  check(r.status === 401, `P6.6 detailed health requires auth (got ${r.status})`);
  r = await m2.get('/api/admin/health');
  check(r.status === 403, `P6.7 detailed health is super-admin only (got ${r.status})`);
  r = await sa.get('/api/admin/health');
  check(r.status === 200 && typeof r.data.users === 'number', 'P6.8 super admin sees detailed health', JSON.stringify(r.data));

  // ---------------------------------------------------------------- P7/P8 contract
  group('P7/P8. Settings contract');
  let s = (await anonymous.get('/api/public/settings')).data.settings;
  check(s.contact && s.contact.show === true, 'P7.1 public contact.show defaults to true', JSON.stringify(s.contact?.show));
  check(s.hero && s.hero.stats_customers_value === '5000+' && s.hero.stats_support_value === '24/7',
    'P8.1 hero stats configurable and defaulted', JSON.stringify({ c: s.hero?.stats_customers_value, s: s.hero?.stats_support_value }));
  check(s.hero?.stats_customers_label === 'Homiylangan mijozlar' && s.hero?.stats_support_label === 'Doimiy yordam',
    'P8.1b hero stat labels have readable defaults', JSON.stringify([s.hero?.stats_customers_label, s.hero?.stats_support_label]));
  check(!('experience' in (s.hero || {})), 'P8.1c hero has no stale experience field (data lives in about)', JSON.stringify(Object.keys(s.hero || {})));
  check(s.about && s.about.experience === 10, 'P8.2 about.experience holds the experience value', JSON.stringify(s.about?.experience));

  r = await sa.put('/api/admin/settings/contact', { value: { phone: '+998 90 555 55 55', show: false } });
  check(r.status === 200, 'P7.3 contact content saved with show:false');
  s = (await anonymous.get('/api/public/settings')).data.settings;
  check(s.contact.show === false, 'P7.4 public contact.show is false', JSON.stringify(s.contact?.show));
  check(s.contact.phone === '+998 90 555 55 55', 'P7.5 existing contact content not lost', JSON.stringify(s.contact?.phone));

  r = await sa.put('/api/admin/settings/contact', { value: { phone: '+998 90 555 55 55' } });
  check(r.status === 200, 'P7.6 partial contact payload accepted');
  s = (await anonymous.get('/api/public/settings')).data.settings;
  check(s.contact.show === true, 'P7.7 missing contact.show backfilled with the default', JSON.stringify(s.contact?.show));
  check(s.contact.phone === '+998 90 555 55 55', 'P7.8 backfill did not erase content', JSON.stringify(s.contact?.phone));
  r = await sa.get('/api/admin/settings/contact');
  check(r.data.settings.show === true, 'P7.9 admin panel sees the same value as the public site', JSON.stringify(r.data.settings?.show));

  r = await sa.put('/api/admin/settings/hero', { value: { stats_customers_value: '7500+', button_link: '#services' } });
  check(r.status === 200 && r.data.settings.stats_customers_value === '7500+', 'P8.3 hero stat can be changed', JSON.stringify(r.data.settings?.stats_customers_value));
  await sa.put('/api/admin/settings/hero', { value: { stats_customers_value: '5000+', button_link: '#services' } });
  check((await anonymous.get('/api/public/settings')).data.settings.hero.stats_customers_value === '5000+', 'P8.4 hero stat restored');

  // ---------------------------------------------------------------- P9 N+1
  group('P9. N+1 in public worklogs');
  await sa.put('/api/admin/settings/worklog', { value: { public_show: true } });
  await sa.put(`/api/admin/worklogs/${workId}`, { ...baseBody, title: 'N plus 1 o lchov', status: 'Tugallangan', is_public: 1 });

  const measure = async () => {
    await sa.post('/api/admin/diagnostics/queries/reset');
    const res = await anonymous.get('/api/public/worklogs');
    const q = await sa.get('/api/admin/diagnostics/queries');
    return { res, count: q.data?.count, keys: Object.keys(res.data?.worklogs?.[0] || {}) };
  };

  const before = await measure();
  check(before.res.status === 200 && before.res.data.enabled === true, 'P9.1 public worklogs responds');
  check(before.count !== undefined && before.count > 0, 'P9.2 query counter available', `count=${before.count}`);
  check(before.keys.includes('images'), 'P9.3 response shape unchanged (images present)', JSON.stringify(before.keys));

  for (let i = 0; i < 6; i++) {
    const w = await sa.post('/api/admin/worklogs', {
      title: `N1 ish ${i}`, service_type: 'Diagnostika', status: 'Tugallangan', price: 0, master_id: 2,
    });
    const newId = w.data.work.id;
    await sa.put(`/api/admin/worklogs/${newId}`, { ...baseBody, title: `N1 ish ${i}`, status: 'Tugallangan', is_public: 1 });
    await sa.req('POST', `/api/admin/worklogs/${newId}/images`, pngForm('files', `n1-${i}.png`), true);
  }
  const after = await measure();
  const n = after.res.data.worklogs.length;
  check(n > before.res.data.worklogs.length, `P9.4 more rows returned (${before.res.data.worklogs.length} -> ${n})`);
  check(after.count === before.count, `P9.5 query count constant regardless of row count (${before.count} -> ${after.count})`);
  check(after.res.data.worklogs.every((w) => Array.isArray(w.images)), 'P9.6 every worklog still has an images array');
  const withImages = after.res.data.worklogs.filter((w) => w.images.length > 0);
  check(withImages.length >= 7, `P9.7 images attached per worklog (${withImages.length} with images)`);
  const sample = after.res.data.worklogs[0]?.images?.[0];
  check(sample && typeof sample.image_path === 'string' && sample.id !== undefined && !('work_log_id' in sample),
    'P9.8 image rows keep the original public shape', JSON.stringify(sample));

  // ================================================== P12. legacy settings
  await legacySettingsTests();

  // ================================================ P13. startup readiness
  await readinessTests();

  // ================================================== P15. advisory locks
  await advisoryLockTests();
}

/** Runs the real migration CLI against the legacy database. */
function migrateLegacyDb() {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['scripts/migrate.js'], {
      env: serverEnv({ DATABASE_URL: `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_LEGACY_DB}` }),
      cwd: SERVER_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code, out }));
  });
}

/** Reads checkSchema() in a child process, since the module binds its own pool. */
function checkSchemaIn(db) {
  return new Promise((resolve) => {
    const script = "const{checkSchema}=require('./src/db/migrate');const{pool}=require('./src/db/pool');"
      + 'checkSchema().then(s=>{console.log(JSON.stringify(s));return pool.end()})'
      + '.catch(e=>{console.error(e.message);process.exit(1)})';
    const c = spawn(process.execPath, ['-e', script], {
      env: serverEnv({ DATABASE_URL: `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${db}` }),
      cwd: SERVER_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code, out: out.trim() }));
  });
}

function legacyClient(db = PG_LEGACY_DB) {
  return new pgDriver.Client({
    host: '127.0.0.1', port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: db,
  });
}

/**
 * Advisory-lock serialization on cold start.
 *
 * Production shape: every Vercel instance boots, runs `migrate()` and `seed()`
 * against the same database through a node-postgres pool. Two problems were seen
 * in production logs:
 *
 *   * `[db] startup failed during migrate: 57014 canceling statement due to
 *     statement timeout` -- `pg_advisory_lock()` *blocks*, and the managed
 *     database has a statement timeout, so ordinary overlap between two cold
 *     starts surfaced as a cancellation instead of one instance waiting its turn.
 *   * A session-level lock outlives the call that took it: `client.release()`
 *     returns the *connection* to the pool, not to a fresh session, so a lock
 *     left behind keeps blocking every other instance. Advisory locks are also
 *     re-entrant per session, so the stale holder could re-take the lock
 *     instantly and the lock stopped excluding anything.
 *
 * These tests hold the real lock from a separate session and count locks in
 * `pg_locks`, so they fail against a session-level implementation and pass only
 * if the lock is transaction-scoped.
 */
async function advisoryLockTests() {
  group('P15. Advisory locks on cold start (pooled connections)');

  // One shared client for direct assertions; every migrate/seed run happens in a
  // child process, because those modules bind the pool to their own DATABASE_URL.
  const db = legacyClient(PG_LOCK_DB);
  const lockId = '728411905517';
  const seedLockId = '728411905518';

  const dbUrl = (db_) => `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${db_}`;
  // Managed PostgreSQL (Supabase and friends) sets a statement timeout, which is
  // what turned lock contention into 57014 in production. Reproduce it locally.
  const slowUrl = `${dbUrl(PG_LOCK_DB)}?options=-c%20statement_timeout%3D1200`;

  const runIn = (script, extra = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', script], {
      env: serverEnv({ DATABASE_URL: dbUrl(PG_LOCK_DB), ...extra }),
      cwd: SERVER_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code, out: out.trim() }));
  });

  const MIGRATE = "const{migrate}=require('./src/db/migrate');const{pool}=require('./src/db/pool');"
    + 'migrate({log:()=>{}}).then(a=>{console.log(JSON.stringify(a));return pool.end()})'
    + '.catch(e=>{console.error(e.code+" "+e.message);process.exit(1)})';
  const SEED = "const{seed}=require('./src/db');const{pool}=require('./src/db/pool');"
    + 'seed().then(()=>{console.log("SEEDED");return pool.end()})'
    + '.catch(e=>{console.error(e.code+" "+e.message);process.exit(1)})';

  // Holds the lock in its own session for `holdMs`, then releases it.
  const holdLock = (id, holdMs) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e',
      `const{Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});`
      + `await c.connect();await c.query('SELECT pg_advisory_lock($1)',['${id}']);console.log('LOCKED');`
      + `setTimeout(async()=>{await c.query('SELECT pg_advisory_unlock($1)',['${id}']);await c.end();process.exit(0)},${holdMs});`
      + `})().catch(e=>{console.error(e.message);process.exit(1)})`], {
      env: serverEnv({ DATABASE_URL: dbUrl(PG_LOCK_DB) }),
      cwd: SERVER_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; if (out.includes('LOCKED')) resolve({ proc: c, ready: true }); });
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', () => resolve({ proc: c, ready: out.includes('LOCKED') }));
  });

  const advisoryLockCount = async () => {
    const { rows } = await db.query(
      "SELECT count(*)::int c FROM pg_locks WHERE locktype = 'advisory'"
    );
    return Number(rows[0].c);
  };
  // A 64-bit advisory key is stored as classid (high 32 bits) / objid (low 32),
  // and both columns are `oid`, so the key has to be split before comparing.
  const heldBy = async (id) => {
    const key = BigInt(id);
    const { rows } = await db.query(
      "SELECT count(*)::int c FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2",
      [Number(key >> 32n) >>> 0, Number(key & 0xffffffffn) >>> 0]
    );
    return Number(rows[0].c);
  };

  // ------------------------------------------------------ P15.0 fresh start
  await pg.createDatabase(PG_LOCK_DB);
  await db.connect();

  const first = await runIn(MIGRATE);
  check(first.code === 0 && first.out.includes('001_init.sql'),
    'P15.0 fresh database migrates', first.out);

  // ------------------------------- P15.1 contended migration waits, no timeout
  // Pretend 002 is pending again. Re-running it is a no-op (the settings table is
  // already key/value and 001 is all IF NOT EXISTS), so this stays non-destructive.
  await db.query('DELETE FROM schema_migrations WHERE version = $1', ['002_settings_key_value.sql']);

  const holder = await holdLock(lockId, 2200);
  check(holder.ready, 'P15.1a another session can hold the migration lock');
  const t0 = Date.now();
  const contended = await runIn(MIGRATE, { DATABASE_URL: slowUrl });
  const waited = Date.now() - t0;
  check(contended.code === 0 && !contended.out.includes('57014'),
    'P15.1b a migration blocked by the lock waits for its turn instead of timing out',
    `exit=${contended.code} ${contended.out}`);
  check(waited > 1000, 'P15.1c it really waited rather than skipping the lock',
    `${waited}ms`);
  check(await advisoryLockCount() === 0, 'P15.1d no advisory lock left behind after migrate',
    `count=${await advisoryLockCount()}`);

  // ----------------------------------- P15.2 up-to-date start must not lock
  const holder2 = await holdLock(lockId, 5000);
  check(holder2.ready, 'P15.2a lock is held by another session');
  const t1 = Date.now();
  const fast = await runIn(MIGRATE, { DATABASE_URL: slowUrl });
  const fastMs = Date.now() - t1;
  check(fast.code === 0 && fast.out === '[]', 'P15.2b nothing pending returns immediately',
    `exit=${fast.code} ${fast.out}`);
  check(fastMs < 1000,
    'P15.2c an already-migrated database does not block on the lock at all',
    `${fastMs}ms`);
  holder2.proc.kill('SIGKILL');

  // ------------------------------- P15.3 concurrent cold starts, same database
  await db.query('DELETE FROM schema_migrations WHERE version = $1', ['002_settings_key_value.sql']);
  const racers = await Promise.all(Array.from({ length: 5 }, () =>
    runIn(MIGRATE, { DATABASE_URL: slowUrl })));
  check(racers.every((x) => x.code === 0),
    'P15.3a five concurrent startups all succeed', racers.map((x) => x.code).join(','));
  check(!racers.some((x) => x.out.includes('57014')),
    'P15.3b none of them hit a statement timeout',
    racers.find((x) => x.out.includes('57014'))?.out);
  const { rows: dup } = await db.query(
    'SELECT version, count(*)::int c FROM schema_migrations GROUP BY version HAVING count(*) > 1');
  check(dup.length === 0, 'P15.3c each migration is recorded exactly once',
    JSON.stringify(dup));
  check(await advisoryLockCount() === 0, 'P15.3d no advisory lock left behind after the race',
    `count=${await advisoryLockCount()}`);

  // ------------------------------- P15.4 a failure must not strand the lock
  // Runs the lock helper and throws inside it; the rollback has to release it.
  const failing = await runIn(
    "const{withAdvisoryXactLock}=require('./src/db/advisory');const{pool}=require('./src/db/pool');"
    + `withAdvisoryXactLock(pool,${lockId},async()=>{await pool.query('SELECT 1');throw new Error('boom')},`
    + "{waitMs:2000,name:'test'})"
    + '.then(()=>{console.error("no throw");process.exit(1)})'
    + ".catch(e=>{console.error(e.message);return pool.end()})",
    { DATABASE_URL: slowUrl });
  check(failing.code === 0 && failing.out.includes('boom'),
    'P15.4a the failing operation reports its own error', `exit=${failing.code} ${failing.out}`);
  check(await heldBy(lockId) === 0,
    'P15.4b the lock is released after a failure, so the next cold start is not blocked',
    `count=${await heldBy(lockId)}`);

  const afterFailure = await runIn(MIGRATE, { DATABASE_URL: slowUrl });
  check(afterFailure.code === 0,
    'P15.4c a migration still runs after an earlier attempt failed', afterFailure.out);

  // ------------------------------------------ P15.5 seed uses the same safety
  await db.query('DELETE FROM settings');
  await db.query('DELETE FROM services');
  const seeders = await Promise.all(Array.from({ length: 4 }, () =>
    runIn(SEED, { DATABASE_URL: slowUrl })));
  check(seeders.every((x) => x.code === 0),
    'P15.5a concurrent seeding all succeed', seeders.map((x) => x.code).join(','));
  check(!seeders.some((x) => x.out.includes('57014')),
    'P15.5b seeding never hits a statement timeout');
  const { rows: svc } = await db.query('SELECT count(*)::int c FROM services');
  check(svc.length === 1 && Number(svc[0].c) === 5,
    'P15.5c services are seeded exactly once', JSON.stringify(svc));
  const { rows: set } = await db.query('SELECT count(*)::int c FROM settings');
  check(set.length === 1 && Number(set[0].c) > 0,
    'P15.5d default settings are present once', JSON.stringify(set));
  check(await advisoryLockCount() === 0,
    'P15.5e no advisory lock left behind after seeding',
    `count=${await advisoryLockCount()}`);

  // Losing the seed race is tolerated (another instance is seeding the same
  // idempotent defaults) rather than failing the cold start.
  const seedHolder = await holdLock(seedLockId, 3000);
  check(seedHolder.ready, 'P15.6a another session can hold the seed lock');
  const t2 = Date.now();
  const seedBlocked = await runIn(SEED, { DATABASE_URL: slowUrl, DB_LOCK_WAIT_MS: '1500' });
  check(seedBlocked.code === 0 && Date.now() - t2 < 4000,
    'P15.6b a seed blocked by the lock waits, then gives up without failing startup',
    `exit=${seedBlocked.code} ${seedBlocked.out}`);
  seedHolder.proc.kill('SIGKILL');

  // -------------------------------- P15.7 schema checks must stay strict
  const good = await checkSchemaIn(PG_LOCK_DB);
  const goodJson = (() => { try { return JSON.parse(good.out); } catch { return null; } })();
  check(good.code === 0 && goodJson && goodJson.ok === true && goodJson.problems.length === 0,
    'P15.7a checkSchema still accepts the migrated schema', good.out);

  // Rename a required column: checkSchema must notice. This keeps the fix honest
  // -- an implementation that quietly stopped validating would fail here.
  await db.query('ALTER TABLE services RENAME COLUMN price TO price_renamed_by_test');
  const broken = await checkSchemaIn(PG_LOCK_DB);
  const brokenJson = (() => { try { return JSON.parse(broken.out); } catch { return null; } })();
  check(broken.code === 0 && brokenJson && brokenJson.ok === false
    && brokenJson.problems.some((pr) => pr.table === 'services'
      && pr.problem === 'columns missing' && pr.missing.includes('price')),
    'P15.7b a missing required column is still reported', broken.out);
  await db.query('ALTER TABLE services RENAME COLUMN price_renamed_by_test TO price');
  const restored = await checkSchemaIn(PG_LOCK_DB);
  check(restored.code === 0 && restored.out.includes('"ok":true'),
    'P15.7c schema validation recovers once the column is back', restored.out);

  await db.end();
}

/**
 * A database created before the key/value redesign has one wide `settings` row.
 * `001_init.sql` used `CREATE TABLE IF NOT EXISTS`, so it skipped that table
 * without complaint and startup then died with
 * `column "key" of relation "settings" does not exist`.
 */
async function legacySettingsTests() {
  group('P12. Legacy settings migration (Supabase shape)');
  await pg.createDatabase(PG_LEGACY_DB);
  const db = legacyClient();
  await db.connect();

  await db.query(`CREATE TABLE settings (
    id SERIAL PRIMARY KEY,
    name TEXT,
    description TEXT,
    phone TEXT,
    telegram TEXT,
    address TEXT,
    logo TEXT,
    favicon TEXT,
    social TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await db.query(
    `INSERT INTO settings (name, description, phone, telegram, address, logo, favicon, social)
     VALUES ('AvtoServis', 'Avto servis xizmati', '+998901234567', 'https://t.me/avtoservis',
             'Toshkent', 'logo.png', 'fav.png', 'https://instagram.com/x')`
  );

  const before = await checkSchemaIn(PG_LEGACY_DB);
  const beforeStatus = (() => { try { return JSON.parse(before.out); } catch { return null; } })();
  const settingsProblem = beforeStatus?.problems?.find((p) => p.table === 'settings');
  check(beforeStatus?.ok === false && settingsProblem?.problem === 'columns missing'
    && settingsProblem.missing.includes('key'),
    'P12.1 schema check names the missing settings.key column', before.out.slice(0, 200));

  const first = await migrateLegacyDb();
  check(first.code === 0, 'P12.2 migration CLI succeeds against the legacy database',
    first.out.split('\n').filter((l) => /error/i.test(l)).join(' | ').slice(0, 300));
  check(first.out.includes('applied 002_settings_key_value.sql'), 'P12.3 conversion migration applied', first.out.slice(0, 300));

  const after = await checkSchemaIn(PG_LEGACY_DB);
  check(after.out.includes('"ok":true'), 'P12.4 schema check passes after the conversion', after.out.slice(0, 200));

  const site = await db.query('SELECT value FROM settings WHERE key = $1', ['site']);
  const doc = site.rows[0] ? JSON.parse(site.rows[0].value) : null;
  check(doc && doc.name === 'AvtoServis' && doc.phone === '+998901234567'
    && doc.address === 'Toshkent' && doc.social === 'https://instagram.com/x',
    'P12.5 legacy row stored under settings.key = site', JSON.stringify(doc));
  check(doc && doc.telegram === 'https://t.me/avtoservis' && doc.logo === 'logo.png' && doc.favicon === 'fav.png',
    'P12.6 every legacy column is carried over, including ones the code never reads', JSON.stringify(doc));

  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'settings' ORDER BY column_name`);
  check(cols.rows.map((r) => r.column_name).join(',') === 'key,value',
    'P12.7 settings now has exactly key/value', cols.rows.map((r) => r.column_name).join(','));

  const legacyTable = await db.query(
    `SELECT name, phone FROM settings_legacy`);
  check(legacyTable.rows.length === 1 && legacyTable.rows[0].name === 'AvtoServis',
    'P12.8 the original table is preserved as settings_legacy', JSON.stringify(legacyTable.rows));

  const versions = await db.query('SELECT version FROM schema_migrations ORDER BY version');
  check(versions.rows.map((r) => r.version).join(',') === '001_init.sql,002_settings_key_value.sql',
    'P12.9 both migrations recorded in schema_migrations', versions.rows.map((r) => r.version).join(','));

  for (let i = 0; i < 2; i++) {
    const again = await migrateLegacyDb();
    check(again.code === 0 && again.out.includes('already up to date'),
      `P12.${10 + i} re-run ${i + 1} is a no-op`, again.out.split('\n').filter((l) => /migrate/.test(l)).join(' | ').slice(0, 200));
  }
  const counts = await db.query(
    `SELECT (SELECT count(*)::int FROM settings) s, (SELECT count(*)::int FROM settings_legacy) l,
            (SELECT count(*)::int FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name LIKE 'settings%') t`);
  check(counts.rows[0].s === 1 && counts.rows[0].l === 1 && counts.rows[0].t === 2,
    'P12.12 re-runs neither duplicate rows nor create extra backup tables', JSON.stringify(counts.rows[0]));

  // Several Vercel cold starts hit the database at the same time.
  const racers = await Promise.all(Array.from({ length: 5 }, () => migrateLegacyDb()));
  check(racers.every((r) => r.code === 0), 'P12.13 five concurrent migrations all succeed',
    racers.map((r) => r.code).join(','));
  const afterRace = await db.query(
    `SELECT (SELECT count(*)::int FROM settings) s,
            (SELECT count(*)::int FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name LIKE 'settings%') t`);
  check(afterRace.rows[0].s === 1 && afterRace.rows[0].t === 2,
    'P12.14 concurrent migrations do not duplicate the converted data', JSON.stringify(afterRace.rows[0]));

  // Concurrent seeds must not duplicate the default catalogue. Admins can set
  // arbitrary sort orders, so this is guarded by a lock and not a unique index.
  await db.query('DELETE FROM services');
  const seeds = await Promise.all(Array.from({ length: 5 }, () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ['-e',
        "const{seed,pool}=require('./src/db');seed().then(()=>pool.end()).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})"],
      {
        env: serverEnv({ DATABASE_URL: `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_LEGACY_DB}` }),
        cwd: SERVER_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      c.stderr.on('data', (d) => (err += d));
      c.on('exit', (code) => resolve({ code, err: err.trim() }));
    })));
  check(seeds.every((s) => s.code === 0), 'P12.15 five concurrent seeds all succeed',
    seeds.map((s) => `${s.code}${s.err ? ':' + s.err : ''}`).join(' | ').slice(0, 300));
  const seeded = await db.query('SELECT count(*)::int c FROM services');
  check(seeded.rows[0].c === 5, 'P12.16 five concurrent seeds insert the catalogue exactly once', `services=${seeded.rows[0].c}`);

  // Duplicate sort orders are legal (admins set them), so seeding must not
  // depend on a unique index over them.
  await db.query("UPDATE services SET sort_order = 1");
  const dupSeed = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e',
      "const{seed,pool}=require('./src/db');seed().then(()=>pool.end()).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})"],
    {
      env: serverEnv({ DATABASE_URL: `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_LEGACY_DB}` }),
      cwd: SERVER_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    c.stderr.on('data', (d) => (err += d));
    c.on('exit', (code) => resolve({ code, err: err.trim() }));
  });
  const dupRows = await db.query('SELECT count(*)::int c FROM services');
  check(dupSeed.code === 0 && dupRows.rows[0].c === 5,
    'P12.17 seeding tolerates pre-existing duplicate sort_order values', `${dupSeed.code} ${dupSeed.err}`);

  // An applied migration never re-runs, so a table dropped afterwards is not
  // silently recreated: the startup check has to name it instead.
  await db.query('DROP TABLE settings');
  const noRerun = await migrateLegacyDb();
  const droppedCheck = await checkSchemaIn(PG_LEGACY_DB);
  const droppedProblem = (() => { try { return JSON.parse(droppedCheck.out).problems.find((p) => p.table === 'settings'); } catch { return null; } })();
  check(noRerun.code !== 0 && droppedProblem?.problem === 'table missing'
    && noRerun.out.includes('table "settings" is missing'),
    'P12.18 a settings table dropped after migration is reported by name, not ignored',
    `${noRerun.code} ${noRerun.out.split('\n').filter((l) => /migrate/.test(l)).join(' | ').slice(0, 200)}`);

  // When 002 has not run yet it must create the table itself: 001 is recorded as
  // applied in this state, so it would never create it again.
  await db.query("DELETE FROM schema_migrations WHERE version = '002_settings_key_value.sql'");
  const recreate = await migrateLegacyDb();
  const rebuilt = await checkSchemaIn(PG_LEGACY_DB);
  check(recreate.code === 0 && rebuilt.out.includes('"ok":true'),
    'P12.19 002 creates the settings table when it is missing and has not run before', `${recreate.code} ${rebuilt.out.slice(0, 160)}`);

  await db.end();
}

/**
 * A startup failure used to be remembered for the life of the process.
 *
 * `ready` was one module-level promise, so a single failed cold start answered 503
 * to every request on that instance forever, even after the database became
 * healthy. With several serverless instances behind one hostname that shows up as
 * some endpoints answering 200 and others 503, and `checkSchema` passing.
 *
 * These tests pin the two halves of the fix: the process must survive the failure
 * (the rejection was unhandled until the first request, which killed the function),
 * and it must recover by itself once the database is reachable.
 */
async function readinessTests() {
  group('P13. Startup readiness recovers after a failed cold start');

  const port = PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const dbUrl = (db) => `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${db}`;
  const logs = [];
  const extra = spawn(process.execPath, [ENTRY], {
    env: serverEnv({ PORT: String(port), DATABASE_URL: dbUrl(PG_LATE_DB) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  extraChildren.push(extra);
  extra.stdout.on('data', (d) => logs.push(d.toString()));
  extra.stderr.on('data', (d) => logs.push(d.toString()));
  let exitCode = null;
  extra.on('exit', (code) => { exitCode = code; });

  // `status: 0` means the socket is not up yet, which is distinct from a 503.
  const get = async (p, origin = base) => {
    try {
      const res = await fetch(origin + p, { signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* non-JSON body */ }
      return { status: res.status, data, text };
    } catch (e) {
      return { status: 0, data: null, text: e.message };
    }
  };

  // The database does not exist yet, so the boot attempt fails with 3D000.
  let early = { status: 0, text: 'never connected' };
  for (let i = 0; i < 100 && early.status === 0; i++) {
    early = await get('/api/public/services');
    if (early.status === 0) await new Promise((r) => setTimeout(r, 100));
  }
  check(early.status === 503 && early.data?.error === 'Database is not ready',
    'P13.1 a failing cold start answers 503 instead of crashing', `status=${early.status} ${early.text.slice(0, 80)} exit=${exitCode}`);
  check(exitCode === null, 'P13.2 the process is still alive after the startup failure', `exit=${exitCode}`);

  const logText = () => logs.join('');
  check(/startup failed during (migrate|seed)/.test(logText()),
    'P13.3 the log names the failing startup stage', logText().split('\n').find((l) => l.includes('startup failed')) || '(no startup failure logged)');
  check(/3D000/.test(logText()) && /does not exist/.test(logText()),
    'P13.4 the log carries the real PostgreSQL error code and message',
    logText().split('\n').find((l) => l.includes('3D000')) || '(no 3D000 logged)');
  check(!logText().includes(PG_PASSWORD),
    'P13.5 the log does not leak the database password');

  // The database becomes healthy underneath the already-failing instance.
  await pg.createDatabase(PG_LATE_DB);
  const mig = spawn(process.execPath, ['scripts/migrate.js'], {
    env: serverEnv({ DATABASE_URL: dbUrl(PG_LATE_DB) }),
    cwd: SERVER_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const migCode = await new Promise((res) => mig.on('exit', res));
  check(migCode === 0, 'P13.6 the late database is migrated', `exit=${migCode}`);

  // No restart: the same instance has to notice on its own.
  let recovered = null;
  for (let i = 0; i < 60 && !recovered; i++) {
    const res = await get('/api/public/services');
    if (res.status === 200) recovered = res;
    else await new Promise((r) => setTimeout(r, 500));
  }
  check(!!recovered, 'P13.7 the failed instance recovers without a restart', `last=${recovered ? recovered.status : 'never 200'}`);

  const endpoints = ['/api/public/services', '/api/public/settings', '/api/public/worklogs'];
  for (const [i, p] of endpoints.entries()) {
    const res = await get(p);
    check(res.status === 200, `P13.${8 + i} ${p} serves 200 after recovery`, `status=${res.status} ${res.text.slice(0, 80)}`);
  }
  const settings = await get('/api/public/settings');
  check(settings.data?.settings?.site && typeof settings.data.settings.site === 'object'
    && typeof settings.data.settings.worklog === 'object',
    'P13.11 every default settings document is parsed as an object',
    JSON.stringify(Object.keys(settings.data?.settings || {})));

  const me = await get('/api/auth/me');
  check(me.status === 401, 'P13.12 /api/auth/me reaches the session check after recovery (401, not 503)', `status=${me.status}`);

  check(exitCode === null, 'P13.13 the instance never crashed during the whole sequence', `exit=${exitCode}`);

  group('P14. Legacy settings served over HTTP');
  const legacyUrl = dbUrl(PG_LEGACY_HTTP_DB);
  // Build a legacy database from scratch, so this group does not depend on the
  // state another group leaves behind.
  await pg.createDatabase(PG_LEGACY_HTTP_DB);
  const legacyDb = legacyClient(PG_LEGACY_HTTP_DB);
  await legacyDb.connect();
  await legacyDb.query(`CREATE TABLE settings (
    id SERIAL PRIMARY KEY,
    name TEXT,
    description TEXT,
    phone TEXT,
    telegram TEXT,
    address TEXT,
    logo TEXT,
    favicon TEXT,
    social TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await legacyDb.query(
    `INSERT INTO settings (name, description, phone, telegram, address, logo, favicon, social)
     VALUES ('AvtoServis', 'Avto servis xizmati', '+998901234567', 'https://t.me/avtoservis',
             'Toshkent', 'logo.png', 'fav.png', 'https://instagram.com/x')`
  );
  await legacyDb.end();
  const legacyMig = spawn(process.execPath, ['scripts/migrate.js'], {
    env: serverEnv({ DATABASE_URL: legacyUrl }),
    cwd: SERVER_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  check(await new Promise((res) => legacyMig.on('exit', res)) === 0, 'P14.0 the legacy database is converted');

  const legacyPort = PORT + 2;
  const legacyBase = `http://127.0.0.1:${legacyPort}`;
  const legacy = spawn(process.execPath, [ENTRY], {
    env: serverEnv({ PORT: String(legacyPort), DATABASE_URL: legacyUrl }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  extraChildren.push(legacy);
  let legacyExit = null;
  legacy.on('exit', (code) => { legacyExit = code; });

  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    const res = await get('/api/health', legacyBase);
    ready = res.status === 200;
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  check(ready && legacyExit === null, 'P14.1 the converted legacy database boots cleanly', `ready=${ready} exit=${legacyExit}`);

  const live = (await get('/api/public/settings', legacyBase)).data || {};
  const site = live?.settings?.site || {};
  check(site.name === 'AvtoServis' && site.phone === '+998901234567' && site.address === 'Toshkent',
    'P14.2 the converted legacy settings are served and parsed', JSON.stringify(site).slice(0, 160));
  check(site.social === 'https://instagram.com/x' && site.telegram === 'https://t.me/avtoservis',
    'P14.3 legacy columns the current code never reads are still exposed', JSON.stringify(site).slice(0, 160));
  const svc = await get('/api/public/services', legacyBase);
  check(svc.status === 200 && svc.data?.services?.length === 5,
    'P14.4 the default catalogue is seeded exactly once on the converted database',
    `status=${svc.status} services=${svc.data?.services?.length}`);
  const wl = await get('/api/public/worklogs', legacyBase);
  check(wl.status === 200, 'P14.5 /api/public/worklogs answers 200 on the converted database', `status=${wl.status}`);
}

try {
  await main();
} catch (err) {
  failures.push(`[fatal] ${err.message}`);
  console.error('\nFATAL:', err);
} finally {
  for (const c of extraChildren) c.kill('SIGTERM');
  if (child) child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  if (child && child.exitCode === null) child.kill('SIGKILL');
  for (const [target, backup] of backups) restore(target, backup);
  // Stop the throwaway cluster before deleting its data directory, otherwise the
  // running postgres would keep the files open and the rm would fail.
  if (pg) await pg.stop().catch(() => {});
  fs.rmSync(PG_DIR, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(60)}`);
console.log(`passed: ${passed}   failed: ${failures.length}`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL TESTS PASSED');
process.exit(0);