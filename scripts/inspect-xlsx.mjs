import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const XLSX = require(join(here, '..', 'assets', 'xlsx.full.min.js'));

const file = process.argv[2];
const buf = readFileSync(file);
const wb = XLSX.read(buf, { type: 'buffer' });

console.log('HOJAS:', JSON.stringify(wb.SheetNames));
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const nonEmpty = rows.filter(r => r.some(c => String(c).trim() !== ''));
  console.log(`\n--- HOJA "${name}" filas_con_datos=${nonEmpty.length} cols_max=${Math.max(...nonEmpty.map(r => r.length))}`);
  nonEmpty.slice(0, 10).forEach((r, i) => console.log(String(i).padStart(2), JSON.stringify(r)));
  if (nonEmpty.length > 10) {
    console.log('   ...');
    console.log('ult:', JSON.stringify(nonEmpty[nonEmpty.length - 1]));
  }
}
