import React, { useEffect, useState } from 'react';
import { api } from '../api';
import Icon from './icons';
import { SectionTitle } from './ui';

const SERVICE_ICONS = {
  'Mator xodovoy': 'engine',
  Diagnostika: 'diagnostic',
  Programma: 'chip',
  Elektrik: 'bolt',
  'Moy almashtirish': 'oil',
};

export default function WorkGallery() {
  const [data, setData] = useState(null);
  const [lightbox, setLightbox] = useState(null);

  useEffect(() => {
    api.get('/public/worklogs').then(setData).catch(() => setData({ enabled: false, worklogs: [] }));
  }, []);

  if (!data || !data.enabled || data.worklogs.length === 0) return null;

  const open = (images, i) => {
    if (images && images.length) setLightbox({ images, i });
  };

  return (
    <section id="worklogs" className="relative py-20 md:py-28">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(40%_60%_at_80%_20%,rgba(225,29,46,0.06),transparent)]" />
      <div className="container-x">
        <SectionTitle
          eyebrow="Ko'rsatilgan natijalar"
          title="Bizning bajarilgan ishlarimiz"
          description="Ustalarimiz tomonidan bajarilgan ishlar va real natijalar. Fotosuratlarni ko'rib chiqing."
        />

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {data.worklogs.map((w) => {
            const first = w.images && w.images[0];
            return (
              <article key={w.id} className="card group overflow-hidden !p-0">
                {first ? (
                  <button type="button" onClick={() => open(w.images, 0)} className="relative block h-52 w-full overflow-hidden">
                    <img src={`/api/workimages/${first.image_path}`} alt={w.title} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
                    {w.images.length > 1 && (
                      <span className="absolute bottom-2 right-2 rounded-lg bg-black/70 px-2 py-1 text-xs font-medium text-white backdrop-blur">
                        +{w.images.length - 1} rasm
                      </span>
                    )}
                    <span className="absolute inset-0 bg-black/0 transition group-hover:bg-black/20" />
                  </button>
                ) : (
                  <div className="flex h-52 items-center justify-center bg-gradient-to-br from-[rgb(var(--c-secondary))] to-[#182136]">
                    <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[rgb(var(--c-primary))]/15 text-[rgb(var(--c-primary))] ring-1 ring-[rgb(var(--c-primary))]/25">
                      <Icon name={SERVICE_ICONS[w.service_type] || 'wrench'} size={30} />
                    </span>
                  </div>
                )}

                <div className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-bold text-white transition-colors group-hover:text-[rgb(var(--c-primary))]">{w.title}</h3>
                    <Badge icon={SERVICE_ICONS[w.service_type]}>{w.service_type}</Badge>
                  </div>
                  {(w.car_brand || w.car_model) && (
                    <p className="mt-1.5 text-sm text-white/60">Avtomobil: {[w.car_brand, w.car_model].filter(Boolean).join(' ')}</p>
                  )}
                  {w.description && <p className="mt-2 line-clamp-3 text-sm text-white/55">{w.description}</p>}
                  <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3 text-xs text-white/40">
                    <span>Usta: {w.master_name || '...'}</span>
                    {w.images && w.images.length > 0 && (
                      <button type="button" onClick={() => open(w.images, 0)} className="flex items-center gap-1 text-[rgb(var(--c-primary))] hover:underline">
                        <Icon name="camera" size={13} /> Galereya
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {lightbox && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm animate-fade-in" onClick={() => setLightbox(null)}>
          <button className="absolute right-4 top-4 rounded-xl bg-white/10 p-2.5 text-white hover:bg-white/20" onClick={() => setLightbox(null)} aria-label="Yopish">
            <Icon name="close" size={20} />
          </button>
          {lightbox.images.length > 1 && (
            <>
              <button
                className="absolute left-3 top-1/2 -translate-y-1/2 rounded-xl bg-white/10 p-2.5 text-white hover:bg-white/20"
                onClick={(e) => { e.stopPropagation(); setLightbox((l) => ({ ...l, i: (l.i - 1 + l.images.length) % l.images.length })); }}
                aria-label="Oldingi"
              >
                <Icon name="chevronleft" size={22} />
              </button>
              <button
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-xl bg-white/10 p-2.5 text-white hover:bg-white/20"
                onClick={(e) => { e.stopPropagation(); setLightbox((l) => ({ ...l, i: (l.i + 1) % l.images.length })); }}
                aria-label="Keyingi"
              >
                <Icon name="chevronright" size={22} />
              </button>
            </>
          )}
          {lightbox.images.length > 0 && (
            <img
              src={`/api/workimages/${lightbox.images[lightbox.i].image_path}`}
              alt="Rasm"
              className="max-h-[86vh] max-w-[92vw] rounded-xl object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </section>
  );
}

function Badge({ children, icon }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[rgb(var(--c-primary))]/30 bg-[rgb(var(--c-primary))]/10 px-3 py-0.5 text-xs font-semibold text-[rgb(var(--c-primary))]">
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}