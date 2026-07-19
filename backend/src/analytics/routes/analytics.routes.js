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
import { calcAttritionRate, calcOfferAcceptanceRate } from '../services/metricsCalculator.js';
import pqRouter  from './powerQuality.routes.js';
import mfgRouter from './manufacturing.routes.js';

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

const router = Router();

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

// GET /api/analytics/revenue
router.get('/revenue', async (req, res) => {
  try {
    const data = await computeRevenueMetrics(req.scope?.company_id ?? null);
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
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    const p1 = params.length + 1;

    const [depRows, hcRow] = await Promise.all([
      sqN(`SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(exit_date, updated_at) AT TIME ZONE 'Asia/Kolkata'), 'Mon') AS month,
                  DATE_TRUNC('month', COALESCE(exit_date, updated_at) AT TIME ZONE 'Asia/Kolkata') AS month_ts,
                  COUNT(*) AS cnt
           FROM employees
           WHERE LOWER(status) IN ('inactive','terminated','left','resigned','ex-employee')
             AND COALESCE(exit_date, updated_at) >= NOW() - INTERVAL '6 months'
             ${and}
           GROUP BY DATE_TRUNC('month', COALESCE(exit_date, updated_at) AT TIME ZONE 'Asia/Kolkata')
           ORDER BY month_ts`, params),
      sq1(`SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) IN ('active','probation') ${and}`, params),
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
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);

    const [hireRows, depRows] = await Promise.all([
      sqN(`SELECT TO_CHAR(DATE_TRUNC('month', joining_date AT TIME ZONE 'Asia/Kolkata'), 'Mon') AS month,
                  DATE_TRUNC('month', joining_date AT TIME ZONE 'Asia/Kolkata') AS month_ts,
                  COUNT(*) AS cnt
           FROM employees
           WHERE joining_date >= NOW() - INTERVAL '6 months'
             AND joining_date IS NOT NULL
             ${and}
           GROUP BY DATE_TRUNC('month', joining_date AT TIME ZONE 'Asia/Kolkata')
           ORDER BY month_ts`, params),
      sqN(`SELECT TO_CHAR(DATE_TRUNC('month', updated_at AT TIME ZONE 'Asia/Kolkata'), 'Mon') AS month,
                  DATE_TRUNC('month', updated_at AT TIME ZONE 'Asia/Kolkata') AS month_ts,
                  COUNT(*) AS cnt
           FROM employees
           WHERE LOWER(status) IN ('inactive','terminated','left')
             AND updated_at >= NOW() - INTERVAL '6 months'
             ${and}
           GROUP BY DATE_TRUNC('month', updated_at AT TIME ZONE 'Asia/Kolkata')
           ORDER BY month_ts`, params),
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
router.get('/offer-acceptance', async (req, res) => {
  try {
    const row = await sq1(`
      SELECT
        COALESCE(COUNT(*) FILTER (WHERE LOWER(status) IN ('offered','accepted','joined','declined')), 0) AS offered,
        COALESCE(COUNT(*) FILTER (WHERE LOWER(status) IN ('accepted','joined')), 0) AS accepted,
        COALESCE(COUNT(*) FILTER (WHERE LOWER(status) = 'declined'), 0) AS declined
      FROM candidates
      WHERE updated_at >= NOW() - INTERVAL '12 months'
    `);
    const offered  = parseInt(row?.offered  || 0);
    const accepted = parseInt(row?.accepted || 0);
    const declined = parseInt(row?.declined || 0);
    const data = {
      offered,
      accepted,
      declined,
      rate: calcOfferAcceptanceRate(accepted, offered),
    };
    res.json({ data });
  } catch (e) {
    /* candidates table may not exist — return zeros */
    res.json({ data: { offered: 0, accepted: 0, declined: 0, rate: 0 } });
  }
});

// GET /api/analytics/absenteeism — rolling 30-day absenteeism
router.get('/absenteeism', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);

    const [attRow, hcRow] = await Promise.all([
      sq1(`SELECT
             COUNT(*) FILTER (WHERE LOWER(status) = 'absent') AS absent_days,
             COUNT(*) AS total_days
           FROM attendance
           WHERE date >= NOW() - INTERVAL '30 days'
           ${cid != null ? `AND company_id = $1` : ''}`,
           cid != null ? [cid] : []),
      sq1(`SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) IN ('active','probation') ${and}`, params),
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
    const rows = await sqN(`
      SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS month,
             DATE_TRUNC('month', created_at) AS month_ts,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'done') AS done
      FROM tasks
      WHERE created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month_ts
    `);
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
             ROUND(AVG(COALESCE(pr.overall_rating, pr.rating, 0))::numeric, 1) AS score
      FROM employees e
      JOIN performance_reviews pr ON pr.employee_id = e.id
      WHERE LOWER(e.status) IN ('active','probation')
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
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE LOWER(status) NOT IN ('completed','cancelled')) AS active,
          COUNT(*) FILTER (WHERE LOWER(status) = 'on-track') AS on_track
        FROM projects
      `).catch(() => ({ rows: [{ active: 0, on_track: 0 }] })),
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
        arr:             { value: revenue.arr || 0,             growth: 0,                   label: 'ARR (Ann.)', sub: 'MRR × 12' },
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
      WHERE LOWER(status) IN ('active','probation') ${and}
      GROUP BY band
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
router.get('/time-to-hire', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    // Join employees with candidates by email; compute days between application and joining
    const row = await sq1(`
      SELECT
        ROUND(AVG(e.joining_date - c.created_at::date)) AS avg_days,
        COUNT(*) AS matched,
        MIN(e.joining_date - c.created_at::date) AS min_days,
        MAX(e.joining_date - c.created_at::date) AS max_days
      FROM employees e
      JOIN candidates c ON LOWER(c.email) = LOWER(e.company_email)
      WHERE e.joining_date >= NOW() - INTERVAL '12 months'
        AND c.stage IN ('joined','accepted')
        AND e.joining_date >= c.created_at::date
        ${and.replace('$1', `$${params.length + 1}`)}
    `, params);
    res.json({
      data: {
        avgDays:  parseInt(row?.avg_days  || 0),
        matched:  parseInt(row?.matched   || 0),
        minDays:  parseInt(row?.min_days  || 0),
        maxDays:  parseInt(row?.max_days  || 0),
      },
    });
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
          ROUND(AVG(COALESCE(pr.overall_rating, pr.rating, 0))::numeric, 1) AS score,
          COUNT(*) AS reviews,
          COUNT(*) FILTER (WHERE COALESCE(pr.overall_rating, pr.rating, 0) >= 80) AS satisfied,
          COUNT(*) FILTER (WHERE COALESCE(pr.overall_rating, pr.rating, 0) < 50) AS at_risk
        FROM performance_reviews pr
        JOIN employees e ON e.id = pr.employee_id
        WHERE pr.created_at >= NOW() - INTERVAL '12 months'
          AND LOWER(e.status) IN ('active','probation')
          ${cidClause}
      `, params),
      sqN(`
        SELECT TO_CHAR(DATE_TRUNC('month', pr.created_at), 'Mon') AS month,
               ROUND(AVG(COALESCE(pr.overall_rating, pr.rating, 0))::numeric, 1) AS score
        FROM performance_reviews pr
        JOIN employees e ON e.id = pr.employee_id
        WHERE pr.created_at >= NOW() - INTERVAL '6 months'
          AND LOWER(e.status) IN ('active','probation')
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
        WHERE LOWER(status) IN ('active','probation')
          AND joining_date >= NOW() - INTERVAL '90 days'
          ${and}
      `, params),
      sqN(`
        SELECT id, first_name, last_name, department, designation,
               joining_date, probation_end_date, status
        FROM employees
        WHERE LOWER(status) IN ('active','probation')
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
        AND LOWER(e.status) IN ('active','probation')
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

// GET /api/analytics/hr-kpis — consolidated HR KPIs for HR Analytics Dashboard
router.get('/hr-kpis', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    const [hcRow, attrRow, tenureRow, probRow, leaveRow] = await Promise.all([
      sq1(`SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE LOWER(status) IN ('active','probation')) AS active,
             COUNT(*) FILTER (WHERE LOWER(status) = 'probation') AS probation
           FROM employees WHERE deleted_at IS NULL ${and}`, params),
      sq1(`SELECT COUNT(*) AS departed FROM employees
           WHERE LOWER(status) IN ('inactive','terminated','left','resigned','ex-employee')
             AND COALESCE(exit_date, updated_at) >= NOW() - INTERVAL '12 months' ${and}`, params),
      sq1(`SELECT ROUND(AVG(EXTRACT(EPOCH FROM AGE(NOW(), joining_date)) / 31536000)::numeric, 1) AS avg_tenure
           FROM employees WHERE LOWER(status) IN ('active','probation') AND joining_date IS NOT NULL ${and}`, params),
      sq1(`SELECT COUNT(*) AS on_leave FROM leave_applications
           WHERE (hr_status = 'approved' OR manager_status = 'approved')
             AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE
             ${cid != null ? `AND company_id = $${params.length + 1}` : ''}`,
           cid != null ? [...params, cid] : params),
    ]);
    const total    = parseInt(hcRow?.total      || 0);
    const active   = parseInt(hcRow?.active     || 0);
    const probation= parseInt(hcRow?.probation  || 0);
    const departed = parseInt(attrRow?.departed || 0);
    const attrRate = active > 0 ? parseFloat(((departed / Math.max(active, 1)) * 100).toFixed(1)) : 0;
    res.json({
      total_employees:  total,
      active_employees: active,
      probation_count:  probation,
      on_leave:         parseInt(leaveRow?.on_leave || 0),
      attrition_rate:   attrRate,
      avg_tenure_years: parseFloat(tenureRow?.avg_tenure || 0),
    });
  } catch (e) {
    res.json({ total_employees: 0, active_employees: 0, probation_count: 0, on_leave: 0, attrition_rate: 0, avg_tenure_years: 0 });
  }
});

// GET /api/analytics/department-distribution — headcount and avg tenure by department
router.get('/department-distribution', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    const rows = await sqN(`
      SELECT department,
             COUNT(*) AS count,
             ROUND(AVG(EXTRACT(EPOCH FROM AGE(NOW(), joining_date)) / 31536000)::numeric, 1) AS avg_tenure,
             COUNT(*) FILTER (WHERE LOWER(designation) LIKE '%manager%'
                               OR LOWER(designation) LIKE '%head%'
                               OR LOWER(designation) LIKE '%lead%') AS managers
      FROM employees
      WHERE deleted_at IS NULL
        AND LOWER(status) IN ('active','probation')
        AND department IS NOT NULL AND department <> ''
        ${and}
      GROUP BY department
      ORDER BY count DESC
    `, params);
    const departments = rows.map(r => ({
      department: r.department,
      count:      parseInt(r.count || 0),
      avg_tenure: parseFloat(r.avg_tenure || 0),
      managers:   parseInt(r.managers || 0),
    }));
    res.json({ departments, total: departments.reduce((s, d) => s + d.count, 0) });
  } catch (e) {
    res.json({ departments: [], total: 0 });
  }
});

// GET /api/analytics/employee-status — headcount grouped by employment status
router.get('/employee-status', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    const rows = await sqN(`
      SELECT COALESCE(status, 'Unknown') AS status, COUNT(*) AS count
      FROM employees
      WHERE deleted_at IS NULL ${and}
      GROUP BY status
      ORDER BY count DESC
    `, params);
    const statuses = rows.map(r => ({ status: r.status, count: parseInt(r.count || 0) }));
    res.json({ statuses, total: statuses.reduce((s, d) => s + d.count, 0) });
  } catch (e) {
    res.json({ statuses: [], total: 0 });
  }
});

// GET /api/analytics/pending-leaves — count of unactioned leave applications
router.get('/pending-leaves', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    const row = await sq1(`
      SELECT COUNT(*) AS pending
      FROM leave_applications
      WHERE (hr_status = 'pending' OR manager_status = 'pending') ${and}
    `, params);
    res.json({ count: parseInt(row?.pending || 0), pending: parseInt(row?.pending || 0) });
  } catch (e) {
    res.json({ count: 0, pending: 0 });
  }
});

// GET /api/analytics/age-distribution — headcount by age bracket
router.get('/age-distribution', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
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
        SELECT EXTRACT(YEAR FROM AGE(CURRENT_DATE, COALESCE(dob, date_of_birth))) AS age
        FROM employees
        WHERE deleted_at IS NULL
          AND LOWER(status) IN ('active','probation')
          AND COALESCE(dob, date_of_birth) IS NOT NULL
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
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    const { rows } = await pool.query(`
      SELECT office_id AS "Emp Code",
             first_name || ' ' || COALESCE(last_name,'') AS "Name",
             department AS "Department", designation AS "Designation",
             employment_type AS "Employment Type",
             TO_CHAR(joining_date,'DD-Mon-YYYY') AS "Joining Date",
             status AS "Status", gender AS "Gender",
             COALESCE(grade,'') AS "Grade", COALESCE(band,'') AS "Band"
      FROM employees
      WHERE deleted_at IS NULL AND LOWER(status) IN ('active','probation') ${and}
      ORDER BY department, first_name
    `, params);
    if (req.query.format === 'xlsx') return sendXlsx(res, 'Headcount', rows, 'Headcount_Report.xlsx');
    res.json({ data: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/employee-reports/attrition — attrition report for CSV export
router.get('/employee-reports/attrition', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { and, params } = scopeFrags(cid);
    const { from, to } = req.query;
    const p = [...params];
    let dateClause = '';
    if (from) { p.push(from); dateClause += ` AND COALESCE(exit_date, updated_at) >= $${p.length}`; }
    if (to)   { p.push(to);   dateClause += ` AND COALESCE(exit_date, updated_at) <= $${p.length}`; }
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
        AND LOWER(status) IN ('inactive','terminated','left','resigned','ex-employee')
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
        AND LOWER(e.status) IN ('active','probation')
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
      WHERE LOWER(status) IN ('active','probation')
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
      WHERE LOWER(e.status) IN ('active','probation')
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
    const empC = cid != null ? 'AND company_id = $1'   : '';
    const eJC  = cid != null ? 'AND e.company_id = $1' : '';
    const p    = cid != null ? [cid] : [];

    const results = await Promise.allSettled([
      // [0] Time to hire (candidate application → joining)
      sq1(`SELECT ROUND(AVG(e.joining_date - c.created_at::date)) AS avg_days,
                  COUNT(*) AS matched
           FROM employees e
           JOIN candidates c ON LOWER(c.email) = LOWER(e.company_email)
           WHERE e.joining_date >= NOW() - INTERVAL '12 months'
             AND c.stage IN ('joined','accepted')
             AND e.joining_date >= c.created_at::date`, []),

      // [1] Offer acceptance / decline metrics
      sq1(`SELECT
             COUNT(*) FILTER (WHERE LOWER(status) IN ('offered','accepted','joined','declined')) AS offered,
             COUNT(*) FILTER (WHERE LOWER(status) IN ('accepted','joined'))                      AS accepted,
             COUNT(*) FILTER (WHERE LOWER(status) = 'declined')                                 AS declined
           FROM candidates
           WHERE updated_at >= NOW() - INTERVAL '12 months'`, []),

      // [2] Revenue from paid invoices (current FY)
      sq1(`SELECT COALESCE(SUM(total_amount), 0) AS total_revenue
           FROM invoices
           WHERE EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW())
             ${empC}`, p),

      // [3] Training effectiveness from assessment submissions
      sq1(`SELECT ROUND(AVG(score)::numeric, 1) AS avg_score,
                  COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE score >= 70) AS passed
           FROM assessment_submissions
           WHERE created_at >= NOW() - INTERVAL '12 months'
             AND score IS NOT NULL`, []),

      // [4] Performance appraisal rating distribution
      sqN(`SELECT
             CASE
               WHEN COALESCE(pr.overall_rating, pr.rating, 0) >= 90 THEN 'Exceptional'
               WHEN COALESCE(pr.overall_rating, pr.rating, 0) >= 75 THEN 'Exceeds'
               WHEN COALESCE(pr.overall_rating, pr.rating, 0) >= 60 THEN 'Meets'
               WHEN COALESCE(pr.overall_rating, pr.rating, 0) >= 40 THEN 'Below'
               ELSE 'PIP'
             END AS band,
             COUNT(*) AS count
           FROM performance_reviews pr
           JOIN employees e ON e.id = pr.employee_id
           WHERE pr.created_at >= NOW() - INTERVAL '12 months'
             AND LOWER(e.status) IN ('active','probation')
             ${eJC}
           GROUP BY band
           ORDER BY MIN(COALESCE(pr.overall_rating, pr.rating, 0)) DESC`, p),

      // [5] Turnover / attrition
      sq1(`SELECT
             COUNT(*) FILTER (WHERE LOWER(status) IN ('inactive','terminated','left','resigned','ex-employee')
               AND COALESCE(exit_date, updated_at) >= NOW() - INTERVAL '12 months') AS departed,
             COUNT(*) FILTER (WHERE LOWER(status) IN ('active','probation'))          AS active
           FROM employees WHERE deleted_at IS NULL ${empC}`, p),

      // [6] Engagement score from performance reviews
      sq1(`SELECT ROUND(AVG(COALESCE(pr.overall_rating, pr.rating, 0))::numeric, 1) AS score,
                  COUNT(*) FILTER (WHERE COALESCE(pr.overall_rating, pr.rating, 0) >= 75) AS engaged
           FROM performance_reviews pr
           JOIN employees e ON e.id = pr.employee_id
           WHERE pr.created_at >= NOW() - INTERVAL '12 months'
             AND LOWER(e.status) IN ('active','probation')
             ${eJC}`, p),

      // [7] Acquisition (new hires last 12 months)
      sq1(`SELECT
             COUNT(*) FILTER (WHERE joining_date >= NOW() - INTERVAL '12 months') AS new_hires,
             COUNT(*) FILTER (WHERE LOWER(status) IN ('active','probation'))       AS active_count
           FROM employees WHERE deleted_at IS NULL ${empC}`, p),

      // [8] Salary statistics for compa-ratio
      sq1(`SELECT
             ROUND(AVG(COALESCE(basic_salary,0))::numeric,0) AS avg_salary,
             ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(basic_salary,0))::numeric,0) AS median_salary,
             ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY COALESCE(basic_salary,0))::numeric,0) AS p25,
             ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY COALESCE(basic_salary,0))::numeric,0) AS p75
           FROM employees
           WHERE LOWER(status) IN ('active','probation')
             AND deleted_at IS NULL AND basic_salary > 0 ${empC}`, p),

      // [9] Gender diversity (overall)
      sq1(`SELECT
             COUNT(*) FILTER (WHERE LOWER(gender) IN ('female','f','woman')) AS female,
             COUNT(*) FILTER (WHERE LOWER(gender) IN ('male','m','man'))     AS male,
             COUNT(*) AS total
           FROM employees
           WHERE LOWER(status) IN ('active','probation') AND deleted_at IS NULL ${empC}`, p),

      // [10] Leadership gender diversity (representation in senior roles)
      sq1(`SELECT
             COUNT(*) FILTER (WHERE LOWER(gender) IN ('female','f','woman')) AS female_leaders,
             COUNT(*) AS total_leaders
           FROM employees
           WHERE LOWER(status) IN ('active','probation') AND deleted_at IS NULL
             AND (LOWER(designation) LIKE '%manager%' OR LOWER(designation) LIKE '%director%'
               OR LOWER(designation) LIKE '%head%'    OR LOWER(designation) LIKE '%vp%'
               OR LOWER(designation) LIKE '%chief%'   OR LOWER(designation) LIKE '%president%'
               OR LOWER(designation) LIKE '%lead%')
             ${empC}`, p),

      // [11] Leave utilization (proxy for benefits utilization)
      sq1(`SELECT COUNT(DISTINCT employee_id) AS utilizers
           FROM leave_applications
           WHERE created_at >= NOW() - INTERVAL '12 months'
             ${empC}`, p),

      // [12] Time to fill from job_openings (if table exists)
      sq1(`SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400)) AS avg_fill_days
           FROM job_openings
           WHERE LOWER(status) IN ('filled','closed')
             AND updated_at >= NOW() - INTERVAL '12 months'
             ${empC}`, p),

      // [13] Cost per hire from recruitment_costs (if table exists)
      sq1(`SELECT ROUND(SUM(amount) / NULLIF(COUNT(DISTINCT hire_id), 0)) AS cost_per_hire
           FROM recruitment_costs
           WHERE created_at >= NOW() - INTERVAL '12 months'
             ${empC}`, p),
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
      recruitment: {
        avgDaysToHire:       parseInt(tth?.avg_days || 0),
        timeToFill:          parseInt(ttf?.avg_fill_days || 0),
        offerAcceptanceRate: offered > 0 ? parseFloat(((accepted / offered) * 100).toFixed(1)) : 0,
        offerDeclineRate:    offered > 0 ? parseFloat(((declined / offered) * 100).toFixed(1)) : 0,
        offerExceptionRate:  offered > 0 ? parseFloat(((declined / offered) * 100).toFixed(1)) : 0,
        costPerHire:         parseInt(cph?.cost_per_hire || 0),
        totalOffered:        offered,
        totalAccepted:       accepted,
        totalDeclined:       declined,
      },
      performance: {
        revenuePerEmployee:         activeHC > 1 ? parseFloat((totalRevenue / activeHC).toFixed(0)) : 0,
        trainingEffectivenessScore: parseFloat(trn?.avg_score || 0),
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
