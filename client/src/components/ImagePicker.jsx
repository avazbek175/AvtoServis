import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import Icon from './icons';
import { Modal, Spinner, Alert } from './ui';

export default function ImagePicker({ value, onChange, label = 'Rasm', hint = 'JPG, PNG, WEBP, AVIF. Maks 6MB', prefix = 'gallery' }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('upload');
  const [media, setMedia] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  async function openPicker() {
    setOpen(true);
    setError('');
    setMode('upload');
    setLoading(true);
    try {
      const { media: m } = await api.get('/admin/media');
      setMedia(m || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function upload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('prefix', prefix);
      const res = await api.post('/admin/uploads', fd);
      onChange(res.url);
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function useUrl(e) {
    e.preventDefault();
    if (!url.trim()) return setError('URL kiritilmadi');
    onChange(url.trim());
    setOpen(false);
  }

  function remove() {
    onChange('');
  }

  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-3">
        <div className="relative flex h-20 w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white/5">
          {value ? (
            <img src={value} alt="Oldindan ko'rish" className="h-full w-full object-cover" />
          ) : (
            <Icon name="image" size={24} className="text-white/25" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={openPicker} className="btn-primary !py-2 text-xs">Tanlash Yuklash</button>
          {value && (
            <button type="button" onClick={remove} className="inline-flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300">
              <Icon name="trash" size={13} />
              O'chirish
            </button>
          )}
        </div>
      </div>
      <p className="mt-1.5 text-xs text-white/35">{hint}</p>

      <Modal open={open} onClose={() => setOpen(false)} title="Rasm tanlash">
        <div className="mb-4 flex gap-2">
          <button type="button" onClick={() => setMode('upload')} className={`rounded-lg px-4 py-2 text-sm font-semibold ${mode === 'upload' ? 'bg-[rgb(var(--c-primary))] text-white' : 'bg-white/5 text-white/60'}`}>Yuklash</button>
          <button type="button" onClick={() => setMode('library')} className={`rounded-lg px-4 py-2 text-sm font-semibold ${mode === 'library' ? 'bg-[rgb(var(--c-primary))] text-white' : 'bg-white/5 text-white/60'}`}>Galeriya ({media.length})</button>
        </div>

        {error && <Alert className="mb-3">{error}</Alert>}

        {mode === 'upload' && (
          <div className="space-y-4">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02] px-6 py-10 text-center transition hover:border-[rgb(var(--c-primary))]/50">
              {uploading ? <Spinner /> : <Icon name="image" size={32} className="text-white/30" />}
              <div>
                <div className="text-sm font-medium text-white/80">{uploading ? 'Yuklanmoqda...' : 'Bosib rasm tanlang'}</div>
                <div className="mt-1 text-xs text-white/40">{hint}</div>
              </div>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={upload} disabled={uploading} />
            </label>
            <div className="flex items-center gap-2 text-xs text-white/40">yoki</div>
            <form onSubmit={useUrl} className="flex gap-2">
              <input className="field" placeholder="https://... rasmga havola" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button type="submit" className="btn-primary shrink-0 !py-2 text-xs">URL ishlatish</button>
            </form>
          </div>
        )}

        {mode === 'library' && (
          loading ? <div className="flex justify-center py-8"><Spinner /></div> :
          media.length === 0 ? <p className="py-8 text-center text-sm text-white/40">Hali rasm yuklanmagan. Avval bitta rasm yuklang.</p> :
          <div className="grid max-h-80 grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
            {media.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { onChange(m.url); setOpen(false); }}
                className={`group relative aspect-square overflow-hidden rounded-xl border transition ${value === m.url ? 'border-[rgb(var(--c-primary))] ring-2 ring-[rgb(var(--c-primary))]/40' : 'border-white/10 hover:border-white/30'}`}
              >
                <img src={m.url} alt={m.original_name} className="h-full w-full object-cover transition duration-200 group-hover:scale-105" />
              </button>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}