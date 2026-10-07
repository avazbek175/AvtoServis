/**
 * Oil and filter inventory: stock arithmetic, movement ledger and audit.
 *
 * This module holds the logic rather than the HTTP layer for one reason: a work
 * log must consume stock *inside the same transaction* as the work log row, and
 * the work-log router must not reach that logic by requiring the inventory router
 * (which would pull an Express router into an unrelated module).
 *
 * Every function that touches stock takes an explicit `runner`: either the pool
 * facade (`db`) or a transaction (`t`). Callers MUST already be inside a
 * transaction for `applyMovement`, because the correctness of the whole ledger
 * rests on the `SELECT ... FOR UPDATE` row lock being held until COMMIT, and
 * `db.transaction()` deliberately does not nest -- a nested call would grab a
 * second pooled connection and lock nothing at all.
 */
const db = require('./db');

const { db: pool } = db;

// Columns returned for a product row. Kept in one place so the list endpoint,
// the detail endpoint and the CSV export can never drift apart.
//
// `sale_price` is an output expression, not a column: `cost_price +
// markup_amount` is computed by PostgreSQL at read time, so the selling price
// can never fall out of step with the two numbers it is made of. Every call site
// selects from this single table (no join, no aggregate), which is what makes a
// bare expression safe here.
const PRODUCT_FIELDS =
  'id, name, type, brand, viscosity, unit, package_size, current_quantity, ' +
  'minimum_quantity, cost_price, markup_amount, ' +
  'cost_price + markup_amount AS sale_price, ' +
  'is_active, created_at, updated_at';

const MOVEMENT_FIELDS =
  'id, product_id, movement_type, quantity, before_quantity, after_quantity, ' +
  'reference_type, reference_id, admin_id, note, created_at';

/**
 * Same columns, table-qualified.
 *
 * Any movement query that joins `users` (for the admin name) or `inventory_products`
 * (for the product name) must use this instead of MOVEMENT_FIELDS: a bare `id` is
 * ambiguous there and PostgreSQL refuses the whole statement.
 */
function movementFields(alias) {
  const a = alias ? `${alias}.` : '';
  return (
    `${a}id, ${a}product_id, ${a}movement_type, ${a}quantity, ${a}before_quantity, ` +
    `${a}after_quantity, ${a}reference_type, ${a}reference_id, ${a}admin_id, ` +
    `${a}note, ${a}created_at`
  );
}

// Widest values the columns can hold. NUMERIC(12,3) tops out at 999999999.999
// and NUMERIC(12,2) at 9999999999.99. Checking this here turns an out-of-range
// quantity into a readable 400 instead of a "numeric field overflow" 500 from
// PostgreSQL, which tells the operator nothing about what to fix.
const MAX_QTY = 999999999.999;
const MAX_MONEY = 9999999999.99;

const MOVEMENT_TYPES = ['purchase', 'consumption', 'adjustment'];
const PRODUCT_TYPES = ['oil', 'filter'];
const UNITS = ['liter', 'piece'];

// Movement type -> audit action.
const AUDIT_FOR = {
  purchase: 'stock_in',
  consumption: 'consumed',
  adjustment: 'adjusted',
};

// Oil is sold by volume and filters by the piece; the DB CHECK enforces the same
// pairing. Deriving it here means a client cannot ask for a filter in litres.
function unitForType(type) {
  return type === 'oil' ? 'liter' : 'piece';
}

