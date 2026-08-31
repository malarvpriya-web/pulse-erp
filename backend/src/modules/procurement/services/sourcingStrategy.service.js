/**
 * sourcingStrategy.service.js — feeds the sourcing strategy engine with real data.
 *
 * The engine (engines/sourcingStrategyEngine.js) is pure scoring. Everything
 * that makes a category position defensible rather than an opinion is loaded
 * here, from the same tables the buyers work in:
 *
 *   - category spend, supplier count and concentration from PO LINES, because
 *     a PO header carries no item and therefore no category
 *   - bench depth from approved_vendor_list and item_vendor_prices
 *   - live competition from how many vendors actually quoted our RFQs
 *   - captivity from tooling, lead times and sole sources
 *
 * THREE RULES THIS FILE IS BUILT ON, each one a defect this project has already
 * paid for:
 *
 *   1. A MISSING FACT IS NULL, NEVER ZERO. `off_avl_spend_pct` is computed only
 *      over items that actually have an approved vendor list; for an item with
 *      no AVL rows at all, "100% of spend was off-AVL" would be a fabrication —
 *      nothing was ever approved, so nothing can be off it. Same for price
 *      spread (needs two priced vendors) and quotes per RFQ (needs an RFQ).
 *
 *   2. NO QUERY IS WRAPPED IN `.catch(() => [])`. Nineteen SQL statements in
 *      this codebase failed on every single request for months because their
 *      errors were swallowed into an empty array that rendered as a plausible
 *      zero. Every query here is allowed to throw; the route turns it into a
 *      500 that someone can see.
 *
 *   3. SPEND THAT CANNOT BE ATTRIBUTED IS REPORTED, NOT DROPPED. PO value with
 *      no line, or a line whose item carries no category, lands in an explicit
 *      `Uncategorised` bucket with an `unattributed_po_value` figure beside it.
 *      A category board that quietly omits a third of the spend is worse than
 *      no board.
 */
import pool from '../../shared/db.js';
import { PO_VOID } from '../../../shared/statusSets.js';
import { analyseCategory, findMethod } from '../engines/sourcingStrategyEngine.js';

const num = (v, fallback = null) => {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

const pct = (part, whole) => {
  const p = num(part), w = num(whole);
  if (p == null || w == null || w === 0) return null;
  return (p / w) * 100;
};

const round1 = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100);

/** NULL category_id is a real bucket, not a row to drop. */
const UNCATEGORISED = 'uncategorised';
const keyOf = (categoryId) => (categoryId == null ? UNCATEGORISED : String(categoryId));

/**
 * The window every spend figure is denominated in.
 *
 * Shipped in the payload as `basis`, because a growth or concentration number
 * without its window is the §121 defect: a plausible answer to a question
 * nobody asked.
 */
export function resolveWindow({ months = 12, from = null, to = null } = {}) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime());
  if (!from) start.setMonth(start.getMonth() - Number(months || 12));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(start), to: iso(end), months: Number(months || 12) };
}

// ── Loaders ───────────────────────────────────────────────────────────────────

/**
 * PO lines in the window, already resolved to a category.
 *
 * One query, returned at line grain, because six of the facts below are
 * different aggregations of the same rows and re-running the join six times
 * would be both slower and a chance for the six to disagree.
 */
async function loadSpendLines(companyId, win) {
  const { rows } = await pool.query(
    `SELECT po.id                         AS po_id,
            po.supplier_id,
            po.branch_id,
            po.order_date,
            COALESCE(po.currency, 'INR')  AS currency,
            COALESCE(po.customs_duty, 0)  AS customs_duty,
            COALESCE(po.freight_amount, 0) AS freight_amount,
            po.total_amount               AS po_total,
            poi.item_id,
            ii.category_id,
            COALESCE(poi.total_amount, poi.quantity * poi.rate, 0) AS line_value
       FROM purchase_orders po
       JOIN purchase_order_items poi ON poi.po_id = po.id
       LEFT JOIN inventory_items ii  ON ii.id = poi.item_id
      WHERE po.deleted_at IS NULL
        AND po.order_date >= $2::date
        AND po.order_date <= $3::date
        AND LOWER(COALESCE(po.status, '')) <> ALL($4::text[])
        AND ($1::int IS NULL OR po.company_id = $1)`,
    [companyId ?? null, win.from, win.to, PO_VOID]
  );
  return rows;
}

/**
 * PO value in the window that no line accounts for.
 *
 * Not a curiosity: every category spend figure on the board is built from
 * lines, so this is the amount the board cannot see. It belongs on the page.
 */
