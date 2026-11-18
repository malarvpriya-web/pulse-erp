/**
 * Look up (or delete) a ZZVE test employee by last name.
 *
 * Browser tests that drive the Add Employee form need to know whether a record
 * was actually created — the UI's success dialog is a claim, the row is the
 * fact. Deletion refuses anything not first-named ZZVE, so a mistyped argument
 * cannot remove a real person.
 *
 *   node scripts/zzve-employee-id.mjs <lastName>            -> ZZVE_EMPLOYEE_ID=<id|0>
 *   node scripts/zzve-employee-id.mjs <lastName> --delete   -> ZZVE_EMPLOYEE_REMOVED=<n>
 */
import fs from 'node:fs';

const pool = (await import('../src/config/db.js')).default;
const [, , last, flag] = process.argv;
if (!last) throw new Error('usage: zzve-employee-id.mjs <lastName> [--delete]');

const FILE_COLUMNS = ['photo_url', 'pan_file', 'aadhaar_file', 'cancelled_cheque_file',
                      'bank_statement_file', 'resume_file', 'offer_letter_file'];

const { rows } = await pool.query(
  `SELECT id, first_name, company_email, ${FILE_COLUMNS.join(', ')}
     FROM employees WHERE last_name = $1 ORDER BY id`, [last]);

if (flag === '--delete') {
  let removed = 0;
  for (const r of rows) {
    if (r.first_name !== 'ZZVE') throw new Error(`employee ${r.id} is not a ZZVE fixture — refusing`);
    await pool.query('DELETE FROM users WHERE email = $1', [r.company_email]);
    await pool.query('DELETE FROM employee_salary_assignments WHERE employee_id = $1', [r.id]);
    await pool.query('DELETE FROM hr_onboarding_checklist_progress WHERE employee_id = $1', [r.id]);
    await pool.query('DELETE FROM hr_notes WHERE employee_id = $1', [r.id]);
    await pool.query('DELETE FROM employees WHERE id = $1', [r.id]);
    for (const c of FILE_COLUMNS) if (r[c]) fs.rmSync(`.${r[c]}`, { force: true });
    removed++;
  }
  console.log(`ZZVE_EMPLOYEE_REMOVED=${removed}`);
} else {
  console.log(`ZZVE_EMPLOYEE_ID=${rows[0]?.id ?? 0}`);
}

await pool.end();
