/**
 * manufacturing.routes.js — Industrial Manufacturing KPI Analytics
 * Mounted under /analytics/manufacturing by analytics.routes.js
 * All metrics are derived exclusively from persisted DB state.
 * No hardcoded fallbacks — empty arrays / zeros on missing data.
 *
 * Endpoints:
 *   GET /analytics/manufacturing/scrap-rate        — scrap trend + by-product breakdown
 *   GET /analytics/manufacturing/burn-test-trend   — burn/load-test pass rate trend
 *   GET /analytics/manufacturing/ecn-frequency     — ECN volume by type and severity over time
 *   GET /analytics/manufacturing/work-centre       — work-centre throughput + utilisation
 */

import { Router } from 'express';
import pool from '../../config/db.js';

const router = Router();

/**
 * Company scoping.
 *
 * This router had none at all. With a single tenant in the database that was
 * invisible; seeding a second company made it obvious — /work-centre reported
 * `in_progress: 3` to BOTH tenants (two orders from one, one from the other).
 *
 * `work_centres`, `production_orders`, `production_scrap` and
 * `engineering_changes` all carry company_id. `test_runs` and
 * `test_run_measurements` do not, so the burn-test endpoint is scoped through
 * the production order it belongs to where that link exists, and is flagged in
 * the response where it cannot be.
 *
 * A null company id means a genuinely global scope (an unassigned super admin),
 * matching the `($1 IS NULL OR company_id = $1)` convention used elsewhere.
 */
const cidOf = (req) => req.scope?.company_id ?? null;
const cidAnd = (cid, col = 'company_id', idx = 1) =>
  cid != null ? ` AND ${col} = $${idx}` : '';
const cidWhere = (cid, col = 'company_id', idx = 1) =>
  cid != null ? ` WHERE ${col} = $${idx}` : '';
const cidArgs = (cid) => (cid != null ? [cid] : []);

/**
 * Query helpers that keep "this failed" distinguishable from "this is empty".
 *
 * Both used to swallow the error and return []/null, which the response builder
 * then ran through `?? 0`. A single wrong column name therefore surfaced as a
 * confident `0` on the dashboard rather than as a fault — that is exactly how
 * `production_orders.completed_at` (a column that has never existed) reported
 * "0 orders in progress" while two orders sat in `planned`.
 *
 * On failure the result now carries a non-enumerable `__failed` marker, so the
 * JSON shape is unchanged for callers that ignore it while the response builder
 * can emit an explicit unavailable state instead of a fabricated zero.
 */
const markFailed = (value, err) => {
  Object.defineProperty(value, '__failed', { value: err.message, enumerable: false });
  return value;
};
/** True when a helper result came back from a failed query rather than an empty one. */
export const queryFailed = (v) => Boolean(v && v.__failed);

const sqN = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { console.error('[mfg-analytics] query failed:', e.message); return markFailed([], e); }
};
const sq1 = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows[0] || null; }
  catch (e) { console.error('[mfg-analytics] query failed:', e.message); return markFailed({}, e); }
};

/* ── GET /analytics/manufacturing/scrap-rate ─────────────────────────────────
   Monthly scrap quantity + value (last 6 months) and per-product breakdown.
   Sourced from production_scrap. A production_orders fallback used to be wired
   here for "when the scrap table is absent"; it was unreachable (sqN resolves
   rather than rejects) and referenced a column that has never existed, so it
   was removed rather than left as a comment promising behaviour it never had. */
