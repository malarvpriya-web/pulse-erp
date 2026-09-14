/**
 * spendAnalytics.service.js — the procurement spend cube.
 *
 * WHY THIS EXISTS
 * ---------------
 * `GET /procurement/analytics/spend` used to be twelve lines inline in the
 * route file, and every one of the numbers it returned was wrong in a way the
 * caller could not see:
 *
 *   1. CURRENCY. It summed `purchase_orders.total_amount` — the figure in the
 *      currency the PO was RAISED in. A $12,000 order added 12,000 to a rupee
 *      total. The correct column, `total_amount_inr`, already existed on the
 *      same row and was never read.
 *
 *   2. "CATEGORY" WAS NOT A CATEGORY. `group_by=category` grouped on
 *      `vendors.category` — free text describing the SUPPLIER, not what was
 *      bought. A distributor selling fasteners, bearings and lubricants
 *      reported as one bar. Meanwhile `item_categories` — a real parent/child
 *      commodity tree — hangs off every PO line via
 *      `inventory_items.category_id` and was never joined. Commodity spend is
 *      therefore computed at the LINE level here, which is the only level at
 *      which it means anything: one PO can span five categories.
 *
 *   3. SILENT TRUNCATION. A hard `LIMIT 20` with no total and no flag. On any
 *      real supplier base "spend by vendor" was a top-20 list presented as the
 *      whole picture, and any share-of-spend computed from it was a share of
 *      the visible fifth. Shares here are always computed against the true
 *      grand total, before truncation, and `truncated`/`group_count` say what
 *      was left out.
 *
 *   4. DRAFT POs COUNTED AS SPEND. The filter excluded `cancelled` only, so
 *      drafts and rejects inflated every figure. `PO_VOID` in shared/statusSets
 *      was written for exactly this predicate — "Draft is excluded because it
 *      is not yet a commitment" — and this is its first caller.
 *
 * HEADER vs LINE, AND WHY THE TWO TOTALS DIFFER
 * ---------------------------------------------
 * Vendor and month spend are header figures. Commodity spend is the sum of
 * line figures, and the two do NOT reconcile: freight, customs duty and any
 * header-level charge live outside the lines, and a PO with no lines at all
 * contributes nothing to the commodity view. Rather than quietly letting the
 * category panel under-report against the vendor panel next to it, every
 * response carries a `coverage` block stating the header total, the classified
 * total and the gap. A spend figure whose coverage is invisible gets trusted
 * anyway, which is worse than showing nothing.
 *
 * Everything is returned in INR. `exchange_rate` is applied to line amounts,
 * which are stored in the PO's own currency.
 */
import pool from '../../shared/db.js';
import { sqlPoCommitted, notIn, BILL_VOID } from '../../../shared/statusSets.js';

