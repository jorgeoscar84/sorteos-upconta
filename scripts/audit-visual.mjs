/**
 * Auditoría visual + funcional (CDP) de Sorteo Studio — v2
 * - contraste con composición de alfa correcta
 * - targets reales (excluye range/checkbox/sr-only)
 * - viewport móvil sin emulación de escala
 * - audita login, estudio, escenario y /admin (sesión de administrador)
 *
 * Uso: node scripts/audit-visual.mjs <puertoCDP> <baseURL> [adminUser] [adminPass]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import zlib from 'node:zlib';

const PORT = process.argv[2] || 9222;
const BASE = (process.argv[3] || 'http://127.0.0.1:3020').replace(/\/$/, '');
const ADMIN_USER = process.argv[4] || 'admin';
const ADMIN_PASS = process.argv[5] || 'Studio2026!Sorteo#Kq7';
const OUT = 'audit';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── PNG mínimo para probar el logo real ── */
function makePng(width, height, rgbAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) { const [r, g, b] = rgbAt(x, y); raw[p++] = r; raw[p++] = g; raw[p++] = b; }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}
const logoPng = makePng(360, 120, (x, y) => {
  const inMark = x > 22 && x < 100 && y > 22 && y < 98;
  const ring = inMark && Math.hypot(x - 61, y - 60) > 26 && Math.hypot(x - 61, y - 60) < 17;
  if (ring) return [18, 32, 47];
  const bar = x > 118 && x < 336 && y > 44 && y < 76 && !(x > 180 && x < 196);
  if (bar) return [18, 32, 47];
  if (x > 118 && x < 336 && y > 84 && y < 92) return [31, 163, 122];
  return [255, 255, 255];
});
const logoDataUrl = `data:image/png;base64,${logoPng.toString('base64')}`;

/* ── API ── */
class Jar {
  constructor() { this.c = new Map(); }
  h() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res) {
    for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [pair] = line.split(';'); const i = pair.indexOf('=');
      this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
}
async function api(jar, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(method !== 'GET' ? { 'X-Requested-With': 'fetch', Origin: BASE } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(jar?.h() ? { Cookie: jar.h() } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual'
  });
  if (jar) jar.absorb(res);
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json().catch(() => null) : null };
}
const DEMO = { user: 'cumbre', pass: 'CumbreDemo2026!' };

