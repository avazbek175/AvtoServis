import React from 'react';
import { useSite } from '../store';
import Icon from './icons';
import { SectionTitle } from './ui';

export default function Contact() {
  const { settings } = useSite();
  const c = settings?.contact || {};
  if (c.show === false) return null;

  const items = [
    { icon: 'phone', label: 'Telefon', value: c.phone, href: c.phone ? `tel:${c.phone.replace(/[^+\d]/g, '')}` : undefined },
    { icon: 'telegram', label: 'Telegram', value: c.telegram || 'Telegram', href: c.telegram || undefined },
    { icon: 'instagram', label: 'Instagram', value: c.instagram || 'Instagram', href: c.instagram || undefined },
    { icon: 'mail', label: 'Email', value: c.email, href: c.email ? `mailto:${c.email}` : undefined },
    { icon: 'pin', label: 'Manzil', value: c.address },
    { icon: 'clock', label: 'Ish vaqti', value: c.working_hours },
  ];

  return (
    <section id="contact" className="relative py-20 md:py-28">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_100%_100%,rgba(225,29,46,0.07),transparent)]" />
      <div className="container-x">
        <SectionTitle
          eyebrow="Aloqa"
          title="Biz bilan bog'laning"
          description="Savollaringiz bo'lsa, istalgan yo'l orqali biz bilan bog'lanishingiz mumkin. Sizga yordam berishdan mamnunmiz."
        />

        <div className="grid gap-6 lg:grid-cols-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:col-span-3 lg:grid-cols-2 lg:content-start">
            {items.map((it) => (
              <div key={it.label} className="card group flex items-start gap-4 p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-[rgb(var(--c-primary))]/40 hover:shadow-xl">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[rgb(var(--c-primary))]/25 to-[rgb(var(--c-primary))]/10 text-[rgb(var(--c-primary))] ring-1 ring-[rgb(var(--c-primary))]/20 transition-transform duration-300 group-hover:scale-110">
                  <Icon name={it.icon} size={20} />
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wider text-white/40">{it.label}</div>
                  {it.href ? (
                    <a href={it.href} target={it.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className="mt-1 block break-words text-sm font-medium text-white/85 underline-offset-4 transition hover:text-[rgb(var(--c-primary))] hover:underline">
                      {it.value}
                    </a>
                  ) : (
                    <div className="mt-1 whitespace-pre-line text-sm font-medium text-white/85">{it.value}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="lg:col-span-2">
            {c.map_link ? (
              <div className="card h-full overflow-hidden !p-0">
                <iframe
                  title="Xarita"
                  src={c.map_link}
                  className="h-full min-h-[320px] w-full border-0"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  allowFullScreen
                />
              </div>
            ) : (
              <div className="card relative flex h-full min-h-[320px] flex-col items-center justify-center gap-3 overflow-hidden p-8 text-center">
                <span className="absolute inset-0 bg-[radial-gradient(55%_60%_at_50%_45%,rgb(var(--c-primary))/0.08,transparent)]" aria-hidden="true" />
                <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[rgb(var(--c-primary))]/20 to-transparent text-[rgb(var(--c-primary))] ring-1 ring-[rgb(var(--c-primary))]/25">
                  <Icon name="pin" size={30} />
                </span>
                <p className="relative font-semibold text-white/80">{c.address || 'Manzil'}</p>
                <p className="relative text-sm text-white/50">Xaritaga havolani administrator panelidan qo'shishingiz mumkin.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}