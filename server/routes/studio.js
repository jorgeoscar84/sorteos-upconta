/* ═══════════════════════════════════════════════════════════════════════
   /api/studio — estado del evento, branding, settings, participantes,
   sorteo autoritativo en servidor, reset y export CSV.
   Requiere sesión + licencia activa. TODO se filtra por account_id.
   ═══════════════════════════════════════════════════════════════════════ */

import { Router } from 'express';
import crypto from 'node:crypto';
import * as db from '../db.js';
import { requireAuth, requireLicense } from '../auth.js';
import {
  brandingView, drawView, drawWinners, licenseView, mergeSettings,
  participantView, partnersView, studioView
} from '../serialize.js';
import { UPLOAD_PATH_RE, deleteUpload, saveImageDataUrl, uploadExists } from '../uploads.js';
import {
  HttpError, asObject, asyncHandler, arrayOf, badRequest, bool, brandColor,
  has, integer, text
} from '../validate.js';

const router = Router();

// Ninguna ruta de studio es alcanzable sin estos dos middlewares.
router.use(requireAuth, requireLicense);

/* ── Helpers ─────────────────────────────────────────────────────────── */

/**
 * Fisher–Yates parcial con `crypto.randomInt` (uniforme, sin sesgo de módulo).
 * Devuelve `count` ganadores distintos de la lista elegible.
 */
function pickWinners(participants, count) {
  const pool = participants.slice();
  for (let i = 0; i < count; i += 1) {
    const j = i + crypto.randomInt(pool.length - i);
    const swap = pool[i];
    pool[i] = pool[j];
    pool[j] = swap;
  }
  return pool.slice(0, count);
}

const csvCell = (value) => {
  const raw = String(value ?? '');
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
};

/** Normaliza el num de un participante (Excel a veces manda número). */
function participantNum(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, 20);
  return text(value, field, { min: 1, max: 40 });
}

/* ── GET /state ──────────────────────────────────────────────────────── */

router.get('/state', (req, res) => {
  const accountId = req.account.id;
  const license = db.getLicense(accountId);
  const branding = db.getBranding(accountId);
  const studio = db.getStudio(accountId);

  res.json({
    branding: brandingView(branding, req.account.brand_color),
    studio: studioView(studio),
    participants: db.listParticipants(accountId).map(participantView),
    draws: db.listDraws(accountId).map(drawView),
    license: licenseView(license)
  });
});

/* ── PUT /branding ───────────────────────────────────────────────────── */

router.put('/branding', asyncHandler(async (req, res) => {
  const body = asObject(req.body);
  const account = req.account;
  const current = db.getBranding(account.id);
  const currentPartners = partnersView(current);

  let displayName = current.display_name;
  let logoPath = current.logo_path ?? null;
  let nextBrandColor = account.brand_color;
  let partners = currentPartners;
  const freshFiles = []; // para limpiar si la escritura en DB falla

  if (has(body, 'displayName')) {
    displayName = text(body.displayName, 'displayName', { min: 0, max: 80, allowNull: true });
  }
  if (has(body, 'brandColor')) {
    nextBrandColor = brandColor(body.brandColor);
  }
  if (has(body, 'logoDataUrl')) {
    if (body.logoDataUrl === null || body.logoDataUrl === '') {
      logoPath = null; // quitar logo
    } else {
      logoPath = saveImageDataUrl(body.logoDataUrl, 'logoDataUrl');
      freshFiles.push(logoPath);
    }
  }

  if (has(body, 'partners')) {
    const list = arrayOf(body.partners, 'partners', { max: 12 });
    partners = list.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw badRequest(`partners[${index}] debe ser un objeto.`);
      }
      const name = text(item.name, `partners[${index}].name`, { min: 0, max: 60, allowNull: true });
      if (has(item, 'dataUrl') && item.dataUrl !== null && item.dataUrl !== '') {
        const path = saveImageDataUrl(item.dataUrl, `partners[${index}].dataUrl`);
        freshFiles.push(path);
        return { name, path };
      }
      // Tolerancia para round-trip: el frontend puede reenviar el path del state.
      if (typeof item.path === 'string' && UPLOAD_PATH_RE.test(item.path) && uploadExists(item.path)) {
        return { name, path: item.path };
      }
      throw badRequest(`partners[${index}] necesita una imagen (dataUrl).`);
    });
  }

  let saved;
  try {
    saved = db.saveBranding(account.id, {
      displayName,
      logoPath,
      partnersJson: JSON.stringify(partners)
    });
    if (nextBrandColor !== account.brand_color) {
      db.updateAccountBrandColor(account.id, nextBrandColor);
    }
  } catch (err) {
    // No dejar archivos huérfanos si falló la persistencia.
    for (const path of freshFiles) deleteUpload(path);
    throw err;
  }

  // Borrar los archivos reemplazados: ya no están referenciados por esta cuenta.
  const keep = new Set([saved.logo_path, ...partnersView(saved).map((p) => p.path)].filter(Boolean));
  const previous = new Set([current.logo_path, ...currentPartners.map((p) => p.path)].filter(Boolean));
  for (const path of previous) {
    if (!keep.has(path)) deleteUpload(path);
  }

  res.json({ branding: brandingView(saved, nextBrandColor) });
}));

/* ── PUT /settings ───────────────────────────────────────────────────── */

