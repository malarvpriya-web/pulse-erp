/**
 * Approval Center source registry — the ONE place that knows, per request type:
 *
 *   pending(companyId)   rows currently awaiting a decision, at their current stage
 *   canAct(ctx, row)     whether THIS caller can decide that row — a mirror of the
 *                        authorisation the module's own endpoint enforces
 *   actions(row)         the module's own endpoint(s) that make the decision
 *   mine(ctx)            the caller's own submitted requests (My Requests)
 *   decided(ctx)         decisions the caller made (Approval History)
 *
 * Why actions point at the MODULE's endpoint: the Approval Center used to
 * re-implement every transition itself. Each copy drifted from the module —
 * a leave approved here skipped L2/HR and never deducted leave balance, an
 * expense jumped straight to 'Approved' past accounts and management, a PR
 * skipped segregation of duties, an ECN ignored its other parallel approvers.
 * The Approval Center is now an inbox over the modules, not a second
 * workflow engine. See APPROVALS_GAP_ANALYSIS.md.
 *
 * canAct() mirrors, it does not decide: the module endpoint re-checks on every
 * call. If a module's rule changes, change the mirror here too — a stale mirror
 * shows a button that 403s (or hides one that would work), it cannot grant
 * anything. approvals.sources.test.js pins each mirror to its module rule.
 */
import pool from '../../config/db.js';
import { permissionFor, rolesOf, hasRole } from '../../middlewares/auth.middleware.js';
import { isExitedSql } from '../../shared/employeeStatus.js';
import { canOverride, canClaimCategory, isApproverRole } from './approvals.authz.js';
import { isAttendanceApprover } from '../attendance/attendance.authz.js';
import { assertCanDecideAmount, assertNotSelfApproval } from '../procurement/procurement.authz.js';
import { isCurrentSql } from '../../shared/employeeStatus.js';
import { GP_APPROVER_JOIN, APPROVER_LABEL, approverDecision } from '../../shared/gatePassApprover.js';

// Overdue threshold when a request type has no configured SLA. 48h is the
// figure the Approval Center always used; it is kept as the fallback, not
// promoted to a rule. Types that DO have a configured SLA
// (workflow_steps.sla_hours — leave and travel today) use that instead.
export const DEFAULT_SLA_HOURS = 48;

// type → workflows.module whose step sla_hours applies to it.
const SLA_WORKFLOW_MODULE = { leave: 'leaves', travel: 'travel' };

async function q(sql, params = []) {
  try {
    return (await pool.query(sql, params)).rows;
  } catch (e) {
    // A module whose table is absent in this database contributes nothing;
    // any other error is real and must surface.
    if (e.code === '42P01') return [];
    throw e;
  }
}

const cf = (companyId, col) => (companyId != null ? `AND ${col} = $1` : '');
const cp = (companyId) => (companyId != null ? [companyId] : []);
const name = (alias) => `NULLIF(TRIM(CONCAT(${alias}.first_name, ' ', COALESCE(${alias}.last_name, ''))), '')`;

const req_ = (method, url, body = {}, commentKey = null, extra = {}) =>
  ({ method, url, body, commentKey, ...extra });

// ── Per-caller context, loaded once per request ──────────────────────────────

/**
 * Everything canAct() needs, preloaded so a 150-row queue costs a handful of
 * queries instead of one per row.
 */
export async function buildContext(req) {
  const userId = req.user?.userId ?? req.user?.id ?? null;
  let employeeId = req.user?.employee_id ?? null;
  if (employeeId == null && userId != null) {
    const r = await q('SELECT employee_id FROM users WHERE id = $1', [userId]);
    employeeId = r[0]?.employee_id ?? null;
  }
  // The module endpoints read req.user.employee_id directly (no users-table
  // fallback) when they authorise — mirror THAT, or a legacy login would see
  // buttons its own endpoint refuses.
  const jwtEmployeeId = req.user?.employee_id ?? null;

  const [directReports, orgReports, attDelegations] = jwtEmployeeId == null ? [[], [], []] : await Promise.all([
    q('SELECT id FROM employees WHERE reporting_manager_id = $1', [jwtEmployeeId]),
    q('SELECT employee_id FROM org_relationships WHERE manager_id = $1', [jwtEmployeeId]),
    q(`SELECT org.employee_id, d.delegation_type, d.company_id
         FROM attendance_approval_delegations d
         JOIN org_relationships org ON org.manager_id = d.delegator_id
        WHERE d.delegate_id = $1 AND d.is_active = TRUE
          AND CURRENT_DATE BETWEEN d.from_date AND d.to_date`, [jwtEmployeeId]),
  ]);

  // The LIVE login link — what the review queues (intern evaluation, probation
  // review) match their assignee on, as their own modules do.
  const linked = userId == null ? [] : await q(
    'SELECT employee_id FROM users WHERE id = $1 AND is_active = true', [userId]);
  const linkedEmployeeId = linked[0]?.employee_id ?? null;

  // Requesters who HAVE an active reporting manager: for them the HR/admin
  // level-1 fallback does not apply (shared/managerApprovalAuthz.js, §203).
  const managed = await q(
    `SELECT e.id FROM employees e JOIN employees m ON m.id = e.reporting_manager_id
      WHERE m.id <> e.id AND m.deleted_at IS NULL AND NOT (${isExitedSql('m.status')})
        AND ($1::int IS NULL OR e.company_id = $1)`, [req.scope?.company_id ?? null]);

  const perms = {};
  for (const m of ['leaves', 'procurement', 'finance', 'engineering', 'hr', 'expense_claims']) {
    perms[m] = await permissionFor(req, m).catch(() => null);
  }

  return {
    req,
    userId,
    employeeId,
    jwtEmployeeId,
    linkedEmployeeId,
    companyId: req.scope?.company_id ?? null,
    primaryRole: String(req.user?.role || '').toLowerCase(),
    roles: rolesOf(req),
    directReports: new Set(directReports.map(r => String(r.id))),
    hasActiveManager: new Set(managed.map(r => String(r.id))),
    orgReports: new Set(orgReports.map(r => String(r.employee_id))),
    attDelegations,
    perms,
  };
}

const can = (ctx, module, col) => !!ctx.perms[module]?.[col];
const holds = (ctx, ...codes) => ctx.roles.some(r => codes.includes(r));

// Mirror of shared/managerApprovalAuthz.js authorizeManagerApproval() (§203):
// never one's own; delegate; reporting manager; HR/admin (PRIMARY role, as the
// endpoints pass it) only when the requester has no active reporting manager.
function managerApproves(ctx, requesterEmpId, delegateEmpId) {
  if (ctx.jwtEmployeeId != null && requesterEmpId != null && String(requesterEmpId) === String(ctx.jwtEmployeeId)) return false;
  if (ctx.jwtEmployeeId != null && delegateEmpId != null && Number(delegateEmpId) === Number(ctx.jwtEmployeeId)) return true;
  if (ctx.jwtEmployeeId != null && requesterEmpId != null && ctx.directReports.has(String(requesterEmpId))) return true;
  if (['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec'].includes(ctx.primaryRole)) {
    return requesterEmpId != null && !ctx.hasActiveManager.has(String(requesterEmpId));
  }
  return false;
}

// Mirror of attendance.authz.js assertCanDecideFor() (role check is a UNION).
function attendanceDecides(ctx, employeeId, companyId, delegationType) {
  if (hasRole(ctx.req, 'hr', 'hr_manager', 'admin', 'super_admin')) return true;
  if (ctx.jwtEmployeeId == null) return false;
  if (ctx.orgReports.has(String(employeeId))) return true;
  return ctx.attDelegations.some(d =>
    String(d.employee_id) === String(employeeId)
    && (d.delegation_type === delegationType || d.delegation_type === 'all')
    && (companyId == null || d.company_id == null || Number(d.company_id) === Number(companyId)));
}

// ── Sources ──────────────────────────────────────────────────────────────────

const LEAVE_STAGE = { l1: 'L1 — Reporting manager', l2: 'L2 — Department head', hr: 'L3 — HR final' };

