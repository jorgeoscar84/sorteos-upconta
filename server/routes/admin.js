/* ═══════════════════════════════════════════════════════════════════════
   /api/admin — consola de licencias (solo role='admin').
   Cuentas, licencias, renovaciones, reseteo de contraseña y bitácora.
   ═══════════════════════════════════════════════════════════════════════ */

import { Router } from 'express';
import * as db from '../db.js';
import { hashPassword, requireAdmin, requireAuth } from '../auth.js';
import { accountAdminView } from '../serialize.js';
import {
  HttpError, accountStatus, asObject, asyncHandler, brandColor, email, integer, isoDate,
  licenseStatus, oneOf, password, positiveId, text, username, uniqueViolation
} from '../validate.js';

const router = Router();

router.use(requireAuth, requireAdmin);

/* ── Helpers ─────────────────────────────────────────────────────────── */

function requireAccount(id) {
  const account = db.getAccountById(id);
  if (!account) throw new HttpError('NOT_FOUND', 'Cuenta no encontrada.', 404);
  return account;
}

/** Reconstruye la licencia desde las columnas alias de listAccounts(). */
const licenseFromRow = (row) => (row.license_status === null || row.license_status === undefined ? null : {
  plan: row.license_plan,
  seats: row.license_seats,
  status: row.license_status,
  started_at: row.license_started_at,
  expires_at: row.license_expires_at,
  payment_method: row.license_payment_method,
  payment_ref: row.license_payment_ref,
  amount_cents: row.license_amount_cents,
  notes: row.license_notes
});

function accountPayload(accountId) {
  const account = db.getAccountById(accountId);
  const license = db.getLicense(accountId);
  return accountAdminView(account, license, db.countParticipants(accountId));
}

/** Traduce la violación UNIQUE de SQLite al campo concreto. */
function rethrowUnique(err) {
  if (uniqueViolation(err, 'accounts.username')) {
    throw new HttpError('CONFLICT', 'Ese nombre de usuario ya está en uso.', 409);
  }
  if (uniqueViolation(err, 'accounts.email')) {
    throw new HttpError('CONFLICT', 'Ese email ya está registrado.', 409);
  }
  throw err;
}

const DEFAULT_LICENSE = {
  plan: 'mensual', seats: 1, status: 'pending', startedAt: null, expiresAt: null,
  paymentMethod: 'transferencia', paymentRef: '', amountCents: 0, notes: ''
};

/* ── GET /overview ───────────────────────────────────────────────────── */

router.get('/overview', (req, res) => {
  const accounts = db.listAccounts('');

  let active = 0;
  let pending = 0;
  let expiringSoon = 0;
  let revenueCents = 0;

  for (const row of accounts) {
    const license = licenseFromRow(row);
    const status = db.effectiveLicenseStatus(license);
    if (status === 'active') {
      active += 1;
      const left = db.daysLeft(license);
      if (left !== null && left >= 0 && left <= 7) expiringSoon += 1;
    } else if (status === 'pending') {
      pending += 1;
    }
    // "Ingresos cobrados": lo pendiente de transferencia todavía no es ingreso.
    if (status !== 'pending') revenueCents += Number(row.license_amount_cents || 0);
  }

  res.json({ totalAccounts: accounts.length, active, pending, expiringSoon, revenueCents });
});

/* ── GET /accounts?q= ────────────────────────────────────────────────── */

router.get('/accounts', (req, res) => {
  const raw = req.query.q;
  const search = raw === undefined ? '' : text(raw, 'q', { min: 0, max: 120, allowNull: true });

  const accounts = db.listAccounts(search).map((row) => {
    const license = licenseFromRow(row);
    return accountAdminView(
      {
        id: row.id,
        company_name: row.company_name,
        contact_name: row.contact_name,
        email: row.email,
        username: row.username,
        status: row.status,
        role: row.role,
        brand_color: row.brand_color,
        created_at: row.created_at
      },
      license,
      row.participants_count
    );
  });

  res.json({ accounts });
});

/* ── POST /accounts ──────────────────────────────────────────────────── */

