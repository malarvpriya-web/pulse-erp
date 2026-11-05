/**
 * 20260930000002 — make the salary-assignment upsert possible at all.
 *
 * `POST /salary-structures/:id/assign` is the ONLY screen-backed way to record
 * an employee's salary (HR → Salary Structure → Assign). It has never worked.
 * Its statement fails twice over against the live table:
 *
 *   1. `DO UPDATE SET ... updated_at = NOW()` — there is no `updated_at`
 *      column. The original DDL (20260424000002) created this table with
 *      id / employee_id / salary_structure_id / effective_date / basic_salary /
 *      created_at, and the columns the code uses now were bolted on later
 *      without it.
 *   2. `ON CONFLICT (employee_id, structure_id, effective_from)` — there is no
 *      unique constraint or index on those columns. The only unique index on
 *      the table is the primary key on `id`.
 *
 * Either one alone is a hard error, so every attempt to save a salary returned
 * 500. Measured on 2026-09-30: of 85 rows in this table, **83 hold exactly the
 * `basic_salary` column default of 30000 with zero allowance and zero
 * deductions** — the value `addEmployee`'s auto-enrolment leaves behind when
 * nobody can enter a real one. The two exceptions came in through the increment
 * and hire paths, which INSERT without ON CONFLICT and therefore never hit
 * either fault.
 *
 * ── Why (employee_id, effective_from) and not the three columns the code named
 *
 * The handler's key includes `structure_id`, which would let one employee hold
 * two different salaries effective the same day as long as they sat under
 * different structures. That is not a revision history, it is a contradiction,
 * and the View Employee → History table would render both rows for one date.
 *
 * The structure is an ATTRIBUTE of an assignment, not part of its identity:
 * re-assigning someone on a date they already have is a correction to that
 * revision. So the key is (employee_id, effective_from) and `structure_id`
 * becomes one of the fields the upsert overwrites.
 *
 * `structure_id` is also nullable, and NULL never conflicts with NULL in a
 * btree — a three-column key including it would silently stop deduplicating for
 * exactly the rows that have no structure.
 *
 * Verified before writing this: 0 duplicate (employee_id, effective_from)
 * pairs and 0 NULL structure_ids, so the index builds without a pre-pass. The
 * guard below reports any that appear rather than failing on a bare index-build
 * error.
 */

const UNIQ = 'employee_salary_assignments_emp_effective_uniq';

export async function up(knex) {
  // NOT NULL with a default backfills every existing row in one pass; these are
  // salary records, so "never updated" is honestly represented by the creation
  // time rather than by NULL.
  await knex.raw(`
    ALTER TABLE employee_salary_assignments
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()
  `);

  const { rows: dupes } = await knex.raw(`
    SELECT employee_id, effective_from, COUNT(*)::int AS n
      FROM employee_salary_assignments
     GROUP BY 1, 2
    HAVING COUNT(*) > 1
     ORDER BY n DESC`);
  if (dupes.length) {
    const detail = dupes
      .map(d => `employee ${d.employee_id} on ${String(d.effective_from).slice(0, 10)} x${d.n}`)
      .join('; ');
    throw new Error(
      `Cannot add ${UNIQ}: an employee already has more than one salary assignment ` +
      `effective the same date — ${detail}. Decide which figure is correct and ` +
      `remove the others, then re-run.`,
    );
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQ}
        ON employee_salary_assignments (employee_id, effective_from)`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${UNIQ}`);
  await knex.raw(`ALTER TABLE employee_salary_assignments DROP COLUMN IF EXISTS updated_at`);
}
