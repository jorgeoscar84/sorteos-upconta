/**
 * Genera assets/participantes.json (semilla del evento) desde un Excel de una columna.
 * Uso: node scripts/build-seed.mjs "ruta.xlsx" "Executive Sessions 2026"
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const XLSX = require(join(here, '..', 'assets', 'xlsx.full.min.js'));

const [, , src, eventName = 'Evento', version = new Date().toISOString().slice(0, 10)] = process.argv;
if (!src) { console.error('Falta la ruta del Excel'); process.exit(1); }

const wb = XLSX.read(readFileSync(src), { type: 'buffer' });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });

// Aplanar: nombres pueden venir en 1 columna o en varias (nombre, empresa, cargo)
const flat = rows
  .map(r => r.map(c => String(c ?? '').replace(/\s+/g, ' ').trim()))
  .filter(r => r.some(Boolean));

const isHeader = (r) => r.length === 1 && /^(listado|nombre|nombres|participantes?|asistentes?)$/i.test(r[0]);
const body = isHeader(flat[0]) ? flat.slice(1) : flat;

const people = [];
const seen = new Set();
for (const r of body) {
  const name = (r[0] || '').trim();
  if (!name) continue;
  const key = name.toLowerCase();
  if (seen.has(key)) continue;           // dedupe: nadie puede ganar dos veces por error de lista
  seen.add(key);
  const detail = r.slice(1).filter(Boolean).join(' · ');
  people.push({ num: String(people.length + 1), name, detail });
}

const seed = {
  version,
  event: eventName,
  brand: 'UpConta',
  prize: 'Premio principal',
  participants: people
};
writeFileSync(join(here, '..', 'assets', 'participantes.json'), JSON.stringify(seed, null, 2), 'utf8');
console.log(`OK ${people.length} participantes -> assets/participantes.json (evento: ${eventName})`);
console.log('Primeros 3:', people.slice(0, 3).map(p => `${p.num}. ${p.name}`).join(' | '));
console.log('Últimos 2:', people.slice(-2).map(p => `${p.num}. ${p.name}`).join(' | '));
