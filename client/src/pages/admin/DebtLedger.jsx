import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import Icon from '../../components/icons';
import { Loading, Alert, Badge, Modal, ConfirmDialog } from '../../components/ui';

const STATUS_META = {
  unpaid: { label: "To'lanmagan", badge: 'danger', row: 'bg-red-500/[0.04]' },
  partially_paid: { label: "Qisman to'langan", badge: 'warn', row: '' },
  paid: { label: "To'langan", badge: 'success', row: '' },
};

const FILTERS = [
  { key: 'all', label: 'Barcha' },
  { key: 'unpaid', label: "To'lanmagan" },
  { key: 'partially_paid', label: "Qisman to'langan" },
  { key: 'paid', label: "To'langan" },
  { key: 'archive', label: 'Arxiv' },
];

const SORTS = [
  { key: 'newest', label: 'Eng yangi' },
  { key: 'oldest', label: 'Eng eski' },
  { key: 'largest', label: 'Eng katta qarz' },
  { key: 'remaining', label: 'Eng katta qolgan qarz' },
];

// 250000 -> "250 000". Sum is rendered server-side derived; grouping is only
// presentational.
function som(n) {
  const v = Number(n || 0);
  return `${v.toLocaleString('ru-RU').replace(/,/g, ' ')} so'm`;
}

