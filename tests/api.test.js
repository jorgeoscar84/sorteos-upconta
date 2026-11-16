/* ═══════════════════════════════════════════════════════════════════════
   Tests de integración de la API (node:test + node:assert/strict).
   Arranca el servidor real en un puerto efímero con DATA_DIR temporal.
   Ejecutar:  npm test
   ═══════════════════════════════════════════════════════════════════════ */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sorteo-api-test-'));

// El entorno se fija ANTES de importar el servidor: db.js resuelve DATA_DIR al importarse.
process.env.DATA_DIR = TMP;
process.env.NODE_ENV = 'test';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'Admin-Sorteo-2026';
process.env.SESSION_SECRET = 'test-secret-para-sorteo-studio-1234567890';
delete process.env.APP_ORIGIN;

const { createApp } = await import('../server/index.js');
const { closeDb } = await import('../server/db.js');

/* Imagen PNG 1x1 válida y JPEG 1x1 válida para probar uploads. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const today = () => new Date().toISOString().slice(0, 10);
const futureDate = () => new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
const pngDataUrl = (b64 = PNG_B64) => `data:image/png;base64,${b64}`;
const b64 = (text) => Buffer.from(text).toString('base64');

let server;
let base;
let adminCookie;
let acmeCookie;
let betaCookie;
let acmeId;
let betaId;

/* ── Cliente HTTP mínimo con CSRF y cookies manuales ─────────────────── */

