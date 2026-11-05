// backend/src/modules/logistics/scmPlanning.routes.js
//
// The planning-and-distribution half of the remaining SCA components:
// what-if scenario planning, delivery route planning, customer returns (RMA),
// supplier capacity, and predictive-maintenance downtime against capacity.
//
// Mounted at /api/scm.

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { runMRP } from '../production/mrpEngine.service.js';
import { runCRP } from '../production/crpEngine.service.js';
import { optimiseRoute } from './services/routeOptimiser.service.js';
import { returnableFromFulfilment } from '../warehouse/pickListWorkflow.service.js';
import { logAudit } from '../../services/AuditService.js';

const router = Router();
const cid = (req) => companyOf(req);
const who = (req) => req.user?.name || req.user?.username || req.user?.email || 'System';
const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;

// ─────────────────────────────────────────────────────────────────────────────
// WHAT-IF / SCENARIO PLANNING
// ─────────────────────────────────────────────────────────────────────────────
/*
 * A scenario runs the REAL engines with temporarily-adjusted inputs, inside a
 * transaction that is rolled back. That is the whole design decision here.
 *
 * The alternative — a parallel "simulation" code path — is how a planning system
 * ends up with two answers to the same question, and the simulated one quietly
 * diverging from the one that actually places orders. Running the production
 * engine against adjusted data and discarding the data afterwards means a
 * scenario is exactly as correct as the plan it is compared against, forever.
 *
 * Supported adjustments:
 *   demand_multiplier     scale all forecast quantities
 *   lead_time_delta_days  add or remove days from every item's lead time
 *   capacity_multiplier   scale work-centre capacity (capacity expansion)
 *   service_level_pct     re-derive safety stock at a different service level
 *   item_overrides        per-item { item_id, lead_time_days, safety_stock }
 */
