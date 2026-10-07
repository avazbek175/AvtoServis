const express = require('express');
const { db } = require('../db');
const auth = require('../auth');
const inv = require('../inventory');

const router = require('../asyncRoute').wrapRouter(express.Router());

// Every warehouse endpoint requires a session. Stock levels and purchase costs
// are business data, so there is deliberately no public path and no
// unauthenticated branch anywhere in this file -- the same rule the debt ledger
// follows.
router.use(auth.authenticate);
router.use(auth.authorize('super_admin'));

const SORTS = {
  name: 'lower(p.name) ASC',
  newest: 'p.created_at DESC, p.id DESC',
  oldest: 'p.created_at ASC, p.id ASC',
  quantity: 'p.current_quantity DESC',
  price: 'p.cost_price DESC',
};

/**
 * Escapes a user-supplied LIKE term.
 *
 * Without this a search for `%` matches everything and `_` matches any single
 * character, so "100%" silently becomes a full scan and the admin gets results
 * they did not ask for. Every query that uses this must pair it with
 * `ESCAPE '\'`.
 */
function likeTerm(value) {
  return '%' + String(value == null ? '' : value).trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

function idParam(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Parses the list query string.
 *
 * `filter`, `sort` and `type` are whitelists rather than interpolated values, so
 * nothing a client sends can reach the SQL as more than a bound parameter.
 */
function listQuery(req) {
  const q = req.query || {};
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const perPage = Math.min(100, Math.max(5, Number(q.per_page) || 20));
  const filter = ['all', 'active', 'inactive', 'low', 'out'].includes(q.filter) ? q.filter : 'all';
  const sort = Object.prototype.hasOwnProperty.call(SORTS, q.sort) ? q.sort : 'name';
  const type = ['all', 'oil', 'filter'].includes(q.type) ? q.type : 'all';
  return {
    page,
    perPage,
    filter,
    sort,
    type,
    q: String(q.q || '').trim(),
    orderBy: SORTS[sort],
  };
}

/**
 * Validates a `YYYY-MM-DD` filter bound.
 *
 * The value is handed to PostgreSQL as `(? )::date`. An unvalidated string there
 * is a cast error, i.e. an opaque 500 for something the client got wrong, so the
 * shape is checked first and an unusable value is ignored rather than guessed at.
 */
function dateParam(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw inv.badRequest("Sana noto'g'ri formatda (masalan 2026-10-05)");
  }
  return v;
}

function productConditions({ filter, type, q }) {
  const conds = [];
  const params = [];
  if (filter === 'active') conds.push('p.is_active = 1');
  else if (filter === 'inactive') conds.push('p.is_active = 0');
  // "low" is below the minimum but still has stock; "out" is exactly empty. They
  // are separate so the admin can tell "reorder soon" from "cannot work today".
  else if (filter === 'low') conds.push('p.is_active = 1 AND p.current_quantity > 0 AND p.current_quantity <= p.minimum_quantity');
  else if (filter === 'out') conds.push('p.is_active = 1 AND p.current_quantity <= 0');

  if (type !== 'all') {
    conds.push('p.type = ?');
    params.push(type);
  }
  if (q) {
    conds.push("(p.name ILIKE ? ESCAPE '\\' OR p.brand ILIKE ? ESCAPE '\\' OR p.viscosity ILIKE ? ESCAPE '\\')");
    const like = likeTerm(q);
    params.push(like, like, like);
  }
  return { conds, params };
}

/** Decorative label the table renders instead of recomputing the rule. */
function stockState(product) {
  const current = Number(product.current_quantity);
  const minimum = Number(product.minimum_quantity);
  if (current <= 0) return 'out';
  if (current <= minimum) return 'low';
  return 'ok';
}

const STATE_UZ = { ok: 'Yetarli', low: 'Kam', out: 'Tugagan' };
const MOVEMENT_UZ = {
  purchase: 'Kirim',
  consumption: 'Sarf',
  adjustment: 'Tuzatish',
};
const REFERENCE_UZ = {
  work_log: 'Ish',
  manual: 'Qo\'lda',
  stocktake: 'Inventarizatsiya',
};

// Declared before the "/:id" patterns so the literal paths win.
router.get('/stats', async (req, res) => {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(current_quantity) FILTER (WHERE type = 'oil' AND is_active = 1), 0)    AS oil_total,
         COALESCE(SUM(current_quantity) FILTER (WHERE type = 'filter' AND is_active = 1), 0) AS filter_total,
         COALESCE(SUM(minimum_quantity) FILTER (WHERE type = 'oil' AND is_active = 1), 0)    AS oil_minimum,
         COALESCE(SUM(minimum_quantity) FILTER (WHERE type = 'filter' AND is_active = 1), 0) AS filter_minimum,
         COUNT(*) FILTER (WHERE type = 'oil' AND is_active = 1)                              AS oil_products,
         COUNT(*) FILTER (WHERE type = 'filter' AND is_active = 1)                           AS filter_products,
         COUNT(*) FILTER (WHERE is_active = 0)                                               AS inactive_products,
         COUNT(*) FILTER (WHERE is_active = 1 AND current_quantity <= 0)                      AS out_of_stock,
         COUNT(*) FILTER (WHERE is_active = 1 AND current_quantity > 0 AND current_quantity <= minimum_quantity) AS low_stock,
         COALESCE(SUM(current_quantity * cost_price) FILTER (WHERE type = 'oil' AND is_active = 1), 0)    AS oil_value,
         COALESCE(SUM(current_quantity * cost_price) FILTER (WHERE type = 'filter' AND is_active = 1), 0) AS filter_value
       FROM inventory_products`
    )
    .get();

  // Totals come from the movement ledger, not from current_quantity, so "how much
  // has passed through this warehouse" is a fact about history rather than a
  // guess based on today's stock.
  const used = await db
    .prepare(
      `SELECT
         COALESCE(-SUM(m.quantity) FILTER (WHERE p.type = 'oil' AND m.movement_type = 'consumption'), 0)    AS oil_consumed,
         COALESCE(-SUM(m.quantity) FILTER (WHERE p.type = 'filter' AND m.movement_type = 'consumption'), 0) AS filter_consumed,
         COALESCE(SUM(m.quantity) FILTER (WHERE p.type = 'oil' AND m.movement_type = 'purchase'), 0)    AS oil_purchased,
         COALESCE(SUM(m.quantity) FILTER (WHERE p.type = 'filter' AND m.movement_type = 'purchase'), 0) AS filter_purchased,
         COALESCE(SUM(m.quantity) FILTER (WHERE p.type = 'oil' AND m.movement_type = 'adjustment'), 0)    AS oil_adjusted,
         COALESCE(SUM(m.quantity) FILTER (WHERE p.type = 'filter' AND m.movement_type = 'adjustment'), 0) AS filter_adjusted
       FROM inventory_movements m JOIN inventory_products p ON p.id = m.product_id`
    )
    .get();

  const lowStock = await db
    .prepare(
      `SELECT id, name, type, brand, viscosity, unit, current_quantity, minimum_quantity
         FROM inventory_products
        WHERE is_active = 1 AND current_quantity <= minimum_quantity
        ORDER BY (current_quantity - minimum_quantity) ASC, name ASC
        LIMIT 20`
    )
    .all();

  const recent = await db
    .prepare(
      `SELECT ${inv.movementFields('m')}, p.name AS product_name, p.type AS product_type, p.unit
         FROM inventory_movements m JOIN inventory_products p ON p.id = m.product_id
        ORDER BY m.created_at DESC, m.id DESC LIMIT 10`
    )
    .all();

  res.json({
    stats: {
      oilTotal: Number(row.oil_total),
      oilConsumed: Number(used.oil_consumed),
      oilPurchased: Number(used.oil_purchased),
      oilAdjusted: Number(used.oil_adjusted),
      oilValue: Number(row.oil_value),
      filterTotal: Number(row.filter_total),
      filterConsumed: Number(used.filter_consumed),
      filterPurchased: Number(used.filter_purchased),
      filterAdjusted: Number(used.filter_adjusted),
      filterValue: Number(row.filter_value),
      oilProducts: Number(row.oil_products),
      filterProducts: Number(row.filter_products),
      inactiveProducts: Number(row.inactive_products),
      outOfStock: Number(row.out_of_stock),
      lowStock: Number(row.low_stock),
      oilMinimum: Number(row.oil_minimum),
      filterMinimum: Number(row.filter_minimum),
    },
    low_stock: lowStock.map((p) => ({ ...p, state: stockState(p) })),
    recent_movements: recent,
  });
});

router.get('/low-stock', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT ${inv.PRODUCT_FIELDS}
         FROM inventory_products p
        WHERE is_active = 1 AND current_quantity <= minimum_quantity
        ORDER BY (current_quantity - minimum_quantity) ASC, name ASC`
    )
    .all();
  res.json({ products: rows.map((p) => ({ ...p, state: stockState(p) })) });
});

