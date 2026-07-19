import express from 'express';
import pool from '../../../config/db.js';
import { nextRfqNumber } from '../../../shared/docNumber.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);


// ─── Helper: compute match status and variance from amounts ──────────────────
function computeMatch(poAmt, invAmt, grnVal) {
  const po = Number(poAmt);
  const inv = Number(invAmt);
  const grn = Number(grnVal);
  const variance = Math.max(Math.abs(po - inv), Math.abs(po - grn));
  const pct = po > 0 ? variance / po : 0;
  let match_status;
  if (pct <= 0.01) match_status = 'matched';
  else if (pct <= 0.05) match_status = 'partial';
  else match_status = 'mismatch';
  return { match_status, variance: parseFloat(variance.toFixed(2)) };
}

// ─── GET /vendors ─────────────────────────────────────────────────────────────
router.get('/vendors', async (req, res) => {
  try {
    const { category, status, search } = req.query;
    const companyId = cid(req);
    const conditions = [];
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

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM vendors ${where} ORDER BY vendor_name ASC`,
      params
    );
    res.json({ vendors: result.rows });
  } catch (err) {
    console.error('[GET /vendors]', err.message);
    res.status(500).json({ error: 'Failed to fetch vendors', detail: err.message });
  }
});

// ─── POST /vendors ────────────────────────────────────────────────────────────
router.post('/vendors', async (req, res) => {
  try {
    const { vendor_name, category, gstin, pan, bank_name, account_number, ifsc, contact_person, email, phone, city, state, address, quality_rating, delivery_rating, price_rating, status } = req.body;
    const companyId = cid(req);
    const result = await pool.query(
      `INSERT INTO vendors (vendor_name, category, gstin, pan, bank_name, account_number, ifsc, contact_person, email, phone, city, state, address, quality_rating, delivery_rating, price_rating, status, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [vendor_name, category, gstin, pan, bank_name, account_number, ifsc, contact_person, email, phone, city, state, address, quality_rating || 0, delivery_rating || 0, price_rating || 0, status || 'active', companyId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[POST /vendors]', err.message);
    res.status(500).json({ error: 'Failed to create vendor', detail: err.message });
  }
});

// ─── PUT /vendors/:id ─────────────────────────────────────────────────────────
router.put('/vendors/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { vendor_name, category, gstin, pan, bank_name, account_number, ifsc, contact_person, email, phone, city, state, address, quality_rating, delivery_rating, price_rating, status } = req.body;
    const result = await pool.query(
      `UPDATE vendors SET vendor_name=$1, category=$2, gstin=$3, pan=$4, bank_name=$5, account_number=$6, ifsc=$7, contact_person=$8, email=$9, phone=$10, city=$11, state=$12, address=$13, quality_rating=$14, delivery_rating=$15, price_rating=$16, status=$17, updated_at=NOW()
       WHERE id=$18 RETURNING *`,
      [vendor_name, category, gstin, pan, bank_name, account_number, ifsc, contact_person, email, phone, city, state, address, quality_rating, delivery_rating, price_rating, status, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[PUT /vendors/:id]', err.message);
    res.status(500).json({ error: 'Failed to update vendor', detail: err.message });
  }
});

// ─── GET /rfqs ────────────────────────────────────────────────────────────────
router.get('/rfqs', async (req, res) => {
  try {
    const companyId = cid(req);
    const conditions = ['1=1'];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`r.company_id = $${idx++}`); params.push(companyId); }

    const rfqResult = await pool.query(
      `SELECT r.*, COUNT(q.id)::INT AS response_count, MIN(q.unit_price) AS lowest_quote
       FROM rfqs r
       LEFT JOIN rfq_quotes q ON q.rfq_id = r.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY r.id
       ORDER BY r.created_at DESC`, params
    );
    const rfqs = rfqResult.rows;

    const quoteIds = rfqs.map(r => r.id);
    let quotesByRfq = {};
    if (quoteIds.length) {
      const ph = quoteIds.map((_, i) => `$${i + 1}`).join(',');
      const quotesResult = await pool.query(
        `SELECT q.*, v.vendor_name FROM rfq_quotes q LEFT JOIN vendors v ON v.id = q.vendor_id WHERE q.rfq_id IN (${ph}) ORDER BY q.unit_price ASC`,
        quoteIds
      );
      for (const quote of quotesResult.rows) {
        if (!quotesByRfq[quote.rfq_id]) quotesByRfq[quote.rfq_id] = [];
        quotesByRfq[quote.rfq_id].push(quote);
      }
    }

    const merged = rfqs.map(r => ({ ...r, quotes: quotesByRfq[r.id] || [] }));
    res.json({ rfqs: merged });
  } catch (err) {
    console.error('[GET /rfqs]', err.message);
    res.status(500).json({ error: 'Failed to fetch RFQs', detail: err.message });
  }
});

