import express from "express";
import { addEmployee, getEmployees, getEmployee, updateEmployee, deleteEmployee, getNextEmployeeCode, getEmployeeAnalytics, getExEmployees,
  listBankChangeRequests, approveBankChangeRequest, rejectBankChangeRequest, withdrawBankChangeRequest, requestBankVerification } from "./employee.controller.js";
import { verifyToken, allowRoles, hasRole, requirePermission } from "../middlewares/auth.middleware.js";
import { logAudit } from "../services/AuditService.js";
import pool from "../config/db.js";
import { companyOf, callerIdentity } from "../shared/scope.js";
import { presenceOf } from "../shared/presence.js";
import { captureBefore } from '../middlewares/captureBefore.js';
import { canonicalWritableStatus, WRITABLE_STATUSES, EXIT_STATUS, EXITED_STATUSES } from "../shared/employeeStatus.js";
import { exitStatusWorkflowOnly } from "../shared/hrContainment.js";
import { getDirectoryEntries } from "./employee.service.js";
import { readScope } from "../shared/employeeAccess.js";
import { withSalaryMasking } from "./salaryVisibility.js";

const HR_ROLES = [
  "admin", "super_admin", "hr", "hr_manager", "hr_exec", "payroll_admin",
  // legacy mixed-case variants stored in older user records
  "Admin", "SuperAdmin", "HR",
];

// Roles that reach the Employees section in the sidebar (ROLE_SECTION_ALLOWLIST
// in the frontend's menuCatalog.js). Offboarding records — separation type,
// exit reason, F&F status — are not phonebook data: this list was
// verifyToken-only, so any authenticated caller could read every ex-employee's
// full row, salary and bank block included. maskPII in getExEmployees redacts
// what the non-HR roles here must not see.
const EX_EMPLOYEE_ROLES = [...HR_ROLES, "manager", "department_head"];

const router = express.Router();

router.get("/analytics", verifyToken, getEmployeeAnalytics);
// Bank-detail maker-checker (§204). Above the /:id routes so the path is not
// read as an employee id. Each handler checks the employee_bank grant itself.
router.get("/bank-change-requests", verifyToken, listBankChangeRequests);
router.post("/bank-change-requests/:id/approve", verifyToken, approveBankChangeRequest);
router.post("/bank-change-requests/:id/reject", verifyToken, rejectBankChangeRequest);
router.post("/bank-change-requests/:id/withdraw", verifyToken, withdrawBankChangeRequest);
// "Verify as-is": the details on record go to a second HR person unchanged (§206).
router.post("/:id/bank-verification-request", verifyToken, requestBankVerification);
router.get("/ex", verifyToken, allowRoles(...EX_EMPLOYEE_ROLES), getExEmployees);
router.get("/", verifyToken, getEmployees);
router.get("/next-code", verifyToken, allowRoles(...HR_ROLES), getNextEmployeeCode);

