// backend/src/modules/production/mrp.routes.js
//
// MRP II Planning workbench API:
//   - Run regenerative MRP, browse run history + results
//   - Firm / convert / ignore planned orders (buy -> PR, make -> production order)
//   - Master Production Schedule (MPS) CRUD
//   - Demand forecast CRUD
//   - Item planning attributes (safety stock, lead time, lot sizing, make/buy)
//   - Planning dashboard KPIs

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { nextProdOrderNumber, nextPurchaseRequestNumber } from '../../shared/docNumber.js';
import { runMRP, computeATP } from './mrpEngine.service.js';
import { computeCTP } from './ctpEngine.service.js';
import { copyRoutingToProductionOperations } from './routingCopy.service.js';

const router = Router();
const actor = (req) => ({ id: req.user?.userId || req.user?.id || null, name: req.user?.name || req.user?.email || 'System' });
const cidOf = (req) => (req.scope?.company_id != null ? req.scope.company_id : null);

// ─────────────────────────────────────────────────────────────────────────────
// MRP RUN + RESULTS
// ─────────────────────────────────────────────────────────────────────────────

/* POST /mrp/run — execute a regenerative MRP pass */
router.post('/run', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const {
      horizon_days = 90,
      bucket_days = 7,
      include_sales_orders = true,
      include_mps = true,
      include_forecast = true,
    } = req.body || {};
    const result = await runMRP({
      companyId: cidOf(req),
      horizonDays: Math.max(1, Math.min(730, parseInt(horizon_days, 10) || 90)),
      bucketDays: Math.max(1, Math.min(31, parseInt(bucket_days, 10) || 7)),
      includeSalesOrders: !!include_sales_orders,
      includeMPS: !!include_mps,
      includeForecast: !!include_forecast,
      actor: actor(req),
    });
    res.json({
      run: result.run,
      planned_orders: result.plannedOrders,
      exceptions: result.exceptions.map(e => ({ ...e, item: undefined, item_name: e.item.item_name, item_code: e.item.item_code })),
      unmatched_demand: result.unmatched,
      buckets: result.buckets,
      time_phased: result.timePhased,
      summary: {
        planned_orders: result.plannedOrders.length,
        make: result.plannedOrders.filter(p => p.order_type === 'make').length,
        buy: result.plannedOrders.filter(p => p.order_type === 'buy').length,
        exceptions: result.exceptions.length,
        unmatched: result.unmatched.length,
      },
    });
  } catch (e) { console.error('[mrp/run]', e); res.status(500).json({ error: e.message }); }
});

