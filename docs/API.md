# Arquitectura — Sorteo Studio (UpConta white-label)

Producto SaaS multi-empresa para sorteos en vivo. **Una empresa = una cuenta + una licencia.**
La marca visible es la de la empresa cliente; el producto ("Sorteo Studio") aparece discreto.

```
Browser ──HTTP──▶ Express (node:24) ──▶ SQLite (node:sqlite)  [/data/app.db]
                        │                 └── /data/uploads/*  (logos)
                        └── static: /public
```

Sin dependencias nativas ni build step de frontend. Única dependencia npm: `express`.
Node 24 trae `node:sqlite` y `node:crypto` (scrypt, randomInt, randomBytes).

## Páginas (MPA)

| Ruta | Archivo | Acceso |
|---|---|---|
| `/login` | `public/login.html` | pública |
| `/` | `public/studio.html` | sesión + licencia activa (admin también entra) |
| `/admin` | `public/admin.html` | sesión + `role=admin` |
| `/uploads/:file` | disco `/data/uploads` | pública, nombre aleatorio 32 hex |

`/` sin sesión → 302 `/login`. `/admin` sin admin → 302 `/`.

## Esquema SQLite

```sql
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',        -- 'user' | 'admin'
  status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'suspended'
  brand_color TEXT NOT NULL DEFAULT '#C9A227',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE licenses (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'mensual',     -- mensual | trimestral | anual | evento
  seats INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | active | expired | revoked
  started_at TEXT,
  expires_at TEXT,                          -- ISO 'YYYY-MM-DD' (NULL = sin vencimiento)
  payment_method TEXT NOT NULL DEFAULT 'transferencia',
  payment_ref TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,              -- sha256(token) hex
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);

CREATE TABLE branding (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  logo_path TEXT,                           -- '/uploads/xxxx.png'
  partners_json TEXT NOT NULL DEFAULT '[]'  -- [{name, path}]
);

CREATE TABLE studios (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  event_title TEXT NOT NULL DEFAULT '',
  prize TEXT NOT NULL DEFAULT 'Premio principal',
  round INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT NOT NULL DEFAULT '{}'  -- {winners,turns,duration,removeWinners,sounds,confetti,simultaneous}
);

CREATE TABLE participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  num TEXT NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  won INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL
);
CREATE INDEX idx_participants_account ON participants(account_id, position);

CREATE TABLE draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  prize TEXT NOT NULL,
  winners_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_id INTEGER,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL,
  ip TEXT NOT NULL,
  ok INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts ON login_attempts(identifier, created_at);
```

## Reglas de acceso

- **Sesión**: cookie `sid` (HttpOnly, SameSite=Lax, Path=/, Secure si `X-Forwarded-Proto=https`), 12 h deslizantes.
- **requireAuth**: sesión válida.
- **requireLicense**: `accounts.status='active'` **y** licencia `status='active'` **y** (`expires_at` NULL o ≥ hoy). Si no → `403 {error:'LICENSE_INACTIVE'}` con `license` en el body.
- **requireAdmin**: `role='admin'`.
- Estado de licencia calculado al leer: `pending|active|expired|revoked`.

## API (JSON, prefijo /api)

Errores siempre `{ error: 'CODE', message: 'texto para el humano' }`.
Códigos: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `LICENSE_INACTIVE`, `RATE_LIMITED`, `NOT_FOUND`, `CONFLICT`.

### Auth
- `POST /api/auth/login` `{identifier, password}` → `{user}` + cookie. 8 intentos/15 min por identifier+IP → `RATE_LIMITED`.
- `POST /api/auth/logout` → `{ok:true}` (borra sesión y cookie).
- `GET  /api/auth/me` → `{user:{id,username,email,companyName,role,status,brandColor,license:{plan,status,seats,expiresAt,daysLeft}}}` o 401.
- `POST /api/auth/change-password` `{currentPassword,newPassword}` → `{ok:true}` (invalida otras sesiones).

### Studio (requireAuth + requireLicense)
- `GET /api/studio/state` → `{branding:{displayName,logoPath,partners[],brandColor}, studio:{eventTitle,prize,round,settings}, participants:[{id,num,name,detail,won}], draws:[{id,round,prize,winners:[{num,name}],createdAt}], license}`.
- `PUT /api/studio/branding` `{displayName?, logoDataUrl?|null, partners?:[{dataUrl?,name?}], brandColor?}` → `{branding}`.
  Acepta PNG/JPEG/WebP en dataURL, máx 400 KB decodificado y 8 MB de body; se guarda en `/data/uploads/<32hex>.<ext>`.
