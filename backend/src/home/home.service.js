import pool from "../config/db.js";

export const getActiveAnnouncements = async () => {
  const result = await pool.query(`
    SELECT id, title, message, created_by, created_at, to_date AS expiry_date
    FROM announcements
    WHERE is_active = true
    AND (to_date IS NULL OR to_date >= CURRENT_DATE)
    ORDER BY created_at DESC
  `);
  return result.rows;
};

export const getUpcomingEvents = async () => {
  const result = await pool.query(`
    SELECT id, title, department, event_date, description
    FROM events
    WHERE event_date >= CURRENT_DATE
    ORDER BY event_date ASC
    LIMIT 10
  `);
  return result.rows;
};

export const getTodaysCelebrations = async () => {
  const result = await pool.query(`
    SELECT 
      id,
      first_name,
      last_name,
      dob,
      joining_date,
      department,
      designation
    FROM employees
    WHERE status = 'Active'
  `);

  const today = new Date();
  const celebrations = [];

  result.rows.forEach(emp => {
    if (emp.dob) {
      const dob = new Date(emp.dob);
      if (dob.getMonth() === today.getMonth() && dob.getDate() === today.getDate()) {
        celebrations.push({
          id: emp.id,
          name: `${emp.first_name} ${emp.last_name}`,
          type: 'Birthday',
          department: emp.department,
          designation: emp.designation
        });
      }
    }

    if (emp.joining_date) {
      const joinDate = new Date(emp.joining_date);
      if (joinDate.getMonth() === today.getMonth() && 
          joinDate.getDate() === today.getDate() &&
          joinDate.getFullYear() < today.getFullYear()) {
        const years = today.getFullYear() - joinDate.getFullYear();
        celebrations.push({
          id: emp.id,
          name: `${emp.first_name} ${emp.last_name}`,
          type: 'Work Anniversary',
          years: years,
          department: emp.department,
          designation: emp.designation
        });
      }
    }
  });

  return celebrations;
};

export const getActivePolicies = async () => {
  const result = await pool.query(`
    SELECT id, name, version, file_url, updated_date, category
    FROM policies
    WHERE status = 'active'
    ORDER BY updated_date DESC
  `);
  return result.rows;
};

export const getResources = async () => {
  const result = await pool.query(`
    SELECT id, name, category, file_url, updated_date
    FROM downloads
    WHERE is_active = true
    ORDER BY category, name
  `);
  return result.rows;
};

export const getHolidays = async (companyId = null) => {
  const result = await pool.query(`
    SELECT id, name, date, type, description
      FROM holidays
     WHERE ($1::integer IS NULL OR company_id = $1 OR company_id IS NULL)
       AND date >= CURRENT_DATE
     ORDER BY date ASC
  `, [companyId]);
  return result.rows;
};

export const getAllHolidays = async (companyId = null) => {
  const result = await pool.query(`
    SELECT id, name, date, type, description
      FROM holidays
     WHERE ($1::integer IS NULL OR company_id = $1 OR company_id IS NULL)
     ORDER BY date ASC
  `, [companyId]);
  return result.rows;
};

/* ════════════════════════════════════════════════════════════════════════════
   HOME DASHBOARD — single role-aware summary (GET /api/home/summary)
   All queries are scoped by company_id (read from req.scope.company_id in the
   controller — NOT companyId). A null companyId means "global" (super admin
   with no company assignment) and disables the company filter.
════════════════════════════════════════════════════════════════════════════ */

// Best-effort helpers: never let one missing table/column break the whole page.
const safeRows = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
};
const safeVal = async (sql, params = [], fallback = 0) => {
  const rows = await safeRows(sql, params);
  const v = rows[0]?.v;
  return v == null ? fallback : v;
};

// Identity for the top bar. Name isn't carried in the JWT, so it's read from
// the users table; email/role come from req.user in the controller.
export const getUserIdentity = async (userId) => {
  const rows = await safeRows(
    `SELECT name, email FROM users WHERE id = $1 LIMIT 1`, [userId]
  );
  return rows[0] || null;
};

// Company reference documents for a category ('policy' | 'brand_assets').
// A NULL company_id row is a global default visible to every company.
export const getCompanyDocuments = async (category, companyId = null) => {
  return safeRows(
    `SELECT id, title, category, description, file_url, icon, updated_at
       FROM company_documents
      WHERE category = $1
        AND is_active = true
        AND ($2::integer IS NULL OR company_id = $2 OR company_id IS NULL)
      ORDER BY updated_at DESC, title ASC`,
    [category, companyId]
  );
};

