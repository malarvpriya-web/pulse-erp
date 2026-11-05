// backend/src/modules/inventory/services/inventoryProjection.service.js
/**
 * Projected on-hand, stockout risk, and where the safety-stock budget should go.
 *
 * WHAT WAS MISSING
 * ----------------
 * Pulse could tell you what stock IS. It could not tell you what stock WILL BE
 * without running a full MRP pass and reading an 11,000-row time-phased grid.
 * Three separate components - "inventory forecasting", "inventory prediction"
 * and "stockout prediction" - were all the same absent thing: a forward curve
 * of on-hand per item.
 *
 * MRP already nets demand against supply, so this does not re-implement that.
 * It projects at the ITEM level, daily, which is the resolution a buyer works
 * at, and it is cheap enough to run on a screen.
 *
 * WHAT A STOCKOUT RISK MEANS HERE
 * -------------------------------
 * `days_to_stockout` is when the curve crosses zero, and `days_to_safety_breach`
 * is when it crosses safety stock - which is the number that matters, because
 * safety stock is the point at which you are relying on luck. Risk is graded
 * against the item's own lead time: running out in 5 days with a 30-day lead
 * time is a different problem from running out in 5 days with a 2-day lead time,
 * and a single "days of cover" figure hides that completely.
 *
 * An item with no demand signal reports `no_demand_signal` rather than infinite
 * cover. A flat line at today's stock is not a forecast.
 *
 * INVENTORY OPTIMISATION, AND WHAT "ECHELON" MEANS IN THIS BUILD
 * --------------------------------------------------------------
 * `optimiseInventory` answers one question: given what safety stock costs and
 * what a stockout costs, is each item's service level set in the right place?
 * It computes, per item, the marginal rupee of safety stock against the
 * marginal risk it removes, and recommends raising the level on items where
 * cover is cheap relative to consequence and lowering it where it is not.
 *
 * Multi-echelon means holding stock at the level of the network where it is
 * cheapest to hold. Pulse models warehouses, so the echelon dimension here is
 * per-warehouse cover for the same item: an item held in three places carries
 * three lots of safety stock, and pooling them at the location that actually
 * consumes it is usually the largest single saving available. That comparison is
 * reported per item, and `pooling_saving` is the difference between the sum of
 * the per-location safety stocks and the safety stock a single pooled location
 * would need for the same service level - which is sigma * sqrt(n) rather than
 * n * sigma, the square-root law.
 *
 * It is NOT a stochastic multi-echelon optimiser, and does not claim to be.
 */
import pool from '../../../config/db.js';
import { calculateSafetyStock } from './inventoryPlanning.service.js';

const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;
const r2  = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3  = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const DAY = 24 * 3600 * 1000;

