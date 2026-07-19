// backend/src/database/migrations/20260506000007_tds_lower_deduction.js
// Adds Section 197 lower-deduction certificate fields to tds_deductees,
// and adds an employee_id FK so salary TDS (192) can reference HR records.

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE tds_deductees
      ADD COLUMN IF NOT EXISTS lower_deduction_cert_number VARCHAR(50),
      ADD COLUMN IF NOT EXISTS lower_deduction_rate        NUMERIC(5,2),
      ADD COLUMN IF NOT EXISTS lower_deduction_valid_from  DATE,
      ADD COLUMN IF NOT EXISTS lower_deduction_valid_to    DATE,
      ADD COLUMN IF NOT EXISTS employee_id                 INT REFERENCES employees(id) ON DELETE SET NULL
  `);

  // Unique index: one deductee row per employee for Section 192
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tds_deductees_employee
      ON tds_deductees (employee_id)
      WHERE employee_id IS NOT NULL
  `);

  // Add employee_id to tds_transactions as well (salary payment linkage)
  await knex.raw(`
    ALTER TABLE tds_transactions
      ADD COLUMN IF NOT EXISTS employee_id INT REFERENCES employees(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS payroll_month INT,
      ADD COLUMN IF NOT EXISTS payroll_year  INT
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS uq_tds_deductees_employee`);
  await knex.raw(`
    ALTER TABLE tds_transactions
      DROP COLUMN IF EXISTS employee_id,
      DROP COLUMN IF EXISTS payroll_month,
      DROP COLUMN IF EXISTS payroll_year
  `);
  await knex.raw(`
    ALTER TABLE tds_deductees
      DROP COLUMN IF EXISTS lower_deduction_cert_number,
      DROP COLUMN IF EXISTS lower_deduction_rate,
      DROP COLUMN IF EXISTS lower_deduction_valid_from,
      DROP COLUMN IF EXISTS lower_deduction_valid_to,
      DROP COLUMN IF EXISTS employee_id
  `);
}