router.get('/export.csv', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT ${inv.PRODUCT_FIELDS} FROM inventory_products p ORDER BY p.type, lower(p.name)`
    )
    .all();
  inv.csvResponse(
    res,
    `ombor-${inv.appNow()}.csv`,
    ['Mahsulot', 'Turi', 'Brend', 'Viskozitet', 'Birlik', 'Qadoq', 'Qoldiq', 'Minimal',
      'Summa', 'Ustama', 'Sotuv narxi', 'Holat'],
    rows.map((p) => [
      p.name,
      p.type === 'oil' ? 'Moy' : 'Filtr',
      p.brand,
      p.viscosity,
      p.unit === 'liter' ? 'liter' : 'dona',
      Number(p.package_size),
      Number(p.current_quantity),
      Number(p.minimum_quantity),
      Number(p.cost_price),
      Number(p.markup_amount),
      Number(p.sale_price),
      Number(p.is_active) ? STATE_UZ[stockState(p)] : 'Arxiv',
    ])
  );
});

router.get('/movements/export.csv', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT ${inv.movementFields('m')}, p.name AS product_name, p.type AS product_type, p.unit, u.full_name AS admin_name
         FROM inventory_movements m
         JOIN inventory_products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.admin_id
        ORDER BY m.created_at DESC, m.id DESC`
    )
    .all();
  inv.csvResponse(
    res,
    `harakatlar-${inv.appNow()}.csv`,
    ['Sana', 'Mahsulot', 'Turi', 'Harakat', 'Miqdor', 'Oldingi', 'Keyingi', 'Admin', 'Izoh', 'Manba'],
    rows.map((m) => [
      m.created_at,
      m.product_name,
      m.product_type === 'oil' ? 'Moy' : 'Filtr',
      MOVEMENT_UZ[m.movement_type] || m.movement_type,
      Number(m.quantity),
      Number(m.before_quantity),
      Number(m.after_quantity),
      m.admin_name || '',
      m.note,
      m.reference_type ? REFERENCE_UZ[m.reference_type] || m.reference_type : '',
    ])
  );
});