const leave = {
  type: 'leave', label: 'Leave', page: 'LeaveApprovals', myPage: 'MyLeaves',
  pending(companyId) {
    return q(`
      SELECT 'leave:' || la.id AS id, la.id::text AS source_id,
             CONCAT(COALESCE(lt.leave_name, 'Leave'), ' · ', TO_CHAR(la.start_date, 'DD Mon'),
                    CASE WHEN la.end_date <> la.start_date THEN ' – ' || TO_CHAR(la.end_date, 'DD Mon') ELSE '' END,
                    ' (', la.number_of_days::float8, 'd)') AS request_title,
             la.reason AS description, la.number_of_days AS amount, 'days' AS amount_unit,
             e.id AS requester_emp_id, ${name('e')} AS requested_by, e.company_email AS requester_email,
             e.department, la.applied_at AS request_date, e.company_id,
             la.delegate_approver_id AS delegate_emp_id,
             CASE WHEN la.manager_status = 'pending' THEN 'l1'
                  WHEN lt.l2_required AND (la.l2_status IS NULL OR la.l2_status = 'pending') THEN 'l2'
                  ELSE 'hr' END AS stage_key
        FROM leave_applications la
        JOIN employees e ON e.id = la.employee_id
        LEFT JOIN leave_types lt ON lt.id = la.leave_type_id
       WHERE la.status = 'pending' AND la.deleted_at IS NULL ${cf(companyId, 'e.company_id')}`,
      cp(companyId));
  },
  stage: (r) => LEAVE_STAGE[r.stage_key],
  canAct(ctx, r) {
    if (!can(ctx, 'leaves', 'can_approve')) return false;
    // Nobody decides their own leave, at any level (leaves.routes.js
    // blockOwnLeaveDecision) — so it is not in their own inbox either.
    if (ctx.employeeId != null && String(ctx.employeeId) === String(r.requester_emp_id)) return false;
    // L2/HR queues are role-gated in LeaveApprovals.jsx; the endpoints check
    // only the permission, so the queue roles are the narrower, honest mirror.
    if (r.stage_key === 'l1') return managerApproves(ctx, r.requester_emp_id, r.delegate_emp_id);
    if (r.stage_key === 'l2') return holds(ctx, 'department_head', 'l2_approver', 'admin', 'super_admin', 'hr_manager');
    return holds(ctx, 'hr', 'hr_manager', 'admin', 'super_admin');
  },
  actions(r) {
    const lvl = r.stage_key === 'l1' ? 'manager' : r.stage_key;
    return {
      approve: req_('post', `/leaves/approve/${lvl}/${r.source_id}`, {}, 'comments'),
      reject:  req_('post', `/leaves/reject/${lvl}/${r.source_id}`,  {}, 'comments', { commentRequired: true }),
      ...(r.stage_key === 'l1' ? { delegate: req_('post', `/leaves/delegate/${r.source_id}`, {}, null, { delegateKey: 'delegate_employee_id' }) } : {}),
    };
  },
  mine(ctx) {
    return q(`
      SELECT 'leave:' || la.id AS id, la.id::text AS source_id,
             CONCAT(COALESCE(lt.leave_name, 'Leave'), ' · ', TO_CHAR(la.start_date, 'DD Mon YY'),
                    CASE WHEN la.end_date <> la.start_date THEN ' – ' || TO_CHAR(la.end_date, 'DD Mon YY') ELSE '' END) AS request_title,
             la.number_of_days AS amount, 'days' AS amount_unit, la.applied_at AS request_date, la.status AS raw_status,
             COALESCE(la.hr_comments, la.l2_comments, la.manager_comments) AS comments,
             CASE WHEN la.status <> 'pending' THEN NULL
                  WHEN la.manager_status = 'pending' THEN COALESCE(${name('d')}, ${name('m')}, 'Reporting manager')
                  WHEN lt.l2_required AND (la.l2_status IS NULL OR la.l2_status = 'pending') THEN 'Department head'
                  ELSE 'HR' END AS current_approver,
             GREATEST(la.manager_approved_at, la.l2_approved_at, la.hr_approved_at) AS decided_at
        FROM leave_applications la
        LEFT JOIN leave_types lt ON lt.id = la.leave_type_id
        LEFT JOIN employees e ON e.id = la.employee_id
        LEFT JOIN employees m ON m.id = e.reporting_manager_id
        LEFT JOIN employees d ON d.id = la.delegate_approver_id
       WHERE la.employee_id = $1 AND la.deleted_at IS NULL`, [ctx.employeeId]);
  },
  myActions(r) {
    // Withdraw is the module's own route (pending or approved); offered here for
    // pending only — retracting an approved leave belongs on the leave screen.
    return r.raw_status === 'pending'
      ? { withdraw: req_('post', `/leaves/${r.source_id}/withdraw`, {}, 'reason', { commentRequired: true }) }
      : {};
  },
  decided(ctx) {
    if (ctx.employeeId == null) return [];
    return q(`
      SELECT 'leave:' || la.id AS id, la.id::text AS source_id,
             CONCAT(COALESCE(lt.leave_name, 'Leave'), ' · ', TO_CHAR(la.start_date, 'DD Mon YY')) AS request_title,
             ${name('e')} AS requested_by, la.applied_at AS request_date,
             h.action AS decision, h.created_at AS decision_date, h.comments,
             CONCAT('L', h.approval_level) AS stage
        FROM leave_approval_history h
        JOIN leave_applications la ON la.id = h.leave_application_id
        LEFT JOIN leave_types lt ON lt.id = la.leave_type_id
        LEFT JOIN employees e ON e.id = la.employee_id
       WHERE h.approver_id = $1 AND h.action IN ('approved', 'rejected')`, [ctx.employeeId]);
  },
  chain(sourceId) {
    return q(`
      SELECT CONCAT('L', h.approval_level) AS step, ${name('e')} AS approver_name,
             INITCAP(h.action) AS status, h.created_at AS decision_date, h.comments AS comment
        FROM leave_approval_history h LEFT JOIN employees e ON e.id = h.approver_id
       WHERE h.leave_application_id = $1 ORDER BY h.created_at`, [sourceId]);
  },
};

const REG_STAGE = { manager: 'Reporting manager', hr: 'HR' };
const regularization = {
  type: 'reg', label: 'Regularization', page: 'RegularizationApprovals', myPage: 'AttendanceDashboard',
  pending(companyId) {
    return q(`
      SELECT 'reg:' || r.id AS id, r.id::text AS source_id,
             CONCAT('Attendance correction · ', TO_CHAR(r.date, 'DD Mon YY')) AS request_title,
             r.reason AS description, NULL::numeric AS amount,
             e.id AS requester_emp_id, ${name('e')} AS requested_by, e.company_email AS requester_email,
             e.department, r.created_at AS request_date, r.company_id,
             COALESCE(NULLIF(r.approval_level, 'done'), 'manager') AS stage_key
        FROM attendance_regularization_requests r
        LEFT JOIN employees e ON e.id::text = r.employee_id::text
       WHERE r.status = 'pending' ${cf(companyId, 'r.company_id')}`, cp(companyId));
  },
  stage: (r) => REG_STAGE[r.stage_key] || r.stage_key,
  canAct(ctx, r) {
    if (!isAttendanceApprover(ctx.req)) return false;
    const isHR = hasRole(ctx.req, 'hr', 'hr_manager', 'admin', 'super_admin');
    if (r.stage_key === 'hr') return isHR;
    return isHR || attendanceDecides(ctx, r.requester_emp_id, r.company_id, 'regularization');
  },
  actions: (r) => ({
    approve: req_('put', `/attendance/regularize/${r.source_id}/approve`, {}, 'remarks'),
    reject:  req_('put', `/attendance/regularize/${r.source_id}/reject`,  {}, 'remarks', { commentRequired: true }),
  }),
  mine(ctx) {
    return q(`
      SELECT 'reg:' || r.id AS id, r.id::text AS source_id,
             CONCAT('Attendance correction · ', TO_CHAR(r.date, 'DD Mon YY')) AS request_title,
             NULL::numeric AS amount, r.created_at AS request_date, r.status AS raw_status,
             r.manager_remarks AS comments,
             CASE WHEN r.status <> 'pending' THEN NULL
                  WHEN r.approval_level = 'hr' THEN 'HR'
                  ELSE COALESCE(${name('m')}, 'Reporting manager') END AS current_approver,
             COALESCE(r.hr_actioned_at, r.manager_actioned_at) AS decided_at
        FROM attendance_regularization_requests r
        LEFT JOIN employees e ON e.id::text = r.employee_id::text
        LEFT JOIN employees m ON m.id = e.reporting_manager_id
       WHERE r.employee_id::text = $1::text`, [ctx.employeeId]);
  },
  decided(ctx) {
    // manager_id / hr_id hold the deciding users.id (attendance.routes.js).
    return q(`
      SELECT 'reg:' || r.id AS id, r.id::text AS source_id,
             CONCAT('Attendance correction · ', TO_CHAR(r.date, 'DD Mon YY')) AS request_title,
             ${name('e')} AS requested_by, r.created_at AS request_date,
             CASE WHEN r.status = 'rejected' THEN 'rejected' ELSE 'approved' END AS decision,
             COALESCE(r.hr_actioned_at, r.manager_actioned_at) AS decision_date, r.manager_remarks AS comments
        FROM attendance_regularization_requests r
        LEFT JOIN employees e ON e.id::text = r.employee_id::text
       WHERE (r.manager_id = $1 OR r.hr_id = $1) AND r.manager_actioned_at IS NOT NULL
         AND r.status IN ('approved', 'rejected', 'pending')`, [ctx.userId]);
  },
};