// Today's attendance punch for one employee — powers the Home clock-in widget.
// Mirrors attendanceRepository.getTodayStatus (attendance_records is the punch
// table; the `attendance` table is the aggregate used for company rates).
const getMyAttendanceToday = async (employeeId, companyId = null) => {
  if (!employeeId) return null;
  const rows = await safeRows(
    `SELECT status,
            check_in_time  AS check_in,
            check_out_time AS check_out,
            total_hours    AS hours_worked
       FROM attendance_records
      WHERE employee_id = $1 AND attendance_date = CURRENT_DATE AND deleted_at IS NULL
        AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM employees e WHERE e.id = $1 AND e.company_id = $2))
      ORDER BY check_in_time DESC NULLS LAST
      LIMIT 1`,
    [employeeId, companyId]
  );
  return rows[0] || null;
};

// Tasks assigned to a single employee (their own open work only).
const getMyOpenTasks = async (employeeId) => {
  if (!employeeId) return [];
  return safeRows(
    `SELECT t.id, t.task_title, t.priority, t.status, t.due_date,
            p.project_name
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.assigned_to = $1
        AND t.status <> 'done'
        AND t.deleted_at IS NULL
      ORDER BY t.due_date ASC NULLS LAST, t.priority DESC
      LIMIT 12`,
    [employeeId]
  );
};

