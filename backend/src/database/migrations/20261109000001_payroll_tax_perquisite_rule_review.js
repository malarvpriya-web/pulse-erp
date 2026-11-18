/**
 * 20261109000001 — surcharge, loan perquisites, the Form 138 salary details,
 * a second person for statutory-rule changes, and absence after the cutoff day.
 *
 * payroll_runs                    perquisite_value (taxable, not paid), annual_surcharge,
 *                                 annual_cess, lop_carried_days, lop_carried_amount
 * payroll_loans.purpose           'general' | 'medical' (medical loans carry no perquisite)
 * payroll_attendance_summary      counted_to (last day the sync counted), carried_lop_days /
 *                                 carried_base_days (absence after last month's cutoff),
 *                                 carried_to_next (last month's days were carried — a later
 *                                 re-sync of that month must not count them again)
 * payroll_statutory_rule_changes  a rule version proposed by one person, applied only when
 *                                 a different authorised person confirms it
 *
 * Nothing existing is rewritten. The runner is a pg shim: placeholders are $n.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE payroll_runs
      ADD COLUMN IF NOT EXISTS perquisite_value numeric(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS annual_surcharge numeric(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS annual_cess numeric(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lop_carried_days numeric(5,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lop_carried_amount numeric(12,2) NOT NULL DEFAULT 0`);
  await knex.raw(`
    ALTER TABLE payroll_loans
      ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'general' CHECK (purpose IN ('general', 'medical'))`);
  await knex.raw(`
    ALTER TABLE payroll_attendance_summary
      ADD COLUMN IF NOT EXISTS counted_to date,
      ADD COLUMN IF NOT EXISTS carried_lop_days numeric(5,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS carried_base_days numeric(5,2),
      ADD COLUMN IF NOT EXISTS carried_to_next boolean NOT NULL DEFAULT false`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_statutory_rule_changes (
      id serial PRIMARY KEY,
      company_id integer,
      scope text NOT NULL DEFAULT 'company' CHECK (scope IN ('company', 'global')),
      rule_key text NOT NULL,
      effective_from date NOT NULL,
      value jsonb NOT NULL,
      source_reference text NOT NULL,
      proposed_by integer,
      proposed_at timestamptz NOT NULL DEFAULT NOW(),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
      decided_by integer,
      decided_at timestamptz,
      decision_note text,
      applied_rule_id integer
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_rule_changes_pending ON payroll_statutory_rule_changes (company_id) WHERE status = 'pending'`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS payroll_statutory_rule_changes`);
  await knex.raw(`ALTER TABLE payroll_attendance_summary DROP COLUMN IF EXISTS counted_to, DROP COLUMN IF EXISTS carried_lop_days, DROP COLUMN IF EXISTS carried_base_days, DROP COLUMN IF EXISTS carried_to_next`);
  await knex.raw(`ALTER TABLE payroll_loans DROP COLUMN IF EXISTS purpose`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS perquisite_value, DROP COLUMN IF EXISTS annual_surcharge, DROP COLUMN IF EXISTS annual_cess, DROP COLUMN IF EXISTS lop_carried_days, DROP COLUMN IF EXISTS lop_carried_amount`);
}