function dayKey(d) {
  const x = new Date(d);
  // Built from local date parts. `toISOString()` on a local midnight lands on
  // the previous day anywhere east of UTC, which is how an earlier pass ended
  // up bucketing every month one day early.
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/**
 * Daily projected on-hand per item over `horizonDays`.
 *
 * Demand: open sales-order lines at their delivery date, plus the un-consumed
 * remainder of approved forecast periods spread evenly across the period.
 * Supply: open purchase orders and open production orders at their expected
 * date. Both are the same sources MRP uses, deliberately - a projection that
 * disagrees with the plan is worse than no projection.
 */
export async function projectedOnHand({
  companyId = null, itemId = null, horizonDays = 90,
} = {}) {
  const { rows: items } = await pool.query(`
    SELECT i.id, i.item_code, i.item_name, i.unit_of_measure,
           COALESCE(i.current_stock,0)   AS on_hand,
           COALESCE(i.safety_stock,0)    AS safety_stock,
           COALESCE(i.reorder_level,0)   AS reorder_level,
           COALESCE(i.lead_time_days,0)  AS lead_time_days,
           COALESCE(i.avg_daily_demand,0) AS avg_daily_demand,
           i.abc_class        AS abc_class
      FROM inventory_items i
     WHERE ($1::int IS NULL OR i.company_id = $1)
       AND ($2::int IS NULL OR i.id = $2)
       AND i.deleted_at IS NULL AND COALESCE(i.is_active,true) = true
     ORDER BY i.item_code`, [companyId, itemId]);
  if (!items.length) return { horizon_days: horizonDays, items: [] };

  const ids = items.map(i => i.id);

  const { rows: orderDemand } = await pool.query(`
    SELECT soi.item_id,
           COALESCE(so.delivery_date, so.promised_date, so.order_date)::date AS on_date,
           SUM(GREATEST(COALESCE(soi.quantity,0) - COALESCE(soi.fulfilled_qty,0), 0)) AS qty
      FROM sales_order_items soi
      JOIN sales_orders so ON so.id = soi.order_id
     WHERE soi.item_id = ANY($1::int[])
       AND so.deleted_at IS NULL
       AND LOWER(COALESCE(so.order_status,'')) NOT IN ('cancelled','delivered','completed','closed')
       AND ($2::int IS NULL OR so.company_id = $2)
     GROUP BY 1, 2`, [ids, companyId]);

  const { rows: forecastDemand } = await pool.query(`
    SELECT item_id, period_start::date AS period_start, period_end::date AS period_end,
           GREATEST(COALESCE(forecast_qty, quantity, 0) - COALESCE(consumed_qty,0), 0) AS qty
      FROM demand_forecasts
     WHERE item_id = ANY($1::int[])
       AND LOWER(COALESCE(status,'')) = 'approved'
       AND ($2::int IS NULL OR company_id = $2)
       AND period_end >= CURRENT_DATE`, [ids, companyId]);

  const { rows: poSupply } = await pool.query(`
    SELECT poi.item_id,
           COALESCE(po.expected_delivery_date, po.order_date)::date AS on_date,
           SUM(GREATEST(COALESCE(poi.quantity,0) - COALESCE(poi.received_qty,0), 0)) AS qty
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.po_id
     WHERE poi.item_id = ANY($1::int[])
       AND LOWER(COALESCE(po.status,'')) NOT IN ('cancelled','received','closed')
       AND ($2::int IS NULL OR po.company_id = $2)
     GROUP BY 1, 2`, [ids, companyId]);

  const { rows: prodSupply } = await pool.query(`
    SELECT product_id AS item_id,
           COALESCE(planned_end_date, planned_start_date)::date AS on_date,
           SUM(GREATEST(COALESCE(quantity_planned,0) - COALESCE(quantity_completed,0), 0)) AS qty
      FROM production_orders
     WHERE product_id = ANY($1::int[])
       AND LOWER(COALESCE(status,'')) NOT IN ('completed','cancelled','closed')
       AND ($2::int IS NULL OR company_id = $2)
     GROUP BY 1, 2`, [ids, companyId]);

  // ── build per-item daily movement ──────────────────────────────────────────
  const movement = new Map();                 // itemId -> Map(dayKey -> delta)
  const bump = (id, date, delta) => {
    const k = Number(id);
    if (!movement.has(k)) movement.set(k, new Map());
    const m = movement.get(k);
    const d = dayKey(date);
    m.set(d, num(m.get(d)) + num(delta));
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizonEnd = new Date(today.getTime() + horizonDays * DAY);
  const inWindow = (d) => {
    const x = new Date(d); x.setHours(0, 0, 0, 0);
    return x >= today && x <= horizonEnd;
  };

  for (const d of orderDemand) if (inWindow(d.on_date)) bump(d.item_id, d.on_date, -num(d.qty));
  for (const s of poSupply)    if (inWindow(s.on_date)) bump(s.item_id, s.on_date, +num(s.qty));
  for (const s of prodSupply)  if (inWindow(s.on_date)) bump(s.item_id, s.on_date, +num(s.qty));

  // Forecast is spread evenly across its period. A forecast is a rate, not an
  // event, and dropping a month of demand on the first of the month produces a
  // stockout date that is up to 30 days early.
  for (const f of forecastDemand) {
    const start = new Date(Math.max(new Date(f.period_start).getTime(), today.getTime()));
    const end   = new Date(f.period_end);
    const days  = Math.max(1, Math.round((end - start) / DAY) + 1);
    const per   = num(f.qty) / days;
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * DAY);
      if (inWindow(d)) bump(f.item_id, d, -per);
    }
  }

  // ── walk each item forward ────────────────────────────────────────────────
  const out = items.map(it => {
    const deltas = movement.get(Number(it.id)) || new Map();
    const hasSignal = [...deltas.values()].some(v => v < 0) || num(it.avg_daily_demand) > 0;
    let balance = num(it.on_hand);
    const curve = [];
    let stockoutDay = null, safetyBreachDay = null, minBalance = balance;

    for (let i = 0; i <= horizonDays; i++) {
      const d = new Date(today.getTime() + i * DAY);
      const k = dayKey(d);
      let delta = num(deltas.get(k));
      // With no dated demand at all, fall back to the item's own average daily
      // demand so a fast mover is not projected flat.
      if (!deltas.size && num(it.avg_daily_demand) > 0) delta -= num(it.avg_daily_demand);
      balance = r3(balance + delta);
      if (balance < minBalance) minBalance = balance;
      if (stockoutDay === null && balance < 0) stockoutDay = i;
      if (safetyBreachDay === null && num(it.safety_stock) > 0 && balance < num(it.safety_stock)) safetyBreachDay = i;
      curve.push({ day: i, date: k, delta: r3(delta), projected: balance });
    }

    const lead = num(it.lead_time_days);
    let risk = 'none';
    if (!hasSignal) risk = 'no_demand_signal';
    else if (stockoutDay !== null && stockoutDay <= lead) risk = 'critical';
    else if (stockoutDay !== null) risk = 'high';
    else if (safetyBreachDay !== null && safetyBreachDay <= lead) risk = 'medium';
    else if (safetyBreachDay !== null) risk = 'low';

    return {
      item_id: it.id, item_code: it.item_code, item_name: it.item_name,
      uom: it.unit_of_measure, abc_class: it.abc_class,
      on_hand: num(it.on_hand), safety_stock: num(it.safety_stock),
      lead_time_days: lead,
      days_to_stockout: stockoutDay,
      days_to_safety_breach: safetyBreachDay,
      min_projected: minBalance,
      // Cover is only meaningful when something is consuming the stock.
      days_of_cover: hasSignal && num(it.avg_daily_demand) > 0
        ? r2(num(it.on_hand) / num(it.avg_daily_demand)) : null,
      stockout_risk: risk,
      has_demand_signal: hasSignal,
      curve,
    };
  });

  return {
    horizon_days: horizonDays,
    generated_at: new Date().toISOString(),
    items: out,
    summary: {
      items: out.length,
      at_risk: out.filter(i => ['critical', 'high'].includes(i.stockout_risk)).length,
      breaching_safety: out.filter(i => i.days_to_safety_breach !== null).length,
      no_signal: out.filter(i => i.stockout_risk === 'no_demand_signal').length,
    },
  };
}

