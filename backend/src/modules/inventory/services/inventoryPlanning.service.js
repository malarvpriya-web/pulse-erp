// backend/src/modules/inventory/services/inventoryPlanning.service.js
//
// The one place EOQ, reorder point, safety stock and ABC are computed — and the
// only place they are WRITTEN BACK to the item master.
//
// WHY THIS SERVICE EXISTS
// -----------------------
// The 2026-09-11 SCA audit found all four already implemented, correctly, in
// three different read-only report endpoints — and discarded every time. Nothing
// in the codebase wrote abc_class, safety_stock or reorder_level from a
// calculation, so mrpEngine.service.js read the hand-typed fields instead:
// safety_stock 0.00 on every item, abc_class NULL on every item. The formulas
// were never the problem; having nowhere to put the answer was.
//
// The three former implementations also disagreed on unit cost — inventory used
// AVG(stock_ledger.rate), procurement used AVG(purchase_order_items.rate) — so
// two screens could legitimately show different EOQs for the same part. This is
// now the single source of truth and both callers read it.
//
// THE MATHS
//   D    annual demand         consumption over the lookback, annualised
//   d    average daily demand  D / 365
//   sigma_p  standard deviation of demand per PERIOD (monthly bucket)
//   sigma_d  sigma_p / sqrt(days_per_period)      — daily demand sigma
//   L    lead time (days)
//   z    service-level factor (95% -> 1.645)
//
//   Safety stock = z * sigma_d * sqrt(L)          — classic lead-time demand cover
//   ROP          = d * L + safety stock
//   EOQ          = sqrt(2 * D * S / H),  H = unit_cost * holding_rate
//   ABC          = Pareto on annual consumption value, A to 70%, B to 90%.
//                  The band is decided on the cumulative BEFORE the item, so
//                  the item that crosses a boundary belongs to the class it
//                  crosses out of. Testing the cumulative after adding it put
//                  a part holding 80% of all value in B, and a sole part
//                  holding 100% of it in C — the most important item in the
//                  business, classified as the tail.
//
// WHAT IT REFUSES TO DO
// ---------------------
// An item with fewer than `min_periods_for_stats` periods of history gets NULL
// parameters and a skip_reason, never a zero. A zero safety stock computed from
// no data is indistinguishable from a deliberate decision to hold none, and that
// ambiguity is exactly how the current 0.00-everywhere state came to look normal.
//
// Manual overrides survive. safety_stock_source / reorder_point_source say which
// figure MRP should honour; when either is 'manual' the planner's number is left
// alone and the calculated one is still stored alongside it so the two can be
// compared.

import pool from '../../../config/db.js';
import { demandQtySql, demandRowSql, issueRowSql, unclassifiedTransactionTypes } from './ledgerSemantics.js';

const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;
const r3 = (n) => Math.round(n * 1000) / 1000;
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * What counts as demand is defined ONCE, in ledgerSemantics.js — an inclusion
 * map built from every ledger writer, with reversals netted and unclassified
 * types reported rather than counted. It replaced NON_DEMAND_TRANSACTION_TYPES
 * / nonDemandExclusionSql, an exclusion list under which a vendor return, a
 * cycle-count loss or any newly invented type silently became consumption, and
 * which Store Cost Analysis and the slow-mover lists did not use at all.
 * Re-exported here because this service is where planning readers look first.
 */
export {
  LEDGER_CLASS, TRANSACTION_TYPE_CLASS, ISSUE_TYPES, ISSUE_REVERSAL_TYPES,
  classifyLedgerRow, demandQtyOf, issueRowSql, demandRowSql, demandQtySql, demandValueSql,
  unclassifiedTransactionTypes,
} from './ledgerSemantics.js';

/** Reason code persisted on an item the run evaluated but could not classify. */
export const INSUFFICIENT_HISTORY = 'insufficient_history';

/**
 * Service-level z for a target percentage, via an inverse-normal approximation
 * (Acklam). A lookup table was rejected: planners set 97.5% and 99.9% and a
 * table silently rounds those to the nearest tabulated row.
 */
