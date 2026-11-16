/* ═══════════════════════════════════════════════════════════════════════
   Sorteo Studio — consola de licencias (/admin)
   Cuentas a mano, pagos por transferencia, renovaciones, revocaciones y bitácora.
   Depende de /js/api.js (api, toast, el, money, fmtDate, fmtDateTime, daysLeft,
   licensePill, confirmDialog, initials, debounce).
   ═══════════════════════════════════════════════════════════════════════ */

import {
  api, toast, el, money, fmtDate, fmtDateTime, daysLeft,
  licensePill, confirmDialog, initials, debounce, brandInk, brandText
} from './api.js';

const PLAN_LABEL = { mensual: 'Mensual', trimestral: 'Trimestral', anual: 'Anual', evento: 'Evento' };
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ── Nodos ── */
const dom = {
  userName: document.getElementById('userName'),
  userEmail: document.getElementById('userEmail'),
  logoutBtn: document.getElementById('logoutBtn'),
  newAccountBtn: document.getElementById('newAccountBtn'),
  kpiGrid: document.getElementById('kpiGrid'),
  accountsCount: document.getElementById('accountsCount'),
  search: document.getElementById('search'),
  tableRegion: document.getElementById('tableRegion'),
  auditList: document.getElementById('auditList'),
  auditRefresh: document.getElementById('auditRefresh'),
  footStamp: document.getElementById('footStamp'),
  backupsList: document.getElementById('backupsList'),
  backupsMeta: document.getElementById('backupsMeta'),
  backupCreate: document.getElementById('backupCreate'),
  backupVerify: document.getElementById('backupVerify'),
  integrityStatus: document.getElementById('integrityStatus'),

  drawer: document.getElementById('accountDrawer'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
  drawerTitle: document.getElementById('drawerTitle'),
  drawerSub: document.getElementById('drawerSub'),
  drawerClose: document.getElementById('drawerClose'),
  drawerCancel: document.getElementById('drawerCancel'),
  drawerSubmit: document.getElementById('drawerSubmit'),
  form: document.getElementById('accountForm'),

  company: document.getElementById('company'),
  contact: document.getElementById('contact'),
  email: document.getElementById('email'),
  username: document.getElementById('username'),
  passwordField: document.getElementById('passwordField'),
  password: document.getElementById('password'),
  pwdRegen: document.getElementById('pwdRegen'),
  pwdCopy: document.getElementById('pwdCopy'),
  plan: document.getElementById('plan'),
  expires: document.getElementById('expires'),
  amount: document.getElementById('amount'),
  notes: document.getElementById('notes'),
  activate: document.getElementById('activate'),
  activateField: document.getElementById('activateField'),

  errCompany: document.getElementById('err-company'),
  errEmail: document.getElementById('err-email'),
  errUsername: document.getElementById('err-username'),
  errPassword: document.getElementById('err-password'),
  errExpires: document.getElementById('err-expires'),
  errAmount: document.getElementById('err-amount')
};

/* ── Estado ── */
const state = {
  me: null,
  overview: null,
  accounts: [],
  audit: [],
  q: '',
  accountsReady: false,
  tableFloor: 0,
  editing: null,
  usernameTouched: false,
  busy: false,
  menu: null,
  drawerReturn: null,
  modalReturn: null,
  backups: [],
  backupsReady: false,
  backupsBusy: false,
  integrityBusy: false
};

/* ── Utilidades ── */

/** Traduce un error del API a una frase que se le puede decir a una persona. */
function humanError(err) {
  const code = err?.code || '';
  switch (code) {
    case 'CONFLICT': return 'Ya existe una cuenta con ese usuario o correo.';
    case 'NOT_FOUND': return 'Esa cuenta ya no existe. Actualiza la lista.';
    case 'RATE_LIMITED': return 'Demasiados intentos seguidos. Espera unos minutos.';
    case 'FORBIDDEN': return 'Tu usuario no tiene permisos de administrador.';
    case 'UNAUTHORIZED': return 'Tu sesión expiró. Vuelve a entrar.';
    case 'LICENSE_INACTIVE': return 'La licencia de esa cuenta está inactiva.';
    case 'BAD_REQUEST': return err?.message || 'Revisa los datos: hay algo que el servidor no acepta.';
    default: return err?.message || 'No hay conexión con el servidor. Revisa tu red e intenta de nuevo.';
  }
}
function toastErr(err) { toast(humanError(err), 'err'); }

/** confirmDialog que devuelve el foco a donde estaba antes de abrirse. */
async function askConfirm(options) {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const answer = await confirmDialog(options);
  if (previous && document.contains(previous)) {
    try { previous.focus({ preventScroll: true }); } catch { /* sin foco */ }
  }
  return answer;
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* probamos el fallback */ }
  try {
    const ta = el('textarea', { class: 'sr-only', readonly: true });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
async function copyAndToast(text, okMsg) {
  if (await copyText(text)) toast(okMsg);
  else toast('No se pudo copiar. Selecciona el texto a mano.', 'warn');
}

function randInt(max) {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0] % max;
  }
  return Math.floor(Math.random() * max);
}

