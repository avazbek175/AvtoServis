import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import Icon from '../../components/icons';
import { Loading, Alert, ConfirmDialog, EmptyState, Spinner, Badge } from '../../components/ui';

export default function MediaAdmin() {
  const [media, setMedia] = useState(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);

  async function load() {
    setError('');
    try {
      const { media: m } = await api.get('/admin/media');
      setMedia(m || []);
    } catch (e) {
      setError(e.message);
      setMedia([]);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function upload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post('/admin/uploads', fd);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setError('');
    try {
      await api.del('/admin/media/' + deleting.id);
      await load();
      setDeleting(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function copyUrl(m) {
    navigator.clipboard?.writeText(m.url).then(
      () => { setError(''); setMsg(m.url); setTimeout(() => setMsg(''), 1600); },
      () => {}
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">Media / Rasmlar</h1>
          <p className="mt-1 text-sm text-white/50">Saytda ishlatiladigan barcha rasmlar shu yerda saqlanadi.</p>
        </div>
        <label className={`btn-primary cursor-pointer ${uploading ? 'opacity-60' : ''}`}>
          {uploading ? <Spinner className="h-4 w-4" /> : <Icon name="pluss" size={17} />}
          {uploading ? 'Yuklanmoqda...' : 'Rasm yuklash'}
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={upload} disabled={uploading} />
        </label>
      </div>

      {error && <Alert>{error}</Alert>}
      {msg && <Alert kind="success">Havola nusxalandi</Alert>}

      {!media ? (
        <Loading />
      ) : media.length === 0 ? (
        <EmptyState icon="image" title="Rasmlar yo'q" hint="Yuklangan rasmlar bu yerda ko'rinadi. Rasm yuklash uchun tugmani bosing." />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {media.map((m) => (
            <div key={m.id} className="card group overflow-hidden !p-0">
              <div className="relative aspect-square overflow-hidden">
                <img src={m.url} alt={m.original_name} className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
                <div className="absolute right-2 top-2">
                  <Badge kind="default">{formatSize(m.size)}</Badge>
                </div>
                <button type="button" onClick={() => copyUrl(m)} className="absolute inset-x-2 bottom-2 flex items-center justify-center gap-1.5 rounded-lg bg-black/70 py-1.5 text-xs font-medium text-white opacity-0 backdrop-blur transition group-hover:opacity-100">
                  <Icon name="copy" size={12} /> Havolani nusxalash
                </button>
              </div>
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <p className="truncate text-xs text-white/60" title={m.original_name}>{m.original_name}</p>
                <button type="button" onClick={() => setDeleting(m)} className="rounded-lg p-1.5 text-white/40 transition hover:bg-red-500/10 hover:text-red-400" title="O'chirish"><Icon name="trash" size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Rasmni o'chirish"
        message={`"${deleting?.original_name}" rasm o'chiriladi. Saytda ishlatilayotgan bo'lsa, avval boshqa rasm tanlang.`}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
        busy={busy}
      />
    </div>
  );
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}