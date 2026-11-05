// backend/src/modules/inventory/services/inventoryKpi.service.js
//
// The inventory KPIs the 2026-09-15 audit found absent (finding 30): turnover,
// days of inventory, achieved service level, stockouts, safety-stock breaches,
// excess inventory, obsolete/slow-moving stock, GRN pending IQC and material
// waiting for production.
//
// WHY A SERVICE AND NOT A QUERY IN THE ROUTE
// ------------------------------------------
// Because the same handful of numbers was already computed three different ways
// across this codebase and disagreed. Audit defect 1.3: the EOQ Planner screen
// shows 30-52% of the governed reorder point on long-lead items, because it
// reinvented the demand window with a flat 14-day lead time instead of reading
// the governed parameters. A KPI that quietly disagrees with the planning
// parameters it exists to measure is worse than no KPI, because it gets
// believed. Everything here reads the SAME demand definition as
// inventoryPlanning.service.js, through ledgerSemantics.js (demandQtySql).
//
// WHAT "SERVICE LEVEL" MEANS HERE — READ THIS BEFORE QUOTING THE NUMBER
// --------------------------------------------------------------------
// There are two service levels and they are not interchangeable:
//
//   TARGET   inventory_planning_settings.service_level_pct (live 95). An INPUT.
//            It picks the z that sizes safety stock. It says nothing whatever
//            about what actually happened.
//   ACHIEVED what this service measures: the share of item-days on which stock
//            was actually on hand. An OUTPUT, derived from the ledger.
//
// Reporting the target as though it were the achievement is the most common way
// an inventory dashboard lies, and this codebase has previous for exactly that
// shape of defect. They are returned as separate, differently-named fields and
// are never merged.
//
// A demand-weighted FILL RATE — "of the quantity requested, how much was
// served" — is what most textbooks mean by service level, and it is NOT
// derivable from this database: material_issue_logs records qty_issued but no
// requested quantity, so a short issue cannot be told from a small one, and a
// demand refused outright leaves no row at all. Rather than silently substitute
// availability for fill rate, fill_rate_pct is returned as null with the reason
// attached to it.
//
// GRANULARITY
// stock_ledger.transaction_date is a DATE, so a stockout that opened and closed
// inside one day is invisible. Daily is the finest honest resolution the data
// supports, and the payload says so rather than implying hourly precision.

import pool from '../../../config/db.js';
import { getPlanningSettings } from './inventoryPlanning.service.js';
import { demandQtySql, demandValueSql } from './ledgerSemantics.js';

const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;
const r2 = (n) => Math.round(n * 100) / 100;

/** Divide, or return null. Never Infinity, never NaN, never a 0 that reads as a measurement. */
const ratio = (numerator, denominator) =>
  num(denominator) > 0 ? num(numerator) / num(denominator) : null;

const DAY_MS = 86400000;

/** Local date parts, never toISOString(): east of UTC that shifts the day back one. */
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysBetween = (from, to) => Math.round((to - from) / DAY_MS);

/**
 * Compute every inventory KPI for one company over one window.
 *
 * @param {object}  opts
 * @param {number?} opts.companyId  null = unscoped (super_admin)
 * @param {number?} opts.windowDays defaults to the company's planning lookback,
 *   so the KPIs and the planning parameters describe the same stretch of time.
 */
