import React from 'react';
import Icon from './icons';

export function Spinner({ className = 'h-6 w-6', light = true }) {
  return (
    <svg className={`animate-spin ${className} ${light ? 'text-white' : 'text-zinc-400'}`} viewBox="0 0 24 24" fill="none" aria-label="Yuklanmoqda">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 1 0 0 8v4a8 8 0 0 1-8-8Z" />
    </svg>
  );
}

export function Loading({ label = 'Yuklanmoqda...' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-white/60">
      <Spinner className="h-8 w-8" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function EmptyState({ icon = 'search', title = "Hech narsa topilmadi", hint = '' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white/40">
        <Icon name={icon} size={26} />
      </div>
      <p className="font-medium text-white/80">{title}</p>
      {hint && <p className="max-w-sm text-sm text-white/40">{hint}</p>}
    </div>
  );
}

export function Alert({ kind = 'error', children, className = '' }) {
  const styles = {
    error: 'border-red-500/40 bg-red-500/10 text-red-300',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    info: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${styles[kind]} ${className}`}>{children}</div>
  );
}

export function Modal({ open, onClose, title, children, wide = false }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className={`relative w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#111725] p-6 shadow-2xl animate-modal-in`}>
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-white/50 transition hover:bg-white/10 hover:text-white" aria-label="Yopish">
            <Icon name="close" size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Badge({ children, kind = 'default' }) {
  const styles = {
    default: 'border-white/10 bg-white/5 text-white/70',
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    danger: 'border-red-500/30 bg-red-500/10 text-red-300',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    primary: 'border-transparent text-white',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${styles[kind]}`}>{children}</span>
  );
}

export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-[rgb(var(--c-primary))]' : 'bg-white/15'} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      <span
        className="absolute rounded-full bg-white shadow transition-transform"
        style={{ height: 18, width: 18, left: 3, transform: checked ? 'translateX(20px)' : 'translateX(0)' }}
      />
    </button>
  );
}

export function ConfirmDialog({ open, title, message, onCancel, onConfirm, busy = false }) {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <p className="text-sm text-white/70">{message}</p>
      <div className="mt-6 flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="rounded-xl border border-white/15 px-5 py-2.5 text-sm font-medium text-white/80 hover:bg-white/5">
          Bekor qilish
        </button>
        <button type="button" onClick={onConfirm} disabled={busy} className="rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-60">
          {busy ? 'Jarayonda...' : 'O\'chirish'}
        </button>
      </div>
    </Modal>
  );
}

export function SectionTitle({ eyebrow, title, description, center = true }) {
  return (
    <div className={`mb-12 ${center ? 'text-center' : ''}`}>
      {eyebrow && (
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[rgb(var(--c-primary))]/30 bg-[rgb(var(--c-primary))]/10 px-4 py-1 text-xs font-semibold uppercase tracking-wider text-[rgb(var(--c-primary))]">
          <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--c-primary))]" />
          {eyebrow}
        </div>
      )}
      <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">{title}</h2>
      {description && <p className={`mx-auto mt-4 max-w-2xl text-white/60 ${center ? '' : 'mx-0'}`}>{description}</p>}
    </div>
  );
}