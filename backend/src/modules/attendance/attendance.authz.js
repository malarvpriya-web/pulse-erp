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

export const requireAttendanceOperator = gate(
  isAttendanceOperator,
  'Your role cannot record attendance for other employees.',
);

// ─────────────────────────────────────────────────────────────────────────────
// "My team" — one definition for every attendance read and decision (§278.2)
// ─────────────────────────────────────────────────────────────────────────────
// Go-live check 2026-11-18: the attendance router is mounted behind login only,
// and most GET routes never checked whose records they returned, so a plain
// employee could read every colleague's punches, late arrivals, monthly report,
// analytics and audit log. Reads are now: HR/admin → whole company; anyone else
// → their own record plus their team. A reporting manager who holds only the
// `employee` role still has a team — approval follows the reporting line, not
// the login's role (a manager of 4 used to see 0 requests and get 403).
//
// Team = direct reports (employees.reporting_manager_id or org_relationships),
// employees reporting to someone who has delegated to me (active, in date),
// and — for viewing only — everyone in a department I head.
const toInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * SQL boolean: the employee row `alias` is in `actorEmpId`'s team. The id is
 * inlined as a validated integer so the fragment drops into the module's
 * existing string-built queries without renumbering their $n parameters.
 */
export function teamSql(alias, actorEmpId, { departmentHeads = true } = {}) {
  const me = toInt(actorEmpId);
  if (me == null) return 'FALSE';
  const a = alias;
  return `(
      ${a}.reporting_manager_id = ${me}
      OR EXISTS (SELECT 1 FROM org_relationships t_o WHERE t_o.employee_id = ${a}.id AND t_o.manager_id = ${me})
      OR EXISTS (SELECT 1 FROM attendance_approval_delegations t_d
                  WHERE t_d.delegate_id = ${me} AND t_d.is_active = TRUE
                    AND CURRENT_DATE BETWEEN t_d.from_date AND t_d.to_date
                    AND (${a}.reporting_manager_id = t_d.delegator_id
                         OR EXISTS (SELECT 1 FROM org_relationships t_o2
                                     WHERE t_o2.employee_id = ${a}.id AND t_o2.manager_id = t_d.delegator_id)))${departmentHeads ? `
      OR EXISTS (SELECT 1 FROM department_heads t_dh JOIN master_departments t_md ON t_md.id = t_dh.department_id
                  WHERE t_dh.head_employee_id = ${me} AND t_dh.ended_at IS NULL
                    AND LOWER(TRIM(t_md.name)) = LOWER(TRIM(${a}.department)))` : ''}
    )`;
}

/**
 * The extra WHERE text that limits an attendance read to what the caller may
 * see: '' for HR/admin, ` AND (own record OR team)` for anyone else, and null
 * when the login is not linked to an employee (nothing to scope to → deny).
 */
export function attendanceViewClause(req, alias = 'e') {
  if (isAttendanceAdmin(req)) return '';
  const me = toInt(req.user?.employee_id);
  if (me == null) return null;
  return ` AND (${alias}.id = ${me} OR ${teamSql(alias, me)})`;
}

const NOT_LINKED = {
  error: 'Forbidden',
  code: 'EMPLOYEE_LINK_REQUIRED',
  message: 'Your login is not linked to an employee record. Ask HR to link it.',
};

/** May the caller see this one employee's attendance? null when yes. */
export async function assertCanViewEmployee(pool, req, employeeId) {
  if (!req.user) return { status: 401, body: { error: 'Unauthorized' } };
  if (isAttendanceAdmin(req)) return null;
  const me = toInt(req.user?.employee_id);
  if (me == null) return { status: 403, body: NOT_LINKED };
  const target = toInt(employeeId);
  if (target == null) return { status: 400, body: { error: 'Invalid employee id' } };
  if (target === me) return null;
  const { rows } = await pool.query(
    `SELECT 1 FROM employees e WHERE e.id = $1 AND ${teamSql('e', me)} LIMIT 1`, [target],
  ).catch(() => ({ rows: [] }));
  if (rows.length) return null;
  return { status: 403, body: {
    error: 'Forbidden', code: 'NOT_YOUR_TEAM',
    message: 'You can only see your own attendance and your team’s.',
  } };
}

/** Does the caller manage anyone (directly or by delegation)? */
export async function hasDecisionTeam(pool, req) {
  const me = toInt(req.user?.employee_id);
  if (me == null) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM employees e
      WHERE e.deleted_at IS NULL AND ${teamSql('e', me, { departmentHeads: false })}
      LIMIT 1`,
  ).catch(() => ({ rows: [] }));
  return rows.length > 0;
}

/**
 * Approve / reject gate. HR, admin and the manager roles pass as before; so
 * does anyone who is a reporting manager or an active delegate, whatever their
 * login role. Each decision route still calls assertCanDecideFor() for the
 * specific employee, so passing this gate never widens WHOSE requests one can
 * decide.
 */
export function makeRequireAttendanceApprover(pool) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (isAttendanceApprover(req) || await hasDecisionTeam(pool, req)) return next();
    return res.status(403).json({
      error: 'Forbidden', code: 'ATTENDANCE_ROLE_REQUIRED',
      message: 'Only HR, administrators and reporting managers can approve or reject attendance requests.',
    });
  };
}

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
  // Never one's own request (admin / super_admin excepted, as on the
  // regularization and shift routes). Overtime had no such check, and once a
  // delegation counts, a delegate could otherwise approve their own overtime.
  if (req.user?.employee_id != null && String(req.user.employee_id) === String(employeeId)
      && !hasRole(req, 'admin', 'super_admin')) {
    return { status: 403, body: {
      error: 'Forbidden', code: 'SELF_APPROVAL',
      message: 'You cannot decide your own attendance request.',
    } };
  }
  if (hasRole(req, 'hr', 'hr_manager', 'admin', 'super_admin')) return null;

  const actorEmpId = req.user?.employee_id ?? null;
  if (actorEmpId == null) {
    return { status: 403, body: {
      error: 'Forbidden',
      code: 'EMPLOYEE_LINK_REQUIRED',
      message: 'Your login is not linked to an employee record, so it cannot decide attendance requests.',
    } };
  }

  // §278.2: the reporting line is read from employees.reporting_manager_id as
  // well as org_relationships — the same two sources Team Attendance uses.
  const { rows } = await pool.query(
    `SELECT 1 FROM org_relationships
      WHERE employee_id = $1 AND manager_id = $2
      UNION
     SELECT 1 FROM employees WHERE id = $1 AND reporting_manager_id = $2
      UNION
     SELECT 1 FROM attendance_approval_delegations d
       JOIN employees emp ON emp.id = $1
      WHERE d.delegate_id = $2
        AND (emp.reporting_manager_id = d.delegator_id
             OR EXISTS (SELECT 1 FROM org_relationships org
                         WHERE org.employee_id = $1 AND org.manager_id = d.delegator_id))
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
