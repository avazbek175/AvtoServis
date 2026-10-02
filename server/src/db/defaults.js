/**
 * Default site settings.
 *
 * The same object seeds the `settings` table on first run and documents the
 * contract shared by the admin panel and the public site. Keys added here are
 * backfilled into already-stored objects by settings.js `withDefaults()`, so no
 * data migration is needed.
 */
const DEFAULT_SETTINGS = {
  site: {
    name: 'AvtoServis',
    logo: '',
    favicon: '',
    phone: '+998 90 123 45 67',
    email: 'info@avtoservis.uz',
    telegram: 'https://t.me/avtoservis',
    instagram: 'https://instagram.com/avtoservis',
    address: 'Toshkent sh., Chilonzor tumani, 12-mavze',
    working_hours: 'Dushanba – Shanba: 09:00 – 19:00',
  },
  hero: {
    title: 'Avtomobilingiz uchun professional xizmat',
    subtitle: 'Tajribali ustalar, zamonaviy uskunalar va sifatli ehtiyot qismlar. Avtomobilingiz ishonchli qo\'llarda.',
    background_image: '',
    button_text: 'Xizmatlar',
    button_link: '#services',
    show: true,
    // Hero statistics. The "experience" figure is not stored here on purpose: it is
    // derived from `about.experience` / `about.experience_label` so the two
    // sections can never show different numbers.
    stats_customers_value: '5000+',
    stats_customers_label: 'Homiylangan mijozlar',
    stats_support_value: '24/7',
    stats_support_label: 'Doimiy yordam',
  },
  about: {
    title: 'Biz haqimizda',
    description: 'AvtoServis — avtomobillarga texnik xizmat ko\'rsatish bo\'yicha yuqori malakali mutaxassislar jamoasi. Biz zamonaviy diagnostika uskunalari bilan ishlaymiz va har bir mijozga individual yondashamiz.',
    image: '',
    experience: 10,
    experience_label: 'Yillik tajriba',
    show: true,
  },
  contact: {
    // `show` belongs to the contract: the admin toggle and the public section read
    // the same key, otherwise the panel shows "off" while the section is visible.
    show: true,
    phone: '+998 90 123 45 67',
    telegram: 'https://t.me/avtoservis',
    instagram: 'https://instagram.com/avtoservis',
    address: 'Toshkent sh., Chilonzor tumani, 12-mavze',
    email: 'info@avtoservis.uz',
    working_hours: 'Dushanba – Shanba: 09:00 – 19:00\nYakshanba: dam olish kuni',
    map_link: '',
  },
  design: {
    primary_color: '#e11d2e',
    secondary_color: '#0f1722',
    font_family: 'Manrope',
    show_services: true,
    show_about: true,
  },
  footer: {
    text: 'AvtoServis — avtomobilingizga sifatli texnik xizmat.',
    copyright: '© 2026 AvtoServis. Barcha huquqlar himoyalangan.',
  },
  worklog: {
    public_show: false,
  },
};

const DEFAULT_MASTER_PERMISSIONS = ['content', 'services', 'media'];

module.exports = { DEFAULT_SETTINGS, DEFAULT_MASTER_PERMISSIONS };