const overtime = {
  type: 'ot', label: 'Overtime', page: 'OvertimeApprovals', myPage: 'AttendanceDashboard',
  pending(companyId) {
    return q(`
      SELECT 'ot:' || o.id AS id, o.id::text AS source_id,
             CONCAT('Overtime ', o.ot_hours, 'h · ', TO_CHAR(o.attendance_date, 'DD Mon YY')) AS request_title,
             o.reason AS description, o.ot_hours AS amount, 'hours' AS amount_unit,
             e.id AS requester_emp_id, ${name('e')} AS requested_by, e.company_email AS requester_email,
             e.department, o.created_at AS request_date, o.company_id
        FROM attendance_ot_records o
        LEFT JOIN employees e ON e.id = o.employee_id
       WHERE o.status = 'pending' ${cf(companyId, 'o.company_id')}`, cp(companyId));
  },
  stage: () => 'Reporting manager',
  canAct: (ctx, r) => isAttendanceApprover(ctx.req) && attendanceDecides(ctx, r.requester_emp_id, r.company_id, 'overtime'),
  actions: (r) => ({
    approve: req_('put', `/attendance/overtime/${r.source_id}/approve`, {}, 'remarks'),
    reject:  req_('put', `/attendance/overtime/${r.source_id}/reject`,  {}, 'remarks', { commentRequired: true }),
  }),
  mine(ctx) {
    return q(`
      SELECT 'ot:' || o.id AS id, o.id::text AS source_id,
             CONCAT('Overtime ', o.ot_hours, 'h · ', TO_CHAR(o.attendance_date, 'DD Mon YY')) AS request_title,
             o.ot_hours AS amount, 'hours' AS amount_unit, o.created_at AS request_date, o.status AS raw_status,
             o.rejection_remarks AS comments,
             CASE WHEN o.status = 'pending' THEN COALESCE(${name('m')}, 'Reporting manager') END AS current_approver,
             o.approved_at AS decided_at
        FROM attendance_ot_records o
        LEFT JOIN employees e ON e.id = o.employee_id
        LEFT JOIN employees m ON m.id = e.reporting_manager_id
       WHERE o.employee_id = $1`, [ctx.employeeId]);
  },
  decided(ctx) {
    // The reject route records no actor column; approvals are attributable.
    return q(`
      SELECT 'ot:' || o.id AS id, o.id::text AS source_id,
             CONCAT('Overtime ', o.ot_hours, 'h · ', TO_CHAR(o.attendance_date, 'DD Mon YY')) AS request_title,
             ${name('e')} AS requested_by, o.created_at AS request_date,
             'approved' AS decision, o.approved_at AS decision_date, NULL AS comments
        FROM attendance_ot_records o LEFT JOIN employees e ON e.id = o.employee_id
       WHERE o.approved_by = $1 AND o.status = 'approved'`, [ctx.userId]);
  },
};

// Reimbursement workflow (travel-reimbursement.routes.js): each status is a level.
const EXP_LEVEL = {
  'Submitted':         { key: 'manager',  stage: 'L1 — Reporting manager',   path: 'manager-approve' },
  'Manager Approved':  { key: 'accounts', stage: 'L2 — Accounts verification', path: 'accounts-verify' },
  'Accounts Verified': { key: 'mgmt',     stage: 'L3 — Management approval', path: 'mgmt-approve' },
};
const expense = {
  type: 'exp', label: 'Expense', page: 'ExpenseReview', myPage: 'ExpenseClaims',
  pending(companyId) {
    return q(`
      SELECT 'exp:' || c.id AS id, c.id::text AS source_id,
             CONCAT('Expense claim ', COALESCE(c.claim_number, '#' || c.id)) AS request_title,
             c.notes AS description, c.total_amount AS amount, 'INR' AS amount_unit,
             e.id AS requester_emp_id, ${name('e')} AS requested_by, e.company_email AS requester_email,
             e.department, COALESCE(c.submitted_at, c.claim_date::timestamp) AS request_date, e.company_id,
             c.delegate_approver_id AS delegate_emp_id, c.status AS raw_status
        FROM expense_claims c
        LEFT JOIN employees e ON e.id = c.employee_id
       WHERE c.status IN ('Submitted', 'Manager Approved', 'Accounts Verified') ${cf(companyId, 'e.company_id')}`,
      cp(companyId));
  },
  stage: (r) => EXP_LEVEL[r.raw_status]?.stage,
  canAct(ctx, r) {
    const lvl = EXP_LEVEL[r.raw_status]?.key;
    // Never one's own claim (the claim routes refuse it). Levels 2 and 3 follow
    // the explicit expense_claims grants the routes check (§202), not roles.
    if (r.requester_emp_id != null && String(r.requester_emp_id) === String(ctx.employeeId ?? ctx.linkedEmployeeId)) return false;
    if (lvl === 'manager')  return managerApproves(ctx, r.requester_emp_id, r.delegate_emp_id);
    if (lvl === 'accounts') return can(ctx, 'expense_claims', 'can_edit');
    if (lvl === 'mgmt')     return can(ctx, 'expense_claims', 'can_approve');
    return false;
  },
  actions(r) {
    const path = EXP_LEVEL[r.raw_status]?.path;
    const url = `/reimbursement/claims/${r.source_id}/${path}`;
    return {
      approve: req_('put', url, { status: 'Approved' }, 'remarks'),
      reject:  req_('put', url, { status: 'Rejected' }, 'remarks', { commentRequired: true }),
      ...(r.raw_status === 'Submitted' ? { delegate: req_('post', `/reimbursement/claims/${r.source_id}/delegate`, {}, null, { delegateKey: 'delegate_employee_id' }) } : {}),
    };
  },
  mine(ctx) {
    return q(`
      SELECT 'exp:' || c.id AS id, c.id::text AS source_id,
             CONCAT('Expense claim ', COALESCE(c.claim_number, '#' || c.id)) AS request_title,
             c.total_amount AS amount, 'INR' AS amount_unit,
             COALESCE(c.submitted_at, c.claim_date::timestamp) AS request_date, c.status AS raw_status,
             COALESCE(c.mgmt_remarks, c.accounts_remarks, c.manager_remarks, c.rejection_reason) AS comments,
             CASE c.status WHEN 'Submitted' THEN COALESCE(${name('d')}, ${name('m')}, 'Reporting manager')
                           WHEN 'Manager Approved' THEN 'Accounts'
                           WHEN 'Accounts Verified' THEN 'Management'
                           WHEN 'Mgmt Approved' THEN 'Finance (payment)' END AS current_approver,
             GREATEST(c.manager_approved_at, c.accounts_verified_at, c.mgmt_approved_at) AS decided_at
        FROM expense_claims c
        LEFT JOIN employees e ON e.id = c.employee_id
        LEFT JOIN employees m ON m.id = e.reporting_manager_id
        LEFT JOIN employees d ON d.id = c.delegate_approver_id
       WHERE c.employee_id = $1 AND c.status <> 'Draft'`, [ctx.employeeId]);
  },
  decided(ctx) {
    return q(`
      SELECT 'exp:' || c.id AS id, c.id::text AS source_id,
             CONCAT('Expense claim ', COALESCE(c.claim_number, '#' || c.id)) AS request_title,
             ${name('e')} AS requested_by, COALESCE(c.submitted_at, c.claim_date::timestamp) AS request_date,
             LOWER(a.status) AS decision, a.actioned_at AS decision_date, a.remarks AS comments, a.level_name AS stage
        FROM expense_claim_approvals a
        JOIN expense_claims c ON c.id = a.claim_id
        LEFT JOIN employees e ON e.id = c.employee_id
       WHERE a.approver_id = $1 AND a.status IN ('Approved', 'Rejected')`, [ctx.userId]);
  },
  chain(sourceId) {
    return q(`
      SELECT a.level_name AS step, COALESCE(${name('e')}, u.email) AS approver_name,
             a.status, a.actioned_at AS decision_date, a.remarks AS comment
        FROM expense_claim_approvals a
        LEFT JOIN users u ON u.id = a.approver_id
        LEFT JOIN employees e ON e.id = u.employee_id
       WHERE a.claim_id = $1 ORDER BY a.level`, [sourceId]);
  },
};

