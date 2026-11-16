/* ═══════════════════════════════════════════════════════════════════════
   Sorteo Studio — confeti y serpentinas en canvas
   Cap duro de partículas para sostener 60 fps en el escenario. Respeta
   `prefers-reduced-motion` (no lanza nada) y el interruptor de confeti.
   ═══════════════════════════════════════════════════════════════════════ */

const MAX_PARTICLES = 600;
const MAX_DPR = 2;

const state = {
  canvas: null,
  ctx: null,
  parts: [],
  raf: 0,
  width: 0,
  height: 0,
  dpr: 1,
  enabled: true,
  focus: false
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function parseHex(value) {
  let hex = String(value || '').trim().replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function mix(a, b, amount) {
  const ca = parseHex(a) || [227, 176, 75];
  const cb = parseHex(b) || [255, 255, 255];
  return '#' + ca.map((n, i) => clamp(Math.round(n + (cb[i] - n) * amount), 0, 255).toString(16).padStart(2, '0')).join('');
}

function palette() {
  const brand = parseHex(cssVar('--brand', '#E3B04B')) ? cssVar('--brand', '#E3B04B') : '#E3B04B';
  return [
    brand,
    mix(brand, '#ffffff', 0.42),
    '#FFFFFF',
    '#E9EDF5',
    mix(brand, '#000000', 0.36),
    mix(brand, '#ffffff', 0.72)
  ];
}

function resize() {
  if (!state.canvas) return;
  state.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  state.width = window.innerWidth;
  state.height = window.innerHeight;
  state.canvas.width = Math.round(state.width * state.dpr);
  state.canvas.height = Math.round(state.height * state.dpr);
  state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
}

function push(particle) {
  if (state.parts.length >= MAX_PARTICLES) return;
  state.parts.push(particle);
}

function makeConfetti(x, y, options = {}) {
  const colors = palette();
  push({
    kind: 'confetti',
    x,
    y,
    vx: options.vx ?? (Math.random() - 0.5) * 12,
    vy: options.vy ?? (-8 - Math.random() * 12),
    w: 5 + Math.random() * 8,
    h: 8 + Math.random() * 12,
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[(Math.random() * colors.length) | 0],
    life: 0,
    ttl: 260 + Math.random() * 140,
    drag: 0.992,
    gravity: 0.3,
    sway: Math.random() * Math.PI * 2,
    swayV: 0.02 + Math.random() * 0.05
  });
}

function makeRibbon(x, y, options = {}) {
  const colors = palette();
  push({
    kind: 'ribbon',
    x,
    y,
    vx: options.vx ?? (Math.random() - 0.5) * 9,
    vy: options.vy ?? (-10 - Math.random() * 10),
    len: 70 + Math.random() * 90,
    wid: 5 + Math.random() * 5,
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.12,
    color: colors[(Math.random() * colors.length) | 0],
    life: 0,
    ttl: 340 + Math.random() * 160,
    drag: 0.995,
    gravity: 0.12,
    sway: Math.random() * Math.PI * 2,
    swayV: 0.03 + Math.random() * 0.06,
    phase: Math.random() * 6.28
  });
}

function makeSpark(x, y) {
  push({
    kind: 'spark',
    x,
    y,
    vx: (Math.random() - 0.5) * 5,
    vy: (Math.random() - 0.5) * 5,
    w: 2 + Math.random() * 2.4,
    color: '#FFF3C9',
    life: 0,
    ttl: 30 + Math.random() * 30,
    drag: 0.94,
    gravity: 0.06,
    sway: 0,
    swayV: 0
  });
}

function frame() {
  const { ctx } = state;
  if (!ctx) return;
  ctx.clearRect(0, 0, state.width, state.height);
  for (let i = state.parts.length - 1; i >= 0; i--) {
    const p = state.parts[i];
    p.life++;
    p.vx *= p.drag;
    p.vy = p.vy * p.drag + p.gravity;
    p.sway += p.swayV;
    p.x += p.vx + Math.sin(p.sway) * (p.kind === 'ribbon' ? 2.4 : 1.1);
    p.y += p.vy;
    p.rot += p.vr;
    const fading = p.life > p.ttl * 0.8;
    const alpha = fading ? clamp((p.ttl - p.life) / (p.ttl * 0.2), 0, 1) : 1;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    if (p.kind === 'confetti') {
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.globalAlpha = alpha * 0.5;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w * 0.3, p.h);
    } else if (p.kind === 'ribbon') {
      const sway = Math.sin(p.sway + p.phase) * 16;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(sway, p.len * 0.35, sway * 0.4, p.len * 0.7);
      ctx.quadraticCurveTo(-sway * 0.5, p.len * 0.9, 0, p.len);
      ctx.lineWidth = p.wid;
      ctx.lineCap = 'round';
      ctx.strokeStyle = p.color;
      ctx.stroke();
      ctx.lineWidth = p.wid * 0.35;
      ctx.strokeStyle = 'rgba(255,255,255,.45)';
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, p.w, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
    ctx.restore();

    if (p.y > state.height + 140 || p.life > p.ttl) state.parts.splice(i, 1);
  }

  /* Con el overlay de ganador abierto, se despeja el centro para que el
     logo, los nombres y el premio respiren; el confeti queda en los bordes. */
  if (state.focus) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    const cx = state.width * 0.5;
    const cy = state.height * 0.42;
    const radius = Math.min(state.width, state.height) * 0.46;
    const hole = ctx.createRadialGradient(cx, cy, radius * 0.34, cx, cy, radius);
    hole.addColorStop(0, 'rgba(0,0,0,1)');
    hole.addColorStop(0.72, 'rgba(0,0,0,0.86)');
    hole.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = hole;
    ctx.fillRect(0, 0, state.width, state.height);
    ctx.restore();
  }

  if (state.parts.length) {
    state.raf = requestAnimationFrame(frame);
  } else {
    state.raf = 0;
    ctx.clearRect(0, 0, state.width, state.height);
  }
}

function run() {
  if (!state.raf) state.raf = requestAnimationFrame(frame);
}

export const FX = {
  /** @param {HTMLCanvasElement} canvas capa fija a pantalla completa */
  init(canvas) {
    if (!canvas) return;
    state.canvas = canvas;
    state.ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  },

  setEnabled(value) {
    state.enabled = !!value;
    if (!state.enabled) FX.stop();
  },

  /** Despeja el centro de la capa (overlay de ganador). */
  setFocus(value) {
    state.focus = !!value;
  },

  get enabled() {
    return state.enabled;
  },

  /** @param {number} intensity 1 = una explosión normal */
  burst(intensity = 1) {
    if (!state.enabled || !state.ctx || reducedMotion()) return;
    resize();
    const strength = clamp(Number(intensity) || 1, 0.25, 2);
    const count = Math.round(150 * strength);
    const W = state.width;
    const H = state.height;

    for (let i = 0; i < count * 0.3; i++) {
      makeConfetti(0, H * (0.55 + Math.random() * 0.3), { vx: 9 + Math.random() * 16, vy: -9 - Math.random() * 16 });
      makeConfetti(W, H * (0.55 + Math.random() * 0.3), { vx: -9 - Math.random() * 16, vy: -9 - Math.random() * 16 });
    }
    for (let i = 0; i < count * 0.46; i++) {
      makeConfetti(Math.random() * W, -20 - Math.random() * 200, { vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 5 });
      if (i % 3 === 0) makeRibbon(Math.random() * W, -20 - Math.random() * 160);
    }
    for (let i = 0; i < count * 0.12; i++) {
      makeRibbon(0, H * (0.5 + Math.random() * 0.35), { vx: 10 + Math.random() * 12, vy: -6 - Math.random() * 10 });
      makeRibbon(W, H * (0.5 + Math.random() * 0.35), { vx: -10 - Math.random() * 12, vy: -6 - Math.random() * 10 });
    }
    for (let i = 0; i < 40 * strength; i++) {
      makeSpark(W * 0.5 + (Math.random() - 0.5) * W * 0.6, H * 0.35 + (Math.random() - 0.5) * 200);
    }
    run();
  },

  stop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.parts = [];
    if (state.ctx) state.ctx.clearRect(0, 0, state.width, state.height);
  }
};
