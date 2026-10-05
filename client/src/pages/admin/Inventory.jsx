import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import Icon from '../../components/icons';
import { Loading, Alert, Badge, Modal, Toggle } from '../../components/ui';
import {
  MAX_PRODUCTS,
  addDraft as addDraftTo,
  canAdd,
  canRemove,
  clearFieldError,
  draftPayload,
  firstInvalidIndex,
  focusFromServerMessage,
  newDrafts,
  removeDraft as removeDraftFrom,
  switchType,
  updateDraft,
  validateDrafts,
} from './inventoryDrafts';

/**
 * Oil and filter warehouse.
 *
 * Stock is never edited directly in this UI: it only moves through "Omborga
 * qo'shish", "Sarf" and "Tuzatish", each of which writes a movement row. That
 * is why there is no plain quantity field on the edit form -- the server would
 * reject it, and a control that cannot work is worse than no control.
 */

const TYPE_META = {
  oil: { label: 'Moy', icon: 'oil' },
  filter: { label: 'Filtr', icon: 'box' },
};

const STATE_META = {
  ok: { label: 'Yetarli', badge: 'success' },
  low: { label: 'Kam', badge: 'warn' },
  out: { label: 'Tugagan', badge: 'danger' },
};

const MOVEMENT_META = {
  purchase: { label: 'Kirim', badge: 'success' },
  consumption: { label: 'Sarf', badge: 'danger' },
  adjustment: { label: 'Tuzatish', badge: 'warn' },
};

const FILTERS = [
  { key: 'all', label: 'Barchasi' },
  { key: 'active', label: 'Faol' },
  { key: 'low', label: 'Kam qolgan' },
  { key: 'out', label: 'Tugagan' },
  { key: 'inactive', label: 'Arxiv' },
];

const SORTS = [
  { key: 'name', label: 'Nomi (A-Z)' },
  { key: 'newest', label: 'Eng yangi' },
  { key: 'quantity', label: 'Eng ko\'p qoldiq' },
  { key: 'price', label: 'Eng qimmat narx' },
];

const PER_PAGE = 20;

// Uzbek decimal separator, so 23.5 L reads as "23,5 L" for the operator.
function qty(n) {
  return Number(n || 0).toLocaleString('uz-UZ', { maximumFractionDigits: 3 });
}

function unitLabel(u) {
  return u === 'liter' ? 'L' : 'dona';
}

function withUnit(n, u) {
  return `${qty(n)} ${unitLabel(u)}`;
}

function money(n) {
  return `${Number(n || 0).toLocaleString('ru-RU').replace(/,/g, ' ')} so'm`;
}

/** Signed delta for the movement history, e.g. "+4,5 L" / "-1 L". */
function signed(n, u) {
  const v = Number(n || 0);
  return `${v > 0 ? '+' : ''}${qty(v)} ${unitLabel(u)}`;
}

function productLabel(p) {
  if (!p) return '';
  const parts = [p.name];
  if (p.type === 'oil' && p.viscosity) parts.push(p.viscosity);
  else if (p.brand) parts.push(p.brand);
  return parts.filter(Boolean).join(' · ');
}

const EMPTY_FORM = {
  name: '', type: 'oil', brand: '', viscosity: '', unit: 'liter',
  package_size: '', minimum_quantity: '', cost_price: '', current_quantity: '',
};

/**
 * The single-product form (`EMPTY_FORM`) is kept exactly as it was.
 *
 * The batch form lives in `inventoryDrafts.js` alongside its card, because the rules
 * worth testing -- what happens when a card in the middle is removed, what happens
 * at the cap, which card an error belongs to -- are array and string logic, and
 * burying them in a JSX component makes them untestable without a browser. The
 * component itself is `BulkProductModal` at the bottom of this file.
 */

