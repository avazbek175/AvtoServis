# AvtoServis API Documentation

REST API for the AvtoServis auto-service platform (React SPA + Express + PostgreSQL).

This document was written from the server source code in `server/src/**` and
`server/migrations/*.sql`. Every endpoint, field, status code and error message
below exists in the code; nothing here is speculative.

- **Source of truth:** `server/src/index.js` (mounts), `server/src/routes/*.js`
- **OpenAPI spec:** [`docs/openapi.yaml`](./openapi.yaml)
- **Version:** unversioned (the API has no `/v1` prefix). Treat the docs as
  matching the deployed `main` branch.

---

## 1. Overview

| | |
|---|---|
| Style | REST, JSON request/response bodies |
| Base prefix | `/api` |
| Auth | Session token (JWT) sent as an HttpOnly cookie **or** `Authorization: Bearer` |
| Roles | `super_admin`, `master` |
| Master permissions | `content`, `services`, `media` (per-user array) |
| Money | Integer so'm for the debt ledger; 2-decimal numbers for inventory prices |
| Timestamps | UTC text `YYYY-MM-DD HH:MM:SS` (never ISO-8601 with `T`/`Z`) |

---

## 2. Base URL

| Environment | Base URL | Evidence |
|---|---|---|
| **Production** | `https://javohirautoservis.uz` | `server/.env.example` lists it as a production `CLIENT_ORIGIN` |
| Production (Vercel alias) | `https://avtoservis-iota.vercel.app` | `server/.env.example` |
| Local dev | `http://localhost:4000` | `PORT` default in `server/src/index.js` |

All API paths below are relative to the base URL:

```
https://javohirautoservis.uz/api/auth/login
```

Routing (from `vercel.json`): every request to `/api/*` is forwarded to the
Express server; everything else goes to the SPA. The server also serves the
built SPA itself when it runs outside Vercel.

> If you deploy somewhere else, take the origin from your own deployment
> configuration — do not assume the table above.

---

## 3. Authentication

### 3.1 Logging in

```http
POST /api/auth/login
Content-Type: application/json

{ "username": "admin", "password": "••••••••" }
```

**200 OK**

```json
{ "user": { "id": 1, "full_name": "…", "username": "admin", "email": "…",
            "role": "super_admin", "is_active": true, "created_at": "2026-01-05 09:14:02" } }
```

The response also carries:

```
Set-Cookie: avtoservis_token=<JWT>; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax; Secure
```

- `username` may be the username **or** the email address.
- The token itself is **not** in the JSON body — a native client must read it
  from the `Set-Cookie` response header (see §16).
- Passwords are bcrypt-hashed; comparison failures return `401`.

### 3.2 Using the token

`server/src/auth.js` reads the token from, in order:

1. `Authorization: Bearer <JWT>` — recommended for native mobile clients
2. the `avtoservis_token` cookie — used by the web SPA

So a mobile client can do either:

```http
Authorization: Bearer <JWT>
```

or

```http
Cookie: avtoservis_token=<JWT>
```

The token is a JWT (`HS256`, 7-day expiry) that must also exist in the
`sessions` table. Every authenticated request re-checks the session row and the
user's `is_active` flag, so **logout, a password change or an account deactivation
kills the token immediately**, not just at expiry.

### 3.3 Session lifecycle

| Action | Effect |
|---|---|
| `POST /api/auth/logout` | Deletes the session row, clears the cookie → `200 { "ok": true }` |
| `POST /api/auth/change-password` (admin) | Revokes **all** sessions of that user and clears the caller's cookie |
| Admin sets a new password / deactivates a user | Revokes all of that user's sessions |

### 3.4 Roles and permissions

| Role | Access |
|---|---|
| `super_admin` | Everything |
| `master` | Everything marked "any authenticated user", plus endpoints gated by a permission the user has |

Permissions granted to a `master`: `content`, `services`, `media`
(`authorizePermission('content' | 'services' | 'media')`).

Permission-gated areas:

| Permission | Endpoints |
|---|---|
| `services` | `/api/admin/services*` |
| `media` | `/api/admin/uploads`, `/api/admin/media*` |
| `content` | `/api/admin/settings*` |

`super_admin`-only areas: users, applications, diagnostics, health, debt purge,
the whole inventory router, and the `worklog` settings key.

**Ownership rules (work logs):** a `master` only sees/edits work logs where
`master_id` equals their own id. A `super_admin` sees everything.

### 3.5 First-run setup

```http
GET /api/auth/setup-status        → { "needsSetup": true | false }
POST /api/auth/setup              → 201 { "user": … }
Authorization: Bearer <SETUP_SECRET>   (or X-Setup-Secret: <value>)
```

Body: `{ full_name, username, email, password }` (`password` ≥ 8 chars,
`username` = 3–30 chars of `[A-Za-z0-9_]`).

- Production: without a configured secret the endpoint answers
  `503 { "error": "Setup o'chirilgan. Birinchi admin yaratish uchun SETUP_SECRET sozlang" }`.
- Wrong/missing secret: `401` / `403`.
- Once a super admin exists: `403 { "error": "Super admin allaqachon yaratilgan" }`.
- The secret value never appears in a response or a log.

### 3.6 Master application (public signup)

`POST /api/auth/apply` → `201 { "application": … }`
Body: `full_name, phone, email, username, password, specialty, message?`.
An admin approves/rejects it later (§8.5).

---

## 4. Request & response conventions

### 4.1 Content type and limits

| | |
|---|---|
| Request body | `Content-Type: application/json` (`express.json({ limit: '2mb' })`) |
| Body over 2 MB | `413` with `{"error":"request entity too large"}` |
| Uploads | `multipart/form-data` (see §13) |
| Response | JSON, UTF-8; exports return CSV/XLSX binaries |

Empty/missing body on a POST is tolerated (`req.body || {}`) — missing fields
then fail field-level validation with `400`.

### 4.2 Timestamps

All `*_at` fields are UTC text, fixed width:

```
"2026-10-07 09:35:12"
```

Because the format is zero-padded, lexicographic order equals chronological
order. Date **query** parameters use `YYYY-MM-DD` and are validated; a malformed
value is a `400`, not a `500`.

### 4.3 Money & quantities

| Domain | Rule |
|---|---|
| Debt ledger (`debt_amount`, `paid_amount`, `amount`) | **Plain integers only** — `12.5`, `1e9`, `"12abc"` are rejected with `400`. Max: safe-integer range. |
| Inventory prices (`cost_price`, `markup_amount`, `sale_price`) | Up to 2 decimals, `0 … 9999999999.99` |
| Inventory quantities | Up to 3 decimals, `0 … 999999999.999`; **filters must be whole numbers** |
| `sale_price` | Not a stored column — always `cost_price + markup_amount`, computed by the database |

### 4.4 Pagination

Endpoints that paginate accept:

| Param | Default | Range |
|---|---|---|
| `page` | `1` | ≥ 1 |
| `per_page` | `20` | 5 … 100 (values outside are clamped) |

