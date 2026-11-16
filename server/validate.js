/* ═══════════════════════════════════════════════════════════════════════
   Validación estricta de entradas + error HTTP tipado.
   Regla: toda entrada del cliente pasa por aquí antes de tocar la DB.
   Los mensajes son para humanos; el `code` es el contrato con el frontend.
   ═══════════════════════════════════════════════════════════════════════ */

export class HttpError extends Error {
  /**
   * @param {string} code  código del contrato (BAD_REQUEST, UNAUTHORIZED, ...)
   * @param {string} message texto para el humano
   * @param {number} [status] status HTTP; 400 por defecto
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
  }
}

/** Envuelve handlers async: Express 4 no captura promesas rechazadas por sí solo. */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export const badRequest = (message) => new HttpError('BAD_REQUEST', message, 400);
export const notFound = (message = 'Recurso no encontrado.') => new HttpError('NOT_FOUND', message, 404);
export const conflict = (message) => new HttpError('CONFLICT', message, 409);

/** El body JSON siempre debe ser un objeto plano. */
export function asObject(body) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('El cuerpo de la petición debe ser un objeto JSON.');
  }
  return body;
}

export const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Texto con longitud acotada.
 * @param {unknown} value
 * @param {string} field nombre para el mensaje de error
 * @param {{min?:number,max?:number,required?:boolean,trim?:boolean,allowNull?:boolean,pattern?:RegExp,patternMessage?:string}} [opts]
 */
export function text(value, field, opts = {}) {
  const {
    min = 0, max = 500, required = true, trim = true, allowNull = false, pattern, patternMessage
  } = opts;

  if (value === undefined || value === null) {
    if (allowNull) return '';
    if (required) throw badRequest(`El campo "${field}" es obligatorio.`);
    return null;
  }
  if (typeof value !== 'string') throw badRequest(`El campo "${field}" debe ser texto.`);

  const out = trim ? value.trim() : value;
  if (out.length < min) throw badRequest(`El campo "${field}" debe tener al menos ${min} caracteres.`);
  if (out.length > max) throw badRequest(`El campo "${field}" no puede superar ${max} caracteres.`);
  if (pattern && !pattern.test(out)) {
    throw badRequest(patternMessage || `El campo "${field}" tiene un formato inválido.`);
  }
  return out;
}

export function bool(value, field, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw badRequest(`El campo "${field}" debe ser true o false.`);
  return value;
}

export function integer(value, field, opts = {}) {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, fallback = null } = opts;
  if (value === undefined || value === null) {
    if (fallback !== null) return fallback;
    throw badRequest(`El campo "${field}" es obligatorio.`);
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest(`El campo "${field}" debe ser un número entero.`);
  }
  if (value < min || value > max) {
    throw badRequest(`El campo "${field}" debe estar entre ${min} y ${max}.`);
  }
  return value;
}

export function oneOf(value, field, allowed, fallback = null) {
  if (value === undefined || value === null) {
    if (fallback !== null) return fallback;
    throw badRequest(`El campo "${field}" es obligatorio.`);
  }
  if (!allowed.includes(value)) {
    throw badRequest(`El campo "${field}" debe ser uno de: ${allowed.join(', ')}.`);
  }
  return value;
}

export function arrayOf(value, field, opts = {}) {
  const { max = 2000, min = 0 } = opts;
  if (!Array.isArray(value)) throw badRequest(`El campo "${field}" debe ser una lista.`);
  if (value.length < min) throw badRequest(`El campo "${field}" debe tener al menos ${min} elementos.`);
  if (value.length > max) throw badRequest(`El campo "${field}" no puede tener más de ${max} elementos.`);
  return value;
}

/* ── Dominio ── */

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
export const PLANS = ['mensual', 'trimestral', 'anual', 'evento'];
export const LICENSE_STATUSES = ['pending', 'active', 'expired', 'revoked'];
export const ACCOUNT_STATUSES = ['active', 'suspended'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function email(value, { required = true } = {}) {
  const raw = text(value, 'email', { min: 3, max: 120, required, allowNull: true });
  if (!raw && !required) return '';
  const out = raw.toLowerCase();
  if (!EMAIL_RE.test(out)) throw badRequest('El email no tiene un formato válido.');
  return out;
}

export function username(value) {
  // Se normaliza a minúsculas: la columna es COLLATE NOCASE, así nunca hay dos formas del mismo usuario.
  const raw = text(value, 'username', { min: 3, max: 32 }).toLowerCase();
  if (!USERNAME_RE.test(raw)) {
    throw badRequest('El usuario debe tener 3–32 caracteres y solo minúsculas, números, punto, guión o guión bajo.');
  }
  return raw;
}

export function password(value, field = 'password') {
  const raw = text(value, field, { min: 10, max: 200, trim: false });
  if (raw.trim().length === 0) throw badRequest('La contraseña no puede ser solo espacios.');
  return raw;
}

export const plan = (value, fallback = null) => oneOf(value, 'plan', PLANS, fallback);
export const licenseStatus = (value, fallback = null) =>
  oneOf(value, 'licenseStatus', LICENSE_STATUSES, fallback);
export const accountStatus = (value, fallback = null) =>
  oneOf(value, 'status', ACCOUNT_STATUSES, fallback);

export function brandColor(value) {
  const raw = text(value, 'brandColor', { min: 4, max: 7 });
  if (!/^#?[0-9a-f]{6}$/i.test(raw)) throw badRequest('El color de marca debe tener el formato #RRGGBB.');
  return `#${raw.replace('#', '').toUpperCase()}`;
}

/** Fecha ISO 'YYYY-MM-DD' (o null = sin vencimiento). Valida que exista en el calendario. */
export function isoDate(value, field, { allowNull = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (allowNull) return null;
    throw badRequest(`El campo "${field}" es obligatorio.`);
  }
  const raw = text(value, field, { min: 10, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw badRequest(`El campo "${field}" debe tener el formato YYYY-MM-DD.`);
  }
  const [y, m, d] = raw.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw badRequest(`El campo "${field}" no es una fecha válida.`);
  }
  return raw;
}

/** id numérico (acepta el string de un parámetro de ruta). */
export function positiveId(value, field = 'id') {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw badRequest(`El campo "${field}" debe ser un identificador válido.`);
  }
  return n;
}

/** Detecta violaciones de índice único de SQLite para traducirlas a 409. */
export function uniqueViolation(err, column) {
  const msg = String(err?.message || '');
  if (!/UNIQUE constraint failed/i.test(msg)) return false;
  return column ? msg.includes(column) : true;
}
