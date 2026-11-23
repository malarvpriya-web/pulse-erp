/**
 * One-off (owner, 2026-11-19): sample attendance must not sit on the real
 * staff EMP001–EMP003 — Payroll Sync would pay it as real attendance. Keeps the
 * samples on the "(Sample)" employees (EMP041–EMP043).
 *
 * Removes, after writing a JSON backup to _backups/attendance_2026-11-19/:
 *   · attendance_records of EMP001–003 with remarks '(Sample)'
 *   · the two demo CSV punches (biometric_logs 668, 669 — EMP002/EMP003 on
 *     2026-11-18, from the sample script's CSV import) and the attendance rows
 *     they created that day (source 'biometric', no remarks)
 *   · the two June test delegations (ids 1, 2; created_by NULL; EMP001↔EMP002
 *     until 2041 / 2050) — the active one handed all of EMP001's approvals to
 *     EMP002 until 2050.
 *
 * Usage: node scripts/samples/attendance-cleanup-real-staff-2026-11-19.mjs [--apply]
 * Without --apply it only prints what it would remove.
 */
import fs from 'node:fs';
import path from 'node:path';
import pool from '../../src/config/db.js';

const APPLY = process.argv.includes('--apply');
const REAL = ['EMP001', 'EMP002', 'EMP003'];

const { rows: emps } = await pool.query(
  `SELECT id, office_id FROM employees WHERE company_id = 1 AND office_id = ANY($1::text[])`, [REAL]);
const ids = emps.map((e) => e.id);

const pick = {
  sample_attendance: await pool.query(
    `SELECT * FROM attendance_records WHERE employee_id = ANY($1::int[]) AND remarks ILIKE '%(Sample)%'`, [ids]),
  demo_logs: await pool.query(
    `SELECT * FROM biometric_logs WHERE id IN (668, 669) AND employee_id = ANY($1::int[])
        AND raw_data->>'source' = 'csv_import'`, [ids]),
  demo_attendance: await pool.query(
    `SELECT * FROM attendance_records WHERE employee_id = ANY($1::int[]) AND attendance_date = '2026-11-18'
        AND source = 'biometric' AND remarks IS NULL
        AND employee_id IN (SELECT employee_id FROM biometric_logs WHERE id IN (668, 669))`, [ids]),
  test_delegations: await pool.query(
    `SELECT * FROM attendance_approval_delegations WHERE id IN (1, 2) AND created_by IS NULL
        AND from_date = '2026-06-23'`),
};
for (const [k, r] of Object.entries(pick)) console.log(`${k}: ${r.rows.length}`);

if (!APPLY) { console.log('Dry run — add --apply to remove.'); process.exit(0); }

// The workspace _backups folder, outside the (public) repo. Run from backend/.
const dir = path.resolve(process.cwd(), '../../_backups/attendance_2026-11-19');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'real-staff-sample-cleanup.json'),
  JSON.stringify(Object.fromEntries(Object.entries(pick).map(([k, r]) => [k, r.rows])), null, 1));
console.log(`Backup: ${dir}`);

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const del = async (sql, list) => (list.length ? (await client.query(sql, [list])).rowCount : 0);
  const n1 = await del(`DELETE FROM attendance_records WHERE id = ANY($1::int[])`,
    [...pick.sample_attendance.rows, ...pick.demo_attendance.rows].map((r) => r.id));
  const n2 = await del(`DELETE FROM biometric_logs WHERE id = ANY($1::int[])`, pick.demo_logs.rows.map((r) => r.id));
  const n3 = await del(`DELETE FROM attendance_approval_delegations WHERE id = ANY($1::int[])`, pick.test_delegations.rows.map((r) => r.id));
  const { rows: [a] } = await client.query(
    `INSERT INTO audit_logs (module_name, action_type, reference_type, new_data_json, company_id, created_at)
     VALUES ('attendance', 'data_cleanup', 'sample_data', $1::jsonb, 1, NOW()) RETURNING id`,
    [JSON.stringify({ reason: 'Owner 2026-11-19: sample attendance off real staff EMP001-003; June test delegations removed',
      attendance_records: n1, biometric_logs: n2, delegations: n3, backup: '_backups/attendance_2026-11-19/real-staff-sample-cleanup.json' })])
    .catch(() => ({ rows: [{}] }));
  await client.query('COMMIT');
  console.log(`Removed attendance_records ${n1}, biometric_logs ${n2}, delegations ${n3}; audit_logs ${a?.id ?? '(not written)'}`);
} catch (e) {
  await client.query('ROLLBACK'); throw e;
} finally { client.release(); await pool.end(); }
