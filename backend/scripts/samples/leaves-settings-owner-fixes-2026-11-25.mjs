/**
 * Owner decisions 2026-11-25 (Leave Settings audit):
 *  1. Sick Leave: untick "Attachment required" — the medical certificate rule
 *     (after 3 days) is the one that should apply.
 *  2. EMP001–003 Sick 1/6/6 and Casual 4 were NOT set on purpose (edited
 *     25 Apr 2026, no leave taken) → back to the type default (7 each).
 * Backup: _backups/leaves_2026-11-25/owner_fixes.json. Audited. Idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import pool from '../../src/config/db.js';

const CO = 1, YEAR = 2026;
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows: [admin] } = await client.query(`SELECT id FROM users WHERE email = 'superadmin@manifest.in' LIMIT 1`);
  const audit = (action, type, ref, oldD, newD) => client.query(
    `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, old_data_json, new_data_json, company_id)
     VALUES ($1, 'leaves', $2, $3, $4, $5, $6, $7) RETURNING id`,
    [admin?.id ?? null, action, ref, type, JSON.stringify(oldD), JSON.stringify(newD), CO]);

  const { rows: [sick] } = await client.query(
    `SELECT id, requires_attachment, requires_medical_cert_days FROM leave_types
      WHERE company_id = $1 AND leave_name = 'Sick Leave' AND deleted_at IS NULL`, [CO]);
  const { rows: bal } = await client.query(`
    SELECT lb.id, e.office_id, lt.leave_name, lb.allocated_days, lt.annual_quota
      FROM leave_balances lb JOIN employees e ON e.id = lb.employee_id JOIN leave_types lt ON lt.id = lb.leave_type_id
     WHERE e.company_id = $1 AND e.office_id IN ('EMP001','EMP002','EMP003') AND lb.year = $2
       AND lt.leave_name IN ('Sick Leave','Casual Leave') AND lb.allocated_days <> lt.annual_quota`, [CO, YEAR]);
  const dir = path.resolve('../../_backups/leaves_2026-11-25');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner_fixes.json'), JSON.stringify({ sick, balances: bal }, null, 2));

  const ids = [];
  if (sick?.requires_attachment) {
    await client.query('UPDATE leave_types SET requires_attachment = false, updated_at = NOW() WHERE id = $1', [sick.id]);
    ids.push((await audit('update', 'leave_type', sick.id, { requires_attachment: true }, { requires_attachment: false, reason: 'Owner 2026-11-25: medical certificate after 3 days applies, not an attachment on every request' })).rows[0].id);
  }
  for (const b of bal) {
    await client.query('UPDATE leave_balances SET allocated_days = $2, updated_at = NOW() WHERE id = $1', [b.id, b.annual_quota]);
    ids.push((await audit('correction', 'leave_balance', b.id, { allocated_days: b.allocated_days }, { allocated_days: b.annual_quota, reason: `Owner 2026-11-25: ${b.office_id} ${b.leave_name} was not set on purpose — back to the default` })).rows[0].id);
  }
  await client.query('COMMIT');
  console.log(`Sick attachment ${sick?.requires_attachment ? 'unticked' : 'already off'}; ${bal.length} balance(s) reset; audit ${ids.join(', ') || 'none'}`);
} catch (e) { await client.query('ROLLBACK'); console.error(e.message); process.exitCode = 1; }
finally { client.release(); await pool.end(); }
