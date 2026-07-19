/**
 * Migration: 20260614000003_payroll_approval
 * Adds approval workflow columns to payroll_runs.
 * Flow: pending → approved (Finance Head) → paid
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approved_by  INTEGER REFERENCES users(id)`);
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS approved_by`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS approved_at`);
}
