/* ═══════════════════════════════════════════════════════════════════════
   Estudio — shell, cuatro vistas y escenario.
   El sorteo lo decide SIEMPRE el servidor (POST /api/studio/draw); aquí
   solo se anima la ruleta hasta el ganador devuelto y se revela.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  api,
  toast,
  el,
  esc,
  applyBrandColor,
  fileToDataUrl,
  extractDominantColor,
  fmtDate,
  fmtDateTime,
  confirmDialog,
  licensePill,
  initials
} from './api.js';
import { Wheel, brandTextColor } from './wheel.js';
import { sound } from './sound.js';
import { FX } from './fx.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/* Fuentes con media="print": activadas desde JS (CSP-safe, no bloqueantes). */
document.querySelectorAll('link[data-fonts]').forEach((link) => {
  link.media = 'all';
});

const SESSION_HINT = 'sorteo.session';
function setSessionHint(value) {
  try {
    if (value) localStorage.setItem(SESSION_HINT, '1');
    else localStorage.removeItem(SESSION_HINT);
  } catch {
    /* modo privado */
  }
}

const MAX_PARTICIPANTS = 2000;
const MAX_PARTNERS = 12;

const DEFAULT_SETTINGS = {
  winners: 1,
  turns: 8,
  duration: 8,
  removeWinners: true,
  sounds: true,
  confetti: true,
  simultaneous: true
};

const VIEW_META = {
  sorteo: {
    title: 'Sorteo',
    sub: 'Configura la ruleta y ábrela en el escenario.'
  },
  participantes: {
    title: 'Participantes',
    sub: 'La lista que entra a la ruleta. Hasta 2.000 personas.'
  },
  marca: {
    title: 'Marca',
    sub: 'El logo, el nombre y el color que se ven en pantalla.'
  },
  historial: {
    title: 'Historial',
    sub: 'El acta del evento, ronda por ronda.'
  }
};

const state = {
  user: null,
  branding: {
    displayName: '',
    logoPath: null,
    logoDataUrl: null,
    partners: [],
    brandColor: '#E3B04B'
  },
  studio: {
    eventTitle: '',
    prize: 'Premio principal',
    round: 1,
    settings: { ...DEFAULT_SETTINGS }
  },
  participants: [],
  draws: [],
  license: null,
  view: 'sorteo',
  brandDirty: { logo: false, partners: false },
  spinning: false,
  stageOpen: false,
  logoLum: new Map()
};

let wheelPreview = null;
let wheelStage = null;
let saveSettingsTimer = 0;
let saveParticipantsTimer = 0;
let saveStateTimer = 0;
let revealTimers = [];
let bound = false;

/* ══════════════ utilidades ══════════════ */

const eligible = () => state.participants.filter((p) => !p.won);
const toItem = (p) => ({ num: String(p.num ?? ''), name: String(p.name ?? '') });
const logoSource = () => state.branding.logoDataUrl || state.branding.logoPath || null;
const companyName = () => state.branding.displayName || state.user?.companyName || 'Tu empresa';
const prizeName = () => state.studio.prize || 'Premio principal';
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const sameParticipant = (a, b) => {
  if (!a || !b) return false;
  if (a.id != null && b.id != null) return a.id === b.id;
  return String(a.num) === String(b.num) && String(a.name) === String(b.name);
};

function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function setValue(input, value) {
  if (input && input.value !== String(value)) input.value = String(value);
}

function setSaveState(text, kind = '') {
  const node = $('#saveState');
  if (!node) return;
  node.textContent = text;
  node.dataset.kind = kind;
  clearTimeout(saveStateTimer);
  if (kind === 'ok') {
    saveStateTimer = setTimeout(() => {
      if (node.textContent === text) {
        node.textContent = 'Todo guardado';
        node.dataset.kind = '';
      }
    }, 2400);
  }
}

function setBrandSaveState(text, kind = '') {
  const node = $('#brandSaveState');
  if (!node) return;
  node.textContent = text;
  node.dataset.kind = kind;
}

function updateRangeFill(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value) || min;
  input.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    winners: clamp(Number(source.winners) || DEFAULT_SETTINGS.winners, 1, 12),
    turns: clamp(Number(source.turns) || DEFAULT_SETTINGS.turns, 2, 40),
    duration: clamp(Number(source.duration) || DEFAULT_SETTINGS.duration, 3, 16),
    removeWinners: source.removeWinners !== false,
    sounds: source.sounds !== false,
    confetti: source.confetti !== false,
    simultaneous: source.simultaneous !== false
  };
}

