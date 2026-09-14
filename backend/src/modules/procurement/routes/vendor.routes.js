/**
 * vendor.routes.js — the vendor COMPARISON reads.
 *
 * WHAT THIS FILE USED TO BE, AND WHY IT WAS DANGEROUS
 * ---------------------------------------------------
 * It was a complete, unhardened SHADOW of the procurement core. Mounted at
 * `v1Router.use("/", vendorRoutes)` behind `verifyToken` and NOTHING ELSE, it
 * offered a second implementation of the same controls the procurement module
 * spent two remediation passes hardening — with none of the hardening:
 *
 *   PATCH /api/three-way-match/:id/resolve
 *       Clears a flagged invoice discrepancy — the control that releases an
 *       invoice for payment. No permission check, no company predicate, and it
 *       set `discrepancy_reason = NULL`, destroying the record of what the
 *       discrepancy had been. ANY authenticated account — employee, hr,
 *       sales_exec — could clear ANY tenant's flagged invoice.
 *   PUT /api/rfqs/:id/quotes/:quoteId/winner
 *       Awards a sourcing event. No permission check, no company predicate, and
 *       `quoteId` was never checked to belong to the RFQ being closed.
 *   PUT /api/vendors/:id
 *       Rewrites the vendor master INCLUDING bank_name / account_number / ifsc,
 *       with NO company predicate at all. Changing a supplier's bank details is
 *       the destination of an invoice-fraud attempt, and this was the widest
 *       open door in the module.
 *   POST /api/vendors
 *       A second vendor-create path: no tax-id validation, no finance-party
 *       binding (so the vendor is unpayable — see vendorIdentity.service.js),
 *       and it accepted quality_rating / delivery_rating / price_rating straight
 *       from the body, which the hardened path deliberately whitelists OUT
 *       because they are computed scorecard columns.
 *   POST /api/rfqs, PUT /api/rfqs/:id, POST /api/rfqs/:id/quotes,
 *   GET /api/rfqs, GET /api/three-way-match
 *       Duplicates of endpoints that exist, gated and scoped, under
 *       /api/procurement.
 *
 * NO CLIENT CALLED ANY OF THEM. A repo-wide search for callers of the write
 * paths found none — the frontend uses the `/procurement`-prefixed routes for
 * every one of these actions. They were dead code that was nevertheless live
 * and reachable over HTTP, shadowing the hardened equivalents.
 *
 * They are therefore REMOVED rather than re-gated. Re-gating would leave two
 * implementations of "award an RFQ" and "clear an invoice for payment" to keep
 * in step, which is the drift that produced this file in the first place. The
 * removed paths answer 410 naming the canonical route, so a caller nobody knew
 * about gets told where to go instead of a silent 404.
 *
 * WHAT REMAINS are the four comparison READS that the Vendor Comparison and
 * Vendor Management screens actually call. Each was also unscoped —
 * `WHERE id IN (...)` over vendors, `WHERE po.supplier_id IN (...)` over orders
 * — so any authenticated caller could read another tenant's supplier list,
 * spend history and negotiated unit prices by walking ids. They are now gated
 * on the procurement view grant, and the id list is narrowed to the caller's
 * own company before it reaches any query.
 */
import express from 'express';
import pool from '../../../config/db.js';
import { companyOf } from '../../../shared/scope.js';
import { requireProcurement } from '../procurement.authz.js';

const router = express.Router();
const cid = req => companyOf(req);

/**
 * The subset of `?ids=` the caller is actually allowed to see.
 *
 * Every read below interpolates the id list into an `IN (...)` clause across
 * vendors, purchase orders, PO lines, RFQ quotes and price history. Narrowing
 * ONCE, here, is what makes all of them tenant-safe: an id belonging to another
 * company is dropped before it reaches any of those queries, so there is no
 * per-query predicate left to forget. Returns [] when nothing survives, which
 * the callers render as an empty comparison rather than as a leak.
 */
async function ownedVendorIds(req, raw) {
  const ids = String(raw || '').split(',').map(Number).filter(Boolean);
  if (!ids.length) return [];
  const companyId = cid(req);
  const { rows } = await pool.query(
    `SELECT id FROM vendors
      WHERE id = ANY($1::int[]) AND deleted_at IS NULL
        AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
    [ids, companyId]
  );
  return rows.map(r => r.id);
}

// ─── GET /vendors ─────────────────────────────────────────────────────────────
// The picker list. Read-only, company-scoped, and the only one of the original
// /vendors verbs that survives — creating and editing a vendor go through
// /api/procurement/vendors, which validates tax ids and binds the finance party.
router.get('/vendors', requireProcurement('view'), async (req, res) => {
  try {
    const { category, status, search } = req.query;
    const companyId = cid(req);
    const conditions = ['deleted_at IS NULL'];
    const params = [];
    let idx = 1;

    if (companyId) { conditions.push(`(company_id = $${idx++} OR company_id IS NULL)`); params.push(companyId); }
    if (category)  { conditions.push(`category = $${idx++}`); params.push(category); }
    if (status)    { conditions.push(`status = $${idx++}`); params.push(status); }
    if (search) {
      conditions.push(`(vendor_name ILIKE $${idx} OR city ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const result = await pool.query(
      `SELECT * FROM vendors WHERE ${conditions.join(' AND ')} ORDER BY vendor_name ASC`,
      params
    );
    res.json({ vendors: result.rows });
  } catch (err) {
    console.error('[GET /vendors]', err.message);
    res.status(500).json({ error: 'Failed to fetch vendors', detail: err.message });
  }
});