export function zForServiceLevel(pct) {
  const p = Math.min(0.999999, Math.max(0.5, num(pct) / 100));
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, x;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5; const r = q * q;
    x = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
        (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  return Math.round(x * 1000) / 1000;
}

/** Population standard deviation across period buckets. */
function stddev(values) {
  if (!values.length) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Resolve the company's planning policy, creating the default row on first use. */
export async function getPlanningSettings(companyId, client = pool) {
  if (companyId == null) {
    return { company_id: null, ordering_cost: 500, holding_cost_rate: 0.18,
             service_level_pct: 95, lookback_days: 365, min_periods_for_stats: 3, auto_apply: true };
  }
  const { rows } = await client.query(
    `SELECT * FROM inventory_planning_settings WHERE company_id = $1`, [companyId]);
  if (rows[0]) return rows[0];
  const { rows: [created] } = await client.query(
    `INSERT INTO inventory_planning_settings (company_id) VALUES ($1)
     ON CONFLICT (company_id) DO UPDATE SET updated_at = NOW() RETURNING *`, [companyId]);
  return created;
}

/** A rejected setting. Carries status 400 so routes can answer with it. */
export class PlanningSettingsError extends Error {
  constructor(errors) {
    super(errors.join(' '));
    this.name = 'PlanningSettingsError';
    this.status = 400;
    this.errors = errors;
  }
}

/**
 * Validate a settings patch AGAINST the row it will be merged into, so a patch
 * of only the A threshold is checked against the stored B threshold. The
 * database CHECKs (ips_abc_thresholds_ordered, ips_xyz_thresholds_ordered)
 * stay as the backstop; this turns their 500 into a 400 that names the field,
 * and covers FSN, which has no CHECK.
 *
 * Returns a list of messages; empty means valid.
 */
export function validatePlanningSettings(patch = {}, current = {}) {
  const errors = [];
  const merged = { ...current, ...patch };
  const numberOf = (k) => {
    if (patch[k] === undefined) return num(merged[k]);
    const v = patch[k];
    if (v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v))) {
      errors.push(`${k} must be a number.`);
      return NaN;
    }
    return Number(v);
  };

  const a = numberOf('abc_a_threshold_pct');
  const b = numberOf('abc_b_threshold_pct');
  if (Number.isFinite(a) && Number.isFinite(b)) {
    if (!(a > 0 && a < 100)) errors.push('ABC A threshold must be greater than 0 and less than 100.');
    if (!(b > 0 && b <= 100)) errors.push('ABC B threshold must be greater than 0 and at most 100.');
    if (!(a < b)) errors.push('ABC A threshold must be lower than the B threshold.');
  }

  const x = numberOf('xyz_x_max_cv');
  const y = numberOf('xyz_y_max_cv');
  if (Number.isFinite(x) && Number.isFinite(y) && !(x > 0 && x < y)) {
    errors.push('XYZ X limit must be greater than 0 and lower than the Y limit.');
  }

  const s = numberOf('fsn_slow_days');
  const n = numberOf('fsn_nonmoving_days');
  if (Number.isFinite(s) && Number.isFinite(n)) {
    if (!Number.isInteger(s) || !Number.isInteger(n) || s < 1) errors.push('FSN day limits must be whole days of at least 1.');
    if (!(s < n)) errors.push('FSN slow-moving days must be fewer than non-moving days.');
  }
  return errors;
}

/**
 * Update a company's planning policy. Pass `client` to run inside a caller's
 * transaction (Inventory Settings writes these together with its own blob).
 * Throws PlanningSettingsError (status 400) on an invalid or contradictory
 * combination; nothing is written in that case.
 */
export async function updatePlanningSettings(companyId, patch = {}, client = pool) {
  const current = await getPlanningSettings(companyId, client);
  const allowed = ['ordering_cost', 'holding_cost_rate', 'service_level_pct',
                   'lookback_days', 'min_periods_for_stats', 'auto_apply',
                   'abc_a_threshold_pct', 'abc_b_threshold_pct',
                   'xyz_x_max_cv', 'xyz_y_max_cv',
                   'fsn_slow_days', 'fsn_nonmoving_days',
                   'excess_cover_days'];
  const errors = validatePlanningSettings(patch, current);
  if (errors.length) throw new PlanningSettingsError(errors);
  const sets = [], vals = [companyId];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    vals.push(patch[k]);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return current;
  const { rows: [row] } = await client.query(
    `UPDATE inventory_planning_settings SET ${sets.join(', ')}, updated_at = NOW()
      WHERE company_id = $1 RETURNING *`, vals);
  return row;
}

/**
 * Average purchase-order rate per item for a company — the FIRST leg of the
 * unit-cost precedence every planning figure uses (purchase price, then
 * standard cost, then ledger rate). One query, shared by the recompute and by
 * anything that needs a unit cost for an item that has no consumption value.
 */
export async function purchaseRatesByItem(companyId, client = pool, itemIds = null) {
  const { rows } = await client.query(`
    SELECT poi.item_id, AVG(NULLIF(poi.rate, 0)) AS unit_cost
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.po_id
     WHERE ($1::int IS NULL OR po.company_id = $1) AND poi.item_id IS NOT NULL
       AND ($2::int[] IS NULL OR poi.item_id = ANY($2::int[]))
     GROUP BY poi.item_id`, [companyId, itemIds]);
  return new Map(rows.map(r => [r.item_id, num(r.unit_cost)]));
}

/**
 * A unit cost for one item that does not depend on demand history, in the
 * planning precedence: average purchase rate, then standard cost, then the
 * average non-zero ledger rate. Exists so that an item whose annual consumption
 * value has been cleared (insufficient history) still has a price: consumption
 * value / annual demand was only ever a way of recovering this number, never
 * its source.
 *
 * @returns {{unit_cost: number|null, unit_cost_source: 'purchase_orders'|'standard_cost'|'ledger_rate'|null}}
 */
export async function resolveUnitCost(itemId, companyId, client = pool) {
  const po = (await purchaseRatesByItem(companyId, client, [itemId])).get(itemId);
  if (po > 0) return { unit_cost: r2(po), unit_cost_source: 'purchase_orders' };
  const { rows: [it] } = await client.query(
    `SELECT standard_cost,
            (SELECT AVG(NULLIF(sl.rate, 0)) FROM stock_ledger sl
              WHERE sl.item_id = ii.id AND ($2::int IS NULL OR sl.company_id = $2)) AS ledger_rate
       FROM inventory_items ii
      WHERE ii.id = $1 AND ($2::int IS NULL OR ii.company_id = $2)`, [itemId, companyId]);
  if (num(it?.standard_cost) > 0) return { unit_cost: r2(num(it.standard_cost)), unit_cost_source: 'standard_cost' };
  if (num(it?.ledger_rate) > 0)   return { unit_cost: r2(num(it.ledger_rate)),   unit_cost_source: 'ledger_rate' };
  return { unit_cost: null, unit_cost_source: null };
}

// ── ABC ownership ────────────────────────────────────────────────────────────
//
// inventory_items.abc_class is the OPERATIVE class; abc_class_source says who
// owns it (migration 20261021000009). 'manual' is never moved by a recompute,
// 'calculated' always is, and NULL — a legacy row whose author could not be
// established — is treated as engine-owned and stamped 'calculated' by the next
// run. These fragments are the one definition of that policy; every writer of
// abc_class uses them.

