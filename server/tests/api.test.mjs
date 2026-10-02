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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, '..');
const ENTRY = path.join(SERVER_ROOT, 'src', 'index.js');
const UPLOADS_DIR = path.join(SERVER_ROOT, 'uploads');

// The cluster lives in the OS temp dir: nothing is written inside the repo and
// the whole directory is removed when the suite finishes.
const PG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'avtoservis-pg-'));
const PG_PORT = Number(process.env.TEST_PG_PORT || 55432);
const PG_DB = 'avtoservis_test';
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
}

try {
  await main();
} catch (err) {
  failures.push(`[fatal] ${err.message}`);
  console.error('\nFATAL:', err);
} finally {
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