const purchase = {
  type: 'pr', label: 'Purchase', page: 'PurchaseRequest', myPage: 'PurchaseRequest',
  pending(companyId) {
    return q(`
      SELECT 'pr:' || pr.id AS id, pr.id::text AS source_id,
             CONCAT('Purchase request ', pr.request_number) AS request_title,
             pr.notes AS description,
             GREATEST(COALESCE(pr.total_amount, 0),
                      COALESCE((SELECT SUM(COALESCE(quantity, 0) * COALESCE(expected_price, 0))
                                  FROM purchase_request_items WHERE pr_id = pr.id), 0)) AS amount,
             'INR' AS amount_unit,
             e.id AS requester_emp_id, ${name('e')} AS requested_by, e.company_email AS requester_email,
             e.department, pr.request_date, pr.company_id
        FROM purchase_requests pr
        LEFT JOIN employees e ON e.id = pr.requested_by_employee_id
       WHERE pr.status IN ('pending_approval', 'pending') ${cf(companyId, 'pr.company_id')}`, cp(companyId));
  },
  stage: () => 'Procurement approver',
  async canAct(ctx, r) {
    // requireProcurement('approve') + amount band + segregation of duties —
    // the same three gates PUT /procurement/purchase-requests/:id/approve runs.
    if (!can(ctx, 'procurement', 'can_approve')) return false;
    const settings = await procurementSettings(ctx, r.company_id);
    if (assertCanDecideAmount(ctx.req, Number(r.amount) || 0, settings, 'approve')) return false;
    if (assertNotSelfApproval(ctx.req, r.requester_emp_id, settings, { amount: Number(r.amount) || 0 })) return false;
    return true;
  },
  actions: (r) => ({
    approve: req_('put', `/procurement/purchase-requests/${r.source_id}/approve`, {}, null),
    reject:  req_('put', `/procurement/purchase-requests/${r.source_id}/reject`,  {}, 'remarks', { commentRequired: true }),
  }),
  mine(ctx) {
    return q(`
      SELECT 'pr:' || pr.id AS id, pr.id::text AS source_id,
             CONCAT('Purchase request ', pr.request_number) AS request_title,
             pr.total_amount AS amount, 'INR' AS amount_unit, pr.request_date, pr.status AS raw_status,
             pr.rejection_reason AS comments,
             CASE WHEN pr.status IN ('pending_approval', 'pending') THEN 'Procurement approver' END AS current_approver,
             pr.approved_at AS decided_at
        FROM purchase_requests pr
       WHERE pr.requested_by_employee_id = $1 AND pr.status <> 'draft'`, [ctx.employeeId]);
  },
  decided(ctx) {
    if (ctx.employeeId == null) return [];
    // purchase_requests.approved_by (employees.id) records approve AND reject.
    return q(`
      SELECT 'pr:' || pr.id AS id, pr.id::text AS source_id,
             CONCAT('Purchase request ', pr.request_number) AS request_title,
             ${name('e')} AS requested_by, pr.request_date,
             CASE WHEN pr.status = 'rejected' THEN 'rejected' ELSE 'approved' END AS decision,
             pr.approved_at AS decision_date, pr.rejection_reason AS comments
        FROM purchase_requests pr LEFT JOIN employees e ON e.id = pr.requested_by_employee_id
       WHERE pr.approved_by = $1 AND pr.approved_at IS NOT NULL`, [ctx.employeeId]);
  },
};

async function procurementSettings(ctx, companyId) {
  ctx._procSettings ??= new Map();
  const key = String(companyId);
  if (!ctx._procSettings.has(key)) {
    const rows = await q(
      `SELECT * FROM procurement_settings WHERE company_id = $1 LIMIT 1`, [companyId]);
    ctx._procSettings.set(key, rows[0] || {});
  }
  return ctx._procSettings.get(key);
}

const ecn = {
  type: 'ecn', label: 'ECN', page: 'ECNManagement', myPage: 'ECNManagement',
  // Parallel approvers: one engineering_change_approvals row per approver; the
  // change is approved when none remain pending (ecn.routes.js).
  pending(companyId) {
    return q(`
      SELECT 'ecn:' || c.id AS id, c.id::text AS source_id,
             CONCAT('[', c.change_type, '] ', c.title) AS request_title, c.reason AS description,
             NULL::numeric AS amount,
             e.id AS requester_emp_id, COALESCE(${name('e')}, c.requested_by_name) AS requested_by,
             e.company_email AS requester_email, NULL AS department, c.created_at AS request_date, c.company_id,
             CASE c.severity WHEN 'critical' THEN 'High' WHEN 'high' THEN 'High' WHEN 'medium' THEN 'Medium' ELSE 'Low' END AS priority,
             COALESCE(ARRAY_AGG(a.approver_id) FILTER (WHERE a.status = 'pending'), '{}') AS pending_approver_ids,
             COUNT(a.id) FILTER (WHERE a.status = 'approved') AS approvals_done,
             COUNT(a.id) AS approvals_total
        FROM engineering_changes c
        LEFT JOIN employees e ON e.id = c.requested_by
        LEFT JOIN engineering_change_approvals a ON a.engineering_change_id = c.id
       WHERE c.status = 'submitted' ${cf(companyId, 'c.company_id')}
       GROUP BY c.id, e.id`, cp(companyId));
  },
  stage: (r) => `Parallel review (${r.approvals_done}/${r.approvals_total} approved)`,
  // Mirrors ecn.routes.js: only a named approver holding a PENDING row may
  // decide. A change with no named approvers cannot be decided by anyone
  // (409 APPROVER_CONFIGURATION_REQUIRED) — it is in nobody's inbox.
  canAct: (ctx, r) => can(ctx, 'engineering', 'can_add')
    && (r.pending_approver_ids || []).map(String).includes(String(ctx.userId)),
  actions: (r) => ({
    approve: req_('post', `/engineering/ecn/changes/${r.source_id}/approve`, {}, 'remarks'),
    reject:  req_('post', `/engineering/ecn/changes/${r.source_id}/reject`,  {}, 'remarks', { commentRequired: true }),
  }),
  mine(ctx) {
    return q(`
      SELECT 'ecn:' || c.id AS id, c.id::text AS source_id,
             CONCAT('[', c.change_type, '] ', c.title) AS request_title, NULL::numeric AS amount,
             c.created_at AS request_date, c.status AS raw_status, NULL AS comments,
             CASE WHEN c.status = 'submitted' THEN
               (SELECT STRING_AGG(a.approver_name, ', ') FROM engineering_change_approvals a
                 WHERE a.engineering_change_id = c.id AND a.status = 'pending') END AS current_approver,
             c.approved_at AS decided_at
        FROM engineering_changes c
       WHERE c.requested_by = $1 AND c.status <> 'draft'`, [ctx.employeeId]);
  },
  decided(ctx) {
    return q(`
      SELECT 'ecn:' || c.id AS id, c.id::text AS source_id,
             CONCAT('[', c.change_type, '] ', c.title) AS request_title,
             c.requested_by_name AS requested_by, c.created_at AS request_date,
             a.status AS decision, a.acted_at AS decision_date, a.remarks AS comments
        FROM engineering_change_approvals a JOIN engineering_changes c ON c.id = a.engineering_change_id
       WHERE a.approver_id = $1 AND a.status IN ('approved', 'rejected')`, [ctx.userId]);
  },
  chain(sourceId) {
    return q(`
      SELECT COALESCE(a.role_name, 'Approver') AS step, a.approver_name, INITCAP(a.status) AS status,
             a.acted_at AS decision_date, a.remarks AS comment
        FROM engineering_change_approvals a WHERE a.engineering_change_id = $1 ORDER BY a.id`, [sourceId]);
  },
};

