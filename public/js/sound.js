/* ═══════════════════════════════════════════════════════════════════════
   Sorteo Studio — audio sintetizado (WebAudio, sin archivos)
   Tambores que aceleran, tick al pasar cada gajo, crash, fanfarria y
   aplausos. El AudioContext se crea en el primer gesto del usuario.
   ═══════════════════════════════════════════════════════════════════════ */

const SoundState = {
  ctx: null,
  master: null,
  noise: null,
  enabled: true,
  unlocked: false
};

function ensure() {
  if (SoundState.ctx) return SoundState.ctx;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  try {
    const ctx = new AudioCtor();
    const master = ctx.createGain();
    master.gain.value = 0.82;
    master.connect(ctx.destination);
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    SoundState.ctx = ctx;
    SoundState.master = master;
    SoundState.noise = buffer;
    return ctx;
  } catch {
    return null;
  }
}

function ready() {
  if (!SoundState.enabled) return null;
  const ctx = ensure();
  // Sin gesto del usuario el contexto queda suspendido: no se programan
  // nodos (así el navegador no escupe un warning por cada uno).
  if (!ctx || ctx.state !== 'running') return null;
  return ctx;
}

function noiseSource(ctx) {
  const source = ctx.createBufferSource();
  source.buffer = SoundState.noise;
  source.loop = true;
  return source;
}

function scheduleTom(when, velocity, duration) {
  const ctx = SoundState.ctx;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, when);
  osc.frequency.exponentialRampToValueAtTime(52, when + duration * 0.9);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.3 * velocity, when + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  osc.connect(gain);
  gain.connect(SoundState.master);
  osc.start(when);
  osc.stop(when + duration + 0.02);

  const source = noiseSource(ctx);
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 420;
  const attack = ctx.createGain();
  attack.gain.setValueAtTime(0.14 * velocity, when);
  attack.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
  source.connect(lowpass);
  lowpass.connect(attack);
  attack.connect(SoundState.master);
  source.start(when);
  source.stop(when + 0.06);
}

export const sound = {
  setEnabled(value) {
    SoundState.enabled = !!value;
    if (!SoundState.enabled && SoundState.ctx && SoundState.ctx.state === 'running') {
      SoundState.ctx.suspend().catch(() => {});
    } else if (SoundState.enabled && SoundState.ctx) {
      SoundState.ctx.resume().catch(() => {});
    }
  },

  get enabled() {
    return SoundState.enabled;
  },

  /** Debe llamarse de forma sincrónica dentro de un gesto del usuario. */
  unlock() {
    if (!SoundState.enabled) return;
    SoundState.unlocked = true;
    const ctx = ensure();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  },

  /** Redoble acelerado durante `durationSeconds`. */
  drumRoll(durationSeconds = 8) {
    if (!ready()) return;
    const ctx = SoundState.ctx;
    const start = ctx.currentTime + 0.02;
    const total = Math.max(0.5, Number(durationSeconds) || 8);
    let elapsed = 0;
    let interval = 0.3;
    let i = 0;
    while (elapsed < total) {
      scheduleTom(start + elapsed, i % 4 === 0 ? 1 : 0.62, 0.1);
      elapsed += Math.max(0.075, interval);
      interval *= 0.972;
      i++;
    }
    const source = noiseSource(ctx);
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 900;
    bandpass.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.05, start + total * 0.75);
    gain.gain.linearRampToValueAtTime(0.0001, start + total);
    source.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(SoundState.master);
    source.start(start);
    source.stop(start + total + 0.05);
  },

  tick() {
    if (!ready()) return;
    const ctx = SoundState.ctx;
    const now = ctx.currentTime;
    const source = noiseSource(ctx);
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 2400;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.05, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
    source.connect(highpass);
    highpass.connect(gain);
    gain.connect(SoundState.master);
    source.start(now);
    source.stop(now + 0.05);
  },

  crash() {
    if (!ready()) return;
    const ctx = SoundState.ctx;
    const now = ctx.currentTime;
    const source = noiseSource(ctx);
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 3200;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.28, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.9);
    source.connect(highpass);
    highpass.connect(gain);
    gain.connect(SoundState.master);
    source.start(now);
    source.stop(now + 2);

    [3200, 4700, 6100].forEach((frequency, i) => {
      const osc = ctx.createOscillator();
      const oscGain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = frequency;
      oscGain.gain.setValueAtTime(0.05 - i * 0.012, now);
      oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2 + i * 0.25);
      osc.connect(oscGain);
      oscGain.connect(SoundState.master);
      osc.start(now);
      osc.stop(now + 1.8);
    });
  },

  fanfare() {
    if (!ready()) return;
    const ctx = SoundState.ctx;
    const start = ctx.currentTime + 0.02;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((frequency, i) => {
      const when = start + i * 0.11;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.2, when + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.65);
      osc.connect(gain);
      gain.connect(SoundState.master);
      osc.start(when);
      osc.stop(when + 0.7);

      const harmonic = ctx.createOscillator();
      const harmonicGain = ctx.createGain();
      harmonic.type = 'sine';
      harmonic.frequency.value = frequency * 2;
      harmonicGain.gain.setValueAtTime(0.0001, when);
      harmonicGain.gain.exponentialRampToValueAtTime(0.07, when + 0.02);
      harmonicGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.5);
      harmonic.connect(harmonicGain);
      harmonicGain.connect(SoundState.master);
      harmonic.start(when);
      harmonic.stop(when + 0.55);
    });
  },

  applause() {
    if (!ready()) return;
    const ctx = SoundState.ctx;
    const start = ctx.currentTime;
    for (let i = 0; i < 26; i++) {
      const when = start + Math.random() * 2.2;
      const source = noiseSource(ctx);
      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 900 + Math.random() * 2200;
      bandpass.Q.value = 1.4;
      const gain = ctx.createGain();
      const amp = 0.02 + Math.random() * 0.05;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(amp, when + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.1 + Math.random() * 0.06);
      source.connect(bandpass);
      bandpass.connect(gain);
      gain.connect(SoundState.master);
      source.start(when);
      source.stop(when + 0.25);
    }
  },

  celebrate() {
    if (!SoundState.enabled) return;
    this.crash();
    this.fanfare();
    this.applause();
  }
};
