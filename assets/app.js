/* ═══════════════════════════════════════════════════════════════════════
   UpConta · Sorteos en Vivo
   Ruleta + tambores + confeti/serpentinas. Sin dependencias externas
   salvo SheetJS (vendorizado) para leer Excel.
   ═══════════════════════════════════════════════════════════════════════ */
(() => {
'use strict';

const STORE_KEY = 'upconta.sorteo.v1';
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const cryptoRand = () => {
  const a = new Uint32Array(1);
  (window.crypto || window.msCrypto).getRandomValues(a);
  return a[0] / 4294967296;
};
const fmtTime = (d) => new Date(d).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' });

/* ══════════════ ESTADO ══════════════ */
const DEFAULT = {
  brand: 'UpConta',
  event: '',
  prize: 'Premio principal',
  winners: 1,
  turns: 8,
  duration: 8,
  removeWinners: true,
  sounds: true,
  confetti: true,
  simultaneous: true,
  logo: null,
  partners: [],
  participants: [],
  history: [],
  round: 1,
  seedVersion: null
};
let state = structuredClone(DEFAULT);
let rotation = 0;
let spinning = false;

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { /* cuota: logos grandes */ }
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = Object.assign(structuredClone(DEFAULT), JSON.parse(raw));
  } catch (e) { /* ignore */ }
  if (!Array.isArray(state.participants)) state.participants = [];
  if (!Array.isArray(state.partners)) state.partners = [];
  if (!Array.isArray(state.history)) state.history = [];
}

/* ══════════════ SEMILLA DEL EVENTO (assets/participantes.json) ══════════════
   Se aplica sola la primera vez (o cuando la versión de la lista cambia),
   así cualquiera que abra la URL en el evento ya ve la lista cargada.      */
async function applySeed() {
  try {
    const res = await fetch('assets/participantes.json', { cache: 'no-store' });
    if (!res.ok) return;
    const seed = await res.json();
    if (!seed || !Array.isArray(seed.participants) || !seed.participants.length) return;
    if (state.seedVersion === seed.version) return;

    state.participants = seed.participants.map(p => ({
      num: String(p.num ?? ''),
      name: String(p.name ?? '').trim(),
      detail: String(p.detail ?? '').trim(),
      won: false
    })).filter(p => p.name);
    state.seedVersion = seed.version;
    state.history = [];
    state.round = 1;
    if (seed.event) state.event = seed.event;
    if (seed.brand) state.brand = seed.brand;
    if (seed.prize) state.prize = seed.prize;
    save();
    hydrateInputs(); renderBrand(); renderParticipants(); renderSummaries(); drawWheel();
    setTimeout(() => toast(`${state.participants.length} participantes · ${state.event || 'evento'} listos`), 500);
  } catch (e) { /* sin semilla: la app sigue funcionando normal */ }
}

/* ══════════════ LECTOR DE EXCEL (carga perezosa) ══════════════
   952 KB solo se descargan si el usuario sube/descarga un Excel:
   la app abre instantánea en el evento.                              */
let xlsxPromise = null;
function ensureXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxPromise) {
    xlsxPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'assets/xlsx.full.min.js';
      s.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('No se pudo inicializar el lector de Excel'));
      s.onerror = () => reject(new Error('No se pudo cargar el lector de Excel'));
      document.head.appendChild(s);
    });
  }
  return xlsxPromise;
}

/* ══════════════ PARTICIPANTES ══════════════ */
const participants = () => state.participants;
const eligible = () => state.participants.filter(p => !p.won);
function setParticipants(list) {
  // dedupe por número si viene, si no por nombre
  const seen = new Set(); const out = [];
  list.forEach((p, i) => {
    const num = String(p.num ?? (i + 1)).trim() || String(i + 1);
    const name = String(p.name ?? '').trim();
    if (!name) return;
    const key = num + '|' + name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ num, name, detail: String(p.detail ?? '').trim(), won: !!p.won });
  });
  state.participants = out;
  save(); renderParticipants(); drawWheel(); renderSummaries();
  return out.length;
}

/* ══════════════ PARSEO CSV / EXCEL / TEXTO ══════════════ */
function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  const delim = (text.match(/;/g) || []).length > (text.match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

const RE_NUM  = /(^|\b)(n[uú]mero|num|nro|no\.?|#|codigo|c[oó]digo|cedula|c[eé]dula|id|orden|participante\s*n)/i;
const RE_NAME = /(nombre|participante|name|apellido|persona|asistente|contador)/i;
const RE_DET  = /(empresa|estudio|cargo|area|área|departamento|telefono|tel[eé]fono|celular|correo|email|cargo)/i;

function rowsToParticipants(rows) {
  if (!rows.length) return [];
  const clean = rows.map(r => r.map(c => String(c ?? '').trim())).filter(r => r.some(Boolean));
  if (!clean.length) return [];

  const head = clean[0].map(h => h.toLowerCase());
  const hasHeader = clean.length > 1 && (
    head.some(h => RE_NUM.test(h)) || head.some(h => RE_NAME.test(h))
  ) && head.filter(h => h).length >= 2 && !/^\d+$/.test(head[0] || 'x');

  let iNum = -1, iName = -1, detailIdx = [];
  let data = clean;

  if (hasHeader) {
    iNum  = head.findIndex(h => RE_NUM.test(h));
    iName = head.findIndex(h => RE_NAME.test(h));
    head.forEach((h, i) => { if (i !== iNum && i !== iName && h) detailIdx.push(i); });
    data = clean.slice(1);
  } else {
    // sin cabecera: detectar columna numérica inicial
    if (/^\d+[a-zA-Z]?$/.test(clean[0][0] || '')) {
      iNum = 0; iName = 1;
      detailIdx = clean[0].map((_, i) => i).filter(i => i > 1);
    } else {
      iName = 0; detailIdx = clean[0].map((_, i) => i).filter(i => i > 0);
    }
  }
  if (iName < 0) iName = iNum === 0 ? 1 : 0;
  if (detailIdx.length === 0) detailIdx = clean[0].map((_, i) => i).filter(i => i !== iNum && i !== iName);

  const out = [];
  data.forEach((r, i) => {
    const name = (r[iName] || '').trim();
    if (!name) return;
    const num = iNum >= 0 && (r[iNum] || '').trim() ? r[iNum].trim() : String(i + 1);
    const detail = detailIdx.map(k => (r[k] || '').trim()).filter(Boolean).join(' · ');
    out.push({ num, name, detail });
  });
  return out;
}

async function readDataFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') {
    try { await ensureXLSX(); }
    catch (e) { throw new Error('No se pudo cargar el lector de Excel. Guarda el archivo como CSV.'); }
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    return rowsToParticipants(rows);
  }
  const text = await file.text();
  if (/\.json$/i.test(file.name)) {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : (j.participantes || j.participants || []);
    return arr.map((x, i) => typeof x === 'string'
      ? { num: i + 1, name: x, detail: '' }
      : { num: x.numero ?? x.num ?? x.Numero ?? x.number ?? i + 1, name: x.nombre ?? x.name ?? x.Nombre ?? '', detail: x.empresa ?? x.cargo ?? x.detalle ?? '' });
  }
  return rowsToParticipants(parseCSV(text));
}

