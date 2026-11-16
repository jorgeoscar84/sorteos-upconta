# Sorteo Studio

SaaS **white-label** de sorteos en vivo para eventos corporativos. Cada empresa cliente entra con
su propio usuario, ve **su logo y su marca** como protagonistas, y hace sorteos con ruleta,
tambores, fanfarria, confeti y serpentinas en pantalla grande.

El producto (Sorteo Studio) queda al fondo: lo que se ve es la marca del cliente. El acceso está
gobernado por **licencias** que el administrador entrega a mano (venta por transferencia, marcada
como pagada en la consola).

```
Empresa cliente ──login──▶ Estudio (ruleta + participantes + marca + historial)
Administrador  ──login──▶ /admin  (cuentas, licencias, renovaciones, auditoría)
```

## Roles

| Rol | Puede |
|---|---|
| `admin` | Crear cuentas, activar/renovar/revocar licencias, marcar pagos, resetear contraseñas, ver auditoría, y usar el estudio |
| `user` (empresa) | Usar el estudio con su licencia activa: participantes, marca, sorteos, historial, exportar CSV |

## Flujo comercial (manual, hoy)

1. El administrador entra a `/admin` → **Nueva cuenta** y llena empresa, contacto, email, usuario,
   contraseña (se genera una segura y se copia para entregarla), plan, vencimiento y monto.
2. La cuenta nace según el checkbox: **pendiente de pago** o **activa**.
3. Cuando llega la transferencia, el administrador pulsa **Marcar pago recibido** → licencia
   `active` con vencimiento.
4. Al vencer, la licencia pasa a `expired` y el usuario ve la pantalla de licencia inactiva con el
   contacto de su asesor. El administrador **renueva** (1/3/12 meses) desde la misma tabla.
5. Para cortar el acceso: **Revocar** (inmediato, conserva los datos) o **Suspender cuenta**.

Las licencias vencen por fecha (`expires_at`) y se evalúan en cada request: no hay caché de permisos.

## Funciones del estudio

- **Ruleta** con selección **autoritativa del servidor** (`crypto.randomInt` + Fisher–Yates): el
  navegador solo anima el resultado, no lo elige.
- **Ganadores múltiples** por sorteo (1–12), revelado simultáneo o uno a uno.
- **Vueltas** (2–40) y duración del giro (3–16 s) configurables.
- **Sin repetición**: los ganadores se descartan y no vuelven a salir.
- **Importación**: Excel (.xlsx/.xls), CSV, TSV, JSON o pegar lista, con detección de columnas
  (Número / Nombre / Empresa / Cargo). Plantillas descargables + lista del evento de ejemplo.
- **Marca blanca**: logo principal (se extrae su color dominante y se usa como acento de la app),
  hasta 12 logos de marcas participantes, nombre a mostrar.
- **Escenario** a pantalla completa con foco del participante bajo el puntero, sonido sintetizado
  (WebAudio, sin archivos), confeti y serpentinas (canvas).
- **Historial** por ronda y **exportación CSV** para el acta del evento.
- Atajos: `Espacio` girar · `F` pantalla completa · `R` siguiente ronda · `M` silenciar.

## Stack

| Capa | Tecnología |
|---|---|
| Servidor | Node 24 + Express 4 (sin build step, sin bundler) |
| Base de datos | SQLite embebido vía `node:sqlite` (archivo en `DATA_DIR`) |
| Auth | scrypt + sesiones en cookie HttpOnly + CSRF por cabecera/origen |
| Frontend | HTML + CSS + ES modules (tokens de diseño en `public/styles/system.css`) |
| Excel | SheetJS vendorizado, carga perezosa solo al importar |
| Deploy | Docker (node:24-alpine) en Dokploy con volumen persistente en `/data` |

## Estructura

```
server/            index.js · db.js · auth.js · validate.js · routes/{auth,studio,admin}.js
public/            login.html · studio.html · admin.html · js/ · styles/ · assets/
docs/API.md        contrato de API + esquema SQLite + reglas de seguridad
docs/DESIGN.md     dirección de arte, tokens, accesibilidad
tests/             pruebas de API con node:test
legacy/            v1 estática (referencia histórica, no se despliega)
```

## Desarrollo local

```bash
npm install
cp .env.example .env          # opcional: define ADMIN_USERNAME / ADMIN_PASSWORD
npm run dev                   # http://localhost:3000
npm test                      # pruebas de API
```

Los datos locales viven en `./.data` (`app.db` + `uploads/`). Para reiniciar de cero: borra esa
carpeta.

## Deploy

`Dockerfile` escucha en `3000` y sirve todo desde Node. En Dokploy:

- **Volumen** persistente montado en `/data` (base de datos y logos).
- **Variables**: `DATA_DIR=/data`, `SESSION_SECRET` (≥32 caracteres), `ADMIN_USERNAME`,
  `ADMIN_PASSWORD`, `APP_ORIGIN=https://tu-dominio`, `PORT=3000`.
- **Dominio** con HTTPS y puerto interno `3000`.
- Healthcheck: `GET /healthz`.

El admin inicial se crea solo en el primer arranque (si no existe ningún `role='admin'`). Cambia esa
contraseña después del primer acceso.

## Seguridad

- Contraseñas con `scrypt` (N=16384, r=8, p=1) y comparación en tiempo constante.
- Sesiones: token de 32 bytes, en base solo su `sha256`; cookie `HttpOnly`, `SameSite=Lax`,
  `Secure` bajo HTTPS; 12 h deslizantes.
- CSRF: cabecera `X-Requested-With: fetch` + validación de `Origin`.
- Rate limit de login: 8 intentos / 15 min por usuario+IP y 30 / 15 min por IP.
- Uploads: validación por *magic bytes*, máximo 400 KB, nombre aleatorio, servidos con
  `nosniff`.
- Aislamiento multi-empresa: toda consulta filtra por la cuenta de la sesión.
- CSP, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`.

## Roadmap

- [ ] Pago con tarjeta (suscripción) con webhook que activa la licencia automáticamente.
- [ ] Alta autoservicio con validación de transferencia asistida (comprobante + aprobación).
- [ ] Múltiples usuarios por cuenta (equipo) y roles internos.
- [ ] Marca por evento (varios eventos por cuenta con logos distintos).
- [ ] Certificado público del ganador (link verificable + QR en pantalla).