// ── Salary revisions ──────────────────────────────────────────────────────────
// PC-01 D5 (04 Nov 26): payroll:view, from the permission matrix — the same
// right that reads salary assignments in Payroll Center. It used to be a role
// list that also admitted hr_exec and finance_manager. Scope: the employee must
// be in the caller's company; a login with no company is refused unless it is a
// genuinely global super-admin scope (it used to read every tenant).
router.get("/:id/salary-revisions", verifyToken, requirePermission('payroll', 'view'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Invalid employee id' });
  const companyId = companyOf(req);
  if (companyId == null && !req.scope?.isGlobal) {
    return res.status(403).json({ message: 'No company context for this login' });
  }
  try {
    // Salary history is the most sensitive payload this page serves and this
    // route was gated on ROLE ONLY — `WHERE a.employee_id = $1`, no tenant
    // predicate. Holding an HR role in company B was therefore enough to read
    // company A's basic salary by id. The join to `employees` makes the
    // caller's company part of the lookup instead of an afterthought; a null
    // companyId is a genuinely global super-admin scope.
    const { rows } = await pool.query(
      `SELECT a.id, a.employee_id, a.effective_from, a.basic_salary,
              a.special_allowance, a.loan_deduction, a.advance_deduction, a.created_at,
              a.entry_mode, a.annual_ctc, a.ctc_policy_version, a.breakdown, a.proposal_id,
              s.name AS structure_name, s.id AS structure_id
       FROM employee_salary_assignments a
       JOIN employees e ON e.id = a.employee_id AND e.deleted_at IS NULL
       LEFT JOIN salary_structures s ON s.id = a.structure_id
       WHERE a.employee_id = $1
         AND ($2::int IS NULL OR e.company_id = $2::int)
       ORDER BY a.effective_from DESC, a.created_at DESC`,
      [id, companyId]
    );
    logAudit({ userId: req.user?.id, module: 'employees', recordId: id, recordType: 'salary_revision', action: 'view', req });
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Offboard an active employee ───────────────────────────────────────────────
// Creates an exit_request and transitions employee status in one transaction.
router.post("/:id/offboard", verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const empId = Number(req.params.id);
  if (!Number.isInteger(empId) || empId < 1) return res.status(400).json({ error: 'Invalid employee id' });

  const {
    separation_type = 'resignation',
    last_working_date,
    notice_period,
    reason,
  } = req.body;

  if (!last_working_date) return res.status(400).json({ error: 'last_working_date is required' });

  const companyId = req.scope?.company_id ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Scope check
    const { rows: [emp] } = await client.query(
      `SELECT * FROM employees WHERE id=$1 ${companyId != null ? 'AND company_id=$2' : ''}`,
      companyId != null ? [empId, companyId] : [empId]
    );
    if (!emp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Employee not found' }); }

    // Create exit request
    const { rows: [er] } = await client.query(
      `INSERT INTO exit_requests
         (employee_id, separation_type, last_working_date, notice_period, reason, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
      [empId, separation_type, last_working_date, notice_period || null, reason || null]
    );

    // Seed exit_clearance row so checklist is immediately visible
    await client.query(
      `INSERT INTO exit_clearance (employee_id) VALUES ($1) ON CONFLICT (employee_id) DO NOTHING`,
      [empId]
    );

    // Move employee into notice period — NOT straight to the terminal status.
    // exitStatusSync.cron.js flips to resigned/terminated/left once
    // last_working_date actually arrives; 'notice' keeps them counted as
    // active for payroll/attendance in the meantime (mirrors exit.routes.js
    // POST /initiate, the other entry point into the same flow).
    // Capitalized to match live employees.status convention and the
    // frontend's STATUS_STYLE.Notice badge (EmployeeProfile.jsx).
    // canonicalWritableStatus rather than a bare literal: this value is the
    // reason 'Notice' counts as employed everywhere else, so it must come from
    // the same vocabulary those readers use.
    const newStatus = canonicalWritableStatus('Notice');
    // Defence in depth: the handler already proved this employee belongs to the
    // caller's company above, but a bare `WHERE id =` on an employees write is the
    // shape of the bug that was found on PATCH /:id/status and on exit F&F. The
    // predicate costs nothing and removes the need to trace the proof.
    await client.query(
      `UPDATE employees SET status=$1, updated_at=NOW()
        WHERE id=$2 AND ($3::int IS NULL OR company_id=$3)`,
      [newStatus, empId, companyId]
    );

    await client.query('COMMIT');

    logAudit({
      userId: req.user?.id,
      module: 'employees',
      recordId: empId,
      recordType: 'employee',
      action: 'offboard',
      oldData: { status: emp.status },
      newData: { status: newStatus, separation_type, last_working_date, exit_request_id: er.id },
    });

    res.status(201).json({ exit_request: er, employee_status: newStatus });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Retroactively patch exit details for existing ex-employees ────────────────
// Fixes records that were status-changed without going through the offboard flow.
router.patch("/ex/:id/exit-details", verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const empId = Number(req.params.id);
  if (!Number.isInteger(empId) || empId < 1) return res.status(400).json({ error: 'Invalid employee id' });

  const { exit_date, exit_reason, separation_type, last_working_date } = req.body;
  const companyId = req.scope?.company_id ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update employees table base fields
    const { rows: [emp] } = await client.query(
      `UPDATE employees
          SET exit_date   = COALESCE($1, exit_date),
              exit_reason = COALESCE($2, exit_reason)
        WHERE id = $3 ${companyId != null ? 'AND company_id=$4' : ''}
        RETURNING *`,
      companyId != null
        ? [exit_date || null, exit_reason || null, empId, companyId]
        : [exit_date || null, exit_reason || null, empId]
    );
    if (!emp) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Employee not found' }); }

    // If no exit_request exists yet, create a minimal one so all derived fields work
    if (separation_type || last_working_date) {
      const { rows: existing } = await client.query(
        `SELECT id FROM exit_requests WHERE employee_id=$1 AND status NOT IN ('rejected','cancelled') LIMIT 1`,
        [empId]
      );
      if (existing.length) {
        await client.query(
          `UPDATE exit_requests
              SET separation_type   = COALESCE($1, separation_type),
                  last_working_date = COALESCE($2, last_working_date),
                  updated_at        = NOW()
            WHERE id = $3`,
          [separation_type || null, last_working_date || null, existing[0].id]
        );
      } else {
        await client.query(
          `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status, reason)
           VALUES ($1, $2, $3, 'closed', $4)`,
          [empId, separation_type || 'resignation', last_working_date || exit_date || null, exit_reason || null]
        );
      }
    }

    await client.query('COMMIT');
    logAudit({ userId: req.user?.id, module: 'employees', recordId: empId, recordType: 'employee', action: 'update_exit_details', newData: req.body });
    res.json(await withSalaryMasking(req, { success: true, employee: emp }));
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Rehire an ex-employee ─────────────────────────────────────────────────────
router.post("/ex/:id/rehire", verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const empId = Number(req.params.id);
  if (!Number.isInteger(empId) || empId < 1) return res.status(400).json({ error: 'Invalid employee id' });

  const { new_joining_date } = req.body;
  const joiningDate = new_joining_date || new Date().toISOString().slice(0, 10);
  const companyId = req.scope?.company_id ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [old] } = await client.query(
      `SELECT * FROM employees WHERE id=$1 ${companyId != null ? 'AND company_id=$2' : ''}`,
      companyId != null ? [empId, companyId] : [empId]
    );
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Employee not found' }); }
    if (old.separation_type === 'termination' || (old.exit_reason || '').toLowerCase().includes('terminat')) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Terminated employees are not eligible for rehire' });
    }

    const { rows: [emp] } = await client.query(
      `UPDATE employees
          SET status      = $1,
              joining_date = $2,
              exit_date   = NULL,
              exit_reason = NULL,
              updated_at  = NOW()
        WHERE id = $3 AND ($4::int IS NULL OR company_id = $4)
        RETURNING *`,
      // ACTIVE_STATUSES[0] capitalised via the vocabulary rather than a literal:
      // a rehire must land on the same 'Active' every reader recognises.
      [canonicalWritableStatus('Active'), joiningDate, empId, companyId]
    );

    // Close any open exit request
    await client.query(
      `UPDATE exit_requests SET status='closed', updated_at=NOW()
        WHERE employee_id=$1 AND status NOT IN ('closed','rejected','cancelled')`,
      [empId]
    );

    await client.query('COMMIT');

    logAudit({
      userId: req.user?.id,
      module: 'employees',
      recordId: empId,
      recordType: 'employee',
      action: 'rehire',
      oldData: { status: old.status, exit_date: old.exit_date },
      newData: { status: 'Active', joining_date: joiningDate },
    });

    res.json(await withSalaryMasking(req, { success: true, employee: emp }));
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Employee Directory — company phonebook (active staff only, safe fields) ──────
// Managers and above can see personal phone. Regular employees cannot.
// birthday (MM-DD only, no year) and on_leave_today are included for card badges.
const DIRECTORY_PHONE_ROLES = [
  'admin', 'super_admin', 'hr',
  'hr_manager', 'hr_exec', 'payroll_admin', 'manager',
];
router.get("/directory", verifyToken, async (req, res) => {
  // An unresolved company is refused, not read as "every company".
  const scope = readScope(req);
  if (scope.refused) return res.status(403).json({ error: "Your account has no company assignment" });
  const companyId = scope.companyId;
  // hasRole() over the whole user_roles set, lower-cased on both sides. The
  // previous Set membership test read req.user.role — the primary claim only —
  // so a manager or HR user holding that grant as a secondary role had the
  // phone column redacted, and the mixed-case legacy variants were carried in
  // the Set purely to work around the missing case fold.
  const canSeePhone = hasRole(req, DIRECTORY_PHONE_ROLES);
  try {
    // The projection lives in employee.service.js (getDirectoryEntries) so the
    // single-employee read a directory-tier caller gets from GET /employees/:id
    // is, by construction, exactly this phonebook row and no more.
    const rows = await getDirectoryEntries({ companyId, canSeePhone });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/list", verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const where = companyId != null ? `WHERE company_id = $1 AND deleted_at IS NULL` : `WHERE deleted_at IS NULL`;
    const params = companyId != null ? [companyId] : [];
    const { rows } = await (await import('../config/db.js')).default.query(
      `SELECT id, name, designation, department, company_id FROM employees ${where} ORDER BY name`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
/**
 * GET /employees/direct-reports — the caller's own reporting line.
 *
 * MUST stay above `GET /:id`: Express matches in registration order, so a
 * literal path registered after a `/:id` route is unreachable ("direct-reports"
 * would bind as :id and 400 on the integer cast).
 *
 * Not HR-gated — every employee is entitled to see who reports to them, and the
 * query is anchored to the caller's own employee id, so there is nothing to
 * escalate. The Manager dashboard's "Direct Reports" card reads this.
 *
 * `status` is today's attendance state, not the employment status: the card
 * renders it as a presence dot. It is 'unknown' when no record exists for today,
 * so an unmarked team does not silently render as fully present.
 */
router.get("/direct-reports", verifyToken, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const me = await callerIdentity(req, pool, companyId);

    // Admin / service accounts have no employees row, so there is no personal
    // reporting line to walk — and they are the ONLY roles that can open the
    // Ops Command Center, so returning [] here left the card permanently empty.
    //
    // Their remit is the whole org, so answer the org-level version of the same
    // question: who manages whom. Reported under a distinct `source` so the card
    // can relabel itself rather than pass this off as the caller's own reports.
    if (!me.employee_id) {
      const { rows } = await pool.query(
        `SELECT m.id,
                m.name,
                m.department,
                m.designation,
                m.status        AS employment_status,
                cnt.n::int      AS reports_count,
                ar.status       AS att_status,
                ar.work_mode    AS att_work_mode,
                COALESCE(ar.late_minutes, 0)::int AS att_late_minutes
           FROM employees m
           JOIN LATERAL (
                SELECT COUNT(*) AS n
                  FROM employees c
                 WHERE c.deleted_at IS NULL
                   AND c.id <> m.id
                   AND LOWER(COALESCE(c.status, 'active')) NOT IN ('inactive','resigned','terminated','exited','left')
                   AND ($1::int IS NULL OR c.company_id = $1)
                   AND ( c.reporting_manager_id = m.id
                         OR ( c.reporting_manager_id IS NULL
                              AND NULLIF(TRIM(m.name), '') IS NOT NULL
                              AND LOWER(TRIM(c.reporting_manager)) = LOWER(TRIM(m.name)) ) )
           ) cnt ON cnt.n > 0
           LEFT JOIN attendance_records ar
                  ON ar.employee_id     = m.id
                 AND ar.attendance_date = CURRENT_DATE
                 AND ar.deleted_at IS NULL
          WHERE m.deleted_at IS NULL
            AND LOWER(COALESCE(m.status, 'active')) NOT IN ('inactive','resigned','terminated','exited','left')
            AND ($1::int IS NULL OR m.company_id = $1)
          ORDER BY cnt.n DESC, m.name
          LIMIT 25`,
        [companyId]
      );
      return res.json({
        data: rows.map(r => ({
          id:                r.id,
          name:              r.name,
          department:        r.department,
          designation:       r.designation,
          employment_status: r.employment_status,
          reports_count:     r.reports_count,
          status:            presenceOf(r),
        })),
        source: "org_reporting_lines",
        reason: rows.length
          ? null
          : "No reporting lines are recorded yet — set a reporting manager on the employee records.",
      });
    }

    const { rows } = await pool.query(
      `SELECT e.id,
              e.name,
              e.department,
              e.designation,
              e.status                              AS employment_status,
              (SELECT COUNT(*) FROM employees c
                WHERE c.reporting_manager_id = e.id
                  AND c.id <> e.id
                  AND c.deleted_at IS NULL)::int    AS reports_count,
              ar.status                             AS att_status,
              ar.work_mode                          AS att_work_mode,
              COALESCE(ar.late_minutes, 0)::int     AS att_late_minutes
         FROM employees e
         LEFT JOIN attendance_records ar
                ON ar.employee_id     = e.id
               AND ar.attendance_date = CURRENT_DATE
               AND ar.deleted_at IS NULL
        WHERE e.deleted_at IS NULL
          AND e.id <> $1
          AND LOWER(COALESCE(e.status, 'active')) NOT IN ('inactive','resigned','terminated','exited','left')
          AND ($3::int IS NULL OR e.company_id = $3)
          AND ( e.reporting_manager_id = $1
                OR ( e.reporting_manager_id IS NULL
                     AND $2::text IS NOT NULL
                     AND LOWER(TRIM(e.reporting_manager)) = LOWER(TRIM($2::text)) ) )
        ORDER BY e.name`,
      [me.employee_id, me.name ?? null, companyId]
    );

    res.json({
      data: rows.map(r => ({
        id:                r.id,
        name:              r.name,
        department:        r.department,
        designation:       r.designation,
        employment_status: r.employment_status,
        reports_count:     r.reports_count,
        status:            presenceOf(r),
      })),
      source: "reporting_hierarchy",
      manager: { employee_id: me.employee_id, name: me.name },
      reason:  rows.length ? null : "No one currently reports to you in the org hierarchy.",
    });
  } catch (err) {
    console.error("[GET /employees/direct-reports]", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id", verifyToken, getEmployee);
// ── Containment C6 / MD-14 (HR_P0_REMEDIATION_DESIGN_2026-11-03.md, P0-6) ──
// A current employee reaches an exit status only through Exit Management, which
// records the exit request, clearance and F&F. These three writers used to end
// the employment directly: PUT with status 'Left' (All Employees → Terminate and
// the Edit Employee status field), POST creating someone as 'Left', and DELETE,
// which soft-deletes with status 'terminated'. A record that is ALREADY exited
// may still be edited (or soft-deleted): that changes no employment. A body that
// carries no exit status, or an id the controller will refuse anyway, passes
// through untouched.
const USE_EXIT_WORKFLOW = {
  code: 'USE_EXIT_WORKFLOW',
  error: 'An employee leaves through Exit Management (Initiate Exit), which records the exit, clearance and settlement.',
};
async function exitStatusViaWorkflow(req, res, next) {
  if (!exitStatusWorkflowOnly()) return next();
  try {
    const endsEmployment = req.method === 'DELETE'
      || canonicalWritableStatus(req.body?.status) === EXIT_STATUS;
    if (!endsEmployment) return next();
    if (req.method === 'POST') return res.status(409).json(USE_EXIT_WORKFLOW);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return next();
    const { rows: [cur] } = await pool.query(
      `SELECT status FROM employees WHERE id = $1 AND ($2::int IS NULL OR company_id = $2::int)`,
      [id, companyOf(req)]);
    if (!cur) return next();   // the controller answers with its own 404
    if (EXITED_STATUSES.includes(String(cur.status || '').trim().toLowerCase())) return next();
    return res.status(409).json(USE_EXIT_WORKFLOW);
  } catch (err) { return next(err); }
}

router.post("/", verifyToken, allowRoles(...HR_ROLES), exitStatusViaWorkflow, addEmployee);
router.put("/:id", verifyToken, allowRoles(...HR_ROLES), exitStatusViaWorkflow, updateEmployee);
// Lightweight status-only patch — auto-sets confirmation_date when status → Active
router.patch("/:id/status", verifyToken, allowRoles(...HR_ROLES, "hr_manager"), captureBefore('employees'), async (req, res) => {
  const empId = Number(req.params.id);
  if (!Number.isInteger(empId) || empId < 1) return res.status(400).json({ error: 'Invalid employee id' });
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required' });

  // Validate against the canonical WRITE vocabulary. This endpoint took the
  // body's `status` straight into an UPDATE, so any string at all became an
  // employment status — `{"status":"totally-made-up"}` was a 200. That is how a
  // vocabulary grows synonyms faster than anything can reconcile them.
  // canonicalWritableStatus also fixes the spelling, so 'notice' is stored as
  // 'Notice' rather than as a fourth variant of it.
  const canonical = canonicalWritableStatus(status);
  if (!canonical) {
    return res.status(400).json({
      error: `"${status}" is not a valid employment status.`,
      allowed: WRITABLE_STATUSES,
    });
  }
  // Containment C6 (HR_P0_REMEDIATION_DESIGN_2026-11-03.md, P0-6): ending the
  // employment here skipped exit, clearance, F&F and login revocation. No screen
  // sends it (EmployeesData's row and bulk menus never offer 'Left'), so only a
  // direct API call is refused.
  if (canonical === EXIT_STATUS && exitStatusWorkflowOnly()) {
    return res.status(409).json({
      code: 'USE_EXIT_WORKFLOW',
      error: 'An employee leaves through Exit Management, not a status change.',
    });
  }

  const companyId = companyOf(req);
  try {
    const today = new Date().toISOString().split('T')[0];
    const confirmClause = canonical === 'Active'
      ? `, confirmation_date = COALESCE(confirmation_date, '${today}'::date)`
      : '';
    // Tenant-scoped. This UPDATE was `WHERE id=$2` alone — the only employee
    // write in this file with no company filter — so an HR user in one company
    // could flip the employment status of any employee id in the database, in
    // any tenant, and the audit entry would look entirely routine.
    const { rows } = await pool.query(
      `UPDATE employees SET status=$1${confirmClause}, updated_at=NOW()
        WHERE id=$2 AND ($3::int IS NULL OR company_id=$3) RETURNING *`,
      [canonical, empId, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    logAudit({ userId: req.user?.id, module: 'employees', recordId: empId, recordType: 'employee', action: 'update_status', newData: { status: canonical } });
    res.json(await withSalaryMasking(req, rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete("/:id", verifyToken, allowRoles(...HR_ROLES), exitStatusViaWorkflow, deleteEmployee);

export default router;
