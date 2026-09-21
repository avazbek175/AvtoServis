import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSite } from '../store';
import Icon from './icons';

export default function Navbar() {
  const { settings } = useSite();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const site = settings?.site || {};

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const links = [
    { href: '#home', label: 'Bosh sahifa' },
    { href: '#services', label: 'Xizmatlar' },
    { href: '#about', label: 'Biz haqimizda' },
    { href: '#contact', label: "Aloqa" },
  ];

  return (
    <header className={`fixed inset-x-0 top-0 z-40 transition-all duration-300 ${scrolled ? 'border-b border-white/5 bg-[#0b0f17]/90 shadow-lg shadow-black/20 backdrop-blur-lg' : 'bg-transparent'}`}>
      <div className="container-x flex h-16 items-center justify-between">
        <Link to="/" className="group flex items-center gap-2.5" onClick={() => setOpen(false)}>
          {site.logo ? (
            <img src={site.logo} alt={site.name} className="h-10 w-10 rounded-xl object-cover ring-1 ring-white/10" />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[rgb(var(--c-primary))] text-white shadow-lg shadow-[rgb(var(--c-primary))/35] transition-transform duration-200 group-hover:scale-105">
              <Icon name="wrench" size={20} />
            </span>
          )}
          <span className="text-lg font-extrabold tracking-tight text-white">{site.name || 'AvtoServis'}</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="group relative rounded-lg px-4 py-2 text-sm font-medium text-white/70 transition hover:text-white">
              {l.label}
              <span className="absolute inset-x-4 -bottom-0.5 h-0.5 origin-left scale-x-0 rounded-full bg-[rgb(var(--c-primary))] transition-transform duration-300 group-hover:scale-x-100" aria-hidden="true" />
            </a>
          ))}
          <a href="#contact" className="btn-primary group ml-3 !px-5 !py-2 text-sm">
            {site.phone ? (
              <>
                <Icon name="phone" size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                {site.phone}
              </>
            ) : (
              "Aloqa"
            )}
          </a>
        </nav>

        <button type="button" className="rounded-lg p-2 text-white transition hover:bg-white/5 md:hidden" onClick={() => setOpen(!open)} aria-label="Menyu">
          <Icon name={open ? 'close' : 'menu'} size={24} />
        </button>
      </div>

      {open && (
        <div className="border-t border-white/5 bg-[#0b0f17]/95 backdrop-blur-lg animate-fade-in md:hidden">
          <nav className="container-x flex flex-col gap-1 py-4">
            {links.map((l) => (
              <a key={l.href} href={l.href} className="rounded-lg px-3 py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/5 hover:text-white" onClick={() => setOpen(false)}>
                {l.label}
              </a>
            ))}
            <a href="#contact" className="btn-primary mt-2 justify-center" onClick={() => setOpen(false)}>
              <Icon name="phone" size={16} />
              {site.phone || 'Aloqa'}
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}