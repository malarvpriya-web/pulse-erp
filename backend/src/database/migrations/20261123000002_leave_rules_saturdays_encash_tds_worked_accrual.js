/**
 * 20261123000002 — Leave rules (owner, 2026-11-23).
 *
 * 1. attendance_general_settings.saturday_off_weeks — which Saturdays of the
 *    month are weekly off when Saturday is otherwise a working day, e.g.
 *    [2, 4] = 2nd and 4th Saturday. Used everywhere a weekly off is decided
 *    (shared/weekend.js). Empty = no Saturday off (unless 'saturday' is in
 *    weekend_days, which keeps meaning every Saturday).
 * 2. payroll_adjustments.tds_rate / in_wages — a one-time earning can carry
 *    its own flat TDS % (instead of the slab) and be kept out of PF/ESI wages.
 *    Leave encashment uses both: flat % from Leave Settings, not wages.
 * 3. leave_types.days_worked_per_leave_day — for accrual type 'worked':
 *    1 day of leave for every N days worked (Factories Act: 20).
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE attendance_general_settings
      ADD COLUMN IF NOT EXISTS saturday_off_weeks JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await knex.raw(`
    ALTER TABLE payroll_adjustments
      ADD COLUMN IF NOT EXISTS tds_rate NUMERIC(5,2) CHECK (tds_rate IS NULL OR (tds_rate >= 0 AND tds_rate <= 100)),
      ADD COLUMN IF NOT EXISTS in_wages BOOLEAN NOT NULL DEFAULT true`);
  await knex.raw(`
    ALTER TABLE leave_types
      ADD COLUMN IF NOT EXISTS days_worked_per_leave_day NUMERIC(5,2) NOT NULL DEFAULT 20
        CHECK (days_worked_per_leave_day > 0)`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE attendance_general_settings DROP COLUMN IF EXISTS saturday_off_weeks`);
  await knex.raw(`ALTER TABLE payroll_adjustments DROP COLUMN IF EXISTS tds_rate, DROP COLUMN IF EXISTS in_wages`);
  await knex.raw(`ALTER TABLE leave_types DROP COLUMN IF EXISTS days_worked_per_leave_day`);
}
