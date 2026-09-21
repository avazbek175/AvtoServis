import React from 'react';
import { useSite } from '../store';
import Icon from './icons';
import { Modal } from './ui';

export default function ServiceModal({ service, onClose }) {
  if (!service) return null;
  return (
    <Modal open={!!service} onClose={onClose} title={service.name} wide>
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        {service.image ? (
          <img src={service.image} alt={service.name} className="h-40 w-full rounded-xl object-cover md:h-full" />
        ) : (
          <div className="relative flex h-40 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-[rgb(var(--c-secondary))] to-[#182136] md:h-full">
            <span className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_50%,rgb(var(--c-primary))/0.15,transparent)]" aria-hidden="true" />
            <Icon name={service.icon || 'wrench'} size={56} className="relative text-[rgb(var(--c-primary))]/80" />
          </div>
        )}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {service.price && (
              <span className="rounded-full border border-[rgb(var(--c-primary))]/30 bg-[rgb(var(--c-primary))]/10 px-3 py-0.5 text-sm font-semibold text-[rgb(var(--c-primary))]">
                Narxi: {service.price}
              </span>
            )}
          </div>
          <p className="mt-3 text-sm leading-relaxed text-white/70">{service.description}</p>
          {service.benefits && (
            <div className="mt-5">
              <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/50">Afzalliklar</h4>
              <ul className="grid gap-2 sm:grid-cols-2">
                {service.benefits.split('|').filter(Boolean).map((b, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-sm text-white/75">
                    <Icon name="check" size={15} className="shrink-0 text-emerald-400" />
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <a href="#contact" onClick={onClose} className="btn-primary group/btn text-sm">
              <Icon name="phone" size={16} />
              Buyurtma berish
            </a>
          </div>
        </div>
      </div>
    </Modal>
  );
}