and return:

```json
"pagination": { "page": 1, "per_page": 20, "total": 137, "pages": 7 }
```

Endpoints **without** pagination: work-log list and stats, all stats endpoints,
low-stock, exports, users, applications, media list.

### 4.5 Filtering, sorting, search

- `filter` / `sort` / `type` / `status` values are whitelisted — an unknown value
  falls back to the default rather than erroring.
- `q` is a case-insensitive substring search (`ILIKE`); `%` and `_` are escaped,
  so they are matched literally.
- `status` is accepted as an alias for `filter` on the debt list.

### 4.6 CORS

- Browser clients must send an `Origin` listed in `CLIENT_ORIGIN`; otherwise the
  response carries no `Access-Control-Allow-Origin`, and a pre-emptive guard
  returns `403 {"error":"CORS: origin not allowed"}`.
- Allowed headers: `Content-Type`, `Authorization`. Methods: `GET, POST, PUT, PATCH, DELETE, OPTIONS`. Credentials: enabled.
- **Requests without an `Origin` header are always allowed** — curl, server-to-server
  calls and native mobile apps are unaffected by CORS.

---

## 5. Errors & status codes

Every error body has exactly this shape:

```json
{ "error": "human-readable message" }
```

Messages are mostly in Uzbek (verbatim from the server). Some responses add a
`retryAfter` field (rate limits).

| Status | Meaning / where it comes from |
|---|---|
| `400` | Validation: missing field, wrong type, bad date, bad file type, `MulterError` |
| `401` | No/invalid/expired session: `Not authenticated`, `Invalid session`, `Session expired or invalid`, `Account unavailable`, `Login yoki parol noto'g'ri`, `Setup secret talab qilinadi` |
| `403` | Authenticated but not allowed: `Forbidden: insufficient permissions`, `CORS: origin not allowed`, `Pass key noto'g'ri`, `Setup secret noto'g'ri`, role/ownership refusals |
| `404` | Not found. **Unknown `/api/*` paths** return `404 {"error":"API route not found"}` |
| `409` | State conflict: duplicates (`Username yoki email band`), archived rows, insufficient stock, purge with payments |
| `413` | JSON body over 2 MB |
| `429` | Rate limited — includes `Retry-After` header and `retryAfter` seconds |
| `500` | `{"error":"Internal server error"}` (internals are never leaked) |
| `503` | `Database is not ready` (cold start / migration in progress), setup disabled in production, debt deletion disabled because no pass key is configured |

Handler behaviour (`server/src/index.js`): an error carries `status`/`statusCode`
in the 4xx range and is surfaced as-is; anything else becomes a `500`. A
deliberate operator-facing 5xx sets `expose: true`.

---

## 6. Public API (no authentication)

Mounted at `/api/public`, plus two image routes.

### 6.1 `GET /api/health`

```json
{ "status": "ok" }
```

Liveness only — deliberately no business data. Detailed counts live behind
`GET /api/admin/health` (super admin).

### 6.2 `GET /api/public/settings`

```json
{ "settings": { "site": {…}, "hero": {…}, "about": {…}, "contact": {…},
                "design": {…}, "footer": {…}, "worklog": { "public_show": false } } }
```

Missing keys are backfilled from the server's defaults, so new settings appear
for already-initialized sites without a migration.

### 6.3 `GET /api/public/services`

Active services only, in catalogue order (`sort_order, id`):

```json
{ "services": [ { "id": 3, "name": "Mator", "description": "…", "benefits": "…",
                  "image": "…", "icon": "wrench", "price": "50 000 so'm" } ] }
```

`price` is free text (`TEXT`), not a number.

### 6.4 `GET /api/public/services/:id`

`200 {"service":{…}}` or `404 {"error":"Xizmat topilmadi"}` (inactive services
are invisible here too).

### 6.5 `GET /api/public/worklogs`

Depends on the admin toggle `worklog.public_show`:

```json
{ "enabled": false, "worklogs": [] }
```

When enabled, only rows with `is_public = 1` **and** `status = 'Tugallangan'`:

```json
{ "enabled": true, "worklogs": [
  { "id": 12, "title": "…", "service_type": "Mator", "car_brand": "Chevrolet",
    "car_model": "Nexia", "description": "…", "created_at": "…",
    "master_name": "…", "images": [ { "id": 4, "image_path": "w-…-1.jpg" } ] } ] }
```

Image URLs: `/api/workimages/<image_path>` (§13.3).

### 6.6 `GET /api/media/:filename`

Public media. If the file lives in object storage → `302` redirect to its public
URL (`Cache-Control: public, max-age=31536000, immutable`); otherwise the file is
streamed. `404 {"error":"Fayl topilmadi"}` when missing.

### 6.7 `GET /api/workimages/:filename`

Work-log images are **not** public by default. The route allows access when:

- `work_logs.is_public = 1` **and** `settings.worklog.public_show === true` → anonymous access, or
- an authenticated `super_admin`, or
- the authenticated owner (`work_logs.master_id = user.id`)

otherwise `403 {"error":"Forbidden: insufficient permissions"}`.
`Cache-Control: private, max-age=3600`.

---

## 7. Authentication API (`/api/auth`)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | public, rate-limited | Session login (§3.1) |
| POST | `/api/auth/logout` | public | Revokes the current session → `{"ok":true}` |
| GET | `/api/auth/me` | session | `{"user":{id,full_name,username,email,role,is_active,created_at}}`; `401` if the account vanished or was deactivated |
| GET | `/api/auth/setup-status` | public | `{"needsSetup":bool}` |
| POST | `/api/auth/setup` | setup secret | Creates the first super admin → `201 {"user"}` (§3.5) |
| POST | `/api/auth/apply` | public | Master application → `201 {"application"}` (§3.6) |

**Login errors**

| Status | `error` |
|---|---|
| 400 | `Login va parol kiritilishi shart` |
| 401 | `Login yoki parol noto'g'ri` |
| 403 | `Hisob faolshtirilgan. Administrator bilan bog'laning` |
| 429 | `Juda ko'p urinish. Biroz kutib turing va qayta yuboring.` (+ `retryAfter`, `Retry-After`) |

---

## 8. Admin API (`/api/admin`)

The whole router requires a session (`router.use(auth.authenticate)`).
Paths below are relative to `/api/admin`.

### 8.1 Dashboard — `GET /dashboard`

Any authenticated user. Master rows are scoped to the caller.

```json
{ "stats": { "totalServices": 8, "activeServices": 8, "masters": 3, "mastersActive": 3,
             "mediaCount": 12, "debtTotal": 41, "debtOutstanding": 1520000,
             "debtTotalDebtors": 41, "debtCreatedToday": 2,
             "pendingApplications": 1 },
  "visible": { "hero": true, "about": true, "services": true,
               "site": true, "contact": true, "footer": true } }
```

`pendingApplications` is present only for `super_admin`.

### 8.2 Settings — permission `content`