async function setup() {
  const A = new Jar();
  const l = await api(A, '/auth/login', { method: 'POST', body: { identifier: ADMIN_USER, password: ADMIN_PASS } });
  if (l.status !== 200) throw new Error(`login admin ${l.status}`);

  const list = await api(A, '/admin/accounts?q=cumbre');
  const found = (list.data?.accounts || []).find((a) => a.username === DEMO.user);
  if (!found) {
    const r = await api(A, '/admin/accounts', {
      method: 'POST',
      body: {
        companyName: 'Cumbre & Asociados', contactName: 'María Cumbre', email: 'maria@cumbre.example',
        username: DEMO.user, password: DEMO.pass, plan: 'trimestral', seats: 3,
        expiresAt: new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10),
        status: 'active', licenseStatus: 'active', amountCents: 24000,
        notes: 'Transferencia Banco Pichincha #0021 (demo)'
      }
    });
    if (![200, 201].includes(r.status)) throw new Error(`crear cuenta ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  } else {
    await api(A, `/admin/accounts/${found.id}`, { method: 'PATCH', body: { password: DEMO.pass, licenseStatus: 'active', status: 'active' } });
  }
  // segunda cuenta para que la tabla del admin tenga variedad
  const list2 = await api(A, '/admin/accounts?q=andes');
  if (!(list2.data?.accounts || []).some((a) => a.username === 'andes')) {
    await api(A, '/admin/accounts', {
      method: 'POST',
      body: {
        companyName: 'Andes Auditores', contactName: 'Carlos Andes', email: 'carlos@andes.example',
        username: 'andes', password: 'AndesDemo2026!', plan: 'mensual', seats: 1,
        expiresAt: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
        status: 'active', licenseStatus: 'active', amountCents: 9000, notes: 'Renovación pendiente'
      }
    });
  }

  const U = new Jar();
  const ul = await api(U, '/auth/login', { method: 'POST', body: { identifier: DEMO.user, password: DEMO.pass } });
  if (ul.status !== 200) throw new Error(`login demo ${ul.status}`);
  await api(U, '/studio/branding', { method: 'PUT', body: { displayName: 'Cumbre & Asociados', logoDataUrl, partners: [], brandColor: '#1FA37A' } });
  await api(U, '/studio/settings', { method: 'PUT', body: { eventTitle: 'Executive Sessions 2026', prize: 'Cena para dos + bono USD 500', winners: 2, turns: 7, duration: 8 } });
  const names = ['Joshelyne Lucas Zamora', 'Ramiro Cruz Bonilla', 'Humberto Panchana Quiñonez', 'Daysi Cevallos Alcivar',
    'Jorge Faubla Lectong', 'Jean Carlos Rodríguez Choez', 'Johana Macias Ramirez', 'Patricia David David',
    'Ana Cristina Zambrano', 'María Zuxiliadora Cevallos', 'Gustavo Vinueza', 'Alberto Murillo'];
  const rp = await api(U, '/studio/participants', { method: 'PUT', body: { participants: names.map((n) => ({ name: n })) } });
  if (rp.status !== 200) throw new Error(`participantes ${rp.status}`);
  return { cuentas: list.data?.accounts?.length ?? 0, demoCookie: U.c.get('sid'), adminCookie: A.c.get('sid') };
}

/* ── CDP ── */
async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = l.find((t) => t.type === 'page');
      if (p) return p;
    } catch { }
    await sleep(250);
  }
  throw new Error('sin target CDP');
}
const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); let pageErrors = []; let consoleErrors = []; let securityErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0].slice(0, 160));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 160));
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error' || /Content Security Policy|CSP/i.test(e.text || '')) securityErrors.push(`${e.source || 'log'}: ${String(e.text).slice(0, 180)}`);
  }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const viewport = async (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (r.result?.data) writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
};

const AUDIT_JS = String.raw`(() => {
  const parse = (s) => { const m = String(s||'').match(/[\d.]+/g); if (!m) return null; return { r:+m[0], g:+m[1], b:+m[2], a: m.length>3 ? +m[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v/=255; return v<=.03928 ? v/12.92 : ((v+.055)/1.055)**2.4; }; return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b); };
  const bgOf = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.001) stack.push(c); }
    let out = { r: 5, g: 7, b: 13 };
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = stack[i];
      out = { r: c.r*c.a + out.r*(1-c.a), g: c.g*c.a + out.g*(1-c.a), b: c.b*c.a + out.b*(1-c.a) };
    }
    return out;
  };
  const skip = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display==='none' || cs.visibility==='hidden') return true;
    if (+cs.opacity < 0.35) return true;
    if (el.closest('.sr-only')) return true;
    const r = el.getBoundingClientRect();
    return !r.width || !r.height;
  };
  const fails = [];
  for (const el of document.querySelectorAll('p,span,a,li,h1,h2,h3,h4,button,label,small,td,th,strong,em')) {
    const t = el.textContent?.trim(); if (!t || t.length < 1 || el.children.length > 2 || skip(el)) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const a = lum(fg), b = lum(bg);
    const ratio = (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    const big = parseFloat(cs.fontSize)>=24 || (parseFloat(cs.fontSize)>=18.66 && parseInt(cs.fontWeight)>=700);
    if (ratio < (big?3:4.5)) fails.push({ text: t.slice(0,32), ratio:+ratio.toFixed(2), size: cs.fontSize });
  }
  const interactive = [...document.querySelectorAll('a[href],button,input,select,textarea,[role=button]')].filter(e => {
    if (skip(e)) return false;
    const type = (e.getAttribute('type')||'').toLowerCase();
    if (['range','checkbox','radio','hidden'].includes(type)) return false;
    if (getComputedStyle(e).pointerEvents === 'none') return false;
    return true;
  });
  const smallTargets = interactive.filter(e => e.getBoundingClientRect().height < 44 && e.getBoundingClientRect().width < 44)
    .slice(0, 8).map(e => ({ tag: e.tagName, h: Math.round(e.getBoundingClientRect().height), text: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 22) }));
  const unlabeled = [...document.querySelectorAll('input:not([type=hidden]),select,textarea')]
    .filter(i => !i.labels?.length && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby')).length;
  return {
    title: document.title, path: location.pathname,
    overflow: { vw: innerWidth, scrollW: document.documentElement.scrollWidth, ok: document.documentElement.scrollWidth <= innerWidth+1 },
    contrast: { fails: fails.length, sample: fails.slice(0, 8) },
    a11y: {
      h1: document.querySelectorAll('h1').length,
      imgSinAlt: [...document.images].filter(i => !i.hasAttribute('alt')).length,
      labels: document.querySelectorAll('label').length,
      inputs: document.querySelectorAll('input:not([type=hidden]),select,textarea').length,
      unlabeled, smallTargets
    },
    hooks: {
      brandPlate: !!document.querySelector('.brand-plate'),
      logo: document.querySelector('.brand-plate img')?.getAttribute('src') || null,
      wheel: !!document.querySelector('canvas'),
      spin: [...document.querySelectorAll('button')].some(b => /^\\s*(girar|sortear)/i.test(b.textContent||'')),
      tableRows: document.querySelectorAll('table tbody tr').length,
      navItems: document.querySelectorAll('.rail nav a, .rail .tab, .rail button').length,
      kpis: document.querySelectorAll('.kpi, [class*=kpi]').length,
      empty: document.querySelectorAll('.empty').length
    },
    brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()
  };
})()`;

async function audit(name, { w, h }, { settle = 400 } = {}) {
  await viewport(w, h);
  await sleep(settle);
  pageErrors = []; consoleErrors = []; securityErrors = [];
  const data = await ev(AUDIT_JS);
  await sleep(250);
  await shot(name);
  return { name, ...data, pageErrors, consoleErrors, securityErrors };
}
async function go(url, settle = 1900) { await send('Page.navigate', { url }); await sleep(settle); }

/** Fija/borra la cookie de sesión directamente en el navegador (determinista). */
async function setSession(cookieValue) {
  if (!cookieValue) {
    await send('Network.deleteCookies', { name: 'sid', url: BASE });
    return;
  }
  await send('Network.setCookie', { name: 'sid', value: cookieValue, url: BASE, path: '/', httpOnly: true, sameSite: 'Lax' });
}
// prueba funcional del formulario de login real (una sola vez, se reporta)
async function uiLoginCheck(user, pass) {
  await go(`${BASE}/login`, 1600);
  const filled = await ev(`(() => {
    const inputs = [...document.querySelectorAll('form input')];
    if (inputs.length < 2) return 'sin-inputs';
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(inputs[0], ${JSON.stringify(user)}); set(inputs[1], ${JSON.stringify(pass)});
    const f = document.querySelector('form'); if (f.requestSubmit) f.requestSubmit(); else f.submit();
    return 'enviado';
  })()`);
  await sleep(2600);
  const path = await ev('location.pathname');
  return { filled, path, ok: path === '/' };
}

const report = { setup: null, pages: [], notes: [], base: BASE };
try { report.setup = await setup(); } catch (e) { report.notes.push('setup: ' + e.message); }

await send('Runtime.enable'); await send('Page.enable');

// 1) login
await go(`${BASE}/login`);
report.pages.push(await audit('login-1440', { w: 1440, h: 900 }));
report.pages.push(await audit('login-390', { w: 390, h: 844 }));

// 2) estudio con sesión de empresa (cookie inyectada: determinista)
await setSession(report.setup?.demoCookie);
await go(`${BASE}/`, 2300);
report.notes.push('login-form-check: ' + JSON.stringify(await uiLoginCheck(DEMO.user, DEMO.pass)));
await go(`${BASE}/`, 2000);
report.pages.push(await audit('studio-1440', { w: 1440, h: 900 }, { settle: 900 }));
report.pages.push(await audit('studio-390', { w: 390, h: 844 }));
report.pages.push(await audit('studio-768', { w: 768, h: 1024 }));

// 3) escenario + sorteo
await viewport(1600, 900);
const opened = await ev(`(() => { const b=[...document.querySelectorAll('button,a')].find(x=>/abrir escenario|escenario/i.test(x.textContent||'')); if(b){b.click();return true} return false })()`);
await sleep(1300);
report.pages.push({ ...(await audit('stage-1600', { w: 1600, h: 900 })), opened });
const spun = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^\\s*(girar|sortear)/i.test(x.textContent||'')); if(b&&!b.disabled){b.click();return true} return false })()`);
if (spun) {
  await sleep(9200);
  await shot('stage-winner-1600');
  report.notes.push('sorteo ejecutado en la UI (2 ganadores)');
  const overlay = await ev(`(() => ({ visible: !!document.querySelector('[class*=winner]'), cards: document.querySelectorAll('[class*=winner-card]').length }))()`);
  report.notes.push('overlay: ' + JSON.stringify(overlay));
}

// 4) admin con sesión de administrador
await setSession(report.setup?.adminCookie);
await go(`${BASE}/admin`, 2300);
report.pages.push(await audit('admin-1440', { w: 1440, h: 900 }, { settle: 600 }));
report.pages.push(await audit('admin-390', { w: 390, h: 844 }));
report.pages.push(await audit('admin-768', { w: 768, h: 1024 }));

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const summary = report.pages.map((p) => ({
  page: p.name, path: p.path, title: (p.title || '').slice(0, 40),
  overflow: p.overflow?.ok, contrast: p.contrast?.fails, h1: p.a11y?.h1,
  imgAlt: p.a11y?.imgSinAlt, unlabeled: p.a11y?.unlabeled, small: p.a11y?.smallTargets?.length,
  rows: p.hooks?.tableRows, logo: !!p.hooks?.logo, brand: p.brand,
  errs: (p.pageErrors?.length || 0) + (p.consoleErrors?.length || 0),
  security: (p.securityErrors?.length || 0),
  securitySample: (p.securityErrors || []).slice(0, 2),
  sample: p.contrast?.sample
}));
console.log(JSON.stringify({ setup: report.setup, notes: report.notes, pages: summary }, null, 1));
ws.close();