/** SET clauses for a recompute writing calculated class `valueSql`. */
export function abcRecomputeSetSql(valueSql) {
  return `abc_class = CASE WHEN abc_class_source = 'manual' THEN abc_class ELSE ${valueSql} END,
          abc_class_source = CASE WHEN abc_class_source = 'manual' THEN 'manual' ELSE 'calculated' END`;
}

/**
 * SET clauses for a person changing ownership. `modeSql` evaluates to 'set',
 * 'clear' or 'keep'; `valueSql` to the class for 'set'. Clearing returns the
 * item to the engine's CURRENT answer, which is NULL for an item it could not
 * classify — the same thing the next recompute would do.
 */
export function abcOverrideSetSql(modeSql, valueSql) {
  return `abc_class = CASE ${modeSql} WHEN 'set'   THEN ${valueSql}
                                      WHEN 'clear' THEN abc_class_calculated::text
                                      ELSE abc_class::text END,
          abc_class_source = CASE ${modeSql} WHEN 'set'   THEN 'manual'
                                             WHEN 'clear' THEN 'calculated'
                                             ELSE abc_class_source END`;
}

/**
 * Interpret an incoming abc_class field.
 *   undefined          -> keep    (the caller did not mention it)
 *   null / ''          -> clear   (back to the calculated class)
 *   'a' | 'B' | ' c '  -> set     (a manual override, even if it equals the
 *                                  calculated class — that is how a planner
 *                                  pins a class so a future recompute cannot move it)
 * Anything else throws a 400: silently treating a typo as "clear" would drop a
 * planner's override with no error.
 */
export function parseAbcOverride(v) {
  if (v === undefined) return { mode: 'keep', value: null };
  if (v === null || String(v).trim() === '') return { mode: 'clear', value: null };
  const s = String(v).trim().toUpperCase();
  if (['A', 'B', 'C'].includes(s)) return { mode: 'set', value: s };
  const err = new Error(`abc_class must be A, B, C or blank (got "${v}").`);
  err.status = 400;
  throw err;
}

/** Per-row classification status — one definition for every ABC reader. */
export function abcStatusSql(alias = 'ii') {
  return `CASE
            WHEN ${alias}.abc_class_source = 'manual'       THEN 'manual'
            WHEN ${alias}.abc_class_calculated IS NOT NULL
             AND ${alias}.abc_class_source IS NULL          THEN 'legacy_unverified'
            WHEN ${alias}.abc_class_calculated IS NOT NULL  THEN 'classified'
            WHEN ${alias}.classification_reason IS NOT NULL THEN ${alias}.classification_reason
            ELSE 'not_computed'
          END`;
}

/**
 * The authoritative ABC classification of a company's active items, as the
 * planning run persisted it — the single read every ABC screen and report now
 * shares, so none of them can compute its own answer. annual_consumption_value
 * and the Pareto percentages are reported only where a calculated class stands
 * on them.
 */
export async function getAbcClassification(companyId, client = pool) {
  const { rows } = await client.query(`
    SELECT ii.id AS item_id, ii.item_code, ii.item_name, ii.unit_of_measure,
           ii.abc_class, ii.abc_class_source, ii.abc_class_calculated,
           ii.abc_rank, ii.abc_value_pct, ii.abc_cumulative_pct,
           CASE WHEN ii.abc_class_calculated IS NOT NULL THEN ii.annual_consumption_value END
             AS annual_consumption_value,
           ii.xyz_class, ii.fsn_class,
           ${abcStatusSql('ii')} AS classification_status,
           ii.classification_reason, ii.classified_at
      FROM inventory_items ii
     WHERE ($1::int IS NULL OR ii.company_id = $1)
       AND COALESCE(ii.is_active, true) = true AND ii.deleted_at IS NULL
     ORDER BY ii.abc_rank NULLS LAST, ii.annual_consumption_value DESC NULLS LAST, ii.item_code`,
    [companyId]);
  return rows;
}

/**
 * Recompute every item's planning parameters and persist them.
 *
 * @param {object}  opts
 * @param {number?} opts.companyId
 * @param {boolean} opts.apply    false = dry run (compute + record, write nothing to items)
 * @returns {Promise<{run, items}>}
 */
/**
 * EOQ = sqrt(2DS/H).
 *
 * @param annualDemand        D, units per year
 * @param orderingCost        S, cost of placing one order
 * @param holdingCostPerUnit  H, annual cost of holding one unit (unit cost x rate)
 */
export function calculateEOQ(annualDemand, orderingCost, holdingCostPerUnit) {
  const D = num(annualDemand), S = num(orderingCost), H = num(holdingCostPerUnit);
  if (!(D > 0) || !(H > 0)) return 0;
  return Math.sqrt((2 * D * S) / H);
}

/**
 * Safety stock = z * sigma_d * sqrt(L) — cover for demand variability across
 * the lead time.
 *
 * `serviceLevel` is accepted either as a percentage (95) or as a fraction
 * (0.95); anything at or below 1 is read as a fraction. zForServiceLevel()
 * clamps below 0.5, so feeding it a raw 0.95 would silently yield z = 0 and a
 * safety stock of nothing.
 */
export function calculateSafetyStock(sigmaDaily, leadTimeDays, serviceLevel = 95) {
  const sigma = num(sigmaDaily);
  const L     = Math.max(num(leadTimeDays), 0);
  const raw   = num(serviceLevel);
  const pct   = raw > 0 && raw <= 1 ? raw * 100 : raw;
  return zForServiceLevel(pct) * sigma * Math.sqrt(L);
}