router.get('/movements', async (req, res) => {
  const q = req.query || {};
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const perPage = Math.min(100, Math.max(5, Number(q.per_page) || 20));
  const conds = [];
  const params = [];
  // Two independent axes: what kind of product moved, and what kind of move it
  // was. Filtering on both at once is what makes "only oil purchases in October"
  // answerable from the history screen.
  const productType = ['oil', 'filter'].includes(q.type) ? String(q.type) : '';
  if (productType) {
    conds.push('p.type = ?');
    params.push(productType);
  }
  const movementType = ['purchase', 'consumption', 'adjustment'].includes(String(q.movement_type || ''))
    ? String(q.movement_type)
    : '';
  if (movementType) {
    conds.push('m.movement_type = ?');
    params.push(movementType);
  }
  if (idParam(q.product_id)) {
    conds.push('m.product_id = ?');
    params.push(idParam(q.product_id));
  }
  const dateFrom = dateParam(q.date_from);
  if (dateFrom) {
    conds.push('(m.created_at)::date >= (? )::date');
    params.push(dateFrom);
  }
  const dateTo = dateParam(q.date_to);
  if (dateTo) {
    conds.push('(m.created_at)::date <= (? )::date');
    params.push(dateTo);
  }
  if (String(q.q || '').trim()) {
    conds.push("(p.name ILIKE ? ESCAPE '\\' OR p.brand ILIKE ? ESCAPE '\\' OR m.note ILIKE ? ESCAPE '\\')");
    const like = likeTerm(q.q);
    params.push(like, like, like);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = Number(
    (
      await db
        .prepare(`SELECT COUNT(*) AS c FROM inventory_movements m JOIN inventory_products p ON p.id = m.product_id ${where}`)
        .get(params)
    ).c
  );
  const rows = await db
    .prepare(
      `SELECT ${inv.movementFields('m')}, p.name AS product_name, p.type AS product_type, p.unit, u.full_name AS admin_name
         FROM inventory_movements m
         JOIN inventory_products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.admin_id
         ${where}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(params.concat([perPage, (page - 1) * perPage]));

  res.json({
    movements: rows.map((m) => ({
      ...m,
      movement_label: MOVEMENT_UZ[m.movement_type] || m.movement_type,
      reference_label: m.reference_type ? REFERENCE_UZ[m.reference_type] || m.reference_type : '',
    })),
    pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
  });
});

router.get('/products', async (req, res) => {
  const opts = listQuery(req);
  const { conds, params } = productConditions(opts);
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM inventory_products p ${where}`).get(params)).c);
  const rows = await db
    .prepare(
      `SELECT ${inv.PRODUCT_FIELDS} FROM inventory_products p ${where}
        ORDER BY ${opts.orderBy} LIMIT ? OFFSET ?`
    )
    .all(params.concat([opts.perPage, (opts.page - 1) * opts.perPage]));
  res.json({
    products: rows.map((p) => ({ ...p, state: stockState(p), state_label: STATE_UZ[stockState(p)] })),
    pagination: {
      page: opts.page,
      per_page: opts.perPage,
      total,
      pages: Math.max(1, Math.ceil(total / opts.perPage)),
    },
  });
});

