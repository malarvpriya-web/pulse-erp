/**
 * 20260531000004_company_settings.js
 *
 * 1. company_settings — persists ModuleSettingsPanel JSON config per company.
 *    Uses company_id = 0 for single-tenant / no-company-scope installs.
 *
 * 2. payroll_runs breakdown columns — basic, hra, conveyance_allowance,
 *    medical_allowance, special_allowance, lop_days, bonus, loan_deduction,
 *    advance_deduction. Referenced by getPayslipByQuery (already reads them
 *    with || 0 fallback); this migration adds them so save-slip can write them.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS company_settings (
      id         SERIAL        PRIMARY KEY,
      company_id INTEGER       NOT NULL DEFAULT 0,
      module     VARCHAR(100)  NOT NULL,
      settings   JSONB         NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, module)
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_company_settings_lookup
    ON company_settings(company_id, module)
  `);

  await knex.raw(`
    ALTER TABLE payroll_runs
      ADD COLUMN IF NOT EXISTS basic                NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS hra                  NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS conveyance_allowance NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS medical_allowance    NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS special_allowance    NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lop_days             NUMERIC(5,2)  DEFAULT 0,
      ADD COLUMN IF NOT EXISTS bonus                NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS loan_deduction       NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS advance_deduction    NUMERIC(12,2) DEFAULT 0
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS company_settings CASCADE');
  await knex.raw(`
    ALTER TABLE payroll_runs
      DROP COLUMN IF EXISTS basic,
      DROP COLUMN IF EXISTS hra,
      DROP COLUMN IF EXISTS conveyance_allowance,
      DROP COLUMN IF EXISTS medical_allowance,
      DROP COLUMN IF EXISTS special_allowance,
      DROP COLUMN IF EXISTS lop_days,
      DROP COLUMN IF EXISTS bonus,
      DROP COLUMN IF EXISTS loan_deduction,
      DROP COLUMN IF EXISTS advance_deduction
  `);
}
