/**
 * 20260518000001_payroll_stabilization.js
 *
 * Fixes payroll_runs schema so per-employee rows can be inserted:
 *  1. Drops the UNIQUE constraint on period_label (blocks multi-row inserts)
 *  2. Makes period_label nullable
 *  3. Adds partial UNIQUE index on (employee_id, month, year) — the real PK for per-employee payroll
 *  4. Creates payslip_email_log table (referenced by emailPayslip controller)
 */

export async function up(knex) {
  // 1. Drop the UNIQUE constraint on period_label so multiple employees
  //    can share the same period (e.g. "May 2026").
  await knex.raw(`
    DO $$
    DECLARE
      cname TEXT;
    BEGIN
      SELECT conname INTO cname
        FROM pg_constraint
       WHERE conrelid = 'payroll_runs'::regclass
         AND contype  = 'u'
         AND conkey   = ARRAY(
               SELECT attnum FROM pg_attribute
               WHERE attrelid = 'payroll_runs'::regclass
                 AND attname  = 'period_label'
             );
      IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE payroll_runs DROP CONSTRAINT %I', cname);
      END IF;
    END$$;
  `);

  // 2. Make period_label nullable (was NOT NULL in the original migration).
  await knex.raw(`
    ALTER TABLE payroll_runs
      ALTER COLUMN period_label DROP NOT NULL
  `);

  // 3. Add partial UNIQUE index — one payroll row per employee per month/year.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_runs_emp_month_year
      ON payroll_runs (employee_id, month, year)
      WHERE employee_id IS NOT NULL
        AND month       IS NOT NULL
        AND year        IS NOT NULL
  `);

  // 4. payslip_email_log — tracks email dispatch for payslips.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payslip_email_log (
      id          SERIAL      PRIMARY KEY,
      employee_id INTEGER     REFERENCES employees(id) ON DELETE CASCADE,
      month       INTEGER     NOT NULL,
      year        INTEGER     NOT NULL,
      sent_to     VARCHAR(200),
      sent_at     TIMESTAMPTZ DEFAULT NOW(),
      status      VARCHAR(20) DEFAULT 'sent',
      UNIQUE (employee_id, month, year)
    )
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS payslip_email_log`);
  await knex.raw(`DROP INDEX IF EXISTS uq_payroll_runs_emp_month_year`);
  // Re-adding the NOT NULL + UNIQUE on period_label is intentionally omitted
  // because rolling back would corrupt any data already written.
}
