/* ═══════════════════════════════════════════════════════════════════════
   Sorteo Studio — servidor Express (Node 24, ESM, sin build step).
   Arranque:  node server/index.js
   Tests:     importan `createApp()` y escuchan en un puerto efímero.
   ═══════════════════════════════════════════════════════════════════════ */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { hashPassword, loadSession, refreshSessionCookie } from './auth.js';
import { HttpError, password as validatePassword, username as validateUsername } from './validate.js';
import { UPLOAD_NAME_RE, mimeForFilename } from './uploads.js';
import authRoutes from './routes/auth.js';
import studioRoutes from './routes/studio.js';
import adminRoutes from './routes/admin.js';

export const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/* ── Seguridad de cabeceras ──────────────────────────────────────────── */

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "script-src 'self'",
  "connect-src 'self'"
].join('; ');

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)';

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  next();
}

/* ── CSRF ────────────────────────────────────────────────────────────── */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function allowedOrigins(req) {
  const allowed = new Set();
  const own = normalizeOrigin(`${req.protocol}://${req.get('host') || ''}`);
  if (own) allowed.add(own);
  const fromEnv = normalizeOrigin((process.env.APP_ORIGIN || '').trim());
  if (fromEnv) allowed.add(fromEnv);
  return allowed;
}

/**
 * Doble comprobación para métodos mutantes: header propio del cliente fetch
 * (un formulario cross-site no puede enviarlo sin CORS) + Origin permitido.
 */
function csrfProtection(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();

  if (req.get('x-requested-with') !== 'fetch') {
    return next(new HttpError('FORBIDDEN', 'Solicitud rechazada: falta el encabezado X-Requested-With.', 403));
  }
  const origin = normalizeOrigin(req.get('origin'));
  if (!origin) {
    return next(new HttpError('FORBIDDEN', 'Solicitud rechazada: falta el encabezado Origin.', 403));
  }
  if (!allowedOrigins(req).has(origin)) {
    return next(new HttpError('FORBIDDEN', 'Solicitud rechazada: origen no permitido.', 403));
  }
  return next();
}

/* ── Páginas (MPA) ───────────────────────────────────────────────────── */

function servePage(res, next, filename) {
  const file = path.join(PUBLIC_DIR, filename);
  if (!fs.existsSync(file)) {
    return next(new HttpError('NOT_FOUND', 'Página no disponible en esta instalación.', 404));
  }
  return res.sendFile(file);
}

function pageLogin(req, res, next) {
  const session = loadSession(req);
  if (session) {
    refreshSessionCookie(req, res, session);
    const license = db.getLicense(session.account.id);
    const canEnter = session.account.role === 'admin' || db.isLicenseActive(session.account, license);
    // Con licencia inactiva se muestra el login (sin bucle de redirecciones);
    // el estudio avisa del estado de la licencia por API.
    if (canEnter) return res.redirect(302, '/');
  }
  return servePage(res, next, 'login.html');
}

function pageStudio(req, res, next) {
  const session = loadSession(req);
  if (!session) return res.redirect(302, '/login');
  refreshSessionCookie(req, res, session);
  // El estudio carga /api/studio/state, que exige licencia activa (requireLicense).
  return servePage(res, next, 'studio.html');
}

function pageAdmin(req, res, next) {
  const session = loadSession(req);
  if (!session) return res.redirect(302, '/login');
  refreshSessionCookie(req, res, session);
  if (session.account.role !== 'admin') return res.redirect(302, '/');
  return servePage(res, next, 'admin.html');
}

/* ── Uploads ─────────────────────────────────────────────────────────── */