function unitLabel(product) {
  return product.unit === 'liter' ? 'L' : 'dona';
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

/** 409: the request is well-formed but conflicts with the current state. */
function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

/**
 * Strict unsigned decimal parser.
 *
 * `parseFloat` is unusable here: it accepts `'4.5abc'` (returning 4.5) and
 * `'1e3'` (returning 1000), so a typo would silently record a different volume
 * than the operator typed, and an exponent would smuggle in a value that does
 * not fit NUMERIC(12,3). The raw text is matched before conversion. `integer`
 * additionally refuses any decimal point, because filters are whole pieces.
 */
function parseQty(value, field, { integer = false, allowZero = false } = {}) {
  const raw = typeof value === 'number' ? String(value) : String(value == null ? '' : value).trim();
  if (!/^\d+(\.\d{1,3})?$/.test(raw)) {
    throw badRequest(`${field} noto'g'ri formatda (masalan ${integer ? '4' : '4.5'})`);
  }
  if (integer && raw.includes('.')) {
    throw badRequest(`${field} butun son bo'lishi kerak`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest(`${field} noto'g'ri`);
  if (n < 0) throw badRequest(`${field} manfiy bo'lishi mumkin emas`);
  if (n > MAX_QTY) throw badRequest(`${field} juda katta ( maksimal ${MAX_QTY} )`);
  if (n === 0 && !allowZero) throw badRequest(`${field} 0 dan katta bo'lishi kerak`);
  return n;
}

/**
 * Signed decimal parser, for a stock take that found *less* than the system holds.
 * Same strictness as `parseQty`, but zero is refused because a movement that
 * changes nothing would be a lie in the history.
 */
function parseSignedQty(value, field, { integer = false } = {}) {
  const raw = typeof value === 'number' ? String(value) : String(value == null ? '' : value).trim();
  if (!/^-?\d+(\.\d{1,3})?$/.test(raw)) {
    throw badRequest(`${field} noto'g'ri formatda (masalan -1.5)`);
  }
  if (integer && raw.includes('.')) {
    throw badRequest(`${field} butun son bo'lishi kerak`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) throw badRequest(`${field} 0 bo'lmasligi kerak`);
  return n;
}

/** Money: two decimals, never negative. Stored as NUMERIC(12,2), never REAL. */
function parseMoney(value, field) {
  const raw = typeof value === 'number' ? String(value) : String(value == null ? '' : value).trim();
  if (raw === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw badRequest(`${field} noto'g'ri formatda (masalan 45000 yoki 45000.50)`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest(`${field} noto'g'ri`);
  if (n > MAX_MONEY) throw badRequest(`${field} juda katta ( maksimal ${MAX_MONEY} )`);
  return n;
}

/** Trimmed free text with a length cap, matching the debt ledger's helper. */
function text(value, field, { required = false, max = 200 } = {}) {
  const v = String(value == null ? '' : value).trim();
  if (required && !v) throw badRequest(`${field} to'ldirilishi shart`);
  if (v.length > max) throw badRequest(`${field} juda uzun`);
  return v;
}

/**
 * Validates a *complete* product object and returns the cleaned columns.
 *
 * Callers validate the merged product (existing row patched with the request),
 * not the request alone. That closes the hole where changing `type` from filter
 * to oil would otherwise leave viscosity empty and only be caught by the database
 * CHECK, as an opaque 500 instead of a 400.
 */
function validateProduct(input) {
  const out = {};

  const type = String(input.type || '').trim();
  if (!PRODUCT_TYPES.includes(type)) throw badRequest("Mahsulot turi noto'g'ri (moy yoki filtr)");
  out.type = type;

  out.name = text(input.name, 'Mahsulot nomi', { required: true, max: 150 });
  out.brand = text(input.brand, 'Brend', { max: 80 });
  out.viscosity = text(input.viscosity, 'Viskozitet', { max: 30 });

  // Viscosity is meaningful for oil only. Rejecting it for a filter keeps the
  // two product types from drifting into a shared, ambiguous shape.
  if (type === 'oil' && !out.viscosity) {
    throw badRequest("Moy uchun viskozitet majburiy (masalan 5W-30)");
  }
  if (type === 'filter' && out.viscosity) {
    throw badRequest('Filtr uchun viskozitet kiritilmaydi');
  }

  // `unit` is derived, never trusted. A contradicting value is a bug in the
  // caller and is reported rather than quietly overwritten.
  if (input.unit !== undefined && input.unit !== null && String(input.unit).trim() !== '') {
    const unit = String(input.unit).trim();
    if (!UNITS.includes(unit)) throw badRequest("Birlik noto'g'ri (liter yoki dona)");
    if (unit !== unitForType(type)) {
      throw badRequest(
        type === 'oil'
          ? "Moy uchun birlik 'liter' bo'lishi kerak"
          : "Filtr uchun birlik 'dona' bo'lishi kerak"
      );
    }
  }
  out.unit = unitForType(type);

  out.package_size = parseQty(
    input.package_size === undefined || input.package_size === null || input.package_size === ''
      ? 1
      : input.package_size,
    'Qadoq hajmi'
  );
  out.minimum_quantity = parseQty(
    input.minimum_quantity === undefined || input.minimum_quantity === null || input.minimum_quantity === ''
      ? 0
      : input.minimum_quantity,
    'Minimal qoldiq',
    { allowZero: true }
  );
  out.cost_price = parseMoney(input.cost_price, 'Kelish narxi');
  out.markup_amount = parseMoney(input.markup_amount, 'Ustama summa');

  return out;
}

/**
 * Appends an audit row inside the caller's transaction.
 *
 * Mirrors the debt ledger's helper: it takes the runner so the audit row shares
 * the caller's transaction, and it never receives anything sensitive.
 */
async function audit(runner, req, productId, action, metadata) {
  await runner
    .prepare(
      'INSERT INTO inventory_audit_logs (product_id, action, admin_id, admin_name, metadata) VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      productId == null ? null : Number(productId),
      action,
      req && req.user ? req.user.id : null,
      req && req.user ? req.user.full_name || '' : '',
      JSON.stringify(metadata || {})
    );
}

/**
 * Audit row that must survive the rollback of the action it describes.
 *
 * A refused action throws, and a throw inside db.transaction() rolls everything
 * back -- which would erase the only record that someone tried. This writes on
 * the pool instead, so the attempt outlives the failure.
 */
async function auditStandalone(req, productId, action, metadata) {
  try {
    await audit(pool, req, productId, action, metadata);
  } catch {
    // Never let audit bookkeeping mask the real reason the action failed.
  }
}

/** Numeric summary of a product for audit metadata. */
function snapshot(p) {
  return {
    name: p.name,
    type: p.type,
    brand: p.brand,
    unit: p.unit,
    current_quantity: Number(p.current_quantity),
    minimum_quantity: Number(p.minimum_quantity),
    cost_price: Number(p.cost_price),
    markup_amount: Number(p.markup_amount),
    is_active: Number(p.is_active),
  };
}

/**
 * Locks the product row and applies one stock movement.
 *
 * The lock is the whole point: `SELECT ... FOR UPDATE` blocks a second admin who
 * is consuming the same product until this transaction commits, so the "is there
 * enough stock" test and the write that acts on it cannot be interleaved.
 *
 * The new level is computed by PostgreSQL, never in JavaScript. `23.5 + 4.5` is
 * exact in double arithmetic, but `0.1 + 0.2` is not, and a warehouse that
 * accumulates 0.30000000000000004 litres of phantom oil is worse than one that
 * refuses to run. NUMERIC does every step exactly; the value crosses into JS
 * only at the boundary, where it is a plain decimal.
 *
 * MUST be called inside db.transaction().
 *
 * @returns {{product: object, movement: object}}
 */
async function applyMovement(runner, opts) {
  const {
    productId,
    movementType,
    quantity,
    absoluteTarget,
    req,
    note = '',
    referenceType = null,
    referenceId = null,
    allowInactive = false,
  } = opts;

  if (!MOVEMENT_TYPES.includes(movementType)) throw badRequest("Harakat turi noto'g'ri");

  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Mahsulot topilmadi');

  // --- 1. Lock the row -------------------------------------------------
  const before = await runner
    .prepare(`SELECT ${PRODUCT_FIELDS} FROM inventory_products WHERE id = ? FOR UPDATE`).get(id);
  if (!before) throw notFound('Mahsulot topilmadi');
  if (!allowInactive && !Number(before.is_active)) {
    throw conflict('Bu mahsulot arxivlangan. Avval uni faollashtiring.');
  }

  const startQty = Number(before.current_quantity);

  // Signed delta. Consumption is stored negative, so a single SUM over
  // inventory_movements.quantity reproduces the current stock exactly.
  let delta;
  if (absoluteTarget !== undefined && absoluteTarget !== null) {
    // A stock take states the real level; the movement records the difference so
    // the history stays a narrative. The subtraction runs in PostgreSQL to keep
    // it exact.
    const row = await runner
      .prepare('SELECT (?::numeric - ?::numeric) AS delta')
      .get(absoluteTarget, startQty);
    delta = Number(row.delta);
  } else {
    delta = Number(quantity);
    if (!Number.isFinite(delta)) throw badRequest('Miqdor noto\'g\'ri');
    if (movementType === 'consumption') {
      // Consumption is stored negative so that a single SUM over the ledger
      // reproduces the current level. The client sends a positive magnitude
      // ("take 4 L"); the sign is applied here, so no caller can get it wrong
      // and add stock by accident.
      if (delta <= 0) throw badRequest("Sarflanadigan miqdor 0 dan katta bo'lishi kerak");
      delta = -Math.abs(delta);
    }
  }
  if (!Number.isFinite(delta) || delta === 0) {
    throw badRequest("Miqdor 0 bo'lmasligi kerak");
  }

  // `reference_type` and `reference_id` are paired by a CHECK constraint. A
  // manual stock-in legitimately has no referring row, so a type without an id
  // is normalised to "no reference at all" here rather than at each call site --
  // forgetting it once would surface as an opaque 500 from the database.
  const refType = referenceId === undefined || referenceId === null ? null : referenceType;

  // Rounded to the column's 3 decimals before the sign test so a value that is
  // a hair under zero through double rounding is treated as zero. The actual
  // stored level is whatever PostgreSQL computes, never this number.
  const projected = Number((startQty + delta).toFixed(3));
  if (projected < 0) {
    const u = unitLabel(before);
    throw conflict(
      `${before.name} uchun yetarli qoldiq yo'q. Qoldiq: ${startQty} ${u}, talab: ${Math.abs(delta)} ${u}`
    );
  }

  // --- 2. Write the new level ------------------------------------------
  // The WHERE guard is a second line of defence: even with the lock, the row
  // cannot be driven below zero.
  const updated = await runner
    .prepare(
      `UPDATE inventory_products
          SET current_quantity = current_quantity + ?, updated_at = app_now()
        WHERE id = ? AND current_quantity + ? >= 0
        RETURNING ${PRODUCT_FIELDS}`
    )
    .one(delta, id, delta);
  if (!updated) {
    throw conflict('Qoldiq yetarli emas. Boshqa admin allaqachon sarf qilgan.');
  }

  // --- 3. Append the movement ------------------------------------------
  // Same transaction, so a movement row can never exist without the stock
  // change it describes, nor the stock change without its movement.
  const safeNote = String(note == null ? '' : note).trim().slice(0, 500);
  const movement = await runner
    .prepare(
      `INSERT INTO inventory_movements
         (product_id, movement_type, quantity, before_quantity, after_quantity,
          reference_type, reference_id, admin_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${MOVEMENT_FIELDS}`
    )
    .one(
      id,
      movementType,
      delta,
      startQty,
      Number(updated.current_quantity),
      refType,
      referenceId,
      req && req.user ? req.user.id : null,
      safeNote
    );

  await audit(runner, req, id, AUDIT_FOR[movementType], {
    movement_type: movementType,
    quantity: delta,
    before_quantity: startQty,
    after_quantity: Number(updated.current_quantity),
    reference_type: refType,
    reference_id: referenceId,
    note: safeNote,
  });

  return { product: updated, movement };
}

/**
 * Recomputes the current level from the movement ledger alone.
 *
 * Deliberately independent of `current_quantity` -- this is what proves the two
 * agree. Any drift (a manual UPDATE, a restored backup) shows up here.
 */
async function reconcile(runner, productId) {
  const row = await runner
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS total,
              COALESCE(SUM(quantity) FILTER (WHERE movement_type = 'purchase'), 0) AS purchased,
              COALESCE(SUM(-quantity) FILTER (WHERE movement_type = 'consumption'), 0) AS consumed,
              COALESCE(SUM(quantity) FILTER (WHERE movement_type = 'adjustment'), 0) AS adjusted,
              COUNT(*) AS movements
         FROM inventory_movements WHERE product_id = ?`
    )
    .get(productId);
  const product = await runner
    .prepare('SELECT current_quantity FROM inventory_products WHERE id = ?')
    .get(productId);
  const current = product ? Number(product.current_quantity) : 0;
  const total = Number(row.total);
  return {
    current_quantity: current,
    ledger_total: total,
    purchased: Number(row.purchased),
    consumed: Number(row.consumed),
    adjusted: Number(row.adjusted),
    movements: Number(row.movements),
    consistent: Math.abs(current - total) < 0.0005,
  };
}

/**
 * Escapes one CSV cell and neutralises spreadsheet formula injection.
 *
 * A cell starting with = + - @ TAB or CR is executed by Excel/Sheets on open, so
 * a product named "=cmd|..." would run on the operator's machine. Prefixing a
 * single quote makes it inert text.
 */
function csvCell(value) {
  let v = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Builds a CSV attachment, with the BOM Excel needs to read the Uzbek letters. */
function csvResponse(res, filename, header, body) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  const rows = [header, ...body].map((row) => row.map(csvCell).join(',')).join('\r\n');
  // Without the BOM Excel decodes UTF-8 as the local codepage and renders
  // "o'" / "g'" as mojibake.
  res.send('\ufeff' + rows);
}

function appNow() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/**
 * Upper bound on one bulk product request.
 *
 * The cap is not cosmetic. Each product in a bulk batch is validated, inserted,
 * given its opening movement and audited inside a single transaction that holds
 * one pooled connection; an unbounded batch could therefore hold a connection
 * long enough to starve the rest of the app. It also keeps the modal usable --
 * past a couple of dozen cards the form is a wall of inputs, not a form.
 */
const MAX_BULK_PRODUCTS = 20;

/**
 * Reads the opening stock out of a product payload.
 *
 * Two names mean the same thing and are normalised here rather than at each call
 * site: `initial_quantity` is what the bulk form sends (it says plainly that this
 * is the stock the product *starts* with), `current_quantity` is the historical
 * single-create field. They are never two independent quantities.
 *
 * A filter's opening stock must be a whole number, because half a filter is not
 * something that can later be consumed either -- the consumption endpoint already
 * refuses a fractional filter, and seeding one here would create stock that can
 * never be used.
 */
function parseOpening(input, type) {
  const raw =
    input.initial_quantity !== undefined && input.initial_quantity !== null && input.initial_quantity !== ''
      ? input.initial_quantity
      : input.current_quantity;
  if (raw === undefined || raw === null || raw === '') return 0;
  return parseQty(raw, "Boshlang'ich qoldiq", {
    allowZero: true,
    integer: type === 'filter',
  });
}

/**
 * Creates one product with its opening stock movement and its audit rows.
 *
 * MUST be called inside db.transaction(): the product row, the movement that
 * justifies its stock level and the audit trail have to become visible together
 * or not at all. Everything before the movement is optional (a product may start
 * empty), but a product with stock and no movement row would make the very first
 * reconciliation report a permanent discrepancy.
 *
 * The single-create endpoint and the bulk endpoint both call this, so the two
 * paths cannot drift apart: a validation rule or a ledger fix applied here lands
 * in both at once.
 *
 * @param {object} runner transaction scope -- never the pool
 * @param {object} input  one product payload
 * @param {object} [opts] `{ auditExtra }` merged into the `created` audit row
 * @returns {Promise<object>} the created product, plus `opening_movement_id`
 *   when stock was seeded.
 */
async function createProduct(runner, req, input, opts = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const clean = validateProduct(source);
  const opening = parseOpening(source, clean.type);

  const created = await runner
    .prepare(
      `INSERT INTO inventory_products
         (name, type, brand, viscosity, unit, package_size, current_quantity,
          minimum_quantity, cost_price, markup_amount, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       RETURNING ${PRODUCT_FIELDS}`
    )
    .one(
      clean.name,
      clean.type,
      clean.brand,
      clean.viscosity,
      clean.unit,
      clean.package_size,
      0,
      clean.minimum_quantity,
      clean.cost_price,
      clean.markup_amount
    );

  let openingMovementId = null;
  if (opening > 0) {
    const movement = await runner
      .prepare(
        `INSERT INTO inventory_movements
           (product_id, movement_type, quantity, before_quantity, after_quantity,
            reference_type, reference_id, admin_id, note)
         VALUES (?, 'purchase', ?, 0, ?, NULL, NULL, ?, ?)
         RETURNING id`
      )
      .one(created.id, opening, opening, req.user.id, "Boshlang'ich qoldiq");
    await runner
      .prepare('UPDATE inventory_products SET current_quantity = ? WHERE id = ?')
      .run(opening, created.id);
    created.current_quantity = opening;
    openingMovementId = movement.id;
  }

  await audit(runner, req, created.id, 'created', {
    ...snapshot(created),
    opening_quantity: opening,
    // The audit `action` column is a fixed CHECK enum, so a batch is recorded by
    // annotating each member rather than by inventing a new action that would
    // require a migration.
    ...(opts.auditExtra || {}),
  });

  return openingMovementId ? { ...created, opening_movement_id: openingMovementId } : created;
}

module.exports = {
  PRODUCT_FIELDS,
  MOVEMENT_FIELDS,
  movementFields,
  MOVEMENT_TYPES,
  PRODUCT_TYPES,
  UNITS,
  MAX_BULK_PRODUCTS,
  unitForType,
  unitLabel,
  badRequest,
  notFound,
  conflict,
  MAX_QTY,
  MAX_MONEY,
  parseQty,
  parseSignedQty,
  parseMoney,
  text,
  validateProduct,
  parseOpening,
  createProduct,
  audit,
  auditStandalone,
  snapshot,
  applyMovement,
  reconcile,
  csvCell,
  csvResponse,
  appNow,
};