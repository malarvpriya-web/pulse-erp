/**
 * powerQuality.routes.js — Power Quality & Test Historian Analytics
 * Mounted under /analytics/pq by analytics.routes.js
 * All metrics sourced from test_runs + test_run_measurements tables.
 * No hardcoded fallback values — empty arrays / zeros on missing data.
 */

import { Router } from 'express';
import pool from '../../config/db.js';

const router = Router();

const sqN = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { console.error('[pq-analytics] query failed:', e.message); return []; }
};
const sq1 = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows[0] || null; }
  catch (e) { console.error('[pq-analytics] query failed:', e.message); return null; }
};

/* ── GET /analytics/pq/kpis ──────────────────────────────────────────────────
   Aggregate KPIs: total tests, pass/fail counts, avg THD-I, avg THD-V,
   avg power factor, avg active power output — rolling 12 months.          */
router.get('/kpis', async (req, res) => {
  try {
    const [runsRow, pfRow, poutRow] = await Promise.all([
      sq1(`
        SELECT
          COUNT(*)::INT                                                      AS total_tests,
          COUNT(*) FILTER (WHERE overall_result = 'pass')::INT              AS passed,
          COUNT(*) FILTER (WHERE overall_result = 'fail')::INT              AS failed,
          COUNT(*) FILTER (WHERE overall_result = 'in_progress')::INT       AS in_progress,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE overall_result = 'pass')
            / NULLIF(COUNT(*) FILTER (WHERE overall_result IN ('pass','fail')), 0), 1
          ) AS first_pass_rate
        FROM test_runs
        WHERE created_at >= NOW() - INTERVAL '12 months'
      `),
      sq1(`
        SELECT
          ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'THD_I'), 2) AS avg_thd_i,
          ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'THD_V'), 2) AS avg_thd_v,
          ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'PF'),    3) AS avg_pf
        FROM test_run_measurements m
        JOIN test_runs r ON r.id = m.test_run_id
        WHERE r.created_at >= NOW() - INTERVAL '12 months'
          AND m.measured_value IS NOT NULL
      `),
      sq1(`
        SELECT
          ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'P_OUT'), 1) AS avg_p_out,
          ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'Q_OUT'), 1) AS avg_q_out
        FROM test_run_measurements m
        JOIN test_runs r ON r.id = m.test_run_id
        WHERE r.created_at >= NOW() - INTERVAL '12 months'
          AND m.measured_value IS NOT NULL
      `),
    ]);

    res.json({
      total_tests:     parseInt(runsRow?.total_tests   || 0),
      passed:          parseInt(runsRow?.passed         || 0),
      failed:          parseInt(runsRow?.failed         || 0),
      in_progress:     parseInt(runsRow?.in_progress    || 0),
      first_pass_rate: parseFloat(runsRow?.first_pass_rate ?? 0),
      avg_thd_i:       parseFloat(pfRow?.avg_thd_i      ?? 0),
      avg_thd_v:       parseFloat(pfRow?.avg_thd_v      ?? 0),
      avg_pf:          parseFloat(pfRow?.avg_pf          ?? 0),
      avg_p_out:       parseFloat(poutRow?.avg_p_out    ?? 0),
      avg_q_out:       parseFloat(poutRow?.avg_q_out    ?? 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /analytics/pq/thd-trend ─────────────────────────────────────────────
   Monthly avg THD-I and THD-V over the last 6 months.
   Month boundaries computed in IST (Asia/Kolkata).                         */
router.get('/thd-trend', async (req, res) => {
  try {
    const rows = await sqN(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', r.created_at AT TIME ZONE 'Asia/Kolkata'), 'Mon YY') AS month,
        DATE_TRUNC('month', r.created_at AT TIME ZONE 'Asia/Kolkata')                    AS month_ts,
        ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'THD_I'), 2) AS thd_i,
        ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'THD_V'), 2) AS thd_v
      FROM test_runs r
      JOIN test_run_measurements m ON m.test_run_id = r.id
      WHERE r.created_at >= NOW() - INTERVAL '6 months'
        AND m.measured_value IS NOT NULL
      GROUP BY DATE_TRUNC('month', r.created_at AT TIME ZONE 'Asia/Kolkata')
      ORDER BY month_ts
    `);
    res.json(rows.map(r => ({
      month: r.month,
      thd_i: parseFloat(r.thd_i ?? 0),
      thd_v: parseFloat(r.thd_v ?? 0),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /analytics/pq/power-factor ──────────────────────────────────────────
   Monthly avg / min / max power factor (last 6 months) + PF band counts.  */
router.get('/power-factor', async (req, res) => {
  try {
    const [trend, bands] = await Promise.all([
      sqN(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', r.created_at AT TIME ZONE 'Asia/Kolkata'), 'Mon YY') AS month,
          DATE_TRUNC('month', r.created_at AT TIME ZONE 'Asia/Kolkata')                    AS month_ts,
          ROUND(AVG(m.measured_value),  3) AS avg_pf,
          ROUND(MIN(m.measured_value),  3) AS min_pf,
          ROUND(MAX(m.measured_value),  3) AS max_pf
        FROM test_runs r
        JOIN test_run_measurements m ON m.test_run_id = r.id
        WHERE m.parameter_code = 'PF'
          AND m.measured_value IS NOT NULL
          AND r.created_at >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', r.created_at AT TIME ZONE 'Asia/Kolkata')
        ORDER BY month_ts
      `),
      sqN(`
        SELECT
          CASE
            WHEN measured_value >= 0.98 THEN '≥ 0.98 (Excellent)'
            WHEN measured_value >= 0.95 THEN '0.95 – 0.97 (Good)'
            WHEN measured_value >= 0.90 THEN '0.90 – 0.94 (Acceptable)'
            ELSE '< 0.90 (Poor)'
          END AS band,
          COUNT(*)::INT AS count
        FROM test_run_measurements m
        JOIN test_runs r ON r.id = m.test_run_id
        WHERE m.parameter_code = 'PF'
          AND m.measured_value IS NOT NULL
          AND r.created_at >= NOW() - INTERVAL '12 months'
        GROUP BY band
        ORDER BY band
      `),
    ]);

    res.json({
      trend: trend.map(r => ({
        month:  r.month,
        avg_pf: parseFloat(r.avg_pf ?? 0),
        min_pf: parseFloat(r.min_pf ?? 0),
        max_pf: parseFloat(r.max_pf ?? 0),
      })),
      bands: bands.map(b => ({ band: b.band, count: b.count })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /analytics/pq/product-kpis ──────────────────────────────────────────
   Per-product first-pass rate, avg THD-I, avg PF (last 12 months, top 10). */
router.get('/product-kpis', async (req, res) => {
  try {
    const rows = await sqN(`
      SELECT
        COALESCE(r.product_name, 'Unknown')                                   AS product,
        COUNT(DISTINCT r.id)::INT                                              AS total,
        COUNT(DISTINCT r.id) FILTER (WHERE r.overall_result = 'pass')::INT    AS passed,
        ROUND(
          100.0 * COUNT(DISTINCT r.id) FILTER (WHERE r.overall_result = 'pass')
          / NULLIF(COUNT(DISTINCT r.id) FILTER (WHERE r.overall_result IN ('pass','fail')), 0),
          1
        ) AS pass_rate,
        ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'THD_I'), 2) AS avg_thd_i,
        ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'THD_V'), 2) AS avg_thd_v,
        ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'PF'),    3) AS avg_pf,
        ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'P_OUT'), 1) AS avg_p_out
      FROM test_runs r
      LEFT JOIN test_run_measurements m ON m.test_run_id = r.id
        AND m.measured_value IS NOT NULL
      WHERE r.created_at >= NOW() - INTERVAL '12 months'
      GROUP BY r.product_name
      ORDER BY total DESC
      LIMIT 10
    `);
    res.json(rows.map(r => ({
      product:   r.product,
      total:     r.total,
      passed:    r.passed,
      pass_rate: parseFloat(r.pass_rate  ?? 0),
      avg_thd_i: parseFloat(r.avg_thd_i ?? 0),
      avg_thd_v: parseFloat(r.avg_thd_v ?? 0),
      avg_pf:    parseFloat(r.avg_pf    ?? 0),
      avg_p_out: parseFloat(r.avg_p_out ?? 0),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /analytics/pq/harmonics ─────────────────────────────────────────────
   Counts measurements that failed by parameter_code for harmonic parameters.
   Groups by parameter to surface worst offenders.                           */
router.get('/harmonics', async (req, res) => {
  try {
    const rows = await sqN(`
      SELECT
        m.parameter_code,
        m.parameter_name,
        COUNT(*)::INT                                            AS total,
        COUNT(*) FILTER (WHERE m.result = 'fail')::INT          AS failures,
        ROUND(AVG(m.measured_value), 3)                         AS avg_value,
        ROUND(AVG(m.max_limit),      3)                         AS avg_limit,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE m.result = 'fail')
          / NULLIF(COUNT(*), 0), 1
        )                                                        AS failure_rate
      FROM test_run_measurements m
      JOIN test_runs r ON r.id = m.test_run_id
      WHERE m.parameter_code IN ('THD_I','THD_V','PF','P_OUT','Q_OUT')
        AND m.measured_value IS NOT NULL
        AND r.created_at >= NOW() - INTERVAL '12 months'
      GROUP BY m.parameter_code, m.parameter_name
      ORDER BY failures DESC
    `);
    res.json(rows.map(r => ({
      parameter_code: r.parameter_code,
      parameter_name: r.parameter_name,
      total:         r.total,
      failures:      r.failures,
      avg_value:     parseFloat(r.avg_value     ?? 0),
      avg_limit:     parseFloat(r.avg_limit     ?? 0),
      failure_rate:  parseFloat(r.failure_rate  ?? 0),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /analytics/pq/maintenance ───────────────────────────────────────────
   Maintenance KPIs: assets due, open breakdowns, MTTR, cost MTD.           */
router.get('/maintenance', async (req, res) => {
  try {
    const [due, openBreak, mttr, costMTD] = await Promise.allSettled([
      sq1(`SELECT COUNT(*)::INT AS n FROM maintenance_schedules
           WHERE next_due_date <= NOW() + INTERVAL '7 days'`),
      sq1(`SELECT COUNT(*)::INT AS n FROM maintenance_logs
           WHERE log_type='breakdown' AND status != 'completed'`),
      sq1(`SELECT ROUND(AVG(downtime_hrs), 2) AS mttr
           FROM maintenance_logs
           WHERE status='completed' AND downtime_hrs IS NOT NULL
             AND created_at >= NOW() - INTERVAL '6 months'`),
      sq1(`SELECT COALESCE(SUM(cost), 0) AS total
           FROM maintenance_logs
           WHERE created_at >= date_trunc('month', NOW())`),
    ]);

    const safe = (r, field, def = 0) =>
      r.status === 'fulfilled' ? parseFloat(r.value?.[field] ?? def) : def;

    res.json({
      assets_due:        safe(due,       'n'),
      open_breakdowns:   safe(openBreak, 'n'),
      mttr_hrs:          safe(mttr,      'mttr'),
      cost_mtd:          safe(costMTD,   'total'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /analytics/pq/export ────────────────────────────────────────────────
   CSV export of test runs with PQ measurements for the requested period.
   Query params: period (days, default 90), format (csv | json)
   All timestamps are expressed in IST (Asia/Kolkata, UTC+5:30).           */
router.get('/export', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || 90), 365);
    const fmt  = req.query.format === 'json' ? 'json' : 'csv';

    // IST export timestamp for report metadata
    const exportedAt = new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: '2-digit', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }) + ' IST';

    const rows = await sqN(`
      SELECT
        r.run_number,
        r.product_name,
        r.serial_number,
        r.test_stage,
        r.test_type,
        r.station_name,
        r.overall_result,
        TO_CHAR(r.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI IST') AS test_date,
        MAX(m.measured_value) FILTER (WHERE m.parameter_code = 'THD_I') AS thd_i,
        MAX(m.measured_value) FILTER (WHERE m.parameter_code = 'THD_V') AS thd_v,
        MAX(m.measured_value) FILTER (WHERE m.parameter_code = 'PF')    AS pf,
        MAX(m.measured_value) FILTER (WHERE m.parameter_code = 'P_OUT') AS p_out,
        MAX(m.measured_value) FILTER (WHERE m.parameter_code = 'Q_OUT') AS q_out
      FROM test_runs r
      LEFT JOIN test_run_measurements m ON m.test_run_id = r.id
        AND m.parameter_code IN ('THD_I','THD_V','PF','P_OUT','Q_OUT')
      WHERE r.created_at >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY r.id, r.run_number, r.product_name, r.serial_number,
               r.test_stage, r.test_type, r.station_name, r.overall_result, r.created_at
      ORDER BY r.created_at DESC
    `, [days]);

    if (fmt === 'json') {
      return res.json({ exported_at: exportedAt, period_days: days, source: 'test_runs + test_run_measurements', rows });
    }

    /* CSV — includes report metadata header and IST timestamps */
    const metaHeaders = [
      `# Pulse ERP — Power Quality Report`,
      `# Exported: ${exportedAt}`,
      `# Period: last ${days} days`,
      `# Source: test_runs + test_run_measurements (live DB)`,
      `# Record count: ${rows.length}`,
      `#`,
    ];
    const headers = [
      'Run Number','Product','Serial Number','Test Stage','Test Type',
      'Station','Result','Date (IST)','THD-I (%)','THD-V (%)','Power Factor',
      'Active Power (kW)','Reactive Power (kVAR)',
    ];
    const csvRows = rows.map(r => [
      r.run_number, r.product_name || '', r.serial_number || '',
      r.test_stage, r.test_type, r.station_name || '',
      r.overall_result, r.test_date,
      r.thd_i ?? '', r.thd_v ?? '', r.pf ?? '',
      r.p_out ?? '', r.q_out ?? '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

    const dateTag = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
    const csv = [...metaHeaders, headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="pq-report-${dateTag}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /analytics/pq/compliance-summary ────────────────────────────────────
   Fleet-level IEC 61000-3-2 compliance summary over the last 12 months.
   Reports THD-I / THD-V exceedance counts, pass rates by test stage, and
   top-10 products by failure count.
   All values derived from persisted test_runs + test_run_measurements.      */
router.get('/compliance-summary', async (req, res) => {
  try {
    const THD_LIMIT = 5.0; // Practical PQ commissioning limit (%)

    const [thdI, thdV, byStage, byProduct] = await Promise.all([

      // THD-I: count measurements above 5% and above 8% thresholds
      sq1(`
        SELECT
          COUNT(*) FILTER (WHERE m.measured_value > ${THD_LIMIT})::INT  AS above_limit,
          COUNT(*) FILTER (WHERE m.measured_value > 8.0)::INT            AS above_8pct,
          COUNT(*) FILTER (WHERE m.measured_value <= ${THD_LIMIT})::INT  AS compliant,
          COUNT(*)::INT                                                   AS total,
          ROUND(AVG(m.measured_value), 2)                                AS avg_value,
          ROUND(MAX(m.measured_value), 2)                                AS max_value
        FROM test_run_measurements m
        JOIN test_runs r ON r.id = m.test_run_id
        WHERE m.parameter_code = 'THD_I'
          AND m.measured_value IS NOT NULL
          AND r.created_at >= NOW() - INTERVAL '12 months'
      `),

      // THD-V: count measurements above 5% threshold
      sq1(`
        SELECT
          COUNT(*) FILTER (WHERE m.measured_value > ${THD_LIMIT})::INT  AS above_limit,
          COUNT(*) FILTER (WHERE m.measured_value <= ${THD_LIMIT})::INT  AS compliant,
          COUNT(*)::INT                                                   AS total,
          ROUND(AVG(m.measured_value), 2)                                AS avg_value,
          ROUND(MAX(m.measured_value), 2)                                AS max_value
        FROM test_run_measurements m
        JOIN test_runs r ON r.id = m.test_run_id
        WHERE m.parameter_code = 'THD_V'
          AND m.measured_value IS NOT NULL
          AND r.created_at >= NOW() - INTERVAL '12 months'
      `),

      // Pass rate by test stage (FAT / SAT / other)
      sqN(`
        SELECT
          r.test_stage,
          COUNT(DISTINCT r.id)::INT                                                            AS total,
          COUNT(DISTINCT r.id) FILTER (WHERE r.overall_result = 'pass')::INT                  AS passed,
          COUNT(DISTINCT r.id) FILTER (WHERE r.overall_result = 'fail')::INT                  AS failed,
          ROUND(
            100.0 * COUNT(DISTINCT r.id) FILTER (WHERE r.overall_result = 'pass')
            / NULLIF(COUNT(DISTINCT r.id) FILTER (WHERE r.overall_result IN ('pass','fail')), 0),
            1
          ) AS pass_rate
        FROM test_runs r
        WHERE r.created_at >= NOW() - INTERVAL '12 months'
        GROUP BY r.test_stage
        ORDER BY total DESC
      `),

      // Top-10 products by failure count
      sqN(`
        SELECT
          COALESCE(r.product_name, 'Unknown')                                           AS product,
          COUNT(DISTINCT r.id)::INT                                                     AS total,
          COUNT(DISTINCT r.id) FILTER (WHERE r.overall_result = 'fail')::INT            AS failed,
          ROUND(
            100.0 * COUNT(DISTINCT r.id) FILTER (WHERE r.overall_result = 'fail')
            / NULLIF(COUNT(DISTINCT r.id), 0), 1
          )                                                                             AS fail_rate,
          ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'THD_I'), 2)    AS avg_thd_i,
          ROUND(AVG(m.measured_value) FILTER (WHERE m.parameter_code = 'PF'),    3)    AS avg_pf
        FROM test_runs r
        LEFT JOIN test_run_measurements m ON m.test_run_id = r.id AND m.measured_value IS NOT NULL
        WHERE r.created_at >= NOW() - INTERVAL '12 months'
        GROUP BY r.product_name
        ORDER BY failed DESC, total DESC
        LIMIT 10
      `),
    ]);

    res.json({
      thd_i: {
        above_limit: parseInt(thdI?.above_limit ?? 0),
        above_8pct:  parseInt(thdI?.above_8pct  ?? 0),
        compliant:   parseInt(thdI?.compliant    ?? 0),
        total:       parseInt(thdI?.total        ?? 0),
        avg_value:   parseFloat(thdI?.avg_value  ?? 0),
        max_value:   parseFloat(thdI?.max_value  ?? 0),
      },
      thd_v: {
        above_limit: parseInt(thdV?.above_limit ?? 0),
        compliant:   parseInt(thdV?.compliant   ?? 0),
        total:       parseInt(thdV?.total       ?? 0),
        avg_value:   parseFloat(thdV?.avg_value ?? 0),
        max_value:   parseFloat(thdV?.max_value ?? 0),
      },
      by_stage:   byStage.map(r => ({ ...r, pass_rate: parseFloat(r.pass_rate ?? 0) })),
      by_product: byProduct.map(r => ({
        ...r,
        fail_rate: parseFloat(r.fail_rate ?? 0),
        avg_thd_i: parseFloat(r.avg_thd_i ?? 0),
        avg_pf:    parseFloat(r.avg_pf    ?? 0),
      })),
      standard:        'IEC 61000-3-2:2018',
      thd_limit_pct:   THD_LIMIT,
      period_months:   12,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
