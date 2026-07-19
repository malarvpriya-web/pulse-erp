import express from 'express';
import pool from '../../shared/db.js';
import timesheetRepository from '../repositories/timesheet.repository.js';
import projectCostRepository from '../../projects/repositories/projectCost.repository.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => req.scope?.company_id ?? companyOf(req);
const uid = req => req.user?.employee_id ?? req.user?.userId ?? req.user?.id ?? null;

router.get('/timesheets', async (req, res) => {
  try {
    const timesheets = await timesheetRepository.findAll({ ...req.query, company_id: cid(req) });
    res.json(timesheets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// My Timesheet — projects assigned to this employee + their entries for the week
router.get('/timesheets/my-timesheet', async (req, res) => {
  try {
    const eid = uid(req);
    const company_id = cid(req);
    const { week_start, week_end } = req.query;

    const projResult = await pool.query(
      `SELECT DISTINCT p.id, p.project_code, p.project_name, p.status,
          ptm.role AS member_role, ptm.billing_rate
       FROM project_team_members ptm
       JOIN projects p ON p.id = ptm.project_id
       WHERE ptm.employee_id = $1
         AND ptm.deleted_at IS NULL
         AND p.status = 'active'
       ORDER BY p.project_name`,
      [eid]
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

    res.json({ projects: projResult.rows, entries });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// All Timesheets — role-scoped: admin/manager/hr see all company entries; employee sees own
router.get('/timesheets/all', async (req, res) => {
  try {
    const company_id = cid(req);
    const role = req.user?.role ?? '';
    const { start_date, end_date, status, employee_id: qEid } = req.query;

    const filters = { company_id, start_date, end_date };
    if (status) filters.status = status;

    const isPrivileged = ['admin', 'super_admin', 'manager', 'hr', 'HR Manager',
                          'Finance Manager', 'Project Manager'].includes(role);
    if (!isPrivileged) {
      filters.employee_id = qEid || uid(req);
    } else if (qEid) {
      filters.employee_id = qEid;
    }

    const entries = await timesheetRepository.findAll(filters);
    res.json(entries);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approvals — submitted timesheets scoped by manager or company admin
router.get('/timesheets/approvals', async (req, res) => {
  try {
    const company_id = cid(req);
    const role = req.user?.role ?? '';
    const filters = { company_id, status: 'submitted' };

    const isAdmin = ['admin', 'super_admin', 'hr', 'HR Manager'].includes(role);
    if (!isAdmin) {
      // For managers: only entries where manager_id matches this user's employee record
      const managerEid = uid(req);
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
           AND (p.project_manager_id = $1 OR e.manager_id = $1)
           ${company_id ? 'AND te.company_id = $2' : ''}
         ORDER BY te.submitted_at ASC`,
        company_id ? [managerEid, company_id] : [managerEid]
      ).catch(() => ({ rows: [] }));
      return res.json(rows);
    }

    const entries = await timesheetRepository.findAll(filters);
    res.json(entries);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timesheets/weekly-summary', async (req, res) => {
  try {
    const { employee_id, week_start, week_end } = req.query;
    const summary = await timesheetRepository.getWeeklySummary(employee_id, week_start, week_end);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timesheets/:id', async (req, res) => {
  try {
    const timesheet = await timesheetRepository.findById(req.params.id);
    if (!timesheet) return res.status(404).json({ error: 'Timesheet not found' });
    res.json(timesheet);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/timesheets', async (req, res) => {
  try {
    const timesheet = await timesheetRepository.create({ ...req.body, company_id: cid(req) });
    res.status(201).json(timesheet);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/timesheets/:id', async (req, res) => {
  try {
    const timesheet = await timesheetRepository.update(req.params.id, req.body);
    res.json(timesheet);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/timesheets/:id', async (req, res) => {
  try {
    await timesheetRepository.delete(req.params.id);
    res.json({ message: 'Timesheet deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/timesheets/submit-week', async (req, res) => {
  try {
    const { employee_id, week_start, week_end } = req.body;
    await timesheetRepository.submitWeek(employee_id, week_start, week_end);
    res.json({ message: 'Week submitted for approval' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clock-in — record timestamp, return server-confirmed time
router.post('/timesheets/clock-in', async (req, res) => {
  try {
    const eid = req.body.employee_id || uid(req);
    const clocked_in_at = req.body.timestamp || new Date().toISOString();
    res.json({ ok: true, clocked_in_at, employee_id: eid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clock-out — compute elapsed hours, create a draft entry for today
router.post('/timesheets/clock-out', async (req, res) => {
  try {
    const company_id = cid(req);
    const eid = req.body.employee_id || uid(req);
    const clocked_out_at = req.body.timestamp || new Date().toISOString();
    const { clock_in_timestamp, project_id } = req.body;

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
        project_id: project_id || null,
        task_id: null,
        work_date: today,
        hours_worked,
        description: 'Clock-in / clock-out entry',
        is_billable: true,
        status: 'draft',
        company_id,
      });
    }

    res.json({ ok: true, hours_worked, clocked_out_at, entry });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/timesheets/approve', async (req, res) => {
  try {
    const { ids, approved_by } = req.body;
    await timesheetRepository.approveEntries(ids, approved_by);
    
    // Update project labour costs
    const entries = await timesheetRepository.findAll({ status: 'approved' });
    const projectIds = [...new Set(entries.map(e => e.project_id))];
    for (const projectId of projectIds) {
      await projectCostRepository.updateLabourCost(projectId);
    }
    
    res.json({ message: 'Timesheets approved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/timesheets/reject', async (req, res) => {
  try {
    const { ids, approved_by, reason } = req.body;
    await timesheetRepository.rejectEntries(ids, approved_by, reason);
    res.json({ message: 'Timesheets rejected' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timesheets/summary/weekly', async (req, res) => {
  try {
    const { employee_id, week_start, week_end } = req.query;
    const summary = await timesheetRepository.getWeeklySummary(employee_id, week_start, week_end);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timesheets/utilization/:employee_id', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const utilization = await timesheetRepository.getUtilization(req.params.employee_id, start_date, end_date);
    res.json(utilization);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timesheets/pending-approvals/:manager_id', async (req, res) => {
  try {
    const pending = await timesheetRepository.getPendingApprovals(req.params.manager_id);
    res.json(pending);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Weekly production report — aggregates all employees' hours for a given week
router.get('/timesheets/weekly-report', async (req, res) => {
  try {
    const { week_start } = req.query;
    if (!week_start) return res.status(422).json({ error: 'week_start is required (YYYY-MM-DD)' });

    const weekEnd = new Date(week_start);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const week_end = weekEnd.toISOString().split('T')[0];

    // Per-employee daily breakdown
    const empRows = await timesheetRepository.findAll({ start_date: week_start, end_date: week_end });

    // Aggregate by employee
    const byEmp = {};
    for (const row of empRows) {
      const id = row.employee_id;
      if (!byEmp[id]) {
        byEmp[id] = {
          id,
          name: row.employee_name || `Employee ${id}`,
          dept: row.department || '—',
          mon: 0, tue: 0, wed: 0, thu: 0, fri: 0,
          total: 0, billable: 0,
          submitted: null,
          status: 'Pending',
        };
      }
      const e = byEmp[id];
      const dow = new Date(row.work_date).getDay(); // 0=Sun,1=Mon...
      const hrs = parseFloat(row.hours_worked) || 0;
      if (dow === 1) e.mon += hrs;
      else if (dow === 2) e.tue += hrs;
      else if (dow === 3) e.wed += hrs;
      else if (dow === 4) e.thu += hrs;
      else if (dow === 5) e.fri += hrs;
      e.total += hrs;
      if (row.is_billable) e.billable += hrs;
      if (row.submitted_at && (!e.submitted || row.submitted_at > e.submitted)) e.submitted = row.submitted_at?.toISOString?.()?.split('T')[0] ?? row.submitted_at;
      if (row.status === 'approved') e.status = 'Approved';
      else if (row.status === 'rejected') e.status = 'Rejected';
    }

    const employees = Object.values(byEmp).map(e => ({
      ...e,
      mon: +e.mon.toFixed(1), tue: +e.tue.toFixed(1), wed: +e.wed.toFixed(1),
      thu: +e.thu.toFixed(1), fri: +e.fri.toFixed(1),
      total: +e.total.toFixed(1), billable: +e.billable.toFixed(1),
    }));

    // Employees who have no entries this week (missing submissions)
    const allEmpsResult = await timesheetRepository.findAll({});
    const submittedIds = new Set(Object.keys(byEmp).map(Number));
    const missingMap = {};
    for (const row of allEmpsResult) {
      const id = row.employee_id;
      if (!submittedIds.has(id) && !missingMap[id]) {
        missingMap[id] = {
          name: row.employee_name || `Employee ${id}`,
          dept: row.department || '—',
          due: week_end,
        };
      }
    }
    const missing = Object.values(missingMap);

    // Project distribution (hours by project for this week)
    const projRows = empRows.filter(r => r.project_name);
    const byProject = {};
    for (const r of projRows) {
      const name = r.project_name;
      byProject[name] = (byProject[name] || 0) + (parseFloat(r.hours_worked) || 0);
    }
    const totalProjectHrs = Object.values(byProject).reduce((s, v) => s + v, 0);
    const project_distribution = Object.entries(byProject)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({
        name,
        value: +value.toFixed(1),
        pct: totalProjectHrs > 0 ? +(value / totalProjectHrs * 100).toFixed(1) : 0,
      }));

    // Daily hours by department (Mon–Fri)
    const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const byDept = {};
    for (const e of employees) {
      const dept = e.dept || 'Other';
      if (!byDept[dept]) byDept[dept] = { day: dept, mon: 0, tue: 0, wed: 0, thu: 0, fri: 0 };
      for (const d of DAYS) byDept[dept][d] += e[d];
    }
    const daily_by_dept = [
      { day: 'Mon', ...Object.fromEntries(Object.entries(byDept).map(([dept, v]) => [dept, +v.mon.toFixed(1)])) },
      { day: 'Tue', ...Object.fromEntries(Object.entries(byDept).map(([dept, v]) => [dept, +v.tue.toFixed(1)])) },
      { day: 'Wed', ...Object.fromEntries(Object.entries(byDept).map(([dept, v]) => [dept, +v.wed.toFixed(1)])) },
      { day: 'Thu', ...Object.fromEntries(Object.entries(byDept).map(([dept, v]) => [dept, +v.thu.toFixed(1)])) },
      { day: 'Fri', ...Object.fromEntries(Object.entries(byDept).map(([dept, v]) => [dept, +v.fri.toFixed(1)])) },
    ];

    res.json({ employees, missing, project_distribution, daily_by_dept });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Company-wide utilization (bare path — mounted at /api/timesheets/utilization) ──
router.get('/utilization', async (req, res) => {
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
         AND e.status IN ('active','probation','notice')
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

// ── Weekly production report (bare path — mounted at /api/timesheets/weekly-report) ──
router.get('/weekly-report', async (req, res) => {
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
});

// ── Marketing-facing timesheet views ─────────────────────────────────────────
router.get('/assign-tasks', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.title, t.status, t.priority, t.due_date,
              e.first_name || ' ' || COALESCE(e.last_name,'') AS assigned_to,
              p.name AS project_name
       FROM tasks t
       LEFT JOIN employees e ON e.id = t.assigned_to
       LEFT JOIN projects p  ON p.id = t.project_id
       WHERE LOWER(e.department) LIKE '%marketing%'
          OR LOWER(p.name) LIKE '%marketing%'
       ORDER BY t.due_date NULLS LAST LIMIT 200`
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch { res.json([]); }
});

router.get('/marketing-entry', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ts.id, ts.week_start_date, ts.total_hours, ts.status,
              e.first_name || ' ' || COALESCE(e.last_name,'') AS employee_name,
              p.name AS project_name
       FROM timesheets ts
       LEFT JOIN employees e ON e.id = ts.employee_id
       LEFT JOIN projects p  ON p.id = ts.project_id
       WHERE LOWER(e.department) LIKE '%marketing%'
          OR LOWER(p.name) LIKE '%marketing%'
       ORDER BY ts.week_start_date DESC LIMIT 200`
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch { res.json([]); }
});

export default router;

