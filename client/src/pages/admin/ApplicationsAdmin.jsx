import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { useAdmin } from '../../store';
import Icon from '../../components/icons';
import { Loading, Alert, Badge, Modal, EmptyState, Spinner } from '../../components/ui';

const FILTERS = [
  { key: '', label: 'Barchasi' },
  { key: 'pending', label: 'Kutilmoqda' },
  { key: 'approved', label: 'Qabul qilindi' },
  { key: 'rejected', label: 'Rad etildi' },
];

const STATUS_BADGE = {
  pending: { kind: 'warn', label: 'Kutilmoqda' },
  approved: { kind: 'success', label: 'Qabul qilindi' },
  rejected: { kind: 'danger', label: 'Rad etildi' },
};

export default function ApplicationsAdmin() {
  const { user } = useAdmin();
  const [apps, setApps] = useState(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [notice, setNotice] = useState(null);
  const [reason, setReason] = useState('');
  const [expandId, setExpandId] = useState(null);

  async function load() {
    setError('');
    try {
      const q = filter ? `?status=${filter}` : '';
      const { applications } = await api.get('/admin/applications' + q);
      setApps(applications);
    } catch (e) {
      setError(e.message);
      setApps([]);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  if (user.role !== 'super_admin') {
    return <Alert>Sizda bu bo'limga kirish huquqi yo'q.</Alert>;
  }

  async function confirmApprove() {
    setBusy(true);
    setError('');
    try {
      const { user: created } = await api.post(`/admin/applications/${approving.id}/approve`);
      setNotice(`"${created.username}" ustasi akkaunti yaratildi va ariza qabul qilindi.`);
      setApproving(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmReject() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/admin/applications/${rejecting.id}/reject`, { reason });
      setNotice(`"${rejecting.full_name}" arizasi rad etildi.`);
      setRejecting(null);
      setReason('');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Usta arizalari</h1>
        <p className="mt-1 text-sm text-white/50">Usta bo'lish uchun yuborilgan arizalarni ko'rib chiqing, qabul qiling yoki rad eting.</p>
      </div>

      {notice && <Alert kind="success">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${filter === f.key ? 'bg-[rgb(var(--c-primary))] text-white' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {!apps ? (
          <div className="card flex justify-center py-14"><Spinner /></div>
        ) : apps.length === 0 ? (
          <div className="card">
            <EmptyState icon="document" title="Arizalar yo'q" hint="Bu filtr bo'yicha ariza topilmadi." />
          </div>
        ) : (
          apps.map((a) => {
            const st = STATUS_BADGE[a.status] || STATUS_BADGE.pending;
            return (
              <div key={a.id} className="card p-5">
                <div className="flex flex-wrap items-center gap-4">
                  <span className={`flex h-11 w-11 items-center justify-center rounded-xl text-white ${a.status === 'approved' ? 'bg-emerald-600' : a.status === 'rejected' ? 'bg-red-600' : 'bg-[rgb(var(--c-primary))]'}`}>
                    <Icon name="document" size={19} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-white">{a.full_name}</span>
                      <Badge kind={st.kind}>{st.label}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-white/45">@ {a.username} · {a.specialty}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {a.status === 'pending' && (
                      <>
                        <button type="button" onClick={() => setApproving(a)} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500">Qabul qilish</button>
                        <button type="button" onClick={() => setRejecting(a)} className="rounded-xl border border-red-500/40 px-4 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-500/10">Rad etish</button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setExpandId(expandId === a.id ? null : a.id)}
                      className="rounded-lg p-2 text-white/50 hover:bg-white/10 hover:text-white"
                      aria-label="Ma'lumot"
                    >
                      <Icon name={expandId === a.id ? 'chevronup' : 'chevronright'} size={17} />
                    </button>
                  </div>
                </div>

                {(expandId === a.id || a.status !== 'pending') && (
                  <div className="mt-4 grid gap-x-6 gap-y-2 border-t border-white/5 pt-4 text-sm sm:grid-cols-2">
                    <div><span className="text-white/40">Telefon: </span><span className="text-white/85">{a.phone}</span></div>
                    <div><span className="text-white/40">Email: </span><span className="text-white/85">{a.email}</span></div>
                    <div><span className="text-white/40">Mutaxassisligi: </span><span className="text-white/85">{a.specialty}</span></div>
                    <div><span className="text-white/40">Yuborilgan sana: </span><span className="text-white/85">{a.created_at}</span></div>
                    {a.message && (
                      <div className="sm:col-span-2">
                        <span className="text-white/40">Qo'shimcha ma'lumot:</span>
                        <p className="mt-1 whitespace-pre-wrap rounded-xl bg-white/[0.03] px-4 py-3 text-white/80">{a.message}</p>
                      </div>
                    )}
                    {(a.status === 'approved' || a.status === 'rejected') && (
                      <div className="sm:col-span-2">
                        <span className="text-white/40">{a.status === 'approved' ? "Ko'rib chiqilgan: " : 'Rad etilgan: '}</span>
                        <span className="text-white/85">{a.reviewed_by_name || 'Super admin'} · {a.reviewed_at}</span>
                        {a.status === 'rejected' && a.rejection_reason && (
                          <p className="mt-1 rounded-xl bg-red-500/10 px-4 py-3 text-red-300">Sabab: {a.rejection_reason}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <Modal open={!!approving} onClose={() => setApproving(null)} title="Arizani qabul qilish">
        <div className="space-y-4">
          <Alert kind="info">
            "{approving?.full_name}" arizasi tasdiqlanadi va <b>usta</b> roli bilan faol akkaunt yaratiladi. U super admin emas va arizalarni tasdiqlay olmaydi.
          </Alert>
          <div className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-sm text-white/80">
            <div>Login: {approving?.username}</div>
            <div className="mt-1">Email: {approving?.email}</div>
            <div className="mt-1">Mutaxassisligi: {approving?.specialty}</div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setApproving(null)} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
            <button type="button" onClick={confirmApprove} disabled={busy} className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-60">
              {busy ? 'Jarayonda...' : 'Qabul qilish'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title="Arizani rad etish">
        <div className="space-y-4">
          <Alert kind="info">
            "{rejecting?.full_name}" arizasi rad etiladi. Bu holda akkaunt yaratilmaydi va ariza egasi tizimga kira olmaydi.
          </Alert>
          {error && <Alert>{error}</Alert>}
          <div>
            <label className="label">Rad etish sababi (ixtiyoriy)</label>
            <textarea className="field min-h-[90px]" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Masalan: hozircha mutaxassis still qo'shilmagan" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setRejecting(null)} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
            <button type="button" onClick={confirmReject} disabled={busy} className="rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-60">
              {busy ? 'Jarayonda...' : 'Rad etish'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}