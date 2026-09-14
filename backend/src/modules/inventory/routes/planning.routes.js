// backend/src/modules/inventory/routes/planning.routes.js
//
// Inventory planning + demand forecasting endpoints.
//
// Mounted at /api/inventory/planning. Everything here is company-scoped through
// companyOf(req) — never req.user.company_id, which fails OPEN across tenants
// for tokens minted before the claim existed (see shared/scope.js).

import express from 'express';
import pool from '../../shared/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';
import planning from '../services/inventoryPlanning.service.js';
import forecasting from '../services/demandForecast.service.js';
import causal from '../services/causalForecast.service.js';

const router = express.Router();
const actorOf = (req) => ({ id: req.user?.id ?? null, name: req.user?.name || req.user?.username || 'System' });

// ── Planning policy ──────────────────────────────────────────────────────────

router.get('/settings', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    res.json(await planning.getPlanningSettings(companyOf(req)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    if (cid == null) return res.status(400).json({ error: 'A company scope is required to set planning policy.' });
    res.json(await planning.updatePlanningSettings(cid, req.body || {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Parameter recomputation ──────────────────────────────────────────────────

/* POST /inventory/planning/recompute  { apply?: boolean } */
router.post('/recompute', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const result = await planning.recomputePlanningParameters({
      companyId: companyOf(req),
      apply: req.body?.apply === undefined ? null : Boolean(req.body.apply),
      actor: actorOf(req),
    });
    res.json(result);
  } catch (e) { console.error('[planning/recompute]', e); res.status(500).json({ error: e.message }); }
});

router.get('/runs', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM inventory_planning_runs
        WHERE ($1::int IS NULL OR company_id = $1)
        ORDER BY created_at DESC LIMIT 50`, [companyOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/runs/:id', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows: [run] } = await pool.query(
      `SELECT * FROM inventory_planning_runs WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const { rows: items } = await pool.query(
      `SELECT * FROM inventory_planning_run_items WHERE run_id = $1 ORDER BY annual_consumption_value DESC NULLS LAST`,
      [run.id]);
    res.json({ run, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* The live policy per item: what is stored, what was calculated, and which the
   planner has pinned. One screen answering "why is this number this number". */
router.get('/parameters', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, item_code, item_name, unit_of_measure, current_stock,
             lead_time_days, annual_demand, avg_daily_demand, demand_stddev, demand_cv,
             demand_periods_observed, eoq,
             safety_stock, safety_stock_calculated, COALESCE(safety_stock_source,'calculated')  AS safety_stock_source,
             reorder_level, reorder_point_calculated, COALESCE(reorder_point_source,'calculated') AS reorder_point_source,
             abc_class, abc_class_calculated, annual_consumption_value,
             service_level_pct, service_level_z, planning_params_computed_at
        FROM inventory_items
       WHERE ($1::int IS NULL OR company_id = $1)
         AND COALESCE(is_active,true) = true AND deleted_at IS NULL
       ORDER BY annual_consumption_value DESC NULLS LAST, item_name`, [companyOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Pin or unpin a parameter. Pinning is what lets a planner disagree with the
   model without the next recompute quietly overruling them. */
router.put('/parameters/:itemId', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { safety_stock, reorder_level, safety_stock_source, reorder_point_source, lead_time_days } = req.body || {};
    const sets = [], vals = [req.params.itemId, companyOf(req)];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (safety_stock        !== undefined) { push('safety_stock', safety_stock);   push('safety_stock_source', 'manual'); }
    if (reorder_level       !== undefined) { push('reorder_level', reorder_level); push('reorder_point_source', 'manual'); }
    if (safety_stock_source  !== undefined) push('safety_stock_source', safety_stock_source);
    if (reorder_point_source !== undefined) push('reorder_point_source', reorder_point_source);
    if (lead_time_days       !== undefined) push('lead_time_days', lead_time_days);
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    // Releasing a pin restores the calculated figure immediately rather than
    // leaving the stale manual number in place until the next recompute.
    const restore = [];
    if (safety_stock_source === 'calculated')  restore.push(`safety_stock  = COALESCE(safety_stock_calculated,  safety_stock)`);
    if (reorder_point_source === 'calculated') restore.push(`reorder_level = COALESCE(reorder_point_calculated, reorder_level)`);

    const { rows: [row] } = await pool.query(
      `UPDATE inventory_items SET ${[...sets, ...restore].join(', ')}, updated_at = NOW()
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`, vals);
    if (!row) return res.status(404).json({ error: 'Item not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stock reconciliation ─────────────────────────────────────────────────────
// inventory_items.current_stock must equal the stock ledger's balance. The audit
// found them 100% divergent — every item's ledger balance was 0 while
// current_stock read 10006 / 12 / 8 / 15 / 3 — because seeding scripts and a
// couple of integration-test teardowns wrote current_stock directly, with no
// ledger row. MRP, valuation, ATP and allocation all read current_stock, so a
// silent divergence there is wrong answers everywhere downstream.
//
// Making the invariant CHECKABLE matters more than any one repair: a number that
// can drift undetected will drift again.

router.get('/reconciliation', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ii.id, ii.item_code, ii.item_name,
             COALESCE(ii.current_stock,0)::numeric                      AS current_stock,
             COALESCE(SUM(sl.quantity_in - sl.quantity_out),0)::numeric AS ledger_balance,
             (COALESCE(ii.current_stock,0) -
              COALESCE(SUM(sl.quantity_in - sl.quantity_out),0))::numeric AS divergence,
             COUNT(sl.id)::int                                          AS ledger_rows
        FROM inventory_items ii
        LEFT JOIN stock_ledger sl ON sl.item_id = ii.id
       WHERE ($1::int IS NULL OR ii.company_id = $1)
         AND ii.deleted_at IS NULL
       GROUP BY ii.id, ii.item_code, ii.item_name, ii.current_stock
      HAVING COALESCE(ii.current_stock,0)
             <> COALESCE(SUM(sl.quantity_in - sl.quantity_out),0)
       ORDER BY ABS(COALESCE(ii.current_stock,0) -
                    COALESCE(SUM(sl.quantity_in - sl.quantity_out),0)) DESC`, [companyOf(req)]);
    res.json({
      reconciled: rows.length === 0,
      diverging_items: rows.length,
      items: rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /inventory/planning/reconcile — close the gap with a documented adjustment.
   The difference is booked as an adjustment MOVEMENT rather than by overwriting
   either side. Silently setting current_stock to the ledger balance would
   destroy a quantity that may physically be on the shelf, and silently trusting
   current_stock would leave the gap unexplained; an adjustment row states the
   discrepancy, dates it, and leaves both figures reconcilable afterwards. This
   is the same thing a physical count does, and it is why the repair is itself
   auditable. */
router.post('/reconcile', requirePermission('inventory', 'approve'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cid = companyOf(req);
    const { rows } = await client.query(`
      SELECT ii.id, ii.item_code, COALESCE(ii.current_stock,0) AS current_stock,
             COALESCE(SUM(sl.quantity_in - sl.quantity_out),0) AS ledger_balance
        FROM inventory_items ii
        LEFT JOIN stock_ledger sl ON sl.item_id = ii.id
       WHERE ($1::int IS NULL OR ii.company_id = $1) AND ii.deleted_at IS NULL
       GROUP BY ii.id, ii.item_code, ii.current_stock
      HAVING COALESCE(ii.current_stock,0)
             <> COALESCE(SUM(sl.quantity_in - sl.quantity_out),0)
       FOR UPDATE OF ii`, [cid]);

    const fixed = [];
    for (const r of rows) {
      const delta = parseFloat(r.current_stock) - parseFloat(r.ledger_balance);
      await client.query(`
        INSERT INTO stock_ledger
          (item_id, transaction_type, quantity_in, quantity_out, balance_qty, rate, value,
           reference_type, transaction_date, remarks, company_id)
        VALUES ($1,'adjustment',$2,$3,$4,0,0,'reconciliation',CURRENT_DATE,$5,$6)`,
        [r.id, delta > 0 ? delta : 0, delta < 0 ? -delta : 0, r.current_stock,
         `Reconciliation: on-hand was ${r.current_stock}, ledger ${r.ledger_balance}`, cid]);
      fixed.push({ item_id: r.id, item_code: r.item_code,
        was: parseFloat(r.current_stock), ledger: parseFloat(r.ledger_balance), adjustment: delta });
    }
    await client.query('COMMIT');
    res.json({ reconciled: fixed.length, items: fixed });
  } catch (e) {
    await client.query('ROLLBACK'); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── ABC ──────────────────────────────────────────────────────────────────────

router.get('/abc', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT abc_class AS category, COUNT(*)::int AS item_count,
             COALESCE(SUM(annual_consumption_value),0)::numeric AS value,
             COALESCE(SUM(current_stock * COALESCE(standard_cost,0)),0)::numeric AS stock_value
        FROM inventory_items
       WHERE ($1::int IS NULL OR company_id = $1)
         AND COALESCE(is_active,true) = true AND deleted_at IS NULL AND abc_class IS NOT NULL
       GROUP BY abc_class ORDER BY abc_class`, [companyOf(req)]);
    const { rows: items } = await pool.query(`
      SELECT id, item_code, item_name, abc_class, annual_consumption_value, annual_demand, current_stock
        FROM inventory_items
       WHERE ($1::int IS NULL OR company_id = $1)
         AND COALESCE(is_active,true) = true AND deleted_at IS NULL AND abc_class IS NOT NULL
       ORDER BY annual_consumption_value DESC NULLS LAST`, [companyOf(req)]);
    res.json({ summary: rows, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Demand forecasting ───────────────────────────────────────────────────────

/* POST /inventory/planning/forecast/run */
router.post('/forecast/run', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { horizon_periods, lookback_days, method, holdout } = req.body || {};
    const result = await forecasting.runDemandForecast({
      companyId: companyOf(req),
      horizonPeriods: parseInt(horizon_periods, 10) || 6,
      lookbackDays:   parseInt(lookback_days, 10)   || 730,
      method:         method || 'auto',
      holdout:        parseInt(holdout, 10) || 3,
      actor: actorOf(req),
    });
    res.json(result);
  } catch (e) { console.error('[planning/forecast]', e); res.status(500).json({ error: e.message }); }
});

router.get('/forecast/runs', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM demand_forecast_runs WHERE ($1::int IS NULL OR company_id = $1)
        ORDER BY created_at DESC LIMIT 50`, [companyOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* The forecast grid: what the model said, what it is now, and whether a human
   has touched it. */
router.get('/forecast', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { status, item_id } = req.query;
    const vals = [companyOf(req)];
    let where = `($1::int IS NULL OR df.company_id = $1)`;
    if (status)  { vals.push(status);  where += ` AND df.status = $${vals.length}`; }
    if (item_id) { vals.push(item_id); where += ` AND df.item_id = $${vals.length}`; }
    const { rows } = await pool.query(`
      SELECT df.*, ii.item_code, ii.unit_of_measure
        FROM demand_forecasts df
        LEFT JOIN inventory_items ii ON ii.id = df.item_id
       WHERE ${where}
       ORDER BY COALESCE(df.period_start, df.forecast_date), ii.item_code`, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Approving is what turns a statistical draft into planning input. MRP consumes
   approved and manually-entered forecasts, never raw drafts. */
router.post('/forecast/approve', requirePermission('inventory', 'approve'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    const runId = req.body?.run_id ?? null;
    if (!ids && !runId) return res.status(400).json({ error: 'ids or run_id is required' });
    const vals = [companyOf(req), req.user?.id ?? null, actorOf(req).name];
    let filter;
    if (ids) { vals.push(ids); filter = `df.id = ANY($${vals.length}::int[])`; }
    else     { vals.push(runId); filter = `df.run_id = $${vals.length}`; }
    const { rows } = await pool.query(`
      UPDATE demand_forecasts df
         SET status = 'approved', approved_by = $2, approved_by_name = $3, approved_at = NOW()
       WHERE ($1::int IS NULL OR df.company_id = $1) AND ${filter} AND df.status = 'draft'
       RETURNING df.id`, vals);
    res.json({ approved: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* A planner's revision. The model's number is preserved in forecast_qty so the
   override stays visible and accuracy keeps measuring the model, not the human. */
router.put('/forecast/:id', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { quantity, notes } = req.body || {};
    if (quantity === undefined) return res.status(400).json({ error: 'quantity is required' });
    const { rows: [row] } = await pool.query(`
      UPDATE demand_forecasts
         SET quantity = $3, is_manual_override = true, version = COALESCE(version,1) + 1,
             notes = COALESCE($4, notes), updated_at = NOW()
       WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`,
      [req.params.id, companyOf(req), quantity, notes ?? null]);
    if (!row) return res.status(404).json({ error: 'Forecast not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/forecast/measure-accuracy', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    res.json(await forecasting.measureForecastAccuracy({ companyId: companyOf(req) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Accuracy analytics: MAPE / MAD / bias per item and per method. */
router.get('/forecast/accuracy', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const [byItem, byMethod] = await Promise.all([
      pool.query(`
        SELECT item_id, item_code, item_name, method,
               COUNT(*)::int AS periods,
               ROUND(AVG(pct_error)::numeric, 2) AS mape,
               ROUND(AVG(abs_error)::numeric, 3) AS mad,
               ROUND(AVG(bias)::numeric, 3)      AS bias
          FROM demand_forecast_accuracy
         WHERE ($1::int IS NULL OR company_id = $1)
         GROUP BY item_id, item_code, item_name, method
         ORDER BY mape NULLS LAST`, [cid]),
      pool.query(`
        SELECT method, COUNT(*)::int AS periods,
               ROUND(AVG(pct_error)::numeric, 2) AS mape,
               ROUND(AVG(abs_error)::numeric, 3) AS mad,
               ROUND(AVG(bias)::numeric, 3)      AS bias
          FROM demand_forecast_accuracy
         WHERE ($1::int IS NULL OR company_id = $1)
         GROUP BY method ORDER BY mape NULLS LAST`, [cid]),
    ]);
    res.json({ by_item: byItem.rows, by_method: byMethod.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Demand drivers (causal forecasting) ──────────────────────────────────────
// A driver is a leading indicator whose movement explains demand. Registering
// one is what turns causal forecasting from a missing capability into a
// configuration step.

router.get('/drivers', requirePermission('inventory', 'view'), async (req, res) => {
  try { res.json(await causal.listDrivers(companyOf(req))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/drivers', requirePermission('inventory', 'edit'), async (req, res) => {
  try { res.status(201).json(await causal.upsertDriver(companyOf(req), req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* Populate the drivers Pulse can derive from its own data — opportunity and
   tender pipeline, both of which lead shipped demand. */
router.post('/drivers/sync', requirePermission('inventory', 'edit'), async (req, res) => {
  try { res.json(await causal.syncInternalDrivers(companyOf(req), req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/drivers/:id/values', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const values = Array.isArray(req.body?.values) ? req.body.values : [];
    res.json(await causal.setDriverValues(req.params.id, companyOf(req), values));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/drivers/:id/values', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT period_start::text AS period_start, value, is_actual
         FROM forecast_driver_values WHERE driver_id = $1 ORDER BY period_start`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Attach a driver to an item's demand model, then re-run the forecast to fit it. */
router.post('/items/:itemId/drivers', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { driver_id } = req.body || {};
    if (!driver_id) return res.status(400).json({ error: 'driver_id is required' });
    res.status(201).json(await causal.attachDriver(companyOf(req), req.params.itemId, driver_id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/items/:itemId/drivers/:driverId', requirePermission('inventory', 'edit'), async (req, res) => {
  try { res.json(await causal.detachDriver(req.params.itemId, req.params.driverId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* The fitted models: coefficient and R-squared per item/driver. The coefficient
   is the statement "one more unit of driver is this much demand", which a
   planner can sanity-check in a way they cannot check a smoothing constant. */
router.get('/drivers/fits', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT idd.*, ii.item_code, ii.item_name, d.driver_code, d.driver_name, d.lag_periods
        FROM item_demand_drivers idd
        JOIN inventory_items ii ON ii.id = idd.item_id
        JOIN forecast_drivers d ON d.id = idd.driver_id
       WHERE ($1::int IS NULL OR idd.company_id = $1)
       ORDER BY idd.r_squared DESC NULLS LAST`, [companyOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
