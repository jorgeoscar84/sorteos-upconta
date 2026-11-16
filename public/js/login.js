/* ═══════════════════════════════════════════════════════════════════════
   Login — sesión existente, envío del formulario y errores en línea.
   La ruleta de la izquierda es real (misma clase que el estudio) y gira
   despacio: es el único efecto "wow" de la pantalla.
   ═══════════════════════════════════════════════════════════════════════ */

import { api } from './api.js';
import { Wheel } from './wheel.js';

/* Las fuentes llegan con media="print" para no bloquear el render; se activan
   desde JS para no usar handlers inline (la CSP del servidor no los permite). */
document.querySelectorAll('link[data-fonts]').forEach((link) => {
  link.media = 'all';
});

const SESSION_HINT = 'sorteo.session';
const hasHint = () => {
  try {
    return localStorage.getItem(SESSION_HINT) === '1';
  } catch {
    return false;
  }
};
const setHint = (value) => {
  try {
    if (value) localStorage.setItem(SESSION_HINT, '1');
    else localStorage.removeItem(SESSION_HINT);
  } catch {
    /* modo privado: seguimos sin la pista */
  }
};

const form = document.getElementById('loginForm');
const identifierInput = document.getElementById('identifier');
const passwordInput = document.getElementById('password');
const submitButton = document.getElementById('btnLogin');
const errorBox = document.getElementById('loginError');
const canvas = document.getElementById('loginWheel');

const DEMO_WHEEL = [
  { num: '01', name: 'Ana Torres' },
  { num: '02', name: 'Luis Mora' },
  { num: '03', name: 'Carla Vega' },
  { num: '04', name: 'José Andrade' },
  { num: '05', name: 'María Pilco' },
  { num: '06', name: 'Diego Ruiz' },
  { num: '07', name: 'Fernanda Ochoa' },
  { num: '08', name: 'Carlos Cedeño' },
  { num: '09', name: 'Andrea Salazar' },
  { num: '10', name: 'Marco Vinueza' },
  { num: '11', name: 'Sofía Espinoza' },
  { num: '12', name: 'Ricardo León' },
  { num: '13', name: 'Verónica Núñez' },
  { num: '14', name: 'Esteban Ortiz' },
  { num: '15', name: 'Daniela Paredes' },
  { num: '16', name: 'Gabriel Suárez' },
  { num: '17', name: 'Patricia Ruiz' },
  { num: '18', name: 'Andrés Villamar' }
];

let wheel = null;
let busy = false;

function startWheel() {
  if (!canvas) return;
  try {
    wheel = new Wheel(canvas, { labelScale: 0.72 });
    wheel.setItems(DEMO_WHEEL);
    wheel.startAmbient((Math.PI * 2) / 46); // una vuelta cada 46 s
  } catch {
    /* sin canvas la pantalla sigue funcionando */
  }
}

function showError(message) {
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.hidden = false;
  identifierInput?.setAttribute('aria-invalid', 'true');
  passwordInput?.setAttribute('aria-invalid', 'true');
}

function clearError() {
  if (!errorBox) return;
  errorBox.hidden = true;
  errorBox.textContent = '';
  identifierInput?.removeAttribute('aria-invalid');
  passwordInput?.removeAttribute('aria-invalid');
}

function setBusy(value) {
  busy = value;
  if (!submitButton) return;
  submitButton.disabled = value;
  submitButton.textContent = value ? 'Entrando…' : 'Entrar';
}

function homeFor(me) {
  // El administrador aterriza en la consola de licencias; la empresa, en su estudio.
  return me?.user?.role === 'admin' ? '/admin' : '/';
}

async function redirectIfSignedIn() {
  // El servidor ya redirige /login cuando hay sesión (pageLogin). Esta
  // comprobación cubre una pestaña con sesión previa sin pedir /auth/me
  // a ciegas: así la consola no acumula un 401 en cada visita anónima.
  if (!hasHint()) return;
  try {
    const me = await api('/auth/me', { redirectOn401: false });
    location.replace(homeFor(me));
  } catch (error) {
    if (error.status === 401) setHint(false);
  }
}

function messageFor(error) {
  if (error.code === 'RATE_LIMITED') {
    const wait = /min|espera|intenta/i.test(error.message || '')
      ? error.message
      : 'Demasiados intentos seguidos. Espera 15 minutos antes de volver a probar.';
    return wait;
  }
  if (error.code === 'UNAUTHORIZED' || error.status === 401) {
    return 'Usuario o contraseña incorrectos. Revisa los datos que te entregaron.';
  }
  if (!error.status) {
    return 'No pudimos conectar con el estudio. Revisa tu conexión e inténtalo otra vez.';
  }
  return error.message || 'No se pudo iniciar sesión. Inténtalo otra vez.';
}

async function onSubmit(event) {
  event.preventDefault();
  if (busy) return;
  clearError();

  const identifier = identifierInput.value.trim();
  const password = passwordInput.value;

  if (!identifier) {
    showError('Escribe tu usuario o correo para entrar.');
    identifierInput.focus();
    return;
  }
  if (!password) {
    showError('Escribe tu contraseña.');
    passwordInput.focus();
    return;
  }

  setBusy(true);
  try {
    const me = await api('/auth/login', {
      method: 'POST',
      body: { identifier, password },
      redirectOn401: false
    });
    setHint(true);
    location.replace(homeFor(me));
  } catch (error) {
    showError(messageFor(error));
    passwordInput.focus();
    passwordInput.select();
    setBusy(false);
  }
}

if (form) form.addEventListener('submit', onSubmit);
if (identifierInput) identifierInput.addEventListener('input', clearError);
if (passwordInput) passwordInput.addEventListener('input', clearError);
window.addEventListener('pagehide', () => wheel?.destroy());

startWheel();
redirectIfSignedIn();
