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
import { logAudit } from '../../../services/AuditService.js';
import planning from '../services/inventoryPlanning.service.js';
import ledgerSemantics from '../services/ledgerSemantics.js';
import { computeInventoryKpis } from '../services/inventoryKpi.service.js';
import forecasting from '../services/demandForecast.service.js';
import causal from '../services/causalForecast.service.js';
import projection from '../services/inventoryProjection.service.js';

const router = express.Router();
const actorOf = (req) => ({ id: req.user?.id ?? null, name: req.user?.name || req.user?.username || 'System' });

// ── Planning policy ──────────────────────────────────────────────────────────

router.get('/settings', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const settings = await planning.getPlanningSettings(cid);
    // Inventory Settings once stored ABC cutoffs in company_settings that the
    // engine never read. Where a company still has such values and they differ
    // from what is in force, report them rather than adopt or discard them —
    // which set is right is the company's call.
    let legacy = null;
    if (cid != null) {
      const { rows: [blob] } = await pool.query(
        `SELECT settings->>'abc_a_threshold' AS a, settings->>'abc_b_threshold' AS b
           FROM company_settings WHERE company_id = $1 AND module = 'inventory'`, [cid]);
      const a = blob?.a == null ? null : Number(blob.a);
      const b = blob?.b == null ? null : Number(blob.b);
      if ((a != null && a !== Number(settings.abc_a_threshold_pct)) ||
          (b != null && b !== Number(settings.abc_b_threshold_pct))) {
        legacy = { abc_a_threshold: a, abc_b_threshold: b, applied: false,
                   note: 'Saved from Inventory Settings before it was connected to the engine; never used for classification.' };
      }
    }
    res.json({ ...settings, legacy_inventory_settings: legacy });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    if (cid == null) return res.status(400).json({ error: 'A company scope is required to set planning policy.' });
    const before = await planning.getPlanningSettings(cid);
    const after = await planning.updatePlanningSettings(cid, req.body || {});
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'inventory', recordId: cid,
               recordType: 'inventory_planning_settings', action: 'update',
               oldData: before, newData: after, req, company_id: cid });
    res.json(after);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message, message: e.message, errors: e.errors });
    res.status(500).json({ error: e.message });
  }
});

// ── What counts as demand ────────────────────────────────────────────────────
/* GET /inventory/planning/ledger-semantics?since_days=365
   The classification every demand figure is built on (ledgerSemantics.js), the
   cases awaiting a business decision, and — for this company — any ledger
   transaction types it does not classify. Those count as nothing; this is
   where someone reviews them rather than discovering them in a log. */
