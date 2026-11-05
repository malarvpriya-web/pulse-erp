import express from 'express';
import pool from '../../../config/db.js';
import leavesRepository from '../repositories/leaves.repository.js';
import { requirePermission, allowRoles } from '../../../middlewares/auth.middleware.js';
import { validate } from '../../../services/ValidationEngineService.js';
import { evaluateRules } from '../../../services/RuleEngineService.js';
import { logAudit } from '../../../services/AuditService.js';
import { authorizeManagerApproval, DENIED_MESSAGE } from '../../../shared/managerApprovalAuthz.js';
import { hasRole } from '../../../middlewares/auth.middleware.js';
import { employeeOf, companyOf } from '../../../shared/scope.js';

const router = express.Router();

// Leave-type definitions and quota allocations are HR/admin-only. These routes
// share the 'leaves.add' permission with self-service Apply Leave, so a role
// check is required on top — otherwise any employee who can apply for leave
// could also change quotas ("12 leaves" drifting) and leave types.
const LEAVE_ADMIN_ROLES = ['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec'];
const requireLeaveAdmin = allowRoles(...LEAVE_ADMIN_ROLES);

// ── Auto-sync approved leave to attendance_records ───────────────────────────
async function syncLeaveToAttendance(application, poolRef) {
  try {
    if (!application || application.status !== 'approved') return;
    const { employee_id, from_date, to_date, leave_type_id, company_id } = application;
    // Support both start_date/end_date and from_date/to_date field names
    const startDate = application.start_date || from_date;
    const endDate   = application.end_date   || to_date;
    if (!employee_id || !startDate || !endDate) return;

    // Get leave type details (for WFH detection)
    const ltRow = await poolRef.query(
      'SELECT name, leave_name FROM leave_types WHERE id=$1 LIMIT 1',
      [leave_type_id]
    ).catch(() => ({ rows: [] }));
    const leaveName = ((ltRow.rows[0]?.name || ltRow.rows[0]?.leave_name || '')).toLowerCase();
    const workMode = leaveName.includes('wfh') || leaveName.includes('work from home') ? 'wfh' : 'office';
    const isHalfDay = application.is_half_day || application.duration === 0.5 || application.half_day;

    // Resolve company_id if not on the application
    let resolvedCompanyId = company_id ?? null;
    if (resolvedCompanyId == null) {
      const empRow = await poolRef.query(
        'SELECT company_id FROM employees WHERE id=$1 LIMIT 1', [employee_id]
      ).catch(() => ({ rows: [] }));
      resolvedCompanyId = empRow.rows[0]?.company_id ?? null;
    }

    // Iterate each date in the leave range
    const start = new Date(startDate);
    const end   = new Date(endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (dow === 0 || dow === 6) continue; // Skip weekends
      const dateStr = d.toISOString().split('T')[0];

      // Skip holidays
      const isHoliday = await poolRef.query(
        'SELECT 1 FROM holidays WHERE date=$1::date AND (company_id=$2 OR company_id IS NULL) LIMIT 1',
        [dateStr, resolvedCompanyId]
      ).then(r => r.rows.length > 0).catch(() => false);
      if (isHoliday) continue;

      const status = isHalfDay ? 'half_day' : (workMode === 'wfh' ? 'wfh' : 'on_leave');

      await poolRef.query(`
        INSERT INTO attendance_records
          (employee_id, attendance_date, status, work_mode, company_id, source)
        VALUES ($1, $2, $3, $4, $5, 'leave_sync')
        ON CONFLICT (employee_id, attendance_date)
        DO UPDATE SET
          status = CASE
            WHEN attendance_records.status IN ('present','late') THEN attendance_records.status
            ELSE EXCLUDED.status
          END,
          work_mode = CASE
            WHEN attendance_records.status IN ('present','late') THEN attendance_records.work_mode
            ELSE EXCLUDED.work_mode
          END,
          updated_at = NOW()
      `, [employee_id, dateStr, status, workMode, resolvedCompanyId]);
    }
  } catch (err) {
    console.error('[leave-sync] Error syncing leave to attendance:', err.message);
  }
}

// ── Reverse attendance records created by a previously-approved leave ─────────
async function reverseLeaveAttendance(application, poolRef) {
  try {
    if (!application) return;
    const startDate = application.start_date || application.from_date;
    const endDate   = application.end_date   || application.to_date;
    const { employee_id } = application;
    if (!employee_id || !startDate || !endDate) return;

    // Only delete records that the leave-sync originally inserted (source='leave_sync').
    // This ensures we never clobber biometric or manual attendance entries.
    await poolRef.query(`
      DELETE FROM attendance_records
      WHERE employee_id = $1
        AND attendance_date BETWEEN $2::date AND $3::date
        AND source = 'leave_sync'
    `, [employee_id, startDate, endDate]);
  } catch (err) {
    console.error('[leave-sync] Error reversing attendance for leave:', err.message);
  }
}

// ── Post LOP deduction to active payroll run (non-blocking) ──────────────────
async function postLopToPayroll(application, poolRef) {
  try {
    if (!application) return;
    // Only post once the leave is actually approved — a mid-workflow approval
    // (manager approved, L2/HR still pending) must not charge payroll yet.
    if (application.status && application.status !== 'approved') return;
    // Full-LOP application (probation block or LOP leave type): the whole
    // request is unpaid. Otherwise a paid leave may still carry a clubbing
    // LOP portion (weekend/holiday days auto-charged) in lop_days.
    const isFullLop = application.is_lop || application.is_lop_type;
    const days = isFullLop
      ? Number(application.number_of_days || 0)
      : Number(application.lop_days || 0);
    if (days <= 0) return;
    const startDate = application.start_date || application.from_date;
    if (!startDate) return;
    const month = new Date(startDate).getMonth() + 1;
    const year  = new Date(startDate).getFullYear();

    // Fetch employee's daily rate (basic_salary / 26)
    const { rows: empRows } = await poolRef.query(
      `SELECT basic_salary FROM employees WHERE id = $1 LIMIT 1`, [application.employee_id]
    ).catch(() => ({ rows: [] }));
    const basicSalary = Number(empRows[0]?.basic_salary || 0);
    const lopAmount = basicSalary > 0 ? Number(((basicSalary / 26) * days).toFixed(2)) : 0;

    // Find active payroll run for this employee and period
    const { rows: runRows } = await poolRef.query(`
      SELECT id FROM payroll_runs
      WHERE employee_id = $1 AND month = $2 AND year = $3 AND status IN ('draft', 'pending')  -- drafts only: an approved run is posted to the GL and backs the payslip and payment (PAYROLL_DATA_FLOW_AUDIT.md Part 10)
      LIMIT 1
    `, [application.employee_id, month, year]).catch(() => ({ rows: [] }));

    if (runRows.length) {
      await poolRef.query(`
        UPDATE payroll_runs
        SET lop_days   = COALESCE(lop_days, 0) + $1,
            lop_amount = COALESCE(lop_amount, 0) + $2,
            updated_at = NOW()
        WHERE id = $3
      `, [days, lopAmount, runRows[0].id]).catch(() => {});
    }
  } catch {
    // Non-blocking — do not break approval flow
  }
}

// ── Notification helper (non-blocking) ───────────────────────────────────────
async function notifyLeaveEvent(event, application, actor, recipients = []) {
  try {
    const { notifyWorkflowEvent } = await import('../../../services/WorkflowNotificationService.js');
    const ctx = {
      module: 'Leave',
      recordId: application.id,
      actorId: actor?.employee_id || actor?.userId,
      actorName: actor?.name || actor?.email || 'System',
      context: {
        employee_name: application.employee_name || `Employee #${application.employee_id}`,
        leave_type: application.leave_name || application.leave_type || '',
        days: application.number_of_days,
        from: application.start_date,
        to: application.end_date,
        reason: application.reason || '',
      },
      recipientIds: recipients.filter(Boolean),
    };
    await notifyWorkflowEvent(event, ctx).catch(() => {});
  } catch {
    // notifications are best-effort — never break the main flow
  }
}

// ── Project-milestone conflict alert (non-blocking) ──────────────────────────
// Warns the PM when the leave-applying employee has a project milestone due
// within ±3 calendar days of the leave window.
async function notifyProjectMilestoneConflict(application, poolRef) {
  try {
    const startDate = application.start_date || application.from_date;
    const endDate   = application.end_date   || application.to_date;
    if (!application.employee_id || !startDate || !endDate) return;

    const { rows: conflicts } = await poolRef.query(`
      SELECT DISTINCT
        p.id                  AS project_id,
        p.project_name,
        p.project_manager_id,
        pm.title              AS milestone_title,
        pm.due_date           AS milestone_due_date
      -- project_resources is a phantom twin that was never created in this
      -- schema; the real project-team table is project_members (same
      -- project_id / employee_id / end_date shape). This query silently threw,
      -- so a leave application never warned the PM about a milestone clash.
      FROM project_members pr
      JOIN projects p          ON p.id = pr.project_id
      JOIN project_milestones pm ON pm.project_id = p.id
      WHERE pr.employee_id = $1
        AND (pr.end_date IS NULL OR pr.end_date >= $2::date)
        AND pm.status != 'completed'
        AND pm.due_date BETWEEN ($2::date - INTERVAL '3 days') AND ($3::date + INTERVAL '3 days')
        AND p.project_manager_id IS NOT NULL
    `, [application.employee_id, startDate, endDate]);

    if (!conflicts.length) return;

    const { notifyWorkflowEvent } = await import('../../../services/WorkflowNotificationService.js');

    // group by PM — one notification per PM, listing all affected milestones
    const pmMap = new Map();
    for (const c of conflicts) {
      if (!pmMap.has(c.project_manager_id)) {
        pmMap.set(c.project_manager_id, { project_name: c.project_name, milestones: [] });
      }
      pmMap.get(c.project_manager_id).milestones.push(
        `${c.milestone_title} (due ${c.milestone_due_date?.toISOString?.().slice(0,10) ?? c.milestone_due_date})`
      );
    }

    for (const [pmId, info] of pmMap) {
      await notifyWorkflowEvent('leave_milestone_conflict', {
        module: 'Leave',
        recordId: application.id,
        actorId: application.employee_id,
        actorName: application.employee_name || `Employee #${application.employee_id}`,
        context: {
          employee_name: application.employee_name || `Employee #${application.employee_id}`,
          project_name: info.project_name,
          milestones: info.milestones.join('; '),
          from: startDate,
          to: endDate,
          days: application.number_of_days,
        },
        recipientIds: [pmId],
      }).catch(() => {});
    }
  } catch {
    // best-effort — never block the apply flow
  }
}