export default function Inventory() {
  const [stats, setStats] = useState(null);
  const [products, setProducts] = useState([]);
  const [page, setPage] = useState({ page: 1, per_page: PER_PAGE, total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('products');

  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [type, setType] = useState('all');
  const [sort, setSort] = useState('name');
  const [currentPage, setCurrentPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [stockFor, setStockFor] = useState(null);
  const [consumeFor, setConsumeFor] = useState(null);
  const [adjustFor, setAdjustFor] = useState(null);
  const [detailFor, setDetailFor] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ filter, type, sort, page: String(currentPage), per_page: String(PER_PAGE) });
      if (search) params.set('q', search);
      const [s, list] = await Promise.all([
        api.get('/admin/inventory/stats'),
        api.get(`/admin/inventory/products?${params.toString()}`),
      ]);
      setStats(s.stats);
      setProducts(list.products || []);
      setPage(list.pagination || { page: currentPage, per_page: PER_PAGE, total: 0, pages: 1 });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filter, type, sort, currentPage, search]);

  useEffect(() => {
    load();
  }, [load]);

  // Debounce so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q.trim());
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const afterChange = async (message) => {
    setNotice(message);
    await load();
  };

  // Success feedback fades on its own; errors stay until the next action so a
  // rejection the operator must react to is never missed.
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const cards = useMemo(() => {
    if (!stats) return [];
    return [
      { label: 'Jami moy', value: withUnit(stats.oilPurchased, 'liter'), icon: 'oil', color: 'bg-sky-500' },
      { label: 'Ishlatilgan moy', value: withUnit(stats.oilConsumed, 'liter'), icon: 'oil', color: 'bg-red-500' },
      { label: 'Qolgan moy', value: withUnit(stats.oilTotal, 'liter'), icon: 'oil', color: 'bg-[rgb(var(--c-primary))]' },
      { label: 'Jami filtr', value: withUnit(stats.filterPurchased, 'piece'), icon: 'box', color: 'bg-sky-500' },
      { label: 'Ishlatilgan filtr', value: withUnit(stats.filterConsumed, 'piece'), icon: 'trash', color: 'bg-amber-500' },
      { label: 'Qolgan filtr', value: withUnit(stats.filterTotal, 'piece'), icon: 'box', color: 'bg-emerald-500' },
    ];
  }, [stats]);

  const lowStock = stats ? stats.lowStock || [] : [];
  const recent = stats ? stats.recent_movements || [] : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Moy va filtrlar ombori</h1>
          <p className="mt-1 text-sm text-white/50">
            Kirim, sarf va qoldiq. Barcha ma'lumotlar PostgreSQL'da saqlanadi.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <CsvButton url="/admin/inventory/export.csv" filename="ombor.csv" label="Ombor CSV" />
          <CsvButton url="/admin/inventory/movements/export.csv" filename="harakatlar.csv" label="Harakatlar CSV" />
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
            className="btn-primary flex items-center gap-2 !py-2.5 text-sm"
          >
            <Icon name="pluss" size={16} /> Mahsulot qo'shish
          </button>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      {notice && (
        <div className="fixed bottom-5 right-5 z-[60] max-w-sm animate-fade-in">
          <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-[#111725] px-4 py-3 shadow-2xl">
            <Icon name="check" size={18} className="mt-0.5 shrink-0 text-emerald-300" />
            <span className="text-sm text-white/85">{notice}</span>
            <button type="button" onClick={() => setNotice('')} className="ml-1 shrink-0 text-white/40 hover:text-white" aria-label="Yopish">
              <Icon name="close" size={15} />
            </button>
          </div>
        </div>
      )}

      {/* ---------------- Stat cards ---------------- */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {loading && !stats
          ? [0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="card p-5">
                <div className="h-8 w-28 animate-pulse rounded bg-white/10" />
                <div className="mt-2 h-3 w-20 animate-pulse rounded bg-white/5" />
              </div>
            ))
          : cards.map((c) => (
              <div key={c.label} className="card p-5">
                <div className="flex items-center gap-4">
                  <span className={`flex h-12 w-12 items-center justify-center rounded-xl text-white shadow-lg ${c.color}`}>
                    <Icon name={c.icon} size={22} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-xl font-extrabold tracking-tight">{c.value}</div>
                    <div className="text-xs text-white/50">{c.label}</div>
                  </div>
                </div>
              </div>
            ))}
      </div>

      {/* ---------------- Low stock ---------------- */}
      {lowStock.length > 0 && (
        <div className="card p-5">
          <div className="flex items-center gap-2">
            <Icon name="clock" size={18} className="text-amber-300" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-white/70">Kam qolgan mahsulotlar</h2>
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300">
              {lowStock.length}
            </span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {lowStock.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm text-white/80">{productLabel(p)}</span>
                <span className="shrink-0 text-xs font-semibold text-amber-300">
                  {withUnit(p.current_quantity, p.unit)} qoldi, min {withUnit(p.minimum_quantity, p.unit)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- Recent movements ---------------- */}
      {recent.length > 0 && (
        <div className="card p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Icon name="clock" size={18} className="text-white/40" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-white/70">Oxirgi harakatlar</h2>
            </div>
            <button
              type="button"
              onClick={() => setTab('movements')}
              className="btn-outline !py-1.5 text-xs"
            >
              Barchasi
            </button>
          </div>
          <div className="divide-y divide-white/5">
            {recent.map((m) => (
              <MovementRow key={m.id} m={m} compact />
            ))}
          </div>
        </div>
      )}

      {/* ---------------- Tabs ---------------- */}
      <div className="flex gap-2 border-b border-white/10">
        {[
          { key: 'products', label: 'Mahsulotlar', icon: 'dashboard' },
          { key: 'movements', label: 'Harakatlar tarixi', icon: 'clock' },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
              tab === t.key
                ? 'border-[rgb(var(--c-primary))] text-white'
                : 'border-transparent text-white/50 hover:text-white/80'
            }`}
          >
            <Icon name={t.icon} size={16} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'products' ? (
        <>
          {/* ---------------- Toolbar ---------------- */}
          <div className="card p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[200px] flex-1">
                <label className="label">Qidirish</label>
                <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, brend yoki viskozitet" />
              </div>
              <div>
                <label className="label">Turi</label>
                <select className="field" value={type} onChange={(e) => { setType(e.target.value); setCurrentPage(1); }}>
                  <option value="all" className="bg-[#111725]">Barchasi</option>
                  <option value="oil" className="bg-[#111725]">Moy</option>
                  <option value="filter" className="bg-[#111725]">Filtr</option>
                </select>
              </div>
              <div>
                <label className="label">Holat</label>
                <select className="field" value={filter} onChange={(e) => { setFilter(e.target.value); setCurrentPage(1); }}>
                  {FILTERS.map((f) => (
                    <option key={f.key} value={f.key} className="bg-[#111725]">{f.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Saralash</label>
                <select className="field" value={sort} onChange={(e) => { setSort(e.target.value); setCurrentPage(1); }}>
                  {SORTS.map((s) => (
                    <option key={s.key} value={s.key} className="bg-[#111725]">{s.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {loading && !products.length ? (
            <Loading label="Ombor yuklanmoqda..." />
          ) : products.length === 0 ? (
            <div className="card p-10 text-center">
              <Icon name="box" size={32} className="mx-auto mb-3 text-white/30" />
              <p className="text-white/60">Mahsulot topilmadi</p>
              <p className="mt-1 text-xs text-white/35">Birinchi moy yoki filtrni qo'shing.</p>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="card hidden overflow-hidden lg:block">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/45">
                        <th className="px-4 py-3 font-semibold">Mahsulot</th>
                        <th className="px-4 py-3 font-semibold">Turi</th>
                        <th className="px-4 py-3 font-semibold">Brend</th>
                        <th className="px-4 py-3 font-semibold">Viskozitet</th>
                        <th className="px-4 py-3 text-right font-semibold">Qoldiq</th>
                        <th className="px-4 py-3 text-right font-semibold">Minimal</th>
                        <th className="px-4 py-3 font-semibold">Holat</th>
                        <th className="px-4 py-3 text-right font-semibold">Narx</th>
                        <th className="px-4 py-3 font-semibold">Amal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((p) => (
                        <ProductRow
                          key={p.id}
                          product={p}
                          onOpen={() => setDetailFor(p)}
                          onEdit={() => {
                            setEditing(p);
                            setFormOpen(true);
                          }}
                          onStock={() => setStockFor(p)}
                          onConsume={() => setConsumeFor(p)}
                          onAdjust={() => setAdjustFor(p)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mobile cards */}
              <div className="space-y-3 lg:hidden">
                {products.map((p) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    onOpen={() => setDetailFor(p)}
                    onEdit={() => {
                      setEditing(p);
                      setFormOpen(true);
                    }}
                    onStock={() => setStockFor(p)}
                    onConsume={() => setConsumeFor(p)}
                    onAdjust={() => setAdjustFor(p)}
                  />
                ))}
              </div>

              {page.pages > 1 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/45">
                    {page.total} ta mahsulot · {page.page} / {page.pages} sahifa
                  </span>
                  <div className="flex gap-2">
                    <button type="button" className="btn-outline !py-2 text-sm" disabled={currentPage <= 1} onClick={() => setCurrentPage(currentPage - 1)}>Oldingi</button>
                    <button type="button" className="btn-outline !py-2 text-sm" disabled={currentPage >= page.pages} onClick={() => setCurrentPage(currentPage + 1)}>Keyingi</button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <MovementHistory onChanged={load} />
      )}

      <ProductFormModal
        open={formOpen}
        product={editing}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSaved={async (created, count) => {
          setFormOpen(false);
          setEditing(null);
          if (created && count > 1) return afterChange(`${count} ta mahsulot muvaffaqiyatli qo'shildi.`);
          return afterChange(created ? 'Mahsulot omborga qo\'shildi.' : 'Mahsulot yangilandi.');
        }}
      />
      <StockInModal product={stockFor} onClose={() => setStockFor(null)} onSaved={() => { setStockFor(null); return afterChange('Omborga qo\'shildi.'); }} />
      <ConsumeModal product={consumeFor} onClose={() => setConsumeFor(null)} onSaved={() => { setConsumeFor(null); return afterChange('Sarf qilindi.'); }} />
      <AdjustModal product={adjustFor} onClose={() => setAdjustFor(null)} onSaved={() => { setAdjustFor(null); return afterChange('Qoldiq tuzatildi.'); }} />
      <ProductDetailModal product={detailFor} onClose={() => setDetailFor(null)} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                               */
/* ------------------------------------------------------------------ */

function statusBadge(product) {
  if (!Number(product.is_active)) return <Badge kind="default">Arxiv</Badge>;
  const meta = STATE_META[product.state] || STATE_META.ok;
  return <Badge kind={meta.badge}>{meta.label}</Badge>;
}

function ProductRow({ product, onOpen, onEdit, onStock, onConsume, onAdjust }) {
  const live = Number(product.is_active) === 1;
  return (
    <tr className={`border-b border-white/5 transition hover:bg-white/[0.03] ${live ? '' : 'opacity-60'}`}>
      <td className="px-4 py-3">
        <button type="button" onClick={onOpen} className="text-left font-semibold text-white hover:text-[rgb(var(--c-primary))]">
          {product.name}
        </button>
        {Number(product.package_size) > 1 && (
          <div className="text-xs text-white/40">{qty(product.package_size)} {unitLabel(product.unit)} / qadoq</div>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-white/70">
          <Icon name={TYPE_META[product.type].icon} size={14} />
          {TYPE_META[product.type].label}
        </span>
      </td>
      <td className="px-4 py-3 text-white/70">{product.brand || '—'}</td>
      <td className="px-4 py-3 text-white/70">{product.viscosity || '—'}</td>
      <td className={`px-4 py-3 text-right font-bold ${product.state === 'out' ? 'text-red-300' : product.state === 'low' ? 'text-amber-300' : 'text-white'}`}>
        {withUnit(product.current_quantity, product.unit)}
      </td>
      <td className="px-4 py-3 text-right text-white/50">{withUnit(product.minimum_quantity, product.unit)}</td>
      <td className="px-4 py-3">{statusBadge(product)}</td>
      <td className="px-4 py-3 text-right text-white/80">{money(product.cost_price)}</td>
      <td className="px-4 py-3">
        <RowActions product={product} onOpen={onOpen} onEdit={onEdit} onStock={onStock} onConsume={onConsume} onAdjust={onAdjust} />
      </td>
    </tr>
  );
}

function ProductCard({ product, onOpen, onEdit, onStock, onConsume, onAdjust }) {
  return (
    <div className={`card p-4 ${Number(product.is_active) ? '' : 'opacity-60'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button type="button" onClick={onOpen} className="text-left font-bold hover:text-[rgb(var(--c-primary))]">
            {productLabel(product)}
          </button>
          <div className="text-xs text-white/45">{TYPE_META[product.type].label}{product.brand ? ` · ${product.brand}` : ''}</div>
        </div>
        {statusBadge(product)}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] uppercase text-white/40">Qoldiq</div>
          <div className="text-xs font-bold text-white">{withUnit(product.current_quantity, product.unit)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-white/40">Minimal</div>
          <div className="text-xs font-semibold text-white/70">{withUnit(product.minimum_quantity, product.unit)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-white/40">Narx</div>
          <div className="text-xs font-semibold text-white/70">{money(product.cost_price)}</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 border-t border-white/5 pt-3">
        <RowActions product={product} onOpen={onOpen} onEdit={onEdit} onStock={onStock} onConsume={onConsume} onAdjust={onAdjust} />
      </div>
    </div>
  );
}

function RowActions({ product, onOpen, onEdit, onStock, onConsume, onAdjust }) {
  const live = Number(product.is_active) === 1;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {live && (
        <button
          type="button"
          onClick={onStock}
          className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20"
        >
          <Icon name="pluss" size={14} /> Qo'shish
        </button>
      )}
      {live && (
        <button
          type="button"
          onClick={onConsume}
          className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/20"
        >
          <Icon name="trash" size={14} /> Sarf
        </button>
      )}
      <button
        type="button"
        onClick={onAdjust}
        className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-300 transition hover:bg-amber-500/20"
      >
        <Icon name="edit" size={14} /> Tuzatish
      </button>
      <button type="button" onClick={onEdit} title="Tahrirlash" className="rounded-lg border border-white/10 p-1.5 text-white/60 transition hover:bg-white/10">
        <Icon name="edit" size={14} />
      </button>
      <button type="button" onClick={onOpen} title="Tarix" className="rounded-lg border border-white/10 p-1.5 text-white/60 transition hover:bg-white/10">
        <Icon name="document" size={14} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Movement history tab                                               */
/* ------------------------------------------------------------------ */

function MovementHistory({ onChanged }) {
  const [movements, setMovements] = useState([]);
  const [page, setPage] = useState({ page: 1, per_page: PER_PAGE, total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [movementType, setMovementType] = useState('');
  const [productType, setProductType] = useState('');
  const [productId, setProductId] = useState('');
  const [allProducts, setAllProducts] = useState([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  // The product filter needs a full list; the paginated table cannot provide it.
  // The server caps per_page at 100, so this is a shortcut picker -- anything
  // outside it stays reachable through the free-text search above.
  useEffect(() => {
    let alive = true;
    api.get('/admin/inventory/products?per_page=100&sort=name')
      .then((d) => { if (alive) setAllProducts(d.products || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(currentPage), per_page: String(PER_PAGE) });
      if (search) params.set('q', search);
      if (movementType) params.set('movement_type', movementType);
      if (productType) params.set('type', productType);
      if (productId) params.set('product_id', productId);
      if (from) params.set('date_from', from);
      if (to) params.set('date_to', to);
      const data = await api.get(`/admin/inventory/movements?${params.toString()}`);
      setMovements(data.movements || []);
      setPage(data.pagination || { page: currentPage, per_page: PER_PAGE, total: 0, pages: 1 });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [currentPage, search, movementType, productType, productId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q.trim());
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const reset = () => {
    setQ(''); setSearch(''); setMovementType(''); setProductType(''); setProductId(''); setFrom(''); setTo(''); setCurrentPage(1);
  };

  return (
    <>
      <div className="card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <label className="label">Qidirish</label>
            <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mahsulot, brend yoki izoh" />
          </div>
          <div>
            <label className="label">Harakat</label>
            <select className="field" value={movementType} onChange={(e) => { setMovementType(e.target.value); setCurrentPage(1); }}>
              <option value="" className="bg-[#111725]">Barchasi</option>
              <option value="purchase" className="bg-[#111725]">Kirim</option>
              <option value="consumption" className="bg-[#111725]">Sarf</option>
              <option value="adjustment" className="bg-[#111725]">Tuzatish</option>
            </select>
          </div>
          <div>
            <label className="label">Turi</label>
            <select className="field" value={productType} onChange={(e) => { setProductType(e.target.value); setCurrentPage(1); }}>
              <option value="" className="bg-[#111725]">Barchasi</option>
              <option value="oil" className="bg-[#111725]">Moy</option>
              <option value="filter" className="bg-[#111725]">Filtr</option>
            </select>
          </div>
          <div>
            <label className="label">Mahsulot</label>
            <select className="field max-w-[220px]" value={productId} onChange={(e) => { setProductId(e.target.value); setCurrentPage(1); }}>
              <option value="" className="bg-[#111725]">Barchasi</option>
              {allProducts
                .filter((p) => !productType || p.type === productType)
                .map((p) => (
                  <option key={p.id} value={p.id} className="bg-[#111725]">{productLabel(p)}</option>
                ))}
            </select>
          </div>
          <div>
            <label className="label">Boshlanish</label>
            <input type="date" className="field" value={from} onChange={(e) => { setFrom(e.target.value); setCurrentPage(1); }} />
          </div>
          <div>
            <label className="label">Tugash</label>
            <input type="date" className="field" value={to} onChange={(e) => { setTo(e.target.value); setCurrentPage(1); }} />
          </div>
          <button type="button" onClick={reset} className="btn-outline !py-2.5 text-sm">
            <Icon name="close" size={14} /> Tozalash
          </button>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      {loading && !movements.length ? (
        <Loading label="Harakatlar yuklanmoqda..." />
      ) : movements.length === 0 ? (
        <div className="card p-10 text-center">
          <Icon name="clock" size={32} className="mx-auto mb-3 text-white/30" />
          <p className="text-white/60">Harakat topilmadi</p>
        </div>
      ) : (
        <>
          <div className="card hidden overflow-hidden lg:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/45">
                    <th className="px-4 py-3 font-semibold">Sana</th>
                    <th className="px-4 py-3 font-semibold">Mahsulot</th>
                    <th className="px-4 py-3 font-semibold">Harakat</th>
                    <th className="px-4 py-3 text-right font-semibold">Miqdor</th>
                    <th className="px-4 py-3 text-right font-semibold">Oldingi</th>
                    <th className="px-4 py-3 text-right font-semibold">Keyingi</th>
                    <th className="px-4 py-3 font-semibold">Admin</th>
                    <th className="px-4 py-3 font-semibold">Izoh</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.map((m) => (
                    <MovementRow key={m.id} m={m} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-3 lg:hidden">
            {movements.map((m) => (
              <div key={m.id} className="card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold">{m.product_name}</div>
                    <div className="text-xs text-white/45">{m.created_at}</div>
                  </div>
                  <Badge kind={(MOVEMENT_META[m.movement_type] || MOVEMENT_META.adjustment).badge}>
                    {m.movement_label}
                  </Badge>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-[10px] uppercase text-white/40">Miqdor</div>
                    <div className={`text-xs font-bold ${Number(m.quantity) > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                      {signed(m.quantity, m.unit)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-white/40">Oldingi</div>
                    <div className="text-xs font-semibold text-white/70">{qty(m.before_quantity)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-white/40">Keyingi</div>
                    <div className="text-xs font-semibold text-white/70">{qty(m.after_quantity)}</div>
                  </div>
                </div>
                {m.note && <div className="mt-2 text-xs text-white/45">{m.note}</div>}
              </div>
            ))}
          </div>

          {page.pages > 1 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/45">
                {page.total} ta harakat · {page.page} / {page.pages} sahifa
              </span>
              <div className="flex gap-2">
                <button type="button" className="btn-outline !py-2 text-sm" disabled={currentPage <= 1} onClick={() => setCurrentPage(currentPage - 1)}>Oldingi</button>
                <button type="button" className="btn-outline !py-2 text-sm" disabled={currentPage >= page.pages} onClick={() => setCurrentPage(currentPage + 1)}>Keyingi</button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

function MovementRow({ m, compact }) {
  const meta = MOVEMENT_META[m.movement_type] || MOVEMENT_META.adjustment;
  if (compact) {
    return (
      <div className="flex items-center justify-between gap-3 py-2">
        <div className="min-w-0">
          <span className="block truncate text-sm text-white/80">{m.product_name}</span>
          <span className="text-xs text-white/35">{m.created_at}</span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Badge kind={meta.badge}>{m.movement_label}</Badge>
          <span className={`text-sm font-bold ${Number(m.quantity) > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
            {signed(m.quantity, m.unit)}
          </span>
        </div>
      </div>
    );
  }
  return (
    <tr className="border-b border-white/5 transition hover:bg-white/[0.03]">
      <td className="px-4 py-3 text-xs text-white/45">{m.created_at}</td>
      <td className="px-4 py-3 font-medium text-white">{m.product_name}</td>
      <td className="px-4 py-3">
        <Badge kind={meta.badge}>{m.movement_label}</Badge>
        {m.reference_label && <div className="mt-0.5 text-[10px] text-white/35">{m.reference_label}</div>}
      </td>
      <td className={`px-4 py-3 text-right font-bold ${Number(m.quantity) > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
        {signed(m.quantity, m.unit)}
      </td>
      <td className="px-4 py-3 text-right text-white/50">{withUnit(m.before_quantity, m.unit)}</td>
      <td className="px-4 py-3 text-right font-semibold text-white">{withUnit(m.after_quantity, m.unit)}</td>
      <td className="px-4 py-3 text-white/60">{m.admin_name || '—'}</td>
      <td className="max-w-[220px] truncate px-4 py-3 text-xs text-white/50">{m.note || '—'}</td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/* Modals                                                             */
/* ------------------------------------------------------------------ */

/**
 * Edit form. One product.
 *
 * Viscosity is shown only for oil and is required there; unit is never a free
 * choice because it follows from the type. Both rules are enforced again on the
 * server -- this is convenience, not the defence.
 *
 * Editing stays a single-product operation on purpose. Adding is the batch case and
 * has its own form below; mixing the two would mean a card array and an activation
 * toggle sharing one piece of state.
 *
 * Note there is no quantity field here: stock is never edited directly, only moved
 * through the stock endpoints, so a control that the server would reject is not
 * offered.
 */
function EditProductModal({ open, product, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    setForm(
      product
        ? {
            name: product.name,
            type: product.type,
            brand: product.brand || '',
            viscosity: product.viscosity || '',
            unit: product.unit,
            package_size: String(product.package_size ?? ''),
            minimum_quantity: String(product.minimum_quantity ?? ''),
            cost_price: String(product.cost_price ?? ''),
            current_quantity: String(product.current_quantity ?? ''),
          }
        : EMPTY_FORM
    );
  }, [open, product]);

  const isOil = form.type === 'oil';
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function onSubmit(e) {
    e.preventDefault();
    // A second click while the request is in flight would submit the same edit twice.
    if (busy) return;
    setMsg(null);
    setBusy(true);
    try {
      const payload = {
        name: form.name,
        type: form.type,
        brand: form.brand,
        unit: isOil ? 'liter' : 'piece',
        package_size: form.package_size,
        minimum_quantity: form.minimum_quantity,
        cost_price: form.cost_price,
      };
      if (isOil) payload.viscosity = form.viscosity;
      await api.patch(`/admin/inventory/products/${product.id}`, payload);
      await onSaved(false);
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Mahsulotni tahrirlash" wide>
      <form onSubmit={onSubmit} className="space-y-4">
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Mahsulot turi *</label>
            <select className="field" value={form.type} disabled onChange={() => {}}>
              <option value="oil" className="bg-[#111725]">Moy</option>
              <option value="filter" className="bg-[#111725]">Filtr</option>
            </select>
            <p className="mt-1 text-xs text-white/35">Tur bo\'yicha o\'zgartirish arxivlash orqali amalga oshiriladi.</p>
          </div>
          <div>
            <label className="label">Nomi *</label>
            <input className="field" value={form.name} onChange={set('name')} placeholder={isOil ? 'Castrol EDGE' : 'MANN Oil Filter'} required maxLength={150} />
          </div>
          <div>
            <label className="label">Brend</label>
            <input className="field" value={form.brand} onChange={set('brand')} placeholder={isOil ? 'Castrol' : 'MANN'} maxLength={80} />
          </div>
          {isOil && (
            <div>
              <label className="label">Viskozitet *</label>
              <input className="field" value={form.viscosity} onChange={set('viscosity')} placeholder="5W-30" required maxLength={30} />
            </div>
          )}
          <div>
            <label className="label">Birlik</label>
            <input className="field" value={isOil ? 'liter' : 'dona'} disabled readOnly />
          </div>
          <div>
            <label className="label">Qadoq hajmi ({isOil ? 'L' : 'dona'})</label>
            <input className="field" inputMode="decimal" value={form.package_size} onChange={set('package_size')} placeholder={isOil ? '4' : '1'} />
          </div>
          <div>
            <label className="label">Minimal qoldiq</label>
            <input className="field" inputMode="decimal" value={form.minimum_quantity} onChange={set('minimum_quantity')} placeholder={isOil ? '20' : '5'} />
          </div>
          <div>
            <label className="label">Kelish narxi (so'm)</label>
            <input className="field" inputMode="decimal" value={form.cost_price} onChange={set('cost_price')} placeholder="45000" />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
          <div>
            <div className="text-sm font-semibold">Faol mahsulot</div>
            <div className="text-xs text-white/40">O\'chirilgan mahsulot tanlovchilarda ko\'rinmaydi, tarixi saqlanadi.</div>
          </div>
          <Toggle
            checked={Number(product.is_active) === 1}
            label="Faol"
            onChange={async (next) => {
              try {
                await api.patch(`/admin/inventory/products/${product.id}`, { is_active: next ? 1 : 0 });
                await onSaved(false);
              } catch (err) {
                setMsg({ kind: 'error', text: err.message });
              }
            }}
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
          <button type="submit" disabled={busy} className="btn-primary !py-2.5 text-sm disabled:opacity-60">
            {busy ? 'Saqlanmoqda...' : 'Saqlash'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Multi-product add form                                             */
/* ------------------------------------------------------------------ */

/**
 * One product card in the batch form.
 *
 * The fields follow the type: viscosity exists only for oil, and the unit is a
 * disabled readout rather than a choice because it is derived from the type on the
 * server too. The grid is one column on a phone and two on a desktop, which is what
 * the `sm:grid-cols-2` does, and the opening-stock field spans both columns because
 * it carries a hint line of its own.
 */
function DraftCard({ index, draft, errors, removable, onChange, onRemove, inputRef, highlighted }) {
  const isOil = draft.type === 'oil';
  const field = (key) => (e) => onChange({ [key]: e.target.value });
  // A red ring on the inputs that failed, so the offending card is findable by
  // scanning the form rather than by reading eight messages.
  const ring = (key) => (errors[key] ? '!border-red-500/60' : '');
  const hint = (key) => (errors[key] ? <p className="mt-1 text-xs text-red-300">{errors[key]}</p> : null);

  return (
    <div
      className={`rounded-2xl border bg-white/[0.03] p-4 transition-colors ${
        highlighted ? 'border-[rgb(var(--c-primary))]/50' : 'border-white/10'
      }`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="flex h-7 min-w-7 items-center justify-center rounded-full border border-white/15 bg-white/[0.06] px-2 text-xs font-bold tabular-nums text-white/80">
          {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={!removable}
          title={removable ? 'Bu mahsulotni olib tashlash' : 'Kamida bitta mahsulot qolishi kerak'}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 px-2.5 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-500/15 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-white/25 disabled:hover:bg-transparent"
        >
          <Icon name="trash" size={14} />
          O&apos;chirish
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Mahsulot turi *</label>
          <select className="field" value={draft.type} onChange={(e) => onChange(switchType(e.target.value))}>
            <option value="oil" className="bg-[#111725]">Moy</option>
            <option value="filter" className="bg-[#111725]">Filtr</option>
          </select>
        </div>
        <div>
          <label className="label">Nomi *</label>
          <input
            ref={inputRef}
            className={`field ${ring('name')}`}
            value={draft.name}
            onChange={field('name')}
            placeholder={isOil ? 'Castrol EDGE' : 'MANN Oil Filter'}
            maxLength={150}
          />
          {hint('name')}
        </div>
        <div>
          <label className="label">Brend *</label>
          <input
            className={`field ${ring('brand')}`}
            value={draft.brand}
            onChange={field('brand')}
            placeholder={isOil ? 'Castrol' : 'MANN'}
            maxLength={80}
          />
          {hint('brand')}
        </div>
        {isOil && (
          <div>
            <label className="label">Viskozitet *</label>
            <input
              className={`field ${ring('viscosity')}`}
              value={draft.viscosity}
              onChange={field('viscosity')}
              placeholder="5W-30"
              maxLength={30}
            />
            {hint('viscosity')}
          </div>
        )}
        <div>
          <label className="label">Birlik</label>
          {/* Shown translated, like every other unit in this page: the stored value
              is `piece`, but the operator reads `dona` everywhere else. */}
          <input className="field" value={isOil ? 'liter' : 'dona'} disabled readOnly />
        </div>
        <div>
          <label className="label">Qadoq hajmi ({isOil ? 'L' : 'dona'})</label>
          <input
            className={`field ${ring('package_size')}`}
            inputMode="decimal"
            value={draft.package_size}
            onChange={field('package_size')}
            placeholder={isOil ? '4' : '1'}
          />
          {hint('package_size')}
        </div>
        <div>
          <label className="label">Minimal qoldiq</label>
          <input
            className={`field ${ring('minimum_quantity')}`}
            inputMode="decimal"
            value={draft.minimum_quantity}
            onChange={field('minimum_quantity')}
            placeholder={isOil ? '20' : '5'}
          />
          {hint('minimum_quantity')}
        </div>
        <div>
          <label className="label">Kelish narxi (so&apos;m)</label>
          <input
            className={`field ${ring('cost_price')}`}
            inputMode="decimal"
            value={draft.cost_price}
            onChange={field('cost_price')}
            placeholder="45000"
          />
          {hint('cost_price')}
        </div>
        <div className="sm:col-span-2">
          <label className="label">Boshlang&apos;ich qoldiq</label>
          <input
            className={`field ${ring('initial_quantity')}`}
            inputMode="decimal"
            value={draft.initial_quantity}
            onChange={field('initial_quantity')}
            placeholder="0"
          />
          <p className="mt-1 text-xs text-white/35">Kirim harakati sifatida yoziladi.</p>
          {hint('initial_quantity')}
        </div>
      </div>
    </div>
  );
}

/**
 * Add many products at once.
 *
 * Every card is one product, numbered in the order it appears, and the whole set is
 * submitted as a single request. The server commits them in one transaction, so the
 * operator gets all of them or none: a typo in the sixth card cannot leave the first
 * five sitting in the warehouse with no way to tell that is what happened.
 *
 * The panel is the `footer` layout of `Modal`: the header and the footer stay pinned
 * and only the card list scrolls, so the Save button is reachable no matter how many
 * cards are open, and the modal never grows past 90vh.
 *
 * The list rules (add, remove, renumber, cap) and the field validation live in
 * `inventoryDrafts.js`, free of JSX so they can be asserted directly; this component
 * renders them and owns the focus.
 */
function BulkProductModal({ open, onClose, onSaved }) {
  const [drafts, setDrafts] = useState(newDrafts);
  const [errors, setErrors] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const cardRefs = useRef([]);
  const nameRefs = useRef([]);

  // Re-seed on open so a previous batch's drafts -- and its errors -- can never
  // survive into the next one. Keyed on `open`, so it only fires on the transition.
  useEffect(() => {
    if (!open) return;
    setDrafts(newDrafts());
    setErrors([]);
    setMsg(null);
    setBusy(false);
    setFocusIndex(0);
  }, [open]);

  // Put the cursor on the card the operator was last pointed at: the first one when
  // the modal opens, the new one after "+ Yana mahsulot qo'shish", and the card that
  // failed when the form or the server points at one.
  useEffect(() => {
    if (!open) return;
    const input = nameRefs.current[focusIndex];
    if (input) input.focus();
    const card = cardRefs.current[focusIndex];
    if (card && focusIndex > 0) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [open, focusIndex, drafts.length]);

  function update(index, patch) {
    setDrafts((prev) => updateDraft(prev, index, patch));
    // Editing a field clears its error at once; leaving a red message under an input
    // the operator has just fixed is only noise.
    setErrors((prev) => clearFieldError(prev, index, Object.keys(patch)));
  }

  function onAdd() {
    const next = addDraftTo(drafts, errors);
    if (!next.added) return;
    setDrafts(next.drafts);
    setErrors(next.errors);
    setFocusIndex(next.focusIndex);
  }

  function onRemove(index) {
    const next = removeDraftFrom(drafts, errors, index);
    if (!next.removed) return;
    setDrafts(next.drafts);
    setErrors(next.errors);
    // The numbers renumber themselves, because each card renders its own position;
    // only the focus has to be moved deliberately.
    setFocusIndex(next.focusIndex);
  }

  async function onSubmit(e) {
    e.preventDefault();
    // A second click while the request is in flight would submit the batch twice.
    if (busy) return;

    const nextErrors = validateDrafts(drafts);
    const firstBad = firstInvalidIndex(nextErrors);
    if (firstBad !== -1) {
      setErrors(nextErrors);
      setMsg({ kind: 'error', text: 'Ba\'zi maydonlar to\'ldirilmagan yoki noto\'g\'ri. Qizil belgilangan joylarni tuzatib qayta urinib ko\'ring.' });
      setFocusIndex(firstBad);
      return;
    }

    setErrors([]);
    setMsg(null);
    setBusy(true);
    try {
      const res = await api.post('/admin/inventory/products/bulk', {
        products: drafts.map(draftPayload),
      });
      await onSaved(true, (res && res.count) || drafts.length);
    } catch (err) {
      // The endpoint prefixes its message with the position ("3-mahsulot: Viskozitet
      // majburiy"), so the message is shown as-is and the digits are read back out to
      // move the operator to the exact card that failed.
      setMsg({ kind: 'error', text: err.message });
      const index = focusFromServerMessage(err.message, drafts.length);
      if (index !== null) setFocusIndex(index);
    } finally {
      setBusy(false);
    }
  }

  const atLimit = !canAdd(drafts);

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Mahsulot qo'shish"
      wide
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-white/40">
            {drafts.length} ta mahsulot{atLimit ? ` · maksimal ${MAX_PRODUCTS} ta` : ''}
          </span>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="flex-1 rounded-xl border border-white/15 px-5 py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/5 disabled:opacity-40 sm:flex-none"
            >
              Bekor qilish
            </button>
            <button
              type="submit"
              form="bulk-product-form"
              disabled={busy}
              className="btn-primary flex-1 !py-2.5 text-sm disabled:opacity-60 sm:flex-none"
            >
              {busy ? 'Saqlanmoqda...' : `Saqlash${drafts.length > 1 ? ` (${drafts.length})` : ''}`}
            </button>
          </div>
        </div>
      }
    >
      <form id="bulk-product-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

        {drafts.map((draft, index) => (
          <div
            key={draft.uid}
            ref={(el) => {
              cardRefs.current[index] = el;
            }}
            className="animate-fade-up"
          >
            <DraftCard
              index={index}
              draft={draft}
              errors={errors[index] || {}}
              removable={canRemove(drafts)}
              highlighted={focusIndex === index}
              onChange={(patch) => update(index, patch)}
              onRemove={() => onRemove(index)}
              inputRef={(el) => {
                nameRefs.current[index] = el;
              }}
            />
          </div>
        ))}

        <button
          type="button"
          onClick={onAdd}
          disabled={atLimit || busy}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-white/20 bg-white/[0.02] px-5 py-4 text-sm font-semibold text-white/70 transition hover:border-white/35 hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-white/20 disabled:hover:bg-white/[0.02] disabled:hover:text-white/70"
        >
          <Icon name="pluss" size={16} />
          {atLimit ? `Maksimal ${MAX_PRODUCTS} ta mahsulot qo'shildi` : '+ Yana mahsulot qo\'shish'}
        </button>
      </form>
    </Modal>
  );
}

/**
 * Chooses between the two forms.
 *
 * The branch lives here rather than inside either form so the edit form stays exactly
 * what it was and the batch form never carries the single-product branches.
 */
function ProductFormModal(props) {
  return props.product ? <EditProductModal {...props} /> : <BulkProductModal {...props} />;
}

/** Shared body for the three stock movements: a quantity, an optional note. */
function MovementForm({ product, title, submitLabel, kind, onClose, onSubmit, children }) {
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isPiece = product && product.unit === 'piece';
  // Receiving more stock is additive and cheap to notice; removing or rewriting
  // stock is not, so those two stop for an explicit confirmation.
  const needsConfirm = kind === 'consume' || kind === 'adjust';

  useEffect(() => {
    setQuantity('');
    setNote('');
    setMsg(null);
    setConfirming(false);
  }, [product]);

  async function run() {
    setMsg(null);
    setBusy(true);
    try {
      await onSubmit({ quantity: quantity.trim(), note: note.trim() });
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    if (needsConfirm) {
      setConfirming(true);
      return;
    }
    run();
  }

  const delta = kind === 'consume'
    ? -Math.abs(Number(quantity) || 0)
    : kind === 'adjust'
      ? Number(quantity) || 0
      : Math.abs(Number(quantity) || 0);
  const projected = Number(product.current_quantity) + delta;

  return (
    <>
      <Modal open onClose={onClose} title={title}>
      <form onSubmit={submit} className="space-y-4">
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm">
          <div className="font-semibold">{productLabel(product)}</div>
          <div className="mt-0.5 text-white/45">
            Hozirgi qoldiq: <span className="font-bold text-white">{withUnit(product.current_quantity, product.unit)}</span>
          </div>
        </div>

        <div>
          <label className="label">
            {kind === 'consume' ? 'Sarflanadigan' : 'Qo\'shiladigan'} miqdor ({isPiece ? 'dona' : 'L'}) *
          </label>
          <input
            className="field"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder={isPiece ? '1' : '4.5'}
            step={isPiece ? '1' : '0.001'}
            required
          />
        </div>

        {children}

        <div>
          <label className="label">Izoh</label>
          <input className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Ishlatildi / yetkazib beruvchi" />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
          <button
            type="submit"
            disabled={busy || !quantity.trim()}
            className={`rounded-xl px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60 ${
              kind === 'consume' ? 'bg-red-600 hover:bg-red-500' : kind === 'adjust' ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'
            }`}
          >
            {busy ? 'Jarayonda...' : submitLabel}
          </button>
        </div>
      </form>
      </Modal>

      {confirming && (
        <Modal open onClose={() => !busy && setConfirming(false)} title={kind === 'consume' ? 'Sarfni tasdiqlash' : 'Tuzatishni tasdiqlash'}>
          <div className="space-y-3 text-sm text-white/70">
            <p>
              <span className="font-semibold text-white">{productLabel(product)}</span> uchun{' '}
              <span className="font-bold text-white">{signed(delta, product.unit)}</span>{' '}
              {kind === 'consume' ? 'sarf qilinmoqchasi' : 'tuzatilmoqchasi'}.
            </p>
            <p className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
              Qoldiq <span className="font-bold text-white">{withUnit(product.current_quantity, product.unit)}</span>
              {' → '}
              <span className={`font-bold ${projected < 0 ? 'text-red-300' : 'text-emerald-300'}`}>
                {withUnit(projected, product.unit)}
              </span>
              {projected < 0 && <span className="mt-1 block text-xs text-red-300">Qoldiq manfiy bo‘ladi; server rad etadi.</span>}
            </p>
            <p className="text-xs text-white/40">Harakat tarihga yoziladi va o‘chirilmaydi.</p>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5 disabled:opacity-60"
            >
              Bekor qilish
            </button>
            <button
              type="button"
              onClick={run}
              disabled={busy}
              className={`rounded-xl px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60 ${
                kind === 'consume' ? 'bg-red-600 hover:bg-red-500' : 'bg-amber-600 hover:bg-amber-500'
              }`}
            >
              {busy ? 'Jarayonda...' : kind === 'consume' ? 'Sarf qilish' : 'Tuzatish'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function StockInModal({ product, onClose, onSaved }) {
  if (!product) return null;
  return (
    <MovementForm
      product={product}
      kind="stock-in"
      title="Omborga qo'shish"
      submitLabel="Qo'shish"
      onClose={onClose}
      onSubmit={async ({ quantity, note }) => {
        await api.post(`/admin/inventory/products/${product.id}/stock-in`, { quantity, note });
        await onSaved();
      }}
    />
  );
}

function ConsumeModal({ product, onClose, onSaved }) {
  if (!product) return null;
  return (
    <MovementForm
      product={product}
      kind="consume"
      title="Sarf qilish"
      submitLabel="Sarf qilish"
      onClose={onClose}
      onSubmit={async ({ quantity, note }) => {
        await api.post(`/admin/inventory/products/${product.id}/consume`, { quantity, note });
        await onSaved();
      }}
    />
  );
}

/**
 * Stock take.
 *
 * Two ways to express the same correction, because both come up in practice:
 * a signed difference ("we are 1 L short") or the real count on the shelf
 * ("there are 24 L"). A reason is mandatory either way.
 */
function AdjustModal({ product, onClose, onSaved }) {
  const [mode, setMode] = useState('delta');
  if (!product) return null;
  return (
    <MovementForm
      product={product}
      kind="adjust"
      title="Qoldiqni tuzatish"
      submitLabel="Tuzatish"
      onClose={onClose}
      onSubmit={async ({ quantity, note }) => {
        await api.post(`/admin/inventory/products/${product.id}/adjust`, {
          quantity: mode === 'delta' ? quantity : undefined,
          current_quantity: mode === 'absolute' ? quantity : undefined,
          reason: note,
        });
        await onSaved();
      }}
    >
      <div>
        <label className="label">Tuzatish usuli</label>
        <select className="field" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="delta" className="bg-[#111725]">Farq (manfiy bo'lishi mumkin)</option>
          <option value="absolute" className="bg-[#111725]">Haqiqiy qoldiq</option>
        </select>
      </div>
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-xs text-amber-200/90">
        Sabab majburiy. Har bir o'zgarish <span className="font-semibold">Harakatlar tarixi</span>da saqlanadi.
      </div>
    </MovementForm>
  );
}

/**
 * Product detail: totals, the movement history behind them, and the jobs that
 * consumed it. `totals.consistent` is the server's own recomputation of the
 * stock from the ledger, shown so a discrepancy is visible instead of silent.
 */
function ProductDetailModal({ product, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!product) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .get(`/admin/inventory/products/${product.id}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [product]);

  if (!product) return null;

  return (
    <Modal open onClose={onClose} title={productLabel(product)} wide>
      {loading ? (
        <Loading label="Yuklanmoqda..." />
      ) : error ? (
        <Alert>{error}</Alert>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryTile label="Joriy qoldiq" value={withUnit(data.product.current_quantity, data.product.unit)} tone="text-white" />
            <SummaryTile label="Jami kirim" value={withUnit(data.totals.purchased, data.product.unit)} tone="text-emerald-300" />
            <SummaryTile label="Jami sarf" value={withUnit(data.totals.consumed, data.product.unit)} tone="text-red-300" />
            <SummaryTile label="Tuzatishlar" value={signed(data.totals.adjusted, data.product.unit)} tone="text-amber-300" />
            <SummaryTile label="Minimal" value={withUnit(data.product.minimum_quantity, data.product.unit)} tone="text-white/70" />
            <SummaryTile label="Narx" value={money(data.product.cost_price)} tone="text-white/70" />
          </div>

          {data.totals.consistent ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-4 py-2.5 text-xs text-emerald-300">
              <Icon name="check" size={14} />
              Harakatlar tarixi orqali qayta hisoblanganda ham {withUnit(data.totals.ledger_total, data.product.unit)} chiqadi.
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-300">
              <Icon name="close" size={14} />
              Farq bor: tizim {withUnit(data.totals.current_quantity, data.product.unit)}, tarix {withUnit(data.totals.ledger_total, data.product.unit)}.
            </div>
          )}

          {data.service_materials.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-white/50">Ishlarda ishlatilgan</h4>
              <div className="space-y-1">
                {data.service_materials.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2 text-xs">
                    <span className="min-w-0 truncate text-white/70">
                      {m.title}{m.customer_name ? ` · ${m.customer_name}` : ''}
                    </span>
                    <span className="shrink-0 font-semibold text-white/60">{withUnit(m.quantity, data.product.unit)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-white/50">Harakatlar tarixi</h4>
            {data.movements.length === 0 ? (
              <p className="text-sm text-white/40">Hali harakat yo\'q.</p>
            ) : (
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {data.movements.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2 text-xs">
                    <div className="min-w-0">
                      <div className="font-semibold text-white/80">{m.created_at}</div>
                      {m.note && <div className="truncate text-white/40">{m.note}</div>}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className={`font-bold ${Number(m.quantity) > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                        {signed(m.quantity, data.product.unit)}
                      </div>
                      <div className="text-white/40">
                        {qty(m.before_quantity)} → {qty(m.after_quantity)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function SummaryTile({ label, value, tone }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className={`mt-1 truncate text-sm font-bold ${tone}`}>{value}</div>
    </div>
  );
}

/**
 * CSV download via fetch + blob.
 *
 * A plain <a href> would work too, but the endpoint is session-authenticated, so
 * the cookie has to travel with the request; fetch does that and lets a failed
 * request surface as a message instead of a downloaded file of HTML.
 */
function CsvButton({ url, filename, label }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function download() {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch(`/api${url}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Eksport bajarilmadi');
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={download} disabled={busy} className="btn-outline flex items-center gap-2 !py-2.5 text-sm">
        <Icon name="document" size={16} /> {busy ? 'Yuklanmoqda...' : label}
      </button>
      {err && <span className="text-xs text-red-300">{err}</span>}
    </div>
  );
}