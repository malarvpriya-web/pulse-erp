/**
 * 20260722000001_scope_granular_manager_approvals.js
 *
 * F16 role-reconciliation pass: project_manager/sales_manager/service_manager
 * were removed from approvals.authz.js's APPROVER_ROLES — none of the shared
 * Approval Center pool's categories (leave/regularization/OT/purchase
 * request/expense/ECN/payment) are their domain, so membership only ever let
 * them claim work that wasn't theirs (e.g. sales_manager approving a purchase
 * request). [20260721000002_granular_role_approvals_notifications_grants.js]'s
 * VAEP grant on 'approvals' for these three is now stale: can_approve=true in
 * role_permissions no longer means anything, because the write path is gated
 * by the hardcoded APPROVER_ROLES array in approvals.authz.js, not by
 * role_permissions. Downgrading to the same VA shape that migration already
 * uses for its EXEC_TIER (view + submit own requests, no approve) so the DB
 * stops asserting an approval authority that no longer exists.
 *
 * 'notifications' is untouched — unrelated to approval authority.
 */
const ROLES = ['project_manager', 'sales_manager', 'service_manager'];

export async function up(knex) {
  await knex.raw(
    `UPDATE role_permissions
        SET can_edit = false, can_approve = false
      WHERE module = 'approvals'
        AND role_id IN (SELECT id FROM roles WHERE code = ANY($1))`,
    [ROLES]
  );
}

export async function down(knex) {
  await knex.raw(
    `UPDATE role_permissions
        SET can_edit = true, can_approve = true
      WHERE module = 'approvals'
        AND role_id IN (SELECT id FROM roles WHERE code = ANY($1))`,
    [ROLES]
  );
}
