#!/usr/bin/env node
/**
 * Smoke test remoto (producción o local): verifica auth, licencias, CSRF,
 * aislamiento básico y el sorteo autoritativo contra una URL real.
 *
 * Uso:
 *   node scripts/smoke-remote.mjs https://dominio admin 'ClaveDelAdmin'
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:3010').replace(/\/$/, '');
const ADMIN_USER = process.argv[3] || process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.argv[4] || process.env.ADMIN_PASSWORD || '';
const HOST = new URL(BASE).host;

const results = [];
const ok = (name, detail = '') => results.push({ test: name, pass: true, detail });
const fail = (name, detail = '') => results.push({ test: name, pass: false, detail });

class Jar {
  constructor() { this.cookies = new Map(); }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const k = pair.slice(0, idx).trim(), v = pair.slice(idx + 1).trim();
      if (v === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
}

async function call(jar, path, { method = 'GET', body, csrf = true, headers = {} } = {}) {
  const h = {
    ...(csrf && method !== 'GET' ? { 'X-Requested-With': 'fetch', Origin: BASE } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(jar && jar.header() ? { Cookie: jar.header() } : {}),
    ...headers
  };
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
  if (jar) jar.absorb(res);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { status: res.status, data, headers: res.headers };
}

const t = async (name, fn) => {
  try { await fn(); } catch (e) { fail(name, e.message); }
};

const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assert falló'); };

async function main() {
  console.log(`\n▶ Smoke test: ${BASE}\n`);

  await t('GET /healthz', async () => {
    const r = await call(null, '/healthz');
    assert(r.status === 200, `status ${r.status}`);
    ok('healthz', String(r.data).trim().slice(0, 20));
  });

  await t('GET /login sirve la página', async () => {
    const r = await call(null, '/login');
    assert(r.status === 200, `status ${r.status}`);
    assert(/<form/i.test(r.data), 'sin <form>');
    ok('login page', 'form presente');
  });

  await t('GET / redirige sin sesión', async () => {
    const r = await call(null, '/');
    assert([301, 302, 303, 307].includes(r.status), `status ${r.status} (se esperaba redirección)`);
    ok('raíz protegida', `→ ${r.headers.get('location') || '?'}`);
  });

  await t('GET /api/auth/me sin sesión → 401', async () => {
    const r = await call(null, '/api/auth/me');
    assert(r.status === 401, `status ${r.status}`);
    ok('me 401');
  });

  await t('CSRF: POST sin cabecera → 403', async () => {
    const r = await call(null, '/api/auth/login', { method: 'POST', body: { identifier: 'x', password: 'y' }, csrf: false });
    assert(r.status === 403, `status ${r.status}`);
    ok('csrf bloqueado');
  });

  await t('Login con contraseña incorrecta → 401', async () => {
    const jar = new Jar();
    const r = await call(jar, '/api/auth/login', { method: 'POST', body: { identifier: ADMIN_USER, password: 'clave-incorrecta-123' } });
    assert(r.status === 401, `status ${r.status}`);
    ok('login inválido 401');
  });

  const adminJar = new Jar();
  await t('Login admin', async () => {
    assert(ADMIN_PASS, 'falta la contraseña del admin (arg 3)');
    const r = await call(adminJar, '/api/auth/login', { method: 'POST', body: { identifier: ADMIN_USER, password: ADMIN_PASS } });
    assert(r.status === 200, `status ${r.status} → ${JSON.stringify(r.data)}`);
    assert(r.data?.user?.role === 'admin', `rol ${r.data?.user?.role}`);
    ok('login admin', `${r.data.user.companyName} · role=admin`);
  });

  await t('GET /api/admin/overview', async () => {
    const r = await call(adminJar, '/api/admin/overview');
    assert(r.status === 200, `status ${r.status}`);
    ok('overview', JSON.stringify(r.data).slice(0, 90));
  });

  const demoUser = `demo${Date.now().toString().slice(-6)}`;
  const demoPass = 'DemoPrueba2026!';
  await t('Alta de cuenta demo (licencia activa)', async () => {
    const body = {
      companyName: 'Empresa Demo Smoke',
      contactName: 'QA Automático',
      email: `${demoUser}@example.com`,
      username: demoUser,
      password: demoPass,
      plan: 'mensual',
      seats: 1,
      expiresAt: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
      status: 'active',
      licenseStatus: 'active',
      amountCents: 5000,
      notes: 'smoke test'
    };
    const r = await call(adminJar, '/api/admin/accounts', { method: 'POST', body });
    assert([200, 201].includes(r.status), `status ${r.status} → ${JSON.stringify(r.data)}`);
    ok('cuenta creada', `${demoUser}`);
  });

  const userJar = new Jar();
  await t('Login de la cuenta demo', async () => {
    const r = await call(userJar, '/api/auth/login', { method: 'POST', body: { identifier: demoUser, password: demoPass } });
    assert(r.status === 200, `status ${r.status} → ${JSON.stringify(r.data)}`);
    assert(r.data?.user?.license?.status === 'active', `licencia ${r.data?.user?.license?.status}`);
    ok('login usuario', `licencia ${r.data.user.license.status} · ${r.data.user.license.daysLeft} d`);
  });

  await t('PUT participantes (aislamiento por cuenta)', async () => {
    const r = await call(userJar, '/api/studio/participants', {
      method: 'PUT',
      body: { participants: [{ name: 'Ana Smoke' }, { name: 'Beto Smoke' }, { name: 'Caro Smoke' }] }
    });
    assert(r.status === 200, `status ${r.status}`);
    assert(r.data?.count === 3, `count ${r.data?.count}`);
    ok('participantes guardados', 'count=3');
  });

  await t('POST sorteo: el servidor elige ganadores', async () => {
    const r = await call(userJar, '/api/studio/draw', { method: 'POST', body: { count: 1, prize: 'Premio Smoke' } });
    assert(r.status === 200, `status ${r.status} → ${JSON.stringify(r.data)}`);
    assert(Array.isArray(r.data.winners) && r.data.winners.length === 1, `winners ${JSON.stringify(r.data.winners)}`);
    assert(r.data.remaining === 2, `remaining ${r.data.remaining}`);
    ok('sorteo', `ganador=${r.data.winners[0].name} · quedan ${r.data.remaining}`);
  });

  await t('La cuenta demo no alcanza /admin', async () => {
    const r = await call(userJar, '/api/admin/overview');
    assert([401, 403].includes(r.status), `status ${r.status}`);
    ok('permisos admin', `status ${r.status}`);
  });

  await t('La cuenta demo no puede listar cuentas', async () => {
    const r = await call(userJar, '/api/admin/accounts');
    assert([401, 403].includes(r.status), `status ${r.status}`);
    ok('sin fuga de cuentas', `status ${r.status}`);
  });

  const pass = results.filter(r => r.pass).length;
  console.log('┌───────────────────────────────┬────────┬────────────────────────────────────────────┐');
  for (const r of results) {
    console.log(`│ ${r.test.padEnd(29)} │ ${(r.pass ? 'PASS' : 'FAIL').padEnd(6)} │ ${String(r.detail).slice(0, 42).padEnd(42)} │`);
  }
  console.log('└───────────────────────────────┴────────┴────────────────────────────────────────────┘');
  console.log(`\n${pass}/${results.length} pruebas OK\n`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => { console.error('Fallo general:', e); process.exitCode = 1; });
