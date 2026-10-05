const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const auth = require('../auth');
const rateLimit = require('../rateLimit');
const { buildDebtWorkbook } = require('../debtExcel');

const router = require('../asyncRoute').wrapRouter(express.Router());

// Every debt endpoint is admin-only. There is deliberately no public route and
// no unauthenticated branch anywhere in this file: debt records are financial
// data about named people and must never be reachable without a session.
router.use(auth.authenticate);

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

/**
 * Parses a so'm amount from JSON.
 *
 * Only plain integers are accepted. `parseFloat('12abc')` returns 12 and
 * `parseFloat('1e9')` returns 1000000000, both of which would silently record a
 * wrong figure on a financial ledger, so the raw value is matched first.
 */
function parseAmount(value, field) {
  const raw = typeof value === 'number' ? String(value) : String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(raw)) {
    throw badRequest(`${field} butun son raqam bo'lishi kerak (manfiy va kasr sonlar qabul qilinmaydi)`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw badRequest(`${field} noto'g'ri`);
  }
  return n;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** Text field: trimmed, length-capped so one row cannot hold a novel. */
function text(value, field, { required = false, max = 2000 } = {}) {
  const v = String(value == null ? '' : value).trim();
  if (required && !v) throw badRequest(`${field} to'ldirilishi shart`);
  if (v.length > max) throw badRequest(`${field} juda uzun`);
  return v;
}

/** Status is derived from the amounts, never taken from the request body. */
function statusFor(debtAmount, paidAmount) {
  if (paidAmount <= 0) return 'unpaid';
  if (paidAmount >= debtAmount) return 'paid';
  return 'partially_paid';
}

// ---------------------------------------------------------------------------
// Search / filter / sort / pagination
// ---------------------------------------------------------------------------

/**
 * Escapes LIKE wildcards so a search for "100%" is a literal search.
 */
function likeTerm(value) {
  return `%${String(value).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
}

// Whitelisted ORDER BY. A raw value from the query string is never interpolated.
// Aliased on `d` because the export sorts the same expression against a JOIN,
// where a bare created_at would be ambiguous against debt_payments.
const SORTS = {
  newest: 'd.created_at DESC, d.id DESC',
  oldest: 'd.created_at ASC, d.id ASC',
  largest: 'd.debt_amount DESC, d.id DESC',
  remaining: 'd.remaining_amount DESC, d.id DESC',
};

const FILTERS = {
  all: null,
  // "unpaid" means nothing has been paid yet. Partially-paid rows are a separate
  // filter so the counts stay mutually exclusive and the cards add up.
  unpaid: "d.status = 'unpaid' AND d.remaining_amount > 0",
  partially_paid: "d.status = 'partially_paid' AND d.remaining_amount > 0",
  paid: "d.status = 'paid'",
  archive: null, // handled separately: deleted_at IS NOT NULL
};

function listQuery(req) {
  const q = text(req.query.q ?? req.query.search, 'q', { max: 120 });
  // "status" is accepted as an alias for "filter" so an export link can be built
  // by hand (?status=unpaid) without having to know the internal filter names.
  const filterKeyRaw = req.query.filter ?? req.query.status;
  const filterKey = FILTERS[filterKeyRaw] !== undefined ? filterKeyRaw : 'all';
  const filter = FILTERS[filterKey];
  const archived = filterKey === 'archive';

  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(100, Math.max(5, Number.parseInt(req.query.per_page) || 20));
  const orderBy = SORTS[req.query.sort] || SORTS.newest;

  const where = [archived ? 'd.deleted_at IS NOT NULL' : 'd.deleted_at IS NULL'];
  const params = [];

  if (q) {
    const term = likeTerm(q);
    // Only the fields the operator can actually see. The home address used to be
    // searchable; it is no longer collected, displayed or exported, so matching on
    // it would let a legacy address surface rows the UI gives no way to explain.
    where.push("(d.full_name ILIKE ? ESCAPE '\\' OR d.phone ILIKE ? ESCAPE '\\' OR d.service ILIKE ? ESCAPE '\\')");
    params.push(term, term, term);
  }
  if (filter) where.push(filter);

  return { where: where.join(' AND '), params, page, perPage, orderBy, archived, filterKey };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Appends an audit row inside the caller's transaction.
 *
 * `metadata` deliberately holds only debtor/amount facts. The delete pass key is
 * never passed in here, so it cannot end up in the table — the gate is evidenced
 * by the delete_requested/deleted pair instead.
 */
async function audit(t, req, debtId, action, metadata) {
  await t
    .prepare(
      'INSERT INTO debt_audit_logs (debt_id, action, admin_id, admin_name, metadata) VALUES (?, ?, ?, ?, ?)'
    )
    .run(debtId == null ? null : Number(debtId), action, req.user.id, req.user.full_name || '', JSON.stringify(metadata || {}));
}

/**
 * Commits an audit row outside of any delete transaction.
 *
 * Needed for the failure path: a wrong pass key throws, and a throw inside
 * db.transaction() rolls the whole thing back, which would silently erase the
 * very record of the failed attempt. Recording `delete_denied` on its own
 * connection means the attempt survives the rollback.
 */
async function auditStandalone(req, debtId, action, metadata) {
  try {
    await audit(db, req, debtId, action, metadata);
  } catch {
    // Never let the audit bookkeeping mask the real reason the delete failed.
  }
}

/**
 * Snapshot of the debtor's identifying fields, for the audit trail.
 *
 * The home address is no longer part of this snapshot. It is absent from every
 * field the API collects or returns, so recording it on new audit rows would only
 * preserve data the product has stopped keeping. Rows already in the table are
 * historical facts and are left exactly as they are.
 */
function snapshot(d) {
  return {
    full_name: d.full_name,
    phone: d.phone,
    service: d.service,
    debt_amount: Number(d.debt_amount),
    paid_amount: Number(d.paid_amount),
    remaining_amount: Number(d.remaining_amount),
    status: d.status,
  };
}

/**
 * The columns every read path returns.
 *
 * `address` is absent on purpose: the column still exists in the table (see
 * migration 005) and older rows keep their value, but it is not selected, so it
 * cannot leak through the list, the detail endpoint, the statistics or either
 * export. Dropping it here rather than from each query is what makes that
 * guarantee hold for every caller at once.
 */
const DEBT_FIELDS = 'id, full_name, phone, service, description, debt_amount, paid_amount, remaining_amount, status, created_at, updated_at, deleted_at';

// ---------------------------------------------------------------------------
// DELETE pass key
// ---------------------------------------------------------------------------

/**
 * Checks the delete pass key from the environment against the one supplied.
 *
 * The comparison is timing-safe so the response time cannot be used to guess the
 * key one character at a time, and the supplied value is never echoed back,
 * logged, or written to the audit log.
 *
 * Fails closed: with DEBT_DELETE_PASS_KEY unset, deletion is refused in every
 * environment rather than quietly falling through to "no protection".
 */
function deletePassKeyOk(req) {
  const configured = String(process.env.DEBT_DELETE_PASS_KEY || '');
  if (!configured) {
    const err = new Error(
      "O'chirish vaqtincha faol emas. Server sozlamalarida DEBT_DELETE_PASS_KEY belgilanmagan."
    );
    err.status = 503;
    // A deliberate, actionable 5xx: safe to show, since it names an env var and
    // leaks nothing about the key itself.
    err.expose = true;
    throw err;
  }

  const header = req.headers['x-debt-pass-key'];
  const bearer = String(req.headers.authorization || '');
  const bearerValue = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : '';
  const provided = String(header || req.body?.pass_key || bearerValue || '').trim();
  if (!provided) {
    rateLimit.recordDebtDeleteFailure(req);
    throw forbidden();
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    rateLimit.recordDebtDeleteFailure(req);
    throw forbidden();
  }
  return true;
}

function forbidden() {
  const err = new Error("Pass key noto'g'ri");
  err.status = 403;
  return err;
}

function paidOnly() {
  const err = new Error('Bu qarz hali to\'liq to\'lanmagan.');
  err.status = 409;
  return err;
}

/**
 * Separate from paidOnly(): an archived row may well be fully paid, so saying
 * "not fully paid" about it would be a misleading reason for the refusal.
 */
function archivedOnly() {
  const err = new Error('Bu qarz arxivlangan.');
  err.status = 409;
  return err;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Legacy CSV export.
 *
 * Kept, and still reachable, for backward compatibility with anything already
 * pointing at it -- a saved bookmark, a report that runs on a schedule, an older
 * build of the app. The UI no longer offers it; the Excel workbook at
 * "/export.xlsx" is what an operator downloads.
 *
 * `address` is gone from the output for the same reason it is gone from the API.
 */
router.get('/export.csv', async (req, res) => {
  const { where, params } = listQuery(req);
  const rows = await db
    .prepare(`SELECT ${DEBT_FIELDS} FROM debts d WHERE ${where} ORDER BY d.created_at DESC, d.id DESC`)
    .all(...params);

  const header = ['Ism', 'Telefon', 'Xizmat', 'Qarz', 'To\'langan', 'Qolgan', 'Holat', 'Sana'];
  const body = rows.map((d) => [
    d.full_name,
    d.phone,
    d.service,
    d.debt_amount,
    d.paid_amount,
    d.remaining_amount,
    STATUS_UZ[d.status] || d.status,
    d.created_at,
  ]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  // Attached as a download, never served from a public URL, and the response is
  // only reachable through the session cookie checked above.
  res.setHeader('Content-Disposition', `attachment; filename="qarz-daftari-${appNow()}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send([header, ...body].map((row) => row.map(csvCell).join(',')).join('\r\n'));
});