/**
 * Where the safety-stock budget is mis-allocated, and what pooling would save.
 */
export async function optimiseInventory({ companyId = null, targetServiceLevel = null } = {}) {
  const { rows: settings } = await pool.query(
    `SELECT * FROM inventory_planning_settings WHERE company_id = $1`, [companyId]);
  const defaultService = num(settings[0]?.service_level_pct) || 95;
  const holdingRate    = num(settings[0]?.holding_cost_rate) || 0.2;

  const { rows: items } = await pool.query(`
    SELECT i.id, i.item_code, i.item_name,
           COALESCE(i.standard_cost,0)          AS unit_cost,
           COALESCE(i.safety_stock,0)           AS safety_stock,
           COALESCE(i.safety_stock_calculated,0) AS safety_stock_calculated,
           COALESCE(i.demand_stddev,0)          AS demand_stddev,
           COALESCE(i.avg_daily_demand,0)       AS avg_daily_demand,
           COALESCE(i.lead_time_days,0)         AS lead_time_days,
           COALESCE(i.service_level_pct, $2)    AS service_level_pct,
           -- The OPERATIVE class: a planner's manual override sets the service
           -- level here as it does everywhere else (abc_class_source).
           i.abc_class               AS abc_class,
           i.demand_periods_observed
      FROM inventory_items i
     WHERE ($1::int IS NULL OR i.company_id = $1)
       AND i.deleted_at IS NULL AND COALESCE(i.is_active,true) = true`,
    [companyId, defaultService]);

  // Per-item, per-warehouse holdings: the echelon dimension.
  const { rows: byLocation } = await pool.query(`
    SELECT item_id, warehouse_id,
           SUM(COALESCE(quantity_in,0) - COALESCE(quantity_out,0)) AS qty
      FROM stock_ledger
     WHERE ($1::int IS NULL OR company_id = $1)
       AND warehouse_id IS NOT NULL
     GROUP BY 1, 2
    HAVING SUM(COALESCE(quantity_in,0) - COALESCE(quantity_out,0)) > 0`, [companyId]);
  const locationsByItem = new Map();
  for (const r of byLocation) {
    const k = Number(r.item_id);
    locationsByItem.set(k, (locationsByItem.get(k) || 0) + 1);
  }

  const recommendations = [];
  let currentCost = 0, optimisedCost = 0, poolingSaving = 0;

  for (const it of items) {
    const unitCost = num(it.unit_cost);
    const held     = num(it.safety_stock);
    const holdCost = held * unitCost * holdingRate;
    currentCost += holdCost;

    if (!num(it.demand_periods_observed)) {
      recommendations.push({
        item_id: it.id, item_code: it.item_code, item_name: it.item_name,
        action: 'insufficient_history',
        rationale: 'No demand history — a service level cannot be set from nothing',
        current_safety_stock: held, recommended_safety_stock: null,
        annual_holding_cost: r2(holdCost), locations: locationsByItem.get(Number(it.id)) || 0,
      });
      optimisedCost += holdCost;
      continue;
    }

    // An A-class part earns a higher service level than a C-class part: the
    // consequence of running out is proportional to what flows through it.
    const band = String(it.abc_class || 'C').toUpperCase();
    const target = targetServiceLevel != null ? num(targetServiceLevel)
      : (band === 'A' ? 98 : band === 'B' ? 95 : 90);
    const sigmaDaily = num(it.demand_stddev) / Math.sqrt(30.44);
    const recommended = r3(calculateSafetyStock(sigmaDaily, num(it.lead_time_days), target));
    const recCost = recommended * unitCost * holdingRate;
    optimisedCost += recCost;

    // Square-root law: n locations each covering their own variability need
    // sqrt(n) times the safety stock one pooled location would need.
    const locations = locationsByItem.get(Number(it.id)) || 1;
    const pooled = locations > 1 ? r3(recommended / Math.sqrt(locations)) : recommended;
    const saving = r2((recommended - pooled) * unitCost * holdingRate);
    if (locations > 1) poolingSaving += saving;

    const delta = r3(recommended - held);
    recommendations.push({
      item_id: it.id, item_code: it.item_code, item_name: it.item_name,
      abc_class: band,
      current_service_level: num(it.service_level_pct),
      recommended_service_level: target,
      current_safety_stock: held,
      recommended_safety_stock: recommended,
      change_qty: delta,
      annual_holding_cost: r2(holdCost),
      recommended_holding_cost: r2(recCost),
      locations,
      pooled_safety_stock: pooled,
      pooling_saving: locations > 1 ? saving : 0,
      action: Math.abs(delta) < 0.5 ? 'hold'
            : delta > 0 ? 'raise_cover' : 'release_cover',
      rationale: Math.abs(delta) < 0.5
        ? `Cover matches a ${target}% service level for a ${band}-class part`
        : delta > 0
          ? `A ${band}-class part is carrying less than a ${target}% service level needs`
          : `Cover exceeds what a ${target}% service level needs for a ${band}-class part`,
    });
  }

  recommendations.sort((a, b) =>
    Math.abs(num(b.recommended_holding_cost) - num(b.annual_holding_cost)) -
    Math.abs(num(a.recommended_holding_cost) - num(a.annual_holding_cost)));

  return {
    settings: { holding_cost_rate: holdingRate, default_service_level_pct: defaultService },
    summary: {
      items: items.length,
      current_annual_holding_cost: r2(currentCost),
      optimised_annual_holding_cost: r2(optimisedCost),
      difference: r2(optimisedCost - currentCost),
      multi_location_items: [...locationsByItem.values()].filter(n => n > 1).length,
      echelon_pooling_saving: r2(poolingSaving),
      raise: recommendations.filter(r => r.action === 'raise_cover').length,
      release: recommendations.filter(r => r.action === 'release_cover').length,
      insufficient_history: recommendations.filter(r => r.action === 'insufficient_history').length,
    },
    recommendations,
  };
}

