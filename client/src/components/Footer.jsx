import React from 'react';
import { Link } from 'react-router-dom';
import { useSite } from '../store';
import Icon from './icons';

export default function Footer() {
  const { settings } = useSite();
  const site = settings?.site || {};
  const footer = settings?.footer || {};
  const c = settings?.contact || {};

  const socials = [
    { icon: 'telegram', href: c.telegram || site.telegram },
    { icon: 'instagram', href: c.instagram || site.instagram },
  ].filter((s) => s.href);

  return (
    <footer className="relative border-t border-white/5 bg-[#080b12]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[rgb(var(--c-primary))]/50 to-transparent" aria-hidden="true" />
      <div className="container-x py-14">
        <div className="grid gap-10 md:grid-cols-3">
          <div>
            <Link to="/" className="flex items-center gap-2.5">
              {site.logo ? (
                <img src={site.logo} alt={site.name} className="h-10 w-10 rounded-xl object-cover" />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[rgb(var(--c-primary))] text-white shadow-lg shadow-[rgb(var(--c-primary))/30]">
                  <Icon name="wrench" size={20} />
                </span>
              )}
              <span className="text-lg font-extrabold tracking-tight text-white">{site.name || 'AvtoServis'}</span>
            </Link>
            <p className="mt-4 text-sm leading-relaxed text-white/50">{footer.text || ''}</p>
            <div className="mt-5 flex gap-3">
              {socials.map((s) => (
                <a key={s.icon} href={s.href} target="_blank" rel="noreferrer" className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-all duration-200 hover:-translate-y-0.5 hover:border-[rgb(var(--c-primary))]/40 hover:text-[rgb(var(--c-primary))] hover:shadow-lg hover:shadow-[rgb(var(--c-primary))/20]" aria-label={s.icon}>
                  <Icon name={s.icon} size={18} />
                </a>
              ))}
            </div>
          </div>

          <div>
            <h4 className="mb-4 text-sm font-bold uppercase tracking-wider text-white/70">Xizmatlar</h4>
            <ul className="space-y-2.5 text-sm text-white/55">
              {['Mator xodovoy', 'Diagnostika', 'Programma', 'Elektrik', 'Moy almashtirish'].map((n) => (
                <li key={n}>
                  <a href="#services" className="transition-colors hover:text-[rgb(var(--c-primary))]">{n}</a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="mb-4 text-sm font-bold uppercase tracking-wider text-white/70">Aloqa</h4>
            <ul className="space-y-3 text-sm text-white/55">
              {site.phone && (
                <li className="flex items-center gap-2.5">
                  <Icon name="phone" size={15} className="text-[rgb(var(--c-primary))]" />
                  <a href={`tel:${site.phone.replace(/[^+\d]/g, '')}`} className="hover:text-white">{site.phone}</a>
                </li>
              )}
              {site.address && (
                <li className="flex items-start gap-2.5">
                  <Icon name="pin" size={15} className="mt-0.5 shrink-0 text-[rgb(var(--c-primary))]" />
                  <span>{site.address}</span>
                </li>
              )}
              {site.working_hours && (
                <li className="flex items-start gap-2.5 whitespace-pre-line">
                  <Icon name="clock" size={15} className="mt-0.5 shrink-0 text-[rgb(var(--c-primary))]" />
                  <span>{site.working_hours}</span>
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>

      <div className="border-t border-white/5 py-5">
        <div className="container-x flex flex-col items-center justify-between gap-2 text-center text-xs text-white/40 sm:flex-row">
          <span>{footer.copyright || `© ${new Date().getFullYear()} ${site.name || 'AvtoServis'}.`}</span>
          <Link to="/admin/login" className="flex items-center gap-1.5 transition hover:text-white/70">
            <Icon name="lock" size={13} />
            Master panel
          </Link>
        </div>
      </div>
    </footer>
  );
}