/**
 * The removed writes, and where each one now lives.
 *
 * 410 rather than a silent 404: if some caller nobody knew about is still
 * reaching for one of these, it is told exactly which endpoint to use instead
 * of failing in a way that looks like a routing bug.
 */
const MOVED = [
  ['post',  '/vendors',                         'POST /api/procurement/vendors'],
  ['put',   '/vendors/:id',                     'PUT /api/procurement/vendors/:id'],
  ['get',   '/rfqs',                            'GET /api/procurement/rfqs'],
  ['post',  '/rfqs',                            'POST /api/procurement/rfqs'],
  ['put',   '/rfqs/:id',                        'PATCH /api/procurement/rfqs/:id/send-to-vendors'],
  ['post',  '/rfqs/:id/quotes',                 'POST /api/procurement/rfqs/:rfqId/responses/:vendorId'],
  ['put',   '/rfqs/:id/quotes/:quoteId/winner', 'PATCH /api/procurement/rfqs/:rfqId/award/:vendorId'],
  ['get',   '/three-way-match',                 'GET /api/procurement/three-way-match'],
  ['patch', '/three-way-match/:id/resolve',     'PATCH /api/procurement/three-way-match/:id/resolve'],
];
for (const [verb, path, canonical] of MOVED) {
  router[verb](path, (_req, res) => res.status(410).json({
    error: 'This endpoint has been removed.',
    code: 'ENDPOINT_REMOVED',
    use: canonical,
    reason: 'It was an ungated, unscoped duplicate of the endpoint named above, which enforces permissions, tenant scope and the business rules of the module.',
  }));
}

