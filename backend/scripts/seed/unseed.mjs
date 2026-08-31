/**
 * Removes every row recorded in _manifest.json (written by seed-empty-tables.mjs).
 *
 *   node scripts/seed/unseed.mjs [--only=a,b]
 *
 * Deletes in reverse insertion order and re-sweeps while progress is being made,
 * so FK chains unwind without needing an explicit dependency graph.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makePool } from './lib-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const onlyArg = argv.find(a => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.split('=')[1].split(',').map(s => s.trim())) : null;

const manifestPath = path.join(HERE, '_manifest.json');
if (!fs.existsSync(manifestPath)) { console.error('no _manifest.json — nothing to unseed'); process.exit(1); }

let pending = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).reverse();
if (ONLY) pending = pending.filter(r => ONLY.has(r.table));

const pool = makePool();
let deleted = 0;

for (let pass = 1; pass <= 12 && pending.length; pass++) {
  const stuck = [];
  for (const { table, pk } of pending) {
    const cols = Object.keys(pk || {});
    if (!cols.length) continue;
    const where = cols.map((c, i) => `"${c}" = $${i + 1}`).join(' and ');
    try {
      const r = await pool.query(`delete from "${table}" where ${where}`, cols.map(c => pk[c]));
      deleted += r.rowCount;
    } catch { stuck.push({ table, pk }); }
  }
  console.log(`pass ${pass}: deleted ${deleted}, still blocked ${stuck.length}`);
  if (stuck.length === pending.length) { pending = stuck; break; }   // no progress
  pending = stuck;
}

if (pending.length) {
  console.log(`\n${pending.length} rows could not be deleted (referenced elsewhere):`);
  const byTable = {};
  for (const r of pending) byTable[r.table] = (byTable[r.table] || 0) + 1;
  console.log(Object.entries(byTable).map(([t, n]) => `  ${t} x${n}`).join('\n'));
  fs.writeFileSync(path.join(HERE, '_manifest.json'), JSON.stringify(pending, null, 1));
} else {
  fs.writeFileSync(path.join(HERE, '_manifest.json'), '[]');
  console.log('\nAll seeded rows removed.');
}
await pool.end();
