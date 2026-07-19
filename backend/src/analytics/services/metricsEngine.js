/**
 * metricsEngine.js — DB aggregate functions.
 * Each function queries the database and returns computed metrics.
 * Falls back to empty structures on any DB error.
 *
 * Results are cached in-process for METRICS_CACHE_TTL_MS (default 60 s) to
 * prevent the CEO dashboard from hammering the DB on every page load.
 * Cache keys include company_id so tenants never share cached results.
 */

import pool from '../../config/db.js';
import {
  calcAttritionRate, calcVoluntaryAttrition, calcAvgTenure,
  calcHeadcountGrowth, calcARR, calcConversionRate,
} from './metricsCalculator.js';

// ── In-process TTL cache ──────────────────────────────────────────────────────
const _cache    = new Map(); // key → { data, expiresAt }
const CACHE_TTL = parseInt(process.env.METRICS_CACHE_TTL_MS || '60000');

function cached(baseKey, fn) {
  return (company_id = null) => {
    const key = company_id != null ? `${baseKey}:${company_id}` : baseKey;
    const now  = Date.now();
    const hit  = _cache.get(key);
    if (hit && now < hit.expiresAt) return Promise.resolve(hit.data);
    const p = fn(company_id);
    p.then(data => _cache.set(key, { data, expiresAt: now + CACHE_TTL })).catch(() => {});
    return p;
  };
}

const safeQuery = async (queryFn, fallback) => {
  try { return await queryFn(); }
  catch (e) { console.error('[metricsEngine]', e.message); return fallback; }
};

/* safe individual pool.query — never throws, returns {rows:[]} on error */
const sq = async (sql, params = []) => {
  try { return await pool.query(sql, params); }
  catch (e) { console.error('[metricsEngine] query failed:', e.message); return { rows: [] }; }
};

/* Build WHERE / AND fragments for optional company_id scoping */
function scopeFrags(company_id) {
  if (company_id == null) return { where: '', and: '', params: [] };
  return {
    where:  `WHERE company_id = $1`,
    and:    `AND company_id = $1`,
    params: [company_id],
  };
}

