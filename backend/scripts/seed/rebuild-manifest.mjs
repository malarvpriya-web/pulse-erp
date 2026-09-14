/**
 * Rebuilds _manifest.json from the pre-seed baseline in _schema.json.
 *
 *   node scripts/seed/rebuild-manifest.mjs [--write]
 *
 * Recovery path for a manifest that was lost or truncated. Every table that held
 * 0 rows at baseline contains only seeded rows now, so all of its primary keys
 * belong in the manifest. For a table that already had rows (the --topup
 * masters), only the keys above the baseline high-water mark are seeded.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makePool, introspect } from './lib-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRITE = process.argv.includes('--write');
const baseline = JSON.parse(fs.readFileSync(path.join(HERE, '_schema.json'), 'utf8')).counts;

const pool = makePool();
const { T } = await introspect(pool);

const rebuilt = [];
let emptyTables = 0, topupTables = 0;

for (const [table, wasCount] of Object.entries(baseline)) {
  const meta = T.get(table);
  if (!meta || !meta.pk || meta.relkind === 'p') continue;
  const pkCols = meta.pk.map(c => `"${c}"`).join(', ');

  if (wasCount === 0) {
    const { rows } = await pool.query(`select ${pkCols} from "${table}"`);
    if (rows.length) { emptyTables++; for (const pk of rows) rebuilt.push({ table, pk }); }
  } else if (meta.pk.length === 1 && /^(int|bigint|smallint)/.test(
      meta.cols.find(c => c.column_name === meta.pk[0])?.data_type || '')) {
    // integer PK: anything above the baseline count of highest keys is ours
    const { rows } = await pool.query(
      `select ${pkCols} from "${table}" order by ${pkCols} desc limit $1`,
      [Math.max(0, (await pool.query(`select count(*)::int n from "${table}"`)).rows[0].n - wasCount)]
    );
    if (rows.length) { topupTables++; for (const pk of rows) rebuilt.push({ table, pk }); }
  }
}

console.log(`Rebuilt ${rebuilt.length} rows: ${emptyTables} previously-empty tables, ${topupTables} topped-up masters`);
if (WRITE) {
  fs.writeFileSync(path.join(HERE, '_manifest.json'), JSON.stringify(rebuilt, null, 1));
  console.log('wrote scripts/seed/_manifest.json');
} else {
  console.log('(dry run — pass --write to save)');
}
await pool.end();
