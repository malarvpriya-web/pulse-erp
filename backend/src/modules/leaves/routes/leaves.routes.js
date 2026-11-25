import express from 'express';
import multer from 'multer';
import { uploadFile } from '../../../services/StorageService.js';
import pool from '../../../config/db.js';
import leavesRepository from '../repositories/leaves.repository.js';
import { openingAllocation } from '../services/leaveAccrual.service.js';
import { requirePermission, allowRoles, can } from '../../../middlewares/auth.middleware.js';
import { validate } from '../../../services/ValidationEngineService.js';
import { evaluateRules } from '../../../services/RuleEngineService.js';
import { logAudit } from '../../../services/AuditService.js';
import { authorizeManagerApproval, managerCanLogIn, DENIED_MESSAGE } from '../../../shared/managerApprovalAuthz.js';
import { hasRole, rolesOf } from '../../../middlewares/auth.middleware.js';
import { employeeOf, companyOf } from '../../../shared/scope.js';
import { CLOSED_EXIT_STATUSES } from '../../hr/exitCase.js';
import { NOTICE_STATUSES, isCurrentSql } from '../../../shared/employeeStatus.js';
import { getWeekendDays, dayIsWeekend } from '../../../shared/weekend.js';

const router = express.Router();

/**
 * Own leave works for everyone (owner, 2026-11-25). The routes behind My
 * Leaves / Apply Leave pass for any login linked to an employee record, even
 * when none of its roles holds a Leaves grant (sales_exec, store_keeper,
 * finance_manager … have leaves view/add = false, so such a person could not
 * see their balance, apply or cancel). Safe because every handler behind it
 * already pins a non-HR caller to their OWN employee_id (apply, balance,
 * probation-status, types for_employee, cancel/withdraw, history) — HR-ness
 * comes from roles, never from this gate. An unlinked login still needs the
 * grant, as before.
 */
