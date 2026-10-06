import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useAdmin } from '../../store';
import Icon from '../../components/icons';
import { Loading, Alert, Badge, Modal, Toggle, ConfirmDialog, EmptyState, Spinner } from '../../components/ui';
import { SERVICE_NAMES } from '../../serviceCatalog';

const SERVICE_TYPES = SERVICE_NAMES;
const STATUSES = ['Jarayonda', 'Tugallangan'];

function fmt(c) {
  return new Intl.NumberFormat('uz-UZ').format(Number(c) || 0) + ' so\'m';
}

export default function WorkLogs() {
  const { user } = useAdmin();
  const isSA = user.role === 'super_admin';

  const [worklogs, setWorklogs] = useState(null);
  const [stats, setStats] = useState(null);
  const [masters, setMasters] = useState([]);
  const [publicShow, setPublicShow] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ q: '', service_type: '', status: '', date_from: '', date_to: '', master_id: '' });
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [savingPublic, setSavingPublic] = useState(false);

  useEffect(() => {
    loadStats();
    if (isSA) {
      api.get('/admin/users').then(({ users }) => setMasters(users.filter((u) => u.role === 'master'))).catch(() => {});
      api.get('/admin/settings/worklog').then(({ settings }) => setPublicShow(settings.public_show === true)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSA]);

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  async function loadList() {
    setError('');
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
      const q = params.toString();
      const { worklogs: list } = await api.get('/admin/worklogs' + (q ? '?' + q : ''));
      setWorklogs(list);
    } catch (e) {
      setError(e.message);
      setWorklogs([]);
    }
  }

  async function loadStats() {
    try {
      const { stats: s } = await api.get('/admin/worklogs/stats');
      setStats(s);
    } catch {
      setStats(null);
    }
  }

  function setFilter(k, v) {
    setFilters((f) => ({ ...f, [k]: v }));
  }

  async function togglePublic() {
    setSavingPublic(true);
    setError('');
    try {
      await api.put('/admin/settings/worklog', { value: { public_show: !publicShow } });
      setPublicShow((v) => !v);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingPublic(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setError('');
    try {
      await api.del('/admin/worklogs/' + deleting.id);
      setDeleting(null);
      await Promise.all([loadList(), loadStats()]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const filtered = worklogs;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">{isSA ? 'Barcha bajarilgan ishlar' : 'Mening ishlarim'}</h1>
          <p className="mt-1 text-sm text-white/50">
            {isSA
              ? 'Barcha ustalarning bajargan ishlari, rasmlari va statistika.'
              : 'Bajargan ishlaringizni yozib boring, natijalarni kuzating.'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isSA && (
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white/70">
              <span className="text-sm text-white/80">Saytda ko'rsatish</span>
              <Toggle checked={publicShow} onChange={togglePublic} disabled={savingPublic} label="Saytda ko'rsatish" />
            </label>
          )}
          <button type="button" onClick={() => setEditing({})} className="btn-primary">
            <Icon name="pluss" size={17} /> Yangi ish qo'shish
          </button>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      {stats && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <StatCard icon="document" label="Jami ishlar" value={stats.total} color="bg-[rgb(var(--c-primary))]" />
          <StatCard icon="check" label="Tugallangan" value={stats.completed} color="bg-emerald-500" />
          <StatCard icon="clock" label="Jarayonda" value={stats.inProgress} color="bg-amber-500" />
          <StatCard icon="money" label="Umumiy daromad" value={fmt(stats.earnings)} color="bg-sky-500" small />
        </div>
      )}

      <div className="card flex flex-wrap items-end gap-3 !p-4">
        <div className="min-w-[200px] flex-1">
          <label className="label">Qidirish (nomi / mijoz / model)</label>
          <input className="field" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} placeholder="Masalan: Chevrolet, Ali..." />
        </div>
        <div>
          <label className="label">Xizmat turi</label>
          <select className="field" value={filters.service_type} onChange={(e) => setFilter('service_type', e.target.value)}>
            <option value="" className="bg-[#111725]">Barchasi</option>
            {SERVICE_TYPES.map((s) => <option key={s} value={s} className="bg-[#111725]">{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Holat</label>
          <select className="field" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="" className="bg-[#111725]">Barchasi</option>
            {STATUSES.map((s) => <option key={s} value={s} className="bg-[#111725]">{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Boshlanish sanasi</label>
          <input type="date" className="field" value={filters.date_from} onChange={(e) => setFilter('date_from', e.target.value)} />
        </div>
        <div>
          <label className="label">Tugash sanasi</label>
          <input type="date" className="field" value={filters.date_to} onChange={(e) => setFilter('date_to', e.target.value)} />
        </div>
        {isSA && (
          <div>
            <label className="label">Usta</label>
            <select className="field" value={filters.master_id} onChange={(e) => setFilter('master_id', e.target.value)}>
              <option value="" className="bg-[#111725]">Barcha ustalar</option>
              {masters.map((m) => <option key={m.id} value={m.id} className="bg-[#111725]">{m.full_name || m.username}</option>)}
            </select>
          </div>
        )}
      </div>

      {!worklogs ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState icon="document" title="Ishlar yo'q" hint="Yangi ish qo'shish tugmasini bosing yoki filtrlarni o'zgartiring." />
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((w) => (
            <WorkCard
              key={w.id}
              w={w}
              isSA={isSA}
              onEdit={() => setEditing({ ...w, _images: w.images })}
              onDelete={() => setDeleting(w)}
              onOpenLightbox={(images, index) => setLightbox({ images, index })}
              reload={async () => { await Promise.all([loadList(), loadStats()]); }}
              onError={(m) => setError(m)}
            />
          ))}
        </div>
      )}

      {editing && (
        <WorkForm
          isSA={isSA}
          initial={editing}
          masters={masters}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await Promise.all([loadList(), loadStats()]); }}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Ishni o'chirish"
        message={`"${deleting?.title}" yozuvi va barcha rasmlari o'chiriladi. Davom etasizmi?`}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
        busy={busy}
      />

      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function StatCard({ icon, label, value, color, small }) {
  return (
    <div className="card flex items-center gap-4 p-5">
      <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white shadow-lg ${color}`}>
        <Icon name={icon} size={22} />
      </span>
      <div className="min-w-0">
        <div className={`truncate font-extrabold tracking-tight text-white ${small ? 'text-base' : 'text-2xl'}`}>{value}</div>
        <div className="text-xs text-white/50">{label}</div>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  return <Badge kind={status === 'Tugallangan' ? 'success' : 'warn'}>{status}</Badge>;
}

function WorkCard({ w, isSA, onEdit, onDelete, onOpenLightbox, reload, onError }) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold text-white">{w.title}</h3>
            <Badge kind="default">{w.service_type}</Badge>
            <StatusBadge status={w.status} />
            {w.is_public ? <Badge kind="primary">Saytda</Badge> : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/50">
            {isSA && <span>👤 {w.master_name || 'Usta'}</span>}
            {(w.car_brand || w.car_model) && <span>🚗 {[w.car_brand, w.car_model].filter(Boolean).join(' ')}</span>}
            {w.car_number && <span>#{w.car_number}</span>}
            {w.customer_name && <span>Mijoz: {w.customer_name}</span>}
            {w.start_date && <span>📅 {w.start_date}</span>}
            {Number(w.price) > 0 && <span className="font-semibold text-emerald-400">{fmt(w.price)}</span>}
          </div>
          {w.description && <p className="mt-2 line-clamp-2 text-sm text-white/60">{w.description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={onEdit} className="rounded-lg p-2 text-white/50 hover:bg-white/10 hover:text-white" title="Tahrirlash">
            <Icon name="edit" size={17} />
          </button>
          <button type="button" onClick={onDelete} disabled={busy} className="rounded-lg p-2 text-white/50 hover:bg-red-500/10 hover:text-red-400" title="O'chirish">
            <Icon name="trash" size={17} />
          </button>
        </div>
      </div>

      {w.images && w.images.length > 0 && (
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {w.images.map((img, i) => (
            <button
              key={img.id}
              type="button"
              onClick={() => onOpenLightbox(w.images, i)}
              className="group relative aspect-square overflow-hidden rounded-xl border border-white/5"
            >
              <img src={`/api/workimages/${img.image_path}`} alt={img.original_filename} className="h-full w-full object-cover transition duration-200 group-hover:scale-105" />
              <span className="absolute inset-0 bg-black/0 transition group-hover:bg-black/20" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY_FORM = {
  title: '', customer_name: '', customer_phone: '', car_brand: '', car_model: '', car_number: '',
  service_type: '', description: '', start_date: '', end_date: '', price: '', status: 'Jarayonda',
  notes: '', is_public: false, master_id: '',
};

function WorkForm({ isSA, initial, masters, onClose, onSaved }) {
  const isEdit = !!initial.id;
  const [form, setForm] = useState({ ...EMPTY_FORM, master_id: masters.length ? masters[0].id : '', ...initial, is_public: !!initial.is_public });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [images, setImages] = useState(initial._images || initial.images || []);
  const [busyImg, setBusyImg] = useState(false);
  const [pending, setPending] = useState([]);
  const [products, setProducts] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [matErr, setMatErr] = useState('');
  const fileRef = useRef(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (!isSA) return undefined;
    let alive = true;
    api.get('/admin/inventory/products?filter=active&per_page=100&sort=name')
      .then(({ products }) => { if (alive) setProducts(products || []); })
      .catch(() => { if (alive) setMatErr('Ombor mahsulotlarini yuklab bo‘lmadi'); });
    return () => { alive = false; };
  }, []);

  function addMaterial() {
    const used = materials.map((m) => m.product_id);
    const next = products.find((p) => p.is_active && !used.includes(p.id));
    if (!next) { setMatErr('Omborga qo‘shilgan barcha mahsulotlar tanlab olingan'); return; }
    setMatErr('');
    setMaterials((m) => [...m, { product_id: next.id, quantity: '', note: '' }]);
  }

  function setMaterial(i, k, v) {
    setMaterials((m) => m.map((row, idx) => (idx === i ? { ...row, [k]: v } : row)));
  }

  function removeMaterial(i) {
    setMaterials((m) => m.filter((_, idx) => idx !== i));
  }

  function pickFiles(e) {
    const files = Array.from(e.target.files || []);
    setPending((p) => [...p, ...files.map((f) => ({ file: f, url: URL.createObjectURL(f) }))]);
    if (fileRef.current) fileRef.current.value = '';
  }

  function removePending(idx) {
    setPending((p) => p.filter((_, i) => i !== idx));
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    const lines = [];
    for (let i = 0; i < materials.length; i++) {
      const q = Number(String(materials[i].quantity).replace(',', '.'));
      if (!Number.isFinite(q) || q <= 0) {
        setError(`Material ${i + 1}: miqdor 0 dan katta bo‘lishi kerak`);
        return;
      }
      lines.push({ product_id: materials[i].product_id, quantity: q, note: materials[i].note.trim() || undefined });
    }
    setSaving(true);
    try {
      const payload = { ...form };
      // is_public faqat super admin tomonidan boshqariladi; usta yubormasligi kerak,
      // aks holda server uni 403 bilan rad etadi (server alohida tekshiradi).
      if (isSA) {
        payload.is_public = form.is_public ? 1 : 0;
      } else {
        delete payload.is_public;
      }
      if (isEdit) {
        await api.put('/admin/worklogs/' + initial.id, payload);
      } else {
        // Material harakatlari serverda work log bilan bitta transaction ichida
        // yoziladi; yetarli stock bo'lmasa butun ish yozuvi rollback bo'ladi.
        if (lines.length) payload.materials = lines;
        await api.post('/admin/worklogs', payload);
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function uploadPending() {
    if (pending.length === 0) return;
    setBusyImg(true);
    setError('');
    try {
      const fd = new FormData();
      pending.forEach((p) => fd.append('files', p.file));
      const r = await api.post(`/admin/worklogs/${initial.id}/images`, fd);
      setImages(r.images || []);
      pending.forEach((p) => URL.revokeObjectURL(p.url));
      setPending([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyImg(false);
    }
  }

  async function deleteImage(img) {
    setBusyImg(true);
    setError('');
    try {
      const r = await api.del(`/admin/worklogs/images/${img.id}`);
      setImages(r.images || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyImg(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isEdit ? 'Ishni tahrirlash' : 'Yangi ish qo\'shish'} wide>
      <form onSubmit={save} className="space-y-4">
        {error && <Alert>{error}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Ish nomi *</label>
            <input className="field" value={form.title} onChange={set('title')} placeholder="Masalan: Dvigatel kapital taimirlash" required />
          </div>
          {isSA && !isEdit && (
            <div className="sm:col-span-2">
              <label className="label">Ish bajaruvchi usta *</label>
              <select className="field" value={form.master_id} onChange={set('master_id')}>
                {masters.map((m) => <option key={m.id} value={m.id} className="bg-[#111725]">{m.full_name || m.username}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="label">Mijoz ismi</label>
            <input className="field" value={form.customer_name} onChange={set('customer_name')} placeholder="Ali Valiyev" />
          </div>
          <div>
            <label className="label">Mijoz telefoni</label>
            <input className="field" value={form.customer_phone} onChange={set('customer_phone')} placeholder="+998 90 000 00 00" />
          </div>
          <div>
            <label className="label">Avtomobil markasi</label>
            <input className="field" value={form.car_brand} onChange={set('car_brand')} placeholder="Chevrolet" />
          </div>
          <div>
            <label className="label">Avtomobil modeli</label>
            <input className="field" value={form.car_model} onChange={set('car_model')} placeholder="Cobalt" />
          </div>
          <div>
            <label className="label">Davlat raqami</label>
            <input className="field" value={form.car_number} onChange={set('car_number')} placeholder="01 A 777 AA" />
          </div>
          <div>
            <label className="label">Xizmat turi *</label>
            <select className="field" value={form.service_type} onChange={set('service_type')} required>
              <option value="" className="bg-[#111725]">Tanlang...</option>
              {SERVICE_TYPES.map((s) => <option key={s} value={s} className="bg-[#111725]">{s}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Ish boshlanish sanasi</label>
            <input type="date" className="field" value={form.start_date} onChange={set('start_date')} />
          </div>
          <div>
            <label className="label">Ish tugash sanasi</label>
            <input type="date" className="field" value={form.end_date} onChange={set('end_date')} />
          </div>
          <div>
            <label className="label">Ish narxi (so'm)</label>
            <input type="number" min="0" className="field" value={form.price} onChange={set('price')} placeholder="550000" />
          </div>
          <div>
            <label className="label">Ish holati *</label>
            <select className="field" value={form.status} onChange={set('status')}>
              {STATUSES.map((s) => <option key={s} value={s} className="bg-[#111725]">{s}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="label">Bajarilgan ish tavsifi</label>
          <textarea className="field min-h-[90px]" value={form.description} onChange={set('description')} placeholder="Qanday ishlar bajarildi, qanday qismlar almashtirildi..." />
        </div>

        {!isEdit && isSA && (
          <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <label className="label !mb-0">Ombor mahsulotlari ({materials.length})</label>
                <p className="mt-1 text-xs text-white/40">Ishni saqlashda ombor qoldig‘i avtomatik kamayadi</p>
              </div>
              <button type="button" onClick={addMaterial} className="btn-outline !py-2 text-xs">
                <Icon name="box" size={15} /> Qo‘shish
              </button>
            </div>
            {matErr && <Alert>{matErr}</Alert>}
            {materials.length === 0 ? (
              <p className="py-2 text-xs text-white/35">Mahsulot tanlanmagan</p>
            ) : (
              <div className="space-y-2">
                {materials.map((m, i) => {
                  const p = products.find((x) => x.id === m.product_id);
                  const unit = p ? (p.unit === 'liter' ? 'litr' : 'dona') : '';
                  const low = p && Number(p.current_quantity) <= 0;
                  return (
                    <div key={m.product_id} className="grid gap-2 sm:grid-cols-[1fr_120px_1fr_auto] sm:items-start">
                      <div className="text-sm text-white/80">
                        <span className="block truncate">{p ? p.name : `#${m.product_id}`}</span>
                        {p && (
                          <span className={`text-xs ${low ? 'text-rose-400' : 'text-white/40'}`}>
                            Qoldiq: {Number(p.current_quantity).toLocaleString('uz-UZ')} {unit}
                          </span>
                        )}
                      </div>
                      <div>
                        <input
                          type="number" min="0.001" step="0.001" className="field" value={m.quantity}
                          onChange={(e) => setMaterial(i, 'quantity', e.target.value)}
                          placeholder={`Miqdor${unit ? ` (${unit})` : ''}`}
                        />
                      </div>
                      <div>
                        <input className="field" value={m.note} onChange={(e) => setMaterial(i, 'note', e.target.value)} placeholder="Izoh (ixtiyoriy)" />
                      </div>
                      <button
                        type="button" onClick={() => removeMaterial(i)}
                        className="self-center rounded-lg border border-white/10 px-2.5 py-2 text-xs text-white/60 hover:border-rose-500/40 hover:text-rose-300"
                        aria-label="Materialni olib tashlash"
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {isSA && Array.isArray(initial.materials) && initial.materials.length > 0 && (
          <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
            <label className="label !mb-2">Sarflangan mahsulotlar</label>
            <div className="space-y-1">
              {initial.materials.map((m, i) => {
                const p = products.find((x) => x.id === m.product_id);
                const unit = p ? (p.unit === 'liter' ? 'litr' : 'dona') : '';
                return (
                  <div key={i} className="text-xs text-white/60">
                    {p ? p.name : `#${m.product_id}`} — {Number(m.quantity).toLocaleString('uz-UZ')} {unit}
                    {m.note ? ` (${m.note})` : ''}
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-white/35">Harakatlarni tahrirlash ombor sahifasidan bajariladi</p>
          </div>
        )}
        <div>
          <label className="label">Qo'shimcha izohlar</label>
          <textarea className="field min-h-[60px]" value={form.notes} onChange={set('notes')} placeholder="Kafolat, keyingi tavsiyalar va h.k." />
        </div>

        {isSA && (
          <label className="flex cursor-pointer items-center justify-between rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
            <span className="text-sm text-white/80">Saytda umumiy ko'rinishga chiqarish</span>
            <Toggle checked={!!form.is_public} onChange={(v) => setForm((f) => ({ ...f, is_public: v }))} label="Saytda ko'rsatish" />
          </label>
        )}

        {isEdit && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="label !mb-0">Rasmlar ({images.length})</label>
              <div className="flex items-center gap-2">
                <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" onChange={pickFiles} />
                <button
                  type="button"
                  onClick={() => fileRef.current && fileRef.current.click()}
                  className="btn-outline !py-2 text-xs"
                >
                  <Icon name="camera" size={15} /> Rasm tanlash
                </button>
                {pending.length > 0 && (
                  <button type="button" onClick={uploadPending} disabled={busyImg} className="btn-primary !py-2 text-xs disabled:opacity-60">
                    {busyImg ? <Spinner className="h-4 w-4" /> : `Yuklash (${pending.length})`}
                  </button>
                )}
              </div>
            </div>
            {images.length === 0 && pending.length === 0 ? (
              <p className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-center text-sm text-white/40">
                Hozircha rasm yo'q. Bajarilgan ish fotosuratlarini qo'shing (JPG, PNG, WEBP; har bir fayl maks 5MB).
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                {images.map((img) => (
                  <div key={img.id} className="group relative aspect-square overflow-hidden rounded-xl border border-white/5">
                    <img src={`/api/workimages/${img.image_path}`} alt={img.original_filename} className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => deleteImage(img)}
                      disabled={busyImg}
                      className="absolute right-1 top-1 rounded-lg bg-black/70 p-1.5 text-white/90 opacity-0 transition group-hover:opacity-100 hover:bg-red-600 disabled:opacity-40"
                      title="O'chirish"
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))}
                {pending.map((p, i) => (
                  <div key={i} className="relative aspect-square overflow-hidden rounded-xl border border-[rgb(var(--c-primary))]/40 ring-1 ring-[rgb(var(--c-primary))]/40">
                    <img src={p.url} alt="preview" className="h-full w-full object-cover" />
                    <button type="button" onClick={() => removePending(i)} className="absolute right-1 top-1 rounded-lg bg-black/70 p-1.5 text-white" title="Olib tashlash">
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!isEdit && (
          <p className="text-xs text-white/40">Ish saqlangandan keyin rasmlar qo'shishingiz mumkin bo'ladi.</p>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
          <button type="submit" disabled={saving} className="btn-primary !py-2.5 text-sm disabled:opacity-60">
            {saving ? 'Saqlanmoqda...' : isEdit ? 'Saqlash' : `Qo'shish`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Lightbox({ images, index, onClose }) {
  const [i, setI] = useState(index);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((v) => (v + 1) % images.length);
      if (e.key === 'ArrowLeft') setI((v) => (v - 1 + images.length) % images.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, onClose]);
  const img = images[i];
  if (!img) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <button className="absolute right-4 top-4 rounded-xl bg-white/10 p-2.5 text-white hover:bg-white/20" onClick={onClose} aria-label="Yopish">
        <Icon name="close" size={20} />
      </button>
      {images.length > 1 && (
        <>
          <button
            className="absolute left-3 top-1/2 -translate-y-1/2 rounded-xl bg-white/10 p-2.5 text-white hover:bg-white/20"
            onClick={(e) => { e.stopPropagation(); setI((v) => (v - 1 + images.length) % images.length); }}
            aria-label="Oldingi"
          >
            <Icon name="chevronleft" size={22} />
          </button>
          <button
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-xl bg-white/10 p-2.5 text-white hover:bg-white/20"
            onClick={(e) => { e.stopPropagation(); setI((v) => (v + 1) % images.length); }}
            aria-label="Keyingi"
          >
            <Icon name="chevronright" size={22} />
          </button>
        </>
      )}
      <img src={`/api/workimages/${img.image_path}`} alt={img.original_filename || 'Rasm'} className="max-h-[86vh] max-w-[92vw] rounded-xl object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
      {images.length > 1 && (
        <div className="absolute bottom-4 rounded-full bg-white/10 px-4 py-1.5 text-sm text-white">
          {i + 1} / {images.length}
        </div>
      )}
    </div>
  );
}