| Method | Path | Notes |
|---|---|---|
| GET | `/settings/:key` | `200 {"settings":{…}}`; `404 {"error":"Noma'lum sozlamalar"}` |
| PUT | `/settings/:key` | Body: the object itself **or** `{ "value": {…} }` → `200 {"settings":{…}}` |
| GET | `/settings` | See the caveat below |

Valid keys: `site`, `hero`, `about`, `contact`, `design`, `footer`, `worklog`.

- Unknown key on PUT → `400 {"error":"Noma'lum sozlamalar kaliti"}`.
- `key = 'worklog'` requires `super_admin` → otherwise `403`.
- Values are validated server-side before anything is written: URLs must be
  relative or `http(s)`; colours must be `#RGB`/`#RGBA`/`#RRGGBB`/`#RRGGBBAA`.
  Failure → `400` with a message such as
  `Tugma havolasi noto'g'ri. Faqat https://, http:// yoki / bilan boshlanadigan havolalar ruxsat etiladi`.
- Dropped object-storage image URLs are garbage-collected after a successful save.

> **Caveat:** `GET /settings` currently returns `{"settings":{},"keys":[]}` — the
> async value is not awaited in the handler. Use `GET /settings/:key` (that is
> what the web client does).

### 8.3 Media — permission `media`

See §13.

### 8.4 Users — `super_admin`

| Method | Path | Success | Notable errors |
|---|---|---|---|
| GET | `/users` | `{"users":[…]}` (super admins first) | — |
| POST | `/users` | `201 {"user"}` | 400 (short name/password, bad fields), 409 `Username yoki email band` |
| PUT | `/users/:id` | `{"user"}` | 400 `Rol noto'g'ri` / short password, 403 (editing another super admin, creating a second super admin, deactivating yourself), 404, 409 |
| DELETE | `/users/:id` | `{"ok":true}` | 403 `Super adminni o'chirib bo'lmaydi`, 404, 409 `Oxirgi super adminni o'chirib bo'lmaydi` |

- Only `role: "master"` may be created via POST; PUT accepts
  `role ∈ {super_admin, master}`.
- `permissions` is an array filtered to `["content","services","media"]`.
- Setting a password or deactivating a user revokes all of that user's sessions.

User object: `{id, full_name, username, email, role, permissions, is_active, created_at}`.

### 8.5 Applications — `super_admin`

| Method | Path | Success |
|---|---|---|
| GET | `/applications?status=pending\|approved\|rejected` | `{"applications":[…]}` (all when `status` absent) |
| POST | `/applications/:id/approve` | `{"user":{…},"application":{…}}` |
| POST | `/applications/:id/reject` | `{"application":{…}}` — body `{ "reason": "…" }` (≤500 chars) |

Errors: `404 Ariza topilmadi`, `400 Bu ariza allaqachon ko'rib chiqilgan`,
`409 Bu login yoki email allaqachon band`.

Application object: `{id, full_name, phone, email, username, specialty, message,
status, rejection_reason, created_at, reviewed_at, reviewed_by, reviewed_by_name}`.

### 8.6 Change own password — `POST /change-password`

Body `{ "current_password": "…", "new_password": "…" }` (new ≥ 8 chars).

→ `200 { "ok": true, "reauth": true }` — **all sessions are revoked and the
caller's cookie is cleared, so the client must log in again.**
Errors: `400` (missing/short), `401 Joriy parol noto'g'ri`, `404`.

### 8.7 Operations (super admin)

| Method | Path | Response |
|---|---|---|
| GET | `/health` | `{"status":"ok","users":N,"services":N,"sessions":N}` |
| GET | `/diagnostics/queries` | `{"count":N}` or `404` when tracing is off |
| POST | `/diagnostics/queries/reset` | `{"ok":true}` or `404` |

---

## 9. Services API

Catalogue shared by the public site, the admin panel, the work-log form and the
debt form.

### 9.1 Admin — permission `services`, base `/api/admin/services`

| Method | Path | Success | Validation / errors |
|---|---|---|---|
| GET | `/` | `{"services":[…]}` — all rows, `sort_order, id` | — |
| POST | `/` | `201 {"service":{…}}` | `400 Xizmat nomi kiritilishi shart` |
| PUT | `/:id` | `{"service":{…}}` | `404 Xizmat topilmadi`, `400` empty name |
| PATCH | `/reorder` | `{"ok":true}` | body `{ "ids": [3,1,2,…] }`; `400 Noto'g'ri so'rov` |
| DELETE | `/:id` | `{"ok":true}` | `404 Xizmat topilmadi` |

Service object (all columns):

```json
{ "id": 1, "name": "Mator", "description": "…", "benefits": "…",
  "image": "https://…/services/….jpg", "icon": "wrench",
  "price": "…", "sort_order": 1, "is_active": 1,
  "created_at": "2026-01-05 09:14:02" }
```

Notes:

- POST body: `name` (required), `description`, `benefits`, `image`, `icon`
  (default `"wrench"`), `price` (string), `sort_order` (integer, default = max+1),
  `is_active` (boolean, default true).
- PUT is a **full replace of every field** — omitted fields keep their stored
  values (`b.x !== undefined ? b.x : existing.x`). Send the whole object.
- `is_active` is returned as `0`/`1`.
- Replacing/deleting an image URL that belongs to object storage also deletes the
  object, unless it is still referenced elsewhere.

### 9.2 Work-log picker — `GET /api/admin/worklogs/services`

Any authenticated user; **active services only**:

```json
{ "services": [ { "id": 1, "name": "Mator", "icon": "wrench", "sort_order": 1 } ] }
```

This is the endpoint the mobile/web "Xizmat turi" dropdown must use — the list is
live, never a hard-coded constant.

### 9.3 Public — `GET /api/public/services[/:id]`

See §6.3–6.4 (active services, fewer fields).

---

## 10. Work-log API (`/api/admin/worklogs`)

Requires a session. A `master` is scoped to their own rows; `super_admin` sees
all. The list endpoint is **not paginated**.

### 10.1 Work log object

```json
{ "id": 12, "master_id": 2, "master_name": "…",
  "title": "Konditsioner ta'miri", "customer_name": "…", "customer_phone": "+998…",
  "car_brand": "Chevrolet", "car_model": "Nexia", "car_number": "01A123BC",
  "service_type": "Mator", "description": "…",
  "start_date": "2026-10-01", "end_date": "2026-10-03",
  "price": 350000, "status": "Jarayonda",
  "is_public": 0, "notes": "…",
  "created_at": "2026-10-01 10:12:44", "updated_at": "2026-10-03 18:02:10",
  "images": [ { "id": 4, "image_path": "w-…-1.jpg", "original_filename": "a.jpg" } ],
  "materials": [ { "id": 7, "work_log_id": 12, "product_id": 3, "quantity": 4.5,
                   "movement_id": 9, "product_name": "Castrol 5W-30",
                   "product_type": "oil", "brand": "Castrol",
                   "viscosity": "5W-30", "unit": "liter" } ] }
```