async function loadUnattributedPoValue(companyId, win) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(po.total_amount), 0) - COALESCE(SUM(l.line_total), 0) AS unattributed,
            COALESCE(SUM(po.total_amount), 0)                                  AS po_total,
            COUNT(*) FILTER (WHERE l.line_total IS NULL)::int                   AS pos_without_lines
       FROM purchase_orders po
       LEFT JOIN LATERAL (
            SELECT SUM(COALESCE(poi.total_amount, poi.quantity * poi.rate, 0)) AS line_total
              FROM purchase_order_items poi WHERE poi.po_id = po.id
       ) l ON TRUE
      WHERE po.deleted_at IS NULL
        AND po.order_date >= $2::date
        AND po.order_date <= $3::date
        AND LOWER(COALESCE(po.status, '')) <> ALL($4::text[])
        AND ($1::int IS NULL OR po.company_id = $1)`,
    [companyId ?? null, win.from, win.to, PO_VOID]
  );
  return rows[0] || { unattributed: 0, po_total: 0, pos_without_lines: 0 };
}

/** Item master profile per category — items that exist, whether or not bought. */
async function loadItemProfile(companyId) {
  const { rows } = await pool.query(
    `SELECT ii.category_id,
            COUNT(*)::int                                                        AS item_count,
            AVG(NULLIF(ii.lead_time_days, 0))                                    AS avg_lead_time_days,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(ii.make_or_buy,'')) = 'make')::int AS make_items,
            COUNT(*) FILTER (WHERE ii.item_type ILIKE '%asset%')::int             AS asset_items
       FROM inventory_items ii
      WHERE ii.deleted_at IS NULL
        AND COALESCE(ii.is_active, TRUE) = TRUE
        AND ($1::int IS NULL OR ii.company_id = $1)
      GROUP BY ii.category_id`,
    [companyId ?? null]
  );
  return rows;
}

/**
 * Per-item source depth: how many vendors are approved, how many are priced,
 * whether the item is tooled, and how far apart the prices sit.
 *
 * `price_spread_pct` is NULL for an item with fewer than two priced vendors —
 * a single price has no spread, and reporting 0% would read as "the market
 * agrees" when what happened is that we only ever asked one supplier.
 */
async function loadItemSourceDepth(companyId) {
  const { rows } = await pool.query(
    `WITH avl AS (
            SELECT a.item_id, COUNT(DISTINCT a.vendor_id)::int AS approved_vendors
              FROM approved_vendor_list a
             WHERE LOWER(COALESCE(a.status,'')) = 'approved'
               AND (a.valid_to IS NULL OR a.valid_to >= CURRENT_DATE)
               AND ($1::int IS NULL OR a.company_id = $1)
             GROUP BY a.item_id
     ),
     avl_any AS (
            SELECT a.item_id, COUNT(*)::int AS avl_rows
              FROM approved_vendor_list a
             WHERE ($1::int IS NULL OR a.company_id = $1)
             GROUP BY a.item_id
     ),
     prices AS (
            SELECT p.item_id,
                   COUNT(DISTINCT p.vendor_id)::int          AS priced_vendors,
                   COUNT(*)::int                             AS price_points,
                   MIN(NULLIF(p.unit_price, 0))              AS min_price,
                   MAX(NULLIF(p.unit_price, 0))              AS max_price,
                   COUNT(*) FILTER (WHERE COALESCE(p.tooling_cost,0) > 0)::int AS tooled_rows,
                   COUNT(*) FILTER (WHERE p.valid_until IS NOT NULL
                                      AND p.valid_until <= CURRENT_DATE + INTERVAL '90 days')::int AS expiring_rows
              FROM item_vendor_prices p
             WHERE p.deleted_at IS NULL
               AND ($1::int IS NULL OR p.company_id = $1)
             GROUP BY p.item_id
     )
     SELECT ii.id AS item_id,
            ii.category_id,
            COALESCE(avl.approved_vendors, 0)   AS approved_vendors,
            COALESCE(avl_any.avl_rows, 0)       AS avl_rows,
            COALESCE(prices.priced_vendors, 0)  AS priced_vendors,
            COALESCE(prices.price_points, 0)    AS price_points,
            COALESCE(prices.tooled_rows, 0)     AS tooled_rows,
            COALESCE(prices.expiring_rows, 0)   AS expiring_rows,
            CASE WHEN COALESCE(prices.priced_vendors,0) >= 2 AND prices.min_price > 0
                 THEN (prices.max_price - prices.min_price) / prices.min_price * 100
                 ELSE NULL END                  AS price_spread_pct
       FROM inventory_items ii
       LEFT JOIN avl      ON avl.item_id      = ii.id
       LEFT JOIN avl_any  ON avl_any.item_id  = ii.id
       LEFT JOIN prices   ON prices.item_id   = ii.id
      WHERE ii.deleted_at IS NULL
        AND COALESCE(ii.is_active, TRUE) = TRUE
        AND ($1::int IS NULL OR ii.company_id = $1)`,
    [companyId ?? null]
  );
  return rows;
}

/**
 * How many vendors actually quoted, per RFQ, for RFQs touching each category.
 *
 * An RFQ with no `rfq_items` row cannot be attributed to a category at all —
 * `rfqs.item_description` is free text. Those RFQs are counted separately so
 * the page can say the competition figure is partial rather than imply the
 * category never went to tender.
 */
async function loadRfqCompetition(companyId) {
  const { rows } = await pool.query(
    `SELECT ii.category_id,
            r.id                                   AS rfq_id,
            COUNT(DISTINCT q.vendor_id)::int       AS quote_count
       FROM rfqs r
       JOIN rfq_items ri            ON ri.rfq_id = r.id
       LEFT JOIN inventory_items ii ON ii.id = ri.item_id
       LEFT JOIN rfq_quotes q       ON q.rfq_id = r.id
      WHERE ($1::int IS NULL OR r.company_id = $1)
      GROUP BY ii.category_id, r.id`,
    [companyId ?? null]
  );
  return rows;
}

/** Spend by (category, vendor) — the input to concentration and to off-AVL. */
function vendorSpendFromLines(lines) {
  const map = new Map(); // catKey -> Map(vendorId -> spend)
  for (const l of lines) {
    const k = keyOf(l.category_id);
    if (!map.has(k)) map.set(k, new Map());
    const inner = map.get(k);
    const v = l.supplier_id ?? 0;
    inner.set(v, (inner.get(v) || 0) + num(l.line_value, 0));
  }
  return map;
}

/** Vendors whose FIRST purchase in the category falls inside the window. */
async function loadNewEntrants(companyId, win) {
  const { rows } = await pool.query(
    `WITH first_seen AS (
            SELECT ii.category_id, po.supplier_id, MIN(po.order_date) AS first_date
              FROM purchase_orders po
              JOIN purchase_order_items poi ON poi.po_id = po.id
              LEFT JOIN inventory_items ii  ON ii.id = poi.item_id
             WHERE po.deleted_at IS NULL
               AND LOWER(COALESCE(po.status,'')) <> ALL($4::text[])
               AND ($1::int IS NULL OR po.company_id = $1)
             GROUP BY ii.category_id, po.supplier_id
     )
     SELECT category_id, COUNT(*)::int AS new_vendors
       FROM first_seen
      WHERE first_date >= $2::date AND first_date <= $3::date
      GROUP BY category_id`,
    [companyId ?? null, win.from, win.to, PO_VOID]
  );
  return rows;
}

/** Vendors newly approved onto an item's AVL inside the window. */
async function loadNewApprovals(companyId, win) {
  const { rows } = await pool.query(
    `SELECT ii.category_id, COUNT(DISTINCT a.vendor_id)::int AS newly_approved
       FROM approved_vendor_list a
       LEFT JOIN inventory_items ii ON ii.id = a.item_id
      WHERE LOWER(COALESCE(a.status,'')) = 'approved'
        AND a.created_at >= $2::date
        AND a.created_at < ($3::date + INTERVAL '1 day')
        AND ($1::int IS NULL OR a.company_id = $1)
      GROUP BY ii.category_id`,
    [companyId ?? null, win.from, win.to]
  );
  return rows;
}

/** Open NCRs, attributed through the PO they were raised against. */
async function loadOpenNcrs(companyId, win) {
  const { rows } = await pool.query(
    `SELECT ii.category_id, COUNT(DISTINCT n.id)::int AS open_ncrs
       FROM vendor_ncr n
       JOIN purchase_order_items poi ON poi.po_id = n.po_id
       LEFT JOIN inventory_items ii  ON ii.id = poi.item_id
      WHERE LOWER(COALESCE(n.status,'')) NOT IN ('closed', 'cancelled')
        AND n.ncr_date >= $2::date
        AND ($1::int IS NULL OR n.company_id = $1)
      GROUP BY ii.category_id`,
    [companyId ?? null, win.from]
  );
  return rows;
}

/** Vendor master attributes for the suppliers actually used in each category. */
async function loadVendorAttributes(companyId, vendorIds) {
  if (!vendorIds.length) return [];
  const { rows } = await pool.query(
    `SELECT id, vendor_name, category, payment_terms_days,
            COALESCE(is_critical_supplier, FALSE) AS is_critical_supplier,
            COALESCE(is_single_source, FALSE)     AS is_single_source
       FROM vendors
      WHERE id = ANY($1::int[])
        AND ($2::int IS NULL OR company_id = $2)`,
    [vendorIds, companyId ?? null]
  );
  return rows;
}

/** Consumption evidence — does the demand-reduction lever have anything to bite on? */
async function loadConsumptionPoints(companyId, win) {
  const { rows } = await pool.query(
    `SELECT ii.category_id, COUNT(*)::int AS consumption_points
       FROM stock_ledger sl
       JOIN inventory_items ii ON ii.id = sl.item_id
      WHERE COALESCE(sl.quantity_out, 0) > 0
        AND sl.transaction_date >= $2::date
        AND ($1::int IS NULL OR sl.company_id = $1)
      GROUP BY ii.category_id`,
    [companyId ?? null, win.from]
  );
  return rows;
}

/** Off-AVL spend, measured ONLY where an AVL exists to be off. */
async function loadOffAvlSpend(companyId, win) {
  const { rows } = await pool.query(
    `WITH lines AS (
            SELECT ii.category_id,
                   poi.item_id,
                   po.supplier_id,
                   COALESCE(poi.total_amount, poi.quantity * poi.rate, 0) AS line_value
              FROM purchase_orders po
              JOIN purchase_order_items poi ON poi.po_id = po.id
              LEFT JOIN inventory_items ii  ON ii.id = poi.item_id
             WHERE po.deleted_at IS NULL
               AND po.order_date >= $2::date
               AND po.order_date <= $3::date
               AND LOWER(COALESCE(po.status,'')) <> ALL($4::text[])
               AND ($1::int IS NULL OR po.company_id = $1)
     ),
     governed AS (
            -- Only items that HAVE an approved vendor list can have spend that
            -- sits outside it. Without this filter every item nobody has got
            -- round to approving would report 100% maverick spend.
            SELECT DISTINCT a.item_id
              FROM approved_vendor_list a
             WHERE LOWER(COALESCE(a.status,'')) = 'approved'
               AND ($1::int IS NULL OR a.company_id = $1)
     )
     SELECT l.category_id,
            SUM(l.line_value)                                     AS governed_spend,
            SUM(l.line_value) FILTER (
              WHERE NOT EXISTS (
                SELECT 1 FROM approved_vendor_list a
                 WHERE a.item_id = l.item_id
                   AND a.vendor_id = l.supplier_id
                   AND LOWER(COALESCE(a.status,'')) = 'approved'
                   AND ($1::int IS NULL OR a.company_id = $1)
              )
            )                                                     AS off_avl_spend
       FROM lines l
       JOIN governed g ON g.item_id = l.item_id
      GROUP BY l.category_id`,
    [companyId ?? null, win.from, win.to, PO_VOID]
  );
  return rows;
}

/** Company TCO switch — one of the method `requires`. */
async function loadTcoEnabled(companyId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(tco_enabled, FALSE) AS tco_enabled
       FROM procurement_settings
      WHERE ($1::int IS NULL OR company_id = $1)
      ORDER BY company_id NULLS LAST
      LIMIT 1`,
    [companyId ?? null]
  );
  return rows[0] ? rows[0].tco_enabled === true : false;
}

