/**
 * 20261020000002 — PF wage on each payroll run.
 *
 * The PF ECR needs the wage PF was actually computed on: Basic raised to 50%
 * of remuneration where the Code on Social Security deeming applies, then
 * capped at the wage ceiling in force for the month (Rs 15,000, Rs 25,000 from
 * 17-Sep-2026). Neither can be re-derived from `basic` afterwards, so the
 * engine's figures are stored with the run. NULL on runs generated before this
 * migration — the ECR refuses those instead of guessing.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS pf_wage NUMERIC(12,2)`);
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS pf_contribution_wage NUMERIC(12,2)`);
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS eps_wage NUMERIC(12,2)`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS eps_wage`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS pf_contribution_wage`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS pf_wage`);
}
