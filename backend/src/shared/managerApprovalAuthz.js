// managerApprovalAuthz.js — reusable "is this actor allowed to take the
// reporting-manager (level 1) decision on this person's request" gate.
// Originally built for Travel (modules/travel/) to replace the old
// `req.user.role === 'manager'` gate (any manager-role user could approve ANY
// employee's request, not just their own reports — see
// MODULE_FEATURE_CONNECTION_MANUAL.md §18.1 #3); moved here so leaves.routes.js's
// L1 step could reuse it (§32). Callers: leave L1 approve/reject/delegate,
// travel requests and advances, expense claims, sales discount approvals.
//
// The rule (§203, 2026-10-29):
//   1. nobody decides their own request — as manager, delegate or override;
//   2. the claim's / request's assigned delegate;
//   3. the requester's reporting manager;
//   4. HR or an admin ONLY as a fallback, when the requester has no ACTIVE
//      reporting manager (none set, the manager left or was deleted, or the
//      record points at the requester themself).
// Step 4 used to be a blanket override: any hr / hr_manager / hr_exec / admin
// could take every employee's level-1 decision, even one whose manager was
// right there. It stays as a fallback because most employees have no manager
// on record (31 of 35 at Manifest on 2026-10-29) — without it their requests
// would have no possible approver. Company scoping is the callers' job: each
// loads the record inside the caller's company first.
import pool from '../config/db.js';
import { isExitedSql } from './employeeStatus.js';

const HR_OVERRIDE_ROLES    = new Set(['hr', 'hr_manager', 'hr_exec']);
const ADMIN_OVERRIDE_ROLES = new Set(['admin', 'super_admin']);

/** The requester's reporting manager, if that person is still employed (else null). */
export async function activeReportingManagerId(requesterEmployeeId) {
  if (requesterEmployeeId == null) return null;
  const { rows } = await pool.query(
    `SELECT m.id
       FROM employees e
       JOIN employees m ON m.id = e.reporting_manager_id
      WHERE e.id = $1 AND m.id <> e.id AND m.deleted_at IS NULL
        AND NOT (${isExitedSql('m.status')})`,
    [requesterEmployeeId]);
  return rows[0]?.id ?? null;
}

/**
 * @param actorEmployeeId  employees.id of the person attempting to decide
 * @param actorRole        their primary role (req.user.role)
 * @param actorRoles       optional: every role held (rolesOf(req)); falls back to [actorRole]
 * @param requesterEmployeeId  employees.id of whoever raised the request/advance/claim
 * @param delegateApproverId   employees.id explicitly delegated for this record, or null
 * @returns {Promise<{authorized: boolean, reason: string|null}>}
 *   reasons: 'delegate' | 'reporting_manager' | 'no_manager_fallback' (granted);
 *            'self' | 'has_manager' | null (refused)
 */
export async function authorizeManagerApproval({ actorEmployeeId, actorRole, actorRoles, requesterEmployeeId, delegateApproverId }) {
  const roles = (Array.isArray(actorRoles) && actorRoles.length ? actorRoles : [actorRole])
    .map(r => String(r || '').toLowerCase());

  if (actorEmployeeId != null && requesterEmployeeId != null && Number(actorEmployeeId) === Number(requesterEmployeeId)) {
    return { authorized: false, reason: 'self' };
  }
  if (actorEmployeeId != null && delegateApproverId != null && Number(delegateApproverId) === Number(actorEmployeeId)) {
    return { authorized: true, reason: 'delegate' };
  }

  const managerId = await activeReportingManagerId(requesterEmployeeId);
  if (managerId != null && actorEmployeeId != null && Number(managerId) === Number(actorEmployeeId)) {
    return { authorized: true, reason: 'reporting_manager' };
  }

  const overrideRole = roles.some(r => ADMIN_OVERRIDE_ROLES.has(r) || HR_OVERRIDE_ROLES.has(r));
  if (overrideRole) {
    return managerId == null
      ? { authorized: true, reason: 'no_manager_fallback' }
      : { authorized: false, reason: 'has_manager' };
  }
  return { authorized: false, reason: null };
}

export const DENIED_MESSAGE =
  "Only the employee's reporting manager or an assigned delegate can approve this. HR or an admin can approve it only when the employee has no active reporting manager — and nobody approves their own request.";
