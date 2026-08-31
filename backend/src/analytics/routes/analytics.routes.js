/**
 * analytics.routes.js — Full analytics endpoints.
 * All routes require JWT auth (applied at server.js registration).
 * company_id is extracted from req.scope (set by verifyToken middleware)
 * and passed through to every metricsEngine call for tenant isolation.
 */

import { Router } from 'express';
import pool from '../../config/db.js';
import {
  computeHeadcount,
  computeAttrition,
  computeDeptWorkforce,
  computeRevenueMetrics,
  computeSalesKPIs,
} from '../services/metricsEngine.js';
import { calcAttritionRate } from '../services/metricsCalculator.js';
import { resolveRange, dimension, assertDateParams } from '../../shared/dashboardFilters.js';
import {
  EMPLOYEE_ACTIVE, EMPLOYEE_EXITED, PROJECT_CLOSED, PROJECT_ACTIVE,
  LEAVE_PENDING, INVOICE_PAID, isIn, notIn,
} from '../../shared/statusSets.js';
import pqRouter  from './powerQuality.routes.js';
import mfgRouter from './manufacturing.routes.js';
import recruitmentRepository from '../../modules/recruitment/repositories/recruitment.repository.js';

/* safe single-row helper */
const sq1 = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows[0] || null; }
  catch (e) { console.error('[analytics] sq1 failed:', e.message); return null; }
};
const sqN = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { console.error('[analytics] sqN failed:', e.message); return []; }
};

/* Build company_id scope fragments for raw SQL endpoints */
function scopeFrags(company_id) {
  if (company_id == null) return { where: '', and: '', params: [] };
  return { where: `WHERE company_id = $1`, and: `AND company_id = $1`, params: [company_id] };
}

/**
 * Scope + dashboard-filter fragments for the HR Analytics endpoints.
 *
 * Extends scopeFrags with the department dimension and the period range from
 * the dashboard filter bar (?department=&period=&from=&to=). Param positions are
 * allocated dynamically because the company and department clauses are each
 * optional — never hand-number $n against this.
 *
 * Every fragment builder takes the param array it should append to and numbers
 * $n from that array's length. Each query MUST own its list — Postgres rejects a
 * bind that supplies more parameters than the statement references, so a shared
 * array mutated by one query's fragment breaks its siblings.
 *
 * Usage:
 *   const f = hrFrags(req);
 *   sqN(`SELECT … FROM employees WHERE deleted_at IS NULL ${f.and}`, f.base());
 *
 *   const p = f.base();                       // own copy
 *   const period = f.between('joining_date', p);
 *   sqN(`SELECT … WHERE 1=1 ${f.and} ${period}`, p);
 */
function hrFrags(req, { defaultPeriod = 'last12m' } = {}) {
  const company_id = req.scope?.company_id ?? null;
  const department = dimension(req.query, 'department');
  const range = resolveRange(req.query, { defaultPeriod });

  // Base params, in the order `and` references them.
  const baseParams = [];
  let and = '';
  if (company_id != null) { baseParams.push(company_id); and += ` AND company_id = $${baseParams.length}`; }
  if (department)         { baseParams.push(department); and += ` AND department = $${baseParams.length}`; }

  return {
    company_id, department, range, and,

    /** A fresh param list matching `and`. Never hand the same one to two queries. */
    base: () => [...baseParams],

    /** Period predicate on `col`, appending its bounds to `params`. */
    between(col, params) {
      if (range.isAll || (!range.from && !range.to)) return '';
      let sql = '';
      if (range.from) { params.push(range.from); sql += ` AND ${col} >= $${params.length}::date`; }
      if (range.to)   { params.push(range.to);   sql += ` AND ${col} < ($${params.length}::date + INTERVAL '1 day')`; }
      return sql;
    },

    /** Company predicate alone, for tables without a department column. */
    companyOnly(params) {
      if (company_id == null) return '';
      params.push(company_id);
      return ` AND company_id = $${params.length}`;
    },

    /**
     * Department predicate for tables that have no `department` column of their
     * own (leave_applications, …) — matches through employees.
     */
    deptViaEmployee(col, params) {
      if (!department) return '';
      params.push(department);
      return ` AND ${col} IN (SELECT id FROM employees WHERE department = $${params.length})`;
    },
  };
}

const router = Router();

/*
 * REMOVED 2026-08-18 — five endpoints with no caller anywhere in the frontend:
 *   GET /revenue                  (only consumer was services/modules/analyticsService.js, itself dead)
 *   GET /hr-kpis                  ┐
 *   GET /department-distribution  │ served only HRAnalyticsDashboard, a page registered
 *   GET /employee-status          │ in routes.jsx but absent from every nav menu and
 *   GET /pending-leaves           ┘ therefore unreachable. Its one genuine advantage —
 *                                   passing filter params to every call — has been ported
 *                                   into HR Dashboard's Analytics tab, and the page deleted.
 * Each duplicated an endpoint HR Dashboard already uses (/headcount, /dept-workforce,
 * /attrition, /leaves). Restore from git history if a caller ever needs them.
 */

/* ── Sub-routers ── */
router.use('/pq',            pqRouter);
router.use('/manufacturing', mfgRouter);

