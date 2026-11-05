import pool from "../config/db.js";
import { classifySource } from "./documentDownload.js";
import { myPendingApprovals } from "../modules/approvals/approvals.controller.js";
import { resolveViewer, visibleAnnouncements, audienceSql } from "../announcements/announcement.visibility.js";

// The signed-in user's live announcements — announcement.visibility.js is the one
// definition shared with GET /announcements/active. This used to ignore
// publish_at, from_date, archive and audience (an announcement for one employee
// reached everyone), and showed company_id NULL rows to every company.
// `viewer` = { companyId, userId, employeeId }; no company → nothing.
export const getActiveAnnouncements = async (viewer = {}) =>
  visibleAnnouncements(await resolveViewer(viewer));

// There has never been an `events` table — the company-events feed is carried by
// `announcements` (title / from_date / category / message line up 1:1 with the
// columns this used to select). Kept the original output shape so any consumer
// of /api/home/events/upcoming is unaffected.
export const getUpcomingEvents = async (viewer = {}) => {
  // Same visibility rule as the announcements feed (company, audience, not
  // archived, published), except that an announcement whose From date is still
  // ahead counts — an upcoming event is one that has not started yet. A
  // Scheduled Publish time still hides it until then.
  const v = await resolveViewer(viewer);
  if (v.companyId == null) return [];
  const result = await pool.query(`
    SELECT a.id,
           a.title,
           a.category    AS department,
           a.from_date   AS event_date,
           a.message     AS description
    FROM announcements a
    LEFT JOIN employees e ON e.id = $2::int AND e.company_id = $1::int
    WHERE a.company_id = $1::int
      AND a.deleted_at IS NULL
      AND a.is_active
      AND (a.publish_at IS NULL OR a.publish_at <= NOW())
      AND COALESCE(a.to_date, a.from_date) >= CURRENT_DATE
      AND ${audienceSql('a', 'e')}
    ORDER BY a.from_date ASC
    LIMIT 10
  `, [v.companyId, v.employeeId]);
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

// `policies` and `downloads` never existed. The real tables are `hr_policies`
// and `hr_downloads`, with `title` rather than `name` and `updated_at` rather
// than `updated_date`; neither carries the status/is_active flags these queries
// filtered on. Both endpoints therefore 500'd on every call — /home/resources is
// mounted and reachable, so the Resources panel has never loaded.
// Same audience as the Home panel: an all-employee endpoint must not list
// internal or retired policies.
export const getActivePolicies = async (companyId = null) => {
  const result = await pool.query(`
    SELECT id, title AS name, version, file_url, updated_at AS updated_date, category
    FROM hr_policies
    WHERE ($1::int IS NULL OR company_id = $1)
      AND is_active AND applicable_to = 'all'
    ORDER BY updated_at DESC
  `, [companyId]);
  return result.rows;
};

export const getResources = async (companyId = null) => {
  const result = await pool.query(`
    SELECT id, title AS name, category, file_url, updated_at AS updated_date
    FROM hr_downloads
    WHERE ($1::int IS NULL OR company_id = $1)
    ORDER BY category, title
  `, [companyId]);
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
// The catch is deliberately NOT silent — an empty panel with no log line is
// undebuggable, which is how a transient DB error (pool timeout, cold start)
// used to reach the UI as a perfectly ordinary "no documents yet".
const safeRows = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows; }
  catch (err) {
    console.error('[home.service] query failed:', err?.code || '', err?.message,
      '|', String(sql).trim().slice(0, 90));
    return [];
  }
};

// Same as safeRows but propagates the error, for queries where "empty" and
// "failed" must not look alike to the caller. getHomeSummary turns a rejection
// into a `degraded` marker so the panel offers a retry instead of claiming
// there is nothing to show.
const strictRows = async (sql, params = []) => (await pool.query(sql, params)).rows;
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

// A Home document tile never carries a Drive link: Drive files are downloaded
// through GET /home/documents/:kind/:id/download (documentDownload.js), which
// returns the file itself. `download` says how the tile behaves:
//   'file' → Download button, streamed by Pulse
//   'link' → an external page (not Drive), opened in a new tab; file_url set
//   null   → not linked to a usable file yet
const toHomeDoc = ({ source_url, ...doc }) => {
  const download = classifySource(source_url);
  return { ...doc, download, file_url: download === 'link' ? String(source_url).trim() : null };
};

