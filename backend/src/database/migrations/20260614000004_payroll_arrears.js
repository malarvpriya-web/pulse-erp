/**
 * Migration: 20260614000004_payroll_arrears
 * Creates payroll_arrears table for salary revision back-pay and retro pay.
 * Arrears arise when: salary is revised mid-year, and previous months need to be topped up.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_arrears (
      id              SERIAL PRIMARY KEY,
      employee_id     INTEGER       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      company_id      INTEGER,
      arrear_type     VARCHAR(30)   NOT NULL DEFAULT 'salary_revision',
      from_month      INTEGER       NOT NULL,
      from_year       INTEGER       NOT NULL,
      to_month        INTEGER       NOT NULL,
      to_year         INTEGER       NOT NULL,
      old_basic       NUMERIC(12,2) NOT NULL,
      new_basic       NUMERIC(12,2) NOT NULL,
      arrear_amount   NUMERIC(12,2) NOT NULL,
      tds_on_arrear   NUMERIC(12,2) NOT NULL DEFAULT 0,
      net_arrear      NUMERIC(12,2) NOT NULL,
      reason          TEXT,
      status          VARCHAR(20)   NOT NULL DEFAULT 'pending',
      approved_by     INTEGER,
      approved_at     TIMESTAMPTZ,
      paid_in_month   INTEGER,
      paid_in_year    INTEGER,
      created_by      INTEGER,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_payroll_arrears_employee ON payroll_arrears(employee_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_payroll_arrears_company  ON payroll_arrears(company_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS payroll_arrears CASCADE`);
}
