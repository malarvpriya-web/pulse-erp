// backend/src/modules/production/crp.routes.js
//
// Capacity Requirements Planning workbench API:
//   - Run CRP, browse run history + the work-centre × bucket load grid
//   - Maintain work-centre capacity attributes (efficiency, days/week, machines)
//   - Dashboard KPIs (overloaded work centres, peak load)

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { runCRP } from './crpEngine.service.js';

const router = Router();
const actor = (req) => ({ id: req.user?.userId || req.user?.id || null, name: req.user?.name || req.user?.email || 'System' });
const cidOf = (req) => (req.scope?.company_id != null ? req.scope.company_id : null);

/* POST /crp/run */
router.post('/run', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const { horizon_days = 84, bucket_days = 7, include_planned = true } = req.body || {};
    const result = await runCRP({
      companyId: cidOf(req),
      horizonDays: Math.max(1, Math.min(365, parseInt(horizon_days, 10) || 84)),
      bucketDays: Math.max(1, Math.min(31, parseInt(bucket_days, 10) || 7)),
      includePlanned: !!include_planned,
      actor: actor(req),
    });
    res.json({
      run: result.run,
      buckets: result.buckets,
      work_centres: result.workCentres,
      load: result.load,
      summary: {
        work_centres: result.workCentres.length,
        buckets: result.buckets.length,
        overloaded_buckets: result.run.overloaded_count,
        peak_load_pct: result.run.peak_load_pct,
      },
    });
  } catch (e) { console.error('[crp/run]', e); res.status(500).json({ error: e.message }); }
});

/* GET /crp/runs */
router.get('/runs', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { rows } = await pool.query(
      `SELECT * FROM crp_runs WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
       ORDER BY created_at DESC LIMIT 100`, [cid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /crp/runs/:id — run header + full load grid */
router.get('/runs/:id', requirePermission('production', 'view'), async (req, res) => {
  try {
    const [run, load] = await Promise.all([
      pool.query(`SELECT * FROM crp_runs WHERE id = $1`, [req.params.id]),
      pool.query(`SELECT * FROM crp_load WHERE run_id = $1 ORDER BY work_centre_name, bucket_index`, [req.params.id]),
    ]);
    if (!run.rows[0]) return res.status(404).json({ error: 'Run not found' });
    res.json({ run: run.rows[0], load: load.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /crp/load?run_id=&work_centre_id=&overloaded=1 */
router.get('/load', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { run_id, work_centre_id, overloaded } = req.query;
    if (!run_id) return res.status(400).json({ error: 'run_id required' });
    const where = ['run_id = $1'], vals = [run_id];
    if (work_centre_id) { vals.push(work_centre_id); where.push(`work_centre_id = $${vals.length}`); }
    if (overloaded === '1' || overloaded === 'true') where.push('is_overloaded = TRUE');
    const { rows } = await pool.query(
      `SELECT * FROM crp_load WHERE ${where.join(' AND ')} ORDER BY work_centre_name, bucket_index`, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /crp/work-centre-capacity — list work centres with capacity attributes */
router.get('/work-centre-capacity', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { rows } = await pool.query(`
      SELECT id, name, machine, department, status,
             COALESCE(capacity_hours_per_day,8) capacity_hours_per_day,
             COALESCE(efficiency_pct,100) efficiency_pct,
             COALESCE(working_days_per_week,5) working_days_per_week,
             COALESCE(num_machines,1) num_machines,
             COALESCE(cost_per_hour,0) cost_per_hour
        FROM work_centres
       WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
       ORDER BY name`, [cid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* PUT /crp/work-centre-capacity/:id */
router.put('/work-centre-capacity/:id', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const f = req.body || {};
    const { rows: [row] } = await pool.query(`
      UPDATE work_centres SET
        capacity_hours_per_day = COALESCE($2, capacity_hours_per_day),
        efficiency_pct         = COALESCE($3, efficiency_pct),
        working_days_per_week  = COALESCE($4, working_days_per_week),
        num_machines           = COALESCE($5, num_machines),
        cost_per_hour          = COALESCE($6, cost_per_hour),
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, capacity_hours_per_day, efficiency_pct, working_days_per_week, num_machines, cost_per_hour`,
      [req.params.id, f.capacity_hours_per_day, f.efficiency_pct, f.working_days_per_week, f.num_machines, f.cost_per_hour]);
    if (!row) return res.status(404).json({ error: 'Work centre not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /crp/dashboard — latest run KPIs + per-work-centre peak load */
router.get('/dashboard', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { rows: [last] } = await pool.query(
      `SELECT * FROM crp_runs WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
       ORDER BY created_at DESC LIMIT 1`, [cid]);
    let workCentres = [];
    if (last) {
      const { rows } = await pool.query(`
        SELECT work_centre_id, work_centre_name,
               MAX(load_pct) peak_load_pct,
               ROUND(AVG(load_pct),1) avg_load_pct,
               SUM(required_hours) total_required_hrs,
               SUM(available_hours) total_available_hrs,
               COUNT(*) FILTER (WHERE is_overloaded)::int overloaded_buckets
          FROM crp_load WHERE run_id = $1
         GROUP BY work_centre_id, work_centre_name
         ORDER BY peak_load_pct DESC`, [last.id]);
      workCentres = rows;
    }
    res.json({ last_run: last || null, work_centres: workCentres });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