const payment = {
  type: 'pay', label: 'Payment', page: 'PaymentBatch', myPage: 'PaymentBatch',
  // Status vocabulary is the module's ('pending_approval'); the Approval Center
  // used to look for 'Awaiting_Approval', which no writer produces.
  pending(companyId) {
    return q(`
      SELECT 'pay:' || b.id AS id, b.id::text AS source_id,
             CONCAT('Payment batch ', b.batch_number) AS request_title, b.notes AS description,
             b.total_amount AS amount, 'INR' AS amount_unit,
             e.id AS requester_emp_id, COALESCE(${name('e')}, u.email) AS requested_by, u.email AS requester_email,
             NULL AS department, COALESCE(b.created_at, b.batch_date::timestamp) AS request_date, b.company_id,
             b.created_by AS requester_user_id, 'High' AS priority
        FROM payment_batches b
        LEFT JOIN users u ON u.id = b.created_by
        LEFT JOIN employees e ON e.id = u.employee_id
       WHERE b.status = 'pending_approval' ${cf(companyId, 'b.company_id')}`, cp(companyId));
  },
  stage: () => 'Finance approver',
  // Maker ≠ checker (paymentBatch.service.js approveBatch).
  canAct: (ctx, r) => can(ctx, 'finance', 'can_approve')
    && !(r.requester_user_id != null && String(r.requester_user_id) === String(ctx.userId)),
  actions: (r) => ({
    approve: req_('post', `/finance/payment-batches/${r.source_id}/approve`, {}, null),
    reject:  req_('post', `/finance/payment-batches/${r.source_id}/reject`,  {}, 'reason', { commentRequired: true }),
  }),
  mine(ctx) {
    return q(`
      SELECT 'pay:' || b.id AS id, b.id::text AS source_id,
             CONCAT('Payment batch ', b.batch_number) AS request_title, b.total_amount AS amount, 'INR' AS amount_unit,
             COALESCE(b.created_at, b.batch_date::timestamp) AS request_date, b.status AS raw_status,
             b.rejection_reason AS comments,
             CASE WHEN b.status = 'pending_approval' THEN 'Finance approver' END AS current_approver,
             COALESCE(b.approved_at, b.rejected_at) AS decided_at
        FROM payment_batches b
       WHERE b.created_by = $1 AND b.status <> 'draft'`, [ctx.userId]);
  },
  decided(ctx) {
    return q(`
      SELECT 'pay:' || b.id AS id, b.id::text AS source_id,
             CONCAT('Payment batch ', b.batch_number) AS request_title, NULL AS requested_by,
             COALESCE(b.created_at, b.batch_date::timestamp) AS request_date,
             CASE WHEN b.rejected_by = $1 THEN 'rejected' ELSE 'approved' END AS decision,
             CASE WHEN b.rejected_by = $1 THEN b.rejected_at ELSE b.approved_at END AS decision_date,
             b.rejection_reason AS comments
        FROM payment_batches b
       WHERE b.approved_by = $1 OR b.rejected_by = $1`, [ctx.userId]);
  },
};

const travel = {
  type: 'travel', label: 'Travel', page: 'TravelApprovals', myPage: 'TravelRequests',
  pending(companyId) {
    return q(`
      SELECT 'travel:' || t.id AS id, t.id::text AS source_id,
             CONCAT('Travel ', COALESCE(t.request_number, '#' || t.id), ' · ', COALESCE(t.destination, ''),
                    ' (', TO_CHAR(t.from_date, 'DD Mon'), ')') AS request_title,
             t.purpose AS description, NULL::numeric AS amount,
             e.id AS requester_emp_id, COALESCE(${name('e')}, t.employee_name) AS requested_by,
             e.company_email AS requester_email, e.department, t.created_at AS request_date, t.company_id,
             t.delegate_approver_id AS delegate_emp_id
        FROM travel_requests t
        LEFT JOIN employees e ON e.id = t.employee_id
       WHERE t.status = 'Pending' ${cf(companyId, 't.company_id')}`, cp(companyId));
  },
  stage: () => 'Reporting manager',
  canAct: (ctx, r) => managerApproves(ctx, r.requester_emp_id, r.delegate_emp_id),
  actions: (r) => ({
    approve: req_('put', `/travel/requests/${r.source_id}/status`, { status: 'Approved' }, 'comments'),
    reject:  req_('put', `/travel/requests/${r.source_id}/status`, { status: 'Rejected' }, 'comments', { commentRequired: true }),
    delegate: req_('post', `/travel/requests/${r.source_id}/delegate`, {}, null, { delegateKey: 'delegate_employee_id' }),
  }),
  mine(ctx) {
    return q(`
      SELECT 'travel:' || t.id AS id, t.id::text AS source_id,
             CONCAT('Travel ', COALESCE(t.request_number, '#' || t.id), ' · ', COALESCE(t.destination, '')) AS request_title,
             NULL::numeric AS amount, t.created_at AS request_date, t.status AS raw_status, NULL AS comments,
             CASE WHEN t.status = 'Pending' THEN COALESCE(${name('d')}, ${name('m')}, 'Reporting manager') END AS current_approver,
             NULL::timestamp AS decided_at
        FROM travel_requests t
        LEFT JOIN employees e ON e.id = t.employee_id
        LEFT JOIN employees m ON m.id = e.reporting_manager_id
        LEFT JOIN employees d ON d.id = t.delegate_approver_id
       WHERE t.employee_id = $1 OR t.created_by = $2`, [ctx.employeeId, ctx.userId]);
  },
  decided(ctx) {
    // PUT /travel/requests/:id/status records the decider only in the audit log.
    return q(`
      SELECT DISTINCT ON (t.id) 'travel:' || t.id AS id, t.id::text AS source_id,
             CONCAT('Travel ', COALESCE(t.request_number, '#' || t.id), ' · ', COALESCE(t.destination, '')) AS request_title,
             t.employee_name AS requested_by, t.created_at AS request_date,
             CASE WHEN al.action_type = 'reject' THEN 'rejected' ELSE 'approved' END AS decision,
             al.created_at AS decision_date, NULL AS comments
        FROM audit_logs al JOIN travel_requests t ON t.id::text = al.reference_id::text
       WHERE al.user_id = $1 AND al.module_name = 'travel' AND al.reference_type = 'travel_request'
         AND al.action_type IN ('approve', 'reject')
       ORDER BY t.id, al.created_at DESC`, [ctx.userId]);
  },
};

