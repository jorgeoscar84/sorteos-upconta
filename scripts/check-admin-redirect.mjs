/** Verifica que el admin aterrice en /admin tras el login y vea el enlace en el estudio. */
const PORT = process.argv[2], BASE = (process.argv[3] || '').replace(/\/$/, '');
const USER = process.argv[4] || 'admin', PASS = process.argv[5] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') console.log('EXC', (m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
  if (m.method === 'Runtime.consoleAPICalled') console.log('CONSOLE', m.params.type, m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 120));
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/')) console.log('REQ', m.params.request.method, m.params.request.url);
  if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/')) console.log('RES', m.params.response.status, m.params.response.url);
};
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Network.clearBrowserCookies');
await send('Page.navigate', { url: `${BASE}/login` });
await sleep(1800);
await ev(`(() => {
  const inputs=[...document.querySelectorAll('form input')];
  const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  set(inputs[0], ${JSON.stringify(USER)}); set(inputs[1], ${JSON.stringify(PASS)});
  const f=document.querySelector('form'); f.requestSubmit(); return true;
})()`);
await sleep(2600);
const afterLogin = await ev('location.pathname');
console.log('tras login admin →', afterLogin);

// el enlace a la consola debe existir y ser visible dentro del estudio
await send('Page.navigate', { url: `${BASE}/` });
await sleep(2200);
const link = await ev(`(() => { const a=document.querySelector('#btnAdmin'); if(!a) return 'sin-nodo'; const r=a.getBoundingClientRect(); return JSON.stringify({texto:a.textContent.trim(), href:a.getAttribute('href'), visible:!a.hidden && r.width>0, alto:Math.round(r.height)}); })()`);
console.log('enlace consola en estudio →', link);
ws.close();
