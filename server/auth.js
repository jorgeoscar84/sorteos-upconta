/* ═══════════════════════════════════════════════════════════════════════
   Autenticación y sesiones.
   - Contraseñas: scrypt N=16384 r=8 p=1, salt 16 B, keylen 64,
     formato `scrypt$N$r$p$saltB64$hashB64`, comparación timingSafeEqual.
   - Sesiones: token de 32 B aleatorios en cookie `sid`; en DB solo sha256(token).
     Expiración deslizante de 12 h (se renueva en cada petición autenticada).
   - Rate limit de login contra la tabla login_attempts.
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import * as db from './db.js';
import { HttpError } from './validate.js';
import { licenseView } from './serialize.js';

const scryptAsync = promisify(crypto.scrypt);

/* Parámetros del contrato: no cambiar sin migrar los hashes existentes. */
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64, saltBytes: 16, maxmem: 128 * 1024 * 1024 };

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h deslizantes

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_PER_IDENTIFIER = 8;
export const LOGIN_MAX_PER_IP = 30;

const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

/* ── Hash de contraseñas ─────────────────────────────────────────────── */

export async function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const derived = await scryptAsync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem
  });
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), derived.toString('base64')
  ].join('$');
}

/**
 * Verifica una contraseña contra el hash almacenado.
 * Nunca lanza por un hash corrupto: devuelve false (cuenta inservible, no crash).
 */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Límites defensivos: un hash manipulado no debe poder bloquear el proceso con scrypt gigante.
  const isPow2 = (n) => Number.isInteger(n) && n >= 1024 && n <= 1 << 20 && (n & (n - 1)) === 0;
  if (!isPow2(N) || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    return false;
  }

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length < 8 || expected.length < 16) return false;

  let derived;
  try {
    derived = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT.maxmem });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Gasta el mismo tiempo de scrypt cuando el usuario no existe, para no
 * filtrar por temporización qué identificadores están registrados.
 */
export async function burnPasswordTime(password) {
  await scryptAsync(password, Buffer.alloc(SCRYPT.saltBytes), SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem
  });
}

/* ── Cookies ─────────────────────────────────────────────────────────── */

export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue; // la primera aparición gana
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* se deja el valor crudo */
    }
    out[name] = value;
  }
  return out;
}

/** La cookie es Secure cuando la petición llega por TLS (también detrás de proxy). */
export function isSecureRequest(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  return forwarded === 'https' || req.secure === true;
}

function cookieOptions(req, withMaxAge = true) {
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecureRequest(req)
  };
  if (withMaxAge) options.maxAge = SESSION_TTL_MS;
  return options;
}

export function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, cookieOptions(req));
}

export function clearSessionCookie(req, res) {
  const { maxAge, ...options } = cookieOptions(req);
  void maxAge;
  res.clearCookie(SESSION_COOKIE, options);
}

/* ── Sesiones ────────────────────────────────────────────────────────── */

export const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Crea la sesión, deja la cookie puesta y devuelve el token en claro (solo en memoria). */
export function createSession(req, res, accountId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  const now = Date.now();
  db.insertSession({
    tokenHash,
    accountId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    ip: req.ip || '',
    userAgent: String(req.get('user-agent') || '').slice(0, 300)
  });
  setSessionCookie(req, res, token);
  return token;
}

/**
 * Resuelve la sesión de la cookie. Devuelve `{account, token, tokenHash}` o null.
 * Renueva la expiración deslizante en cada lectura válida.
 */
export function loadSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const row = db.getSessionAccount(tokenHash);
  if (!row) return null;
  const now = Date.now();
  if (row.session_expires_at <= now) {
    db.deleteSession(tokenHash);
    return null;
  }
  db.touchSession(tokenHash, now + SESSION_TTL_MS);
  return { account: row, token, tokenHash };
}

/* ── Cookie deslizante ───────────────────────────────────────────────── */

const COOKIE_REFRESH_MS = 5 * 60 * 1000;
const lastCookieRefresh = new Map();

/**
 * Reemite la cookie (Max-Age 12 h) como máximo cada 5 min por sesión:
 * así la expiración del navegador también es deslizante sin reescribir la
 * cabecera Set-Cookie en cada petición.
 */
export function refreshSessionCookie(req, res, session) {
  const now = Date.now();
  const last = lastCookieRefresh.get(session.tokenHash) || 0;
  if (now - last < COOKIE_REFRESH_MS) return;
  if (lastCookieRefresh.size > 10_000) {
    for (const [hash, timestamp] of lastCookieRefresh) {
      if (now - timestamp > SESSION_TTL_MS) lastCookieRefresh.delete(hash);
    }
  }
  lastCookieRefresh.set(session.tokenHash, now);
  setSessionCookie(req, res, session.token);
}

/* ── Middlewares ─────────────────────────────────────────────────────── */

export function requireAuth(req, res, next) {
  const session = loadSession(req);
  if (!session) {
    return next(new HttpError('UNAUTHORIZED', 'Tu sesión expiró. Inicia sesión de nuevo.', 401));
  }
  req.account = session.account;
  req.sessionTokenHash = session.tokenHash;
  refreshSessionCookie(req, res, session);
  return next();
}

/**
 * Exige cuenta activa + licencia activa vigente.
 * Los admins de plataforma no dependen de licencia (consola /admin y visita a /).
 */
export function requireLicense(req, res, next) {
  const account = req.account;
  const license = db.getLicense(account.id);
  req.license = license;

  if (account.role === 'admin') return next();

  if (!db.isLicenseActive(account, license)) {
    const message = account.status !== 'active'
      ? 'Tu cuenta está suspendida. Contacta a soporte.'
      : 'Tu licencia no está activa. Contacta a UpConta para completar el pago.';
    return res.status(403).json({ error: 'LICENSE_INACTIVE', message, license: licenseView(license) });
  }
  return next();
}

export function requireAdmin(req, res, next) {
  if (req.account?.role !== 'admin') {
    return next(new HttpError('FORBIDDEN', 'Esta acción requiere una cuenta de administrador.', 403));
  }
  return next();
}

/* ── Rate limit de login ─────────────────────────────────────────────── */

/** Lanza RATE_LIMITED si se superaron los umbrales de fallos en la ventana. */
export function enforceLoginRateLimit(identifier, ip) {
  const since = Date.now() - LOGIN_WINDOW_MS;
  const normalized = String(identifier).toLowerCase();
  if (db.countLoginFailures(normalized, ip, since) >= LOGIN_MAX_PER_IDENTIFIER) {
    throw new HttpError('RATE_LIMITED', 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo otra vez.', 429);
  }
  if (db.countLoginFailuresByIp(ip, since) >= LOGIN_MAX_PER_IP) {
    throw new HttpError('RATE_LIMITED', 'Demasiados intentos fallidos desde esta conexión. Espera 15 minutos.', 429);
  }
}

export function recordLoginAttempt({ identifier, ip, ok }) {
  db.recordLoginAttempt({ identifier: String(identifier).toLowerCase(), ip, ok });
  // Retención corta: la tabla no crece sin control con intentos antiguos.
  db.pruneLoginAttempts(Date.now() - ATTEMPT_RETENTION_MS);
}
