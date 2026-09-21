import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { useSite } from '../../store';
import Icon from '../../components/icons';
import { Loading, Alert, Spinner } from '../../components/ui';
import { Field, KEY_FIELDS } from './formConfig';

export default function SectionPage({ section, title }) {
  const { settings, reloadPublic } = useSite();
  const [values, setValues] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const fields = KEY_FIELDS[section] || [];

  useEffect(() => {
    setError('');
    api.get('/admin/settings/' + section)
      .then((r) => setValues(r.settings))
      .catch((e) => setError(e.message));
  }, [section]);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setError('');
    try {
      await api.put('/admin/settings/' + section, { value: values });
      await reloadPublic();
      setMsg({ kind: 'success', text: "O'zgarishlar saqlandi va saytga qo'llandi." });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function onChange(key, v) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">{title}</h1>
          <p className="mt-1 text-sm text-white/50">Saqlangandan so'ng o'zgarishlar darhol saytda ko'rinadi.</p>
        </div>
        <button type="button" onClick={save} disabled={saving || !values} className="btn-primary text-sm disabled:opacity-60">
          {saving ? <Spinner className="h-4 w-4" /> : <><Icon name="check" size={16} /> Saqlash</>}
        </button>
      </div>

      {error && <Alert>{error}</Alert>}
      {msg && (
        <Alert kind={msg.kind} className="flex items-center gap-2">
          {msg.text}
        </Alert>
      )}

      {!values ? (
        <Loading />
      ) : (
        <form onSubmit={save} className="card space-y-5 p-6">
          {fields.map((f) => (
            <Field key={f.key} field={f} value={values[f.key]} onChange={onChange} />
          ))}
        </form>
      )}
    </div>
  );
}