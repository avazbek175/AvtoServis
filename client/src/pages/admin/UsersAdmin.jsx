import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { useAdmin } from '../../store';
import Icon from '../../components/icons';
import { Alert, Modal, Toggle, Badge, ConfirmDialog, EmptyState, Spinner } from '../../components/ui';

const PERMISSIONS = [
  { key: 'content', label: 'Sayt sozlamalari' },
  { key: 'services', label: 'Xizmatlar' },
  { key: 'media', label: 'Media / Rasmlar' },
];

function parsePerms(u) {
  try {
    const p = JSON.parse(u.permissions || '[]');
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

export default function UsersAdmin() {
  const { user: me } = useAdmin();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  async function load() {
    setError('');
    try {
      const { users: u } = await api.get('/admin/users');
      setUsers(u);
    } catch (e) {
      setError(e.message);
      setUsers([]);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (me.role !== 'super_admin') {
    return <Alert>Sizda bu bo'limga kirish huquqi yo'q.</Alert>;
  }

  async function toggleActive(u) {
    setBusy(true);
    setError('');
    try {
      await api.put('/admin/users/' + u.id, { is_active: u.is_active ? 0 : 1 });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setError('');
    try {
      await api.del('/admin/users/' + deleting.id);
      await load();
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
          <h1 className="text-2xl font-extrabold">Ustalar</h1>
          <p className="mt-1 text-sm text-white/50">Usta akkauntlarini boshqarish. Ustalar arizalar orqali yoki to'g'ridan-to'g'ri qo'shiladi.</p>
        </div>
        <button type="button" onClick={() => setEditing({})} className="btn-primary">
          <Icon name="pluss" size={17} /> Usta qo'shish
        </button>
      </div>

      {error && <Alert>{error}</Alert>}

      <div className="card !p-0 overflow-hidden">
        {!users ? (
          <div className="flex justify-center py-14"><Spinner /></div>
        ) : users.length === 0 ? (
          <EmptyState icon="user" title="Foydalanuvchilar yo'q" />
        ) : (
          <div className="divide-y divide-white/5">
            {users.map((u) => {
              const isSA = u.role === 'super_admin';
              return (
                <div key={u.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <span className={`flex h-11 w-11 items-center justify-center rounded-xl text-white ${isSA ? 'bg-gradient-to-br from-[rgb(var(--c-primary))] to-[rgb(var(--c-secondary))]' : 'bg-sky-500'}`}>
                    <Icon name={isSA ? 'lock' : 'user'} size={19} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-white">{u.full_name || u.username} {u.id === me.id && <span className="text-xs font-normal text-white/40">(siz)</span>}</span>
                      {isSA ? <Badge kind="danger">Super admin</Badge> : <Badge kind="default">Usta</Badge>}
                      {u.is_active ? <Badge kind="success">Faol</Badge> : <Badge kind="warn">Bloklangan</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-white/45">@{u.username} · {u.email}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Toggle checked={!!u.is_active} onChange={() => toggleActive(u)} disabled={u.id === me.id || isSA} />
                    {!isSA && (
                      <>
                        <button type="button" onClick={() => setEditing({ ...u, _perms: parsePerms(u) })} className="rounded-lg p-2 text-white/50 hover:bg-white/10 hover:text-white" title="Tahrirlash"><Icon name="edit" size={17} /></button>
                        <button type="button" onClick={() => setDeleting(u)} disabled={u.id === me.id} className="rounded-lg p-2 text-white/50 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-30" title="O'chirish"><Icon name="trash" size={17} /></button>
                      </>
                    )}
                    {isSA && u.id === me.id && (
                      <span className="text-xs text-white/35">Super adminni o'zgartirib bo'lmaydi</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editing && (
        <UserForm
          me={me}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); setBusy(true); setTimeout(() => setBusy(false), 300); }}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Ustani o'chirish"
        message={`"${deleting?.username}" hisobi o'chiriladi. U bu bilan master panelga kira olmaydi. Davom etasizmi?`}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
        busy={busy}
      />
    </div>
  );
}

function UserForm({ initial, onClose, onSaved, me }) {
  const isEdit = !!initial.id;
  const [form, setForm] = useState({
    full_name: initial.full_name || initial.username || '',
    username: initial.username || '',
    email: initial.email || '',
    password: '',
    is_active: initial.is_active === false || initial.is_active === 0 ? 0 : 1,
    permissions: initial._perms || ['content', 'services', 'media'],
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const payload = { ...form };
      if (!payload.password) delete payload.password;
      if (isEdit) {
        await api.put('/admin/users/' + initial.id, payload);
      } else {
        await api.post('/admin/users', payload);
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const togglePerm = (key) => {
    const has = form.permissions.includes(key);
    setForm({
      ...form,
      permissions: has ? form.permissions.filter((p) => p !== key) : [...form.permissions, key],
    });
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal open onClose={onClose} title={isEdit ? 'Ustani tahrirlash' : 'Yangi usta qo\'shish'}>
      <form onSubmit={save} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Ism va familiya *</label>
            <input className="field" value={form.full_name} onChange={set('full_name')} required />
          </div>
          <div>
            <label className="label">Login *</label>
            <input className="field" value={form.username} onChange={set('username')} required />
          </div>
        </div>

        <div>
          <label className="label">Email *</label>
          <input type="email" className="field" value={form.email} onChange={set('email')} required />
        </div>

        <div>
          <label className="label">{isEdit ? 'Yangi parol (bo\'sh qoldirilsa o\'zgarmaydi)' : 'Parol *'}</label>
          <input type="password" className="field" minLength={8} value={form.password} onChange={set('password')} required={!isEdit} placeholder="Kamida 8 belgi" />
        </div>

        <div>
          <label className="label">Rol</label>
          <select className="field" value="master" disabled>
            <option value="master" className="bg-[#111725]">Usta (cheklangan huquq)</option>
          </select>
          <p className="mt-1 text-xs text-white/40">Super admin faqat dastlabki sozlashda yaratiladi.</p>
        </div>

        <div>
          <label className="label">Huquqlar</label>
          <div className="space-y-2 rounded-xl border border-white/5 bg-white/[0.03] p-4">
            {PERMISSIONS.map((p) => (
              <label key={p.key} className="flex cursor-pointer items-center justify-between">
                <span className="text-sm text-white/80">{p.label}</span>
                <Toggle checked={form.permissions.includes(p.key)} onChange={() => togglePerm(p.key)} label={p.label} />
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
          <div>
            <div className="text-sm font-medium text-white/80">Hisob faolligi</div>
            <div className="text-xs text-white/40">{form.is_active ? 'Faol — panelga kira oladi' : 'Bloklangan — kira olmaydi'}</div>
          </div>
          <Toggle checked={!!form.is_active} onChange={(v) => setForm({ ...form, is_active: v ? 1 : 0 })} />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
          <button type="submit" disabled={saving} className="btn-primary !py-2.5 text-sm disabled:opacity-60">{saving ? 'Saqlanmoqda...' : isEdit ? 'Saqlash' : 'Qo\'shish'}</button>
        </div>
      </form>
    </Modal>
  );
}