router.post('/accounts', asyncHandler(async (req, res) => {
  const body = asObject(req.body);

  const companyName = text(body.companyName, 'companyName', { min: 1, max: 80 });
  const contactName = body.contactName === undefined ? '' : text(body.contactName, 'contactName', { min: 0, max: 80, allowNull: true });
  const mail = email(body.email);
  const user = username(body.username);
  const plainPassword = password(body.password);
  const accountStatusValue = body.status === undefined ? 'active' : accountStatus(body.status);
  const planValue = body.plan === undefined ? DEFAULT_LICENSE.plan : oneOf(body.plan, 'plan', ['mensual', 'trimestral', 'anual', 'evento']);
  const seats = body.seats === undefined ? 1 : integer(body.seats, 'seats', { min: 1, max: 100 });
  const expiresAt = body.expiresAt === undefined ? null : isoDate(body.expiresAt, 'expiresAt');
  const amountCents = body.amountCents === undefined ? 0 : integer(body.amountCents, 'amountCents', { min: 0, max: 100_000_000 });
  const notes = body.notes === undefined ? '' : text(body.notes, 'notes', { min: 0, max: 500, allowNull: true });
  // Extensión tolerante acordada con el panel: permite crear la cuenta ya pagada.
  const licenseStatusValue = body.licenseStatus === undefined ? 'pending' : licenseStatus(body.licenseStatus);

  const passwordHash = await hashPassword(plainPassword);

  let accountId;
  try {
    accountId = db.transaction(() => {
      const account = db.createAccount({
        companyName,
        contactName,
        email: mail,
        username: user,
        passwordHash,
        role: 'user',
        status: accountStatusValue
      });
      db.ensureAccountScaffold(account.id, {
        displayName: companyName,
        license: {
          ...DEFAULT_LICENSE,
          plan: planValue,
          seats,
          status: licenseStatusValue,
          startedAt: licenseStatusValue === 'active' ? db.todayIso() : null,
          expiresAt,
          amountCents,
          notes
        }
      });
      db.logAudit({
        actorId: req.account.id,
        action: 'ACCOUNT_CREATED',
        targetId: account.id,
        meta: { companyName, username: user, plan: planValue, licenseStatus: licenseStatusValue }
      });
      return account.id;
    });
  } catch (err) {
    rethrowUnique(err);
  }

  res.status(201).json({ account: accountPayload(accountId) });
}));

/* ── PATCH /accounts/:id ─────────────────────────────────────────────── */