router.put('/settings', asyncHandler(async (req, res) => {
  const body = asObject(req.body);
  const accountId = req.account.id;
  const studio = db.getStudio(accountId);
  const settings = mergeSettings(studio.settings_json);

  let eventTitle = studio.event_title;
  let prize = studio.prize;

  if (has(body, 'eventTitle')) {
    eventTitle = text(body.eventTitle, 'eventTitle', { min: 0, max: 120, allowNull: true });
  }
  if (has(body, 'prize')) {
    prize = text(body.prize, 'prize', { min: 1, max: 90 });
  }
  if (has(body, 'winners')) settings.winners = integer(body.winners, 'winners', { min: 1, max: 12 });
  if (has(body, 'turns')) settings.turns = integer(body.turns, 'turns', { min: 2, max: 40 });
  if (has(body, 'duration')) settings.duration = integer(body.duration, 'duration', { min: 3, max: 16 });
  for (const key of ['removeWinners', 'sounds', 'confetti', 'simultaneous']) {
    if (has(body, key)) settings[key] = bool(body[key], key);
  }

  const saved = db.saveStudio(accountId, {
    eventTitle,
    prize,
    round: studio.round,
    settingsJson: JSON.stringify(settings)
  });

  res.json({ studio: studioView(saved) });
}));

/* ── PUT /participants ───────────────────────────────────────────────── */

router.put('/participants', asyncHandler(async (req, res) => {
  const body = asObject(req.body);
  const accountId = req.account.id;
  const list = arrayOf(body.participants, 'participants', { max: 2000 });

  const seen = new Set();
  const rows = [];

  list.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw badRequest(`participants[${index}] debe ser un objeto.`);
    }
    const name = text(item.name, `participants[${index}].name`, { min: 1, max: 120 });
    const num = participantNum(item.num, `participants[${index}].num`, String(rows.length + 1));
    const detail = has(item, 'detail')
      ? text(item.detail, `participants[${index}].detail`, { min: 0, max: 160, allowNull: true })
      : '';

    // Dedupe por num+name para que un Excel con filas repetidas no infle la ruleta.
    const key = `${num.toLowerCase()}\u0000${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ num, name, detail });
  });

  const participants = db.replaceParticipants(accountId, rows);
  res.json({ count: participants.length, participants: participants.map(participantView) });
}));

/* ── POST /draw ──────────────────────────────────────────────────────── */

router.post('/draw', asyncHandler(async (req, res) => {
  const body = asObject(req.body);
  const accountId = req.account.id;

  // La elección ocurre DENTRO de una transacción: nadie puede colarse entre leer y marcar.
  const result = db.transaction(() => {
    const studio = db.getStudio(accountId);
    const settings = mergeSettings(studio.settings_json);
    const count = has(body, 'count') ? integer(body.count, 'count', { min: 1, max: 12 }) : settings.winners;
    const prize = has(body, 'prize') && body.prize !== null && body.prize !== ''
      ? text(body.prize, 'prize', { min: 1, max: 90 })
      : studio.prize;

    const eligible = db.listEligibleParticipants(accountId);
    if (eligible.length === 0) {
      throw new HttpError('CONFLICT', 'No quedan participantes elegibles. Reinicia el sorteo para volver a sortear.', 409);
    }

    const winners = pickWinners(eligible, Math.min(count, eligible.length));
    const stored = winners.map((w) => ({ id: w.id, num: w.num, name: w.name, detail: w.detail }));

    db.insertDraw({
      accountId,
      round: studio.round,
      prize,
      winnersJson: JSON.stringify(stored),
      createdAt: db.nowIso()
    });
    if (settings.removeWinners) {
      db.markParticipantsWon(accountId, stored.map((w) => w.id));
    }
    const remaining = db.countEligibleParticipants(accountId);

    // El contrato avanza la ronda solo cuando ya no quedan elegibles.
    let nextRound = studio.round;
    if (remaining === 0) {
      nextRound += 1;
      db.setStudioRound(accountId, nextRound);
    }

    db.logAudit({
      actorId: accountId,
      action: 'DRAW_COMPLETED',
      targetId: accountId,
      meta: { round: studio.round, prize, winners: stored.map((w) => `${w.num} ${w.name}`) }
    });

    return { winners: stored, round: nextRound, remaining };
  });

  res.json(result);
}));

/* ── POST /reset ─────────────────────────────────────────────────────── */

router.post('/reset', asyncHandler(async (req, res) => {
  const body = asObject(req.body);
  const accountId = req.account.id;
  // Por seguridad, si el cliente no dice nada se conservan los participantes.
  const keepParticipants = has(body, 'keepParticipants') ? bool(body.keepParticipants, 'keepParticipants') : true;

  db.resetStudio(accountId, { keepParticipants });
  db.logAudit({
    actorId: accountId,
    action: 'STUDIO_RESET',
    targetId: accountId,
    meta: { keepParticipants }
  });

  res.json({ ok: true });
}));

/* ── GET /results.csv ────────────────────────────────────────────────── */

router.get('/results.csv', (req, res) => {
  const rows = db.listDrawsAsc(req.account.id);
  const lines = ['SORTEO,NUMERO,NOMBRE,DETALLE,PREMIO,FECHA'];

  for (const draw of rows) {
    for (const winner of drawWinners(draw.winners_json)) {
      lines.push([
        draw.round, winner.num, winner.name, winner.detail, draw.prize, draw.created_at
      ].map(csvCell).join(','));
    }
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="resultados.csv"');
  res.send(`${lines.join('\r\n')}\r\n`);
});

export default router;
