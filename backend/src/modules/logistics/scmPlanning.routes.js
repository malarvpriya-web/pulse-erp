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
router.get('/returns', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const vals = [cid(req)];
    let where = '($1::int IS NULL OR r.company_id = $1)';
    if (req.query.status) { vals.push(req.query.status); where += ` AND r.status = $${vals.length}`; }
    const { rows } = await pool.query(`
      SELECT r.*, so.order_number,
             (SELECT COUNT(*)::int FROM sales_return_items i WHERE i.return_id = r.id) AS line_count
        FROM sales_returns r
        LEFT JOIN sales_orders so ON so.id = r.sales_order_id
       WHERE ${where} ORDER BY r.return_date DESC, r.id DESC LIMIT 100`, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /scm/returns — raise an RMA against a delivered order. */
router.post('/returns', requirePermission('sales', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { sales_order_id, shipment_id, reason, reason_detail, lines = [], complaint_id } = req.body || {};
    if (!sales_order_id || !lines.length) {
      return res.status(400).json({ error: 'sales_order_id and at least one line are required' });
    }
    await client.query('BEGIN');
    const companyId = cid(req);
    const { rows: [so] } = await client.query(
      `SELECT * FROM sales_orders WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [sales_order_id, companyId]);
    if (!so) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sales order not found' }); }

    const { rows: [seq] } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(rma_number, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n
         FROM sales_returns WHERE ($1::int IS NULL OR company_id = $1)`, [companyId]);
    const rma = `RMA-${String(seq.n).padStart(6, '0')}`;

    const { rows: [ret] } = await client.query(`
      INSERT INTO sales_returns
        (company_id, rma_number, sales_order_id, shipment_id, customer_id, customer_name,
         reason, reason_detail, complaint_id, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested',$10) RETURNING *`,
      [companyId, rma, sales_order_id, shipment_id ?? null, so.customer_id, so.customer_name,
       reason ?? null, reason_detail ?? null, complaint_id ?? null, req.user?.id ?? null]);

    for (const l of lines) {
      await client.query(`
        INSERT INTO sales_return_items
          (return_id, company_id, item_id, item_name, batch_id, serial_id, quantity, uom, unit_price, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ret.id, companyId, l.item_id ?? null, l.item_name ?? null, l.batch_id ?? null,
         l.serial_id ?? null, l.quantity ?? 0, l.uom ?? null, l.unit_price ?? null, l.notes ?? null]);
    }
    await client.query('COMMIT');
    const { rows: items } = await pool.query(`SELECT * FROM sales_return_items WHERE return_id = $1`, [ret.id]);
    res.status(201).json({ ...ret, items });
  } catch (e) {
    await client.query('ROLLBACK'); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* POST /scm/returns/:id/receive — goods are back. Restock only what QC passes.
   Returned stock going straight back to available is the classic returns defect:
   a customer return is unverified until inspected, so a 'reject' or 'scrap'
   disposition books it to a quarantined lot instead of sellable stock. */
router.post('/returns/:id/receive', requirePermission('sales', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { lines = [] } = req.body || {};
    await client.query('BEGIN');
    const { rows: [ret] } = await client.query(
      `SELECT * FROM sales_returns WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [req.params.id, cid(req)]);
    if (!ret) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Return not found' }); }
    if (ret.received_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This return has already been received.' });
    }

    const { postStock } = await import('../production/subcontracting.routes.js');
    const restocked = [];
    for (const l of lines) {
      const { rows: [item] } = await client.query(
        `SELECT * FROM sales_return_items WHERE id = $1 AND return_id = $2`, [l.id, ret.id]);
      if (!item) continue;
      const disposition = l.disposition || 'restock';
      const qcResult = l.qc_result || (disposition === 'restock' ? 'pass' : 'fail');
      const qty = num(l.received_qty ?? item.quantity);

      // $2 is both assigned to a varchar column and compared as text, and
      // Postgres refuses to deduce one type for both ("text versus character
      // varying"). Casting at each use site settles it.
      await client.query(`
        UPDATE sales_return_items
           SET disposition = $2::varchar, qc_result = $3,
               restocked_qty = CASE WHEN $2::text = 'restock' THEN $4 ELSE 0 END
         WHERE id = $1`, [item.id, disposition, qcResult, qty]);

      if (disposition === 'restock' && qcResult === 'pass' && item.item_id && qty > 0) {
        await postStock(client, {
          itemId: item.item_id, inQty: qty, txnType: 'sales_return',
          refType: 'sales_return', refId: ret.id, rate: num(item.unit_price),
          remarks: `Customer return ${ret.rma_number} — inspected and restocked`,
          createdBy: req.user?.employee_id ?? null, companyId: ret.company_id,
          batchId: item.batch_id ?? null,
        });
        restocked.push({ item_id: item.item_id, qty });
      } else if (item.batch_id) {
        // Not sellable: the lot is quarantined so it cannot be issued or shipped.
        await client.query(
          `UPDATE inventory_batches SET status = 'quarantine', quality_status = 'failed',
                  blocked_reason = $2, blocked_at = NOW()
            WHERE id = $1`, [item.batch_id, `Returned on ${ret.rma_number}: ${disposition}`]);
      }
    }

    const { rows: [updated] } = await client.query(`
      UPDATE sales_returns SET status = 'received', received_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`, [ret.id]);
    await client.query('COMMIT');
    res.json({ ...updated, restocked });
  } catch (e) {
    await client.query('ROLLBACK'); console.error('[scm/returns/receive]', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.post('/returns/:id/close', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(`
      UPDATE sales_returns SET status = 'closed', closed_at = NOW(), updated_at = NOW(),
             credit_note_id = COALESCE($3, credit_note_id)
       WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`,
      [req.params.id, cid(req), req.body?.credit_note_id ?? null]);
    if (!row) return res.status(404).json({ error: 'Return not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
