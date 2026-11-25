/**
 * Go-live check 2026-11-25: leave_balances.used_days must equal the approved
 * leave of that employee/type/year — F&F (settlementEngine) and the year-end
 * carry-forward read the stored column. The sample script inserted approved
 * sample leave without counting it (EMP041 Earned Leave: 0 used, 2 approved).
 * Sets used_days to the approved total wherever they differ (non-LOP types).
 * Backup: _backups/leaves_2026-11-25/used_days_reconcile.json. Audited. Idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import pool from '../../src/config/db.js';

const CO = 1;
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows: [admin] } = await client.query(`SELECT id FROM users WHERE email = 'superadmin@manifest.in' LIMIT 1`);
  const { rows } = await client.query(`
    SELECT lb.id, lb.employee_id, lb.leave_type_id, lb.year, lb.used_days, COALESCE(s.d, 0) AS approved_days
      FROM leave_balances lb
      JOIN employees e   ON e.id = lb.employee_id
      JOIN leave_types lt ON lt.id = lb.leave_type_id
      LEFT JOIN (SELECT employee_id, leave_type_id, EXTRACT(YEAR FROM start_date)::int AS y, SUM(number_of_days) AS d
                   FROM leave_applications WHERE status = 'approved' AND deleted_at IS NULL GROUP BY 1, 2, 3) s
             ON s.employee_id = lb.employee_id AND s.leave_type_id = lb.leave_type_id AND s.y = lb.year
     WHERE e.company_id = $1 AND NOT lt.is_lop_type
       AND COALESCE(lb.used_days, 0) <> COALESCE(s.d, 0)
     FOR UPDATE OF lb`, [CO]);
  const dir = path.resolve('../../_backups/leaves_2026-11-25');
  fs.mkdirSync(dir, { recursive: true });
  // Only when there is something to change — a re-run must not blank the backup.
  // (First run 2026-11-25: row 10302 EMP041 EL used_days 0.00 → 2, audit 190865.)
  if (rows.length) fs.writeFileSync(path.join(dir, `used_days_reconcile_${Date.now()}.json`), JSON.stringify(rows, null, 2));
  const ids = [];
  for (const r of rows) {
    await client.query('UPDATE leave_balances SET used_days = $1, updated_at = NOW() WHERE id = $2', [r.approved_days, r.id]);
    const { rows: [a] } = await client.query(
      `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, old_data_json, new_data_json, company_id)
       VALUES ($1, 'leaves', 'update', $2, 'leave_balance', $3, $4, $5) RETURNING id`,
      [admin?.id ?? null, r.id, JSON.stringify({ used_days: r.used_days }),
        JSON.stringify({ used_days: r.approved_days, reason: 'Go-live check 2026-11-25: used days = approved leave' }), CO]);
    ids.push(a.id);
  }
  await client.query('COMMIT');
  console.log(`reconciled ${rows.length} balance row(s); audit ${ids.join(', ') || '—'}`);
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await pool.end();
}
