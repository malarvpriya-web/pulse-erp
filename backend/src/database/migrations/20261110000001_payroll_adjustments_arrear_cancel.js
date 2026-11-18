/**
 * 20261110000001 — one-time payroll adjustments, cancelling an arrear, and the
 * night-shift allowance on the saved run (manual §261).
 *
 * payroll_adjustments   an amount for ONE employee in ONE wage month, entered by HR:
 *                       kind 'earning'   (incentive, reimbursement paid through pay…):
 *                                        part of gross, taxed in that month, counted in
 *                                        "all remuneration" for the PF/ESI wage
 *                       kind 'deduction' (canteen, fine, notice-pay recovery…): taken
 *                                        from net pay and credited, in the approval
 *                                        journal, to account_code (required)
 *                       Generate Payroll picks up the month's rows; once that month's
 *                       payroll is approved for the employee they cannot be changed.
 * payroll_runs          other_earnings, other_deductions, adjustment_lines (the rows
 *                       used, as computed), night_shift_allowance (was computed into
 *                       gross but never stored, so an issued payslip left it off)
 * payroll_arrears       cancelled_by / cancelled_at / cancel_reason (status 'cancelled')
 *
 * Nothing existing is rewritten. The runner is a pg shim: placeholders are $n.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_adjustments (
      id serial PRIMARY KEY,
      company_id integer NOT NULL REFERENCES companies(id),
      employee_id integer NOT NULL REFERENCES employees(id),
      month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
      year integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
      kind text NOT NULL CHECK (kind IN ('earning', 'deduction')),
      label text NOT NULL CHECK (length(trim(label)) > 0),
      amount numeric(12,2) NOT NULL CHECK (amount > 0),
      account_code text,
      reason text,
      created_by integer,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      is_test boolean NOT NULL DEFAULT false,
      CONSTRAINT payroll_adjustments_deduction_account CHECK (kind = 'earning' OR account_code IS NOT NULL)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_payroll_adjustments_period ON payroll_adjustments (company_id, year, month)`);
  await knex.raw(`
    ALTER TABLE payroll_runs
      ADD COLUMN IF NOT EXISTS other_earnings numeric(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS other_deductions numeric(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS adjustment_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS night_shift_allowance numeric(12,2) NOT NULL DEFAULT 0`);
  await knex.raw(`
    ALTER TABLE payroll_arrears
      ADD COLUMN IF NOT EXISTS cancelled_by integer,
      ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
      ADD COLUMN IF NOT EXISTS cancel_reason text`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE payroll_arrears DROP COLUMN IF EXISTS cancelled_by, DROP COLUMN IF EXISTS cancelled_at, DROP COLUMN IF EXISTS cancel_reason`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS other_earnings, DROP COLUMN IF EXISTS other_deductions, DROP COLUMN IF EXISTS adjustment_lines, DROP COLUMN IF EXISTS night_shift_allowance`);
  await knex.raw(`DROP TABLE IF EXISTS payroll_adjustments`);
}