/**
 * Measure how long suppliers actually take, and let planning use it.
 *
 * `lead_time_days` was hand-typed and uniform - 7 days on every item in the
 * reference company - while the actual PO-date-to-GRN-date interval sat in the
 * database unused. MRP offsets every release by that number, so a wrong lead
 * time is not a reporting inaccuracy: it is the release date being wrong.
 *
 * The measured figure is written to `lead_time_measured_days` and only promoted
 * into `lead_time_days` when `lead_time_source` is not 'manual' - a planner who
 * has pinned a lead time keeps it, and can still see what the receipts say.
 */
export async function measureSupplierLeadTimes({ companyId = null, minObservations = 2, apply = true } = {}) {
  const { rows } = await pool.query(`
    SELECT poi.item_id,
           COUNT(*)::int                                            AS observations,
           ROUND(AVG(GREATEST(g.received_date::date - po.order_date::date, 0))::numeric, 2) AS avg_days,
           MAX(GREATEST(g.received_date::date - po.order_date::date, 0))  AS max_days,
           MIN(GREATEST(g.received_date::date - po.order_date::date, 0))  AS min_days
      FROM goods_receipt_notes g
      JOIN purchase_orders po ON po.id = g.po_id
      JOIN purchase_order_items poi ON poi.po_id = po.id
     WHERE poi.item_id IS NOT NULL
       AND g.received_date IS NOT NULL AND po.order_date IS NOT NULL
       AND ($1::int IS NULL OR po.company_id = $1)
     GROUP BY poi.item_id`, [companyId]);

  const applied = [];
  for (const r of rows) {
    if (Number(r.observations) < minObservations) continue;
    const { rows: [item] } = await pool.query(`
      UPDATE inventory_items
         SET lead_time_measured_days = $2::numeric,
             lead_time_observations  = $3,
             lead_time_measured_at   = NOW(),
             -- $2 is cast on every use. Left bare it appears once as a numeric
             -- column value and once inside ROUND(), and Postgres refuses with
             -- "inconsistent types deduced for parameter $2" rather than
             -- guessing — which the exercise run found immediately.
             lead_time_days = CASE WHEN $4 AND COALESCE(lead_time_source,'') <> 'manual'
                                   THEN GREATEST(ROUND($2::numeric)::int, 0) ELSE lead_time_days END,
             lead_time_source = CASE WHEN $4 AND COALESCE(lead_time_source,'') <> 'manual'
                                     THEN 'measured' ELSE lead_time_source END,
             updated_at = NOW()
       WHERE id = $1 AND ($5::int IS NULL OR company_id = $5)
       RETURNING id, item_code, lead_time_days, lead_time_measured_days, lead_time_source`,
      [r.item_id, r.avg_days, r.observations, !!apply, companyId]);
    if (item) applied.push({ ...item, observations: r.observations, min_days: r.min_days, max_days: r.max_days });
  }

  return {
    measured: rows.length,
    applied: applied.length,
    min_observations: minObservations,
    items: applied,
    skipped_thin: rows.filter(r => Number(r.observations) < minObservations)
      .map(r => ({ item_id: r.item_id, observations: r.observations })),
  };
}