function normalizeParticipants(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const output = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i] || {};
    const name = String(raw.name ?? '').trim();
    if (!name) continue;
    const num = String(raw.num ?? '').trim() || String(output.length + 1);
    const key = `${num}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      id: raw.id,
      num,
      name: name.slice(0, 120),
      detail: String(raw.detail ?? '').trim().slice(0, 160),
      won: Boolean(raw.won)
    });
    if (output.length >= MAX_PARTICIPANTS) break;
  }
  return output;
}

function setBrandTextColor() {
  const color = brandTextColor(state.branding.brandColor);
  if (color) document.documentElement.style.setProperty('--brand-text', color);
}

/* ══════════════ carga inicial ══════════════ */

async function boot() {
  FX.init($('#fx'));
  bindUI();

  let me;
  try {
    me = await api('/auth/me', { redirectOn401: false });
  } catch (error) {
    if (error.status === 401) {
      location.replace('/login');
      return;
    }
    showFatalGate('No pudimos entrar a tu cuenta', 'El estudio no respondió. Revisa tu conexión e inténtalo de nuevo.');
    return;
  }

  state.user = me?.user || me || null;
  setSessionHint(true);

  let data = null;
  try {
    data = await api('/studio/state');
    applyState(data);
  } catch (error) {
    if (error.status === 401) {
      location.replace('/login');
      return;
    }
    if (error.code === 'LICENSE_INACTIVE') {
      applyFallbackState();
      showLicenseGate(error.payload?.license || state.user?.license || {});
      return;
    }
    applyFallbackState();
    showBanner(error);
  }

  initWheels();
  renderAll();
  switchView('sorteo');
  if (!data && !state.license) setSaveState('Sin conexión', 'err');
}

function applyFallbackState() {
  const user = state.user || {};
  state.branding = {
    displayName: user.companyName || '',
    logoPath: null,
    logoDataUrl: null,
    partners: [],
    brandColor: user.brandColor || '#E3B04B'
  };
  state.studio = {
    eventTitle: '',
    prize: 'Premio principal',
    round: 1,
    settings: { ...DEFAULT_SETTINGS }
  };
  state.participants = [];
  state.draws = [];
  state.license = user.license || null;
  applyBrandColor(state.branding.brandColor);
  setBrandTextColor();
}

/** Aplica el payload de GET /api/studio/state. */
function applyState(data, { keepDraft = true } = {}) {
  if (!data || typeof data !== 'object') return;
  const branding = data.branding || {};
  const hasDraft = keepDraft && (state.brandDirty.logo || state.brandDirty.partners);

  if (!hasDraft) {
    state.branding = {
      displayName: String(branding.displayName || ''),
      logoPath: branding.logoPath || null,
      logoDataUrl: null,
      partners: (Array.isArray(branding.partners) ? branding.partners : []).map((partner) => ({
        name: String(partner?.name || ''),
        path: partner?.path || null,
        dataUrl: null
      })),
      brandColor: /^#[0-9a-f]{6}$/i.test(branding.brandColor || '')
        ? branding.brandColor
        : state.user?.brandColor || '#E3B04B'
    };
    state.brandDirty = { logo: false, partners: false };
  } else if (/^#[0-9a-f]{6}$/i.test(branding.brandColor || '')) {
    state.branding.brandColor = branding.brandColor;
  }

  const studio = data.studio || {};
  state.studio = {
    eventTitle: String(studio.eventTitle || ''),
    prize: String(studio.prize || 'Premio principal'),
    round: Number(studio.round) || 1,
    settings: normalizeSettings(studio.settings)
  };
  state.participants = normalizeParticipants(data.participants);
  state.draws = Array.isArray(data.draws)
    ? data.draws.map((draw) => ({
        id: draw?.id,
        round: Number(draw?.round) || 1,
        prize: String(draw?.prize || 'Premio'),
        winners: (Array.isArray(draw?.winners) ? draw.winners : []).map((winner) => ({
          id: winner?.id,
          num: String(winner?.num ?? ''),
          name: String(winner?.name ?? ''),
          detail: String(winner?.detail ?? '')
        })),
        createdAt: draw?.createdAt || null
      }))
    : [];
  state.license = data.license || state.user?.license || null;

  // Los canvas leen --brand al construirse: fija el color antes de crearlos.
  applyBrandColor(state.branding.brandColor);
  setBrandTextColor();
}

function initWheels() {
  const previewCanvas = $('#wheelPreview');
  const stageCanvas = $('#wheelStage');
  if (previewCanvas) {
    wheelPreview = new Wheel(previewCanvas);
    wheelPreview.setItems(eligible().map(toItem));
  }
  if (stageCanvas) {
    wheelStage = new Wheel(stageCanvas, {
      onIndex(index) {
        if (!state.stageOpen) return;
        updateSpotlight(wheelStage.items[index] || null);
      }
    });
    wheelStage.setItems(eligible().map(toItem));
  }
}

/* ══════════════ render ══════════════ */

function renderAll() {
  applyBrandColor(state.branding.brandColor);
  setBrandTextColor();
  wheelPreview?.refreshColors();
  wheelStage?.refreshColors();
  renderBrand();
  renderUser();
  renderLicense();
  renderAppbar();
  hydrateSettings();
  renderParticipants();
  renderHistory();
  renderMarca();
  syncWheels();
  syncSoundButtons();
  sound.setEnabled(state.studio.settings.sounds);
}

function renderBrand() {
  const company = companyName();
  setText($('#railName'), company);
  setText($('#userCompany'), company);
  setText($('#stageCompany'), company);
  setText($('#stageEvent'), state.studio.eventTitle || 'Sorteo en vivo');
  document.title = `${company} · Sorteo Studio`;

  const source = logoSource();
  setLogo($('#railLogo'), source, company, 'rail');
  setLogo($('#stageLogo'), source, company, 'stage');
  setLogo($('#winnerBrand'), source, company, 'winner');
  if (state.view === 'marca') renderMarcaLogoOnly();
}

function renderUser() {
  const user = state.user || {};
  setText($('#userName'), user.username || 'Usuario');
  setText($('#userAvatar'), initials(user.username || companyName()).slice(0, 2));
  // El administrador necesita un camino visible a la consola de licencias.
  const adminLink = $('#btnAdmin');
  if (adminLink) adminLink.hidden = user.role !== 'admin';
}

function renderLicense() {
  const wrap = $('#licensePillWrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!state.license) {
    wrap.append(el('span', { class: 'pill pill--muted', text: 'Licencia' }));
    return;
  }
  const info = licensePill(state.license);
  wrap.append(el('span', { class: `pill ${info.cls}`, text: info.text }));
}

function renderAppbar() {
  setText($('#roundPill'), `Sorteo ${state.studio.round}`);
  setText($('#setupRound'), `Ronda ${state.studio.round}`);
}

function hydrateSettings() {
  const settings = state.studio.settings;
  setValue($('#inpEvent'), state.studio.eventTitle);
  setValue($('#inpPrize'), state.studio.prize);
  setValue($('#inpWinners'), settings.winners);
  setValue($('#inpTurns'), settings.turns);
  setValue($('#inpDuration'), settings.duration);
  setText($('#lblTurns'), String(settings.turns));
  setText($('#lblDuration'), `${settings.duration} s`);
  setText($('#previewTurns'), String(settings.turns));
  setText($('#hubTurns'), String(settings.turns));
  updateRangeFill($('#inpTurns'));
  updateRangeFill($('#inpDuration'));
  const removeWinners = $('#chkRemoveWinners');
  const sounds = $('#chkSounds');
  const confetti = $('#chkConfetti');
  const simultaneous = $('#chkSimultaneous');
  if (removeWinners) removeWinners.checked = settings.removeWinners;
  if (sounds) sounds.checked = settings.sounds;
  if (confetti) confetti.checked = settings.confetti;
  if (simultaneous) simultaneous.checked = settings.simultaneous;
}

function updateCounts() {
  const pool = eligible();
  setText($('#previewCount'), String(pool.length));
  setText($('#sumEligible'), String(pool.length));
  setText($('#sumWinners'), String(state.studio.settings.winners));
  setText($('#sumPrize'), prizeName());
  setText($('#partPill'), String(pool.length));
  setText($('#previewCount'), String(pool.length));
  const total = state.participants.length;
  const wonCount = total - pool.length;
  setText(
    $('#partCount'),
    total
      ? `${total} ${total === 1 ? 'persona' : 'personas'}${wonCount ? ` · ${wonCount} ya ${wonCount === 1 ? 'ganó' : 'ganaron'}` : ''}`
      : 'Aún sin participantes'
  );
  renderStageLabels();
  syncSpinButton();
}

function renderStageLabels() {
  setText($('#stagePrize'), prizeName());
  setText($('#stageRound'), `Sorteo ${state.studio.round}`);
  setText($('#stageEvent'), state.studio.eventTitle || 'Sorteo en vivo');
  setText($('#hubTurns'), String(state.studio.settings.turns));
}

function renderParticipants() {
  const list = state.participants;
  const body = $('#partBody');
  if (!body) return;
  body.innerHTML = '';
  for (let i = 0; i < list.length; i++) {
    const participant = list[i];
    body.insertAdjacentHTML(
      'beforeend',
      `<tr class="${participant.won ? 'is-won' : ''}">
        <td class="t-num num">${esc(participant.num)}</td>
        <td>${esc(participant.name)}${participant.won ? '<span class="won-tag">Ganó</span>' : ''}</td>
        <td class="muted">${esc(participant.detail || '—')}</td>
        <td class="t-del">
          <button class="row-del" type="button" data-remove="${i}" aria-label="Quitar a ${esc(participant.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
        </td>
      </tr>`
    );
  }
  const wrap = $('#partTableWrap');
  if (wrap) wrap.hidden = list.length === 0;
  const empty = $('#partEmpty');
  if (empty) empty.hidden = list.length > 0;
  updateCounts();
}

function renderHistory() {
  const list = state.draws;
  const container = $('#histList');
  if (!container) return;
  container.innerHTML = list
    .map((draw) => {
      const winners = (draw.winners || [])
        .map(
          (winner) =>
            `<li class="hist__winner"><b>N° ${esc(winner.num)}</b> ${esc(winner.name)}</li>`
        )
        .join('');
      return `<li class="hist-item">
        <div class="hist__round">Sorteo ${esc(String(draw.round))}<small>Ronda</small></div>
        <div>
          <p class="hist__prize">${esc(draw.prize)}</p>
          <ul class="hist__winners">${winners || '<li class="hist__winner">Sin ganadores registrados</li>'}</ul>
        </div>
        <time class="hist__date" datetime="${esc(draw.createdAt || '')}">${esc(fmtDateTime(draw.createdAt))}</time>
      </li>`;
    })
    .join('');
  container.hidden = list.length === 0;
  const empty = $('#histEmpty');
  if (empty) empty.hidden = list.length > 0;
  setText(
    $('#histHint'),
    list.length
      ? `${list.length} ${list.length === 1 ? 'ronda registrada' : 'rondas registradas'} · exporta el acta en CSV.`
      : 'Cada ronda queda registrada con su premio y sus ganadores.'
  );
}

function syncWheels() {
  const items = eligible().map(toItem);
  if (wheelPreview) wheelPreview.setItems(items);
  if (wheelStage && !state.spinning) wheelStage.setItems(items);
  updateCounts();
}

function renderMarca() {
  const branding = state.branding;
  renderMarcaLogoOnly();
  const nameInput = $('#inpDisplayName');
  setValue(nameInput, branding.displayName);
  const colorInput = $('#inpBrandColor');
  if (colorInput && /^#[0-9a-f]{6}$/i.test(branding.brandColor)) colorInput.value = branding.brandColor;
  setText($('#brandColorLabel'), branding.brandColor.toUpperCase());
  setText($('#partnerCount'), `${branding.partners.length} / ${MAX_PARTNERS}`);
  const removeButton = $('#btnRemoveLogo');
  if (removeButton) removeButton.disabled = !logoSource();
  renderPartners();
}

function renderMarcaLogoOnly() {
  const art = $('#logoSlotArt');
  if (!art) return;
  const source = logoSource();
  const company = companyName();
  if (source) {
    setLogo(art, source, company, 'slot');
    setText($('#logoSlotTitle'), company);
    setText($('#logoSlotHint'), 'Haz clic para reemplazar el logo.');
  } else {
    art.innerHTML = '';
    art.append(el('span', { class: 'monogram monogram--lg', 'aria-hidden': 'true', text: initials(company).charAt(0) || '?' }));
    setText($('#logoSlotTitle'), 'Sube el logo principal');
    setText($('#logoSlotHint'), 'PNG, JPG o WebP. Fondo transparente se ve mejor.');
  }
}

function renderPartners() {
  const grid = $('#partnerGrid');
  if (!grid) return;
  grid.innerHTML = '';
  state.branding.partners.forEach((partner, index) => {
    const source = partner.dataUrl || partner.path;
    const card = el('div', { class: 'partner' }, [
      source ? el('img', { src: source, alt: `Logo de ${partner.name || `marca participante ${index + 1}`}` }) : el('span', { class: 'hint', text: partner.name || 'Logo' }),
      el(
        'button',
        {
          class: 'partner__remove',
          type: 'button',
          'aria-label': `Quitar ${partner.name || `marca participante ${index + 1}`}`,
          onclick: () => removePartner(index)
        },
        [
          el('span', {
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'
          })
        ]
      )
    ]);
    grid.append(card);
  });
  if (state.branding.partners.length < MAX_PARTNERS) {
    const add = el('button', { class: 'partner partner--add', type: 'button', 'aria-label': 'Añadir logos de marcas participantes', onclick: () => $('#filePartners')?.click() }, [
      el('span', {
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
      }),
      el('span', { text: 'Añadir logo' })
    ]);
    grid.append(add);
  }
}

/* Logos con placa adaptativa: si el logo es claro, fondo oscuro y viceversa. */
function setLogo(container, source, name, variant) {
  if (!container) return;
  container.innerHTML = '';
  if (!source) {
    const monogram = el('span', {
      class: variant === 'rail' ? 'monogram' : 'monogram monogram--lg',
      'aria-hidden': 'true',
      text: initials(name).charAt(0) || '?'
    });
    container.append(monogram);
    return;
  }
  const hold = el('span', { class: 'logo-hold logo-hold--plate-light' });
  const img = el('img', { src: source, alt: `Logo de ${name}` });
  hold.append(img);
  container.append(hold);
  logoLuminance(source).then((lum) => {
    if (!hold.isConnected) return;
    hold.classList.toggle('logo-hold--plate-dark', lum >= 0.55);
    hold.classList.toggle('logo-hold--plate-light', lum < 0.55);
  });
}

function logoLuminance(source) {
  if (state.logoLum.has(source)) return Promise.resolve(state.logoLum.get(source));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        let sum = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 60) continue;
          sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          count++;
        }
        const lum = count ? sum / count : 0.5;
        state.logoLum.set(source, lum);
        resolve(lum);
      } catch {
        resolve(0.5);
      }
    };
    img.onerror = () => {
      state.logoLum.set(source, 0.5);
      resolve(0.5);
    };
    img.src = source;
  });
}

function updateSpotlight(item) {
  if (!item) {
    setText($('#spotNum'), 'N° —');
    setText($('#spotName'), 'Carga la lista para empezar');
    return;
  }
  setText($('#spotNum'), `N° ${item.num}`);
  setText($('#spotName'), item.name || '—');
}

/* ══════════════ vistas ══════════════ */

function switchView(name) {
  if (!VIEW_META[name]) return;
  state.view = name;
  $$('.rail-tab').forEach((tab) => {
    const active = tab.dataset.view === name;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  $$('.view').forEach((view) => {
    view.hidden = view.id !== `view-${name}`;
  });
  setText($('#viewTitle'), VIEW_META[name].title);
  setText($('#viewSub'), VIEW_META[name].sub);
  if (name === 'sorteo' && wheelPreview) requestAnimationFrame(() => wheelPreview.resize());
  if (name === 'marca') renderMarca();
  if (name === 'historial') renderHistory();
}

/* ══════════════ guardado ══════════════ */

function scheduleSettingsSave() {
  setSaveState('Guardando…');
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(saveSettings, 550);
}

async function saveSettings() {
  const settings = state.studio.settings;
  const prize = (state.studio.prize || '').trim() || 'Premio principal';
  try {
    const response = await api('/studio/settings', {
      method: 'PUT',
      body: {
        eventTitle: state.studio.eventTitle,
        prize,
        winners: settings.winners,
        turns: settings.turns,
        duration: settings.duration,
        removeWinners: settings.removeWinners,
        sounds: settings.sounds,
        confetti: settings.confetti,
        simultaneous: settings.simultaneous
      }
    });
    if (response?.studio) {
      state.studio = {
        ...state.studio,
        ...response.studio,
        settings: normalizeSettings(response.studio.settings)
      };
      if (!state.studio.prize.trim()) state.studio.prize = 'Premio principal';
      setValue($('#inpPrize'), state.studio.prize);
      setText($('#sumPrize'), prizeName());
      renderStageLabels();
      renderAppbar();
    }
    setSaveState('Guardado', 'ok');
  } catch (error) {
    setSaveState('Sin guardar', 'err');
    toast(error.message || 'No se pudieron guardar los ajustes del sorteo.', 'err');
  }
}

function scheduleParticipantsSave(delay = 550) {
  setSaveState('Guardando…');
  clearTimeout(saveParticipantsTimer);
  saveParticipantsTimer = setTimeout(saveParticipants, delay);
}

async function saveParticipants() {
  try {
    const payload = state.participants.map((p) => ({
      num: String(p.num),
      name: p.name,
      detail: p.detail || ''
    }));
    const response = await api('/studio/participants', {
      method: 'PUT',
      body: { participants: payload }
    });
    if (response && Array.isArray(response.participants)) {
      state.participants = normalizeParticipants(response.participants);
    }
    renderParticipants();
    syncWheels();
    setSaveState('Guardado', 'ok');
  } catch (error) {
    setSaveState('Sin guardar', 'err');
    toast(error.message || 'No se pudo guardar la lista de participantes.', 'err');
  }
}

async function saveBranding() {
  const button = $('#btnSaveBrand');
  if (button) button.disabled = true;
  setBrandSaveState('Guardando…');
  try {
    const body = {
      displayName: state.branding.displayName || '',
      brandColor: /^#[0-9a-f]{6}$/i.test(state.branding.brandColor) ? state.branding.brandColor : '#E3B04B'
    };
    if (state.brandDirty.logo) body.logoDataUrl = state.branding.logoDataUrl || null;
    if (state.brandDirty.partners) {
      const partners = [];
      for (const partner of state.branding.partners) {
        const entry = { name: partner.name || '' };
        if (partner.dataUrl) entry.dataUrl = partner.dataUrl;
        else if (partner.path) entry.path = partner.path;
        else continue;
        partners.push(entry);
      }
      body.partners = partners;
    }

    const response = await api('/studio/branding', { method: 'PUT', body });
    const branding = response?.branding;
    if (branding) {
      state.branding = {
        displayName: String(branding.displayName || state.branding.displayName),
        logoPath: branding.logoPath || null,
        logoDataUrl: null,
        partners: (Array.isArray(branding.partners) ? branding.partners : []).map((partner) => ({
          name: String(partner?.name || ''),
          path: partner?.path || null,
          dataUrl: null
        })),
        brandColor: /^#[0-9a-f]{6}$/i.test(branding.brandColor || '')
          ? branding.brandColor
          : state.branding.brandColor
      };
    }
    state.brandDirty = { logo: false, partners: false };
    renderAll();
    setBrandSaveState('Marca guardada', 'ok');
    toast('Marca guardada. Se ve así en el escenario.');
  } catch (error) {
    setBrandSaveState('Sin guardar', 'err');
    toast(error.message || 'No se pudo guardar la marca.', 'err');
  } finally {
    if (button) button.disabled = false;
  }
}

/* ══════════════ escenario ══════════════ */

function openStage() {
  const pool = eligible();
  if (!pool.length) {
    toast('Primero sube la lista: sin participantes no hay sorteo.', 'warn');
    switchView('participantes');
    return;
  }
  state.stageOpen = true;
  const stage = $('#stage');
  if (stage) stage.hidden = false;
  $('#app')?.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = 'hidden';
  if (wheelStage) {
    wheelStage.setItems(pool.map(toItem));
    wheelStage.resize();
    updateSpotlight(wheelStage.items[wheelStage.indexAtPointer()]);
  }
  renderStageLabels();
  syncSpinButton();
  sound.unlock();
  const spinButton = $('#btnSpin');
  if (spinButton) spinButton.focus({ preventScroll: true });
}

function closeStage() {
  if (state.spinning) return;
  state.stageOpen = false;
  const stage = $('#stage');
  if (stage) stage.hidden = true;
  $('#app')?.removeAttribute('aria-hidden');
  const overlay = $('#winnerOverlay');
  if (overlay) overlay.hidden = true;
  clearRevealTimers();
  FX.stop();
  FX.setFocus(false);
  document.body.style.overflow = '';
  wheelStage?.stop();
}

function syncSpinButton() {
  const pool = eligible();
  const button = $('#btnSpin');
  if (button) button.disabled = state.spinning || pool.length === 0;
  setText($('#spinLabel'), state.spinning ? 'Girando…' : 'Girar');
  const hint = $('#stageHint');
  if (!hint) return;
  if (!pool.length) {
    hint.textContent = 'No quedan participantes elegibles. Reinicia el sorteo desde Historial.';
  } else if (state.spinning) {
    hint.textContent = 'Sorteando…';
  } else {
    hint.innerHTML = '<kbd>Espacio</kbd> girar · <kbd>F</kbd> pantalla completa · <kbd>R</kbd> siguiente sorteo · <kbd>M</kbd> sonido';
  }
}

function resetSpinUI() {
  state.spinning = false;
  $('#wheelWrap')?.classList.remove('is-spinning');
  $('#spotlight')?.classList.remove('is-live');
  syncSpinButton();
}

function pulsePointer() {
  const pointer = $('#wheelPointer');
  if (!pointer) return;
  pointer.classList.remove('is-tick');
  void pointer.offsetWidth;
  pointer.classList.add('is-tick');
}

async function spin() {
  if (state.spinning || !state.stageOpen) return;
  const pool = eligible();
  if (!pool.length) {
    toast('No quedan participantes elegibles. Reinicia el sorteo desde Historial.', 'warn');
    return;
  }

  sound.unlock();
  state.spinning = true;
  $('#wheelWrap')?.classList.add('is-spinning');
  $('#spotlight')?.classList.add('is-live');
  syncSpinButton();

  let response = null;
  try {
    response = await api('/studio/draw', {
      method: 'POST',
      body: {
        count: state.studio.settings.winners,
        prize: prizeName()
      }
    });
  } catch (error) {
    resetSpinUI();
    if (error.code === 'CONFLICT') {
      toast('No quedan participantes elegibles. Reinicia el sorteo para empezar otra ronda.', 'warn');
    } else if (error.code === 'LICENSE_INACTIVE') {
      closeStage();
      showLicenseGate(error.payload?.license || state.license || {});
    } else {
      toast(error.message || 'No se pudo sortear. Inténtalo otra vez.', 'err');
    }
    return;
  }

  const winners = (Array.isArray(response?.winners) ? response.winners : []).filter(Boolean);
  if (!winners.length) {
    resetSpinUI();
    toast('El servidor no devolvió ganadores. Inténtalo otra vez.', 'err');
    return;
  }

  const drawRound = state.studio.round || 1;
  let currentPool = eligible();
  let targetIndex = currentPool.findIndex((participant) => sameParticipant(participant, winners[0]));

  if (targetIndex < 0 || !wheelStage) {
    await refreshState({ silent: true });
    currentPool = eligible();
    targetIndex = currentPool.findIndex((participant) => sameParticipant(participant, winners[0]));
    if (targetIndex < 0) targetIndex = 0;
    wheelStage?.setItems(currentPool.map(toItem));
  }
  if (wheelStage && wheelStage.items.length !== currentPool.length) {
    wheelStage.setItems(currentPool.map(toItem));
  }

  const settings = state.studio.settings;
  const turns = clamp(Number(settings.turns) || 8, 2, 40);
  const durationMs = clamp(Number(settings.duration) || 8, 3, 16) * 1000;

  if (settings.sounds) sound.drumRoll(durationMs / 1000);
  await wheelStage.spinToIndex(targetIndex, {
    turns,
    duration: durationMs,
    onTick: () => {
      pulsePointer();
      if (state.studio.settings.sounds) sound.tick();
    }
  });

  updateSpotlight(winners[0]);
  setText($('#spotName'), winners.map((winner) => winner.name).join(' · '));

  if (settings.sounds) sound.celebrate();
  if (settings.confetti) FX.burst(winners.length > 1 ? 1.35 : 1);

  state.studio.round = Number(response?.round) || drawRound;
  if (settings.removeWinners) {
    winners.forEach((winner) => {
      const participant = state.participants.find((item) => sameParticipant(item, winner));
      if (participant) participant.won = true;
    });
  }
  state.draws = [
    {
      round: drawRound,
      prize: prizeName(),
      winners: winners.map((winner) => ({
        id: winner?.id,
        num: String(winner?.num ?? ''),
        name: String(winner?.name ?? ''),
        detail: String(winner?.detail ?? '')
      })),
      createdAt: new Date().toISOString()
    },
    ...state.draws
  ];

  if (wheelPreview) wheelPreview.setItems(eligible().map(toItem));
  renderParticipants();
  renderHistory();
  renderAppbar();
  renderStageLabels();
  resetSpinUI();
  showWinners(winners);
}

function clearRevealTimers() {
  revealTimers.forEach((timer) => clearTimeout(timer));
  revealTimers = [];
}

function showWinners(winners) {
  const overlay = $('#winnerOverlay');
  const cards = $('#winnerCards');
  if (!overlay || !cards) return;
  cards.innerHTML = '';
  setText($('#winnerTitle'), winners.length > 1 ? `${winners.length} ganadores` : 'Tenemos ganador');
  setText($('#winnerPrize'), prizeName());
  setLogo($('#winnerBrand'), logoSource(), companyName(), 'winner');
  FX.setFocus(true);
  overlay.hidden = false;

  const reduced = prefersReducedMotion();
  const revealCard = (winner, delay) => {
    const card = el('div', { class: 'winner__card' }, [
      el('span', { class: 'winner__num', text: `N° ${winner.num}` }),
      el('span', { class: 'winner__name', text: winner.name }),
      winner.detail ? el('span', { class: 'winner__detail', text: winner.detail }) : null
    ]);
    if (!reduced && delay) card.style.animationDelay = `${delay}ms`;
    cards.append(card);
  };

  if (state.studio.settings.simultaneous || reduced || winners.length === 1) {
    winners.forEach((winner, index) => revealCard(winner, reduced ? 0 : index * 110));
  } else {
    revealCard(winners[0], 0);
    winners.slice(1).forEach((winner, index) => {
      const timer = setTimeout(() => {
        revealCard(winner, 0);
        if (state.studio.settings.sounds) sound.crash();
        if (state.studio.settings.confetti) FX.burst(0.5);
      }, (index + 1) * 1100);
      revealTimers.push(timer);
    });
  }

  $('#btnWinnerNext')?.focus({ preventScroll: true });
}

async function closeWinner() {
  clearRevealTimers();
  FX.stop();
  FX.setFocus(false);
  const overlay = $('#winnerOverlay');
  if (overlay) overlay.hidden = true;
  await refreshState({ silent: true });
  syncSpinButton();
}

async function nextDraw() {
  const hadOverlay = $('#winnerOverlay') && !$('#winnerOverlay').hidden;
  if (!hadOverlay) return;
  clearRevealTimers();
  FX.stop();
  FX.setFocus(false);
  const overlay = $('#winnerOverlay');
  if (overlay) overlay.hidden = true;
  await refreshState({ silent: true });
  syncSpinButton();
  if (eligible().length) {
    toast(`Sorteo ${state.studio.round} listo.`);
  } else {
    toast('No quedan participantes elegibles. Reinicia el sorteo desde Historial.', 'warn');
  }
}

async function refreshState({ silent = false } = {}) {
  try {
    const data = await api('/studio/state');
    applyState(data);
    renderAll();
  } catch (error) {
    if (error.code === 'LICENSE_INACTIVE') {
      closeStage?.();
      showLicenseGate(error.payload?.license || state.license || {});
      return;
    }
    if (!silent) toast(error.message || 'No pudimos actualizar el estudio.', 'err');
  }
}

/* ══════════════ sonido y pantalla completa ══════════════ */

function syncSoundButtons() {
  const enabled = state.studio.settings.sounds;
  ['#btnSoundToggle', '#btnStageSound'].forEach((selector) => {
    const button = $(selector);
    if (!button) return;
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', enabled ? 'Silenciar sonido' : 'Activar sonido');
    button.title = enabled ? 'Sonido (M)' : 'Sonido apagado (M)';
    button.classList.toggle('is-off', !enabled);
  });
  const checkbox = $('#chkSounds');
  if (checkbox) checkbox.checked = enabled;
}

function toggleSound() {
  const enabled = !state.studio.settings.sounds;
  state.studio.settings.sounds = enabled;
  sound.setEnabled(enabled);
  if (enabled) {
    sound.unlock();
    sound.tick();
  }
  syncSoundButtons();
  scheduleSettingsSave();
  toast(enabled ? 'Sonido activado' : 'Sonido en silencio');
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch {
    /* el navegador puede rechazarlo; el escenario sigue a pantalla completa */
  }
}

async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* la sesión se cierra igual */
  }
  setSessionHint(false);
  location.replace('/login');
}

/* ══════════════ participantes ══════════════ */

function parseDelimited(text) {
  const sample = String(text || '').split(/\r?\n/).find((line) => line.trim()) || '';
  const counts = {
    '\t': (sample.match(/\t/g) || []).length,
    ';': (sample.match(/;/g) || []).length,
    ',': (sample.match(/,/g) || []).length
  };
  const delimiter = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ',';
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
}

const RE_NUM = /(^|\b)(n[uú]mero|num|nro|no\.?|#|codigo|c[oó]digo|cedula|c[eé]dula|id|orden|participante\s*n)/i;
const RE_NAME = /(nombre|participante|name|apellido|persona|asistente|contador)/i;

function rowsToParticipants(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const clean = rows.map((row) => row.map((cell) => String(cell ?? '').trim())).filter((row) => row.some(Boolean));
  if (!clean.length) return [];

  const head = clean[0].map((cell) => cell.toLowerCase());
  const hasHeader =
    clean.length > 1 &&
    (head.some((cell) => RE_NUM.test(cell)) || head.some((cell) => RE_NAME.test(cell))) &&
    head.filter(Boolean).length >= 2 &&
    !/^\d+$/.test(head[0] || 'x');

  let numIndex = -1;
  let nameIndex = -1;
  let data = clean;

  if (hasHeader) {
    numIndex = head.findIndex((cell) => RE_NUM.test(cell));
    nameIndex = head.findIndex((cell) => RE_NAME.test(cell));
    data = clean.slice(1);
  } else if (/^\d+[a-zA-Z]?$/.test(clean[0][0] || '')) {
    numIndex = 0;
    nameIndex = 1;
  } else {
    nameIndex = 0;
  }
  if (nameIndex < 0) nameIndex = numIndex === 0 ? 1 : 0;

  const detailIndexes = clean[0]
    .map((_, index) => index)
    .filter((index) => index !== numIndex && index !== nameIndex);

  return data
    .map((row, index) => {
      const name = String(row[nameIndex] || '').trim();
      if (!name) return null;
      const num = numIndex >= 0 && String(row[numIndex] || '').trim() ? String(row[numIndex]).trim() : String(index + 1);
      const detail = detailIndexes
        .map((cellIndex) => String(row[cellIndex] || '').trim())
        .filter(Boolean)
        .join(' · ');
      return { num, name, detail };
    })
    .filter(Boolean);
}

let xlsxPromise = null;

function ensureXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxPromise) {
    xlsxPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/assets/xlsx.full.min.js';
      script.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('lector no disponible')));
      script.onerror = () => reject(new Error('no se pudo cargar el lector de Excel'));
      document.head.appendChild(script);
    });
  }
  return xlsxPromise;
}

async function readDataFile(file) {
  const extension = (file.name.split('.').pop() || '').toLowerCase();
  if (extension === 'xlsx' || extension === 'xls') {
    try {
      await ensureXLSX();
    } catch {
      throw new Error('No se pudo cargar el lector de Excel. Guarda el archivo como CSV.');
    }
    const buffer = await file.arrayBuffer();
    const workbook = window.XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    return rowsToParticipants(rows);
  }
  const text = await file.text();
  if (/\.json$/i.test(file.name)) {
    const parsed = JSON.parse(text);
    const array = Array.isArray(parsed) ? parsed : parsed.participantes || parsed.participants || [];
    return array.map((entry, index) =>
      typeof entry === 'string'
        ? { num: index + 1, name: entry, detail: '' }
        : {
            num: entry.numero ?? entry.num ?? entry.Numero ?? entry.number ?? index + 1,
            name: entry.nombre ?? entry.name ?? entry.Nombre ?? '',
            detail: entry.empresa ?? entry.cargo ?? entry.detalle ?? ''
          }
    );
  }
  return rowsToParticipants(parseDelimited(text));
}

async function ingestFile(file) {
  if (!file) return;
  try {
    const list = await readDataFile(file);
    if (!list.length) {
      toast('No encontramos nombres en el archivo. Revisa que la primera columna sea el nombre.', 'warn');
      return;
    }
    applyImportedList(list, `${Math.min(list.length, MAX_PARTICIPANTS)} participantes importados.`);
  } catch (error) {
    toast(error.message || 'No se pudo leer el archivo. Prueba con CSV.', 'err');
  }
}

function applyImportedList(list, message) {
  const normalized = normalizeParticipants(list);
  if (list.length > MAX_PARTICIPANTS) {
    toast(`La lista trae ${list.length} personas: guardamos las primeras ${MAX_PARTICIPANTS}.`, 'warn');
  }
  state.participants = normalized;
  state.draws = [];
  renderParticipants();
  syncWheels();
  renderHistory();
  scheduleParticipantsSave(0);
  if (message) toast(message);
}

function removeParticipant(index) {
  const participant = state.participants[index];
  if (!participant) return;
  state.participants.splice(index, 1);
  renderParticipants();
  syncWheels();
  scheduleParticipantsSave();
  toast(`Quitamos a ${participant.name}.`);
}

async function clearParticipants() {
  if (!state.participants.length) {
    toast('La lista ya está vacía.', 'warn');
    return;
  }
  const confirmed = await confirmDialog({
    title: '¿Borrar la lista?',
    message: 'Se quitan todos los participantes de la ruleta. El acta del historial se conserva.',
    confirmText: 'Borrar lista',
    danger: true
  });
  if (!confirmed) return;
  state.participants = [];
  renderParticipants();
  syncWheels();
  scheduleParticipantsSave(0);
  toast('Lista borrada. Puedes subir otra cuando quieras.');
}

function downloadBlob(content, filename, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { href: url, download: filename });
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadTemplateCsv() {
  const rows = [
    ['NUMERO', 'NOMBRE', 'EMPRESA', 'CARGO'],
    ['1', 'Ana Torres', 'Tu empresa', 'Contadora Senior'],
    ['2', 'Luis Mora', 'Tu empresa', 'Socio'],
    ['3', 'Carla Vega', 'Tu empresa', 'Auditora']
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadBlob(`\uFEFF${csv}`, 'plantilla-participantes.csv', 'text/csv;charset=utf-8');
  toast('Plantilla CSV descargada.');
}

async function downloadEventList() {
  try {
    const response = await fetch('/assets/lista-manta-2026.csv', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('sin archivo');
    const blob = await response.blob();
    downloadBlob(blob, 'lista-manta-2026.csv', 'text/csv;charset=utf-8');
    toast('Lista del evento descargada.');
  } catch {
    toast('La lista del evento todavía no está publicada. Sube tu Excel o usa la plantilla.', 'warn');
  }
}

const DEMO_NAMES = [
  'Ana Torres', 'Luis Mora', 'Carla Vega', 'José Andrade', 'María Pilco', 'Diego Ruiz',
  'Fernanda Ochoa', 'Carlos Cedeño', 'Andrea Salazar', 'Juan Chávez', 'Paula Guerrero', 'Marco Vinueza',
  'Sofía Espinoza', 'Ricardo León', 'Verónica Núñez', 'Esteban Ortiz', 'Daniela Paredes', 'Gabriel Suárez',
  'Patricia Ruiz', 'Andrés Villamar', 'Gabriela Tapia', 'Oscar Mendoza', 'Mónica Rojas', 'Javier Alvarado',
  'Rosa Quintero', 'Miguel Zambrano', 'Isabel Cabrera', 'Felipe Cordero', 'Camila Aguirre', 'Rodrigo Brito',
  'Elena Caicedo', 'Pablo Herrera', 'Silvia Maldonado', 'Hugo Ponce', 'Lorena Viteri', 'Byron Aguilar',
  'Victoria Sánchez', 'Wilson Cárdenas', 'Tatiana Bonilla', 'Alberto Murillo', 'Cristina Giler', 'Emilio Navas',
  'Natalia Arcos', 'Gustavo Vinueza', 'Paulina Rueda', 'Marco Yépez', 'Alejandra Pinto', 'Rubén Ortega',
  'Irene Cañizares', 'Vicente Romo', 'Diana Bedoya', 'Adrián Jaramillo', 'Karina Freire', 'Tomás Larrea',
  'Bárbara Saltos', 'Santiago Guerrero', 'Elisa Mora', 'Ramiro Cazar', 'Luz Almeida', 'Kevin Basantes'
];
const DEMO_COMPANIES = ['Cumbre', 'PuntoVenta', 'Sofi', 'Nexuss', 'Estudio Mora', 'UpConnect'];
const DEMO_ROLES = ['Contadora', 'Auditor', 'Socio', 'Analista', 'Gerente', 'Tesorero'];

function loadDemo() {
  const list = DEMO_NAMES.map((name, index) => ({
    num: String(index + 1),
    name,
    detail: `${DEMO_COMPANIES[index % DEMO_COMPANIES.length]} · ${DEMO_ROLES[(index * 3) % DEMO_ROLES.length]}`
  }));
  applyImportedList(list, '60 personas de ejemplo cargadas. La ruleta ya puede girar.');
}

/* ══════════════ marca: archivos ══════════════ */

function dataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  return Math.round((dataUrl.length - comma - 1) * 0.75);
}

function reencode(dataUrl, maxDimension) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function fitImage(dataUrl, maxBytes) {
  let result = dataUrl;
  let dimension = 480;
  while (dataUrlBytes(result) > maxBytes && dimension > 120) {
    dimension = Math.round(dimension * 0.78);
    result = await reencode(result, dimension);
  }
  return result;
}

function isAllowedImage(file) {
  return /^image\/(png|jpe?g|webp)$/i.test(file.type || '') || /\.(png|jpe?g|webp)$/i.test(file.name || '');
}

async function handleMainLogo(file) {
  if (!file) return;
  if (!isAllowedImage(file)) {
    toast('Usa un logo PNG, JPG o WebP.', 'warn');
    return;
  }
  try {
    const original = await fileToDataUrl(file, 480);
    const dataUrl = await fitImage(original, 380 * 1024);
    state.branding.logoDataUrl = dataUrl;
    state.brandDirty.logo = true;
    const color = await extractDominantColor(dataUrl);
    if (color && /^#[0-9a-f]{6}$/i.test(color)) {
      state.branding.brandColor = color;
      applyBrandColor(color);
      setBrandTextColor();
      wheelPreview?.refreshColors();
      wheelStage?.refreshColors();
    }
    renderBrand();
    renderMarca();
    setBrandSaveState('Logo listo. Guarda la marca.');
  } catch {
    toast('No se pudo procesar la imagen. Prueba con otro archivo.', 'err');
  }
}

async function handlePartnerFiles(files) {
  const list = Array.from(files || []).filter(isAllowedImage);
  if (!list.length) {
    toast('Usa logos PNG, JPG o WebP.', 'warn');
    return;
  }
  let added = 0;
  for (const file of list) {
    if (state.branding.partners.length >= MAX_PARTNERS) {
      toast(`Máximo ${MAX_PARTNERS} marcas participantes.`, 'warn');
      break;
    }
    try {
      const original = await fileToDataUrl(file, 320);
      const dataUrl = await fitImage(original, 300 * 1024);
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 48);
      state.branding.partners.push({ name, path: null, dataUrl });
      added++;
    } catch {
      /* se salta el archivo que no se pueda leer */
    }
  }
  if (!added) {
    toast('No se pudo agregar ningún logo.', 'warn');
    return;
  }
  state.brandDirty.partners = true;
  renderMarca();
  setBrandSaveState('Logos listos. Guarda la marca.');
}

function removePartner(index) {
  state.branding.partners.splice(index, 1);
  state.brandDirty.partners = true;
  renderMarca();
  setBrandSaveState('Cambios sin guardar.');
}

/* ══════════════ estados de error / licencia ══════════════ */

function showBanner(error) {
  const banner = $('#loadBanner');
  if (!banner) return;
  banner.hidden = false;
  banner.innerHTML = '';
  banner.append(
    el('span', { class: 'grow', text: error?.message || 'No pudimos cargar tu estudio. Revisa la conexión e inténtalo otra vez.' }),
    el('button', { class: 'btn btn--sm', type: 'button', text: 'Reintentar', onclick: () => location.reload() })
  );
}

function showLicenseGate(license) {
  const app = $('#app');
  if (app) app.setAttribute('aria-hidden', 'true');
  const info = licensePill(license || {});
  const status = license?.status || 'pending';
  const expiry = license?.expiresAt ? fmtDate(license.expiresAt) : null;

  let text = 'La cuenta está suspendida o la licencia no está activa. Escríbele a tu asesor para revisar el estado.';
  if (status === 'pending') {
    text = 'El pago de tu licencia está pendiente de confirmación. En cuanto se acredite, esta pantalla se desbloquea sola.';
  } else if (status === 'expired') {
    text = `La licencia venció${expiry ? ` el ${expiry}` : ''}. Renueva con tu asesor para volver a abrir el estudio.`;
  } else if (status === 'revoked') {
    text = 'La licencia fue revocada. Habla con tu asesor para revisar el estado de tu cuenta.';
  }

  const gate = el('div', { class: 'gate', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gateTitle' }, [
    el('div', { class: 'gate__card' }, [
      el('span', { class: 'gate__mark', 'aria-hidden': 'true', text: 'S' }),
      el('div', { class: 'col', style: 'gap:6px' }, [
        el('p', { class: 'eyebrow', text: 'Licencia' }),
        el('h2', { class: 'gate__title', id: 'gateTitle', text: 'Tu licencia no está activa' })
      ]),
      el('p', { class: 'gate__text', text }),
      el('div', { class: 'gate__meta' }, [
        el('span', { class: `pill ${info.cls}`, text: info.text }),
        license?.plan ? el('span', { text: `Plan ${license.plan}` }) : null,
        expiry ? el('span', { text: `Vence ${expiry}` }) : null
      ]),
      el('p', { class: 'gate__text' }, [
        'La marca y la lista de ',
        el('strong', { text: companyName() }),
        ' siguen guardadas. Nada se pierde.'
      ]),
      el('div', { class: 'gate__actions' }, [
        el('button', { class: 'btn btn--primary', type: 'button', text: 'Volver a intentar', onclick: () => location.reload() }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'Salir', onclick: () => logout() })
      ])
    ])
  ]);
  document.body.appendChild(gate);
  gate.querySelector('button')?.focus();
}

function showFatalGate(title, message) {
  const app = $('#app');
  if (app) app.setAttribute('aria-hidden', 'true');
  const gate = el('div', { class: 'gate', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fatalTitle' }, [
    el('div', { class: 'gate__card' }, [
      el('span', { class: 'gate__mark', 'aria-hidden': 'true', text: 'S' }),
      el('div', { class: 'col', style: 'gap:6px' }, [
        el('p', { class: 'eyebrow', text: 'Sin conexión' }),
        el('h2', { class: 'gate__title', id: 'fatalTitle', text: title })
      ]),
      el('p', { class: 'gate__text', text: message }),
      el('div', { class: 'gate__actions' }, [
        el('button', { class: 'btn btn--primary', type: 'button', text: 'Reintentar', onclick: () => location.reload() }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'Volver al acceso', onclick: () => location.replace('/login') })
      ])
    ])
  ]);
  document.body.appendChild(gate);
  gate.querySelector('button')?.focus();
}

/* ══════════════ eventos ══════════════ */

function bindUI() {
  if (bound) return;
  bound = true;

  $$('.rail-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  $('.rail__nav')?.addEventListener('keydown', (event) => {
    const tabs = $$('.rail-tab');
    const current = tabs.findIndex((tab) => tab.dataset.view === state.view);
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const target = tabs[next];
    switchView(target.dataset.view);
    target.focus();
  });

  $('#btnLogout')?.addEventListener('click', logout);
  $('#btnOpenStage')?.addEventListener('click', openStage);
  $('#btnOpenStageTop')?.addEventListener('click', openStage);
  $('#btnStageExit')?.addEventListener('click', closeStage);
  $('#btnStageFull')?.addEventListener('click', toggleFullscreen);
  $('#btnStageSound')?.addEventListener('click', toggleSound);
  $('#btnSoundToggle')?.addEventListener('click', toggleSound);
  $('#btnSpin')?.addEventListener('click', spin);
  $('#btnWinnerClose')?.addEventListener('click', closeWinner);
  $('#btnWinnerNext')?.addEventListener('click', nextDraw);
  $('#btnExportCsv')?.addEventListener('click', () => toast('Exportando el acta en CSV…'));

  /* Ajustes del sorteo */
  $('#inpEvent')?.addEventListener('input', (event) => {
    state.studio.eventTitle = event.target.value;
    renderStageLabels();
    scheduleSettingsSave();
  });
  $('#inpPrize')?.addEventListener('input', (event) => {
    state.studio.prize = event.target.value;
    renderStageLabels();
    updateCounts();
    scheduleSettingsSave();
  });

  const winnersInput = $('#inpWinners');
  const stepper = winnersInput?.closest('.stepper');
  const setWinners = (value) => {
    const next = clamp(Math.round(Number(value) || 1), 1, 12);
    state.studio.settings.winners = next;
    setValue(winnersInput, next);
    updateCounts();
    scheduleSettingsSave();
  };
  stepper?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-step]');
    if (!button) return;
    setWinners((Number(winnersInput.value) || 1) + Number(button.dataset.step));
  });
  winnersInput?.addEventListener('change', () => setWinners(winnersInput.value));

  $('#inpTurns')?.addEventListener('input', (event) => {
    const value = clamp(Number(event.target.value) || 8, 2, 40);
    state.studio.settings.turns = value;
    setText($('#lblTurns'), String(value));
    setText($('#previewTurns'), String(value));
    setText($('#hubTurns'), String(value));
    updateRangeFill(event.target);
    scheduleSettingsSave();
  });

  $('#inpDuration')?.addEventListener('input', (event) => {
    const value = clamp(Number(event.target.value) || 8, 3, 16);
    state.studio.settings.duration = value;
    setText($('#lblDuration'), `${value} s`);
    updateRangeFill(event.target);
    scheduleSettingsSave();
  });

  $('#chkRemoveWinners')?.addEventListener('change', (event) => {
    state.studio.settings.removeWinners = event.target.checked;
    scheduleSettingsSave();
    toast(event.target.checked ? 'Los ganadores no vuelven a salir.' : 'Los ganadores pueden volver a salir.');
  });
  $('#chkSounds')?.addEventListener('change', (event) => {
    state.studio.settings.sounds = event.target.checked;
    if (event.target.checked) {
      sound.unlock();
      sound.tick();
    }
    sound.setEnabled(event.target.checked);
    syncSoundButtons();
    scheduleSettingsSave();
  });
  $('#chkConfetti')?.addEventListener('change', (event) => {
    state.studio.settings.confetti = event.target.checked;
    scheduleSettingsSave();
  });
  $('#chkSimultaneous')?.addEventListener('change', (event) => {
    state.studio.settings.simultaneous = event.target.checked;
    scheduleSettingsSave();
  });

  /* Participantes */
  const dropzone = $('#dropzone');
  const fileData = $('#fileData');
  const openFilePicker = () => fileData?.click();
  dropzone?.addEventListener('click', openFilePicker);
  dropzone?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openFilePicker();
    }
  });
  ['dragenter', 'dragover'].forEach((type) => {
    dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    dropzone?.addEventListener(type, () => dropzone.classList.remove('is-over'));
  });
  dropzone?.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) ingestFile(file);
  });
  fileData?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) ingestFile(file);
  });

  $('#btnTemplateCsv')?.addEventListener('click', downloadTemplateCsv);
  $('#btnEventList')?.addEventListener('click', downloadEventList);
  $('#btnDemo')?.addEventListener('click', loadDemo);
  $('#btnClearParticipants')?.addEventListener('click', clearParticipants);

  const pasteWrap = $('#pasteWrap');
  $('#btnPaste')?.addEventListener('click', () => {
    if (!pasteWrap) return;
    pasteWrap.hidden = !pasteWrap.hidden;
    $('#btnPaste')?.setAttribute('aria-expanded', String(!pasteWrap.hidden));
    if (!pasteWrap.hidden) $('#inpPaste')?.focus();
  });
  $('#btnPasteCancel')?.addEventListener('click', () => {
    if (!pasteWrap) return;
    pasteWrap.hidden = true;
    $('#btnPaste')?.setAttribute('aria-expanded', 'false');
  });
  $('#btnPasteApply')?.addEventListener('click', () => {
    const rows = parseDelimited($('#inpPaste')?.value || '');
    const list = rowsToParticipants(rows);
    if (!list.length) {
      toast('No detectamos nombres. Escribe una persona por línea.', 'warn');
      return;
    }
    applyImportedList(list, `${Math.min(list.length, MAX_PARTICIPANTS)} participantes cargados.`);
    if (pasteWrap) pasteWrap.hidden = true;
    $('#btnPaste')?.setAttribute('aria-expanded', 'false');
  });

  $('#partBody')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    removeParticipant(Number(button.dataset.remove));
  });

  /* Marca */
  const logoSlot = $('#logoSlot');
  const fileLogo = $('#fileLogo');
  logoSlot?.addEventListener('click', () => fileLogo?.click());
  logoSlot?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileLogo?.click();
    }
  });
  ['dragenter', 'dragover'].forEach((type) => {
    logoSlot?.addEventListener(type, (event) => {
      event.preventDefault();
      logoSlot.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    logoSlot?.addEventListener(type, () => logoSlot.classList.remove('is-over'));
  });
  logoSlot?.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) handleMainLogo(file);
  });
  fileLogo?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) handleMainLogo(file);
  });
  $('#btnRemoveLogo')?.addEventListener('click', () => {
    state.branding.logoDataUrl = null;
    state.branding.logoPath = null;
    state.brandDirty.logo = true;
    renderBrand();
    renderMarca();
    setBrandSaveState('Logo quitado. Guarda la marca.');
  });

  $('#inpDisplayName')?.addEventListener('input', (event) => {
    state.branding.displayName = event.target.value;
    renderBrand();
    setBrandSaveState('Cambios sin guardar.');
  });
  $('#inpBrandColor')?.addEventListener('input', (event) => {
    const value = event.target.value;
    if (!/^#[0-9a-f]{6}$/i.test(value)) return;
    state.branding.brandColor = value;
    applyBrandColor(value);
    setBrandTextColor();
    setText($('#brandColorLabel'), value.toUpperCase());
    wheelPreview?.refreshColors();
    wheelStage?.refreshColors();
    renderBrand();
    setBrandSaveState('Cambios sin guardar.');
  });

  $('#btnAddPartner')?.addEventListener('click', () => $('#filePartners')?.click());
  $('#filePartners')?.addEventListener('change', (event) => {
    const files = event.target.files;
    event.target.value = '';
    if (files && files.length) handlePartnerFiles(files);
  });
  $('#btnSaveBrand')?.addEventListener('click', saveBranding);

  /* Historial */
  $('#btnResetDraw')?.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: '¿Reiniciar el sorteo?',
      message: 'Se borran las rondas y los ganadores marcados. La lista de participantes se mantiene.',
      confirmText: 'Reiniciar sorteo',
      danger: true
    });
    if (!confirmed) return;
    try {
      await api('/studio/reset', { method: 'POST', body: { keepParticipants: true } });
      await refreshState({ silent: true });
      toast('Sorteo reiniciado. Los participantes siguen en la lista.');
    } catch (error) {
      toast(error.message || 'No se pudo reiniciar el sorteo.', 'err');
    }
  });

  document.addEventListener('keydown', onGlobalKeydown);
}

function onGlobalKeydown(event) {
  const target = event.target;
  const typing =
    target &&
    (target.matches?.('input, textarea, select') || target.isContentEditable);
  if (typing) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;

  const overlay = $('#winnerOverlay');
  const overlayOpen = overlay && !overlay.hidden;

  if (event.code === 'Space' || event.key === ' ') {
    if (!state.stageOpen) return;
    event.preventDefault();
    if (!overlayOpen) spin();
    return;
  }
  if (event.key === 'Escape') {
    if (overlayOpen) {
      event.preventDefault();
      closeWinner();
    } else if (state.stageOpen) {
      event.preventDefault();
      closeStage();
    }
    return;
  }
  if (!state.stageOpen) return;
  const key = String(event.key || '').toLowerCase();
  if (key === 'f') {
    event.preventDefault();
    toggleFullscreen();
  } else if (key === 'r') {
    if (overlayOpen) {
      event.preventDefault();
      nextDraw();
    }
  } else if (key === 'm') {
    event.preventDefault();
    toggleSound();
  }
}

window.addEventListener('pagehide', () => {
  wheelPreview?.destroy();
  wheelStage?.destroy();
  FX.stop();
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