// Normalized pending-approval rows across the common source tables, company
// scoped. Each row carries requester_emp_id, requester_manager_id and
// approver_id so callers can split "awaiting my action" vs "awaiting others".
//
// NOTE: `approver_config` (the Settings → Access Control → Approver Chains
// screen) is NOT the source here and never has been. Routing is resolved
// per-row from each table's own approver_id, falling back to the requester's
// reporting manager — see getPendingApprovals below. Audited 2026-07-16 and
// deliberately left that way: this logic is live for leave/expense/probation
// approvals, while approver_config holds 3 rows that nothing reads. If you are
// here to make the configured chains take effect, that is a real change with a
// real blast radius, not a bug fix.
const pendingApprovalUnion = async (companyId) => {
  const cf = companyId != null ? `AND e.company_id = $1` : '';
  const params = companyId != null ? [companyId] : [];

  // travel_advances scopes on its own company_id rather than the employee's:
  // employee_id there holds a users.id, so the employees join can miss.
  const cfAdv = companyId != null ? `AND ta.company_id = $1` : '';

  const [leaves, expenses, purchases, regs, advances, central] = await Promise.all([
    safeRows(
      `SELECT 'leave:' || la.id::text AS id, 'Leave' AS type,
              CONCAT('Leave request from ', e.first_name) AS title,
              TRIM(CONCAT(e.first_name, ' ', COALESCE(e.last_name,''))) AS requested_by,
              e.id AS requester_emp_id, e.reporting_manager_id AS requester_manager_id,
              NULL::integer AS approver_id, la.applied_at AS request_date, NULL::numeric AS amount
         FROM leave_applications la
         LEFT JOIN employees e ON e.id::text = la.employee_id::text
        WHERE la.status = 'pending' ${cf}`, params),
    safeRows(
      `SELECT 'exp:' || ec.id::text AS id, 'Expense' AS type,
              CONCAT('Expense Claim ', ec.claim_number) AS title,
              TRIM(CONCAT(e.first_name, ' ', COALESCE(e.last_name,''))) AS requested_by,
              e.id AS requester_emp_id, e.reporting_manager_id AS requester_manager_id,
              ec.approved_by AS approver_id, ec.claim_date AS request_date, ec.total_amount AS amount
         FROM expense_claims ec
         LEFT JOIN employees e ON e.id = ec.employee_id
        WHERE LOWER(ec.status) = 'pending' ${cf}`, params),
    safeRows(
      `SELECT 'pr:' || pr.id::text AS id, 'Purchase' AS type,
              CONCAT('Purchase Request ', pr.request_number) AS title,
              TRIM(CONCAT(e.first_name, ' ', COALESCE(e.last_name,''))) AS requested_by,
              e.id AS requester_emp_id, e.reporting_manager_id AS requester_manager_id,
              pr.approved_by AS approver_id, pr.request_date AS request_date, NULL::numeric AS amount
         FROM purchase_requests pr
         LEFT JOIN employees e ON e.id = pr.requested_by_employee_id
        WHERE pr.status IN ('pending_approval','pending') ${cf}`, params),
    safeRows(
      `SELECT 'reg:' || arr.id::text AS id, 'Regularization' AS type,
              CONCAT('Attendance regularization for ', arr.date) AS title,
              TRIM(CONCAT(e.first_name, ' ', COALESCE(e.last_name,''))) AS requested_by,
              e.id AS requester_emp_id, e.reporting_manager_id AS requester_manager_id,
              arr.manager_id AS approver_id, arr.created_at AS request_date, NULL::numeric AS amount
         FROM attendance_regularization_requests arr
         LEFT JOIN employees e ON e.id::text = arr.employee_id::text
        WHERE arr.status = 'pending' ${cf}`, params),
    // Travel advances awaiting Finance or Manager. Both steps are role-gated
    // rather than assigned to a person, so approver_id stays NULL and the
    // requester's reporting manager carries the routing.
    safeRows(
      `SELECT 'adv:' || ta.id::text AS id, 'Travel Advance' AS type,
              CONCAT('Travel advance — ', COALESCE(tr.request_number, ta.purpose, 'no reference')) AS title,
              TRIM(CONCAT(e.first_name, ' ', COALESCE(e.last_name,''))) AS requested_by,
              e.id AS requester_emp_id, e.reporting_manager_id AS requester_manager_id,
              NULL::integer AS approver_id,
              COALESCE(ta.required_by, ta.created_at::date) AS request_date,
              ta.amount AS amount
         FROM travel_advances ta
         LEFT JOIN users u ON u.id = ta.employee_id
         LEFT JOIN employees e ON e.id = COALESCE(u.employee_id, ta.employee_id)
         LEFT JOIN travel_requests tr ON tr.id = ta.travel_request_id
        WHERE ta.status IN ('Pending Finance','Pending Manager') ${cfAdv}`, params),
    // Central approvals table (probation etc.) — approver is explicitly assigned.
    safeRows(
      companyId != null
        ? `SELECT 'appr:' || a.id::text AS id,
                  COALESCE(a.module_name, a.reference_type, 'Approval') AS type,
                  COALESCE(a.title, 'Approval request') AS title,
                  COALESCE(a.requester_name, a.requested_by::text) AS requested_by,
                  NULL::integer AS requester_emp_id, NULL::integer AS requester_manager_id,
                  a.approver_id AS approver_id, a.request_date AS request_date, NULL::numeric AS amount
             FROM approvals a
            WHERE a.status = 'Pending' AND a.company_id = $1`
        : `SELECT 'appr:' || a.id::text AS id,
                  COALESCE(a.module_name, a.reference_type, 'Approval') AS type,
                  COALESCE(a.title, 'Approval request') AS title,
                  COALESCE(a.requester_name, a.requested_by::text) AS requested_by,
                  NULL::integer AS requester_emp_id, NULL::integer AS requester_manager_id,
                  a.approver_id AS approver_id, a.request_date AS request_date, NULL::numeric AS amount
             FROM approvals a
            WHERE a.status = 'Pending'`,
      params),
  ]);

  return [...leaves, ...expenses, ...purchases, ...regs, ...advances, ...central]
    .sort((a, b) => new Date(a.request_date || 0) - new Date(b.request_date || 0));
};

// Employee "My pending approvals" — split into two labeled groups. Exported so
// the read-only My Requests page (approvals.controller.js getMyRequests) can
// reuse the same "awaiting my action" logic without re-deriving the query.
export const getEmployeeApprovals = async (userId, employeeId, companyId) => {
  const all = await pendingApprovalUnion(companyId);
  const empId = employeeId != null ? String(employeeId) : null;
  const uId   = userId != null ? String(userId) : null;

  // (a) Awaiting my action — I'm the assigned approver, or I'm the reporting
  //     manager of the requester (leave/expense raised by my reportees).
  const awaitingMyAction = all.filter(r =>
    (r.approver_id != null && String(r.approver_id) === uId) ||
    (empId != null && r.requester_manager_id != null && String(r.requester_manager_id) === empId)
  );

  // (b) Awaiting others — requests I raised that are still pending someone else.
  const awaitingOthers = empId == null ? [] : all.filter(r =>
    r.requester_emp_id != null && String(r.requester_emp_id) === empId
  );

  return {
    awaitingMyAction: awaitingMyAction.slice(0, 8),
    awaitingOthers:   awaitingOthers.slice(0, 8),
  };
};

