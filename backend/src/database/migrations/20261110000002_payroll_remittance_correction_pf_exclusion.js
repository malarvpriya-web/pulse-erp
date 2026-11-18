/**
 * 20261110000002 — correcting a recorded statutory payment, and employees
 * excluded from PF (manual §262).
 *
 * payroll_statutory_remittances  cancelled_at / cancelled_by / cancel_reason /
 *                                reversal_journal_id. A wrong record (wrong challan,
 *                                wrong date) is cancelled: its payment journal is
 *                                reversed and the levy shows as due again, so the
 *                                right payment can be recorded. The cancelled row
 *                                stays as history, so "one record per levy and
 *                                month" now holds for live rows only.
 * payroll_pf_exclusions          an employee who is NOT a PF member: an "excluded
 *                                employee" under EPF Scheme para 2(f) — PF wages above
 *                                the ceiling when they joined, and never a member
 *                                before (no UAN). Recorded from their Form 11
 *                                declaration; payroll deducts no PF from
 *                                effective_from. Ending it (the employee joins PF)
 *                                keeps the row.
 *
 * The runner is a pg shim: placeholders are $n.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE payroll_statutory_remittances
      ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
      ADD COLUMN IF NOT EXISTS cancelled_by integer,
      ADD COLUMN IF NOT EXISTS cancel_reason text,
      ADD COLUMN IF NOT EXISTS reversal_journal_id uuid REFERENCES journal_entries(id)`);
  await knex.raw(`ALTER TABLE payroll_statutory_remittances DROP CONSTRAINT IF EXISTS payroll_statutory_remittances_company_id_kind_month_year_key`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS payroll_statutory_remittances_live_uq
      ON payroll_statutory_remittances (company_id, kind, month, year) WHERE cancelled_at IS NULL`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_pf_exclusions (
      id serial PRIMARY KEY,
      company_id integer NOT NULL REFERENCES companies(id),
      employee_id integer NOT NULL REFERENCES employees(id),
      effective_from date NOT NULL,
      declaration_reference text NOT NULL CHECK (length(trim(declaration_reference)) > 0),
      reason text,
      recorded_by integer,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      ended_on date,
      ended_by integer,
      end_reason text,
      CHECK (ended_on IS NULL OR ended_on >= effective_from)
    )`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS payroll_pf_exclusions_open_uq
      ON payroll_pf_exclusions (employee_id) WHERE ended_on IS NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS payroll_pf_exclusions`);
  await knex.raw(`DROP INDEX IF EXISTS payroll_statutory_remittances_live_uq`);
  await knex.raw(`
    ALTER TABLE payroll_statutory_remittances
      DROP COLUMN IF EXISTS reversal_journal_id, DROP COLUMN IF EXISTS cancel_reason,
      DROP COLUMN IF EXISTS cancelled_by, DROP COLUMN IF EXISTS cancelled_at`);
}
