/**
 * Who may raise and who may approve a requisition (owner decision 2026-11-17).
 *
 *   Raise / edit / submit / withdraw / cancel / close / reopen
 *     - HR (hr, hr_manager, hr_exec): any department
 *     - a department head: their own department only. A head is either mapped
 *       on the Department Heads page (department_heads, current assignment) or
 *       holds the department_head role (then: their own employee department)
 *   Approve / send back
 *     - Super Admin only
 *   Close / reopen / cancel / restore (status only)
 *     - also Super Admin, as top management (the route allows the move)
 *
 * Super Admin may also raise (owner, 2026-11-17). Because Super Admin is the
 * only approver and there is no one above, a requisition Super Admin raised is
 * approved by Super Admin too — the self-approval block applies only to roles
 * below the approver (who cannot approve at all). The timeline shows who
 * raised and who approved.
 *
 * Used by the requisition routes, the approvals controller and the Approval
 * Center's canAct, so the three cannot drift apart.
 */
import pool from '../shared/db.js';
import { rolesOf } from '../../middlewares/auth.middleware.js';
import { companyOf, employeeOf } from '../../shared/scope.js';

export const HR_RAISER_ROLES = ['hr', 'hr_manager', 'hr_exec'];
export const REQUISITION_APPROVER_ROLES = ['super_admin', 'superadmin'];

const norm = (s) => String(s ?? '').trim().toLowerCase();

export function canApproveRequisition(req) {
  return rolesOf(req).some(r => REQUISITION_APPROVER_ROLES.includes(r));
}

/**
 * Offers are approved (= sent to the candidate) by Super Admin only — the same
 * rule as requisitions, because an offer is a salary commitment (owner,
 * 2026-11-18). HR and department heads draft and submit; they do not approve.
 */
export function canApproveOffer(req) {
  return canApproveRequisition(req);
}

/**
 * @returns {Promise<{ any: boolean, departments: string[] }>}
 *   any = may raise for every department (HR); departments = the ones this
 *   caller heads. Both empty/false → may not raise.
 */
export async function requisitionRaiserScope(req) {
  const roles = rolesOf(req);
  // Super Admin raises for any department too (owner, 2026-11-17).
  if (roles.some(r => HR_RAISER_ROLES.includes(r) || REQUISITION_APPROVER_ROLES.includes(r))) return { any: true, departments: [] };
  const me = await employeeOf(req, pool);
  if (!me) return { any: false, departments: [] };
  const company = companyOf(req);
  const { rows } = await pool.query(
    `SELECT md.name
       FROM department_heads dh JOIN master_departments md ON md.id = dh.department_id
      WHERE dh.head_employee_id = $1 AND dh.ended_at IS NULL AND md.is_active
        AND ($2::int IS NULL OR dh.company_id = $2)
     UNION
     SELECT e.department FROM employees e
      WHERE e.id = $1 AND e.department IS NOT NULL AND $3::boolean`,
    [me, company ?? null, roles.includes('department_head')]);
  return { any: false, departments: [...new Set(rows.map(r => r.name).filter(Boolean))] };
}

/** True when the caller may raise / manage a requisition for `department`. */
export function scopeAllows(scope, department) {
  if (scope.any) return true;
  return !!department && scope.departments.some(d => norm(d) === norm(department));
}

/** The 403 message for a caller who may not act on this department. */
export function raiserRefusal(scope, department) {
  if (!scope.any && !scope.departments.length) {
    return 'Only HR or a department head can raise and manage requisitions.';
  }
  return `You can raise requisitions only for ${scope.departments.join(', ')}${department ? ` — not for ${department}` : ''}.`;
}

/**
 * Department heads in Offer & Onboarding and Reports & Setup (owner decision
 * 2026-11-18): they see offers, onboarding, employee creation, reports and the
 * forecast for THEIR department(s) only, and do not manage recruitment set-up
 * (Settings, Email Templates).
 *
 * @returns {Promise<string[]|null>} null = no department limit (HR, Super Admin,
 *   a recruiter role, or anyone who is not a department head); otherwise the
 *   departments this head may see — possibly empty, which then shows nothing.
 */
export async function recruitmentDeptScope(req) {
  const roles = rolesOf(req);
  if (roles.some(r => HR_RAISER_ROLES.includes(r) || REQUISITION_APPROVER_ROLES.includes(r) || /recruit/.test(r))) return null;
  const scope = await requisitionRaiserScope(req);
  const isHead = roles.includes('department_head') || scope.departments.length > 0;
  return isHead ? scope.departments : null;
}

/** The department filter a recruitment list/report should apply: null = all. */
export async function recruitmentDeptFilter(req, requested = null) {
  const scope = await recruitmentDeptScope(req);
  const want = requested ? String(requested) : null;
  if (scope === null) return want ? [want] : null;
  if (!want) return scope;
  return scope.some(d => norm(d) === norm(want)) ? [want] : [];
}

/** May this caller change recruitment set-up (Settings, Email Templates)? */
export async function canManageRecruitmentSetup(req) {
  return (await recruitmentDeptScope(req)) === null;
}