- `PUT /api/studio/settings` `{eventTitle?,prize?,winners?,turns?,duration?,removeWinners?,sounds?,confetti?,simultaneous?}` → `{studio}` (validado: winners 1–12, turns 2–40, duration 3–16).
- `PUT /api/studio/participants` `{participants:[{num?,name,detail?}]}` → `{count, participants}` (máx 2000, dedupe por num+name, renumera `position`).
- `POST /api/studio/draw` `{count?, prize?}` → `{winners:[{id,num,name,detail}], round, remaining}`.
  **El servidor elige** con `crypto.randomInt` (Fisher–Yates) entre participantes con `won=0`.
  Efectos: inserta en `draws`, marca `won=1` si `removeWinners`, `round+1` si ya no quedan elegibles.
  Sin elegibles → `409 CONFLICT`.
- `POST /api/studio/reset` `{keepParticipants?:true}` → `{ok:true}` (won=0, draws borrados, round=1).
- `GET  /api/studio/results.csv` → `text/csv` (SORTEO,NUMERO,NOMBRE,DETALLE,PREMIO,FECHA).

### Admin (requireAdmin)
- `GET  /api/admin/overview` → `{totalAccounts, active, pending, expiringSoon, revenueCents}`.
- `GET  /api/admin/accounts?q=` → `{accounts:[{id,companyName,contactName,email,username,status,role,brandColor,license:{plan,status,seats,expiresAt,daysLeft,amountCents,paymentRef,notes},participants,createdAt}]}`.
- `POST /api/admin/accounts` `{companyName,contactName,email,username,password,plan,seats,expiresAt,status,amountCents,notes}` → `{account}` (crea cuenta + licencia + branding + studio; audita `ACCOUNT_CREATED`).
- `PATCH /api/admin/accounts/:id` `{companyName?,contactName?,email?,status?,brandColor?,plan?,seats?,expiresAt?,licenseStatus?,amountCents?,paymentRef?,notes?,password?}` → `{account}`.
- `POST /api/admin/accounts/:id/renew` `{months, plan?}` → `{account}` (extiende desde max(hoy, expires_at)).
- `POST /api/admin/accounts/:id/reset-password` `{newPassword}` → `{ok:true}` (invalida sesiones del usuario).
- `GET  /api/admin/audit?limit=80` → `{entries:[{id,action,targetCompany,actorName,createdAt,meta}]}`.

## Seguridad (no negociable)

- Hash: `scrypt` N=16384 r=8 p=1, salt 16 B, keylen 64 → `scrypt$N$r$p$saltB64$hashB64`. Comparación `timingSafeEqual`.
- Contraseñas ≥ 10 caracteres. Nunca se devuelve el hash por API.
- Cookie de sesión token = 32 B aleatorios; en DB solo `sha256`.
- CSRF: en métodos mutantes exigir `X-Requested-With: fetch` y `Origin` ∈ {mismo host, `APP_ORIGIN`}. Sin header → 403.
- Rate limit login: 8/15 min por identifier+IP, 30/15 min por IP.
- Cabeceras: `Content-Security-Policy` (self + fonts.gstatic/googleapis + data: para imágenes), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, `Permissions-Policy`.
- Uploads: mime real por magic bytes (PNG/JPEG/WebP), tamaño ≤ 400 KB, nombre aleatorio, se sirve con `Content-Type` correcto y `X-Content-Type-Options: nosniff`.
- Bootstrap admin: si no hay ningún `role='admin'` y existen `ADMIN_USERNAME` + `ADMIN_PASSWORD` → crear admin. Idempotente al arranque.
- Todo query con parámetros (`db.prepare(...).run/ get/ all`), nunca concatenación.
- Aislamiento: **todo** acceso a studio/participants/draws filtra por `account_id` de la sesión.

## Entorno

| Var | Uso | Default |
|---|---|---|
| `PORT` | puerto HTTP | `3000` |
| `DATA_DIR` | sqlite + uploads | `/data` |
| `SESSION_SECRET` | firma/derivación (32+ chars) | se genera y persiste en `DATA_DIR/secret` |
| `ADMIN_USERNAME` | bootstrap admin | — |
| `ADMIN_PASSWORD` | bootstrap admin | — |
| `APP_ORIGIN` | origin público para CSRF | se infiere de `X-Forwarded-*` |
| `NODE_ENV` | `production` en Docker | — |

### Datos y respaldos (requireAdmin)

- `GET  /api/admin/backups` → `{backups:[{name,bytes,createdAt}], lastBackupAt, auto:{everyHours:24, keep:14}}`
- `POST /api/admin/backups` → `201 {backup:{name,bytes,createdAt}}` (snapshot con `VACUUM INTO`, audita `BACKUP_CREATED`)
- `GET  /api/admin/backups/:name` → descarga `.db` (`Content-Disposition: attachment`). Nombre validado por regex `^app-\d{8}-\d{6}(-\d{2})?\.db$`, confinado a `DATA_DIR/backups`.
- `POST /api/admin/maintenance/integrity` → `{ok, integrity, counts:{accounts,licenses,participants,draws}, checkedAt}` (`PRAGMA integrity_check`, audita `INTEGRITY_CHECKED`)

El respaldo automático corre al arrancar (si el último tiene más de 24 h) y luego cada hora se reevalúa; conserva los últimos 14 en `DATA_DIR/backups`.