function uploadsHandler(req, res, next) {
  const filename = req.params.file;
  if (!UPLOAD_NAME_RE.test(filename)) {
    return next(new HttpError('NOT_FOUND', 'Imagen no encontrada.', 404));
  }
  const absolute = path.join(db.UPLOADS_DIR, filename);
  if (!fs.existsSync(absolute)) {
    return next(new HttpError('NOT_FOUND', 'Imagen no encontrada.', 404));
  }
  res.setHeader('Content-Type', mimeForFilename(filename) || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(absolute, (err) => {
    if (err && !res.headersSent) next(err);
  });
}

/* ── Bootstrap del admin ─────────────────────────────────────────────── */

/**
 * Crea la cuenta admin de plataforma solo si no existe ninguna y hay
 * ADMIN_USERNAME + ADMIN_PASSWORD. Idempotente en cada arranque.
 */
async function bootstrapAdmin() {
  if (db.countAdmins() > 0) return;

  const rawUsername = (process.env.ADMIN_USERNAME || '').trim();
  const rawPassword = process.env.ADMIN_PASSWORD || '';
  if (!rawUsername && !rawPassword) return; // instalación sin bootstrap: admin se crea aparte
  if (!rawUsername || !rawPassword) {
    console.warn('[bootstrap] ADMIN_USERNAME y ADMIN_PASSWORD deben definirse juntos; se omite.');
    return;
  }

  let adminUsername;
  let adminPassword;
  try {
    adminUsername = validateUsername(rawUsername);
    adminPassword = validatePassword(rawPassword, 'ADMIN_PASSWORD');
  } catch (err) {
    console.warn(`[bootstrap] credenciales de admin inválidas: ${err.message}`);
    return;
  }

  if (db.getAccountByUsername(adminUsername)) {
    console.warn(`[bootstrap] el usuario "${adminUsername}" ya existe y no es admin; no se promueve automáticamente.`);
    return;
  }

  const passwordHash = await hashPassword(adminPassword);
  db.transaction(() => {
    const account = db.createAccount({
      companyName: 'Sorteo Studio',
      contactName: 'Administrador',
      email: `${adminUsername}@sorteo-studio.local`,
      username: adminUsername,
      passwordHash,
      role: 'admin',
      status: 'active'
    });
    // Licencia sin vencimiento: la cuenta admin no depende de facturación.
    db.ensureAccountScaffold(account.id, {
      displayName: 'Sorteo Studio',
      license: {
        plan: 'anual',
        seats: 1,
        status: 'active',
        startedAt: db.todayIso(),
        expiresAt: null,
        notes: 'Cuenta administrador de la plataforma'
      }
    });
    db.logAudit({
      actorId: account.id,
      action: 'ADMIN_BOOTSTRAPPED',
      targetId: account.id,
      meta: { username: adminUsername }
    });
  });
  console.log(`[bootstrap] cuenta admin creada: ${adminUsername}`);
}

/* ── App ─────────────────────────────────────────────────────────────── */

export async function createApp() {
  await bootstrapAdmin();

  const app = express();
  app.disable('x-powered-by');
  // Detrás de Traefik/Dokploy: confiar solo en proxies de loopback/redes privadas.
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

  app.use(securityHeaders);

  app.get('/healthz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain').send('ok');
  });

  // El CSRF se comprueba antes de parsear cuerpos: una petición sin cabeceras no gasta CPU.
  app.use(csrfProtection);
  app.use('/api', express.json({ limit: '8mb' }));

  app.get('/uploads/:file', uploadsHandler);

  // Páginas antes del static para controlar "/" y las redirecciones por sesión.
  app.get('/login', pageLogin);
  app.get('/', pageStudio);
  app.get('/admin', pageAdmin);

  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));

  app.use('/api/auth', authRoutes);
  app.use('/api/studio', studioRoutes);
  app.use('/api/admin', adminRoutes);

  // 404 JSON solo para el prefijo de API (el frontend espera JSON ahí).
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Ruta de API no encontrada.' });
  });
  app.use((req, res) => {
    res.status(404).type('text/plain').send('No encontrado.');
  });

  app.use(errorHandler);
  return app;
}

/* ── Manejo central de errores ───────────────────────────────────────── */

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const isApi = req.originalUrl.startsWith('/api') || req.path.startsWith('/api');
  let status = 500;
  let code = 'SERVER_ERROR';
  let message = 'Ocurrió un error interno.';

  if (err instanceof HttpError) {
    status = err.status;
    code = err.code;
    message = err.message;
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    code = 'BAD_REQUEST';
    message = 'El cuerpo de la petición es demasiado grande (máximo 8 MB).';
  } else if (err instanceof SyntaxError && 'body' in err) {
    status = 400;
    code = 'BAD_REQUEST';
    message = 'El cuerpo de la petición no es JSON válido.';
  } else if (err?.code === 'ENOENT') {
    status = 404;
    code = 'NOT_FOUND';
    message = 'Recurso no encontrado.';
  } else if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
    status = err.status;
    code = 'BAD_REQUEST';
    message = 'La petición no es válida.';
  }

  if (status >= 500) {
    // Nunca se expone el stack al cliente; sí queda en el log del contenedor.
    console.error('[error]', err);
  }

  if (isApi) return res.status(status).json({ error: code, message });
  return res.status(status).type('text/plain').send(message);
}

/* ── Arranque ────────────────────────────────────────────────────────── */

async function start() {
  db.getSessionSecret(); // garantiza DATA_DIR/secret en el primer arranque
  const app = await createApp();
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => {
    console.log(`[sorteo] escuchando en http://127.0.0.1:${port} · datos en ${db.DATA_DIR}`);
  });

  // Limpieza periódica de sesiones vencidas (no bloquea el cierre del proceso).
  const sweeper = setInterval(() => {
    try {
      db.purgeExpiredSessions();
    } catch (err) {
      console.warn('[sorteo] no se pudieron purgar sesiones:', err.message);
    }
  }, 6 * 60 * 60 * 1000);
  sweeper.unref();

  const shutdown = (signal) => {
    console.log(`[sorteo] ${signal} recibido, cerrando...`);
    clearInterval(sweeper);
    server.close(() => {
      db.closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  start().catch((err) => {
    console.error('[sorteo] no se pudo arrancar:', err);
    process.exit(1);
  });
}

export { start };