const ADV_STAGE = { 'Pending Finance': 'L1 — Finance review', 'Pending Manager': 'L2 — Reporting manager' };
const advance = {
  type: 'adv', label: 'Travel Advance', page: 'TravelAdvances', myPage: 'TravelAdvances',
  // travel_advances.employee_id holds a users.id (travel.routes.js) — resolve
  // the employee the way resolveAdvanceRequesterEmployeeId() does.
  pending(companyId) {
    return q(`
      SELECT 'adv:' || a.id AS id, a.id::text AS source_id,
             CONCAT('Travel advance · ', COALESCE(t.request_number, a.purpose, '#' || a.id)) AS request_title,
             a.purpose AS description, a.amount, 'INR' AS amount_unit,
             e.id AS requester_emp_id, ${name('e')} AS requested_by, e.company_email AS requester_email,
             e.department, a.created_at AS request_date, a.company_id,
             a.delegate_approver_id AS delegate_emp_id, a.status AS raw_status
        FROM travel_advances a
        LEFT JOIN travel_requests t ON t.id = a.travel_request_id
        LEFT JOIN users u ON u.id = a.employee_id
        LEFT JOIN employees e ON e.id = COALESCE(t.employee_id, u.employee_id)
       WHERE a.status IN ('Pending Finance', 'Pending Manager') ${cf(companyId, 'a.company_id')}`, cp(companyId));
  },
  stage: (r) => ADV_STAGE[r.raw_status],
  canAct(ctx, r) {
    if (r.raw_status === 'Pending Finance') return holds(ctx, 'admin', 'super_admin', 'finance');
    return managerApproves(ctx, r.requester_emp_id, r.delegate_emp_id);
  },
  actions(r) {
    const path = r.raw_status === 'Pending Finance' ? 'finance-review' : 'manager-review';
    const url = `/travel/advances/${r.source_id}/${path}`;
    return {
      approve: req_('put', url, { status: 'Approved' }, 'comments'),
      reject:  req_('put', url, { status: 'Rejected' }, 'comments', { commentRequired: true }),
      ...(r.raw_status === 'Pending Manager' ? { delegate: req_('post', `/travel/advances/${r.source_id}/delegate`, {}, null, { delegateKey: 'delegate_employee_id' }) } : {}),
    };
  },
  mine(ctx) {
    return q(`
      SELECT 'adv:' || a.id AS id, a.id::text AS source_id,
             CONCAT('Travel advance · ', COALESCE(a.purpose, '#' || a.id)) AS request_title,
             a.amount, 'INR' AS amount_unit, a.created_at AS request_date, a.status AS raw_status,
             COALESCE(a.manager_comments, a.finance_comments) AS comments,
             CASE a.status WHEN 'Pending Finance' THEN 'Finance'
                           WHEN 'Pending Manager' THEN 'Reporting manager' END AS current_approver,
             COALESCE(a.manager_at, a.finance_at) AS decided_at
        FROM travel_advances a
       WHERE a.employee_id = $1`, [ctx.userId]);
  },
  myActions(r) {
    // Native resubmit after a finance rejection (PUT /travel/advances/:id/resubmit).
    return r.raw_status === 'Finance Rejected' ? { resubmitPage: 'TravelAdvances' } : {};
  },
  decided(ctx) {
    return q(`
      SELECT 'adv:' || a.id AS id, a.id::text AS source_id,
             CONCAT('Travel advance · ', COALESCE(a.purpose, '#' || a.id)) AS request_title,
             NULL AS requested_by, a.created_at AS request_date,
             CASE WHEN a.manager_by = $1 THEN (CASE WHEN a.status = 'Rejected' THEN 'rejected' ELSE 'approved' END)
                  ELSE (CASE WHEN a.status = 'Finance Rejected' THEN 'rejected' ELSE 'approved' END) END AS decision,
             CASE WHEN a.manager_by = $1 THEN a.manager_at ELSE a.finance_at END AS decision_date,
             CASE WHEN a.manager_by = $1 THEN a.manager_comments ELSE a.finance_comments END AS comments
        FROM travel_advances a
       WHERE a.manager_by = $1 OR a.finance_by = $1`, [ctx.userId]);
  },
};

// Requisition and offer have no approval screen of their own — the Approval
// Center IS their native path (approvals.controller.js approveSourceItem), and
// "reject" returns them to draft for the requester to revise: Send back.
const requisition = {
  type: 'requisition', label: 'Requisition', page: 'JobRequisitionPipeline', myPage: 'JobRequisitionPipeline', native: 'approvals',
  pending(companyId) {
    return q(`
      SELECT 'requisition:' || jr.id AS id, jr.id::text AS source_id,
             CONCAT(jr.job_title, ' (', jr.number_of_positions, ' position',
                    CASE WHEN jr.number_of_positions = 1 THEN '' ELSE 's' END, ')') AS request_title,
             jr.job_description AS description, NULL::numeric AS amount,
             e.id AS requester_emp_id, ${name('e')} AS requested_by, e.company_email AS requester_email,
             jr.department, jr.created_at AS request_date, jr.company_id,
             CASE WHEN jr.number_of_positions >= 3 THEN 'High' WHEN jr.number_of_positions = 2 THEN 'Medium' ELSE 'Low' END AS priority
        FROM job_requisitions jr LEFT JOIN employees e ON e.id = jr.requested_by
       WHERE jr.status = 'pending_approval' AND jr.deleted_at IS NULL ${cf(companyId, 'jr.company_id')}`, cp(companyId));
  },
  stage: () => 'Approver',
  canAct: (ctx, r) => (canOverride(ctx.req) || (isApproverRole(ctx.req) && canClaimCategory(ctx.req, 'requisition')))
    && !(ctx.employeeId != null && String(ctx.employeeId) === String(r.requester_emp_id)),
  actions: (r) => ({
    approve: req_('post', `/approvals/${r.id}/approve`, {}, 'comment'),
    reject:  req_('post', `/approvals/${r.id}/reject`,  {}, 'comment', { commentRequired: true, label: 'Send back' }),
  }),
  mine(ctx) {
    return q(`
      SELECT 'requisition:' || jr.id AS id, jr.id::text AS source_id,
             CONCAT('Requisition · ', jr.job_title) AS request_title, NULL::numeric AS amount,
             jr.created_at AS request_date,
             CASE WHEN jr.status = 'draft' AND last.status = 'Rejected' THEN 'sent_back' ELSE jr.status END AS raw_status,
             last.comments,
             CASE WHEN jr.status = 'pending_approval' THEN 'Approver' END AS current_approver,
             last.decision_date AS decided_at
        FROM job_requisitions jr
        LEFT JOIN LATERAL (SELECT status, comments, decision_date FROM approvals
                            WHERE module_name = 'requisition' AND reference_id = jr.id
                            ORDER BY decision_date DESC NULLS LAST LIMIT 1) last ON TRUE
       WHERE jr.requested_by = $1 AND jr.deleted_at IS NULL
         AND (jr.status <> 'draft' OR last.status = 'Rejected')`, [ctx.employeeId]);
  },
  myActions: (r) => (r.raw_status === 'sent_back' ? { resubmitPage: 'JobRequisitionPipeline' } : {}),
};