- `status`: `Jarayonda` | `Tugallangan` (only these two).
- `price`: number ≥ 0 (max `1e12`).
- `service_type`: must match a row in the `services` catalogue (see §10.5).
- `is_public`: `0`/`1`, only `super_admin` may change it.

### 10.2 Endpoints

| Method | Path | Success | Description |
|---|---|---|---|
| GET | `/` | `{"worklogs":[…]}` | List, newest first |
| GET | `/stats` | `{"stats":{total,completed,inProgress,earnings}}` | Aggregates |
| POST | `/` | `201 {"work":{…}}` | Create |
| GET | `/services` | `{"services":[…]}` | Picker catalogue (§9.2) |
| GET | `/:id` | `{"work":{…}}` | Detail (includes `materials`) |
| PUT | `/:id` | `{"work":{…}}` | Update |
| DELETE | `/:id` | `{"ok":true}` | Delete (cascades images) |
| POST | `/:id/images` | `201 {"images":[…]}` | Upload photos (multipart) |
| DELETE | `/images/:imageId` | `{"ok":true,"images":[…]}` | Remove one photo |

> Route order matters: `/services` and `/stats` are matched before `/:id`.
> Always call them without an id segment.

**List query parameters**

| Param | Notes |
|---|---|
| `q` | Matches `title`, `customer_name`, `car_model`, `car_brand` |
| `service_type` | Exact match |
| `status` | Exact match (`Jarayonda` / `Tugallangan`) |
| `date_from`, `date_to` | `YYYY-MM-DD` on `created_at` |
| `master_id` | **super_admin only**; a master's own rows are always filtered |

**Create body** (`POST /`)

```json
{ "title": "…", "service_type": "Mator", "price": 350000, "status": "Jarayonda",
  "customer_name": "…", "customer_phone": "…", "car_brand": "…", "car_model": "…",
  "car_number": "…", "description": "…", "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD", "notes": "…",
  "master_id": 2, "is_public": false,
  "materials": [ { "product_id": 3, "quantity": 4.5, "note": "…" } ] }
```

- `master_id` is **required for super_admin** (`400 Ish bajaruvchi ustani tanlang`)
  and ignored for a master (their own id is used).
- `materials` is optional, max 30 items; **sending materials requires `super_admin`**
  → `403 Ombordan mahsulot sarflash faqat admin uchun`.
- Stock sufficiency is checked inside the transaction: a short item fails the
  whole request with `409 … yetarli qoldiq yo'q…`.
- Validation failures → `400` with `{ "error": "…" }`.

**Update body** (`PUT /:id`) — same fields; omitted fields keep stored values.
`service_type` may stay as-is even if the service was retired; a *changed* value
must resolve to an active catalogue row.

**Ownership:** `403 Forbidden: insufficient permissions` when a master touches
another master's row; `404 Ish topilmadi` when it does not exist.

### 10.3 Images

```http
POST /api/admin/worklogs/12/images
Content-Type: multipart/form-data
files: <file>, <file>, …            (field name is "files", up to 10)
```

- ≤ 10 files per request, ≤ 5 MB each, `image/jpeg|png|webp|avif`.
- Max **15 images per work log** → `400 Bitta ishga ko'pi bilan 15 ta rasm qo'shish mumkin`.
- Errors: `400 Rasm juda katta (maks 5MB)`, `400 Bitta so'rovda ko'pi bilan 10 ta rasm yuboriladi`, `400 Rasm yuklanmadi`.
- Success: `201 { "images": [ … ] }` — the **complete** image list for that work log.
- Images are stored under a private object prefix; the public URL is
  `/api/workimages/<image_path>` (§6.7).

`DELETE /api/admin/worklogs/images/:imageId` →
`200 {"ok":true,"images":[…]}`, or `400 Noto'g'ri rasm ID`,
`404 Rasm topilmadi` / `Ish topilmadi`, `403` for non-owners.

### 10.4 Errors specific to work logs

| Status | `error` |
|---|---|
| 400 | `Ish nomi kiritilishi shart`, `Ish nomi juda uzun`, `Ish holati noto'g'ri`, `Narx noto'g'ri`, `Xizmat turi noto'g'ri` |
| 400 | `Xizmat turi noto'g'ri: "Mator xodovoy" endi Mator va Xodovoy deb ikkiga ajratildi` |
| 400 | `Xizmat turi faol emas: "<nomi>"` |
| 403 | `Faqat super admin saytda ko'rsatishni sozlashi mumkin` (changing `is_public`) |
| 403 | `Forbidden: insufficient permissions` |

### 10.5 `service_type` resolution rules

1. Exact match against `services.name` → stored with the catalogue's spelling.
2. Case/space-insensitive match (so a hand-typed `"mator"` works).
3. Unchanged value on PUT is always accepted — even the retired
   `"Mator xodovoy"` — so old rows stay editable.
4. A changed value that matches nothing → `400 Xizmat turi noto'g'ri`.
5. The legacy combined value as a *new* value → the explicit split message above.

`work_logs.service_type` stores a **text value**, not an id. When a service is
renamed, existing work logs keep the old spelling.

---

## 11. Inventory API (`/api/admin/inventory`)

**Entire router: session + `super_admin` only.** A `master` gets `403`.

### 11.1 Product object

```json
{ "id": 3, "name": "Castrol EDGE 5W-30", "type": "oil", "brand": "Castrol",
  "viscosity": "5W-30", "unit": "liter", "package_size": 4,
  "current_quantity": 48.5, "minimum_quantity": 10,
  "cost_price": 185000, "markup_amount": 25000, "sale_price": 210000,
  "is_active": 1, "created_at": "…", "updated_at": "…",
  "state": "ok", "state_label": "Yetarli" }
```

- `type`: `oil` | `filter`. `unit` is **derived**: oil → `liter`, filter → `piece`.
- `viscosity` is required for oil, forbidden for filter.
- `state` / `state_label` are computed: `ok`/`Yetarli`, `low`/`Kam`, `out`/`Tugagan`.
- `current_quantity` can never be written directly — only through movements.

### 11.2 Movement object

```json
{ "id": 91, "product_id": 3, "movement_type": "purchase",
  "quantity": 12, "before_quantity": 36.5, "after_quantity": 48.5,
  "reference_type": "manual", "reference_id": null, "admin_id": 1, "note": "…",
  "created_at": "…",
  "product_name": "Castrol EDGE 5W-30", "product_type": "oil", "unit": "liter",
  "admin_name": "…", "movement_label": "Kirim", "reference_label": "Qo'lda" }
```

`movement_type`: `purchase` (+) | `consumption` (−) | `adjustment` (±).
`reference_type`: `work_log` | `manual` | `stocktake`.

### 11.3 Endpoints