/** computeHeadcount — total, active, on-leave, new hires, departures, growth */
export const computeHeadcount = cached('headcount', (company_id) => safeQuery(async () => {
  const { where, and, params } = scopeFrags(company_id);
  const p1 = params.length + 1; // next param index after company_id

  /* Run every sub-query independently so one bad column never kills the rest */
  const [totalR, leavesR, hiresR, depsR, byDeptR, byGenderR] = await Promise.all([
    sq(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN LOWER(status) IN ('active','probation') THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN LOWER(status) = 'probation' THEN 1 ELSE 0 END) AS probation
        FROM employees ${where}`, params),
    sq(`SELECT COUNT(*) AS on_leave
        FROM leave_applications
        WHERE LOWER(status)='approved'
          AND start_date <= CURRENT_DATE
          AND end_date   >= CURRENT_DATE
          ${company_id != null ? `AND company_id = $${p1}` : ''}`,
       company_id != null ? [...params] : []),
    sq(`SELECT COUNT(*) AS new_hires
        FROM employees
        WHERE created_at >= date_trunc('month', CURRENT_DATE) ${and}`, params),
    sq(`SELECT COUNT(*) AS departures
        FROM employees
        WHERE LOWER(status)='inactive'
          AND COALESCE(updated_at, created_at) >= date_trunc('month', CURRENT_DATE) ${and}`, params),
    sq(`SELECT department, COUNT(*)::int AS count
        FROM employees
        WHERE LOWER(status) IN ('active','probation') ${and}
        GROUP BY department ORDER BY count DESC`, params),
    sq(`SELECT COALESCE(NULLIF(TRIM(gender),''), 'Not Specified') AS gender,
               COUNT(*)::int AS count
        FROM employees
        WHERE LOWER(status) IN ('active','probation') ${and}
        GROUP BY gender
        ORDER BY count DESC`, params),
  ]);

  const total     = parseInt(totalR.rows[0]?.total     || 0);
  const active    = parseInt(totalR.rows[0]?.active    || 0);
  const probation = parseInt(totalR.rows[0]?.probation || 0);
  const onLeave   = parseInt(leavesR.rows[0]?.on_leave || 0);
  const newHires  = parseInt(hiresR.rows[0]?.new_hires || 0);
  const departures= parseInt(depsR.rows[0]?.departures || 0);
  const prevTotal = Math.max(total + departures - newHires, 1);

  return {
    total, active, onLeave, newHires, departures, probation,
    by_department: byDeptR.rows,
    by_gender:     byGenderR.rows,
    growth:        calcHeadcountGrowth(total, prevTotal),
  };
}, { total:0, active:0, onLeave:0, newHires:0, departures:0, probation:0, by_department:[], by_gender:[], growth:0 }));

/** computeAttrition — rate, voluntary, involuntary, avgTenure, atRisk */
export const computeAttrition = cached('attrition', (company_id) => safeQuery(async () => {
  const { and, params } = scopeFrags(company_id);

  const [hcR, depR, tenureR] = await Promise.all([
    sq(`SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) IN ('active','probation') ${and}`, params),
    sq(`SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE LOWER(status) IN ('resigned','left')) AS voluntary
        FROM employees
        WHERE LOWER(status) IN ('inactive','resigned','terminated','left')
          AND COALESCE(updated_at, created_at) >= CURRENT_DATE - INTERVAL '12 months' ${and}`, params),
    sq(`SELECT EXTRACT(DAY FROM NOW() - created_at) AS days
        FROM employees
        WHERE LOWER(status) IN ('active','probation') ${and}`, params),
  ]);
  const headcount  = parseInt(hcR.rows[0]?.total || 1);
  const departures = parseInt(depR.rows[0]?.total || 0);
  const voluntary  = parseInt(depR.rows[0]?.voluntary || 0);
  const tenureDays = tenureR.rows.map(r => parseFloat(r.days || 0));
  return {
    rate:        calcAttritionRate(departures, headcount),
    voluntary:   calcVoluntaryAttrition(voluntary, headcount),
    involuntary: calcAttritionRate(departures - voluntary, headcount),
    avgTenure:   calcAvgTenure(tenureDays),
    atRisk:      0,
  };
}, { rate:0, voluntary:0, involuntary:0, avgTenure:0, atRisk:0 }));

/** computeDeptWorkforce — headcount per department */
export const computeDeptWorkforce = cached('dept-workforce', (company_id) => safeQuery(async () => {
  const { and, params } = scopeFrags(company_id);
  const res = await sq(
    `SELECT department AS dept, COUNT(*)::int AS headcount
     FROM employees
     WHERE LOWER(status) IN ('active','probation') ${and}
     GROUP BY department ORDER BY headcount DESC`,
    params
  );
  return res.rows.map(r => ({
    dept:      r.dept || 'Unknown',
    headcount: parseInt(r.headcount),
    target:    Math.ceil(parseInt(r.headcount) * 1.1),
  }));
}, []));

/** computeRevenueMetrics — revenue, arr, mrr, growth (not tenant-split: finance not yet scoped) */
export const computeRevenueMetrics = cached('revenue', (_company_id) => safeQuery(async () => {
  const [revR, prevR] = await Promise.all([
    sq(`SELECT COALESCE(SUM(total_amount),0) AS revenue
        FROM invoices
        WHERE LOWER(status)='paid'
          AND created_at >= date_trunc('year', CURRENT_DATE)`),
    sq(`SELECT COALESCE(SUM(total_amount),0) AS revenue
        FROM invoices
        WHERE LOWER(status)='paid'
          AND created_at >= date_trunc('year', CURRENT_DATE) - INTERVAL '1 year'
          AND created_at <  date_trunc('year', CURRENT_DATE)`),
  ]);
  const revenue  = parseFloat(revR.rows[0]?.revenue  || 0);
  const prevYear = parseFloat(prevR.rows[0]?.revenue || 0);
  const mrr = Math.round(revenue / 12);
  return { revenue, arr: calcARR(mrr), mrr, growth: calcHeadcountGrowth(revenue, prevYear) };
}, { revenue:0, arr:0, mrr:0, growth:0 }));

/** computeSalesKPIs — pipeline value, conversion rate, avg deal size */
export const computeSalesKPIs = cached('sales-kpis', (_company_id) => safeQuery(async () => {
  const [pipR, wonR] = await Promise.all([
    sq(`SELECT COALESCE(SUM(expected_value),0) AS pipeline
        FROM opportunities
        WHERE deleted_at IS NULL
          AND LOWER(stage) NOT IN ('closed_won','closed_lost','closed won','closed lost')`),
    sq(`SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN LOWER(stage) IN ('closed_won','closed won') THEN 1 END) AS won,
          COALESCE(SUM(CASE WHEN LOWER(stage) IN ('closed_won','closed won') THEN COALESCE(expected_value,0) ELSE 0 END),0) AS won_value
        FROM opportunities
        WHERE deleted_at IS NULL`),
  ]);
  const pipelineValue = parseFloat(pipR.rows[0]?.pipeline  || 0);
  const total         = parseInt(wonR.rows[0]?.total        || 0);
  const won           = parseInt(wonR.rows[0]?.won          || 0);
  const wonValue      = parseFloat(wonR.rows[0]?.won_value  || 0);
  return {
    pipelineValue,
    conversionRate: calcConversionRate(won, total),
    avgDealSize:    won > 0 ? Math.round(wonValue / won) : 0,
  };
}, { pipelineValue:0, conversionRate:0, avgDealSize:0 }));