const offer = {
  type: 'offer', label: 'Offer Letter', page: 'OfferManagement', myPage: 'OfferManagement', native: 'approvals',
  pending(companyId) {
    return q(`
      SELECT 'offer:' || ol.id AS id, ol.id::text AS source_id,
             CONCAT('Offer: ', c.full_name, ' — ', COALESCE(jo.job_title, jr.job_title, 'Position')) AS request_title,
             ol.notes AS description, ol.offered_salary AS amount, 'INR' AS amount_unit,
             e.id AS requester_emp_id, COALESCE(${name('e')}, 'Recruitment') AS requested_by,
             e.company_email AS requester_email, NULL AS department, ol.created_at AS request_date, ol.company_id
        FROM offer_letters ol
        JOIN candidates c ON c.id = ol.candidate_id
        LEFT JOIN job_openings jo ON jo.id = ol.job_opening_id
        LEFT JOIN job_requisitions jr ON jr.id = jo.requisition_id
        LEFT JOIN employees e ON e.id = ol.created_by
       WHERE ol.offer_status = 'pending_approval' AND ol.deleted_at IS NULL ${cf(companyId, 'ol.company_id')}`, cp(companyId));
  },
  stage: () => 'Approver',
  canAct: (ctx, r) => (canOverride(ctx.req) || (isApproverRole(ctx.req) && canClaimCategory(ctx.req, 'offer')))
    && !(ctx.employeeId != null && String(ctx.employeeId) === String(r.requester_emp_id)),
  actions: (r) => ({
    approve: req_('post', `/approvals/${r.id}/approve`, {}, 'comment'),
    reject:  req_('post', `/approvals/${r.id}/reject`,  {}, 'comment', { commentRequired: true, label: 'Send back' }),
  }),
  mine(ctx) {
    return q(`
      SELECT 'offer:' || ol.id AS id, ol.id::text AS source_id,
             CONCAT('Offer: ', c.full_name) AS request_title, ol.offered_salary AS amount, 'INR' AS amount_unit,
             ol.created_at AS request_date,
             CASE WHEN ol.offer_status = 'draft' AND last.status = 'Rejected' THEN 'sent_back' ELSE ol.offer_status END AS raw_status,
             last.comments,
             CASE WHEN ol.offer_status = 'pending_approval' THEN 'Approver' END AS current_approver,
             last.decision_date AS decided_at
        FROM offer_letters ol
        JOIN candidates c ON c.id = ol.candidate_id
        LEFT JOIN LATERAL (SELECT status, comments, decision_date FROM approvals
                            WHERE module_name = 'offer' AND title = 'Offer #' || ol.id::text
                            ORDER BY decision_date DESC NULLS LAST LIMIT 1) last ON TRUE
       WHERE ol.created_by = $1 AND ol.deleted_at IS NULL
         AND (ol.offer_status <> 'draft' OR last.status = 'Rejected')`, [ctx.employeeId]);
  },
  myActions: (r) => (r.raw_status === 'sent_back' ? { resubmitPage: 'OfferManagement' } : {}),
};

// Review queues: work assigned to ONE person, completed on its own form (ratings,
// comments, recommendation) — not an approve/reject. They are listed so My
// Pending Approvals (and Home's preview of it) is the whole of what waits on
// the caller; the only action is `open`, which takes them to that form. The
// assignee is matched on the LIVE login link (users.employee_id), the identity
// the modules themselves use (internEvaluations.routes.js callerEmployeeId,
// probationReviews.service.js linkedEmployee) — never a role.

const internEval = {
  type: 'ieval', label: 'Intern Evaluation', page: 'MyInternEvaluations',
  // Same rule as GET /intern-evaluations/mine/summary `needs_action`: an open
  // intern the assignee mentors (or whose evaluation HR sent them), whose latest
  // evaluation by that mentor is missing, a Draft, or Returned by HR.
  pending(companyId) {
    return q(`
      SELECT 'ieval:' || i.id || ':' || m.emp AS id, i.id::text AS source_id,
             CONCAT('Evaluate intern ', NULLIF(TRIM(CONCAT(i.first_name, ' ', COALESCE(i.last_name, ''))), ''),
                    COALESCE(' (' || i.intern_code || ')', '')) AS request_title,
             CASE ev.status WHEN 'Returned' THEN CONCAT('Returned by HR: ', ev.return_reason)
                            WHEN 'Draft' THEN 'Draft saved — not submitted yet' END AS description,
             NULL::numeric AS amount, NULL AS requester_emp_id,
             COALESCE(qu.name, 'HR') AS requested_by, NULL AS requester_email, i.department,
             COALESCE(ev.request_sent_at, ev.created_at, i.start_date::timestamp) AS request_date, i.company_id,
             m.emp AS assignee_emp_id, COALESCE(ev.status, 'none') AS stage_key
        FROM interns i
        CROSS JOIN LATERAL (
          SELECT i.mentor_employee_id AS emp
          UNION
          SELECT aev.mentor_employee_id FROM intern_evaluations aev
           WHERE aev.intern_id = i.id AND aev.request_sent_at IS NOT NULL
             AND aev.status IN ('Draft', 'Submitted', 'Returned')) m
        JOIN employees me ON me.id = m.emp AND me.company_id = i.company_id
                         AND me.deleted_at IS NULL AND ${isCurrentSql('me.status')}
        LEFT JOIN LATERAL (SELECT * FROM intern_evaluations x
                            WHERE x.intern_id = i.id AND x.mentor_employee_id = m.emp
                            ORDER BY x.id DESC LIMIT 1) ev ON TRUE
        LEFT JOIN users qu ON qu.id = ev.requested_by_user_id
       WHERE i.deleted_at IS NULL AND m.emp IS NOT NULL
         AND i.status NOT IN ('Completed', 'Cancelled', 'Terminated')
         AND COALESCE(ev.status, 'none') IN ('none', 'Draft', 'Returned')
         ${cf(companyId, 'i.company_id')}`, cp(companyId));
  },
  stage: (r) => ({ none: 'Mentor — not started', Draft: 'Mentor — draft', Returned: 'Mentor — returned by HR' })[r.stage_key] || 'Mentor',
  canAct: (ctx, r) => ctx.linkedEmployeeId != null && String(r.assignee_emp_id) === String(ctx.linkedEmployeeId),
  actions: () => ({ open: { page: 'MyInternEvaluations', params: {} } }),
};

const probationReview = {
  type: 'prob', label: 'Probation Review', page: 'MyProbationReviews',
  // Same rule as GET /probation-reviews/mine/summary `needs_action`.
  pending(companyId) {
    return q(`
      SELECT 'prob:' || r.id AS id, r.id::text AS source_id,
             CONCAT('Probation review · ', ${name('e')}, COALESCE(' (' || e.office_id || ')', '')) AS request_title,
             CASE WHEN r.reviewer_due_date IS NOT NULL THEN CONCAT('Due ', TO_CHAR(r.reviewer_due_date, 'DD Mon YY')) END AS description,
             NULL::numeric AS amount, NULL AS requester_emp_id,
             COALESCE(rq.name, 'HR') AS requested_by, NULL AS requester_email, e.department,
             r.requested_at AS request_date, r.company_id, r.reviewer_employee_id AS assignee_emp_id,
             CASE WHEN r.reviewer_due_date < CURRENT_DATE THEN 'High' ELSE 'Medium' END AS priority
        FROM probation_reviews r
        JOIN employees e ON e.id = r.employee_id
        LEFT JOIN users rq ON rq.id = r.requested_by_user_id
       WHERE r.status = 'requested' ${cf(companyId, 'r.company_id')}`, cp(companyId));
  },
  stage: () => 'Department head',
  canAct: (ctx, r) => ctx.linkedEmployeeId != null && String(r.assignee_emp_id) === String(ctx.linkedEmployeeId),
  actions: (r) => ({ open: { page: 'MyProbationReviews', params: { ref: r.source_id } } }),
};

// Gate passes (hr/biometric.routes.js). The approver is the pass holder's
// department head, else their reporting manager, else HR — one rule in
// shared/gatePassApprover.js, used by the endpoint too, so this mirror is the
// rule itself rather than a copy of it. Reject = cancel with a reason, which
// the designated approver may do while the pass is pending. §198.
const GP_TITLE = (a) => `CONCAT('Gate pass · ', COALESCE(${name('e')}, ${a}.visitor_name, 'Visitor'),
  COALESCE(' · ' || TO_CHAR(${a}.valid_from AT TIME ZONE 'Asia/Kolkata', 'DD Mon YY HH24:MI'), ''))`;