router.get('/scrap-rate', async (req, res) => {
  try {
    const cid = cidOf(req);
    const [trendRows, byProductRows, kpiRow] = await Promise.all([

      // Monthly scrap trend (IST month boundaries)
      sqN(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', scrapped_at AT TIME ZONE 'Asia/Kolkata'), 'Mon YY') AS month,
          DATE_TRUNC('month', scrapped_at AT TIME ZONE 'Asia/Kolkata')                   AS month_ts,
          COALESCE(SUM(quantity), 0)::NUMERIC       AS scrap_qty,
          COALESCE(SUM(scrap_value), 0)::NUMERIC    AS scrap_value,
          COUNT(*)::INT                             AS incidents
        FROM production_scrap
        WHERE scrapped_at >= NOW() - INTERVAL '6 months' ${cidAnd(cid)}
        GROUP BY DATE_TRUNC('month', scrapped_at AT TIME ZONE 'Asia/Kolkata')
        ORDER BY month_ts
      `, cidArgs(cid)),

      // Scrap by product (top 10, 12-month window)
      sqN(`
        SELECT
          COALESCE(product_name, 'Unknown')            AS product,
          COALESCE(SUM(quantity), 0)::NUMERIC          AS total_scrap_qty,
          COALESCE(SUM(scrap_value), 0)::NUMERIC       AS total_scrap_value,
          COUNT(*)::INT                                AS incidents,
          COALESCE(reason, 'Not Specified')            AS top_reason
        FROM production_scrap
        WHERE scrapped_at >= NOW() - INTERVAL '12 months' ${cidAnd(cid)}
        GROUP BY product_name, reason
        ORDER BY total_scrap_qty DESC
        LIMIT 10
      `, cidArgs(cid)),

      // KPI summary
      sq1(`
        SELECT
          COALESCE(SUM(quantity), 0)::NUMERIC       AS total_scrap_qty,
          COALESCE(SUM(scrap_value), 0)::NUMERIC    AS total_scrap_value,
          COUNT(*)::INT                             AS total_incidents
        FROM production_scrap
        WHERE scrapped_at >= DATE_TRUNC('month', NOW()) ${cidAnd(cid)}
      `, cidArgs(cid)),
    ]);

    const scrapKpiFailed = queryFailed(kpiRow);
    res.json({
      kpi_available: !scrapKpiFailed,
      kpi: scrapKpiFailed ? null : {
        scrap_qty_mtd:   parseFloat(kpiRow?.total_scrap_qty   ?? 0),
        scrap_value_mtd: parseFloat(kpiRow?.total_scrap_value ?? 0),
        incidents_mtd:   parseInt(kpiRow?.total_incidents      ?? 0),
      },
      trend: trendRows.map(r => ({
        month:       r.month,
        scrap_qty:   parseFloat(r.scrap_qty   ?? 0),
        scrap_value: parseFloat(r.scrap_value ?? 0),
        incidents:   parseInt(r.incidents     ?? 0),
      })),
      by_product: byProductRows.map(r => ({
        product:          r.product,
        total_scrap_qty:   parseFloat(r.total_scrap_qty   ?? 0),
        total_scrap_value: parseFloat(r.total_scrap_value ?? 0),
        incidents:         parseInt(r.incidents           ?? 0),
        top_reason:        r.top_reason,
      })),
      no_data: trendRows.length === 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /analytics/manufacturing/burn-test-trend ────────────────────────────
   Monthly burn / load test pass rate from test_runs where test_type contains
   'burn' or 'load'. Surfaces first-pass rate + fail reasons trend.          */
router.get('/burn-test-trend', async (req, res) => {
  try {
    // `test_runs` carries no company_id. Every row that belongs to a tenant
    // reaches one through its production order or its project, so scope on
    // either link. A run with neither cannot be attributed and is excluded when
    // a company scope is in force — counting it for everyone would be the leak
    // this fixes, and counting it for nobody is the safe direction.
    const cid = cidOf(req);
    const runScope = cid != null ? `
          AND (EXISTS (SELECT 1 FROM production_orders po
                        WHERE po.id = %s.production_order_id AND po.company_id = $1)
            OR EXISTS (SELECT 1 FROM projects pj
                        WHERE pj.id = %s.project_id AND pj.company_id = $1))` : '';
    const scopeFor = (alias) => runScope.split('%s').join(alias);

    const [trendRows, failReasons, kpiRow] = await Promise.all([

      // Monthly burn/load test pass rates (IST)
      sqN(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at AT TIME ZONE 'Asia/Kolkata'), 'Mon YY') AS month,
          DATE_TRUNC('month', created_at AT TIME ZONE 'Asia/Kolkata')                   AS month_ts,
          COUNT(*)::INT                                                                  AS total,
          COUNT(*) FILTER (WHERE overall_result = 'pass')::INT                          AS passed,
          COUNT(*) FILTER (WHERE overall_result = 'fail')::INT                          AS failed,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE overall_result = 'pass')
            / NULLIF(COUNT(*) FILTER (WHERE overall_result IN ('pass','fail')), 0), 1
          )                                                                             AS pass_rate
        FROM test_runs tr
        WHERE LOWER(tr.test_type) IN ('burn', 'burn-in', 'burn_in', 'load', 'load_test', 'fat', 'sat')
          AND tr.created_at >= NOW() - INTERVAL '6 months'
          ${scopeFor('tr')}
        GROUP BY DATE_TRUNC('month', tr.created_at AT TIME ZONE 'Asia/Kolkata')
        ORDER BY month_ts
      `, cidArgs(cid)),

      // Top failure parameter codes for burn tests
      sqN(`
        SELECT
          m.parameter_code,
          m.parameter_name,
          COUNT(*) FILTER (WHERE m.result = 'fail')::INT AS fail_count,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE m.result = 'fail')
            / NULLIF(COUNT(*), 0), 1
          ) AS failure_rate
        FROM test_run_measurements m
        JOIN test_runs r ON r.id = m.test_run_id
        WHERE LOWER(r.test_type) IN ('burn', 'burn-in', 'burn_in', 'load', 'load_test', 'fat', 'sat')
          AND r.created_at >= NOW() - INTERVAL '6 months'
          AND m.measured_value IS NOT NULL
          ${scopeFor('r')}
        GROUP BY m.parameter_code, m.parameter_name
        ORDER BY fail_count DESC
        LIMIT 8
      `, cidArgs(cid)),

      // Rolling 12-month KPI
      sq1(`
        SELECT
          COUNT(*)::INT                                                                  AS total,
          COUNT(*) FILTER (WHERE overall_result = 'pass')::INT                          AS passed,
          COUNT(*) FILTER (WHERE overall_result = 'fail')::INT                          AS failed,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE overall_result = 'pass')
            / NULLIF(COUNT(*) FILTER (WHERE overall_result IN ('pass','fail')), 0), 1
          )                                                                             AS first_pass_rate
        FROM test_runs tr
        WHERE LOWER(tr.test_type) IN ('burn', 'burn-in', 'burn_in', 'load', 'load_test', 'fat', 'sat')
          AND tr.created_at >= NOW() - INTERVAL '12 months'
          ${scopeFor('tr')}
      `, cidArgs(cid)),
    ]);

    res.json({
      kpi: {
        total_12m:        parseInt(kpiRow?.total          ?? 0),
        passed_12m:       parseInt(kpiRow?.passed         ?? 0),
        failed_12m:       parseInt(kpiRow?.failed         ?? 0),
        first_pass_rate:  parseFloat(kpiRow?.first_pass_rate ?? 0),
      },
      trend: trendRows.map(r => ({
        month:      r.month,
        total:      parseInt(r.total     ?? 0),
        passed:     parseInt(r.passed    ?? 0),
        failed:     parseInt(r.failed    ?? 0),
        pass_rate:  parseFloat(r.pass_rate ?? 0),
      })),
      top_failure_params: failReasons.map(r => ({
        parameter_code: r.parameter_code,
        parameter_name: r.parameter_name,
        fail_count:     parseInt(r.fail_count   ?? 0),
        failure_rate:   parseFloat(r.failure_rate ?? 0),
      })),
      no_data: trendRows.length === 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /analytics/manufacturing/ecn-frequency ──────────────────────────────
   ECN volume by change_type and severity over 12 months.
   Monthly trend + breakdown by type and severity.                           */
router.get('/ecn-frequency', async (req, res) => {
  try {
    const cid = cidOf(req);
    const [trendRows, byTypeRows, bySeverityRows, kpiRow] = await Promise.all([

      // Monthly ECN creation trend (IST)
      sqN(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at AT TIME ZONE 'Asia/Kolkata'), 'Mon YY') AS month,
          DATE_TRUNC('month', created_at AT TIME ZONE 'Asia/Kolkata')                   AS month_ts,
          COUNT(*)::INT                                                                  AS total,
          COUNT(*) FILTER (WHERE status = 'implemented')::INT                           AS implemented,
          COUNT(*) FILTER (WHERE status IN ('draft','submitted'))::INT                  AS open,
          COUNT(*) FILTER (WHERE severity = 'critical')::INT                            AS critical
        FROM engineering_changes
        WHERE created_at >= NOW() - INTERVAL '12 months' ${cidAnd(cid)}
        GROUP BY DATE_TRUNC('month', created_at AT TIME ZONE 'Asia/Kolkata')
        ORDER BY month_ts
      `, cidArgs(cid)),

      // By change type (top 8)
      sqN(`
        SELECT
          change_type,
          COUNT(*)::INT                                                    AS total,
          COUNT(*) FILTER (WHERE status = 'implemented')::INT             AS implemented,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE status = 'implemented')
            / NULLIF(COUNT(*), 0), 1
          )                                                                AS implementation_rate
        FROM engineering_changes
        WHERE created_at >= NOW() - INTERVAL '12 months' ${cidAnd(cid)}
        GROUP BY change_type
        ORDER BY total DESC
        LIMIT 8
      -- cidArgs(cid) was missing here while cidAnd(cid) emitted AND company_id = $1,
      -- so Postgres raised 42P02 "there is no parameter $1" and the by-type
      -- breakdown was empty on every call. A fragment and its arguments must
      -- always be added in the same edit.
      `, cidArgs(cid)),

      // By severity
      sqN(`
        SELECT
          severity,
          COUNT(*)::INT                                                    AS total,
          COUNT(*) FILTER (WHERE status = 'implemented')::INT             AS implemented,
          ROUND(AVG(EXTRACT(EPOCH FROM (
            COALESCE(implemented_at, NOW()) - created_at
          )) / 86400), 1)                                                  AS avg_days_to_implement
        FROM engineering_changes
        WHERE created_at >= NOW() - INTERVAL '12 months' ${cidAnd(cid)}
        GROUP BY severity
        ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END
      `, cidArgs(cid)),

      // MTD summary
      sq1(`
        SELECT
          COUNT(*)::INT                                                   AS total_mtd,
          COUNT(*) FILTER (WHERE severity = 'critical')::INT             AS critical_mtd,
          COUNT(*) FILTER (WHERE status IN ('draft','submitted'))::INT   AS open_total
        FROM engineering_changes
        WHERE (created_at >= DATE_TRUNC('month', NOW()) OR status IN ('draft','submitted'))
          ${cidAnd(cid)}
      `, cidArgs(cid)),
    ]);

    res.json({
      kpi: {
        total_mtd:   parseInt(kpiRow?.total_mtd   ?? 0),
        critical_mtd: parseInt(kpiRow?.critical_mtd ?? 0),
        open_total:  parseInt(kpiRow?.open_total   ?? 0),
      },
      trend: trendRows.map(r => ({
        month:       r.month,
        total:       parseInt(r.total       ?? 0),
        implemented: parseInt(r.implemented ?? 0),
        open:        parseInt(r.open        ?? 0),
        critical:    parseInt(r.critical    ?? 0),
      })),
      by_type: byTypeRows.map(r => ({
        change_type:         r.change_type,
        total:               parseInt(r.total              ?? 0),
        implemented:         parseInt(r.implemented        ?? 0),
        implementation_rate: parseFloat(r.implementation_rate ?? 0),
      })),
      by_severity: bySeverityRows.map(r => ({
        severity:              r.severity,
        total:                 parseInt(r.total                   ?? 0),
        implemented:           parseInt(r.implemented             ?? 0),
        avg_days_to_implement: parseFloat(r.avg_days_to_implement ?? 0),
      })),
      no_data: trendRows.length === 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /analytics/manufacturing/work-centre ────────────────────────────────
   Work-centre throughput and utilisation from production execution data.
   Queries: work_centres, production_routings, routing_steps, production_orders */
router.get('/work-centre', async (req, res) => {
  try {
    const cid = cidOf(req);
    const [wcRows, throughputRows, kpiRow] = await Promise.all([

      // Per work-centre: current queue depth + completion rate (last 30 days)
      sqN(`
        SELECT
          wc.id,
          wc.name                                                          AS work_centre,
          wc.capacity_hours_per_day                                        AS capacity_hrs,
          COUNT(DISTINCT po.id) FILTER (
            WHERE po.status NOT IN ('completed','cancelled')
          )::INT                                                           AS active_orders,
          COUNT(DISTINCT po.id) FILTER (
            WHERE po.status = 'completed'
            AND po.actual_end_at >= NOW() - INTERVAL '30 days'
          )::INT                                                           AS completed_30d,
          ROUND(
            100.0 * COUNT(DISTINCT po.id) FILTER (
              WHERE po.status = 'completed'
              AND po.actual_end_at >= NOW() - INTERVAL '30 days'
            ) / NULLIF(
              COUNT(DISTINCT po.id) FILTER (
                WHERE po.created_at >= NOW() - INTERVAL '30 days'
              ), 0
            ), 1
          )                                                                AS completion_rate
        FROM work_centres wc
        LEFT JOIN routing_steps rs ON rs.work_centre_id = wc.id
        LEFT JOIN production_operations op ON op.routing_step_id = rs.id
        LEFT JOIN production_orders po ON po.id = op.production_order_id
               ${cid != null ? 'AND po.company_id = $1' : ''}
        ${cidWhere(cid, 'wc.company_id')}
        GROUP BY wc.id, wc.name, wc.capacity_hours_per_day
        ORDER BY active_orders DESC
        LIMIT 15
      `, cidArgs(cid)),

      // Monthly throughput trend (orders completed per work centre, IST)
      sqN(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', po.actual_end_at AT TIME ZONE 'Asia/Kolkata'), 'Mon YY') AS month,
          DATE_TRUNC('month', po.actual_end_at AT TIME ZONE 'Asia/Kolkata')                   AS month_ts,
          COUNT(DISTINCT po.id)::INT                                                          AS completed_orders,
          COALESCE(SUM(po.quantity_completed), 0)::NUMERIC                                     AS total_qty
        FROM production_orders po
        WHERE po.status = 'completed'
          AND po.actual_end_at >= NOW() - INTERVAL '6 months'
          ${cidAnd(cid, 'po.company_id')}
        GROUP BY DATE_TRUNC('month', po.actual_end_at AT TIME ZONE 'Asia/Kolkata')
        ORDER BY month_ts
      `, cidArgs(cid)),

      // Overall KPI row
      sq1(`
        SELECT
          COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled'))::INT AS in_progress,
          COUNT(*) FILTER (WHERE status = 'completed' AND actual_end_at >= DATE_TRUNC('month', NOW()))::INT AS completed_mtd,
          ROUND(AVG(
            EXTRACT(EPOCH FROM (actual_end_at - created_at)) / 3600
          ) FILTER (WHERE status = 'completed' AND actual_end_at >= NOW() - INTERVAL '30 days'), 1) AS avg_cycle_hrs
        FROM production_orders
        ${cidWhere(cid)}
      `, cidArgs(cid)),
    ]);

    // A failed KPI query blanks the whole block rather than reporting confident
    // zeros. `avg_cycle_hrs` stays null when nothing completed in the window —
    // that is "not measurable yet", not "zero hours".
    const kpiFailed = queryFailed(kpiRow);
    res.json({
      kpi: kpiFailed ? null : {
        in_progress:    parseInt(kpiRow?.in_progress   ?? 0),
        completed_mtd:  parseInt(kpiRow?.completed_mtd ?? 0),
        avg_cycle_hrs:  kpiRow?.avg_cycle_hrs == null ? null : parseFloat(kpiRow.avg_cycle_hrs),
      },
      kpi_available: !kpiFailed,
      work_centres: wcRows.map(r => ({
        id:              r.id,
        work_centre:     r.work_centre,
        capacity_hrs:    parseFloat(r.capacity_hrs    ?? 0),
        active_orders:   parseInt(r.active_orders     ?? 0),
        completed_30d:   parseInt(r.completed_30d     ?? 0),
        completion_rate: parseFloat(r.completion_rate ?? 0),
      })),
      throughput_trend: throughputRows.map(r => ({
        month:            r.month,
        completed_orders: parseInt(r.completed_orders ?? 0),
        total_qty:        parseFloat(r.total_qty      ?? 0),
      })),
      throughput_available: !queryFailed(throughputRows),
      no_data: wcRows.length === 0 && throughputRows.length === 0
               && !queryFailed(wcRows) && !queryFailed(throughputRows),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
