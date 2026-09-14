// backend/src/modules/intelligence/anomalyDetector.js
// Anomaly detection logic, extracted from GET /api/ai/anomalies so it can be
// reused by anomalyDetection.cron.js (same split as kpiNarrator.js /
// kpiDigest.cron.js) — the route stays a thin wrapper over detectAnomalies().
import pool from '../../config/db.js';
import { EMPLOYEE_ACTIVE, isIn } from '../../shared/statusSets.js';

const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const stdDev = (arr) => {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length || 1));
};

/**
 * SIGMA_THRESHOLD and MIN_SAMPLE must be chosen together.
 *
 * With POPULATION standard deviation the largest z-score any single point can
 * attain in a sample of n is (n-1)/sqrt(n). That is 1.79 at n=5 and 2.47 at n=8,
 * both below a 2.5-sigma gate — so the old `rows.length >= 5` guard admitted
 * samples in which the detector was ARITHMETICALLY INCAPABLE of firing, and
 * reported "no anomalies" over them. MIN_SAMPLE is now derived from the
 * threshold rather than guessed, and a sample below it is reported as
 * insufficient rather than clean.
 */
const SIGMA_THRESHOLD = 2.5;
const minSampleFor = (sigma) => {
  for (let n = 3; n <= 1000; n++) if ((n - 1) / Math.sqrt(n) > sigma) return n;
  return 1000;
};
export const MIN_SAMPLE = minSampleFor(SIGMA_THRESHOLD); // 9 at 2.5 sigma

/**
 * detectAnomalies(companyId)
 *
 * All five detectors are now tenant-scoped. They previously ran unfiltered across
 * every company, and two of them could never fire at all:
 *   - the invoice detector selected `client_name`, a column that does not exist
 *     on `invoices`, so the query threw and the empty catch swallowed it;
 *   - the attendance detector filtered `e.status='active'` case-sensitively,
 *     which matches nothing because the app writes 'Active'.
 * Both are fixed below.
 */
