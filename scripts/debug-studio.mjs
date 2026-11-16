/** Traza de carga del estudio: qué renderiza y cuándo. */
const PORT = process.argv[2] || 9225;
const BASE = (process.argv[3] || 'http://127.0.0.1:3020').replace(/\/$/, '');
const USER = process.argv[4] || 'cumbre';
const PASS = process.argv[5] || 'CumbreDemo2026!';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description?.split('\n')[0] || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type.toUpperCase() + ' ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 140));
  if (m.method === 'Log.entryAdded') logs.push('LOG ' + m.params.entry.level + ' ' + m.params.entry.text.slice(0, 140));
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/login` });
await sleep(1500);
await ev(`(() => {
  const inputs=[...document.querySelectorAll('form input')];
  const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  set(inputs[0], ${JSON.stringify(USER)}); set(inputs[1], ${JSON.stringify(PASS)});
  const f = document.querySelector('form');
  if (f.requestSubmit) f.requestSubmit(); else f.submit();
  return true;
})()`);

const SNAP = `(() => {
  const t = s => document.querySelector(s)?.textContent?.trim() || null;
  const cv = document.querySelector('canvas');
  let painted = 0;
  if (cv) { try { const ctx = cv.getContext('2d'); const d = ctx.getImageData(0,0,cv.width,cv.height).data; for (let i=3;i<d.length;i+=4*997) if (d[i]>8) painted++; } catch(e) { painted = -1; } }
  return JSON.stringify({
    path: location.pathname, title: document.title,
    brand: t('.brand-plate .brand-name') || t('.brand-plate'),
    logo: document.querySelector('.brand-plate img')?.getAttribute('src') || null,
    user: t('#userAvatar') + ' | ' + (document.querySelector('.rail')?.innerText || '').split('\\n').slice(-3).join(' / '),
    elegibles: (document.body.innerText.match(/ELEGIBLES[\\s\\S]{0,20}/) || [''])[0].replace(/\\s+/g,' '),
    canvas: cv ? cv.width + 'x' + cv.height + ' painted=' + painted : null,
    participantsRows: document.querySelectorAll('table tbody tr').length
  });
})()`;

for (const ms of [400, 900, 1600, 2600, 4000, 6000]) {
  await sleep(ms === 400 ? 400 : ms - (ms === 900 ? 400 : ms === 1600 ? 900 : ms === 2600 ? 1600 : ms === 4000 ? 2600 : 4000));
  const snap = await ev(SNAP);
  console.log(`${String(ms).padStart(5)}ms`, snap);
}
console.log('\nLOGS:', JSON.stringify(logs.slice(0, 14), null, 1));
ws.close();
