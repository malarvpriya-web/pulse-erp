/**
 * Leaves clean-up (Leaves review, 2026-11-23). One-off, idempotent.
 *
 * Writes a JSON backup (+ .sha256) to ../_backups/leaves_2026-11-23/ FIRST, then:
 *   1. Deletes the 5 smoke-test leave applications ("Smoke test", "Restart
 *      verify", "P1 smoke fix test", "final verify", "test" — all on EMP001,
 *      statuses contradicting each other) and their approval-history rows.
 *   2. Deletes the 5 junk encashment claims (100–200 days each on EMP022–034,
 *      templated reasons; none had touched a balance).
 *   3. Switches off the leave types the company does not offer: Paternity,
 *      Marriage (owner 2026-11-11) and Work From Home (removed 2026-11-19).
 *      Compensatory Off stays — it is offered once someone has comp-off days.
 *   4. Re-derives leave_balances.used_days from approved applications (it had
 *      drifted: approvals of the junk rows, and encashment approvals that also
 *      added to it).
 * Each step is audit-logged (module 'leaves', reference_type 'cleanup').
 *
 * Usage (from backend/): node scripts/samples/leaves-cleanup-2026-11-23.mjs
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pool from '../../src/config/db.js';

const CO = 1;
const JUNK_APP_REASONS = ['Smoke test', 'Restart verify', 'P1 smoke fix test', 'final verify', 'test'];
const JUNK_ENCASH_IDS = [21, 22, 23, 24, 25];
const OFF_CODES = ['PATERNITY', 'MRG', 'WFH'];

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../../../_backups/leaves_2026-11-23');
fs.mkdirSync(dir, { recursive: true });

const client = await pool.connect();
try {
  const { rows: apps } = await client.query(
    `SELECT la.* FROM leave_applications la JOIN employees e ON e.id = la.employee_id
      WHERE e.company_id = $1 AND la.reason = ANY($2::text[]) AND la.employee_id = 1`, [CO, JUNK_APP_REASONS]);
  const appIds = apps.map(a => a.id);
  const { rows: hist } = appIds.length
    ? await client.query('SELECT * FROM leave_approval_history WHERE leave_application_id = ANY($1::int[])', [appIds])
    : { rows: [] };
  const { rows: enc } = await client.query(
    `SELECT * FROM leave_encashments WHERE id = ANY($1::int[]) AND company_id = $2 AND reason NOT ILIKE '%(Sample)%'`, [JUNK_ENCASH_IDS, CO]);
  const { rows: types } = await client.query(
    `SELECT * FROM leave_types WHERE company_id = $1 AND UPPER(leave_code) = ANY($2::text[]) AND is_active = true`, [CO, OFF_CODES]);
  const { rows: drift } = await client.query(`
    SELECT lb.id, lb.employee_id, lb.leave_type_id, lb.year, lb.used_days AS old_used,
           COALESCE((SELECT SUM(number_of_days) FROM leave_applications la
                      WHERE la.employee_id = lb.employee_id AND la.leave_type_id = lb.leave_type_id
                        AND la.status = 'approved' AND EXTRACT(YEAR FROM la.start_date) = lb.year
                        AND la.deleted_at IS NULL AND NOT (la.id = ANY($1::int[]))), 0) AS new_used
      FROM leave_balances lb`, [appIds]);
  const changed = drift.filter(d => Number(d.old_used) !== Number(d.new_used));

  const backup = { taken_at: new Date().toISOString(), applications: apps, approval_history: hist, encashments: enc, leave_types: types, used_days_before: changed };
  const file = path.join(dir, `leaves_cleanup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const text = JSON.stringify(backup, null, 2);
  fs.writeFileSync(file, text);
  fs.writeFileSync(file + '.sha256', crypto.createHash('sha256').update(text).digest('hex') + '  ' + path.basename(file) + '\n');
  console.log('backup:', file);

  await client.query('BEGIN');
  const { rows: [admin] } = await client.query(`
    SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE LOWER(r.code) = 'super_admin' AND u.is_active = TRUE ORDER BY u.id LIMIT 1`);
  const audit = (action, ref, oldData, newData) => client.query(
    `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, old_data_json, new_data_json, company_id)
     VALUES ($1, 'leaves', $2, $3, 'cleanup', $4, $5, $6) RETURNING id`,
    [admin?.id ?? null, action, ref, JSON.stringify(oldData), JSON.stringify(newData), CO]);
  const ids = [];

  if (appIds.length) {
    await client.query('DELETE FROM leave_approval_history WHERE leave_application_id = ANY($1::int[])', [appIds]);
    await client.query(`DELETE FROM attendance_records WHERE source = 'leave_sync' AND employee_id = 1
                          AND attendance_date IN (SELECT generate_series(start_date, end_date, '1 day')::date FROM leave_applications WHERE id = ANY($1::int[]))`, [appIds]);
    await client.query('DELETE FROM leave_applications WHERE id = ANY($1::int[])', [appIds]);
    ids.push((await audit('delete', null, { leave_application_ids: appIds, history_rows: hist.length }, { reason: 'Smoke-test leave applications (Leaves review 2026-11-23)', backup: path.basename(file) })).rows[0].id);
  }
  if (enc.length) {
    await client.query('DELETE FROM leave_encashments WHERE id = ANY($1::int[])', [enc.map(e => e.id)]);
    ids.push((await audit('delete', null, { leave_encashment_ids: enc.map(e => e.id) }, { reason: 'Junk encashment claims (100–200 days, templated reasons)', backup: path.basename(file) })).rows[0].id);
  }
  if (types.length) {
    await client.query('UPDATE leave_types SET is_active = false, updated_at = NOW() WHERE id = ANY($1::int[])', [types.map(t => t.id)]);
    ids.push((await audit('update', null, { active: types.map(t => t.leave_name) }, { is_active: false, reason: 'Not offered by the company (owner 2026-11-11 / WFH removed 2026-11-19). Switch back on in Leave Settings.' })).rows[0].id);
  }
  for (const d of changed) {
    await client.query('UPDATE leave_balances SET used_days = $1, updated_at = NOW() WHERE id = $2', [d.new_used, d.id]);
  }
  if (changed.length) {
    ids.push((await audit('update', null, { used_days: changed.map(d => ({ id: d.id, was: d.old_used })) }, { used_days: 'approved leave in the year', rows: changed.length })).rows[0].id);
  }
  await client.query('COMMIT');
  console.log({ deleted_applications: appIds.length, deleted_history: hist.length, deleted_encashments: enc.length,
    switched_off_types: types.map(t => t.leave_name), used_days_fixed: changed.length, audit_log_ids: ids });
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('FAILED, nothing changed:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