export async function computeInventoryKpis({ companyId = null, windowDays = null } = {}) {
  const settings = await getPlanningSettings(companyId);
  const window = Math.max(1, parseInt(windowDays ?? settings.lookback_days, 10) || 365);
  const excessCoverDays = parseInt(settings.excess_cover_days, 10) || 180;

  // The timeline is the half-open interval [start, endExclusive), so every day
  // in the window is counted exactly once — an inclusive end double-counts the
  // last day and reports a service level a fraction of a point too high.
  const today = midnight(new Date());
  const endExclusive = addDays(today, 1);
  const start = addDays(endExclusive, -window);
  const startKey = ymd(start);

  // ── Items in scope, with the planning parameters they are measured against ──
  const { rows: items } = await pool.query(
    `SELECT ii.id, ii.item_code, ii.item_name, ii.unit_of_measure,
            COALESCE(ii.safety_stock, 0)  AS safety_stock,
            COALESCE(ii.reorder_level, 0) AS reorder_level,
            COALESCE(ii.standard_cost, 0) AS standard_cost,
            ii.abc_class, ii.xyz_class, ii.fsn_class,
            ii.avg_daily_demand, ii.annual_demand, ii.last_movement_date,
            ii.planning_params_computed_at
       FROM inventory_items ii
      WHERE ($1::int IS NULL OR ii.company_id = $1)
        AND COALESCE(ii.is_active, true) = true AND ii.deleted_at IS NULL
      ORDER BY ii.id`,
    [companyId]
  );

  if (!items.length) return emptyResult({ settings, window, start, today, excessCoverDays });

  // ── Cost basis — the SAME precedence the planning service uses ──────────────
  // Purchase price first, standard cost second, ledger rate last. Sharing the
  // precedence is the whole point: an inventory value computed on one basis and
  // an EOQ computed on another cannot be reconciled by the person reading both,
  // and that disagreement is what created two different EOQs for one part.
  const { rows: poRates } = await pool.query(
    `SELECT poi.item_id, AVG(NULLIF(poi.rate, 0)) AS unit_cost
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.po_id
      WHERE ($1::int IS NULL OR po.company_id = $1) AND poi.item_id IS NOT NULL
      GROUP BY poi.item_id`,
    [companyId]
  );
  const poCost = new Map(poRates.map((r) => [r.item_id, num(r.unit_cost)]));

  const { rows: ledgerRates } = await pool.query(
    `SELECT item_id, AVG(NULLIF(rate, 0)) AS unit_cost
       FROM stock_ledger
      WHERE ($1::int IS NULL OR company_id = $1)
      GROUP BY item_id`,
    [companyId]
  );
  const ledgerCost = new Map(ledgerRates.map((r) => [r.item_id, num(r.unit_cost)]));

  const costOf = (it) => poCost.get(it.id) || num(it.standard_cost) || ledgerCost.get(it.id) || 0;

  // ── Opening balance at the window start, per item ───────────────────────────
  // Everything before the window collapses into one number. Transfers are NOT
  // excluded here: a transfer genuinely moved stock and the balance must carry
  // it. The exclusion list defines what counts as DEMAND, not what counts as a
  // MOVEMENT; conflating the two would stop the balance reconciling.
  const { rows: openings } = await pool.query(
    `SELECT item_id, SUM(quantity_in - quantity_out) AS bal
       FROM stock_ledger
      WHERE ($1::int IS NULL OR company_id = $1)
        AND transaction_date < $2::date
      GROUP BY item_id`,
    [companyId, startKey]
  );
  const openingOf = new Map(openings.map((r) => [r.item_id, num(r.bal)]));

  // ── Daily net movement inside the window, per item ──────────────────────────
  const { rows: deltas } = await pool.query(
    `SELECT item_id, transaction_date::date AS d,
            SUM(quantity_in - quantity_out) AS net,
            SUM(quantity_in + quantity_out) AS gross,
            -- Demand per ledgerSemantics (issues less returns of issues), the
            -- same definition the planning parameters it measures are built on.
            SUM(${demandQtySql()}) AS demand_qty,
            SUM(${demandValueSql()}) AS demand_value
       FROM stock_ledger
      WHERE ($1::int IS NULL OR company_id = $1)
        AND transaction_date >= $2::date
      GROUP BY item_id, 2
      ORDER BY item_id, 2`,
    [companyId, startKey]
  );

  const movesOf = new Map();
  for (const row of deltas) {
    if (!movesOf.has(row.item_id)) movesOf.set(row.item_id, []);
    movesOf.get(row.item_id).push({
      // transaction_date comes back as a 'YYYY-MM-DD' string (the DATE parser
      // override in config/db.js), so it is split into local parts rather than
      // fed to new Date(), which would read it as UTC midnight and land on the
      // previous day everywhere east of UTC.
      date: fromYmd(row.d),
      net: num(row.net),
      gross: num(row.gross),
      demandQty: num(row.demand_qty),
      demandValue: num(row.demand_value),
    });
  }

  // Month-end sampling points for the average inventory the turnover ratio
  // divides by. Averaging opening and closing is the usual shortcut and it
  // misreads any business with a seasonal build-up: the months in between are
  // exactly where the stock sat.
  const samplePoints = [];
  for (let d = new Date(start.getFullYear(), start.getMonth() + 1, 0); d < endExclusive;
       d = new Date(d.getFullYear(), d.getMonth() + 2, 0)) {
    samplePoints.push(midnight(d));
  }
  if (!samplePoints.length || daysBetween(samplePoints[samplePoints.length - 1], today) > 0) {
    samplePoints.push(today);
  }

  // ── Walk each item's balance across the window ──────────────────────────────
  let itemDaysCarried = 0, itemDaysOut = 0, stockoutEvents = 0;
  let totalDemandValue = 0, totalDemandQty = 0;
  const sampleValueTotals = new Array(samplePoints.length).fill(0);

  const stockoutItems = [], breachItems = [], excessItems = [], staleItems = [];
  let closingValue = 0, itemsCarried = 0;

  for (const it of items) {
    const unitCost = costOf(it);
    const moves = movesOf.get(it.id) || [];
    const opening = openingOf.get(it.id) || 0;

    // An item with no opening stock and no real movement in the window was never
    // carried, so it did not "stock out" — it simply was not being held. Counting
    // it would drag the service level down over items nobody stocked, which is
    // the CROSS JOIN warehouses defect wearing a different hat.
    //
    // The test is a movement that moved QUANTITY, not merely a row. Live proof
    // of why: ITM-002's entire history is one `adjustment` row dated 2026-08-22
    // carrying 0 in and 0 out. Counting a row was enough to mark the item
    // carried, and that single no-op row reported 365 stockout days and pulled
    // the company's service level from 100% to 90% on evidence of nothing.
    const carried = opening !== 0 || moves.some((m) => m.gross > 0);

    let balance = opening;
    let cursor = start;
    let daysOut = 0, itemStockouts = 0;

    /** Advance the clock to `until`, accruing the days spent at or below zero. */
    const advanceTo = (until) => {
      const days = daysBetween(cursor, until);
      if (days <= 0) return;
      if (balance <= 0) daysOut += days;
      cursor = until;
    };

    let mi = 0, si = 0;
    // Demand nets returns against issues, so a day can be negative; the ITEM is
    // floored at zero over the window (more returned than issued is no demand,
    // not negative demand that would cancel another item).
    let itemDemandQty = 0, itemDemandValue = 0;
    while (mi < moves.length || si < samplePoints.length) {
      const nextMove = mi < moves.length ? moves[mi].date : null;
      const nextSample = si < samplePoints.length ? samplePoints[si] : null;

      // On a tie the movement is applied first, so a month-end sample reflects
      // the stock as it stood at the close of that day rather than before it.
      if (nextMove && (!nextSample || nextMove <= nextSample)) {
        advanceTo(nextMove);
        const before = balance;
        balance += moves[mi].net;
        itemDemandQty += moves[mi].demandQty;
        itemDemandValue += moves[mi].demandValue;
        // A stockout EVENT is the crossing, not the condition. Counting the
        // condition would report one long outage as hundreds of stockouts and
        // make the figure useless for comparing one period against another.
        if (before > 0 && balance <= 0) { stockoutEvents++; itemStockouts++; }
        mi++;
      } else {
        advanceTo(nextSample);
        sampleValueTotals[si] += Math.max(0, balance) * unitCost;
        si++;
      }
    }
    advanceTo(endExclusive);
    totalDemandQty += Math.max(0, itemDemandQty);
    totalDemandValue += Math.max(0, itemDemandValue);

    const position = balance;
    closingValue += Math.max(0, position) * unitCost;

    if (carried) {
      itemsCarried++;
      itemDaysCarried += window;
      itemDaysOut += daysOut;
    }

    const row = {
      item_id: it.id, item_code: it.item_code, item_name: it.item_name,
      unit_of_measure: it.unit_of_measure,
      abc_class: it.abc_class, xyz_class: it.xyz_class, fsn_class: it.fsn_class,
      current_stock: r2(position), unit_cost: r2(unitCost),
      stock_value: r2(Math.max(0, position) * unitCost),
    };

    if (position <= 0 && carried) {
      stockoutItems.push({ ...row, days_out_of_stock: daysOut, stockout_events: itemStockouts });
    }

    // A breach is measured against the safety stock actually IN FORCE — the
    // planner's figure where they have overridden it, because that is the one
    // MRP honours. Measuring against the calculated figure would report
    // breaches of a policy nobody is running.
    const ss = num(it.safety_stock);
    if (ss > 0 && position < ss) {
      breachItems.push({ ...row, safety_stock: r2(ss), shortfall: r2(ss - position) });
    }

    // Excess needs a demand rate to mean anything. An item with no demand is not
    // over-stocked, it is non-moving, and it is counted under FSN instead — the
    // two KPIs deliberately do not overlap, so they can be added up.
    const daily = num(it.avg_daily_demand);
    if (daily > 0 && position > 0) {
      const coverDays = position / daily;
      if (coverDays > excessCoverDays) {
        const excessQty = position - excessCoverDays * daily;
        excessItems.push({
          ...row,
          cover_days: Math.round(coverDays),
          excess_qty: r2(excessQty),
          excess_value: r2(excessQty * unitCost),
        });
      }
    }

    if ((it.fsn_class === 'S' || it.fsn_class === 'N') && position > 0) {
      staleItems.push({ ...row, last_movement_date: it.last_movement_date });
    }
  }

  // ── Turnover ────────────────────────────────────────────────────────────────
  const annualisedConsumption = totalDemandValue * (365 / window);
  const averageInventoryValue = sampleValueTotals.length
    ? sampleValueTotals.reduce((s, v) => s + v, 0) / sampleValueTotals.length
    : closingValue;
  const turnover = ratio(annualisedConsumption, averageInventoryValue);

  // ── Pipeline ────────────────────────────────────────────────────────────────
  const { rows: [grn] } = await pool.query(
    `SELECT COUNT(*)::int AS pending
       FROM goods_receipt_notes
      WHERE ($1::int IS NULL OR company_id = $1)
        AND LOWER(COALESCE(quality_status, '')) = 'pending'`,
    [companyId]
  );

  // inventory_reservations carries no company_id of its own, so it is scoped
  // through the item it reserves. Reading it unscoped is how the existing
  // /advanced-inventory/dashboard counts every other tenant's reservations as
  // this tenant's.
  const { rows: [waiting] } = await pool.query(
    `SELECT COUNT(*)::int AS reservations,
            COALESCE(SUM(r.quantity_remaining), 0)::numeric AS qty,
            COALESCE(SUM(r.quantity_remaining * COALESCE(ii.standard_cost, 0)), 0)::numeric AS value
       FROM inventory_reservations r
       JOIN inventory_items ii ON ii.id = r.item_id
      WHERE ($1::int IS NULL OR ii.company_id = $1)
        AND ii.deleted_at IS NULL
        AND LOWER(COALESCE(r.status, '')) IN ('active', 'partially_consumed')
        AND COALESCE(r.quantity_remaining, 0) > 0`,
    [companyId]
  );

  const inStockPct = itemDaysCarried > 0
    ? r2((100 * (itemDaysCarried - itemDaysOut)) / itemDaysCarried)
    : null;

  return {
    window: { days: window, start: ymd(start), end: ymd(today), granularity: 'day' },
    policy: {
      target_service_level_pct: num(settings.service_level_pct),
      excess_cover_days: excessCoverDays,
      abc_a_threshold_pct: num(settings.abc_a_threshold_pct),
      abc_b_threshold_pct: num(settings.abc_b_threshold_pct),
      fsn_slow_days: parseInt(settings.fsn_slow_days, 10) || null,
      fsn_nonmoving_days: parseInt(settings.fsn_nonmoving_days, 10) || null,
    },
    valuation: {
      basis: 'purchase_order_avg_rate -> standard_cost -> ledger_avg_rate',
      closing_inventory_value: r2(closingValue),
      average_inventory_value: r2(averageInventoryValue),
      sample_points: sampleValueTotals.length,
    },
    turnover: {
      consumption_value_in_window: r2(totalDemandValue),
      consumption_qty_in_window: r2(totalDemandQty),
      annualised_consumption_value: r2(annualisedConsumption),
      average_inventory_value: r2(averageInventoryValue),
      // NULL, not 0: "nothing was consumed" and "no ratio can be computed" are
      // different findings, and a 0 turnover reads as the first one.
      inventory_turnover: turnover === null ? null : Math.round(turnover * 100) / 100,
      days_of_inventory: turnover === null || turnover <= 0 ? null : Math.round(365 / turnover),
    },
    service_level: {
      target_pct: num(settings.service_level_pct),
      achieved_in_stock_pct: inStockPct,
      basis: 'item-days in stock / item-days carried, from the stock ledger',
      item_days_carried: itemDaysCarried,
      item_days_out_of_stock: itemDaysOut,
      items_carried: itemsCarried,
      fill_rate_pct: null,
      fill_rate_unavailable_reason:
        'No requested quantity is recorded anywhere: material_issue_logs stores qty_issued only, ' +
        'so a short issue cannot be told from a small one and a refused demand leaves no row at all.',
    },
    stockouts: {
      items_currently_out: stockoutItems.length,
      stockout_events_in_window: stockoutEvents,
      stockout_rate_pct: itemDaysCarried > 0 ? r2((100 * itemDaysOut) / itemDaysCarried) : null,
      items: stockoutItems.sort((a, b) => b.days_out_of_stock - a.days_out_of_stock),
    },
    safety_stock_breaches: {
      count: breachItems.length,
      basis: 'in-force safety stock (the planner figure where overridden, which is what MRP honours)',
      items: breachItems.sort((a, b) => b.shortfall - a.shortfall),
    },
    excess_inventory: {
      count: excessItems.length,
      threshold_cover_days: excessCoverDays,
      total_excess_value: r2(excessItems.reduce((s, r) => s + r.excess_value, 0)),
      items: excessItems.sort((a, b) => b.excess_value - a.excess_value),
    },
    obsolete_slow_moving: {
      slow_moving_count: staleItems.filter((r) => r.fsn_class === 'S').length,
      non_moving_count: staleItems.filter((r) => r.fsn_class === 'N').length,
      total_value: r2(staleItems.reduce((s, r) => s + r.stock_value, 0)),
      items: staleItems.sort((a, b) => b.stock_value - a.stock_value),
    },
    pipeline: {
      grn_pending_iqc: grn.pending,
      material_waiting_for_production: {
        reservations: waiting.reservations,
        quantity: r2(num(waiting.qty)),
        value: r2(num(waiting.value)),
      },
    },
    coverage: {
      items_total: items.length,
      items_carried_in_window: itemsCarried,
      items_with_planning_params: items.filter((i) => i.planning_params_computed_at).length,
      items_classified: items.filter((i) => i.abc_class).length,
      last_planning_run: items.reduce((latest, i) => {
        const t = i.planning_params_computed_at;
        return t && (!latest || new Date(t) > new Date(latest)) ? t : latest;
      }, null),
    },
  };
}

