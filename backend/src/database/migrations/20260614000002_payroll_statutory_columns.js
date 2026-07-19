/**
 * Migration: 20260614000002_payroll_statutory_columns
 * Adds EPS/EPF split columns and LWF columns to payroll_runs.
 * EPS = 8.33% employer contribution routed to Employees' Pension Scheme
 * EPF employer = 3.67% routed to EPF account (total employer = 12%)
 * LWF = Labour Welfare Fund (state-specific, employee + employer share)
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS eps           NUMERIC(12,2) DEFAULT 0`);
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS epf_employer  NUMERIC(12,2) DEFAULT 0`);
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS lwf_employee  NUMERIC(12,2) DEFAULT 0`);
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS lwf_employer  NUMERIC(12,2) DEFAULT 0`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS eps`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS epf_employer`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS lwf_employee`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS lwf_employer`);
}
