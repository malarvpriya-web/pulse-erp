/**
 * 20261020000001 — payroll data-flow audit controls (PAYROLL_DATA_FLOW_AUDIT.md).
 *
 * Schema only, plus FLAGGING of rows that are demonstrably test data. No salary,
 * tax or loan amount is changed by this migration.
 *
 *  1. payroll_statutory_rules — effective-dated statutory parameters added at
 *     runtime (built-in versions live in modules/payroll/statutoryRules.js).
 *  2. payroll_runs.is_test / validation_issues — statutory outputs (Form 138 /
 *     24Q, Form 16, ECR) exclude is_test rows. Flagged:
 *       · period_label LIKE 'SEED%'  — 5 rows (Jan–May 2026, gross ₹100–₹200
 *         with TDS 18× gross, status 'active'), two of them in Q1 FY 2026-27;
 *       · employee_id IS NULL        — 12 rows left by a deleted test employee
 *         (Nov-2026 / May-2027 / May-2028), which belong to nobody.
 *     Then a status vocabulary CHECK, NOT VALID so the grandfathered 'active'
 *     seed rows stay readable while every NEW write is checked.
 *  3. payroll_loans.is_test — flagged where emi_schedule carries the seeder's
 *     {"seed":"SEED"} marker (5 rows, EMI = full principal).
 *  4. payroll_loan_repayments — one row per loan per payroll month, written at
 *     approval. Nothing ever reduced outstanding_balance before, so an EMI
 *     recurred every month forever and no loan closed on its own.
 *  5. payroll_arrears — PF differentials and the run that paid it; is_test where
 *     old_basic = new_basic with a non-zero amount (an arrear with no basic
 *     change cannot exist; all 5 current rows).
 *  6. employee_salary_assignments.basic_salary loses its DEFAULT 30000. A
 *     column default is not a salary: Add Employee's "no salary entered" branch
 *     relied on it, so a blank form wrote ₹30,000 that payroll then paid.
 *     Existing rows are NOT touched — which of them are real 30000s cannot be
 *     told from the data; they are listed in the audit report instead.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_statutory_rules (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      rule_key         VARCHAR(60)  NOT NULL,
      effective_from   DATE         NOT NULL,
      value            JSONB        NOT NULL,
      source_reference TEXT         NOT NULL CHECK (length(btrim(source_reference)) > 0),
      created_by       INTEGER,
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS payroll_statutory_rules_version_uniq
      ON payroll_statutory_rules (COALESCE(company_id, 0), rule_key, effective_from)
  `);

  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false`);
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS validation_issues JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS arrears_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await knex.raw(`
    UPDATE payroll_runs SET is_test = true
     WHERE is_test = false AND (period_label LIKE 'SEED%' OR employee_id IS NULL)
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_status_vocab') THEN
        ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_status_vocab
          CHECK (status IN ('draft', 'pending', 'approved', 'paid', 'on_hold')) NOT VALID;
      END IF;
    END $$
  `);

  await knex.raw(`ALTER TABLE payroll_loans ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false`);
  await knex.raw(`UPDATE payroll_loans SET is_test = true WHERE is_test = false AND emi_schedule->>'seed' = 'SEED'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_loan_repayments (
      id              SERIAL PRIMARY KEY,
      loan_id         INTEGER NOT NULL REFERENCES payroll_loans(id) ON DELETE CASCADE,
      payroll_run_id  INTEGER REFERENCES payroll_runs(id) ON DELETE SET NULL,
      month           INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
      year            INTEGER NOT NULL,
      amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      balance_after   NUMERIC(12,2) NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (loan_id, month, year)
    )
  `);

  await knex.raw(`ALTER TABLE payroll_arrears ADD COLUMN IF NOT EXISTS employee_pf_diff NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await knex.raw(`ALTER TABLE payroll_arrears ADD COLUMN IF NOT EXISTS employer_pf_diff NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await knex.raw(`ALTER TABLE payroll_arrears ADD COLUMN IF NOT EXISTS paid_run_id INTEGER REFERENCES payroll_runs(id) ON DELETE SET NULL`);
  await knex.raw(`ALTER TABLE payroll_arrears ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false`);
  await knex.raw(`
    UPDATE payroll_arrears SET is_test = true
     WHERE is_test = false AND old_basic = new_basic AND arrear_amount > 0
  `);

  await knex.raw(`ALTER TABLE employee_salary_assignments ALTER COLUMN basic_salary DROP DEFAULT`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employee_salary_assignments ALTER COLUMN basic_salary SET DEFAULT 30000`);
  await knex.raw(`ALTER TABLE payroll_arrears DROP COLUMN IF EXISTS is_test`);
  await knex.raw(`ALTER TABLE payroll_arrears DROP COLUMN IF EXISTS paid_run_id`);
  await knex.raw(`ALTER TABLE payroll_arrears DROP COLUMN IF EXISTS employer_pf_diff`);
  await knex.raw(`ALTER TABLE payroll_arrears DROP COLUMN IF EXISTS employee_pf_diff`);
  await knex.raw(`DROP TABLE IF EXISTS payroll_loan_repayments`);
  await knex.raw(`ALTER TABLE payroll_loans DROP COLUMN IF EXISTS is_test`);
  await knex.raw(`ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_status_vocab`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS arrears_amount`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS validation_issues`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS is_test`);
  await knex.raw(`DROP TABLE IF EXISTS payroll_statutory_rules`);
}
