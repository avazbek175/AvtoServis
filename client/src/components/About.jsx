import React from 'react';
import { useSite } from '../store';
import Icon from './icons';
import { SectionTitle } from './ui';

export default function About() {
  const { settings } = useSite();
  const about = settings?.about || {};
  const design = settings?.design || {};
  if (about.show === false || design.show_about === false) return null;

  const points = [
    { icon: 'check', text: "Sifat kafolati va shaffof narxlar" },
    { icon: 'clock', text: "O'z vaqtida va tezkor xizmat" },
    { icon: 'diagnostic', text: "Zamonaviy diagnostika uskunalari" },
    { icon: 'user', text: "Tajribali sertifikatlangan ustalar" },
  ];

  return (
    <section id="about" className="relative py-20 md:py-28">
      <div className="container-x">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="relative animate-fade-up">
            <div className="absolute -inset-4 -z-10 rounded-3xl bg-[rgb(var(--c-primary))]/10 blur-2xl" />
            {about.image ? (
              <img src={about.image} alt={about.title} className="aspect-[4/3] w-full rounded-3xl border border-white/10 object-cover shadow-2xl" />
            ) : (
              <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-[rgb(var(--c-secondary))] to-[#182136]">
                <span className="absolute inset-0 bg-[radial-gradient(50%_60%_at_50%_40%,rgb(var(--c-primary))/0.12,transparent)]" aria-hidden="true" />
                <span className="relative flex h-28 w-28 items-center justify-center rounded-3xl border border-white/10 bg-white/[0.04] text-white/25 shadow-2xl">
                  <Icon name="engine" size={64} />
                </span>
              </div>
            )}
            {about.experience && (
              <div className="absolute -bottom-6 -right-4 flex h-24 w-24 flex-col items-center justify-center rounded-2xl bg-gradient-to-br from-[rgb(var(--c-primary))] to-[rgb(var(--c-secondary))] text-white shadow-2xl shadow-[rgb(var(--c-primary))/40] sm:-right-6 sm:h-28 sm:w-28">
                <span className="text-3xl font-extrabold tracking-tight">{about.experience}+</span>
                <span className="px-3 text-center text-[11px] font-medium leading-tight opacity-90">{about.experience_label || 'Yillik tajriba'}</span>
              </div>
            )}
          </div>

          <div className="animate-fade-up" style={{ animationDelay: '0.1s' }}>
            <SectionTitle center={false} eyebrow="Biz haqimizda" title={about.title} description={about.description} />
            <ul className="-mt-6 grid gap-3 sm:grid-cols-2">
              {points.map((p, i) => (
                <li key={i} className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-sm text-white/75 transition-colors hover:border-[rgb(var(--c-primary))]/30">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[rgb(var(--c-primary))]/25 to-[rgb(var(--c-primary))]/10 text-[rgb(var(--c-primary))] ring-1 ring-[rgb(var(--c-primary))]/20">
                    <Icon name={p.icon} size={16} />
                  </span>
                  {p.text}
                </li>
              ))}
            </ul>
            <div className="mt-8 flex flex-wrap gap-4">
              <a href="#contact" className="btn-primary">
                <Icon name="phone" size={17} />
                Biz bilan bog'laning
              </a>
              <a href="#services" className="btn-outline">
                Xizmatlarimiz
                <Icon name="arrow" size={17} />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}