export default function DebtLedger() {
  const [stats, setStats] = useState(null);
  const [debts, setDebts] = useState([]);
  const [page, setPage] = useState({ page: 1, per_page: 20, total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [currentPage, setCurrentPage] = useState(1);

  const [addOpen, setAddOpen] = useState(false);
  const [payFor, setPayFor] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ filter, sort, page: String(currentPage), per_page: '20' });
      if (search) params.set('q', search);
      const [s, list] = await Promise.all([
        api.get('/admin/debts/stats'),
        api.get(`/admin/debts?${params.toString()}`),
      ]);
      setStats(s);
      setDebts(list.debts || []);
      setPage(list.pagination || { page: currentPage, per_page: 20, total: 0, pages: 1 });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filter, sort, currentPage, search]);

  useEffect(() => {
    load();
  }, [load]);

  // Debounce search so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q.trim());
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const cards = useMemo(() => {
    if (!stats) return [];
    return [
      { label: 'Jami qarz', value: som(stats.totalDebt), icon: 'money', color: 'bg-[rgb(var(--c-primary))]' },
      { label: "To'lanishi kerak", value: som(stats.totalRemaining), icon: 'clock', color: 'bg-red-500' },
      { label: "To'liq to'langan", value: som(stats.totalPaid), icon: 'check', color: 'bg-emerald-500' },
      { label: 'Qarzdorlar soni', value: stats.totalDebtors, icon: 'user', color: 'bg-sky-500' },
    ];
  }, [stats]);

  const onDeleted = async () => {
    setDeleteTarget(null);
    setNotice("Qarz arxivlandi va o'chirildi.");
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Qarz daftari</h1>
          <p className="mt-1 text-sm text-white/50">
            Qarzdorlar, qarz va to'lovlar. Ma'lumotlar PostgreSQL'da saqlanadi.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <CsvExportButton onDone={load} />
          <button type="button" onClick={() => setAddOpen(true)} className="btn-primary flex items-center gap-2 !py-2.5 text-sm">
            <Icon name="pluss" size={16} /> Qarz qo'shish
          </button>
        </div>
      </div>

      {notice && <Alert kind="success">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((c) => (
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

      <div className="card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <label className="label">Qidirish</label>
            <input
              className="field"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ism, telefon, manzil yoki xizmat"
            />
          </div>
          <div>
            <label className="label">Holat</label>
            <select className="field" value={filter} onChange={(e) => { setFilter(e.target.value); setCurrentPage(1); }}>
              {FILTERS.map((f) => <option key={f.key} value={f.key} className="bg-[#111725]">{f.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Saralash</label>
            <select className="field" value={sort} onChange={(e) => { setSort(e.target.value); setCurrentPage(1); }}>
              {SORTS.map((s) => <option key={s.key} value={s.key} className="bg-[#111725]">{s.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      {loading && !debts.length ? (
        <Loading label="Qarzlar yuklanmoqda..." />
      ) : debts.length === 0 ? (
        <div className="card p-10 text-center">
          <Icon name="search" size={32} className="mx-auto mb-3 text-white/30" />
          <p className="text-white/60">Qarz topilmadi</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="card hidden overflow-hidden lg:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/45">
                    <th className="px-4 py-3 font-semibold">Ism</th>
                    <th className="px-4 py-3 font-semibold">Telefon</th>
                    <th className="px-4 py-3 font-semibold">Xizmat</th>
                    <th className="px-4 py-3 text-right font-semibold">Qarz</th>
                    <th className="px-4 py-3 text-right font-semibold">To'langan</th>
                    <th className="px-4 py-3 text-right font-semibold">Qolgan</th>
                    <th className="px-4 py-3 font-semibold">Holat</th>
                    <th className="px-4 py-3 font-semibold">Sana</th>
                    <th className="px-4 py-3 font-semibold">Amal</th>
                  </tr>
                </thead>
                <tbody>
                  {debts.map((d) => {
                    const meta = STATUS_META[d.status] || STATUS_META.unpaid;
                    const archived = Boolean(d.deleted_at);
                    return (
                      <tr key={d.id} className={`border-b border-white/5 transition hover:bg-white/[0.03] ${meta.row} ${archived ? 'opacity-60' : ''}`}>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-white">{d.full_name}</div>
                          <div className="text-xs text-white/40">{d.address}</div>
                        </td>
                        <td className="px-4 py-3 text-white/70">{d.phone}</td>
                        <td className="px-4 py-3 text-white/70">{d.service}</td>
                        <td className="px-4 py-3 text-right text-white/80">{som(d.debt_amount)}</td>
                        <td className="px-4 py-3 text-right text-emerald-300/90">{som(d.paid_amount)}</td>
                        <td className="px-4 py-3 text-right font-bold text-red-300">{som(d.remaining_amount)}</td>
                        <td className="px-4 py-3">
                          <Badge kind={archived ? 'default' : meta.badge}>{archived ? 'Arxiv' : meta.label}</Badge>
                        </td>
                        <td className="px-4 py-3 text-xs text-white/45">{d.created_at}</td>
                        <td className="px-4 py-3">
                          <RowActions
                            debt={d}
                            archived={archived}
                            onPay={() => setPayFor(d)}
                            onHistory={() => setHistoryFor(d)}
                            onDelete={() => setDeleteTarget(d)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 lg:hidden">
            {debts.map((d) => {
              const meta = STATUS_META[d.status] || STATUS_META.unpaid;
              const archived = Boolean(d.deleted_at);
              return (
                <div key={d.id} className={`card p-4 ${archived ? 'opacity-60' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-bold">{d.full_name}</div>
                      <div className="text-xs text-white/45">{d.phone} · {d.address}</div>
                      <div className="mt-1 text-xs text-white/60">{d.service}</div>
                    </div>
                    <Badge kind={archived ? 'default' : meta.badge}>{archived ? 'Arxiv' : meta.label}</Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div><div className="text-[10px] uppercase text-white/40">Qarz</div><div className="text-xs font-semibold">{som(d.debt_amount)}</div></div>
                    <div><div className="text-[10px] uppercase text-white/40">To'langan</div><div className="text-xs font-semibold text-emerald-300">{som(d.paid_amount)}</div></div>
                    <div><div className="text-[10px] uppercase text-white/40">Qolgan</div><div className="text-xs font-bold text-red-300">{som(d.remaining_amount)}</div></div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-white/5 pt-3">
                    <RowActions
                      debt={d}
                      archived={archived}
                      onPay={() => setPayFor(d)}
                      onHistory={() => setHistoryFor(d)}
                      onDelete={() => setDeleteTarget(d)}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {page.pages > 1 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/45">
                {page.total} ta yozit · {page.page} / {page.pages} sahifa
              </span>
              <div className="flex gap-2">
                <button type="button" className="btn-outline !py-2 text-sm" disabled={currentPage <= 1} onClick={() => setCurrentPage(currentPage - 1)}>Oldingi</button>
                <button type="button" className="btn-outline !py-2 text-sm" disabled={currentPage >= page.pages} onClick={() => setCurrentPage(currentPage + 1)}>Keyingi</button>
              </div>
            </div>
          )}
        </>
      )}

      <AddDebtModal open={addOpen} onClose={() => setAddOpen(false)} onSaved={async () => { setAddOpen(false); setNotice("Qarz daftarga qo'shildi"); await load(); }} />
      <PaymentModal debt={payFor} onClose={() => setPayFor(null)} onSaved={load} />
      <HistoryModal debt={historyFor} onClose={() => setHistoryFor(null)} />
      <DeleteModal debt={deleteTarget} onClose={() => setDeleteTarget(null)} onDone={onDeleted} />
    </div>
  );
}

function RowActions({ debt, archived, onPay, onHistory, onDelete }) {
  const unpaid = Number(debt.remaining_amount) > 0;
  return (
    <div className="flex items-center gap-1.5">
      {!archived && unpaid && (
        <button type="button" onClick={onPay} className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20">
          <Icon name="money" size={14} /> To'lov
        </button>
      )}
      <button type="button" onClick={onHistory} className="rounded-lg border border-white/10 p-1.5 text-white/60 transition hover:bg-white/10" title="Tarix">
        <Icon name="document" size={14} />
      </button>
      {!archived && (
        <button type="button" onClick={onDelete} className="rounded-lg border border-red-500/30 p-1.5 text-red-300 transition hover:bg-red-500/20" title="O'chirish">
          <Icon name="trash" size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * CSV download via fetch + blob.
 *
 * A plain <a href> would work too, but the endpoint is session-authenticated, so
 * the cookie has to travel with the request; fetch does that and lets errors
 * surface as a message instead of a downloaded file full of HTML.
 */
function CsvExportButton({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function download() {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/admin/debts/export.csv', { credentials: 'include' });
      if (!res.ok) throw new Error('Eksport bajarilmadi');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'qarz-daftari.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (onDone) onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={download} disabled={busy} className="btn-outline flex items-center gap-2 !py-2.5 text-sm">
        <Icon name="document" size={16} /> {busy ? 'Yuklanmoqda...' : 'CSV eksport'}
      </button>
      {err && <span className="text-xs text-red-300">{err}</span>}
    </div>
  );
}

function AddDebtModal({ open, onClose, onSaved }) {
  const [form, setForm] = useState({ full_name: '', phone: '', address: '', service: '', debt_amount: '', paid_amount: '', description: '' });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setForm({ full_name: '', phone: '', address: '', service: '', debt_amount: '', paid_amount: '', description: '' }); setMsg(null); }
  }, [open]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function onSubmit(e) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await api.post('/admin/debts', {
        ...form,
        debt_amount: form.debt_amount.replace(/\s/g, ''),
        paid_amount: form.paid_amount.replace(/\s/g, ''),
      });
      await onSaved();
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Qarz qo'shish" wide>
      <form onSubmit={onSubmit} className="space-y-4">
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Ism-familiya *</label>
            <input className="field" value={form.full_name} onChange={set('full_name')} required />
          </div>
          <div>
            <label className="label">Telefon *</label>
            <input className="field" value={form.phone} onChange={set('phone')} placeholder="+998 90 123 45 67" required />
          </div>
          <div>
            <label className="label">Yashash joyi *</label>
            <input className="field" value={form.address} onChange={set('address')} placeholder="Urganch, Xorazm" required />
          </div>
          <div>
            <label className="label">Ko'rsatilgan xizmat *</label>
            <input className="field" value={form.service} onChange={set('service')} placeholder="Moy almashtirish" required />
          </div>
          <div>
            <label className="label">Jami qarz summasi *</label>
            <input className="field" inputMode="numeric" value={form.debt_amount} onChange={set('debt_amount')} placeholder="350000" required />
          </div>
          <div>
            <label className="label">To'langan summa</label>
            <input className="field" inputMode="numeric" value={form.paid_amount} onChange={set('paid_amount')} placeholder="0" />
          </div>
        </div>
        <div>
          <label className="label">Izoh</label>
          <textarea className="field min-h-[80px]" value={form.description} onChange={set('description')} placeholder="Castrol 5W-30 olindi, qolgan pul keyin beriladi." />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
          <button type="submit" disabled={busy} className="btn-primary !py-2.5 text-sm disabled:opacity-60">
            {busy ? <span className="text-sm">Saqlanmoqda...</span> : 'Saqlash'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PaymentModal({ debt, onClose, onSaved }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (debt) { setAmount(''); setNote(''); setMsg(null); }
  }, [debt]);

  if (!debt) return null;

  async function onSubmit(e) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await api.post(`/admin/debts/${debt.id}/payments`, { amount: amount.replace(/\s/g, ''), note });
      onClose();
      if (onSaved) await onSaved();
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="To'lov qo'shish">
      <form onSubmit={onSubmit} className="space-y-4">
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm">
          <div className="flex justify-between"><span className="text-white/50">Qarz</span><span className="font-semibold">{som(debt.debt_amount)}</span></div>
          <div className="mt-1 flex justify-between"><span className="text-white/50">To'langan</span><span className="font-semibold text-emerald-300">{som(debt.paid_amount)}</span></div>
          <div className="mt-1 flex justify-between border-t border-white/10 pt-1"><span className="text-white/50">Qolgan</span><span className="font-bold text-red-300">{som(debt.remaining_amount)}</span></div>
        </div>
        <div>
          <label className="label">To'lov summasi *</label>
          <input className="field" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="200000" required />
        </div>
        <div>
          <label className="label">Izoh</label>
          <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
          <button type="submit" disabled={busy} className="btn-primary !py-2.5 text-sm disabled:opacity-60">
            {busy ? 'Saqlanmoqda...' : 'To\'lovni qo\'shish'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function HistoryModal({ debt, onClose }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!debt) return;
    setData(null);
    api.get(`/admin/debts/${debt.id}`).then(setData).catch(() => setData({ error: 'Tarixni yuklab bo\'lmadi' }));
  }, [debt]);

  if (!debt) return null;

  return (
    <Modal open onClose={onClose} title={`${debt.full_name} — tarix`} wide>
      <div className="space-y-5">
        <section>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-white/50">To'lovlar</h3>
          {!data ? <Loading /> : data.payments.length === 0 ? (
            <p className="text-sm text-white/45">To'lovlar yo'q</p>
          ) : (
            <div className="space-y-2">
              {data.payments.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm">
                  <div>
                    <div className="font-semibold text-emerald-300">{som(p.amount)}</div>
                    {p.note && <div className="text-xs text-white/45">{p.note}</div>}
                  </div>
                  <div className="text-right text-xs text-white/40">
                    <div>{p.created_at}</div>
                    <div>{p.created_by_name || '—'}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-white/50">Audit log</h3>
          {!data ? null : data.audit_logs.length === 0 ? (
            <p className="text-sm text-white/45">Audit yozuvlari yo'q</p>
          ) : (
            <div className="space-y-1.5">
              {data.audit_logs.map((a) => (
                <div key={a.id} className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2 text-xs">
                  <span className="font-medium text-white/70">{a.action}</span>
                  <span className="text-white/40">{a.created_at} · {a.admin_name || '—'}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

/**
 * Two-phase delete: a plain confirmation, then the pass key, then the final
 * destructive action.
 *
 * The pass key is held in component state only for the life of this modal and is
 * cleared when it closes. It is never written to localStorage/sessionStorage and
 * never compared here — the server does that, and the frontend does not even know
 * the correct value.
 */
function DeleteModal({ debt, onClose, onDone }) {
  const [stage, setStage] = useState('confirm');
  const [passKey, setPassKey] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (debt) { setStage('confirm'); setPassKey(''); setMsg(null); }
  }, [debt]);

  if (!debt) return null;

  const unpaid = Number(debt.remaining_amount) > 0;
  if (unpaid) {
    return (
      <Modal open onClose={onClose} title="O'chirish">
        <p className="text-sm text-white/70">Bu qarz hali to'liq to'lanmagan.</p>
        <div className="mt-6 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Yopish</button>
        </div>
      </Modal>
    );
  }

  async function onDelete() {
    setMsg(null);
    setBusy(true);
    try {
      // Sent as a header, never in the URL, so it cannot end up in access logs.
      await api.delWithHeaders(`/admin/debts/${debt.id}`, { 'X-Debt-Pass-Key': passKey });
      setPassKey('');
      await onDone();
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Qarzni o'chirish">
      {stage === 'confirm' ? (
        <>
          <p className="text-sm text-white/70">Bu qarz yozuvini o'chirishni xohlaysizmi?</p>
          <p className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm">
            <span className="font-semibold">{debt.full_name}</span>
            <span className="ml-2 text-white/45">{som(debt.debt_amount)} · to'langan {som(debt.paid_amount)}</span>
          </p>
          <div className="mt-6 flex justify-end gap-3">
            <button type="button" onClick={onClose} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
            <button type="button" onClick={() => setStage('passkey')} className="rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-500">Davom etish</button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-white/70">O'chirishni tasdiqlash uchun pass key kiriting.</p>
          {msg && <div className="mt-3"><Alert kind="error">{msg.text}</Alert></div>}
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => { e.preventDefault(); onDelete(); }}
          >
            <div>
              <label className="label">Pass key</label>
              {/* Not stored anywhere; cleared on close and after use. */}
              <input
                className="field"
                type="password"
                value={passKey}
                onChange={(e) => setPassKey(e.target.value)}
                autoComplete="off"
                required
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setStage('confirm')} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Orqaga</button>
              <button type="submit" disabled={busy || !passKey} className="rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-60">
                {busy ? 'Jarayonda...' : 'Qarz yozuvini butunlay o\'chirish'}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}