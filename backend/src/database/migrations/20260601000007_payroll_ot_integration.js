/**
 * 20260601000007_payroll_ot_integration.js
 *
 * Adds overtime_pay and overtime_hours columns to payroll_runs so that
 * approved OT from attendance_ot_records flows through payroll generation
 * and is persisted on each payroll run row.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE payroll_runs
      ADD COLUMN IF NOT EXISTS overtime_hours NUMERIC(8,2)  NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS overtime_pay   NUMERIC(12,2) NOT NULL DEFAULT 0
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE payroll_runs
      DROP COLUMN IF EXISTS overtime_hours,
      DROP COLUMN IF EXISTS overtime_pay
  `);
}