router.get('/ledger-semantics', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const sinceDays = Number.isInteger(Number(req.query.since_days)) && Number(req.query.since_days) > 0
      ? Number(req.query.since_days) : null;
    res.json({
      classes: ledgerSemantics.TRANSACTION_TYPE_CLASS,
      reversal_policy: 'Returns of issues reduce demand in the month booked; annual demand is netted over the '
                     + 'window and floored at zero; a monthly series value is floored at zero; FSN dates the last issue only.',
      unknown_policy: 'Unclassified types never count as demand or as an issue, and are listed here.',
      ambiguous: ledgerSemantics.AMBIGUOUS_TYPES,
      unclassified_transaction_types: await ledgerSemantics.unclassifiedTransactionTypes(pool, companyOf(req), sinceDays),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Inventory KPIs ───────────────────────────────────────────────────────────

/*
 * GET /inventory/planning/kpis?window_days=365
 *
 * The eight KPIs the audit found absent from the inventory dashboard: turnover,
 * days of inventory, achieved service level, stockouts, safety-stock breaches,
 * excess inventory, obsolete/slow-moving stock and the receiving/production
 * pipeline.
 *
 * It lives beside the planning parameters rather than on the dashboard router
 * on purpose: every one of these numbers measures whether the parameters next
 * door are working, and they share a demand definition and a cost basis with
 * them. Put somewhere else it would have reinvented both, which is precisely
 * how the EOQ Planner screen came to disagree with the governed reorder point.
 *
 * `window_days` is clamped rather than validated-and-rejected: a caller asking
 * for ten years of ledger walk gets five, not a 400 they have to handle.
 */
router.get('/kpis', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const raw = parseInt(req.query.window_days, 10);
    const windowDays = Number.isFinite(raw) ? Math.min(Math.max(raw, 7), 1825) : null;
    res.json(await computeInventoryKpis({ companyId: companyOf(req), windowDays }));
  } catch (e) { console.error('[planning/kpis]', e); res.status(500).json({ error: e.message }); }
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
             abc_class, abc_class_calculated, abc_class_source, annual_consumption_value,
             service_level_pct, service_level_z, planning_params_computed_at,
             classification_reason, classified_at,
             -- What the operative figure stands on. A calculated-source figure
             -- with no current calculation behind it (the item fell below the
             -- history minimum) is the last run's number, kept because changing
             -- stocking cover is a policy decision — say so instead of
             -- presenting it as a live calculation.
             CASE WHEN COALESCE(safety_stock_source,'calculated') = 'manual' THEN 'manual'
                  WHEN safety_stock_calculated IS NOT NULL                  THEN 'calculated'
                  ELSE 'no_current_calculation' END AS safety_stock_basis,
             CASE WHEN COALESCE(reorder_point_source,'calculated') = 'manual' THEN 'manual'
                  WHEN reorder_point_calculated IS NOT NULL                  THEN 'calculated'
                  ELSE 'no_current_calculation' END AS reorder_point_basis
        FROM inventory_items
       WHERE ($1::int IS NULL OR company_id = $1)
         AND COALESCE(is_active,true) = true AND deleted_at IS NULL
       ORDER BY annual_consumption_value DESC NULLS LAST, item_name`, [companyOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Pin or unpin a parameter. Pinning is what lets a planner disagree with the
   model without the next recompute quietly overruling them. */
/* The ABC class pins the same way:
     { abc_class: 'A' }                 pin A (manual), even if A is what the
                                        engine says — that is how a planner
                                        holds a class against a future recompute
     { abc_class: null }  or
     { abc_class_source: 'calculated' } release; the item takes the engine's
                                        current class at once */
router.put('/parameters/:itemId', requirePermission('inventory', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const { safety_stock, reorder_level, safety_stock_source, reorder_point_source, lead_time_days } = body;
    let abc;
    try {
      abc = body.abc_class_source === 'calculated' && body.abc_class === undefined
        ? { mode: 'clear', value: null }
        : planning.parseAbcOverride(body.abc_class);
    } catch (err) { return res.status(400).json({ error: err.message }); }
    if (body.abc_class_source !== undefined && !['manual', 'calculated'].includes(body.abc_class_source)) {
      return res.status(400).json({ error: 'abc_class_source must be manual or calculated.' });
    }
    if (body.abc_class_source === 'manual' && abc.mode !== 'set') {
      return res.status(400).json({ error: 'Pinning a manual ABC class needs abc_class.' });
    }

    const sets = [], vals = [req.params.itemId, companyOf(req)];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (safety_stock        !== undefined) { push('safety_stock', safety_stock);   push('safety_stock_source', 'manual'); }
    if (reorder_level       !== undefined) { push('reorder_level', reorder_level); push('reorder_point_source', 'manual'); }
    if (safety_stock_source  !== undefined) push('safety_stock_source', safety_stock_source);
    if (reorder_point_source !== undefined) push('reorder_point_source', reorder_point_source);
    if (lead_time_days       !== undefined) push('lead_time_days', lead_time_days);
    if (abc.mode !== 'keep') {
      vals.push(abc.mode, abc.value);
      sets.push(planning.abcOverrideSetSql(`$${vals.length - 1}::text`, `$${vals.length}::text`));
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    // Releasing a pin restores the calculated figure immediately rather than
    // leaving the stale manual number in place until the next recompute.
    const restore = [];
    if (safety_stock_source === 'calculated')  restore.push(`safety_stock  = COALESCE(safety_stock_calculated,  safety_stock)`);
    if (reorder_point_source === 'calculated') restore.push(`reorder_level = COALESCE(reorder_point_calculated, reorder_level)`);

    await client.query('BEGIN');
    const { rows: [before] } = await client.query(
      `SELECT * FROM inventory_items WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [req.params.itemId, companyOf(req)]);
    if (!before) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item not found' }); }
    const { rows: [row] } = await client.query(
      `UPDATE inventory_items SET ${[...sets, ...restore].join(', ')}, updated_at = NOW()
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`, vals);
    await client.query('COMMIT');

    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'inventory', recordId: row.id,
               recordType: 'inventory_item_planning', action: 'update',
               oldData: before, newData: row, req, company_id: row.company_id });
    res.json(row);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
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