| Method | Path | Success | Description |
|---|---|---|---|
| GET | `/stats` | `{"stats":{…},"low_stock":[…],"recent_movements":[…]}` | Dashboard figures |
| GET | `/low-stock` | `{"products":[…]}` | Active products at/below minimum |
| GET | `/products` | `{"products":[…],"pagination":{…}}` | Filtered list |
| GET | `/products/:id` | `{"product":…,"totals":…,"movements":[…],"service_materials":[…],"audit_logs":[…]}` | Detail (≤200 history rows each) |
| POST | `/products` | `201 {"product":{…}}` | Create |
| POST | `/products/bulk` | `201 {"count":N,"products":[…]}` | Create up to 20 atomically |
| PATCH | `/products/:id` | `{"product":{…}}` | Update metadata |
| DELETE | `/products/:id` | `{"ok":true}` | Hard delete (only with no history) |
| POST | `/products/:id/stock-in` | `201 {"product":…,"movement":…}` | Kirim (purchase) |
| POST | `/products/:id/consume` | `201 {"product":…,"movement":…}` | Sarf (consumption) |
| POST | `/products/:id/adjust` | `201 {"product":…,"movement":…}` | Stock take |
| GET | `/movements` | `{"movements":[…],"pagination":{…}}` | Movement history |
| GET | `/export.csv` | CSV attachment | Product list |
| GET | `/movements/export.csv` | CSV attachment | Movement history |

**`GET /products` query params**

| Param | Values | Default |
|---|---|---|
| `page`, `per_page` | see §4.4 | 1 / 20 |
| `filter` | `all`, `active`, `inactive`, `low`, `out` | `all` |
| `type` | `all`, `oil`, `filter` | `all` |
| `sort` | `name`, `newest`, `oldest`, `quantity`, `price` | `name` |
| `q` | matches `name`, `brand`, `viscosity` | — |

**`GET /movements` query params**

| Param | Values |
|---|---|
| `page`, `per_page` | see §4.4 |
| `type` | `oil`, `filter` |
| `movement_type` | `purchase`, `consumption`, `adjustment` |
| `product_id` | integer |
| `date_from`, `date_to` | `YYYY-MM-DD` (a malformed value → `400 Sana noto'g'ri formatda (masalan 2026-10-05)`) |
| `q` | matches product `name`, `brand`, movement `note` |

**`POST /products` / each bulk item**

```json
{ "name": "Castrol EDGE 5W-30", "type": "oil", "brand": "Castrol",
  "viscosity": "5W-30", "package_size": 4, "minimum_quantity": 10,
  "cost_price": 185000, "markup_amount": 25000,
  "initial_quantity": 12, "is_active": true }
```

- `initial_quantity` (alias `current_quantity`) seeds opening stock with a
  matching `purchase` movement; omitted/0 means the product starts empty.
- `unit` is derived; sending a contradicting unit → `400`.
- Errors: `400 Mahsulot turi noto'g'ri (moy yoki filtr)`,
  `400 Moy uchun viskozitet majburiy (masalan 5W-30)`,
  `400 Filtr uchun viskozitet kiritilmaydi`, `400 Mahsulot nomi …`, plus the
  price/quantity format messages from §4.3.
- **Bulk:** body `{ "products": [ … ] }`, 1–20 items, all-or-nothing. A failure
  is reported with its position: `2-mahsulot: <original message>`, keeping the
  original status code.
- Duplicates are allowed (no unique constraint on name).

**`PATCH /products/:id`**

- Validates the **merged** row (existing + patch).
- `current_quantity` must be unchanged if present → otherwise
  `400 Qoldiqni to'g'ridan-to'g'ri o'zgartirib bo'lmaydi. Omborga qo'shish, sarf yoki tuzatishdan foydalaning.`
- `404 Mahsulot topilmadi`.

**`DELETE /products/:id`**

- Refused when the product has any movement or service-material history →
  `409 Bu mahsulotning ombor harakati mavjud, shuning uchun o'chirib bo'lmaydi. Uni arxivlang (aktiv/deaktiv).`
- Recommended alternative: `PATCH` with `is_active: false`.

**Stock movements** (`stock-in` / `consume` / `adjust`)

```json
{ "quantity": 12, "note": "…", "supplier": "…" }              // stock-in
{ "quantity": 4.5, "note": "Ishda ishlatildi" }               // consume
{ "reason": "Inventarizatsiya", "current_quantity": 46 }      // adjust (absolute)
{ "reason": "To'kish", "quantity": -2.5 }                     // adjust (signed delta)
```

- `stock-in`: optional `supplier` is appended to the note.
- `consume`: quantity must be > 0 (the sign is applied server-side); filters must
  be whole numbers.
- `adjust`: `reason` is **mandatory** (`400 Tuzatish sababi to'ldirilishi shart`);
  send either `current_quantity` (absolute shelf count) or a signed `quantity`
  (never both, never zero).
- Common failures: `404 Mahsulot topilmadi`,
  `409 Bu mahsulot arxivlangan. Avval uni faollashtiring.`,
  `409 <nomi> uchun yetarli qoldiq yo'q. Qoldiq: X L, talab: Y L`,
  `409 Qoldiq yetarli emas. Boshqa admin allaqachon sarf qilgan.`

Every successful movement writes a `inventory_movements` row **and** an audit row
in the same transaction, and the new stock level is computed by PostgreSQL.

---

## 12. Debt ledger API (`/api/admin/debts`)

**Entire router: session required.** There is no public path to this data.
Additional gates: `DELETE /:id` and `POST /:id/purge` need the delete pass key;
`purge` also needs `super_admin`.

### 12.1 Debt object

```json
{ "id": 5, "full_name": "Alisher Nazarov", "phone": "+998901234567",
  "service": "Mator", "description": "…",
  "debt_amount": 500000, "paid_amount": 200000, "remaining_amount": 300000,
  "status": "partially_paid", "status_label": "Qisman to'langan",
  "created_at": "…", "updated_at": "…", "deleted_at": null }
```

- `status` is **derived** from the amounts, never taken from the request:
  `unpaid` (0 paid) | `partially_paid` | `paid`.
- `status_label` (Uzbek) is added on every read.
- `remaining_amount` is a generated column — client values are ignored.
- `address` is intentionally never selected, returned or exported.

### 12.2 Endpoints

| Method | Path | Success | Description |
|---|---|---|---|
| GET | `/` | `{"debts":[…],"pagination":{…},"archived":false}` | List |
| POST | `/` | `201 {"debt":{…}}` | Create |
| GET | `/stats` | `{"totalDebtors":…,"totalDebt":…,"totalRemaining":…,"totalPaid":…,"openDebtors":…,"partialDebtors":…,"paidDebtors":…,"createdToday":…,"archived":…}` | Aggregates (live rows) |
| GET | `/:id` | `{"debt":…,"payments":[…],"audit_logs":[…]}` | Detail |
| PATCH | `/:id` | `{"debt":{…}}` | Edit |
| POST | `/:id/payments` | `201 {"debt":{…}}` | Record a payment |
| POST | `/:id/mark-paid` | `{"debt":{…}}` | Settle fully |
| DELETE | `/:id` | `{"ok":true,"debt":{…}}` | Archive (soft delete) + pass key |
| POST | `/:id/purge` | `{"ok":true,"purged":<id>}` | Permanent delete + pass key + super admin |
| GET | `/export.csv` | CSV attachment | Current view |
| GET | `/export.xlsx` | XLSX attachment | Debts + payments + audit sheets |