router.patch('/accounts/:id', asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id, 'id');
  const account = requireAccount(id);
  const body = asObject(req.body);
  const entries = Object.keys(body);

  // La cuenta y su licencia se leen, se fusionan y se escriben completas:
  // así no hay SQL dinámico y el update es atómico.
  const mergedAccount = { ...account };
  const license = db.getLicense(id) || db.insertLicenseIfMissing(id, DEFAULT_LICENSE);
  const mergedLicense = { ...license };

  if (entries.includes('companyName')) mergedAccount.company_name = text(body.companyName, 'companyName', { min: 1, max: 80 });
  if (entries.includes('contactName')) mergedAccount.contact_name = text(body.contactName, 'contactName', { min: 0, max: 80, allowNull: true });
  if (entries.includes('email')) mergedAccount.email = email(body.email);
  if (entries.includes('brandColor')) mergedAccount.brand_color = brandColor(body.brandColor);
  if (entries.includes('status')) {
    mergedAccount.status = accountStatus(body.status);
    if (mergedAccount.status === 'suspended' && id === req.account.id) {
      throw new HttpError('BAD_REQUEST', 'No puedes suspender tu propia cuenta.', 400);
    }
  }

  if (entries.includes('plan')) mergedLicense.plan = oneOf(body.plan, 'plan', ['mensual', 'trimestral', 'anual', 'evento']);
  if (entries.includes('seats')) mergedLicense.seats = integer(body.seats, 'seats', { min: 1, max: 100 });
  if (entries.includes('expiresAt')) mergedLicense.expires_at = isoDate(body.expiresAt, 'expiresAt');
  if (entries.includes('amountCents')) mergedLicense.amount_cents = integer(body.amountCents, 'amountCents', { min: 0, max: 100_000_000 });
  if (entries.includes('paymentRef')) mergedLicense.payment_ref = text(body.paymentRef, 'paymentRef', { min: 0, max: 80, allowNull: true });
  if (entries.includes('notes')) mergedLicense.notes = text(body.notes, 'notes', { min: 0, max: 500, allowNull: true });
  if (entries.includes('licenseStatus')) {
    mergedLicense.status = licenseStatus(body.licenseStatus);
    // Si se activa el pago sin fecha de inicio, el inicio es hoy.
    if (mergedLicense.status === 'active' && !mergedLicense.started_at) {
      mergedLicense.started_at = db.todayIso();
    }
  }

  const newPassword = entries.includes('password') ? password(body.password, 'password') : null;
  const newHash = newPassword ? await hashPassword(newPassword) : null;
  // Suspender debe cortar el acceso ya mismo, no en el siguiente login.
  const justSuspended = entries.includes('status') && mergedAccount.status === 'suspended' && account.status !== 'suspended';

  try {
    db.transaction(() => {
      db.saveAccount(mergedAccount);
      db.saveLicense(id, mergedLicense);
      if (newHash) {
        db.updateAccountPassword(id, newHash);
        db.deleteSessionsForAccount(id); // cambió la contraseña: fuera todas las sesiones
      }
      if (justSuspended) db.deleteSessionsForAccount(id);
      db.logAudit({
        actorId: req.account.id,
        action: 'ACCOUNT_UPDATED',
        targetId: id,
        meta: { fields: entries.filter((key) => key !== 'password'), passwordChanged: Boolean(newHash) }
      });
    });
  } catch (err) {
    rethrowUnique(err);
  }

  res.json({ account: accountPayload(id) });
}));

/* ── POST /accounts/:id/renew ────────────────────────────────────────── */

router.post('/accounts/:id/renew', asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id, 'id');
  requireAccount(id);
  const body = asObject(req.body);

  const months = integer(body.months, 'months', { min: 1, max: 60 });
  const license = db.getLicense(id) || db.insertLicenseIfMissing(id, DEFAULT_LICENSE);
  const planValue = body.plan === undefined ? license.plan : oneOf(body.plan, 'plan', ['mensual', 'trimestral', 'anual', 'evento']);

  // Extiende desde el vencimiento actual o desde hoy, lo que sea posterior.
  const base = license.expires_at && license.expires_at > db.todayIso() ? license.expires_at : db.todayIso();
  const nextExpires = db.addMonthsIso(base, months);

  db.transaction(() => {
    db.saveLicense(id, {
      ...license,
      plan: planValue,
      status: 'active',
      started_at: license.started_at || db.todayIso(),
      expires_at: nextExpires
    });
    db.logAudit({
      actorId: req.account.id,
      action: 'LICENSE_RENEWED',
      targetId: id,
      meta: { months, plan: planValue, from: license.expires_at, to: nextExpires }
    });
  });

  res.json({ account: accountPayload(id) });
}));

/* ── POST /accounts/:id/reset-password ───────────────────────────────── */

router.post('/accounts/:id/reset-password', asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id, 'id');
  requireAccount(id);
  const body = asObject(req.body);
  const newPassword = password(body.newPassword, 'newPassword');
  const newHash = await hashPassword(newPassword);

  db.updateAccountPassword(id, newHash);
  db.deleteSessionsForAccount(id); // el usuario debe volver a entrar con la clave nueva
  db.logAudit({ actorId: req.account.id, action: 'PASSWORD_RESET', targetId: id, meta: {} });

  res.json({ ok: true });
}));

/* ── GET /audit?limit=80 ─────────────────────────────────────────────── */

router.get('/audit', (req, res) => {
  const raw = req.query.limit;
  let limit = 80;
  if (raw !== undefined) {
    const parsed = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      throw new HttpError('BAD_REQUEST', 'El parámetro limit debe ser un entero entre 1 y 500.', 400);
    }
    limit = parsed;
  }
  res.json({ entries: db.listAudit(limit) });
});

export default router;