// ── Resolve manager_id from the employee's reporting_manager_id FK first,
//    then fall back to name-string match as a safety net.
async function resolveManagerEmployeeId(employee_id) {
  if (!employee_id) return null;
  try {
    // Primary: direct FK reference (reporting_manager_id column if it exists)
    const { rows: fkRows } = await pool.query(
      `SELECT reporting_manager_id AS id
       FROM employees
       WHERE id = $1
         AND reporting_manager_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM employees m WHERE m.id = reporting_manager_id AND m.status IS DISTINCT FROM 'Left')
       LIMIT 1`,
      [employee_id]
    );
    if (fkRows[0]?.id) return fkRows[0].id;

    // Fallback: name-string match
    const { rows } = await pool.query(
      `SELECT m.id
       FROM employees e
       JOIN employees m
         ON LOWER(TRIM(CONCAT(m.first_name, ' ', COALESCE(m.last_name, ''))))
            = LOWER(TRIM(COALESCE(e.reporting_manager, '')))
       WHERE e.id = $1
         AND COALESCE(e.reporting_manager, '') <> ''
         AND m.status IS DISTINCT FROM 'Left'
       LIMIT 1`,
      [employee_id]
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

function normalizeApplicationPayload(body, employee_id, leave_type_id) {
  return {
    ...body,
    employee_id,
    leave_type_id,
    start_date: body.start_date || body.from_date || body.fromDate,
    end_date: body.end_date || body.to_date || body.toDate,
    number_of_days: body.number_of_days ?? body.days ?? body.total_days ?? body.numberOfDays,
  };
}

function statusForWorkflowError(error) {
  return error.code === 'LEAVE_NOT_ACTIONABLE' ? 409 : 500;
}

async function resolveLeaveTypeId(leave_type, company_id = null) {
  if (!leave_type) return null;
  const candidates = [leave_type];
  if (!/\bleave$/i.test(leave_type)) candidates.push(`${leave_type} Leave`);
  const { rows } = await pool.query(
    `SELECT id FROM leave_types
      WHERE LOWER(leave_name) = ANY($1)
        AND is_active = true AND deleted_at IS NULL
        AND (company_id IS NULL OR company_id = $3)
      ORDER BY CASE WHEN LOWER(leave_name) = LOWER($2) THEN 0 ELSE 1 END
      LIMIT 1`,
    [candidates.map(v => v.toLowerCase()), leave_type, company_id]
  );
  return rows[0]?.id ?? null;
}

// ── Role helpers ──────────────────────────────────────────────────────────────
const ADMIN_HR_ROLES = new Set(['admin', 'super_admin', 'hr', 'hr_manager', 'hr_admin', 'hr_exec']);
const isAdminOrHR = (role) => ADMIN_HR_ROLES.has((role || '').toLowerCase());

/**
 * Force a non-privileged caller's list query onto their OWN employee_id.
 *
 * `requirePermission('leaves','view')` is a MODULE grant, and the `employee`
 * role holds it — every employee needs it to open their own leave page. It
 * therefore admits every employee to the unfiltered list, and the only thing
 * that was narrowing the result was the frontend volunteering
 * `?employee_id=<me>` (AllLeaves.jsx: `isAdminOrHR ? {} : { employee_id: uid }`).
 * A caller who simply omits that parameter — or supplies someone else's id —
 * received the whole company's applications, reason free-text included.
 *
 * Scoping a list by what the client chose to send is not scoping. The server
 * decides here:
 *   admin / HR            → unrestricted, as before.
 *   manager-queue request → left alone; the /applications handler already pins
 *                           manager_id to the caller's own employee_id.
 *   everyone else         → employee_id is overwritten with the caller's own,
 *                           discarding whatever arrived in the query string.
 *
 * A non-privileged caller with no linked employee record has no own-rows to
 * see, so they get none — never the unfiltered set.
 */
function scopeToSelf(req, filters) {
  if (isAdminOrHR((req.user?.role || '').toLowerCase())) return filters;
  if (filters.manager_status) return filters;          // approver queue, pinned below
  const self = req.user?.employee_id ?? null;
  return { ...filters, employee_id: self ?? -1 };
}

/** Single-record counterpart of scopeToSelf(): own row, or one you approve. */
function canSeeApplication(req, application) {
  if (isAdminOrHR((req.user?.role || '').toLowerCase())) return true;
  const self = req.user?.employee_id ?? null;
  if (self == null) return false;
  return Number(application.employee_id) === Number(self)
      || Number(application.manager_id)  === Number(self)
      || Number(application.hr_id)       === Number(self);
}

/**
 * Load ONE leave application for a decision or a single-record read, inside
 * the caller's company. Every route below that takes `:id` goes through this.
 *
 * Before 2026-10-19 they loaded `WHERE id = $1` alone, and the HR/admin
 * override in authorizeManagerApproval() carries no company — so an HR user in
 * company B could approve, reject, cancel or delegate company A's leave by id.
 * A row in another company is reported exactly like a missing one (null → 404),
 * so the response does not confirm that the id exists elsewhere. A global
 * super admin (companyOf() === null) is unscoped, as everywhere else.
 */
async function loadLeaveInCompany(req, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const { rows } = await pool.query(
    `SELECT la.*, e.company_id AS employee_company_id,
            COALESCE(e.name, CONCAT(e.first_name, ' ', COALESCE(e.last_name, ''))) AS employee_name
       FROM leave_applications la
       LEFT JOIN employees e ON e.id = la.employee_id
      WHERE la.id = $1 AND la.deleted_at IS NULL`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;
  const companyId = companyOf(req);
  const rowCompany = row.employee_company_id ?? row.company_id;
  if (companyId != null && Number(rowCompany) !== Number(companyId)) return null;
  return row;
}

// Who may decide each level. L2 and HR-final carried only the module grant
// `leaves:approve`, which every manager holds — so any manager could take the
// department-head or HR-final decision on anyone's leave. These are the role
// sets the leave approval queues already use (LeaveApprovals.jsx QUEUES), now
// enforced where the decision is made. Union of all roles held (hasRole).
const L2_APPROVER_ROLES = ['department_head', 'l2_approver', 'admin', 'super_admin', 'hr_manager'];
const HR_FINAL_ROLES    = ['hr', 'hr_manager', 'admin', 'super_admin'];
// authorizeManagerApproval()'s identity-free overrides (primary role).
const L1_OVERRIDE_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec'];

/**
 * Policy (2026-10-20): nobody decides their own leave — not at L1, L2 or
 * HR-final, not as a delegate, not through the generic status / bulk /
 * workflow routes. The HR/admin override in authorizeManagerApproval() and the
 * L2/HR role checks are identity-free, so an HR user, department head or admin
 * could approve their own leave before this.
 *
 * The actor's employee is read from the users table (the trusted link), not
 * from the token or the request. Returns true when it has answered the request
 * (403 SELF_APPROVAL_BLOCKED); the leave is untouched and stays pending for
 * another eligible approver at the same level. The message says whether one
 * exists — if none does, an administrator has to provide one.
 */
async function blockOwnLeaveDecision(req, res, leave, level) {
  const userId = req.user?.userId ?? req.user?.id ?? null;
  const { rows: [me] } = userId == null ? { rows: [] }
    : await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
  const actorEmp = me?.employee_id ?? null;
  if (actorEmp == null || String(actorEmp) !== String(leave.employee_id)) return false;

  const others = await countAlternateLeaveApprovers(leave, level);
  const who = { l1: 'the reporting manager, an assigned delegate, HR or an admin',
                l2: 'another department head or L2 approver', hr: 'another HR user' }[level];
  res.status(403).json({
    error: others > 0
      ? `You cannot decide your own leave. It stays pending for ${who} (${others} eligible in your company).`
      : `You cannot decide your own leave, and no one else in your company is eligible to decide it at this level `
        + `(${who}). It stays pending until an administrator assigns one — for example a reporting manager, a delegate, `
        + `or the ${level === 'l2' ? 'department_head / l2_approver' : level === 'hr' ? 'hr / hr_manager' : 'hr'} role to a colleague.`,
    code: 'SELF_APPROVAL_BLOCKED',
    level,
    eligible_alternates: others,
  });
  return true;
}

// Active logins in the leave's company, other than the requester, that this
// level's rule would accept. Used for the message only — the routes themselves
// still enforce the rule for whoever acts.
async function countAlternateLeaveApprovers(leave, level) {
  const company = leave.employee_company_id ?? leave.company_id;
  const base = `FROM users u LEFT JOIN employees e ON e.id = u.employee_id
                WHERE u.is_active = TRUE AND COALESCE(e.company_id, u.company_id) = $1
                  AND u.employee_id IS DISTINCT FROM $2`;
  const roleHeld = (roles) => `EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                                       WHERE ur.user_id = u.id AND LOWER(r.code) = ANY('{${roles.join(',')}}'::text[]))`;
  let sql;
  const params = [company, leave.employee_id];
  if (level === 'l1') {
    params.push(leave.delegate_approver_id ?? null);
    sql = `SELECT COUNT(DISTINCT u.id)::int AS n ${base}
             AND (u.employee_id = (SELECT reporting_manager_id FROM employees WHERE id = $2)
                  OR u.employee_id = $3
                  OR LOWER(u.role) = ANY('{${L1_OVERRIDE_ROLES.join(',')}}'::text[]))`;
  } else {
    sql = `SELECT COUNT(DISTINCT u.id)::int AS n ${base} AND ${roleHeld(level === 'l2' ? L2_APPROVER_ROLES : HR_FINAL_ROLES)}`;
  }
  const { rows: [r] } = await pool.query(sql, params);
  return r?.n ?? 0;
}

// ── Generic status update — HR/Admin only; guards against bypassing workflow ──
export async function handleStatusUpdate(req, res) {
  const role = (req.user?.role || '').toLowerCase();
  const { status } = req.body;
  const raw = (status || '').toLowerCase();
  const normalized = raw === 'approve' ? 'approved' : raw === 'reject' ? 'rejected' : raw;
  if (!['approved', 'rejected', 'pending', 'cancelled'].includes(normalized)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }
  // Only admin/HR roles may use the generic status update; managers must use
  // the typed /approve/manager or /reject/manager endpoints.
  if (!isAdminOrHR(role) && normalized !== 'cancelled') {
    return res.status(403).json({ error: 'Use the specific approve/reject endpoints for your role' });
  }
  try {
    const existing = await loadLeaveInCompany(req, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Leave application not found' });
    // A non-HR caller reaches this only to cancel, and only their own leave —
    // the same rule PUT /:id/cancel applies. It used to cancel ANY leave.
    if (!isAdminOrHR(role) && String(existing.employee_id) !== String(req.user?.employee_id)) {
      return res.status(403).json({ error: 'You can only cancel your own leave applications' });
    }
    if (normalized !== 'cancelled' && await blockOwnLeaveDecision(req, res, existing, 'hr')) return;
    const application = await leavesRepository.updateStatus(
      req.params.id,
      normalized,
      req.user?.employee_id || null,
      req.body.comments || req.body.reason || ''
    );
    if (normalized === 'approved' || normalized === 'rejected') {
      notifyLeaveEvent(normalized, application, req.user, [application.employee_id]);
    }
    res.json({ success: true, data: application, ...application });
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE TYPES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/types', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;

    // `applicable=1` scopes the catalogue to what the company has actually
    // configured (used by the Apply Leave screen so employees don't see the
    // global statutory seed types the company never enabled). If the company
    // has NOT configured any of its own types, we fall back to the global seed
    // catalogue so the picker is never empty. Without the flag (e.g. the
    // Settings admin view) the full global + company catalogue is returned.
    const applicable = ['1', 'true', 'yes'].includes(String(req.query.applicable || '').toLowerCase());
    const scopeClause = applicable
      ? `AND (
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM leave_types
                 WHERE company_id = $1 AND is_active = true AND deleted_at IS NULL
               )
               THEN company_id = $1
               ELSE company_id IS NULL
             END
           )`
      : `AND (company_id IS NULL OR company_id = $1)`;

    const { rows } = await pool.query(`
      SELECT id, leave_name, leave_code, annual_quota AS default_days,
             COALESCE(description, '') AS description, is_active,
             COALESCE(carry_forward_allowed, false)    AS carry_forward_allowed,
             COALESCE(max_carry_forward_days, 0)       AS max_carry_forward_days,
             COALESCE(is_encashable, false)             AS is_encashable,
             COALESCE(allow_half_day, true)             AS allow_half_day,
             COALESCE(requires_attachment, false)       AS requires_attachment,
             COALESCE(requires_medical_cert_days, 0)   AS requires_medical_cert_days,
             COALESCE(allow_negative_balance, false)    AS allow_negative_balance,
             COALESCE(min_notice_days, 0)               AS min_notice_days,
             COALESCE(max_consecutive_days, 0)          AS max_consecutive_days,
             COALESCE(accrual_type, 'manual')           AS accrual_type,
             COALESCE(accrual_days_per_month, 0)        AS accrual_days_per_month,
             COALESCE(gender_restriction, '')            AS gender_restriction,
             COALESCE(allowed_in_probation, true)        AS allowed_in_probation,
             COALESCE(is_lop_type, false)                AS is_lop_type,
             COALESCE(is_paid, true)                     AS is_paid,
             COALESCE(l2_required, false)                AS l2_required,
             COALESCE(max_encash_days_per_year, 0)       AS max_encash_days_per_year,
             COALESCE(sandwich_rule, false)              AS sandwich_rule
      FROM leave_types
      WHERE deleted_at IS NULL AND is_active = true
        ${scopeClause}
      ORDER BY leave_name
    `, [companyId]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /probation-status — tells the Apply Leave screen whether the target
// employee is currently in their probation period (paid leave blocked, LOP
// only). Employees may only query themselves; HR/Admin may pass ?employee_id.
router.get('/probation-status', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    let empId = req.query.employee_id;
    if (!isAdminOrHR(role) || !empId) empId = req.user?.employee_id;
    if (!empId || isNaN(parseInt(empId, 10))) {
      return res.json({ in_probation: false, probation_end: null });
    }
    // The STORED probation_end_date only (shared/probationDates.js). The old
    // fallback to joining_date + 90 days was a fourth probation rule that
    // disagreed with the other three. Company-scoped: an HR user's
    // ?employee_id= could read any tenant's probation state.
    const { rows } = await pool.query(
      `SELECT status, joining_date, probation_end_date::text AS prob_end
       FROM employees
       WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)
       LIMIT 1`,
      [empId, companyOf(req)]
    );
    if (!rows.length) return res.json({ in_probation: false, probation_end: null });
    const { status, prob_end } = rows[0];
    const statusProbation = String(status || '').toLowerCase() === 'probation';
    const dateProbation = prob_end ? new Date(prob_end) >= new Date(new Date().toDateString()) : false;
    const inProbation = statusProbation || dateProbation;
    res.json({
      in_probation: inProbation,
      probation_end: prob_end ? String(prob_end).slice(0, 10) : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/types', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const {
      leave_name, default_days, description,
      carry_forward_allowed, max_carry_forward_days, is_encashable,
      allow_half_day, requires_attachment, requires_medical_cert_days,
      allow_negative_balance, min_notice_days, max_consecutive_days,
      accrual_type, accrual_days_per_month, gender_restriction, allowed_in_probation,
      l2_required, max_encash_days_per_year, sandwich_rule,
    } = req.body;
    const trimmed = (leave_name || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'leave_name is required' });
    if (trimmed.length < 2) return res.status(400).json({ error: 'Leave type name must be at least 2 characters' });
    if (!/[A-Za-z]/.test(trimmed)) return res.status(400).json({ error: 'Leave type name must contain at least one letter' });
    const companyId = req.scope?.company_id ?? null;
    const leave_code = trimmed.toUpperCase().replace(/\s+/g, '_').slice(0, 10);
    const { rows } = await pool.query(`
      INSERT INTO leave_types (
        leave_name, leave_code, annual_quota, description, company_id,
        carry_forward_allowed, max_carry_forward_days, is_encashable,
        allow_half_day, requires_attachment, requires_medical_cert_days,
        allow_negative_balance, min_notice_days, max_consecutive_days,
        accrual_type, accrual_days_per_month, gender_restriction, allowed_in_probation,
        l2_required, max_encash_days_per_year, sandwich_rule
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT DO NOTHING
      RETURNING id, leave_name, annual_quota AS default_days, description
    `, [
      trimmed, leave_code, Number(default_days) || 0, description?.trim() || '', companyId,
      carry_forward_allowed ?? false, Number(max_carry_forward_days) || 0, is_encashable ?? false,
      allow_half_day ?? true, requires_attachment ?? false, Number(requires_medical_cert_days) || 0,
      allow_negative_balance ?? false, Number(min_notice_days) || 0, max_consecutive_days ? Number(max_consecutive_days) : null,
      accrual_type || 'manual', Number(accrual_days_per_month) || 0,
      gender_restriction || null, allowed_in_probation ?? true,
      l2_required ?? false, max_encash_days_per_year ? Number(max_encash_days_per_year) : null, sandwich_rule ?? false,
    ]);
    if (!rows.length) return res.status(409).json({ error: 'A leave type with this name already exists' });
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: rows[0].id, recordType: 'leave_type', action: 'create', newData: rows[0], req });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk create leave types (used by the Setup Wizard — Leave Policies step).
// Tolerant of duplicates so the wizard can be re-run without failing.
router.post('/types/bulk', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const input = Array.isArray(req.body?.leaveTypes) ? req.body.leaveTypes : [];
    const companyId = req.scope?.company_id ?? null;
    const created = [];
    const skipped = [];

    for (const t of input) {
      // Accept both the wizard field names and the canonical leave_types names.
      const name = (t.leave_name ?? t.name ?? '').trim();
      if (!name || name.length < 2 || !/[A-Za-z]/.test(name)) {
        skipped.push({ name: name || '(blank)', reason: 'invalid name' });
        continue;
      }
      const quota          = Number(t.default_days ?? t.quota) || 0;
      const carryForward   = t.carry_forward_allowed ?? t.carry_forward ?? false;
      const maxCarry       = Number(t.max_carry_forward_days ?? t.max_carry) || 0;
      const encashable     = t.is_encashable ?? t.encashable ?? false;
      const genderRaw      = t.gender_restriction ?? t.gender ?? null;
      const genderRestrict = (!genderRaw || genderRaw === 'All') ? null : genderRaw;
      const approval       = t.approval ?? '';
      const l2Required     = t.l2_required ?? /L2/i.test(approval);
      const leaveCode      = name.toUpperCase().replace(/\s+/g, '_').slice(0, 10);

      const { rows } = await pool.query(`
        INSERT INTO leave_types (
          leave_name, leave_code, annual_quota, description, company_id,
          carry_forward_allowed, max_carry_forward_days, is_encashable,
          gender_restriction, l2_required
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT DO NOTHING
        RETURNING id, leave_name, annual_quota AS default_days
      `, [
        name, leaveCode, quota, '', companyId,
        carryForward, maxCarry, encashable,
        genderRestrict, l2Required,
      ]);

      if (rows.length) {
        created.push(rows[0]);
        logAudit({ userId: req.user?.userId, module: 'leaves', recordId: rows[0].id, recordType: 'leave_type', action: 'create', newData: rows[0], req });
      } else {
        skipped.push({ name, reason: 'already exists' });
      }
    }

    res.json({ success: true, created: created.length, skipped: skipped.length, leaveTypes: created, details: { skipped } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/types/:id', requireLeaveAdmin, requirePermission('leaves', 'edit'), async (req, res) => {
  try {
    const {
      leave_name, default_days, description,
      carry_forward_allowed, max_carry_forward_days, is_encashable,
      allow_half_day, requires_attachment, requires_medical_cert_days,
      allow_negative_balance, min_notice_days, max_consecutive_days,
      accrual_type, accrual_days_per_month, gender_restriction, allowed_in_probation,
      l2_required, max_encash_days_per_year, sandwich_rule,
    } = req.body;
    if (!leave_name?.trim()) return res.status(400).json({ error: 'leave_name is required' });
    const { rows: oldRows } = await pool.query(`SELECT * FROM leave_types WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!oldRows.length) return res.status(404).json({ error: 'Leave type not found' });
    await pool.query(`
      UPDATE leave_types
      SET leave_name = $1, annual_quota = $2, description = $3,
          carry_forward_allowed = $4, max_carry_forward_days = $5, is_encashable = $6,
          allow_half_day = $7, requires_attachment = $8, requires_medical_cert_days = $9,
          allow_negative_balance = $10, min_notice_days = $11, max_consecutive_days = $12,
          accrual_type = $13, accrual_days_per_month = $14, gender_restriction = $15,
          allowed_in_probation = $16, l2_required = $17, max_encash_days_per_year = $18,
          sandwich_rule = $19, updated_at = NOW()
      WHERE id = $20 AND deleted_at IS NULL
    `, [
      leave_name.trim(), Number(default_days) || 0, description?.trim() || '',
      carry_forward_allowed ?? oldRows[0].carry_forward_allowed,
      max_carry_forward_days != null ? Number(max_carry_forward_days) : oldRows[0].max_carry_forward_days,
      is_encashable ?? oldRows[0].is_encashable,
      allow_half_day ?? oldRows[0].allow_half_day,
      requires_attachment ?? oldRows[0].requires_attachment,
      requires_medical_cert_days != null ? Number(requires_medical_cert_days) : oldRows[0].requires_medical_cert_days,
      allow_negative_balance ?? oldRows[0].allow_negative_balance,
      min_notice_days != null ? Number(min_notice_days) : oldRows[0].min_notice_days,
      max_consecutive_days != null ? Number(max_consecutive_days) : oldRows[0].max_consecutive_days,
      accrual_type || oldRows[0].accrual_type,
      accrual_days_per_month != null ? Number(accrual_days_per_month) : oldRows[0].accrual_days_per_month,
      gender_restriction ?? oldRows[0].gender_restriction,
      allowed_in_probation ?? oldRows[0].allowed_in_probation,
      l2_required ?? oldRows[0].l2_required ?? false,
      max_encash_days_per_year != null ? Number(max_encash_days_per_year) : oldRows[0].max_encash_days_per_year,
      sandwich_rule ?? oldRows[0].sandwich_rule ?? false,
      req.params.id,
    ]);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_type', action: 'update', oldData: oldRows[0], newData: req.body, req });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/types/:id', requireLeaveAdmin, requirePermission('leaves', 'delete'), async (req, res) => {
  try {
    const { rows: oldRows } = await pool.query(`SELECT * FROM leave_types WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!oldRows.length) return res.status(404).json({ error: 'Leave type not found' });
    await pool.query(`UPDATE leave_types SET deleted_at = NOW(), is_active = false WHERE id = $1`, [req.params.id]);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_type', action: 'delete', oldData: oldRows[0], req });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE BALANCE
// ─────────────────────────────────────────────────────────────────────────────

// GET /balance/:employee_id — role-scoped: employees can only see their own
router.get('/balance/:employee_id', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const empId = req.params.employee_id;
    if (!empId || empId === 'null' || empId === 'undefined' || isNaN(parseInt(empId, 10))) {
      return res.json([]);
    }
    const role = (req.user?.role || '').toLowerCase();
    const callerEmpId = req.user?.employee_id;
    // Employees may only fetch their own balance
    if (!isAdminOrHR(role) && !['manager','department_head','l2_approver'].includes(role)) {
      if (String(callerEmpId) !== String(req.params.employee_id)) {
        return res.status(403).json({ error: 'You can only view your own leave balance' });
      }
    }
    const { year } = req.query;
    const balance = await leavesRepository.getLeaveBalance(req.params.employee_id, year);
    res.json(balance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/balance/initialize', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const { employee_id, year } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    await leavesRepository.initializeLeaveBalance(employee_id, year || new Date().getFullYear());
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: employee_id, recordType: 'leave_balance', action: 'initialize', newData: { employee_id, year }, req });
    res.json({ message: 'Leave balance initialized' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk allocate leave balances to all active employees
router.post('/bulk-allocate', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  const allocYear = Number(req.body.year) || new Date().getFullYear();
  const companyId = req.scope?.company_id ?? null;
  try {
    const { rows: leaveTypes } = await pool.query(`
      SELECT id, annual_quota FROM leave_types
      WHERE is_active = true AND deleted_at IS NULL
        AND (company_id IS NULL OR company_id = $1)
    `, [companyId]);
    const { rows: employees } = await pool.query(`
      SELECT id FROM employees
      WHERE LOWER(COALESCE(status,'active')) NOT IN ('left','terminated','resigned','inactive','ex-employee','notice_period')
        AND ($1::integer IS NULL OR company_id = $1)
    `, [companyId]);
    let count = 0;
    for (const emp of employees) {
      for (const lt of leaveTypes) {
        await pool.query(`
          INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING
        `, [emp.id, lt.id, allocYear, lt.annual_quota]);
        count++;
      }
    }
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: null, recordType: 'leave_balance', action: 'bulk_allocate', newData: { year: allocYear, employees: employees.length, types: leaveTypes.length, records: count }, req });
    res.json({ success: true, year: allocYear, records: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// All allocations — admin view
/**
 * Leave balances.
 *
 * `leaves`.`view` is granted to `employee` on purpose — people need to see their
 * own balance — so the permission gate alone does not scope this. It did not
 * scope itself either: a live probe on 2026-09-04 with a plain `employee` token
 * returned **292 rows across 34 employees**, i.e. every colleague's leave
 * entitlement, usage and remaining days.
 *
 * The sibling `/applications` gets this right by narrowing on the caller's own
 * employee id; this endpoint over the same population did not. That is the
 * detail-vs-list split again: two endpoints over one dataset are two separate
 * redaction decisions, and only one of them had been made.
 *
 * HR and administrators see everyone. A manager sees their own reports. Everyone
 * else sees themselves. An `employee_id` in the query string is honoured only
 * for callers allowed to look at other people.
 */
router.get('/allocations', requirePermission('leaves', 'view'), async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const companyId = req.scope?.company_id ?? null;
  try {
    const isAdmin   = hasRole(req, ...LEAVE_ADMIN_ROLES);
    const isManager = hasRole(req, 'manager', 'department_head', 'hr_manager');
    const me        = await employeeOf(req, pool);

    // Resolved server-side. A caller who may not see others cannot widen their
    // own scope by passing someone else's id.
    const requested = req.query.employee_id ? Number(req.query.employee_id) : null;
    let scopeEmployeeId = null;   // null = no per-employee restriction
    let scopeManagerId  = null;

    if (isAdmin) {
      scopeEmployeeId = Number.isInteger(requested) ? requested : null;
    } else if (isManager) {
      scopeManagerId = me;
      if (Number.isInteger(requested)) scopeEmployeeId = requested;   // still bounded by the manager filter below
    } else {
      if (me == null) {
        // No employee record means no balance to show. Returning everything
        // would be the fail-open this endpoint just had.
        return res.json([]);
      }
      scopeEmployeeId = me;
    }

    const { rows } = await pool.query(`
      SELECT lb.id, lb.employee_id, lb.leave_type_id, lb.year,
             lb.allocated_days,
             COALESCE(lb.used_days, 0)                              AS used_days,
             COALESCE(
               (SELECT SUM(la.number_of_days)
                FROM leave_applications la
                WHERE la.employee_id = lb.employee_id
                  AND la.leave_type_id = lb.leave_type_id
                  AND la.status = 'pending'
                  AND EXTRACT(YEAR FROM la.start_date) = lb.year
                  AND la.deleted_at IS NULL), 0
             )                                                      AS pending_days,
             lb.allocated_days - COALESCE(lb.used_days, 0) - COALESCE(
               (SELECT SUM(la2.number_of_days)
                FROM leave_applications la2
                WHERE la2.employee_id = lb.employee_id
                  AND la2.leave_type_id = lb.leave_type_id
                  AND la2.status = 'pending'
                  AND EXTRACT(YEAR FROM la2.start_date) = lb.year
                  AND la2.deleted_at IS NULL), 0
             )                                                      AS remaining_days,
             CONCAT(e.first_name, ' ', e.last_name)                 AS employee_name,
             lt.leave_name
      FROM   leave_balances lb
      JOIN   employees  e  ON lb.employee_id   = e.id
      JOIN   leave_types lt ON lb.leave_type_id = lt.id
      WHERE  lb.year = $1
        AND ($2::integer IS NULL OR e.company_id = $2)
        AND ($3::integer IS NULL OR lb.employee_id = $3)
        AND ($4::integer IS NULL OR e.reporting_manager_id = $4)
      ORDER  BY employee_name, lt.leave_name
    `, [year, companyId, scopeEmployeeId, scopeManagerId]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create / update a single allocation
router.post('/allocate', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  const { employee_id, leave_type_id, allocated_days, year } = req.body;
  if (!employee_id || !leave_type_id || allocated_days == null) {
    return res.status(400).json({ error: 'employee_id, leave_type_id, and allocated_days are required' });
  }
  const allocYear = Number(year) || new Date().getFullYear();
  try {
    const { rows } = await pool.query(`
      INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (employee_id, leave_type_id, year)
      DO UPDATE SET allocated_days = $4, updated_at = NOW()
      RETURNING id, employee_id, leave_type_id, year, allocated_days
    `, [employee_id, leave_type_id, allocYear, Number(allocated_days)]);
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE APPLICATIONS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/applications', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    const filters = { ...req.query, company_id: req.scope?.company_id ?? null };

    // For manager-queue requests: if no manager_id provided, resolve from JWT user_id.
    // This avoids frontend sending the wrong ID type (user.userId vs employee_id).
    if (filters.manager_status && !isAdminOrHR(role) && !filters.manager_id) {
      const empId = req.user?.employee_id;
      if (empId) {
        filters.manager_id = empId;
      } else {
        // Fallback: look up employee_id from users.id. employees has no
        // user_id column — this always returned zero rows before.
        const { rows } = await pool.query(
          `SELECT e.id FROM users u JOIN employees e ON e.id = u.employee_id
           WHERE u.id = $1 AND e.status IS DISTINCT FROM 'Left' LIMIT 1`,
          [req.user?.userId || req.user?.id]
        );
        if (rows[0]?.id) filters.manager_id = rows[0].id;
      }
    }

    const applications = await leavesRepository.findApplications(scopeToSelf(req, filters));
    res.json(applications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/applications/:id', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const application = (await loadLeaveInCompany(req, req.params.id))
      && await leavesRepository.findById(req.params.id);
    if (!application) return res.status(404).json({ error: 'Application not found' });
    // Same module-grant problem as the list route: 'leaves:view' admits every
    // employee, so without this an employee could read any colleague's leave —
    // and its reason — by walking the id. Own record, or one they are named on
    // as approver; otherwise it does not exist as far as this caller is concerned.
    if (!canSeeApplication(req, application)) {
      return res.status(404).json({ error: 'Application not found' });
    }
    res.json(application);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approval history for a leave application
router.get('/applications/:id/history', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    // The trail names approvers and carries their comments: same visibility as
    // the application itself (it had none — any employee could walk ids).
    const application = await loadLeaveInCompany(req, req.params.id);
    if (!application || !canSeeApplication(req, application)) {
      return res.status(404).json({ error: 'Application not found' });
    }
    const { rows } = await pool.query(`
      SELECT lah.*,
        COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS approver_name,
        e.designation AS approver_designation
      FROM leave_approval_history lah
      LEFT JOIN employees e ON lah.approver_id = e.id
      WHERE lah.leave_application_id = $1
      ORDER BY lah.created_at ASC
    `, [req.params.id]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Apply for leave with backend balance validation, policy enforcement, notification
async function handleApplyLeave(req, res) {
  try {
    let { employee_id, leave_type_id, leave_type } = req.body;
    if (!employee_id) employee_id = req.user?.employee_id;
    const normalizedPayload = normalizeApplicationPayload(req.body, employee_id, leave_type_id);

    // Always use authenticated user as the employee (unless HR/Admin submitting for another)
    const role = (req.user?.role || '').toLowerCase();
    if (!isAdminOrHR(role)) {
      normalizedPayload.employee_id = req.user?.employee_id;
      employee_id = req.user?.employee_id;
    }

    /**
     * No employee to file the leave FOR.
     *
     * `leave_applications.employee_id` is NOT NULL, and nothing above guarantees a
     * value: a non-HR caller gets `req.user.employee_id`, which is NULL for any
     * login that is not linked to an employee row — the three admin accounts are
     * deliberately unlinked (see the employee-login policy). The INSERT therefore
     * reached Postgres with NULL and came back as a bare 500:
     *
     *   null value in column "employee_id" of relation "leave_applications"
     *   violates not-null constraint
     *
     * That is a 400: the request cannot be fulfilled as sent, and the caller can
     * see why. A 500 says "the server is broken", which sends someone reading
     * logs after a phantom outage.
     *
     * The two causes get different messages because they need different actions —
     * an HR user forgot to say who, an employee's login needs linking.
     */
    if (!normalizedPayload.employee_id) {
      return res.status(400).json({
        error: isAdminOrHR(role)
          ? 'Specify which employee this leave application is for (employee_id).'
          : 'Your login is not linked to an employee record, so leave cannot be applied for. Please contact HR.',
        code: 'EMPLOYEE_LINK_REQUIRED',
        module: 'leaves',
      });
    }

    /**
     * Same class of defect, one column over.
     *
     * `leave_applications.number_of_days` is NOT NULL, and
     * `normalizeApplicationPayload` only PASSES IT THROUGH — `body.number_of_days
     * ?? days ?? total_days ?? numberOfDays`. A caller who sends dates but no day
     * count reached the INSERT with NULL and got another bare 500.
     *
     * Validated rather than derived, deliberately. The dates are right there and
     * `end - start` looks obvious, but how many LEAVE days that is depends on
     * weekends, the holiday calendar and half-days — policy the Apply Leave form
     * already owns and sends (`number_of_days: days`). Computing a second answer
     * here would be a second opinion on leave policy, and the two would drift.
     * So: the UI is unaffected, and an integration that omits it is told what is
     * missing instead of being handed a 500.
     */
    if (normalizedPayload.number_of_days == null || normalizedPayload.number_of_days === '') {
      return res.status(400).json({
        error: 'number_of_days is required — send the leave-day count for this date range.',
        code: 'NUMBER_OF_DAYS_REQUIRED',
        module: 'leaves',
      });
    }

    // Auto-resolve manager_id
    if (!normalizedPayload.manager_id) {
      normalizedPayload.manager_id = await resolveManagerEmployeeId(employee_id);
    }

    // Defensive: the validation engine may resolve undefined/null (no schema
    // configured for 'leaves') or reject — treat either as "valid" so a
    // misconfigured/absent validator can't 500 the apply flow. Matches the
    // finance route's guard.
    const vres = await Promise.resolve(
      validate('leaves', { ...normalizedPayload, days: normalizedPayload.number_of_days })
    ).catch(() => null);
    const { valid, errors } = vres ?? { valid: true, errors: [] };
    const blockingErrors = valid
      ? []
      : (errors || []).filter(err => !(err?.field === 'reason' && normalizedPayload.reason?.trim()));
    if (blockingErrors.length) {
      const message = blockingErrors.map(err => err?.message).filter(Boolean).join('; ') || 'Validation failed';
      return res.status(422).json({ error: message, code: 'VALIDATION_ERROR', module: 'leaves', errors: blockingErrors });
    }

    if (!leave_type_id && leave_type) {
      leave_type_id = await resolveLeaveTypeId(leave_type, req.scope?.company_id ?? null);
    }
    if (!leave_type_id) {
      return res.status(400).json({ error: `Leave type "${leave_type || 'unknown'}" not found. Please contact HR to set up leave types.` });
    }

    // ── Backend balance validation ──────────────────────────────────────────
    const requestedDays = Number(normalizedPayload.number_of_days) || 0;
    const applyYear = new Date(normalizedPayload.start_date).getFullYear();
    const { rows: balRows } = await pool.query(`
      SELECT
        COALESCE(lb.allocated_days, lt.annual_quota, 0) AS allocated,
        COALESCE(lb.used_days, 0) AS used,
        COALESCE(
          (SELECT SUM(la2.number_of_days)
           FROM leave_applications la2
           WHERE la2.employee_id = $1 AND la2.leave_type_id = $2
             AND la2.status = 'pending'
             AND EXTRACT(YEAR FROM la2.start_date) = $3
             AND la2.deleted_at IS NULL), 0
        ) AS pending_days,
        COALESCE(lt.allow_negative_balance, false) AS allow_negative
      FROM leave_types lt
      LEFT JOIN leave_balances lb
        ON lb.employee_id = $1 AND lb.leave_type_id = lt.id AND lb.year = $3
      WHERE lt.id = $2 AND lt.deleted_at IS NULL
    `, [employee_id, leave_type_id, applyYear]);

    if (balRows.length) {
      const { allocated, used, pending_days, allow_negative } = balRows[0];
      const available = Number(allocated) - Number(used) - Number(pending_days);
      if (!allow_negative && requestedDays > available) {
        return res.status(422).json({
          error: `Insufficient leave balance. Available: ${available} day(s), Requested: ${requestedDays} day(s).`,
          code: 'INSUFFICIENT_BALANCE',
          available,
          requested: requestedDays,
        });
      }
    }

    // ── Policy enforcement ─────────────────────────────────────────────────
    const { rows: typeRows } = await pool.query(
      `SELECT min_notice_days, requires_attachment, requires_medical_cert_days,
              allowed_in_probation, max_consecutive_days, sandwich_rule,
              gender_restriction, include_holidays, include_weekends,
              is_lop_type, is_paid
       FROM leave_types WHERE id = $1`, [leave_type_id]
    );
    if (typeRows.length) {
      const lt = typeRows[0];
      const today = new Date(); today.setHours(0,0,0,0);
      const startDate = new Date(normalizedPayload.start_date);
      const endDate   = new Date(normalizedPayload.end_date);
      const noticeDays = Math.ceil((startDate - today) / 86400000);
      const exemptTypes = ['sick', 'medical', 'emergency', 'bereavement'];

      // Min notice
      if (lt.min_notice_days > 0 && noticeDays < lt.min_notice_days) {
        if (!exemptTypes.some(e => (leave_type || '').toLowerCase().includes(e))) {
          return res.status(422).json({
            error: `This leave type requires at least ${lt.min_notice_days} day(s) advance notice.`,
            code: 'INSUFFICIENT_NOTICE',
          });
        }
      }

      // Max consecutive days
      if (lt.max_consecutive_days && requestedDays > lt.max_consecutive_days) {
        return res.status(422).json({
          error: `This leave type allows a maximum of ${lt.max_consecutive_days} consecutive day(s).`,
          code: 'MAX_CONSECUTIVE_EXCEEDED',
        });
      }

      // Gender restriction
      if (lt.gender_restriction && lt.gender_restriction !== '') {
        const { rows: empGender } = await pool.query(
          `SELECT LOWER(COALESCE(gender,'')) AS gender FROM employees WHERE id = $1`, [employee_id]
        ).catch(() => ({ rows: [] }));
        const empG = empGender[0]?.gender || '';
        const allowed = lt.gender_restriction.toLowerCase();
        if (empG && allowed && !empG.startsWith(allowed[0])) {
          return res.status(422).json({
            error: `This leave type is restricted to ${lt.gender_restriction} employees only.`,
            code: 'GENDER_RESTRICTED',
          });
        }
      }

      // Probation restriction — company policy: employees serving probation may
      // only take Loss of Pay (unpaid) leave. Any paid leave type is blocked
      // regardless of its per-type allowed_in_probation flag. LOP types are
      // always allowed so probationers can still record unpaid absence.
      if (!lt.is_lop_type) {
        // Stored probation_end_date only — no joining_date + 90 days fallback.
        // No .catch: a failed lookup used to read as "no employee" and let paid
        // leave through; it is now a 500 like any other failure in this handler.
        const { rows: empProb } = await pool.query(
          `SELECT status, joining_date, probation_end_date::text AS prob_end
           FROM employees WHERE id = $1`, [employee_id]
        );
        if (empProb.length) {
          const probEnd = empProb[0].prob_end ? new Date(empProb[0].prob_end) : null;
          const inProbation =
            String(empProb[0].status || '').toLowerCase() === 'probation' ||
            (probEnd && startDate <= probEnd);
          if (inProbation) {
            return res.status(422).json({
              error: 'You are in your probation period. Paid leave is not available — only Loss of Pay (unpaid) leave can be applied.',
              code: 'PROBATION_RESTRICTED',
            });
          }
        }
      }

      // Sandwich rule: if leave starts on Tuesday or ends on Thursday, adjacent
      // weekend days get counted as leave days (per Indian labour law convention).
      if (lt.sandwich_rule) {
        const dayBefore = new Date(startDate); dayBefore.setDate(dayBefore.getDate() - 1);
        const dayAfter  = new Date(endDate);   dayAfter.setDate(dayAfter.getDate() + 1);
        const dowBefore = dayBefore.getDay();
        const dowAfter  = dayAfter.getDay();
        if ((dowBefore === 0 || dowBefore === 6) && (dowAfter === 0 || dowAfter === 6)) {
          return res.status(422).json({
            error: 'Sandwich rule applies: leave cannot be flanked by weekends for this leave type.',
            code: 'SANDWICH_RULE_VIOLATION',
          });
        }
      }
    }

    // ── Overlap detection — reject if same employee already has approved/pending leave on these dates ──
    const { rows: overlapRows } = await pool.query(`
      SELECT id, start_date, end_date, status
      FROM leave_applications
      WHERE employee_id = $1
        AND deleted_at IS NULL
        AND status IN ('pending','approved')
        AND start_date <= $3::date
        AND end_date   >= $2::date
    `, [employee_id, normalizedPayload.start_date, normalizedPayload.end_date]);
    if (overlapRows.length > 0) {
      const o = overlapRows[0];
      return res.status(409).json({
        error: `A ${o.status} leave application already exists for this date range (${o.start_date?.slice(0,10)} – ${o.end_date?.slice(0,10)}). Cancel it before applying again.`,
        code: 'LEAVE_OVERLAP',
      });
    }

    const application = await leavesRepository.applyLeave({ ...normalizedPayload, leave_type_id });

    // Post-persistence side-effects are best-effort. The leave is already saved,
    // so a failure in auditing / rules / notifications / balance auto-init must
    // never turn a successful application into a 500. Promise.resolve() guards
    // against non-promise returns; the try/catch guards against synchronous throws.
    let ruleAlerts = [];
    try {
      logAudit({ userId: req.user?.userId, module: 'leaves', recordId: application.id, recordType: 'leave_application', action: 'create', newData: application, req });
      const ruleResults = await Promise.resolve(evaluateRules('leaves', application)).catch(() => []);
      ruleAlerts = (ruleResults || []).filter(r => r.triggered);
      // Notify manager
      notifyLeaveEvent('submitted', application, req.user, [normalizedPayload.manager_id]);
      // Alert project manager(s) if any project milestones fall within this leave window
      Promise.resolve(notifyProjectMilestoneConflict(application, pool)).catch(() => {});
      // Auto-init balance if not yet allocated (new employee safety net)
      Promise.resolve(leavesRepository.initializeLeaveBalance(employee_id, applyYear)).catch(() => {});
    } catch (sideEffectErr) {
      console.warn('[leaves] post-apply side-effect failed (leave was saved):', sideEffectErr.message);
    }

    res.status(201).json({ ...application, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

router.post('/apply', requirePermission('leaves', 'add'), handleApplyLeave);

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL WORKFLOW — L1 / L2 / L3
// ─────────────────────────────────────────────────────────────────────────────

// L1 — Manager Approval. Identity-gated (reporting manager/delegate/HR/admin —
// see shared/managerApprovalAuthz.js), not just anyone holding 'leaves.approve'
// permission — that permission alone previously let any manager-role user
// approve any employee's leave, not just their own reports.
router.post('/approve/manager/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id; // Always use authenticated user
    const { comments } = req.body;
    const found = await loadLeaveInCompany(req, req.params.id);
    if (!found) return res.status(404).json({ error: 'Leave application not found' });
    if (await blockOwnLeaveDecision(req, res, found, 'l1')) return;
    const oldRows = [found];
    const auth = await authorizeManagerApproval({
      actorEmployeeId: actorEmpId,
      actorRole: req.user?.role,
      requesterEmployeeId: oldRows[0].employee_id,
      delegateApproverId: oldRows[0].delegate_approver_id,
    });
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    const application = await leavesRepository.approveByManager(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'approve', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'manager' }, req });
    // Sync to attendance if this is a single-level approval that results in status='approved'
    syncLeaveToAttendance(application, pool).catch(() => {});
    // Post LOP (probation / clubbing) if this approval finalized the leave
    postLopToPayroll(application, pool).catch(() => {});
    // Notify employee + L2 approver (if configured)
    notifyLeaveEvent('approved', { ...application, employee_name: oldRows[0]?.employee_name }, req.user, [application.employee_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

router.post('/reject/manager/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id;
    const { comments } = req.body;
    if (!comments?.trim()) return res.status(400).json({ error: 'A rejection reason (comments) is required' });
    const found = await loadLeaveInCompany(req, req.params.id);
    if (!found) return res.status(404).json({ error: 'Leave application not found' });
    if (await blockOwnLeaveDecision(req, res, found, 'l1')) return;
    const oldRows = [found];
    const auth = await authorizeManagerApproval({
      actorEmployeeId: actorEmpId,
      actorRole: req.user?.role,
      requesterEmployeeId: oldRows[0].employee_id,
      delegateApproverId: oldRows[0].delegate_approver_id,
    });
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    const application = await leavesRepository.rejectByManager(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'reject', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'manager' }, req });
    reverseLeaveAttendance(application, pool).catch(() => {});
    notifyLeaveEvent('rejected', application, req.user, [application.employee_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

// L2 — Dept Head Approval
router.post('/approve/l2/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id;
    const { comments } = req.body;
    const found = await loadLeaveInCompany(req, req.params.id);
    if (!found) return res.status(404).json({ error: 'Leave application not found' });
    if (await blockOwnLeaveDecision(req, res, found, 'l2')) return;
    if (!hasRole(req, ...L2_APPROVER_ROLES)) {
      return res.status(403).json({ error: 'Only a department head or L2 approver can take the L2 decision' });
    }
    const oldRows = [found];
    const application = await leavesRepository.approveByL2(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'approve', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'l2_approver' }, req });
    // Sync to attendance if this is a single-level approval that results in status='approved'
    syncLeaveToAttendance(application, pool).catch(() => {});
    // Post LOP (probation / clubbing) if this approval finalized the leave
    postLopToPayroll(application, pool).catch(() => {});
    notifyLeaveEvent('approved', application, req.user, [application.employee_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

router.post('/reject/l2/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id;
    const { comments } = req.body;
    if (!comments?.trim()) return res.status(400).json({ error: 'A rejection reason (comments) is required' });
    const found = await loadLeaveInCompany(req, req.params.id);
    if (!found) return res.status(404).json({ error: 'Leave application not found' });
    if (await blockOwnLeaveDecision(req, res, found, 'l2')) return;
    if (!hasRole(req, ...L2_APPROVER_ROLES)) {
      return res.status(403).json({ error: 'Only a department head or L2 approver can take the L2 decision' });
    }
    const oldRows = [found];
    const application = await leavesRepository.rejectByL2(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'reject', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'l2_approver' }, req });
    reverseLeaveAttendance(application, pool).catch(() => {});
    notifyLeaveEvent('rejected', application, req.user, [application.employee_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

// L3 — HR Final Approval
router.post('/approve/hr/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id;
    const { comments } = req.body;
    const found = await loadLeaveInCompany(req, req.params.id);
    if (!found) return res.status(404).json({ error: 'Leave application not found' });
    if (await blockOwnLeaveDecision(req, res, found, 'hr')) return;
    if (!hasRole(req, ...HR_FINAL_ROLES)) {
      return res.status(403).json({ error: 'Only HR can take the final leave decision' });
    }
    const oldRows = [found];
    const application = await leavesRepository.approveByHR(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'approve', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'hr' }, req });
    // Auto-sync attendance records for approved leave dates (WFH-aware, holiday-aware)
    syncLeaveToAttendance(application, pool).catch(() => {});
    // Post LOP deduction to active payroll run if this is a Loss of Pay application
    postLopToPayroll(application, pool).catch(() => {});
    notifyLeaveEvent('approved', application, req.user, [application.employee_id, application.manager_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

router.post('/reject/hr/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id;
    const { comments } = req.body;
    if (!comments?.trim()) return res.status(400).json({ error: 'A rejection reason (comments) is required' });
    const found = await loadLeaveInCompany(req, req.params.id);
    if (!found) return res.status(404).json({ error: 'Leave application not found' });
    if (await blockOwnLeaveDecision(req, res, found, 'hr')) return;
    if (!hasRole(req, ...HR_FINAL_ROLES)) {
      return res.status(403).json({ error: 'Only HR can take the final leave decision' });
    }
    const oldRows = [found];
    const application = await leavesRepository.rejectByHR(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'reject', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'hr' }, req });
    reverseLeaveAttendance(application, pool).catch(() => {});
    notifyLeaveEvent('rejected', application, req.user, [application.employee_id, application.manager_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

// Bulk approve — HR/Admin only
router.post('/bulk-approve', requirePermission('leaves', 'approve'), async (req, res) => {
  const role = (req.user?.role || '').toLowerCase();
  if (!isAdminOrHR(role)) return res.status(403).json({ error: 'Only HR and Admin can bulk approve leaves' });
  const { ids, comments } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array is required' });
  const actorEmpId = req.user?.employee_id;
  const results = [];
  for (const id of ids) {
    try {
      // Same company gate as the single routes — an id from another company
      // is reported as not found, never approved.
      const target = await loadLeaveInCompany(req, id);
      if (!target) { results.push({ id, status: 'error', error: 'Leave application not found' }); continue; }
      // Never approve your own leave in a batch either.
      const self = { status: () => self, json: (b) => { self.body = b; return self; } };
      if (await blockOwnLeaveDecision(req, self, target, 'hr')) {
        results.push({ id, status: 'error', code: 'SELF_APPROVAL_BLOCKED', error: self.body?.error }); continue;
      }
      const app = await leavesRepository.updateStatus(id, 'approved', actorEmpId, comments || 'Bulk approved');
      syncLeaveToAttendance(app, pool).catch(() => {});
      notifyLeaveEvent('approved', app, req.user, [app.employee_id]);
      results.push({ id, status: 'approved' });
    } catch (err) {
      results.push({ id, status: 'error', error: err.message });
    }
  }
  logAudit({ userId: req.user?.userId, module: 'leaves', recordId: null, recordType: 'leave_application', action: 'bulk_approve', newData: { ids, results }, req });
  res.json({ success: true, results });
});

// Generic status update (admin/HR only — guarded)
router.put('/applications/:id/status', requirePermission('leaves', 'approve'), handleStatusUpdate);

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR & ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/calendar', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const calendar = await leavesRepository.getLeaveCalendar({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(calendar);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const analytics = await leavesRepository.getLeaveAnalytics({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPAT SHIMS — legacy endpoint signatures
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    res.json(await leavesRepository.findApplications(
      scopeToSelf(req, { ...req.query, company_id: req.scope?.company_id ?? null })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy alias — routes through the same full validation as POST /apply
router.post('/', requirePermission('leaves', 'add'), handleApplyLeave);

// No requirePermission gate: hard-scoped to the caller's own employee_id below,
// so it can never return another employee's data — same self-service shape as
// attendance's GET /employee/:id (no permission gate either). Requiring the
// full 'leaves' module grant here would block finance/finance_manager/
// accounts_exec from ever seeing their own leave history, defeating their
// deliberate self-service carve-out (see FINANCE_SELF_SERVICE_PAGES in
// menuCatalog.js) even though the frontend already lets them reach this page.
router.get('/my', async (req, res) => {
  try {
    // `?? -1` matters: findApplications skips the employee_id clause when the
    // value is falsy, so a caller whose account carries no employee_id used to
    // fall through this "my leaves" route into the WHOLE company's list.
    const employeeId = req.user?.employee_id ?? -1;
    res.json(await leavesRepository.findApplications({ ...req.query, employee_id: employeeId, company_id: req.scope?.company_id ?? null }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/team', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    const filters = { ...req.query, company_id: req.scope?.company_id ?? null };
    if (!isAdminOrHR(role)) {
      filters.manager_id = req.user?.employee_id || null;
      // Security: employees and managers cannot pass arbitrary employee_id to see others
      if (!['manager','department_head','l2_approver'].includes(role)) {
        delete filters.employee_id;
      }
    }
    res.json(await leavesRepository.findApplications(filters));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /balance — current user's own balance (uses employee_id, not userId)
router.get('/balance', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const employeeId = req.user?.employee_id;
    if (!employeeId) return res.status(400).json({ error: 'Employee profile not linked to this user account' });
    res.json(await leavesRepository.getLeaveBalance(employeeId, req.query.year));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy approve/reject/cancel shims
router.patch('/:id/approve', requirePermission('leaves', 'approve'), (req, res) =>
  handleStatusUpdate({ ...req, body: { status: 'approved' } }, res)
);
router.put('/:id/approve', requirePermission('leaves', 'approve'), (req, res) =>
  handleStatusUpdate({ ...req, body: { status: 'approved' } }, res)
);
router.patch('/:id/reject', requirePermission('leaves', 'approve'), (req, res) =>
  handleStatusUpdate({ ...req, body: { status: 'rejected', ...req.body } }, res)
);
router.put('/:id/reject', requirePermission('leaves', 'approve'), (req, res) =>
  handleStatusUpdate({ ...req, body: { status: 'rejected', ...req.body } }, res)
);

// Cancel — employee can cancel their own, HR/Admin can cancel any
router.put('/:id/cancel', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    const app = await loadLeaveInCompany(req, req.params.id);
    if (!app) return res.status(404).json({ error: 'Leave application not found' });
    // Non-admin employees can only cancel their own
    if (!isAdminOrHR(role)) {
      if (String(app.employee_id) !== String(req.user?.employee_id)) {
        return res.status(403).json({ error: 'You can only cancel your own leave applications' });
      }
    }
    const application = await leavesRepository.updateStatus(req.params.id, 'cancelled', req.user?.employee_id, req.body.reason || '');
    reverseLeaveAttendance(application, pool).catch(() => {});
    notifyLeaveEvent('cancelled', { ...application, employee_name: app.employee_name }, req.user, [app.manager_id, app.hr_id]);
    res.json({ success: true, ...application });
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

// Withdraw — employee retracts an already-approved leave (before leave date)
router.post('/:id/withdraw', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Withdrawal reason is required' });
    const role = (req.user?.role || '').toLowerCase();
    const app = await loadLeaveInCompany(req, req.params.id);
    if (!app) return res.status(404).json({ error: 'Leave application not found' });
    if (!isAdminOrHR(role) && String(app.employee_id) !== String(req.user?.employee_id)) {
      return res.status(403).json({ error: 'You can only withdraw your own leave applications' });
    }
    if (!['approved', 'pending'].includes(app.status)) {
      return res.status(409).json({ error: `Cannot withdraw a leave in '${app.status}' status` });
    }
    const application = await leavesRepository.updateStatus(req.params.id, 'cancelled', req.user?.employee_id, reason);
    await pool.query(`UPDATE leave_applications SET withdrawal_reason = $1 WHERE id = $2`, [reason, req.params.id]);
    reverseLeaveAttendance(application, pool).catch(() => {});
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'withdraw', newData: { withdrawal_reason: reason }, req });
    notifyLeaveEvent('cancelled', { ...application, employee_name: app.employee_name }, req.user, [app.manager_id, app.hr_id]);
    res.json({ success: true, withdrawal_reason: reason, ...application });
  } catch (err) {
    res.status(statusForWorkflowError(err)).json({ error: err.message });
  }
});

// ── GET /on-leave-today — employees on approved leave right now ───────────────
router.get('/on-leave-today', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(`
      SELECT DISTINCT
        la.id AS leave_id,
        la.employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation,
        lt.leave_name,
        la.start_date, la.end_date, la.number_of_days
      FROM leave_applications la
      JOIN employees e  ON la.employee_id = e.id
      JOIN leave_types lt ON la.leave_type_id = lt.id
      WHERE la.status = 'approved'
        AND la.deleted_at IS NULL
        AND la.start_date <= $1::date
        AND la.end_date   >= $1::date
        AND ($2::integer IS NULL OR e.company_id = $2)
      ORDER BY e.department, employee_name
    `, [today, companyId]);
    res.json({ date: today, count: rows.length, employees: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /delegate/:id — manager sets a delegate approver for a pending leave ─
router.post('/delegate/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const { delegate_employee_id, comments } = req.body;
    if (!delegate_employee_id) return res.status(400).json({ error: 'delegate_employee_id is required' });
    // Only someone already entitled to take the L1 decision may hand it on —
    // the rule travel's and reimbursement's delegate routes already apply.
    // This route used to let any `leaves:approve` holder (every manager)
    // re-point any company's leave at anyone, including the requester.
    const found = await loadLeaveInCompany(req, req.params.id);
    if (!found) return res.status(404).json({ error: 'Leave application not found' });
    // Choosing who decides your own leave is deciding it.
    if (await blockOwnLeaveDecision(req, res, found, 'l1')) return;
    const auth = await authorizeManagerApproval({
      actorEmployeeId: req.user?.employee_id,
      actorRole: req.user?.role,
      requesterEmployeeId: found.employee_id,
      delegateApproverId: found.delegate_approver_id,
    });
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    const { rows: [delegate] } = await pool.query(
      `SELECT id FROM employees
        WHERE id::text = $1::text AND company_id = $2 AND deleted_at IS NULL
          AND LOWER(status) IN ('active', 'probation', 'notice')`,
      [String(delegate_employee_id), found.employee_company_id ?? found.company_id]
    );
    if (!delegate) return res.status(400).json({ error: 'The delegate must be an active employee in the same company' });
    if (String(delegate.id) === String(found.employee_id)) {
      return res.status(400).json({ error: 'A leave cannot be delegated to the person who applied for it' });
    }
    // Delegation hands on the L1 decision, so only while L1 is still open.
    const { rows } = await pool.query(`
      UPDATE leave_applications
      SET delegate_approver_id = $1, updated_at = NOW()
      WHERE id = $2
        AND status = 'pending'
        AND manager_status = 'pending'
        AND deleted_at IS NULL
      RETURNING *
    `, [delegate.id, req.params.id]);
    if (!rows.length) return res.status(409).json({ error: 'This leave is no longer awaiting its first-level decision' });
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'delegate', newData: { delegate_employee_id, comments }, req });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /accrual-history — per-employee monthly accrual log ──────────────────
/**
 * Monthly leave accrual history.
 *
 * `leaves`.`view` is held by `employee` by design, so the permission gate does
 * not scope this one. A live probe on 2026-09-04 with a plain employee token
 * returned 34 rows covering 34 DIFFERENT PEOPLE — every colleague's accrual,
 * usage and remaining entitlement, with their name and department attached.
 *
 * Same shape as /allocations, fixed the same way: HR and administrators see
 * everyone, a manager sees their reports, everyone else sees themselves. The
 * caller's identity is resolved server-side and an employee_id in the query is
 * honoured only for callers already allowed to look at other people.
 */
router.get('/accrual-history', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const year = Number(req.query.year) || new Date().getFullYear();

    const isAdmin   = hasRole(req, ...LEAVE_ADMIN_ROLES);
    const isManager = hasRole(req, 'manager', 'department_head', 'hr_manager');
    const me        = await employeeOf(req, pool);
    const requested = req.query.employee_id ? Number(req.query.employee_id) : null;

    let scopeEmployeeId = null;
    let scopeManagerId  = null;
    if (isAdmin) {
      scopeEmployeeId = Number.isInteger(requested) ? requested : null;
    } else if (isManager) {
      scopeManagerId = me;
      if (Number.isInteger(requested)) scopeEmployeeId = requested;
    } else {
      if (me == null) return res.json([]);
      scopeEmployeeId = me;
    }
    const { rows } = await pool.query(`
      SELECT
        lb.employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department,
        lt.leave_name,
        lb.year,
        lb.allocated_days,
        lb.carried_forward_days,
        lb.used_days,
        lb.encashed_days,
        GREATEST(
          COALESCE(lb.allocated_days,0) - COALESCE(lb.used_days,0) - COALESCE(lb.encashed_days,0), 0
        ) AS available_days,
        lb.updated_at
      FROM leave_balances lb
      JOIN employees e  ON lb.employee_id = e.id
      JOIN leave_types lt ON lb.leave_type_id = lt.id
      WHERE lb.year = $1
        AND ($2::integer IS NULL OR e.company_id = $2)
        AND lt.accrual_type = 'monthly'
        AND e.status IS DISTINCT FROM 'Left'
        AND ($3::integer IS NULL OR lb.employee_id = $3)
        AND ($4::integer IS NULL OR e.reporting_manager_id = $4)
      ORDER BY e.department, employee_name, lt.leave_name
    `, [year, companyId, scopeEmployeeId, scopeManagerId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /carry-forward-report — annual carry-forward audit ───────────────────
router.get('/carry-forward-report', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const year = Number(req.query.year) || new Date().getFullYear();
    const { rows } = await pool.query(`
      SELECT
        lb.employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department,
        lt.leave_name,
        lb.year,
        COALESCE(lb.carried_forward_days, 0) AS carried_forward_days,
        lt.max_carry_forward_days,
        lt.carry_forward_expiry_months,
        lb.updated_at
      FROM leave_balances lb
      JOIN employees e  ON lb.employee_id = e.id
      JOIN leave_types lt ON lb.leave_type_id = lt.id
      WHERE lb.year = $1
        AND COALESCE(lb.carried_forward_days, 0) > 0
        AND ($2::integer IS NULL OR e.company_id = $2)
        AND e.status IS DISTINCT FROM 'Left'
      ORDER BY e.department, employee_name, lt.leave_name
    `, [year, companyId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE POLICIES — per-company policy overrides for each leave type
// ─────────────────────────────────────────────────────────────────────────────

router.get('/policies', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const { rows } = await pool.query(`
      SELECT lp.*, lt.leave_name, lt.leave_code
      FROM leave_policies lp
      JOIN leave_types lt ON lt.id = lp.leave_type_id
      WHERE lp.company_id = $1
      ORDER BY lt.leave_name
    `, [companyId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/policies/:leave_type_id', requireLeaveAdmin, requirePermission('leaves', 'edit'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    if (!companyId) return res.status(400).json({ error: 'Company context required' });

    const policyFields = [
      'policy_name','accrual_type','accrual_days_per_month','accrual_start',
      'probation_allowed','notice_period_allowed','min_notice_days','max_consecutive_days',
      'sandwich_rule','include_weekends','include_holidays','carry_forward_allowed',
      'max_carry_forward_days','carry_forward_expiry_months','allow_negative_balance',
      'requires_attachment','requires_medical_cert_days','gender_restriction',
      'department_restriction','is_active',
    ];

    const sets = ['updated_at = NOW()'];
    const params = [companyId, req.params.leave_type_id];
    for (const field of policyFields) {
      if (req.body[field] !== undefined) {
        params.push(req.body[field]);
        sets.push(`${field} = $${params.length}`);
      }
    }

    const { rows } = await pool.query(`
      INSERT INTO leave_policies (company_id, leave_type_id, ${policyFields.filter(f => req.body[f] !== undefined).join(', ')})
      VALUES ($1, $2, ${policyFields.filter(f => req.body[f] !== undefined).map((_, i) => `$${i + 3}`).join(', ')})
      ON CONFLICT (company_id, leave_type_id)
      DO UPDATE SET ${sets.join(', ')}
      RETURNING *
    `, params);

    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.leave_type_id, recordType: 'leave_policy', action: 'update', newData: req.body, req });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Workflow engine integration — protected
router.get('/:id/workflow', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const { getWorkflowStatus } = await import('../../../services/WorkflowService.js');
    const status = await getWorkflowStatus('leaves', parseInt(req.params.id));
    res.json(status || { status: 'no_workflow' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Same reporting-manager/delegate/HR/admin identity gate the primary
// /approve|reject/manager/:id routes use (shared/managerApprovalAuthz.js).
// This is a second write path to the same leave_applications row via the
// generic WorkflowService engine — advanceWorkflow() itself only checks
// role, so without this gate anyone holding 'leaves.approve' could bypass
// the hierarchy check entirely by calling this route directly instead of
// the primary one (Automation Opportunity Audit §30.2).
router.post('/:id/workflow/advance', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const { getWorkflowStatus, advanceWorkflow } = await import('../../../services/WorkflowService.js');
    const { action, comments } = req.body;
    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ error: 'action must be approve or reject' });
    const leaveRow = await loadLeaveInCompany(req, req.params.id);
    if (!leaveRow) return res.status(404).json({ error: 'Leave application not found' });
    if (await blockOwnLeaveDecision(req, res, leaveRow, 'l1')) return;
    const auth = await authorizeManagerApproval({
      actorEmployeeId: req.user?.employee_id,
      actorRole: req.user?.role,
      requesterEmployeeId: leaveRow.employee_id,
      delegateApproverId: leaveRow.delegate_approver_id,
    });
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    const instance = await getWorkflowStatus('leaves', parseInt(req.params.id));
    if (!instance || instance.status === 'no_workflow')
      return res.status(404).json({ error: 'No active workflow for this leave' });
    if (['approved', 'rejected', 'cancelled'].includes(instance.status))
      return res.status(400).json({ error: `Workflow already ${instance.status}` });
    const result = await advanceWorkflow(instance.id, action, req.user.userId, comments || '');
    if (result.status === 'approved' || result.status === 'rejected') {
      await leavesRepository.updateStatus(req.params.id, result.status, req.user?.employee_id || null, comments || '');
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

