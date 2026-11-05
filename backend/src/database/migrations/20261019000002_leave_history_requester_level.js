/**
 * 20261019000002_leave_history_requester_level.js
 *
 * leave_approval_history.approval_level: allow 0 = the requester's own action.
 *
 * leavesRepository.updateStatus() records a cancellation / withdrawal at level
 * 0 (it is not an approval level), but 20260527000001_leave_l2_approval
 * constrained the column to (1, 2, 3). Every leave cancel and withdraw has
 * therefore failed with a check-constraint violation inside the transaction —
 * the employee could not withdraw a pending request at all. Found while
 * verifying the Approval Center's Withdraw action end to end.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE leave_approval_history
      DROP CONSTRAINT IF EXISTS leave_approval_history_approval_level_check;
    ALTER TABLE leave_approval_history
      ADD CONSTRAINT leave_approval_history_approval_level_check
      CHECK (approval_level IN (0, 1, 2, 3));
  `);
}

export async function down(knex) {
  // Level-0 rows (cancellations) would violate the narrower check; they are
  // history, so they stay and the old constraint is restored NOT VALID.
  await knex.raw(`
    ALTER TABLE leave_approval_history
      DROP CONSTRAINT IF EXISTS leave_approval_history_approval_level_check;
    ALTER TABLE leave_approval_history
      ADD CONSTRAINT leave_approval_history_approval_level_check
      CHECK (approval_level IN (1, 2, 3)) NOT VALID;
  `);
}