**List query params**

| Param | Values | Default |
|---|---|---|
| `page`, `per_page` | see §4.4 | 1 / 20 |
| `filter` (alias `status`) | `all`, `unpaid`, `partially_paid`, `paid`, `archive` | `all` |
| `sort` | `newest`, `oldest`, `largest`, `remaining` | `newest` |
| `q` (alias `search`) | matches `full_name`, `phone`, `service` | — |

`filter=archive` switches to archived rows (`deleted_at IS NOT NULL`) and sets
`"archived": true` in the response.

Exports honour the same `filter`/`sort`/`q` (pagination is ignored).

### 12.3 Create / update rules

**POST `/`**

```json
{ "full_name": "…", "phone": "+998901234567", "service": "Mator",
  "description": "…", "debt_amount": 500000, "paid_amount": 0 }
```

- `full_name`, `phone`, `service` required (≤ 200 / 60 / 300 chars).
- `debt_amount` must be a positive integer → `400 Qarz summasi 0 dan katta bo'lishi kerak`.
- `paid_amount` optional (0), must be an integer ≤ `debt_amount`.
- `address` in the body is accepted and **discarded**.
- An opening `paid_amount > 0` also creates a payment row
  (`Boshlang'ich to'lov`) and an audit `created` entry.

**PATCH `/:id`**

- Editable: `full_name`, `phone`, `service`, `description`, `debt_amount`.
- **Not editable:** `paid_amount` (only payments/mark-paid move it).
- A *changed* `service` must be an active catalogue service →
  `400 Xizmat ro'yxatdan tanlanishi kerak`. An unchanged one is always kept.
- Lowering `debt_amount` below `paid_amount` →
  `400 Qarzni kamaytirish mumkin emas: to'langan summa yangi qarz summasidan katta bo'lib ketadi`.
- Archived row → `409 Arxivdagi qarzni tahrirlash mumkin emas`; missing → `404 Qarz topilmadi`.

**POST `/:id/payments`**

```json
{ "amount": 100000, "note": "Naqd" }
```

- `amount` positive integer, ≤ current `remaining_amount` →
  otherwise `400 To'lov qoldiq summadan (300000 so'm) katta bo'lishi mumkin emas`.
- Row lock (`FOR UPDATE`) serialises concurrent payments.
- `201` with the updated debt.

**POST `/:id/mark-paid`** — inserts a payment for the outstanding remainder so
`SUM(payments)` always equals `paid_amount`. Archived → `409`.

### 12.4 Deleting a debt

Order of checks, all server-side:

1. session → `401`
2. rate limit → `429` (+`Retry-After`)
3. exists → `404 Qarz topilmadi`
4. not already archived → `409 Bu qarz allaqachon arxivlangan`
5. fully settled → `409 Bu qarz hali to'liq to'lanmagan.`
6. pass key → `403 Pass key noto'g'ri`

**Pass key** — a server-side shared secret. Supply it as:

```http
X-Debt-Pass-Key: <secret>
```

(also accepted as `pass_key` in the JSON body, or as `Authorization: Bearer <secret>` —
but for mobile clients **use the header**, because `Authorization` is where the
session JWT goes).

- Compared with `crypto.timingSafeEqual`; the value is never echoed or logged.
- If the server has no pass key configured: `503 O'chirish vaqtincha faol emas.
  Server sozlamalarida DEBT_DELETE_PASS_KEY belgilanmagan.` (fail closed).
- Only **failed** attempts are counted (per admin session and per IP): 5 per
  15 minutes by default. A correct key clears the budget.

**Archive** (`DELETE /:id`) sets `deleted_at` (soft delete) — the row stays in
the archive with its audit trail.
**Purge** (`POST /:id/purge`, super admin) physically removes the row and is
refused if the debt ever received a payment →
`409 Bu qarzga to'lovlar qo'shilgan. To'lov tarixi saqlanishi uchun bu yozuv faqat arxivlanadi.`

### 12.5 Payments & audit shapes

```json
{ "id": 11, "amount": 100000, "note": "Naqd", "created_at": "…",
  "created_by": 1, "created_by_name": "…" }
```

```json
{ "id": 44, "action": "payment_added", "admin_id": 1, "admin_name": "…",
  "metadata": { … }, "created_at": "…" }
```

`action` ∈ `created`, `updated`, `payment_added`, `marked_paid`,
`delete_requested`, `delete_denied`, `deleted`, `purged`.

---

## 13. Files & media

### 13.1 Storage model

- Object storage (Cloudflare R2) when configured, otherwise local disk.
- Public prefixes: `services`, `oils`, `promotions`, `gallery`.
- Work-log images use a **private** `work/` prefix (optionally a separate
  non-public bucket) and are only reachable through `/api/workimages/:filename`.
- Static `/uploads/*` is served by the server, but the `work/` path is rejected
  with `404 {"error":"Fayl topilmadi"}` before the static handler runs.

### 13.2 Admin upload — `POST /api/admin/uploads`

Permission: `media`.

```http
POST /api/admin/uploads
Content-Type: multipart/form-data

file: <binary>          # required
prefix: services        # optional: services | oils | promotions | gallery (default gallery)
```

- Accepted MIME: `image/jpeg`, `image/png`, `image/webp`, `image/avif` →
  otherwise `400 Faqat JPG, PNG, WEBP, AVIF rasmlari ruxsat etiladi`.
- ≤ 6 MB per file. Missing file → `400 Fayl yuklanmadi`.
- `201`:

```json
{ "media": { "id": 9, "filename": "…", "original_name": "a.jpg",
             "mime": "image/jpeg", "size": 123456, "object_key": "…",
             "url": "…" }, "url": "…" }
```

Related: `GET /api/admin/media` → `{"media":[…]}` (newest first),
`DELETE /api/admin/media/:id` → `{"ok":true}` or
`404 Media topilmadi` / `409 Bu rasm saytda ishlatilmoqda. Avval boshqa rasmni tanlang`.

### 13.3 Reading images

| Kind | URL | Access |
|---|---|---|
| Public media | `/api/media/<filename>` (302 to the storage URL) | anonymous |
| Public work photo | `/api/workimages/<image_path>` | anonymous only if the work log is public *and* the toggle is on |
| Private work photo | `/api/workimages/<image_path>` | `super_admin` or the owning master |
| Static uploads | `/uploads/<file>` | anonymous, except `work/` |

Image URLs returned by API responses are already absolute for object storage
(`https://…/services/uuid.jpg`) or root-relative for disk storage.

---

## 14. Rate limits & operational behaviour

