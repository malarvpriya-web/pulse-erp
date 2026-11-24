/**
 * 20261123000001 — Leave encashment is paid through payroll (Leaves review,
 * 2026-11-23).
 *
 * An approved encashment used to write payroll_runs.leave_encashment_amount,
 * which the payroll engine never reads, so the money was never paid. Approval
 * now adds a one-time EARNING to payroll_adjustments for the payout month
 * (Generate Payroll picks it up and taxes it at the employee's slab); this
 * column links the claim to that row. The claim shows "Paid" once that
 * month's payroll for the employee is approved or paid.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE leave_encashments
      ADD COLUMN IF NOT EXISTS payroll_adjustment_id INTEGER REFERENCES payroll_adjustments(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE leave_encashments
      DROP COLUMN IF EXISTS payroll_adjustment_id, DROP COLUMN IF EXISTS paid_at`);
}
