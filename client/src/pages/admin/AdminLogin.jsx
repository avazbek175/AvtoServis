import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAdmin } from '../../store';
import { useSite } from '../../store';
import { api } from '../../api';
import Icon from '../../components/icons';
import { Alert, Spinner } from '../../components/ui';

const SPECIALTIES = ['Mator xodovoy', 'Diagnostika', 'Programma', 'Elektrik', 'Moy almashtirish'];

export default function AdminLogin() {
  const { user, login, setUser } = useAdmin();
  const { settings } = useSite();
  const [mode, setMode] = useState('login');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({
    username: '',
    password: '',
    su_name: '',
    su_username: '',
    su_email: '',
    su_password: '',
    app_name: '',
    app_phone: '',
    app_email: '',
    app_username: '',
    app_password: '',
    app_specialty: '',
    app_message: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const site = settings?.site || {};

  React.useEffect(() => {
    api.get('/auth/setup-status').then(({ needsSetup: n }) => setNeedsSetup(!!n));
  }, []);

  if (user) return <Navigate to="/admin" replace />;

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (needsSetup && mode === 'login') {
        const r = await api.post('/auth/setup', {
          full_name: form.su_name,
          username: form.su_username,
          email: form.su_email,
          password: form.su_password,
        });
        setUser(r.user);
        navigate('/admin', { replace: true });
      } else if (mode === 'login') {
        await login(form.username, form.password);
        navigate('/admin', { replace: true });
      } else {
        await api.post('/auth/apply', {
          full_name: form.app_name,
          phone: form.app_phone,
          email: form.app_email,
          username: form.app_username,
          password: form.app_password,
          specialty: form.app_specialty,
          message: form.app_message,
        });
        setSubmitted(true);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0b0f17] px-4 py-10">
      <div className="absolute inset-0 bg-[radial-gradient(50%_40%_at_50%_0%,rgba(225,29,46,0.12),transparent)]" />
      <div className="absolute -left-32 -bottom-32 h-96 w-96 rounded-full bg-[rgb(var(--c-primary))]/10 blur-3xl" />
      <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-sky-500/5 blur-3xl" />

      <div className="relative w-full max-w-md animate-fade-up">
        <div className="mb-8 text-center">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[rgb(var(--c-primary))] to-[rgb(var(--c-secondary))] text-white shadow-xl shadow-[rgb(var(--c-primary))/40]">
            <Icon name="lock" size={30} />
          </span>
          <h1 className="mt-5 text-2xl font-extrabold tracking-tight text-white">Master paneli</h1>
          <p className="mt-1 text-sm text-white/50">
            {needsSetup && mode === 'login'
              ? 'Tizim sozlanmagan — Super admin yarating'
              : `Login yozing — ${site.name || 'AvtoServis'} boshqaruvi`}
          </p>
        </div>

        <form onSubmit={onSubmit} className="card relative space-y-4 !border-white/10 p-7">
          <span className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[rgb(var(--c-primary))]/60 to-transparent" aria-hidden="true" />
          {error && <Alert>{error}</Alert>}

          <div className="mb-1 flex gap-2">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${mode === 'login' ? 'bg-[rgb(var(--c-primary))] text-white' : 'bg-white/5 text-white/60'}`}
            >
              Login
            </button>
            <button
              type="button"
              onClick={() => setMode('apply')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${mode === 'apply' ? 'bg-[rgb(var(--c-primary))] text-white' : 'bg-white/5 text-white/60'}`}
            >
              Usta bo'lish uchun ariza berish
            </button>
          </div>

          {mode === 'apply' ? (
            submitted ? (
              <div className="py-4 text-center">
                <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                  <Icon name="check" size={26} />
                </span>
                <p className="text-lg font-bold text-white">Arizangiz yuborildi.</p>
                <p className="mt-2 text-sm text-white/60">Super admin arizangizni ko'rib chiqadi.</p>
                <p className="mt-1 text-sm text-white/60">Ariza tasdiqlangandan keyin akkauntingiz orqali tizimga kirishingiz mumkin.</p>
                <button
                  type="button"
                  onClick={() => { setSubmitted(false); setForm({ ...form, app_password: '', app_message: '' }); }}
                  className="mt-6 btn-outline !py-2 text-sm"
                >
                  Yana ariza berish
                </button>
              </div>
            ) : (
              <>
                <div>
                  <label className="label" htmlFor="app_name">Ism va familiya *</label>
                  <input id="app_name" className="field" value={form.app_name} onChange={set('app_name')} autoComplete="name" required />
                </div>
                <div>
                  <label className="label" htmlFor="app_phone">Telefon raqam *</label>
                  <input id="app_phone" className="field" value={form.app_phone} onChange={set('app_phone')} autoComplete="tel" placeholder="+998 90 123 45 67" required />
                </div>
                <div>
                  <label className="label" htmlFor="app_email">Email *</label>
                  <input id="app_email" type="email" className="field" value={form.app_email} onChange={set('app_email')} autoComplete="email" required />
                </div>
                <div>
                  <label className="label" htmlFor="app_username">Login *</label>
                  <input id="app_username" className="field" value={form.app_username} onChange={set('app_username')} autoComplete="username" required />
                </div>
                <div>
                  <label className="label" htmlFor="app_password">Parol (kamida 8 belgi) *</label>
                  <input id="app_password" type="password" className="field" value={form.app_password} onChange={set('app_password')} autoComplete="new-password" minLength={8} required />
                </div>
                <div>
                  <label className="label" htmlFor="app_specialty">Mutaxassisligi *</label>
                  <select id="app_specialty" className="field" value={form.app_specialty} onChange={set('app_specialty')} required>
                    <option value="" className="bg-[#111725]">Mutaxassislikni tanlang</option>
                    {SPECIALTIES.map((s) => (
                      <option key={s} value={s} className="bg-[#111725]">{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="app_message">Qo'shimcha ma'lumot</label>
                  <textarea id="app_message" className="field min-h-[80px]" value={form.app_message} onChange={set('app_message')} placeholder="Tajribangiz, sertifikatlaringiz va boshqa ma'lumotlar" />
                </div>
                <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-60">
                  {busy ? <Spinner className="h-5 w-5" /> : 'Ariza yuborish'}
                </button>
                <p className="text-center text-xs text-white/35">Ariza tasdiqlangandan keyingina tizimga kirish mumkin bo'ladi.</p>
              </>
            )
          ) : needsSetup ? (
            <>
              <div className="rounded-xl border border-[rgb(var(--c-primary))]/25 bg-[rgb(var(--c-primary))]/10 px-4 py-3 text-xs text-white/70">
                Tizim hali sozlanmagan. Bitta <b className="text-white">super admin</b> akkaunti yaratiladi — u barcha boshqaruv huquqiga ega bo'ladi.
              </div>
              <div>
                <label className="label" htmlFor="su_name">Ism va familiya *</label>
                <input id="su_name" className="field" value={form.su_name} onChange={set('su_name')} autoComplete="name" required />
              </div>
              <div>
                <label className="label" htmlFor="su_username">Login *</label>
                <input id="su_username" className="field" value={form.su_username} onChange={set('su_username')} autoComplete="username" required />
              </div>
              <div>
                <label className="label" htmlFor="su_email">Email *</label>
                <input id="su_email" type="email" className="field" value={form.su_email} onChange={set('su_email')} autoComplete="email" required />
              </div>
              <div>
                <label className="label" htmlFor="su_password">Parol (kamida 8 belgi) *</label>
                <input id="su_password" type="password" className="field" value={form.su_password} onChange={set('su_password')} autoComplete="new-password" minLength={8} required />
              </div>
              <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-60">
                {busy ? <Spinner className="h-5 w-5" /> : 'Super adminni yaratish va kirish'}
              </button>
            </>
          ) : (
            <>
              <div>
                <label className="label" htmlFor="username">Login yoki email</label>
                <input id="username" className="field" value={form.username} onChange={set('username')} autoComplete="username" required />
              </div>
              <div>
                <label className="label" htmlFor="password">Parol</label>
                <input id="password" type="password" className="field" value={form.password} onChange={set('password')} autoComplete="current-password" required />
              </div>
              <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-60">
                {busy ? <Spinner className="h-5 w-5" /> : 'Kirish'}
              </button>
            </>
          )}

          <a href="/" className="block text-center text-xs text-white/40 transition hover:text-white/70">← Saytga qaytish</a>
        </form>
      </div>
    </div>
  );
}