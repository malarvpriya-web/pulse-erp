/**
 * itemSourcing.routes.js  (mounted alongside componentCatalog at /inventory/catalog)
 *
 * COMPONENT SOURCING VIEW — GET /items/:itemId/sourcing
 *
 *   "Click a component → see every vendor that can supply it, with price, MOQ,
 *    lead time and quality rating, so a BOM can be costed against the cheapest
 *    (or the most reliable) source."
 *
 * One vendor row is assembled from four independent price sources, because no
 * single table knows them all:
 *   1. item_vendor_prices   — the negotiated price book (what we agreed to pay)
 *   2. purchase_order_items — what we ACTUALLY paid, per PO, with dates
 *   3. rfq_quotes           — what vendors quoted in RFQs. rfq_quotes.unit_price
 *                             is stored per-RFQ, not per-line, so it is only
 *                             attributable to one item when the RFQ has exactly
 *                             one item line — the query enforces that.
 *   4. price_history        — the manual / imported price log
 *
 * `best_price` COALESCEs them in that order of authority and `price_source`
 * names which one won, so a buyer is never shown a number without its provenance.
 *
 * TOTAL COST OF OWNERSHIP
 * `best_price` answers "what does the vendor charge?", which is not the question
 * a sourcing decision turns on. Each vendor row therefore also carries `tco`:
 * the acquisition + landed + ownership + risk cost of buying `?qty` units from
 * them, computed by engines/tcoEngine.js from this vendor's OBSERVED reject
 * rate, on-time record and freight ratio. `summary.tco` names the lowest-TCO
 * vendor alongside the lowest-price one and quantifies the gap when they differ
 * — which is the whole point of the comparison.
 *
 * Company-scoped via req.scope.company_id (NULL scope = superadmin, sees all).
 */
import express from 'express';
import pool from '../../shared/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { rankOptions } from '../../procurement/engines/tcoEngine.js';
import {
  loadTcoParams, loadVendorPerformance, loadAnnualDemand, masterRate, tcoBasis,
} from '../../procurement/services/tco.service.js';

const router = express.Router();

const scopeOf = (req) => req.scope?.company_id ?? null;