| Endpoint | Limit | Response |
|---|---|---|
| `POST /api/auth/login` | 10 failed attempts per account + 50 per IP, 15 min window | `429` + `Retry-After` + `{"error":…,"retryAfter":N}` |
| `DELETE /api/admin/debts/:id`, `POST …/purge` | 5 failed pass-key attempts per admin session + per IP, 15 min | same shape |

Limits are counted on **failures only**; a successful request does not consume
the budget (login additionally clears the account bucket).

Other operational responses:

| Situation | Response |
|---|---|
| Database not ready / migration running | `503 {"error":"Database is not ready"}` — retry with backoff |
| Unknown `/api/*` path | `404 {"error":"API route not found"}` |
| Disallowed browser origin | `403 {"error":"CORS: origin not allowed"}` |
| Server fault | `500 {"error":"Internal server error"}` |

Env vars that shape behaviour (server-side only, never exposed to clients):
`CLIENT_ORIGIN`, `TRUST_PROXY`, `JWT_SECRET`, `SETUP_SECRET`,
`DEBT_DELETE_PASS_KEY`, `LOGIN_RATE_*`, `DEBT_DELETE_RATE_*`, `R2_*`,
`DATABASE_URL`.

---

## 15. Request examples

### 15.1 cURL — login and call an admin endpoint

```bash
BASE=https://javohirautoservis.uz

# 1. login, keep the cookie jar
curl -c jar.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"secret"}'

# 2. authenticated call using the cookie
curl -b jar.txt "$BASE/api/admin/dashboard"
```

### 15.2 cURL — token in an Authorization header (mobile style)

```bash
TOKEN='<JWT from the Set-Cookie header>'

curl -X POST "$BASE/api/auth/logout" -H "Authorization: Bearer $TOKEN"
curl "$BASE/api/admin/worklogs" -H "Authorization: Bearer $TOKEN"
```

### 15.3 cURL — create a debt and pay it

```bash
curl -b jar.txt -X POST "$BASE/api/admin/debts" \
  -H 'Content-Type: application/json' \
  -d '{"full_name":"Alisher Nazarov","phone":"+998901234567",
       "service":"Mator","debt_amount":500000,"paid_amount":100000}'

curl -b jar.txt -X POST "$BASE/api/admin/debts/5/payments" \
  -H 'Content-Type: application/json' \
  -d '{"amount":150000,"note":"Naqd"}'
```

### 15.4 cURL — stock movement

```bash
curl -b jar.txt -X POST "$BASE/api/admin/inventory/products/3/stock-in" \
  -H 'Content-Type: application/json' \
  -d '{"quantity":12,"note":"Yangi partiya","supplier":"Orient Oil"}'
```

### 15.5 cURL — upload work photos

```bash
curl -b jar.txt -X POST "$BASE/api/admin/worklogs/12/images" \
  -F 'files=@/tmp/one.jpg' -F 'files=@/tmp/two.jpg'
```

### 15.6 cURL — archive a debt (pass key)

```bash
curl -b jar.txt -X DELETE "$BASE/api/admin/debts/5" \
  -H "X-Debt-Pass-Key: $DEBT_DELETE_PASS_KEY"
```

### 15.7 JavaScript (browser / React)

```js
const API = '/api';

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    credentials: 'include',                 // session cookie
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const { user } = await api('POST', '/auth/login', { username, password });
const { worklogs } = await api('GET', '/admin/worklogs');
```

### 15.8 Python (mobile backend)

```python
import requests

BASE = "https://javohirautoservis.uz/api"
s = requests.Session()

r = s.post(f"{BASE}/auth/login", json={"username": "admin", "password": "…"})
r.raise_for_status()
token = r.cookies.get("avtoservis_token")      # or parse Set-Cookie

headers = {"Authorization": f"Bearer {token}"}
data = s.get(f"{BASE}/admin/worklogs", headers=headers).json()
```

---

## 16. Mobile app integration guide

### 16.1 Recommended flow

1. **Check first-run state** (optional): `GET /api/auth/setup-status`.
2. **Login**: `POST /api/auth/login`. Read the token from the `Set-Cookie`
   response header — the JSON body only contains the user:

   ```js
   const setCookie = res.headers.get('set-cookie') || '';
   const token = setCookie.match(/avtoservis_token=([^;]+)/)?.[1];
   ```
3. **Store** the token in secure storage (Keychain / Keystore). It is valid for
   7 days *and* until the session is revoked server-side.
4. **Send** `Authorization: Bearer <token>` on every subsequent request.
5. **Detect logout**: any `401` means the session is gone → clear the token and
   return to the login screen. `401` messages: `Not authenticated`,
   `Invalid session`, `Session expired or invalid`, `Account unavailable`.
6. **Never** store or transmit the server's pass key / setup secret / database
   credentials in the app. `X-Debt-Pass-Key` is entered by the operator, not
   baked into a build.

### 16.2 Things that differ from a browser

| Topic | Behaviour |
|---|---|
| CORS | Not applicable — requests without an `Origin` header are always accepted |
| Cookies | Optional; the Bearer header is enough and is simpler for a native client |
| Redirects | `/api/media/:filename` answers `302` — enable redirect following, or use the absolute object-storage URL from the upload response |
| Downloads | Exports return `Content-Disposition: attachment` (CSV/XLSX) with `Cache-Control: no-store` |
| Body limit | 2 MB JSON per request |
| Uploads | `multipart/form-data`; work photos: field `files`, ≤10 files, ≤5 MB each, max 15 per work log |

### 16.3 Endpoint map by app screen

| Screen | Endpoints |
|---|---|
| Login | `POST /api/auth/login`, `GET /api/auth/me` |
| Dashboard | `GET /api/admin/dashboard`, `GET /api/admin/worklogs/stats`, `GET /api/admin/debts/stats`, `GET /api/admin/inventory/stats` |
| Services catalogue | `GET /api/admin/worklogs/services` (picker), `GET /api/admin/services` (edit) |
| Work log list / detail | `GET /api/admin/worklogs`, `GET /api/admin/worklogs/:id` |
| Create / edit work log | `POST /api/admin/worklogs`, `PUT /api/admin/worklogs/:id` |
| Work photos | `POST /api/admin/worklogs/:id/images`, `DELETE /api/admin/worklogs/images/:imageId`, `GET /api/workimages/:filename` |
| Inventory | `GET/POST/PATCH/DELETE /api/admin/inventory/products…`, `POST …/stock-in\|consume\|adjust`, `GET …/movements` |
| Debt ledger | `GET/POST /api/admin/debts`, `PATCH /:id`, `POST /:id/payments`, `POST /:id/mark-paid`, `DELETE /:id` |
| Exports | `GET /api/admin/debts/export.xlsx`, `GET /api/admin/inventory/export.csv` |
| Public site data (no login) | `GET /api/public/settings`, `/api/public/services`, `/api/public/worklogs` |

### 16.4 Error handling recipe

