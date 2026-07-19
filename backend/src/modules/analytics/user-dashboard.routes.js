import express from 'express';
import pool from '../shared/db.js';
import { companyOf } from '../../shared/scope.js';

/**
 * Employee Analytics ("User Dashboard") aggregation endpoints.
 *
 * Feeds the analytics dashboard: leave / travel / timesheet metric cards,
 * weekly time-logged charts, travel-cost and leave-by-month charts, the
 * missed-timesheet table and the leave-statistics widget.
 *
 * Scoping model
 *  - company_id: taken from the JWT scope (never trusted from the query).
 *  - employee_id: a global SERIAL PK, so scoping a query by employee_id alone
 *    is already company-safe. Non-privileged callers are always clamped to
 *    their own employee_id; privileged roles (manager/admin/hr) may pass
 *    ?employee_id to drill into a specific employee. The department/user
 *    roster lists additionally scope on employees.company_id.
 *
 * Data-source note: timesheet_entries has no task-category column, so
 * "time by task type" groups by project (the richest available dimension,
 * consistent with the existing weekly-report project_distribution).
 */

const router = express.Router();

const cid = req => req.scope?.company_id ?? companyOf(req);
const uid = req => req.user?.employee_id ?? req.user?.userId ?? req.user?.id ?? null;

const PRIVILEGED_ROLES = new Set([
  'admin', 'super_admin', 'manager', 'hr', 'HR Manager',
  'hr_manager', 'hr_exec', 'Finance Manager', 'Project Manager',
]);
const isPrivileged = req => PRIVILEGED_ROLES.has(req.user?.role ?? '');

// Resolve the employee whose data is being requested. Non-privileged callers
// can only ever see themselves regardless of what ?employee_id they send.
function resolveEmployeeId(req) {
  const own = uid(req);
  const requested = req.query.employee_id ? parseInt(req.query.employee_id, 10) : null;
  if (requested && isPrivileged(req)) return requested;
  return own;
}

function resolveYear(req) {
  const y = parseInt(req.query.year, 10);
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : new Date().getFullYear();
}

