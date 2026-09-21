import React, { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAdmin, useSite } from '../../store';
import { api } from '../../api';
import Icon from '../../components/icons';
import { Spinner, Modal, Alert } from '../../components/ui';

const NAV = [
  { to: '/admin', end: true, icon: 'dashboard', label: 'Dashboard' },
  { to: '/admin/services', icon: 'wrench', label: 'Xizmatlar' },
  { to: '/admin/settings', icon: 'settings', label: 'Sayt sozlamalari' },
  { to: '/admin/hero', icon: 'spark', label: 'Hero bo\'limi' },
  { to: '/admin/about', icon: 'heart', label: 'Biz haqimizda' },
  { to: '/admin/contact', icon: 'pin', label: 'Aloqa ma\'lumotlari' },
  { to: '/admin/footer', icon: 'layout', label: 'Footer' },
  { to: '/admin/design', icon: 'eye', label: 'Dizayn' },
  { to: '/admin/applications', icon: 'document', label: 'Usta arizalari', adminOnly: true },
  { to: '/admin/users', icon: 'user', label: 'Ustalar', adminOnly: true },
  { to: '/admin/worklogs', icon: 'document', label: 'Bajarilgan ishlar' },
  { to: '/admin/media', icon: 'image', label: 'Media / Rasmlar' },
];

export default function AdminLayout() {
  const { user, logout } = useAdmin();
  const { siteLoading } = useSite();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const navigate = useNavigate();

  async function doLogout() {
    setConfirm(false);
    await logout();
    navigate('/admin/login', { replace: true });
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-[#0b0f17] text-white lg:flex">
      {siteLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0b0f17]/80 backdrop-blur-sm">
          <Spinner className="h-10 w-10" />
        </div>
      )}

      <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-white/5 bg-[#0e1420] transition-transform lg:static lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="relative flex h-16 items-center gap-2.5 border-b border-white/5 px-5">
          <span className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[rgb(var(--c-primary))]/60 to-transparent" aria-hidden="true" />
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[rgb(var(--c-primary))] to-[rgb(var(--c-secondary))] text-white shadow-lg shadow-[rgb(var(--c-primary))/25]">
            <Icon name="wrench" size={18} />
          </span>
          <div>
            <div className="text-sm font-extrabold leading-tight tracking-tight">Admin Panel</div>
            <div className="text-[11px] text-white/40">{user.role === 'super_admin' ? 'Super admin' : 'Usta'}</div>
          </div>
          <button type="button" className="ml-auto rounded-lg p-1.5 text-white/50 hover:bg-white/10 lg:hidden" onClick={() => setSidebarOpen(false)} aria-label="Yopish">
            <Icon name="close" size={18} />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {NAV.filter((n) => !n.adminOnly || user.role === 'super_admin').map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-all ${isActive ? 'bg-[rgb(var(--c-primary))] text-white shadow-lg shadow-[rgb(var(--c-primary))/25]' : 'text-white/60 hover:bg-white/5 hover:text-white'}`
              }
            >
              <Icon name={n.icon} size={18} />
              {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-white/5 p-3 space-y-1">
          <button type="button" onClick={() => setPwdOpen(true)} className="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium text-white/60 transition hover:bg-white/5 hover:text-white">
            <Icon name="lock" size={18} />
            Parolni o'zgartirish
          </button>
          <button type="button" onClick={() => setConfirm(true)} className="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium text-red-400/80 transition hover:bg-red-500/10 hover:text-red-300">
            <Icon name="logout" size={18} />
            Chiqish
          </button>
        </div>
      </aside>

      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setSidebarOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-white/5 bg-[#0b0f17]/90 px-4 backdrop-blur-lg sm:px-6">
          <button type="button" className="rounded-lg p-2 text-white/70 hover:bg-white/10 lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Menyu">
            <Icon name="menu" size={20} />
          </button>
          <h1 className="text-sm font-semibold text-white/80">Boshqaruv paneli</h1>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60 sm:block">{user.username}</span>
            <a href="/" className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs font-medium text-white/70 transition hover:bg-white/5" target="_blank" rel="noreferrer">
              <Icon name="home" size={14} />
              Saytni ko'rish
            </a>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>

      <ConfirmLogout open={confirm} onCancel={() => setConfirm(false)} onConfirm={doLogout} />
      <ChangePasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </div>
  );
}

function ConfirmLogout({ open, onCancel, onConfirm }) {
  return (
    <Modal open={open} onClose={onCancel} title="Chiqish">
      <p className="text-sm text-white/70">Haqiqatan ham tizimdan chiqmoqchimisiz?</p>
      <div className="mt-6 flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
        <button type="button" onClick={onConfirm} className="rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-500">Chiqish</button>
      </div>
    </Modal>
  );
}

function ChangePasswordModal({ open, onClose }) {
  const [form, setForm] = useState({ current_password: '', new_password: '' });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await api.post('/admin/change-password', form);
      setMsg({ kind: 'success', text: 'Parol muvaffaqiyatli o\'zgartirildi' });
      setForm({ current_password: '', new_password: '' });
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Parolni o'zgartirish">
      <form onSubmit={onSubmit} className="space-y-4">
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <div>
          <label className="label">Joriy parol</label>
          <input type="password" className="field" value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} required />
        </div>
        <div>
          <label className="label">Yangi parol (kamida 8 belgi)</label>
          <input type="password" className="field" minLength={8} value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} required />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-white/80 hover:bg-white/5">Bekor qilish</button>
          <button type="submit" disabled={busy} className="btn-primary !py-2.5 text-sm disabled:opacity-60">{busy ? 'Jarayonda...' : 'Saqlash'}</button>
        </div>
      </form>
    </Modal>
  );
}