```js
async function call(path, opts) {
  const res = await fetch(BASE + path, { ...opts, headers });
  if (res.status === 401) return redirectToLogin();
  if (res.status === 429) {
    const retry = Number(res.headers.get('Retry-After')) || 5;
    return showTryAgainLater(retry);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || 'Xatolik');
  return body;
}
```

Always branch on **status code**, and show `body.error` verbatim — the messages
are written for the operator and are already localized (Uzbek).

---

## 17. Full endpoint reference

Legend: 🔓 public · 🔑 session · 👑 `super_admin` · 📝 permission (`content`/`services`/`media`)

| # | Method | Path | Access | Description |
|---|---|---|---|---|
| 1 | GET | `/api/health` | 🔓 | Liveness probe |
| 2 | GET | `/api/public/settings` | 🔓 | Public site settings |
| 3 | GET | `/api/public/services` | 🔓 | Active services |
| 4 | GET | `/api/public/services/:id` | 🔓 | One active service |
| 5 | GET | `/api/public/worklogs` | 🔓 | Public work-log gallery |
| 6 | GET | `/api/media/:filename` | 🔓 | Public image (302 / stream) |
| 7 | GET | `/api/workimages/:filename` | 🔓/🔑 | Work photo (public if shared, else owner/admin) |
| 8 | POST | `/api/auth/login` | 🔓 | Log in (rate limited) |
| 9 | POST | `/api/auth/logout` | 🔓 | Log out |
| 10 | GET | `/api/auth/me` | 🔑 | Current user |
| 11 | GET | `/api/auth/setup-status` | 🔓 | First-run flag |
| 12 | POST | `/api/auth/setup` | 🔓+secret | Create first super admin |
| 13 | POST | `/api/auth/apply` | 🔓 | Master application |
| 14 | GET | `/api/admin/dashboard` | 🔑 | Dashboard stats |
| 15 | GET | `/api/admin/settings` | 📝content | All settings (currently empty — see §8.2) |
| 16 | GET | `/api/admin/settings/:key` | 📝content | One settings section |
| 17 | PUT | `/api/admin/settings/:key` | 📝content (+👑 for `worklog`) | Save a settings section |
| 18 | GET | `/api/admin/media` | 📝media | Media library |
| 19 | POST | `/api/admin/uploads` | 📝media | Upload an image |
| 20 | DELETE | `/api/admin/media/:id` | 📝media | Delete a media item |
| 21 | GET | `/api/admin/services` | 📝services | All services (incl. inactive) |
| 22 | POST | `/api/admin/services` | 📝services | Create a service |
| 23 | PUT | `/api/admin/services/:id` | 📝services | Update a service |
| 24 | PATCH | `/api/admin/services/reorder` | 📝services | Reorder services |
| 25 | DELETE | `/api/admin/services/:id` | 📝services | Delete a service |
| 26 | GET | `/api/admin/users` | 👑 | List users |
| 27 | POST | `/api/admin/users` | 👑 | Create a master |
| 28 | PUT | `/api/admin/users/:id` | 👑 | Update a user |
| 29 | DELETE | `/api/admin/users/:id` | 👑 | Delete a user |
| 30 | GET | `/api/admin/applications` | 👑 | List applications |
| 31 | POST | `/api/admin/applications/:id/approve` | 👑 | Approve → creates user |
| 32 | POST | `/api/admin/applications/:id/reject` | 👑 | Reject with reason |
| 33 | POST | `/api/admin/change-password` | 🔑 | Change own password |
| 34 | GET | `/api/admin/health` | 👑 | Detailed health |
| 35 | GET | `/api/admin/diagnostics/queries` | 👑 | Query counter (if enabled) |
| 36 | POST | `/api/admin/diagnostics/queries/reset` | 👑 | Reset query counter |
| 37 | GET | `/api/admin/worklogs` | 🔑 | Work-log list |
| 38 | GET | `/api/admin/worklogs/stats` | 🔑 | Work-log stats |
| 39 | POST | `/api/admin/worklogs` | 🔑 | Create work log |
| 40 | GET | `/api/admin/worklogs/services` | 🔑 | Service picker |
| 41 | GET | `/api/admin/worklogs/:id` | 🔑 | Work-log detail |
| 42 | PUT | `/api/admin/worklogs/:id` | 🔑 | Update work log |
| 43 | DELETE | `/api/admin/worklogs/:id` | 🔑 | Delete work log |
| 44 | POST | `/api/admin/worklogs/:id/images` | 🔑 | Upload work photos |
| 45 | DELETE | `/api/admin/worklogs/images/:imageId` | 🔑 | Delete a work photo |
| 46 | GET | `/api/admin/debts` | 🔑 | Debt list |
| 47 | POST | `/api/admin/debts` | 🔑 | Create a debt |
| 48 | GET | `/api/admin/debts/stats` | 🔑 | Debt stats |
| 49 | GET | `/api/admin/debts/export.csv` | 🔑 | CSV export |
| 50 | GET | `/api/admin/debts/export.xlsx` | 🔑 | Excel export |
| 51 | GET | `/api/admin/debts/:id` | 🔑 | Debt detail |
| 52 | PATCH | `/api/admin/debts/:id` | 🔑 | Edit a debt |
| 53 | POST | `/api/admin/debts/:id/payments` | 🔑 | Add a payment |
| 54 | POST | `/api/admin/debts/:id/mark-paid` | 🔑 | Settle fully |
| 55 | DELETE | `/api/admin/debts/:id` | 🔑+pass key | Archive a debt |
| 56 | POST | `/api/admin/debts/:id/purge` | 👑+pass key | Permanently delete |
| 57 | GET | `/api/admin/inventory/stats` | 👑 | Warehouse stats |
| 58 | GET | `/api/admin/inventory/low-stock` | 👑 | Low-stock list |
| 59 | GET | `/api/admin/inventory/products` | 👑 | Product list |
| 60 | POST | `/api/admin/inventory/products` | 👑 | Create product |
| 61 | POST | `/api/admin/inventory/products/bulk` | 👑 | Bulk create (≤20) |
| 62 | GET | `/api/admin/inventory/products/:id` | 👑 | Product detail |
| 63 | PATCH | `/api/admin/inventory/products/:id` | 👑 | Update product |
| 64 | DELETE | `/api/admin/inventory/products/:id` | 👑 | Delete product |
| 65 | POST | `/api/admin/inventory/products/:id/stock-in` | 👑 | Stock in |
| 66 | POST | `/api/admin/inventory/products/:id/consume` | 👑 | Consume |
| 67 | POST | `/api/admin/inventory/products/:id/adjust` | 👑 | Stock take |
| 68 | GET | `/api/admin/inventory/movements` | 👑 | Movement history |
| 69 | GET | `/api/admin/inventory/export.csv` | 👑 | Product CSV |
| 70 | GET | `/api/admin/inventory/movements/export.csv` | 👑 | Movement CSV |

Any other `/api/*` path → `404 { "error": "API route not found" }`.