async function api(method, pathname, opts = {}) {
  const { body, cookie, headers = {}, csrf = true, origin = 'same' } = opts;
  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (csrf) finalHeaders['X-Requested-With'] = 'fetch';
  if (origin === 'same') finalHeaders.Origin = base;
  else if (typeof origin === 'string') finalHeaders.Origin = origin;
  if (cookie) finalHeaders.Cookie = cookie;

  const res = await fetch(base + pathname, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString('utf8');
  let json = null;
  if ((res.headers.get('content-type') || '').includes('json')) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { res, status: res.status, json, text, buffer, setCookies: res.headers.getSetCookie?.() ?? [] };
}

const cookieFrom = (result) => {
  const raw = result.setCookies.find((value) => value.startsWith('sid='));
  return raw ? raw.split(';')[0] : null;
};

async function login(identifier, password, cookie) {
  const result = await api('POST', '/api/auth/login', { body: { identifier, password }, cookie });
  return { ...result, cookie: cookieFrom(result) };
}

async function createAccount(overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const payload = {
    companyName: `Empresa ${suffix}`,
    contactName: 'Contacto',
    email: `cuenta-${suffix}@test.local`,
    username: `cuenta_${suffix}`,
    password: 'ClaveSegura-2026',
    plan: 'mensual',
    seats: 1,
    expiresAt: futureDate(),
    status: 'active',
    amountCents: 0,
    notes: '',
    ...overrides
  };
  const result = await api('POST', '/api/admin/accounts', { body: payload, cookie: adminCookie });
  return { result, payload };
}

/* ── Arranque / cierre ───────────────────────────────────────────────── */

before(async () => {
  const app = await createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const adminLogin = await login('admin', 'Admin-Sorteo-2026');
  assert.equal(adminLogin.status, 200, 'el bootstrap del admin debe permitir entrar');
  adminCookie = adminLogin.cookie;
  assert.ok(adminCookie, 'login admin debe entregar cookie sid');
});

after(async () => {
  if (server) {
    await new Promise((resolve) => {
      server.close(() => resolve());
      // undici mantiene sockets keep-alive: cerrarlos permite que el test termine.
      server.closeAllConnections?.();
    });
  }
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ── 9) healthz ──────────────────────────────────────────────────────── */

test('healthz responde 200 ok', async () => {
  const result = await api('GET', '/healthz');
  assert.equal(result.status, 200);
  assert.equal(result.text, 'ok');
  assert.equal(result.res.headers.get('x-content-type-options'), 'nosniff');
});

/* ── 1) login correcto / incorrecto ──────────────────────────────────── */

test('login rechaza credenciales incorrectas y usuarios inexistentes', async () => {
  const wrongPassword = await api('POST', '/api/auth/login', {
    body: { identifier: 'admin', password: 'clave-equivocada' }
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.json.error, 'UNAUTHORIZED');
  assert.equal(wrongPassword.setCookies.length, 0, 'no debe entregar cookie con credenciales malas');

  const unknown = await api('POST', '/api/auth/login', {
    body: { identifier: 'no.existe', password: 'ClaveSegura-2026' }
  });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.error, 'UNAUTHORIZED');
});

test('login correcto entrega cookie HttpOnly SameSite=Lax y /me devuelve el usuario', async () => {
  const result = await login('admin', 'Admin-Sorteo-2026');
  assert.equal(result.status, 200);
  assert.equal(result.json.user.role, 'admin');
  assert.equal(result.json.user.username, 'admin');

  const rawCookie = result.setCookies.find((value) => value.startsWith('sid='));
  assert.ok(rawCookie, 'falta la cookie sid');
  assert.match(rawCookie, /HttpOnly/i);
  assert.match(rawCookie, /SameSite=Lax/i);
  assert.match(rawCookie, /Path=\//);

  const me = await api('GET', '/api/auth/me', { cookie: result.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.username, 'admin');
  assert.equal(me.json.user.license.status, 'active');
  assert.equal(me.json.user.password_hash, undefined);
  assert.ok(!JSON.stringify(me.json).includes('scrypt$'), 'nunca debe filtrarse el hash');
});

/* ── 2) rate limit ───────────────────────────────────────────────────── */

test('rate limit: bloquea al noveno intento fallido (8/15 min por identifier+IP)', async () => {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = await api('POST', '/api/auth/login', {
      body: { identifier: 'intruso', password: `intento-${attempt}` }
    });
    assert.equal(result.status, 401, `el intento ${attempt} debe ser 401 antes del límite`);
  }
  const blocked = await api('POST', '/api/auth/login', {
    body: { identifier: 'intruso', password: 'intento-9' }
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, 'RATE_LIMITED');
});

/* ── 8) CSRF ─────────────────────────────────────────────────────────── */

test('CSRF: métodos mutantes exigen X-Requested-With y Origin del mismo host', async () => {
  const noHeader = await api('POST', '/api/auth/login', {
    body: { identifier: 'admin', password: 'Admin-Sorteo-2026' },
    csrf: false
  });
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.json.error, 'FORBIDDEN');

  const noOrigin = await api('POST', '/api/auth/login', {
    body: { identifier: 'admin', password: 'Admin-Sorteo-2026' },
    origin: null
  });
  assert.equal(noOrigin.status, 403);

  const foreignOrigin = await api('POST', '/api/auth/login', {
    body: { identifier: 'admin', password: 'Admin-Sorteo-2026' },
    origin: 'https://evil.example'
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.json.error, 'FORBIDDEN');
});

/* ── 3) studio sin sesión ────────────────────────────────────────────── */

test('GET /api/studio/state sin sesión responde 401', async () => {
  const result = await api('GET', '/api/studio/state');
  assert.equal(result.status, 401);
  assert.equal(result.json.error, 'UNAUTHORIZED');
});

/* ── 5) admin crea cuenta + 4) licencia pending ──────────────────────── */

test('admin crea cuenta; licencia pending bloquea studio con 403 LICENSE_INACTIVE', async () => {
  const { result, payload } = await createAccount({
    companyName: 'Acme Demo',
    contactName: 'Ana Pérez',
    email: 'ana@acme.test',
    username: 'acme',
    plan: 'trimestral',
    seats: 2,
    amountCents: 15_000,
    notes: 'Pago por confirmar'
  });
  assert.equal(result.status, 201, 'el alta de cuenta debe responder 201');
  acmeId = result.json.account.id;
  assert.equal(result.json.account.license.status, 'pending');
  assert.equal(result.json.account.participants, 0);
  assert.equal(result.json.account.username, payload.username);
  assert.equal(result.json.account.password_hash, undefined);

  // La cuenta recién creada puede entrar aunque su licencia esté pendiente.
  const loginResult = await login('acme', payload.password);
  assert.equal(loginResult.status, 200);
  acmeCookie = loginResult.cookie;

  const me = await api('GET', '/api/auth/me', { cookie: acmeCookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.license.status, 'pending');

  const blocked = await api('GET', '/api/studio/state', { cookie: acmeCookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error, 'LICENSE_INACTIVE');
  assert.equal(blocked.json.license.status, 'pending');

  // El admin marca el pago: la licencia pasa a activa y el estudio abre.
  const patch = await api('PATCH', `/api/admin/accounts/${acmeId}`, {
    body: { licenseStatus: 'active' }, cookie: adminCookie
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.account.license.status, 'active');
  assert.equal('startedAt' in patch.json.account.license, false, 'license.startedAt no pertenece al contrato');

  const state = await api('GET', '/api/studio/state', { cookie: acmeCookie });
  assert.equal(state.status, 200);
  assert.equal(state.json.branding.displayName, 'Acme Demo');
  assert.equal(state.json.studio.prize, 'Premio principal');
  assert.equal(state.json.studio.round, 1);
  assert.equal(state.json.studio.settings.winners, 1);
  assert.deepEqual(state.json.participants, []);
  assert.deepEqual(state.json.draws, []);
  assert.equal(state.json.license.status, 'active');
});

test('licencia activa con fecha vencida se reporta como expired y bloquea', async () => {
  const { result, payload } = await createAccount({
    companyName: 'Vencida SA',
    username: 'vencida',
    email: 'vencida@test.local',
    expiresAt: '2020-01-01',
    licenseStatus: 'active'
  });
  assert.equal(result.status, 201);
  assert.equal(result.json.account.license.status, 'expired');

  const loginResult = await login('vencida', payload.password);
  assert.equal(loginResult.status, 200);
  const blocked = await api('GET', '/api/studio/state', { cookie: loginResult.cookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.license.status, 'expired');
});

/* ── 6) participantes + sorteo ───────────────────────────────────────── */

test('PUT participants deduplica por num+name, renumera y valida', async () => {
  const result = await api('PUT', '/api/studio/participants', {
    cookie: acmeCookie,
    body: {
      participants: [
        { num: '1', name: 'Ana Torres', detail: 'UpConta' },
        { num: '2', name: 'Luis Pérez', detail: 'Manta' },
        { num: '1', name: 'Ana Torres', detail: 'UpConta' }, // duplicado exacto
        { name: 'Sofía', detail: '' }
      ]
    }
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.count, 3);
  assert.deepEqual(result.json.participants.map((p) => p.num), ['1', '2', '3']);
  assert.equal(result.json.participants[2].name, 'Sofía');
  assert.equal(result.json.participants[0].won, false);

  const invalid = await api('PUT', '/api/studio/participants', {
    cookie: acmeCookie,
    body: { participants: [{ num: '4' }] }
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, 'BAD_REQUEST');

  const tooMany = await api('PUT', '/api/studio/participants', {
    cookie: acmeCookie,
    body: { participants: Array.from({ length: 2001 }, (_, i) => ({ name: `P${i}` })) }
  });
  assert.equal(tooMany.status, 400);
});

test('POST draw elige ganadores únicos en servidor y descuenta elegibles', async () => {
  const first = await api('POST', '/api/studio/draw', {
    cookie: acmeCookie, body: { count: 2, prize: 'Laptop' }
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.winners.length, 2);
  assert.equal(first.json.remaining, 1);
  assert.equal(first.json.round, 1);
  const ids = first.json.winners.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, 'los ganadores no deben repetirse');
  for (const winner of first.json.winners) {
    assert.equal(typeof winner.num, 'string');
    assert.ok(winner.name.length > 0);
  }

  const afterFirst = await api('GET', '/api/studio/state', { cookie: acmeCookie });
  assert.equal(afterFirst.status, 200);
  assert.equal(afterFirst.json.draws.length, 1);
  assert.equal(afterFirst.json.draws[0].prize, 'Laptop');
  assert.equal(afterFirst.json.draws[0].winners.length, 2);
  assert.equal(afterFirst.json.participants.filter((p) => p.won).length, 2);

  // Se piden 2 pero solo queda 1 elegible: el servidor ajusta y luego avanza de ronda.
  const second = await api('POST', '/api/studio/draw', {
    cookie: acmeCookie, body: { count: 2 }
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.winners.length, 1);
  assert.equal(second.json.remaining, 0);
  assert.equal(second.json.round, 2, 'la respuesta debe reflejar la ronda siguiente al agotar elegibles');

  const afterSecond = await api('GET', '/api/studio/state', { cookie: acmeCookie });
  assert.equal(afterSecond.json.studio.round, 2, 'al agotar elegibles la ronda avanza');
  assert.equal(afterSecond.json.participants.every((p) => p.won), true);

  const exhausted = await api('POST', '/api/studio/draw', { cookie: acmeCookie, body: {} });
  assert.equal(exhausted.status, 409);
  assert.equal(exhausted.json.error, 'CONFLICT');
});

test('GET results.csv exporta el acta con encabezado exacto', async () => {
  const result = await api('GET', '/api/studio/results.csv', { cookie: acmeCookie });
  assert.equal(result.status, 200);
  assert.match(result.res.headers.get('content-type'), /^text\/csv/);
  assert.equal(result.text.split('\r\n')[0], 'SORTEO,NUMERO,NOMBRE,DETALLE,PREMIO,FECHA');
  assert.match(result.text, /Laptop/);
  assert.match(result.text, /Ana Torres|Luis Pérez|Sofía/);
  assert.ok(result.text.trim().split('\r\n').length >= 4, 'debe haber una fila por ganador');
});

/* ── Uploads / branding ──────────────────────────────────────────────── */

test('PUT branding valida magic bytes, guarda PNG/JPEG y sirve /uploads con cache immutable', async () => {
  const result = await api('PUT', '/api/studio/branding', {
    cookie: acmeCookie,
    body: {
      displayName: 'Acme Eventos',
      brandColor: '#1D4ED8',
      logoDataUrl: pngDataUrl(),
      partners: [
        { name: 'Marca Uno', dataUrl: pngDataUrl() },
        { name: 'Marca Dos', dataUrl: pngDataUrl() }
      ]
    }
  });
  assert.equal(result.status, 200);
  const branding = result.json.branding;
  assert.equal(branding.displayName, 'Acme Eventos');
  assert.equal(branding.brandColor, '#1D4ED8');
  assert.match(branding.logoPath, /^\/uploads\/[a-f0-9]{32}\.png$/);
  assert.equal(branding.partners.length, 2);

  const logo = await api('GET', branding.logoPath);
  assert.equal(logo.status, 200);
  assert.equal(logo.res.headers.get('content-type'), 'image/png');
  assert.equal(logo.res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.ok(logo.buffer.equals(Buffer.from(PNG_B64, 'base64')), 'el archivo servido debe ser el PNG original');

  // Reemplazo por JPEG: el archivo anterior debe desaparecer.
  const replaced = await api('PUT', '/api/studio/branding', {
    cookie: acmeCookie,
    body: { logoDataUrl: `data:image/jpeg;base64,${JPEG_B64}` }
  });
  assert.equal(replaced.status, 200);
  assert.match(replaced.json.branding.logoPath, /^\/uploads\/[a-f0-9]{32}\.jpg$/);
  assert.equal(replaced.json.branding.displayName, 'Acme Eventos', 'los campos no enviados se conservan');

  const oldLogo = await api('GET', branding.logoPath);
  assert.equal(oldLogo.status, 404, 'el logo reemplazado se borra del disco');

  const newLogo = await api('GET', replaced.json.branding.logoPath);
  assert.equal(newLogo.status, 200);
  assert.equal(newLogo.res.headers.get('content-type'), 'image/jpeg');

  // Round-trip: enviar solo el path existente conserva la imagen.
  const roundTrip = await api('PUT', '/api/studio/branding', {
    cookie: acmeCookie,
    body: { partners: [{ name: 'Marca Uno', path: replaced.json.branding.partners[0].path }] }
  });
  assert.equal(roundTrip.status, 200);
  assert.equal(roundTrip.json.branding.partners.length, 1);

  // Quitar logo: logoPath null y archivo borrado.
  const removed = await api('PUT', '/api/studio/branding', { cookie: acmeCookie, body: { logoDataUrl: null } });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.branding.logoPath, null);
  assert.equal((await api('GET', replaced.json.branding.logoPath)).status, 404);
});

test('PUT branding rechaza imágenes falsas o demasiado grandes', async () => {
  const notAnImage = await api('PUT', '/api/studio/branding', {
    cookie: acmeCookie,
    body: { logoDataUrl: `data:image/png;base64,${b64('esto no es un png')}` }
  });
  assert.equal(notAnImage.status, 400);
  assert.equal(notAnImage.json.error, 'BAD_REQUEST');

  const oversize = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400 * 1024)]);
  const tooBig = await api('PUT', '/api/studio/branding', {
    cookie: acmeCookie,
    body: { logoDataUrl: `data:image/png;base64,${oversize.toString('base64')}` }
  });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.json.message, /400 KB/);
});

/* ── 7) aislamiento multi-empresa ────────────────────────────────────── */

test('aislamiento: la cuenta B no ve ni modifica participantes/sorteos de A', async () => {
  const { result, payload } = await createAccount({
    companyName: 'Beta Corp',
    username: 'beta',
    email: 'beta@test.local',
    licenseStatus: 'active'
  });
  assert.equal(result.status, 201);
  betaId = result.json.account.id;

  const betaLogin = await login('beta', payload.password);
  assert.equal(betaLogin.status, 200);
  betaCookie = betaLogin.cookie;

  const betaPut = await api('PUT', '/api/studio/participants', {
    cookie: betaCookie,
    body: { participants: [{ num: 'B1', name: 'Beta Uno' }, { num: 'B2', name: 'Beta Dos' }] }
  });
  assert.equal(betaPut.status, 200);
  assert.equal(betaPut.json.count, 2);

  const betaState = await api('GET', '/api/studio/state', { cookie: betaCookie });
  assert.equal(betaState.status, 200);
  assert.deepEqual(betaState.json.participants.map((p) => p.name), ['Beta Uno', 'Beta Dos']);
  assert.deepEqual(betaState.json.draws, [], 'B no debe ver los sorteos de A');

  const acmeState = await api('GET', '/api/studio/state', { cookie: acmeCookie });
  assert.equal(acmeState.json.participants.length, 3, 'A conserva sus 3 participantes');
  assert.equal(acmeState.json.participants.some((p) => p.name.startsWith('Beta')), false);
  assert.equal(acmeState.json.draws.length, 2, 'A conserva sus 2 sorteos');

  // Un sorteo de B no marca ganadores en A.
  const betaDraw = await api('POST', '/api/studio/draw', { cookie: betaCookie, body: { count: 1 } });
  assert.equal(betaDraw.status, 200);
  assert.equal(betaDraw.json.remaining, 1);

  const acmeAfter = await api('GET', '/api/studio/state', { cookie: acmeCookie });
  assert.equal(acmeAfter.json.participants.filter((p) => p.won).length, 3, 'A ya tenía todos sus ganadores marcados, sin cambios');
  assert.equal(acmeAfter.json.draws.length, 2);
});

/* ── reset ───────────────────────────────────────────────────────────── */

test('POST reset reinicia ganadores, draws y ronda; keepParticipants=false borra lista', async () => {
  const reset = await api('POST', '/api/studio/reset', { cookie: acmeCookie, body: {} });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.json, { ok: true });

  const state = await api('GET', '/api/studio/state', { cookie: acmeCookie });
  assert.equal(state.json.draws.length, 0);
  assert.equal(state.json.studio.round, 1);
  assert.equal(state.json.participants.every((p) => p.won === false), true);

  const clear = await api('POST', '/api/studio/reset', {
    cookie: acmeCookie, body: { keepParticipants: false }
  });
  assert.equal(clear.status, 200);
  const cleared = await api('GET', '/api/studio/state', { cookie: acmeCookie });
  assert.deepEqual(cleared.json.participants, []);
});

/* ── Contraseña ──────────────────────────────────────────────────────── */

test('change-password invalida las otras sesiones y exige la clave actual', async () => {
  const first = await login('beta', 'ClaveSegura-2026');
  const second = await login('beta', 'ClaveSegura-2026');
  assert.ok(first.cookie && second.cookie);

  const wrongCurrent = await api('POST', '/api/auth/change-password', {
    cookie: second.cookie,
    body: { currentPassword: 'no-es-la-clave', newPassword: 'ClaveNueva-2026' }
  });
  assert.equal(wrongCurrent.status, 400);

  const changed = await api('POST', '/api/auth/change-password', {
    cookie: second.cookie,
    body: { currentPassword: 'ClaveSegura-2026', newPassword: 'ClaveNueva-2026' }
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.json, { ok: true });

  assert.equal((await api('GET', '/api/auth/me', { cookie: first.cookie })).status, 401, 'la otra sesión debe morir');
  assert.equal((await api('GET', '/api/auth/me', { cookie: second.cookie })).status, 200, 'la sesión actual sigue viva');

  const oldPassword = await login('beta', 'ClaveSegura-2026');
  assert.equal(oldPassword.status, 401);
  const newPassword = await login('beta', 'ClaveNueva-2026');
  assert.equal(newPassword.status, 200);
  betaCookie = newPassword.cookie;
});

/* ── Admin: overview / lista / renovar / audit / reset-password ──────── */

test('admin: overview, lista filtrada y auditoría responden el contrato', async () => {
  const overview = await api('GET', '/api/admin/overview', { cookie: adminCookie });
  assert.equal(overview.status, 200);
  assert.equal(typeof overview.json.totalAccounts, 'number');
  assert.ok(overview.json.totalAccounts >= 3);
  assert.ok(overview.json.active >= 2);
  assert.ok(overview.json.revenueCents >= 15_000);
  assert.equal(typeof overview.json.expiringSoon, 'number');

  const list = await api('GET', '/api/admin/accounts?q=beta', { cookie: adminCookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.accounts.length, 1);
  const beta = list.json.accounts[0];
  assert.equal(beta.username, 'beta');
  assert.equal(beta.participants, 2);
  assert.equal(typeof beta.license.amountCents, 'number');
  assert.equal(typeof beta.license.paymentRef, 'string');
  assert.equal(beta.password_hash, undefined);

  const audit = await api('GET', '/api/admin/audit?limit=80', { cookie: adminCookie });
  assert.equal(audit.status, 200);
  assert.ok(Array.isArray(audit.json.entries));
  assert.ok(audit.json.entries.some((entry) => entry.action === 'ACCOUNT_CREATED'));
  assert.ok(audit.json.entries.some((entry) => entry.action === 'LICENSE_RENEWED' || entry.action === 'LOGIN_SUCCESS'));
  assert.equal(typeof audit.json.entries[0].createdAt, 'string');

  const badLimit = await api('GET', '/api/admin/audit?limit=9999', { cookie: adminCookie });
  assert.equal(badLimit.status, 400);
});

test('admin: renewal extiende desde el vencimiento y activa la licencia', async () => {
  const before = await api('GET', '/api/admin/accounts?q=beta', { cookie: adminCookie });
  const beforeExpires = before.json.accounts[0].license.expiresAt;

  const renewed = await api('POST', `/api/admin/accounts/${betaId}/renew`, {
    cookie: adminCookie, body: { months: 2, plan: 'anual' }
  });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.json.account.license.status, 'active');
  assert.equal(renewed.json.account.license.plan, 'anual');
  assert.ok(renewed.json.account.license.expiresAt > beforeExpires, 'la fecha debe extenderse');
  assert.notEqual(renewed.json.account.license.expiresAt, beforeExpires);

  const missing = await api('POST', '/api/admin/accounts/99999/renew', {
    cookie: adminCookie, body: { months: 1 }
  });
  assert.equal(missing.status, 404);
});

test('admin: reset-password invalida sesiones y permite entrar con la clave nueva', async () => {
  const reset = await api('POST', `/api/admin/accounts/${acmeId}/reset-password`, {
    cookie: adminCookie, body: { newPassword: 'ClaveAdmin-2026' }
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.json, { ok: true });

  assert.equal((await api('GET', '/api/auth/me', { cookie: acmeCookie })).status, 401);
  const relogin = await login('acme', 'ClaveAdmin-2026');
  assert.equal(relogin.status, 200);
  acmeCookie = relogin.cookie;

  const weak = await api('POST', `/api/admin/accounts/${acmeId}/reset-password`, {
    cookie: adminCookie, body: { newPassword: 'corta' }
  });
  assert.equal(weak.status, 400);
});

test('admin: usuario normal no accede a /api/admin y las cuentas inexistentes dan 404', async () => {
  const forbidden = await api('GET', '/api/admin/overview', { cookie: acmeCookie });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error, 'FORBIDDEN');

  const missing = await api('PATCH', '/api/admin/accounts/99999', {
    cookie: adminCookie, body: { notes: 'x' }
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'NOT_FOUND');
});

test('admin: no permite suspender la propia cuenta', async () => {
  const self = await api('GET', '/api/auth/me', { cookie: adminCookie });
  const result = await api('PATCH', `/api/admin/accounts/${self.json.user.id}`, {
    cookie: adminCookie, body: { status: 'suspended' }
  });
  assert.equal(result.status, 400);
});

/* ── Rutas inexistentes / uploads ────────────────────────────────────── */

test('404 JSON para /api/* y 404 para uploads inexistentes o inválidos', async () => {
  const missingApi = await api('GET', '/api/no-existe');
  assert.equal(missingApi.status, 404);
  assert.equal(missingApi.json.error, 'NOT_FOUND');

  const missingUpload = await api('GET', `/uploads/${'a'.repeat(32)}.png`);
  assert.equal(missingUpload.status, 404);

  const badName = await api('GET', '/uploads/../../etc/passwd');
  assert.equal(badName.status, 404);
});

/* ── Páginas (requieren el frontend ya generado) ─────────────────────── */

const pagesReady = ['login.html', 'studio.html', 'admin.html']
  .every((file) => fs.existsSync(path.join(ROOT, 'public', file)));

test('páginas: /login 200, / sin sesión 302 /login, /admin según rol', {
  skip: pagesReady ? false : 'public/*.html aún no existe (frontend en progreso)'
}, async () => {
  const loginPage = await api('GET', '/login');
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.res.headers.get('content-type'), /text\/html/);

  const rootWithoutSession = await api('GET', '/');
  assert.equal(rootWithoutSession.status, 302);
  assert.equal(rootWithoutSession.res.headers.get('location'), '/login');

  const adminPageAsUser = await api('GET', '/admin', { cookie: acmeCookie });
  assert.equal(adminPageAsUser.status, 302);
  assert.equal(adminPageAsUser.res.headers.get('location'), '/');

  const adminPageAsAdmin = await api('GET', '/admin', { cookie: adminCookie });
  assert.equal(adminPageAsAdmin.status, 200);
  assert.match(adminPageAsAdmin.res.headers.get('content-type'), /text\/html/);

  const studioPage = await api('GET', '/', { cookie: acmeCookie });
  assert.equal(studioPage.status, 200);
});
