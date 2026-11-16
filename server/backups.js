/* ═══════════════════════════════════════════════════════════════════════
   Respaldos de la base de datos y verificación de integridad.

   Por qué existe: la base de licencias es el activo del negocio (quién pagó,
   hasta cuándo, qué se le entregó). SQLite guarda todo en un archivo en el
   volumen /data; un respaldo descargable protege contra corrupción o error
   humano aunque el volumen se pierda.

   Decisiones:
   - El snapshot se hace con `VACUUM INTO`, que es consistente incluso con
     escrituras concurrentes (copiar el archivo a mano podría capturar un
     estado a medias entre WAL y base).
   - Se guarda en DATA_DIR/backups y se conservan los últimos KEEP.
   - Además del automático diario, el admin puede crear y DESCARGAR uno:
     un respaldo que vive en el mismo volumen no sirve contra la pérdida
     del volumen, así que la copia fuera del servidor la hace el humano.
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, db, nowIso } from './db.js';
import { HttpError } from './validate.js';

export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const KEEP_BACKUPS = 14;
export const AUTO_EVERY_HOURS = 24;

/** Nombre válido de respaldo. Sin esto, `:name` sería una puerta a path traversal. */
export const BACKUP_NAME_RE = /^app-\d{8}-\d{6}(-\d{2})?\.db$/;

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-`
    + `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function ensureBackupDir() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

/** Lista de respaldos, del más nuevo al más viejo. */
export function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUPS_DIR)
    .filter((name) => BACKUP_NAME_RE.test(name))
    .map((name) => {
      const info = fs.statSync(path.join(BACKUPS_DIR, name));
      return { name, bytes: info.size, createdAt: info.mtime.toISOString() };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function latestBackupAt() {
  return listBackups()[0]?.createdAt || null;
}

function prune() {
  const all = listBackups();
  for (const old of all.slice(KEEP_BACKUPS)) {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, old.name)); }
    catch { /* si falla, se reintenta en la próxima pasada */ }
  }
  // Restos de un proceso anterior interrumpido
  for (const name of fs.readdirSync(BACKUPS_DIR)) {
    if (name.endsWith('.tmp')) {
      try { fs.unlinkSync(path.join(BACKUPS_DIR, name)); } catch { /* igual */ }
    }
  }
}

/**
 * Crea un snapshot consistente de la base y lo deja en BACKUPS_DIR.
 * @returns {{name: string, bytes: number, createdAt: string}}
 */
export function createBackup() {
  ensureBackupDir();
  const base = `app-${stamp()}`;
  let name = `${base}.db`;
  for (let i = 2; fs.existsSync(path.join(BACKUPS_DIR, name)); i += 1) {
    name = `${base}-${String(i).padStart(2, '0')}.db`;
  }
  const target = path.join(BACKUPS_DIR, name);
  const temp = `${target}.tmp`;

  // VACUUM INTO escribe una copia coherente en un archivo nuevo.
  const escaped = temp.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  fs.renameSync(temp, target);
  prune();

  const info = fs.statSync(target);
  if (!info.size) throw new Error('El respaldo salió vacío.');
  return { name, bytes: info.size, createdAt: info.mtime.toISOString() };
}

/** Crea el respaldo automático si el último tiene más de AUTO_EVERY_HOURS. */
export function runAutoBackupIfDue() {
  const last = latestBackupAt();
  const due = !last || (Date.now() - new Date(last).getTime()) >= AUTO_EVERY_HOURS * 3600_000;
  if (!due) return null;
  return createBackup();
}

/** Ruta absoluta y validada de un respaldo existente. */
export function resolveBackupPath(name) {
  if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) {
    throw new HttpError('NOT_FOUND', 'Ese respaldo no existe.', 404);
  }
  const absolute = path.join(BACKUPS_DIR, name);
  const relative = path.relative(BACKUPS_DIR, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError('NOT_FOUND', 'Ese respaldo no existe.', 404);
  }
  if (!fs.existsSync(absolute)) {
    throw new HttpError('NOT_FOUND', 'Ese respaldo ya no está en el servidor.', 404);
  }
  return { path: absolute, name };
}

function scalar(sql) {
  const row = db.prepare(sql).get();
  return row ? Number(Object.values(row)[0]) : 0;
}

/** `PRAGMA integrity_check` + conteos para que el admin vea qué está respaldando. */
export function integrityCheck() {
  const row = db.prepare('PRAGMA integrity_check').get();
  const integrity = String(row ? Object.values(row)[0] : 'unknown');
  return {
    ok: integrity === 'ok',
    integrity,
    counts: {
      accounts: scalar('SELECT COUNT(*) AS n FROM accounts'),
      licenses: scalar('SELECT COUNT(*) AS n FROM licenses'),
      participants: scalar('SELECT COUNT(*) AS n FROM participants'),
      draws: scalar('SELECT COUNT(*) AS n FROM draws')
    },
    checkedAt: nowIso()
  };
}