const ownLeave = (action) => async (req, res, next) => {
  if (req.user?.employee_id && !(await can(req, 'leaves', action))) return next();
  return requirePermission('leaves', action)(req, res, next);
};

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
    // Weekly offs from Attendance Settings (incl. 2nd/4th-Saturday offs), on
    // local calendar dates — toISOString() gave the previous day in IST.
    const weekend = await getWeekendDays(resolvedCompanyId);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const start = new Date(`${String(startDate instanceof Date ? iso(startDate) : startDate).slice(0, 10)}T00:00:00`);
    const end   = new Date(`${String(endDate instanceof Date ? iso(endDate) : endDate).slice(0, 10)}T00:00:00`);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = iso(d);
      if (dayIsWeekend(dateStr, weekend)) continue; // weekly off

      // Skip holidays
      const isHoliday = await poolRef.query(
        'SELECT 1 FROM holidays WHERE date=$1::date AND (company_id=$2 OR company_id IS NULL) AND (zone_id IS NULL OR zone_id = (SELECT zone_id FROM employees WHERE id = $3)) LIMIT 1',
        [dateStr, resolvedCompanyId, employee_id]
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
/**
 * Post (sign +1) or take back (sign −1) a leave's Loss of Pay on the employee's
 * DRAFT payroll run for the leave's month. An approved run is posted to the GL
 * and backs the payslip and payment, so it is never touched: the result says
 * so, and the caller tells HR to correct it in Payroll.
 *   → { days, finalised: boolean } | null when there is no LOP to post
 * The amount uses the Basic in force (latest salary assignment, else the
 * employee master) — the same source encashment and payroll read; it used to
 * read only the master's basic_salary (2026-11-24).
 */
async function postLopToPayroll(application, poolRef, sign = 1) {
  try {
    if (!application) return null;
    // Posting happens only once the leave is approved — a mid-workflow approval
    // (manager approved, L2/HR still pending) must not charge payroll yet. A
    // reversal is for a leave that WAS approved and is now cancelled.
    if (sign > 0 && application.status && application.status !== 'approved') return null;
    // Full-LOP application (probation block or LOP leave type): the whole
    // request is unpaid. Otherwise a paid leave may still carry a clubbing
    // LOP portion (weekend/holiday days auto-charged) in lop_days.
    const isFullLop = application.is_lop || application.is_lop_type;
    const days = isFullLop
      ? Number(application.number_of_days || 0)
      : Number(application.lop_days || 0);
    if (days <= 0) return null;
    const startDate = String(application.start_date || application.from_date || '').slice(0, 10);
    if (!startDate) return null;
    const month = Number(startDate.slice(5, 7));
    const year  = Number(startDate.slice(0, 4));

    const { rows: [sal] } = await poolRef.query(`
      SELECT COALESCE(
        (SELECT basic_salary FROM employee_salary_assignments
          WHERE employee_id = $1 AND effective_from <= $2::date
          ORDER BY effective_from DESC, created_at DESC LIMIT 1),
        (SELECT basic_salary FROM employees WHERE id = $1)) AS basic`, [application.employee_id, startDate]);
    const basicSalary = Number(sal?.basic || 0);
    const lopAmount = basicSalary > 0 ? Number(((basicSalary / 26) * days).toFixed(2)) : 0;

    const { rows: runRows } = await poolRef.query(`
      SELECT id, status FROM payroll_runs
      WHERE employee_id = $1 AND month = $2 AND year = $3
      ORDER BY (status IN ('draft', 'pending')) DESC
      LIMIT 1
    `, [application.employee_id, month, year]);
    const run = runRows[0];
    if (!run) return { days, finalised: false };
    if (!['draft', 'pending'].includes(run.status)) return { days, finalised: true };
    await poolRef.query(`
      UPDATE payroll_runs
      SET lop_days   = GREATEST(COALESCE(lop_days, 0)   + $1, 0),
          lop_amount = GREATEST(COALESCE(lop_amount, 0) + $2, 0),
          updated_at = NOW()
      WHERE id = $3
    `, [sign * days, sign * lopAmount, run.id]);
    return { days, finalised: false };
  } catch (err) {
    // Non-blocking — do not break the approval / cancel flow.
    console.warn('[leaves] LOP payroll post failed:', err.message);
    return null;
  }
}

// ── Notification helper (non-blocking) ───────────────────────────────────────
async function notifyLeaveEvent(event, application, actor, recipients = [], extra = {}) {
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
        ...extra,
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
      // e. qualified (2026-11-25): bare `reporting_manager_id` inside the
      // subquery bound to m's own column (m.id = m.reporting_manager_id), so
      // this never matched and every leave fell through to the name match.
      `SELECT e.reporting_manager_id AS id
       FROM employees e
       WHERE e.id = $1
         AND e.reporting_manager_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM employees m WHERE m.id = e.reporting_manager_id AND ${isCurrentSql('m.status')})
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
         AND ${isCurrentSql('m.status')}
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

/**
 * Leave days in [start, end] for a company: working days (not a weekly off,
 * not a holiday) and the non-working days sandwiched between the first and
 * last working day (clubbing → Loss of Pay). Same rule as ApplyLeave.jsx's
 * preview. Returns { error, code } for a request that cannot be a leave.
 */
async function countLeaveDays({ companyId, start, end, halfDay = false, employeeId = null }) {
  const s = String(start || '').slice(0, 10), e = String(end || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) {
    return { error: 'Start and end dates are required (YYYY-MM-DD).', code: 'DATES_REQUIRED' };
  }
  if (e < s) return { error: 'The end date is before the start date.', code: 'END_BEFORE_START' };
  const span = (Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86400000 + 1;
  if (span > 366) return { error: 'A leave request cannot be longer than a year.', code: 'RANGE_TOO_LONG' };
  const weekend = await getWeekendDays(companyId);
  const { rows: hol } = await pool.query(
    // A zone's holiday is off only for that zone's employees (Holiday
    // Calendar → zone); a company-wide one (no zone) for everyone.
    `SELECT date::text AS d FROM holidays
      WHERE date BETWEEN $1::date AND $2::date AND (company_id = $3 OR company_id IS NULL)
        AND (zone_id IS NULL OR zone_id = (SELECT zone_id FROM employees WHERE id = $4))`,
    [s, e, companyId, employeeId]);
  const holidays = new Set(hol.map(h => h.d.slice(0, 10)));
  const days = [];
  for (let t = Date.parse(`${s}T00:00:00Z`); t <= Date.parse(`${e}T00:00:00Z`); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);   // UTC-built, so the calendar date is exact
    days.push(!dayIsWeekend(d, weekend) && !holidays.has(d));
  }
  const first = days.indexOf(true), last = days.lastIndexOf(true);
  if (first === -1) {
    return { error: halfDay
      ? 'A half day must be on a working day — that date is a weekly off or a holiday.'
      : 'Those dates are all weekly offs or holidays — there is no working day to take leave on.', code: 'NO_WORKING_DAYS' };
  }
  if (halfDay) return { workingDays: 0.5, clubbedDays: 0 };
  let clubbedDays = 0;
  for (let i = first; i <= last; i++) if (!days[i]) clubbedDays++;
  return { workingDays: days.filter(Boolean).length, clubbedDays };
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
const ADMIN_HR_ROLES = (['admin', 'super_admin', 'hr', 'hr_manager', 'hr_admin', 'hr_exec']);
// Union of ALL roles held (user_roles), never the primary `req.user.role` alone.
const isAdminOrHR = (req) => hasRole(req, ...ADMIN_HR_ROLES);

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
  if (isAdminOrHR(req)) return filters;
  if (filters.manager_status) return filters;          // approver queue, pinned below
  // Department-head queue: pinned to the head's own department in /applications.
  if (filters.queue === 'l2' && hasRole(req, ...L2_APPROVER_ROLES) && filters.department) return filters;
  const self = req.user?.employee_id ?? null;
  return { ...filters, employee_id: self ?? -1 };
}

/** Single-record counterpart of scopeToSelf(): own row, or one you approve. */
async function canSeeApplication(req, application) {
  if (isAdminOrHR(req)) return true;
  const self = req.user?.employee_id ?? null;
  if (self == null) return false;
  const is = v => v != null && Number(v) === Number(self);
  // 2026-11-25: also everyone the queues show it to — the current reporting
  // manager, the delegate, the L2 approver, and a department head of the
  // applicant's department (the L2 queue). Before, their History button 404'd.
  if (is(application.employee_id) || is(application.manager_id) || is(application.hr_id)
      || is(application.delegate_approver_id) || is(application.l2_approver_id)
      || is(application.reporting_manager_id)) return true;
  if (!hasRole(req, ...L2_APPROVER_ROLES)) return false;
  const { rows: [r] } = await pool.query(
    `SELECT 1 FROM employees me JOIN employees ap ON ap.id = $2
      WHERE me.id = $1 AND me.department IS NOT NULL AND me.department = ap.department`,
    [self, application.employee_id]);
  return !!r;
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
    `SELECT la.*, e.company_id AS employee_company_id, e.reporting_manager_id,
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
/**
 * May this caller take the manager (L1) decision on this leave? The shared
 * reporting-line rule (managerApprovalAuthz.js), plus: once the manager step
 * has been ESCALATED (leaveEscalation.service.js — it waited past Leave
 * Settings → "escalate after N days"), HR / admin may take it too (2026-11-24).
 */
async function authorizeL1(req, leave) {
  const auth = await authorizeManagerApproval({
    actorEmployeeId: req.user?.employee_id,
    actorRole: req.user?.role,
    actorRoles: rolesOf(req),
    requesterEmployeeId: leave.employee_id,
    delegateApproverId: leave.delegate_approver_id,
  });
  if (!auth.authorized && auth.reason === 'has_manager' && leave.escalation_step === 'l1' && isAdminOrHR(req)) {
    return { authorized: true, reason: 'escalated' };
  }
  return auth;
}

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

// ── Generic status update (2026-11-25 go-live check) ──────────────────────────
// PUT /applications/:id/status and PATCH|PUT /:id/approve|reject are older
// one-button routes (Notification Center, Manager Dashboard). They used to set
// the leave straight to approved/rejected for HR — skipping the manager and
// department-head steps, the escalation rule and the LOP posting to payroll —
// and refused managers outright. Now each decision is taken at the step the
// leave is actually waiting on, by that step's own handler (same identity,
// self-decision, permission and payroll rules as Leave Approvals). Cancel goes
// through cancelLeave() (own leave only before it starts; LOP reversed).
export async function handleStatusUpdate(req, res) {
  const raw = String(req.body?.status || '').toLowerCase();
  const normalized = raw === 'approve' ? 'approved' : raw === 'reject' ? 'rejected' : raw;
  if (!['approved', 'rejected', 'cancelled'].includes(normalized)) {
    return res.status(400).json({ error: 'Status must be approved, rejected or cancelled' });
  }
  try {
    if (normalized === 'cancelled') {
      return await cancelLeave(req, res, { reason: req.body?.reason || req.body?.comments || '' });
    }
    const leave = await loadLeaveInCompany(req, req.params.id);
    if (!leave) return res.status(404).json({ error: 'Leave application not found' });
    if (leave.status !== 'pending') {
      return res.status(409).json({ error: `This leave is already ${leave.status}`, code: 'LEAVE_NOT_ACTIONABLE' });
    }
    const { rows: [lt] } = await pool.query('SELECT l2_required FROM leave_types WHERE id = $1', [leave.leave_type_id]);
    const step = leave.manager_status !== 'approved' ? 'l1'
      : (lt?.l2_required && leave.l2_status !== 'approved') ? 'l2' : 'hr';
    // L2 and HR are 'leaves.approve' steps (their own routes require it); L1 is the reporting line.
    if (step !== 'l1' && !(await can(req, 'leaves', 'approve'))) {
      return res.status(403).json({ error: DENIED_MESSAGE });
    }
    const sub = Object.create(req);
    sub.body = { ...req.body, comments: req.body?.comments || req.body?.reason || '' };
    const approve = normalized === 'approved';
    const handler = { l1: approve ? approveL1 : rejectL1, l2: approve ? approveL2 : rejectL2, hr: approve ? approveHR : rejectHR }[step];
    return await handler(sub, res);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE TYPES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/types', ownLeave('view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;

    // `applicable=1` scopes the catalogue to what the company has actually
    // configured (used by the Apply Leave screen so employees don't see the
    // global statutory seed types the company never enabled). If the company
    // has NOT configured any of its own types, we fall back to the global seed
    // catalogue so the picker is never empty. Without the flag (e.g. the
    // Settings admin view) the full global + company catalogue is returned.
    const applicable = ['1', 'true', 'yes'].includes(String(req.query.applicable || '').toLowerCase());
    // Leave Settings lists switched-off types too, so they can be switched back on.
    const includeInactive = !applicable && ['1', 'true'].includes(String(req.query.include_inactive || '')) && isAdminOrHR(req);
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
             COALESCE(sandwich_rule, false)              AS sandwich_rule,
             carry_forward_expiry_months,
             COALESCE(days_worked_per_leave_day, 20)     AS days_worked_per_leave_day
      FROM leave_types
      WHERE deleted_at IS NULL AND (is_active = true OR $2::boolean)
        ${scopeClause}
      ORDER BY is_active DESC, leave_name
    `, [companyId, includeInactive]);
    // for_employee=<id> (Apply Leave, 2026-11-24): leave out the types the
    // person cannot take for their gender (Maternity / Paternity …) — the same
    // rule /apply enforces (GENDER_RESTRICTED). Anyone but HR asks for
    // themself, whatever id they send. Unknown gender: nothing is hidden.
    if (applicable && req.query.for_employee != null) {
      const target = isAdminOrHR(req) ? Number(req.query.for_employee) : await employeeOf(req, pool);
      const { rows: [g] } = target ? await pool.query(
        `SELECT LOWER(COALESCE(gender, '')) AS gender FROM employees WHERE id = $1 AND company_id = $2`, [target, companyId])
        : { rows: [] };
      const empG = g?.gender || '';
      if (empG) {
        return res.json(rows.filter(t => {
          const r = String(t.gender_restriction || '').toLowerCase();
          return !r || r === 'all' || empG.startsWith(r[0]);
        }));
      }
    }
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /probation-status — tells the Apply Leave screen whether the target
// employee is currently in their probation period (paid leave blocked, LOP
// only). Employees may only query themselves; HR/Admin may pass ?employee_id.
// ── Leave rules (owner, 2026-11-23) ─────────────────────────────────────────
// company_settings module 'leaves'. encashment_tds_pct: flat income-tax % on a
// leave encashment (default 20 — change it when the government rule changes).
// escalation_days (2026-11-24): a request that waits this many days at one
// approval step is escalated (leaveEscalation.service.js); 0 = never.
export const LEAVE_SETTING_DEFAULTS = { encashment_tds_pct: 20, escalation_days: 3 };
export async function leaveSettingsOf(companyId, db = pool) {
  if (companyId == null) return { ...LEAVE_SETTING_DEFAULTS };
  const { rows: [r] } = await db.query(
    `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'leaves'`, [companyId]);
  return { ...LEAVE_SETTING_DEFAULTS, ...(r?.settings || {}) };
}

router.get('/settings', ownLeave('view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const weekend = await getWeekendDays(companyId);
    res.json({ ...(await leaveSettingsOf(companyId)), weekend_days: [...weekend], saturday_off_weeks: weekend.saturdayWeeks || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/settings', requireLeaveAdmin, requirePermission('leaves', 'edit'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (companyId == null) return res.status(400).json({ error: 'Company context required' });
    const before = await leaveSettingsOf(companyId);
    const next = { ...before };
    if (req.body.encashment_tds_pct !== undefined) {
      const pct = Number(req.body.encashment_tds_pct);
      if (!(pct >= 0 && pct <= 100)) return res.status(400).json({ error: 'Encashment TDS must be between 0 and 100 %' });
      next.encashment_tds_pct = Math.round(pct * 100) / 100;
    }
    if (req.body.escalation_days !== undefined) {
      const d = Number(req.body.escalation_days);
      if (!(Number.isInteger(d) && d >= 0 && d <= 30)) return res.status(400).json({ error: 'Escalate after must be a whole number of days from 0 (never) to 30' });
      next.escalation_days = d;
    }
    await pool.query(`
      INSERT INTO company_settings (company_id, module, settings) VALUES ($1, 'leaves', $2::jsonb)
      ON CONFLICT (company_id, module) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
    [companyId, JSON.stringify(next)]);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: null, recordType: 'leave_settings', action: 'update', oldData: before, newData: next, req });
    res.json(next);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serving notice = an exit (HR → Exit Management) that is still open. Leave
// taken while one is open is Loss of Pay only (same rule as probation).
export async function openNoticePeriod(employeeId) {
  if (!employeeId) return null;
  const { rows: [emp] } = await pool.query(
    `SELECT status, exit_date::text AS exit_date FROM employees WHERE id = $1`, [employeeId]);
  if (emp && NOTICE_STATUSES.includes(String(emp.status || '').trim().toLowerCase())) {
    return { id: null, last_working_date: emp.exit_date || null };
  }
  const { rows: [open] } = await pool.query(
    `SELECT id, last_working_date::text AS last_working_date FROM exit_requests
      WHERE employee_id = $1 AND status <> ALL($2::text[])
      ORDER BY id DESC LIMIT 1`,
    [employeeId, CLOSED_EXIT_STATUSES]);
  return open || null;
}

router.get('/probation-status', ownLeave('view'), async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    let empId = req.query.employee_id;
    if (!isAdminOrHR(req) || !empId) empId = req.user?.employee_id;
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
    if (!rows.length) return res.json({ in_probation: false, probation_end: null, in_notice: false, last_working_date: null });
    const { status, prob_end } = rows[0];
    const statusProbation = String(status || '').toLowerCase() === 'probation';
    const dateProbation = prob_end ? new Date(prob_end) >= new Date(new Date().toDateString()) : false;
    const inProbation = statusProbation || dateProbation;
    const notice = await openNoticePeriod(empId);
    // Who decides the manager step (Apply Leave shows it, 2026-11-25): the
    // reporting manager when they are a current employee with a login, else
    // HR steps in (managerApprovalAuthz) — the screen says so up front.
    const mgrId = await resolveManagerEmployeeId(empId);
    let approver = null;
    if (mgrId && await managerCanLogIn(mgrId)) {
      const { rows: [m] } = await pool.query(
        `SELECT id, office_id, COALESCE(NULLIF(TRIM(name), ''), TRIM(CONCAT(first_name, ' ', last_name))) AS name
           FROM employees WHERE id = $1`, [mgrId]);
      if (m) approver = { id: m.id, name: m.name, office_id: m.office_id };
    }
    res.json({
      in_probation: inProbation,
      // Status Probation = every leave is LOP. Only a stored end date: leave
      // that STARTS after it is paid again (the rule /apply enforces).
      status_probation: statusProbation,
      probation_end: prob_end ? String(prob_end).slice(0, 10) : null,
      in_notice: !!notice,
      last_working_date: notice?.last_working_date ?? null,
      approver,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Numbers on a leave type must be ≥ 0 (a negative Default Days or notice
// was saved as-is before, 2026-11-25). Blank = not set.
const TYPE_NUMBER_FIELDS = {
  default_days: 'Default days', max_carry_forward_days: 'Max carry forward days',
  requires_medical_cert_days: 'Medical certificate after (days)', min_notice_days: 'Min notice days',
  max_consecutive_days: 'Max consecutive days', accrual_days_per_month: 'Days per month',
  max_encash_days_per_year: 'Max encash days / year', carry_forward_expiry_months: 'Carried days expire after (months)',
  days_worked_per_leave_day: 'Days worked per leave day',
};
function leaveTypeNumberError(body) {
  for (const [k, label] of Object.entries(TYPE_NUMBER_FIELDS)) {
    const v = body?.[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return `${label} must be a number of 0 or more`;
  }
  if (body?.default_days !== undefined && body.default_days !== '' && !Number.isInteger(Number(body.default_days))) {
    return 'Default days must be a whole number (use Days per Month for part-days)';
  }
  if (body?.is_lop_type === true && body?.is_paid === true) return 'A Loss of Pay type cannot also be Paid';
  if (body?.carry_forward_expiry_months != null && body.carry_forward_expiry_months !== '' && Number(body.carry_forward_expiry_months) > 12) {
    return 'Carried days expire after must be 0–12 months';
  }
  return null;
}

router.post('/types', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const {
      leave_name, default_days, description,
      carry_forward_allowed, max_carry_forward_days, is_encashable,
      allow_half_day, requires_attachment, requires_medical_cert_days,
      allow_negative_balance, min_notice_days, max_consecutive_days,
      accrual_type, accrual_days_per_month, gender_restriction, allowed_in_probation,
      l2_required, max_encash_days_per_year, sandwich_rule, days_worked_per_leave_day,
      is_paid, is_lop_type, is_active, carry_forward_expiry_months,
    } = req.body;
    const trimmed = (leave_name || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'leave_name is required' });
    const numErr = leaveTypeNumberError(req.body);
    if (numErr) return res.status(400).json({ error: numErr });
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
        l2_required, max_encash_days_per_year, sandwich_rule, days_worked_per_leave_day,
        is_paid, is_lop_type, is_active, carry_forward_expiry_months
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
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
      Number(days_worked_per_leave_day) > 0 ? Number(days_worked_per_leave_day) : 20,
      // Saved on Add too (2026-11-25): the form sent them, but only Edit wrote
      // them — a new type ticked "unpaid" / "Loss of Pay" / inactive, or with a
      // carry-forward expiry, was stored paid, active and never-expiring.
      is_paid ?? true, is_lop_type ?? false, is_active ?? true,
      carry_forward_expiry_months === '' || carry_forward_expiry_months == null ? null : Number(carry_forward_expiry_months),
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
      is_paid, is_lop_type, is_active, carry_forward_expiry_months, days_worked_per_leave_day,
    } = req.body;
    if (!leave_name?.trim()) return res.status(400).json({ error: 'leave_name is required' });
    const numErr = leaveTypeNumberError(req.body);
    if (numErr) return res.status(400).json({ error: numErr });
    // Own company's types only (a global seed type is not editable per tenant).
    const { rows: oldRows } = await pool.query(
      `SELECT * FROM leave_types WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyOf(req)]);
    if (!oldRows.length) return res.status(404).json({ error: 'Leave type not found' });
    await pool.query(`
      UPDATE leave_types
      SET leave_name = $1, annual_quota = $2, description = $3,
          carry_forward_allowed = $4, max_carry_forward_days = $5, is_encashable = $6,
          allow_half_day = $7, requires_attachment = $8, requires_medical_cert_days = $9,
          allow_negative_balance = $10, min_notice_days = $11, max_consecutive_days = $12,
          accrual_type = $13, accrual_days_per_month = $14, gender_restriction = $15,
          allowed_in_probation = $16, l2_required = $17, max_encash_days_per_year = $18,
          sandwich_rule = $19, is_paid = $21, is_lop_type = $22, is_active = $23,
          carry_forward_expiry_months = $24, days_worked_per_leave_day = $25, updated_at = NOW()
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
      // Key sent = the form's choice; "No restriction" arrives as null/'' and
      // must clear it (`?? old` kept the old Male/Female restriction).
      'gender_restriction' in req.body ? (gender_restriction || null) : oldRows[0].gender_restriction,
      allowed_in_probation ?? oldRows[0].allowed_in_probation,
      l2_required ?? oldRows[0].l2_required ?? false,
      max_encash_days_per_year != null ? Number(max_encash_days_per_year) : oldRows[0].max_encash_days_per_year,
      sandwich_rule ?? oldRows[0].sandwich_rule ?? false,
      req.params.id,
      is_paid ?? oldRows[0].is_paid ?? true,
      is_lop_type ?? oldRows[0].is_lop_type ?? false,
      is_active ?? oldRows[0].is_active ?? true,
      carry_forward_expiry_months === '' ? null
        : carry_forward_expiry_months != null ? Number(carry_forward_expiry_months) : oldRows[0].carry_forward_expiry_months,
      Number(days_worked_per_leave_day) > 0 ? Number(days_worked_per_leave_day) : (oldRows[0].days_worked_per_leave_day ?? 20),
    ]);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_type', action: 'update', oldData: oldRows[0], newData: req.body, req });
    res.json({ success: true });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A leave type with this name already exists' });
    res.status(500).json({ error: error.message });
  }
});

router.delete('/types/:id', requireLeaveAdmin, requirePermission('leaves', 'delete'), async (req, res) => {
  try {
    const { rows: oldRows } = await pool.query(
      `SELECT * FROM leave_types WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyOf(req)]);
    if (!oldRows.length) return res.status(404).json({ error: 'Leave type not found' });
    // In use → refuse; switching it off (Active = No) keeps the history.
    const { rows: [use] } = await pool.query(`
      SELECT (SELECT COUNT(*) FROM leave_applications WHERE leave_type_id = $1 AND deleted_at IS NULL)::int AS apps,
             (SELECT COUNT(*) FROM leave_balances WHERE leave_type_id = $1 AND COALESCE(allocated_days,0) > 0)::int AS balances`,
      [req.params.id]);
    if (use.apps > 0 || use.balances > 0) {
      return res.status(409).json({
        code: 'LEAVE_TYPE_IN_USE',
        error: `"${oldRows[0].leave_name}" is in use (${use.apps} application(s), ${use.balances} balance(s) with days). Edit it and set Active to No instead of deleting it.`,
      });
    }
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
router.get('/balance/:employee_id', ownLeave('view'), async (req, res) => {
  try {
    const empId = req.params.employee_id;
    if (!empId || empId === 'null' || empId === 'undefined' || isNaN(parseInt(empId, 10))) {
      return res.json([]);
    }
    const callerEmpId = req.user?.employee_id;
    // Only inside the caller's company.
    const cid = companyOf(req);
    const { rows: [target] } = await pool.query(
      `SELECT id, reporting_manager_id FROM employees WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [parseInt(empId, 10), cid]);
    if (!target) return res.status(404).json({ error: 'Employee not found' });
    // Own balance; HR/admin; a department head / L2 approver; or the person's
    // reporting manager (so an approver sees the balance before deciding).
    const isSelf = String(callerEmpId) === String(empId);
    const isReportingManager = callerEmpId != null && String(target.reporting_manager_id) === String(callerEmpId);
    if (!isSelf && !isAdminOrHR(req) && !hasRole(req, 'department_head', 'l2_approver') && !isReportingManager) {
      return res.status(403).json({ error: 'You can only view your own leave balance' });
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
      SELECT id, annual_quota, accrual_type FROM leave_types
      WHERE is_active = true AND deleted_at IS NULL
        AND (company_id IS NULL OR company_id = $1)
    `, [companyId]);
    const { rows: employees } = await pool.query(`
      SELECT id, to_char(joining_date, 'YYYY-MM-DD') AS joining_date FROM employees
      WHERE LOWER(COALESCE(status,'active')) NOT IN ('left','terminated','resigned','inactive','ex-employee','notice_period')
        AND ($1::integer IS NULL OR company_id = $1)
    `, [companyId]);
    // `records` = balances actually CREATED. It counted every employee × type,
    // so a re-run said "35 records created" while creating none (2026-11-25).
    let count = 0, existing = 0;
    for (const emp of employees) {
      for (const lt of leaveTypes) {
        const r = await pool.query(`
          INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING
        `, [emp.id, lt.id, allocYear, openingAllocation(lt, emp.joining_date, allocYear)]);
        if (r.rowCount) count++; else existing++;
      }
    }
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: null, recordType: 'leave_balance', action: 'bulk_allocate', newData: { year: allocYear, employees: employees.length, types: leaveTypes.length, records: count, existing }, req });
    res.json({ success: true, year: allocYear, records: count, existing });
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
      // A manager login with no employee record has no team: nothing to show
      // (a null manager filter returned every row in the company, 2026-11-24).
      if (me == null) return res.json([]);
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
      -- Same balance formula as the employee's own cards (getLeaveBalance):
      -- used = approved leave; remaining = allocated + carried forward − used
      -- − pending − encashed. People who have left and switched-off types are
      -- not listed.
      WITH x AS (
        SELECT lb.id, lb.employee_id, lb.leave_type_id, lb.year,
               lb.allocated_days,
               COALESCE(lb.carried_forward_days, 0) AS carried_forward_days,
               COALESCE(lb.encashed_days, 0)        AS encashed_days,
               COALESCE((SELECT SUM(la.number_of_days) FROM leave_applications la
                          WHERE la.employee_id = lb.employee_id AND la.leave_type_id = lb.leave_type_id
                            AND la.status = 'approved' AND EXTRACT(YEAR FROM la.start_date) = lb.year
                            AND la.deleted_at IS NULL), 0) AS used_days,
               COALESCE((SELECT SUM(la.number_of_days) FROM leave_applications la
                          WHERE la.employee_id = lb.employee_id AND la.leave_type_id = lb.leave_type_id
                            AND la.status = 'pending' AND EXTRACT(YEAR FROM la.start_date) = lb.year
                            AND la.deleted_at IS NULL), 0) AS pending_days,
               TRIM(CONCAT(e.first_name, ' ', e.last_name)) AS employee_name,
               e.office_id AS employee_code, e.department,
               lt.leave_name, COALESCE(lt.is_lop_type, false) AS is_lop_type,
               COALESCE(lt.allow_negative_balance, false) AS allow_negative_balance
        FROM   leave_balances lb
        JOIN   employees  e  ON lb.employee_id   = e.id
        JOIN   leave_types lt ON lb.leave_type_id = lt.id
        WHERE  lb.year = $1
          AND  ${isCurrentSql('e.status')}
          AND  lt.is_active = true AND lt.deleted_at IS NULL
          AND ($2::integer IS NULL OR e.company_id = $2)
          AND ($3::integer IS NULL OR lb.employee_id = $3)
          AND ($4::integer IS NULL OR e.reporting_manager_id = $4)
      )
      SELECT *, allocated_days + carried_forward_days - used_days - pending_days - encashed_days AS remaining_days
        FROM x ORDER BY employee_name, leave_name
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
  const days = Number(allocated_days);
  if (allocated_days === '' || !Number.isFinite(days) || days < 0 || days > 366) {
    return res.status(400).json({ error: 'Allocated days must be a number from 0 to 366' });
  }
  if (!(allocYear >= 2000 && allocYear <= 2100)) return res.status(400).json({ error: 'Enter a valid year' });
  try {
    // Own company's current employee and an active type only (2026-11-25):
    // any id was accepted — another company's employee, a deleted or
    // switched-off type — and the change was not audited.
    const cid = companyOf(req);
    const { rows: [emp] } = await pool.query(
      `SELECT id FROM employees WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND ${isCurrentSql('status')}`,
      [employee_id, cid]);
    if (!emp) return res.status(404).json({ error: 'Employee not found (or has left)' });
    const { rows: [lt] } = await pool.query(
      `SELECT id FROM leave_types WHERE id = $1 AND deleted_at IS NULL AND is_active = true
          AND (company_id IS NULL OR $2::int IS NULL OR company_id = $2)`, [leave_type_id, cid]);
    if (!lt) return res.status(404).json({ error: 'Leave type not found or switched off' });
    const { rows: [before] } = await pool.query(
      `SELECT allocated_days FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
      [employee_id, leave_type_id, allocYear]);
    const { rows } = await pool.query(`
      INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (employee_id, leave_type_id, year)
      DO UPDATE SET allocated_days = $4, updated_at = NOW()
      RETURNING id, employee_id, leave_type_id, year, allocated_days
    `, [employee_id, leave_type_id, allocYear, days]);
    // Saved without a change → nothing to record.
    if (!before || Number(before.allocated_days) !== days) {
      logAudit({ userId: req.user?.userId, module: 'leaves', recordId: rows[0].id, recordType: 'leave_balance',
        action: before ? 'update' : 'create', oldData: before || null, newData: rows[0], req });
    }
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /allocations/:id — remove a balance given by mistake (2026-11-25) ──
// Only a balance nothing has touched yet: no approved / pending leave on it
// that year, nothing carried forward or encashed, no encashment claim, and no
// credit from the accrual run (that credit's lock row would stop the run from
// giving it again — set the days to 0 instead). Audited with the full row.
router.delete('/allocations/:id', requireLeaveAdmin, requirePermission('leaves', 'delete'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows: [b] } = await pool.query(`
      SELECT lb.*, lt.leave_name, TRIM(CONCAT(e.first_name, ' ', e.last_name)) AS employee_name
        FROM leave_balances lb
        JOIN employees e ON e.id = lb.employee_id
        JOIN leave_types lt ON lt.id = lb.leave_type_id
       WHERE lb.id = $1 AND ($2::int IS NULL OR e.company_id = $2)`, [req.params.id, cid]);
    if (!b) return res.status(404).json({ error: 'Allocation not found' });
    const { rows: [use] } = await pool.query(`
      SELECT (SELECT COUNT(*) FROM leave_applications
               WHERE employee_id = $1 AND leave_type_id = $2 AND EXTRACT(YEAR FROM start_date) = $3
                 AND status IN ('approved', 'pending') AND deleted_at IS NULL)::int AS apps,
             (SELECT COUNT(*) FROM leave_encashments
               WHERE employee_id = $1 AND leave_type_id = $2 AND status <> 'cancelled' AND status <> 'rejected')::int AS claims,
             (SELECT COUNT(*) FROM leave_accrual_log
               WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3)::int AS credits`,
      [b.employee_id, b.leave_type_id, b.year]);
    const reasons = [];
    if (use.apps) reasons.push(`${use.apps} approved/pending leave request(s)`);
    if (Number(b.carried_forward_days)) reasons.push('carried-forward days');
    if (Number(b.encashed_days) || use.claims) reasons.push('an encashment');
    if (use.credits) reasons.push('days credited by the accrual run');
    if (reasons.length) {
      return res.status(409).json({
        code: 'ALLOCATION_IN_USE',
        error: `${b.employee_name} · ${b.leave_name} ${b.year} has ${reasons.join(', ')} — it cannot be deleted. Edit it and set the days instead.`,
      });
    }
    await pool.query('DELETE FROM leave_balances WHERE id = $1', [b.id]);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: b.id, recordType: 'leave_balance', action: 'delete', oldData: b, req });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /settings/history — who changed leave configuration (2026-11-25) ────
// Leave types, allocations, leave rules and accrual / carry-forward / expiry
// runs, from audit_logs, newest first. Own company only; HR / admin only.
const HISTORY_KINDS = {
  types:       `a.module_name = 'leaves' AND a.reference_type = 'leave_type'`,
  allocations: `a.module_name = 'leaves' AND a.reference_type = 'leave_balance'`,
  rules:       `a.module_name = 'leaves' AND a.reference_type = 'leave_settings'`,
  runs:        `a.module_name = 'leave_accrual'`,
};
router.get('/settings/history', requireLeaveAdmin, requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    if (cid == null) return res.json([]);
    const kind = HISTORY_KINDS[req.query.kind] ? [HISTORY_KINDS[req.query.kind]] : Object.values(HISTORY_KINDS);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const { rows } = await pool.query(`
      SELECT a.id, a.created_at, a.action_type AS action, a.reference_type AS record_type, a.reference_id AS record_id,
             a.old_data_json AS old_data, a.new_data_json AS new_data,
             COALESCE(NULLIF(TRIM(CONCAT(ue.first_name, ' ', ue.last_name)), ''), u.name, u.email, 'System') AS changed_by,
             COALESCE(lt.leave_name, a.new_data_json->>'leave_name', a.old_data_json->>'leave_name') AS leave_name,
             NULLIF(TRIM(CONCAT(be.first_name, ' ', be.last_name)), '') AS employee_name, be.office_id AS employee_code,
             blt.leave_name AS balance_type, COALESCE(lb.year, (a.new_data_json->>'year')::int, (a.old_data_json->>'year')::int) AS year
        FROM audit_logs a
        LEFT JOIN users u      ON u.id = a.user_id
        LEFT JOIN employees ue ON ue.id = u.employee_id
        LEFT JOIN leave_types lt ON a.reference_type = 'leave_type' AND a.reference_id ~ '^[0-9]+$' AND lt.id = a.reference_id::int
        LEFT JOIN leave_balances lb ON a.reference_type = 'leave_balance' AND a.reference_id ~ '^[0-9]+$' AND lb.id = a.reference_id::int
        LEFT JOIN employees be ON be.id = COALESCE(lb.employee_id, (a.old_data_json->>'employee_id')::int, (a.new_data_json->>'employee_id')::int)
        LEFT JOIN leave_types blt ON blt.id = COALESCE(lb.leave_type_id, (a.old_data_json->>'leave_type_id')::int, (a.new_data_json->>'leave_type_id')::int)
       WHERE a.company_id = $1 AND (${kind.join(') OR (')})
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $2`, [cid, limit]);
    res.json(rows);
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
    // 2026-11-25: by the CURRENT reporting line or the assigned delegate
    // (l1_for) — the same people authorizeL1 lets decide — and never a
    // manager_id the caller chose.
    if (filters.manager_status && !isAdminOrHR(req)) {
      delete filters.manager_id;
      const empId = req.user?.employee_id;
      if (empId) {
        filters.l1_for = empId;
      } else {
        // Fallback: look up employee_id from users.id. employees has no
        // user_id column — this always returned zero rows before.
        const { rows } = await pool.query(
          `SELECT e.id FROM users u JOIN employees e ON e.id = u.employee_id
           WHERE u.id = $1 AND e.status IS DISTINCT FROM 'Left' LIMIT 1`,
          [req.user?.userId || req.user?.id]
        );
        // -1 when there is no employee: findApplications skips a falsy
        // manager_id, which handed an unlinked login every pending request.
        filters.l1_for = rows[0]?.id ?? -1;
      }
    }

    // A department head (not HR/admin) works the L2 queue for their own
    // department only — whatever department the request named.
    if (filters.queue === 'l2' && !isAdminOrHR(req)) {
      const me = await employeeOf(req, pool);
      const { rows: [dep] } = me == null ? { rows: [] }
        : await pool.query('SELECT department FROM employees WHERE id = $1', [me]);
      filters.department = dep?.department || '__none__';
    }
    // The HR queue is HR's alone.
    if (filters.queue === 'hr' && !hasRole(req, ...HR_FINAL_ROLES)) filters.employee_id = -1;

    const applications = await leavesRepository.findApplications(scopeToSelf(req, filters));
    res.json(applications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/applications/:id', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const found = await loadLeaveInCompany(req, req.params.id);
    const application = found && { ...(await leavesRepository.findById(req.params.id)),
      reporting_manager_id: found.reporting_manager_id };
    if (!application?.id) return res.status(404).json({ error: 'Application not found' });
    // Same module-grant problem as the list route: 'leaves:view' admits every
    // employee, so without this an employee could read any colleague's leave —
    // and its reason — by walking the id. Own record, or one they are named on
    // as approver; otherwise it does not exist as far as this caller is concerned.
    if (!(await canSeeApplication(req, application))) {
      return res.status(404).json({ error: 'Application not found' });
    }
    res.json(application);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approval history for a leave application
router.get('/applications/:id/history', ownLeave('view'), async (req, res) => {
  try {
    // The trail names approvers and carries their comments: same visibility as
    // the application itself (it had none — any employee could walk ids).
    const application = await loadLeaveInCompany(req, req.params.id);
    if (!application || !(await canSeeApplication(req, application))) {
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
    if (!isAdminOrHR(req)) {
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
        error: isAdminOrHR(req)
          ? 'Specify which employee this leave application is for (employee_id).'
          : 'Your login is not linked to an employee record, so leave cannot be applied for. Please contact HR.',
        code: 'EMPLOYEE_LINK_REQUIRED',
        module: 'leaves',
      });
    }

    /**
     * The day count is the SERVER's (2026-11-24). It used to be taken from the
     * request as sent, so any client could book a 10-day range as 0.5 days and
     * pass the balance check, or a half day on a Sunday. The rule is the one
     * the Apply Leave form previews: weekly offs (incl. the company's off
     * Saturdays) and holidays are not leave days; those sandwiched between the
     * first and last working day of the leave are Loss of Pay (clubbing); a
     * half day must fall on a working day. Whatever the client sent is ignored.
     */
    // No back-dated leave from employees (owner, 2026-11-24): a leave that
    // starts before today is entered by HR (Apply Leave → on behalf). The
    // screen already blocked past dates; the API took any date.
    if (!isAdminOrHR(req)) {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (String(normalizedPayload.start_date || '').slice(0, 10) < todayStr) {
        return res.status(422).json({
          error: 'Leave cannot start before today. For a past date, ask HR to enter it.',
          code: 'BACKDATED_NOT_ALLOWED', module: 'leaves',
        });
      }
    }
    // One request per year (2026-11-25): balances, accrual, carry forward and
    // the encashment cap are all per calendar year, and a leave was charged
    // wholly to its START year — 30 Dec–2 Jan took 4 days of the old year.
    if (!normalizedPayload.half_day
        && String(normalizedPayload.start_date || '').slice(0, 4) !== String(normalizedPayload.end_date || '').slice(0, 4)) {
      const y = String(normalizedPayload.start_date).slice(0, 4);
      return res.status(422).json({
        error: `A leave can't run past 31 Dec — apply up to 31 Dec ${y}, then a second request from 1 Jan.`,
        code: 'LEAVE_CROSSES_YEAR', module: 'leaves',
      });
    }
    {
      const { rows: [empCo] } = await pool.query('SELECT company_id FROM employees WHERE id = $1', [normalizedPayload.employee_id]);
      const count = await countLeaveDays({
        companyId: empCo?.company_id ?? req.scope?.company_id ?? null,
        employeeId: normalizedPayload.employee_id,
        start: normalizedPayload.start_date,
        end: normalizedPayload.half_day ? normalizedPayload.start_date : normalizedPayload.end_date,
        halfDay: !!normalizedPayload.half_day,
      });
      if (count.error) return res.status(400).json({ error: count.error, code: count.code, module: 'leaves' });
      if (normalizedPayload.half_day) normalizedPayload.end_date = normalizedPayload.start_date;
      // Session is AM or PM (morning default); none on a full-day leave.
      normalizedPayload.half_day_session = normalizedPayload.half_day
        ? (String(normalizedPayload.half_day_session || '').toUpperCase() === 'PM' ? 'PM' : 'AM')
        : null;
      normalizedPayload.number_of_days = count.workingDays;
      normalizedPayload.lop_days = count.clubbedDays;     // full-LOP requests are set below, once the type is known
      normalizedPayload.clubbing_flag = count.clubbedDays > 0;
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
    // A type picked by id must be one this employee's company offers and has
    // not switched off — the name lookup above already insisted on that, the
    // id path did not (2026-11-24).
    {
      const { rows: [okType] } = await pool.query(
        `SELECT 1 FROM leave_types lt
          WHERE lt.id = $1 AND lt.deleted_at IS NULL AND lt.is_active = true
            AND (lt.company_id IS NULL OR lt.company_id = (SELECT company_id FROM employees WHERE id = $2))`,
        [leave_type_id, normalizedPayload.employee_id]);
      if (!okType) return res.status(400).json({ error: 'That leave type is not offered (it is switched off or belongs to another company).', code: 'LEAVE_TYPE_NOT_AVAILABLE' });
    }

    // ── Backend balance validation ──────────────────────────────────────────
    const requestedDays = Number(normalizedPayload.number_of_days) || 0;
    const applyYear = new Date(normalizedPayload.start_date).getFullYear();
    // Same formula as the balance cards (getLeaveBalance): allocated + carried
    // forward − approved − pending − encashed. lb.used_days is not used: the
    // encashment approval also adds to it, so it double-counted encashed days.
    const { rows: balRows } = await pool.query(`
      SELECT
        COALESCE(lb.allocated_days, lt.annual_quota, 0) + COALESCE(lb.carried_forward_days, 0)
          - COALESCE(lb.encashed_days, 0)
          -- Days in an encashment claim still waiting for HR / payroll are
          -- spoken for: taking them as leave too would pay them twice.
          - COALESCE((SELECT SUM(x.days_encashed) FROM leave_encashments x
                       WHERE x.employee_id = $1 AND x.leave_type_id = $2 AND x.year = $3
                         AND x.status = 'pending'), 0) AS allocated,
        COALESCE((SELECT SUM(la1.number_of_days) FROM leave_applications la1
                   WHERE la1.employee_id = $1 AND la1.leave_type_id = $2 AND la1.status = 'approved'
                     AND EXTRACT(YEAR FROM la1.start_date) = $3 AND la1.deleted_at IS NULL), 0) AS used,
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
              is_lop_type, is_paid, leave_name, COALESCE(allow_half_day, true) AS allow_half_day
       FROM leave_types WHERE id = $1`, [leave_type_id]
    );
    if (typeRows.length) {
      const lt = typeRows[0];
      // Unpaid or not is the TYPE's, not the client's say. A Loss of Pay type
      // is unpaid for every day of it, not only the clubbed ones.
      normalizedPayload.is_lop = !!lt.is_lop_type;
      if (lt.is_lop_type) normalizedPayload.lop_days = normalizedPayload.number_of_days;
      const startDate = new Date(normalizedPayload.start_date);
      const endDate   = new Date(normalizedPayload.end_date);
      // Calendar days between today (business time zone — the process TZ is
      // pinned) and the start, counted on dates only. It compared UTC midnight
      // of the start with LOCAL midnight today, so every request looked 5½
      // hours further away and got one day more notice than it gave.
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const noticeDays = Math.round((Date.parse(`${String(normalizedPayload.start_date).slice(0, 10)}T00:00:00Z`) - Date.parse(`${todayStr}T00:00:00Z`)) / 86400000);
      const exemptTypes = ['sick', 'medical', 'emergency', 'bereavement'];

      // Min notice. Exempt by the TYPE's own name — the request's free-text
      // leave_type let anyone send "sick" with an Earned Leave id and skip it.
      if (lt.min_notice_days > 0 && noticeDays < lt.min_notice_days) {
        if (!exemptTypes.some(e => String(lt.leave_name || '').toLowerCase().includes(e))) {
          return res.status(422).json({
            error: `This leave type requires at least ${lt.min_notice_days} day(s) advance notice.`,
            code: 'INSUFFICIENT_NOTICE',
          });
        }
      }

      // Half day only where the type allows it (2026-11-25: the flag was
      // shown on the form but never checked here).
      if (normalizedPayload.half_day && !lt.allow_half_day) {
        return res.status(422).json({
          error: `${lt.leave_name} cannot be taken as a half day.`,
          code: 'HALF_DAY_NOT_ALLOWED',
        });
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
        // Notice period (an open exit): Loss of Pay only, like probation.
        if (await openNoticePeriod(employee_id)) {
          return res.status(422).json({
            error: 'You are serving your notice period. Paid leave is not available — only Loss of Pay (unpaid) leave can be applied.',
            code: 'NOTICE_RESTRICTED',
          });
        }
      }

      // Supporting document. The type can demand one always, or once the
      // request is longer than N days (medical certificate). These flags were
      // read here before but never checked, so any request went through.
      // Only a file stored by POST /leaves/attachment counts (a local
      // /uploads/<name>, or the storage bucket's https URL) — not any text.
      const att = String(normalizedPayload.attachment_url || '').trim();
      const hasAttachment = /^\/uploads\/[\w.-]+$/.test(att) || /^https:\/\//.test(att);
      if (att && !hasAttachment) {
        return res.status(400).json({ error: 'Upload the attachment again — that file link is not valid.', code: 'ATTACHMENT_INVALID' });
      }
      if (!hasAttachment && lt.requires_attachment) {
        return res.status(422).json({
          error: 'This leave type needs a supporting document. Attach it and submit again.',
          code: 'ATTACHMENT_REQUIRED',
        });
      }
      if (!hasAttachment && Number(lt.requires_medical_cert_days) > 0 && requestedDays > Number(lt.requires_medical_cert_days)) {
        return res.status(422).json({
          error: `A medical certificate is required for more than ${lt.requires_medical_cert_days} day(s) of this leave. Attach it and submit again.`,
          code: 'MEDICAL_CERT_REQUIRED',
        });
      }
      // (The old "sandwich rule" check was removed 2026-11-23: it refused any
      // leave with a weekend on both sides — every full Mon–Fri week — and no
      // type had it on. Weekends/holidays inside a leave are charged as LOP by
      // the clubbing rule instead, company-wide.)
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
        -- A morning half and an afternoon half on the same day do not clash
        -- (2026-11-25: the second half was refused as an overlap).
        AND NOT ($4::boolean AND COALESCE(half_day, false)
                 AND UPPER(COALESCE(half_day_session, '')) IN ('AM', 'PM')
                 AND UPPER(COALESCE(half_day_session, '')) <> UPPER(COALESCE($5::text, '')))
    `, [employee_id, normalizedPayload.start_date, normalizedPayload.end_date,
        !!normalizedPayload.half_day, normalizedPayload.half_day ? (normalizedPayload.half_day_session || null) : null]);
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

router.post('/apply', ownLeave('add'), handleApplyLeave);

// ── POST /attachment — a leave's supporting document (2026-11-24) ────────────
// Stored by StorageService (local disk / S3) and served only through
// GET /files/:name, whose leave rule lets the applicant, their approvers and HR
// read it. Apply Leave used the document master before, which keeps no file
// without Google Drive (the certificate was lost) and hid it from the approver.
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /\.(pdf|jpe?g|png|docx?)$/i.test(file.originalname || '')),
});
router.post('/attachment', ownLeave('add'), (req, res) => {
  attachmentUpload.single('file')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The file must be under 5 MB.' : err.message });
      if (!req.file) return res.status(400).json({ error: 'Attach a PDF, JPG, PNG or Word file (under 5 MB).' });
      const url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      logAudit({ userId: req.user?.userId, module: 'leaves', recordId: null, recordType: 'leave_attachment', action: 'upload', newData: { url, name: req.file.originalname, size: req.file.size }, req });
      res.status(201).json({ attachment_url: url, file_name: req.file.originalname });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL WORKFLOW — L1 / L2 / L3
// ─────────────────────────────────────────────────────────────────────────────

// L1 — Manager Approval. Identity-gated (reporting manager/delegate/HR/admin —
// see shared/managerApprovalAuthz.js), not just anyone holding 'leaves.approve'
// permission — that permission alone previously let any manager-role user
// approve any employee's leave, not just their own reports.
// 2026-11-24: the gate is 'leaves.view', not 'leaves.approve'. Being the
// reporting manager IS the authority at this step; requiring the role grant
// too left every request whose manager holds only the `employee` role with
// no possible approver (HR may step in only when there is no usable manager).
// L1 reject and delegate follow the same rule.
async function approveL1(req, res) {
  try {
    const actorEmpId = req.user?.employee_id; // Always use authenticated user
    const { comments } = req.body;
    const found = await loadLeaveInCompany(req, req.params.id);
    if (!found) return res.status(404).json({ error: 'Leave application not found' });
    if (await blockOwnLeaveDecision(req, res, found, 'l1')) return;
    const oldRows = [found];
    const auth = await authorizeL1(req, oldRows[0]);
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    const application = await leavesRepository.approveByManager(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'approve', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'manager' }, req });
    // Sync to attendance if this is a single-level approval that results in status='approved'
    syncLeaveToAttendance(application, pool).catch(() => {});
    // Post LOP (probation / clubbing) if this approval finalized the leave
    // Awaited (2026-11-24): fire-and-forget let the posting land after the
    // response — payroll could be run before it, and a later cancel saw it twice.
    await postLopToPayroll(application, pool).catch(() => {});
    // Still pending: tell the employee which step is done and what is next —
    // not "Leave Approved", which they read as final.
    const { rows: [lt1] } = await pool.query('SELECT leave_name, l2_required FROM leave_types WHERE id = $1', [application.leave_type_id]);
    notifyLeaveEvent('leave_step_approved', {
      ...application, employee_name: oldRows[0]?.employee_name, leave_name: lt1?.leave_name,
    }, req.user, [application.employee_id], { step: 'your manager', next: lt1?.l2_required ? 'the department head and then HR' : 'HR' });
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
}
router.post('/approve/manager/:id', requirePermission('leaves', 'view'), approveL1);

async function rejectL1(req, res) {
  try {
    const actorEmpId = req.user?.employee_id;
    const { comments } = req.body;
    if (!comments?.trim()) return res.status(400).json({ error: 'A rejection reason (comments) is required' });
    const found = await loadLeaveInCompany(req, req.params.id);
    if (!found) return res.status(404).json({ error: 'Leave application not found' });
    if (await blockOwnLeaveDecision(req, res, found, 'l1')) return;
    const oldRows = [found];
    const auth = await authorizeL1(req, oldRows[0]);
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    const application = await leavesRepository.rejectByManager(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'reject', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'manager' }, req });
    reverseLeaveAttendance(application, pool).catch(() => {});
    notifyLeaveEvent('rejected', application, req.user, [application.employee_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
}
router.post('/reject/manager/:id', requirePermission('leaves', 'view'), rejectL1);

// L2 — Dept Head Approval
async function approveL2(req, res) {
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
    await postLopToPayroll(application, pool).catch(() => {});
    notifyLeaveEvent('leave_step_approved', application, req.user, [application.employee_id],
      { step: 'the department head', next: 'HR' });
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
}
router.post('/approve/l2/:id', requirePermission('leaves', 'approve'), approveL2);

async function rejectL2(req, res) {
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
}
router.post('/reject/l2/:id', requirePermission('leaves', 'approve'), rejectL2);

// L3 — HR Final Approval
async function approveHR(req, res) {
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
    await postLopToPayroll(application, pool).catch(() => {});
    notifyLeaveEvent('approved', application, req.user, [application.employee_id, application.manager_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
}
router.post('/approve/hr/:id', requirePermission('leaves', 'approve'), approveHR);

async function rejectHR(req, res) {
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
}
router.post('/reject/hr/:id', requirePermission('leaves', 'approve'), rejectHR);

// Bulk approve — HR/Admin only
router.post('/bulk-approve', requirePermission('leaves', 'approve'), async (req, res) => {
  const role = (req.user?.role || '').toLowerCase();
  if (!isAdminOrHR(req)) return res.status(403).json({ error: 'Only HR and Admin can bulk approve leaves' });
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
      // The HR-final step, exactly as one-by-one: needs L1 (and L2 where the
      // type requires it) first, and posts any LOP to payroll. It used to go
      // through updateStatus(), which skipped both.
      const app = await leavesRepository.approveByHR(id, actorEmpId, comments || 'Bulk approved');
      syncLeaveToAttendance(app, pool).catch(() => {});
      await postLopToPayroll(app, pool).catch(() => {});
      notifyLeaveEvent('approved', app, req.user, [app.employee_id, app.manager_id]);
      results.push({ id, status: 'approved' });
    } catch (err) {
      results.push({ id, status: 'error', error: err.message });
    }
  }
  logAudit({ userId: req.user?.userId, module: 'leaves', recordId: null, recordType: 'leave_application', action: 'bulk_approve', newData: { ids, results }, req });
  res.json({ success: true, results });
});

// Generic status update (admin/HR only — guarded)
router.put('/applications/:id/status', requirePermission('leaves', 'view'), handleStatusUpdate);

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR & ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

// Who the Leave Calendar shows (2026-11-25), the same lines the rest of this
// router draws: leave admins the whole company; a department head / L2
// approver their department + direct reports; a manager their direct reports
// (current reporting line, as the L1 queue); anyone else only themself.
// Before, every manager and department head saw the whole company's leave.
// null = company-wide; { kind: 'none' } = a login with no employee record.
export async function calendarScopeOf(req, db = pool) {
  if (hasRole(req, ...LEAVE_ADMIN_ROLES)) return null;
  const me = await employeeOf(req, db);
  if (me == null) return { kind: 'none' };
  if (hasRole(req, 'department_head', 'l2_approver')) return { kind: 'department', me };
  if (hasRole(req, 'manager')) return { kind: 'manager', me };
  return { kind: 'self', me };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

router.get('/calendar', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const { start_date, end_date, employee_id, department, include_pending } = req.query;
    if ((start_date && !ISO_DAY.test(start_date)) || (end_date && !ISO_DAY.test(end_date))) {
      return res.status(400).json({ error: 'start_date and end_date must be YYYY-MM-DD.', code: 'BAD_DATE' });
    }
    if (employee_id != null && employee_id !== '' && !/^\d+$/.test(String(employee_id))) {
      return res.status(400).json({ error: 'employee_id must be a number.', code: 'BAD_EMPLOYEE' });
    }
    const scope = await calendarScopeOf(req);
    if (scope?.kind === 'none') return res.json([]);
    // Only the known filters — a caller's employee_id / department narrows
    // inside the scope above, never widens it.
    const filters = {
      start_date, end_date, include_pending, department: department || undefined,
      employee_id: employee_id ? Number(employee_id) : undefined,
      company_id: req.scope?.company_id ?? null, scope,
    };
    res.json(await leavesRepository.getLeaveCalendar(filters));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /calendar/people — the current staff the calendar's filters may pick,
// in the same scope as /calendar (the full /employees list showed everyone,
// including people who have left).
router.get('/calendar/people', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const scope = await calendarScopeOf(req);
    if (scope?.kind === 'none') return res.json([]);
    res.json(await leavesRepository.getLeaveCalendarPeople({
      company_id: req.scope?.company_id ?? null, scope, currentSql: isCurrentSql('e.status'),
    }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /calendar/holidays?year=2027[&employee_id=] — the days off of the people
// the calendar shows: company-wide holidays + every zone they sit in (or one
// employee's zone). An employee_id outside the caller's scope returns [].
router.get('/calendar/holidays', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const { year, employee_id } = req.query;
    if (!/^\d{4}$/.test(String(year || ''))) {
      return res.status(400).json({ error: 'year must be YYYY.', code: 'BAD_YEAR' });
    }
    if (employee_id != null && employee_id !== '' && !/^\d+$/.test(String(employee_id))) {
      return res.status(400).json({ error: 'employee_id must be a number.', code: 'BAD_EMPLOYEE' });
    }
    const scope = await calendarScopeOf(req);
    if (scope?.kind === 'none') return res.json([]);
    res.json(await leavesRepository.getLeaveCalendarHolidays({
      company_id: req.scope?.company_id ?? null, scope, year,
      employee_id: employee_id ? Number(employee_id) : null, currentSql: isCurrentSql('e.status'),
    }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Company-wide counts per type — HR/admin only (go-live check 2026-11-25: any
// leaves:view holder, i.e. every employee, could read the whole company's).
router.get('/analytics', requireLeaveAdmin, requirePermission('leaves', 'view'), async (req, res) => {
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
    const filters = { ...req.query, company_id: req.scope?.company_id ?? null };
    if (!isAdminOrHR(req)) {
      // -1, not null: findApplications skips a falsy manager_id, which would
      // hand an unlinked login the whole company's list.
      // Reporting line (current) + leaves delegated to me, as the L1 queue.
      delete filters.manager_id;
      filters.l1_for = req.user?.employee_id || -1;
      // Security: employees and managers cannot pass arbitrary employee_id to see others
      if (!hasRole(req, 'manager', 'department_head', 'l2_approver')) {
        delete filters.employee_id;
      }
    }
    res.json(await leavesRepository.findApplications(filters));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /balance — current user's own balance (uses employee_id, not userId)
router.get('/balance', ownLeave('view'), async (req, res) => {
  try {
    const employeeId = req.user?.employee_id;
    if (!employeeId) return res.status(400).json({ error: 'Employee profile not linked to this user account' });
    res.json(await leavesRepository.getLeaveBalance(employeeId, req.query.year));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy approve/reject/cancel shims
// Older one-button aliases — the same step-aware decision (handleStatusUpdate).
const withStatus = (status) => (req, res) => { req.body = { ...(req.body || {}), status }; return handleStatusUpdate(req, res); };
router.patch('/:id/approve', requirePermission('leaves', 'view'), withStatus('approved'));
router.put('/:id/approve',   requirePermission('leaves', 'view'), withStatus('approved'));
router.patch('/:id/reject',  requirePermission('leaves', 'view'), withStatus('rejected'));
router.put('/:id/reject',    requirePermission('leaves', 'view'), withStatus('rejected'));

/**
 * Cancel (or withdraw) a leave — the one rule both routes share (2026-11-24):
 *   - an employee cancels only their own, and only before it starts (the
 *     My Leaves button was the only guard; the API took any date);
 *   - HR / admin may cancel any, but one that has already started needs a reason;
 *   - an approved leave's Loss of Pay is taken back off the draft payroll run;
 *     if that month's payroll is already approved it is left alone and the
 *     answer says so, for HR to correct in Payroll.
 */
async function cancelLeave(req, res, { reason = '', withdraw = false } = {}) {
  const app = await loadLeaveInCompany(req, req.params.id);
  if (!app) return res.status(404).json({ error: 'Leave application not found' });
  const hr = isAdminOrHR(req);
  if (!hr && String(app.employee_id) !== String(req.user?.employee_id)) {
    return res.status(403).json({ error: `You can only ${withdraw ? 'withdraw' : 'cancel'} your own leave applications` });
  }
  if (!['approved', 'pending'].includes(app.status)) {
    return res.status(409).json({ error: `A leave that is ${app.status} cannot be cancelled` });
  }
  const { rows: [when] } = await pool.query(
    'SELECT start_date < CURRENT_DATE AS started FROM leave_applications WHERE id = $1', [app.id]);
  if (when?.started && !hr) {
    return res.status(409).json({
      error: 'This leave has already started, so it can no longer be cancelled here. Ask HR to cancel it.',
      code: 'LEAVE_ALREADY_STARTED',
    });
  }
  if (when?.started && !String(reason || '').trim()) {
    return res.status(400).json({ error: 'This leave has already started — give the reason for cancelling it.', code: 'REASON_REQUIRED' });
  }
  const application = await leavesRepository.updateStatus(req.params.id, 'cancelled', req.user?.employee_id, reason || '');
  if (withdraw) await pool.query('UPDATE leave_applications SET withdrawal_reason = $1 WHERE id = $2', [reason, req.params.id]);
  reverseLeaveAttendance(application, pool).catch(() => {});
  const lop = app.status === 'approved' ? await postLopToPayroll(app, pool, -1) : null;
  logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application',
    action: withdraw ? 'withdraw' : 'cancel', oldData: app, newData: { status: 'cancelled', reason, lop_reversed: lop }, req });
  notifyLeaveEvent('cancelled', { ...application, employee_name: app.employee_name }, req.user, [app.manager_id, app.hr_id]);
  return res.json({
    success: true, ...application,
    ...(withdraw ? { withdrawal_reason: reason } : {}),
    ...(lop?.finalised ? { warning: `This month's payroll is already approved, so its ${lop.days} day(s) of Loss of Pay were not taken back. Correct it in Payroll (arrears).` } : {}),
  });
}

router.put('/:id/cancel', ownLeave('view'), async (req, res) => {
  try {
    await cancelLeave(req, res, { reason: req.body?.reason || '' });
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

// Withdraw — the same, with a reason always required and kept on the leave.
router.post('/:id/withdraw', ownLeave('view'), async (req, res) => {
  try {
    const reason = req.body?.reason;
    if (!reason?.trim()) return res.status(400).json({ error: 'Withdrawal reason is required' });
    await cancelLeave(req, res, { reason, withdraw: true });
  } catch (err) {
    res.status(statusForWorkflowError(err)).json({ error: err.message });
  }
});

// ── GET /on-leave-today — employees on approved leave right now ───────────────
// 2026-11-25: in the Leave Calendar's scope (calendarScopeOf). It used to list
// the whole company's names + leave types to anyone with leaves:view, and
// ignored the Manager Dashboard's ?department. "Today" is the business date —
// toISOString() was UTC, i.e. yesterday until 05:30 IST.
router.get('/on-leave-today', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const { rows: [{ today }] } = await pool.query(`SELECT CURRENT_DATE::text AS today`);
    const scope = await calendarScopeOf(req);
    const rows = scope?.kind === 'none' ? []
      : await leavesRepository.getOnLeaveToday({
        company_id: companyId, scope, department: req.query.department || null });
    res.json({ date: today, count: rows.length, employees: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /delegate/:id — manager sets a delegate approver for a pending leave ─
router.post('/delegate/:id', requirePermission('leaves', 'view'), async (req, res) => {
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
    const auth = await authorizeL1(req, found);
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
      // A manager login with no employee record has no team: nothing to show
      // (a null manager filter returned every row in the company, 2026-11-24).
      if (me == null) return res.json([]);
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
// HR/admin only (2026-11-24): it lists every employee's carried-forward days,
// and 'leaves.view' is held by every employee.
router.get('/carry-forward-report', requireLeaveAdmin, requirePermission('leaves', 'view'), async (req, res) => {
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

// Generic workflow-engine routes RETIRED (go-live check 2026-11-25). Leave is
// decided only by the manager (L1) → dept head (L2) → HR routes. /advance
// finalised the leave straight to 'approved' from L1 — skipping L2 and HR,
// and never posting LOP to payroll. No screen called either route, and no
// leave workflow instance exists.
router.all(['/:id/workflow', '/:id/workflow/advance'], (req, res) =>
  res.status(410).json({ error: 'Leave is approved in Leave Approvals (manager → dept head → HR)', code: 'LEAVE_WORKFLOW_RETIRED' }));

export default router;