/* GET /mrp/runs — run history */
router.get('/runs', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { rows } = await pool.query(
      `SELECT * FROM mrp_runs WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
       ORDER BY created_at DESC LIMIT 100`, [cid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /mrp/runs/:id — run detail with planned orders + exceptions */
router.get('/runs/:id', requirePermission('production', 'view'), async (req, res) => {
  try {
    const [run, orders, exc, tp] = await Promise.all([
      pool.query(`SELECT * FROM mrp_runs WHERE id = $1`, [req.params.id]),
      pool.query(`SELECT * FROM mrp_planned_orders WHERE run_id = $1 ORDER BY low_level_code, order_type, item_name`, [req.params.id]),
      pool.query(`SELECT * FROM mrp_exceptions WHERE run_id = $1 ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`, [req.params.id]),
      pool.query(`SELECT * FROM mrp_time_phased WHERE run_id = $1 ORDER BY low_level_code, item_name, bucket_index`, [req.params.id]),
    ]);
    if (!run.rows[0]) return res.status(404).json({ error: 'Run not found' });
    res.json({ run: run.rows[0], planned_orders: orders.rows, exceptions: exc.rows, time_phased: tp.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /mrp/time-phased?run_id= — the time-phased grid for a run */
router.get('/time-phased', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { run_id } = req.query;
    if (!run_id) return res.status(400).json({ error: 'run_id required' });
    const { rows } = await pool.query(
      `SELECT * FROM mrp_time_phased WHERE run_id = $1 ORDER BY low_level_code, item_name, bucket_index`, [run_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /mrp/atp?item_id=&horizon_days=&bucket_days= — Available-to-Promise */
router.get('/atp', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { item_id, horizon_days = 90, bucket_days = 7 } = req.query;
    if (!item_id) return res.status(400).json({ error: 'item_id required' });
    const result = await computeATP({
      companyId: cidOf(req), itemId: parseInt(item_id, 10),
      horizonDays: Math.max(1, Math.min(730, parseInt(horizon_days, 10) || 90)),
      bucketDays: Math.max(1, Math.min(31, parseInt(bucket_days, 10) || 7)),
    });
    if (!result) return res.status(404).json({ error: 'Item not found' });
    res.json(result);
  } catch (e) { console.error('[mrp/atp]', e); res.status(500).json({ error: e.message }); }
});

/* GET /mrp/ctp?item_id=&quantity=&need_date=&horizon_days=&bucket_days= — Capable-to-Promise */
router.get('/ctp', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { item_id, quantity, need_date, horizon_days = 180, bucket_days = 7 } = req.query;
    if (!item_id || !quantity) return res.status(400).json({ error: 'item_id and quantity required' });
    const result = await computeCTP({
      companyId: cidOf(req), itemId: parseInt(item_id, 10), quantity: parseFloat(quantity),
      needDate: need_date || null,
      horizonDays: Math.max(1, Math.min(730, parseInt(horizon_days, 10) || 180)),
      bucketDays: Math.max(1, Math.min(31, parseInt(bucket_days, 10) || 7)),
    });
    if (!result) return res.status(404).json({ error: 'Item not found' });
    res.json(result);
  } catch (e) { console.error('[mrp/ctp]', e); res.status(500).json({ error: e.message }); }
});

/* GET /mrp/planned-orders?run_id=&type=&status= */
router.get('/planned-orders', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { run_id, type, status } = req.query;
    const where = [], vals = [];
    if (run_id) { vals.push(run_id); where.push(`run_id = $${vals.length}`); }
    if (type)   { vals.push(type);   where.push(`order_type = $${vals.length}`); }
    if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
    const cid = cidOf(req);
    if (cid != null) { vals.push(cid); where.push(`(company_id = $${vals.length} OR company_id IS NULL)`); }
    const { rows } = await pool.query(
      `SELECT * FROM mrp_planned_orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY low_level_code, order_type, item_name LIMIT 1000`, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /mrp/planned-orders/:id/ignore */
router.post('/planned-orders/:id/ignore', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE mrp_planned_orders SET status='ignored' WHERE id=$1 AND status='planned' RETURNING *`, [req.params.id]);
    if (!rows[0]) return res.status(409).json({ error: 'Planned order not in planned state' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /mrp/planned-orders/:id/convert
   buy  -> creates a purchase_requests row (draft)
   make -> creates a production_orders row (planned) */
router.post('/planned-orders/:id/convert', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM mrp_planned_orders WHERE id=$1 FOR UPDATE`, [req.params.id]);
    const po = rows[0];
    if (!po) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Planned order not found' }); }
    if (po.status !== 'planned' && po.status !== 'firmed') {
      await client.query('ROLLBACK'); return res.status(409).json({ error: `Already ${po.status}` });
    }
    const a = actor(req);
    let ref, newId;

    if (po.order_type === 'buy') {
      const prNo = await nextPurchaseRequestNumber(client);
      const { rows: [pr] } = await client.query(`
        INSERT INTO purchase_requests
          (pr_number, item_code, item_name, quantity, unit, status, company_id, request_date, required_date, notes, priority)
        VALUES ($1,$2,$3,$4,$5,'draft',$6,CURRENT_DATE,$7,$8,'medium') RETURNING id`,
        [prNo, po.item_code, po.item_name, po.quantity, po.uom, po.company_id, po.need_date,
         `Auto-created from MRP run #${po.run_id}`]);
      ref = prNo; newId = pr.id;
    } else {
      const prodNo = await nextProdOrderNumber(client);
      const { rows: [prod] } = await client.query(`
        INSERT INTO production_orders
          (production_order_no, product_id, product_name, quantity_planned, bom_id, status, priority,
           planned_start_date, planned_end_date, company_id, created_by, notes)
        VALUES ($1,$2,$3,$4,$5,'planned','medium',$6,$7,$8,$9,$10) RETURNING id`,
        [prodNo, po.item_id, po.item_name, po.quantity, po.bom_id, po.start_date, po.need_date,
         po.company_id, a.id, `Auto-created from MRP run #${po.run_id}`]);
      ref = prodNo; newId = prod.id;
      await copyRoutingToProductionOperations(client, po.bom_id, prod.id);
    }

    const { rows: [updated] } = await client.query(
      `UPDATE mrp_planned_orders SET status='converted', converted_ref=$2, converted_id=$3 WHERE id=$1 RETURNING *`,
      [po.id, ref, newId]);
    await client.query('COMMIT');
    res.json({ planned_order: updated, created: { type: po.order_type === 'buy' ? 'purchase_request' : 'production_order', ref, id: newId } });
  } catch (e) {
    await client.query('ROLLBACK'); console.error('[mrp/convert]', e); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* POST /mrp/planned-orders/convert-all?run_id= — convert every planned order in a run */
router.post('/planned-orders/convert-all', requirePermission('production', 'edit'), async (req, res) => {
  const { run_id, order_type } = req.body || {};
  if (!run_id) return res.status(400).json({ error: 'run_id required' });
  try {
    const filt = order_type ? ' AND order_type=$2' : '';
    const vals = order_type ? [run_id, order_type] : [run_id];
    const { rows } = await pool.query(
      `SELECT id FROM mrp_planned_orders WHERE run_id=$1 AND status='planned'${filt}`, vals);
    let converted = 0, failed = 0;
    for (const r of rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [po] } = await client.query(`SELECT * FROM mrp_planned_orders WHERE id=$1 FOR UPDATE`, [r.id]);
        if (!po || po.status !== 'planned') { await client.query('ROLLBACK'); continue; }
        const a = actor(req);
        let ref, newId;
        if (po.order_type === 'buy') {
          const prNo = await nextPurchaseRequestNumber(client);
          const { rows: [pr] } = await client.query(`
            INSERT INTO purchase_requests (pr_number,item_code,item_name,quantity,unit,status,company_id,request_date,required_date,notes,priority)
            VALUES ($1,$2,$3,$4,$5,'draft',$6,CURRENT_DATE,$7,$8,'medium') RETURNING id`,
            [prNo, po.item_code, po.item_name, po.quantity, po.uom, po.company_id, po.need_date, `Auto-created from MRP run #${po.run_id}`]);
          ref = prNo; newId = pr.id;
        } else {
          const prodNo = await nextProdOrderNumber(client);
          const { rows: [prod] } = await client.query(`
            INSERT INTO production_orders (production_order_no,product_id,product_name,quantity_planned,bom_id,status,priority,planned_start_date,planned_end_date,company_id,created_by,notes)
            VALUES ($1,$2,$3,$4,$5,'planned','medium',$6,$7,$8,$9,$10) RETURNING id`,
            [prodNo, po.item_id, po.item_name, po.quantity, po.bom_id, po.start_date, po.need_date, po.company_id, a.id, `Auto-created from MRP run #${po.run_id}`]);
          ref = prodNo; newId = prod.id;
          await copyRoutingToProductionOperations(client, po.bom_id, prod.id);
        }
        await client.query(`UPDATE mrp_planned_orders SET status='converted', converted_ref=$2, converted_id=$3 WHERE id=$1`, [po.id, ref, newId]);
        await client.query('COMMIT'); converted++;
      } catch (e) { await client.query('ROLLBACK'); failed++; } finally { client.release(); }
    }
    res.json({ converted, failed, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// MASTER PRODUCTION SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────
router.get('/mps', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { rows } = await pool.query(
      `SELECT m.*, i.item_code FROM master_production_schedule m
         LEFT JOIN inventory_items i ON i.id = m.product_id
        WHERE ($1::int IS NULL OR m.company_id = $1 OR m.company_id IS NULL)
        ORDER BY m.due_date`, [cid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mps', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const { product_id, product_name, due_date, quantity, status = 'firm', demand_source = 'manual', notes } = req.body || {};
    if (!product_name || !due_date || !quantity) return res.status(400).json({ error: 'product_name, due_date, quantity required' });
    const a = actor(req);
    const { rows: [row] } = await pool.query(`
      INSERT INTO master_production_schedule (company_id, product_id, product_name, due_date, quantity, status, demand_source, notes, created_by, created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [cidOf(req), product_id || null, product_name, due_date, quantity, status, demand_source, notes || null, a.id, a.name]);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/mps/:id', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const { product_id, product_name, due_date, quantity, quantity_produced, status, notes } = req.body || {};
    const { rows: [row] } = await pool.query(`
      UPDATE master_production_schedule SET
        product_id = COALESCE($2, product_id), product_name = COALESCE($3, product_name),
        due_date = COALESCE($4, due_date), quantity = COALESCE($5, quantity),
        quantity_produced = COALESCE($6, quantity_produced), status = COALESCE($7, status),
        notes = COALESCE($8, notes), updated_at = NOW()
      WHERE id = $1 RETURNING *`,
      [req.params.id, product_id, product_name, due_date, quantity, quantity_produced, status, notes]);
    if (!row) return res.status(404).json({ error: 'MPS entry not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/mps/:id', requirePermission('production', 'edit'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM master_production_schedule WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DEMAND FORECASTS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/forecasts', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { rows } = await pool.query(
      `SELECT f.*, i.item_code, i.item_name AS master_item_name FROM demand_forecasts f
         LEFT JOIN inventory_items i ON i.id = f.item_id
        WHERE ($1::int IS NULL OR f.company_id = $1 OR f.company_id IS NULL)
        ORDER BY f.forecast_date`, [cid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/forecasts', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const { item_id, product_name, forecast_date, quantity, uom, source = 'manual', notes } = req.body || {};
    if (!forecast_date || !quantity) return res.status(400).json({ error: 'forecast_date, quantity required' });
    const a = actor(req);
    const { rows: [row] } = await pool.query(`
      INSERT INTO demand_forecasts (company_id, item_id, product_name, forecast_date, quantity, uom, source, notes, created_by, created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [cidOf(req), item_id || null, product_name || null, forecast_date, quantity, uom || null, source, notes || null, a.id, a.name]);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/forecasts/:id', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const { item_id, product_name, forecast_date, quantity, consumed_qty, uom, notes } = req.body || {};
    const { rows: [row] } = await pool.query(`
      UPDATE demand_forecasts SET
        item_id = COALESCE($2, item_id), product_name = COALESCE($3, product_name),
        forecast_date = COALESCE($4, forecast_date), quantity = COALESCE($5, quantity),
        consumed_qty = COALESCE($6, consumed_qty), uom = COALESCE($7, uom),
        notes = COALESCE($8, notes), updated_at = NOW()
      WHERE id = $1 RETURNING *`,
      [req.params.id, item_id, product_name, forecast_date, quantity, consumed_qty, uom, notes]);
    if (!row) return res.status(404).json({ error: 'Forecast not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/forecasts/:id', requirePermission('production', 'edit'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM demand_forecasts WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM PLANNING ATTRIBUTES
// ─────────────────────────────────────────────────────────────────────────────
router.get('/item-planning', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { rows } = await pool.query(`
      SELECT id, item_code, item_name, unit_of_measure, current_stock, reorder_level,
             COALESCE(reorder_point,0) reorder_point, COALESCE(safety_stock,0) safety_stock,
             COALESCE(lead_time_days,0) lead_time_days, COALESCE(min_order_qty,0) min_order_qty,
             COALESCE(max_order_qty,0) max_order_qty, COALESCE(lot_size_qty,0) lot_size_qty,
             COALESCE(lot_sizing_rule,'lot_for_lot') lot_sizing_rule, COALESCE(make_or_buy,'buy') make_or_buy,
             standard_cost, abc_class, preferred_vendor_id
        FROM inventory_items
       WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL) AND deleted_at IS NULL AND COALESCE(is_active,true)
       ORDER BY item_name LIMIT 2000`, [cid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/item-planning/:id', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const f = req.body || {};
    const { rows: [row] } = await pool.query(`
      UPDATE inventory_items SET
        safety_stock    = COALESCE($2, safety_stock),
        reorder_point   = COALESCE($3, reorder_point),
        lead_time_days  = COALESCE($4, lead_time_days),
        min_order_qty   = COALESCE($5, min_order_qty),
        max_order_qty   = COALESCE($6, max_order_qty),
        lot_size_qty    = COALESCE($7, lot_size_qty),
        lot_sizing_rule = COALESCE($8, lot_sizing_rule),
        make_or_buy     = COALESCE($9, make_or_buy),
        preferred_vendor_id = COALESCE($10, preferred_vendor_id),
        updated_at = NOW()
      WHERE id = $1 RETURNING id, item_code, item_name, safety_stock, reorder_point, lead_time_days,
        min_order_qty, max_order_qty, lot_size_qty, lot_sizing_rule, make_or_buy, preferred_vendor_id`,
      [req.params.id, f.safety_stock, f.reorder_point, f.lead_time_days, f.min_order_qty, f.max_order_qty,
       f.lot_size_qty, f.lot_sizing_rule, f.make_or_buy, f.preferred_vendor_id]);
    if (!row) return res.status(404).json({ error: 'Item not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PLANNING DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { rows: [last] } = await pool.query(
      `SELECT * FROM mrp_runs WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
       ORDER BY created_at DESC LIMIT 1`, [cid]);
    let openPlanned = { total: 0, make: 0, buy: 0, buy_value: 0 };
    let exceptions = { critical: 0, warning: 0, info: 0 };
    if (last) {
      const { rows: [op] } = await pool.query(`
        SELECT COUNT(*)::int total,
               COUNT(*) FILTER (WHERE order_type='make')::int make,
               COUNT(*) FILTER (WHERE order_type='buy')::int buy,
               COALESCE(SUM(est_value) FILTER (WHERE order_type='buy'),0) buy_value
          FROM mrp_planned_orders WHERE run_id=$1 AND status IN ('planned','firmed')`, [last.id]);
      openPlanned = op;
      const { rows: [ex] } = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE severity='critical')::int critical,
               COUNT(*) FILTER (WHERE severity='warning')::int warning,
               COUNT(*) FILTER (WHERE severity='info')::int info
          FROM mrp_exceptions WHERE run_id=$1`, [last.id]);
      exceptions = ex;
    }
    res.json({ last_run: last || null, open_planned_orders: openPlanned, exceptions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
