/**
 * 20260930000001_hr_notes_tenant_and_author.js
 *
 * `hr_notes` is the store behind the Notes tab of View Employee. It was created
 * with four columns — id, employee_id, note_text, created_at — and that is the
 * whole of it. Two consequences, both verified live on 2026-09-30:
 *
 * 1. NO TENANT COLUMN. The service reads and writes by employee_id alone, so
 *    `GET /notes/1` returned company 1's HR notes to an admin of company 1497,
 *    and `POST /notes {employeeId: 1}` from that same admin inserted a note
 *    against another tenant's employee — 201, no error. The employees module
 *    itself already refuses this (GET /employees/1 as that admin is a 404), so
 *    notes were the one door left open on the record.
 *
 * 2. NO AUTHOR. An HR note is a personnel record; "who wrote this" is not
 *    decoration. The tab could only ever render a timestamp and a body.
 *
 * Both columns are added nullable, because this table already holds rows that
 * predate them and there is no honest value to invent for `created_by` on a
 * note written before anyone recorded an author. `company_id` IS backfillable —
 * every note belongs to exactly one employee and every employee to exactly one
 * company — so it is derived rather than guessed, and only then indexed.
 *
 * No NOT NULL on company_id: the backfill below covers every current row, but a
 * NOT NULL would also reject any future insert whose employee has a NULL
 * company_id (some legacy employee rows do), turning a scoping improvement into
 * a write failure. The service supplies it on every new note; the column is the
 * record of it, not the enforcement of it.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE hr_notes
      ADD COLUMN IF NOT EXISTS company_id integer REFERENCES companies(id),
      ADD COLUMN IF NOT EXISTS created_by integer REFERENCES users(id)
  `);

  // Derive the tenant from the employee the note is already attached to. This
  // is the only source of truth available and it is exact — hr_notes.employee_id
  // is a real FK to employees.
  await knex.raw(`
    UPDATE hr_notes n
       SET company_id = e.company_id
      FROM employees e
     WHERE e.id = n.employee_id
       AND n.company_id IS DISTINCT FROM e.company_id
       AND e.company_id IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_hr_notes_employee
        ON hr_notes (employee_id, created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_hr_notes_company
        ON hr_notes (company_id)
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_hr_notes_company`);
  await knex.raw(`DROP INDEX IF EXISTS idx_hr_notes_employee`);
  await knex.raw(`
    ALTER TABLE hr_notes
      DROP COLUMN IF EXISTS created_by,
      DROP COLUMN IF EXISTS company_id
  `);
}
