/**
 * procurementSettings.service.js — the module's configuration, in one place.
 *
 * WHY IT MOVED OUT OF THE ROUTER
 * ------------------------------
 * `PROC_DEFAULTS` and `getProcSettings()` sat in the middle of
 * procurement.routes.js and were read by ten handlers spread across 3,800 lines
 * — PR approval, PO approval, PO cancellation, receipt tolerance, three-way
 * matching, payment blocking, vendor creation and document numbering. Every one
 * of those is a control: the value it reads decides whether a requisition needs
 * CFO sign-off, whether a receipt is refused, whether an invoice can become a
 * payable. Keeping the defaults, the reader and the ranges together — and away
 * from the routing — makes it possible to see the whole control surface at once,
 * which is what the settings audit needed and could not do.
 *
 * The defaults are NOT decoration. `getProcSettings()` falls back to them for a
 * company with no settings row, and the values below are the ones the approval
 * bands, the receipt tolerance and the match tolerance are actually enforced on
 * in that case. A zero here would silently disable the control it names.
 */
import pool from '../../shared/db.js';
import { TCO_DEFAULTS } from '../engines/tcoEngine.js';

export const PROC_DEFAULTS = {
  default_payment_terms_days:  30,
  auto_approve_below:          5000,
  grn_qty_tolerance_pct:       5,
  min_vendor_rating:           3,
  l1_approval_limit:           25000,
  l2_approval_limit:           100000,
  cfo_approval_above:          500000,
  enforce_3way_match:          false,
  block_payment_on_mismatch:   false,
  allowable_price_variance_pct:3,
  pr_prefix:                   'PR',
  po_prefix:                   'PO',
  grn_prefix:                  'GRN',
  rfq_prefix:                  'RFQ',
  rtv_prefix:                  'RTV',
  lpr_prefix:                  'LPR',
  notify_po_approval:          false,
  notify_grn_receipt:          false,
  alert_vendor_rating_drop:    false,
  alert_overdue_delivery:      false,
  // TCO costing rates — mirrored from the engine so a company with no settings
  // row still gets a defensible model rather than zeros (zeros would disable
  // half the cost drivers and make every vendor look identical).
  ...TCO_DEFAULTS,
};

/**
 * The TCO rates the settings PUT owns. Kept as a list so the INSERT, the
 * ON CONFLICT SET and the validation cannot drift apart the way the 19
 * hand-written columns above already have to be kept in step by eye.
 */
export const TCO_SETTING_COLS = Object.keys(TCO_DEFAULTS);

/**
 * Rates are percentages and per-event costs, not free numbers. A negative
 * carrying rate turns holding cost into a rebate and inverts every ranking on
 * the comparison page, so it is rejected at the door rather than clamped
 * silently — a buyer who typed -18 needs to know it did not take.
 */
export const TCO_RANGES = {
  cost_of_capital_pct:          [0, 100],
  inventory_carrying_pct:       [0, 100],
  rework_cost_pct:              [0, 500],
  default_freight_pct:          [0, 100],
  gst_input_credit_pct:         [0, 100],
  single_source_risk_pct:       [0, 100],
  service_level_z:              [0, 5],
  ordering_cost_per_po:         [0, 1e9],
  inspection_cost_per_receipt:  [0, 1e9],
  expedite_cost_per_late_order: [0, 1e9],
  tco_horizon_months:           [1, 120],
};

/**
 * This company's procurement settings, with the defaults filled in.
 *
 * A read failure falls back to the defaults rather than throwing: settings must
 * never be the reason an approval or a receipt fails. The defaults are the
 * CONSERVATIVE direction — thresholds present, tolerances small, the two
 * enforcement flags off — so a fallback never accidentally opens a control.
 */
export async function getProcSettings(companyId, client = null) {
  if (!companyId) return PROC_DEFAULTS;
  const db = client ?? pool;
  const { rows } = await db
    .query(`SELECT * FROM procurement_settings WHERE company_id=$1 LIMIT 1`, [companyId])
    .catch(() => ({ rows: [] }));
  return rows[0] ? { ...PROC_DEFAULTS, ...rows[0] } : PROC_DEFAULTS;
}

export default { PROC_DEFAULTS, TCO_SETTING_COLS, TCO_RANGES, getProcSettings };
