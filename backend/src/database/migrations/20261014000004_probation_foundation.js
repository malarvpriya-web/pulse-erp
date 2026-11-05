/**
 * 20261014000004_probation_foundation.js
 *
 * Two additive objects for the probation foundation (shared/probationDates.js).
 * No existing row is read into, rewritten or deleted.
 *
 *   employees.probation_months  SMALLINT NULL, CHECK 1..24
 *       The period an end date was calculated from, so Edit Employee can show
 *       "6 months" rather than only a date. NULL on every existing row and it
 *       STAYS NULL: the end dates already stored were written by the old
 *       90-day rule (or by hand), and labelling them with a month count would
 *       invent a fact. probation_end_date remains the canonical value; this
 *       column is descriptive. All existing rows are NULL, so the CHECK cannot
 *       reject one.
 *
 *   probation_reminder_log
 *       Durable de-duplication for the daily reminder job. One row per
 *       (employee, probation end date, reminder kind), enforced by a UNIQUE
 *       constraint, written in the SAME transaction as the notifications it
 *       stands for. The job used to de-duplicate by looking for a matching
 *       notification row, but notifications are per-recipient, have no
 *       company column and can be deleted by their reader, so "already sent"
 *       was not a stable fact. Keying on the end date means a changed end
 *       date (a corrected or extended probation) is a new reminder, not a
 *       suppressed one.
 *
 * Rollback drops the log (it only suppresses repeats; losing it means the
 * next run may re-send a reminder) and refuses to drop the column while any
 * employee has a probation_months value, naming how many — HR data is never
 * discarded by a rollback.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS probation_months SMALLINT NULL
  `);
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_employees_probation_months') THEN
        ALTER TABLE employees
          ADD CONSTRAINT chk_employees_probation_months
          CHECK (probation_months IS NULL OR probation_months BETWEEN 1 AND 24);
      END IF;
    END $$
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS probation_reminder_log (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      employee_id         INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      probation_end_date  DATE    NOT NULL,
      reminder_kind       VARCHAR(20) NOT NULL
                          CHECK (reminder_kind IN ('due_soon', 'ended')),
      recipient_count     INTEGER NOT NULL DEFAULT 0,
      sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_probation_reminder UNIQUE (employee_id, probation_end_date, reminder_kind)
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_probation_reminder_log_company
      ON probation_reminder_log (company_id, sent_at DESC)
  `);
}

export async function down(knex) {
  const { rows: [{ n }] } = await knex.raw(
    `SELECT COUNT(*)::int AS n FROM employees WHERE probation_months IS NOT NULL`);
  if (n > 0) {
    throw new Error(
      `Refusing to roll back 20261014000004_probation_foundation: ${n} employee(s) have a ` +
      `probation_months value that dropping the column would discard. Clear or export them first.`);
  }
  await knex.raw(`DROP TABLE IF EXISTS probation_reminder_log`);
  await knex.raw(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS chk_employees_probation_months`);
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS probation_months`);
}
