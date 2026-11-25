/**
 * Sample salaries for the "(Sample)" employees (owner, 2026-11-24).
 *
 * EMP040–043 had no Basic on record, so Leave Reports → Leave Liability said
 * "No salary on record" and the LOP report valued their Loss of Pay at ₹0.
 * This gives each a salary, read the way payroll / F&F / encashment read it:
 * an employee_salary_assignments row (Standard Structure) AND the employee
 * master's basic_salary (the fallback before the assignment takes effect —
 * EMP040 joins 17 Dec 2026).
 *
 * EMP041–043 get ₹30,000 — the Basic their sample encashment claims were
 * already valued at (₹1,153.85/day). EMP040 (Power Electronics Engineer) ₹35,000.
 *
 * Only touches employees whose name carries "(Sample)" and that have no salary
 * yet. Idempotent. Audited (audit_logs, reference_type 'sample').
 *
 * Usage (from backend/): node scripts/samples/leaves-sample-salaries-2026-11-24.mjs
 */
import pool from '../../src/config/db.js';

const CO = 1;
const BASIC = { EMP040: 35000, EMP041: 30000, EMP042: 30000, EMP043: 30000 };

const { rows: emps } = await pool.query(
  `SELECT e.id, e.office_id, e.basic_salary, to_char(e.joining_date, 'YYYY-MM-DD') AS joining_date,
          EXISTS (SELECT 1 FROM employee_salary_assignments a WHERE a.employee_id = e.id) AS has_assignment
     FROM employees e
    WHERE e.company_id = $1 AND e.office_id = ANY($2::text[]) AND e.name ILIKE '%(Sample)%'
    ORDER BY e.office_id`, [CO, Object.keys(BASIC)]);

const todo = emps.filter(e => !e.has_assignment && !(Number(e.basic_salary) > 0));
if (!todo.length) { console.log('Sample salaries already present — nothing changed.'); await pool.end(); process.exit(0); }

const { rows: [structure] } = await pool.query(`SELECT id FROM salary_structures WHERE name = 'Standard Structure' ORDER BY id LIMIT 1`);

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows: [admin] } = await client.query(`
    SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE LOWER(r.code) = 'super_admin' AND u.is_active = TRUE ORDER BY u.id LIMIT 1`);
  const auditIds = [];
  for (const e of todo) {
    const basic = BASIC[e.office_id];
    // From the start of the leave year, or joining if later.
    const from = e.joining_date && e.joining_date > '2026-01-01' ? e.joining_date : '2026-01-01';
    const { rows: [a] } = await client.query(
      `INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary, special_allowance, other_components, company_id)
       VALUES ($1, $2, $3, $4, 0, '{}'::jsonb, $5) RETURNING id`,
      [e.id, structure?.id ?? null, from, basic, CO]);
    await client.query(`UPDATE employees SET basic_salary = $2 WHERE id = $1`, [e.id, basic]);
    const { rows: [log] } = await client.query(
      `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, old_data_json, new_data_json, company_id)
       VALUES ($1, 'payroll', 'create', $2, 'sample', $3, $4, $5) RETURNING id`,
      [admin?.id ?? null, String(e.id),
       JSON.stringify({ basic_salary: e.basic_salary }),
       JSON.stringify({ office_id: e.office_id, basic_salary: basic, salary_assignment_id: a.id, effective_from: from,
                        reason: 'Sample salary so Leave Liability / LOP show money (owner, 2026-11-24)' }), CO]);
    auditIds.push(log.id);
    console.log(`${e.office_id}: Basic ₹${basic} from ${from} (assignment ${a.id})`);
  }
  await client.query('COMMIT');
  console.log('audit_logs:', auditIds.join(', '));
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  await pool.end();
}