router.get('/vendors/compare', requireProcurement('view'), async (req, res) => {
  try {
    // Narrowed to the caller's own company before any query sees it — this read
    // returns a supplier's spend history and negotiated unit prices.
    const ids = await ownedVendorIds(req, req.query.ids);
    if (ids.length < 1) return res.status(400).json({ error: 'Provide at least one vendor id in ?ids= that belongs to your company' });

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');

    // Base vendor profiles
    const { rows: vendors } = await pool.query(
      `SELECT * FROM vendors WHERE id IN (${placeholders}) ORDER BY vendor_name`,
      ids
    );

    // PO stats per vendor
    const { rows: poStats } = await pool.query(`
      SELECT
        po.supplier_id                              AS vendor_id,
        COUNT(DISTINCT po.id)::INT                  AS total_pos,
        ROUND(SUM(po.total_amount)::NUMERIC,2)      AS total_spend,
        ROUND(AVG(po.total_amount)::NUMERIC,2)      AS avg_po_value,
        MAX(po.order_date)                          AS last_po_date,
        COUNT(CASE WHEN po.status='received' THEN 1 END)::INT AS completed_pos
      FROM purchase_orders po
      WHERE po.supplier_id IN (${placeholders})
      GROUP BY po.supplier_id
    `, ids).catch(() => ({ rows: [] }));

    // Avg unit price per vendor from PO items
    const { rows: priceStats } = await pool.query(`
      SELECT
        po.supplier_id                              AS vendor_id,
        ROUND(AVG(poi.rate)::NUMERIC,2)             AS avg_unit_price,
        ROUND(MIN(poi.rate)::NUMERIC,2)             AS min_unit_price,
        ROUND(MAX(poi.rate)::NUMERIC,2)             AS max_unit_price,
        COUNT(poi.id)::INT                          AS line_items
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.po_id
      WHERE po.supplier_id IN (${placeholders}) AND poi.rate > 0
      GROUP BY po.supplier_id
    `, ids).catch(() => ({ rows: [] }));

    // RFQ quote stats per vendor
    const { rows: rfqStats } = await pool.query(`
      SELECT
        q.vendor_id,
        COUNT(*)::INT                               AS total_quotes,
        COUNT(CASE WHEN q.is_winner THEN 1 END)::INT AS won_quotes,
        ROUND(AVG(q.unit_price)::NUMERIC,2)         AS avg_quote_price,
        ROUND(MIN(q.unit_price)::NUMERIC,2)         AS min_quote_price,
        ROUND(AVG(q.delivery_days)::NUMERIC,1)      AS avg_delivery_days
      FROM rfq_quotes q
      WHERE q.vendor_id IN (${placeholders})
      GROUP BY q.vendor_id
    `, ids).catch(() => ({ rows: [] }));

    // Price history stats per vendor
    const { rows: phStats } = await pool.query(`
      SELECT
        vendor_id,
        COUNT(*)::INT                               AS ph_entries,
        ROUND(AVG(unit_price)::NUMERIC,2)           AS ph_avg_price,
        MAX(price_date)                             AS ph_last_date
      FROM price_history
      WHERE vendor_id IN (${placeholders})
      GROUP BY vendor_id
    `, ids).catch(() => ({ rows: [] }));

    // Merge all into vendor objects
    const poMap  = Object.fromEntries(poStats.map(r  => [r.vendor_id,  r]));
    const prMap  = Object.fromEntries(priceStats.map(r => [r.vendor_id, r]));
    const rfqMap = Object.fromEntries(rfqStats.map(r  => [r.vendor_id,  r]));
    const phMap  = Object.fromEntries(phStats.map(r   => [r.vendor_id,  r]));

    const enriched = vendors.map(v => {
      const po  = poMap[v.id]  || {};
      const pr  = prMap[v.id]  || {};
      const rfq = rfqMap[v.id] || {};
      const ph  = phMap[v.id]  || {};

      // Compute composite score (0-100)
      const qRating  = parseFloat(v.quality_rating  || 0);
      const dRating  = parseFloat(v.delivery_rating || 0);
      const pRating  = parseFloat(v.price_rating    || 0);
      const onTime   = parseFloat(v.on_time_pct     || 0);
      const defect   = parseFloat(v.defect_rate     || 0);
      const winRate  = rfq.total_quotes > 0 ? (rfq.won_quotes / rfq.total_quotes) * 100 : 0;

      const score = Math.round(
        (qRating / 5) * 25 +
        (dRating / 5) * 25 +
        (pRating / 5) * 20 +
        (onTime / 100) * 20 +
        Math.max(0, (1 - defect / 10)) * 10
      );

      return {
        ...v,
        // PO stats
        total_pos:     po.total_pos     || 0,
        total_spend:   po.total_spend   || 0,
        avg_po_value:  po.avg_po_value  || 0,
        last_po_date:  po.last_po_date  || null,
        completed_pos: po.completed_pos || 0,
        // Price stats
        avg_unit_price: pr.avg_unit_price || ph.ph_avg_price || null,
        min_unit_price: pr.min_unit_price || null,
        max_unit_price: pr.max_unit_price || null,
        line_items:     pr.line_items    || 0,
        // RFQ stats
        total_quotes:    rfq.total_quotes    || 0,
        won_quotes:      rfq.won_quotes      || 0,
        win_rate:        parseFloat(winRate.toFixed(1)),
        avg_quote_price: rfq.avg_quote_price || null,
        avg_delivery_days: rfq.avg_delivery_days || null,
        // Score
        composite_score: score,
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('[GET /vendors/compare]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /vendors/compare/items?ids=1,2&item_id= ─────────────────────────────
// Returns per-item price breakdown for each selected vendor
router.get('/vendors/compare/items', requireProcurement('view'), async (req, res) => {
  try {
    const ids = await ownedVendorIds(req, req.query.ids);
    if (ids.length < 1) return res.status(400).json({ error: 'Provide vendor ids that belong to your company' });

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');

    // All items ever purchased from these vendors with per-vendor stats
    const { rows } = await pool.query(`
      SELECT
        combined.vendor_id,
        COALESCE(v.vendor_name, combined.vendor_name_text, 'Unknown') AS vendor_name,
        combined.item_id,
        COALESCE(ii.item_name, combined.item_name_text, 'Item #' || combined.item_id) AS item_name,
        COALESCE(ii.item_code, '')                                     AS item_code,
        COALESCE(ii.unit_of_measure, '')                               AS uom,
        COUNT(*)::INT                                                  AS quote_count,
        ROUND(MIN(combined.unit_price)::NUMERIC,2)                    AS min_price,
        ROUND(MAX(combined.unit_price)::NUMERIC,2)                    AS max_price,
        ROUND(AVG(combined.unit_price)::NUMERIC,2)                    AS avg_price,
        MAX(combined.price_date)                                       AS last_date,
        ROUND((
          SELECT unit_price FROM (
            SELECT unit_price FROM (
              SELECT poi2.rate AS unit_price, po2.order_date AS price_date
              FROM purchase_order_items poi2
              JOIN purchase_orders po2 ON po2.id = poi2.po_id
              WHERE poi2.item_id = combined.item_id AND po2.supplier_id = combined.vendor_id AND poi2.rate > 0
              UNION ALL
              SELECT unit_price, price_date FROM price_history
              WHERE item_id = combined.item_id AND vendor_id = combined.vendor_id
            ) sub ORDER BY price_date DESC LIMIT 1
          ) lp
        )::NUMERIC, 2) AS last_price
      FROM (
        SELECT po.supplier_id AS vendor_id, NULL::VARCHAR AS vendor_name_text,
               poi.item_id, NULL::VARCHAR AS item_name_text,
               poi.rate AS unit_price, po.order_date AS price_date
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.po_id
        WHERE po.supplier_id IN (${placeholders}) AND poi.item_id IS NOT NULL AND poi.rate > 0

        UNION ALL

        SELECT vendor_id, vendor_name_text, item_id, item_name_text, unit_price, price_date
        FROM price_history
        WHERE vendor_id IN (${placeholders}) AND item_id IS NOT NULL
      ) combined
      LEFT JOIN vendors v ON v.id = combined.vendor_id
      LEFT JOIN inventory_items ii ON ii.id = combined.item_id
      GROUP BY combined.vendor_id, v.vendor_name, combined.vendor_name_text,
               combined.item_id, ii.item_name, combined.item_name_text, ii.item_code, ii.unit_of_measure
      ORDER BY item_name, avg_price ASC
    `, [...ids, ...ids]).catch(() => ({ rows: [] }));

    res.json(rows);
  } catch (err) {
    console.error('[GET /vendors/compare/items]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /vendors/price-history?ids=1,2,3 ────────────────────────────────────
// Monthly average price per vendor, merged from RFQ quotes + PO items + price_history
router.get('/vendors/price-history', requireProcurement('view'), async (req, res) => {
  try {
    const ids = await ownedVendorIds(req, req.query.ids);
    if (!ids.length) return res.status(400).json({ error: 'Provide vendor ids in ?ids= that belong to your company' });

    const ph = ids.map((_, i) => `$${i + 1}`).join(',');

    const [{ rows: quoteRows }, { rows: poRows }, { rows: phRows }] = await Promise.all([
      // RFQ quotes over time
      pool.query(`
        SELECT q.vendor_id, v.vendor_name,
               TO_CHAR(DATE_TRUNC('month', q.created_at), 'YYYY-MM') AS month,
               ROUND(AVG(q.unit_price)::NUMERIC, 2) AS avg_price
        FROM rfq_quotes q
        JOIN vendors v ON v.id = q.vendor_id
        WHERE q.vendor_id IN (${ph}) AND q.unit_price > 0
        GROUP BY q.vendor_id, v.vendor_name, DATE_TRUNC('month', q.created_at)
      `, ids).catch(() => ({ rows: [] })),

      // PO item lines over time
      pool.query(`
        SELECT po.supplier_id AS vendor_id, v.vendor_name,
               TO_CHAR(DATE_TRUNC('month', po.order_date), 'YYYY-MM') AS month,
               ROUND(AVG(poi.rate)::NUMERIC, 2) AS avg_price
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.po_id
        JOIN vendors v ON v.id = po.supplier_id
        WHERE po.supplier_id IN (${ph}) AND poi.rate > 0 AND po.order_date IS NOT NULL
        GROUP BY po.supplier_id, v.vendor_name, DATE_TRUNC('month', po.order_date)
      `, ids).catch(() => ({ rows: [] })),

      // Explicit price_history entries
      pool.query(`
        SELECT ph.vendor_id,
               COALESCE(v.vendor_name, ph.vendor_name_text, 'Vendor #' || ph.vendor_id) AS vendor_name,
               TO_CHAR(DATE_TRUNC('month', ph.price_date), 'YYYY-MM') AS month,
               ROUND(AVG(ph.unit_price)::NUMERIC, 2) AS avg_price
        FROM price_history ph
        LEFT JOIN vendors v ON v.id = ph.vendor_id
        WHERE ph.vendor_id IN (${ph}) AND ph.unit_price > 0
        GROUP BY ph.vendor_id, v.vendor_name, ph.vendor_name_text, DATE_TRUNC('month', ph.price_date)
      `, ids).catch(() => ({ rows: [] })),
    ]);

    // Merge all three sources, keyed by vendor_id + month (last write wins)
    const merged = {};
    for (const r of [...phRows, ...poRows, ...quoteRows]) {
      if (!r.month || !r.avg_price) continue;
      const key = `${r.vendor_id}__${r.month}`;
      merged[key] = {
        vendor_id:   r.vendor_id,
        vendor_name: r.vendor_name,
        month:       r.month,
        avg_price:   parseFloat(r.avg_price),
      };
    }

    const result = Object.values(merged).sort((a, b) => a.month.localeCompare(b.month));
    res.json(result);
  } catch (err) {
    console.error('[GET /vendors/price-history]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
