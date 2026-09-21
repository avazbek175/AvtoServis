import React, { useState } from 'react';
import { api } from '../../api';
import { useSite } from '../../store';
import Icon from '../../components/icons';
import { Spinner, Modal, Alert, Toggle, Badge, ConfirmDialog, EmptyState } from '../../components/ui';
import ImagePicker from '../../components/ImagePicker';

const ICONS = ['wrench', 'engine', 'diagnostic', 'chip', 'bolt', 'oil', 'spark', 'settings', 'check', 'heart', 'dashboard', 'image', 'pin', 'clock'];

export default function ServicesAdmin() {
  const { settings, services, reloadPublic } = useSite();
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const { services: s } = await api.get('/admin/services');
      setList(s);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    load();
  }, []);

  async function move(id, dir) {
    const idx = list.findIndex((s) => s.id === id);
    const target = idx + dir;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    const [item] = next.splice(idx, 1);
    next.splice(target, 0, item);
    setList(next);
    setBusy(true);
    try {
      await api.patch('/admin/services/reorder', { ids: next.map((s) => s.id) });
      await reloadPublic();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s) {
    const next = { ...s, is_active: s.is_active ? 0 : 1 };
    setList(list.map((x) => (x.id === s.id ? next : x)));
    setBusy(true);
    try {
      await api.put('/admin/services/' + s.id, { is_active: next.is_active });
      await reloadPublic();
    } catch (e) {
      setError(e.message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setError('');
    try {
      await api.del('/admin/services/' + deleting.id);
      await load();
      await reloadPublic();
      setDeleting(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">Xizmatlar</h1>
          <p className="mt-1 text-sm text-white/50">Xizmatlarni qo'shing, tahrirlang, tartibini va faolligini boshqaring.</p>
        </div>
        <button type="button" onClick={() => setEditing({ name: '', description: '', benefits: '', image: '', icon: 'wrench', price: '', is_active: 1 })} className="btn-primary">
          <Icon name="pluss" size={17} /> Yangi xizmat
        </button>
      </div>

      {error && <Alert>{error}</Alert>}

      <div className="card !p-0 overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-14"><Spinner /></div>
        ) : !list || list.length === 0 ? (
          <EmptyState icon="wrench" title="Xizmatlar yo'q" hint="Birinchi xizmatni qo'shish uchun “Yangi xizmat” tugmasini bosing." />
        ) : (
          <div className="divide-y divide-white/5">
            {list.map((s, i) => (
              <div key={s.id} className={`flex flex-wrap items-center gap-4 px-5 py-4 ${s.is_active ? '' : 'opacity-60'}`}>
                <div className="flex flex-col gap-0.5">
                  <button type="button" onClick={() => move(s.id, -1)} disabled={i === 0 || busy} className="rounded p-0.5 text-white/40 hover:bg-white/10 hover:text-white disabled:opacity-20" aria-label="Yuqoriga"><Icon name="chevronup" size={14} /></button>
                  <button type="button" onClick={() => move(s.id, 1)} disabled={i === list.length - 1 || busy} className="rounded p-0.5 text-white/40 hover:bg-white/10 hover:text-white disabled:opacity-20" aria-label="Pastga"><Icon name="chevrondown" size={14} /></button>
                </div>

                {s.image ? (
                  <img src={s.image} alt="" className="h-12 w-16 rounded-lg object-cover" />
                ) : (
                  <span className="flex h-12 w-16 items-center justify-center rounded-lg bg-white/5 text-[rgb(var(--c-primary))]">
                    <Icon name={s.icon || 'wrench'} size={20} />
                  </span>
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-white">{s.name}</span>
                    {s.price && <Badge kind="primary">{s.price}</Badge>}
                    {s.is_active ? <Badge kind="success">Faol</Badge> : <Badge kind="warn">Yopilgan</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-white/45">{s.description || 'Tavsif yo\'q'}</p>
                </div>

                <Toggle checked={!!s.is_active} onChange={() => toggle(s)} />

                <div className="flex gap-1.5">
                  <button type="button" onClick={() => setEditing({ ...s })} className="rounded-lg p-2 text-white/50 transition hover:bg-white/10 hover:text-white" title="Tahrirlash" aria-label="Tahrirlash">
                    <Icon name="edit" size={17} />
                  </button>
                  <button type="button" onClick={() => setDeleting(s)} className="rounded-lg p-2 text-white/50 transition hover:bg-red-500/10 hover:text-red-400" title="O'chirish" aria-label="O'chirish">
                    <Icon name="trash" size={17} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {(editing || deleting || busy) && (
        <>{editing && <ServiceForm initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); reloadPublic(); }} />}</>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Xizmatni o'chirish"
        message={`"${deleting?.name}" xizmati butunlay o'chiriladi. Davom etasizmi?`}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
        busy={busy}
      />
    </div>
  );
}

function ServiceForm({ initial, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: initial.name || '',
    description: initial.description || '',
    benefits: initial.benefits || '',
    image: initial.image || '',
    icon: initial.icon || 'wrench',
    price: initial.price || '',
    is_active: initial.is_active === false || initial.is_active === 0 ? 0 : 1,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) return setError('Xizmat nomi kiritilishi shart');
    setSaving(true);
    try {
      if (initial.id) {
        await api.put('/admin/services/' + initial.id, form);
      } else {
        await api.post('/admin/services', form);
      }
      onSaved(form);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal open onClose={onClose} title={initial.id ? 'Xizmatni tahrirlash' : 'Yangi xizmat'} wide>
      <form onSubmit={save} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Xizmat nomi *</label>
            <input className="field" value={form.name} onChange={set('name')} placeholder="Masalan: Mator xodovoy" required />
          </div>
          <div>
            <label className="label">Narxi (ixtiyoriy)</label>
            <input className="field" value={form.price} onChange={set('price')} placeholder="Masalan: 150 000 so'm" />
          </div>
        </div>

        <div>
          <label className="label">Tavsif</label>
          <textarea className="field min-h-[90px] resize-y" value={form.description} onChange={set('description')} placeholder="Xizmat haqida batafsil ma'lumot" />
        </div>

        <div>
          <label className="label">Afzalliklar (har biri yangi qatorda — | belgisi orqali ajrating)</label>
          <textarea className="field min-h-[70px] resize-y" value={form.benefits} onChange={set('benefits')} placeholder={'Kafolatli ta\'mirlash|Sifatli ehtiyot qismlar|Tezkor xizmat'} />
          <p className="mt-1 text-xs text-white/35">Har bir afzallik alohida, "|" belgisi bilan ajratiladi.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Belgi (ikonka)</label>
            <div className="flex flex-wrap gap-2">
              {ICONS.map((nm) => (
                <button
                  key={nm}
                  type="button"
                  onClick={() => setForm({ ...form, icon: nm })}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${form.icon === nm ? 'bg-[rgb(var(--c-primary))] text-white' : 'bg-white/5 text-white/50 hover:text-white'}`}
                  title={nm}
                >
                  <Icon name={nm} size={17} />
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-3 flex items-center justify-between">
              <label className="label !mb-0">Faollik</label>
              <Toggle checked={!!form.is_active} onChange={(v) => setForm({ ...form, is_active: v ? 1 : 0 })} />
            </div>
          </div>
        </div>

        <ImagePicker value={form.image} onChange={(url) => setForm({ ...form, image: url })} label="Xizmat rasmi" />

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
          <button type="submit" disabled={saving} className="btn-primary !py-2.5 text-sm disabled:opacity-60">
            {saving ? 'Saqlanmoqda...' : initial.id ? 'Saqlash' : 'Qo\'shish'}
          </button>
        </div>
      </form>
    </Modal>
  );
}