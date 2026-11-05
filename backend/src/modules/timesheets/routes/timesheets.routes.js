import express from 'express';
import pool from '../../shared/db.js';
import timesheetRepository from '../repositories/timesheet.repository.js';
import { recalculateProjectCost } from '../../projects/services/projectCostRollup.service.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { CLOSED_PROJECT_STATUSES } from '../../projects/projectStatus.js';
import { respondError } from '../../../shared/pgErrors.js';
import { notifyWorkflowEvent } from '../../../services/WorkflowNotificationService.js';
import { requirePermission, permissionFor, rolesOf } from '../../../middlewares/auth.middleware.js';

/*
 * Access control (LEGACY_MIS_TO_PULSE_AUDIT.md, P0 Task 3). Before this, no
 * route here checked a permission: any logged-in user could read, edit, delete,
 * submit, approve or reject anyone's time, the approver was whatever the client
 * sent as `approved_by`, and the reports and summaries ignored the company.
 *
 *  - OWN records (the employee linked to the login, users.employee_id) are
 *    self-service: any logged-in user may read and log their own time. This is
 *    the existing policy — My Timesheet is offered to roles that hold no
 *    timesheets grant (menuCatalog FINANCE_SELF_SERVICE_PAGES).
 *  - OTHER people's records need the `timesheets` matrix: reading them needs
 *    approve (the reviewer grant — `view` alone is what every employee holds for
 *    their own); writing needs add/edit plus approve; deleting needs delete.
 *    Reports (utilization, weekly report, marketing entry) need approve or export.
 *  - Approve / reject need timesheets:approve, move only 'submitted' entries,
 *    never the approver's own, and only the approver's team (reporting line or
 *    project manager) unless the approver is admin / HR. The approver recorded
 *    is always the logged-in user's employee, never a value from the request.
 *  - Every query and write is limited to the caller's company (companyOf). Only
 *    a global super admin (verifyToken's isGlobal scope) crosses companies.
 *  - Billing rates and amounts are only returned to reviewers.
 *  - Roles come from the database (req.user.roles), never the token's `role`.
 */

const router = express.Router();
const cid = req => companyOf(req);
const isGlobal = req => companyOf(req) == null && req.scope?.isGlobal === true;

const COMPANY_WIDE_APPROVER_ROLES = ['admin', 'super_admin', 'superadmin', 'hr', 'hr_manager'];
const OWNER_STATUSES = ['draft', 'submitted'];

// Per route, not router.use(): this router is also mounted at /projects next
// to other routers, and must not answer for paths it does not own.
const requireTenant = (req, res, next) => {
  if (cid(req) == null && !isGlobal(req)) {
    return res.status(403).json({ error: 'No company is assigned to this login.' });
  }
  next();
};

/** What the caller may do here; computed once per request. */
async function accessOf(req) {
  if (req._timesheetAccess) return req._timesheetAccess;
  const perm = (await permissionFor(req, 'timesheets')) || {};
  const me = await employeeOf(req, pool);
  req._timesheetAccess = {
    me: me != null ? Number(me) : null,
    perm,
    reviewer: Boolean(perm.can_approve),
    reporter: Boolean(perm.can_approve || perm.can_export),
    companyWide: rolesOf(req).some(r => COMPANY_WIDE_APPROVER_ROLES.includes(r)),
  };
  return req._timesheetAccess;
}