// ─── POST /rfqs ───────────────────────────────────────────────────────────────
router.post('/rfqs', async (req, res) => {
  try {
    const { linked_pr_id, item_description, quantity, unit, required_by, vendor_ids } = req.body;

    const rfq_number = await nextRfqNumber();

    const result = await pool.query(
      `INSERT INTO rfqs (rfq_number, pr_id, item_description, quantity, unit, required_by, vendor_ids, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft') RETURNING *`,
      [rfq_number, linked_pr_id || null, item_description, quantity, unit, required_by || null, JSON.stringify(vendor_ids || [])]
    );
    res.status(201).json({ ...result.rows[0], quotes: [] });
  } catch (err) {
    console.error('[POST /rfqs]', err.message);
    res.status(500).json({ error: 'Failed to create RFQ', detail: err.message });
  }
});

// ─── PUT /rfqs/:id ────────────────────────────────────────────────────────────
router.put('/rfqs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, vendor_ids } = req.body;

    const setClauses = [];
    const params = [];
    let idx = 1;

    if (status) { setClauses.push(`status = $${idx++}`); params.push(status); }
    if (vendor_ids !== undefined) { setClauses.push(`vendor_ids = $${idx++}`); params.push(JSON.stringify(vendor_ids)); }
    if (setClauses.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    const result = await pool.query(
      `UPDATE rfqs SET ${setClauses.join(', ')} WHERE id=$${idx} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'RFQ not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[PUT /rfqs/:id]', err.message);
    res.status(500).json({ error: 'Failed to update RFQ', detail: err.message });
  }
});

// ─── POST /rfqs/:id/quotes ────────────────────────────────────────────────────
router.post('/rfqs/:id/quotes', async (req, res) => {
  try {
    const { id } = req.params;
    const { vendor_id, unit_price, total_amount, delivery_days, payment_terms, notes } = req.body;

    const rfqCheck = await pool.query('SELECT id FROM rfqs WHERE id=$1', [id]);
    if (rfqCheck.rows.length === 0) return res.status(404).json({ error: 'RFQ not found' });

    const result = await pool.query(
      `INSERT INTO rfq_quotes (rfq_id, vendor_id, unit_price, total_amount, delivery_days, payment_terms, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, vendor_id, unit_price, total_amount, delivery_days, payment_terms, notes]
    );

    // fetch vendor name to return in response
    const vendorRes = await pool.query('SELECT vendor_name FROM vendors WHERE id=$1', [vendor_id]);
    const vendor_name = vendorRes.rows[0]?.vendor_name || '';
    res.status(201).json({ ...result.rows[0], vendor_name });
  } catch (err) {
    console.error('[POST /rfqs/:id/quotes]', err.message);
    res.status(500).json({ error: 'Failed to add quote', detail: err.message });
  }
});

// ─── PUT /rfqs/:id/quotes/:quoteId/winner ─────────────────────────────────────
router.put('/rfqs/:id/quotes/:quoteId/winner', async (req, res) => {
  try {
    const { id, quoteId } = req.params;

    // clear existing winners for this RFQ
    await pool.query('UPDATE rfq_quotes SET is_winner=false WHERE rfq_id=$1', [id]);
    // mark new winner
    await pool.query('UPDATE rfq_quotes SET is_winner=true WHERE id=$1', [quoteId]);
    // close the RFQ
    const rfqResult = await pool.query(`UPDATE rfqs SET status='closed' WHERE id=$1 RETURNING *`, [id]);
    if (rfqResult.rows.length === 0) return res.status(404).json({ error: 'RFQ not found' });

    res.json({ success: true, rfq: rfqResult.rows[0] });
  } catch (err) {
    console.error('[PUT /rfqs/:id/quotes/:quoteId/winner]', err.message);
    res.status(500).json({ error: 'Failed to select winner', detail: err.message });
  }
});

// ─── GET /three-way-match ─────────────────────────────────────────────────────
router.get('/three-way-match', async (req, res) => {
  try {
    const companyId = cid(req);
    const conditions = ['1=1'];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`twm.company_id = $${idx++}`); params.push(companyId); }
    const { rows } = await pool.query(`
      SELECT twm.*, po.po_number, v.vendor_name
      FROM three_way_matches twm
      JOIN purchase_orders po ON po.id = twm.po_id
      LEFT JOIN vendors v ON v.id = po.supplier_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY twm.created_at DESC
    `, params);
    res.json({ matches: rows });
  } catch (err) {
    console.error('[GET /three-way-match]', err.message);
    res.status(500).json({ error: 'Failed to fetch match records', detail: err.message });
  }
});

// ─── PATCH /three-way-match/:id/resolve ───────────────────────────────────────
router.patch('/three-way-match/:id/resolve', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE three_way_matches SET match_status='matched', discrepancy_reason=NULL WHERE id=$1 RETURNING *`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Match record not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[PATCH /three-way-match/:id/resolve]', err.message);
    res.status(500).json({ error: 'Failed to resolve match', detail: err.message });
  }
});

// ─── GET /vendors/compare?ids=1,2,3 ──────────────────────────────────────────
// Returns enriched profile + PO stats + RFQ stats for each vendor ID
router.get('/vendors/compare', async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
    if (ids.length < 1) return res.status(400).json({ error: 'Provide at least one vendor id in ?ids=' });

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
router.get('/vendors/compare/items', async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
    if (ids.length < 1) return res.status(400).json({ error: 'Provide vendor ids' });

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
router.get('/vendors/price-history', async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Provide vendor ids in ?ids=' });

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