/** Contraseña legible de 14 caracteres, sin letras que se confunden (l, I, O, 0, 1). */
function genPassword(len = 14) {
  const sets = ['abcdefghjkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%&*+-?'];
  const all = sets.join('');
  const out = sets.map((s) => s[randInt(s.length)]);
  while (out.length < len) out.push(all[randInt(all.length)]);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

function suggestUsername(company) {
  const base = String(company || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/[._-]{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 32);
  if (base.length >= 3) return base;
  const padded = (base + '.sorteo').replace(/[._-]{2,}/g, '.').slice(0, 32);
  return USERNAME_RE.test(padded) ? padded : '';
}

function planLabel(plan) { return PLAN_LABEL[plan] || (plan ? String(plan) : '—'); }

function isoDay(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function addDaysIso(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

/** Pinta un monograma con el color de marca de la empresa usando tokens. */
function paintBrand(node, hex) {
  if (!/^#[0-9a-f]{6}$/i.test(String(hex || ''))) return;
  node.style.setProperty('--brand', hex);
  // La tinta se elige por contraste real (AA), no por un umbral a ojo:
  // con teal (#1FA37A) el blanco daba 3.19:1 y el casi-negro da 5.96:1.
  node.style.setProperty('--brand-ink', brandInk(hex));
  node.style.setProperty('--brand-text', brandText(hex));
}

function setBusy(node, busy) {
  if (!node) return;
  node.classList.toggle('is-busy', busy);
  node.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/* ═══════════════════════════ KPIs ═══════════════════════════ */

function kpiTile({ label, value, meta, accent }) {
  return el('article', { class: `adm-kpi${accent ? ` adm-kpi--${accent}` : ''}` }, [
    el('p', { class: 'adm-kpi__label', text: label }),
    el('p', { class: 'adm-kpi__num num', text: String(value) }),
    el('p', { class: 'adm-kpi__meta', text: meta })
  ]);
}

function renderOverview() {
  const source = state.overview || {};
  const total = Number(source.totalAccounts || 0);
  const active = Number(source.active || 0);
  const pending = Number(source.pending || 0);
  const expiringSoon = Number(source.expiringSoon || 0);
  const revenueCents = Number(source.revenueCents || 0);
  dom.kpiGrid.replaceChildren(
    kpiTile({
      label: 'Cuentas',
      value: total,
      meta: `${active} ${active === 1 ? 'activa' : 'activas'}`,
      accent: 'brand'
    }),
    kpiTile({
      label: 'Pago pendiente',
      value: pending,
      meta: 'esperan confirmar la transferencia',
      accent: 'warn'
    }),
    kpiTile({
      label: 'Por vencer',
      value: expiringSoon,
      meta: 'en 7 días o menos',
      accent: 'warn'
    }),
    kpiTile({
      label: 'Ingresos cobrados',
      value: money(revenueCents),
      meta: 'pagos confirmados, acumulado',
      accent: 'ok'
    })
  );
  dom.kpiGrid.setAttribute('aria-busy', 'false');
}

function renderOverviewError(err) {
  dom.kpiGrid.replaceChildren(
    el('div', { class: 'adm-kpi adm-kpi--warn adm-kpi--wide' }, [
      el('p', { class: 'adm-kpi__label', text: 'Resumen no disponible' }),
      el('p', { class: 'adm-kpi__meta', text: humanError(err) }),
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', text: 'Reintentar',
        onclick: () => loadOverview()
      })
    ])
  );
  dom.kpiGrid.setAttribute('aria-busy', 'false');
}

async function loadOverview() {
  try {
    const data = await api('/admin/overview');
    state.overview = data || null;
    renderOverview();
  } catch (err) {
    if (state.overview) toastErr(err);
    else renderOverviewError(err);
  }
}

/* ═══════════════════════════ Tabla de cuentas ═══════════════════════════ */

function companyCell(account) {
  const logo = el('span', { class: 'adm-logo', 'aria-hidden': 'true', text: initials(account.companyName) });
  paintBrand(logo, account.brandColor);

  const name = el('span', { class: 'adm-company__name', title: account.companyName || '', text: account.companyName || 'Sin nombre' });
  if (account.role === 'admin') name.appendChild(el('span', { class: 'adm-tag', text: 'Admin' }));

  return el('div', { class: 'adm-company' }, [
    logo,
    el('span', { class: 'adm-company__body' }, [
      name,
      el('span', { class: 'adm-company__sub', text: account.contactName || 'Sin contacto' })
    ])
  ]);
}

function accessCell(account) {
  const copy = el('button', {
    class: 'btn btn--ghost btn--sm adm-copy',
    type: 'button',
    text: 'Copiar',
    'aria-label': `Copiar acceso de ${account.companyName}`,
    onclick: () => copyAndToast(
      `Usuario: ${account.username}\nCorreo: ${account.email}`,
      'Acceso copiado.'
    )
  });
  return el('div', { class: 'adm-access' }, [
    el('div', { class: 'adm-access__top' }, [
      el('span', { class: 'adm-access__user mono', text: account.username || '—' }),
      copy
    ]),
    el('span', { class: 'adm-access__mail', title: account.email || '', text: account.email || 'Sin correo' })
  ]);
}

function planCell(account) {
  const lic = account.license || {};
  const amount = Number(lic.amountCents || 0);
  return el('div', { class: 'adm-plan' }, [
    el('span', { class: 'adm-plan__name', text: planLabel(lic.plan) }),
    el('span', { class: 'adm-plan__amount num', text: amount > 0 ? money(amount) : 'Sin monto' })
  ]);
}

function estadoCell(account, pill) {
  const pills = el('div', { class: 'adm-pills' }, [
    el('span', { class: `pill ${pill.cls}`, text: pill.text })
  ]);
  if (account.status === 'suspended') {
    pills.appendChild(el('span', { class: 'pill pill--muted', text: 'Cuenta suspendida' }));
  }
  return pills;
}

function venceCell(license, left) {
  const hasDate = Boolean(license.expiresAt);
  const revoked = license.status === 'revoked';
  const main = el('span', {
    class: 'adm-date__main num',
    text: hasDate ? fmtDate(license.expiresAt) : 'Sin vencimiento'
  });

  let subText = 'No expira';
  let subClass = 'adm-date__sub';
  if (revoked) {
    subText = 'Licencia revocada';
  } else if (hasDate) {
    if (left === null) subText = 'Sin vencimiento';
    else if (left < 0) { subText = `Venció hace ${Math.abs(left)} d`; subClass += ' is-late'; }
    else if (left === 0) { subText = 'Vence hoy'; subClass += ' is-soon'; }
    else { subText = `${left} d restantes`; if (left <= 7) subClass += ' is-soon'; }
  }

  return el('div', { class: 'adm-date' }, [
    main,
    el('span', { class: subClass, text: subText })
  ]);
}

function usoCell(account) {
  const n = Number(account.participants || 0);
  return el('span', {
    class: `adm-use num${n ? '' : ' adm-use--zero'}`,
    text: n ? String(n) : '—',
    title: n === 1 ? '1 participante cargado' : `${n} participantes cargados`
  });
}

function actionsButton(account) {
  const btn = el('button', {
    class: 'btn btn--sm adm-actions-btn',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': `Acciones para ${account.companyName}`,
    dataset: { action: 'menu', accountId: String(account.id) }
  }, ['Acciones', el('span', { class: 'adm-caret', 'aria-hidden': 'true', text: '▾' })]);
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu(account, btn);
  });
  return btn;
}

function buildRow(account) {
  const license = account.license || {};
  const pill = licensePill(license);
  return el('tr', { dataset: { accountId: String(account.id) } }, [
    el('td', { 'data-label': 'Empresa' }, [companyCell(account)]),
    el('td', { 'data-label': 'Acceso' }, [accessCell(account)]),
    el('td', { 'data-label': 'Plan' }, [planCell(account)]),
    el('td', { 'data-label': 'Estado' }, [estadoCell(account, pill)]),
    el('td', { 'data-label': 'Vence' }, [venceCell(license, daysLeft(license.expiresAt))]),
    el('td', { 'data-label': 'Uso', class: 't-right' }, [usoCell(account)]),
    el('td', { 'data-label': 'Acciones', class: 't-actions' }, [actionsButton(account)])
  ]);
}

function buildTable(accounts) {
  const table = el('table', { class: 'table adm-table' }, [
    el('caption', { class: 'sr-only', text: 'Cuentas con licencia' }),
    el('thead', {}, el('tr', {}, [
      el('th', { scope: 'col', text: 'Empresa' }),
      el('th', { scope: 'col', text: 'Acceso' }),
      el('th', { scope: 'col', text: 'Plan' }),
      el('th', { scope: 'col', text: 'Estado' }),
      el('th', { scope: 'col', text: 'Vence' }),
      el('th', { scope: 'col', class: 't-right', text: 'Uso' }),
      el('th', { scope: 'col', class: 't-actions', text: 'Acciones' })
    ])),
    el('tbody', {}, accounts.map(buildRow))
  ]);
  return el('div', { class: 'table-wrap' }, table);
}

function clearSearch() {
  dom.search.value = '';
  if (state.q !== '') {
    state.q = '';
    loadAccounts('');
  } else {
    dom.search.focus();
  }
}

function buildEmptyState() {
  if (state.q) {
    return el('div', { class: 'empty' }, [
      el('strong', { text: 'Sin coincidencias' }),
      el('p', { text: `Ninguna empresa coincide con «${state.q}». Cambia la palabra o limpia la búsqueda.` }),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Limpiar búsqueda', onclick: clearSearch })
    ]);
  }
  return el('div', { class: 'empty' }, [
    el('strong', { text: 'Todavía no hay cuentas' }),
    el('p', { text: 'Crea la primera desde «Nueva cuenta»: la licencia y el usuario se generan en el mismo paso.' }),
    el('button', {
      class: 'btn btn--primary btn--sm', type: 'button', text: 'Nueva cuenta',
      onclick: () => openDrawer(null)
    })
  ]);
}

function renderAccounts() {
  const list = state.accounts;
  dom.accountsCount.textContent = state.q
    ? `${list.length} ${list.length === 1 ? 'coincidencia' : 'coincidencias'} para «${state.q}»`
    : `${list.length} ${list.length === 1 ? 'cuenta' : 'cuentas'}`;
  dom.tableRegion.replaceChildren(list.length ? buildTable(list) : buildEmptyState());
  dom.tableRegion.classList.toggle('is-empty', list.length === 0);
  dom.tableRegion.setAttribute('aria-busy', 'false');
  lockTableHeight();
}

/**
 * Con la lista completa fija la altura de la tabla: filtrar o quedarse sin
 * resultados no mueve el layout de la página (solo aplica al modo tabla).
 */
function lockTableHeight() {
  if (window.innerWidth <= 900 || state.q) return;
  const height = Math.round(dom.tableRegion.getBoundingClientRect().height);
  if (!height) return;
  if (height > state.tableFloor) {
    state.tableFloor = height;
    dom.tableRegion.style.minHeight = `${height}px`;
  }
}

function renderAccountsError(err) {
  dom.accountsCount.textContent = 'No se pudo cargar';
  dom.tableRegion.replaceChildren(el('div', { class: 'empty' }, [
    el('strong', { text: 'No pudimos cargar las cuentas' }),
    el('p', { text: humanError(err) }),
    el('button', {
      class: 'btn btn--primary btn--sm', type: 'button', text: 'Reintentar',
      onclick: () => loadAccounts(state.q)
    })
  ]));
  dom.tableRegion.setAttribute('aria-busy', 'false');
}

let accountsSeq = 0;
async function loadAccounts(q, { silent = false } = {}) {
  const seq = (accountsSeq += 1);
  setBusy(dom.tableRegion, true);
  try {
    const data = await api(`/admin/accounts${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (seq !== accountsSeq) return;
    state.accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    state.accountsReady = true;
    renderAccounts();
  } catch (err) {
    if (seq !== accountsSeq) return;
    if (!state.accountsReady) renderAccountsError(err);
    else if (!silent) toastErr(err);
  } finally {
    if (seq === accountsSeq) setBusy(dom.tableRegion, false);
  }
}

function focusRow(accountId) {
  const selector = `[data-account-id="${accountId}"] [data-action="menu"]`;
  const target = dom.tableRegion.querySelector(selector);
  if (target) { target.focus(); return; }
  dom.search.focus();
}

/* ── Menú de acciones por fila (portal en body, posición fija) ── */

function menuButton(label, hint, onSelect, { danger = false, disabled = false } = {}) {
  const btn = el('button', {
    class: `adm-menu__item${danger ? ' adm-menu__item--danger' : ''}`,
    type: 'button',
    role: 'menuitem',
    disabled: disabled || false
  }, [
    el('span', { text: label }),
    hint ? el('span', { class: 'adm-menu__hint', text: hint }) : null
  ]);
  btn.addEventListener('click', () => { closeMenu({ restoreFocus: true }); onSelect(); });
  return btn;
}

function buildMenu(account) {
  const license = account.license || {};
  const left = daysLeft(license.expiresAt);
  const effectiveActive = license.status === 'active' && (left === null || left >= 0);
  const revoked = license.status === 'revoked';
  const suspended = account.status === 'suspended';

  const sep = () => el('div', { class: 'adm-menu__sep', role: 'separator' });

  return [
    menuButton('Renovar 1 mes', '+30 días', () => renew(account, 1)),
    menuButton('Renovar 3 meses', '+90 días', () => renew(account, 3)),
    menuButton('Renovar 12 meses', '+1 año', () => renew(account, 12)),
    sep(),
    menuButton(
      'Marcar pago recibido',
      effectiveActive ? 'ya está activa' : 'activa hoy',
      () => markPaid(account),
      { disabled: effectiveActive }
    ),
    menuButton(suspended ? 'Activar cuenta' : 'Suspender cuenta', '', () => toggleAccount(account)),
    menuButton('Cambiar contraseña', '', () => openResetPassword(account)),
    menuButton('Editar', '', () => openDrawer(account)),
    sep(),
    menuButton('Revocar licencia', revoked ? 'ya revocada' : 'corta el acceso', () => revoke(account), {
      danger: true,
      disabled: revoked
    })
  ];
}

function onMenuKey(event) {
  const current = state.menu;
  if (!current) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu({ restoreFocus: true });
    return;
  }
  if (event.key === 'Tab') { closeMenu(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(current.node.querySelectorAll('[role="menuitem"]:not([disabled])'));
  if (!items.length) return;
  event.preventDefault();
  const idx = items.indexOf(document.activeElement);
  let next = 0;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % items.length;
  else next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
  items[next].focus({ preventScroll: true });
}

function onMenuDismiss(event) {
  const current = state.menu;
  if (!current) return;
  if (event?.type === 'pointerdown' && (current.node.contains(event.target) || current.trigger.contains(event.target))) return;
  closeMenu();
}

function closeMenu({ restoreFocus = false } = {}) {
  const current = state.menu;
  if (!current) return;
  state.menu = null;
  current.node.remove();
  current.trigger.setAttribute('aria-expanded', 'false');
  window.removeEventListener('keydown', onMenuKey, true);
  window.removeEventListener('scroll', onMenuDismiss, true);
  window.removeEventListener('resize', onMenuDismiss);
  document.removeEventListener('pointerdown', onMenuDismiss, true);
  if (restoreFocus) {
    try { current.trigger.focus({ preventScroll: true }); } catch { /* sin foco */ }
  }
}

function openMenu(account, trigger) {
  closeMenu();
  const menu = el('div', {
    class: 'adm-menu',
    role: 'menu',
    'aria-label': `Acciones para ${account.companyName}`
  }, buildMenu(account));

  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);

  const rect = trigger.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const margin = 10;
  let left = Math.min(Math.max(margin, rect.right - mw), window.innerWidth - mw - margin);
  let top = rect.bottom + 6;
  if (top + mh > window.innerHeight - margin) top = Math.max(margin, rect.top - mh - 6);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = '';

  trigger.setAttribute('aria-expanded', 'true');
  state.menu = { node: menu, trigger, accountId: String(account.id) };

  window.addEventListener('keydown', onMenuKey, true);
  window.addEventListener('scroll', onMenuDismiss, true);
  window.addEventListener('resize', onMenuDismiss);
  document.addEventListener('pointerdown', onMenuDismiss, true);

  const first = menu.querySelector('[role="menuitem"]:not([disabled])');
  if (first) first.focus({ preventScroll: true });
}

function toggleMenu(account, trigger) {
  if (state.menu && state.menu.accountId === String(account.id) && state.menu.trigger === trigger) {
    closeMenu({ restoreFocus: true });
    return;
  }
  openMenu(account, trigger);
}

/* ═══════════════════════════ Acciones sobre cuentas ═══════════════════════════ */

async function mutate(fn) {
  if (state.busy) return;
  state.busy = true;
  try { await fn(); }
  catch (err) { toastErr(err); }
  finally { state.busy = false; }
}

async function refreshAll({ audit = false } = {}) {
  await Promise.all([
    loadOverview(),
    loadAccounts(state.q, { silent: true }),
    audit ? loadAudit({ silent: true }) : Promise.resolve()
  ]);
}

async function renew(account, months) {
  const label = months === 1 ? 'un mes' : `${months} meses`;
  const ok = await askConfirm({
    title: 'Renovar licencia',
    message: `Extiendes la licencia de ${account.companyName} por ${label}. Confirma la transferencia cuando llegue: la renovación ya queda aplicada al historial.`,
    confirmText: 'Renovar',
    danger: false
  });
  if (!ok) return;

  await mutate(async () => {
    await api(`/admin/accounts/${account.id}/renew`, { method: 'POST', body: { months } });
    toast(`Licencia renovada ${label}.`);
    await refreshAll({ audit: true });
    focusRow(account.id);
  });
}

async function markPaid(account) {
  const ok = await askConfirm({
    title: 'Marcar pago recibido',
    message: `Confirmas el pago de ${account.companyName} y su licencia queda activa desde hoy. Los datos de la cuenta no cambian.`,
    confirmText: 'Marcar pago',
    danger: false
  });
  if (!ok) return;

  await mutate(async () => {
    await api(`/admin/accounts/${account.id}`, { method: 'PATCH', body: { licenseStatus: 'active' } });
    toast('Pago confirmado. Licencia activa.');
    await refreshAll({ audit: true });
    focusRow(account.id);
  });
}

async function toggleAccount(account) {
  const suspend = account.status !== 'suspended';
  const ok = await askConfirm({
    title: suspend ? 'Suspender cuenta' : 'Activar cuenta',
    message: suspend
      ? `${account.companyName} no podrá entrar al estudio hasta que la reactives. La licencia, los participantes y la marca se conservan.`
      : `${account.companyName} podrá volver a entrar al estudio con la licencia que tenga vigente.`,
    confirmText: suspend ? 'Suspender' : 'Activar',
    danger: suspend
  });
  if (!ok) return;

  await mutate(async () => {
    await api(`/admin/accounts/${account.id}`, {
      method: 'PATCH',
      body: { status: suspend ? 'suspended' : 'active' }
    });
    toast(suspend ? 'Cuenta suspendida.' : 'Cuenta activada.');
    await refreshAll({ audit: true });
    focusRow(account.id);
  });
}

async function revoke(account) {
  const ok = await askConfirm({
    title: 'Revocar licencia',
    message: `${account.companyName} pierde el acceso al estudio de inmediato. Las credenciales se conservan: puedes reactivar marcando el pago recibido o renovando.`,
    confirmText: 'Revocar licencia',
    danger: true
  });
  if (!ok) return;

  await mutate(async () => {
    await api(`/admin/accounts/${account.id}`, { method: 'PATCH', body: { licenseStatus: 'revoked' } });
    toast('Licencia revocada.');
    await refreshAll({ audit: true });
    focusRow(account.id);
  });
}

/* ═══════════════════════════ Modales ═══════════════════════════ */

function trapTab(container, event) {
  if (event.key !== 'Tab') return;
  const nodes = Array.from(container.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])'
  )).filter((node) => node.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Show a modal with backdrop, Escape, focus trap and focus return. */
function showModal(modal, { onClose } = {}) {
  const backdrop = el('div', { class: 'backdrop' });
  state.modalReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.classList.add('adm-lock');

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    modal.remove();
    document.body.classList.remove('adm-lock');
    const previous = state.modalReturn;
    state.modalReturn = null;
    if (previous && document.contains(previous)) {
      try { previous.focus({ preventScroll: true }); } catch { /* sin foco */ }
    }
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    trapTab(modal, event);
  };

  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('click', close);
  document.body.append(backdrop, modal);

  const focusTarget = modal.querySelector('[data-autofocus]') || modal.querySelector('.btn--primary') || modal;
  try { focusTarget.focus({ preventScroll: true }); } catch { /* sin foco */ }

  return close;
}

function credBlock(label, value, onCopy) {
  return el('div', { class: 'adm-cred' }, [
    el('div', { class: 'adm-cred__body' }, [
      el('div', { class: 'adm-cred__label', text: label }),
      el('div', { class: 'adm-cred__val', text: value })
    ]),
    el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button', text: 'Copiar',
      'aria-label': `Copiar ${label.toLowerCase()}`,
      onclick: onCopy
    })
  ]);
}

function openCredentials({ title, sub, company, username, password }) {
  let close = null;
  const all = [
    'Sorteo Studio — acceso',
    `Empresa: ${company}`,
    `Usuario: ${username}`,
    `Contraseña: ${password}`,
    `Entrar: ${location.origin}/login`
  ].join('\n');

  const modal = el('div', {
    class: 'modal adm-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
    tabindex: '-1'
  }, [
    el('p', { class: 'eyebrow', text: 'Credenciales' }),
    el('h2', { class: 'card__title', text: title }),
    el('p', { class: 'adm-modal__sub', text: sub }),
    el('div', { class: 'adm-creds' }, [
      credBlock('Usuario', username, () => copyAndToast(username, 'Usuario copiado.')),
      credBlock('Contraseña', password, () => copyAndToast(password, 'Contraseña copiada.'))
    ]),
    el('div', { class: 'adm-warnbox' }, [
      el('span', { 'aria-hidden': 'true', text: '!' }),
      el('span', { text: 'Esta contraseña no se vuelve a mostrar. Cópiala o entrégala antes de cerrar.' })
    ]),
    el('div', { class: 'adm-modal__actions' }, [
      el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cerrar', onclick: () => close?.() }),
      el('button', {
        class: 'btn btn--primary', type: 'button', text: 'Copiar todo', 'data-autofocus': 'true',
        onclick: () => copyAndToast(all, 'Credenciales copiadas.')
      })
    ])
  ]);

  close = showModal(modal);
}

function openResetPassword(account) {
  let password = genPassword();
  let close = null;

  const valueNode = el('div', { class: 'adm-cred__val', text: password });
  const copyBtn = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button', text: 'Copiar',
    'aria-label': 'Copiar contraseña',
    onclick: () => copyAndToast(password, 'Contraseña copiada.')
  });

  const regenBtn = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button', text: 'Regenerar',
    onclick: () => {
      password = genPassword();
      valueNode.textContent = password;
    }
  });

  const applyBtn = el('button', { class: 'btn btn--primary', type: 'button', text: 'Aplicar cambio', 'data-autofocus': 'true' });
  applyBtn.addEventListener('click', async () => {
    if (applyBtn.disabled) return;
    applyBtn.disabled = true;
    const original = applyBtn.textContent;
    applyBtn.textContent = 'Aplicando…';
    try {
      await api(`/admin/accounts/${account.id}/reset-password`, {
        method: 'POST',
        body: { newPassword: password }
      });
      close?.();
      toast('Contraseña actualizada.');
      openCredentials({
        title: 'Contraseña actualizada',
        sub: `Nueva contraseña para ${account.username} (${account.companyName}).`,
        company: account.companyName,
        username: account.username,
        password
      });
      refreshAll({ audit: true });
    } catch (err) {
      toastErr(err);
      applyBtn.disabled = false;
      applyBtn.textContent = original;
    }
  });

  const modal = el('div', {
    class: 'modal adm-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Cambiar contraseña',
    tabindex: '-1'
  }, [
    el('p', { class: 'eyebrow', text: 'Acceso' }),
    el('h2', { class: 'card__title', text: 'Cambiar contraseña' }),
    el('p', {
      class: 'adm-modal__sub',
      text: `Se cierra la sesión abierta de ${account.username}. La contraseña actual deja de servir en el momento.`
    }),
    el('div', { class: 'adm-creds' }, [
      el('div', { class: 'adm-cred' }, [
        el('div', { class: 'adm-cred__body' }, [
          el('div', { class: 'adm-cred__label', text: 'Contraseña nueva' }),
          valueNode
        ]),
        el('div', { class: 'adm-cred__tools' }, [regenBtn, copyBtn])
      ])
    ]),
    el('div', { class: 'adm-warnbox adm-warnbox--danger' }, [
      el('span', { 'aria-hidden': 'true', text: '!' }),
      el('span', { text: 'Entrega la contraseña nueva antes de cerrar: no se vuelve a mostrar.' })
    ]),
    el('div', { class: 'adm-modal__actions' }, [
      el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancelar', onclick: () => close?.() }),
      applyBtn
    ])
  ]);

  close = showModal(modal);
}

/* ═══════════════════════════ Drawer: alta / edición ═══════════════════════════ */

function fieldDefinitions() {
  return [
    {
      input: dom.company,
      err: dom.errCompany,
      test: (value) => (value.trim().length >= 2 ? '' : 'Escribe el nombre de la empresa.')
    },
    {
      input: dom.email,
      err: dom.errEmail,
      test: (value) => (EMAIL_RE.test(value.trim()) ? '' : 'Escribe un correo válido, por ejemplo cobranzas@empresa.com.')
    },
    {
      input: dom.username,
      err: dom.errUsername,
      test: (value) => (USERNAME_RE.test(value.trim())
        ? ''
        : 'El usuario necesita 3–32 caracteres: minúsculas, números, punto, guion o guion bajo.')
    },
    {
      input: dom.password,
      err: dom.errPassword,
      test: (value) => (value.length >= 10 ? '' : 'La contraseña necesita al menos 10 caracteres.'),
      skip: () => Boolean(state.editing)
    },
    {
      input: dom.expires,
      err: dom.errExpires,
      test: (value) => (!value || ISO_DAY_RE.test(value) ? '' : 'Elige una fecha válida.')
    },
    {
      input: dom.amount,
      err: dom.errAmount,
      test: (value) => {
        if (value.trim() === '') return '';
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? '' : 'Escribe un monto en dólares, por ejemplo 49.00.';
      }
    }
  ];
}

function setFieldError(input, errNode, message) {
  if (!input || !errNode) return;
  if (message) {
    errNode.textContent = message;
    errNode.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  } else {
    errNode.textContent = '';
    errNode.hidden = true;
    input.removeAttribute('aria-invalid');
  }
}

function validateAll() {
  let firstBad = null;
  for (const field of fieldDefinitions()) {
    if (field.skip?.()) {
      setFieldError(field.input, field.err, '');
      continue;
    }
    const message = field.test(field.input.value);
    setFieldError(field.input, field.err, message);
    if (message && !firstBad) firstBad = field.input;
  }
  return firstBad;
}

function readForm() {
  const rawAmount = dom.amount.value.trim();
  const amount = rawAmount === '' ? 0 : Number(rawAmount);
  return {
    companyName: dom.company.value.trim(),
    contactName: dom.contact.value.trim(),
    email: dom.email.value.trim(),
    username: dom.username.value.trim(),
    password: dom.password.value,
    plan: dom.plan.value,
    expiresAt: dom.expires.value || null,
    amountCents: Math.round((Number.isFinite(amount) ? amount : 0) * 100),
    notes: dom.notes.value.trim(),
    activate: dom.activate.checked
  };
}

function setSubmitting(flag) {
  dom.drawerSubmit.disabled = flag;
  dom.drawerCancel.disabled = flag;
  if (flag) dom.drawerSubmit.textContent = 'Guardando…';
  else dom.drawerSubmit.textContent = state.editing ? 'Guardar cambios' : 'Crear cuenta';
}

function openDrawer(account = null) {
  const opener = document.activeElement;
  state.editing = account || null;
  state.usernameTouched = false;
  state.drawerReturn = (opener instanceof HTMLElement && opener !== document.body) ? opener : dom.newAccountBtn;

  dom.form.reset();
  for (const field of fieldDefinitions()) setFieldError(field.input, field.err, '');

  dom.drawerTitle.textContent = account ? 'Editar cuenta' : 'Nueva cuenta';
  dom.drawerSub.textContent = account
    ? `Ajusta los datos de ${account.companyName}. Cada cambio queda en la bitácora.`
    : 'Alta manual: cuenta, licencia y marca se crean juntas.';
  dom.passwordField.hidden = Boolean(account);
  dom.activateField.hidden = Boolean(account);
  dom.username.readOnly = Boolean(account);
  dom.drawerSubmit.textContent = account ? 'Guardar cambios' : 'Crear cuenta';
  dom.drawerSubmit.disabled = false;
  dom.drawerCancel.disabled = false;

  if (account) {
    const license = account.license || {};
    dom.company.value = account.companyName || '';
    dom.contact.value = account.contactName || '';
    dom.email.value = account.email || '';
    dom.username.value = account.username || '';
    dom.plan.value = license.plan || 'mensual';
    dom.expires.value = license.expiresAt || '';
    dom.amount.value = Number(license.amountCents || 0) > 0 ? (Number(license.amountCents) / 100).toFixed(2) : '';
    dom.notes.value = license.notes || '';
    dom.password.value = '';
  } else {
    dom.company.value = '';
    dom.contact.value = '';
    dom.email.value = '';
    dom.username.value = '';
    dom.password.value = genPassword();
    dom.plan.value = 'mensual';
    dom.expires.value = addDaysIso(30);
    dom.amount.value = '';
    dom.notes.value = '';
    dom.activate.checked = true;
  }

  dom.drawerBackdrop.hidden = false;
  dom.drawer.hidden = false;
  document.body.classList.add('adm-lock');

  requestAnimationFrame(() => {
    if (!dom.drawer.hidden) dom.company.focus();
  });
}

function closeDrawer() {
  if (dom.drawer.hidden) return;
  dom.drawer.hidden = true;
  dom.drawerBackdrop.hidden = true;
  document.body.classList.remove('adm-lock');
  state.editing = null;
  const previous = state.drawerReturn;
  state.drawerReturn = null;
  if (previous && document.contains(previous)) {
    try { previous.focus({ preventScroll: true }); } catch { /* sin foco */ }
  } else {
    dom.newAccountBtn.focus();
  }
}

async function submitAccount() {
  if (state.busy) return;
  const invalid = validateAll();
  if (invalid) {
    invalid.focus();
    toast('Revisa los campos marcados.', 'err');
    return;
  }

  const values = readForm();
  const editing = state.editing;
  setSubmitting(true);
  state.busy = true;

  try {
    if (editing) {
      const response = await api(`/admin/accounts/${editing.id}`, {
        method: 'PATCH',
        body: {
          companyName: values.companyName,
          contactName: values.contactName,
          email: values.email,
          plan: values.plan,
          expiresAt: values.expiresAt,
          amountCents: values.amountCents,
          notes: values.notes
        }
      });
      const updated = response?.account;
      closeDrawer();
      toast('Cuenta actualizada.');
      await refreshAll({ audit: true });
      focusRow(updated?.id ?? editing.id);
    } else {
      const response = await api('/admin/accounts', {
        method: 'POST',
        body: {
          companyName: values.companyName,
          contactName: values.contactName,
          email: values.email,
          username: values.username,
          password: values.password,
          plan: values.plan,
          seats: 1,
          expiresAt: values.expiresAt,
          status: 'active',
          licenseStatus: values.activate ? 'active' : 'pending',
          amountCents: values.amountCents,
          notes: values.notes
        }
      });
      const created = response?.account;
      closeDrawer();
      toast('Cuenta creada.');
      await refreshAll({ audit: true });
      if (created?.id) focusRow(created.id);
      openCredentials({
        title: 'Cuenta creada',
        sub: `Entrega estos datos a ${values.companyName}. La contraseña no se vuelve a mostrar.`,
        company: values.companyName,
        username: values.username,
        password: values.password
      });
    }
  } catch (err) {
    if (err?.code === 'CONFLICT') {
      const message = 'Ya existe una cuenta con ese usuario o correo.';
      setFieldError(dom.username, dom.errUsername, message);
      setFieldError(dom.email, dom.errEmail, message);
    }
    toastErr(err);
  } finally {
    state.busy = false;
    setSubmitting(false);
  }
}

/* ═══════════════════════════ Bitácora ═══════════════════════════ */

const AUDIT_META = {
  ACCOUNT_CREATED: { label: 'Cuenta creada', cls: 'pill--brand' },
  ACCOUNT_UPDATED: { label: 'Cuenta editada', cls: 'pill--muted' },
  ACCOUNT_SUSPENDED: { label: 'Cuenta suspendida', cls: 'pill--warn' },
  ACCOUNT_ACTIVATED: { label: 'Cuenta activada', cls: 'pill--ok' },
  LICENSE_ACTIVATED: { label: 'Pago confirmado', cls: 'pill--ok' },
  PAYMENT_RECEIVED: { label: 'Pago confirmado', cls: 'pill--ok' },
  LICENSE_RENEWED: { label: 'Licencia renovada', cls: 'pill--ok' },
  LICENSE_REVOKED: { label: 'Licencia revocada', cls: 'pill--danger' },
  PASSWORD_RESET: { label: 'Contraseña nueva', cls: 'pill--warn' },
  LOGIN_SUCCESS: { label: 'Ingreso al sistema', cls: 'pill--muted' },
  LOGIN_FAILED: { label: 'Ingreso fallido', cls: 'pill--danger' },
  LOGOUT: { label: 'Sesión cerrada', cls: 'pill--muted' },
  ADMIN_BOOTSTRAPPED: { label: 'Admin creado', cls: 'pill--muted' }
};

function auditMeta(entry) {
  const key = String(entry?.action || '').toUpperCase();
  const fields = Array.isArray(entry?.meta?.fields) ? entry.meta.fields : [];
  if (key === 'ACCOUNT_UPDATED' && fields.includes('licenseStatus')) {
    return { label: 'Licencia actualizada', cls: 'pill--brand' };
  }
  if (key === 'ACCOUNT_UPDATED' && fields.includes('status')) {
    return { label: 'Estado de cuenta', cls: 'pill--brand' };
  }
  if (AUDIT_META[key]) return AUDIT_META[key];
  const human = key.toLowerCase().replace(/_/g, ' ');
  const label = human ? human.charAt(0).toUpperCase() + human.slice(1) : 'Movimiento';
  let cls = 'pill--muted';
  if (/REVOK|DELETE|SUSPEND|RESET|FAIL/.test(key)) cls = 'pill--danger';
  else if (/RENEW|ACTIV|CREATE|PAY|CONFIRM/.test(key)) cls = 'pill--ok';
  else if (/UPDATE|EDIT|CHANGE/.test(key)) cls = 'pill--brand';
  return { label, cls };
}

function auditRow(entry) {
  const meta = auditMeta(entry);
  const target = entry.targetCompany || entry.meta?.companyName || entry.meta?.company || '';
  const actor = entry.actorName || '';
  const showTarget = Boolean(target) && target !== actor;

  const main = el('div', { class: 'adm-audit__main' }, [
    el('span', { class: `pill ${meta.cls}`, text: meta.label }),
    showTarget ? el('span', { class: 'adm-audit__target', title: target, text: target }) : null,
    actor
      ? el('span', { class: 'adm-audit__actor', text: showTarget ? `por ${actor}` : actor })
      : null,
    !showTarget && !actor ? el('span', { class: 'adm-audit__actor', text: 'Sistema' }) : null
  ]);

  return el('div', { class: 'adm-audit__row' }, [
    main,
    el('span', { class: 'adm-audit__when num', text: fmtDateTime(entry.createdAt) })
  ]);
}

function renderAudit() {
  if (!state.audit.length) {
    dom.auditList.replaceChildren(el('div', { class: 'empty' }, [
      el('strong', { text: 'Bitácora vacía' }),
      el('p', { text: 'Cuando crees, renueves o revoques una licencia, el movimiento aparece acá.' })
    ]));
    dom.auditList.setAttribute('aria-busy', 'false');
    return;
  }
  dom.auditList.replaceChildren(...state.audit.map(auditRow));
  dom.auditList.setAttribute('aria-busy', 'false');
}

async function loadAudit({ silent = false } = {}) {
  setBusy(dom.auditList, true);
  try {
    const data = await api('/admin/audit?limit=80');
    state.audit = Array.isArray(data?.entries) ? data.entries : [];
    renderAudit();
  } catch (err) {
    if (!state.audit.length) {
      dom.auditList.replaceChildren(el('div', { class: 'empty' }, [
        el('strong', { text: 'La bitácora no cargó' }),
        el('p', { text: humanError(err) }),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', text: 'Reintentar',
          onclick: () => loadAudit()
        })
      ]));
      dom.auditList.setAttribute('aria-busy', 'false');
    } else if (!silent) {
      toastErr(err);
    }
  } finally {
    setBusy(dom.auditList, false);
  }
}

/* ═══════════════════════════ Datos y respaldos ═══════════════════════════ */

function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Error con voz de respaldos (el NOT_FOUND genérico habla de cuentas). */
function backupError(err) {
  if (err?.code === 'NOT_FOUND') {
    return 'Este servidor todavía no expone los respaldos. Intenta de nuevo cuando la actualización esté desplegada.';
  }
  return humanError(err);
}

const backupDownloadUrl = (name) => `/api/admin/backups/${encodeURIComponent(name)}`;

function buildBackupRow(backup) {
  const name = String(backup?.name || 'respaldo');
  return el('li', { class: 'adm-backups__row' }, [
    el('span', { class: 'adm-backups__name', title: name, text: name }),
    el('span', { class: 'adm-backups__size', text: fmtBytes(backup?.bytes) }),
    el('span', { class: 'adm-backups__date', text: fmtDateTime(backup?.createdAt) }),
    el('a', {
      class: 'btn btn--ghost btn--sm adm-backups__dl',
      href: backupDownloadUrl(name),
      text: 'Descargar',
      'aria-label': `Descargar respaldo ${name}`
    })
  ]);
}

function renderBackups() {
  const list = state.backups || [];
  if (!list.length) {
    dom.backupsList.replaceChildren(el('li', { class: 'adm-backups__empty' }, [
      el('div', { class: 'empty' }, [
        el('strong', { text: 'Sin respaldos todavía' }),
        el('p', { text: 'Crea el primero con «Crear respaldo ahora». El automático aparece acá cada 24 h.' })
      ])
    ]));
    dom.backupsList.setAttribute('aria-busy', 'false');
    return;
  }
  dom.backupsList.replaceChildren(...list.map(buildBackupRow));
  dom.backupsList.setAttribute('aria-busy', 'false');
}

function renderBackupsMeta(data) {
  const last = data?.lastBackupAt;
  const auto = data?.auto || {};
  const hours = Number(auto.everyHours || 24);
  const keep = Number(auto.keep || 14);
  const parts = [
    last ? `Último respaldo: ${fmtDateTime(last)}` : 'Todavía sin respaldo automático',
    `automático cada ${hours} h`,
    `conserva los últimos ${keep}`
  ];
  dom.backupsMeta.textContent = parts.join(' · ');
}

function renderBackupsError(err) {
  dom.backupsMeta.textContent = 'No se pudo cargar el estado de los respaldos.';
  dom.backupsList.replaceChildren(el('li', { class: 'adm-backups__empty' }, [
    el('div', { class: 'empty' }, [
      el('strong', { text: 'Los respaldos no cargaron' }),
      el('p', { text: backupError(err) }),
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', text: 'Reintentar',
        onclick: () => loadBackups()
      })
    ])
  ]));
  dom.backupsList.setAttribute('aria-busy', 'false');
}

let backupsSeq = 0;
async function loadBackups({ silent = false } = {}) {
  const seq = (backupsSeq += 1);
  setBusy(dom.backupsList, true);
  try {
    const data = await api('/admin/backups');
    if (seq !== backupsSeq) return;
    const list = Array.isArray(data?.backups) ? data.backups.slice() : [];
    // El más nuevo primero, aunque el servidor cambie de criterio.
    list.sort((a, b) => new Date(b?.createdAt || 0) - new Date(a?.createdAt || 0));
    state.backups = list;
    state.backupsReady = true;
    renderBackupsMeta(data);
    renderBackups();
  } catch (err) {
    if (seq !== backupsSeq) return;
    if (!state.backupsReady) renderBackupsError(err);
    else if (!silent) toast(backupError(err), 'err');
  } finally {
    if (seq === backupsSeq) setBusy(dom.backupsList, false);
  }
}

async function createBackup() {
  if (state.backupsBusy) return;
  state.backupsBusy = true;
  dom.backupCreate.disabled = true;
  dom.backupCreate.textContent = 'Creando…';
  dom.backupCreate.setAttribute('aria-busy', 'true');
  setBusy(dom.backupsList, true);
  try {
    const data = await api('/admin/backups', { method: 'POST', body: {} });
    const created = data?.backup;
    toast(created?.name ? `Respaldo creado: ${created.name}.` : 'Respaldo creado.');
    await loadBackups({ silent: true });
    const firstDownload = dom.backupsList.querySelector('.adm-backups__dl');
    if (firstDownload) firstDownload.focus({ preventScroll: true });
  } catch (err) {
    toast(backupError(err), 'err');
  } finally {
    state.backupsBusy = false;
    dom.backupCreate.disabled = false;
    dom.backupCreate.textContent = 'Crear respaldo ahora';
    dom.backupCreate.removeAttribute('aria-busy');
    setBusy(dom.backupsList, false);
  }
}

function showIntegrity(message, kind = 'ok') {
  if (!message) {
    dom.integrityStatus.hidden = true;
    dom.integrityStatus.textContent = '';
    dom.integrityStatus.className = 'adm-integrity';
    dom.integrityStatus.removeAttribute('title');
    return;
  }
  dom.integrityStatus.hidden = false;
  dom.integrityStatus.className = `adm-integrity adm-integrity--${kind}`;
  dom.integrityStatus.textContent = message;
}

async function verifyIntegrity() {
  if (state.integrityBusy) return;
  state.integrityBusy = true;
  dom.backupVerify.disabled = true;
  dom.backupVerify.textContent = 'Verificando…';
  dom.backupVerify.setAttribute('aria-busy', 'true');
  try {
    const data = await api('/admin/maintenance/integrity', { method: 'POST', body: {} });
    const counts = data?.counts || {};
    const accounts = Number(counts.accounts || 0);
    const licenses = Number(counts.licenses || 0);
    const participants = Number(counts.participants || 0);
    const healthy = data?.ok !== false && String(data?.integrity || 'ok').toLowerCase() === 'ok';
    if (healthy) {
      showIntegrity(
        `Integridad OK · ${accounts} ${accounts === 1 ? 'cuenta' : 'cuentas'} · ` +
        `${licenses} ${licenses === 1 ? 'licencia' : 'licencias'} · ` +
        `${participants} ${participants === 1 ? 'participante' : 'participantes'}`,
        'ok'
      );
      if (data?.checkedAt) dom.integrityStatus.title = `Verificado ${fmtDateTime(data.checkedAt)}`;
      toast('Integridad verificada.');
    } else {
      showIntegrity(`Integridad con problemas · ${String(data?.integrity || 'revisar')}`, 'err');
      dom.integrityStatus.title = 'Revisa el respaldo más reciente antes de seguir operando.';
      toast('La verificación encontró problemas.', 'err');
    }
  } catch (err) {
    showIntegrity(backupError(err), 'err');
    toast(backupError(err), 'err');
  } finally {
    state.integrityBusy = false;
    dom.backupVerify.disabled = false;
    dom.backupVerify.textContent = 'Verificar integridad';
    dom.backupVerify.removeAttribute('aria-busy');
  }
}

/* ═══════════════════════════ Sesión ═══════════════════════════ */

async function loadMe() {
  try {
    const data = await api('/auth/me');
    const user = data?.user;
    if (!user) return;
    state.me = user;
    dom.userName.textContent = user.companyName || user.username || 'Admin';
    dom.userName.title = user.companyName || user.username || '';
    dom.userEmail.textContent = user.email || '';
    dom.userEmail.title = user.email || '';
    if (dom.footStamp) dom.footStamp.textContent = `Sesión admin · ${user.username}`;
  } catch (err) {
    if (err?.status === 401) return;
    dom.userName.textContent = 'Sesión admin';
  }
}

/* ═══════════════════════════ Eventos ═══════════════════════════ */

function bindEvents() {
  dom.logoutBtn.addEventListener('click', async () => {
    dom.logoutBtn.disabled = true;
    try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* igual salimos */ }
    location.href = '/login';
  });

  dom.newAccountBtn.addEventListener('click', () => openDrawer(null));
  dom.drawerClose.addEventListener('click', closeDrawer);
  dom.drawerCancel.addEventListener('click', closeDrawer);
  dom.drawerBackdrop.addEventListener('click', closeDrawer);
  dom.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAccount();
  });

  const queueSearch = () => {
    const q = dom.search.value.trim();
    if (q === state.q) return;
    state.q = q;
    loadAccounts(q);
  };
  const debouncedSearch = debounce(queueSearch, 260);
  dom.search.addEventListener('input', debouncedSearch);
  dom.search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      queueSearch();
    } else if (event.key === 'Escape' && dom.search.value) {
      event.preventDefault();
      dom.search.value = '';
      queueSearch();
    }
  });

  dom.auditRefresh.addEventListener('click', async () => {
    dom.auditRefresh.disabled = true;
    dom.auditRefresh.textContent = 'Actualizando…';
    try { await loadAudit(); } finally {
      dom.auditRefresh.disabled = false;
      dom.auditRefresh.textContent = 'Actualizar';
    }
  });

  dom.backupCreate.addEventListener('click', createBackup);
  dom.backupVerify.addEventListener('click', verifyIntegrity);

  dom.pwdRegen.addEventListener('click', () => {
    dom.password.value = genPassword();
    setFieldError(dom.password, dom.errPassword, '');
    toast('Contraseña regenerada.');
  });
  dom.pwdCopy.addEventListener('click', () => copyAndToast(dom.password.value, 'Contraseña copiada.'));

  dom.company.addEventListener('input', () => {
    if (state.editing || state.usernameTouched) return;
    const suggestion = suggestUsername(dom.company.value);
    if (suggestion) dom.username.value = suggestion;
  });
  dom.username.addEventListener('input', () => { state.usernameTouched = true; });

  for (const field of fieldDefinitions()) {
    field.input.addEventListener('blur', () => {
      if (field.skip?.()) return;
      setFieldError(field.input, field.err, field.test(field.input.value));
    });
    field.input.addEventListener('input', () => {
      if (field.skip?.()) return;
      if (field.input.getAttribute('aria-invalid') === 'true') {
        setFieldError(field.input, field.err, field.test(field.input.value));
      }
    });
  }

  document.addEventListener('keydown', (event) => {
    if (dom.drawer.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer();
      return;
    }
    trapTab(dom.drawer, event);
  });

  window.addEventListener('resize', debounce(() => {
    if (state.accountsReady && !state.q) lockTableHeight();
  }, 160));
}

/* ═══════════════════════════ Arranque ═══════════════════════════ */

function init() {
  bindEvents();
  loadMe();
  loadOverview();
  loadAccounts('');
  loadAudit();
  loadBackups();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