// Fill a sparse {key: value} map into a dense ordered array 1..n.
function densify(rows, keyField, valField, count) {
  const map = new Map(rows.map(r => [Number(r[keyField]), Number(r[valField]) || 0]));
  const out = [];
  for (let i = 1; i <= count; i++) out.push({ n: i, value: map.get(i) ?? 0 });
  return out;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const APPROVED_EXPENSE = ['approved', 'paid', 'reimbursed'];

// ── Metric cards: leaves, travel days, travel cost ───────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const eid = resolveEmployeeId(req);
    const year = resolveYear(req);
    if (!eid) return res.json({ leaves: {}, travel: {}, year });

    const [leaveRes, travelRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(number_of_days), 0)::float AS total_days,
                COUNT(*)::int                            AS count
           FROM leave_applications
          WHERE employee_id = $1
            AND status = 'approved'
            AND EXTRACT(YEAR FROM start_date) = $2
            AND deleted_at IS NULL`,
        [eid, year]
      ).catch(() => ({ rows: [{ total_days: 0, count: 0 }] })),
      pool.query(
        `SELECT COALESCE(SUM(total_amount), 0)::float   AS total_cost,
                COUNT(DISTINCT expense_date)::int        AS travel_days
           FROM expense_claims
          WHERE employee_id = $1
            AND LOWER(status) = ANY($3)
            AND EXTRACT(YEAR FROM expense_date) = $2`,
        [eid, year, APPROVED_EXPENSE]
      ).catch(() => ({ rows: [{ total_cost: 0, travel_days: 0 }] })),
    ]);

    const l = leaveRes.rows[0] || {};
    const t = travelRes.rows[0] || {};
    const leaveDays = Number(l.total_days) || 0;
    const travelDays = Number(t.travel_days) || 0;
    const travelCost = Number(t.total_cost) || 0;

    res.json({
      year,
      leaves: {
        total: leaveDays,
        count: Number(l.count) || 0,
        avg_per_month: +(leaveDays / 12).toFixed(1),
      },
      travel_days: {
        total: travelDays,
        avg_per_month: +(travelDays / 12).toFixed(1),
      },
      travel_cost: {
        total: travelCost,
        avg_per_day: travelDays > 0 ? +(travelCost / travelDays).toFixed(0) : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Chart: hours logged per ISO week (1..53) ─────────────────────────────────
router.get('/time-logged', async (req, res) => {
  try {
    const eid = resolveEmployeeId(req);
    const year = resolveYear(req);
    if (!eid) return res.json([]);

    const { rows } = await pool.query(
      `SELECT EXTRACT(WEEK FROM work_date)::int AS week,
              COALESCE(SUM(hours_worked), 0)::float AS hours
         FROM timesheet_entries
        WHERE employee_id = $1
          AND EXTRACT(YEAR FROM work_date) = $2
          AND deleted_at IS NULL
        GROUP BY week
        ORDER BY week`,
      [eid, year]
    ).catch(() => ({ rows: [] }));

    res.json(densify(rows, 'week', 'hours', 53).map(r => ({ label: `W${r.n}`, week: r.n, value: r.value })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Chart: hours per week, stacked by project ("task type") ──────────────────
router.get('/time-by-type', async (req, res) => {
  try {
    const eid = resolveEmployeeId(req);
    const year = resolveYear(req);
    if (!eid) return res.json({ categories: [], data: [] });

    const { rows } = await pool.query(
      `SELECT COALESCE(p.project_name, 'Unassigned')  AS category,
              EXTRACT(WEEK FROM te.work_date)::int      AS week,
              COALESCE(SUM(te.hours_worked), 0)::float  AS hours
         FROM timesheet_entries te
         LEFT JOIN projects p ON te.project_id = p.id
        WHERE te.employee_id = $1
          AND EXTRACT(YEAR FROM te.work_date) = $2
          AND te.deleted_at IS NULL
        GROUP BY category, week
        ORDER BY week`,
      [eid, year]
    ).catch(() => ({ rows: [] }));

    const categories = [...new Set(rows.map(r => r.category))];
    const byWeek = new Map();
    for (let w = 1; w <= 53; w++) {
      const base = { label: `W${w}`, week: w };
      for (const c of categories) base[c] = 0;
      byWeek.set(w, base);
    }
    for (const r of rows) {
      const row = byWeek.get(Number(r.week));
      if (row) row[r.category] = Number(r.hours) || 0;
    }
    res.json({ categories, data: [...byWeek.values()] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Chart: travel expense (INR) by month ─────────────────────────────────────
router.get('/travel-by-month', async (req, res) => {
  try {
    const eid = resolveEmployeeId(req);
    const year = resolveYear(req);
    if (!eid) return res.json([]);

    const { rows } = await pool.query(
      `SELECT EXTRACT(MONTH FROM expense_date)::int AS month,
              COALESCE(SUM(total_amount), 0)::float  AS amount
         FROM expense_claims
        WHERE employee_id = $1
          AND LOWER(status) = ANY($3)
          AND EXTRACT(YEAR FROM expense_date) = $2
        GROUP BY month
        ORDER BY month`,
      [eid, year, APPROVED_EXPENSE]
    ).catch(() => ({ rows: [] }));

    res.json(densify(rows, 'month', 'amount', 12).map(r => ({ label: MONTH_LABELS[r.n - 1], value: r.value })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Chart: approved leave days by month ──────────────────────────────────────
router.get('/leave-by-month', async (req, res) => {
  try {
    const eid = resolveEmployeeId(req);
    const year = resolveYear(req);
    if (!eid) return res.json([]);

    const { rows } = await pool.query(
      `SELECT EXTRACT(MONTH FROM start_date)::int    AS month,
              COALESCE(SUM(number_of_days), 0)::float AS days
         FROM leave_applications
        WHERE employee_id = $1
          AND status = 'approved'
          AND EXTRACT(YEAR FROM start_date) = $2
          AND deleted_at IS NULL
        GROUP BY month
        ORDER BY month`,
      [eid, year]
    ).catch(() => ({ rows: [] }));

    res.json(densify(rows, 'month', 'days', 12).map(r => ({ label: MONTH_LABELS[r.n - 1], value: r.value })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Widget: leave statistics — total + earned / sick / other / rejected ──────
router.get('/leave-stats', async (req, res) => {
  try {
    const eid = resolveEmployeeId(req);
    const year = resolveYear(req);
    if (!eid) return res.json({ total: 0, breakdown: [] });

    const { rows } = await pool.query(
      `SELECT COALESCE(lt.leave_name, 'Other')          AS type,
              LOWER(la.status)                           AS status,
              COALESCE(SUM(la.number_of_days), 0)::float AS days
         FROM leave_applications la
         LEFT JOIN leave_types lt ON la.leave_type_id = lt.id
        WHERE la.employee_id = $1
          AND EXTRACT(YEAR FROM la.start_date) = $2
          AND la.deleted_at IS NULL
        GROUP BY type, status`,
      [eid, year]
    ).catch(() => ({ rows: [] }));

    const buckets = { earned: 0, sick: 0, other: 0, rejected: 0 };
    for (const r of rows) {
      const days = Number(r.days) || 0;
      if (r.status === 'rejected') { buckets.rejected += days; continue; }
      if (r.status !== 'approved') continue; // pending/cancelled excluded from taken-stats
      const t = (r.type || '').toLowerCase();
      if (/earn|privilege|annual|el\b/.test(t)) buckets.earned += days;
      else if (/sick|sl\b|medical/.test(t)) buckets.sick += days;
      else buckets.other += days;
    }
    const total = buckets.earned + buckets.sick + buckets.other;
    res.json({
      total,
      breakdown: [
        { name: 'Earned Leave', key: 'earned', value: buckets.earned },
        { name: 'Sick Leave', key: 'sick', value: buckets.sick },
        { name: 'Other Leave', key: 'other', value: buckets.other },
        { name: 'Rejected Leave', key: 'rejected', value: buckets.rejected },
      ],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Table: missed timesheet entries (working days with no logged time) ───────
router.get('/missed-timesheets', async (req, res) => {
  try {
    const eid = resolveEmployeeId(req);
    const year = resolveYear(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const search = (req.query.search || '').trim().toLowerCase();
    if (!eid) return res.json({ rows: [], total: 0, page, limit });

    // Employee identity + joining date bound the window's start.
    const empRes = await pool.query(
      `SELECT id,
              TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name,
              joining_date
         FROM employees
        WHERE id = $1`,
      [eid]
    ).catch(() => ({ rows: [] }));
    const emp = empRes.rows[0];
    const empName = emp?.name?.trim() || `Employee ${eid}`;

    // Window: Jan 1 .. min(Dec 31, today). Start no earlier than joining date.
    const now = new Date();
    let start = new Date(Date.UTC(year, 0, 1));
    if (emp?.joining_date) {
      const doj = new Date(emp.joining_date);
      if (!isNaN(doj) && doj > start) start = doj;
    }
    let end = new Date(Date.UTC(year, 11, 31));
    if (year === now.getFullYear() && now < end) end = now;
    if (start > end) return res.json({ rows: [], total: 0, page, limit });

    const startISO = start.toISOString().split('T')[0];
    const endISO = end.toISOString().split('T')[0];

    const [entryRes, holRes, leaveRes] = await Promise.all([
      pool.query(
        `SELECT DISTINCT work_date::text AS d
           FROM timesheet_entries
          WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3 AND deleted_at IS NULL`,
        [eid, startISO, endISO]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT date::text AS d FROM holidays WHERE date BETWEEN $1 AND $2`,
        [startISO, endISO]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT start_date::text AS s, end_date::text AS e
           FROM leave_applications
          WHERE employee_id = $1 AND status = 'approved' AND deleted_at IS NULL
            AND start_date <= $3 AND end_date >= $2`,
        [eid, startISO, endISO]
      ).catch(() => ({ rows: [] })),
    ]);

    const logged = new Set(entryRes.rows.map(r => r.d));
    const holidaySet = new Set(holRes.rows.map(r => r.d));
    const onLeave = new Set();
    for (const lv of leaveRes.rows) {
      const s = new Date(lv.s), e = new Date(lv.e);
      for (const cur = new Date(s); cur <= e; cur.setUTCDate(cur.getUTCDate() + 1)) {
        onLeave.add(cur.toISOString().split('T')[0]);
      }
    }

    // Walk working days (Mon–Fri), collect those with no entry / holiday / leave.
    const missed = [];
    for (const cur = new Date(start); cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
      const dow = cur.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const iso = cur.toISOString().split('T')[0];
      if (logged.has(iso) || holidaySet.has(iso) || onLeave.has(iso)) continue;
      missed.push({ name: empName, date: iso });
    }

    let filtered = missed;
    if (search) {
      filtered = missed.filter(m =>
        m.name.toLowerCase().includes(search) || m.date.includes(search));
    }
    filtered.sort((a, b) => b.date.localeCompare(a.date)); // newest first

    const total = filtered.length;
    const startIdx = (page - 1) * limit;
    res.json({ rows: filtered.slice(startIdx, startIdx + limit), total, page, limit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Filter options: departments + users (privileged only) ────────────────────
router.get('/filters', async (req, res) => {
  try {
    const company_id = cid(req);
    // Non-privileged users get no roster — the view locks to self.
    if (!isPrivileged(req)) {
      return res.json({ departments: [], users: [], self: uid(req) });
    }
    const [deptRes, userRes] = await Promise.all([
      pool.query(
        `SELECT DISTINCT department
           FROM employees
          WHERE department IS NOT NULL AND department <> ''
            AND ($1::int IS NULL OR company_id = $1)
          ORDER BY department`,
        [company_id]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT id,
                TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name,
                department
           FROM employees
          WHERE ($1::int IS NULL OR company_id = $1)
            AND LOWER(status) IN ('active','probation','notice')
          ORDER BY name`,
        [company_id]
      ).catch(() => ({ rows: [] })),
    ]);
    res.json({
      departments: deptRes.rows.map(r => r.department),
      users: userRes.rows.map(r => ({ id: r.id, name: r.name || `Employee ${r.id}`, department: r.department })),
      self: uid(req),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