export async function detectAnomalies(companyId = null) {
  const anomalies = [];
  const cid = companyId ?? null;
  /** Detectors that could not run, or could not have fired, with the reason. */
  const notAssessed = [];

  // 1. Invoice outliers (>2.5σ from 90-day mean)
  try {
    // Customer name comes from `parties` — `invoices.client_name` has never
    // existed, and selecting it made this detector fail silently on every run.
    const { rows } = await pool.query(
      `SELECT i.id, i.invoice_number, COALESCE(pt.name, 'Unknown') AS client_name, i.total_amount
         FROM invoices i
         LEFT JOIN parties pt ON pt.id = i.customer_id
        WHERE i.invoice_date >= NOW()-INTERVAL '90 days'
          AND ($1::int IS NULL OR i.company_id = $1)`, [cid]);
    if (rows.length < MIN_SAMPLE) {
      notAssessed.push({
        detector: 'Invoice Amount Outlier',
        reason: `only ${rows.length} invoice(s) in the last 90 days; at least ${MIN_SAMPLE} are needed before a ${SIGMA_THRESHOLD}-sigma test can flag anything`,
      });
    } else {
      const amounts = rows.map(r => parseFloat(r.total_amount));
      const m = mean(amounts), sd = stdDev(amounts);
      rows.forEach(r => {
        const amt = parseFloat(r.total_amount);
        if (sd > 0 && Math.abs(amt - m) > SIGMA_THRESHOLD * sd) {
          anomalies.push({ type:'Invoice Amount Outlier', severity: amt > m ? 'high' : 'medium',
            description:`Invoice ${r.invoice_number} ₹${(amt/100000).toFixed(2)}L is ${((Math.abs(amt-m)/sd)).toFixed(1)}σ from mean (₹${(m/100000).toFixed(2)}L)`,
            affected_id:r.id, affected_name:r.client_name, variance_amount:Math.round(Math.abs(amt-m)), detected_at:new Date().toISOString() });
        }
      });
    }
  } catch (_) {}

  // 2. Low attendance (<75% this month)
  try {
    const { rows } = await pool.query(`
      SELECT e.id,e.name,e.department,
             COUNT(a.id) FILTER (WHERE LOWER(a.status)='present') AS pdays, COUNT(a.id) AS tdays
      FROM employees e LEFT JOIN attendance a ON a.employee_id=e.id
        AND DATE_TRUNC('month',a.date)=DATE_TRUNC('month',CURRENT_DATE)
      WHERE ${isIn('e.status', EMPLOYEE_ACTIVE)}
        AND ($1::int IS NULL OR e.company_id = $1)
      GROUP BY e.id,e.name,e.department
      HAVING COUNT(a.id)>0 AND COUNT(a.id) FILTER(WHERE LOWER(a.status)='present')::float/COUNT(a.id)<0.75
    `, [cid]);
    rows.forEach(r => {
      const pct = Math.round(parseInt(r.pdays)/parseInt(r.tdays)*100);
      anomalies.push({ type:'Low Attendance', severity: pct<60?'high':'medium',
        description:`${r.name} (${r.department}) attendance ${pct}% this month (${r.pdays}/${r.tdays} days)`,
        affected_id:r.id, affected_name:r.name, variance_amount:0, detected_at:new Date().toISOString() });
    });
  } catch (_) {}

  // 3. PO price >20% above 3-month avg
  try {
    // Table and columns corrected: `po_items` has never existed. The real line-item
    // table is `purchase_order_items`, and its columns are po_id / item_id / rate —
    // not purchase_order_id / item_name / unit_price. The query threw on every run
    // and the catch swallowed it, so this detector had never once fired. Rewritten
    // as an average per item rather than a self-join, which also removes an O(n^2)
    // cross product that would have been the slowest query in the module.
    const { rows } = await pool.query(`
      WITH priced AS (
        SELECT poi.id,
               COALESCE(ii.item_name, 'Item ' || poi.item_id::text) AS item_name,
               poi.rate AS unit_price,
               poi.po_id AS purchase_order_id
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.po_id
        LEFT JOIN inventory_items ii ON ii.id = poi.item_id
        WHERE po.created_at >= NOW() - INTERVAL '90 days'
          AND poi.rate > 0
          AND ($1::int IS NULL OR po.company_id = $1)
      )
      SELECT p.id, p.item_name, p.unit_price, p.purchase_order_id,
             AVG(p.unit_price) OVER (PARTITION BY p.item_name) AS avg_price
      FROM priced p
    `, [cid]).catch(()=>({rows:[]}));
    const seen = new Set();
    rows.forEach(r => {
      const v = (parseFloat(r.unit_price)-parseFloat(r.avg_price))/parseFloat(r.avg_price);
      if (v>0.2 && !seen.has(r.item_name)) {
        seen.add(r.item_name);
        anomalies.push({ type:'PO Price Variance', severity:v>0.4?'high':'medium',
          description:`${r.item_name} bought at ₹${parseFloat(r.unit_price).toFixed(2)} — ${Math.round(v*100)}% above avg (₹${parseFloat(r.avg_price).toFixed(2)})`,
          affected_id:r.purchase_order_id, affected_name:r.item_name,
          variance_amount:Math.round((parseFloat(r.unit_price)-parseFloat(r.avg_price))*100), detected_at:new Date().toISOString() });
      }
    });
  } catch (_) {}

  // 4. Payroll TDS mismatch (>10%)
  try {
    const { rows } = await pool.query(`
      -- Columns corrected. This referenced pr.tds_deducted, pr.computed_tds and
      -- pr.month_year, none of which exist on payroll_runs — so the query threw and
      -- the catch swallowed it, meaning this detector had never once fired. The
      -- real columns are tds (deducted this run) and annual_tax (the computed
      -- annual liability); one twelfth of the latter is the expected monthly
      -- deduction, and month/year are separate integer columns.
      SELECT pr.id, e.name,
             pr.tds                         AS tds_deducted,
             ROUND(pr.annual_tax / 12.0, 2) AS computed_tds
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE pr.annual_tax > 0
        AND ABS(pr.tds - (pr.annual_tax / 12.0)) / (pr.annual_tax / 12.0) > 0.10
        AND make_date(pr.year, pr.month, 1) >= date_trunc('month', NOW() - INTERVAL '1 month')
        AND ($1::int IS NULL OR e.company_id = $1)
    `, [cid]).catch(()=>({rows:[]}));
    rows.forEach(r => {
      const diff = Math.abs(parseFloat(r.tds_deducted)-parseFloat(r.computed_tds));
      const pct  = Math.round(diff/parseFloat(r.computed_tds)*100);
      anomalies.push({ type:'TDS Mismatch', severity:pct>25?'high':'low',
        description:`${r.name} TDS recorded ₹${parseFloat(r.tds_deducted).toFixed(0)} vs computed ₹${parseFloat(r.computed_tds).toFixed(0)} (${pct}% diff)`,
        affected_id:r.id, affected_name:r.name, variance_amount:Math.round(diff), detected_at:new Date().toISOString() });
    });
  } catch (_) {}

  // 5. Recent PQ / production test failures (last 7 days)
  try {
    const { rows } = await pool.query(`
      SELECT id, run_number, product_name, serial_number, test_stage, completed_at,
        (SELECT COUNT(*)::INT FROM test_run_measurements
         WHERE test_run_id = test_runs.id AND result = 'fail') AS fail_count
      FROM test_runs
      -- The comment that used to sit here said "test_runs carries no company_id",
      -- and left the detector unscoped on that basis. test_runs DOES carry
      -- company_id (verified against information_schema), so this was the only
      -- one of the five detectors reading across tenants — on a false premise
      -- written into the code, which is the hardest kind to notice.
      WHERE LOWER(overall_result) = 'fail'
        AND completed_at >= NOW() - INTERVAL '7 days'
        AND ($1::int IS NULL OR company_id = $1)
      ORDER BY completed_at DESC LIMIT 10
    `, [cid]).catch(() => ({ rows: [] }));
    rows.forEach(r => {
      const fc = parseInt(r.fail_count || 0);
      anomalies.push({
        type: 'PQ Test Failure', severity: fc >= 3 ? 'high' : 'medium',
        description: `${r.test_stage} run ${r.run_number} failed — ${r.product_name || 'Unknown'} S/N ${r.serial_number || 'N/A'} (${fc} measurement${fc !== 1 ? 's' : ''} out of spec)`,
        affected_id: r.id, affected_name: r.product_name || 'Unknown Product',
        variance_amount: fc,
        detected_at: r.completed_at ? new Date(r.completed_at).toISOString() : new Date().toISOString(),
      });
    });
  } catch (_) {}

  anomalies.sort((a, b) => ({ high:0,medium:1,low:2 }[a.severity] - { high:0,medium:1,low:2 }[b.severity]));
  // `notAssessed` is deliberately attached to the array rather than returned as a
  // tuple, so every existing caller keeps working while a caller that cares can
  // tell "nothing was wrong" apart from "we could not tell".
  Object.defineProperty(anomalies, 'notAssessed', { value: notAssessed, enumerable: false });
  return anomalies;
}
