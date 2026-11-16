/* ═══════════════════════════════════════════════════════════════════════
   Cliente API compartido + utilidades de UI
   Usar desde studio.js, admin.js y login.js:  import { api, toast, ... } from './api.js'
   ═══════════════════════════════════════════════════════════════════════ */

export class ApiError extends Error {
  constructor(code, message, status, payload) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

/** Petición JSON con CSRF y manejo de sesión expirada. */
export async function api(path, { method = 'GET', body, redirectOn401 = true } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'fetch',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json().catch(() => null);

  if (!res.ok) {
    const code = data?.error || `HTTP_${res.status}`;
    const msg = data?.message || 'No se pudo completar la operación.';
    if (res.status === 401 && redirectOn401 && !location.pathname.startsWith('/login')) {
      location.href = '/login';
    }
    throw new ApiError(code, msg, res.status, data);
  }
  return data;
}

/* ── DOM ── */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ── Toast ── */
export function toast(message, kind = 'ok') {
  let stack = $('.toast-stack');
  if (!stack) {
    stack = el('div', { class: 'toast-stack', 'aria-live': 'polite' });
    document.body.appendChild(stack);
  }
  const node = el('div', { class: `toast toast--${kind}`, role: 'status' }, [
    el('span', { class: 'ico', 'aria-hidden': 'true', html: kind === 'err' ? '✕' : kind === 'warn' ? '!' : '✓' }),
    el('span', { text: message })
  ]);
  stack.appendChild(node);
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 220);
  }, 3400);
  return node;
}

/* ── Formato (es-EC) ── */
export const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString('es-EC', { year: 'numeric', month: 'short', day: '2-digit' });
};
export const fmtDateTime = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-EC', {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
};
export const money = (cents) =>
  (Number(cents || 0) / 100).toLocaleString('es-EC', { style: 'currency', currency: 'USD' });

export function daysLeft(iso) {
  if (!iso) return null;
  const end = new Date(iso.length === 10 ? `${iso}T23:59:59` : iso).getTime();
  return Math.ceil((end - Date.now()) / 86400000);
}

export function licensePill(license) {
  const status = license?.status || 'pending';
  const left = daysLeft(license?.expiresAt);
  if (status === 'revoked') return { cls: 'pill--danger', text: 'Revocada' };
  if (status === 'expired' || (status === 'active' && left !== null && left < 0)) return { cls: 'pill--danger', text: 'Vencida' };
  if (status === 'pending') return { cls: 'pill--warn', text: 'Pago pendiente' };
  if (left !== null && left <= 7) return { cls: 'pill--warn pill--pulse', text: `Vence en ${left} d` };
  return { cls: 'pill--ok', text: left === null ? 'Activa' : `Activa · ${left} d` };
}

/* ── Marca: color dominante del logo + aplicación del token ── */
const relLum = (rgb) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mixWithWhite = (rgb, amount) => rgb.map((c) => Math.round(c + (255 - c) * amount));

/**
 * Devuelve la tinta que MÁS contrasta sobre el color de marca.
 * Regla: se comparan los ratios reales contra blanco y contra negro (no un umbral a ojo),
 * porque colores medios como un teal (#1FA37A) fallan AA con texto blanco (3.19:1).
 */
export function brandInk(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#12100A';
  const lum = relLum(hexToRgb(hex));
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const dark = relLum(hexToRgb('#12100A'));
  const cWhite = ratio(1, lum);
  const cDark = ratio(dark, lum);
  return cWhite >= cDark ? '#FFFFFF' : '#12100A';
}

/** Variante legible del color de marca para TEXTO sobre fondo oscuro. */
export function brandText(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const rgb = hexToRgb(hex);
  const lum = relLum(rgb);
  if (lum >= 0.22) return hex;
  return '#' + mixWithWhite(rgb, 0.5).map((c) => c.toString(16).padStart(2, '0')).join('');
}

export function applyBrandColor(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return;
  const root = document.documentElement;
  const rgb = hexToRgb(hex);
  root.style.setProperty('--brand', hex);
  root.style.setProperty('--brand-ink', brandInk(hex));
  root.style.setProperty('--brand-text', brandText(hex));
  root.style.setProperty('--brand-soft', `rgba(${rgb.join(',')},0.14)`);
  root.style.setProperty('--brand-line', `rgba(${rgb.join(',')},0.38)`);
}

/** Extrae un color representativo (saturación media-alta) de una imagen. */
export function extractDominantColor(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 48;
        const cv = document.createElement('canvas');
        cv.width = size; cv.height = size;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        let best = null, bestScore = -1;
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 200) continue;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          const val = max / 255;
          if (val < 0.18) continue;                       // casi negro
          if (sat < 0.12 && val > 0.9) continue;          // casi blanco
          const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
          const cur = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, score: 0 };
          cur.r += r; cur.g += g; cur.b += b; cur.n++;
          cur.score += sat * (0.35 + 0.65 * val);
          buckets.set(key, cur);
        }
        for (const v of buckets.values()) {
          const score = (v.score / v.n) * Math.log(1 + v.n);
          if (score > bestScore) { bestScore = score; best = v; }
        }
        if (!best) return resolve(null);
        const hex = '#' + [best.r, best.g, best.b]
          .map((c) => Math.round(c / best.n).toString(16).padStart(2, '0')).join('');
        resolve(hex);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** Lee un archivo de imagen, lo reduce a PNG/JPEG dataURL (máx. `maxDim`). */
export function fileToDataUrl(file, maxDim = 480) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.onload = () => {
      const src = String(reader.result);
      if (file.type === 'image/svg+xml') return resolve(src);      // se valida en servidor
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Imagen inválida'));
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

export const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export function debounce(fn, ms = 260) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Pide confirmación con un modal accesible y devuelve bool. */
export function confirmDialog({ title, message, confirmText = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'backdrop' });
    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('h2', { class: 'card__title', text: title }),
      el('p', { class: 'hint', style: 'margin:10px 0 18px;font-size:13px', text: message }),
      el('div', { class: 'row', style: 'justify-content:flex-end;gap:10px' }, [
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancelar', onclick: close.bind(null, false) }),
        el('button', { class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, type: 'button', text: confirmText, onclick: close.bind(null, true) })
      ])
    ]);
    function close(value) {
      document.removeEventListener('keydown', onKey);
      backdrop.remove(); modal.remove();
      resolve(value);
    }
    function onKey(e) { if (e.key === 'Escape') close(false); }
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', () => close(false));
    document.body.append(backdrop, modal);
    modal.querySelector('button:last-child').focus();
  });
}