/**
 * ABC (and now XYZ / FSN) classification.
 *
 * Previously returned class, value and a ranking implied by the sort order, and
 * accepted no filter but the caller's company. Three things were missing that
 * the requirement names explicitly: percentage contribution, cumulative
 * percentage, and the ability to ask the question of one store, category or
 * project rather than the whole company.
 *
 * The per-item percentages are no longer recomputed here — they are persisted
 * by the planning run that decided the class, so what is shown is what the
 * classification was actually based on. Recomputing them at read time would let
 * the two drift the moment anything moved.
 *
 * Filters: warehouse_id, category_id, project_id, item_type, abc_class,
 * xyz_class, fsn_class. A warehouse or project filter narrows the POPULATION
 * (which items are listed); it deliberately does NOT re-run the Pareto over
 * that subset, because a class is a company-level policy decision about a part
 * and an item must not be A in one store and C in another.
 *
 * Every active item is listed, classified or not. This used to filter on
 * abc_class IS NOT NULL, so an item the run could not classify — including
 * every never-issued, Non-moving part — was simply absent, indistinguishable
 * from an item that does not exist. Each row now carries
 * classification_status:
 *   'manual'                abc_class_source = manual: a person owns the class
 *   'classified'            the planning run owns it (abc_class_source = calculated)
 *   'legacy_unverified'     a class from before ownership was recorded whose
 *                           author could not be established; the next run
 *                           takes it over (migration 20261021000009)
 *   'insufficient_history'  evaluated, too little demand history for ABC/XYZ
 *   'not_computed'          no planning run has evaluated it yet
 * (planning.abcStatusSql is the one definition.)
 * and annual_consumption_value only when it is the basis of a current class.
 */