// Company-wide management metrics + queues (non-employee roles).
// Drives the management hero KPIs (attendance, revenue MTD, open tasks,
// pending approvals) and the Approvals queue / Open Tasks cards.
const getManagementMetrics = async (companyId) => {
  const cf = companyId != null ? ` AND company_id = $1` : '';
  const cp = companyId != null ? [companyId] : [];
  const tf = companyId != null ? ` AND (p.company_id = $1 OR p.company_id IS NULL)` : '';

  const [revMtd, attRow, tasks, openTasksCount, queue] = await Promise.all([
    safeVal(`SELECT COALESCE(SUM(COALESCE(total_amount,amount,0)),0)::numeric AS v
               FROM invoices WHERE created_at >= DATE_TRUNC('month', NOW()) AND LOWER(status) NOT IN ('cancelled')`),
    safeRows(`SELECT COUNT(*) FILTER (WHERE status = 'present') AS present,
                     (SELECT COUNT(*) FROM employees WHERE LOWER(status) IN ('active','probation')${cf}) AS total
                FROM attendance WHERE date = CURRENT_DATE`, cp),
    safeRows(`SELECT t.id, t.task_title, t.priority, t.status, t.due_date, p.project_name
                FROM tasks t
                LEFT JOIN projects p ON p.id = t.project_id
               WHERE t.status <> 'done' AND t.deleted_at IS NULL
                 AND t.due_date IS NOT NULL
               ORDER BY t.due_date ASC NULLS LAST
               LIMIT 8`),
    safeVal(`SELECT COUNT(*)::int AS v FROM tasks t
               LEFT JOIN projects p ON p.id = t.project_id
              WHERE t.status <> 'done' AND t.deleted_at IS NULL${tf}`, cp),
    pendingApprovalUnion(companyId),
  ]);

  const present = Number(attRow?.[0]?.present || 0);
  const total   = Number(attRow?.[0]?.total || 0);
  const attRate = total > 0 ? Math.round((present / total) * 100) : 0;

  return {
    attendance: { rate: attRate, total, present },
    revenue:    { mtd: Number(revMtd) || 0 },
    pendingApprovalsCount: queue.length,
    openTasks:             tasks,
    openTasksCount:        Number(openTasksCount) || 0,
    approvalsQueue:        queue.slice(0, 8),
  };
};

// Main orchestrator. `user` = req.user (JWT), `scope` = req.scope.
export const getHomeSummary = async (user, scope) => {
  const role       = String(user?.role || '').toLowerCase();
  const userId     = user?.userId ?? user?.id ?? null;
  const employeeId = user?.employee_id ?? null;
  const companyId  = scope?.company_id ?? null;      // BUG 1: company_id, not companyId

  // Roles are many-to-many, so this can't be `role === 'employee'` — that read
  // only the primary role and would drop someone into the cut-down self-service
  // Home despite them also holding, say, project_manager.
  //
  // The rule: you get the employee-only view only if `employee` is ALL you are.
  // Hold any second role and you get the management view, because every other
  // role in the registry implies visibility beyond your own record.
  const roles = Array.isArray(user?.roles) && user.roles.length
    ? user.roles.map(r => String(r).toLowerCase())
    : [role].filter(Boolean);
  const isEmployee = roles.length > 0 && roles.every(r => r === 'employee');

  // Shared across every role. Attendance is included for any login linked to an
  // employee record — managers/HR/finance punch in from Home too, not just the
  // `employee` role. Returns null for unlinked logins (admin trio).
  const [identity, announcements, policies, brandAssets, myAttendance] = await Promise.all([
    getUserIdentity(userId),
    getActiveAnnouncements(),
    getCompanyDocuments('policy', companyId),
    getCompanyDocuments('brand_assets', companyId),
    getMyAttendanceToday(employeeId, companyId),
  ]);

  const base = {
    identity: {
      name:  identity?.name || user?.email?.split('@')[0] || 'User',
      email: user?.email || identity?.email || '',
      role,
      roles,
    },
    announcements: (announcements || []).slice(0, 6),
    policies,
    brandAssets,
    isEmployee,
    myAttendance,
  };

  if (isEmployee) {
    const [myTasks, myApprovals] = await Promise.all([
      getMyOpenTasks(employeeId),
      getEmployeeApprovals(userId, employeeId, companyId),
    ]);
    return { ...base, myTasks, myApprovals };
  }

  const management = await getManagementMetrics(companyId);
  return { ...base, management };
};
