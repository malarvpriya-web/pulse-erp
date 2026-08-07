// managerApprovalAuthz.js — reusable "is this actor allowed to approve this
// person's request" gate: reporting manager -> delegate -> HR override ->
// admin override. Originally built for Travel (modules/travel/) to replace
// the old `req.user.role === 'manager'` gate (any manager-role user could
// approve ANY employee's request, not just their own reports — see
// MODULE_FEATURE_CONNECTION_MANUAL.md §18.1 #3); moved here so
// leaves.routes.js's L1 manager-approval step could reuse it instead of
// re-implementing the same hierarchy check (§32).
import pool from '../config/db.js';

const HR_OVERRIDE_ROLES    = new Set(['hr', 'hr_manager', 'hr_exec']);
const ADMIN_OVERRIDE_ROLES = new Set(['admin', 'super_admin']);

/**
 * @param actorEmployeeId  req.user?.employee_id of the person attempting to approve
 * @param actorRole        req.user?.role
 * @param requesterEmployeeId  employees.id of whoever raised the request/advance/claim
 * @param delegateApproverId   employees.id explicitly delegated for this record, or null
 * @returns {Promise<{authorized: boolean, reason: string|null}>}
 */
export async function authorizeManagerApproval({ actorEmployeeId, actorRole, requesterEmployeeId, delegateApproverId }) {
  const role = String(actorRole || '').toLowerCase();

  if (ADMIN_OVERRIDE_ROLES.has(role)) return { authorized: true, reason: 'admin_override' };
  if (HR_OVERRIDE_ROLES.has(role))    return { authorized: true, reason: 'hr_override' };
  if (actorEmployeeId == null) return { authorized: false, reason: null };

  if (delegateApproverId != null && Number(delegateApproverId) === Number(actorEmployeeId)) {
    return { authorized: true, reason: 'delegate' };
  }

  if (requesterEmployeeId != null) {
    const { rows } = await pool.query(
      `SELECT 1 FROM employees WHERE id=$1 AND reporting_manager_id=$2`,
      [requesterEmployeeId, actorEmployeeId]
    );
    if (rows.length) return { authorized: true, reason: 'reporting_manager' };
  }

  return { authorized: false, reason: null };
}

export const DENIED_MESSAGE =
  "Only the employee's reporting manager, an assigned delegate, HR, or an admin can approve this";