/** The category master, so a category with no spend still appears on the board. */
async function loadCategories(companyId) {
  const { rows } = await pool.query(
    `SELECT id, category_code, name, parent_id
       FROM item_categories
      WHERE deleted_at IS NULL
        AND COALESCE(is_active, TRUE) = TRUE
        AND ($1::int IS NULL OR company_id = $1)
      ORDER BY name`,
    [companyId ?? null]
  );
  return rows;
}

/** Saved strategies of record, keyed the same way as the facts. */
async function loadSavedStrategies(companyId) {
  const { rows } = await pool.query(
    `SELECT s.*, u.name AS decided_by_name
       FROM sourcing_category_strategies s
       LEFT JOIN users u ON u.id = s.decided_by_user_id
      WHERE ($1::int IS NULL OR s.company_id = $1)`,
    [companyId ?? null]
  );
  return rows;
}

// ── Assembly ──────────────────────────────────────────────────────────────────

const indexBy = (rows, fn) => {
  const m = new Map();
  for (const r of rows) m.set(fn(r), r);
  return m;
};

const mean = (xs) => {
  const live = xs.filter((x) => x != null && Number.isFinite(x));
  return live.length ? live.reduce((a, b) => a + b, 0) / live.length : null;
};

/**
 * Build the fact sheet for every category, then run the engine over each.
 *
 * Everything is loaded once, at the coarsest grain that answers the question,
 * and folded in JS. Concentration in particular is deliberately computed here
 * rather than in SQL: an HHI is a share-of-share, and getting it wrong inside a
 * window function is both easy and invisible.
 */
