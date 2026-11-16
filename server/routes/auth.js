/* ═══════════════════════════════════════════════════════════════════════
   /api/auth — login, logout, sesión actual, cambio de contraseña.
   ═══════════════════════════════════════════════════════════════════════ */

import { Router } from 'express';
import * as db from '../db.js';
import {
  SESSION_COOKIE, clearSessionCookie, createSession, enforceLoginRateLimit, hashPassword,
  parseCookies, recordLoginAttempt, requireAuth, sha256Hex, verifyPassword, burnPasswordTime
} from '../auth.js';
import { userView } from '../serialize.js';
import { HttpError, asObject, asyncHandler, password, text } from '../validate.js';

const router = Router();

router.post('/login', asyncHandler(async (req, res) => {
  const body = asObject(req.body);
  const identifier = text(body.identifier, 'identifier', { min: 3, max: 254 });
  const plainPassword = text(body.password, 'password', { min: 1, max: 200, trim: false });
  const ip = req.ip || '';

  // Se comprueba el límite ANTES de tocar scrypt para no gastar CPU con un atacante.
  enforceLoginRateLimit(identifier, ip);

  const account = db.getAccountByLogin(identifier);
  const passwordOk = account ? await verifyPassword(plainPassword, account.password_hash) : false;
  if (!account) await burnPasswordTime(plainPassword); // misma latencia que un usuario real

  recordLoginAttempt({ identifier, ip, ok: passwordOk });

  if (!account || !passwordOk) {
    throw new HttpError('UNAUTHORIZED', 'Usuario o contraseña incorrectos.', 401);
  }
  if (account.status !== 'active') {
    throw new HttpError('FORBIDDEN', 'Esta cuenta está suspendida. Contacta a soporte.', 403);
  }

  // Si ya había una cookie, se invalida para no acumular sesiones del mismo navegador.
  const previous = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (previous) db.deleteSession(sha256Hex(previous));

  createSession(req, res, account.id);
  const license = db.getLicense(account.id);
  db.logAudit({ actorId: account.id, action: 'LOGIN_SUCCESS', targetId: account.id, meta: { ip } });

  res.json({ user: userView(account, license) });
}));

router.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) db.deleteSession(sha256Hex(token));
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const license = db.getLicense(req.account.id);
  res.json({ user: userView(req.account, license) });
});

router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const body = asObject(req.body);
  const currentPassword = text(body.currentPassword, 'currentPassword', { min: 1, max: 200, trim: false });
  const newPassword = password(body.newPassword, 'newPassword');

  const stillValid = await verifyPassword(currentPassword, req.account.password_hash);
  if (!stillValid) {
    throw new HttpError('BAD_REQUEST', 'La contraseña actual no es correcta.', 400);
  }
  if (currentPassword === newPassword) {
    throw new HttpError('BAD_REQUEST', 'La nueva contraseña debe ser distinta de la actual.', 400);
  }

  const newHash = await hashPassword(newPassword);
  db.updateAccountPassword(req.account.id, newHash);
  // El contrato pide invalidar "las otras" sesiones: la actual sigue viva.
  db.deleteOtherSessions(req.account.id, req.sessionTokenHash);
  db.logAudit({ actorId: req.account.id, action: 'PASSWORD_CHANGED', targetId: req.account.id, meta: {} });

  res.json({ ok: true });
}));

export default router;
