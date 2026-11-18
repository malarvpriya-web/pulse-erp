/**
 * 20261105000007 — what Payroll Center needs to pay real salaries.
 *
 * payroll_runs            days of the month, the wage ESI was charged on, and the
 *                         employer-only PF charges (EDLI, administration)
 * employee_tax_regime     each employee's regime for a tax year (no row = new regime)
 * payroll_opening_balances salary and tax before Pulse or with a previous employer
 * payroll_statutory_remittances  PF / ESI / PT / LWF paid to the authorities
 * attendance_ot_records.multiplier default 1.5 → 2 (the statutory rate)
 * payroll_loans           the payout of a loan: date, bank reference, journal
 *
 * Nothing existing is rewritten. The runner is a pg shim: placeholders are $n.
 * Rollback: down() drops the new columns and tables and restores the default.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE payroll_runs
      ADD COLUMN IF NOT EXISTS paid_days numeric(5,2),
      ADD COLUMN IF NOT EXISTS working_days numeric(5,2),
      ADD COLUMN IF NOT EXISTS days_in_month integer,
      ADD COLUMN IF NOT EXISTS esi_wage numeric(12,2),
      ADD COLUMN IF NOT EXISTS edli_employer numeric(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS pf_admin_employer numeric(12,2) NOT NULL DEFAULT 0`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS employee_tax_regime (
      id serial PRIMARY KEY,
      employee_id integer NOT NULL REFERENCES employees(id),
      financial_year text NOT NULL,
      regime text NOT NULL CHECK (regime IN ('new', 'old')),
      declared_by integer,
      declared_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (employee_id, financial_year)
    )`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_opening_balances (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      employee_id integer NOT NULL REFERENCES employees(id),
      financial_year text NOT NULL,
      gross numeric(14,2) NOT NULL DEFAULT 0 CHECK (gross >= 0),
      tds numeric(14,2) NOT NULL DEFAULT 0 CHECK (tds >= 0),
      employee_pf numeric(14,2) NOT NULL DEFAULT 0 CHECK (employee_pf >= 0),
      months integer NOT NULL DEFAULT 0 CHECK (months BETWEEN 0 AND 12),
      source text NOT NULL,
      created_by integer,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (employee_id, financial_year)
    )`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_statutory_remittances (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      kind text NOT NULL CHECK (kind IN ('pf', 'esi', 'pt', 'lwf')),
      month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
      year integer NOT NULL,
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      challan_reference text NOT NULL,
      paid_on date NOT NULL,
      journal_entry_id uuid REFERENCES journal_entries(id),
      recorded_by integer,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, kind, month, year)
    )`);
  await knex.raw(`ALTER TABLE attendance_ot_records ALTER COLUMN multiplier SET DEFAULT 2`);
  await knex.raw(`
    ALTER TABLE payroll_loans
      ADD COLUMN IF NOT EXISTS disbursed_on date,
      ADD COLUMN IF NOT EXISTS disbursement_reference text,
      ADD COLUMN IF NOT EXISTS disbursement_journal_id uuid REFERENCES journal_entries(id)`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE payroll_loans DROP COLUMN IF EXISTS disbursement_journal_id, DROP COLUMN IF EXISTS disbursement_reference, DROP COLUMN IF EXISTS disbursed_on`);
  await knex.raw(`ALTER TABLE attendance_ot_records ALTER COLUMN multiplier SET DEFAULT 1.5`);
  await knex.raw(`DROP TABLE IF EXISTS payroll_statutory_remittances`);
  await knex.raw(`DROP TABLE IF EXISTS payroll_opening_balances`);
  await knex.raw(`DROP TABLE IF EXISTS employee_tax_regime`);
  await knex.raw(`
    ALTER TABLE payroll_runs
      DROP COLUMN IF EXISTS paid_days, DROP COLUMN IF EXISTS working_days, DROP COLUMN IF EXISTS days_in_month,
      DROP COLUMN IF EXISTS esi_wage, DROP COLUMN IF EXISTS edli_employer, DROP COLUMN IF EXISTS pf_admin_employer`);
}