router.get('/products/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const product = id
    ? await db.prepare(`SELECT ${inv.PRODUCT_FIELDS} FROM inventory_products p WHERE id = ?`).get(id)
    : null;
  if (!product) return res.status(404).json({ error: 'Mahsulot topilmadi' });

  const movements = await db
    .prepare(
      `SELECT ${inv.movementFields('m')}, u.full_name AS admin_name
         FROM inventory_movements m LEFT JOIN users u ON u.id = m.admin_id
        WHERE m.product_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 200`
    )
    .all(product.id);
  const audits = await db
    .prepare(
      `SELECT id, action, admin_id, admin_name, metadata, created_at
         FROM inventory_audit_logs WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`
    )
    .all(product.id);
  const materials = await db
    .prepare(
      `SELECT sm.id, sm.work_log_id, sm.product_id, sm.quantity, w.title, w.customer_name, w.service_type
         FROM service_materials sm JOIN work_logs w ON w.id = sm.work_log_id
        WHERE sm.product_id = ? ORDER BY sm.id DESC LIMIT 100`
    )
    .all(product.id);

  // Independent recomputation from the movement ledger. `consistent` is false
  // if the stored level ever drifts from the history that produced it.
  const totals = await inv.reconcile(db, product.id);

  res.json({
    product: { ...product, state: stockState(product), state_label: STATE_UZ[stockState(product)] },
    totals,
    movements: movements.map((m) => ({
      ...m,
      movement_label: MOVEMENT_UZ[m.movement_type] || m.movement_type,
    })),
    service_materials: materials,
    audit_logs: audits,
  });
});

router.post('/products', async (req, res) => {
  const product = await db.transaction((t) => inv.createProduct(t, req, req.body || {}));
  const { opening_movement_id, ...created } = product;
  res.status(201).json({
    product: { ...created, state: stockState(created), state_label: STATE_UZ[stockState(created)] },
  });
});

