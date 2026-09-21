import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSite } from '../store';
import Icon from './icons';
import { SectionTitle } from './ui';
import ServiceModal from './ServiceModal';

export default function Services({ showDetailModal = true }) {
  const { settings, services } = useSite();
  const [selected, setSelected] = useState(null);
  const navigate = useNavigate();

  if (settings?.design?.show_services === false) return null;

  return (
    <section id="services" className="relative py-20 md:py-28">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(60%_40%_at_50%_0%,rgba(225,29,46,0.08),transparent)]" />
      <div className="container-x">
        <SectionTitle
          eyebrow="Xizmatlarimiz"
          title="Professional avto xizmatlar"
          description="Avtomobilingiz uchun barcha kerakli xizmatlarni bitta joydan. Zamonaviy uskunalar va tajribali mutaxassislar."
        />

        {services.length === 0 ? (
          <p className="text-center text-white/50">Xizmatlar hozircha qo'shilmagan.</p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((s, i) => (
              <article
                key={s.id}
                className="card group relative overflow-hidden p-6 transition-all duration-300 hover:-translate-y-1.5 hover:border-[rgb(var(--c-primary))]/40 hover:shadow-2xl hover:shadow-[rgb(var(--c-primary))/10] animate-fade-up"
                style={{ animationDelay: `${i * 0.06}s` }}
              >
                <span
                  className="pointer-events-none absolute left-6 top-0 h-0.5 w-16 origin-left scale-x-0 bg-gradient-to-r from-[rgb(var(--c-primary))] to-transparent transition-transform duration-300 group-hover:scale-x-100"
                  aria-hidden="true"
                />
                <span className="pointer-events-none absolute right-4 top-3 select-none text-5xl font-extrabold text-white/[0.05] transition-colors duration-300 group-hover:text-[rgb(var(--c-primary))]/15" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="absolute right-0 top-0 h-24 w-24 translate-x-10 -translate-y-10 rounded-full bg-[rgb(var(--c-primary))]/20 blur-2xl transition-all duration-300 group-hover:translate-x-6 group-hover:-translate-y-6" />

                {s.image ? (
                  <div className="relative h-44 overflow-hidden rounded-xl">
                    <img src={s.image} alt={s.name} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
                  </div>
                ) : (
                  <div className="relative flex h-44 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-[rgb(var(--c-secondary))] to-[#182136]">
                    <span className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_50%,rgb(var(--c-primary))/0.14,transparent)]" aria-hidden="true" />
                    <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-[rgb(var(--c-primary))]/15 text-[rgb(var(--c-primary))] ring-1 ring-[rgb(var(--c-primary))]/25 transition-all duration-300 group-hover:scale-110 group-hover:bg-[rgb(var(--c-primary))]/25">
                      <Icon name={s.icon || 'wrench'} size={32} />
                    </span>
                  </div>
                )}

                <div className="mt-5 flex items-start justify-between gap-3">
                  <h3 className="text-lg font-bold text-white transition-colors group-hover:text-[rgb(var(--c-primary))]">{s.name}</h3>
                  {s.price && (
                    <span className="shrink-0 rounded-full border border-[rgb(var(--c-primary))]/30 bg-[rgb(var(--c-primary))]/10 px-3 py-0.5 text-sm font-semibold text-[rgb(var(--c-primary))]">
                      {s.price}
                    </span>
                  )}
                </div>

                <p className="mt-2.5 line-clamp-3 text-sm leading-relaxed text-white/60">{s.description}</p>

                {s.benefits && (
                  <ul className="mt-4 space-y-1.5">
                    {s.benefits.split('|').slice(0, 3).filter(Boolean).map((b, bi) => (
                      <li key={bi} className="flex items-center gap-2 text-sm text-white/70">
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-400/20">
                          <Icon name="check" size={11} strokeWidth={3} />
                        </span>
                        {b}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-5 flex items-center gap-3">
                  {showDetailModal ? (
                    <button type="button" onClick={() => setSelected(s)} className="btn-primary group/btn w-full !py-2.5 text-sm">
                      Batafsil
                      <Icon name="arrow" size={16} className="transition-transform duration-200 group-hover/btn:translate-x-1" />
                    </button>
                  ) : (
                    <button type="button" onClick={() => navigate('/service/' + s.id)} className="btn-primary group/btn w-full !py-2.5 text-sm">
                      Batafsil
                      <Icon name="arrow" size={16} className="transition-transform duration-200 group-hover/btn:translate-x-1" />
                    </button>
                  )}
                  <a href="#contact" className="btn-outline !px-4 !py-2.5 text-sm" title="Aloqa">
                    <Icon name="phone" size={16} />
                  </a>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {showDetailModal && <ServiceModal service={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}