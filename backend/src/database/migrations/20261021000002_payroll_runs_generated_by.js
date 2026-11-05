/**
 * 20261021000002 — who prepared each payroll draft (maker-checker).
 *
 * `generated_by` = users.id of the last person who generated or recalculated
 * the draft. Approval refuses a run its approver prepared, and refuses a run
 * with no recorded preparer (drafts generated before this column) until it is
 * regenerated — PAYROLL_DATA_FLOW_AUDIT.md Part 10. Additive; existing rows
 * keep NULL.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS generated_by INTEGER`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS generated_by`);
}
