import cron from 'node-cron';
import pool from '../config/db.js';

// The EVM S-Curve table/chart (project_scurve_data, GET /projects/:id/scurve)
// existed but nothing ever wrote a row to it — the chart was permanently
// empty. This snapshots one row per project per calendar month, reusing the
// EVM figures projectCostRollup.service.js already computes into
// project_cost_summary (planned_value/earned_value/actual_cost_evm) rather
// than re-deriving them, plus a linear time-elapsed "planned progress"
// baseline from the project's own start/end dates.
async function runScurveSnapshot() {
  const { rows: projects } = await pool.query(
    `SELECT p.id, p.start_date, p.end_date, p.progress_percentage,
            COALESCE(NULLIF(p.budget, 0), NULLIF(p.budget_amount, 0), 0) AS budget,
            cs.planned_value, cs.earned_value, cs.actual_cost_evm, cs.total_cost
     FROM projects p
     LEFT JOIN project_cost_summary cs ON cs.project_id = p.id
     WHERE p.deleted_at IS NULL
       AND p.status NOT IN ('cancelled')`
  );

  const period = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

  for (const p of projects) {
    const budget = parseFloat(p.budget || 0);
    let plannedProgress = 0;
    if (p.start_date && p.end_date) {
      const start = new Date(p.start_date).getTime();
      const end = new Date(p.end_date).getTime();
      if (end > start) {
        plannedProgress = Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100));
      }
    }
    const actualProgress = parseFloat(p.progress_percentage || 0);
    const plannedCost = p.planned_value != null ? parseFloat(p.planned_value) : budget * plannedProgress / 100;
    const actualCost  = p.actual_cost_evm != null ? parseFloat(p.actual_cost_evm) : parseFloat(p.total_cost || 0);
    const earnedValue = p.earned_value != null ? parseFloat(p.earned_value) : budget * actualProgress / 100;

    await pool.query(
      `INSERT INTO project_scurve_data
         (project_id, period, planned_cost, actual_cost, planned_progress, actual_progress, earned_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (project_id, period) DO UPDATE SET
         planned_cost      = EXCLUDED.planned_cost,
         actual_cost       = EXCLUDED.actual_cost,
         planned_progress  = EXCLUDED.planned_progress,
         actual_progress   = EXCLUDED.actual_progress,
         earned_value      = EXCLUDED.earned_value,
         updated_at        = NOW()`,
      [p.id, period, plannedCost, actualCost, plannedProgress, actualProgress, earnedValue]
    );
  }
}

export function startScurveSnapshotCron() {
  // Daily at 02:00 server local time. Upserted on (project_id, period), so
  // running daily just keeps the current month's point fresh — the S-Curve
  // accumulates one real point per project per month over time.
  cron.schedule('0 2 * * *', () => {
    runScurveSnapshot().catch((err) =>
      console.error('[scurveSnapshotCron] failed:', err.message)
    );
  });
  console.log('📈 Project S-Curve snapshot cron started (daily 02:00)');
}

export { runScurveSnapshot };
