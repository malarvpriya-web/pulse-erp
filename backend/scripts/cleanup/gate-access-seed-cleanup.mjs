/**
 * gate-access-seed-cleanup.mjs — delete the SEED gate passes and visitors.
 *
 * Owner instruction 2026-11-12: the Gate Pass & Visitors page starts empty.
 * Every gate_passes / visitors row in the developer DB was a 'SEED …' row from
 * the old empty-table seeding probe: 5 passes (all expired, two pointing at
 * employee 4 — which does not exist — and the deleted employee 5) and 5
 * visitors (all checked out at their check-in time).
 *
 *   node scripts/cleanup/gate-access-seed-cleanup.mjs          dry run (lists)
 *   node scripts/cleanup/gate-access-seed-cleanup.mjs --apply  backup + delete
 *
 * Only rows whose name starts with 'SEED ' are touched. The backup (full rows,
 * JSON + sha256) goes to ../_backups; each deletion writes one audit_logs row.
 * Restore: INSERT the JSON rows back (ids included) — nothing references them.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '../../.env'), quiet: true });
const apply = process.argv.includes('--apply');

const client = new pg.Client({
  host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});
await client.connect();
try {
  await client.query('BEGIN');
  const { rows: passes } = await client.query(
    `SELECT * FROM gate_passes WHERE visitor_name LIKE 'SEED %' OR purpose LIKE 'SEED %' ORDER BY id FOR UPDATE`);
  const { rows: visitors } = await client.query(
    `SELECT * FROM visitors WHERE name LIKE 'SEED %' ORDER BY id FOR UPDATE`);
  console.log(`gate_passes: ${passes.length} SEED row(s) ${passes.map(p => p.id).join(', ')}`);
  console.log(`visitors:    ${visitors.length} SEED row(s) ${visitors.map(v => v.id).join(', ')}`);
  if (!apply) { await client.query('ROLLBACK'); console.log('Dry run — pass --apply to back up and delete.'); process.exit(0); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(here, '../../../../_backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `gate_access_seed_${stamp}.json`);
  const body = JSON.stringify({ taken_at: new Date().toISOString(), database: process.env.DB_NAME, gate_passes: passes, visitors }, null, 2);
  fs.writeFileSync(file, body);
  fs.writeFileSync(`${file}.sha256`, `${crypto.createHash('sha256').update(body).digest('hex')}  ${path.basename(file)}\n`);

  const audit = [];
  for (const [table, rows, type] of [['gate_passes', passes, 'gate_pass'], ['visitors', visitors, 'visitor']]) {
    for (const r of rows) {
      await client.query(`DELETE FROM ${table} WHERE id = $1`, [r.id]);
      const { rows: [a] } = await client.query(
        `INSERT INTO audit_logs (user_id, module_name, action_type, reference_type, reference_id, old_data_json, new_data_json)
         VALUES (NULL, 'gate_access', 'delete', $1, $2, $3, $4) RETURNING id`,
        [type, String(r.id), JSON.stringify(r), JSON.stringify({ reason: 'SEED row removed on owner instruction 2026-11-12', backup: path.basename(file) })]);
      audit.push(a.id);
    }
  }
  await client.query('COMMIT');
  console.log(`Deleted. Backup ${file}\nAudit rows ${audit[0]}–${audit[audit.length - 1]}`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Nothing deleted:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
