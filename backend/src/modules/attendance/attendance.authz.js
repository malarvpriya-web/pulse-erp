/**
 * Authorization tiers for the attendance module.
 *
 * attendance.routes.js is 5,131 lines and 57 mutating routes, and until
 * 2026-07-19 not one of them carried an authorization guard. Any authenticated
 * user — including a plain `employee` — could approve overtime, delete shift
 * definitions, disable geo-fencing, or mark attendance for the whole company.
 * See SECURITY_AUDIT_2026-07-18.md H-2.
 *
 * Three tiers, because attendance genuinely mixes self-service with admin work
 * and a single blanket gate would break clock-in for everyone:
 *
 *   ADMIN     — configuration and master data. Shifts, policies, geo-rules,
 *               work centres, face settings, QR codes, delegations. Changing
 *               any of these silently rewrites the rules for everybody, so this
 *               is the narrowest tier.
 *   APPROVER  — deciding someone else's request: overtime, regularization,
 *               shift-change. Adds line managers to the admin set.
 *   OPERATOR  — recording attendance ON BEHALF of other employees (/mark,
 *               /bulk-mark, contract-labour). Distinct from APPROVER: a
 *               timekeeper may need to mark attendance without holding
 *               approval authority over requests.
 *
 * Routes NOT gated here are self-service by design (clock in/out, submitting
 * one's own OT or regularization, self face-enrolment). Those must instead
 * enforce that the caller is acting on their OWN employee record — see
 * assertSelfOrPrivileged below.
 *
 * Role names mirror the sets already hardcoded throughout this module, so this
 * is a consolidation of existing intent rather than new policy. One difference:
 * the old inline lists included 'hr_admin', which is not a row in `roles` and
 * therefore never matched anything. It is dropped here rather than carried
 * forward as decoration.
 */
import { rolesOf, hasRole } from '../../middlewares/auth.middleware.js';

export const ATTENDANCE_ADMIN = [
  'super_admin', 'admin', 'hr', 'hr_manager',
];

export const ATTENDANCE_APPROVER = [
  ...ATTENDANCE_ADMIN,
  'manager', 'department_head', 'production_manager',
];

export const ATTENDANCE_OPERATOR = [
  ...ATTENDANCE_ADMIN,
  'manager', 'department_head',
];

const has = (req, list) => rolesOf(req).some(r => list.includes(r));

export const isAttendanceAdmin    = (req) => has(req, ATTENDANCE_ADMIN);
export const isAttendanceApprover = (req) => has(req, ATTENDANCE_APPROVER);
export const isAttendanceOperator = (req) => has(req, ATTENDANCE_OPERATOR);

const gate = (test, message) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!test(req)) {
    return res.status(403).json({ error: 'Forbidden', code: 'ATTENDANCE_ROLE_REQUIRED', message });
  }
  next();
};

export const requireAttendanceAdmin = gate(
  isAttendanceAdmin,
  'Only HR and administrators can change attendance configuration.',
);

export const requireAttendanceApprover = gate(
  isAttendanceApprover,
  'Your role cannot approve or reject attendance requests.',
);

export const requireAttendanceOperator = gate(
  isAttendanceOperator,
  'Your role cannot record attendance for other employees.',
);

/**
 * May this caller decide an attendance request belonging to `employeeId`?
 *
 * HR/admin may decide anything. Everyone else must be the employee's manager in
 * `org_relationships`, or hold an active delegation from that manager.
 *
 * This consolidates a check that existed inline on only SOME of the decision
 * routes. The singular approve endpoints had it; their reject and bulk
 * counterparts did not — so a manager could not approve another team's overtime
 * but could freely REJECT it, and `/overtime/bulk-approve` bypassed the check
 * entirely, approving in bulk exactly what the singular route refused. Guards
 * that exist on the happy path and not its siblings are worse than none,
 * because the singular route's presence implies the rule is enforced.
 *
 * Fails CLOSED when the caller has no linked employee record — the previous
 * inline versions were written as `if (!isHROrAdmin && actorEmpId)`, which
 * skipped the entire check for an unlinked login.
 *
 * @returns {null|{status:number,body:object}} null when permitted.
 */