/** Reorder point = average daily demand x lead time + safety stock. */
export function calculateDynamicROP(dailyDemand, leadTimeDays, safetyStock = 0) {
  return num(dailyDemand) * Math.max(num(leadTimeDays), 0) + num(safetyStock);
}

/**
 * How much to order for an item that has fallen to its reorder point.
 *
 * WHY THIS EXISTS
 * ---------------
 * EOQ was computed here, persisted to inventory_items.eoq, shown on two screens
 * — and then read by nothing. Every order quantity in the system was
 * `reorder_level * 2`, independently reinvented in three places:
 *
 *   inventory.routes.js       "Generate PO" button
 *   services/stockAlerts.js   purchase_suggestions
 *   mrpEngine.service.js      a lot-sizing branch literally named 'eoq' that
 *                             rounded to lot_size_qty and never read item.eoq
 *
 * So the answer to "how much should we buy" owed nothing to demand, ordering
 * cost or holding cost. This is the one place that decides it now, and it
 * returns the REASON alongside the number: a planner overruling a quantity
 * needs to know whether it came from EOQ, a supplier minimum or a bare
 * shortfall, and a quantity with no stated basis invites exactly the
 * hand-typing that made the four planning columns worthless the first time.
 *
 * ORDER OF REASONING
 *   1. Start from EOQ where it exists. It is the economically optimal lot.
 *   2. Never order less than the shortfall to the reorder point — EOQ answers
 *      "what is the cheapest lot size", not "is this lot enough". An item well
 *      below its ROP needs covering regardless of what EOQ says.
 *   3. Respect the supplier's minimum and the pack/lot multiple.
 *   4. Respect a maximum where one is set, but never below the shortfall:
 *      silently under-ordering to honour a ceiling would cause the stockout the
 *      whole mechanism exists to prevent. The caller is told it was capped.
 *
 * @param {object} item   eoq, reorder_level, min_order_qty, max_order_qty, lot_size_qty
 * @param {number} onHand stock available now
 * @param {number} incoming already on order and expected
 * @returns {{quantity:number, basis:string, capped:boolean}}
 */
export function suggestedOrderQuantity(item = {}, onHand = 0, incoming = 0) {
  const eoq      = num(item.eoq);
  const rop      = num(item.reorder_level);
  const minQty   = num(item.min_order_qty);
  const maxQty   = num(item.max_order_qty);
  const lot      = num(item.lot_size_qty);
  const position = num(onHand) + num(incoming);

  // What it takes to get back to the reorder point at minimum.
  const shortfall = Math.max(0, rop - position);

  let qty, basis;
  if (eoq > 0) { qty = eoq; basis = 'eoq'; }
  else if (rop > 0) { qty = Math.max(rop * 2 - position, rop); basis = 'reorder_level_heuristic'; }
  else { qty = shortfall; basis = 'shortfall'; }

  if (qty < shortfall) { qty = shortfall; basis = `${basis}+shortfall`; }
  if (minQty > 0 && qty < minQty) { qty = minQty; basis = `${basis}+min_order_qty`; }
  if (lot > 0) { qty = Math.ceil(qty / lot) * lot; basis = `${basis}+lot_multiple`; }

  let capped = false;
  if (maxQty > 0 && qty > maxQty) {
    // Honour the ceiling, but never below what is needed to clear the breach —
    // a capped order that still leaves the item under its ROP is a stockout
    // scheduled for later.
    const capTarget = Math.max(maxQty, shortfall);
    capped = capTarget < qty;
    qty = capTarget;
    if (capped) basis = `${basis}+capped_at_max`;
  }

  // Never emit a zero or a fraction of a unit: a requisition for no quantity is
  // rejected downstream, and the failure surfaces as an unexplained empty PR.
  qty = Math.max(Math.round(qty * 1000) / 1000, 0);
  if (qty <= 0) { qty = Math.max(minQty, lot, 1); basis = 'floor_minimum'; }

  return { quantity: qty, basis, capped };
}

/**
 * ABC Pareto classification over annual consumption value.
 *
 * Sets `abc_class` on each item and returns them ranked by value, descending.
 * Items with no consumption value are C — not 'unclassified'. An item nobody
 * consumes is the definition of a C part.
 *
 * The band is decided on the cumulative share BEFORE the item is added, so the
 * item that carries the running total past 70% is still an A. Deciding it
 * afterwards — `cum <= 70 ? 'A'` — meant a single part holding 80% of all
 * consumption value came out as B, and a sole part holding 100% came out as C.
 */
// NB: the accessor option is `valueFn`, not `valueOf`. `valueOf` is inherited
// from Object.prototype, so destructuring it out of a default `{}` yields the
// built-in method rather than undefined, and the `||` fallback never fires.
export function classifyABCPareto(items, { valueFn, aPct = 70, bPct = 90 } = {}) {
  const read = valueFn || (r => num(r.annual_usage_value ?? r.acv ?? r.annual_consumption_value ?? 0));
  const ranked = [...items].filter(r => read(r) > 0).sort((a, b) => read(b) - read(a));
  const grand  = ranked.reduce((t, r) => t + read(r), 0);

  let running = 0;
  ranked.forEach((r, i) => {
    const cumBefore = grand > 0 ? (100 * running) / grand : 0;
    r.abc_class = cumBefore < aPct ? 'A' : cumBefore < bPct ? 'B' : 'C';
    running += read(r);
    // The Pareto walk already knows each item's share and the running
    // cumulative — it decides the band on exactly these — and used to discard
    // both. Keeping them is what lets a classification be justified rather than
    // merely displayed: it answers "why is this B, and how near is it to A?",
    // which is the question anyone reviewing a classification actually asks.
    r.abc_value_pct      = grand > 0 ? Math.round((100 * read(r) / grand) * 10000) / 10000 : 0;
    r.abc_cumulative_pct = grand > 0 ? Math.round((100 * running / grand) * 10000) / 10000 : 0;
    r.abc_rank           = i + 1;
  });
  for (const r of items) {
    // An item nobody consumes is the definition of a C part, not "unclassified".
    if (!r.abc_class) {
      r.abc_class = 'C';
      r.abc_value_pct = 0;
      r.abc_cumulative_pct = 100;
      r.abc_rank = null;
    }
  }
  return ranked;
}

