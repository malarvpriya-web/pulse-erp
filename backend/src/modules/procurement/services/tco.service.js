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

const num = (v, fallback = null) => {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Company TCO rates. A company with no procurement_settings row gets the
 * engine defaults rather than zeros — zeros would silently disable half the
 * model and make every vendor look identical.
 */
export async function loadTcoParams(companyId) {
  const { rows } = await pool.query(
    `SELECT tco_enabled, cost_of_capital_pct, inventory_carrying_pct,
            ordering_cost_per_po, inspection_cost_per_receipt,
            expedite_cost_per_late_order, rework_cost_pct, default_freight_pct,
            gst_input_credit_pct, single_source_risk_pct, service_level_z,
            tco_horizon_months
       FROM procurement_settings
      WHERE ($1::int IS NULL OR company_id = $1)
      ORDER BY company_id NULLS LAST
      LIMIT 1`,
    [companyId ?? null]
  ).catch(() => ({ rows: [] }));   // pre-migration DB: fall back to defaults
  return resolveParams(rows[0] || {});
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
    // landed_costs is the richer source (freight + insurance + other) but only
    // exists for POs someone costed; purchase_orders.freight_amount is the
    // fallback. Both are per-PO across all lines, so this is a vendor-level
    // ratio, not a per-item one — hence NULLIF on the divisor, never a bare /.
    pool.query(
      `SELECT po.supplier_id AS vendor_id,
              SUM(COALESCE(lc.freight_cost, po.freight_amount, 0)
                + COALESCE(lc.insurance, 0)
                + COALESCE(lc.other_charges, 0))::numeric AS freight_value,
              SUM(COALESCE(po.subtotal, po.total_amount, 0))::numeric AS goods_value
         FROM purchase_orders po
         LEFT JOIN landed_costs lc ON lc.po_id = po.id
        WHERE po.deleted_at IS NULL
          AND LOWER(COALESCE(po.status, '')) NOT IN ('cancelled', 'rejected')
          ${companyId == null ? '' : 'AND po.company_id = $1'}
        GROUP BY po.supplier_id`,
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
    const goods = num(r.goods_value, 0) || 0;
    const frt   = num(r.freight_value, 0) || 0;
    if (goods > 0 && frt > 0) {
      s.freight_pct_observed = +((frt / goods) * 100).toFixed(3);
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
    model: 'acquisition + landed + ownership + risk',
    ...extra,
  };
}

export default { loadTcoParams, loadVendorPerformance, loadAnnualDemand, masterRate, tcoBasis, TCO_DEFAULTS };