// pg returns NUMERIC as a string; `null` must survive as null so the UI shows
// "—" rather than a misleading ₹0 (see project_pg_count_string_nan_bug).
function num(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

router.get('/items/:itemId/sourcing', requirePermission('inventory', 'view'), async (req, res) => {
  const itemId = Number(req.params.itemId);
  if (!Number.isInteger(itemId)) return res.status(422).json({ error: 'Invalid component id' });

  try {
    const companyId = scopeOf(req);
    // Every scoped query below binds ($1 = itemId, $2 = companyId). When the caller
    // is unscoped the $2 clause is omitted AND the param dropped — never leave an
    // unreferenced $n in the array (see project_pg_unreferenced_param_bind_error).
    const scoped = (col) => (companyId == null ? '' : ` AND (${col} = $2 OR ${col} IS NULL)`);
    const args   = companyId == null ? [itemId] : [itemId, companyId];

    const itemRes = await pool.query(
      `SELECT ii.*, c.name AS category_name,
              pv.vendor_name AS preferred_vendor_name
         FROM inventory_items ii
         LEFT JOIN item_categories c ON c.id = ii.category_id AND c.deleted_at IS NULL
         LEFT JOIN vendors        pv ON pv.id = ii.preferred_vendor_id
        WHERE ii.id = $1 AND ii.deleted_at IS NULL${scoped('ii.company_id')}`,
      args
    );
    if (!itemRes.rows.length) return res.status(404).json({ error: 'Component not found' });
    const item = itemRes.rows[0];

    const netPrice = 'ivp.unit_price * (1 - COALESCE(ivp.discount_pct,0)/100.0)';

    const [book, poAgg, rfq, hist, lines, boms, trend] = await Promise.all([
      // 1 ── negotiated price book
      pool.query(
        `SELECT ivp.id AS price_id, ivp.vendor_id, ivp.warehouse_id,
                ivp.unit_price AS quoted_price, ${netPrice} AS net_price,
                ivp.currency, ivp.moq, ivp.pack_size, ivp.discount_pct, ivp.tax_pct,
                ivp.lead_time_days, ivp.vendor_sku, ivp.last_quoted_date,
                ivp.valid_until, ivp.is_preferred, w.warehouse_name AS store_name,
                -- TCO adders: NULL means "not negotiated", which the engine
                -- reports as an estimate rather than treating as zero.
                ivp.freight_per_unit, ivp.packaging_per_unit, ivp.duty_pct,
                ivp.tooling_cost, ivp.scrap_rate_pct, ivp.warranty_months
           FROM item_vendor_prices ivp
           LEFT JOIN warehouses w ON w.id = ivp.warehouse_id
          WHERE ivp.item_id = $1 AND ivp.deleted_at IS NULL
          ORDER BY net_price ASC NULLS LAST`,
        [itemId]
      ),

      // 2 ── what we actually paid, aggregated per vendor
      pool.query(
        `SELECT po.supplier_id AS vendor_id,
                COUNT(DISTINCT po.id)::int            AS po_count,
                SUM(poi.quantity)::numeric            AS total_qty,
                SUM(poi.quantity * poi.rate)::numeric AS total_value,
                MIN(poi.rate)::numeric                AS min_rate,
                MAX(poi.rate)::numeric                AS max_rate,
                AVG(poi.rate)::numeric                AS avg_rate,
                MAX(po.order_date)                    AS last_ordered,
                (ARRAY_AGG(poi.rate ORDER BY po.order_date DESC NULLS LAST, po.id DESC))[1] AS last_rate
           FROM purchase_order_items poi
           JOIN purchase_orders po ON po.id = poi.po_id AND po.deleted_at IS NULL
          WHERE poi.item_id = $1
            AND LOWER(COALESCE(po.status,'')) NOT IN ('cancelled','rejected')
            ${scoped('po.company_id')}
          GROUP BY po.supplier_id`,
        args
      ),

      // 3 ── RFQ quotes, single-item RFQs only (see header note)
      pool.query(
        `SELECT rq.vendor_id,
                COUNT(*)::int                                                AS rfq_count,
                COUNT(*) FILTER (WHERE rq.is_winner)::int                    AS rfq_wins,
                MIN(rq.unit_price)::numeric                                  AS min_quote,
                (ARRAY_AGG(rq.unit_price    ORDER BY rq.created_at DESC))[1] AS last_quote,
                (ARRAY_AGG(rq.delivery_days ORDER BY rq.created_at DESC))[1] AS quote_delivery_days,
                MAX(rq.created_at)                                           AS last_quoted_at
           FROM rfq_items ri
           JOIN rfqs r        ON r.id = ri.rfq_id
           JOIN rfq_quotes rq ON rq.rfq_id = ri.rfq_id
          WHERE ri.item_id = $1
            AND (SELECT COUNT(*) FROM rfq_items x WHERE x.rfq_id = ri.rfq_id) = 1
            ${scoped('r.company_id')}
          GROUP BY rq.vendor_id`,
        args
      ),

      // 4 ── manual / imported price log
      pool.query(
        `SELECT ph.vendor_id,
                (ARRAY_AGG(ph.unit_price ORDER BY ph.price_date DESC, ph.id DESC))[1] AS last_logged_price,
                MAX(ph.price_date) AS last_logged_date,
                COUNT(*)::int      AS log_count
           FROM price_history ph
          WHERE ph.item_id = $1 AND ph.vendor_id IS NOT NULL
          GROUP BY ph.vendor_id`,
        [itemId]
      ),

      // Line-level purchase history — the "on which date, at what price" table
      pool.query(
        `SELECT poi.id AS line_id, po.id AS po_id, po.po_number, po.order_date,
                po.status, po.currency, po.supplier_id AS vendor_id, v.vendor_name,
                poi.quantity, poi.rate, poi.tax_rate,
                COALESCE(poi.total_amount, poi.quantity * poi.rate) AS amount,
                COALESCE(poi.received_qty, poi.received_quantity)   AS received_qty,
                (SELECT SUM(gi.quantity_received) FROM grn_items gi
                  WHERE gi.po_item_id = poi.id)                     AS grn_received,
                (SELECT MAX(g.received_date) FROM grn_items gi
                   JOIN goods_receipt_notes g ON g.id = gi.grn_id AND g.deleted_at IS NULL
                  WHERE gi.po_item_id = poi.id)                     AS received_date
           FROM purchase_order_items poi
           JOIN purchase_orders po ON po.id = poi.po_id AND po.deleted_at IS NULL
           LEFT JOIN vendors v ON v.id = po.supplier_id
          WHERE poi.item_id = $1${scoped('po.company_id')}
          ORDER BY po.order_date DESC NULLS LAST, po.id DESC
          LIMIT 200`,
        args
      ),

      // Where-used: which BOMs consume this component (the BOM-prep hook)
      pool.query(
        `SELECT bh.id AS bom_id, bh.bom_number, bh.product_code, bh.product_name,
                bh.version, bh.status, bl.qty AS qty_per, bl.unit, bl.unit_cost
           FROM bom_lines bl
           JOIN bom_headers bh ON bh.id = bl.bom_id
          WHERE bl.component_id = $1${scoped('bh.company_id')}
          ORDER BY bh.product_name, bh.version
          LIMIT 100`,
        args
      ),

      // Price trend — every dated price point we know for this component
      pool.query(
        `SELECT price_date, vendor_id, vendor_name, unit_price, quantity, source, reference
           FROM (
             SELECT po.order_date AS price_date, po.supplier_id AS vendor_id,
                    v.vendor_name, poi.rate AS unit_price, poi.quantity,
                    'Purchase Order'::text AS source, po.po_number AS reference
               FROM purchase_order_items poi
               JOIN purchase_orders po ON po.id = poi.po_id AND po.deleted_at IS NULL
               LEFT JOIN vendors v ON v.id = po.supplier_id
              WHERE poi.item_id = $1 AND po.order_date IS NOT NULL
             UNION ALL
             SELECT ph.price_date, ph.vendor_id,
                    COALESCE(v.vendor_name, ph.vendor_name_text), ph.unit_price, ph.quantity,
                    COALESCE(NULLIF(ph.price_type,''), 'Price Log'), ph.reference_number
               FROM price_history ph
               LEFT JOIN vendors v ON v.id = ph.vendor_id
              WHERE ph.item_id = $1 AND ph.price_date IS NOT NULL
             UNION ALL
             SELECT ivp.last_quoted_date, ivp.vendor_id, v.vendor_name,
                    ivp.unit_price, NULL::numeric, 'Price Book', ivp.vendor_sku
               FROM item_vendor_prices ivp
               JOIN vendors v ON v.id = ivp.vendor_id
              WHERE ivp.item_id = $1 AND ivp.deleted_at IS NULL
                AND ivp.last_quoted_date IS NOT NULL
           ) t
          ORDER BY price_date ASC
          LIMIT 300`,
        [itemId]
      ),
    ]);

    // ── Fold the four sources into one row per vendor ──
    const byVendor = new Map();
    const slot = (vendorId) => {
      const k = Number(vendorId);
      if (!Number.isFinite(k)) return null;
      if (!byVendor.has(k)) byVendor.set(k, { vendor_id: k });
      return byVendor.get(k);
    };

    for (const r of book.rows) {
      const s = slot(r.vendor_id); if (!s) continue;
      Object.assign(s, {
        price_id: r.price_id, warehouse_id: r.warehouse_id, store_name: r.store_name,
        quoted_price: num(r.quoted_price), net_price: num(r.net_price),
        currency: r.currency || 'INR', moq: num(r.moq), pack_size: num(r.pack_size),
        discount_pct: num(r.discount_pct), tax_pct: num(r.tax_pct),
        book_lead_time_days: r.lead_time_days, vendor_sku: r.vendor_sku,
        last_quoted_date: r.last_quoted_date, valid_until: r.valid_until,
        is_preferred: !!r.is_preferred,
        freight_per_unit: num(r.freight_per_unit), packaging_per_unit: num(r.packaging_per_unit),
        duty_pct: num(r.duty_pct), tooling_cost: num(r.tooling_cost),
        scrap_rate_pct: num(r.scrap_rate_pct), warranty_months: r.warranty_months,
      });
    }
    for (const r of poAgg.rows) {
      const s = slot(r.vendor_id); if (!s) continue;
      Object.assign(s, {
        po_count: r.po_count, total_qty_purchased: num(r.total_qty), total_value: num(r.total_value),
        min_po_rate: num(r.min_rate), max_po_rate: num(r.max_rate), avg_po_rate: num(r.avg_rate),
        last_po_rate: num(r.last_rate), last_ordered: r.last_ordered,
      });
    }
    for (const r of rfq.rows) {
      const s = slot(r.vendor_id); if (!s) continue;
      Object.assign(s, {
        rfq_count: r.rfq_count, rfq_wins: r.rfq_wins,
        min_rfq_price: num(r.min_quote), last_rfq_price: num(r.last_quote),
        rfq_delivery_days: r.quote_delivery_days, last_quoted_at: r.last_quoted_at,
      });
    }
    for (const r of hist.rows) {
      const s = slot(r.vendor_id); if (!s) continue;
      Object.assign(s, {
        last_logged_price: num(r.last_logged_price),
        last_logged_date: r.last_logged_date, log_count: r.log_count,
      });
    }

    let vendors = [];
    if (byVendor.size) {
      const vRes = await pool.query(
        `SELECT id, vendor_name, vendor_code, category, city, state, status,
                quality_rating, delivery_rating, price_rating, on_time_pct, defect_rate,
                lead_time_days, payment_terms_days, msme_status, is_critical_supplier,
                is_single_source, risk_rating
           FROM vendors WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
        [[...byVendor.keys()]]
      );
      const vMap = Object.fromEntries(vRes.rows.map(v => [v.id, v]));

      vendors = [...byVendor.values()].map(s => {
        const v = vMap[s.vendor_id] || {};
        // Authority order: negotiated book → what we last actually paid → RFQ quote → log.
        const [price_source, best_price] = [
          ['Price Book', s.net_price],
          ['Last PO',    s.last_po_rate],
          ['RFQ Quote',  s.last_rfq_price],
          ['Price Log',  s.last_logged_price],
        ].find(([, p]) => p != null && p > 0) || [null, null];

        return {
          ...s,
          vendor_name: v.vendor_name || `Vendor #${s.vendor_id}`,
          vendor_code: v.vendor_code || null,
          category: v.category || null,
          city: v.city || null,
          state: v.state || null,
          status: v.status || null,
          quality_rating: num(v.quality_rating), delivery_rating: num(v.delivery_rating),
          price_rating: num(v.price_rating), on_time_pct: num(v.on_time_pct),
          defect_rate: num(v.defect_rate), risk_rating: v.risk_rating || null,
          payment_terms_days: v.payment_terms_days,
          msme_status: !!v.msme_status,
          is_critical_supplier: !!v.is_critical_supplier,
          is_single_source: !!v.is_single_source,
          // A component-specific lead time beats the vendor-level default.
          lead_time_days: s.book_lead_time_days ?? s.rfq_delivery_days ?? v.lead_time_days ?? null,
          best_price, price_source,
        };
      }).sort((a, b) => {
        if (a.best_price == null) return 1;
        if (b.best_price == null) return -1;
        return a.best_price - b.best_price;
      });
    }

    const priced = vendors.filter(v => v.best_price != null);
    const prices = priced.map(v => v.best_price);
    const best   = prices.length ? Math.min(...prices) : null;
    const worst  = prices.length ? Math.max(...prices) : null;
    const avg    = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    const std    = num(item.standard_cost);

    // ── Total cost of ownership ──────────────────────────────────────────────
    // Every vendor is costed at the SAME quantity, or the comparison is
    // meaningless: per-order costs and MOQ over-buy only differentiate vendors
    // when the requirement is held constant across them.
    const [tcoParams, perf, demand] = await Promise.all([
      loadTcoParams(companyId),
      loadVendorPerformance(itemId, companyId),
      loadAnnualDemand(itemId, companyId),
    ]);

    // Comparison quantity: the caller's ?qty wins, otherwise a REALISTIC ORDER
    // LOT for this component, in descending order of authority.
    //
    // It must be an order lot, not an arbitrary slice of demand. Ordering,
    // inspection and expediting are charged per ORDER, so comparing at a
    // fraction of a real lot makes those fixed costs dwarf the goods value and
    // reports a nonsense premium — a component with 10 units of annual demand
    // compared at "one month" (0.83 units) came back with a 1,800% TCO premium
    // that told the buyer nothing about the vendors.
    //
    // Whichever basis is used is named in the payload: a TCO computed at an
    // unstated quantity is not auditable, and the ranking genuinely moves with it.
    const qtyParam = num(req.query.qty);
    let compareQty = qtyParam != null && qtyParam > 0 ? qtyParam : null;
    let qtyBasis = compareQty != null ? 'requested' : null;
    const pick = (v, basis) => {
      if (compareQty != null) return;
      const n = num(v, 0);
      if (n > 0) { compareQty = n; qtyBasis = basis; }
    };
    pick(item.min_order_qty, 'item minimum order qty');
    pick(item.lot_size_qty,  'item lot size');
    // What we actually buy in one go, when the master data is silent.
    pick(
      poAgg.rows.length
        ? poAgg.rows.reduce((s, r) => s + num(r.total_qty, 0), 0) /
          Math.max(1, poAgg.rows.reduce((s, r) => s + (r.po_count || 0), 0))
        : null,
      'average past purchase order quantity'
    );
    // A full year of demand, NOT a month: with no order-size data the honest
    // assumption is one annual buy, which counts each fixed cost once.
    pick(demand.annual_demand_qty, `a year of ${demand.demand_source}`);
    pick(item.reorder_point, 'reorder point');
    if (compareQty == null) { compareQty = 1; qtyBasis = 'single unit (no demand or order-size data)'; }
    compareQty = +compareQty.toFixed(3);

    const itemTaxPct = num(item.gst_rate ?? item.default_gst_rate);

    // A company that has switched TCO off gets an empty ranking rather than a
    // computed one it did not ask for. rankOptions([]) returns the same shape
    // with null winners, so nothing downstream has to branch.
    const ranked = !tcoParams.tco_enabled ? rankOptions([], tcoParams) : rankOptions(priced.map((v) => {
      const perfRow = perf.get(v.vendor_id) || {};
      return {
        vendor_id: v.vendor_id,
        vendor_name: v.vendor_name,
        unit_price: v.best_price,
        quantity: compareQty,
        // Price-book adders are quoted; a Last-PO or price-log row has none, so
        // the engine estimates them and labels the line 'assumed'.
        freight_per_unit:   v.freight_per_unit ?? null,
        packaging_per_unit: v.packaging_per_unit ?? null,
        duty_pct:           v.duty_pct ?? null,
        tooling_cost:       v.tooling_cost ?? null,
        tax_pct:            v.tax_pct ?? itemTaxPct,
        moq:                v.moq ?? null,
        pack_size:          v.pack_size ?? null,
        lead_time_days:     v.lead_time_days ?? null,
        // A quoted delivery beats the vendor master's standing lead time.
        lead_time_basis: v.book_lead_time_days != null || v.rfq_delivery_days != null
          ? 'quoted' : (v.lead_time_days != null ? 'estimated' : 'assumed'),
        payment_terms_days: v.payment_terms_days ?? null,
        // Measured at the gate for THIS component beats the vendor master's
        // hand-maintained defect_rate, which spans every part they supply.
        // masterRate() reads a hand-maintained 0 as "never measured". Taking
        // vendors.on_time_pct = 0 literally charges a fabricated 100%-late
        // penalty that is large enough to flip the award.
        reject_rate_pct: perfRow.reject_rate_pct ?? masterRate(v.scrap_rate_pct) ?? masterRate(v.defect_rate),
        reject_basis:    perfRow.reject_rate_pct != null ? 'observed' : 'estimated',
        on_time_pct:     perfRow.on_time_pct ?? masterRate(v.on_time_pct),
        on_time_basis:   perfRow.on_time_pct != null ? 'observed' : 'estimated',
        freight_pct_observed: perfRow.freight_pct_observed ?? null,
        is_single_source: !!v.is_single_source,
        annual_demand_qty: demand.annual_demand_qty,
        holding_cost_pct:  num(item.holding_cost_pct),
      };
    }), tcoParams);

    // Fold the scores back onto the vendor rows the UI already renders, so the
    // table can switch between price-order and TCO-order without a second call.
    const tcoByVendor = new Map(ranked.options.map(o => [o.vendor_id, o]));
    for (const v of vendors) {
      const o = tcoByVendor.get(v.vendor_id);
      if (!o) { v.tco = null; continue; }
      v.tco             = o.tco;
      v.tco_per_unit    = o.tco.tco_per_unit;
      v.tco_total       = o.tco.tco_total;
      v.tco_premium_pct = o.tco.premium_pct;
      v.tco_vs_best_pct = o.tco_vs_best_pct;
      v.is_lowest_tco   = o.is_lowest_tco;
      v.is_lowest_price = o.is_lowest_price;
      v.tco_confidence  = o.tco.confidence;
    }

    res.json({
      item: {
        id: item.id, item_code: item.item_code, item_name: item.item_name,
        item_type: item.item_type, unit_of_measure: item.unit_of_measure,
        description: item.description, manufacturer: item.manufacturer,
        product_model: item.product_model, hsn_code: item.hsn_code,
        gst_rate: num(item.gst_rate ?? item.default_gst_rate),
        category_id: item.category_id, category_name: item.category_name,
        abc_class: item.abc_class, make_or_buy: item.make_or_buy,
        standard_cost: std, current_stock: num(item.current_stock),
        reorder_level: num(item.reorder_level), reorder_point: num(item.reorder_point),
        safety_stock: num(item.safety_stock), min_order_qty: num(item.min_order_qty),
        lead_time_days: item.lead_time_days,
        preferred_vendor_id: item.preferred_vendor_id,
        preferred_vendor_name: item.preferred_vendor_name,
        is_active: item.is_active,
      },
      summary: {
        vendor_count: vendors.length,
        priced_vendor_count: priced.length,
        best_price: best,
        best_vendor: priced[0]?.vendor_name || null,
        best_vendor_id: priced[0]?.vendor_id ?? null,
        highest_price: worst,
        avg_price: avg == null ? null : +avg.toFixed(2),
        // Room between cheapest and dearest — tells a buyer whether re-sourcing pays.
        spread_pct: best && worst && best > 0 ? +(((worst - best) / best) * 100).toFixed(1) : 0,
        savings_vs_standard: std != null && best != null ? +(std - best).toFixed(2) : null,
        total_purchased_qty: +poAgg.rows.reduce((s, r) => s + num(r.total_qty, 0), 0).toFixed(3),
        total_purchased_value: +poAgg.rows.reduce((s, r) => s + num(r.total_value, 0), 0).toFixed(2),
        bom_count: boms.rows.length,
        // The finding the page exists to surface: whether the cheapest quote is
        // actually the cheapest buy, and what the difference is worth.
        best_tco_vendor_id: ranked.best_tco_id,
        best_tco_vendor: ranked.options.find(o => o.is_lowest_tco)?.vendor_name ?? null,
        best_tco_per_unit: ranked.best_tco_per_unit,
        tco_spread_pct: ranked.tco_spread_pct,
        tco_recommendation: ranked.recommendation,
        tco_confidence: ranked.confidence,
      },
      // Shipping the rates and the window alongside the numbers is what makes
      // an award defensible — a comparison whose basis is invisible produces a
      // plausible wrong answer nobody can audit
      // (see project_ceo_intelligence_growth_window_and_tabstrip).
      tco_basis: tcoBasis(tcoParams, {
        quantity: compareQty,
        quantity_basis: qtyBasis,
        annual_demand_qty: demand.annual_demand_qty,
        demand_basis: demand.demand_basis,
        demand_source: demand.demand_source,
        item_holding_cost_pct: num(item.holding_cost_pct),
        tax_pct: itemTaxPct,
        vendors_with_observed_quality: [...perf.values()].filter(p => p.reject_rate_pct != null).length,
        vendors_with_observed_otd: [...perf.values()].filter(p => p.on_time_pct != null).length,
      }),
      vendors,
      purchase_lines: lines.rows.map(r => ({
        ...r,
        quantity: num(r.quantity), rate: num(r.rate), amount: num(r.amount),
        received_qty: num(r.grn_received ?? r.received_qty, 0),
      })),
      used_in_boms: boms.rows.map(r => ({
        ...r, qty_per: num(r.qty_per), unit_cost: num(r.unit_cost),
      })),
      price_trend: trend.rows.map(r => ({
        ...r, unit_price: num(r.unit_price), quantity: num(r.quantity),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