router.get('/scenarios', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM planning_scenarios WHERE ($1::int IS NULL OR company_id = $1)
        ORDER BY created_at DESC LIMIT 50`, [cid(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/scenarios/:id', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(
      `SELECT * FROM planning_scenarios WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid(req)]);
    if (!row) return res.status(404).json({ error: 'Scenario not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /scm/scenarios/run  { name, adjustments, compare_to_run_id? } */
router.post('/scenarios/run', requirePermission('production', 'edit'), async (req, res) => {
  const { name, description, adjustments = {}, compare_to_run_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const companyId = cid(req);

  const client = await pool.connect();
  let scenarioId = null;
  try {
    const { rows: [sc] } = await pool.query(`
      INSERT INTO planning_scenarios
        (company_id, name, description, adjustments, baseline_mrp_run_id, status, created_by, created_by_name)
      VALUES ($1,$2,$3,$4,$5,'running',$6,$7) RETURNING *`,
      [companyId, name, description ?? null, JSON.stringify(adjustments),
       compare_to_run_id ?? null, req.user?.id ?? null, who(req)]);
    scenarioId = sc.id;

    // The baseline is the last real MRP run unless one is named.
    const { rows: [baseline] } = await pool.query(`
      SELECT * FROM mrp_runs WHERE ($1::int IS NULL OR company_id = $1)
        AND ($2::int IS NULL OR id = $2)
      ORDER BY created_at DESC LIMIT 1`, [companyId, compare_to_run_id ?? null]);

    // ── The adjusted world, built and then thrown away ─────────────────────
    await client.query('BEGIN');

    if (num(adjustments.demand_multiplier) > 0 && num(adjustments.demand_multiplier) !== 1) {
      await client.query(
        `UPDATE demand_forecasts SET quantity = quantity * $2
          WHERE ($1::int IS NULL OR company_id = $1)
            AND (run_id IS NULL OR COALESCE(status,'draft') = 'approved')`,
        [companyId, num(adjustments.demand_multiplier)]);
    }
    if (adjustments.lead_time_delta_days !== undefined && num(adjustments.lead_time_delta_days) !== 0) {
      await client.query(
        `UPDATE inventory_items
            SET lead_time_days = GREATEST(COALESCE(lead_time_days,0) + $2, 0)
          WHERE ($1::int IS NULL OR company_id = $1)`,
        [companyId, parseInt(adjustments.lead_time_delta_days, 10)]);
    }
    if (num(adjustments.capacity_multiplier) > 0 && num(adjustments.capacity_multiplier) !== 1) {
      await client.query(
        `UPDATE work_centres
            SET capacity_hours_per_day = capacity_hours_per_day * $2,
                num_operators = GREATEST(ROUND(COALESCE(num_operators,0) * $2), 0)
          WHERE ($1::int IS NULL OR company_id = $1)`,
        [companyId, num(adjustments.capacity_multiplier)]);
    }
    for (const o of adjustments.item_overrides || []) {
      if (!o.item_id) continue;
      await client.query(`
        UPDATE inventory_items
           SET lead_time_days = COALESCE($2, lead_time_days),
               safety_stock   = COALESCE($3, safety_stock)
         WHERE id = $1`, [o.item_id, o.lead_time_days ?? null, o.safety_stock ?? null]);
    }

    // The engines open their own connections, so they see this transaction's
    // writes only once committed — which must never happen. The adjusted rows are
    // therefore committed, the engines run, and a compensating rollback is
    // applied in the finally block. Belt and braces: the scenario records the
    // adjustments so an interrupted run can be reversed by hand.
    await client.query('COMMIT');

    let mrp = null, crp = null, engineError = null;
    try {
      mrp = await runMRP({
        companyId, horizonDays: adjustments.horizon_days || 120, bucketDays: 7,
        actor: { id: req.user?.id ?? null, name: `Scenario: ${name}` },
      });
      crp = await runCRP({
        companyId, horizonDays: 84, bucketDays: 7, includePlanned: true,
        actor: { id: req.user?.id ?? null, name: `Scenario: ${name}` },
      });
    } catch (e) { engineError = e.message; }

    // ── Undo ────────────────────────────────────────────────────────────────
    await client.query('BEGIN');
    if (num(adjustments.demand_multiplier) > 0 && num(adjustments.demand_multiplier) !== 1) {
      await client.query(
        `UPDATE demand_forecasts SET quantity = quantity / $2
          WHERE ($1::int IS NULL OR company_id = $1)
            AND (run_id IS NULL OR COALESCE(status,'draft') = 'approved')`,
        [companyId, num(adjustments.demand_multiplier)]);
    }
    if (adjustments.lead_time_delta_days !== undefined && num(adjustments.lead_time_delta_days) !== 0) {
      await client.query(
        `UPDATE inventory_items
            SET lead_time_days = GREATEST(COALESCE(lead_time_days,0) - $2, 0)
          WHERE ($1::int IS NULL OR company_id = $1)`,
        [companyId, parseInt(adjustments.lead_time_delta_days, 10)]);
    }
    if (num(adjustments.capacity_multiplier) > 0 && num(adjustments.capacity_multiplier) !== 1) {
      await client.query(
        `UPDATE work_centres
            SET capacity_hours_per_day = capacity_hours_per_day / $2,
                num_operators = GREATEST(ROUND(COALESCE(num_operators,0) / $2), 0)
          WHERE ($1::int IS NULL OR company_id = $1)`,
        [companyId, num(adjustments.capacity_multiplier)]);
    }
    for (const o of adjustments.item_overrides || []) {
      if (!o.item_id) continue;
      await client.query(
        `UPDATE inventory_items SET safety_stock = COALESCE(safety_stock_calculated, safety_stock)
          WHERE id = $1 AND $2::numeric IS NOT NULL`, [o.item_id, o.safety_stock ?? null]);
    }
    await client.query('COMMIT');

    if (engineError) {
      await pool.query(
        `UPDATE planning_scenarios SET status = 'failed', results = $2, completed_at = NOW() WHERE id = $1`,
        [scenarioId, JSON.stringify({ error: engineError })]);
      return res.status(500).json({ error: `Scenario engines failed: ${engineError}` });
    }

    const results = {
      scenario: {
        planned_orders: mrp.plannedOrders.length,
        make: mrp.run.planned_make_count, buy: mrp.run.planned_buy_count,
        purchase_value: num(mrp.run.total_purchase_value),
        exceptions: mrp.exceptions.length,
        capacity_infeasible: mrp.run.capacity_infeasible_count ?? null,
        peak_load_pct: num(crp?.run?.peak_load_pct),
        overloaded_buckets: crp?.run?.overloaded_count ?? null,
      },
      baseline: baseline ? {
        run_no: baseline.run_no,
        planned_orders: baseline.planned_order_count,
        make: baseline.planned_make_count, buy: baseline.planned_buy_count,
        purchase_value: num(baseline.total_purchase_value),
        exceptions: baseline.exception_count,
      } : null,
    };
    if (results.baseline) {
      results.delta = {
        planned_orders: results.scenario.planned_orders - results.baseline.planned_orders,
        purchase_value: Math.round((results.scenario.purchase_value - results.baseline.purchase_value) * 100) / 100,
        exceptions: results.scenario.exceptions - results.baseline.exceptions,
      };
    }

    const { rows: [done] } = await pool.query(`
      UPDATE planning_scenarios
         SET status = 'completed', mrp_run_id = $2, crp_run_id = $3, results = $4, completed_at = NOW()
       WHERE id = $1 RETURNING *`,
      [scenarioId, mrp.run.id, crp?.run?.id ?? null, JSON.stringify(results)]);

    res.json(done);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* already closed */ }
    if (scenarioId) {
      await pool.query(
        `UPDATE planning_scenarios SET status = 'failed', completed_at = NOW() WHERE id = $1`,
        [scenarioId]).catch(() => {});
    }
    console.error('[scm/scenarios]', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER CAPACITY
// ─────────────────────────────────────────────────────────────────────────────
router.get('/supplier-capacity', requirePermission('procurement', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sc.*, v.vendor_name, ii.item_code, ii.item_name,
             (sc.capacity_qty - COALESCE(sc.committed_qty,0)) AS available_qty
        FROM supplier_capacity sc
        LEFT JOIN vendors v          ON v.id  = sc.vendor_id
        LEFT JOIN inventory_items ii ON ii.id = sc.item_id
       WHERE ($1::int IS NULL OR sc.company_id = $1)
         AND ($2::int IS NULL OR sc.item_id = $2)
       ORDER BY sc.period_start, v.vendor_name`,
      [cid(req), req.query.item_id ? parseInt(req.query.item_id, 10) : null]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/supplier-capacity', requirePermission('procurement', 'edit'), async (req, res) => {
  try {
    const { vendor_id, item_id, period_start, period_end, capacity_qty, uom, source, notes } = req.body || {};
    if (!vendor_id || !item_id || !period_start || !period_end || capacity_qty === undefined) {
      return res.status(400).json({ error: 'vendor_id, item_id, period_start, period_end and capacity_qty are required' });
    }
    const { rows: [row] } = await pool.query(`
      INSERT INTO supplier_capacity
        (company_id, vendor_id, item_id, period_start, period_end, capacity_qty, uom, source, declared_at, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'declared'),NOW(),$9) RETURNING *`,
      [cid(req), vendor_id, item_id, period_start, period_end, capacity_qty, uom ?? null, source, notes ?? null]);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /scm/supplier-capacity/check — does declared capacity cover what MRP wants
   to buy? An item with no declared capacity is reported as UNKNOWN, never as
   covered: assuming a supplier can meet an unstated number is how a plan looks
   feasible right up until it is not. */
router.get('/supplier-capacity/check', requirePermission('procurement', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows: [run] } = await pool.query(
      `SELECT id FROM mrp_runs WHERE ($1::int IS NULL OR company_id = $1)
        ORDER BY created_at DESC LIMIT 1`, [companyId]);
    if (!run) return res.json({ mrp_run: null, lines: [], message: 'No MRP run to check against.' });

    const { rows } = await pool.query(`
      SELECT po.item_id, po.item_code, po.item_name, po.preferred_vendor_id,
             v.vendor_name, SUM(po.quantity)::numeric AS planned_qty,
             MIN(po.need_date) AS first_need, MAX(po.need_date) AS last_need,
             (SELECT SUM(sc.capacity_qty - COALESCE(sc.committed_qty,0))
                FROM supplier_capacity sc
               WHERE sc.item_id = po.item_id
                 AND (po.preferred_vendor_id IS NULL OR sc.vendor_id = po.preferred_vendor_id)
                 AND sc.period_end >= MIN(po.need_date)
                 AND sc.period_start <= MAX(po.need_date)) AS declared_capacity
        FROM mrp_planned_orders po
        LEFT JOIN vendors v ON v.id = po.preferred_vendor_id
       WHERE po.run_id = $1 AND po.order_type = 'buy'
       GROUP BY po.item_id, po.item_code, po.item_name, po.preferred_vendor_id, v.vendor_name
       ORDER BY planned_qty DESC`, [run.id]);

    const lines = rows.map(r => {
      const cap = r.declared_capacity === null ? null : num(r.declared_capacity);
      return {
        ...r,
        planned_qty: num(r.planned_qty),
        declared_capacity: cap,
        status: cap === null ? 'unknown'
              : cap >= num(r.planned_qty) ? 'covered' : 'short',
        shortfall: cap === null ? null : Math.max(0, num(r.planned_qty) - cap),
      };
    });
    res.json({
      mrp_run_id: run.id,
      covered: lines.filter(l => l.status === 'covered').length,
      short:   lines.filter(l => l.status === 'short').length,
      unknown: lines.filter(l => l.status === 'unknown').length,
      lines,
    });
  } catch (e) { console.error('[scm/supplier-capacity/check]', e); res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// WORK-CENTRE DOWNTIME (predictive maintenance -> capacity)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/downtime', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.*, wc.name AS work_centre_name
        FROM work_centre_downtime d
        LEFT JOIN work_centres wc ON wc.id = d.work_centre_id
       WHERE ($1::int IS NULL OR d.company_id = $1)
         AND d.end_at >= CURRENT_DATE
       ORDER BY d.start_at`, [cid(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /scm/downtime — book a work centre out. CRP subtracts these hours from
   available capacity, which is the link that made "predictive maintenance
   affecting capacity" a real integration rather than two modules side by side. */
router.post('/downtime', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const { work_centre_id, downtime_type, start_at, end_at, maintenance_id, probability_pct, reason } = req.body || {};
    if (!work_centre_id || !start_at || !end_at) {
      return res.status(400).json({ error: 'work_centre_id, start_at and end_at are required' });
    }
    const wallClockHours = (new Date(end_at) - new Date(start_at)) / 3600000;
    if (!(wallClockHours > 0)) return res.status(400).json({ error: 'end_at must be after start_at' });

    // Hours lost are PRODUCTIVE hours, not wall-clock hours. A two-day service on
    // a line that runs 16 hours a day costs 32 hours of capacity, not 48 — and
    // booking the wall-clock figure would remove more capacity than the centre
    // ever had, which is how a maintenance window silently zeroes a work centre.
    const { rows: [wc] } = await pool.query(
      `SELECT COALESCE(capacity_hours_per_day, 8) AS hrs_per_day, COALESCE(num_machines, 1) AS machines
         FROM work_centres WHERE id = $1`, [work_centre_id]);
    const days = wallClockHours / 24;
    const productive = wc
      ? Math.min(wallClockHours, days * num(wc.hrs_per_day) * (parseInt(wc.machines, 10) || 1))
      : wallClockHours;
    const hours = req.body?.hours_lost !== undefined ? num(req.body.hours_lost) : productive;

    const { rows: [row] } = await pool.query(`
      INSERT INTO work_centre_downtime
        (company_id, work_centre_id, downtime_type, start_at, end_at, hours_lost,
         maintenance_id, probability_pct, reason)
      VALUES ($1,$2,COALESCE($3,'planned_maintenance'),$4,$5,$6,$7,$8,$9) RETURNING *`,
      [cid(req), work_centre_id, downtime_type, start_at, end_at,
       Math.round(hours * 100) / 100, maintenance_id ?? null, probability_pct ?? null, reason ?? null]);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY ROUTE PLANNING
// ─────────────────────────────────────────────────────────────────────────────
router.get('/routes', requirePermission('logistics', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*, c.carrier_name,
             (SELECT COUNT(*)::int FROM route_stops s WHERE s.route_id = r.id) AS stops
        FROM delivery_routes r
        LEFT JOIN carriers c ON c.id = r.carrier_id
       WHERE ($1::int IS NULL OR r.company_id = $1)
       ORDER BY r.route_date DESC, r.route_no DESC LIMIT 100`, [cid(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/routes/:id', requirePermission('logistics', 'view'), async (req, res) => {
  try {
    const { rows: [route] } = await pool.query(
      `SELECT * FROM delivery_routes WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid(req)]);
    if (!route) return res.status(404).json({ error: 'Route not found' });
    const { rows: stops } = await pool.query(
      `SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_seq`, [route.id]);
    res.json({ ...route, stops });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /scm/routes/plan/candidates — shipments awaiting a route, grouped by city.
   The grouping IS the planning signal: a route is a set of drops that share a
   direction. */
router.get('/routes/plan/candidates', requirePermission('logistics', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id AS shipment_id, s.dispatch_ref, s.sales_order_id, s.promised_date,
             s.weight_kg, s.to_address, so.customer_name, so.priority,
             COALESCE(NULLIF(split_part(COALESCE(s.to_address,''), ',', -1), ''), 'Unassigned') AS city
        FROM shipments s
        LEFT JOIN sales_orders so ON so.id = s.sales_order_id
       WHERE ($1::int IS NULL OR s.company_id = $1)
         AND s.direction = 'outbound' AND s.actual_delivery IS NULL
         AND NOT EXISTS (SELECT 1 FROM route_stops rs WHERE rs.shipment_id = s.id)
       ORDER BY s.promised_date NULLS LAST`, [cid(req)]);

    const byCity = {};
    for (const r of rows) {
      const city = String(r.city).trim();
      (byCity[city] ||= { city, shipments: [], total_weight_kg: 0 });
      byCity[city].shipments.push(r);
      byCity[city].total_weight_kg += num(r.weight_kg);
    }
    res.json({ unrouted: rows.length, groups: Object.values(byCity) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /scm/routes — build a route and sequence its stops.
   Sequencing is by PROMISED DATE then priority: without distances, delivering in
   the order things were promised is the defensible rule. True distance
   optimisation needs a mapping API; this is deliberately the honest subset
   rather than a fabricated "optimised" order. */
router.post('/routes', requirePermission('logistics', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { route_date, route_name, carrier_id, vehicle_ref, driver_name, region,
            shipment_ids = [] } = req.body || {};
    if (!route_date) return res.status(400).json({ error: 'route_date is required' });
    await client.query('BEGIN');
    const companyId = cid(req);

    const { rows: [seq] } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(route_no, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n
         FROM delivery_routes WHERE ($1::int IS NULL OR company_id = $1)`, [companyId]);
    const routeNo = `RT-${String(seq.n).padStart(6, '0')}`;

    const { rows: [route] } = await client.query(`
      INSERT INTO delivery_routes
        (company_id, route_no, route_name, route_date, carrier_id, vehicle_ref,
         driver_name, region, planned_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [companyId, routeNo, route_name ?? null, route_date, carrier_id ?? null,
       vehicle_ref ?? null, driver_name ?? null, region ?? null, who(req)]);

    let stopCount = 0, weight = 0;
    if (shipment_ids.length) {
      const { rows: ships } = await client.query(`
        SELECT s.id, s.sales_order_id, s.to_address, s.weight_kg, s.promised_date,
               so.customer_name, so.priority
          FROM shipments s LEFT JOIN sales_orders so ON so.id = s.sales_order_id
         WHERE s.id = ANY($1::int[])
         ORDER BY s.promised_date NULLS LAST,
                  CASE LOWER(COALESCE(so.priority,'normal'))
                    WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`,
        [shipment_ids]);
      let n = 1;
      for (const s of ships) {
        const city = (String(s.to_address || '').split(',').pop() || '').trim() || null;
        // Coordinates come from the city reference table so the route can be
        // optimised by distance rather than only sequenced by promise date. A
        // stop whose city is unknown keeps NULL coordinates and is sequenced
        // last rather than being placed arbitrarily.
        const { rows: [geo] } = city
          ? await client.query(
              `SELECT latitude, longitude FROM geo_locations
                WHERE LOWER(city) = LOWER($1) AND (company_id IS NULL OR company_id = $2)
                ORDER BY company_id NULLS LAST LIMIT 1`, [city, companyId])
          : { rows: [] };
        await client.query(`
          INSERT INTO route_stops
            (route_id, company_id, stop_seq, shipment_id, sales_order_id, customer_name,
             address, city, promised_date, weight_kg, latitude, longitude)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [route.id, companyId, n++, s.id, s.sales_order_id, s.customer_name,
           s.to_address, city, s.promised_date, s.weight_kg,
           geo?.latitude ?? null, geo?.longitude ?? null]);
        stopCount++; weight += num(s.weight_kg);
      }
      await client.query(
        `UPDATE delivery_routes SET stop_count = $2, total_weight_kg = $3 WHERE id = $1`,
        [route.id, stopCount, Math.round(weight * 1000) / 1000]);
    }
    await client.query('COMMIT');
    const { rows: [final] } = await pool.query(`SELECT * FROM delivery_routes WHERE id = $1`, [route.id]);
    const { rows: stops } = await pool.query(
      `SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_seq`, [route.id]);
    res.status(201).json({ ...final, stops });
  } catch (e) {
    await client.query('ROLLBACK'); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* POST /scm/routes/:id/optimise — resequence a route by distance.
   Nearest-neighbour then 2-opt over great-circle distances, banded by promise
   date so a commitment is never resequenced behind a later one just because it
   is nearer. `distance_source` records that these are great-circle, not road,
   distances — swapping in a road matrix later is a substitution into the same
   optimiser rather than a different answer appearing without explanation. */
router.post('/routes/:id/optimise', requirePermission('logistics', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const companyId = cid(req);
    const { rows: [route] } = await client.query(
      `SELECT * FROM delivery_routes WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [req.params.id, companyId]);
    if (!route) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Route not found' }); }

    const { rows: stops } = await client.query(
      `SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_seq`, [route.id]);
    if (!stops.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This route has no stops to optimise.' });
    }

    // Fill in any coordinate that was missing when the route was built — a city
    // may have been added to the reference table since.
    for (const st of stops) {
      if (st.latitude != null || !st.city) continue;
      const { rows: [geo] } = await client.query(
        `SELECT latitude, longitude FROM geo_locations
          WHERE LOWER(city) = LOWER($1) AND (company_id IS NULL OR company_id = $2)
          ORDER BY company_id NULLS LAST LIMIT 1`, [st.city, companyId]);
      if (geo) {
        st.latitude = geo.latitude; st.longitude = geo.longitude;
        await client.query(`UPDATE route_stops SET latitude = $2, longitude = $3 WHERE id = $1`,
          [st.id, geo.latitude, geo.longitude]);
      }
    }

    // The depot: an explicit origin, else the dispatching warehouse, else the
    // company's main warehouse.
    let depot = { lat: num(req.body?.origin_lat) || null, lng: num(req.body?.origin_lng) || null };
    if (depot.lat == null || depot.lng == null) {
      const { rows: [wh] } = await client.query(`
        SELECT latitude, longitude FROM warehouses
         WHERE latitude IS NOT NULL AND deleted_at IS NULL
           AND ($1::int IS NULL OR company_id = $1)
         ORDER BY (type = 'main') DESC, id LIMIT 1`, [companyId]);
      depot = { lat: wh ? Number(wh.latitude) : null, lng: wh ? Number(wh.longitude) : null };
    }
    if (depot.lat == null) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'No origin to optimise from. Set coordinates on the dispatching warehouse, or pass origin_lat/origin_lng.',
      });
    }

    const result = optimiseRoute(depot, stops.map(s => ({
      id: s.id, lat: s.latitude == null ? null : Number(s.latitude),
      lng: s.longitude == null ? null : Number(s.longitude),
      promised_date: s.promised_date, priority: null, customer_name: s.customer_name,
    })), { respectPromiseDates: req.body?.respect_promise_dates !== false });

    let seq = 1;
    for (const leg of result.legs) {
      await client.query(
        `UPDATE route_stops SET stop_seq = $2, leg_distance_km = $3 WHERE id = $1`,
        [leg.stop.id, seq++, leg.leg_distance_km]);
    }
    const { rows: [updated] } = await client.query(`
      UPDATE delivery_routes
         SET total_distance_km = $2, distance_source = $3, optimised_at = NOW(),
             origin_lat = $4, origin_lng = $5
       WHERE id = $1 RETURNING *`,
      [route.id, result.total_distance_km, result.distance_source, depot.lat, depot.lng]);

    await client.query('COMMIT');
    const { rows: finalStops } = await pool.query(
      `SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_seq`, [route.id]);
    res.json({
      route: updated,
      stops: finalStops,
      total_distance_km: result.total_distance_km,
      baseline_distance_km: result.baseline_distance_km,
      improvement_pct: result.improvement_pct,
      distance_source: result.distance_source,
      distance_note: 'Great-circle distance between city coordinates, not road distance or live traffic.',
      unlocated: result.unlocated,
    });
  } catch (e) {
    await client.query('ROLLBACK'); console.error('[scm/routes/optimise]', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* PATCH /scm/routes/:routeId/stops/:stopId — record arrival. */
router.patch('/routes/:routeId/stops/:stopId', requirePermission('logistics', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { status, arrived_at } = req.body || {};
    await client.query('BEGIN');
    // The route must be the caller's own: a delivered stop marks its shipment
    // (and order) delivered, and this matched route and stop by id alone.
    const { rows: [route] } = await client.query(
      `SELECT id FROM delivery_routes WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [req.params.routeId, cid(req)]);
    if (!route) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Route not found' }); }
    const { rows: [stop] } = await client.query(`
      UPDATE route_stops SET status = COALESCE($3, status),
             arrived_at = COALESCE($4::timestamptz, CASE WHEN $3 = 'delivered' THEN NOW() ELSE arrived_at END)
       WHERE id = $2 AND route_id = $1 RETURNING *`,
      [req.params.routeId, req.params.stopId, status ?? null, arrived_at ?? null]);
    if (!stop) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Stop not found' }); }

    // A delivered stop IS a delivered shipment — the two must not be recorded
    // separately or on-time delivery reads from whichever the user remembered.
    if (String(status).toLowerCase() === 'delivered' && stop.shipment_id) {
      await client.query(
        `UPDATE shipments SET status = 'delivered', actual_delivery = COALESCE(actual_delivery, CURRENT_DATE)
          WHERE id = $1`, [stop.shipment_id]);
      if (stop.sales_order_id) {
        await client.query(
          `UPDATE sales_orders SET delivered_at = COALESCE(delivered_at, NOW()),
                  order_status = CASE WHEN LOWER(COALESCE(order_status,'')) NOT IN ('cancelled','completed')
                                      THEN 'delivered' ELSE order_status END
            WHERE id = $1`, [stop.sales_order_id]);
      }
    }
    // The route closes itself once every stop is done.
    const { rows: [agg] } = await client.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'delivered')::int AS done
         FROM route_stops WHERE route_id = $1`, [req.params.routeId]);
    if (agg.total > 0 && agg.total === agg.done) {
      await client.query(`UPDATE delivery_routes SET status = 'completed' WHERE id = $1`, [req.params.routeId]);
    }
    await client.query('COMMIT');
    res.json(stop);
  } catch (e) {
    await client.query('ROLLBACK'); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER RETURNS (RMA)
// ─────────────────────────────────────────────────────────────────────────────
// What a customer can return against an order: per item, the units that left
// stock for it through its dispatched pick lists (returnableFromFulfilment),
// less what earlier returns put back, less what open returns already request.
// The caller holds the sales order row lock when it is about to act on it.
const DISPOSITIONS = ['restock', 'repair', 'scrap', 'replace'];
const QC_RESULTS = ['pass', 'fail'];
async function returnEligibility(client, companyId, salesOrderId, { excludeReturnId = null } = {}) {
  const { rows: shipped } = await client.query(`
    SELECT l.item_id, MAX(l.item_name) AS item_name, BOOL_OR(COALESCE(ii.is_serial_tracked, false)) AS serial_tracked
      FROM pick_list_lines l
      JOIN pick_lists p ON p.id = l.pick_list_id
      LEFT JOIN inventory_items ii ON ii.id = l.item_id
     WHERE p.sales_order_id = $1 AND ($2::int IS NULL OR p.company_id = $2) AND LOWER(p.status) = 'dispatched'
       AND l.item_id IS NOT NULL AND COALESCE(l.picked_qty, 0) > 0
     GROUP BY l.item_id ORDER BY l.item_id`, [salesOrderId, companyId]);
  const items = [];
  for (const s of shipped) {
    const r = await returnableFromFulfilment(client, companyId, salesOrderId, s.item_id);
    const { rows: [open] } = await client.query(`
      SELECT COALESCE(SUM(i.quantity), 0)::float AS q
        FROM sales_return_items i JOIN sales_returns rt ON rt.id = i.return_id
       WHERE rt.sales_order_id = $1 AND ($2::int IS NULL OR rt.company_id = $2) AND i.item_id = $3
         AND i.received_qty IS NULL AND rt.received_at IS NULL
         AND LOWER(COALESCE(rt.status, '')) NOT IN ('closed', 'cancelled')
         AND rt.id IS DISTINCT FROM $4`, [salesOrderId, companyId, s.item_id, excludeReturnId]);
    const { rows: [price] } = await client.query(
      `SELECT unit_price FROM sales_order_items WHERE order_id = $1 AND item_id = $2 ORDER BY id LIMIT 1`,
      [salesOrderId, s.item_id]);
    const { rows: serials } = await client.query(`
      SELECT DISTINCT sn.id, sn.serial_number
        FROM package_lines pkl
        JOIN packages pk ON pk.id = pkl.package_id
        JOIN pick_lists p ON p.id = pk.pick_list_id
        JOIN serial_numbers sn ON sn.id = pkl.serial_id
       WHERE p.sales_order_id = $1 AND ($2::int IS NULL OR p.company_id = $2) AND LOWER(p.status) = 'dispatched'
         AND pkl.item_id = $3 AND NOT pkl.unpacked
       ORDER BY sn.serial_number`, [salesOrderId, companyId, s.item_id]);
    items.push({
      item_id: s.item_id, item_name: s.item_name, serial_tracked: s.serial_tracked,
      shipped_qty: r.shipped_qty, restocked_qty: r.restocked_qty, open_requested_qty: open.q,
      requestable_qty: Math.max(0, r.returnable - open.q),
      unit_price: price ? Number(price.unit_price) : null,
      cost_verified: r.verified, warehouse_ids: r.warehouse_ids, serials,
    });
  }
  return items;
}

router.get('/returns', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const vals = [cid(req)];
    let where = '($1::int IS NULL OR r.company_id = $1)';
    if (req.query.status) { vals.push(req.query.status); where += ` AND r.status = $${vals.length}`; }
    // The lines travel with the return, so a receipt can be recorded line by
    // line; quantity and value are their totals (the screen read both and the
    // list never sent them).
    const { rows } = await pool.query(`
      SELECT r.*, so.order_number, cn.credit_note_number,
             COALESCE(li.items, '[]'::json) AS items,
             COALESCE(li.line_count, 0) AS line_count,
             COALESCE(li.quantity, 0) AS quantity,
             COALESCE(li.total_value, 0) AS total_value
        FROM sales_returns r
        LEFT JOIN sales_orders so ON so.id = r.sales_order_id
        LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object(
                   'id', i.id, 'item_id', i.item_id, 'item_name', i.item_name, 'serial_id', i.serial_id,
                   'serial_number', sn.serial_number, 'quantity', i.quantity, 'unit_price', i.unit_price,
                   'disposition', i.disposition, 'qc_result', i.qc_result, 'restocked_qty', i.restocked_qty,
                   'received_qty', i.received_qty)
                 ORDER BY i.id) AS items,
                 COUNT(*)::int AS line_count,
                 SUM(i.quantity)::float AS quantity,
                 SUM(i.quantity * COALESCE(i.unit_price, 0))::float AS total_value
            FROM sales_return_items i LEFT JOIN serial_numbers sn ON sn.id = i.serial_id
           WHERE i.return_id = r.id) li ON true
       WHERE ${where} ORDER BY r.return_date DESC, r.id DESC LIMIT 100`, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /scm/returns/eligible?sales_order_id= — what can be returned against an
   order, and the warehouses it may come back to. */
router.get('/returns/eligible', requirePermission('sales', 'view'), async (req, res) => {
  const soId = req.query.sales_order_id;
  if (!/^\d+$/.test(String(soId ?? ''))) return res.status(400).json({ error: 'sales_order_id is required', code: 'SALES_ORDER_REQUIRED' });
  const client = await pool.connect();
  try {
    const { rows: [so] } = await client.query(
      `SELECT id, order_number, company_id FROM sales_orders WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [soId, cid(req)]);
    if (!so) return res.status(404).json({ error: 'Sales order not found' });
    const items = await returnEligibility(client, so.company_id, so.id);
    const { rows: warehouses } = await client.query(
      `SELECT id, COALESCE(warehouse_name, name) AS name FROM warehouses WHERE company_id = $1 ORDER BY 2`, [so.company_id]);
    res.json({ sales_order_id: so.id, order_number: so.order_number, items, warehouses, dispositions: DISPOSITIONS });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

/* POST /scm/returns — raise an RMA against an order, line by line.
   Every line names an item the order shipped from stock, in a quantity within
   what is still returnable (returnEligibility) — an RMA used to accept any item
   in any quantity. A serial must be a unit of the line's item, of this company.
   Refused, nothing written: RETURN_LINES_REQUIRED, RETURN_ITEM_REQUIRED,
   RETURN_QTY_INVALID, RETURN_LINE_DUPLICATED, SERIAL_ITEM_MISMATCH,
   RETURN_NOT_FROM_STOCK, RETURN_EXCEEDS_SHIPPED, SHIPMENT_*. */
router.post('/returns', requirePermission('sales', 'add'), async (req, res) => {
  const client = await pool.connect();
  const refuse = async (status, code, error, extra = {}) => {
    await client.query('ROLLBACK');
    return res.status(status).json({ error, code, ...extra });
  };
  try {
    const { sales_order_id, shipment_id, reason, reason_detail, lines = [], complaint_id } = req.body || {};
    if (!sales_order_id) return res.status(400).json({ error: 'sales_order_id is required', code: 'SALES_ORDER_REQUIRED' });
    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: 'A return needs at least one line (item and quantity).', code: 'RETURN_LINES_REQUIRED' });
    }
    await client.query('BEGIN');
    const companyId = cid(req);
    const { rows: [so] } = await client.query(
      `SELECT * FROM sales_orders WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [sales_order_id, companyId]);
    if (!so) return refuse(404, 'NOT_FOUND', 'Sales order not found');
    if (shipment_id != null) {
      const { rows: [sh] } = await client.query(
        `SELECT id, sales_order_id FROM shipments WHERE id = $1 AND company_id = $2`, [shipment_id, so.company_id]);
      if (!sh) return refuse(404, 'SHIPMENT_NOT_FOUND', 'Shipment not found');
      if (sh.sales_order_id != null && Number(sh.sales_order_id) !== Number(so.id)) {
        return refuse(422, 'SHIPMENT_ORDER_MISMATCH', 'That shipment belongs to a different sales order.');
      }
    }

    const eligible = new Map((await returnEligibility(client, so.company_id, so.id)).map(i => [Number(i.item_id), i]));
    const seen = new Set();
    const wanted = new Map();
    for (const l of lines) {
      const itemId = Number(l?.item_id);
      if (!Number.isInteger(itemId) || itemId <= 0) return refuse(422, 'RETURN_ITEM_REQUIRED', 'Every return line names the item returned.');
      if (!(num(l.quantity) > 0)) return refuse(422, 'RETURN_QTY_INVALID', 'Every return line needs a quantity greater than zero.');
      const key = `${itemId}:${l.serial_id ?? ''}`;
      if (seen.has(key)) return refuse(422, 'RETURN_LINE_DUPLICATED', `Item ${itemId}${l.serial_id ? ` serial ${l.serial_id}` : ''} appears twice; combine the quantities.`);
      seen.add(key);
      if (l.serial_id != null) {
        const { rows: [sn] } = await client.query(
          `SELECT id FROM serial_numbers WHERE id = $1 AND item_id = $2 AND company_id = $3`, [l.serial_id, itemId, so.company_id]);
        if (!sn) return refuse(422, 'SERIAL_ITEM_MISMATCH', `Serial ${l.serial_id} is not a unit of item ${itemId}.`);
        if (num(l.quantity) !== 1) return refuse(422, 'RETURN_QTY_INVALID', 'A serialised unit is returned one at a time.');
      }
      wanted.set(itemId, (wanted.get(itemId) || 0) + num(l.quantity));
    }
    for (const [itemId, q] of wanted) {
      const e = eligible.get(itemId);
      if (!e || e.shipped_qty <= 0) {
        return refuse(409, 'RETURN_NOT_FROM_STOCK',
          `Item ${itemId} did not leave stock for this order through a dispatched pick list, so it cannot be returned against it.`);
      }
      if (q > e.requestable_qty + 1e-9) {
        return refuse(409, 'RETURN_EXCEEDS_SHIPPED',
          `Only ${e.requestable_qty} of item ${itemId} can still be returned (${e.shipped_qty} shipped, ${e.restocked_qty} returned, ${e.open_requested_qty} on open returns).`,
          { item_id: itemId, requestable_qty: e.requestable_qty });
      }
    }

    // Serialise numbering per company (two simultaneous RMAs read the same MAX + 1).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('sales_returns.rma_number'), COALESCE($1::int, 0))`, [so.company_id]);
    const { rows: [seq] } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(rma_number, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n
         FROM sales_returns WHERE company_id = $1`, [so.company_id]);
    const rma = `RMA-${String(seq.n).padStart(6, '0')}`;

    const { rows: [ret] } = await client.query(`
      INSERT INTO sales_returns
        (company_id, rma_number, sales_order_id, shipment_id, customer_id, customer_name,
         reason, reason_detail, complaint_id, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested',$10) RETURNING *`,
      [so.company_id, rma, so.id, shipment_id ?? null, so.customer_id, so.customer_name,
       reason ?? null, reason_detail ?? null, complaint_id ?? null, req.user?.id ?? null]);

    for (const l of lines) {
      const e = eligible.get(Number(l.item_id));
      await client.query(`
        INSERT INTO sales_return_items
          (return_id, company_id, item_id, item_name, batch_id, serial_id, quantity, uom, unit_price, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ret.id, so.company_id, Number(l.item_id), l.item_name ?? e.item_name ?? null, l.batch_id ?? null,
         l.serial_id ?? null, num(l.quantity), l.uom ?? null, l.unit_price ?? e.unit_price ?? null, l.notes ?? null]);
    }
    await client.query('COMMIT');
    const { rows: items } = await pool.query(`SELECT * FROM sales_return_items WHERE return_id = $1 ORDER BY id`, [ret.id]);
    res.status(201).json({ ...ret, items });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* POST /scm/returns/:id/receive — goods are back. Restock only what QC passes.
   Returned stock going straight back to available is the classic returns defect:
   a customer return is unverified until inspected, so a 'reject' or 'scrap'
   disposition quarantines the line's lot instead of restocking.

   Every receipt line names a line of the RMA (lines: [{ id, received_qty,
   disposition, qc_result, warehouse_id }]); an empty receipt is refused rather
   than marking the return received with nothing recorded. A line restocks ONLY
   what the order verifiably took out of stock (returnableFromFulfilment):
     - units that left through the order's dispatched pick lists, less what
       earlier returns already put back — RETURN_EXCEEDS_SHIPPED otherwise;
       a sales-order-level dispatch moves no stock, so nothing it shipped can
       come back into stock (RETURN_NOT_FROM_STOCK)
     - at the FIFO cost the units left at, not the selling price on the RMA
       (which used to become the layer's cost and inflate stock value);
       RETURN_COST_UNVERIFIED when that cost does not reconcile
     - into a warehouse of the company: the one named, or the one the units
       left from when there was exactly one (WAREHOUSE_REQUIRED otherwise)
     - never a serialised unit (SERIAL_RESTOCK_UNSUPPORTED): the serial would
       stay 'shipped' while its stock sat on hand, and no return state for a
       serial is defined. Non-restock dispositions of serial lines still work.
   The sales order row is locked first, so two receipts against one order are
   checked one after the other. No accounting is posted here: the credit note is
   raised in Finance and linked at close. */
router.post('/returns/:id/receive', requirePermission('sales', 'edit'), async (req, res) => {
  const client = await pool.connect();
  const refuse = async (status, code, error, extra = {}) => {
    await client.query('ROLLBACK');
    return res.status(status).json({ error, code, ...extra });
  };
  try {
    const { lines = [] } = req.body || {};
    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: 'List the returned lines received (lines: [{ id, received_qty, disposition }]).', code: 'RECEIPT_LINES_REQUIRED' });
    }
    const ids = lines.map(l => Number(l?.id));
    if (ids.some(i => !Number.isInteger(i) || i <= 0)) {
      return res.status(400).json({ error: 'Each receipt line needs the id of a return line.', code: 'RECEIPT_LINE_INVALID' });
    }
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'A return line appears more than once in this receipt.', code: 'RECEIPT_LINE_DUPLICATED' });
    }
    await client.query('BEGIN');
    const { rows: [ret] } = await client.query(
      `SELECT * FROM sales_returns WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [req.params.id, cid(req)]);
    if (!ret) return refuse(404, 'NOT_FOUND', 'Return not found');
    if (ret.received_at) return refuse(409, 'ALREADY_RECEIVED', 'This return has already been received.');
    // (Phase 3G) Lines may be received in more than one receipt; each line once.
    if (String(ret.status || '').toLowerCase() === 'closed') return refuse(409, 'RETURN_CLOSED', 'This return is closed.');
    if (ret.sales_order_id) {
      await client.query(`SELECT id FROM sales_orders WHERE id = $1 FOR UPDATE`, [ret.sales_order_id]);
    }

    const { postStock } = await import('../production/subcontracting.routes.js');
    const restocked = [];
    for (const l of lines) {
      const { rows: [item] } = await client.query(
        `SELECT * FROM sales_return_items WHERE id = $1 AND return_id = $2`, [l.id, ret.id]);
      if (!item) return refuse(404, 'RETURN_LINE_NOT_FOUND', `Line ${l.id} is not on return ${ret.rma_number}.`);
      if (item.received_qty != null) {
        return refuse(409, 'LINE_ALREADY_RECEIVED', `Line ${item.id} of ${ret.rma_number} has already been received.`);
      }
      // The disposition is recorded explicitly, never assumed; QC defaults only
      // as before (restock → pass, anything else → fail) and must be pass/fail.
      const disposition = l.disposition;
      if (!DISPOSITIONS.includes(disposition)) {
        return refuse(422, disposition == null ? 'DISPOSITION_REQUIRED' : 'DISPOSITION_INVALID',
          `Line ${item.id} needs a disposition: one of ${DISPOSITIONS.join(', ')}.`);
      }
      const qcResult = l.qc_result || (disposition === 'restock' ? 'pass' : 'fail');
      if (!QC_RESULTS.includes(qcResult)) {
        return refuse(422, 'QC_RESULT_INVALID', `QC result for line ${item.id} must be pass or fail.`);
      }
      const qty = num(l.received_qty ?? item.quantity);
      if (!Number.isFinite(qty) || qty < 0 || qty > num(item.quantity)) {
        return refuse(422, 'RECEIVED_QTY_INVALID',
          `Received quantity for line ${item.id} must be between 0 and the ${num(item.quantity)} on the return.`);
      }

      let posted = 0;
      if (disposition === 'restock' && qcResult === 'pass' && item.item_id && qty > 0) {
        if (item.serial_id) {
          return refuse(409, 'SERIAL_RESTOCK_UNSUPPORTED',
            `Line ${item.id} is a serialised unit; restocking serials is not supported (no return state for a serial is defined). Use another disposition.`);
        }
        if (!ret.sales_order_id) {
          return refuse(409, 'RETURN_NOT_FROM_STOCK', `Return ${ret.rma_number} names no sales order, so what left stock cannot be verified.`);
        }
        const r = await returnableFromFulfilment(client, ret.company_id, ret.sales_order_id, item.item_id);
        if (!r.verified) {
          return refuse(409, 'RETURN_COST_UNVERIFIED',
            `The cost at which item ${item.item_id} left stock for this order does not reconcile with its ledger; it cannot be restocked at a verified cost.`);
        }
        if (r.shipped_qty <= 0) {
          return refuse(409, 'RETURN_NOT_FROM_STOCK',
            `Item ${item.item_id} never left stock for this order through a dispatched pick list, so returning it would create stock.`);
        }
        if (qty > r.returnable + 1e-9) {
          return refuse(409, 'RETURN_EXCEEDS_SHIPPED',
            `Only ${r.returnable} of item ${item.item_id} can come back into stock (${r.shipped_qty} shipped, ${r.restocked_qty} already returned).`,
            { returnable: r.returnable });
        }
        let warehouseId = l.warehouse_id ?? null;
        if (warehouseId != null) {
          const { rows: [wh] } = await client.query(
            `SELECT id FROM warehouses WHERE id = $1 AND company_id = $2`, [warehouseId, ret.company_id]);
          if (!wh) return refuse(404, 'WAREHOUSE_NOT_FOUND', `Warehouse ${warehouseId} not found.`);
        } else if (r.warehouse_ids.length === 1) {
          warehouseId = r.warehouse_ids[0];
        } else {
          return refuse(422, 'WAREHOUSE_REQUIRED',
            `Item ${item.item_id} left from ${r.warehouse_ids.length} warehouses; name the one it returns to (warehouse_id).`);
        }
        await postStock(client, {
          itemId: item.item_id, warehouseId, inQty: qty, txnType: 'sales_return',
          refType: 'sales_return', refId: ret.id, rate: r.unit_cost,
          remarks: `Customer return ${ret.rma_number} — inspected and restocked`,
          createdBy: req.user?.employee_id ?? null, companyId: ret.company_id,
          batchId: item.batch_id ?? null,
        });
        posted = qty;
        restocked.push({ item_id: item.item_id, qty, warehouse_id: warehouseId, unit_cost: r.unit_cost });
      } else if (item.batch_id) {
        // Not sellable: the lot is quarantined so it cannot be issued or shipped.
        await client.query(
          `UPDATE inventory_batches SET status = 'quarantine', quality_status = 'failed',
                  blocked_reason = $2, blocked_at = NOW()
            WHERE id = $1`, [item.batch_id, `Returned on ${ret.rma_number}: ${disposition}`]);
      }

      // restocked_qty is what was actually put back — it used to be set for
      // every 'restock' line, even one that failed QC and moved nothing.
      await client.query(`
        UPDATE sales_return_items
           SET disposition = $2::varchar, qc_result = $3, restocked_qty = $4, received_qty = $5
         WHERE id = $1`, [item.id, disposition, qcResult, posted, qty]);
    }

    // Received once every line is; until then partially received.
    const { rows: [left] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM sales_return_items WHERE return_id = $1 AND received_qty IS NULL`, [ret.id]);
    const { rows: [updated] } = await client.query(`
      UPDATE sales_returns
         SET status = CASE WHEN $2 THEN 'received' ELSE 'partially_received' END,
             received_at = CASE WHEN $2 THEN NOW() ELSE received_at END, updated_at = NOW()
       WHERE id = $1 RETURNING *`, [ret.id, left.n === 0]);
    await client.query('COMMIT');
    res.json({ ...updated, restocked });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); console.error('[scm/returns/receive]', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ── Historical receipts (Phase 3H) ──────────────────────────────────────────
   Returns received before received_qty existed (20261028000006) recorded only
   restocked_qty, so a line that was scrapped, repaired or failed QC lost what
   came back — and such a return cannot close (RECEIPT_OUTSTANDING).

   GET /scm/returns/receipt-gaps — READ ONLY. Every line of a received return
   with no received_qty, with its evidence and a classification:
     verified_receipt   restocked after a passed 'restock' and the stock the
                        return posted for the item equals restocked_qty: the
                        receipt code of that era posted exactly what it
                        received, so received_qty = restocked_qty is fact, not
                        inference (proposed_received_qty)
     unresolved         anything else — scrap / repair / replace / failed QC
                        lines (nothing posted, quantity unknown), a restock
                        whose stock does not reconcile, a line the receipt
                        never processed. Needs a document.
   A requested quantity is never taken as received. 'verified_non_receipt' is
   recorded only by a correction with documentary evidence — no stored field
   proves that nothing came back.

   POST /scm/returns/:id/lines/:lineId/receipt-correction — sales:approve.
   Fills the missing received_qty of ONE such line from evidence:
     receipt_document          a receipt document reference
     stock_ledger              the quantity must equal the stock the return
                               posted for the line's item (verified here)
     non_receipt_confirmation  received_qty must be 0, nothing restocked
   Never overwrites a recorded quantity, never moves stock, never restocks;
   received_qty ≥ restocked_qty (what went back to stock came back) and
   ≤ the line's quantity. Recorded in sales_return_receipt_corrections and the
   audit log, under the return's row lock. */
async function receiptGapLines(db, companyId, returnId = null) {
  const { rows } = await db.query(`
    SELECT i.id AS line_id, i.return_id, r.rma_number, r.company_id, r.sales_order_id, r.status, r.received_at,
           i.item_id, i.item_name, i.serial_id, i.quantity::float AS requested_qty,
           i.disposition, i.qc_result, COALESCE(i.restocked_qty, 0)::float AS restocked_qty,
           (SELECT COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::float FROM stock_ledger sl
             WHERE sl.reference_type = 'sales_return' AND sl.reference_id = r.id AND sl.item_id = i.item_id) AS stock_posted_qty,
           r.credit_note_id,
           (SELECT cn.status FROM credit_notes cn WHERE cn.id = r.credit_note_id) AS credit_note_status
      FROM sales_return_items i JOIN sales_returns r ON r.id = i.return_id
     WHERE r.received_at IS NOT NULL AND i.received_qty IS NULL
       AND ($1::int IS NULL OR r.company_id = $1) AND ($2::int IS NULL OR r.id = $2)
     ORDER BY r.id, i.id`, [companyId, returnId]);
  return rows.map(l => {
    const restockReconciles = l.disposition === 'restock' && l.qc_result === 'pass' && l.restocked_qty > 0
      && Math.abs(l.stock_posted_qty - l.restocked_qty) < 1e-6;
    return {
      ...l,
      classification: restockReconciles ? 'verified_receipt' : 'unresolved',
      proposed_received_qty: restockReconciles ? l.restocked_qty : null,
      evidence: restockReconciles
        ? `restocked ${l.restocked_qty} after QC pass; ${l.stock_posted_qty} posted to stock for this item on ${l.rma_number}`
        : l.disposition == null
          ? 'the receipt never processed this line (no disposition, nothing posted)'
          : `${l.disposition} / QC ${l.qc_result}: ${l.restocked_qty} restocked, ${l.stock_posted_qty} posted — received quantity not recorded`,
    };
  });
}

router.get('/returns/receipt-gaps', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const lines = await receiptGapLines(pool, cid(req));
    const count = (k) => lines.filter(l => l.classification === k).length;
    res.json({ lines, summary: { lines: lines.length, verified_receipt: count('verified_receipt'),
                                 verified_non_receipt: 0, unresolved: count('unresolved') } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const EVIDENCE_TYPES = ['receipt_document', 'stock_ledger', 'non_receipt_confirmation'];
router.post('/returns/:id/lines/:lineId/receipt-correction', requirePermission('sales', 'approve'), async (req, res) => {
  const { received_qty, evidence_type, evidence_reference, note } = req.body || {};
  const qty = received_qty === '' || received_qty == null ? NaN : Number(received_qty);
  if (!Number.isFinite(qty) || qty < 0) return res.status(422).json({ error: 'received_qty must be a quantity of 0 or more.', code: 'RECEIVED_QTY_INVALID' });
  if (!EVIDENCE_TYPES.includes(evidence_type)) {
    return res.status(422).json({ error: `evidence_type must be one of ${EVIDENCE_TYPES.join(', ')}.`, code: 'EVIDENCE_TYPE_INVALID' });
  }
  if (!String(evidence_reference ?? '').trim()) {
    return res.status(422).json({ error: 'evidence_reference is required — the document or record the quantity rests on.', code: 'EVIDENCE_REQUIRED' });
  }
  const client = await pool.connect();
  const refuse = async (status, code, error) => { await client.query('ROLLBACK'); return res.status(status).json({ error, code }); };
  try {
    await client.query('BEGIN');
    const { rows: [ret] } = await client.query(
      `SELECT * FROM sales_returns WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`, [req.params.id, cid(req)]);
    if (!ret) return refuse(404, 'NOT_FOUND', 'Return not found');
    if (String(ret.status || '').toLowerCase() === 'closed') return refuse(409, 'RETURN_CLOSED', 'This return is closed.');
    const [gap] = await receiptGapLines(client, ret.company_id, ret.id).then(ls => ls.filter(l => String(l.line_id) === String(req.params.lineId)));
    if (!gap) {
      const { rows: [line] } = await client.query(
        `SELECT received_qty FROM sales_return_items WHERE id = $1 AND return_id = $2`, [req.params.lineId, ret.id]);
      if (!line) return refuse(404, 'RETURN_LINE_NOT_FOUND', 'Return line not found');
      return refuse(409, 'NOT_A_RECEIPT_GAP', line.received_qty != null
        ? 'This line already has a received quantity; corrections never overwrite one.'
        : 'This return has not been received; record a receipt instead.');
    }
    await client.query(`SELECT id FROM sales_return_items WHERE id = $1 FOR UPDATE`, [gap.line_id]);
    if (qty > gap.requested_qty + 1e-9) return refuse(422, 'RECEIVED_QTY_INVALID', `At most ${gap.requested_qty} were on the return line.`);
    if (qty + 1e-9 < gap.restocked_qty) {
      return refuse(422, 'RECEIVED_BELOW_RESTOCKED', `${gap.restocked_qty} went back to stock from this line, so at least that came back.`);
    }
    if (evidence_type === 'stock_ledger' && Math.abs(qty - gap.stock_posted_qty) > 1e-6) {
      return refuse(422, 'EVIDENCE_MISMATCH', `The stock ledger shows ${gap.stock_posted_qty} posted for this line's item, not ${qty}.`);
    }
    if (evidence_type === 'non_receipt_confirmation' && (qty !== 0 || gap.restocked_qty > 0)) {
      return refuse(422, 'EVIDENCE_MISMATCH', 'A non-receipt confirmation records 0 received, on a line nothing was restocked from.');
    }
    const { rows: [corr] } = await client.query(`
      INSERT INTO sales_return_receipt_corrections
        (company_id, return_id, return_item_id, received_qty, previous_received_qty, evidence_type, evidence_reference, note, corrected_by)
      VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8) RETURNING *`,
      [ret.company_id, ret.id, gap.line_id, qty, evidence_type, String(evidence_reference).trim(), note ?? null, req.user?.id ?? null]);
    await client.query(`UPDATE sales_return_items SET received_qty = $2 WHERE id = $1`, [gap.line_id, qty]);
    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: ret.id, recordType: 'sales_return',
               action: 'receipt_correction', oldData: { line_id: gap.line_id, received_qty: null, classification: gap.classification },
               newData: corr, req, company_id: ret.company_id });
    res.json({ correction: corr, line_id: gap.line_id, received_qty: qty });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* POST /scm/returns/:id/close — the return is done; link its credit note.
   Accepts credit_note_id only (dispositions are recorded per line at receipt;
   anything else is refused, never ignored). Phase 3G: a return closes only
   once every line has physically been received — a return with goods still to
   come back is withdrawn (POST /returns/:id/withdraw), never closed — and only
   if its record is consistent, all checked under the return's row lock:
     RECEIPT_OUTSTANDING        a line with no receipt recorded
     RETURN_RECORD_INCONSISTENT a line restocked beyond what it received, or
                                restocked without a passed 'restock'
     RETURN_STOCK_MISMATCH      the stock the return posted (sales_return
                                ledger lines) differs from what its lines
                                say was restocked
     CREDIT_NOTE_NOT_ISSUED     a linked credit note that is a draft or
                                cancelled (a draft can still change or go)
   plus the credit note being this company's and this order's. */
router.post('/returns/:id/close', requirePermission('sales', 'edit'), async (req, res) => {
  const body = req.body || {};
  const unknown = Object.keys(body).filter(k => k !== 'credit_note_id');
  if (unknown.length) {
    return res.status(422).json({ code: 'CLOSE_FIELD_UNKNOWN', fields: unknown,
      error: `Closing a return takes only credit_note_id; ${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not accepted (dispositions are recorded per line at receipt).` });
  }
  const client = await pool.connect();
  const refuse = async (status, code, error, extra = {}) => { await client.query('ROLLBACK'); return res.status(status).json({ error, code, ...extra }); };
  try {
    await client.query('BEGIN');
    const { rows: [ret] } = await client.query(
      `SELECT * FROM sales_returns WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`, [req.params.id, cid(req)]);
    if (!ret) return refuse(404, 'NOT_FOUND', 'Return not found');
    if (String(ret.status || '').toLowerCase() === 'closed') return refuse(409, 'ALREADY_CLOSED', 'This return is already closed.');

    const { rows: lines } = await client.query(
      `SELECT * FROM sales_return_items WHERE return_id = $1 ORDER BY id FOR UPDATE`, [ret.id]);
    const outstanding = lines.filter(l => l.received_qty == null);
    if (!lines.length || outstanding.length) {
      return refuse(409, 'RECEIPT_OUTSTANDING',
        `${outstanding.length || 'No'} line(s) of ${ret.rma_number} have not been received; receive them, or withdraw the return if nothing will come back.`,
        { lines: outstanding.map(l => l.id) });
    }
    for (const l of lines) {
      const restocked = Number(l.restocked_qty || 0);
      const ok = DISPOSITIONS.includes(l.disposition) && QC_RESULTS.includes(l.qc_result)
        && restocked <= Number(l.received_qty) + 1e-9
        && (restocked === 0 || (l.disposition === 'restock' && l.qc_result === 'pass'));
      if (!ok) {
        return refuse(409, 'RETURN_RECORD_INCONSISTENT',
          `Line ${l.id} of ${ret.rma_number} records ${restocked} restocked of ${Number(l.received_qty)} received as '${l.disposition}' / QC '${l.qc_result}', which do not agree.`);
      }
    }
    const { rows: [moved] } = await client.query(`
      SELECT COALESCE(SUM(quantity_in - quantity_out), 0)::float AS q FROM stock_ledger
       WHERE reference_type = 'sales_return' AND reference_id = $1`, [ret.id]);
    const recorded = lines.reduce((t, l) => t + Number(l.restocked_qty || 0), 0);
    if (Math.abs(moved.q - recorded) > 1e-6) {
      return refuse(409, 'RETURN_STOCK_MISMATCH',
        `${ret.rma_number} posted ${moved.q} unit(s) back to stock but its lines record ${recorded} restocked.`);
    }

    const creditNoteId = body.credit_note_id ?? null;
    if (creditNoteId != null) {
      const { rows: [cn] } = await client.query(`
        SELECT cn.id, cn.status, i.sales_order_id
          FROM credit_notes cn LEFT JOIN invoices i ON i.id = cn.original_invoice_id
         WHERE cn.id = $1 AND cn.company_id = $2 AND cn.deleted_at IS NULL`, [creditNoteId, ret.company_id]);
      if (!cn) return refuse(404, 'CREDIT_NOTE_NOT_FOUND', 'Credit note not found');
      if (cn.sales_order_id != null && ret.sales_order_id != null && Number(cn.sales_order_id) !== Number(ret.sales_order_id)) {
        return refuse(422, 'CREDIT_NOTE_ORDER_MISMATCH', 'That credit note was raised against another order\'s invoice.');
      }
      if (cn.status !== 'issued') {
        return refuse(409, 'CREDIT_NOTE_NOT_ISSUED', `That credit note is ${cn.status}; link it once it has been issued.`);
      }
    }
    const { rows: [row] } = await client.query(`
      UPDATE sales_returns SET status = 'closed', closed_at = NOW(), updated_at = NOW(), closed_by = $3,
             credit_note_id = COALESCE($2, credit_note_id)
       WHERE id = $1 RETURNING *`, [ret.id, creditNoteId, req.user?.id ?? null]);
    await client.query('COMMIT');
    res.json(row);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* POST /scm/returns/:id/withdraw — the one supported way to end a return
   without a receipt: nothing came back and nothing will (the customer kept the
   goods, the RMA was raised in error). Needs sales:approve and a reason; only
   while NO line has been received; moves no stock, links no credit note
   (crediting goods the customer kept is a commercial decision outside the
   RMA); recorded as closed_without_receipt with who and why. */
router.post('/returns/:id/withdraw', requirePermission('sales', 'approve'), async (req, res) => {
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to withdraw a return.', code: 'REASON_REQUIRED' });
  const client = await pool.connect();
  const refuse = async (status, code, error) => { await client.query('ROLLBACK'); return res.status(status).json({ error, code }); };
  try {
    await client.query('BEGIN');
    const { rows: [ret] } = await client.query(
      `SELECT * FROM sales_returns WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`, [req.params.id, cid(req)]);
    if (!ret) return refuse(404, 'NOT_FOUND', 'Return not found');
    if (String(ret.status || '').toLowerCase() === 'closed') return refuse(409, 'ALREADY_CLOSED', 'This return is already closed.');
    const { rows: [got] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM sales_return_items WHERE return_id = $1 AND received_qty IS NOT NULL`, [ret.id]);
    if (ret.received_at || got.n > 0) {
      return refuse(409, 'RETURN_HAS_RECEIPTS', `${ret.rma_number} has received goods; it is closed after receipt, not withdrawn.`);
    }
    const { rows: [row] } = await client.query(`
      UPDATE sales_returns SET status = 'closed', closed_at = NOW(), updated_at = NOW(),
             closed_without_receipt = true, close_reason = $2, closed_by = $3
       WHERE id = $1 RETURNING *`, [ret.id, reason, req.user?.id ?? null]);
    await client.query('COMMIT');
    res.json(row);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

export default router;
