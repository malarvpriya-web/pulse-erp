// backend/src/modules/intelligence/anomalyDetector.js
// Anomaly detection logic, extracted from GET /api/ai/anomalies so it can be
// reused by anomalyDetection.cron.js (same split as kpiNarrator.js /
// kpiDigest.cron.js) — the route stays a thin wrapper over detectAnomalies().
import pool from '../../config/db.js';

const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const stdDev = (arr) => {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length || 1));
};

export async function detectAnomalies() {
  const anomalies = [];

  // 1. Invoice outliers (>2.5σ from 90-day mean)
  try {
    const { rows } = await pool.query(`SELECT id,invoice_number,client_name,total_amount FROM invoices WHERE invoice_date >= NOW()-INTERVAL '90 days'`);
    if (rows.length >= 5) {
      const amounts = rows.map(r => parseFloat(r.total_amount));
      const m = mean(amounts), sd = stdDev(amounts);
      rows.forEach(r => {
        const amt = parseFloat(r.total_amount);
        if (Math.abs(amt - m) > 2.5 * sd) {
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
             COUNT(a.id) FILTER (WHERE a.status='present') AS pdays, COUNT(a.id) AS tdays
      FROM employees e LEFT JOIN attendance a ON a.employee_id=e.id
        AND DATE_TRUNC('month',a.date)=DATE_TRUNC('month',CURRENT_DATE)
      WHERE e.status='active' GROUP BY e.id,e.name,e.department
      HAVING COUNT(a.id)>0 AND COUNT(a.id) FILTER(WHERE a.status='present')::float/COUNT(a.id)<0.75
    `);
    rows.forEach(r => {
      const pct = Math.round(parseInt(r.pdays)/parseInt(r.tdays)*100);
      anomalies.push({ type:'Low Attendance', severity: pct<60?'high':'medium',
        description:`${r.name} (${r.department}) attendance ${pct}% this month (${r.pdays}/${r.tdays} days)`,
        affected_id:r.id, affected_name:r.name, variance_amount:0, detected_at:new Date().toISOString() });
    });
  } catch (_) {}

  // 3. PO price >20% above 3-month avg
  try {
    const { rows } = await pool.query(`
      SELECT pi.id,pi.item_name,pi.unit_price,pi.purchase_order_id,
             AVG(pi2.unit_price) OVER (PARTITION BY pi.item_name) AS avg_price
      FROM po_items pi JOIN po_items pi2 ON pi2.item_name=pi.item_name
      JOIN purchase_orders po ON po.id=pi.purchase_order_id
      WHERE po.created_at>=NOW()-INTERVAL '90 days'
    `).catch(()=>({rows:[]}));
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
      SELECT pr.id,e.name,pr.tds_deducted,pr.computed_tds FROM payroll_runs pr
      JOIN employees e ON e.id=pr.employee_id
      WHERE pr.computed_tds>0 AND ABS(pr.tds_deducted-pr.computed_tds)/pr.computed_tds>0.10
      AND pr.month_year>=TO_CHAR(NOW()-INTERVAL '1 month','YYYY-MM')
    `).catch(()=>({rows:[]}));
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
      WHERE overall_result = 'fail'
        AND completed_at >= NOW() - INTERVAL '7 days'
      ORDER BY completed_at DESC LIMIT 10
    `).catch(() => ({ rows: [] }));
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
  return anomalies;
}
