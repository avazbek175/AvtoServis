import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import Icon from '../components/icons';
import { Loading, Alert } from '../components/ui';
import { api } from '../api';
import { useSite } from '../store';

export default function ServiceDetail() {
  const { id } = useParams();
  const { settings } = useSite();
  const [service, setService] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    setState('loading');
    api.get('/public/services/' + id)
      .then(({ service: s }) => { setService(s); setState('ready'); })
      .catch((e) => { setError(e.message); setState('error'); });
  }, [id]);

  const other = settings?.contact || {};
  const phone = other.phone || settings?.site?.phone || '';

  return (
    <>
      <Navbar />
      <main className="min-h-[70vh] pt-28 pb-20">
        <div className="container-x">
          {state === 'loading' && <Loading />}
          {state === 'error' && (
            <div className="py-10">
              {error && <Alert className="mb-4">{error}</Alert>}
              <Alert kind="info" className="mb-6">Xizmat topilmadi yoki yopilgan bo'lishi mumkin.</Alert>
              <Link to="/" className="btn-primary">Bosh sahifaga qaytish</Link>
            </div>
          )}
          {state === 'ready' && service && (
            <div className="grid gap-10 lg:grid-cols-2">
              <div className="animate-fade-up">
                {service.image ? (
                  <img src={service.image} alt={service.name} className="aspect-[4/3] w-full rounded-3xl border border-white/10 object-cover" />
                ) : (
                  <div className="flex aspect-[4/3] w-full items-center justify-center rounded-3xl border border-white/10 bg-gradient-to-br from-[rgb(var(--c-secondary))] to-[#182136]">
                    <Icon name={service.icon || 'wrench'} size={90} className="text-white/25" />
                  </div>
                )}
              </div>
              <div className="animate-fade-up" style={{ animationDelay: '0.1s' }}>
                <Link to="/#services" className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1.5 pl-3 pr-4 text-sm text-white/60 transition hover:border-white/25 hover:text-white">
                  <Icon name="arrow" size={15} className="rotate-180" />
                  Xizmatlarga qaytish
                </Link>
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-3xl font-extrabold text-white sm:text-4xl">{service.name}</h1>
                  {service.price && (
                    <span className="rounded-full border border-[rgb(var(--c-primary))]/30 bg-[rgb(var(--c-primary))]/10 px-4 py-1 text-sm font-semibold text-[rgb(var(--c-primary))]">
                      {service.price}
                    </span>
                  )}
                </div>
                <p className="mt-5 leading-relaxed text-white/70">{service.description}</p>

                {service.benefits && (
                  <div className="mt-7">
                    <h2 className="mb-4 text-sm font-bold uppercase tracking-wider text-white/50">Xizmat afzalliklari</h2>
                    <ul className="grid gap-3 sm:grid-cols-2">
                      {service.benefits.split('|').filter(Boolean).map((b, i) => (
                        <li key={i} className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-sm text-white/75">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                            <Icon name="check" size={14} strokeWidth={3} />
                          </span>
                          {b}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mt-8 flex flex-wrap items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[rgb(var(--c-primary))]/10 text-[rgb(var(--c-primary))]">
                    <Icon name="phone" size={22} />
                  </span>
                  <div className="flex-1">
                    <div className="text-xs text-white/40">Ushbu xizmatga buyurtma berish uchun</div>
                    <div className="font-semibold text-white">{phone || "Telefon raqam"}</div>
                  </div>
                  <a href="#contact" className="btn-primary text-sm">Bog'lanish</a>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}