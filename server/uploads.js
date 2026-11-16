/* ═══════════════════════════════════════════════════════════════════════
   Uploads de imágenes (logos de marca y de marcas participantes).
   Seguridad: el tipo real se decide por magic bytes, nunca por el mime
   declarado en el dataURL; tamaño máximo 400 KB decodificados; el nombre
   en disco es aleatorio (32 hex) y no se acepta ninguna ruta del cliente.
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { UPLOADS_DIR } from './db.js';
import { badRequest } from './validate.js';

export const MAX_UPLOAD_BYTES = 400 * 1024;

/** Nombres que produce este módulo y que /uploads sirve. */
export const UPLOAD_NAME_RE = /^[a-f0-9]{32}\.(png|jpe?g|webp)$/;
export const UPLOAD_PATH_RE = /^\/uploads\/[a-f0-9]{32}\.(png|jpe?g|webp)$/;

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Detecta el formato real por cabecera. Devuelve {ext, mime} o null. */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(PNG_MAGIC)) return { ext: 'png', mime: 'image/png' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  const riff = buffer.subarray(0, 4).toString('ascii');
  const webp = buffer.subarray(8, 12).toString('ascii');
  if (riff === 'RIFF' && webp === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

/**
 * Decodifica un dataURL de imagen. Acepta solo PNG/JPEG/WebP reales.
 * @returns {Buffer}
 */
export function decodeImageDataUrl(dataUrl, field = 'imagen') {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    throw badRequest(`El campo "${field}" debe ser un dataURL de imagen.`);
  }
  const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(dataUrl);
  if (!match) throw badRequest(`El campo "${field}" no es un dataURL de imagen válido.`);

  const payload = match[1].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw badRequest(`El campo "${field}" tiene una codificación base64 inválida.`);
  }

  const buffer = Buffer.from(payload, 'base64');
  // El tamaño se comprueba antes de tocar disco.
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw badRequest(`La imagen supera el máximo de ${Math.round(MAX_UPLOAD_BYTES / 1024)} KB.`);
  }
  if (buffer.length === 0) throw badRequest(`El campo "${field}" está vacío.`);

  const kind = sniffImage(buffer);
  if (!kind) throw badRequest('La imagen debe ser PNG, JPEG o WebP.');
  return { buffer, ...kind };
}

/** Guarda la imagen en DATA_DIR/uploads y devuelve su ruta pública `/uploads/<32hex>.<ext>`. */
export function saveImageDataUrl(dataUrl, field = 'imagen') {
  const { buffer, ext } = decodeImageDataUrl(dataUrl, field);
  const filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer, { mode: 0o644 });
  return `/uploads/${filename}`;
}

export function uploadExists(publicPath) {
  if (!UPLOAD_PATH_RE.test(String(publicPath || ''))) return false;
  const filename = path.basename(publicPath);
  return fs.existsSync(path.join(UPLOADS_DIR, filename));
}

/**
 * Borra un archivo de uploads a partir de su ruta pública.
 * Se ignora cualquier ruta que no tenga el formato exacto (defensa contra traversal).
 */
export function deleteUpload(publicPath) {
  if (!UPLOAD_PATH_RE.test(String(publicPath || ''))) return;
  const filename = path.basename(publicPath);
  const absolute = path.resolve(UPLOADS_DIR, filename);
  if (!absolute.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) return;
  try {
    fs.rmSync(absolute, { force: true });
  } catch (err) {
    // Un archivo huérfano no debe romper el guardado del branding.
    console.warn(`[uploads] no se pudo borrar ${filename}: ${err.message}`);
  }
}

export const mimeForFilename = (filename) => MIME_BY_EXT[path.extname(filename).slice(1).toLowerCase()] || null;
