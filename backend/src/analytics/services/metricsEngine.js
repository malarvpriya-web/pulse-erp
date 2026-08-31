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
  calcHeadcountGrowth, calcRevenueGrowth, calcConversionRate,
} from './metricsCalculator.js';
import {
  EMPLOYEE_ACTIVE, EMPLOYEE_EXITED, EMPLOYEE_VOLUNTARY_EXIT,
  INVOICE_PAID, AMC_ACTIVE, LEAVE_APPROVED,
  isIn,
} from '../../shared/statusSets.js';

// Indian financial year — 1 April to 31 March. Revenue windows MUST use this, not
// `date_trunc('year')` (1 Jan): the calendar-year window was the sole cause of the CEO
// KPI strip reading ₹33.9L against the Executive card's ₹2.4L for the same "YTD revenue".
//
// Imported, not redeclared. Three copies of this expression existed, and the one
// place that had NO copy (dashboard.controller.js) used the calendar year and
// reported ₹62.9L for the same label. One definition, in dashboardFilters.js.
import { FY_START_SQL as FY_START } from '../../shared/dashboardFilters.js';

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
          SUM(CASE WHEN ${isIn('status', EMPLOYEE_ACTIVE)} THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN LOWER(status) = 'probation' THEN 1 ELSE 0 END) AS probation
        FROM employees ${where}`, params),
    // The predicate said `company_id = $2` (p1 = params.length + 1 = 2) while only
    // ONE parameter was bound, so Postgres raised 42P18 "could not determine data
    // type of parameter $1" — a statement that references $2 but is given a single
    // value leaves $1 unreferenced AND $2 unsupplied. sq() swallowed it and
    // "on leave" read 0 forever. Fourth instance of this bug in the codebase;
    // the shape below is the safe one: a NULL-tolerant predicate that always
    // references exactly the parameters it is given.
    sq(`SELECT COUNT(*) AS on_leave
        FROM leave_applications
        WHERE ${isIn('status', LEAVE_APPROVED)}
          AND start_date <= CURRENT_DATE
          AND end_date   >= CURRENT_DATE
          AND ($1::int IS NULL OR company_id = $1)`, [company_id ?? null]),
    sq(`SELECT COUNT(*) AS new_hires
        FROM employees
        WHERE created_at >= date_trunc('month', CURRENT_DATE) ${and}`, params),
    // Every exit status, not just 'inactive'. exit.routes.js writes 'left' on
    // relieving and hr.routes.js writes 'terminated'; the old single-literal
    // filter counted neither, so month-to-date departures always read 0.
    sq(`SELECT COUNT(*) AS departures
        FROM employees
        WHERE ${isIn('status', EMPLOYEE_EXITED)}
          AND COALESCE(updated_at, created_at) >= date_trunc('month', CURRENT_DATE) ${and}`, params),
    sq(`SELECT department, COUNT(*)::int AS count
        FROM employees
        WHERE ${isIn('status', EMPLOYEE_ACTIVE)} ${and}
        GROUP BY department ORDER BY count DESC`, params),
    // GROUP BY 1 (the output expression), NOT `gender` — Postgres resolves a GROUP BY
    // name that collides with an input column in favour of the *input* column, so
    // `GROUP BY gender` grouped on the raw employees.gender and emitted NULL and ''
    // as two separate rows that the COALESCE then labelled 'Not Specified' twice.
    sq(`SELECT COALESCE(NULLIF(TRIM(gender),''), 'Not Specified') AS gender,
               COUNT(*)::int AS count
        FROM employees
        WHERE ${isIn('status', EMPLOYEE_ACTIVE)} ${and}
        GROUP BY 1
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
    // `total` and `active` are DIFFERENT QUESTIONS and were being read as the
    // same one: `total` is every employee record including people who have left,
    // `active` is the payroll population (EMPLOYEE_ACTIVE, which includes anyone
    // serving notice). Four endpoints published one or the other under the bare
    // label "Total Employees". The basis travels with the numbers so a caller
    // can render the right word, and a reconciler can compare like with like.
    basis: {
      total:  'every employee record, including exited',
      active: 'EMPLOYEE_ACTIVE — on payroll today, notice period included',
    },
    headcount_on_payroll: active,
    by_department: byDeptR.rows,
    by_gender:     byGenderR.rows,
    growth:        calcHeadcountGrowth(total, prevTotal),
  };
}, { total:0, active:0, onLeave:0, newHires:0, departures:0, probation:0, by_department:[], by_gender:[], growth:0 }));

