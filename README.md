# AvtoServis

Avtomobil ustaxonasi uchun ish onlayn-sar (auto service) — sayt + boshqaruv paneli.

## Stack
- **Backend:** Node.js + Express + `node:sqlite` (SQLite), session token cookies, bcrypt
- **Frontend:** React 18 + Vite + Tailwind CSS
- **Tizimlar:** Super admin / usta rollari, usta arizalari tasdiqlash oqimi, xizmatlar va media boshqaruvi, "Bajarilgan ishlar" (work log) moduli va saytda ishlar galereyasi

## Ishga tushirish
```bash
# server (http://localhost:4000)
cd server
npm install
npm start

# client build
cd ../client
npm install
npm run build
```

## Xususiyatlar
- Umumiy tashrif sahifasi (xizmatlar, biz haqimizda, kontakt, bajarilgan ishlar galereyasi)
- `/admin` boshqaruv paneli (first-run'da super admin yaratiladi)
- Usta arizalari (aplay), faqat super admin tasdiqlaydi
- Ustalar: sayt matnlari, xizmatlar va media bilan ishlash
- "Bajarilgan ishlar": ustalar o'z ishlarini ro'yxatga oladi, rasm yuklaydi; super admin umumiy statistikani ko'radi va ishlarni saytda namoyish qiladi