/**
 * Bulk product creation: one request, one transaction, all products or none.
 *
 * Stocking a warehouse is normally done as a batch -- the supplier hands over
 * eight SKUs, not one -- so the single-create path was being used as an
 * eight-request loop from the UI. That loop has two failure modes a single
 * request does not: a rejected product in the middle leaves the earlier ones
 * saved (the operator then has to work out which half arrived), and the browser
 * can fire the requests concurrently, so two of them can race on the same
 * stock figures.
 *
 * Here every product is validated, inserted, given its opening movement and
 * audited inside ONE transaction. The first invalid product throws, which rolls
 * back the products already inserted in the same transaction, so a partial batch
 * cannot exist: either all of them are in the warehouse or none of them are.
 *
 * Duplicates are deliberately allowed. `inventory_products` has no unique
 * constraint on the name, and adding one would be a behaviour change the existing
 * data cannot satisfy -- the same brand and viscosity can legitimately be stocked
 * from two suppliers at different package sizes. So a repeated product in one
 * batch is saved twice, exactly as two separate single-create calls would.
 *
 * Declared before the "/products/:id/..." patterns, and those patterns do not
 * collide with it anyway ("/products/bulk" is two segments, "/products/:id/..." is
 * three), so the literal path is unambiguous.
 */
router.post('/products/bulk', async (req, res) => {
  const items = (req.body || {}).products;
  if (!Array.isArray(items)) {
    throw inv.badRequest("'products' massivi talab qilinadi");
  }
  if (items.length === 0) {
    throw inv.badRequest('Kamida bitta mahsulot kiritilishi kerak');
  }
  if (items.length > inv.MAX_BULK_PRODUCTS) {
    throw inv.badRequest(
      `Bir vaqtda ko'pi bilan ${inv.MAX_BULK_PRODUCTS} ta mahsulot qo'shish mumkin (hozir: ${items.length})`
    );
  }

  const created = await db.transaction(async (t) => {
    const rows = [];
    for (let i = 0; i < items.length; i++) {
      try {
        rows.push(
          await inv.createProduct(t, req, items[i], {
            auditExtra: { batch_size: items.length, batch_position: i + 1 },
          })
        );
      } catch (err) {
        // Re-thrown with the position of the offending card. The operator has to
        // know WHICH of the eight cards was wrong; "Viskozitet majburiy" on its
        // own would send them looking through all eight. The original status is
        // preserved so a conflict or a missing row never silently degrades to 400.
        const wrapped = new Error(`${i + 1}-mahsulot: ${err.message}`);
        wrapped.status = err.status || 400;
        throw wrapped;
      }
    }
    return rows;
  });

  res.status(201).json({
    count: created.length,
    products: created.map((row) => {
      const { opening_movement_id, ...product } = row;
      return { ...product, state: stockState(product), state_label: STATE_UZ[stockState(product)] };
    }),
  });
});