/**
 * Excel (.xlsx) export of the whole ledger: debts, payments and audit rows.
 *
 * Three sheets, because they answer three different questions and mixing them
 * would make the sheet unusable for the first two: what is owed (Qarzlar), what
 * has been received (To'lovlar) and who did what (Audit).
 *
 * It exports what the operator is currently looking at. The same `listQuery`
 * helper the list view uses decides the rows, so `?filter=unpaid&sort=largest`
 * or `?q=99890123` produce a file of exactly those debts. Pagination is
 * deliberately ignored: an export that silently stops at 20 rows is worse than
 * useless on a ledger.
 *
 * Cost: three queries plus one aggregate, regardless of how many debts there are.
 * The payment and audit sheets JOIN debts and reuse the identical WHERE clause, so
 * no debt id is fetched twice and there is no query per row.
 *
 * Auth: this router applies auth.authenticate to itself, so the endpoint is
 * unreachable without an admin session. It deliberately adds no extra permission
 * scope: the debt ledger has never gated a role, and adding one now would lock
 * out admins who can already see every debt on screen.
 */
router.get('/export.xlsx', async (req, res) => {
  const { where, params, orderBy, filterKey } = listQuery(req);

  const debts = await db
    .prepare(`SELECT ${DEBT_FIELDS} FROM debts d WHERE ${where} ORDER BY ${orderBy}`)
    .all(...params);

  // One query for the whole payment history, filtered by the same WHERE, instead
  // of a lookup per debt. The debt's name and phone ride along on the join so the
  // sheet is readable without the reader cross-referencing sheet one.
  const payments = await db
    .prepare(
      `SELECT p.id, p.debt_id, p.amount, p.note, p.created_at, p.created_by,
              d.full_name, d.phone, u.full_name AS created_by_name
         FROM debt_payments p
         JOIN debts d ON d.id = p.debt_id
         LEFT JOIN users u ON u.id = p.created_by
        WHERE ${where}
        ORDER BY p.created_at DESC, p.id DESC`
    )
    .all(...params);

  // debt_audit_logs.debt_id has no foreign key on purpose (an audit row outlives
  // the debt it describes), so the join also carries the rows left behind by a
  // purge -- those are attached to no debt any more and are therefore not part of
  // "the debts currently in view".
  const auditLogs = await db
    .prepare(
      `SELECT a.id, a.debt_id, a.action, a.admin_name, a.metadata, a.created_at
         FROM debt_audit_logs a
         JOIN debts d ON d.id = a.debt_id
        WHERE ${where}
        ORDER BY a.created_at DESC, a.id DESC`
    )
    .all(...params);

  // The summary must describe the file, not the ledger, so it aggregates over the
  // same WHERE rather than reading the totals endpoint.
  const totals = await db
    .prepare(
      `SELECT COALESCE(SUM(debt_amount), 0)                   AS total_debt,
              COALESCE(SUM(paid_amount), 0)                   AS total_paid,
              COALESCE(SUM(GREATEST(remaining_amount, 0)), 0) AS total_remaining,
              COUNT(*)                                       AS total_count
         FROM debts d WHERE ${where}`
    )
    .get(...params);

  const { buffer, counts } = await buildDebtWorkbook({
    debts: debts.map((d) => ({ ...d, status_label: STATUS_UZ[d.status] || d.status })),
    payments,
    auditLogs,
    totals: {
      total_debt: Number(totals.total_debt),
      total_paid: Number(totals.total_paid),
      total_remaining: Number(totals.total_remaining),
    },
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="qarz-daftari-${todayStamp()}.xlsx"`);
  res.setHeader('Cache-Control', 'no-store');
  // XLSX is a ZIP, so a proxy must not try to re-compress it.
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('X-Export-Rows', `${counts.debts}/${counts.payments}/${counts.auditLogs}`);
  res.setHeader('X-Export-Filter', String(filterKey));
  res.end(buffer);
});

const STATUS_UZ = { unpaid: "To'lanmagan", partially_paid: "Qisman to'langan", paid: "To'langan" };

function appNow() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/** "YYYY-MM-DD" for the download filename. */
function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Spreadsheet formula injection guard for the legacy CSV export.
 *
 * A cell starting with = + - @ is executed by Excel/Sheets when the file is
 * opened, so a debtor's name of "=cmd|..." would run on the operator's machine.
 * The .xlsx workbook applies the equivalent guard in debtExcel.js, which is where
 * new code should come from; this stays because the CSV endpoint stays.
 */
function csvCell(value) {
  let v = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

router.get('/stats', async (req, res) => {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*)                                                   AS total_debtors,
         COALESCE(SUM(debt_amount), 0)                              AS total_debt,
         COALESCE(SUM(GREATEST(remaining_amount, 0)), 0)            AS total_remaining,
         COALESCE(SUM(paid_amount), 0)                              AS total_paid,
         COUNT(*) FILTER (WHERE remaining_amount > 0)                AS open_debtors,
         COUNT(*) FILTER (WHERE status = 'partially_paid')           AS partial_debtors,
         COUNT(*) FILTER (WHERE status = 'paid')                     AS paid_debtors,
         COUNT(*) FILTER (WHERE created_at >= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')::text)
                                                                       AS created_today
       FROM debts WHERE deleted_at IS NULL`
    )
    .get();

  res.json({
    totalDebtors: Number(row.total_debtors),
    totalDebt: Number(row.total_debt),
    totalRemaining: Number(row.total_remaining),
    totalPaid: Number(row.total_paid),
    openDebtors: Number(row.open_debtors),
    partialDebtors: Number(row.partial_debtors),
    paidDebtors: Number(row.paid_debtors),
    createdToday: Number(row.created_today),
    archived: Number(
      (await db.prepare('SELECT COUNT(*) c FROM debts WHERE deleted_at IS NOT NULL').get()).c
    ),
  });
});

router.get('/', async (req, res) => {
  const { where, params, page, perPage, orderBy, archived } = listQuery(req);

  const rows = await db
    .prepare(`SELECT ${DEBT_FIELDS} FROM debts d WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all([...params, perPage, (page - 1) * perPage]);
  const total = Number(
    (await db.prepare(`SELECT COUNT(*) c FROM debts d WHERE ${where}`).get(...params)).c
  );

  res.json({
    debts: rows.map((d) => ({ ...d, status_label: STATUS_UZ[d.status] || d.status })),
    pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    archived,
  });
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const full_name = text(body.full_name, 'Ism-familiya', { required: true, max: 200 });
  const phone = text(body.phone, 'Telefon', { required: true, max: 60 });
  const service = text(body.service, 'Xizmat', { required: true, max: 300 });
  const description = text(body.description, 'Izoh', { max: 4000 });

  // `address` is accepted and discarded. The field was retired from the product,
  // but an older client or a bookmarked request may still send it; silently
  // ignoring it keeps that request working instead of turning it into a 400, and
  // ignoring it is what stops the value from being stored.
  const debt_amount = parseAmount(body.debt_amount, 'Qarz');
  if (debt_amount <= 0) throw badRequest("Qarz summasi 0 dan katta bo'lishi kerak");

  // An opening payment is allowed but must be coherent with the debt itself.
  const paid_amount = body.paid_amount === undefined || body.paid_amount === null || body.paid_amount === ''
    ? 0
    : parseAmount(body.paid_amount, "To'langan");
  if (paid_amount > debt_amount) throw badRequest("To'langan summa qarz summasidan katta bo'lishi mumkin emas");

  const status = statusFor(debt_amount, paid_amount);

  const debt = await db.transaction(async (t) => {
    // address is written as an empty string, NOT NULL. The column is kept for
    // schema compatibility with existing data, and this is the only value a new
    // row may hold in it. Nothing that the operator typed ever reaches it.
    const created = await t
      .prepare(
        `INSERT INTO debts (full_name, phone, address, service, description, debt_amount, paid_amount, status)
         VALUES (?, ?, '', ?, ?, ?, ?, ?) RETURNING ${DEBT_FIELDS}`
      )
      .one(full_name, phone, service, description, debt_amount, paid_amount, status);

    // An opening balance that is already paid is recorded in the payment ledger
    // too, so SUM(debt_payments) always reconciles with paid_amount.
    if (paid_amount > 0) {
      await t
        .prepare('INSERT INTO debt_payments (debt_id, amount, note, created_by) VALUES (?, ?, ?, ?)')
        .run(created.id, paid_amount, 'Boshlang\'ich to\'lov', req.user.id);
    }
    await audit(t, req, created.id, 'created', snapshot(created));
    return created;
  });

  res.status(201).json({ debt });
});

router.get('/:id', async (req, res) => {
  const debt = await db
    .prepare(`SELECT ${DEBT_FIELDS} FROM debts WHERE id = ?`)
    .get(Number(req.params.id));
  if (!debt) return res.status(404).json({ error: 'Qarz topilmadi' });

  const payments = await db
    .prepare(
      'SELECT p.id, p.amount, p.note, p.created_at, p.created_by, u.full_name AS created_by_name FROM debt_payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.debt_id = ? ORDER BY p.created_at DESC, p.id DESC'
    )
    .all(debt.id);
  const auditLogs = await db
    .prepare(
      'SELECT id, action, admin_id, admin_name, metadata, created_at FROM debt_audit_logs WHERE debt_id = ? ORDER BY created_at DESC, id DESC'
    )
    .all(debt.id);

  res.json({ debt: { ...debt, status_label: STATUS_UZ[debt.status] || debt.status }, payments, audit_logs: auditLogs });
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.prepare(`SELECT ${DEBT_FIELDS} FROM debts WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Qarz topilmadi' });
  if (existing.deleted_at) return res.status(409).json({ error: 'Arxivdagi qarzni tahrirlash mumkin emas' });

  const body = req.body || {};
  const full_name = 'full_name' in body ? text(body.full_name, 'Ism-familiya', { required: true, max: 200 }) : existing.full_name;
  const phone = 'phone' in body ? text(body.phone, 'Telefon', { required: true, max: 60 }) : existing.phone;
  const service = 'service' in body ? text(body.service, 'Xizmat', { required: true, max: 300 }) : existing.service;
  const description = 'description' in body ? text(body.description, 'Izoh', { max: 4000 }) : existing.description;

  // `address` in the body is ignored, for the same reason as on create. It is also
  // absent from the UPDATE below, so a value already stored on the row is left
  // untouched rather than blanked out.
  const debt_amount = 'debt_amount' in body ? parseAmount(body.debt_amount, 'Qarz') : Number(existing.debt_amount);
  if (debt_amount <= 0) throw badRequest("Qarz summasi 0 dan katta bo'lishi kerak");

  // paid_amount is intentionally NOT editable here: it only ever moves through a
  // payment or mark-paid, so the payment ledger stays a complete history.
  const paid_amount = Number(existing.paid_amount);
  if (paid_amount > debt_amount) {
    throw badRequest("Qarzni kamaytirish mumkin emas: to'langan summa yangi qarz summasidan katta bo'lib ketadi");
  }
  const status = statusFor(debt_amount, paid_amount);

  const debt = await db.transaction(async (t) => {
    const updated = await t
      .prepare(
        `UPDATE debts SET full_name = ?, phone = ?, service = ?, description = ?,
                          debt_amount = ?, status = ?, updated_at = app_now()
         WHERE id = ? RETURNING ${DEBT_FIELDS}`
      )
      .one(full_name, phone, service, description, debt_amount, status, id);
    await audit(t, req, id, 'updated', { before: snapshot(existing), after: snapshot(updated) });
    return updated;
  });

  res.json({ debt: { ...debt, status_label: STATUS_UZ[debt.status] || debt.status } });
});

/**
 * Records a payment.
 *
 * The whole thing runs in one transaction that re-reads the debt with FOR UPDATE,
 * so two admins paying the same debt at the same moment serialise instead of
 * both computing a stale remaining amount. remaining_amount is recomputed by the
 * database (generated column), never by the client.
 */
router.post('/:id/payments', async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const amount = parseAmount(body.amount, "To'lov");
  if (amount <= 0) throw badRequest("To'lov summasi 0 dan katta bo'lishi kerak");
  const note = text(body.note, 'Izoh', { max: 1000 });

  const debt = await db.transaction(async (t) => {
    const current = await t
      .prepare(`SELECT ${DEBT_FIELDS} FROM debts WHERE id = ? FOR UPDATE`)
      .one(id);
    if (!current) {
      const err = new Error('Qarz topilmadi');
      err.status = 404;
      throw err;
    }
    if (current.deleted_at) throw archivedOnly();

    const remaining = Number(current.remaining_amount);
    if (amount > remaining) {
      throw badRequest(`To'lov qoldiq summadan (${remaining} so'm) katta bo'lishi mumkin emas`);
    }

    const paid = Number(current.paid_amount) + amount;
    const status = statusFor(Number(current.debt_amount), paid);

    await t
      .prepare('INSERT INTO debt_payments (debt_id, amount, note, created_by) VALUES (?, ?, ?, ?)')
      .run(id, amount, note, req.user.id);

    const updated = await t
      .prepare("UPDATE debts SET paid_amount = ?, status = ?, updated_at = app_now() WHERE id = ? RETURNING " + DEBT_FIELDS)
      .one(paid, status, id);

    await audit(t, req, id, 'payment_added', {
      amount,
      note,
      debt_amount: Number(updated.debt_amount),
      paid_amount: Number(updated.paid_amount),
      remaining_amount: Number(updated.remaining_amount),
      status: updated.status,
    });
    return updated;
  });

  res.status(201).json({ debt: { ...debt, status_label: STATUS_UZ[debt.status] || debt.status } });
});

/**
 * Marks the debt fully paid.
 *
 * A payment row is inserted for the outstanding remainder so that
 * SUM(debt_payments) always equals paid_amount; otherwise the payment history
 * would silently disagree with the debt record.
 */
router.post('/:id/mark-paid', async (req, res) => {
  const id = Number(req.params.id);
  const debt = await db.transaction(async (t) => {
    const current = await t.prepare(`SELECT ${DEBT_FIELDS} FROM debts WHERE id = ? FOR UPDATE`).one(id);
    if (!current) {
      const err = new Error('Qarz topilmadi');
      err.status = 404;
      throw err;
    }
    if (current.deleted_at) throw archivedOnly();

    const outstanding = Number(current.remaining_amount);
    if (outstanding > 0) {
      await t
        .prepare('INSERT INTO debt_payments (debt_id, amount, note, created_by) VALUES (?, ?, ?, ?)')
        .run(id, outstanding, 'Qarz to\'liq to\'langan deb belgilandi', req.user.id);
    }
    const updated = await t
      .prepare("UPDATE debts SET paid_amount = debt_amount, status = 'paid', updated_at = app_now() WHERE id = ? RETURNING " + DEBT_FIELDS)
      .one(id);
    await audit(t, req, id, 'marked_paid', { settled_amount: outstanding, ...snapshot(updated) });
    return updated;
  });

  res.json({ debt: { ...debt, status_label: STATUS_UZ[debt.status] || debt.status } });
});

/**
 * Soft delete (archive).
 *
 * Order of checks, all server-side, so bypassing the UI changes nothing:
 *   1. session            -> router-level auth.authenticate
 *   2. rate limit         -> failed pass keys are counted per IP and per admin
 *   3. debt exists
 *   4. remaining_amount === 0
 *   5. pass key           -> timing-safe compare against DEBT_DELETE_PASS_KEY
 *
 * The row is never removed from the table: deleted_at is stamped so the history
 * stays queryable in the archive, and the audit trail keeps its own copy.
 */
router.delete('/:id', rateLimit.debtDeleteRateLimit, async (req, res) => {
  const id = Number(req.params.id);

  // Pre-read outside the lock: used for the cheap checks and for the audit
  // snapshot. The authoritative check is repeated under FOR UPDATE below.
  const current = await db.prepare(`SELECT ${DEBT_FIELDS} FROM debts WHERE id = ?`).get(id);
  if (!current) return res.status(404).json({ error: 'Qarz topilmadi' });
  if (current.deleted_at) return res.status(409).json({ error: 'Bu qarz allaqachon arxivlangan' });
  // The UI hides this for unsettled debts; the API enforces it regardless.
  if (Number(current.remaining_amount) > 0) throw paidOnly();

  // Committed on its own connection *before* the pass key is examined, so a
  // wrong key leaves a durable record instead of rolling the attempt away.
  await auditStandalone(req, id, 'delete_requested', snapshot(current));

  try {
    deletePassKeyOk(req);
  } catch (e) {
    // Metadata holds only the refusal reason and status, never the supplied key.
    await auditStandalone(req, id, 'delete_denied', { status: e.status, reason: e.message });
    throw e;
  }

  const archived = await db.transaction(async (t) => {
    const locked = await t.prepare(`SELECT ${DEBT_FIELDS} FROM debts WHERE id = ? FOR UPDATE`).one(id);
    if (!locked) {
      const err = new Error('Qarz topilmadi');
      err.status = 404;
      throw err;
    }
    // Another admin may have archived it between the pre-read and this lock.
    if (locked.deleted_at) return null;
    if (Number(locked.remaining_amount) > 0) throw paidOnly();

    const row = await t
      .prepare("UPDATE debts SET deleted_at = app_now(), deleted_by = ?, updated_at = app_now() WHERE id = ? RETURNING " + DEBT_FIELDS)
      .one(req.user.id, id);
    await audit(t, req, id, 'deleted', snapshot(row));
    return row;
  });

  if (!archived) return res.status(409).json({ error: 'Bu qarz allaqachon arxivlangan' });

  // A correct key clears the failure budget for this admin.
  rateLimit.recordDebtDeleteSuccess(req);

  res.json({ ok: true, debt: archived });
});

/**
 * Permanent purge — the only code path that removes a row, so it is restricted to
 * super_admin *and* a second pass key check.
 *
 * The ordinary delete above is a soft delete and is what the UI uses. A purge is
 * refused outright if the debt has any payment history: debt_payments is
 * ON DELETE RESTRICT, so a debt that ever received money can never be removed,
 * only archived. That keeps the payment ledger append-only in every environment
 * and keeps this endpoint to the narrow case of an accidental entry with no
 * money attached.
 */
router.post('/:id/purge', rateLimit.debtDeleteRateLimit, auth.authorize('super_admin'), async (req, res) => {
  const id = Number(req.params.id);

  const current = await db.prepare(`SELECT ${DEBT_FIELDS} FROM debts WHERE id = ?`).get(id);
  if (!current) return res.status(404).json({ error: 'Qarz topilmadi' });
  if (Number(current.remaining_amount) > 0) throw paidOnly();

  await auditStandalone(req, id, 'delete_requested', snapshot(current));

  try {
    deletePassKeyOk(req);
  } catch (e) {
    await auditStandalone(req, id, 'delete_denied', { status: e.status, reason: e.message });
    throw e;
  }

  const purged = await db.transaction(async (t) => {
    const locked = await t.prepare(`SELECT ${DEBT_FIELDS} FROM debts WHERE id = ? FOR UPDATE`).one(id);
    if (!locked) {
      const err = new Error('Qarz topilmadi');
      err.status = 404;
      throw err;
    }
    if (Number(locked.remaining_amount) > 0) throw paidOnly();

    // Belt and braces: even if the count above raced, the RESTRICT foreign key
    // would abort the DELETE. This produces a clear 409 instead of a 500.
    const payments = await t.prepare('SELECT COUNT(*) c FROM debt_payments WHERE debt_id = ?').get(id);
    if (Number(payments.c) > 0) {
      const err = new Error(
        "Bu qarzga to'lovlar qo'shilgan. To'lov tarixi saqlanishi uchun bu yozuv faqat arxivlanadi."
      );
      err.status = 409;
      throw err;
    }

    await t.prepare('DELETE FROM debts WHERE id = ?').run(id);
    // debt_audit_logs has no foreign key to debts, so these rows survive and the
    // purge stays on record.
    await audit(t, req, id, 'purged', snapshot(current));
    return current;
  });

  rateLimit.recordDebtDeleteSuccess(req);
  res.json({ ok: true, purged: purged.id });
});

module.exports = { router, STATUS_UZ };