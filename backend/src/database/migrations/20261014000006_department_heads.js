/**
 * 20261014000006_department_heads.js
 *
 * Per-company department → head mapping, the foundation the probation review
 * workflow will route reviews through. One new table; nothing existing is
 * read, changed or backfilled.
 *
 * WHY A COMPANY COLUMN HERE
 *   master_departments is GLOBAL (id, name, is_active — no company_id), and
 *   employees.department is free TEXT matched to it by name. So the mapping
 *   carries its own company_id and points at the shared department by id:
 *   company A and company B can each name a different head for 'Finance', and
 *   renaming the department in Master Data carries the mapping with it.
 *
 * HISTORY
 *   A row is an assignment. Reassigning or removing a head ENDS the current
 *   row (ended_at, ended_by_user_id, end_reason) and, for a reassignment,
 *   inserts the next one — rows are never updated in any other way and never
 *   deleted by the application. The partial unique index allows exactly one
 *   ACTIVE row per (company, department) and any number of ended ones, so two
 *   simultaneous reassignments cannot both win.
 *
 * KEYS
 *   company     ON DELETE CASCADE  — a deleted company takes its mappings.
 *   department  ON DELETE RESTRICT — a department with assignment history
 *                                    cannot be hard-deleted from the master
 *                                    (Master Data deactivates instead).
 *   employee    ON DELETE RESTRICT — history must not lose its head.
 *
 * ROLLBACK refuses while any assignment row exists (HR data), naming how
 * many; otherwise it drops the table.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS department_heads (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      department_id       INTEGER NOT NULL REFERENCES master_departments(id) ON DELETE RESTRICT,
      head_employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      assigned_by_user_id INTEGER REFERENCES users(id),
      assigned_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at            TIMESTAMPTZ,
      ended_by_user_id    INTEGER REFERENCES users(id),
      end_reason          TEXT,
      CONSTRAINT chk_department_heads_end
        CHECK ((ended_at IS NULL) = (ended_by_user_id IS NULL))
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_department_heads_active
      ON department_heads (company_id, department_id) WHERE ended_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_department_heads_head
      ON department_heads (head_employee_id) WHERE ended_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_department_heads_history
      ON department_heads (company_id, department_id, assigned_at DESC)
  `);
}

export async function down(knex) {
  const { rows: [{ n }] } = await knex.raw(`SELECT COUNT(*)::int AS n FROM department_heads`);
  if (n > 0) {
    throw new Error(
      `Refusing to roll back 20261014000006_department_heads: ${n} assignment row(s) exist. ` +
      `They are HR records — export or remove them deliberately first.`);
  }
  await knex.raw(`DROP TABLE IF EXISTS department_heads`);
}