// GET /api/analytics/headcount
router.get('/headcount', async (req, res) => {
  try {
    const data = await computeHeadcount(req.scope?.company_id ?? null);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/attrition
router.get('/attrition', async (req, res) => {
  try {
    const data = await computeAttrition(req.scope?.company_id ?? null);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/dept-workforce
router.get('/dept-workforce', async (req, res) => {
  try {
    const data = await computeDeptWorkforce(req.scope?.company_id ?? null);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/sales
router.get('/sales', async (req, res) => {
  try {
    const data = await computeSalesKPIs(req.scope?.company_id ?? null);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/gender
router.get('/gender', async (req, res) => {
  try {
    const hc = await computeHeadcount(req.scope?.company_id ?? null);
    const data = (hc.by_gender || []).map(g => ({
      name:  g.gender || 'Not Specified',
      value: g.count  ?? 0,
    }));
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/attrition-trend — monthly attrition rate last 6 months
router.get('/attrition-trend', async (req, res) => {
  try {
    // Window was hardcoded to 6 months; it now follows the dashboard period,
    // defaulting to the same 6 months so an unfiltered call is unchanged.
    const f = hrFrags(req, { defaultPeriod: 'last6m' });
    const { and } = f;
    const depParams = f.base();
    const depRange = f.between('COALESCE(exit_date, updated_at)', depParams);

    const [depRows, hcRow] = await Promise.all([
      sqN(`SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(exit_date, updated_at) AT TIME ZONE 'Asia/Kolkata'), 'Mon') AS month,
                  DATE_TRUNC('month', COALESCE(exit_date, updated_at) AT TIME ZONE 'Asia/Kolkata') AS month_ts,
                  COUNT(*) AS cnt
           FROM employees
           WHERE ${isIn('status', EMPLOYEE_EXITED)}
             ${and} ${depRange}
           GROUP BY DATE_TRUNC('month', COALESCE(exit_date, updated_at) AT TIME ZONE 'Asia/Kolkata')
           ORDER BY month_ts`, depParams),
      sq1(`SELECT COUNT(*) AS total FROM employees WHERE ${isIn('status', EMPLOYEE_ACTIVE)} ${and}`, f.base()),
    ]);
    const headcount = parseInt(hcRow?.total || 1);
    const data = depRows.map(r => ({
      month:      r.month,
      rate:       calcAttritionRate(parseInt(r.cnt || 0), headcount),
      departures: parseInt(r.cnt || 0),
    }));
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/hiring-trend — monthly hires vs departures last 6 months
router.get('/hiring-trend', async (req, res) => {
  try {
    // Same as attrition-trend: the fixed 6-month window is now the default,
    // overridable by the dashboard period selector.
    const f = hrFrags(req, { defaultPeriod: 'last6m' });
    const { and } = f;
    const hireParams = f.base();
    const hireRange = f.between('joining_date', hireParams);
    const depParams = f.base();
    const depRange = f.between('updated_at', depParams);

    const [hireRows, depRows] = await Promise.all([
      sqN(`SELECT TO_CHAR(DATE_TRUNC('month', joining_date AT TIME ZONE 'Asia/Kolkata'), 'Mon') AS month,
                  DATE_TRUNC('month', joining_date AT TIME ZONE 'Asia/Kolkata') AS month_ts,
                  COUNT(*) AS cnt
           FROM employees
           WHERE joining_date IS NOT NULL
             ${and} ${hireRange}
           GROUP BY DATE_TRUNC('month', joining_date AT TIME ZONE 'Asia/Kolkata')
           ORDER BY month_ts`, hireParams),
      sqN(`SELECT TO_CHAR(DATE_TRUNC('month', updated_at AT TIME ZONE 'Asia/Kolkata'), 'Mon') AS month,
                  DATE_TRUNC('month', updated_at AT TIME ZONE 'Asia/Kolkata') AS month_ts,
                  COUNT(*) AS cnt
           FROM employees
           WHERE ${isIn('status', EMPLOYEE_EXITED)}
             ${and} ${depRange}
           GROUP BY DATE_TRUNC('month', updated_at AT TIME ZONE 'Asia/Kolkata')
           ORDER BY month_ts`, depParams),
    ]);
    /* merge by month label */
    const map = {};
    for (const r of hireRows) map[r.month] = { month: r.month, hired: parseInt(r.cnt || 0), departed: 0 };
    for (const r of depRows) {
      if (map[r.month]) map[r.month].departed = parseInt(r.cnt || 0);
      else              map[r.month] = { month: r.month, hired: 0, departed: parseInt(r.cnt || 0) };
    }
    res.json({ data: Object.values(map) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/offer-acceptance — recruitment offer conversion
//
// Was reimplemented here against candidates.status, a column nothing in the
// app ever writes (offer status lives on offer_letters, not candidates) —
// this always returned zeros. Delegates to recruitmentRepository's
// getOfferAcceptanceRate(), the same function Recruitment's own
// /recruitment/analytics/offer-acceptance-rate uses, instead of maintaining
// a second copy of the query. Fixed 2026-08-04.
router.get('/offer-acceptance', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { offered, accepted, declined, rate } = await recruitmentRepository.getOfferAcceptanceRate(cid);
    res.json({ data: { offered, accepted, declined, rate } });
  } catch (e) {
    res.json({ data: { offered: 0, accepted: 0, declined: 0, rate: 0 } });
  }
});

// GET /api/analytics/absenteeism — rolling 30-day absenteeism
router.get('/absenteeism', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);

    const [attRow, hcRow] = await Promise.all([
      // `attendance` carries no company_id — the bare `AND company_id = $1` raised
      // 42703 on every call and sq1 returned null, so the absenteeism rate had
      // always been 0.0%. Scope through the employee, the same way every other
      // attendance read in the app does.
      sq1(`SELECT
             COUNT(*) FILTER (WHERE LOWER(a.status) = 'absent') AS absent_days,
             COUNT(*) AS total_days
           FROM attendance a
           JOIN employees e ON e.id = a.employee_id
           WHERE a.date >= CURRENT_DATE - INTERVAL '30 days'
             AND ($1::int IS NULL OR e.company_id = $1)`, [cid]),
      sq1(`SELECT COUNT(*) AS total FROM employees WHERE ${isIn('status', EMPLOYEE_ACTIVE)} ${and}`, params),
    ]);
    const absentDays  = parseInt(attRow?.absent_days || 0);
    const totalDays   = parseInt(attRow?.total_days  || 1);
    const headcount   = parseInt(hcRow?.total        || 1);
    const denom       = Math.max(totalDays, 1);
    const rate        = parseFloat(((absentDays / denom) * 100).toFixed(1));
    const avgDays     = headcount > 0 ? parseFloat((absentDays / headcount).toFixed(1)) : 0;
    res.json({ data: { rate, absentDays, avgDays, chronic: 0 } });
  } catch (e) {
    res.json({ data: { rate: 0, absentDays: 0, avgDays: 0, chronic: 0 } });
  }
});

// GET /api/analytics/productivity — task completion rate by month (last 6 months)
router.get('/productivity', async (req, res) => {
  try {
    // `tasks` has no company_id of its own — scope through its project.
    const cid = req.scope?.company_id ?? null;
    const rows = await sqN(`
      SELECT TO_CHAR(DATE_TRUNC('month', t.created_at), 'Mon') AS month,
             DATE_TRUNC('month', t.created_at) AS month_ts,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE LOWER(t.status) IN ('done','completed')) AS done
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.created_at >= NOW() - INTERVAL '6 months'
        AND ($1::int IS NULL OR p.company_id = $1 OR p.id IS NULL)
      GROUP BY DATE_TRUNC('month', t.created_at)
      ORDER BY month_ts
    `, [cid]);
    const data = rows.map(r => ({
      month: r.month,
      score: parseInt(r.total) > 0
        ? Math.round((parseInt(r.done || 0) / parseInt(r.total)) * 100)
        : 0,
    }));
    res.json({ data });
  } catch (e) {
    res.json({ data: [] });
  }
});

// GET /api/analytics/top-performers — top employees by performance rating
router.get('/top-performers', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const cidClause = cid != null ? `AND e.company_id = $1` : '';
    const params    = cid != null ? [cid] : [];

    const rows = await sqN(`
      SELECT e.id,
             CONCAT(e.first_name, ' ', COALESCE(e.last_name, '')) AS name,
             e.department AS dept,
             ROUND(AVG(COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0))::numeric, 1) AS score
      FROM employees e
      JOIN performance_reviews pr ON pr.employee_id = e.id
      WHERE ${isIn('e.status', EMPLOYEE_ACTIVE)}
        AND pr.created_at >= NOW() - INTERVAL '12 months'
        ${cidClause}
      GROUP BY e.id, e.first_name, e.last_name, e.department
      ORDER BY score DESC
      LIMIT 10
    `, params);
    const data = rows.map(r => ({
      id:     r.id,
      name:   r.name,
      dept:   r.dept || 'General',
      score:  parseFloat(r.score || 0),
      rating: parseFloat(r.score || 0) >= 90 ? 'Exceptional'
            : parseFloat(r.score || 0) >= 75 ? 'Exceeds'
            : parseFloat(r.score || 0) >= 60 ? 'Meets'
            : 'Below',
    }));
    res.json({ data });
  } catch (e) {
    res.json({ data: [] });
  }
});

// GET /api/analytics/insights/hr — live rule-based HR insights
router.get('/insights/hr', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);

    const [attrition, hc, pendingLeaves] = await Promise.allSettled([
      computeAttrition(cid),
      computeHeadcount(cid),
      sq1(`SELECT COUNT(*) AS total FROM leave_applications WHERE (hr_status='pending' OR manager_status='pending') ${and}`, params),
    ]);
    const safe = (r, fb) => r.status === 'fulfilled' ? r.value : fb;
    const at = safe(attrition, { rate: 0, voluntary: 0 });
    const h  = safe(hc, { newHires: 0, departures: 0 });
    const pl = safe(pendingLeaves, null);

    const insights = [];

    if (at.rate > 15)
      insights.push({ type: 'danger', rule: 'critical_attrition', message: `Attrition at ${at.rate.toFixed(1)}% — critical. Immediate retention action needed.` });
    else if (at.rate > 10)
      insights.push({ type: 'warning', rule: 'high_attrition', message: `Attrition at ${at.rate.toFixed(1)}% — above 10% benchmark. Review exit trends.` });

    if (h.newHires > 0)
      insights.push({ type: 'success', rule: 'hiring_momentum', message: `${h.newHires} new hire${h.newHires > 1 ? 's' : ''} this month.` });

    if (parseInt(pl?.total || 0) > 10)
      insights.push({ type: 'warning', rule: 'pending_leaves', message: `${pl.total} leave requests pending approval — review queue.` });

    if (insights.length === 0)
      insights.push({ type: 'info', rule: 'all_clear', message: 'HR metrics are within normal ranges.' });

    res.json({ data: insights });
  } catch (e) {
    res.json({ data: [] });
  }
});

// GET /api/analytics/ceo/kpis — composite for CEO dashboard
router.get('/ceo/kpis', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const [hc, at, rev, sales, projR] = await Promise.allSettled([
      computeHeadcount(cid),
      computeAttrition(cid),
      computeRevenueMetrics(cid),
      computeSalesKPIs(cid),
      // `projects.status = 'on-track'` is impossible: projects_status_check permits
      // only planning|active|on_hold|completed|cancelled, so the old filter made this
      // tile read 0/N forever. Project health is DERIVED, never stored — a project is
      // on track when it is not past its end date and not over budget, which is the
      // same rule /ceo-intelligence/projects already applies per row. Computing it
      // the same way here keeps the KPI strip and the Projects tab in agreement.
      // Also now company-scoped and deleted_at-aware; it was neither.
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE ${notIn('p.status', PROJECT_CLOSED)}) AS active,
          COUNT(*) FILTER (
            WHERE ${notIn('p.status', PROJECT_CLOSED)}
              AND (p.end_date IS NULL OR p.end_date >= CURRENT_DATE)
              AND COALESCE(cs.total_cost, 0) <= COALESCE(p.budget_amount, 0) * 1.10
          ) AS on_track
        FROM projects p
        LEFT JOIN project_cost_summary cs ON cs.project_id = p.id
        WHERE p.deleted_at IS NULL
          AND ($1::int IS NULL OR p.company_id = $1)
      `, [cid]).catch(() => ({ rows: [{ active: 0, on_track: 0 }] })),
    ]);
    const safe = (r, fallback) => r.status === 'fulfilled' ? r.value : fallback;

    const headcount = safe(hc, {});
    const attrition = safe(at, {});
    const revenue   = safe(rev, {});
    const salesKPI  = safe(sales, {});
    const projRow   = safe(projR, { rows: [{ active: 0, on_track: 0 }] });
    const activeProjects = parseInt(projRow?.rows?.[0]?.active  || 0);
    const onTrack        = parseInt(projRow?.rows?.[0]?.on_track || 0);

    res.json({
      kpis: {
        revenue:         { value: revenue.revenue || 0,         growth: revenue.growth || 0, label: 'Total Revenue (YTD)' },
        arr:             { value: revenue.arr || 0,             growth: 0,                   label: 'ARR (Ann.)', sub: 'Active AMC contracts' },
        headcount:       { value: headcount.total || 0,         growth: headcount.growth || 0, label: 'Headcount' },
        attrition:       { value: attrition.rate || 0,         growth: 0,                   label: 'Attrition Rate', unit: '%' },
        openPipeline:    { value: salesKPI.pipelineValue || 0,  growth: 0,                   label: 'Sales Pipeline' },
        projectsOnTrack: { value: onTrack, growth: 0,           label: 'Projects On-Track', outOf: activeProjects },
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/analytics/headcount-trend — rolling 12-month headcount snapshot ──
router.get('/headcount-trend', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    // For each of the last 12 months: count employees whose joining_date <= month-end
    // and who had not yet exited (exit_date IS NULL or exit_date > month-end)
    const rows = await sqN(`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', NOW()) - INTERVAL '11 months',
          date_trunc('month', NOW()),
          '1 month'
        ) AS month_start
      )
      SELECT TO_CHAR(m.month_start, 'Mon YY') AS month,
             COUNT(e.id) AS headcount
      FROM months m
      LEFT JOIN employees e
        ON e.joining_date <= (m.month_start + INTERVAL '1 month - 1 day')::date
       AND (e.exit_date IS NULL OR e.exit_date > m.month_start::date)
       AND LOWER(e.status) NOT IN ('left','inactive','terminated','resigned','ex-employee')
       ${cid != null ? `AND e.company_id = $1` : ''}
      GROUP BY m.month_start
      ORDER BY m.month_start
    `, params);
    res.json({ data: rows.map(r => ({ month: r.month, headcount: parseInt(r.headcount || 0) })) });
  } catch (e) {
    res.json({ data: [] });
  }
});

// ── GET /api/analytics/salary-bands — salary distribution across bands ─────────
router.get('/salary-bands', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    const rows = await sqN(`
      SELECT
        CASE
          WHEN COALESCE(basic_salary, 0) = 0           THEN 'Not Set'
          WHEN basic_salary < 20000                     THEN '< ₹20K'
          WHEN basic_salary BETWEEN 20000 AND 39999     THEN '₹20K–40K'
          WHEN basic_salary BETWEEN 40000 AND 59999     THEN '₹40K–60K'
          WHEN basic_salary BETWEEN 60000 AND 99999     THEN '₹60K–1L'
          ELSE '> ₹1L'
        END AS band,
        COUNT(*) AS count,
        ROUND(AVG(basic_salary) FILTER (WHERE basic_salary > 0)) AS avg_salary
      FROM employees
      WHERE ${isIn('status', EMPLOYEE_ACTIVE)} ${and}
      -- GROUP BY 1, never GROUP BY band. employees has a real band column, and
      -- Postgres resolves an ambiguous GROUP BY name to the INPUT column, so
      -- GROUP BY band grouped on employees.band and left the CASE expression
      -- ungrouped — 42803 on every call, which the catch below turned into
      -- {"data":[]}. This chart had been permanently empty. Same trap as the
      -- gender query in metricsEngine.js, which is why that one also uses 1.
      GROUP BY 1
      ORDER BY MIN(COALESCE(basic_salary, 0))
    `, params);
    const BAND_ORDER = ['< ₹20K','₹20K–40K','₹40K–60K','₹60K–1L','> ₹1L','Not Set'];
    const sorted = [...rows].sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band));
    res.json({ data: sorted.map(r => ({ band: r.band, count: parseInt(r.count), avgSalary: parseInt(r.avg_salary || 0) })) });
  } catch (e) {
    res.json({ data: [] });
  }
});

// ── GET /api/analytics/time-to-hire — avg days from candidacy to joining ───────
//
// Was reimplemented here joining employees to candidates by email and
// filtering on candidates.stage, a column nothing in the app ever writes
// (real field is current_stage) — this always returned zeros. Delegates to
// recruitmentRepository.getTimeToHire(), the same function Recruitment's own
// /recruitment/analytics/time-to-hire uses, instead of a second copy of the
// query. Fixed 2026-08-04.
router.get('/time-to-hire', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { avg_days, min_days, max_days, matched } = await recruitmentRepository.getTimeToHire(cid);
    res.json({ data: { avgDays: avg_days, matched, minDays: min_days, maxDays: max_days } });
  } catch (e) {
    res.json({ data: { avgDays: 0, matched: 0, minDays: 0, maxDays: 0 } });
  }
});

// ── GET /api/analytics/satisfaction — derived engagement score from reviews ────
router.get('/satisfaction', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const cidClause = cid != null ? `AND e.company_id = $1` : '';
    const params    = cid != null ? [cid] : [];
    const [scoreRow, trendRows] = await Promise.all([
      sq1(`
        SELECT
          ROUND(AVG(COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0))::numeric, 1) AS score,
          COUNT(*) AS reviews,
          COUNT(*) FILTER (WHERE COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0) >= 80) AS satisfied,
          COUNT(*) FILTER (WHERE COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0) < 50) AS at_risk
        FROM performance_reviews pr
        JOIN employees e ON e.id = pr.employee_id
        WHERE pr.created_at >= NOW() - INTERVAL '12 months'
          AND ${isIn('e.status', EMPLOYEE_ACTIVE)}
          ${cidClause}
      `, params),
      sqN(`
        SELECT TO_CHAR(DATE_TRUNC('month', pr.created_at), 'Mon') AS month,
               ROUND(AVG(COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0))::numeric, 1) AS score
        FROM performance_reviews pr
        JOIN employees e ON e.id = pr.employee_id
        WHERE pr.created_at >= NOW() - INTERVAL '6 months'
          AND ${isIn('e.status', EMPLOYEE_ACTIVE)}
          ${cidClause}
        GROUP BY DATE_TRUNC('month', pr.created_at)
        ORDER BY DATE_TRUNC('month', pr.created_at)
      `, params),
    ]);
    res.json({
      data: {
        score:     parseFloat(scoreRow?.score    || 0),
        reviews:   parseInt(scoreRow?.reviews    || 0),
        satisfied: parseInt(scoreRow?.satisfied  || 0),
        atRisk:    parseInt(scoreRow?.at_risk     || 0),
        trend:     trendRows.map(r => ({ month: r.month, score: parseFloat(r.score || 0) })),
      },
    });
  } catch (e) {
    res.json({ data: { score: 0, reviews: 0, satisfied: 0, atRisk: 0, trend: [] } });
  }
});

// ── GET /api/analytics/onboarding — new-hire onboarding pipeline ──────────────
router.get('/onboarding', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    // Employees who joined in the last 90 days (still in onboarding window)
    const [summaryRow, newHires] = await Promise.all([
      sq1(`
        SELECT
          COUNT(*)                                                          AS total,
          COUNT(*) FILTER (WHERE probation_end_date IS NOT NULL
                            AND probation_end_date <= NOW() + INTERVAL '14 days'
                            AND probation_end_date >= NOW())                AS confirming_soon,
          COUNT(*) FILTER (WHERE joining_date >= NOW() - INTERVAL '30 days') AS joined_30d,
          COUNT(*) FILTER (WHERE joining_date >= NOW() - INTERVAL '7 days')  AS joined_7d
        FROM employees
        WHERE ${isIn('status', EMPLOYEE_ACTIVE)}
          AND joining_date >= NOW() - INTERVAL '90 days'
          ${and}
      `, params),
      sqN(`
        SELECT id, first_name, last_name, department, designation,
               joining_date, probation_end_date, status
        FROM employees
        WHERE ${isIn('status', EMPLOYEE_ACTIVE)}
          AND joining_date >= NOW() - INTERVAL '90 days'
          ${and}
        ORDER BY joining_date DESC
        LIMIT 8
      `, params),
    ]);
    res.json({
      data: {
        total:           parseInt(summaryRow?.total            || 0),
        confirmingSoon:  parseInt(summaryRow?.confirming_soon  || 0),
        joined30d:       parseInt(summaryRow?.joined_30d       || 0),
        joined7d:        parseInt(summaryRow?.joined_7d        || 0),
        recentHires:     newHires.map(e => ({
          id:             e.id,
          name:           `${e.first_name} ${e.last_name || ''}`.trim(),
          department:     e.department || 'General',
          designation:    e.designation || '',
          joiningDate:    e.joining_date,
          probationEnd:   e.probation_end_date,
          daysIn:         Math.floor((Date.now() - new Date(e.joining_date)) / 86400000),
        })),
      },
    });
  } catch (e) {
    res.json({ data: { total: 0, confirmingSoon: 0, joined30d: 0, joined7d: 0, recentHires: [] } });
  }
});

// ── GET /api/analytics/compliance-alerts — expiring compliance docs ────────────
router.get('/compliance-alerts', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const cidClause = cid != null ? `AND cd.company_id = $1` : '';
    const params    = cid != null ? [cid] : [];
    const rows = await sqN(`
      SELECT cd.id, cd.doc_type, cd.doc_number, cd.expiry_date, cd.status,
             e.first_name, e.last_name, e.department,
             (cd.expiry_date - CURRENT_DATE) AS days_left
      FROM employee_compliance_docs cd
      JOIN employees e ON e.id = cd.employee_id
      WHERE cd.status = 'valid'
        AND cd.expiry_date <= CURRENT_DATE + INTERVAL '90 days'
        AND ${isIn('e.status', EMPLOYEE_ACTIVE)}
        ${cidClause}
      ORDER BY cd.expiry_date ASC
      LIMIT 20
    `, params);
    const data = rows.map(r => ({
      id:         r.id,
      docType:    r.doc_type,
      docNumber:  r.doc_number || '',
      expiryDate: r.expiry_date,
      daysLeft:   parseInt(r.days_left || 0),
      employee:   `${r.first_name} ${r.last_name || ''}`.trim(),
      department: r.department || '',
      priority:   parseInt(r.days_left) <= 14 ? 'high' : parseInt(r.days_left) <= 30 ? 'medium' : 'low',
    }));
    res.json({ data });
  } catch (e) {
    res.json({ data: [] });
  }
});

// GET /api/analytics/hr-filter-options — dimension values for the HR dashboard
// filter bar. Deliberately ignores the active department filter so choosing one
// doesn't collapse the dropdown to a single entry.
router.get('/hr-filter-options', async (req, res) => {
  try {
    const { and, params } = scopeFrags(req.scope?.company_id ?? null);
    const rows = await sqN(`
      SELECT DISTINCT department FROM employees
      WHERE deleted_at IS NULL AND department IS NOT NULL AND TRIM(department) <> '' ${and}
      ORDER BY department
    `, params);
    res.json({ departments: rows.map(r => r.department) });
  } catch (e) {
    res.json({ departments: [] });
  }
});

// GET /api/analytics/age-distribution — headcount by age bracket
router.get('/age-distribution', async (req, res) => {
  try {
    const f = hrFrags(req);
    const { and } = f;
    const params = f.base();
    const rows = await sqN(`
      SELECT
        CASE
          WHEN age < 25  THEN 'Under 25'
          WHEN age < 30  THEN '25–29'
          WHEN age < 35  THEN '30–34'
          WHEN age < 40  THEN '35–39'
          WHEN age < 45  THEN '40–44'
          WHEN age < 50  THEN '45–49'
          ELSE '50+'
        END AS bracket,
        COUNT(*) AS count
      FROM (
        SELECT EXTRACT(YEAR FROM AGE(CURRENT_DATE, dob)) AS age
        FROM employees
        WHERE deleted_at IS NULL
          AND ${isIn('status', EMPLOYEE_ACTIVE)}
          AND dob IS NOT NULL
          ${and}
      ) sub
      GROUP BY bracket
      ORDER BY MIN(age)
    `, params);
    res.json({ data: rows.map(r => ({ bracket: r.bracket, count: parseInt(r.count) })) });
  } catch (e) {
    res.json({ data: [] });
  }
});

// Shared Excel helper — streams an XLSX workbook from row data
async function sendXlsx(res, sheetName, rows, filename) {
  const XLSX = (await import('xlsx')).default;
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

// GET /api/analytics/employee-reports/headcount — headcount report (JSON or CSV or XLSX)
router.get('/employee-reports/headcount', async (req, res) => {
  try {
    // A malformed date used to reach Postgres and return a 500 carrying raw
    // driver text; the caller could not tell a bad request from an outage.
    const bad = assertDateParams(req.query);
    if (bad) return res.status(bad.status).json(bad.body);
    // EXPORT MUST MATCH THE SCREEN. This accepted only ?format and ignored the
    // department and period the user had selected, so "export what I am looking
    // at" silently produced the whole company. hrFrags is the same filter
    // vocabulary the seven sibling /analytics endpoints already use.
    const f = hrFrags(req, { defaultPeriod: 'all' });
    const p = f.base();
    const period = f.between('joining_date', p);
    const { rows } = await pool.query(`
      SELECT office_id AS "Emp Code",
             first_name || ' ' || COALESCE(last_name,'') AS "Name",
             department AS "Department", designation AS "Designation",
             employment_type AS "Employment Type",
             TO_CHAR(joining_date,'DD-Mon-YYYY') AS "Joining Date",
             status AS "Status", gender AS "Gender",
             COALESCE(grade,'') AS "Grade", COALESCE(band,'') AS "Band"
      FROM employees
      WHERE deleted_at IS NULL AND ${isIn('status', EMPLOYEE_ACTIVE)} ${f.and} ${period}
      ORDER BY department, first_name
    `, p);
    if (req.query.format === 'xlsx') return sendXlsx(res, 'Headcount', rows, 'Headcount_Report.xlsx');
    res.json({ data: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/employee-reports/attrition — attrition report for CSV export
router.get('/employee-reports/attrition', async (req, res) => {
  try {
    // A malformed date used to reach Postgres and return a 500 carrying raw
    // driver text; the caller could not tell a bad request from an outage.
    const bad = assertDateParams(req.query);
    if (bad) return res.status(bad.status).json(bad.body);
    // Department now propagates alongside the date window, matching the page.
    const f = hrFrags(req, { defaultPeriod: 'all' });
    const p = f.base();
    const { from, to } = req.query;
    let dateClause = '';
    if (from) { p.push(from); dateClause += ` AND COALESCE(exit_date, updated_at) >= $${p.length}::date`; }
    // Half-open upper bound: `<= $n` against a date literal is midnight, so an
    // exit recorded on the last day of the window was excluded from the export.
    if (to)   { p.push(to);   dateClause += ` AND COALESCE(exit_date, updated_at) < ($${p.length}::date + INTERVAL '1 day')`; }
    const and = f.and;
    const { rows } = await pool.query(`
      SELECT office_id AS "Emp Code",
             first_name || ' ' || COALESCE(last_name,'') AS "Name",
             department AS "Department", designation AS "Designation",
             TO_CHAR(joining_date,'DD-Mon-YYYY') AS "Joining Date",
             TO_CHAR(exit_date,'DD-Mon-YYYY') AS "Exit Date",
             status AS "Status",
             COALESCE(exit_reason,'') AS "Exit Reason"
      FROM employees
      WHERE deleted_at IS NULL
        AND ${isIn('status', EMPLOYEE_EXITED)}
        ${and}${dateClause}
      ORDER BY COALESCE(exit_date, updated_at) DESC
    `, p);
    if (req.query.format === 'xlsx') return sendXlsx(res, 'Attrition', rows, 'Attrition_Report.xlsx');
    res.json({ data: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/employee-reports/doc-expiry — document expiry report for CSV export
router.get('/employee-reports/doc-expiry', async (req, res) => {
  try {
    // A malformed date used to reach Postgres and return a 500 carrying raw
    // driver text; the caller could not tell a bad request from an outage.
    const bad = assertDateParams(req.query);
    if (bad) return res.status(bad.status).json(bad.body);
    const cid = req.scope?.company_id ?? null;
    const cidClause = cid != null ? `AND e.company_id = $1` : '';
    const params    = cid != null ? [cid] : [];
    const { rows } = await pool.query(`
      SELECT e.office_id AS "Emp Code",
             e.first_name || ' ' || COALESCE(e.last_name,'') AS "Employee Name",
             e.department AS "Department",
             d.document_type AS "Document Type",
             d.document_name AS "Document Name",
             TO_CHAR(d.expiry_date,'DD-Mon-YYYY') AS "Expiry Date",
             COALESCE(d.status,'pending') AS "Status",
             (d.expiry_date - CURRENT_DATE) AS "Days Left"
      FROM employee_documents d
      JOIN employees e ON e.id = d.employee_id
      WHERE d.expiry_date IS NOT NULL
        AND ${isIn('e.status', EMPLOYEE_ACTIVE)}
        ${cidClause}
      ORDER BY d.expiry_date ASC
    `, params);
    if (req.query.format === 'xlsx') return sendXlsx(res, 'DocExpiry', rows, 'Document_Expiry_Report.xlsx');
    res.json({ data: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/employee-reports/salary-bands — salary band distribution (HR only)
router.get('/employee-reports/salary-bands', async (req, res) => {
  try {
    // A malformed date used to reach Postgres and return a 500 carrying raw
    // driver text; the caller could not tell a bad request from an outage.
    const bad = assertDateParams(req.query);
    if (bad) return res.status(bad.status).json(bad.body);
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    const { rows } = await pool.query(`
      SELECT
        COALESCE(band, 'Unassigned') AS "Band",
        COALESCE(grade, 'Unassigned') AS "Grade",
        COUNT(*) AS "Headcount",
        ROUND(AVG(COALESCE(basic_salary,0))::numeric, 0) AS "Avg Basic Salary",
        MIN(COALESCE(basic_salary,0)) AS "Min Salary",
        MAX(COALESCE(basic_salary,0)) AS "Max Salary"
      FROM employees
      WHERE ${isIn('status', EMPLOYEE_ACTIVE)}
        AND deleted_at IS NULL
        ${and}
      GROUP BY band, grade
      ORDER BY band, grade
    `, params);
    if (req.query.format === 'xlsx') return sendXlsx(res, 'SalaryBands', rows, 'Salary_Band_Report.xlsx');
    res.json({ data: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/employee-reports/onboarding-progress — onboarding cohort report
router.get('/employee-reports/onboarding-progress', async (req, res) => {
  try {
    // A malformed date used to reach Postgres and return a 500 carrying raw
    // driver text; the caller could not tell a bad request from an outage.
    const bad = assertDateParams(req.query);
    if (bad) return res.status(bad.status).json(bad.body);
    const cid = req.scope?.company_id ?? null;
    const cidClause = cid != null ? `AND e.company_id = $1` : '';
    const params = cid != null ? [cid] : [];
    const { rows } = await pool.query(`
      SELECT
        e.office_id AS "Emp Code",
        TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')) AS "Employee",
        e.department AS "Department",
        TO_CHAR(e.joining_date,'DD-Mon-YYYY') AS "Joining Date",
        COUNT(p.id) AS "Total Items",
        SUM(CASE WHEN p.done THEN 1 ELSE 0 END) AS "Completed",
        ROUND(100.0 * SUM(CASE WHEN p.done THEN 1 ELSE 0 END) / NULLIF(COUNT(p.id),0),1) AS "% Done"
      FROM employees e
      LEFT JOIN hr_onboarding_checklist_progress p ON p.employee_id = e.id
      WHERE ${isIn('e.status', EMPLOYEE_ACTIVE)}
        ${cidClause}
      GROUP BY e.id, e.office_id, e.first_name, e.last_name, e.department, e.joining_date
      ORDER BY e.joining_date DESC
    `, params);
    if (req.query.format === 'xlsx') return sendXlsx(res, 'Onboarding', rows, 'Onboarding_Progress.xlsx');
    res.json({ data: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/employee-reports/pending-confirmations
router.get('/employee-reports/pending-confirmations', async (req, res) => {
  try {
    // A malformed date used to reach Postgres and return a 500 carrying raw
    // driver text; the caller could not tell a bad request from an outage.
    const bad = assertDateParams(req.query);
    if (bad) return res.status(bad.status).json(bad.body);
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    const { rows } = await pool.query(`
      SELECT
        office_id AS "Emp Code",
        TRIM(first_name || ' ' || COALESCE(last_name,'')) AS "Employee",
        department AS "Department",
        designation AS "Designation",
        TO_CHAR(joining_date,'DD-Mon-YYYY') AS "Joining Date",
        TO_CHAR(probation_end_date,'DD-Mon-YYYY') AS "Probation End",
        (probation_end_date - CURRENT_DATE) AS "Days Remaining"
      FROM employees
      WHERE LOWER(status) = 'probation'
        AND probation_end_date IS NOT NULL
        AND deleted_at IS NULL
        ${and}
      ORDER BY probation_end_date ASC
    `, params);
    if (req.query.format === 'xlsx') return sendXlsx(res, 'PendingConfirmations', rows, 'Pending_Confirmations.xlsx');
    res.json({ data: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/analytics/hr-benchmarks — comprehensive HR benchmarking metrics ──
router.get('/hr-benchmarks', async (req, res) => {
  try {
    const cid  = req.scope?.company_id ?? null;

    // Dashboard period (?period / ?from / ?to). Every subquery below used to
    // hardcode `NOW() - INTERVAL '12 months'`; that is now the default, not a
    // fixed window.
    const range = resolveRange(req.query, { defaultPeriod: 'last12m' });

    /**
     * Per-subquery scope builder. Each query gets its OWN param array holding
     * exactly the placeholders it references — a shared fixed-position array
     * breaks any query that skips one (Postgres: "could not determine data type
     * of parameter"). See the pg-unreferenced-param note in the manual.
     *
     * @param {string} [alias] table alias plus dot, e.g. 'e.'
     */
    const scope = (alias = '') => {
      const params = [];
      const a = alias ? `${alias}` : '';
      let and = '';
      if (cid != null) { params.push(cid); and = ` AND ${a}company_id = $${params.length}`; }
      return {
        params, and,
        /** Period predicate on `col`; appends its bounds to this query's params. */
        between(col) {
          let sql = '';
          if (range.from) { params.push(range.from); sql += ` AND ${col} >= $${params.length}::date`; }
          if (range.to)   { params.push(range.to);   sql += ` AND ${col} <= $${params.length}::date`; }
          return sql;
        },
      };
    };

    // [0][1][3] were previously passed `[]` — i.e. NOT company-scoped at all, so
    // time-to-hire, offer acceptance and training effectiveness were computed
    // across every tenant. They are scoped now.
    // Build every subquery's scope up front. Order matters within each: `and`
    // is allocated first, then between() appends its bounds, so the $n numbers
    // in the SQL match the array positions.
    const s0 = scope('e.');  const w0 = s0.between('e.joining_date');
    const s1 = scope();      const w1 = s1.between('updated_at');
    const s2 = scope();      const w2 = s2.between('created_at');
    const s3 = scope();      const w3 = s3.between('created_at');
    const s4 = scope('e.');  const w4 = s4.between('pr.created_at');
    const s5 = scope();      const w5 = s5.between('COALESCE(exit_date, updated_at)');
    const s6 = scope('e.');  const w6 = s6.between('pr.created_at');
    const s7 = scope();      const w7 = s7.between('joining_date');
    // [8]–[10] are point-in-time (salary bands, gender split, leadership mix):
    // company scope only, no window.
    const s8 = scope(), s9 = scope(), s10 = scope();
    // [11]–[13] are period activity.
    const s11 = scope(); const w11 = s11.between('created_at');
    const s12 = scope(); const w12 = s12.between('updated_at');
    // s13/w13 previously scoped the cost-per-hire query. Retained so the
    // subquery indices below stay readable against the results array.
    const s13 = scope(); const w13 = s13.between('created_at');
    void s13; void w13;

    const results = await Promise.allSettled([
      // [0] Time to hire (candidate application → joining)
      sq1(`SELECT ROUND(AVG(e.joining_date - c.created_at::date)) AS avg_days,
                  COUNT(*) AS matched
           FROM employees e
           JOIN candidates c ON LOWER(c.email) = LOWER(e.company_email)
           WHERE c.stage IN ('joined','accepted')
             AND e.joining_date >= c.created_at::date
             ${s0.and} ${w0}`, s0.params),

      // [1] Offer acceptance / decline.
      //
      // Was `candidates.status IN ('offered','accepted','joined','declined')`.
      // Nothing in the app ever writes an offer outcome to candidates.status —
      // offers live on offer_letters.offer_status — so this returned 0/0 and the
      // page reported 0% acceptance while HR Dashboard, reading the correct table
      // through recruitmentRepository, reported the true rate for the same KPI.
      // Both surfaces now call the same function, so they cannot disagree again.
      recruitmentRepository.getOfferAcceptanceRate(cid),

      // [2] Revenue for revenue-per-employee.
      //
      // The comment said "from paid invoices" but the query carried no status
      // filter, so it summed drafts, sent, pending and overdue invoices too —
      // 48x the figure every other page in this module calls revenue, making
      // revenue-per-employee read in lakhs instead of thousands. Now uses the
      // same paid-only definition as metricsEngine and executive-summary.
      sq1(`SELECT COALESCE(SUM(total_amount), 0) AS total_revenue
           FROM invoices
           WHERE ${isIn('status', INVOICE_PAID)} ${s2.and} ${w2}`, s2.params),

      // [3] Training effectiveness.
      //
      // Queried `assessment_submissions`, a table that has never existed here —
      // sq1 swallowed the "relation does not exist" error and returned null, so
      // the card silently showed 0% "Below target" forever with no way to tell
      // that from a genuine zero. The real table is `assessment_attempts`
      // (score, max_score, score_pct, passed, company_id). It is currently empty,
      // now reported honestly as "no data" rather than as a failing score.
      sq1(`SELECT ROUND(AVG(score_pct)::numeric, 1) AS avg_score,
                  COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE passed IS TRUE) AS passed
           FROM assessment_attempts
           WHERE score_pct IS NOT NULL AND submitted_at IS NOT NULL ${s3.and} ${w3}`, s3.params),

      // [4] Performance appraisal rating distribution
      sqN(`SELECT
             CASE
               WHEN COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0) >= 90 THEN 'Exceptional'
               WHEN COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0) >= 75 THEN 'Exceeds'
               WHEN COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0) >= 60 THEN 'Meets'
               WHEN COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0) >= 40 THEN 'Below'
               ELSE 'PIP'
             END AS band,
             COUNT(*) AS count
           FROM performance_reviews pr
           JOIN employees e ON e.id = pr.employee_id
           WHERE ${isIn('e.status', EMPLOYEE_ACTIVE)}
             ${s4.and} ${w4}
           -- GROUP BY 1, not "band": employees.band is a real column, and
           -- Postgres resolves a bare GROUP BY name to the INPUT column ahead of
           -- the output alias. That grouped by e.band and made the CASE
           -- expression unaggregated, so this query always errored out.
           GROUP BY 1
           ORDER BY MIN(COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0)) DESC`, s4.params),

      // [5] Turnover / attrition — departures within the period; the active
      // headcount it is measured against is point-in-time, so only the
      // `departed` FILTER carries the window.
      sq1(`SELECT
             COUNT(*) FILTER (WHERE ${isIn('status', EMPLOYEE_EXITED)}
               ${w5}) AS departed,
             COUNT(*) FILTER (WHERE ${isIn('status', EMPLOYEE_ACTIVE)})          AS active
           FROM employees WHERE deleted_at IS NULL ${s5.and}`, s5.params),

      // [6] Engagement score from performance reviews
      sq1(`SELECT ROUND(AVG(COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0))::numeric, 1) AS score,
                  COUNT(*) FILTER (WHERE COALESCE(pr.overall_rating, pr.calibrated_rating, pr.final_rating, 0) >= 75) AS engaged
           FROM performance_reviews pr
           JOIN employees e ON e.id = pr.employee_id
           WHERE ${isIn('e.status', EMPLOYEE_ACTIVE)}
             ${s6.and} ${w6}`, s6.params),

      // [7] Acquisition (new hires within the period)
      sq1(`SELECT
             COUNT(*) FILTER (WHERE TRUE ${w7}) AS new_hires,
             COUNT(*) FILTER (WHERE ${isIn('status', EMPLOYEE_ACTIVE)})       AS active_count
           FROM employees WHERE deleted_at IS NULL ${s7.and}`, s7.params),

      // [8] Salary statistics for compa-ratio
      sq1(`SELECT
             ROUND(AVG(COALESCE(basic_salary,0))::numeric,0) AS avg_salary,
             ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(basic_salary,0))::numeric,0) AS median_salary,
             ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY COALESCE(basic_salary,0))::numeric,0) AS p25,
             ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY COALESCE(basic_salary,0))::numeric,0) AS p75
           FROM employees
           WHERE ${isIn('status', EMPLOYEE_ACTIVE)}
             AND deleted_at IS NULL AND basic_salary > 0 ${s8.and}`, s8.params),

      // [9] Gender diversity (overall)
      sq1(`SELECT
             COUNT(*) FILTER (WHERE LOWER(gender) IN ('female','f','woman')) AS female,
             COUNT(*) FILTER (WHERE LOWER(gender) IN ('male','m','man'))     AS male,
             COUNT(*) AS total
           FROM employees
           WHERE ${isIn('status', EMPLOYEE_ACTIVE)} AND deleted_at IS NULL ${s9.and}`, s9.params),

      // [10] Leadership gender diversity (representation in senior roles)
      sq1(`SELECT
             COUNT(*) FILTER (WHERE LOWER(gender) IN ('female','f','woman')) AS female_leaders,
             COUNT(*) AS total_leaders
           FROM employees
           WHERE ${isIn('status', EMPLOYEE_ACTIVE)} AND deleted_at IS NULL
             AND (LOWER(designation) LIKE '%manager%' OR LOWER(designation) LIKE '%director%'
               OR LOWER(designation) LIKE '%head%'    OR LOWER(designation) LIKE '%vp%'
               OR LOWER(designation) LIKE '%chief%'   OR LOWER(designation) LIKE '%president%'
               OR LOWER(designation) LIKE '%lead%')
             ${s10.and}`, s10.params),

      // [11] Leave utilization (proxy for benefits utilization)
      sq1(`SELECT COUNT(DISTINCT employee_id) AS utilizers
           FROM leave_applications
           WHERE 1=1 ${s11.and} ${w11}`, s11.params),

      // [12] Time to fill from job_openings (if table exists)
      sq1(`SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400)) AS avg_fill_days
           FROM job_openings
           WHERE LOWER(status) IN ('filled','closed')
             ${s12.and} ${w12}`, s12.params),

      // [13] Cost per hire.
      //
      // Queried `recruitment_costs`, which has never existed. There is no
      // recruitment-spend ledger anywhere in this schema, so the metric has no
      // honest source. Rather than keep a query that can only fail silently, it
      // resolves to null and the card renders "Not tracked" via
      // `costPerHireAvailable`. Wire this up when a recruitment cost ledger
      // exists; do not approximate from recruitment_agencies.commission_pct,
      // which covers only agency-sourced hires.
      Promise.resolve(null),
    ]);

    const s = (i, fb) => results[i].status === 'fulfilled' ? results[i].value : fb;

    const tth = s(0, null);
    const off = s(1, null);
    const rev = s(2, null);
    const trn = s(3, null);
    const rdt = s(4, []);
    const att = s(5, null);
    const sat = s(6, null);
    const acq = s(7, null);
    const sal = s(8, null);
    const gen = s(9, null);
    const ldg = s(10, null);
    const lvu = s(11, null);
    const ttf = s(12, null);
    const cph = s(13, null);

    const offered      = parseInt(off?.offered      || 0);
    const accepted     = parseInt(off?.accepted     || 0);
    const declined     = parseInt(off?.declined     || 0);
    const costPerHire  = cph == null ? null : (parseInt(cph.cost_per_hire || 0) || null);
    const departed     = parseInt(att?.departed     || 0);
    const activeHC     = Math.max(parseInt(att?.active || 0), 1);
    const newHires     = parseInt(acq?.new_hires    || 0);
    const totalActive  = Math.max(parseInt(acq?.active_count || 0), 1);
    const female       = parseInt(gen?.female       || 0);
    const male         = parseInt(gen?.male         || 0);
    const genTotal     = Math.max(parseInt(gen?.total || 0), 1);
    const leaderFemale = parseInt(ldg?.female_leaders || 0);
    const leaderTotal  = Math.max(parseInt(ldg?.total_leaders || 0), 1);
    const avgSalary    = parseFloat(sal?.avg_salary    || 0);
    const medianSalary = parseFloat(sal?.median_salary || 0);
    const utilizers    = parseInt(lvu?.utilizers || 0);
    const totalRevenue = parseFloat(rev?.total_revenue || 0);

    res.json({
      // Echoed so the cards can name the window they measured instead of
      // asserting a fixed "last 12 months".
      period:       range.period,
      period_label: range.label,
      recruitment: {
        avgDaysToHire:       parseInt(tth?.avg_days || 0),
        timeToFill:          parseInt(ttf?.avg_fill_days || 0),
        offerAcceptanceRate: offered > 0 ? parseFloat(((accepted / offered) * 100).toFixed(1)) : 0,
        // `offerExceptionRate` used to be emitted here as a second name for the
        // identical declined/offered expression, and the UI presented the two as
        // different metrics. One number, one name.
        offerDeclineRate:    offered > 0 ? parseFloat(((declined / offered) * 100).toFixed(1)) : 0,
        costPerHire,
        costPerHireAvailable: costPerHire != null,
        totalOffered:        offered,
        totalAccepted:       accepted,
        totalDeclined:       declined,
        offerDataAvailable:  offered > 0,
      },
      performance: {
        revenuePerEmployee:         activeHC > 1 ? parseFloat((totalRevenue / activeHC).toFixed(0)) : 0,
        revenueBasis:               'paid invoices in period',
        trainingEffectivenessScore: parseFloat(trn?.avg_score || 0),
        // Lets the card tell "0% pass rate" apart from "no assessments recorded".
        trainingDataAvailable:      parseInt(trn?.total || 0) > 0,
        totalAssessments:           parseInt(trn?.total   || 0),
        trainingPassRate:           parseInt(trn?.total   || 0) > 0
          ? parseFloat(((parseInt(trn?.passed || 0) / parseInt(trn.total)) * 100).toFixed(1)) : 0,
        appraisalDistribution: rdt.map(r => ({ band: r.band, count: parseInt(r.count || 0) })),
      },
      retention: {
        turnoverRate:    parseFloat(((departed / activeHC) * 100).toFixed(1)),
        engagementScore: parseFloat(sat?.score    || 0),
        engagedCount:    parseInt(sat?.engaged    || 0),
        acquisitionRate: parseFloat(((newHires / totalActive) * 100).toFixed(1)),
        newHires,
        departed,
      },
      compensation: {
        avgSalary,
        medianSalary,
        p25Salary:              parseFloat(sal?.p25 || 0),
        p75Salary:              parseFloat(sal?.p75 || 0),
        compaRatio:             medianSalary > 0 ? parseFloat((avgSalary / medianSalary).toFixed(2)) : 0,
        benefitsUtilizationRate: totalActive > 1
          ? parseFloat(((utilizers / totalActive) * 100).toFixed(1)) : 0,
      },
      diversity: {
        female,
        male,
        total:           parseInt(gen?.total || 0),
        femalePct:       parseFloat(((female / genTotal) * 100).toFixed(1)),
        malePct:         parseFloat(((male   / genTotal) * 100).toFixed(1)),
        leaderFemale,
        leaderTotal:     parseInt(ldg?.total_leaders || 0),
        leaderFemalePct: parseInt(ldg?.total_leaders || 0) > 0
          ? parseFloat(((leaderFemale / leaderTotal) * 100).toFixed(1)) : 0,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