const requireReporter = async (req, res, next) => {
  try {
    if (!(await accessOf(req)).reporter) {
      return res.status(403).json({ error: 'Forbidden', code: 'TIMESHEET_REPORT_DENIED' });
    }
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
};

const toId = v => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Rates and amounts are for reviewers only. */
function stripRates(rows, a) {
  if (a.reviewer) return rows;
  const strip = r => { if (r) { delete r.billable_amount; delete r.billing_rate; } return r; };
  return Array.isArray(rows) ? rows.map(strip) : strip(rows);
}

async function employeeInCompany(req, employeeId) {
  const { rows } = await pool.query(
    `SELECT id FROM employees WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
    [employeeId, cid(req)]
  );
  return rows.length > 0;
}

/**
 * A project time may be booked to: same company, not closed and — for a
 * non-reviewer — one the employee is allocated to. Returns an error response
 * description, or null when fine.
 */
async function projectProblem(req, a, projectId, employeeId) {
  const { rows } = await pool.query(
    `SELECT status FROM projects
      WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
    [projectId, cid(req)]
  );
  if (!rows.length) return { status: 400, error: 'Project not found in your company' };
  if (CLOSED_PROJECT_STATUSES.includes(rows[0].status)) {
    return { status: 400, error: `Cannot log time — project is ${rows[0].status}` };
  }
  if (!a.reviewer) {
    const { rows: m } = await pool.query(
      'SELECT 1 FROM project_members WHERE project_id = $1 AND employee_id = $2', [projectId, employeeId]);
    if (!m.length) return { status: 403, error: 'You are not allocated to this project' };
  }
  return null;
}

async function taskProblem(req, taskId, projectId) {
  const { rows } = await pool.query(
    `SELECT t.project_id FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = $1 AND ($2::int IS NULL OR p.company_id = $2)`,
    [taskId, cid(req)]
  );
  if (!rows.length) return { status: 400, error: 'Task not found in your company' };
  if (projectId && Number(rows[0].project_id) !== Number(projectId)) {
    return { status: 400, error: 'Task does not belong to that project' };
  }
  return null;
}

/**
 * The employee a self-service write acts for: the body's employee_id when it is
 * the caller, or someone else only for a reviewer holding `grant`.
 * Returns { target } or { status, error }.
 */
async function resolveTarget(req, a, bodyEmployeeId, grant) {
  const target = toId(bodyEmployeeId) ?? a.me;
  if (!target) return { status: 400, error: 'No employee is linked to this login' };
  if (target !== a.me) {
    if (!(a.reviewer && a.perm[grant])) return { status: 403, error: 'You can only record time for yourself' };
    if (!(await employeeInCompany(req, target))) return { status: 400, error: 'Employee not found in your company' };
  }
  return { target };
}

/** Same-company entry the caller may see, or null. */
async function visibleEntry(req, a, id) {
  const entryId = toId(id);
  if (!entryId) return null;
  const row = await timesheetRepository.findById(entryId, cid(req));
  if (!row) return null;
  if (Number(row.employee_id) !== a.me && !a.reviewer) return null;
  return row;
}

const fail = (res, p) => res.status(p.status).json({ error: p.error });

router.get('/timesheets', requireTenant, async (req, res) => {
  try {
    const a = await accessOf(req);
    const { project_id, status, start_date, end_date } = req.query;
    const filters = { company_id: cid(req), project_id, status, start_date, end_date };
    if (a.reviewer) {
      if (req.query.employee_id) filters.employee_id = req.query.employee_id;
    } else {
      if (!a.me) return res.status(403).json({ error: 'No employee is linked to this login' });
      filters.employee_id = a.me;
    }
    const timesheets = await timesheetRepository.findAll(filters);
    res.json(stripRates(timesheets, a));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// My Timesheet — projects assigned to this employee + their entries for the week
router.get('/timesheets/my-timesheet', requireTenant, async (req, res) => {
  try {
    const a = await accessOf(req);
    const eid = a.me;
    const company_id = cid(req);
    const { week_start, week_end } = req.query;
    if (!eid) return res.json({ projects: [], entries: [] });

    // project_team_members was legacy/dropped — the live team-assignment table
    // is project_members (role_in_project, no deleted_at column). This query
    // always threw before, so My Timesheet permanently showed "no project
    // assignments" regardless of actual allocation.
    const projResult = await pool.query(
      `SELECT DISTINCT p.id, p.project_code, p.project_name, p.status,
          pm.role_in_project AS member_role, pm.billing_rate
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       WHERE pm.employee_id = $1
         AND p.status = 'active'
         AND ($2::int IS NULL OR p.company_id = $2)
       ORDER BY p.project_name`,
      [eid, company_id]
    ).catch(() => ({ rows: [] }));

    let entries = [];
    if (week_start && week_end) {
      entries = await timesheetRepository.findAll({
        employee_id: eid,
        start_date: week_start,
        end_date: week_end,
        company_id,
      }).catch(() => []);
    }

    res.json({ projects: stripRates(projResult.rows, a), entries: stripRates(entries, a) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// All Timesheets — reviewers see the company; everyone else their own.
router.get('/timesheets/all', requireTenant, async (req, res) => {
  try {
    const a = await accessOf(req);
    const { start_date, end_date, status, employee_id: qEid } = req.query;

    const filters = { company_id: cid(req), start_date, end_date };
    if (status) filters.status = status;

    if (a.reviewer) {
      if (qEid) filters.employee_id = qEid;
    } else {
      if (!a.me) return res.status(403).json({ error: 'No employee is linked to this login' });
      filters.employee_id = a.me;
    }

    const entries = await timesheetRepository.findAll(filters);
    res.json(stripRates(entries, a));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approvals — submitted entries: the whole company for admin/HR, the
// approver's team (reporting line or project manager) for everyone else.
router.get('/timesheets/approvals', requireTenant, requirePermission('timesheets', 'approve'), async (req, res) => {
  try {
    const a = await accessOf(req);
    const company_id = cid(req);

    if (!a.companyWide) {
      if (!a.me) return res.json([]);
      const { rows } = await pool.query(
        `SELECT te.*,
            e.first_name || ' ' || COALESCE(e.last_name,'') AS employee_name,
            e.department,
            p.project_name
         FROM timesheet_entries te
         JOIN employees e ON te.employee_id = e.id
         LEFT JOIN projects p ON te.project_id = p.id
         WHERE te.status = 'submitted'
           AND te.deleted_at IS NULL
           AND te.employee_id <> $1
           AND (p.project_manager_id = $1 OR e.reporting_manager_id = $1)
           AND ($2::int IS NULL OR te.company_id = $2)
         ORDER BY te.submitted_at ASC`,
        [a.me, company_id]
      ).catch(() => ({ rows: [] }));
      return res.json(rows);
    }

    const entries = await timesheetRepository.findAll({ company_id, status: 'submitted' });
    res.json(entries);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Shared by /weekly-summary and /summary/weekly. */
async function weeklySummary(req, res) {
  try {
    const a = await accessOf(req);
    const { week_start, week_end } = req.query;
    const target = toId(req.query.employee_id) ?? a.me;
    if (!target) return res.status(400).json({ error: 'employee_id is required' });
    if (target !== a.me && !a.reviewer) return res.status(403).json({ error: 'Forbidden' });
    if (!(await employeeInCompany(req, target))) return res.status(404).json({ error: 'Employee not found' });
    const summary = await timesheetRepository.getWeeklySummary(target, week_start, week_end, cid(req));
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

router.get('/timesheets/weekly-summary', requireTenant, weeklySummary);

// Weekly production report — the same company-scoped report as the bare
// /weekly-report below. This copy used to read every company's entries and
// build its "missing" list from all of them.
router.get('/timesheets/weekly-report', requireTenant, requireReporter, (req, res) => weeklyReport(req, res));

router.get('/timesheets/:id', requireTenant, async (req, res) => {
  try {
    const a = await accessOf(req);
    const timesheet = await visibleEntry(req, a, req.params.id);
    if (!timesheet) return res.status(404).json({ error: 'Timesheet not found' });
    res.json(stripRates(timesheet, a));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/timesheets', requireTenant, async (req, res) => {
  try {
    const a = await accessOf(req);
    const t = await resolveTarget(req, a, req.body.employee_id, 'can_add');
    if (t.error) return fail(res, t);

    const { project_id, task_id, work_date, hours_worked, description, is_billable, status } = req.body;
    const projectId = toId(project_id);
    if (projectId) {
      const p = await projectProblem(req, a, projectId, t.target);
      if (p) return fail(res, p);
    }
    const taskId = toId(task_id);
    if (taskId) {
      const p = await taskProblem(req, taskId, projectId);
      if (p) return fail(res, p);
    }

    // A new entry is a draft or goes straight to review — never approved or
    // rejected on creation; approval fields are not accepted at all.
    const timesheet = await timesheetRepository.create({
      employee_id: t.target,
      project_id: projectId,
      task_id: taskId,
      work_date,
      hours_worked,
      description,
      is_billable,
      status: OWNER_STATUSES.includes(status) ? status : 'draft',
      company_id: cid(req),
    });
    res.status(201).json(stripRates(timesheet, a));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const EDITABLE_FIELDS = ['work_date', 'hours_worked', 'description', 'is_billable', 'project_id', 'task_id', 'status'];

router.put('/timesheets/:id', requireTenant, async (req, res) => {
  try {
    const a = await accessOf(req);
    const current = await visibleEntry(req, a, req.params.id);
    const isOwner = current && Number(current.employee_id) === a.me;
    if (!current || (!isOwner && !(a.reviewer && a.perm.can_edit))) {
      return res.status(404).json({ error: 'Timesheet not found' });
    }
    if (current.status === 'approved') {
      return res.status(409).json({ error: 'An approved timesheet entry cannot be changed' });
    }

    const changes = {};
    for (const k of EDITABLE_FIELDS) if (req.body[k] !== undefined) changes[k] = req.body[k];
    if (changes.status !== undefined) {
      if (!OWNER_STATUSES.includes(changes.status)) {
        return res.status(400).json({ error: 'Status can only be set to draft or submitted here; use approve/reject' });
      }
      if (changes.status === 'submitted' && current.status !== 'submitted') changes.submitted_at = new Date();
    }
    if (changes.work_date !== undefined) changes.entry_date = changes.work_date;
    if (changes.project_id !== undefined && changes.project_id !== null) {
      const p = await projectProblem(req, a, toId(changes.project_id), current.employee_id);
      if (p) return fail(res, p);
    }
    if (changes.task_id !== undefined && changes.task_id !== null) {
      const p = await taskProblem(req, toId(changes.task_id), changes.project_id ?? current.project_id);
      if (p) return fail(res, p);
    }

    const timesheet = await timesheetRepository.update(current.id, changes, cid(req));
    if (!timesheet) return res.status(404).json({ error: 'Timesheet not found' });
    res.json(stripRates(timesheet, a));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/timesheets/:id', requireTenant, async (req, res) => {
  try {
    const a = await accessOf(req);
    const current = await visibleEntry(req, a, req.params.id);
    if (!current) return res.status(404).json({ error: 'Timesheet not found' });
    const isOwner = Number(current.employee_id) === a.me;
    // An owner may withdraw their own unreviewed work; anything else needs the
    // delete grant.
    const ownerMay = isOwner && ['draft', 'rejected'].includes(current.status);
    if (!ownerMay && !a.perm.can_delete) {
      return res.status(403).json({ error: 'You cannot delete this timesheet entry' });
    }
    const removed = await timesheetRepository.delete(current.id, cid(req));
    if (!removed) return res.status(404).json({ error: 'Timesheet not found' });
    res.json({ message: 'Timesheet deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/timesheets/submit-week', requireTenant, async (req, res) => {
  try {
    const a = await accessOf(req);
    const t = await resolveTarget(req, a, req.body.employee_id, 'can_edit');
    if (t.error) return fail(res, t);
    const { week_start, week_end } = req.body;
    const submitted = await timesheetRepository.submitWeek(t.target, week_start, week_end, cid(req));
    res.json({ message: 'Week submitted for approval', submitted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clock-in — record timestamp, return server-confirmed time. Own only.
router.post('/timesheets/clock-in', requireTenant, async (req, res) => {
  try {
    const a = await accessOf(req);
    const eid = toId(req.body.employee_id) ?? a.me;
    if (!a.me) return res.status(400).json({ error: 'No employee is linked to this login' });
    if (eid !== a.me) return res.status(403).json({ error: 'You can only clock in yourself' });
    const clocked_in_at = req.body.timestamp || new Date().toISOString();
    res.json({ ok: true, clocked_in_at, employee_id: eid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clock-out — compute elapsed hours, create a draft entry for today. Own only.
router.post('/timesheets/clock-out', requireTenant, async (req, res) => {
  try {
    const a = await accessOf(req);
    const company_id = cid(req);
    const eid = toId(req.body.employee_id) ?? a.me;
    if (!a.me) return res.status(400).json({ error: 'No employee is linked to this login' });
    if (eid !== a.me) return res.status(403).json({ error: 'You can only clock out yourself' });
    const clocked_out_at = req.body.timestamp || new Date().toISOString();
    const { clock_in_timestamp } = req.body;
    const projectId = toId(req.body.project_id);
    if (projectId) {
      const p = await projectProblem(req, a, projectId, eid);
      if (p) return fail(res, p);
    }

    let hours_worked = 0;
    if (clock_in_timestamp) {
      const diff = (new Date(clocked_out_at) - new Date(clock_in_timestamp)) / 3600000;
      hours_worked = Math.max(0, Math.round(diff * 4) / 4); // nearest 0.25h
    }

    let entry = null;
    if (hours_worked > 0) {
      const today = new Date().toISOString().split('T')[0];
      entry = await timesheetRepository.create({
        employee_id: eid,
        project_id: projectId,
        task_id: null,
        work_date: today,
        hours_worked,
        description: 'Clock-in / clock-out entry',
        is_billable: true,
        status: 'draft',
        company_id,
      });
    }

    res.json({ ok: true, hours_worked, clocked_out_at, entry: entry && stripRates(entry, a) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * The entries an approve/reject request may act on, or an error. All-or-
 * nothing: one entry outside the caller's company, their own, outside their
 * team, or not 'submitted' refuses the whole request.
 */
async function reviewTargets(req, a) {
  const raw = Array.isArray(req.body.ids) ? req.body.ids
    : (req.body.timesheet_id != null ? [req.body.timesheet_id] : []);
  const ids = [...new Set(raw.map(toId))];
  if (!ids.length || ids.includes(null)) return { status: 400, error: 'ids must be a non-empty list of timesheet ids' };

  const { rows } = await pool.query(
    `SELECT te.id, te.employee_id, te.status, te.hours_worked, te.project_id,
            e.reporting_manager_id, p.project_manager_id, p.project_name
       FROM timesheet_entries te
       LEFT JOIN employees e ON e.id = te.employee_id
       LEFT JOIN projects  p ON p.id = te.project_id
      WHERE te.id = ANY($1::int[]) AND te.deleted_at IS NULL
        AND ($2::int IS NULL OR te.company_id = $2)`,
    [ids, cid(req)]
  );
  if (rows.length !== ids.length) return { status: 404, error: 'Timesheet not found' };
  if (a.me != null && rows.some(r => Number(r.employee_id) === a.me)) {
    return { status: 403, error: 'You cannot approve or reject your own timesheet', code: 'SELF_APPROVAL' };
  }
  if (!a.companyWide) {
    const outside = rows.filter(r => !(a.me != null
      && (Number(r.reporting_manager_id) === a.me || Number(r.project_manager_id) === a.me)));
    if (outside.length) return { status: 403, error: 'You can only review timesheets of your team' };
  }
  if (rows.some(r => r.status !== 'submitted')) {
    return { status: 409, error: 'Only submitted timesheets can be approved or rejected' };
  }
  return { ids, rows };
}

router.post('/timesheets/approve', requireTenant, requirePermission('timesheets', 'approve'), async (req, res) => {
  try {
    const a = await accessOf(req);
    const t = await reviewTargets(req, a);
    if (t.error) return res.status(t.status).json({ error: t.error, ...(t.code ? { code: t.code } : {}) });

    // The approver is the logged-in user's employee — never body.approved_by.
    const approved = await timesheetRepository.approveEntries(t.ids, a.me, cid(req));
    if (!approved.length) return res.status(409).json({ error: 'No approvable timesheets found' });
    const approvedIds = new Set(approved.map(r => r.id));

    t.rows.filter(r => approvedIds.has(r.id)).forEach(r => {
      if (!r.employee_id) return;
      notifyWorkflowEvent('approved', {
        module: 'Timesheet',
        recordId: r.id,
        recipientIds: [r.employee_id],
        context: { projectName: r.project_name, hours: r.hours_worked },
      });
    });

    // Recalculate full project cost (all 9 sources), not just labour — updateLabourCost()
    // used to overwrite total_cost/profit/margin_pct unconditionally from labour_cost alone,
    // silently collapsing the correct multi-source rollup on every approval.
    //
    // Only the projects this approval actually touched. This used to re-read
    // EVERY approved entry in the database and recalculate EVERY project in it
    // — unscoped, so approving one timesheet rewrote other tenants' cost rows,
    // and the work grew with the whole table rather than the request.
    const projectIds = [...new Set(approved.map(r => r.project_id).filter(Boolean))];
    for (const projectId of projectIds) {
      await recalculateProjectCost(projectId);
    }

    res.json({ message: 'Timesheets approved', approved: approved.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/timesheets/reject', requireTenant, requirePermission('timesheets', 'approve'), async (req, res) => {
  try {
    const a = await accessOf(req);
    const { reason } = req.body;
    const t = await reviewTargets(req, a);
    if (t.error) return res.status(t.status).json({ error: t.error, ...(t.code ? { code: t.code } : {}) });

    const rejected = await timesheetRepository.rejectEntries(t.ids, a.me, reason, cid(req));
    if (!rejected.length) return res.status(409).json({ error: 'No rejectable timesheets found' });
    const rejectedIds = new Set(rejected.map(r => r.id));

    t.rows.filter(r => rejectedIds.has(r.id)).forEach(r => {
      if (!r.employee_id) return;
      notifyWorkflowEvent('rejected', {
        module: 'Timesheet',
        recordId: r.id,
        recipientIds: [r.employee_id],
        context: { projectName: r.project_name },
        comments: reason,
      });
    });

    res.json({ message: 'Timesheets rejected' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timesheets/summary/weekly', requireTenant, weeklySummary);

router.get('/timesheets/utilization/:employee_id', requireTenant, async (req, res) => {
  try {
    const a = await accessOf(req);
    const target = toId(req.params.employee_id);
    if (!target) return res.status(400).json({ error: 'Invalid employee id' });
    if (target !== a.me && !a.reviewer) return res.status(403).json({ error: 'Forbidden' });
    if (!(await employeeInCompany(req, target))) return res.status(404).json({ error: 'Employee not found' });
    const { start_date, end_date } = req.query;
    const utilization = await timesheetRepository.getUtilization(target, start_date, end_date, cid(req));
    res.json(utilization);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timesheets/pending-approvals/:manager_id', requireTenant, requirePermission('timesheets', 'approve'), async (req, res) => {
  try {
    const a = await accessOf(req);
    const managerId = toId(req.params.manager_id);
    if (!managerId) return res.status(400).json({ error: 'Invalid manager id' });
    if (managerId !== a.me && !a.companyWide) return res.status(403).json({ error: 'Forbidden' });
    const pending = await timesheetRepository.getPendingApprovals(managerId, cid(req));
    res.json(pending);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/utilization', requireTenant, requireReporter, async (req, res) => {
  try {
    const { period = 'month' } = req.query;
    const company_id = cid(req);

    const now = new Date();
    const end_date = now.toISOString().split('T')[0];
    let start_date;
    if (period === 'week') {
      const d = new Date(now); d.setDate(d.getDate() - 7);
      start_date = d.toISOString().split('T')[0];
    } else if (period === 'quarter') {
      const d = new Date(now); d.setMonth(d.getMonth() - 3);
      start_date = d.toISOString().split('T')[0];
    } else {
      const d = new Date(now); d.setMonth(d.getMonth() - 1);
      start_date = d.toISOString().split('T')[0];
    }

    const { rows } = await pool.query(
      `SELECT e.id,
              TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')) AS name,
              COALESCE(SUM(te.hours_worked), 0)::float  AS logged_hours,
              160                                        AS total_hours,
              ROUND(COALESCE(SUM(te.hours_worked),0)::numeric / 160 * 100, 1)::float AS utilization_pct
       FROM employees e
       LEFT JOIN timesheet_entries te
         ON te.employee_id = e.id
         AND te.work_date BETWEEN $2 AND $3
         AND te.deleted_at IS NULL
       WHERE ($1::int IS NULL OR e.company_id = $1)
         -- Employees are stored 'Active' / 'Probation' / 'Notice'; the old
         -- case-sensitive IN matched none of them, so the report left out every
         -- real employee (a lowercase test fixture hid it). Same three states.
         AND LOWER(e.status) IN ('active','probation','notice')
       GROUP BY e.id, e.first_name, e.last_name
       ORDER BY utilization_pct DESC`,
      [company_id ?? null, start_date, end_date]
    ).catch(() => ({ rows: [] }));

    res.json(rows.map(r => ({
      name:            r.name || `Employee ${r.id}`,
      logged_hours:    parseFloat(r.logged_hours)    || 0,
      total_hours:     parseFloat(r.total_hours)     || 160,
      utilization_pct: parseFloat(r.utilization_pct) || 0,
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Weekly production report (mounted at /api/timesheets/weekly-report and
// /timesheets/weekly-report) — company-scoped ──
async function weeklyReport(req, res) {
  try {
    const { week_start } = req.query;
    const company_id = cid(req);
    if (!week_start) return res.status(422).json({ error: 'week_start is required (YYYY-MM-DD)' });

    const weekEnd = new Date(week_start);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const week_end = weekEnd.toISOString().split('T')[0];

    const empRows = await timesheetRepository.findAll({
      start_date: week_start,
      end_date:   week_end,
      ...(company_id ? { company_id } : {}),
    });

    const byEmp = {};
    for (const row of empRows) {
      const id = row.employee_id;
      if (!byEmp[id]) {
        byEmp[id] = {
          id,
          name:      row.employee_name || `Employee ${id}`,
          dept:      row.department    || '—',
          mon: 0, tue: 0, wed: 0, thu: 0, fri: 0,
          total: 0, billable: 0,
          submitted: null,
          status: 'Pending',
        };
      }
      const e   = byEmp[id];
      const dow = new Date(row.work_date).getDay();
      const hrs = parseFloat(row.hours_worked) || 0;
      if      (dow === 1) e.mon += hrs;
      else if (dow === 2) e.tue += hrs;
      else if (dow === 3) e.wed += hrs;
      else if (dow === 4) e.thu += hrs;
      else if (dow === 5) e.fri += hrs;
      e.total   += hrs;
      if (row.is_billable) e.billable += hrs;
      if (row.submitted_at && (!e.submitted || row.submitted_at > e.submitted)) {
        e.submitted = row.submitted_at?.toISOString?.()?.split('T')[0] ?? row.submitted_at;
      }
      if      (row.status === 'approved') e.status = 'Approved';
      else if (row.status === 'rejected') e.status = 'Rejected';
    }

    const employees = Object.values(byEmp).map(e => ({
      ...e,
      mon: +e.mon.toFixed(1), tue: +e.tue.toFixed(1), wed: +e.wed.toFixed(1),
      thu: +e.thu.toFixed(1), fri: +e.fri.toFixed(1),
      total: +e.total.toFixed(1), billable: +e.billable.toFixed(1),
    }));

    // Query employees table directly for missing-submission list
    const submittedIds = [...new Set(Object.keys(byEmp).map(Number))];
    const { rows: missingRows } = await pool.query(
      `SELECT id,
              TRIM(first_name || ' ' || COALESCE(last_name,'')) AS name,
              department
       FROM employees
       WHERE ($1::int IS NULL OR company_id = $1)
         AND status IN ('active','probation','notice')
         AND id != ALL($2::int[])`,
      [company_id ?? null, submittedIds.length ? submittedIds : [0]]
    ).catch(() => ({ rows: [] }));

    const missing = missingRows.map(r => ({
      name: r.name || `Employee ${r.id}`,
      dept: r.department || '—',
      due:  week_end,
    }));

    // Project distribution
    const byProject = {};
    for (const r of empRows) {
      if (!r.project_name) continue;
      byProject[r.project_name] = (byProject[r.project_name] || 0) + (parseFloat(r.hours_worked) || 0);
    }
    const totalProjectHrs = Object.values(byProject).reduce((s, v) => s + v, 0);
    const project_distribution = Object.entries(byProject)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({
        name,
        value: +value.toFixed(1),
        pct:   totalProjectHrs > 0 ? +(value / totalProjectHrs * 100).toFixed(1) : 0,
      }));

    // Daily hours by department (Mon–Fri)
    const DAYS       = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const byDept     = {};
    for (const e of employees) {
      const dept = e.dept || 'Other';
      if (!byDept[dept]) byDept[dept] = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0 };
      for (const d of DAYS) byDept[dept][d] += e[d];
    }
    const daily_by_dept = DAY_LABELS.map((label, i) => ({
      day: label,
      ...Object.fromEntries(
        Object.entries(byDept).map(([dept, v]) => [dept, +v[DAYS[i]].toFixed(1)])
      ),
    }));

    res.json({ employees, missing, project_distribution, daily_by_dept });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

router.get('/weekly-report', requireTenant, requireReporter, (req, res) => weeklyReport(req, res));

// ── Marketing-facing timesheet views ─────────────────────────────────────────
// tasks has no company_id: a task belongs to the company of its project, or of
// its assignee when it has no project.
router.get('/assign-tasks', requireTenant, requirePermission('timesheets', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.task_title AS title, t.status, t.priority, t.due_date,
              e.first_name || ' ' || COALESCE(e.last_name,'') AS assigned_to,
              p.project_name
       FROM tasks t
       LEFT JOIN employees e ON e.id = t.assigned_to
       LEFT JOIN projects p  ON p.id = t.project_id AND p.deleted_at IS NULL
       WHERE t.deleted_at IS NULL
         AND (LOWER(e.department) LIKE '%marketing%'
              OR LOWER(p.project_name) LIKE '%marketing%')
         AND ($1::int IS NULL
              OR (t.project_id IS NOT NULL AND p.company_id = $1)
              OR (t.project_id IS NULL AND e.company_id = $1))
       ORDER BY t.due_date NULLS LAST LIMIT 200`,
      [cid(req)]
    );
    res.json(rows);
  } catch (e) { respondError(res, e); }
});

// Other people's timesheets — a report.
router.get('/marketing-entry', requireTenant, requireReporter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      // A timesheet is per employee per week and carries no project_id; the
      // project lives on its entries. The projects listed here are therefore the
      // distinct projects the week's entries were booked against.
      `SELECT ts.id, ts.week_start AS week_start_date, ts.total_hours, ts.status,
              e.first_name || ' ' || COALESCE(e.last_name,'') AS employee_name,
              (SELECT STRING_AGG(DISTINCT p.project_name, ', ')
                 FROM timesheet_entries te
                 JOIN projects p ON p.id = te.project_id AND p.deleted_at IS NULL
                WHERE te.timesheet_id = ts.id) AS project_name
       FROM timesheets ts
       LEFT JOIN employees e ON e.id = ts.employee_id
       WHERE ($1::int IS NULL OR ts.company_id = $1)
         AND (LOWER(e.department) LIKE '%marketing%'
              OR EXISTS (SELECT 1 FROM timesheet_entries te
                           JOIN projects p ON p.id = te.project_id
                          WHERE te.timesheet_id = ts.id
                            AND LOWER(p.project_name) LIKE '%marketing%'))
       ORDER BY ts.week_start DESC LIMIT 200`,
      [cid(req)]
    );
    res.json(rows);
  } catch (e) { respondError(res, e); }
});

export default router;
