/* ═══════════════════════════════════════════════════════════════════════
   Sorteo Studio — ruleta en canvas
   Reutilizable en tres sitios: login (girando lento), vista previa y
   escenario. Sin dependencias: lee los tokens de system.css para que el
   color de marca (--brand) se aplique en caliente.
   ═══════════════════════════════════════════════════════════════════════ */

const TAU = Math.PI * 2;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);

function cssVar(name, fallback = '') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function parseHex(value) {
  let hex = String(value || '').trim().replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function toHex(rgb) {
  return '#' + rgb.map((n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join('');
}

function mix(a, b, amount = 0.5) {
  const ca = parseHex(a) || [227, 176, 75];
  const cb = parseHex(b) || [255, 255, 255];
  return toHex(ca.map((n, i) => n + (cb[i] - n) * amount));
}

function rgba(hex, alpha = 1) {
  const rgb = parseHex(hex) || [227, 176, 75];
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function luminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Color de acento legible sobre fondo oscuro. Si la marca es muy oscura
 * (un azul marino, por ejemplo) se aclara lo justo para cumplir contraste;
 * los rellenos de botón siguen usando --brand tal cual.
 */
export function brandTextColor(hex) {
  if (!parseHex(hex)) return null;
  if (luminance(hex) >= 0.34) return hex;
  let out = hex;
  for (let step = 1; step <= 4; step++) {
    out = mix(hex, '#ffffff', step * 0.14);
    if (luminance(out) >= 0.34) break;
  }
  return out;
}

export class Wheel {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onIndex?: (index:number|null)=>void, labelScale?: number }} [options]
   */
  constructor(canvas, { onIndex = null, labelScale = 1 } = {}) {
    if (!canvas) throw new Error('Wheel necesita un canvas');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onIndex = onIndex;
    this.labelScale = clamp(Number(labelScale) || 1, 0.5, 1.4);
    this.items = [];
    this.rotation = 0;
    this.size = 0;
    this.dpr = 1;
    this._raf = 0;
    this._ambient = 0;
    this._animating = false;
    this._index = -1;
    this._reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._colors = this._readColors();

    this._onResize = () => this.resize();
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(this._onResize) : null;
    if (this._ro) this._ro.observe(canvas.parentElement || canvas);
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  _readColors() {
    const brand = parseHex(cssVar('--brand', '#E3B04B')) ? cssVar('--brand', '#E3B04B') : '#E3B04B';
    return {
      brand,
      brandInk: cssVar('--brand-ink', '#16120A'),
      text: cssVar('--text', '#F3F5FA'),
      muted: cssVar('--muted', '#96A2BA'),
      ink: cssVar('--ink', '#05070D'),
      surface2: cssVar('--surface-2', '#121927'),
      surface3: cssVar('--surface-3', '#18202F'),
      fontUi: cssVar('--font-ui', 'Inter, system-ui, sans-serif')
    };
  }

  /** Relee los tokens (llamar tras applyBrandColor). */
  refreshColors() {
    this._colors = this._readColors();
    this.draw();
  }

  /** @param {{num:string|number,name:string}[]} items */
  setItems(items) {
    this.items = Array.isArray(items) ? items.slice() : [];
    this._index = -1;
    this.draw();
  }

  get sectorStep() {
    return this.items.length ? TAU / this.items.length : TAU;
  }

  /** Índice del gajo que está bajo el puntero (arriba = -PI/2). */
  indexAtPointer(rotation = this.rotation) {
    const n = this.items.length;
    if (!n) return -1;
    const step = TAU / n;
    let angle = (-Math.PI / 2 - rotation) % TAU;
    if (angle < 0) angle += TAU;
    return clamp(Math.floor(angle / step), 0, n - 1);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.round(rect.width);
    if (!width || width < 24) return; // oculta: conserva el último tamaño
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.size = width;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(width * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw() {
    const { ctx, size, items, colors } = {
      ctx: this.ctx,
      size: this.size,
      items: this.items,
      colors: this._colors
    };
    if (!size || !ctx) return;
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 2;
    const rim = Math.max(7, size * 0.042);
    const inner = radius - rim * 0.92;

    ctx.clearRect(0, 0, size, size);

    /* ── Aro metálico con el color de la marca ── */
    const rimGradient = ctx.createLinearGradient(0, -radius, radius * 0.4, radius);
    rimGradient.addColorStop(0, mix(colors.brand, '#ffffff', 0.46));
    rimGradient.addColorStop(0.28, colors.brand);
    rimGradient.addColorStop(0.55, mix(colors.brand, '#000000', 0.48));
    rimGradient.addColorStop(0.78, colors.brand);
    rimGradient.addColorStop(1, mix(colors.brand, '#ffffff', 0.3));
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.fillStyle = rimGradient;
    ctx.fill();

    /* Borde exterior fino + sombra interior del aro */
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 1, 0, TAU);
    ctx.lineWidth = Math.max(1, size * 0.0022);
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, TAU);
    ctx.fillStyle = colors.ink;
    ctx.fill();

    /* ── Sin participantes: disco neutro con voz propia ── */
    if (!items.length) {
      ctx.save();
      ctx.translate(cx, cy);
      const empty = ctx.createRadialGradient(0, -inner * 0.3, inner * 0.1, 0, 0, inner);
      empty.addColorStop(0, colors.surface3);
      empty.addColorStop(1, colors.ink);
      ctx.beginPath();
      ctx.arc(0, 0, inner, 0, TAU);
      ctx.fillStyle = empty;
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors.muted;
      ctx.font = `600 ${Math.max(12, size * 0.036)}px ${colors.fontUi}`;
      ctx.fillText('Aún sin participantes', 0, -size * 0.018);
      ctx.font = `500 ${Math.max(10, size * 0.023)}px ${colors.fontUi}`;
      ctx.fillStyle = rgba(colors.muted, 0.72);
      ctx.fillText('Carga la lista para girar', 0, size * 0.032);
      ctx.restore();
      this._drawStuds(cx, cy, radius, rim, colors);
      return;
    }

    const n = items.length;
    const step = TAU / n;
    const brandLight = mix(colors.brand, '#ffffff', 0.16);
    const brandDeep = mix(colors.brand, '#000000', 0.28);
    const inkLight = colors.surface3;
    const inkDeep = colors.ink;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.rotation);

    /* ── Gajos alternos: marca / tinta ── */
    for (let i = 0; i < n; i++) {
      const from = i * step;
      const to = from + step;
      const isBrand = i % 2 === 0;
      const gradient = ctx.createRadialGradient(0, 0, inner * 0.16, 0, 0, inner);
      if (isBrand) {
        gradient.addColorStop(0, brandLight);
        gradient.addColorStop(0.62, colors.brand);
        gradient.addColorStop(1, brandDeep);
      } else {
        gradient.addColorStop(0, inkLight);
        gradient.addColorStop(0.7, inkDeep);
        gradient.addColorStop(1, '#020409');
      }
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, inner, from, to);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    /* Separadores: líneas finas de tinta */
    ctx.lineWidth = Math.max(0.7, size * 0.0018);
    ctx.strokeStyle = 'rgba(3,5,10,.62)';
    for (let i = 0; i < n; i++) {
      const angle = i * step;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * inner * 0.22, Math.sin(angle) * inner * 0.22);
      ctx.lineTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
      ctx.stroke();
    }

    /* ── Etiquetas ── */
    const showNames = n <= 24;
    for (let i = 0; i < n; i++) {
      const item = items[i] || {};
      const mid = i * step + step / 2;
      const isBrand = i % 2 === 0;
      const ink = isBrand ? colors.brandInk : colors.text;
      ctx.save();
      ctx.rotate(mid);

      if (showNames) {
        /* Banda de texto: solo el anillo exterior (del borde del cubo al aro),
           así ninguna etiqueta queda tapada por el velo del centro. */
        const maxWidth = inner * 0.46;
        const fontSize = Math.max(9, Math.min(size * 0.036, step * inner * 0.5) * this.labelScale);
        ctx.font = `650 ${fontSize}px ${colors.fontUi}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = ink;
        /* Si el nombre completo no entra, se abrevia con criterio (legible a 3 m)
           antes de recurrir a los puntos suspensivos. */
        let text = String(item.name || '');
        const fits = (t) => ctx.measureText(t).width <= maxWidth;
        if (!fits(text)) {
          const parts = text.trim().split(/\s+/).filter(Boolean);
          const candidates = [];
          if (parts.length > 2) candidates.push(parts.slice(0, 2).join(' '));
          if (parts.length > 1) candidates.push(`${parts[0]} ${parts[1].charAt(0)}.`);
          if (parts.length > 2) candidates.push(`${parts[0]} ${parts[parts.length - 1].charAt(0)}.`);
          if (parts.length) candidates.push(parts[0]);
          const hit = candidates.find(fits);
          if (hit) text = hit;
          else {
            while (text.length > 2 && !fits(`${text}…`)) text = text.slice(0, -1);
            text += '…';
          }
        }
        ctx.fillText(text, inner * 0.93, 0);
      } else {
        /* Muchos participantes: número recto, tipo esfera de reloj */
        ctx.translate(inner * 0.79, 0);
        ctx.rotate(-(this.rotation + mid));
        const fontSize = Math.max(8, Math.min(size * 0.03, step * inner * 0.54) * this.labelScale);
        ctx.font = `800 ${fontSize}px ${colors.fontUi}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = ink;
        ctx.fillText(String(item.num ?? i + 1).slice(0, 4), 0, 0);
      }
      ctx.restore();
    }

    /* Velo interior que separa los textos del centro */
    const veil = ctx.createRadialGradient(0, 0, inner * 0.2, 0, 0, inner * 0.94);
    veil.addColorStop(0, 'rgba(5,7,13,.78)');
    veil.addColorStop(0.42, 'rgba(5,7,13,.28)');
    veil.addColorStop(1, 'rgba(5,7,13,0)');
    ctx.beginPath();
    ctx.arc(0, 0, inner, 0, TAU);
    ctx.fillStyle = veil;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, inner * 0.985, 0, TAU);
    ctx.lineWidth = Math.max(1, size * 0.0035);
    ctx.strokeStyle = rgba(colors.brand, 0.5);
    ctx.stroke();

    ctx.restore(); // fin del grupo rotado

    /* ── Reflejo de vidrio sobre el aro ── */
    ctx.save();
    ctx.translate(cx, cy);
    const shine = ctx.createRadialGradient(0, -inner * 0.55, 0, 0, 0, inner);
    shine.addColorStop(0, 'rgba(255,255,255,.12)');
    shine.addColorStop(0.55, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(0, 0, inner, 0, TAU);
    ctx.fillStyle = shine;
    ctx.fill();
    ctx.restore();

    /* ── Centro (el hub HTML se dibuja encima en la UI) ── */
    ctx.beginPath();
    ctx.arc(cx, cy, inner * 0.27, 0, TAU);
    ctx.fillStyle = 'rgba(4,6,12,.92)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, size * 0.0035);
    ctx.strokeStyle = rgba(colors.brand, 0.62);
    ctx.stroke();

    this._drawStuds(cx, cy, radius, rim, colors);

    const index = this.indexAtPointer();
    if (index !== this._index) {
      this._index = index;
      if (this.onIndex) this.onIndex(index);
    }
  }

  _drawStuds(cx, cy, radius, rim, colors) {
    const ctx = this.ctx;
    const count = 24;
    const studRadius = Math.max(1.3, radius * 0.006);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * TAU - Math.PI / 2;
      const x = cx + Math.cos(angle) * (radius - rim * 0.48);
      const y = cy + Math.sin(angle) * (radius - rim * 0.48);
      ctx.beginPath();
      ctx.arc(x, y, studRadius, 0, TAU);
      ctx.fillStyle = i % 2 === 0 ? rgba(colors.brandInk, 0.32) : 'rgba(255,255,255,.28)';
      ctx.fill();
    }
  }

  /**
   * Gira y se detiene en el gajo `index` (ya elegido por el servidor).
   * Devuelve una promesa que resuelve al terminar.
   */
  spinToIndex(index, { turns = 8, duration = 8000, onTick = null } = {}) {
    const n = this.items.length;
    if (!n) return Promise.resolve(false);
    this._reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const step = TAU / n;
    const target = clamp(index, 0, n - 1) * step + step / 2;
    const jitter = (Math.random() - 0.5) * step * 0.46;
    const from = this.rotation;
    const base = -Math.PI / 2 - target + jitter;
    let delta = ((base - from) % TAU + TAU) % TAU;
    const totalTurns = clamp(Math.round(turns), 2, 40);
    const to = from + TAU * totalTurns + delta;
    const durationMs = clamp(Number(duration) || 8000, 0, 20000);

    if (this._reduced || durationMs < 200) {
      this.rotation = ((to % TAU) + TAU) % TAU;
      this._animating = false;
      this.draw();
      if (this.onIndex) this.onIndex(this.indexAtPointer());
      return Promise.resolve(true);
    }

    this._animating = true;
    const started = performance.now();
    let lastIndex = this.indexAtPointer(from);

    return new Promise((resolve) => {
      const frame = (now) => {
        if (!this._animating) return resolve(false);
        const t = clamp((now - started) / durationMs, 0, 1);
        this.rotation = from + (to - from) * easeOutQuart(t);
        const current = this.indexAtPointer();
        if (current !== lastIndex) {
          lastIndex = current;
          if (this.onIndex) this.onIndex(current);
          if (onTick) onTick(current);
        }
        this.draw();
        if (t < 1) {
          this._raf = requestAnimationFrame(frame);
        } else {
          this._animating = false;
          this.rotation = ((this.rotation % TAU) + TAU) % TAU;
          this.draw();
          resolve(true);
        }
      };
      this._raf = requestAnimationFrame(frame);
    });
  }

  /** Giro lento y continuo (login). `radiansPerSecond`. */
  startAmbient(radiansPerSecond = TAU / 44) {
    this._reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this._reduced) return;
    this.stopAmbient();
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(80, now - last);
      last = now;
      this.rotation = (this.rotation + radiansPerSecond * (dt / 1000)) % TAU;
      this.draw();
      this._ambient = requestAnimationFrame(tick);
    };
    this._ambient = requestAnimationFrame(tick);
  }

  stopAmbient() {
    if (this._ambient) cancelAnimationFrame(this._ambient);
    this._ambient = 0;
  }

  stop() {
    this._animating = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.stopAmbient();
  }

  destroy() {
    this.stop();
    if (this._ro) this._ro.disconnect();
    window.removeEventListener('resize', this._onResize);
  }
}
