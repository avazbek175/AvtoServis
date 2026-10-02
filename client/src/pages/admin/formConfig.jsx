import React from 'react';
import ImagePicker from '../../components/ImagePicker';
import { Toggle } from '../../components/ui';

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const isHexColor = (v) => typeof v === 'string' && HEX_COLOR.test(v.trim());

export function Field({ field, value, onChange }) {
  const set = (v) => onChange(field.key, v);

  switch (field.type) {
    case 'textarea':
      return (
        <div>
          <label className="label">{field.label}</label>
          <textarea className="field min-h-[90px] resize-y" value={value || ''} onChange={(e) => set(e.target.value)} placeholder={field.placeholder || ''} />
          {field.hint && <p className="mt-1 text-xs text-white/35">{field.hint}</p>}
        </div>
      );
    case 'image':
      return <ImagePicker value={value || ''} onChange={set} label={field.label} />;
    case 'toggle':
      return (
        <div className="flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
          <div>
            <div className="text-sm font-medium text-white/80">{field.label}</div>
            {field.hint && <div className="text-xs text-white/40">{field.hint}</div>}
          </div>
          <Toggle checked={!!value} onChange={set} />
        </div>
      );
    case 'color': {
      const text = typeof value === 'string' ? value.trim() : '';
      const valid = !text || /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text);
      return (
        <div>
          <label className="label">{field.label}</label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={isHexColor(text) ? text : '#e11d2e'}
              onChange={(e) => set(e.target.value)}
              className="h-10 w-14 cursor-pointer rounded-lg border border-white/10 bg-transparent"
            />
            <div className="flex-1">
              <input
                className={`field ${text && !valid ? 'border-rose-500/60' : ''}`}
                value={text}
                onChange={(e) => set(e.target.value)}
                placeholder="#e11d2e"
              />
              {text && !valid && (
                <p className="mt-1 text-xs text-rose-400">
                  Noto&apos;g&apos;ri rang. Format: #fff, #ffffff yoki #ffffff80
                </p>
              )}
            </div>
          </div>
          {field.hint && valid && <p className="mt-1 text-xs text-white/35">{field.hint}</p>}
        </div>
      );
    }
    case 'select':
      return (
        <div>
          <label className="label">{field.label}</label>
          <select className="field" value={value || ''} onChange={(e) => set(e.target.value)}>
            {field.options.map(([v, l]) => (
              <option key={v} value={v} className="bg-[#111725]">{l}</option>
            ))}
          </select>
        </div>
      );
    case 'number':
      return (
        <div>
          <label className="label">{field.label}</label>
          <input type="number" className="field" value={value ?? ''} onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))} placeholder={field.placeholder || ''} />
        </div>
      );
    default:
      return (
        <div>
          <label className="label">{field.label}</label>
          <input
            type={field.type || 'text'}
            className="field"
            value={value || ''}
            onChange={(e) => set(e.target.value)}
            placeholder={field.placeholder || ''}
          />
          {field.hint && <p className="mt-1 text-xs text-white/35">{field.hint}</p>}
        </div>
      );
  }
}

export const KEY_FIELDS = {
  site: [
    { key: 'name', label: 'Sayt nomi', type: 'text', placeholder: 'AvtoServis' },
    { key: 'logo', label: 'Logo', type: 'image' },
    { key: 'favicon', label: 'Favicon (kichik belgi)', type: 'image' },
    { key: 'phone', label: 'Telefon', type: 'text', placeholder: '+998 90 123 45 67' },
    { key: 'email', label: 'Email', type: 'email', placeholder: 'info@avtoservis.uz' },
    { key: 'telegram', label: 'Telegram havola', type: 'url', placeholder: 'https://t.me/avtoservis' },
    { key: 'instagram', label: 'Instagram havola', type: 'url', placeholder: 'https://instagram.com/avtoservis' },
    { key: 'address', label: 'Manzil', type: 'text', placeholder: 'Toshkent sh.' },
    { key: 'working_hours', label: 'Ish vaqti', type: 'textarea', placeholder: 'Dushanba – Shanba: 09:00 – 19:00\nYakshanba: dam olish kuni' },
  ],
  hero: [
    { key: 'show', label: 'Hero bo\'limini ko\'rsatish', type: 'toggle' },
    { key: 'title', label: 'Hero sarlavha', type: 'textarea' },
    { key: 'subtitle', label: 'Hero matn', type: 'textarea' },
    { key: 'background_image', label: 'Fon rasmi', type: 'image' },
    { key: 'button_text', label: 'Tugma matni', type: 'text' },
    { key: 'button_link', label: 'Tugma havolasi', type: 'text', placeholder: '#services', hint: 'Faqat https://, http:// yoki / bilan boshlanadigan havolalar ruxsat etiladi' },
    { key: 'stats_customers_value', label: 'Statistika 1 — qiymat', type: 'text', placeholder: '5000+' },
    { key: 'stats_customers_label', label: 'Statistika 1 — yozuv', type: 'text', placeholder: 'Homiylangan mijozlar' },
    { key: 'stats_support_value', label: 'Statistika 3 — qiymat', type: 'text', placeholder: '24/7' },
    { key: 'stats_support_label', label: 'Statistika 3 — yozuv', type: 'text', placeholder: 'Doimiy yordam' },
  ],
  about: [
    { key: 'show', label: 'Bo\'limni ko\'rsatish', type: 'toggle' },
    { key: 'title', label: 'Sarlavha', type: 'text' },
    { key: 'description', label: 'Matn (tavsif)', type: 'textarea' },
    { key: 'image', label: 'Rasm', type: 'image' },
    { key: 'experience', label: 'Tajriba (yil) — Hero statistikasida ham ko\'rsatiladi', type: 'number' },
    { key: 'experience_label', label: 'Tajriba yozuvi', type: 'text', placeholder: 'Yillik tajriba' },
  ],
  contact: [
    { key: 'show', label: 'Bo\'limni ko\'rsatish', type: 'toggle' },
    { key: 'phone', label: 'Telefon', type: 'text' },
    { key: 'telegram', label: 'Telegram', type: 'url' },
    { key: 'instagram', label: 'Instagram', type: 'url' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'address', label: 'Manzil', type: 'text' },
    { key: 'working_hours', label: 'Ish vaqti', type: 'textarea' },
    { key: 'map_link', label: 'Google Maps havolasi (iframe src)', type: 'text', hint: 'Google Maps → Shared → Embed a map → iframe src manzili' },
  ],
  footer: [
    { key: 'text', label: 'Footer matni', type: 'textarea' },
    { key: 'copyright', label: 'Copyright matni', type: 'text' },
  ],
  design: [
    { key: 'primary_color', label: 'Asosiy rang', type: 'color' },
    { key: 'secondary_color', label: 'Ikkinchi daraja rang', type: 'color' },
    { key: 'font_family', label: 'Shrift', type: 'select', options: [['Inter', 'Inter'], ['Manrope', 'Manrope'], ['Space Grotesk', 'Space Grotesk'], ['Arial', 'Arial'], ['Georgia', 'Georgia']] },
    { key: 'show_services', label: 'Xizmatlar bo\'limini ko\'rsatish', type: 'toggle' },
    { key: 'show_about', label: 'Biz haqimizda bo\'limini ko\'rsatish', type: 'toggle' },
  ],
};