/* ═══════════════════════════════════════════════════════════════════════
   Capa de datos: SQLite (node:sqlite, DatabaseSync) + esquema + helpers.
   - Todas las consultas usan parámetros (nunca concatenación de valores).
   - El esquema es idempotente: se aplica en cada arranque.
   - Este módulo se inicializa al importarse (una sola conexión por proceso);
     los tests fijan DATA_DIR ANTES del import dinámico.
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/* ── Rutas de datos ──────────────────────────────────────────────────── */

/**
 * DATA_DIR explícito si viene del entorno. Si no:
 *  - `/data` (volumen del contenedor) cuando ya existe y es escribible;
 *  - `./.data` en desarrollo local.
 * No creamos `/data` a ciegas: en Windows/Linux local eso ensuciaría la raíz.
 */
function resolveDataDir() {
  const fromEnv = (process.env.DATA_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  try {
    fs.accessSync('/data', fs.constants.W_OK);
    return path.resolve('/data');
  } catch {
    return path.resolve('.data');
  }
}

export const DATA_DIR = resolveDataDir();
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* ── Esquema (docs/API.md) ───────────────────────────────────────────── */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  brand_color TEXT NOT NULL DEFAULT '#C9A227',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'mensual',
  seats INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  expires_at TEXT,
  payment_method TEXT NOT NULL DEFAULT 'transferencia',
  payment_ref TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS branding (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  logo_path TEXT,
  partners_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS studios (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  event_title TEXT NOT NULL DEFAULT '',
  prize TEXT NOT NULL DEFAULT 'Premio principal',
  round INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  num TEXT NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  won INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_participants_account ON participants(account_id, position);

CREATE TABLE IF NOT EXISTS draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  prize TEXT NOT NULL,
  winners_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_id INTEGER,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL,
  ip TEXT NOT NULL,
  ok INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(identifier, created_at);

-- Índices de apoyo (mismo esquema, solo aceleran lecturas frecuentes).
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_draws_account ON draws(account_id, id);
CREATE INDEX IF NOT EXISTS idx_participants_eligible ON participants(account_id, won);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`;

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec(SCHEMA);

/* ── Utilidades de fecha ─────────────────────────────────────────────── */

/** Fecha de hoy (UTC) en formato ISO corto. Se usa para vencimientos de licencia. */
export const todayIso = () => new Date().toISOString().slice(0, 10);

export const nowIso = () => new Date().toISOString();

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Suma meses a una fecha 'YYYY-MM-DD' recortando el día al último del mes destino
 * (31 ene + 1 mes = 28/29 feb, no 3 mar).
 */
export function addMonthsIso(dateIso, months) {
  const base = dateIso || todayIso();
  const [y, m, d] = base.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total % 12; // 0-11
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${pad2(targetMonth + 1)}-${pad2(Math.min(d, lastDay))}`;
}

/** Días restantes hasta el vencimiento (mismo criterio que el frontend: fin del día). */
export function daysLeft(license) {
  if (!license?.expires_at) return null;
  const end = new Date(`${license.expires_at}T23:59:59`).getTime();
  if (Number.isNaN(end)) return null;
  return Math.ceil((end - Date.now()) / 86_400_000);
}

/**
 * Estado efectivo de la licencia calculado al leer.
 * Un 'active' con fecha pasada se reporta como 'expired' sin depender de un cron.
 */
export function effectiveLicenseStatus(license) {
  if (!license) return 'pending';
  if (license.status === 'revoked') return 'revoked';
  if (license.status === 'pending') return 'pending';
  if (license.status === 'expired') return 'expired';
  if (license.expires_at && license.expires_at < todayIso()) return 'expired';
  return license.status === 'active' ? 'active' : 'pending';
}

export function isLicenseActive(account, license) {
  return account?.status === 'active' && effectiveLicenseStatus(license) === 'active';
}

/* ── JSON seguro ─────────────────────────────────────────────────────── */

export function safeJsonParse(raw, fallback, label = 'json') {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[db] ${label} corrupto; se usa el valor por defecto.`);
    return fallback;
  }
}

/* ── Transacciones ───────────────────────────────────────────────────── */

let inTransaction = false;

/**
 * Ejecuta `fn` dentro de una transacción IMMEDIATE (escritura bloqueada desde el inicio).
 * Si `fn` lanza, se hace ROLLBACK y el error se propaga.
 */
export function transaction(fn) {
  if (inTransaction) throw new Error('transacción anidada no soportada');
  db.exec('BEGIN IMMEDIATE');
  inTransaction = true;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* el rollback puede fallar si SQLite ya abortó: el error original es el relevante */
    }
    throw err;
  } finally {
    inTransaction = false;
  }
}

/* ── Sentencias preparadas ───────────────────────────────────────────── */

const q = {
  /* accounts */
  accountByLogin: db.prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE'),
  accountByUsername: db.prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE'),
  accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  countAdmins: db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'"),
  countAccounts: db.prepare('SELECT COUNT(*) AS n FROM accounts'),
  insertAccount: db.prepare(`
    INSERT INTO accounts (company_name, contact_name, email, username, password_hash, role, status, brand_color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateAccount: db.prepare(`
    UPDATE accounts SET company_name = ?, contact_name = ?, email = ?, status = ?, brand_color = ?, updated_at = ?
    WHERE id = ?
  `),
  updateAccountPassword: db.prepare('UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?'),
  updateAccountRole: db.prepare('UPDATE accounts SET role = ?, updated_at = ? WHERE id = ?'),
  updateAccountBrandColor: db.prepare('UPDATE accounts SET brand_color = ?, updated_at = ? WHERE id = ?'),
  listAccounts: db.prepare(`
    SELECT a.*,
           l.plan AS license_plan, l.seats AS license_seats, l.status AS license_status,
           l.started_at AS license_started_at, l.expires_at AS license_expires_at,
           l.payment_method AS license_payment_method, l.payment_ref AS license_payment_ref,
           l.amount_cents AS license_amount_cents, l.notes AS license_notes,
           l.updated_at AS license_updated_at,
           (SELECT COUNT(*) FROM participants p WHERE p.account_id = a.id) AS participants_count
    FROM accounts a
    LEFT JOIN licenses l ON l.account_id = a.id
    ORDER BY a.created_at DESC, a.id DESC
  `),
  listAccountsFiltered: db.prepare(`
    SELECT a.*,
           l.plan AS license_plan, l.seats AS license_seats, l.status AS license_status,
           l.started_at AS license_started_at, l.expires_at AS license_expires_at,
           l.payment_method AS license_payment_method, l.payment_ref AS license_payment_ref,
           l.amount_cents AS license_amount_cents, l.notes AS license_notes,
           l.updated_at AS license_updated_at,
           (SELECT COUNT(*) FROM participants p WHERE p.account_id = a.id) AS participants_count
    FROM accounts a
    LEFT JOIN licenses l ON l.account_id = a.id
    WHERE a.company_name LIKE ? OR a.contact_name LIKE ? OR a.email LIKE ? OR a.username LIKE ?
    ORDER BY a.created_at DESC, a.id DESC
  `),

  /* licenses */
  licenseByAccount: db.prepare('SELECT * FROM licenses WHERE account_id = ?'),
  insertLicenseIfMissing: db.prepare(`
    INSERT INTO licenses (account_id, plan, seats, status, started_at, expires_at, payment_method, payment_ref, amount_cents, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO NOTHING
  `),
  updateLicense: db.prepare(`
    UPDATE licenses SET plan = ?, seats = ?, status = ?, started_at = ?, expires_at = ?,
      payment_method = ?, payment_ref = ?, amount_cents = ?, notes = ?, updated_at = ?
    WHERE account_id = ?
  `),

  /* sessions */
  insertSession: db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'),
  sessionByHash: db.prepare(`
    SELECT a.*, s.expires_at AS session_expires_at
    FROM sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ?
  `),
  touchSession: db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteSessionsForAccount: db.prepare('DELETE FROM sessions WHERE account_id = ?'),
  deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

  /* branding */
  brandingByAccount: db.prepare('SELECT * FROM branding WHERE account_id = ?'),
  insertBrandingIfMissing: db.prepare(`
    INSERT INTO branding (account_id, display_name, logo_path, partners_json)
    VALUES (?, ?, NULL, '[]')
    ON CONFLICT(account_id) DO NOTHING
  `),
  upsertBranding: db.prepare(`
    INSERT INTO branding (account_id, display_name, logo_path, partners_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      display_name = excluded.display_name,
      logo_path = excluded.logo_path,
      partners_json = excluded.partners_json
  `),

  /* studios */
  studioByAccount: db.prepare('SELECT * FROM studios WHERE account_id = ?'),
  insertStudioIfMissing: db.prepare(`
    INSERT INTO studios (account_id, event_title, prize, round, settings_json)
    VALUES (?, '', 'Premio principal', 1, '{}')
    ON CONFLICT(account_id) DO NOTHING
  `),
  updateStudio: db.prepare('UPDATE studios SET event_title = ?, prize = ?, round = ?, settings_json = ? WHERE account_id = ?'),
  updateStudioRound: db.prepare('UPDATE studios SET round = ? WHERE account_id = ?'),

  /* participants */
  listParticipants: db.prepare('SELECT id, num, name, detail, won FROM participants WHERE account_id = ? ORDER BY position, id'),
  listEligible: db.prepare('SELECT id, num, name, detail FROM participants WHERE account_id = ? AND won = 0 ORDER BY position, id'),
  countEligible: db.prepare('SELECT COUNT(*) AS n FROM participants WHERE account_id = ? AND won = 0'),
  deleteParticipants: db.prepare('DELETE FROM participants WHERE account_id = ?'),
  insertParticipant: db.prepare('INSERT INTO participants (account_id, num, name, detail, won, position) VALUES (?, ?, ?, ?, 0, ?)'),
  resetParticipantsWon: db.prepare('UPDATE participants SET won = 0 WHERE account_id = ?'),
  countParticipants: db.prepare('SELECT COUNT(*) AS n FROM participants WHERE account_id = ?'),

  /* draws */
  insertDraw: db.prepare('INSERT INTO draws (account_id, round, prize, winners_json, created_at) VALUES (?, ?, ?, ?, ?)'),
  listDraws: db.prepare('SELECT * FROM draws WHERE account_id = ? ORDER BY id DESC'),
  listDrawsAsc: db.prepare('SELECT * FROM draws WHERE account_id = ? ORDER BY id ASC'),
  deleteDraws: db.prepare('DELETE FROM draws WHERE account_id = ?'),

  /* auditoría */
  insertAudit: db.prepare('INSERT INTO audit_log (actor_id, action, target_id, meta_json, created_at) VALUES (?, ?, ?, ?, ?)'),
  listAudit: db.prepare(`
    SELECT al.id, al.action, al.target_id, al.meta_json, al.created_at,
           actor.company_name AS actor_company, actor.username AS actor_username,
           target.company_name AS target_company
    FROM audit_log al
    LEFT JOIN accounts actor ON actor.id = al.actor_id
    LEFT JOIN accounts target ON target.id = al.target_id
    ORDER BY al.id DESC
    LIMIT ?
  `),

  /* login attempts */
  insertAttempt: db.prepare('INSERT INTO login_attempts (identifier, ip, ok, created_at) VALUES (?, ?, ?, ?)'),
  countFailuresByIdentifier: db.prepare(`
    SELECT COUNT(*) AS n FROM login_attempts
    WHERE identifier = ? AND ip = ? AND ok = 0 AND created_at >= ?
  `),
  countFailuresByIp: db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ok = 0 AND created_at >= ?'),
  pruneAttempts: db.prepare('DELETE FROM login_attempts WHERE created_at < ?')
};

/* ── Cuentas ─────────────────────────────────────────────────────────── */

export const getAccountByUsername = (username) => q.accountByUsername.get(username);
export const getAccountByLogin = (identifier) => q.accountByLogin.get(identifier, identifier);
export const getAccountById = (id) => q.accountById.get(id);
export const countAdmins = () => q.countAdmins.get().n;
export const countAccounts = () => q.countAccounts.get().n;

export function createAccount({
  companyName, contactName = '', email, username, passwordHash,
  role = 'user', status = 'active', brandColor = '#C9A227'
}) {
  const now = nowIso();
  const info = q.insertAccount.run(
    companyName, contactName, email, username, passwordHash, role, status, brandColor, now, now
  );
  return q.accountById.get(info.lastInsertRowid);
}

/** Guarda los campos mutables de una cuenta (se lee antes, se fusiona y se escribe completo). */
export function saveAccount(account) {
  q.updateAccount.run(
    account.company_name, account.contact_name, account.email, account.status,
    account.brand_color, nowIso(), account.id
  );
}

export const updateAccountPassword = (accountId, passwordHash) =>
  q.updateAccountPassword.run(passwordHash, nowIso(), accountId);

/** Cambia el rol (bootstrap/seed del admin). No se expone por API. */
export const setAccountRole = (accountId, role) => q.updateAccountRole.run(role, nowIso(), accountId);

export const updateAccountBrandColor = (accountId, brandColor) =>
  q.updateAccountBrandColor.run(brandColor, nowIso(), accountId);

export function listAccounts(search = '') {
  const term = search.trim();
  if (!term) return q.listAccounts.all();
  const like = `%${term}%`;
  return q.listAccountsFiltered.all(like, like, like, like);
}

/* ── Licencias ───────────────────────────────────────────────────────── */

export const getLicense = (accountId) => q.licenseByAccount.get(accountId);

export function insertLicenseIfMissing(accountId, {
  plan = 'mensual', seats = 1, status = 'pending', startedAt = null, expiresAt = null,
  paymentMethod = 'transferencia', paymentRef = '', amountCents = 0, notes = ''
} = {}) {
  q.insertLicenseIfMissing.run(
    accountId, plan, seats, status, startedAt, expiresAt, paymentMethod, paymentRef, amountCents, notes, nowIso()
  );
  return getLicense(accountId);
}

export function saveLicense(accountId, license) {
  q.updateLicense.run(
    license.plan, license.seats, license.status, license.started_at, license.expires_at,
    license.payment_method, license.payment_ref, license.amount_cents, license.notes, nowIso(), accountId
  );
  return getLicense(accountId);
}

/**
 * Crea las filas hijas que toda cuenta necesita (licencia, branding, studio).
 * Idempotente: sirve para bootstrap, alta desde admin y seed.
 */
export function ensureAccountScaffold(accountId, {
  displayName = '', license = {}
} = {}) {
  q.insertBrandingIfMissing.run(accountId, displayName);
  q.insertStudioIfMissing.run(accountId);
  insertLicenseIfMissing(accountId, license);
}

/* ── Sesiones ────────────────────────────────────────────────────────── */

export const insertSession = ({ tokenHash, accountId, createdAt, expiresAt, ip, userAgent }) =>
  q.insertSession.run(tokenHash, accountId, createdAt, expiresAt, ip, userAgent);

export const getSessionAccount = (tokenHash) => q.sessionByHash.get(tokenHash);
export const touchSession = (tokenHash, expiresAt) => q.touchSession.run(expiresAt, tokenHash);
export const deleteSession = (tokenHash) => q.deleteSession.run(tokenHash);
export const deleteSessionsForAccount = (accountId) => q.deleteSessionsForAccount.run(accountId);
export const deleteOtherSessions = (accountId, keepHash) => q.deleteOtherSessions.run(accountId, keepHash);
export const purgeExpiredSessions = () => q.purgeSessions.run(Date.now());

/* ── Branding ────────────────────────────────────────────────────────── */

export function getBranding(accountId) {
  const row = q.brandingByAccount.get(accountId);
  if (row) return row;
  // Nunca debería faltar (scaffold), pero si falta la creamos con defaults del schema.
  q.insertBrandingIfMissing.run(accountId, '');
  return q.brandingByAccount.get(accountId);
}

export function saveBranding(accountId, { displayName, logoPath, partnersJson }) {
  q.upsertBranding.run(accountId, displayName, logoPath, partnersJson);
  return getBranding(accountId);
}

/* ── Studio ──────────────────────────────────────────────────────────── */

export function getStudio(accountId) {
  const row = q.studioByAccount.get(accountId);
  if (row) return row;
  q.insertStudioIfMissing.run(accountId);
  return q.studioByAccount.get(accountId);
}

export function saveStudio(accountId, { eventTitle, prize, round, settingsJson }) {
  q.updateStudio.run(eventTitle, prize, round, settingsJson, accountId);
  return getStudio(accountId);
}

export const setStudioRound = (accountId, round) => q.updateStudioRound.run(round, accountId);

/* ── Participantes ───────────────────────────────────────────────────── */

export const listParticipants = (accountId) => q.listParticipants.all(accountId);
export const listEligibleParticipants = (accountId) => q.listEligible.all(accountId);
export const countEligibleParticipants = (accountId) => q.countEligible.get(accountId).n;
export const countParticipants = (accountId) => q.countParticipants.get(accountId).n;

/** Reemplaza la lista completa (borra + inserta) dentro de una transacción. */
export function replaceParticipants(accountId, rows) {
  transaction(() => {
    q.deleteParticipants.run(accountId);
    rows.forEach((row, index) => {
      q.insertParticipant.run(accountId, row.num, row.name, row.detail, index + 1);
    });
  });
  return listParticipants(accountId);
}

/** Marca ganadores asegurando el filtro por cuenta (defensa en profundidad). */
export function markParticipantsWon(accountId, ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(', ');
  const stmt = db.prepare(
    `UPDATE participants SET won = 1 WHERE account_id = ? AND id IN (${placeholders})`
  );
  stmt.run(accountId, ...ids);
}

/* ── Sorteos ─────────────────────────────────────────────────────────── */

export const insertDraw = ({ accountId, round, prize, winnersJson, createdAt }) =>
  q.insertDraw.run(accountId, round, prize, winnersJson, createdAt);

export const listDraws = (accountId) => q.listDraws.all(accountId);
export const listDrawsAsc = (accountId) => q.listDrawsAsc.all(accountId);
export const deleteDraws = (accountId) => q.deleteDraws.run(accountId);

/** Deja el sorteo listo para empezar de nuevo (conserva o borra participantes). */
export function resetStudio(accountId, { keepParticipants }) {
  transaction(() => {
    q.deleteDraws.run(accountId);
    q.resetParticipantsWon.run(accountId);
    if (!keepParticipants) q.deleteParticipants.run(accountId);
    q.updateStudioRound.run(1, accountId);
  });
}

/* ── Auditoría ───────────────────────────────────────────────────────── */

export function logAudit({ actorId = null, action, targetId = null, meta = {} }) {
  q.insertAudit.run(actorId, action, targetId, JSON.stringify(meta), nowIso());
}

export function listAudit(limit = 80) {
  return q.listAudit.all(limit).map((row) => ({
    id: row.id,
    action: row.action,
    targetCompany: row.target_company || null,
    actorName: row.actor_company || row.actor_username || null,
    createdAt: row.created_at,
    meta: safeJsonParse(row.meta_json, {}, 'audit.meta_json')
  }));
}

/* ── Rate limit de login ─────────────────────────────────────────────── */

export const countLoginFailures = (identifier, ip, since) =>
  q.countFailuresByIdentifier.get(identifier, ip, since).n;

export const countLoginFailuresByIp = (ip, since) => q.countFailuresByIp.get(ip, since).n;

export const recordLoginAttempt = ({ identifier, ip, ok }) =>
  q.insertAttempt.run(identifier, ip, ok ? 1 : 0, Date.now());

export const pruneLoginAttempts = (before) => q.pruneAttempts.run(before);

/* ── Secret de sesión ────────────────────────────────────────────────── */

let cachedSecret = null;

/**
 * SESSION_SECRET del entorno o uno generado y persistido en DATA_DIR/secret.
 * Se usa como material de firma reservado por el contrato; los tokens de sesión
 * se guardan como sha256(token) (ver auth.js).
 */
export function getSessionSecret() {
  if (cachedSecret) return cachedSecret;
  const fromEnv = (process.env.SESSION_SECRET || '').trim();
  if (fromEnv.length >= 32) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  if (fromEnv) console.warn('[db] SESSION_SECRET demasiado corto (<32); se ignora.');

  const file = path.join(DATA_DIR, 'secret');
  try {
    const stored = fs.readFileSync(file, 'utf8').trim();
    if (stored.length >= 32) {
      cachedSecret = stored;
      return cachedSecret;
    }
  } catch {
    /* primera ejecución: se genera abajo */
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  cachedSecret = generated;
  return cachedSecret;
}

/** Cierra la conexión (tests y scripts). */
export function closeDb() {
  try {
    db.close();
  } catch {
    /* ya estaba cerrada */
  }
}

export { q as statements };