/**
 * XYZ — how PREDICTABLE demand is, banded on the coefficient of variation.
 *
 * ABC says what a part is worth; XYZ says whether you can forecast it. They are
 * orthogonal and stocking policy needs both: an AX part (valuable, steady) runs
 * on a lean reorder point, an AZ part (equally valuable, erratic) needs cover
 * that an ABC-only policy would never justify holding.
 *
 * `demand_cv` is already computed and persisted per item by
 * recomputePlanningParameters, so this is banding, not new analysis.
 *
 * A null CV means there was not enough history to compute one. It returns null
 * rather than 'Z': "we cannot tell" and "demand is erratic" are different
 * findings, and collapsing the first into the second would put every new part
 * into the highest-safety-stock band on no evidence at all.
 */
export function classifyXYZ(cv, { xMaxCv = 0.5, yMaxCv = 1.0 } = {}) {
  if (cv === null || cv === undefined || cv === '') return null;
  const v = num(cv);
  if (v <= num(xMaxCv)) return 'X';
  if (v <= num(yMaxCv)) return 'Y';
  return 'Z';
}

/**
 * FSN — Fast / Slow / Non-moving, from how long ago the item was last ISSUED.
 *
 * Answers the ageing requirement's non-moving and obsolete questions. An item
 * that has never been issued is N, which is correct and is the case that
 * matters most: stock that arrived and was never touched is exactly the stock
 * nobody thinks to look for.
 *
 * BASIS
 *   Transactions  a qualifying issue is an ISSUE row in ledgerSemantics
 *                 (issueRowSql: an issue type with quantity_out > 0) — the same
 *                 definition ABC and XYZ consume. Receipts, GRNs, put-aways,
 *                 transfers, vendor returns, adjustments and cycle counts never
 *                 count: a part received yesterday and never used is not
 *                 fast-moving. Returns of issues do not un-date the last issue.
 *   Date          `daysSinceLastIssue` is whole calendar days from the
 *                 database's CURRENT_DATE back to the latest qualifying
 *                 transaction_date, computed in SQL. Both sides are DATEs, so
 *                 the time of day the run happens cannot move an item across a
 *                 boundary (the previous Date.now() arithmetic made an issue
 *                 exactly 90 days old read as 90.4 days, i.e. Slow).
 *                 Future-dated rows are ignored by the caller.
 *   Boundaries    inclusive on the faster side:
 *                   days <= slowDays          F
 *                   days <= nonMovingDays     S
 *                   otherwise, or never       N
 */
export function classifyFSN(daysSinceLastIssue, { slowDays = 90, nonMovingDays = 180 } = {}) {
  if (daysSinceLastIssue === null || daysSinceLastIssue === undefined || daysSinceLastIssue === '') return 'N';
  const days = Number(daysSinceLastIssue);
  if (!Number.isFinite(days)) return 'N';
  if (days <= num(slowDays)) return 'F';
  if (days <= num(nonMovingDays)) return 'S';
  return 'N';
}