/* ══════════════ LOGOS ══════════════ */
function downscale(file, maxDim = 360) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        const isSvg = /svg/i.test(file.type);
        resolve(isSvg ? reader.result : cv.toDataURL('image/png'));
      };
      img.onerror = () => resolve(reader.result);
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleLogoFiles(files, isMain) {
  const arr = Array.from(files).filter(f => /^image\//.test(f.type) || /\.(png|jpe?g|svg|webp|gif)$/i.test(f.name));
  if (!arr.length) return;
  if (isMain) {
    state.logo = await downscale(arr[0], 420);
  } else {
    for (const f of arr.slice(0, 12)) state.partners.push(await downscale(f, 300));
    state.partners = state.partners.slice(0, 16);
  }
  save(); renderBrand(); renderSummaries();
}

/* ══════════════ RENDER: MARCA ══════════════ */
function renderBrand() {
  const markBox = $('#brandMark');
  const brandLogos = $('#brandLogos');
  const old = $('#brandLogoImg');
  if (old) old.remove();

  if (state.logo) {
    markBox.style.display = 'none';
    const img = document.createElement('img');
    img.id = 'brandLogoImg'; img.className = 'brand-logo-img'; img.src = state.logo; img.alt = 'Logo';
    brandLogos.prepend(img);
  } else {
    markBox.style.display = '';
    markBox.textContent = (state.brand || 'U').trim().charAt(0).toUpperCase() || 'U';
  }
  $('#brandName').textContent = state.brand || 'UpConta';

  // slot principal
  const imgMain = $('#imgMainLogo');
  const emptyMain = $('#slotMainLogo .logo-slot-empty');
  const clearMain = $('#slotMainLogo .slot-clear');
  if (state.logo) {
    imgMain.src = state.logo; imgMain.hidden = false; emptyMain.hidden = true; clearMain.hidden = false;
  } else {
    imgMain.hidden = true; emptyMain.hidden = false; clearMain.hidden = true;
  }

  // partners en topbar
  const strip = $('#partnerStrip');
  strip.innerHTML = '';
  state.partners.forEach(src => {
    const im = document.createElement('img'); im.src = src; im.alt = 'Marca'; strip.appendChild(im);
  });

  // partners en slot
  const slotP = $('#slotPartners');
  $$('.partner-thumb', slotP).forEach(n => n.remove());
  if (state.partners.length) {
    slotP.classList.add('has-items');
    const emptyP = $('.logo-slot-empty', slotP);
    if (emptyP) emptyP.style.display = 'none';
    state.partners.forEach((src, i) => {
      const d = document.createElement('div');
      d.className = 'partner-thumb';
      d.innerHTML = `<img src="${src}" alt="Marca ${i + 1}" /><button type="button" data-partner-remove="${i}" title="Quitar">×</button>`;
      slotP.appendChild(d);
    });
  } else {
    slotP.classList.remove('has-items');
    const emptyP = $('.logo-slot-empty', slotP);
    if (emptyP) emptyP.style.display = '';
  }
}

/* ══════════════ RENDER: TABLA ══════════════ */
function renderParticipants() {
  const body = $('#ptableBody');
  const empty = $('#tableEmpty');
  const list = participants();
  body.innerHTML = '';
  $('#chipCount').textContent = list.length;
  $('#tableFootInfo').textContent = `${list.length} participante${list.length === 1 ? '' : 's'}${state.history.length ? ` · ${state.history.length} ya ganaron` : ''}`;

  if (!list.length) {
    empty.style.display = 'flex';
    $('#ptable').style.display = 'none';
  } else {
    empty.style.display = 'none';
    $('#ptable').style.display = 'table';
    const frag = document.createDocumentFragment();
    list.forEach((p, i) => {
      const tr = document.createElement('tr');
      if (p.won) tr.className = 'is-winner';
      tr.innerHTML = `<td class="num">${esc(p.num)}</td>
        <td class="nm">${esc(p.name)}</td>
        <td class="dt">${esc(p.detail || '—')}</td>
        <td class="rowdel"><button type="button" data-del="${i}" title="Quitar">×</button></td>`;
      frag.appendChild(tr);
    });
    body.appendChild(frag);
  }
  if (state.participants.length > 400) {
    // rendimiento en eventos grandes
    $('#tableFootInfo').textContent += ' · mostrando todo';
  }
}

function renderSummaries() {
  $('#sumPrize').textContent = state.prize || 'Premio principal';
  $('#sumParticipants').textContent = eligible().length + (state.history.length ? ` / ${state.participants.length}` : '');
  $('#sumWinners').textContent = state.winners;
  $('#sumTurns').textContent = state.turns;
  $('#sumDuration').textContent = state.duration + ' s';
  $('#sumBrands').textContent = state.partners.length + 1;

  $('#stagePrize').textContent = state.prize || 'Premio principal';
  $('#stageEvent').textContent = state.event || '';
  $('#stageCount').textContent = eligible().length;
  $('#stageWinners').textContent = state.winners;
  $('#stageRound').textContent = state.round;
  $('#hubTurns').textContent = state.turns;

  renderHistory();
  refreshSpinButton();
}

function renderHistory() {
  const ul = $('#historyList');
  ul.innerHTML = '';
  state.history.forEach((h, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="h-num">${esc(h.num)}</span>
      <span class="h-name">${esc(h.name)}</span>
      <span class="h-prize">${esc(h.prize)}</span>`;
    ul.appendChild(li);
  });
  if (!state.history.length) {
    ul.innerHTML = `<li style="background:none;border:0;color:var(--muted);font-size:12px;padding-left:0">Aún sin ganadores</li>`;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ══════════════ RULETA ══════════════ */
const wheelCv = $('#wheel');
const wctx = wheelCv.getContext('2d');
let wheelSize = 600;

const GOLD = '#F5C24B', GOLD_D = '#D9A62E', NAVY = '#0F1729', NAVY_L = '#182238';

function resizeWheel() {
  const rect = wheelCv.getBoundingClientRect();
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  wheelSize = Math.max(200, Math.round(rect.width));
  wheelCv.width = Math.round(wheelSize * dpr);
  wheelCv.height = Math.round(wheelSize * dpr);
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawWheel();
}

function drawWheel() {
  const list = eligible();
  const n = list.length;
  const size = wheelSize;
  const cx = size / 2, cy = size / 2;
  const radius = size / 2 - 2;

  wctx.clearRect(0, 0, size, size);
  if (n === 0) {
    wctx.save();
    wctx.translate(cx, cy);
    wctx.fillStyle = 'rgba(255,255,255,.035)';
    wctx.beginPath(); wctx.arc(0, 0, radius, 0, Math.PI * 2); wctx.fill();
    wctx.fillStyle = 'rgba(255,255,255,.35)';
    wctx.font = `600 ${Math.max(12, size * 0.035)}px Inter, system-ui, sans-serif`;
    wctx.textAlign = 'center'; wctx.textBaseline = 'middle';
    wctx.fillText('Sin participantes', 0, -6);
    wctx.font = `500 ${Math.max(10, size * 0.022)}px Inter, system-ui, sans-serif`;
    wctx.fillStyle = 'rgba(255,255,255,.22)';
    wctx.fillText('Carga la lista para girar', 0, 16);
    wctx.restore();
    setSpot('—', 'Sin participantes');
    return;
  }

  const step = (Math.PI * 2) / n;

  wctx.save();
  wctx.translate(cx, cy);
  wctx.rotate(rotation);

  for (let i = 0; i < n; i++) {
    const a0 = i * step, a1 = a0 + step;
    const isGold = i % 2 === 0;
    const grad = wctx.createRadialGradient(radius * .25, 0, radius * .1, 0, 0, radius);
    if (isGold) { grad.addColorStop(0, GOLD); grad.addColorStop(1, GOLD_D); }
    else { grad.addColorStop(0, NAVY_L); grad.addColorStop(1, NAVY); }
    wctx.beginPath();
    wctx.moveTo(0, 0);
    wctx.arc(0, 0, radius, a0, a1);
    wctx.closePath();
    wctx.fillStyle = grad;
    wctx.fill();
    wctx.strokeStyle = 'rgba(4,7,14,.6)';
    wctx.lineWidth = Math.max(0.6, size * 0.0016);
    wctx.stroke();
  }

  // textos
  const stepDeg = step * 180 / Math.PI;
  const showName = stepDeg >= 10;
  for (let i = 0; i < n; i++) {
    const item = list[i];
    const mid = i * step + step / 2;
    const isGold = i % 2 === 0;
    if (showName) {
      wctx.save();
      wctx.rotate(mid);
      const baseFont = Math.max(9, Math.min(size * 0.035, step * radius * 0.52));
      wctx.font = `700 ${baseFont}px Inter, system-ui, sans-serif`;
      wctx.textAlign = 'right';
      wctx.textBaseline = 'middle';
      wctx.fillStyle = isGold ? 'rgba(12,16,26,.92)' : 'rgba(246,247,251,.94)';
      const maxW = radius * 0.62;
      let text = item.name;
      if (wctx.measureText(text).width > maxW) {
        while (text.length > 2 && wctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
        text += '…';
      }
      wctx.fillText(text, radius * 0.92, 0);
      wctx.restore();
    } else {
      // muchos participantes: números legibles (rectos, tipo esfera de reloj)
      wctx.save();
      wctx.rotate(mid);
      wctx.translate(radius * 0.80, 0);
      wctx.rotate(-(rotation + mid));
      const baseFont = Math.max(8, Math.min(size * 0.028, step * radius * 0.5));
      wctx.font = `800 ${baseFont}px Inter, system-ui, sans-serif`;
      wctx.textAlign = 'center';
      wctx.textBaseline = 'middle';
      wctx.fillStyle = isGold ? 'rgba(12,16,26,.95)' : 'rgba(246,247,251,.96)';
      wctx.fillText(String(item.num).slice(0, 4), 0, 0);
      wctx.restore();
    }
  }

  // separador interior + puntos
  wctx.beginPath();
  wctx.arc(0, 0, radius * 0.40, 0, Math.PI * 2);
  wctx.fillStyle = 'rgba(6,9,18,.55)';
  wctx.fill();

  wctx.beginPath();
  wctx.arc(0, 0, radius * 0.965, 0, Math.PI * 2);
  wctx.lineWidth = Math.max(1.5, size * 0.006);
  wctx.strokeStyle = 'rgba(245,194,75,.35)';
  wctx.stroke();
  wctx.restore();

  // brillo estático
  wctx.save();
  wctx.translate(cx, cy);
  const gl = wctx.createRadialGradient(0, -radius * .5, 0, 0, 0, radius);
  gl.addColorStop(0, 'rgba(255,255,255,.10)');
  gl.addColorStop(.55, 'rgba(255,255,255,0)');
  wctx.beginPath(); wctx.arc(0, 0, radius, 0, Math.PI * 2); wctx.fillStyle = gl; wctx.fill();
  wctx.restore();

  updateSpotlight(list, n, step);
}

/* Participante bajo el puntero (arriba = -π/2) */
let spotKey = '';
function updateSpotlight(list, n, step) {
  const TWO_PI = Math.PI * 2;
  let a = (-Math.PI / 2 - rotation) % TWO_PI;
  if (a < 0) a += TWO_PI;
  const idx = Math.floor(a / step) % n;
  const cur = list[Math.max(0, Math.min(n - 1, idx))];
  if (!cur) return;
  const key = cur.num + '|' + cur.name;
  if (key !== spotKey) { spotKey = key; setSpot('N° ' + cur.num, cur.name); }
}
function setSpot(num, name) {
  const n = $('#spotNum'), s = $('#spotName');
  if (n) n.textContent = num;
  if (s) s.textContent = name;
}
function setSpotLive(on) {
  const el = $('#spotlight');
  if (el) el.classList.toggle('is-live', !!on);
}

/* ══════════════ AUDIO ══════════════ */
const Audio_ = (() => {
  let ctx = null, master = null, noiseBuf = null;
  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.85;
      master.connect(ctx.destination);
      const len = Math.floor(ctx.sampleRate * 2);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function noise(dur) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    return src;
  }
  function key(n, dur) {
    return { n, dur };
  }
  // Tambores: golpes de bombo acelerando
  function drumRoll(duration) {
    if (!state.sounds || !ensure()) return;
    const t0 = ctx.currentTime;
    let t = 0, interval = 0.30;
    let i = 0;
    while (t < duration) {
      const accent = i % 4 === 0 ? 1.0 : 0.62;
      scheduleTom(t0 + t, accent, 0.10);
      t += Math.max(0.075, interval);
      interval *= 0.972;
      i++;
    }
    // redoble continuo de fondo
    const src = noise(0);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.055, t0 + duration * 0.75);
    g.gain.linearRampToValueAtTime(0.0001, t0 + duration);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + duration + 0.05);
  }
  function scheduleTom(when, vel, dur) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, when);
    o.frequency.exponentialRampToValueAtTime(52, when + dur * .9);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.30 * vel, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(master);
    o.start(when); o.stop(when + dur + 0.02);
    // ataque de ruido
    const src = noise(0); const hp = ctx.createBiquadFilter(); hp.type = 'lowpass'; hp.frequency.value = 420;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.14 * vel, when);
    g2.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    src.connect(hp); hp.connect(g2); g2.connect(master);
    src.start(when); src.stop(when + 0.06);
  }
  function tick() {
    if (!state.sounds || !ensure()) return;
    const t = ctx.currentTime;
    const src = noise(0);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    src.connect(hp); hp.connect(g); g.connect(master);
    src.start(t); src.stop(t + 0.05);
  }
  function crash() {
    if (!state.sounds || !ensure()) return;
    const t = ctx.currentTime;
    const src = noise(0);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.30, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
    src.connect(hp); hp.connect(g); g.connect(master);
    src.start(t); src.stop(t + 2.0);
    // metálicos
    [3200, 4700, 6100].forEach((f, i) => {
      const o = ctx.createOscillator(); const og = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      og.gain.setValueAtTime(0.05 - i * 0.012, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 1.2 + i * .25);
      o.connect(og); og.connect(master); o.start(t); o.stop(t + 1.8);
    });
  }
  function fanfare() {
    if (!state.sounds || !ensure()) return;
    const t0 = ctx.currentTime + 0.02;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      const t = t0 + i * 0.11;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.20, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.7);
      const o2 = ctx.createOscillator(); const g2 = ctx.createGain();
      o2.type = 'sine'; o2.frequency.value = f * 2;
      g2.gain.setValueAtTime(0.0001, t);
      g2.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o2.connect(g2); g2.connect(master); o2.start(t); o2.stop(t + 0.55);
    });
  }
  function applause() {
    if (!state.sounds || !ensure()) return;
    const t0 = ctx.currentTime;
    for (let i = 0; i < 26; i++) {
      const t = t0 + Math.random() * 2.2;
      const src = noise(0);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 900 + Math.random() * 2200; bp.Q.value = 1.4;
      const g = ctx.createGain();
      const amp = 0.02 + Math.random() * 0.05;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.10 + Math.random() * 0.06);
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(t); src.stop(t + 0.25);
    }
  }
  function celebrate() { crash(); fanfare(); applause(); }
  function resume() { ensure(); }
  return { drumRoll, tick, crash, fanfare, applause, celebrate, resume };
})();

/* ══════════════ CONFETI Y SERPENTINAS ══════════════ */
const FX = (() => {
  const cv = $('#fx');
  const ctx = cv.getContext('2d');
  let parts = [], raf = 0, dpr = 1, W = 0, H = 0;

  function size() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  window.addEventListener('resize', () => { size(); });

  const COLORS = ['#F5C24B', '#FFE49B', '#E9724C', '#41D6C3', '#8B7CFF', '#FFFFFF', '#FF9BC1'];

  function rect(x, y, opts = {}) {
    parts.push({
      kind: 'rect', x, y,
      vx: opts.vx ?? (Math.random() - .5) * 12,
      vy: opts.vy ?? (-8 - Math.random() * 12),
      w: 5 + Math.random() * 8, h: 8 + Math.random() * 12,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - .5) * .3,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      life: 0, ttl: 260 + Math.random() * 140,
      drag: .992, grav: .30, sway: Math.random() * Math.PI * 2, swayV: .02 + Math.random() * .05
    });
  }
  function ribbon(x, y, opts = {}) {
    parts.push({
      kind: 'ribbon', x, y,
      vx: opts.vx ?? (Math.random() - .5) * 9,
      vy: opts.vy ?? (-10 - Math.random() * 10),
      len: 70 + Math.random() * 90, wid: 5 + Math.random() * 5,
      rot: Math.random() * Math.PI * 2, vr: (Math.random() - .5) * .12,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      life: 0, ttl: 340 + Math.random() * 160,
      drag: .995, grav: .12, sway: Math.random() * Math.PI * 2, swayV: .03 + Math.random() * .06,
      phase: Math.random() * 6.28
    });
  }
  function spark(x, y) {
    parts.push({
      kind: 'spark', x, y,
      vx: (Math.random() - .5) * 5, vy: (Math.random() - .5) * 5,
      w: 2 + Math.random() * 2.4, color: '#FFF3C9',
      life: 0, ttl: 30 + Math.random() * 30, drag: .94, grav: .06, sway: 0, swayV: 0
    });
  }

  function burst(intensity = 1) {
    if (!state.confetti) return;
    const n = Math.round(150 * intensity);
    // cañones laterales
    for (let i = 0; i < n * .35; i++) {
      rect(0, H * (.55 + Math.random() * .3), { vx: 9 + Math.random() * 16, vy: -9 - Math.random() * 16 });
      rect(W, H * (.55 + Math.random() * .3), { vx: -9 - Math.random() * 16, vy: -9 - Math.random() * 16 });
    }
    // lluvia desde arriba
    for (let i = 0; i < n * .5; i++) {
      rect(Math.random() * W, -20 - Math.random() * 200, { vx: (Math.random() - .5) * 4, vy: 2 + Math.random() * 5 });
      if (i % 3 === 0) ribbon(Math.random() * W, -20 - Math.random() * 160);
    }
    // serpentinas laterales
    for (let i = 0; i < n * .12; i++) {
      ribbon(0, H * (.5 + Math.random() * .35), { vx: 10 + Math.random() * 12, vy: -6 - Math.random() * 10 });
      ribbon(W, H * (.5 + Math.random() * .35), { vx: -10 - Math.random() * 12, vy: -6 - Math.random() * 10 });
    }
    for (let i = 0; i < 40 * intensity; i++) spark(W * .5 + (Math.random() - .5) * W * .6, H * .35 + (Math.random() - .5) * 200);
    run();
  }

  function step() {
    ctx.clearRect(0, 0, W, H);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life++;
      p.vx *= p.drag; p.vy *= p.drag; p.vy += p.grav;
      p.sway += p.swayV;
      p.x += p.vx + Math.sin(p.sway) * (p.kind === 'ribbon' ? 2.4 : 1.1);
      p.y += p.vy;
      p.rot += p.vr;
      const fading = p.life > p.ttl * .8;
      const alpha = fading ? clamp((p.ttl - p.life) / (p.ttl * .2), 0, 1) : 1;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.kind === 'rect') {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.globalAlpha = alpha * .5;
        ctx.fillStyle = '#fff';
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w * .3, p.h);
      } else if (p.kind === 'ribbon') {
        ctx.beginPath();
        const sway = Math.sin(p.sway + p.phase) * 16;
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(sway, p.len * .35, sway * .4, p.len * .7);
        ctx.quadraticCurveTo(-sway * .5, p.len * .9, 0, p.len);
        ctx.lineWidth = p.wid; ctx.lineCap = 'round'; ctx.strokeStyle = p.color; ctx.stroke();
        ctx.lineWidth = p.wid * .35; ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(0, 0, p.w, 0, 6.283); ctx.fill();
      }
      ctx.restore();

      if (p.y > H + 120 || p.life > p.ttl) parts.splice(i, 1);
    }
    if (parts.length) raf = requestAnimationFrame(step);
    else { cancelAnimationFrame(raf); raf = 0; ctx.clearRect(0, 0, W, H); }
  }
  function run() { if (!raf) raf = requestAnimationFrame(step); }
  function stop() { cancelAnimationFrame(raf); raf = 0; parts = []; ctx.clearRect(0, 0, W, H); }
  return { burst, stop, ribbonRain: burst };
})();

/* ══════════════ GIRO ══════════════ */
const easeOutQuart = t => 1 - Math.pow(1 - t, 4);

function refreshSpinButton() {
  const btn = $('#btnSpin');
  const n = eligible().length;
  const lab = $('#spinLabel');
  if (lab) lab.textContent = spinning ? 'Girando…' : `Girar${n === 0 ? '' : ''}`;
  if (btn) btn.disabled = spinning || n === 0;
  const hint = $('#stageHint');
  if (hint) {
    hint.innerHTML = n === 0
      ? 'Carga participantes en <b>Configurar</b> para empezar'
      : spinning ? '🎲 Sorteando…' : 'Presiona <kbd>Espacio</kbd> o el botón para girar';
  }
}

function pickWinners(k) {
  const pool = eligible();
  const idx = pool.map((_, i) => i);
  // Fisher-Yates con crypto
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(cryptoRand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const count = Math.min(k, pool.length);
  return idx.slice(0, count).map(i => pool[i]);
}

function spin() {
  if (spinning) return;
  const pool = eligible();
  if (pool.length === 0) { toast('No quedan participantes por sortear', 'warn'); return; }

  const k = clamp(parseInt(state.winners, 10) || 1, 1, Math.min(12, pool.length));
  const winners = pickWinners(k);
  const target = winners[0];
  const n = pool.length;
  const step = (Math.PI * 2) / n;
  const winIdx = pool.indexOf(target);
  const sectorCenter = winIdx * step + step / 2;

  const turns = clamp(parseInt(state.turns, 10) || 8, 2, 40);
  const duration = clamp(parseInt(state.duration, 10) || 8, 3, 16) * 1000;
  const jitter = (cryptoRand() - 0.5) * step * 0.7; // no cae siempre igual

  const TWO_PI = Math.PI * 2;
  // queremos (sectorCenter + rotation) ≡ -PI/2  (mod 2PI)
  let baseAngle = -Math.PI / 2 - sectorCenter + jitter;
  // normalizar a > rotación actual
  const fullTurns = TWO_PI * turns;
  let delta = ((baseAngle - rotation) % TWO_PI + TWO_PI) % TWO_PI;
  const startRot = rotation;
  const endRot = startRot + fullTurns + delta;

  spinning = true;
  refreshSpinButton();
  $('#wheelWrap').classList.add('is-spinning');
  setSpotLive(true);
  Audio_.resume();
  Audio_.drumRoll(duration / 1000);

  const startTime = performance.now();
  let lastSector = Math.floor(startRot / step);

  function frame(now) {
    const t = clamp((now - startTime) / duration, 0, 1);
    rotation = startRot + (endRot - startRot) * easeOutQuart(t);
    const sector = Math.floor(rotation / step);
    if (sector !== lastSector) {
      lastSector = sector;
      Audio_.tick();
      const ptr = $('#wheelPointer');
      ptr.classList.remove('is-tick');
      void ptr.offsetWidth;
      ptr.classList.add('is-tick');
    }
    drawWheel();
    if (t < 1) requestAnimationFrame(frame);
    else finish(winners);
  }
  requestAnimationFrame(frame);
}

function finish(winners) {
  spinning = false;
  rotation = ((rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  $('#wheelWrap').classList.remove('is-spinning');
  setSpotLive(false);
  setSpot('★', winners.map(w => w.name).join(' · '));
  refreshSpinButton();

  if (state.sounds) Audio_.celebrate();
  if (state.confetti) FX.burst(winners.length > 1 ? 1.35 : 1);

  // registrar historial
  winners.forEach(w => {
    state.history.push({
      num: w.num, name: w.name, detail: w.detail,
      prize: state.prize || 'Premio',
      round: state.round, ts: Date.now()
    });
    if (state.removeWinners) {
      const p = state.participants.find(x => x.num === w.num && x.name === w.name);
      if (p) p.won = true;
    }
  });
  save();
  renderParticipants();
  renderSummaries();
  showWinnerOverlay(winners);
}

/* ══════════════ OVERLAY ══════════════ */
function showWinnerOverlay(winners) {
  const ov = $('#winnerOverlay');
  const cards = $('#winnerCards');
  const kicker = $('#winnerKicker');
  cards.innerHTML = '';

  kicker.textContent = winners.length > 1
    ? `¡${winners.length} ganadores!`
    : '¡Tenemos ganador!';

  const revealOne = (w, i) => {
    const card = document.createElement('div');
    card.className = 'winner-card';
    card.style.animationDelay = `${state.simultaneous ? i * 110 : 0}ms`;
    card.innerHTML = `
      <span class="w-num">N° ${esc(w.num)}</span>
      <span class="w-name">${esc(w.name)}</span>
      ${w.detail ? `<span class="w-detail">${esc(w.detail)}</span>` : ''}
      <span class="w-prize">${esc(state.prize || 'Premio')}</span>`;
    cards.appendChild(card);
    if (!state.simultaneous && i > 0) {
      if (state.sounds) Audio_.crash();
      if (state.confetti) FX.burst(.5);
    }
  };

  if (state.simultaneous) {
    winners.forEach(revealOne);
  } else {
    let i = 0;
    const next = () => {
      if (i >= winners.length) return;
      revealOne(winners[i], i);
      i++;
      if (i < winners.length) setTimeout(next, 1100);
    };
    next();
  }

  ov.hidden = false;
  $('#btnWinnerNext').focus({ preventScroll: true });
}

function closeOverlay() {
  $('#winnerOverlay').hidden = true;
  FX.stop();
}

function nextRound() {
  state.round = (state.round || 1) + 1;
  closeOverlay();
  save();
  renderSummaries();
  renderParticipants();
  drawWheel();
  toast(`Sorteo ${state.round} listo`);
}

/* ══════════════ TOASTS ══════════════ */
function toast(msg, kind = 'ok') {
  const stack = $('#toastStack');
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'warn' ? ' is-warn' : kind === 'error' ? ' is-error' : '');
  const ico = kind === 'error' ? '⚠' : kind === 'warn' ? '!' : '✓';
  el.innerHTML = `<span class="ico" data-ico="check"></span><span>${esc(msg)}</span>`;
  if (kind !== 'ok') el.querySelector('.ico').style.cssText = 'background:none;font-weight:800;display:grid;place-items:center';
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 280);
  }, 3200);
}

/* ══════════════ VISTAS ══════════════ */
function showView(name) {
  const setup = $('#viewSetup'), stage = $('#viewStage');
  if (name === 'stage') {
    setup.classList.remove('is-active');
    stage.classList.add('is-active');
    requestAnimationFrame(() => { resizeWheel(); drawWheel(); });
  } else {
    stage.classList.remove('is-active');
    setup.classList.add('is-active');
    requestAnimationFrame(resizeWheel);
  }
}

/* ══════════════ PLANTILLAS ══════════════ */
function downloadBlob(content, filename, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function templateRows() {
  return [
    ['NUMERO', 'NOMBRE', 'EMPRESA', 'CARGO', 'TELEFONO'],
    ['1', 'Ana Torres', 'UpConta', 'Contadora Senior', '0991111111'],
    ['2', 'Luis Mora', 'Estudio Mora & Asoc.', 'Socio', '0992222222'],
    ['3', 'Carla Vega', 'Nexuss', 'Auditora', '0993333333'],
    ['4', 'José Andrade', 'UpConta', 'Analista', '0994444444']
  ];
}

async function downloadTemplateXlsx() {
  try { await ensureXLSX(); } catch (e) { downloadTemplateCsv(); return; }
  if (window.XLSX) {
    const ws = XLSX.utils.aoa_to_sheet(templateRows());
    ws['!cols'] = [{ wch: 10 }, { wch: 30 }, { wch: 28 }, { wch: 24 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Participantes');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'plantilla-participantes.xlsx');
    toast('Plantilla Excel descargada');
  } else {
    downloadTemplateCsv();
  }
}
function downloadTemplateCsv() {
  const csv = templateRows().map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadBlob('\uFEFF' + csv, 'plantilla-participantes.csv', 'text/csv;charset=utf-8');
  toast('Plantilla CSV descargada');
}

function exportResults() {
  if (!state.history.length) { toast('Todavía no hay resultados', 'warn'); return; }
  const rows = [['SORTEO', 'NUMERO', 'NOMBRE', 'DETALLE', 'PREMIO', 'HORA']];
  state.history.forEach(h => rows.push([h.round, h.num, h.name, h.detail || '', h.prize, fmtTime(h.ts)]));
  const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadBlob('\uFEFF' + csv, `resultados-sorteo-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
  toast('Resultados exportados');
}

/* ══════════════ DEMO ══════════════ */
const DEMO_NAMES = ['Ana Torres', 'Luis Mora', 'Carla Vega', 'José Andrade', 'María Pilco', 'Diego Ruiz',
  'Fernanda Ochoa', 'Carlos Cedeño', 'Andrea Salazar', 'Juan Chávez', 'Paula Guerrero', 'Marco Vinueza',
  'Sofía Espinoza', 'Ricardo León', 'Verónica Núñez', 'Esteban Ortiz', 'Daniela Paredes', 'Gabriel Suárez',
  'Patricia Ruiz', 'Andrés Villamar', 'Gabriela Tapia', 'Oscar Mendoza', 'Mónica Rojas', 'Javier Alvarado',
  'Rosa Quintero', 'Miguel Zambrano', 'Isabel Cabrera', 'Felipe Cordero', 'Camila Aguirre', 'Rodrigo Brito',
  'Elena Caicedo', 'Pablo Herrera', 'Silvia Maldonado', 'Hugo Ponce', 'Lorena Viteri', 'Byron Aguilar',
  'Victoria Sánchez', 'Wilson Cárdenas', 'Tatiana Bonilla', 'Alberto Murillo', 'Cristina Giler', 'Emilio Navas',
  'Natalia Arcos', 'Gustavo Vinueza', 'Paulina Rueda', 'Marco Yépez', 'Alejandra Pinto', 'Rubén Ortega',
  'Irene Cañizares', 'Vicente Romo', 'Diana Bedoya', 'Adrián Jaramillo', 'Karina Freire', 'Tomás Larrea',
  'Bárbara Saltos', 'Santiago Guerrero', 'Elisa Mora', 'Ramiro Cazar', 'Luz Almeida', 'Kevin Basantes'];
const DEMO_COMPANIES = ['UpConta', 'Estudio Mora', 'Nexuss', 'Cumbre', 'PuntoVenta', 'Sofi', 'UpConnect', 'Independiente'];
const DEMO_ROLES = ['Contadora', 'Auditor', 'Socio', 'Analista', 'Asistente contable', 'Gerente', 'Fiscalista', 'Tesorero'];

function seedDemo() {
  const list = DEMO_NAMES.map((n, i) => ({
    num: String(i + 1),
    name: n,
    detail: `${DEMO_COMPANIES[i % DEMO_COMPANIES.length]} · ${DEMO_ROLES[(i * 3) % DEMO_ROLES.length]}`
  }));
  setParticipants(list);
  toast('60 participantes de ejemplo cargados');
}

/* ══════════════ EVENTOS ══════════════ */
function bind() {
  // ── Sonido / pantalla / config
  $('#btnSound').addEventListener('click', () => {
    state.sounds = !state.sounds;
    if (state.sounds) { Audio_.resume(); Audio_.tick(); }
    $('#btnSound').setAttribute('aria-pressed', String(state.sounds));
    $('#chkSounds').checked = state.sounds;
    save();
    toast(state.sounds ? 'Sonido activado' : 'Sonido desactivado');
  });
  $('#btnFullscreen').addEventListener('click', toggleFullscreen);
  $('#btnSetup').addEventListener('click', () => showView('setup'));
  $('#btnBackSetup').addEventListener('click', () => showView('setup'));
  $('#btnOpenStage').addEventListener('click', () => {
    if (eligibleEmpty()) return;
    showView('stage');
    if (!document.fullscreenElement) toggleFullscreen();
  });
  $('#btnSpin').addEventListener('click', spin);
  $('#btnWinnerClose').addEventListener('click', closeOverlay);
  $('#btnWinnerNext').addEventListener('click', nextRound);
  $('#btnExportResults').addEventListener('click', exportResults);
  $('#btnResetAll').addEventListener('click', () => {
    if (!confirm('¿Reiniciar el sorteo? Se borran ganadores e historial (los participantes se mantienen).')) return;
    state.history = []; state.round = 1;
    state.participants.forEach(p => p.won = false);
    save(); renderSummaries(); renderParticipants(); drawWheel(); closeOverlay();
    toast('Sorteo reiniciado');
  });

  // ── Logos
  $('#slotMainLogo').addEventListener('click', e => {
    if (e.target.dataset.clear === 'main') {
      state.logo = null; save(); renderBrand(); renderSummaries(); toast('Logo quitado');
      return;
    }
    $('#fileLogoMain').click();
  });
  $('#slotPartners').addEventListener('click', e => {
    const rm = e.target.dataset.partnerRemove;
    if (rm !== undefined) {
      state.partners.splice(Number(rm), 1); save(); renderBrand(); renderSummaries(); return;
    }
    $('#filePartners').click();
  });
  $('#fileLogoMain').addEventListener('change', e => {
    handleLogoFiles(e.target.files, true); e.target.value = '';
  });
  $('#filePartners').addEventListener('change', e => {
    handleLogoFiles(e.target.files, false); e.target.value = '';
  });

  // drag&drop de logos
  [['#slotMainLogo', true], ['#slotPartners', false]].forEach(([sel, isMain]) => {
    const el = $(sel);
    el.addEventListener('dragover', e => { e.preventDefault(); el.style.borderColor = 'var(--gold)'; });
    el.addEventListener('dragleave', () => { el.style.borderColor = ''; });
    el.addEventListener('drop', e => {
      e.preventDefault(); el.style.borderColor = '';
      handleLogoFiles(e.dataTransfer.files, isMain);
    });
  });

  // ── Import datos
  const dz = $('#dropzone');
  dz.addEventListener('click', () => $('#fileData').click());
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileData').click(); } });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('is-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
  dz.addEventListener('drop', async e => {
    e.preventDefault(); dz.classList.remove('is-over');
    const f = e.dataTransfer.files[0];
    if (f) await ingestFile(f);
  });
  $('#fileData').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) await ingestFile(f);
    e.target.value = '';
  });

  $('#btnTemplateXlsx').addEventListener('click', downloadTemplateXlsx);
  $('#btnTemplateCsv').addEventListener('click', downloadTemplateCsv);
  $('#btnDemo').addEventListener('click', seedDemo);
  $('#btnClearParticipants').addEventListener('click', () => {
    if (!state.participants.length) return;
    if (!confirm('¿Borrar todos los participantes?')) return;
    setParticipants([]); state.history = []; state.round = 1; save(); renderSummaries(); drawWheel();
    toast('Lista borrada');
  });
  $('#btnPaste').addEventListener('click', () => {
    const w = $('#pasteWrap');
    w.hidden = !w.hidden;
    if (!w.hidden) $('#inpPaste').focus();
  });
  $('#btnPasteCancel').addEventListener('click', () => { $('#pasteWrap').hidden = true; });
  $('#btnPasteApply').addEventListener('click', () => {
    const rows = parseCSV($('#inpPaste').value);
    const list = rowsToParticipants(rows);
    if (!list.length) { toast('No se detectaron nombres', 'warn'); return; }
    setParticipants(list);
    $('#pasteWrap').hidden = true;
    toast(`${list.length} participantes cargados`);
  });

  // ── Tabla: borrar fila
  $('#ptableBody').addEventListener('click', e => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    const i = Number(btn.dataset.del);
    state.participants.splice(i, 1);
    save(); renderParticipants(); renderSummaries(); drawWheel();
  });

  // ── Marca / evento
  $('#inpBrand').addEventListener('input', e => {
    state.brand = e.target.value; save(); renderBrand(); renderSummaries();
  });
  $('#inpEvent').addEventListener('input', e => {
    state.event = e.target.value; save(); renderSummaries();
  });

  // ── Ajustes
  $('#inpPrize').addEventListener('input', e => {
    state.prize = e.target.value; save(); renderSummaries();
  });
  $('#inpWinners').addEventListener('change', e => {
    state.winners = clamp(parseInt(e.target.value, 10) || 1, 1, 12);
    e.target.value = state.winners; save(); renderSummaries();
  });
  $$('[data-stepper]').forEach(st => {
    st.addEventListener('click', e => {
      const b = e.target.closest('button[data-dir]');
      if (!b) return;
      const inp = $('input', st);
      const dir = Number(b.dataset.dir);
      const v = clamp((parseInt(inp.value, 10) || 1) + dir, 1, 12);
      inp.value = v; state.winners = v; save(); renderSummaries();
    });
  });
  const turnsRange = $('#inpTurns');
  const setFill = el => {
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--fill', pct + '%');
  };
  turnsRange.addEventListener('input', e => {
    state.turns = parseInt(e.target.value, 10);
    $('#lblTurns').textContent = state.turns; setFill(e.target); save(); renderSummaries();
  });
  const durRange = $('#inpDuration');
  durRange.addEventListener('input', e => {
    state.duration = parseInt(e.target.value, 10);
    $('#lblDuration').textContent = state.duration; setFill(e.target); save(); renderSummaries();
  });

  $('#chkRemoveWinners').addEventListener('change', e => { state.removeWinners = e.target.checked; save(); toast(e.target.checked ? 'Los ganadores no vuelven a salir' : 'Los ganadores pueden repetir'); });
  $('#chkSounds').addEventListener('change', e => {
    state.sounds = e.target.checked; save();
    $('#btnSound').setAttribute('aria-pressed', String(state.sounds));
    if (state.sounds) Audio_.tick();
  });
  $('#chkConfetti').addEventListener('change', e => { state.confetti = e.target.checked; save(); });
  $('#chkSimultaneous').addEventListener('change', e => { state.simultaneous = e.target.checked; save(); });

  // ── Teclado
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if ($('#viewStage').classList.contains('is-active')) {
        if (!$('#winnerOverlay').hidden) return;
        spin();
      } else {
        showView('stage');
      }
    } else if (e.key === 'f' || e.key === 'F') {
      toggleFullscreen();
    } else if (e.key === 'r' || e.key === 'R') {
      if (!$('#winnerOverlay').hidden) nextRound();
    } else if (e.key === 'Escape') {
      if (!$('#winnerOverlay').hidden) closeOverlay();
    } else if (e.key === 'm' || e.key === 'M') {
      $('#btnSound').click();
    }
  });

  window.addEventListener('resize', () => {
    if ($('#viewStage').classList.contains('is-active')) resizeWheel();
  });
}