/** computeAttrition — rate, voluntary, involuntary, avgTenure, atRisk */
export const computeAttrition = cached('attrition', (company_id) => safeQuery(async () => {
  const { and, params } = scopeFrags(company_id);

  const [hcR, depR, tenureR] = await Promise.all([
    sq(`SELECT COUNT(*) AS total FROM employees WHERE ${isIn('status', EMPLOYEE_ACTIVE)} ${and}`, params),
    sq(`SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE ${isIn('status', EMPLOYEE_VOLUNTARY_EXIT)}) AS voluntary
        FROM employees
        WHERE ${isIn('status', EMPLOYEE_EXITED)}
          AND COALESCE(updated_at, created_at) >= CURRENT_DATE - INTERVAL '12 months' ${and}`, params),
    // Tenure runs from joining_date, the business start date. created_at is the
    // row's insert timestamp — for anyone migrated in from the old system that
    // is the import date, which reported a multi-year veteran as a new joiner.
    sq(`SELECT EXTRACT(DAY FROM NOW() - COALESCE(joining_date::timestamp, created_at)) AS days
        FROM employees
        WHERE ${isIn('status', EMPLOYEE_ACTIVE)} ${and}`, params),
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
     WHERE ${isIn('status', EMPLOYEE_ACTIVE)} ${and}
     GROUP BY department ORDER BY headcount DESC`,
    params
  );
  // No `target` is emitted. The previous `ceil(headcount * 1.1)` was not a
  // headcount plan — it was the headcount itself, restated, so every department
  // rendered at exactly 91% "fill" forever. There is no approved-headcount
  // column in this schema; inventing one and drawing it as a target bar told
  // the reader something false. When a real establishment/budgeted-headcount
  // field exists, add it here and the chart's target series will light up.
  return res.rows.map(r => ({
    dept:      r.dept || 'Unknown',
    headcount: parseInt(r.headcount),
  }));
}, []));

/**
 * computeRevenueMetrics — revenue, arr, mrr, growth
 *
 * Windows on the FINANCIAL year via FY_START and on `invoice_date`, matching
 * /ceo-intelligence/executive-summary exactly, so the CEO KPI strip and the Executive tab
 * card can no longer report different figures for the same YTD revenue.
 * `invoice_date` (not `created_at`) is the business date — the two happen to be identical
 * in today's data, so this changes nothing now but stops a back-dated invoice landing in
 * the wrong year later.
 *
 * TENANT SCOPING: `invoices`, `amc_contracts` and `opportunities` all carry a
 * `company_id` column (verified against information_schema). This function used
 * to declare its parameter as `_company_id` and never bind it, while `cached()`
 * still keyed the result BY company — so tenant A's revenue could be served
 * from tenant B's cache slot. Both halves are fixed: the queries bind the id and
 * the cache key stays per-company.
 */
export const computeRevenueMetrics = cached('revenue', (company_id) => safeQuery(async () => {
  const { and, params } = scopeFrags(company_id);
  const [revR, prevR, amcR] = await Promise.all([
    sq(`SELECT COALESCE(SUM(total_amount),0) AS revenue
        FROM invoices
        WHERE ${isIn('status', INVOICE_PAID)}
          AND invoice_date >= ${FY_START}
          AND invoice_date <= CURRENT_DATE ${and}`, params),
    // Prior year to the SAME POINT in the year, not the whole prior year. Comparing
    // 4½ months of this FY against 12 months of the last one reported −96% "growth"
    // on a business that had simply not finished the year yet.
    sq(`SELECT COALESCE(SUM(total_amount),0) AS revenue
        FROM invoices
        WHERE ${isIn('status', INVOICE_PAID)}
          AND invoice_date >= ${FY_START} - INTERVAL '1 year'
          AND invoice_date <= CURRENT_DATE - INTERVAL '1 year' ${and}`, params),
    // ARR is live recurring contract value, NOT round(revenue/12)*12 — that old formula
    // reproduced `revenue` by construction, so the ARR tile duplicated the revenue tile
    // beside it. Same source as executive-summary's `amc_revenue_annual`, so they agree.
    // Reads ₹0 while `amc_contracts` is empty; that is the honest figure, not a fault.
    sq(`SELECT COALESCE(SUM(contract_value),0) AS arr
        FROM amc_contracts WHERE ${isIn('status', AMC_ACTIVE)} ${and}`, params),
  ]);
  const revenue  = parseFloat(revR.rows[0]?.revenue  || 0);
  const prevYear = parseFloat(prevR.rows[0]?.revenue || 0);
  const arr      = parseFloat(amcR.rows[0]?.arr      || 0);
  return { revenue, arr, mrr: Math.round(arr / 12), growth: calcRevenueGrowth(revenue, prevYear) };
}, { revenue:0, arr:0, mrr:0, growth:0 }));

/**
 * computeSalesKPIs — pipeline value, conversion rate, avg deal size.
 *
 * Same tenant fix as computeRevenueMetrics: `opportunities.company_id` exists and
 * is now bound, rather than the parameter being accepted and discarded while the
 * cache keyed on it.
 */
export const computeSalesKPIs = cached('sales-kpis', (company_id) => safeQuery(async () => {
  const { and, params } = scopeFrags(company_id);
  const [pipR, wonR] = await Promise.all([
    sq(`SELECT COALESCE(SUM(expected_value),0) AS pipeline
        FROM opportunities
        WHERE deleted_at IS NULL
          AND LOWER(stage) NOT IN ('closed_won','closed_lost','closed won','closed lost') ${and}`, params),
    sq(`SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN LOWER(stage) IN ('closed_won','closed won') THEN 1 END) AS won,
          COALESCE(SUM(CASE WHEN LOWER(stage) IN ('closed_won','closed won') THEN COALESCE(expected_value,0) ELSE 0 END),0) AS won_value
        FROM opportunities
        WHERE deleted_at IS NULL ${and}`, params),
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
