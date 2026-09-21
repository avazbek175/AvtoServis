import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useAdmin, useSite } from '../../store';
import Icon from '../../components/icons';
import { Loading, Alert, Badge } from '../../components/ui';

const CARDS = [
  { title: 'Dashboard', to: '/admin', icon: 'dashboard', color: 'text-sky-400 bg-sky-500/10' },
  { title: 'Xizmatlar', to: '/admin/services', icon: 'wrench', color: 'text-red-400 bg-red-500/10' },
  { title: 'Sayt sozlamalari', to: '/admin/settings', icon: 'settings', color: 'text-emerald-400 bg-emerald-500/10' },
  { title: 'Media / Rasmlar', to: '/admin/media', icon: 'image', color: 'text-amber-400 bg-amber-500/10' },
];

export default function Dashboard() {
  const { user } = useAdmin();
  const { settings } = useSite();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/admin/dashboard').then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading label="Dashboard yuklanmoqda..." />;

  const { stats, visible } = data;
  const isSA = user.role === 'super_admin';
  const statCards = [
    { label: 'Jami xizmatlar', value: stats.totalServices, icon: 'wrench', color: 'bg-[rgb(var(--c-primary))]', to: '/admin/services' },
    { label: 'Faol xizmatlar', value: stats.activeServices, icon: 'check', color: 'bg-emerald-500', to: '/admin/services' },
    ...(isSA
      ? [{ label: 'Ariza kutilmoqda', value: stats.pendingApplications, icon: 'document', color: 'bg-amber-500', to: '/admin/applications' }]
      : []),
    ...(isSA
      ? [{ label: 'Ustalar', value: stats.masters, icon: 'user', color: 'bg-sky-500', to: '/admin/users' }]
      : []),
    { label: 'Yuklangan rasmlar', value: stats.mediaCount, icon: 'image', color: 'bg-amber-500', to: '/admin/media' },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-extrabold">Assalomu alaykum, {user.username}!</h1>
        <p className="mt-1 text-sm text-white/50">Sayt holati va tezkor amallar quyida keltirilgan.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statCards.map((c) => (
          <Link key={c.label} to={c.to} className="card group p-5 transition-all duration-200 hover:-translate-y-1 hover:border-white/20">
            <div className="flex items-center gap-4">
              <span className={`flex h-12 w-12 items-center justify-center rounded-xl text-white shadow-lg transition-transform duration-200 group-hover:scale-110 ${c.color}`}>
                <Icon name={c.icon} size={22} />
              </span>
              <div>
                <div className="text-2xl font-extrabold tracking-tight">{c.value}</div>
                <div className="text-xs text-white/50">{c.label}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card p-6">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white/70">
            <Icon name="eye" size={16} /> Saytda ko'rinadigan bo'limlar
          </h2>
          <div className="space-y-3">
            {[
              { label: 'Hero (bosh sahifa)', on: visible.hero },
              { label: 'Xizmatlar bo\'limi', on: visible.services },
              { label: 'Biz haqimizda', on: visible.about },
            ].map((s) => (
              <div key={s.label} className="flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
                <span className="text-sm text-white/80">{s.label}</span>
                {s.on ? <Badge kind="success">Ko'rsatilmoqda</Badge> : <Badge kind="warn">Yashiringan</Badge>}
              </div>
            ))}
          </div>
        </div>

        <div className="card p-6">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white/70">
            <Icon name="spark" size={16} /> Tezkor amallar
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {CARDS.map((c) => (
              <Link key={c.to} to={c.to} className="group flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3.5 text-sm font-medium text-white/80 transition hover:border-[rgb(var(--c-primary))]/40 hover:text-white">
                <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${c.color}`}>
                  <Icon name={c.icon} size={17} />
                </span>
                {c.title}
                <Icon name="chevronright" size={15} className="ml-auto text-white/30 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-[rgb(var(--c-primary))]" />
              </Link>
            ))}
          </div>
          <p className="mt-4 text-xs text-white/35">Barcha sozlamalar serverda saqlanadi va saytga darhol qo'llaniladi.</p>
        </div>
      </div>

      {settings?.site?.name && (
        <div className="card flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <div className="text-sm font-semibold text-white/80">Sayt nomi: <span className="text-[rgb(var(--c-primary))]">{settings.site.name}</span></div>
            <div className="mt-0.5 text-xs text-white/40">Nomi, telefon va boshqa ma'lumotlarni "Sayt sozlamalari" bo'limidan o'zgartirish mumkin.</div>
          </div>
          <Link to="/admin/settings" className="btn-outline !py-2 text-xs">Sozlamalarni ochish</Link>
        </div>
      )}
    </div>
  );
}