function eligibleEmpty() { return eligible().length === 0; }

async function ingestFile(file) {
  try {
    const list = await readDataFile(file);
    if (!list.length) { toast('No se encontraron filas con nombre', 'warn'); return; }
    setParticipants(list);
    toast(`${list.length} participantes importados`);
  } catch (err) {
    console.error(err);
    toast('No se pudo leer el archivo: ' + (err.message || 'formato no soportado'), 'error');
  }
}

function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      (document.documentElement.requestFullscreen || function () { }).call(document.documentElement);
    } else {
      document.exitFullscreen();
    }
  } catch (e) { /* ignorar */ }
}

/* ══════════════ INIT ══════════════ */
function hydrateInputs() {
  $('#inpBrand').value = state.brand || '';
  $('#inpEvent').value = state.event || '';
  $('#inpPrize').value = state.prize || '';
  $('#inpWinners').value = state.winners;
  $('#inpTurns').value = state.turns; $('#lblTurns').textContent = state.turns;
  $('#inpDuration').value = state.duration; $('#lblDuration').textContent = state.duration;
  $('#chkRemoveWinners').checked = state.removeWinners;
  $('#chkSounds').checked = state.sounds;
  $('#chkConfetti').checked = state.confetti;
  $('#chkSimultaneous').checked = state.simultaneous;
  $('#btnSound').setAttribute('aria-pressed', String(state.sounds));
  $('#inpTurns').style.setProperty('--fill', ((state.turns - 2) / 38 * 100) + '%');
  $('#inpDuration').style.setProperty('--fill', ((state.duration - 3) / 13 * 100) + '%');
}

async function init() {
  load();
  await applySeed();
  hydrateInputs();
  bind();
  renderBrand();
  renderParticipants();
  renderSummaries();
  resizeWheel();
  showView('setup');
  setTimeout(resizeWheel, 120);

  if (!state.participants.length) {
    setTimeout(() => toast('Tip: usa "Datos demo" para probar la ruleta ahora mismo', 'warn'), 900);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