const gatePass = {
  type: 'gate', label: 'Gate Pass', page: 'BiometricAccess', myPage: 'BiometricAccess',
  pending(companyId) {
    return q(`
      SELECT 'gate:' || gp.id AS id, gp.id::text AS source_id,
             ${GP_TITLE('gp')} AS request_title,
             gp.purpose AS description, NULL::numeric AS amount,
             gp.employee_id AS requester_emp_id, gp.employee_id,
             COALESCE(${name('e')}, gp.visitor_name) AS requested_by,
             e.company_email AS requester_email, e.department, gp.created_at AS request_date, gp.company_id,
             appr.approver_kind, appr.approver_employee_id, appr.approver_name
        FROM gate_passes gp
        LEFT JOIN employees e ON e.id = gp.employee_id
        ${GP_APPROVER_JOIN}
       WHERE gp.status = 'pending' AND (gp.valid_to IS NULL OR gp.valid_to > NOW())
         ${cf(companyId, 'gp.company_id')}`, cp(companyId));
  },
  stage: (r) => APPROVER_LABEL[r.approver_kind] || 'Approver',
  canAct: (ctx, r) => approverDecision(r, { callerEmployeeId: ctx.employeeId, hrEdit: can(ctx, 'hr', 'can_edit') }).ok,
  actions: (r) => ({
    approve: req_('put', `/gate-passes/${r.source_id}/approve`, {}, null),
    reject:  req_('put', `/gate-passes/${r.source_id}/cancel`, {}, 'reason', { commentRequired: true }),
  }),
  mine(ctx) {
    return q(`
      SELECT 'gate:' || gp.id AS id, gp.id::text AS source_id, ${GP_TITLE('gp')} AS request_title,
             NULL::numeric AS amount, gp.created_at AS request_date,
             CASE WHEN gp.status = 'cancelled' AND gp.approved_at IS NULL THEN 'rejected' ELSE gp.status END AS raw_status,
             gp.cancel_reason AS comments,
             CASE WHEN gp.status = 'pending' THEN COALESCE(appr.approver_name, 'HR') END AS current_approver,
             COALESCE(gp.approved_at, gp.cancelled_at) AS decided_at
        FROM gate_passes gp
        LEFT JOIN employees e ON e.id = gp.employee_id
        ${GP_APPROVER_JOIN}
       WHERE gp.employee_id = $1`, [ctx.employeeId]);
  },
  decided(ctx) {
    return q(`
      SELECT 'gate:' || gp.id AS id, gp.id::text AS source_id, ${GP_TITLE('gp')} AS request_title,
             COALESCE(${name('e')}, gp.visitor_name) AS requested_by, gp.created_at AS request_date,
             CASE WHEN gp.approved_by = $1 THEN 'approved' ELSE 'rejected' END AS decision,
             CASE WHEN gp.approved_by = $1 THEN gp.approved_at ELSE gp.cancelled_at END AS decision_date,
             gp.cancel_reason AS comments
        FROM gate_passes gp
        LEFT JOIN employees e ON e.id = gp.employee_id
       WHERE gp.approved_by = $1 OR (gp.cancelled_by = $1 AND gp.approved_at IS NULL)`, [ctx.employeeId]);
  },
};

export const SOURCES = [leave, regularization, overtime, expense, purchase, ecn, payment, travel, advance, requisition, offer,
  internEval, probationReview, gatePass];
export const SOURCE_BY_TYPE = Object.fromEntries(SOURCES.map(s => [s.type, s]));

/** Types whose decision belongs to a module endpoint, never to /approvals. */
export const MODULE_DECIDED_TYPES = new Set(SOURCES.filter(s => s.native !== 'approvals').map(s => s.type));

// Central `approvals` table rows that are NOT shadows of a source type. Those
// rows (module_name leave/pr/…) were history written by the old Approval Center
// path, or seed rows with no reference — the live record is the source table.
const SHADOW_MODULES = ['leave', 'regularization', 'reg', 'ot', 'purchase_request', 'purchase', 'pr',
  'expense', 'exp', 'ecn', 'payment', 'pay', 'requisition', 'offer', 'travel', 'adv'];

export const central = {
  type: 'appr', label: 'Approval',
  pending(companyId) {
    return q(`
      SELECT a.id::text AS id, a.id::text AS source_id, COALESCE(a.title, a.request_title, 'Approval request') AS request_title,
             a.description, NULL::numeric AS amount, NULL AS requester_emp_id,
             COALESCE(a.requester_name, a.requested_by::text) AS requested_by, NULL AS requester_email,
             NULL AS department, a.request_date, a.company_id, a.approver_id, a.requested_by AS requester_user_id,
             COALESCE(a.module_name, a.reference_type) AS category
        FROM approvals a
       WHERE a.status = 'Pending' AND COALESCE(a.module_name, a.reference_type, '') <> ALL($${companyId != null ? 2 : 1})
             ${companyId != null ? 'AND a.company_id = $1' : ''}`,
      companyId != null ? [companyId, SHADOW_MODULES] : [SHADOW_MODULES]);
  },
  stage: () => 'Assigned approver',
  canAct(ctx, r) {
    if (r.requester_user_id != null && String(r.requester_user_id) === String(ctx.userId)) return false;
    if (canOverride(ctx.req)) return true;
    if (r.approver_id != null) return String(r.approver_id) === String(ctx.userId);
    return isApproverRole(ctx.req) && canClaimCategory(ctx.req, r.category);
  },
  actions: (r) => ({
    approve: req_('post', `/approvals/${r.id}/approve`, {}, 'comment'),
    reject:  req_('post', `/approvals/${r.id}/reject`,  {}, 'comment', { commentRequired: true }),
    delegate: req_('post', '/approvals/delegate', { ids: [r.id] }, null, { delegateKey: 'delegate_to_user_id', delegateIdField: 'user_id' }),
  }),
  mine(ctx) {
    return q(`
      SELECT a.id::text AS id, a.id::text AS source_id, COALESCE(a.title, a.request_title, 'Approval request') AS request_title,
             NULL::numeric AS amount, a.request_date, LOWER(a.status) AS raw_status, a.comments,
             CASE WHEN a.status = 'Pending' THEN COALESCE(${name('e')}, u.email, 'Approver') END AS current_approver,
             a.decision_date AS decided_at, COALESCE(a.module_name, a.reference_type) AS category
        FROM approvals a
        LEFT JOIN users u ON u.id = a.approver_id
        LEFT JOIN employees e ON e.id = u.employee_id
       WHERE a.requested_by = $1`, [ctx.userId]);
  },
  decided(ctx) {
    return q(`
      SELECT a.id::text AS id, a.reference_id::text AS source_id,
             COALESCE(a.title, a.request_title, 'Approval request') AS request_title,
             COALESCE(NULLIF(a.requester_name, 'System'), a.requested_by::text) AS requested_by,
             a.request_date, LOWER(a.status) AS decision, a.decision_date, a.comments,
             COALESCE(a.module_name, a.reference_type) AS category
        FROM approvals a
       WHERE a.approver_id = $1 AND a.status IN ('Approved', 'Rejected')`, [ctx.userId]);
  },
};

// ── SLA ──────────────────────────────────────────────────────────────────────

export async function loadSlaHours() {
  const rows = await q(`
    SELECT w.module, MIN(ws.sla_hours) AS sla_hours
      FROM workflow_steps ws JOIN workflows w ON w.id = ws.workflow_id
     WHERE w.is_active AND ws.sla_hours IS NOT NULL
     GROUP BY w.module`);
  const byModule = Object.fromEntries(rows.map(r => [r.module, Number(r.sla_hours)]));
  const out = {};
  for (const s of SOURCES) {
    const configured = byModule[SLA_WORKFLOW_MODULE[s.type]];
    out[s.type] = configured > 0
      ? { hours: configured, source: 'configured' }
      : { hours: DEFAULT_SLA_HOURS, source: 'default' };
  }
  out.appr = { hours: DEFAULT_SLA_HOURS, source: 'default' };
  return out;
}

// ── Display status ───────────────────────────────────────────────────────────

/** One requester-facing vocabulary over the modules' many status spellings. */
export function displayStatus(raw) {
  const s = String(raw || '').toLowerCase().replace(/_/g, ' ');
  if (s === 'sent back') return 'Sent back';
  if (/(^|\s)rejected$/.test(s)) return 'Rejected';
  if (['cancelled', 'canceled', 'withdrawn'].includes(s)) return 'Cancelled';
  if (['pending', 'submitted', 'pending approval', 'manager approved', 'accounts verified',
       'pending finance', 'pending manager'].includes(s)) return 'Pending';
  if (['approved', 'mgmt approved', 'paid', 'auto approved', 'converted to po', 'sent', 'accepted',
       'open', 'closed', 'implemented', 'processed'].includes(s)) return 'Approved';
  return s ? s.replace(/\b\w/g, c => c.toUpperCase()) : '—';
}