router.get('/abc', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { warehouse_id, category_id, project_id, item_type,
            abc_class, xyz_class, fsn_class } = req.query;

    const where = [
      `($1::int IS NULL OR ii.company_id = $1)`,
      `COALESCE(ii.is_active,true) = true`,
      `ii.deleted_at IS NULL`,
    ];
    const params = [cid];
    const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

    if (category_id) add(`ii.category_id = $?::int`, category_id);
    if (item_type)   add(`LOWER(COALESCE(ii.item_type,'')) = LOWER($?)`, item_type);
    if (abc_class)   add(`ii.abc_class = $?`, String(abc_class).toUpperCase());
    if (xyz_class)   add(`ii.xyz_class = $?`, String(xyz_class).toUpperCase());
    if (fsn_class)   add(`ii.fsn_class = $?`, String(fsn_class).toUpperCase());
    // "Items this store actually carries" — ledger history is the honest proxy,
    // as Pulse has no item x warehouse planning row.
    if (warehouse_id) add(
      `EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.item_id = ii.id AND sl.warehouse_id = $?::int)`,
      warehouse_id);
    // Items consumed by a project, through the production orders it owns.
    if (project_id) add(
      `EXISTS (SELECT 1 FROM material_issue_logs mil
                 JOIN production_orders po ON po.id = mil.production_order_id
                WHERE mil.item_id = ii.id AND po.project_id = $?::int)`,
      project_id);

    const whereSql = where.join(' AND ');

    // The consumption value an insufficient-history item still carries is a
    // leftover from an earlier run (it is kept on the row because procurement
    // derives a unit cost from it); it is not the basis of any class, so it is
    // not reported as one.
    const ACV = `CASE WHEN ii.abc_class_calculated IS NOT NULL THEN ii.annual_consumption_value END`;

    const { rows: summary } = await pool.query(`
      SELECT ii.abc_class AS category, COUNT(*)::int AS item_count,
             COALESCE(SUM(${ACV}),0)::numeric AS value,
             COALESCE(SUM(ii.current_stock * COALESCE(ii.standard_cost,0)),0)::numeric AS stock_value,
             ROUND(COALESCE(SUM(ii.abc_value_pct),0)::numeric, 2) AS value_pct
        FROM inventory_items ii
       WHERE ${whereSql}
       GROUP BY ii.abc_class ORDER BY ii.abc_class NULLS LAST`, params);

    const { rows: items } = await pool.query(`
      SELECT ii.id, ii.item_code, ii.item_name, ii.abc_class, ii.abc_class_calculated,
             ii.abc_rank, ii.abc_value_pct, ii.abc_cumulative_pct,
             ii.xyz_class, ii.fsn_class, ii.demand_cv, ii.last_movement_date,
             ${ACV} AS annual_consumption_value, ii.annual_demand, ii.current_stock,
             ii.abc_class_source,
             ${planning.abcStatusSql('ii')} AS classification_status,
             ii.classification_reason,
             ii.classified_at,
             ii.planning_params_computed_at AS last_calculated_at
        FROM inventory_items ii
       WHERE ${whereSql}
       ORDER BY ii.abc_rank NULLS LAST, ii.annual_consumption_value DESC NULLS LAST, ii.item_code`, params);

    // The ABC x XYZ grid: the pair is what stocking policy is actually set on.
    const matrix = {};
    for (const it of items) {
      if (!it.abc_class || !it.xyz_class) continue;
      const k = `${it.abc_class}${it.xyz_class}`;
      matrix[k] = (matrix[k] || 0) + 1;
    }

    const settings = await planning.getPlanningSettings(cid);
    res.json({
      summary,
      items,
      abcXyzMatrix: matrix,
      thresholds: {
        abc_a_threshold_pct: Number(settings.abc_a_threshold_pct ?? 70),
        abc_b_threshold_pct: Number(settings.abc_b_threshold_pct ?? 90),
        xyz_x_max_cv: Number(settings.xyz_x_max_cv ?? 0.5),
        xyz_y_max_cv: Number(settings.xyz_y_max_cv ?? 1.0),
        fsn_slow_days: Number(settings.fsn_slow_days ?? 90),
        fsn_nonmoving_days: Number(settings.fsn_nonmoving_days ?? 180),
      },
      filters_applied: { warehouse_id, category_id, project_id, item_type, abc_class, xyz_class, fsn_class },
    });
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

// ── Projection, optimisation and measured lead times ─────────────────────────

/* GET /inventory/planning/projected-stock?item_id=&horizon_days=
 * The forward on-hand curve per item, with when it crosses safety stock and
 * when it crosses zero. This is what "inventory forecasting", "inventory
 * prediction" and "stockout prediction" all needed and none of them had. */
router.get('/projected-stock', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const out = await projection.projectedOnHand({
      companyId:   companyOf(req),
      itemId:      req.query.item_id ? Number(req.query.item_id) : null,
      horizonDays: Math.min(365, Math.max(7, Number(req.query.horizon_days) || 90)),
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /inventory/planning/optimisation — where the safety-stock budget is
 * mis-allocated, and what pooling across locations would save. */
router.get('/optimisation', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    res.json(await projection.optimiseInventory({
      companyId: companyOf(req),
      targetServiceLevel: req.query.service_level ? Number(req.query.service_level) : null,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /inventory/planning/lead-times/measure — replace typed lead times with
 * what receipts actually show. Manual pins are respected. */
router.post('/lead-times/measure', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    res.json(await projection.measureSupplierLeadTimes({
      companyId: companyOf(req),
      minObservations: Math.max(1, Number(req.body?.min_observations) || 2),
      apply: req.body?.apply !== false,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /inventory/planning/lead-times — measured vs in-use, per item */
router.get('/lead-times', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, item_code, item_name, lead_time_days, lead_time_measured_days,
             lead_time_observations, lead_time_source, lead_time_measured_at
        FROM inventory_items
       WHERE ($1::int IS NULL OR company_id = $1)
         AND deleted_at IS NULL AND COALESCE(is_active,true) = true
       ORDER BY lead_time_measured_days DESC NULLS LAST, item_code`, [companyOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /inventory/planning/supplier-delay-risk — measured vendor lateness, and
 * which open purchase orders it is likely to land on. */
router.get('/supplier-delay-risk', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    res.json(await projection.supplierDelayRisk({
      companyId: companyOf(req),
      lookbackDays: Math.min(1095, Math.max(30, Number(req.query.lookback_days) || 365)),
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