// The policy rows Home may show and serve: company-wide (applicable_to='all')
// and active. Anything else — 'internal' HR/admin SOPs, the SEED placeholder
// audiences, retired policies — stays inside the HR module. Fail-closed: an
// unknown audience is not company-wide.
//
// file_url is what HR last typed; drive_url is a copy kept for Drive links.
// file_url wins so a link changed from Drive to elsewhere is not shadowed by
// the stale copy. '#' is the column's legacy default, meaning "no link".
const HOME_POLICY_WHERE = `
        ($1::integer IS NULL OR company_id = $1 OR company_id IS NULL)
    AND is_active
    AND applicable_to = 'all'`;
const POLICY_SOURCE = `COALESCE(NULLIF(BTRIM(file_url), '#'), NULLIF(BTRIM(drive_url), ''))`;

// Policies panel — one tile per policy, at its latest version. The Policies
// page records a new version as a NEW row with the same title, so without
// DISTINCT ON every superseded version was listed beside the current one.
// "Latest" = newest row already in effect; a version whose effective date is
// still ahead only shows if no earlier version is active.
export const getPolicyDocuments = async (companyId = null) => {
  const rows = await strictRows(
    `SELECT * FROM (
       SELECT DISTINCT ON (LOWER(BTRIM(title)))
              id, title, category, description, version, effective_date, updated_at,
              ${POLICY_SOURCE} AS source_url
         FROM hr_policies
        WHERE ${HOME_POLICY_WHERE}
        ORDER BY LOWER(BTRIM(title)),
                 (effective_date IS NOT NULL AND effective_date > CURRENT_DATE),
                 created_at DESC, id DESC
     ) latest
     ORDER BY LOWER(title)`,
    [companyId]
  );
  return rows.map(toHomeDoc);
};

export const findHomePolicy = async (id, companyId = null) => {
  const rows = await strictRows(
    `SELECT id, title, ${POLICY_SOURCE} AS source_url
       FROM hr_policies
      WHERE ${HOME_POLICY_WHERE} AND id = $2`,
    [companyId, id]
  );
  return rows[0] || null;
};

// Brand Vault reference documents ('brand_assets' category on company_documents,
// edited in Settings → Brand Vault). A NULL company_id row is a global default
// visible to every company. `roles` gates rows that have a non-NULL
// `visible_roles` (e.g. Letterhead Template is HR/Accounts-only) — a row with
// NULL visible_roles is visible to every role. admin/super_admin always see
// everything regardless of visible_roles.
const BRAND_WHERE = `
        category = 'brand_assets'
    AND is_active = true
    AND ($1::integer IS NULL OR company_id = $1 OR company_id IS NULL)
    AND (
      visible_roles IS NULL
      OR $2::text[] && visible_roles
      OR $2::text[] && ARRAY['admin','super_admin','superadmin']::text[]
    )`;
const roleListOf = (roles) => (Array.isArray(roles) && roles.length
  ? roles.map(r => String(r).toLowerCase())
  : null);

export const getBrandAssets = async (companyId = null, roles = null) => {
  const rows = await strictRows(
    `SELECT id, title, description, version, effective_date, icon, updated_at,
            file_url AS source_url
       FROM company_documents
      WHERE ${BRAND_WHERE}
      ORDER BY LOWER(title)`,
    [companyId, roleListOf(roles)]
  );
  return rows.map(toHomeDoc);
};

