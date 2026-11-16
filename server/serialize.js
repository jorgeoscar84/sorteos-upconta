/* ═══════════════════════════════════════════════════════════════════════
   Serializadores: convierten filas SQLite (snake_case) a las formas JSON
   exactas de docs/API.md. Ningún hash ni dato interno sale por aquí.
   ═══════════════════════════════════════════════════════════════════════ */

import { effectiveLicenseStatus, daysLeft, safeJsonParse } from './db.js';

/** Defaults heredados del producto original (UI de estudio). */
export const SETTINGS_DEFAULTS = Object.freeze({
  winners: 1,
  turns: 8,
  duration: 8,
  removeWinners: true,
  sounds: true,
  confetti: true,
  simultaneous: true
});

/** settings_json puede venir incompleto o con basura: se normaliza al leer. */
export function mergeSettings(raw) {
  const parsed = typeof raw === 'string' ? safeJsonParse(raw, {}, 'studios.settings_json') : (raw || {});
  const out = { ...SETTINGS_DEFAULTS };
  if (Number.isInteger(parsed.winners) && parsed.winners >= 1 && parsed.winners <= 12) out.winners = parsed.winners;
  if (Number.isInteger(parsed.turns) && parsed.turns >= 2 && parsed.turns <= 40) out.turns = parsed.turns;
  if (Number.isInteger(parsed.duration) && parsed.duration >= 3 && parsed.duration <= 16) out.duration = parsed.duration;
  for (const key of ['removeWinners', 'sounds', 'confetti', 'simultaneous']) {
    if (typeof parsed[key] === 'boolean') out[key] = parsed[key];
  }
  return out;
}

/** Licencia "corta" usada por /auth/me, /studio/state y errores LICENSE_INACTIVE. */
export function licenseView(license) {
  return {
    plan: license?.plan ?? 'mensual',
    status: effectiveLicenseStatus(license),
    seats: license?.seats ?? 1,
    expiresAt: license?.expires_at ?? null,
    daysLeft: daysLeft(license)
  };
}

/** Licencia "larga" de la consola admin (forma exacta del contrato). */
export function licenseAdminView(license) {
  return {
    ...licenseView(license),
    amountCents: license?.amount_cents ?? 0,
    paymentRef: license?.payment_ref ?? '',
    notes: license?.notes ?? ''
  };
}

/** Usuario autenticado (nunca incluye password_hash). */
export function userView(account, license) {
  return {
    id: account.id,
    username: account.username,
    email: account.email,
    companyName: account.company_name,
    role: account.role,
    status: account.status,
    brandColor: account.brand_color,
    license: licenseView(license)
  };
}

/** Cuenta tal como la lista/administra el panel admin. */
export function accountAdminView(account, license, participantsCount) {
  return {
    id: account.id,
    companyName: account.company_name,
    contactName: account.contact_name,
    email: account.email,
    username: account.username,
    status: account.status,
    role: account.role,
    brandColor: account.brand_color,
    license: licenseAdminView(license),
    participants: participantsCount ?? 0,
    createdAt: account.created_at
  };
}

const UPLOAD_PATH_RE = /^\/uploads\/[a-f0-9]{32}\.(png|jpe?g|webp)$/;

/** partners_json guardado como [{name,path}] (nunca dataURLs). */
export function partnersView(branding) {
  const raw = safeJsonParse(branding?.partners_json, [], 'branding.partners_json');
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item.name === 'string' && typeof item.path === 'string' && UPLOAD_PATH_RE.test(item.path))
    .map((item) => ({ name: item.name, path: item.path }));
}

export function brandingView(branding, brandColor) {
  return {
    displayName: branding?.display_name ?? '',
    logoPath: branding?.logo_path ?? null,
    partners: partnersView(branding),
    brandColor: brandColor || '#C9A227'
  };
}

export function studioView(studio) {
  return {
    eventTitle: studio?.event_title ?? '',
    prize: studio?.prize ?? 'Premio principal',
    round: studio?.round ?? 1,
    settings: mergeSettings(studio?.settings_json)
  };
}

export function participantView(row) {
  return { id: row.id, num: row.num, name: row.name, detail: row.detail, won: row.won === 1 };
}

/** winners_json guarda más datos (detalle para el CSV) de los que expone la API. */
export function drawWinners(storedJson) {
  const raw = safeJsonParse(storedJson, [], 'draws.winners_json');
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w) => w && typeof w === 'object')
    .map((w) => ({ num: String(w.num ?? ''), name: String(w.name ?? ''), detail: String(w.detail ?? '') }));
}

export function drawView(row) {
  return {
    id: row.id,
    round: row.round,
    prize: row.prize,
    winners: drawWinners(row.winners_json).map((w) => ({ num: w.num, name: w.name })),
    createdAt: row.created_at
  };
}
