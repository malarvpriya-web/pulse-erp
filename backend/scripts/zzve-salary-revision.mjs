/**
 * Give a ZZVE test employee two salary revisions: one already in force and one
 * dated a year out, so the History tab's CURRENT / SCHEDULED split has
 * something real to render.
 *
 * Dates are relative to today — a fixture pinned to a literal year silently
 * stops testing anything the moment that year arrives.
 *
 *   node scripts/zzve-salary-revision.mjs <employeeId>
 */
const pool = (await import('../src/config/db.js')).default;
const [, , id] = process.argv;

const { rows: [emp] } = await pool.query(
  'SELECT id, first_name FROM employees WHERE id = $1', [id]);
if (!emp) throw new Error(`employee ${id} not found`);
if (emp.first_name !== 'ZZVE') throw new Error(`employee ${id} is not a ZZVE fixture — refusing`);

const { rows: [struct] } = await pool.query('SELECT id FROM salary_structures LIMIT 1');
const iso = (d) => d.toISOString().slice(0, 10);
const past   = new Date(); past.setFullYear(past.getFullYear() - 1);
const future = new Date(); future.setFullYear(future.getFullYear() + 1);

// Replace whatever the hire left behind, so the row count is predictable.
await pool.query('DELETE FROM employee_salary_assignments WHERE employee_id = $1', [id]);
for (const [from, basic, allow] of [[iso(past), 64000, 6000], [iso(future), 75000, 8000]]) {
  await pool.query(
    `INSERT INTO employee_salary_assignments
       (employee_id, structure_id, effective_from, basic_salary, special_allowance)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (employee_id, effective_from) DO UPDATE SET
       basic_salary = EXCLUDED.basic_salary, special_allowance = EXCLUDED.special_allowance`,
    [id, struct?.id ?? null, from, basic, allow]);
}
console.log(`ZZVE_REVISIONS=${iso(past)},${iso(future)}`);
await pool.end();