router.patch('/products/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const existing = id
    ? await db.prepare(`SELECT ${inv.PRODUCT_FIELDS} FROM inventory_products WHERE id = ?`).get(id)
    : null;
  if (!existing) return res.status(404).json({ error: 'Mahsulot topilmadi' });

  const body = req.body || {};
  // Validate the merged row, not the patch. Validating only the patch would let
  // `type` change to oil while viscosity stayed empty, which the database CHECK
  // would then reject as an opaque 500 instead of a readable 400.
  //
  // `unit` is deliberately NOT inherited from the existing row. It is derived
  // from the merged type, so switching oil -> filter re-derives "dona" instead
  // of rejecting the request for contradicting the litre it used to be. Only a
  // unit the client actually sent is passed through, so an explicit contradiction
  // is still reported rather than silently overwritten.
  const mergedType = body.type !== undefined ? body.type : existing.type;
  const clean = inv.validateProduct({
    name: body.name !== undefined ? body.name : existing.name,
    type: mergedType,
    brand: body.brand !== undefined ? body.brand : existing.brand,
    viscosity: body.viscosity !== undefined ? body.viscosity : existing.viscosity,
    unit: body.unit,
    package_size: body.package_size !== undefined ? body.package_size : existing.package_size,
    minimum_quantity: body.minimum_quantity !== undefined ? body.minimum_quantity : existing.minimum_quantity,
    cost_price: body.cost_price !== undefined ? body.cost_price : existing.cost_price,
    markup_amount: body.markup_amount !== undefined ? body.markup_amount : existing.markup_amount,
  });

  const isActive =
    body.is_active === undefined
      ? Number(existing.is_active)
      : body.is_active
        ? 1
        : 0;

  // current_quantity is deliberately not editable here: changing stock without a
  // movement row would leave the ledger permanently inconsistent.
  if (body.current_quantity !== undefined) {
    const requested = Number(body.current_quantity);
    if (requested !== Number(existing.current_quantity)) {
      throw inv.badRequest(
        'Qoldiqni to\'g\'ridan-to\'g\'ri o\'zgartirib bo\'lmaydi. Omborga qo\'shish, sarf yoki tuzatishdan foydalaning.'
      );
    }
  }

  const updated = await db.transaction(async (t) => {
    const row = await t
      .prepare(
        `UPDATE inventory_products
            SET name = ?, type = ?, brand = ?, viscosity = ?, unit = ?, package_size = ?,
                minimum_quantity = ?, cost_price = ?, markup_amount = ?, is_active = ?,
                updated_at = app_now()
          WHERE id = ?
        RETURNING ${inv.PRODUCT_FIELDS}`
      )
      .one(
        clean.name,
        clean.type,
        clean.brand,
        clean.viscosity,
        clean.unit,
        clean.package_size,
        clean.minimum_quantity,
        clean.cost_price,
        clean.markup_amount,
        isActive,
        id
      );
    await inv.audit(t, req, id, 'updated', {
      before: inv.snapshot(existing),
      after: inv.snapshot(row),
    });
    if (Number(existing.is_active) !== isActive) {
      await inv.audit(t, req, id, isActive ? 'activated' : 'deactivated', inv.snapshot(row));
    }
    return row;
  });

  res.json({ product: { ...updated, state: stockState(updated), state_label: STATE_UZ[stockState(updated)] } });
});

/**
 * Hard delete is refused as soon as the product has any history.
 *
 * A movement row or a service-material row is a permanent statement about what
 * left the warehouse. Deleting the product would either orphan that history or
 * require cascading it away, and either way the audit trail stops matching
 * reality. The supported alternative is deactivation (`is_active = false`),
 * which hides the product from the pickers but keeps every figure intact.
 */
router.delete('/products/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const existing = id
    ? await db.prepare(`SELECT ${inv.PRODUCT_FIELDS} FROM inventory_products WHERE id = ?`).get(id)
    : null;
  if (!existing) return res.status(404).json({ error: 'Mahsulot topilmadi' });

  const movements = await db
    .prepare('SELECT COUNT(*) AS c FROM inventory_movements WHERE product_id = ?')
    .get(id);
  const materials = await db
    .prepare('SELECT COUNT(*) AS c FROM service_materials WHERE product_id = ?')
    .get(id);

  if (Number(movements.c) > 0 || Number(materials.c) > 0) {
    await inv.auditStandalone(req, id, 'delete_denied', {
      movements: Number(movements.c),
      service_materials: Number(materials.c),
      reason: 'Mahsulot harakati mavjud',
    });
    throw inv.conflict(
      "Bu mahsulotning ombor harakati mavjud, shuning uchun o'chirib bo'lmaydi. Uni arxivlang (aktiv/deaktiv)."
    );
  }

  await inv.auditStandalone(req, id, 'delete_requested', inv.snapshot(existing));
  await db.transaction(async (t) => {
    await t.prepare('DELETE FROM inventory_products WHERE id = ?').run(id);
    await inv.audit(t, req, id, 'deleted', inv.snapshot(existing));
  });
  res.json({ ok: true });
});

