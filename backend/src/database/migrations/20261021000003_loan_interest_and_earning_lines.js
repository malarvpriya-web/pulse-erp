/**
 * 20261021000003 — loan interest/closure and itemised payslip earnings.
 * PAYROLL_DATA_FLOW_AUDIT.md Part 11. Additive; no existing value changes.
 *
 * payroll_loans
 *   interest_rate      annual %, reducing balance. Existing loans: 0 (the
 *                      server never stored a rate — they were interest-free).
 *   tenure_months      installments in the schedule at creation.
 *   single_installment the creator confirmed a one-month recovery.
 *   closed_at / closure_type / closure_note / closed_by
 *                      how a loan ended: repaid (by payroll), prepaid, waived.
 *                      "Close" used to set outstanding to 0 with no record.
 * payroll_loan_repayments
 *   source             payroll | prepayment | waiver. The one-per-month rule
 *                      now applies to PAYROLL recoveries only, so a prepayment
 *                      can be recorded in a month that also has a deduction.
 *   interest_component / principal_component / reference / recorded_by
 * payroll_runs
 *   earning_lines      every structure earning of the month as computed. The
 *                      payslip listed only 5 fixed columns, so any other
 *                      component (e.g. LTA in "Senior Management") was in gross
 *                      but on no line. NULL on rows generated before this.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE payroll_loans
      ADD COLUMN IF NOT EXISTS interest_rate NUMERIC(6,3) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tenure_months INTEGER,
      ADD COLUMN IF NOT EXISTS single_installment BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS closure_type VARCHAR(20),
      ADD COLUMN IF NOT EXISTS closure_note TEXT,
      ADD COLUMN IF NOT EXISTS closed_by INTEGER`);
  await knex.raw(`
    ALTER TABLE payroll_loan_repayments
      ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'payroll',
      ADD COLUMN IF NOT EXISTS interest_component NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS principal_component NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS reference TEXT,
      ADD COLUMN IF NOT EXISTS recorded_by INTEGER`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_loan_repayments_source_check') THEN
        ALTER TABLE payroll_loan_repayments ADD CONSTRAINT payroll_loan_repayments_source_check
          CHECK (source IN ('payroll', 'prepayment', 'waiver'));
      END IF;
    END $$`);
  await knex.raw(`ALTER TABLE payroll_loan_repayments DROP CONSTRAINT IF EXISTS payroll_loan_repayments_loan_id_month_year_key`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_loan_repayment_payroll_month
      ON payroll_loan_repayments (loan_id, month, year) WHERE source = 'payroll'`);
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS earning_lines JSONB`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS earning_lines`);
  await knex.raw(`DROP INDEX IF EXISTS uq_loan_repayment_payroll_month`);
  await knex.raw(`ALTER TABLE payroll_loan_repayments DROP CONSTRAINT IF EXISTS payroll_loan_repayments_source_check`);
  await knex.raw(`
    ALTER TABLE payroll_loan_repayments
      DROP COLUMN IF EXISTS source, DROP COLUMN IF EXISTS interest_component,
      DROP COLUMN IF EXISTS principal_component, DROP COLUMN IF EXISTS reference, DROP COLUMN IF EXISTS recorded_by`);
  await knex.raw(`ALTER TABLE payroll_loan_repayments ADD CONSTRAINT payroll_loan_repayments_loan_id_month_year_key UNIQUE (loan_id, month, year)`);
  await knex.raw(`
    ALTER TABLE payroll_loans
      DROP COLUMN IF EXISTS interest_rate, DROP COLUMN IF EXISTS tenure_months, DROP COLUMN IF EXISTS single_installment,
      DROP COLUMN IF EXISTS closed_at, DROP COLUMN IF EXISTS closure_type, DROP COLUMN IF EXISTS closure_note, DROP COLUMN IF EXISTS closed_by`);
}