export async function recomputePlanningParameters({ companyId = null, apply = null, actor = {} } = {}) {
  const settings = await getPlanningSettings(companyId);
  const orderingCost = num(settings.ordering_cost) || 500;
  const holdingRate  = num(settings.holding_cost_rate) || 0.18;
  const serviceLevel = num(settings.service_level_pct) || 95;
  const lookbackDays = parseInt(settings.lookback_days, 10) || 365;
  const minPeriods   = parseInt(settings.min_periods_for_stats, 10) || 3;
  const shouldApply  = apply === null ? settings.auto_apply !== false : Boolean(apply);
  const z            = zForServiceLevel(serviceLevel);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Items in scope ───────────────────────────────────────────────────────
    const { rows: items } = await client.query(`
      SELECT id, item_code, item_name, unit_of_measure,
             COALESCE(lead_time_days, 0)  AS lead_time_days,
             COALESCE(standard_cost, 0)   AS standard_cost,
             safety_stock, reorder_level,
             COALESCE(safety_stock_source,  'calculated') AS safety_stock_source,
             COALESCE(reorder_point_source, 'calculated') AS reorder_point_source
        FROM inventory_items
       WHERE ($1::int IS NULL OR company_id = $1)
         AND COALESCE(is_active, true) = true AND deleted_at IS NULL
       ORDER BY id`, [companyId]);

    // ── Consumption history, bucketed by month ───────────────────────────────
    // Demand per ledgerSemantics: issues add, returns of issues (customer,
    // production, rework, service-visit reductions) subtract in the month they
    // are booked, and the month is floored at zero. Receipts, transfers, vendor
    // returns, adjustments, cycle counts, seed filler and unclassified types
    // contribute nothing. A month whose net demand is zero is not a month
    // "with demand" for min_periods_for_stats. The rate fallback averages
    // ISSUE rows only, as before.
    const { rows: consumption } = await client.query(`
      SELECT sl.item_id,
             date_trunc('month', sl.transaction_date)::date AS period,
             SUM(${demandQtySql('sl')})::numeric AS net_qty,
             AVG(CASE WHEN ${issueRowSql('sl')} THEN NULLIF(sl.rate, 0) END) AS avg_rate
        FROM stock_ledger sl
       WHERE ($1::int IS NULL OR sl.company_id = $1)
         AND sl.transaction_date >= CURRENT_DATE - ($2 || ' days')::interval
         AND sl.transaction_date <= CURRENT_DATE
         AND ${demandRowSql('sl')}
       GROUP BY sl.item_id, 2`, [companyId, lookbackDays]);

    // Each month keeps its NET demand (negative when more came back than went
    // out). Two uses, two rules — the same ones every other demand reader uses:
    //   annual demand  = net over the whole window, floored at zero, so a return
    //                    booked in the month after its issue still cancels it
    //                    (Store Cost Analysis and the KPIs aggregate the same way)
    //   monthly series = each month floored at zero, because a period cannot
    //                    have negative demand; XYZ and safety stock read it, and
    //                    only a month with positive net counts toward
    //                    min_periods_for_stats.
    const netByItem = new Map();
    const byItem = new Map();
    for (const c of consumption) {
      if (!netByItem.has(c.item_id)) netByItem.set(c.item_id, new Map());
      netByItem.get(c.item_id).set(String(c.period), num(c.net_qty));
      if (num(c.net_qty) <= 0) continue;
      if (!byItem.has(c.item_id)) byItem.set(c.item_id, []);
      byItem.get(c.item_id).push({ period: c.period, qty: num(c.net_qty), rate: num(c.avg_rate) });
    }

    // ── Purchase price as the cost basis, standard cost as fallback ──────────
    const costOf = await purchaseRatesByItem(companyId, client);

    const periodsInLookback = Math.max(1, Math.round(lookbackDays / 30.44));
    const results = [];

    for (const it of items) {
      const hist = byItem.get(it.id) || [];
      const unitCost = costOf.get(it.id) || num(it.standard_cost) ||
                       (hist.find(h => h.rate > 0)?.rate ?? 0);

      if (hist.length < minPeriods) {
        results.push({ item: it,
                       skip: `${INSUFFICIENT_HISTORY}: ${hist.length} of ${minPeriods} required months with demand`,
                       annual_demand: null, eoq: null, safety_stock: null, rop: null,
                       abc: null, acv: 0, unit_cost: unitCost });
        continue;
      }

      // Absent months are genuine zero-demand months and must count toward the
      // variability: dropping them understates sigma for intermittent parts,
      // which is precisely where safety stock matters most.
      const qtyByPeriod = new Map(hist.map(h => [String(h.period), h.qty]));
      // Local date parts, never toISOString(): east of UTC the latter turns the
      // 1st of a month into the last day of the previous one, so these keys
      // would never match SQL's date_trunc('month', ...) and every series would
      // read as all zeros.
      const series = [];
      const netOf = netByItem.get(it.id) || new Map();
      let netTotal = 0;
      for (let i = 0; i < periodsInLookback; i++) {
        const now = new Date();
        const first = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-01`;
        series.push(qtyByPeriod.get(key) ?? 0);
        netTotal += netOf.get(key) ?? 0;
      }

      const totalQty     = series.reduce((s, v) => s + v, 0);
      const annualDemand = Math.max(0, netTotal) * (365 / lookbackDays);
      const dailyDemand  = annualDemand / 365;
      const sigmaPeriod  = stddev(series);
      const sigmaDaily   = sigmaPeriod / Math.sqrt(365 / periodsInLookback);
      const meanPeriod   = totalQty / series.length;
      const cv           = meanPeriod > 0 ? sigmaPeriod / meanPeriod : null;

      // Through the exported formulas, so the numbers this run persists and the
      // numbers anything else computes cannot drift apart.
      const leadDays    = parseInt(it.lead_time_days, 10) || 0;
      const safetyStock = calculateSafetyStock(sigmaDaily, leadDays, serviceLevel);
      const rop         = calculateDynamicROP(dailyDemand, leadDays, safetyStock);

      const H   = unitCost * holdingRate;
      const eoq = annualDemand > 0 && H > 0
        ? calculateEOQ(annualDemand, orderingCost, H)
        : null;

      results.push({
        item: it, skip: null,
        annual_demand: r3(annualDemand),
        daily_demand:  Math.round(dailyDemand * 10000) / 10000,
        sigma_period:  Math.round(sigmaPeriod * 10000) / 10000,
        cv:            cv === null ? null : Math.round(cv * 10000) / 10000,
        periods:       series.length,
        eoq:           eoq === null ? null : r3(eoq),
        safety_stock:  r3(safetyStock),
        rop:           r3(rop),
        unit_cost:     r2(unitCost),
        acv:           r2(annualDemand * unitCost),
        abc:           null,
      });
    }

    // ── Last qualifying ISSUE, for FSN ────────────────────────────────────────
    // Issues only (quantity_out > 0, demand types), so a receipt, put-away or
    // transfer cannot make a part look fast. This used to take MAX(date) over
    // every ledger row, receipts included. Scoped by the items already selected
    // for this company rather than by stock_ledger.company_id, so the item
    // master decides tenancy. Days are computed by the database on DATEs (see
    // classifyFSN), and a post-dated row is not a movement yet.
    const { rows: lastIssues } = await client.query(`
      SELECT sl.item_id,
             MAX(sl.transaction_date)                     AS last_issue,
             (CURRENT_DATE - MAX(sl.transaction_date))::int AS days_since_issue
        FROM stock_ledger sl
       WHERE sl.item_id = ANY($1::int[])
         AND sl.transaction_date <= CURRENT_DATE
         AND ${issueRowSql('sl')}
       GROUP BY sl.item_id`, [items.map(i => i.id)]);
    const lastIssueOf = new Map(lastIssues.map(r => [r.item_id, r]));

    // ── ABC: Pareto over annual consumption value ────────────────────────────
    // Thresholds come from company policy now, not from function defaults.
    // They default to 70/90 so an existing classification does not shift until
    // somebody deliberately changes the policy.
    //
    // Only items with enough history are ranked. An insufficient-history item
    // has no annual consumption value worth the name, and the Pareto walk used
    // to default it to C in the run record while the item master was never
    // touched — the run said C, the item said whatever it said last time. It now
    // gets NULL ABC/XYZ on both, with the reason recorded. Excluding these items
    // does not move anyone else's class: their value was 0, and zero-value rows
    // never entered the ranking.
    const aPct = num(settings.abc_a_threshold_pct) || 70;
    const bPct = num(settings.abc_b_threshold_pct) || 90;
    classifyABCPareto(results.filter(r => !r.skip), { valueFn: r => r.acv, aPct, bPct });
    for (const r of results) {
      if (r.skip) {
        r.abc = null;
        r.abc_value_pct = null; r.abc_cumulative_pct = null; r.abc_rank = null;
        r.xyz = null;
      } else {
        r.abc = r.abc_class;
        r.xyz = classifyXYZ(r.cv, {
          xMaxCv: num(settings.xyz_x_max_cv) || 0.5,
          yMaxCv: num(settings.xyz_y_max_cv) || 1.0,
        });
      }
      // FSN for EVERY item, skipped or not: "never issued" is precisely the
      // case with too little history to classify by value, and it is the N
      // that matters most.
      const issue = lastIssueOf.get(r.item.id);
      r.last_movement = issue?.last_issue ?? null;
      r.fsn = classifyFSN(issue ? issue.days_since_issue : null, {
        slowDays: parseInt(settings.fsn_slow_days, 10) || 90,
        nonMovingDays: parseInt(settings.fsn_nonmoving_days, 10) || 180,
      });
    }
    // Total annual consumption value across the classified population. The run
    // record persists it, so it has to survive the extraction of the Pareto
    // maths into classifyABCPareto().
    const grand = results.reduce((t, r) => t + (r.acv > 0 ? r.acv : 0), 0);

    // Ledger types ledgerSemantics does not classify count as nothing. Record
    // them on the run, and say so, so a new writer is noticed rather than
    // silently missing from (or, under the old exclusion list, added to) demand.
    const unclassified = await unclassifiedTransactionTypes(client, companyId, lookbackDays);
    if (unclassified.length) {
      console.warn(`[planning] company ${companyId}: unclassified stock_ledger transaction types excluded from demand: `
        + unclassified.map(u => `${u.transaction_type || "(blank)"}×${u.rows}`).join(", "));
    }

    // ── Persist ──────────────────────────────────────────────────────────────
    const runNo = `IPL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const counts = { A: 0, B: 0, C: 0 };
    for (const r of results) if (r.abc) counts[r.abc] = (counts[r.abc] || 0) + 1;
    const updatedRows = results.filter(r => !r.skip);

    const { rows: [run] } = await client.query(`
      INSERT INTO inventory_planning_runs
        (company_id, run_no, lookback_days, ordering_cost, holding_cost_rate, service_level_pct,
         items_evaluated, items_updated, items_skipped, abc_a_count, abc_b_count, abc_c_count,
         total_annual_value, params, run_by, run_by_name, completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW()) RETURNING *`,
      [companyId, runNo, lookbackDays, orderingCost, holdingRate, serviceLevel,
       results.length, shouldApply ? updatedRows.length : 0, results.length - updatedRows.length,
       counts.A || 0, counts.B || 0, counts.C || 0, r2(grand),
       JSON.stringify({ z, apply: shouldApply, min_periods: minPeriods, unclassified_transaction_types: unclassified }),
       actor.id ?? null, actor.name ?? 'System']);

    for (const r of results) {
      await client.query(`
        INSERT INTO inventory_planning_run_items
          (run_id, company_id, item_id, item_code, item_name, annual_demand, avg_daily_demand,
           demand_stddev, unit_cost, eoq, safety_stock, reorder_point, abc_class,
           annual_consumption_value, applied, skip_reason,
           abc_value_pct, abc_cumulative_pct, abc_rank, xyz_class, fsn_class, demand_cv)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        // `applied` = this row's classification landed on the item master.
        // For an insufficient-history item that is now true (its FSN and its
        // cleared ABC/XYZ are written); skip_reason still says its planning
        // parameters were not computed.
        [run.id, companyId, r.item.id, r.item.item_code, r.item.item_name,
         r.annual_demand, r.daily_demand ?? null, r.sigma_period ?? null, r.unit_cost,
         r.eoq, r.safety_stock, r.rop, r.abc, r.acv,
         shouldApply, r.skip,
         r.abc_value_pct ?? null, r.abc_cumulative_pct ?? null, r.abc_rank ?? null,
         r.xyz ?? null, r.fsn ?? null, r.cv ?? null]);

      if (!shouldApply) continue;

      // abc_class is moved only when abc_class_source does not say 'manual'
      // (abcRecomputeSetSql). A manual override survives every recompute,
      // including one that equals the calculated class.

      if (r.skip) {
        // Too little history to compute anything from demand. This is the
        // rule the header states — NULL parameters and a reason, never a zero —
        // applied to the item master, which used to keep the last successful
        // run's figures indefinitely and present them as current:
        //
        //   cleared   every CALCULATED, demand-derived figure: annual / daily
        //             demand, sigma, CV, EOQ, calculated safety stock and
        //             reorder point, annual consumption value, the ABC/XYZ
        //             results, and planning_params_computed_at (the KPI service
        //             counts that timestamp as "has planning parameters").
        //   kept      the OPERATIVE safety_stock and reorder_level, whichever
        //             source they have. MRP nets against safety_stock and stock
        //             alerts fire on reorder_level; whether an item that has
        //             lost its demand history should keep, drop or replace that
        //             cover is a stocking-policy decision, not a calculation, and
        //             is not made here. GET /planning/parameters labels a
        //             calculated-source figure with no current calculation
        //             behind it as 'no_current_calculation'.
        //   kept      service level, lead time, lot sizing — policy and typed
        //             inputs, not derived from history.
        //
        // Consumers already handle the NULLs: MRP falls back to the lot size
        // when eoq is NULL, procurement's EOQ endpoint answers
        // 'insufficient_history' (with a unit cost from resolveUnitCost), and
        // the KPI service files a no-demand item under FSN rather than excess.
        await client.query(`
          UPDATE inventory_items SET
            abc_class_calculated = NULL,
            abc_value_pct        = NULL,
            abc_cumulative_pct   = NULL,
            abc_rank             = NULL,
            xyz_class            = NULL,
            demand_cv            = NULL,
            annual_demand            = NULL,
            avg_daily_demand         = NULL,
            demand_stddev            = NULL,
            demand_periods_observed  = NULL,
            eoq                      = NULL,
            safety_stock_calculated  = NULL,
            reorder_point_calculated = NULL,
            annual_consumption_value = NULL,
            planning_params_computed_at = NULL,
            ${abcRecomputeSetSql('NULL')},
            fsn_class            = $2::text,
            last_movement_date   = $3::date,
            classification_reason = $4::text,
            classified_at        = NOW(),
            updated_at           = NOW()
          WHERE id = $1 AND ($5::int IS NULL OR company_id = $5)`,
          [r.item.id, r.fsn, r.last_movement ?? null, INSUFFICIENT_HISTORY, companyId]);
        continue;
      }

      // Manual overrides are honoured: the calculated figure is always stored,
      // but the operative column is only moved when its source says calculated.
      await client.query(`
        UPDATE inventory_items SET
          annual_demand             = $2,
          avg_daily_demand          = $3,
          demand_stddev             = $4,
          demand_cv                 = $5,
          demand_periods_observed   = $6,
          eoq                       = $7,
          safety_stock_calculated   = $8,
          reorder_point_calculated  = $9,
          abc_class_calculated      = $10::text,
          annual_consumption_value  = $11,
          service_level_pct         = $12,
          service_level_z           = $13,
          ${abcRecomputeSetSql('$10::text')},
          abc_value_pct             = $14,
          abc_cumulative_pct        = $15,
          abc_rank                  = $16,
          xyz_class                 = $17::text,
          fsn_class                 = $18::text,
          last_movement_date        = $19::date,
          classification_reason     = NULL,
          classified_at             = NOW(),
          safety_stock  = CASE WHEN COALESCE(safety_stock_source,'calculated')  = 'manual'
                               THEN safety_stock  ELSE $8 END,
          reorder_level = CASE WHEN COALESCE(reorder_point_source,'calculated') = 'manual'
                               THEN reorder_level ELSE $9 END,
          planning_params_computed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1 AND ($20::int IS NULL OR company_id = $20)`,
        [r.item.id, r.annual_demand, r.daily_demand, r.sigma_period, r.cv, r.periods,
         r.eoq, r.safety_stock, r.rop, r.abc, r.acv, serviceLevel, z,
         r.abc_value_pct ?? null, r.abc_cumulative_pct ?? null, r.abc_rank ?? null,
         r.xyz ?? null, r.fsn ?? null, r.last_movement ?? null, companyId]);
    }

    await client.query('COMMIT');
    return {
      run,
      items: results.map(r => ({
        item_id: r.item.id, item_code: r.item.item_code, item_name: r.item.item_name,
        annual_demand: r.annual_demand, avg_daily_demand: r.daily_demand ?? null,
        demand_stddev: r.sigma_period ?? null, demand_cv: r.cv ?? null,
        unit_cost: r.unit_cost, eoq: r.eoq, safety_stock: r.safety_stock,
        reorder_point: r.rop, abc_class: r.abc,
        abc_value_pct: r.abc_value_pct ?? null, abc_cumulative_pct: r.abc_cumulative_pct ?? null,
        abc_rank: r.abc_rank ?? null, xyz_class: r.xyz ?? null, fsn_class: r.fsn ?? null,
        last_movement_date: r.last_movement ?? null,
        classification_reason: r.skip ? INSUFFICIENT_HISTORY : null,
        annual_consumption_value: r.acv, skipped: Boolean(r.skip), skip_reason: r.skip,
      })),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export default {
  recomputePlanningParameters, getPlanningSettings, updatePlanningSettings,
  zForServiceLevel, calculateEOQ, calculateSafetyStock, calculateDynamicROP,
  classifyABCPareto, suggestedOrderQuantity, classifyXYZ, classifyFSN,
  INSUFFICIENT_HISTORY, demandQtySql, demandRowSql, issueRowSql, unclassifiedTransactionTypes,
  validatePlanningSettings, PlanningSettingsError, purchaseRatesByItem, resolveUnitCost,
  abcRecomputeSetSql, abcOverrideSetSql, parseAbcOverride, abcStatusSql, getAbcClassification,
};
