import React from 'react';
import { useSite } from '../store';
import Icon from './icons';

export default function Hero() {
  const { settings } = useSite();
  const hero = settings?.hero || {};
  const site = settings?.site || {};
  if (hero.show === false) return null;

  const stats = [
    { value: '5000+', label: 'Homiylangan mijozlar' },
    { value: hero.experience || '10+', label: site.name?.toLowerCase().includes('avto') ? "Yillik tajriba" : "Yillik tajriba" },
    { value: '24/7', label: 'Doimiy yordam' },
  ];

  return (
    <section id="home" className="relative flex min-h-[92vh] items-center overflow-hidden">
      <div className="absolute inset-0 overflow-hidden">
        {hero.background_image ? (
          <img src={hero.background_image} alt="" className="h-full w-full object-cover animate-slow-zoom" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-[rgb(var(--c-secondary))] via-[#0b1424] to-[#101c30]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-[#0b0f17] via-[#0b0f17]/85 to-[#0b0f17]/30" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0b0f17] via-transparent to-transparent" />
        <div className="absolute left-1/2 top-1/2 -z-0 hidden h-[560px] w-[560px] -translate-x-[25%] -translate-y-1/2 rounded-full bg-[rgb(var(--c-primary))]/15 blur-[130px] lg:block" />
        <div className="absolute inset-y-0 right-0 hidden w-24 items-center justify-center gap-5 lg:flex" aria-hidden="true">
          {[0, 1, 2].map((n) => (
            <span key={n} className="w-px bg-gradient-to-b from-transparent via-white/25 to-transparent animate-shine" style={{ height: `${72 - n * 16}%`, animationDelay: `${n * 0.4}s` }} />
          ))}
        </div>
      </div>

      <div className="container-x relative z-10 pb-24 pt-32 text-center md:pb-28 md:pt-40 md:text-left">
        <div className="animate-fade-up">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[rgb(var(--c-primary))]/30 bg-[rgb(var(--c-primary))]/10 px-4 py-1.5 text-xs font-medium text-white/80 backdrop-blur">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            Professional avto xizmat
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-tight text-white sm:text-5xl md:mx-0 lg:text-6xl">
            {hero.title || "Avtomobilingiz uchun professional xizmat"}
          </h1>
          <div className={'mx-auto mt-6 h-1 w-24 rounded-full bg-[rgb(var(--c-primary))] shadow-lg shadow-[rgb(var(--c-primary))/50] md:mx-0'} aria-hidden="true" />
          <p className="mx-auto mt-5 max-w-xl text-lg text-white/70 md:mx-0">
            {hero.subtitle || ''}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4 md:justify-start">
            <a href={hero.button_link || '#services'} className="btn-primary group text-base">
              {hero.button_text || 'Xizmatlar'}
              <Icon name="arrow" size={18} className="transition-transform duration-200 group-hover:translate-x-1" />
            </a>
            <a href="#contact" className="btn-outline group text-base">
              <Icon name="phone" size={18} />
              Bog'lanish
            </a>
          </div>
        </div>

        <div className="mt-14 grid grid-cols-3 gap-4 rounded-2xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-md animate-fade-up md:gap-0 md:divide-x md:divide-white/10" style={{ animationDelay: '0.15s' }}>
          {stats.map((s) => (
            <div key={s.label} className="text-center md:px-6 md:first:pl-0 md:last:pr-0">
              <div className="text-2xl font-extrabold tracking-tight text-[rgb(var(--c-primary))] sm:text-3xl">{s.value}</div>
              <div className="mt-1 text-xs text-white/60 sm:text-sm">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="absolute bottom-8 left-1/2 hidden -translate-x-1/2 text-white/40 md:block animate-fade-in" aria-hidden="true">
        <Icon name="chevrondown" size={26} />
      </div>
    </section>
  );
}