import express from "express";
import { addEmployee, getEmployees, getEmployee, updateEmployee, deleteEmployee, getNextEmployeeCode, getEmployeeAnalytics, getExEmployees } from "./employee.controller.js";
import { verifyToken, allowRoles } from "../middlewares/auth.middleware.js";
import { logAudit } from "../services/AuditService.js";
import pool from "../config/db.js";
import { companyOf, callerIdentity } from "../shared/scope.js";
import { presenceOf } from "../shared/presence.js";

const HR_ROLES = [
  "admin", "super_admin", "hr", "hr_manager", "hr_exec", "payroll_admin",
  // legacy mixed-case variants stored in older user records
  "Admin", "SuperAdmin", "HR",
];

const router = express.Router();

router.get("/analytics", verifyToken, getEmployeeAnalytics);
router.get("/ex", verifyToken, getExEmployees);
router.get("/", verifyToken, getEmployees);
router.get("/next-code", verifyToken, allowRoles(...HR_ROLES), getNextEmployeeCode);

// ── Salary revisions ──────────────────────────────────────────────────────────
router.get("/:id/salary-revisions", verifyToken, allowRoles(...HR_ROLES, "hr_manager", "hr_exec", "payroll_admin", "finance_manager"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Invalid employee id' });
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.employee_id, a.effective_from, a.basic_salary,
              a.special_allowance, a.loan_deduction, a.advance_deduction, a.created_at,
              s.name AS structure_name, s.id AS structure_id
       FROM employee_salary_assignments a
       LEFT JOIN salary_structures s ON s.id = a.structure_id
       WHERE a.employee_id = $1
       ORDER BY a.effective_from DESC, a.created_at DESC`,
      [id]
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
    const newStatus = 'Notice';
    await client.query(`UPDATE employees SET status=$1 WHERE id=$2`, [newStatus, empId]);

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
    res.json({ success: true, employee: emp });
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
          SET status      = 'Active',
              joining_date = $1,
              exit_date   = NULL,
              exit_reason = NULL
        WHERE id = $2
        RETURNING *`,
      [joiningDate, empId]
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

    res.json({ success: true, employee: emp });
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
const DIRECTORY_PHONE_ROLES = new Set([
  'admin', 'super_admin', 'hr', 'HR', 'Admin', 'SuperAdmin',
  'hr_manager', 'hr_exec', 'payroll_admin', 'manager', 'Manager',
]);
router.get("/directory", verifyToken, async (req, res) => {
  const companyId  = req.scope?.company_id ?? null;
  const canSeePhone = DIRECTORY_PHONE_ROLES.has(req.user?.role || '');
  try {
    const { rows } = await pool.query(
      `SELECT
         e.id,
         e.office_id,
         TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS name,
         e.first_name,
         e.last_name,
         e.designation,
         e.department,
         e.company_email,
         CASE WHEN $2 THEN e.phone ELSE NULL END AS phone,
         e.status,
         e.photo_url,
         e.joining_date,
         e.location,
         e.reporting_manager,
         TO_CHAR(e.dob,          'MM-DD') AS birth_md,
         TO_CHAR(e.joining_date, 'MM-DD') AS anniversary_md,
         EXISTS (
           SELECT 1 FROM leave_applications la
           WHERE la.employee_id = e.id
             AND CURRENT_DATE BETWEEN la.start_date AND la.end_date
             AND (la.hr_status = 'approved' OR la.manager_status = 'approved')
         ) AS on_leave_today
       FROM employees e
       WHERE LOWER(COALESCE(e.status,'active')) NOT IN
               ('left','terminated','resigned','inactive','ex-employee','notice_period','notice period')
         AND ($1::int IS NULL OR e.company_id = $1)
       ORDER BY e.first_name, e.last_name`,
      [companyId, canSeePhone]
    );
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
router.post("/", verifyToken, allowRoles(...HR_ROLES), addEmployee);
router.put("/:id", verifyToken, allowRoles(...HR_ROLES), updateEmployee);
// Lightweight status-only patch — auto-sets confirmation_date when status → Active
router.patch("/:id/status", verifyToken, allowRoles(...HR_ROLES, "hr_manager"), async (req, res) => {
  const empId = Number(req.params.id);
  if (!Number.isInteger(empId) || empId < 1) return res.status(400).json({ error: 'Invalid employee id' });
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required' });
  try {
    const today = new Date().toISOString().split('T')[0];
    const confirmClause = String(status).toLowerCase() === 'active'
      ? `, confirmation_date = COALESCE(confirmation_date, '${today}'::date)`
      : '';
    const { rows } = await pool.query(
      `UPDATE employees SET status=$1${confirmClause}, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [status, empId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    logAudit({ userId: req.user?.id, module: 'employees', recordId: empId, recordType: 'employee', action: 'update_status', newData: { status } });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete("/:id", verifyToken, allowRoles(...HR_ROLES), deleteEmployee);

export default router;