router.post('/products/:id/stock-in', async (req, res) => {
  const id = idParam(req.params.id);
  const body = req.body || {};
  const product = id
    ? await db.prepare(`SELECT ${inv.PRODUCT_FIELDS} FROM inventory_products WHERE id = ?`).get(id)
    : null;
  if (!product) return res.status(404).json({ error: 'Mahsulot topilmadi' });

  const quantity = inv.parseQty(body.quantity, 'Qo\'shiladigan miqdor', {
    integer: product.type === 'filter',
  });
  const note = inv.text(body.note, 'Izoh', { max: 500 });
  const supplier = inv.text(body.supplier, 'Yetkazib beruvchi', { max: 150 });
  const fullNote = supplier ? `${note}${note ? ' | ' : ''}Yetkazib beruvchi: ${supplier}` : note;

  const { product: updated, movement } = await db.transaction((t) =>
    inv.applyMovement(t, {
      productId: id,
      movementType: 'purchase',
      quantity,
      req,
      note: fullNote,
      referenceType: 'manual',
    })
  );
  res.status(201).json({
    product: { ...updated, state: stockState(updated), state_label: STATE_UZ[stockState(updated)] },
    movement: { ...movement, movement_label: MOVEMENT_UZ[movement.movement_type] },
  });
});

router.post('/products/:id/consume', async (req, res) => {
  const id = idParam(req.params.id);
  const body = req.body || {};
  const product = id
    ? await db.prepare(`SELECT ${inv.PRODUCT_FIELDS} FROM inventory_products WHERE id = ?`).get(id)
    : null;
  if (!product) return res.status(404).json({ error: 'Mahsulot topilmadi' });

  const quantity = inv.parseQty(body.quantity, 'Sarflanadigan miqdor', {
    integer: product.type === 'filter',
  });
  const note = inv.text(body.note, 'Sabab', { max: 500 });

  const { product: updated, movement } = await db.transaction((t) =>
    inv.applyMovement(t, {
      productId: id,
      movementType: 'consumption',
      quantity,
      req,
      note,
      referenceType: 'manual',
    })
  );
  res.status(201).json({
    product: { ...updated, state: stockState(updated), state_label: STATE_UZ[stockState(updated)] },
    movement: { ...movement, movement_label: MOVEMENT_UZ[movement.movement_type] },
  });
});

/**
 * Stock take.
 *
 * Accepts either a signed `quantity` (how much the real shelf differs) or an
 * absolute `current_quantity` (what is actually there). Both are recorded as one
 * adjustment movement with a mandatory reason, and in neither case is
 * current_quantity written directly.
 */
router.post('/products/:id/adjust', async (req, res) => {
  const id = idParam(req.params.id);
  const body = req.body || {};
  const product = id
    ? await db.prepare(`SELECT ${inv.PRODUCT_FIELDS} FROM inventory_products WHERE id = ?`).get(id)
    : null;
  if (!product) return res.status(404).json({ error: 'Mahsulot topilmadi' });

  // A reason is mandatory: an unexplained correction is indistinguishable from a
  // mistake, and it is the only clue available when the books do not add up.
  const reason = inv.text(body.reason, 'Tuzatish sababi', { required: true, max: 300 });
  const hasAbsolute =
    body.current_quantity !== undefined && body.current_quantity !== null && body.current_quantity !== '';
  const integer = product.type === 'filter';

  const opts = {
    productId: id,
    movementType: 'adjustment',
    req,
    note: reason,
    referenceType: 'stocktake',
  };
  if (hasAbsolute) {
    opts.absoluteTarget = inv.parseQty(body.current_quantity, 'Haqiqiy qoldiq', {
      integer,
      allowZero: true,
    });
  } else {
    opts.quantity = inv.parseSignedQty(body.quantity, 'Farq', { integer });
  }

  const { product: updated, movement } = await db.transaction((t) => inv.applyMovement(t, opts));
  res.status(201).json({
    product: { ...updated, state: stockState(updated), state_label: STATE_UZ[stockState(updated)] },
    movement: { ...movement, movement_label: MOVEMENT_UZ[movement.movement_type] },
  });
});

module.exports = { router, stockState, STATE_UZ, MOVEMENT_UZ };