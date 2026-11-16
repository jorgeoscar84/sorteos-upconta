#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   Crea (o repara) la cuenta administrador de la plataforma.
   Uso:
     ADMIN_USERNAME=admin ADMIN_PASSWORD='una-clave-larga' npm run seed:admin
     node scripts/seed-admin.js <usuario> <contraseña>
   Es idempotente: si el usuario existe, actualiza la clave y garantiza
   rol admin + licencia activa sin vencimiento. Nunca imprime la contraseña.
   ═══════════════════════════════════════════════════════════════════════ */

import * as db from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { password as validatePassword, username as validateUsername } from '../server/validate.js';

const [, , argUsername, argPassword] = process.argv;
const rawUsername = argUsername || process.env.ADMIN_USERNAME || '';
const rawPassword = argPassword || process.env.ADMIN_PASSWORD || '';

function fail(message) {
  console.error(`[seed-admin] ${message}`);
  db.closeDb();
  process.exit(1);
}

if (!rawUsername || !rawPassword) {
  fail('faltan credenciales. Usa ADMIN_USERNAME/ADMIN_PASSWORD o pásalos como argumentos.');
}

try {
  const username = validateUsername(rawUsername);
  const password = validatePassword(rawPassword, 'ADMIN_PASSWORD');
  const passwordHash = await hashPassword(password);

  const existing = db.getAccountByUsername(username);

  if (existing) {
    db.transaction(() => {
      db.setAccountRole(existing.id, 'admin');
      db.saveAccount({ ...existing, status: 'active' });
      db.updateAccountPassword(existing.id, passwordHash);
      db.deleteSessionsForAccount(existing.id); // clave nueva: sesiones viejas fuera
      db.ensureAccountScaffold(existing.id, {
        displayName: existing.company_name || 'Sorteo Studio',
        license: {
          plan: 'anual',
          seats: 1,
          status: 'active',
          startedAt: db.todayIso(),
          expiresAt: null,
          notes: 'Cuenta administrador de la plataforma'
        }
      });
      // Si ya existía una licencia, se fuerza activa sin vencimiento.
      const license = db.getLicense(existing.id);
      db.saveLicense(existing.id, {
        ...license,
        plan: 'anual',
        status: 'active',
        started_at: license.started_at || db.todayIso(),
        expires_at: null
      });
      db.logAudit({ actorId: existing.id, action: 'ADMIN_SEEDED', targetId: existing.id, meta: { mode: 'update' } });
    });
    console.log(`[seed-admin] admin actualizado: ${username}`);
  } else {
    db.transaction(() => {
      const account = db.createAccount({
        companyName: 'Sorteo Studio',
        contactName: 'Administrador',
        email: `${username}@sorteo-studio.local`,
        username,
        passwordHash,
        role: 'admin',
        status: 'active'
      });
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
      db.logAudit({ actorId: account.id, action: 'ADMIN_SEEDED', targetId: account.id, meta: { mode: 'create' } });
    });
    console.log(`[seed-admin] admin creado: ${username}`);
  }

  db.closeDb();
  process.exit(0);
} catch (err) {
  fail(err.message);
}
