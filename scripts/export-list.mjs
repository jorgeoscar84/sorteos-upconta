/**
 * Convierte la lista del evento (JSON) a CSV importable desde la app.
 * Uso: node scripts/export-list.mjs <entrada.json> <salida.csv>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , src, out] = process.argv;
if (!src || !out) { console.error('Uso: node scripts/export-list.mjs entrada.json salida.csv'); process.exit(1); }

const seed = JSON.parse(readFileSync(src, 'utf8'));
const people = (seed.participants || []).filter(p => p && p.name);

const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const rows = [['NUMERO', 'NOMBRE', 'EMPRESA', 'CARGO']];
people.forEach((p, i) => rows.push([p.num || String(i + 1), p.name, '', '']));

const csv = '\uFEFF' + rows.map(r => r.map(esc).join(',')).join('\r\n');
writeFileSync(out, csv, 'utf8');
console.log(`OK ${people.length} filas -> ${out}`);