export async function getPortfolio(companyId, opts = {}) {
  const win = resolveWindow(opts);

  const [
    categories, lines, unattributed, itemProfile, sourceDepth, rfqRows,
    newEntrants, newApprovals, ncrs, consumption, offAvl, tcoEnabled, saved,
  ] = await Promise.all([
    loadCategories(companyId),
    loadSpendLines(companyId, win),
    loadUnattributedPoValue(companyId, win),
    loadItemProfile(companyId),
    loadItemSourceDepth(companyId),
    loadRfqCompetition(companyId),
    loadNewEntrants(companyId, win),
    loadNewApprovals(companyId, win),
    loadOpenNcrs(companyId, win),
    loadConsumptionPoints(companyId, win),
    loadOffAvlSpend(companyId, win),
    loadTcoEnabled(companyId),
    loadSavedStrategies(companyId),
  ]);

  const vendorSpend = vendorSpendFromLines(lines);
  const allVendorIds = [...new Set(lines.map((l) => l.supplier_id).filter((v) => v != null))];
  const vendorAttrs = indexBy(await loadVendorAttributes(companyId, allVendorIds), (r) => r.id);

  // Which vendors serve more than one category — the bundling signal.
  const vendorCategoryCount = new Map();
  for (const [catKey, inner] of vendorSpend) {
    for (const vid of inner.keys()) {
      if (!vendorCategoryCount.has(vid)) vendorCategoryCount.set(vid, new Set());
      vendorCategoryCount.get(vid).add(catKey);
    }
  }

  const itemProfileBy = indexBy(itemProfile, (r) => keyOf(r.category_id));
  const newEntrantsBy = indexBy(newEntrants, (r) => keyOf(r.category_id));
  const newApprovalsBy = indexBy(newApprovals, (r) => keyOf(r.category_id));
  const ncrBy = indexBy(ncrs, (r) => keyOf(r.category_id));
  const consumptionBy = indexBy(consumption, (r) => keyOf(r.category_id));
  const offAvlBy = indexBy(offAvl, (r) => keyOf(r.category_id));
  const savedBy = indexBy(saved, (r) => keyOf(r.category_id));

  // Per-category rollups of the item-grain and RFQ-grain rows.
  const depthBy = new Map();
  for (const r of sourceDepth) {
    const k = keyOf(r.category_id);
    if (!depthBy.has(k)) depthBy.set(k, []);
    depthBy.get(k).push(r);
  }
  const rfqBy = new Map();
  for (const r of rfqRows) {
    const k = keyOf(r.category_id);
    if (!rfqBy.has(k)) rfqBy.set(k, []);
    rfqBy.get(k).push(r);
  }

  // Spend rollup per category.
  const spendBy = new Map();
  for (const l of lines) {
    const k = keyOf(l.category_id);
    if (!spendBy.has(k)) {
      spendBy.set(k, {
        spend: 0, pos: new Set(), suppliers: new Set(), items: new Set(),
        branches: new Set(), import_spend: 0, freight: 0,
      });
    }
    const acc = spendBy.get(k);
    const val = num(l.line_value, 0);
    acc.spend += val;
    acc.pos.add(l.po_id);
    if (l.supplier_id != null) acc.suppliers.add(l.supplier_id);
    if (l.item_id != null) acc.items.add(l.item_id);
    if (l.branch_id != null) acc.branches.add(l.branch_id);
    if (l.currency !== 'INR' || num(l.customs_duty, 0) > 0) acc.import_spend += val;
    const poTotal = num(l.po_total, 0);
    if (poTotal > 0) acc.freight += num(l.freight_amount, 0) * (val / poTotal);
  }

  const totalSpend = [...spendBy.values()].reduce((a, s) => a + s.spend, 0);

  // Every category master row, plus the uncategorised bucket when it has
  // anything in it. A category with no spend is still a category — it may have
  // items, an AVL and a strategy; it just has no purchase history yet.
  const keys = new Set(categories.map((c) => String(c.id)));
  for (const k of [...spendBy.keys(), ...depthBy.keys(), ...itemProfileBy.keys()]) keys.add(k);

  const nameByKey = new Map(categories.map((c) => [String(c.id), c.name]));
  const codeByKey = new Map(categories.map((c) => [String(c.id), c.category_code]));

  const out = [];
  for (const key of keys) {
    const spendAcc = spendBy.get(key) || null;
    const depth = depthBy.get(key) || [];
    const rfqs = rfqBy.get(key) || [];
    const prof = itemProfileBy.get(key) || null;

    const spend = spendAcc ? spendAcc.spend : null;
    const supplierCount = spendAcc ? spendAcc.suppliers.size : null;

    // Concentration. Only meaningful once there is spend to concentrate.
    let hhi = null, topShare = null;
    if (spendAcc && spendAcc.spend > 0) {
      const inner = vendorSpend.get(key) || new Map();
      const shares = [...inner.values()].map((v) => v / spendAcc.spend);
      hhi = shares.reduce((a, s) => a + s * s, 0);
      topShare = Math.max(...shares) * 100;
    }

    const approvedPerItem = depth.length ? mean(depth.map((d) => num(d.approved_vendors))) : null;
    const pricedPerItem   = depth.length ? mean(depth.map((d) => num(d.priced_vendors)))   : null;
    const spreads = depth.map((d) => num(d.price_spread_pct)).filter((x) => x != null);
    const pricePoints = depth.reduce((a, d) => a + num(d.price_points, 0), 0);
    const tooledItems = depth.filter((d) => num(d.tooled_rows, 0) > 0).length;
    const expiring = depth.reduce((a, d) => a + num(d.expiring_rows, 0), 0);

    // "Single source" means one known source of supply, counting every place we
    // record one: an approved vendor, a quoted price, or a purchase actually
    // made. An item with nothing recorded anywhere is NOT single-sourced — it
    // is unknown, and is excluded from the denominator.
    const purchasedVendorsByItem = new Map();
    for (const l of lines) {
      if (keyOf(l.category_id) !== key || l.item_id == null) continue;
      if (!purchasedVendorsByItem.has(l.item_id)) purchasedVendorsByItem.set(l.item_id, new Set());
      if (l.supplier_id != null) purchasedVendorsByItem.get(l.item_id).add(l.supplier_id);
    }
    let knownItems = 0, soleItems = 0;
    for (const d of depth) {
      const known = Math.max(
        num(d.approved_vendors, 0),
        num(d.priced_vendors, 0),
        (purchasedVendorsByItem.get(d.item_id) || new Set()).size
      );
      if (known === 0) continue;
      knownItems += 1;
      if (known === 1) soleItems += 1;
    }

    const quoteCounts = rfqs.map((r) => num(r.quote_count)).filter((x) => x != null);

    const offAvlRow = offAvlBy.get(key);
    const offAvlPct = offAvlRow
      ? pct(num(offAvlRow.off_avl_spend, 0), num(offAvlRow.governed_spend))
      : null;

    // `branches` only ever collects non-null branch_ids, so an empty set means
    // no PO here recorded a site at all.
    const branchesRecorded = !!spendAcc && spendAcc.branches.size > 0;
    const vendorsHere = spendAcc ? [...spendAcc.suppliers] : [];
    const sharedSuppliers = vendorsHere.filter((v) => (vendorCategoryCount.get(v) || new Set()).size > 1).length;
    const terms = new Set(
      vendorsHere.map((v) => vendorAttrs.get(v) && vendorAttrs.get(v).payment_terms_days).filter((t) => t != null)
    );
    const hasCritical = vendorsHere.some((v) => vendorAttrs.get(v) && vendorAttrs.get(v).is_critical_supplier === true);

    const newVendorCount = Math.max(
      num((newEntrantsBy.get(key) || {}).new_vendors, 0),
      num((newApprovalsBy.get(key) || {}).newly_approved, 0)
    );
    // Zero new vendors is only a measurement where there was purchasing to
    // observe. In a category we have never bought from, "no new entrants" is an
    // absence of evidence, not evidence of a closed market.
    const observedEntry = spendAcc != null || depth.length > 0;

    const facts = {
      spend_12m:                    spend,
      po_count:                     spendAcc ? spendAcc.pos.size : null,
      avg_po_value:                 spendAcc && spendAcc.pos.size ? spendAcc.spend / spendAcc.pos.size : null,
      supplier_count:               supplierCount,
      hhi:                          hhi == null ? null : round2(hhi),
      top_supplier_share_pct:       topShare == null ? null : round1(topShare),
      item_count:                   prof ? num(prof.item_count) : (depth.length || null),
      // A count of zero is only reportable where the thing that produces it was
      // observed at all. `branch_count` is null rather than 0 when the POs
      // carry no branch — nobody recorded a site, which is not the same as
      // "bought at no sites". This distinction is `a || b` on a numeric zero
      // turned the right way round, and getting it backwards is the defect
      // class this codebase has paid for most often.
      branch_count:                 branchesRecorded ? spendAcc.branches.size : null,
      share_of_total_spend_pct:     spend == null ? null : round1(pct(spend, totalSpend)),
      import_spend_pct:             spendAcc && spendAcc.spend > 0 ? round1(pct(spendAcc.import_spend, spendAcc.spend)) : null,
      freight_spend_pct:            spendAcc && spendAcc.spend > 0 ? round1(pct(spendAcc.freight, spendAcc.spend)) : null,

      avg_lead_time_days:           prof ? round1(num(prof.avg_lead_time_days)) : null,
      make_option_item_pct:         prof && num(prof.item_count, 0) > 0 ? round1(pct(prof.make_items, prof.item_count)) : null,
      is_asset_category:            prof ? num(prof.asset_items, 0) > 0 : null,

      avg_approved_vendors_per_item: approvedPerItem == null ? null : round1(approvedPerItem),
      avg_priced_vendors_per_item:   pricedPerItem == null ? null : round1(pricedPerItem),
      single_source_item_pct:        knownItems > 0 ? round1((soleItems / knownItems) * 100) : null,
      tooled_item_pct:               depth.length ? round1((tooledItems / depth.length) * 100) : null,
      price_spread_pct:              spreads.length ? round1(mean(spreads)) : null,
      // Zero price points across items we DO hold is a measurement ("nobody has
      // priced these"); zero across a category with no items is an absence.
      price_points:                  depth.length ? pricePoints : null,
      expiring_price_count:          depth.length ? expiring : null,

      avg_quotes_per_rfq:            quoteCounts.length ? round1(mean(quoteCounts)) : null,
      rfq_count:                     quoteCounts.length,

      new_qualified_vendors_12m:     observedEntry ? newVendorCount : null,
      open_ncr_count:                num((ncrBy.get(key) || {}).open_ncrs, spendAcc ? 0 : null),
      consumption_points:            num((consumptionBy.get(key) || {}).consumption_points, depth.length ? 0 : null),
      off_avl_spend_pct:             offAvlPct == null ? null : round1(offAvlPct),
      distinct_payment_terms:        vendorsHere.length ? terms.size : null,
      shared_supplier_count:         vendorsHere.length ? sharedSuppliers : null,
      has_critical_supplier:         vendorsHere.length ? hasCritical : null,
      uncategorised_spend_pct:       key === UNCATEGORISED ? 100 : 0,
      tco_enabled:                   tcoEnabled,
    };

    const analysis = analyseCategory(facts);
    const savedRow = savedBy.get(key) || null;

    out.push({
      category_key: key,
      category_id: key === UNCATEGORISED ? null : Number(key),
      category_code: codeByKey.get(key) || null,
      category_name: key === UNCATEGORISED ? 'Uncategorised' : (nameByKey.get(key) || `Category ${key}`),
      is_uncategorised: key === UNCATEGORISED,
      facts,
      forces: analysis.forces,
      coverage_pct: analysis.coverage_pct,
      position: analysis.position,
      top_plays: analysis.top_plays,
      strategy: savedRow
        ? {
            id: savedRow.id,
            quadrant_key: savedRow.quadrant_key,
            lever_key: savedRow.lever_key,
            method_key: savedRow.method_key,
            method_label: savedRow.method_label,
            rationale: savedRow.rationale,
            target_saving_pct: num(savedRow.target_saving_pct),
            review_date: savedRow.review_date,
            status: savedRow.status,
            decided_by_name: savedRow.decided_by_name,
            updated_at: savedRow.updated_at,
            drifted: savedRow.quadrant_key != null
              && analysis.position.quadrant_key != null
              && savedRow.quadrant_key !== analysis.position.quadrant_key,
          }
        : null,
    });
  }

  out.sort((a, b) => (num(b.facts.spend_12m, -1)) - (num(a.facts.spend_12m, -1)));

  const unattributedValue = num(unattributed.unattributed, 0);
  return {
    basis: {
      window: win,
      spend_source: 'purchase_order_items joined to inventory_items.category_id',
      excluded_po_statuses: PO_VOID,
      total_attributed_spend: round2(totalSpend),
      unattributed_po_value: round2(unattributedValue),
      unattributed_pct: round1(pct(unattributedValue, num(unattributed.po_total))),
      pos_without_lines: num(unattributed.pos_without_lines, 0),
      tco_enabled: tcoEnabled,
    },
    categories: out,
  };
}

