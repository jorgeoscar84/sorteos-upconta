/** Debug del login: qué pasa exactamente al enviar el formulario. */
const PORT = process.argv[2] || 9228;
const BASE = (process.argv[3] || 'http://127.0.0.1:3020').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') events.push('EXC ' + (m.params.exceptionDetails.exception?.description?.split('\n')[0] || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled') events.push(m.params.type.toUpperCase() + ' ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 120));
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/')) events.push(`REQ ${m.params.request.method} ${m.params.request.url}`);
  if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/')) events.push(`RES ${m.params.response.status} ${m.params.response.url}`);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/login` });
await sleep(1800);

console.log('FORM:', await ev(`(() => {
  const f = document.querySelector('form');
  const b = [...f.querySelectorAll('button')].map(x => ({ type: x.type, text: x.textContent.trim(), id: x.id }));
  return JSON.stringify({ action: f.getAttribute('action'), method: f.getAttribute('method'), inputs: [...f.querySelectorAll('input')].map(i => i.name + ':' + i.type + ':' + (i.id||'')), buttons: b });
})()`));

await ev(`(() => {
  const inputs=[...document.querySelectorAll('form input')];
  const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))};
  set(inputs[0],'cumbre'); set(inputs[1],'CumbreDemo2026!');
  return inputs.map(i=>i.name+'='+i.value).join(' ');
})()`).then((v) => console.log('FILLED:', v));

// 1) probar submit nativo
await ev(`(() => { const f=document.querySelector('form'); if (f.requestSubmit) f.requestSubmit(); else f.submit(); return true })()`);
await sleep(2500);
console.log('TRAS requestSubmit → path:', await ev('location.pathname'), '| body:', (await ev('document.body.innerText')).slice(0, 260).replace(/\n+/g, ' | '));
console.log('EVENTOS:', JSON.stringify(events.slice(0, 12), null, 1));
ws.close();