export async function assertCanDecideFor(pool, req, employeeId, companyId, delegationType) {
  if (!req.user) return { status: 401, body: { error: 'Unauthorized' } };
  if (hasRole(req, 'hr', 'hr_manager', 'admin', 'super_admin')) return null;

  const actorEmpId = req.user?.employee_id ?? null;
  if (actorEmpId == null) {
    return { status: 403, body: {
      error: 'Forbidden',
      code: 'EMPLOYEE_LINK_REQUIRED',
      message: 'Your login is not linked to an employee record, so it cannot decide attendance requests.',
    } };
  }

  const { rows } = await pool.query(
    `SELECT 1 FROM org_relationships
      WHERE employee_id = $1 AND manager_id = $2
      UNION
     SELECT 1 FROM attendance_approval_delegations d
       JOIN org_relationships org ON org.employee_id = $1 AND org.manager_id = d.delegator_id
      WHERE d.delegate_id = $2
        AND d.delegation_type IN ($4, 'all')
        AND d.is_active = TRUE
        AND CURRENT_DATE BETWEEN d.from_date AND d.to_date
        AND ($3::integer IS NULL OR d.company_id = $3)
      LIMIT 1`,
    [employeeId, actorEmpId, companyId ?? null, delegationType]
  ).catch(() => ({ rows: [] }));

  if (!rows.length) {
    return { status: 403, body: {
      error: 'Forbidden',
      code: 'NOT_YOUR_REPORT',
      message: 'You can only decide requests for your own direct reports.',
    } };
  }
  return null;
}

/**
 * Ownership check for self-service routes.
 *
 * Replaces the pattern that was repeated inline across this module:
 *
 *     const callerRole = (req.user?.role || '').toLowerCase();
 *     if (!isPrivileged && callerEmpId && String(callerEmpId) !== String(target))
 *
 * which had two defects:
 *
 *  1. `req.user.role` is the PRIMARY role only. Roles are many-to-many
 *     (user_roles), so someone holding both `employee` and `manager` was
 *     evaluated as whichever happened to be primary — their manager rights were
 *     invisible. rolesOf() is the project-wide convention for exactly this.
 *
 *  2. `callerEmpId &&` short-circuits the whole check when the caller's login is
 *     not linked to an employee record (`users.employee_id IS NULL`), so an
 *     unlinked account could pass ANY employee_id in the body and act as that
 *     person. Today every unlinked active account happens to be an admin, so
 *     this is latent rather than live — but unlinked logins are a known
 *     recurring state in this database, and the check must not depend on that
 *     coincidence holding.
 *
 * Fails closed: unknown caller identity means denied, not allowed.
 *
 * @returns {null|{status:number,body:object}} null when permitted.
 */
export function assertSelfOrPrivileged(req, targetEmployeeId, privileged = ATTENDANCE_OPERATOR) {
  if (!req.user) return { status: 401, body: { error: 'Unauthorized' } };

  if (has(req, privileged)) return null;

  const callerEmpId = req.user?.employee_id ?? null;
  if (callerEmpId == null) {
    return { status: 403, body: {
      error: 'Forbidden',
      code: 'EMPLOYEE_LINK_REQUIRED',
      message: 'Your login is not linked to an employee record, so it cannot act on attendance. Ask HR to link it.',
    } };
  }

  if (targetEmployeeId != null && String(callerEmpId) !== String(targetEmployeeId)) {
    return { status: 403, body: {
      error: 'Forbidden',
      code: 'NOT_YOUR_RECORD',
      message: 'You can only do this for your own attendance record.',
    } };
  }

  return null;
}
