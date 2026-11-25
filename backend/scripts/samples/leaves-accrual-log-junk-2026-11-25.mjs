/**
 * Leave Settings audit 2026-11-25: five leave_accrual_log rows seeded on
 * 2026-08-20 by a test generator (run_mode / accrual_type 'Standard',
 * 'General', 'Primary', 'Routine'; 100–200 days "credited" to people who
 * have left). They never touched a balance but they show in Leave Reports →
 * Credit History, and as the accrual lock (uq_accrual_log_period) they would
 * block a real credit for those employee/type/month slots.
 *
 * Backup: _backups/leaves_2026-11-25/accrual_log_junk.json. Audited.
 * Usage (from backend/): node scripts/samples/leaves-accrual-log-junk-2026-11-25.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import pool from '../../src/config/db.js';

const CO = 1;
const JUNK_MODES = ['Standard', 'General', 'Primary', 'Routine'];
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    `SELECT * FROM leave_accrual_log WHERE run_mode = ANY($1::text[]) AND accrual_type = run_mode`, [JUNK_MODES]);
  if (!rows.length) { console.log('Nothing to delete'); await client.query('ROLLBACK'); process.exit(0); }
  const dir = path.resolve('../../_backups/leaves_2026-11-25');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'accrual_log_junk.json'), JSON.stringify(rows, null, 2));
  await client.query('DELETE FROM leave_accrual_log WHERE id = ANY($1::int[])', [rows.map(r => r.id)]);
  const { rows: [admin] } = await client.query(`SELECT id FROM users WHERE email = 'superadmin@manifest.in' LIMIT 1`);
  const { rows: [a] } = await client.query(
    `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, old_data_json, new_data_json, company_id)
     VALUES ($1, 'leaves', 'delete_junk_accrual_log', NULL, 'cleanup', $2, $3, $4) RETURNING id`,
    [admin?.id ?? null, JSON.stringify(rows), JSON.stringify({ deleted: rows.map(r => r.id) }), CO]);
  await client.query('COMMIT');
  console.log(`Deleted ${rows.length} rows (${rows.map(r => r.id).join(', ')}), audit ${a.id}, backup ${dir}`);
} catch (e) {
  await client.query('ROLLBACK'); console.error(e.message); process.exitCode = 1;
} finally { client.release(); await pool.end(); }
