/**
 * 20260706000004_leave_clubbing_lop_days
 *
 * Adds leave_applications.lop_days — the portion of a leave request that is
 * charged as Loss of Pay (unpaid). This is used for two cases:
 *   1. Clubbing: weekend/holiday days sandwiched between working leave days are
 *      auto-charged as LOP (paid balance only covers the working days).
 *   2. Probation: paid leave is blocked, so the whole request is LOP — in that
 *      case is_lop=true carries the amount and lop_days may stay 0.
 *
 * Kept as a separate additive column so balance deduction (number_of_days) and
 * LOP payroll posting (lop_days / is_lop) stay independent.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE leave_applications
      ADD COLUMN IF NOT EXISTS lop_days NUMERIC(6,2) NOT NULL DEFAULT 0
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE leave_applications DROP COLUMN IF EXISTS lop_days`);
}