/** One category, with the full 16-method board rather than just the top plays. */
export async function getCategory(companyId, categoryKey, opts = {}) {
  const portfolio = await getPortfolio(companyId, opts);
  const row = portfolio.categories.find((c) => c.category_key === String(categoryKey));
  if (!row) return null;

  const analysis = analyseCategory(row.facts);
  const suppliers = await loadCategorySuppliers(companyId, row.category_id, resolveWindow(opts));

  return {
    basis: portfolio.basis,
    ...row,
    recommendations: analysis.recommendations,
    suppliers,
  };
}

/**
 * The supplier segment view for one category: who we buy from, what share they
 * hold, and where the vendor health engine (§49G) puts them.
 *
 * "Choose the approach for each category AND supplier segment" needs both — the
 * category picks the play, the segment picks who it is played with.
 */
async function loadCategorySuppliers(companyId, categoryId, win) {
  const { rows } = await pool.query(
    `WITH lines AS (
            SELECT po.supplier_id,
                   COALESCE(poi.total_amount, poi.quantity * poi.rate, 0) AS line_value,
                   po.id AS po_id
              FROM purchase_orders po
              JOIN purchase_order_items poi ON poi.po_id = po.id
              LEFT JOIN inventory_items ii  ON ii.id = poi.item_id
             WHERE po.deleted_at IS NULL
               AND po.order_date >= $2::date
               AND po.order_date <= $3::date
               AND LOWER(COALESCE(po.status,'')) <> ALL($5::text[])
               AND ($1::int IS NULL OR po.company_id = $1)
               AND (($4::int IS NULL AND ii.category_id IS NULL) OR ii.category_id = $4)
     )
     SELECT v.id                       AS vendor_id,
            v.vendor_name,
            v.category                 AS vendor_category,
            COALESCE(v.is_critical_supplier, FALSE) AS is_critical_supplier,
            COALESCE(v.is_single_source, FALSE)     AS is_single_source,
            v.payment_terms_days,
            v.lead_time_days,
            SUM(l.line_value)          AS spend,
            COUNT(DISTINCT l.po_id)::int AS po_count,
            h.health_score,
            h.health_status
       FROM lines l
       JOIN vendors v ON v.id = l.supplier_id
       LEFT JOIN vendor_health_scores h ON h.vendor_id = v.id
      GROUP BY v.id, v.vendor_name, v.category, v.is_critical_supplier,
               v.is_single_source, v.payment_terms_days, v.lead_time_days,
               h.health_score, h.health_status
      ORDER BY SUM(l.line_value) DESC`,
    [companyId ?? null, win.from, win.to, categoryId ?? null, PO_VOID]
  );

  const total = rows.reduce((a, r) => a + num(r.spend, 0), 0);
  return rows.map((r) => ({
    ...r,
    spend: round2(num(r.spend, 0)),
    share_pct: total > 0 ? round1((num(r.spend, 0) / total) * 100) : null,
    // §49G's composite. NUMERIC arrives from pg as a string, and a vendor the
    // health engine has never scored has no row at all — null, not 0, or the
    // supplier segment would read "worst supplier we have" for "never measured".
    health_score: num(r.health_score),
    health_status: r.health_status || 'Unrated',
  }));
}

