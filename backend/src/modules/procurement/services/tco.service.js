/**
 * tco.service.js — feeds the TCO engine with real data.
 *
 * The engine (engines/tcoEngine.js) is pure arithmetic. Everything that makes a
 * TCO trustworthy rather than a rate-card fantasy is loaded here:
 *
 *   - the company's costing rates from procurement_settings
 *   - each vendor's OBSERVED reject rate from grn_items (not the stale
 *     vendors.defect_rate a human typed in once)
 *   - each vendor's OBSERVED on-time rate from GRN vs PO promised date
 *   - each vendor's OBSERVED freight as a share of order value, from the
 *     purchase_orders/landed_costs the vendor actually billed us
 *   - the item's annual demand, so per-order and one-time costs are spread over
 *     the same volume for every vendor being compared
 *
 * Observed beats master-data everywhere, and the `*_basis` flags travel with the
 * numbers so the UI can say which is which. A comparison that cannot show its
 * provenance gets trusted anyway, which is worse than showing nothing.
 */
import pool from '../../shared/db.js';
import { resolveParams, TCO_DEFAULTS } from '../engines/tcoEngine.js';
import { resolveFxRates, fxFieldsFor } from '../../finance/services/fxRate.service.js';

export { fxFieldsFor };

const num = (v, fallback = null) => {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The company's TCO settings could not be READ (missing column, failed query).
 * Distinct from "no settings row", which legitimately means defaults.
 */
export class TcoParamsUnavailableError extends Error {
  constructor(cause) {
    super(`TCO settings could not be read, so no comparison is costed: ${cause?.message || cause}`);
    this.name = 'TcoParamsUnavailableError';
    this.code = 'TCO_SETTINGS_UNAVAILABLE';
    this.status = 503;
    this.cause = cause;
  }
}

/**
 * Company TCO rates. A company with NO procurement_settings row gets the engine
 * defaults rather than zeros — zeros would silently disable half the model.
 *
 * A failed READ is not "no row". This used to `.catch(() => ({ rows: [] }))`,
 * so a missing column (code deployed ahead of its migration) or a dropped
 * connection quietly replaced every company's saved rates with the defaults and
 * the comparison looked fine. It now throws TcoParamsUnavailableError; callers
 * show "TCO unavailable" instead of a plausible wrong number.
 *
 * No company → defaults, NOT "the first company's row": the old
 * `$1 IS NULL OR company_id = $1 … LIMIT 1` handed an unscoped caller whichever
 * tenant sorted first.
 */
export async function loadTcoParams(companyId) {
  if (companyId == null) return resolveParams({});
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT tco_enabled, cost_of_capital_pct, inventory_carrying_pct,
              ordering_cost_per_po, inspection_cost_per_receipt,
              expedite_cost_per_late_order, rework_cost_pct, default_freight_pct,
              gst_input_credit_pct, single_source_risk_pct, service_level_z,
              tco_horizon_months, tco_day_count_basis, tco_fx_max_age_days,
              tco_assumed_freight_enabled, main_receiving_warehouse_id,
              default_currency AS base_currency
         FROM procurement_settings
        WHERE company_id = $1
        LIMIT 1`,
      [companyId]
    ));
  } catch (e) {
    throw new TcoParamsUnavailableError(e);
  }
  return resolveParams(rows[0] || {});
}

/**
 * Quoted freight for the engine, in the QUOTE's currency (§219).
 *
 * A vendor may quote goods in one currency and freight in another
 * (freight_currency). The stored figures are left exactly as entered; here the
 * freight is restated in the quote's currency with APPROVED rates:
 *   freight_q = freight_f x rate(f → base) / rate(q → base)
 * so the engine's single quote-currency conversion then lands it in base.
 *
 * If the freight currency has no usable approved rate, the freight is NOT
 * dropped and the model does NOT take over — the vendor quoted freight, so it
 * stays quoted freight. The option carries `charges_fx_unavailable`, the
 * engine refuses to cost it (reason no_fx_rate), and §217 makes the comparison
 * incomplete with the vendor and reason shown.
 */
export function quoteFreightFields(q, fx, baseCurrency) {
  const n = (v) => { if (v == null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
  const base = (baseCurrency || 'INR').toUpperCase();
  const fa = n(q.freight_amount), fpu = n(q.freight_per_unit);
  const out = { freight_amount: fa, freight_per_unit: fpu };
  const qc = (q.currency ? String(q.currency).toUpperCase() : null) || base;
  const fc = q.freight_currency ? String(q.freight_currency).toUpperCase() : null;
  if (!fc || fc === qc || (fa == null && fpu == null)) return out;
  const toBase = (c) => (c === base ? { ok: true, rate: 1, method: 'base' } : fx?.get(c));
  const rf = toBase(fc);
  if (!rf?.ok) {
    return { freight_amount: null, freight_per_unit: null,
      charges_fx_unavailable: { reason: rf?.reason ?? 'no_approved_rate', currency: fc, latest_rate_date: rf?.latest_rate_date ?? null,
        message: `Freight quoted in ${fc}: ${rf?.message || `no approved ${fc} exchange rate`}` } };
  }
  const rq = qc !== base && q.fx_rate_override != null ? { ok: true, rate: Number(q.fx_rate_override) } : toBase(qc);
  // The quote's own currency unconvertible: the engine refuses the whole quote
  // on that ground already; leave freight as stated.
  if (!rq?.ok) return out;
  const factor = rf.rate / rq.rate;
  return {
    freight_amount: fa == null ? null : fa * factor,
    freight_per_unit: fpu == null ? null : fpu * factor,
    freight_fx: { from: fc, to: qc, factor, rate_to_base: rf.rate, rate_id: rf.rate_id ?? null,
                  rate_date: rf.rate_date ?? null, source: rf.source ?? null,
                  as_quoted: { freight_amount: fa, freight_per_unit: fpu, currency: fc } },
  };
}

/**
 * Approved FX resolutions for a set of priced options, as of today (DB date).
 * Thin wrapper so every TCO caller applies the same rule.
 */
export async function loadFxForCurrencies(companyId, currencies, params) {
  return resolveFxRates(companyId, currencies, {
    baseCurrency: params.base_currency, maxAgeDays: params.tco_fx_max_age_days,
  });
}

/**
 * Per-vendor observed performance for ONE component.
 *
 * Scoped by company where the source table carries a company_id. Returns a Map
 * keyed by vendor_id, so a vendor with no history is simply absent and the
 * engine falls back to master data (and says so).
 */
export async function loadVendorPerformance(itemId, companyId) {
  const scoped = companyId == null ? '' : ' AND po.company_id = $2';
  const args   = companyId == null ? [itemId] : [itemId, companyId];

  const [quality, delivery, freight] = await Promise.all([
    // Reject rate measured at the gate, for THIS component and THIS vendor.
    // grn_items.quantity_rejected is the only place the truth lives; the
    // vendors.defect_rate column is a manually maintained summary across all
    // parts and cannot answer "how do they do on this part".
    pool.query(
      `SELECT po.supplier_id AS vendor_id,
              SUM(gi.quantity_received)::numeric AS received_qty,
              SUM(COALESCE(gi.quantity_rejected, 0))::numeric AS rejected_qty,
              COUNT(DISTINCT g.id)::int AS receipt_count
         FROM grn_items gi
         JOIN goods_receipt_notes g ON g.id = gi.grn_id AND g.deleted_at IS NULL
         JOIN purchase_orders po    ON po.id = g.po_id  AND po.deleted_at IS NULL
        WHERE gi.item_id = $1${scoped}
        GROUP BY po.supplier_id`,
      args
    ).catch(() => ({ rows: [] })),

    // On-time delivery: received on or before the PO's promised date. Rows with
    // no promised date are excluded from BOTH numerator and denominator — a
    // missing promise is not evidence of lateness.
    pool.query(
      `SELECT po.supplier_id AS vendor_id,
              COUNT(*)::int AS receipts,
              COUNT(*) FILTER (WHERE g.received_date <= po.expected_delivery_date)::int AS on_time
         FROM goods_receipt_notes g
         JOIN purchase_orders po      ON po.id = g.po_id AND po.deleted_at IS NULL
         JOIN purchase_order_items pi ON pi.po_id = po.id AND pi.item_id = $1
        WHERE g.deleted_at IS NULL
          AND g.received_date IS NOT NULL
          AND po.expected_delivery_date IS NOT NULL${scoped}
        GROUP BY po.supplier_id`,
      args
    ).catch(() => ({ rows: [] })),

    // Freight as a share of order value, from what the vendor actually billed.
    //
    // THREE SOURCES, IN ORDER OF GRAIN. Freight is a per-CONSIGNMENT cost — one
    // PO received in three part-loads carries three different carrier bills —
    // so the receipt is the truest grain and the PO header the coarsest:
    //
    //   1. goods_receipt_notes  what the lorry that actually arrived cost
    //   2. landed_costs         the PO's costing sheet, when someone filled one
    //   3. purchase_orders.freight_amount   the PO header figure
    //
    // NULLIF(po.freight_amount, 0) is load-bearing. The column is
    // `numeric DEFAULT 0`, so it is NEVER NULL and the old COALESCE could never
    // reach its next branch: all six live POs read 0.00 because nobody was ever
    // asked, not because carriage was free. Unmeasured is not zero — the same
    // rule masterRate() below enforces for vendor performance. A human who
    // types a genuine 0 still loses it here; that is the price of a column
    // whose default destroyed the distinction, and it is why the GRN columns
    // added in 20260917000003 are nullable with NO default.
    //
    // THE RATIO IS TAKEN OVER COSTED ORDERS ONLY. Dividing a vendor's freight
    // by the value of EVERY order — including the ones nobody costed — deflates
    // the ratio by exactly the share that went uncosted, so a vendor with one
    // costed PO in ten would look ten times cheaper to ship from than they are.
    // `costed_orders` travels with the number so the caller can weigh it.
    //
    // Each child is pre-aggregated to one row per po_id BEFORE it is joined.
    // Joining goods_receipt_notes and landed_costs directly to purchase_orders
    // would multiply the two children together and count goods_value once per
    // resulting row (project_sql_fanout_multi_child_join).
    pool.query(
      `WITH po_base AS (
         SELECT po.id, po.supplier_id,
                COALESCE(NULLIF(po.subtotal, 0), po.total_amount, 0) AS goods_value,
                NULLIF(po.freight_amount, 0)                         AS po_freight
           FROM purchase_orders po
          WHERE po.deleted_at IS NULL
            AND LOWER(COALESCE(po.status, '')) NOT IN ('cancelled', 'rejected')
            ${companyId == null ? '' : 'AND po.company_id = $1'}
       ),
       grn_charges AS (
         SELECT g.po_id,
                SUM(COALESCE(g.freight_amount, 0)
                  + COALESCE(g.insurance_amount, 0)
                  + COALESCE(g.other_charges, 0)) AS amt,
                COUNT(*) FILTER (
                  WHERE g.freight_amount IS NOT NULL
                     OR g.insurance_amount IS NOT NULL
                     OR g.other_charges IS NOT NULL
                ) AS costed_receipts
           FROM goods_receipt_notes g
          WHERE g.deleted_at IS NULL AND g.po_id IS NOT NULL
          GROUP BY g.po_id
       ),
       lc_charges AS (
         SELECT lc.po_id,
                SUM(COALESCE(lc.freight_cost, 0)
                  + COALESCE(lc.insurance, 0)
                  + COALESCE(lc.other_charges, 0)) AS amt
           FROM landed_costs lc
          WHERE lc.po_id IS NOT NULL
          GROUP BY lc.po_id
       ),
       resolved AS (
         SELECT b.supplier_id,
                b.goods_value,
                COALESCE(
                  CASE WHEN gc.costed_receipts > 0 THEN gc.amt END,
                  lcc.amt,
                  b.po_freight
                ) AS charge
           FROM po_base b
           LEFT JOIN grn_charges gc  ON gc.po_id  = b.id
           LEFT JOIN lc_charges  lcc ON lcc.po_id = b.id
       )
       SELECT supplier_id AS vendor_id,
              SUM(charge) FILTER (WHERE charge IS NOT NULL)::numeric      AS freight_value,
              SUM(goods_value) FILTER (WHERE charge IS NOT NULL)::numeric AS goods_value,
              COUNT(*) FILTER (WHERE charge IS NOT NULL)::int             AS costed_orders,
              COUNT(*)::int                                               AS order_count
         FROM resolved
        GROUP BY supplier_id`,
      companyId == null ? [] : [companyId]
    ).catch(() => ({ rows: [] })),
  ]);

  const map = new Map();
  const slot = (id) => {
    const k = Number(id);
    if (!Number.isFinite(k)) return null;
    if (!map.has(k)) map.set(k, { vendor_id: k });
    return map.get(k);
  };

  for (const r of quality.rows) {
    const s = slot(r.vendor_id); if (!s) continue;
    const recv = num(r.received_qty, 0) || 0;
    const rej  = num(r.rejected_qty, 0) || 0;
    // Denominator is what was PRESENTED (accepted + rejected), not what was
    // accepted — dividing by the accepted quantity understates the reject rate.
    const presented = recv + rej;
    if (presented > 0) {
      s.reject_rate_pct = +((rej / presented) * 100).toFixed(3);
      s.reject_basis    = 'observed';
      s.receipt_count   = r.receipt_count;
      s.received_qty    = recv;
    }
  }

  for (const r of delivery.rows) {
    const s = slot(r.vendor_id); if (!s) continue;
    const n = r.receipts || 0;
    if (n > 0) {
      s.on_time_pct  = +((r.on_time / n) * 100).toFixed(2);
      s.on_time_basis = 'observed';
      s.otd_sample    = n;
    }
  }

  for (const r of freight.rows) {
    const s = slot(r.vendor_id); if (!s) continue;
    const goods  = num(r.goods_value, 0) || 0;
    const frt    = num(r.freight_value, 0) || 0;
    const costed = r.costed_orders || 0;
    // `frt >= 0`, not `> 0`. A vendor whose costed orders all carried nil
    // freight has been MEASURED at zero — they deliver free — and that is a
    // real commercial advantage the comparison should credit them with. The
    // previous `> 0` discarded it and fell back to charging them the company's
    // assumed 2%, penalising the one vendor who does not bill for carriage.
    // Unmeasured is still distinct: those vendors have no row here at all.
    if (goods > 0 && costed > 0 && frt >= 0) {
      s.freight_pct_observed    = +((frt / goods) * 100).toFixed(3);
      s.freight_sample_orders   = costed;
      s.freight_order_count     = r.order_count || costed;
    }
  }

  return map;
}

/**
 * Annual demand for a component, so per-order and one-time costs are spread
 * over the same volume for every vendor.
 *
 * Consumption first (what the plant actually burns), purchase history second.
 * A component with neither returns null and the engine narrows the horizon to
 * the compared quantity — stated in its `assumptions`, never silently.
 */
export async function loadAnnualDemand(itemId, companyId) {
  const scopedLed = companyId == null ? '' : ' AND sl.company_id = $2';
  const scopedPo  = companyId == null ? '' : ' AND po.company_id = $2';
  const args = companyId == null ? [itemId] : [itemId, companyId];

  // stock_ledger is the consumption ledger, and `quantity_out` is read directly
  // rather than filtering on transaction_type: that column holds free text whose
  // live values are seeded labels ('Primary', 'General', 'Routine', 'Standard'),
  // not a movement vocabulary, so an IN ('issue','out',...) filter matches
  // nothing and would silently report zero demand for every component.
  // stock_movements is NOT used here — it has no company_id at all, so it cannot
  // be tenant-scoped (see project_stock_three_systems_unification).
  const { rows: iss } = await pool.query(
    `SELECT SUM(COALESCE(sl.quantity_out, 0))::numeric AS qty
       FROM stock_ledger sl
      WHERE sl.item_id = $1
        AND sl.transaction_date >= (CURRENT_DATE - INTERVAL '12 months')
        ${scopedLed}`,
    args
  ).catch(() => ({ rows: [] }));

  const consumed = num(iss[0]?.qty);
  if (consumed != null && consumed > 0) {
    return { annual_demand_qty: consumed, demand_basis: 'observed', demand_source: 'consumption (12m)' };
  }

  const { rows: po } = await pool.query(
    `SELECT SUM(poi.quantity)::numeric AS qty
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.po_id AND po.deleted_at IS NULL
      WHERE poi.item_id = $1
        AND po.order_date >= (CURRENT_DATE - INTERVAL '12 months')
        AND LOWER(COALESCE(po.status, '')) NOT IN ('cancelled', 'rejected')
        ${scopedPo}`,
    args
  ).catch(() => ({ rows: [] }));

  const purchased = num(po[0]?.qty);
  if (purchased != null && purchased > 0) {
    return { annual_demand_qty: purchased, demand_basis: 'observed', demand_source: 'purchases (12m)' };
  }

  return { annual_demand_qty: null, demand_basis: null, demand_source: null };
}

/**
 * A hand-maintained vendor-master rate, read as "unknown" when it is 0.
 *
 * `vendors.on_time_pct` and `vendors.defect_rate` default to 0 and are filled in
 * by a human, so across the live vendor master a 0 overwhelmingly means NOBODY
 * MEASURED IT, not "this vendor is never on time". Taking it literally is
 * actively punitive: a 0% on-time rate drives a 100% late share, which charges
 * the vendor maximum safety stock AND expediting on every order — a fabricated
 * penalty large enough to flip the award away from them.
 *
 * Unmeasured is not zero (see project_analytics_ai_module_audit). A real
 * measured zero still gets through, because it comes from loadVendorPerformance
 * as an OBSERVED value and never passes through here.
 */
export function masterRate(v) {
  const n = num(v);
  return n == null || n === 0 ? null : n;
}

/**
 * The basis block every TCO payload must carry.
 *
 * A comparison whose window and rates are invisible produces a plausible wrong
 * answer that nobody can audit (see project_ceo_intelligence_growth_window_and_tabstrip
 * — a wrong window shipped a believable empty state for months). Shipping the
 * rates alongside the numbers is how a buyer checks the model before defending
 * an award on it.
 */
export function tcoBasis(params, extra = {}) {
  return {
    // Honoured by every caller: when a company switches TCO off, comparisons
    // fall back to unit price and the UI hides the TCO columns rather than
    // showing a column of dashes.
    tco_enabled:                  params.tco_enabled !== false,
    horizon_months:               params.tco_horizon_months,
    cost_of_capital_pct:          params.cost_of_capital_pct,
    inventory_carrying_pct:       params.inventory_carrying_pct,
    ordering_cost_per_po:         params.ordering_cost_per_po,
    inspection_cost_per_receipt:  params.inspection_cost_per_receipt,
    expedite_cost_per_late_order: params.expedite_cost_per_late_order,
    rework_cost_pct:              params.rework_cost_pct,
    default_freight_pct:          params.default_freight_pct,
    gst_input_credit_pct:         params.gst_input_credit_pct,
    single_source_risk_pct:       params.single_source_risk_pct,
    service_level_z:              params.service_level_z,
    day_count_basis:              params.tco_day_count_basis,
    currency:                     params.base_currency,
    fx_max_age_days:              params.tco_fx_max_age_days,
    assumed_freight_enabled:      params.tco_assumed_freight_enabled !== false,
    main_receiving_warehouse_id:  params.main_receiving_warehouse_id ?? null,
    freight_rule:                 'quoted → modelled (kg/1000 x km x approved rate per tonne-km) → observed → assumed % (if enabled) → incomplete',
    fx_rule:                      'approved Finance rate on or before the comparison date; stale or unapproved = not ranked',
    model: 'acquisition + landed + ownership + risk',
    ...extra,
  };
}

export default { loadTcoParams, loadFxForCurrencies, loadVendorPerformance, loadAnnualDemand, masterRate, tcoBasis, TCO_DEFAULTS };