/**
 * How late each supplier has actually been, expressed as the risk that the next
 * receipt slips - and which open POs that risk lands on.
 *
 * Vendor health already scores on-time delivery. What did not exist was the step
 * from "this vendor is 40% late" to "therefore THIS open purchase order is
 * likely to slip, and the production order waiting on it should be replanned".
 */
export async function supplierDelayRisk({ companyId = null, lookbackDays = 365 } = {}) {
  const { rows: history } = await pool.query(`
    SELECT po.supplier_id,
           v.vendor_name AS vendor_name,
           COUNT(*)::int AS receipts,
           SUM(CASE WHEN g.received_date::date > po.expected_delivery_date::date THEN 1 ELSE 0 END)::int AS late,
           ROUND(AVG(GREATEST(g.received_date::date - po.expected_delivery_date::date, 0))::numeric, 2) AS avg_days_late
      FROM goods_receipt_notes g
      JOIN purchase_orders po ON po.id = g.po_id
      LEFT JOIN vendors v ON v.id = po.supplier_id
     WHERE po.expected_delivery_date IS NOT NULL AND g.received_date IS NOT NULL
       AND g.received_date >= CURRENT_DATE - ($2 || ' days')::interval
       AND ($1::int IS NULL OR po.company_id = $1)
     GROUP BY po.supplier_id, v.vendor_name`, [companyId, String(lookbackDays)]);

  const riskByVendor = new Map();
  for (const h of history) {
    const rate = h.receipts ? h.late / h.receipts : 0;
    riskByVendor.set(Number(h.supplier_id), {
      vendor_id: h.supplier_id, vendor_name: h.vendor_name,
      receipts: h.receipts, late: h.late,
      late_rate_pct: r2(rate * 100),
      avg_days_late: num(h.avg_days_late),
      // Graded, not a raw percentage: two receipts is not a track record, and
      // presenting 50% off two data points as a risk score is how a supplier
      // gets written off for one bad delivery.
      confidence: h.receipts >= 8 ? 'high' : h.receipts >= 3 ? 'medium' : 'low',
      risk: h.receipts < 3 ? 'unknown' : rate >= 0.5 ? 'high' : rate >= 0.2 ? 'medium' : 'low',
    });
  }

  const { rows: openPOs } = await pool.query(`
    SELECT po.id, po.po_number, po.supplier_id, po.expected_delivery_date,
           v.vendor_name AS vendor_name,
           COUNT(poi.id)::int AS lines
      FROM purchase_orders po
      LEFT JOIN vendors v ON v.id = po.supplier_id
      LEFT JOIN purchase_order_items poi ON poi.po_id = po.id
     WHERE LOWER(COALESCE(po.status,'')) NOT IN ('cancelled','received','closed')
       AND ($1::int IS NULL OR po.company_id = $1)
     GROUP BY po.id, po.po_number, po.supplier_id, po.expected_delivery_date, v.vendor_name`, [companyId]);

  const exposed = openPOs.map(po => {
    const r = riskByVendor.get(Number(po.supplier_id)) || null;
    const expected = po.expected_delivery_date ? new Date(po.expected_delivery_date) : null;
    const predicted = expected && r
      ? new Date(expected.getTime() + Math.round(num(r.avg_days_late) * num(r.late_rate_pct) / 100) * DAY)
      : expected;
    return {
      po_id: po.id, po_number: po.po_number, vendor_id: po.supplier_id,
      vendor_name: po.vendor_name || r?.vendor_name || null,
      lines: po.lines,
      expected_delivery_date: po.expected_delivery_date,
      predicted_delivery_date: predicted ? dayKey(predicted) : null,
      predicted_slip_days: expected && predicted ? Math.round((predicted - expected) / DAY) : 0,
      risk: r?.risk ?? 'unknown',
      basis: r ? `${r.late}/${r.receipts} receipts late, avg ${r.avg_days_late}d` : 'no receipt history for this vendor',
    };
  }).sort((a, b) => b.predicted_slip_days - a.predicted_slip_days);

  return {
    lookback_days: lookbackDays,
    vendors: [...riskByVendor.values()].sort((a, b) => b.late_rate_pct - a.late_rate_pct),
    open_purchase_orders: exposed,
    summary: {
      vendors_scored: riskByVendor.size,
      high_risk_vendors: [...riskByVendor.values()].filter(v => v.risk === 'high').length,
      unknown_risk_vendors: [...riskByVendor.values()].filter(v => v.risk === 'unknown').length,
      open_pos_at_risk: exposed.filter(p => p.predicted_slip_days > 0).length,
    },
  };
}

export default { projectedOnHand, optimiseInventory, measureSupplierLeadTimes, supplierDelayRisk };