// ── Writing the decision ──────────────────────────────────────────────────────

/**
 * Record the sourcing approach chosen for a category.
 *
 * THE CLIENT DOES NOT GET TO NAME THE QUADRANT. It sends a `method_key` and
 * nothing else about the taxonomy; the lever and quadrant are looked up from
 * the engine. A payload claiming that "reverse auction" sits under "Risk
 * Management" would otherwise be stored verbatim and every board grouping built
 * on it afterwards would be quietly wrong.
 *
 * The live facts and position are frozen onto the row at the moment of saving,
 * for the reason §128 froze a TCO award: spend moves, and a decision that
 * cannot be re-read against the numbers it was made on cannot be defended.
 */
export async function saveStrategy(companyId, categoryKey, payload = {}, decidedByUserId = null) {
  const method = findMethod(payload.method_key);
  if (!method) {
    const err = new Error(`Unknown sourcing method '${payload.method_key}'`);
    err.status = 400;
    throw err;
  }

  const key = String(categoryKey);
  const categoryId = key === UNCATEGORISED ? null : Number(key);
  if (categoryId != null && !Number.isInteger(categoryId)) {
    const err = new Error(`Invalid category '${categoryKey}'`);
    err.status = 400;
    throw err;
  }

  // Freeze what the decision was made against.
  const portfolio = await getPortfolio(companyId, payload);
  const snapshot = portfolio.categories.find((c) => c.category_key === key);
  if (!snapshot) {
    const err = new Error(`Category '${categoryKey}' is not on the sourcing board`);
    err.status = 404;
    throw err;
  }

  // A method from a quadrant the category is not in is allowed — a category
  // manager may deliberately play against the position, exactly as an award may
  // deliberately go against the TCO recommendation — but the divergence is
  // recorded rather than smoothed over.
  const status = ['draft', 'active', 'retired'].includes(String(payload.status || '').toLowerCase())
    ? String(payload.status).toLowerCase()
    : 'draft';

  const { rows } = await pool.query(
    `INSERT INTO sourcing_category_strategies
       (company_id, category_id, quadrant_key, lever_key, method_key, method_label,
        supplier_segment, rationale, target_saving_pct, review_date, status,
        facts_snapshot, position_snapshot, forces_snapshot, decided_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
     ON CONFLICT (COALESCE(company_id, -1), COALESCE(category_id, -1))
     DO UPDATE SET quadrant_key       = EXCLUDED.quadrant_key,
                   lever_key          = EXCLUDED.lever_key,
                   method_key         = EXCLUDED.method_key,
                   method_label       = EXCLUDED.method_label,
                   supplier_segment   = EXCLUDED.supplier_segment,
                   rationale          = EXCLUDED.rationale,
                   target_saving_pct  = EXCLUDED.target_saving_pct,
                   review_date        = EXCLUDED.review_date,
                   status             = EXCLUDED.status,
                   facts_snapshot     = EXCLUDED.facts_snapshot,
                   position_snapshot  = EXCLUDED.position_snapshot,
                   forces_snapshot    = EXCLUDED.forces_snapshot,
                   decided_by_user_id = EXCLUDED.decided_by_user_id,
                   updated_at         = NOW()
     RETURNING *`,
    [
      companyId ?? null,
      categoryId,
      method.quadrant_key,
      method.lever_key,
      method.key,
      method.label,
      payload.supplier_segment || null,
      payload.rationale || null,
      payload.target_saving_pct == null || payload.target_saving_pct === '' ? null : num(payload.target_saving_pct),
      payload.review_date || null,
      status,
      JSON.stringify(snapshot.facts),
      JSON.stringify(snapshot.position),
      JSON.stringify(snapshot.forces),
      decidedByUserId ?? null,
    ]
  );

  const saved = rows[0];
  return {
    ...saved,
    against_position: snapshot.position.quadrant_key != null
      && snapshot.position.quadrant_key !== method.quadrant_key,
    position_at_decision: snapshot.position,
  };
}

export default {
  getPortfolio,
  getCategory,
  saveStrategy,
  resolveWindow,
};