export const findBrandAsset = async (id, companyId = null, roles = null) => {
  const rows = await strictRows(
    `SELECT id, title, file_url AS source_url
       FROM company_documents
      WHERE ${BRAND_WHERE} AND id = $3`,
    [companyId, roleListOf(roles), id]
  );
  return rows[0] || null;
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

// Rows shown on Home's My Pending Approvals card; "View all" opens the rest.
export const HOME_APPROVALS_PREVIEW = 5;

// Employee "My pending approvals".
//
// awaitingMyAction IS the Approval Center's My Pending Approvals list
// (approvals.controller.js myPendingApprovals) — every module, each with its
// own decision rule, plus the review queues (intern evaluations, probation
// reviews). Home shows the first few; `awaitingMyActionTotal` is the full
// count. It used to be a second, narrower rule over five tables (requester's
// reporting manager / approver_id), so the card and "View all" disagreed.
export const getEmployeeApprovals = async (userId, employeeId, companyId, req) => {
  const [mine, all] = await Promise.all([
    myPendingApprovals(req),
    pendingApprovalUnion(companyId),
  ]);
  const empId = employeeId != null ? String(employeeId) : null;

  // Awaiting others — requests I raised that are still pending someone else
  // (feeds the hero's My Requests counter).
  const awaitingOthers = empId == null ? [] : all.filter(r =>
    r.requester_emp_id != null && String(r.requester_emp_id) === empId
  );

  return {
    awaitingMyAction: mine.slice(0, HOME_APPROVALS_PREVIEW).map(r => ({
      id: r.id, type: r.request_type, request_type: r.request_type, title: r.request_title,
      request_title: r.request_title, requested_by: r.requested_by, request_date: r.request_date,
      amount: r.amount, overdue: r.overdue,
      // Review queues open their own form; everything else opens the Approval Center.
      open: r.actions?.open ?? null,
    })),
    awaitingMyActionTotal: mine.length,
    awaitingOthers: awaitingOthers.slice(0, 8),
  };
};

// Main orchestrator. `user` = req.user (JWT), `scope` = req.scope.
// Home is identical for every role — everyone gets their own personal open
// tasks and pending approvals (no company-wide management metrics band).
export const getHomeSummary = async (user, scope, req) => {
  const role       = String(user?.role || '').toLowerCase();
  const userId     = user?.userId ?? user?.id ?? null;
  const employeeId = user?.employee_id ?? null;
  const companyId  = scope?.company_id ?? null;      // BUG 1: company_id, not companyId

  const roles = Array.isArray(user?.roles) && user.roles.length
    ? user.roles.map(r => String(r).toLowerCase())
    : [role].filter(Boolean);

  // Shared across every role. Attendance is included for any login linked to an
  // employee record — managers/HR/finance punch in from Home too, not just the
  // `employee` role. Returns null for unlinked logins (admin trio).
  // allSettled, not all: one failing slice must not 500 the whole page, but it
  // must not silently arrive as an empty list either — the failed keys ship in
  // `degraded` so the panel says "couldn't load" and offers a retry.
  const SLICES = [
    ['identity',      getUserIdentity(userId),                                  null],
    ['announcements', getActiveAnnouncements({ companyId, userId, employeeId }), []],
    ['policies',      getPolicyDocuments(companyId),                            []],
    ['brandAssets',   getBrandAssets(companyId, roles),                         []],
    ['myAttendance',  getMyAttendanceToday(employeeId, companyId),              null],
    ['myTasks',       getMyOpenTasks(employeeId),                               []],
    ['myApprovals',   getEmployeeApprovals(userId, employeeId, companyId, req),
                      { awaitingMyAction: [], awaitingMyActionTotal: 0, awaitingOthers: [] }],
  ];
  const settled  = await Promise.allSettled(SLICES.map(([, p]) => p));
  const degraded = [];
  const slice    = {};
  settled.forEach((r, i) => {
    const [key, , fallback] = SLICES[i];
    if (r.status === 'fulfilled') { slice[key] = r.value; return; }
    console.error(`[home.summary] ${key} failed:`, r.reason?.code || '', r.reason?.message || r.reason);
    degraded.push(key);
    slice[key] = fallback;
  });
  const { identity, announcements, policies, brandAssets, myAttendance, myTasks, myApprovals } = slice;

  return {
    identity: {
      name:  identity?.name || user?.email?.split('@')[0] || 'User',
      email: user?.email || identity?.email || '',
      role,
      roles,
    },
    announcements: (announcements || []).slice(0, 6),
    policies,
    brandAssets,
    myAttendance,
    myTasks,
    myApprovals,
    degraded,
  };
};