/** Rows a single facet returns before it is truncated. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** pg returns NUMERIC as a string; NULL must not become 0 by accident. */
const num = (v, fallback = 0) => {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * A purchase order's value in INR, as a SQL expression.
 *
 * `total_amount` is denominated in the PO's OWN currency, so summing it across
 * a mixed-currency book adds dollars to rupees. `total_amount_inr` is the
 * correct column; where it was never populated the rate on the row is applied,
 * and a zero or NULL rate falls back to 1 rather than annihilating the order.
 *
 * Exported so every spend figure in the module — cube, trend and dashboard —
 * is the same expression rather than three hand-copied variants that drift.
 */
export const poSpendInr = (alias = 'po') =>
  `COALESCE(${alias}.total_amount_inr, ${alias}.total_amount * COALESCE(NULLIF(${alias}.exchange_rate, 0), 1), 0)`;

export function resolveLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * The scoped-PO CTE every facet builds on, plus the bind values it needs.
 *
 * All four facet queries prepend this identical prefix and pass this identical
 * array, so every `$n` is referenced in every statement — sharing one
 * fixed-position param array across sibling queries is otherwise how you get
 * an "unreferenced parameter" bind error.
 *
 * `total_amount_inr` is preferred; where it was never populated the rate on the
 * row is applied, and a zero/NULL rate falls back to 1 rather than annihilating
 * the order.
 */
function scopedPoCte({ companyId, from, to }) {
  const params = [];
  const conditions = [
    'po.deleted_at IS NULL',
    sqlPoCommitted('po.status'),
  ];
  if (companyId) { params.push(companyId); conditions.push(`po.company_id = $${params.length}`); }
  if (from)      { params.push(from);      conditions.push(`po.order_date >= $${params.length}`); }
  if (to)        { params.push(to);        conditions.push(`po.order_date <= $${params.length}`); }

  const sql = `
    WITH scoped AS (
      SELECT po.id,
             po.supplier_id,
             po.order_date,
             po.cost_center_id,
             po.project_id,
             COALESCE(NULLIF(po.exchange_rate, 0), 1) AS fx,
             ${poSpendInr('po')} AS spend_inr
      FROM purchase_orders po
      WHERE ${conditions.join(' AND ')}
    )`;

  return { sql, params };
}

/**
 * Attach share-of-total and truncate.
 *
 * `total` is the grand total across ALL groups, not the sum of what survives
 * the limit — a share computed after truncation is the defect this function
 * exists to prevent.
 */
function finalise(rows, total, limit) {
  const shaped = rows.map((r) => ({
    ...r,
    total_spend: round2(num(r.total_spend)),
    po_count: num(r.po_count),
    share_pct: total > 0 ? round2((num(r.total_spend) / total) * 100) : 0,
  }));
  return {
    rows: shaped.slice(0, limit),
    group_count: shaped.length,
    truncated: shaped.length > limit,
  };
}

/**
 * The whole cube in one call.
 *
 * Returns all three facets together because that is the shape the Procurement
 * Reports page renders — vendor, commodity and month side by side. The old
 * endpoint returned one flat array chosen by `group_by`, which no caller ever
 * sent, so the page read `by_vendor` off an array and rendered "No data" on
 * every panel.
 */
export async function loadSpendFacets({ companyId, from = null, to = null, limit = DEFAULT_LIMIT } = {}) {
  const { sql: cte, params } = scopedPoCte({ companyId, from, to });

  const [vendorRes, commodityRes, monthRes, supplierTypeRes,
         costCentreRes, projectRes, coverageRes] = await Promise.all([
    // ── by vendor (header level) ───────────────────────────────────────────
    pool.query(`${cte}
      SELECT COALESCE(v.vendor_name, 'Unknown') AS vendor_name,
             COALESCE(v.vendor_name, 'Unknown') AS label,
             SUM(s.spend_inr)                   AS total_spend,
             COUNT(*)::INT                      AS po_count
      FROM scoped s
      LEFT JOIN vendors v ON v.id = s.supplier_id
      GROUP BY COALESCE(v.vendor_name, 'Unknown')
      ORDER BY total_spend DESC NULLS LAST`, params),

    // ── by commodity category (LINE level — one PO spans many categories) ──
    pool.query(`${cte}
      SELECT COALESCE(ic.name, 'Unclassified') AS category,
             COALESCE(ic.name, 'Unclassified') AS label,
             parent.name                       AS parent_category,
             SUM(COALESCE(poi.total_amount, 0) * s.fx) AS total_spend,
             COUNT(DISTINCT s.id)::INT                 AS po_count
      FROM scoped s
      JOIN purchase_order_items poi ON poi.po_id = s.id
      LEFT JOIN inventory_items ii  ON ii.id = poi.item_id
      LEFT JOIN item_categories ic  ON ic.id = ii.category_id AND ic.deleted_at IS NULL
      LEFT JOIN item_categories parent ON parent.id = ic.parent_id AND parent.deleted_at IS NULL
      GROUP BY COALESCE(ic.name, 'Unclassified'), parent.name
      ORDER BY total_spend DESC NULLS LAST`, params),

    // ── by month (header level, ascending so "vs previous" reads forward) ──
    pool.query(`${cte}
      SELECT TO_CHAR(DATE_TRUNC('month', s.order_date), 'YYYY-MM') AS month,
             TO_CHAR(DATE_TRUNC('month', s.order_date), 'YYYY-MM') AS label,
             SUM(s.spend_inr) AS total_spend,
             COUNT(*)::INT    AS po_count
      FROM scoped s
      WHERE s.order_date IS NOT NULL
      GROUP BY DATE_TRUNC('month', s.order_date)
      ORDER BY DATE_TRUNC('month', s.order_date) ASC`, params),

    // ── by supplier type ──────────────────────────────────────────────────
    // What `group_by=category` used to mean. Kept, because "how much goes to
    // distributors vs OEMs" is a fair question — but named for what it is, so
    // it can no longer be mistaken for commodity spend.
    pool.query(`${cte}
      SELECT COALESCE(v.category, 'Uncategorised') AS vendor_category,
             COALESCE(v.category, 'Uncategorised') AS label,
             SUM(s.spend_inr) AS total_spend,
             COUNT(*)::INT    AS po_count
      FROM scoped s
      LEFT JOIN vendors v ON v.id = s.supplier_id
      GROUP BY COALESCE(v.category, 'Uncategorised')
      ORDER BY total_spend DESC NULLS LAST`, params),

    // ── by cost centre (header level) ─────────────────────────────────────
    // `purchase_orders.cost_center_id` arrived on 8 Sep. Before it, spend that
    // belonged to a DEPARTMENT rather than a project had nowhere to sit, so
    // this facet could not be asked for at all. Orders raised before the column
    // existed carry NULL and are reported as 'Unallocated' — not folded into
    // whichever centre happens to sort first, and not dropped, because a cost
    // centre view that quietly omits a fifth of the spend is worse than one
    // that shows the gap.
    pool.query(`${cte}
      SELECT COALESCE(cc.name, 'Unallocated') AS cost_centre,
             COALESCE(cc.name, 'Unallocated') AS label,
             cc.code                          AS cost_centre_code,
             SUM(s.spend_inr) AS total_spend,
             COUNT(*)::INT    AS po_count
      FROM scoped s
      LEFT JOIN cost_centers cc ON cc.id = s.cost_center_id
      GROUP BY COALESCE(cc.name, 'Unallocated'), cc.code
      ORDER BY total_spend DESC NULLS LAST`, params),

    // ── by project (header level) ─────────────────────────────────────────
    // Same treatment: an order not charged to a project is 'Unallocated', which
    // for most businesses is the majority of the book and is a legitimate row.
    pool.query(`${cte}
      SELECT COALESCE(pr.project_name, 'Unallocated') AS project,
             COALESCE(pr.project_name, 'Unallocated') AS label,
             pr.project_code,
             SUM(s.spend_inr) AS total_spend,
             COUNT(*)::INT    AS po_count
      FROM scoped s
      LEFT JOIN projects pr ON pr.id = s.project_id AND pr.deleted_at IS NULL
      GROUP BY COALESCE(pr.project_name, 'Unallocated'), pr.project_code
      ORDER BY total_spend DESC NULLS LAST`, params),

    // ── coverage: how much of the header spend the line view can explain ───
    pool.query(`${cte}
      SELECT COUNT(*)::INT AS po_count,
             COUNT(*) FILTER (
               WHERE NOT EXISTS (SELECT 1 FROM purchase_order_items poi WHERE poi.po_id = s.id)
             )::INT AS pos_without_lines,
             COALESCE(SUM(s.spend_inr), 0) AS header_spend
      FROM scoped s`, params),
  ]);

  const headerTotal = round2(num(coverageRes.rows[0]?.header_spend));
  const lineTotal = round2(
    commodityRes.rows.reduce((sum, r) => sum + num(r.total_spend), 0)
  );

  const byVendor = finalise(vendorRes.rows, headerTotal, limit);
  const byCategory = finalise(commodityRes.rows, lineTotal, limit);
  const byMonth = finalise(monthRes.rows, headerTotal, monthRes.rows.length);
  const byVendorCategory = finalise(supplierTypeRes.rows, headerTotal, limit);
  // Both are header facets, so both share the header grand total — an order
  // appears in exactly one cost centre and one project, so these reconcile with
  // the vendor panel exactly, unlike the line-level commodity panel.
  const byCostCentre = finalise(costCentreRes.rows, headerTotal, limit);
  const byProject = finalise(projectRes.rows, headerTotal, limit);

  // How much of the book has been charged to a centre / a project at all. A
  // cost-centre chart is only a control surface once this is high; below that
  // it is mostly one 'Unallocated' bar and the caller should be told.
  const allocatedShare = (rows) => {
    const unallocated = num(rows.find((r) => r.label === 'Unallocated')?.total_spend);
    return headerTotal > 0 ? round2(((headerTotal - unallocated) / headerTotal) * 100) : 0;
  };

  return {
    currency: 'INR',
    from: from || null,
    to: to || null,

    by_vendor: byVendor.rows,
    by_category: byCategory.rows,
    by_month: byMonth.rows,
    by_vendor_category: byVendorCategory.rows,
    by_cost_centre: byCostCentre.rows,
    by_project: byProject.rows,

    totals: {
      total_spend: headerTotal,
      po_count: num(coverageRes.rows[0]?.po_count),
      vendor_count: byVendor.group_count,
      category_count: byCategory.group_count,
      cost_centre_count: byCostCentre.group_count,
      project_count: byProject.group_count,
    },

    // Says out loud why the category panel does not add up to the vendor panel.
    coverage: {
      header_spend: headerTotal,
      classified_spend: lineTotal,
      unallocated_spend: round2(headerTotal - lineTotal),
      pos_without_lines: num(coverageRes.rows[0]?.pos_without_lines),
      note: 'Commodity spend is summed from PO lines; freight, duty and other header-level charges sit outside them, as does any PO with no lines.',

      // The two header dimensions added on 10 Sep. Both are optional columns on
      // a purchase order, so both have an honest "how much is actually tagged"
      // figure rather than a chart that implies full coverage.
      cost_centre_allocated_pct: allocatedShare(byCostCentre.rows),
      project_allocated_pct: allocatedShare(byProject.rows),
      allocation_note: 'cost_center_id arrived on 2026-09-08 and project_id is optional by design; orders carrying neither are reported as Unallocated rather than omitted.',
    },

    truncation: {
      limit,
      by_vendor: { group_count: byVendor.group_count, truncated: byVendor.truncated },
      by_category: { group_count: byCategory.group_count, truncated: byCategory.truncated },
      by_vendor_category: { group_count: byVendorCategory.group_count, truncated: byVendorCategory.truncated },
      by_cost_centre: { group_count: byCostCentre.group_count, truncated: byCostCentre.truncated },
      by_project: { group_count: byProject.group_count, truncated: byProject.truncated },
    },
  };
}

/**
 * Rolling monthly spend for the dashboard trend chart.
 *
 * Same currency and status corrections as the cube; kept separate because it
 * spans a fixed trailing window rather than the caller's date range.
 */
export async function loadSpendTrend({ companyId, months = 12 } = {}) {
  const window = Number.isFinite(Number(months)) ? Math.min(Math.max(Number(months), 1), 60) : 12;
  const params = [];
  const conditions = [
    'po.deleted_at IS NULL',
    sqlPoCommitted('po.status'),
    `po.order_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '${window - 1} months'`,
  ];
  if (companyId) { params.push(companyId); conditions.push(`po.company_id = $${params.length}`); }

  const { rows } = await pool.query(`
    SELECT TO_CHAR(DATE_TRUNC('month', po.order_date), 'YYYY-MM') AS month,
           COALESCE(SUM(${poSpendInr('po')}), 0) AS total_spend,
           COUNT(*)::INT AS po_count
    FROM purchase_orders po
    WHERE ${conditions.join(' AND ')}
    GROUP BY DATE_TRUNC('month', po.order_date)
    ORDER BY DATE_TRUNC('month', po.order_date) ASC
  `, params);

  return rows.map((r) => ({
    month: r.month,
    total_spend: round2(num(r.total_spend)),
    // `spend` is what the endpoint returned before this fix. Kept so an older
    // caller reading it does not start seeing undefined.
    spend: round2(num(r.total_spend)),
    po_count: num(r.po_count),
  }));
}

/**
 * A bill's value in INR, as a SQL expression.
 *
 * `bills` has `currency` and `exchange_rate` but — unlike `purchase_orders` —
 * no pre-computed INR column, so the rate is always applied. Same discipline as
 * poSpendInr: summing `total_amount` across a mixed-currency book adds dollars
 * to rupees.
 */
export const billSpendInr = (alias = 'b') =>
  `COALESCE(${alias}.total_amount, 0) * COALESCE(NULLIF(${alias}.exchange_rate, 0), 1)`;

/**
 * The date `bills.po_id` began to exist. A bill raised before this could not
 * have carried a PO link no matter how it was bought, so it is neither
 * PO-backed nor maverick — it is unclassifiable, and is reported as such.
 *
 * This is the ONLY runtime definition. The migration that added the column
 * (20260902000001_bills_po_link.js) notes the same date in a comment but
 * deliberately does not export it: a migration is a frozen record of what ran,
 * and app code must not depend on a file that may later be deleted from disk.
 * If this date is ever wrong, it is wrong here and nowhere else.
 */
export const PO_LINK_AVAILABLE_FROM = '2026-09-02';

/**
 * Invoice spend, non-PO spend, and the maverick ratio.
 *
 * WHAT MAKES THIS HONEST
 * A maverick ratio is `non-PO spend / total spend`, and the naive query —
 * `WHERE po_id IS NULL` — counts every bill raised before the link column
 * existed as maverick. On this database that would report 100% maverick spend
 * from a standing start, which is not a finding, it is an artefact.
 *
 * So bills split three ways, not two:
 *
 *   po_backed     po_id is set — a purchase order was raised and invoiced against
 *   non_po        po_id is NULL on a bill raised AFTER the link existed
 *   unclassified  po_id is NULL on a bill raised BEFORE it — unknowable
 *
 * `maverick_pct` is computed over the classifiable population only, and
 * `classified_pct` says how much of the book that population represents. A
 * maverick ratio over 3% of the ledger is not a control metric, and the caller
 * is told so rather than left to assume otherwise.
 */
export async function loadInvoiceSpend({ companyId, from = null, to = null, limit = DEFAULT_LIMIT } = {}) {
  const params = [];
  const conditions = ['b.deleted_at IS NULL', notIn('b.status', BILL_VOID)];
  if (companyId) { params.push(companyId); conditions.push(`b.company_id = $${params.length}`); }
  if (from)      { params.push(from);      conditions.push(`b.bill_date >= $${params.length}`); }
  if (to)        { params.push(to);        conditions.push(`b.bill_date <= $${params.length}`); }

  params.push(PO_LINK_AVAILABLE_FROM);
  const linkFrom = `$${params.length}`;

  const cte = `
    WITH scoped AS (
      SELECT b.id,
             b.po_id,
             b.party_name,
             b.supplier_id,
             ${billSpendInr('b')} AS spend_inr,
             CASE
               WHEN b.po_id IS NOT NULL THEN 'po_backed'
               WHEN COALESCE(b.bill_date, b.created_at::date) >= ${linkFrom}::date THEN 'non_po'
               ELSE 'unclassified'
             END AS bucket
      FROM bills b
      WHERE ${conditions.join(' AND ')}
    )`;

  const [bucketRes, vendorRes, leakageRes] = await Promise.all([
    pool.query(`${cte}
      SELECT bucket, SUM(spend_inr) AS total_spend, COUNT(*)::INT AS bill_count
      FROM scoped GROUP BY bucket`, params),

    // The actionable list: who we are paying without an order behind it.
    pool.query(`${cte}
      SELECT COALESCE(NULLIF(s.party_name, ''), p.name, 'Unknown') AS vendor_name,
             COALESCE(NULLIF(s.party_name, ''), p.name, 'Unknown') AS label,
             SUM(s.spend_inr) AS total_spend,
             COUNT(*)::INT    AS bill_count
      FROM scoped s
      LEFT JOIN parties p ON p.id = s.supplier_id
      WHERE s.bucket = 'non_po'
      GROUP BY 1
      ORDER BY total_spend DESC NULLS LAST`, params),

    // PO-to-invoice variance: what was ordered vs what the supplier billed.
    pool.query(`${cte}
      SELECT po.po_number,
             COALESCE(v.vendor_name, 'Unknown') AS vendor_name,
             ${poSpendInr('po')}   AS ordered_spend,
             SUM(s.spend_inr)     AS invoiced_spend,
             SUM(s.spend_inr) - ${poSpendInr('po')} AS variance
      FROM scoped s
      JOIN purchase_orders po ON po.id = s.po_id
      LEFT JOIN vendors v ON v.id = po.supplier_id
      GROUP BY po.id, po.po_number, po.total_amount, po.total_amount_inr, po.exchange_rate, v.vendor_name
      HAVING SUM(s.spend_inr) <> ${poSpendInr('po')}
      ORDER BY ABS(SUM(s.spend_inr) - ${poSpendInr('po')}) DESC`, params),
  ]);

  const bucket = (name) => bucketRes.rows.find((r) => r.bucket === name) ?? {};
  const poBacked     = round2(num(bucket('po_backed').total_spend));
  const nonPo        = round2(num(bucket('non_po').total_spend));
  const unclassified = round2(num(bucket('unclassified').total_spend));
  const classifiable = round2(poBacked + nonPo);
  const total        = round2(classifiable + unclassified);

  const vendors = finalise(vendorRes.rows, nonPo, limit);

  return {
    currency: 'INR',
    from: from || null,
    to: to || null,
    po_link_available_from: PO_LINK_AVAILABLE_FROM,

    totals: {
      invoice_spend: total,
      po_backed_spend: poBacked,
      non_po_spend: nonPo,
      unclassified_spend: unclassified,
      bill_count: bucketRes.rows.reduce((n, r) => n + num(r.bill_count), 0),
      po_backed_bills: num(bucket('po_backed').bill_count),
      non_po_bills: num(bucket('non_po').bill_count),
      unclassified_bills: num(bucket('unclassified').bill_count),
    },

    // The control metric, plus everything needed to judge whether to trust it.
    maverick: {
      maverick_pct: classifiable > 0 ? round2((nonPo / classifiable) * 100) : null,
      basis: 'non-PO spend as a share of classifiable invoice spend',
      classified_pct: total > 0 ? round2((classifiable / total) * 100) : 0,
      reliable: total > 0 && classifiable / total >= 0.5,
      note: `Bills dated before ${PO_LINK_AVAILABLE_FROM} could not carry a purchase-order link and are excluded from the ratio rather than counted as maverick. The ratio is meaningful once classified_pct is high.`,
    },

    top_non_po_vendors: vendors.rows,
    po_invoice_variance: leakageRes.rows.map((r) => ({
      po_number: r.po_number,
      vendor_name: r.vendor_name,
      ordered_spend: round2(num(r.ordered_spend)),
      invoiced_spend: round2(num(r.invoiced_spend)),
      variance: round2(num(r.variance)),
    })),

    truncation: {
      limit,
      top_non_po_vendors: { group_count: vendors.group_count, truncated: vendors.truncated },
    },
  };
}

export default {
  loadSpendFacets, loadSpendTrend, loadInvoiceSpend,
  resolveLimit, poSpendInr, billSpendInr,
  DEFAULT_LIMIT, MAX_LIMIT, PO_LINK_AVAILABLE_FROM,
};