/** 'YYYY-MM-DD' (or a Date) to local midnight, without a UTC round-trip. */
function fromYmd(value) {
  if (value instanceof Date) return midnight(value);
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** A company with no items gets zeros and nulls in the same shape, never a 500. */
function emptyResult({ settings, window, start, today, excessCoverDays }) {
  return {
    window: { days: window, start: ymd(start), end: ymd(today), granularity: 'day' },
    policy: {
      target_service_level_pct: num(settings.service_level_pct),
      excess_cover_days: excessCoverDays,
    },
    valuation: { basis: null, closing_inventory_value: 0, average_inventory_value: 0, sample_points: 0 },
    turnover: {
      consumption_value_in_window: 0, consumption_qty_in_window: 0,
      annualised_consumption_value: 0, average_inventory_value: 0,
      inventory_turnover: null, days_of_inventory: null,
    },
    service_level: {
      target_pct: num(settings.service_level_pct), achieved_in_stock_pct: null,
      basis: 'item-days in stock / item-days carried, from the stock ledger',
      item_days_carried: 0, item_days_out_of_stock: 0, items_carried: 0,
      fill_rate_pct: null, fill_rate_unavailable_reason: 'No item in scope.',
    },
    stockouts: { items_currently_out: 0, stockout_events_in_window: 0, stockout_rate_pct: null, items: [] },
    safety_stock_breaches: { count: 0, basis: null, items: [] },
    excess_inventory: { count: 0, threshold_cover_days: excessCoverDays, total_excess_value: 0, items: [] },
    obsolete_slow_moving: { slow_moving_count: 0, non_moving_count: 0, total_value: 0, items: [] },
    pipeline: { grn_pending_iqc: 0, material_waiting_for_production: { reservations: 0, quantity: 0, value: 0 } },
    coverage: {
      items_total: 0, items_carried_in_window: 0, items_with_planning_params: 0,
      items_classified: 0, last_planning_run: null,
    },
  };
}

export default { computeInventoryKpis };
