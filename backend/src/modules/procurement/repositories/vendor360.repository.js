import pool from '../../../config/db.js';

// Swallows DB errors gracefully — every aggregation is non-critical.
// The caller (service) decides what to do when a section is empty.
const q  = (sql, params) => pool.query(sql, params).catch(() => ({ rows: [] }));
const q1 = (sql, params, def = {}) =>
  pool.query(sql, params).catch(() => ({ rows: [def] }));

export const Vendor360Repo = {

  // ── VENDOR LIST ──────────────────────────────────────────────────────────────
  async listVendors(companyId, { search, status } = {}) {
    const params  = [companyId];
    const conds   = ['v.company_id = $1'];
    let   idx     = 2;
    if (search) {
      conds.push(
        `(COALESCE(v.vendor_name, v.name) ILIKE $${idx}
          OR v.vendor_code ILIKE $${idx}
          OR v.email       ILIKE $${idx})`
      );
      params.push(`%${search}%`);
      idx++;
    }
    if (status) { conds.push(`v.status = $${idx++}`); params.push(status); }

    // purchase_orders' vendor FK is `supplier_id`, not `vendor_id` — same drift as
    // every other query in this file (see per-function comments below for the fuller
    // goods_receipts/vendor_scorecards drift this file had never worked around).
    const { rows } = await q(
      `SELECT v.id,
              COALESCE(v.vendor_name, v.name)            AS name,
              v.vendor_code, v.vendor_type, v.status,
              v.email, v.phone, v.city, v.state,
              v.category, v.msme_status,
              COALESCE(po_agg.po_count, 0)::int          AS po_count,
              COALESCE(po_agg.po_value, 0)::numeric      AS po_value,
              COALESCE(sc.overall_score, 0)::numeric     AS score,
              v.created_at
       FROM vendors v
       LEFT JOIN (
         SELECT supplier_id,
                COUNT(*)::int                                           AS po_count,
                SUM(COALESCE(total_amount_inr, total_amount))::numeric AS po_value
         FROM purchase_orders
         WHERE status NOT IN ('Cancelled', 'Rejected') AND company_id = $1
         GROUP BY supplier_id
       ) po_agg ON po_agg.supplier_id = v.id
       LEFT JOIN LATERAL (
         SELECT (COALESCE(quality_score,0) + COALESCE(delivery_score,0) +
                 COALESCE(cost_score,0)    + COALESCE(support_score,0)  +
                 COALESCE(compliance_score,0)) / 5 AS overall_score
         FROM vendor_scorecards
         WHERE vendor_id = v.id AND company_id = $1
         ORDER BY period_year DESC, period_quarter DESC
         LIMIT 1
       ) sc ON TRUE
       WHERE ${conds.join(' AND ')}
       ORDER BY po_value DESC NULLS LAST, v.vendor_name ASC
       LIMIT 100`,
      params
    );
    return rows;
  },

  // ── PROFILE ──────────────────────────────────────────────────────────────────
  // company_id enforced here: cross-company lookup returns null → 404 upstream
  async profile(vendorId, companyId) {
    const { rows } = await q(
      `SELECT * FROM vendors WHERE id = $1 AND company_id = $2`,
      [vendorId, companyId]
    );
    return rows[0] || null;
  },

  // vendor_contacts has no company_id column; vendor_id FK is the scope boundary.
  // Real name column is `name`, not `contact_name`; there's no `department` column.
  async contacts(vendorId) {
    const { rows } = await q(
      `SELECT id, vendor_id, name AS contact_name, designation, email, phone, mobile,
              is_primary, created_at
       FROM vendor_contacts
       WHERE vendor_id = $1
       ORDER BY is_primary DESC NULLS LAST, created_at ASC`,
      [vendorId]
    );
    return rows;
  },

  // ── PROCUREMENT ──────────────────────────────────────────────────────────────
  // purchase_orders' vendor FK is `supplier_id`, not `vendor_id`, throughout this file.
  async procurementOrders(vendorId, companyId) {
    const { rows } = await q(
      `SELECT po.id, po.po_number, po.order_date, po.expected_delivery_date,
              po.status, po.currency,
              COALESCE(po.total_amount_inr, po.total_amount)::numeric AS total_amount_inr,
              po.project_id, po.incoterm,
              COUNT(poi.id)::int AS line_count
       FROM purchase_orders po
       LEFT JOIN purchase_order_items poi ON poi.po_id = po.id
       WHERE po.supplier_id = $1 AND po.company_id = $2
       GROUP BY po.id
       ORDER BY po.order_date DESC
       LIMIT 100`,
      [vendorId, companyId]
    );
    return rows;
  },

  async procurementMetrics(vendorId, companyId) {
    const { rows } = await q1(
      `SELECT
         COUNT(*)::int                                                               AS total_pos,
         COUNT(CASE WHEN status NOT IN ('Cancelled','Rejected') THEN 1 END)::int    AS awarded_orders,
         COUNT(CASE WHEN status IN ('Approved','Sent','Partial') THEN 1 END)::int   AS open_pos,
         COUNT(CASE WHEN status IN ('Received','Completed') THEN 1 END)::int        AS closed_pos,
         COUNT(CASE WHEN status IN ('Cancelled','Rejected') THEN 1 END)::int        AS cancelled_pos,
         COALESCE(SUM(CASE WHEN status NOT IN ('Cancelled','Rejected')
           THEN COALESCE(total_amount_inr, total_amount) END), 0)::numeric          AS total_po_value,
         COALESCE(SUM(CASE WHEN status IN ('Approved','Sent','Partial')
           THEN COALESCE(total_amount_inr, total_amount) END), 0)::numeric          AS open_po_value,
         COALESCE(SUM(CASE WHEN status IN ('Received','Completed')
           THEN COALESCE(total_amount_inr, total_amount) END), 0)::numeric          AS closed_po_value,
         COALESCE(AVG(CASE WHEN status NOT IN ('Cancelled','Rejected')
           THEN COALESCE(total_amount_inr, total_amount) END), 0)::numeric          AS avg_order_value
       FROM purchase_orders
       WHERE supplier_id = $1 AND company_id = $2`,
      [vendorId, companyId],
      { total_pos: 0, awarded_orders: 0, open_pos: 0, closed_pos: 0, cancelled_pos: 0,
        total_po_value: 0, open_po_value: 0, closed_po_value: 0, avg_order_value: 0 }
    );
    return rows[0];
  },

  async rfqData(vendorId, companyId) {
    const { rows } = await q(
      `SELECT r.id, r.rfq_number, r.created_at, r.status, r.required_by,
              rq.unit_price, rq.total_amount, rq.delivery_days,
              rq.is_winner, rq.payment_terms
       FROM rfqs r
       LEFT JOIN rfq_quotes rq ON rq.rfq_id = r.id AND rq.vendor_id = $1
       WHERE r.company_id = $2
         AND r.vendor_ids::text LIKE '%' || $1::text || '%'
       ORDER BY r.created_at DESC
       LIMIT 30`,
      [vendorId, companyId]
    );
    return rows;
  },

  // ── DELIVERY ─────────────────────────────────────────────────────────────────
  // goods_receipts doesn't exist and goods_receipt_notes has no vendor_id — bridge
  // through purchase_orders.supplier_id via po_id (same pattern used to fix
  // vendorHealth.service.js and project360.routes.js's identical drift this session).
  async grns(vendorId, companyId) {
    const { rows } = await q(
      `SELECT g.id, g.grn_number, g.received_date, g.status, g.po_id, g.notes,
              po.expected_delivery_date, po.order_date,
              CASE
                WHEN g.received_date IS NOT NULL AND po.expected_delivery_date IS NOT NULL
                THEN (g.received_date::date - po.expected_delivery_date::date)
              END AS delay_days
       FROM goods_receipt_notes g
       JOIN purchase_orders po ON po.id = g.po_id
       WHERE po.supplier_id = $1 AND g.company_id = $2 AND g.deleted_at IS NULL
       ORDER BY g.received_date DESC
       LIMIT 100`,
      [vendorId, companyId]
    );
    return rows;
  },

  async deliveryMetrics(vendorId, companyId) {
    const { rows } = await q1(
      `SELECT
         COUNT(g.id)::int                                                          AS total_grns,
         COALESCE(AVG(
           CASE WHEN g.received_date IS NOT NULL AND po.order_date IS NOT NULL
             THEN (g.received_date::date - po.order_date::date)
           END
         ), 0)::numeric(6,1)                                                       AS avg_lead_time_days,
         COUNT(CASE
           WHEN g.received_date IS NOT NULL AND po.expected_delivery_date IS NOT NULL
             AND g.received_date::date <= po.expected_delivery_date::date
           THEN 1 END)::int                                                        AS on_time_count,
         COUNT(CASE
           WHEN g.received_date IS NOT NULL AND po.expected_delivery_date IS NOT NULL
             AND g.received_date::date >  po.expected_delivery_date::date
           THEN 1 END)::int                                                        AS delayed_count,
         COUNT(CASE WHEN po.status = 'partial' THEN 1 END)::int                    AS partial_count
       FROM goods_receipt_notes g
       JOIN purchase_orders po ON po.id = g.po_id
       WHERE po.supplier_id = $1 AND g.company_id = $2 AND g.deleted_at IS NULL`,
      [vendorId, companyId],
      { total_grns: 0, avg_lead_time_days: 0, on_time_count: 0, delayed_count: 0, partial_count: 0 }
    );
    return rows[0];
  },

  // ── QUALITY ──────────────────────────────────────────────────────────────────
  // ncr_reports has no defect_description/quantity_affected — real description column
  // is `description`; there's no per-NCR affected-quantity anywhere in this schema.
  async ncrs(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, ncr_number, created_at, description AS defect_description, severity, status,
              disposition, source, containment_action
       FROM ncr_reports
       WHERE vendor_id = $1 AND company_id = $2
       ORDER BY created_at DESC
       LIMIT 50`,
      [vendorId, companyId]
    );
    return rows;
  },

  // capa_actions has no action_description — real column is `description`.
  async capas(vendorId, companyId) {
    const { rows } = await q(
      `SELECT ca.id, ca.ncr_id, ca.description AS action_description, ca.due_date, ca.status,
              ca.verified_at, n.severity AS ncr_severity, n.ncr_number
       FROM capa_actions ca
       JOIN ncr_reports n ON n.id = ca.ncr_id
       WHERE n.vendor_id = $1 AND ca.company_id = $2
       ORDER BY ca.due_date ASC
       LIMIT 30`,
      [vendorId, companyId]
    );
    return rows;
  },

  // Same goods_receipts/vendor_id bridge as grns() above.
  async qualityInspections(vendorId, companyId) {
    const { rows } = await q(
      `SELECT ir.id, ir.inspected_at AS inspection_date, ir.stage, ir.overall_result, ir.status, ir.grn_id
       FROM inspection_reports ir
       JOIN goods_receipt_notes g ON g.id = ir.grn_id
       JOIN purchase_orders po ON po.id = g.po_id
       WHERE po.supplier_id = $1 AND ir.company_id = $2
       ORDER BY ir.inspected_at DESC
       LIMIT 50`,
      [vendorId, companyId]
    );
    return rows;
  },

  async qualitySnapshots(vendorId, companyId) {
    const { rows } = await q(
      `SELECT snapshot_period, total_received, total_rejected, ncr_count,
              critical_ncr, ppm, on_time_pct, quality_score, delivery_score, overall_score
       FROM supplier_quality_snapshots
       WHERE vendor_id = $1 AND company_id = $2
       ORDER BY snapshot_period DESC
       LIMIT 6`,
      [vendorId, companyId]
    );
    return rows;
  },

  // ── PURCHASE LINES ───────────────────────────────────────────────────────────
  // Line-level "what did we buy from this vendor, when, at what price". The
  // aggregated suppliedMaterials() below answers "how much in total"; this answers
  // the per-transaction question a buyer actually asks when reviewing a supplier.
  //
  // Deliberately uses pool.query, NOT the error-swallowing q() the rest of this
  // file uses: this is the primary content of its own tab, and a silently empty
  // table reads as "we never bought anything" (the safeQuery trap — see
  // project_reports_module_data_integrity_audit).
  async purchaseLines(vendorId, companyId, { search, from, to, limit = 500 } = {}) {
    const params = [vendorId];
    const conds  = ['po.supplier_id = $1', 'po.deleted_at IS NULL'];
    // companyId is null for super_admin, who operates across tenants — `= NULL`
    // would match nothing, so the clause is dropped rather than bound.
    if (companyId != null) {
      params.push(companyId);
      conds.push(`(po.company_id = $${params.length} OR po.company_id IS NULL)`);
    }
    if (search) {
      params.push(`%${search}%`);
      conds.push(`(im.item_name ILIKE $${params.length} OR im.item_code ILIKE $${params.length}
                   OR po.po_number ILIKE $${params.length})`);
    }
    if (from) { params.push(from); conds.push(`po.order_date >= $${params.length}`); }
    if (to)   { params.push(to);   conds.push(`po.order_date <= $${params.length}`); }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT poi.id AS line_id, po.id AS po_id, po.po_number, po.order_date,
              po.expected_delivery_date, po.status, po.currency, po.project_id,
              poi.item_id,
              COALESCE(im.item_name, 'Item #' || poi.item_id) AS item_name,
              im.item_code, im.unit_of_measure AS uom, im.category_id,
              ic.name AS category_name,
              poi.quantity, poi.rate, poi.tax_rate,
              COALESCE(poi.total_amount, poi.quantity * poi.rate) AS amount,
              COALESCE(poi.received_qty, poi.received_quantity)   AS received_qty,
              (SELECT SUM(gi.quantity_received) FROM grn_items gi
                WHERE gi.po_item_id = poi.id)                     AS grn_received,
              (SELECT SUM(gi.quantity_rejected) FROM grn_items gi
                WHERE gi.po_item_id = poi.id)                     AS grn_rejected,
              (SELECT MAX(g.received_date) FROM grn_items gi
                 JOIN goods_receipt_notes g ON g.id = gi.grn_id AND g.deleted_at IS NULL
                WHERE gi.po_item_id = poi.id)                     AS received_date
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.po_id
         LEFT JOIN inventory_items im ON im.id = poi.item_id
         LEFT JOIN item_categories ic ON ic.id = im.category_id AND ic.deleted_at IS NULL
        WHERE ${conds.join(' AND ')}
        ORDER BY po.order_date DESC NULLS LAST, po.id DESC, poi.id
        LIMIT $${params.length}`,
      params
    );
    return rows;
  },

  // ── INVENTORY ────────────────────────────────────────────────────────────────
  // purchase_order_items carries no item_name/item_code/uom of its own — those live
  // on inventory_items, joined by item_id. po.supplier_id, not po.vendor_id.
  async suppliedMaterials(vendorId, companyId) {
    const { rows } = await q(
      `SELECT poi.item_id,
              COALESCE(im.item_name, 'Item #' || poi.item_id) AS item_name,
              im.item_code,
              im.unit_of_measure                          AS uom,
              SUM(poi.quantity)::numeric                  AS total_ordered,
              SUM(poi.quantity * poi.rate)::numeric       AS total_value,
              COUNT(DISTINCT po.id)::int                  AS po_count,
              MAX(po.order_date)                          AS last_ordered
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.po_id
       LEFT JOIN inventory_items im ON im.id = poi.item_id AND im.company_id = $2
       WHERE po.supplier_id = $1 AND po.company_id = $2
         AND po.status NOT IN ('Cancelled', 'Rejected')
       GROUP BY poi.item_id, im.item_name, im.item_code, im.unit_of_measure
       ORDER BY total_value DESC
       LIMIT 50`,
      [vendorId, companyId]
    );
    return rows;
  },

  // inventory_transactions doesn't exist — this codebase's stock ledger is empty by
  // design in every environment; inventory_items.current_stock is the actual source
  // of truth (see project_stock_three_systems_unification), so read it directly
  // instead of trying to derive it from a transaction log that was never populated.
  async criticalStock(vendorId, companyId) {
    const { rows } = await q(
      `SELECT im.id, im.item_name, im.item_code, im.unit_of_measure AS uom,
              im.current_stock, im.reorder_level, im.lead_time_days
       FROM inventory_items im
       WHERE im.preferred_vendor_id = $1 AND im.company_id = $2
       ORDER BY im.current_stock ASC
       LIMIT 30`,
      [vendorId, companyId]
    );
    return rows;
  },

  // ── PROJECTS ─────────────────────────────────────────────────────────────────
  // projects has no `name` or `contract_value` column — real names are `project_name`
  // and `budget_amount` (see project_projects_budget_validation_gotcha: `budget_amount`
  // is the live field, `budget` is a legacy duplicate). po.supplier_id, not vendor_id.
  async projectData(vendorId, companyId) {
    const { rows } = await q(
      `SELECT
              p.id, p.project_name, p.status, p.priority,
              p.start_date, p.end_date, p.budget_amount AS contract_value,
              SUM(COALESCE(po.total_amount_inr, po.total_amount))::numeric AS vendor_po_value,
              COUNT(po.id)::int AS po_count
       FROM purchase_orders po
       JOIN projects p ON p.id = po.project_id
       WHERE po.supplier_id = $1 AND po.company_id = $2
         AND po.status NOT IN ('Cancelled', 'Rejected')
       GROUP BY p.id, p.project_name, p.status, p.priority, p.start_date, p.end_date, p.budget_amount
       ORDER BY p.start_date DESC
       LIMIT 20`,
      [vendorId, companyId]
    );
    return rows;
  },

  // ── FINANCE ──────────────────────────────────────────────────────────────────
  // bills.supplier_id is uuid (Finance's parties.id) while vendorId here is the
  // procurement vendors.id (integer) — the two masters had no join key at all
  // until vendors.party_id was added (GSTIN-matched backfill). Resolve through
  // it rather than comparing vendorId to supplier_id directly (that used to
  // throw "operator does not exist: uuid = integer" — Vendor 360's Finance tab,
  // cost score, and financial risk were all silently broken).
  // bills also has no `payment_terms` column — dropped rather than fabricated.
  async billsData(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, bill_number, bill_date, due_date, total_amount, balance,
              net_payable, status, approval_status, tds_amount
       FROM bills
       WHERE supplier_id = (SELECT party_id FROM vendors WHERE id = $1)
         AND company_id = $2
       ORDER BY bill_date DESC
       LIMIT 50`,
      [vendorId, companyId]
    );
    return rows;
  },

  async financeMetrics(vendorId, companyId) {
    const { rows } = await q1(
      // due_date::date - bill_date::date is already an integer day count in Postgres —
      // wrapping it in EXTRACT(DAY FROM ...) is only valid for an interval/timestamp,
      // not a plain integer, and always threw "function pg_catalog.extract(unknown,
      // integer) does not exist" (silently swallowed by q1's .catch()).
      `SELECT
         COALESCE(SUM(total_amount), 0)::numeric                                        AS total_spend,
         COALESCE(SUM(CASE WHEN LOWER(status) = 'paid'
                       THEN total_amount ELSE 0 END), 0)::numeric                       AS paid_amount,
         COALESCE(SUM(balance), 0)::numeric                                             AS outstanding_amount,
         COUNT(*)::int                                                                   AS total_bills,
         COUNT(CASE WHEN LOWER(status) NOT IN ('paid','cancelled') THEN 1 END)::int     AS pending_bills,
         COALESCE(AVG(
           CASE WHEN LOWER(status) = 'paid'
                 AND bill_date IS NOT NULL AND due_date IS NOT NULL
             THEN (due_date::date - bill_date::date)
           END
         ), 0)::numeric(6,1)                                                            AS avg_payment_terms_days,
         COALESCE(SUM(tds_amount), 0)::numeric                                          AS total_tds
       FROM bills
       WHERE supplier_id = (SELECT party_id FROM vendors WHERE id = $1)
         AND company_id = $2`,
      [vendorId, companyId],
      { total_spend: 0, paid_amount: 0, outstanding_amount: 0, total_bills: 0,
        pending_bills: 0, avg_payment_terms_days: 0, total_tds: 0 }
    );
    return rows[0];
  },

  // ── SCORECARD ────────────────────────────────────────────────────────────────
  // vendor_scorecards is a real, already-migrated table, but this whole section was
  // written for a different, hypothetical shape (ad-hoc `scored_at` timestamp,
  // `classification`, `notes`, `scored_by`) that never matched what actually got
  // created (`period_year`/`period_quarter`, `risk_rating`, `remarks`, `evaluated_by`)
  // — the CREATE TABLE IF NOT EXISTS below was dead code the whole time since the real
  // table already existed with different columns. Mapped onto the real shape rather
  // than the schema being changed: `created_at` stands in for "when scored",
  // `risk_rating`/`remarks`/`evaluated_by` for `classification`/`notes`/`scored_by`.
  async latestScorecard(vendorId, companyId) {
    const { rows } = await q(
      `SELECT * FROM vendor_scorecards
       WHERE vendor_id = $1 AND company_id = $2
       ORDER BY period_year DESC, period_quarter DESC
       LIMIT 1`,
      [vendorId, companyId]
    );
    return rows[0] || null;
  },

  async saveScorecard(vendorId, companyId, data, userId) {
    const now = new Date();
    const periodYear    = now.getFullYear();
    const periodQuarter = Math.floor(now.getMonth() / 3) + 1;
    const { rows: [row] } = await pool.query(
      `INSERT INTO vendor_scorecards
         (vendor_id, company_id, period_year, period_quarter, quality_score, delivery_score,
          cost_score, support_score, compliance_score, overall_score, risk_rating, remarks, evaluated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (vendor_id, period_year, period_quarter) DO UPDATE SET
         quality_score    = EXCLUDED.quality_score,
         delivery_score   = EXCLUDED.delivery_score,
         cost_score       = EXCLUDED.cost_score,
         support_score    = EXCLUDED.support_score,
         compliance_score = EXCLUDED.compliance_score,
         overall_score    = EXCLUDED.overall_score,
         risk_rating      = EXCLUDED.risk_rating,
         remarks          = EXCLUDED.remarks,
         evaluated_by     = EXCLUDED.evaluated_by,
         updated_at       = NOW()
       RETURNING *`,
      [
        vendorId, companyId, periodYear, periodQuarter,
        data.quality_score    || 0,
        data.delivery_score   || 0,
        data.cost_score       || 0,
        data.support_score    || 0,
        data.compliance_score || 0,
        data.overall_score    || 0,
        data.classification   || null,
        data.notes            || null,
        userId                || null,
      ]
    );
    return row;
  },

  // ── TIMELINE (7 parallel lightweight queries) ─────────────────────────────────
  // vendors has no approval_status column — dropped rather than fabricated
  // (status + approved_at/approved_by already carry that information).
  async timelineVendorInfo(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, COALESCE(vendor_name, name) AS name,
              created_at, status
       FROM vendors WHERE id = $1 AND company_id = $2`,
      [vendorId, companyId]
    );
    return rows[0] || null;
  },

  async timelinePOs(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, po_number, order_date,
              COALESCE(total_amount_inr, total_amount)::numeric AS amount, status
       FROM purchase_orders
       WHERE supplier_id = $1 AND company_id = $2
       ORDER BY order_date DESC LIMIT 30`,
      [vendorId, companyId]
    );
    return rows;
  },

  async timelineGRNs(vendorId, companyId) {
    const { rows } = await q(
      `SELECT g.id, g.grn_number, g.received_date AS date, g.status
       FROM goods_receipt_notes g
       JOIN purchase_orders po ON po.id = g.po_id
       WHERE po.supplier_id = $1 AND g.company_id = $2 AND g.deleted_at IS NULL
       ORDER BY g.received_date DESC LIMIT 20`,
      [vendorId, companyId]
    );
    return rows;
  },

  async timelineNCRs(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, ncr_number, created_at AS date, severity, status
       FROM ncr_reports
       WHERE vendor_id = $1 AND company_id = $2
       ORDER BY created_at DESC LIMIT 10`,
      [vendorId, companyId]
    );
    return rows;
  },

  // Same uuid party_id bridge as billsData()/financeMetrics() — this one had never
  // gotten the fix those two already carry a comment about.
  async timelineBills(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, bill_number, bill_date AS date, total_amount AS amount, status
       FROM bills
       WHERE supplier_id = (SELECT party_id FROM vendors WHERE id = $1)
         AND company_id = $2
       ORDER BY bill_date DESC LIMIT 10`,
      [vendorId, companyId]
    );
    return rows;
  },

  async timelineScorecards(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, created_at AS date, overall_score
       FROM vendor_scorecards
       WHERE vendor_id = $1 AND company_id = $2
       ORDER BY created_at DESC LIMIT 5`,
      [vendorId, companyId]
    );
    return rows;
  },

  async timelineRFQs(vendorId, companyId) {
    const { rows } = await q(
      `SELECT r.id, r.rfq_number, r.created_at AS date
       FROM rfqs r
       WHERE r.company_id = $2
         AND r.vendor_ids::text LIKE '%' || $1::text || '%'
       ORDER BY r.created_at DESC LIMIT 10`,
      [vendorId, companyId]
    );
    return rows;
  },

  // ── RISK: project dependency count ───────────────────────────────────────────
  async projectCount(vendorId, companyId) {
    const { rows } = await q1(
      `SELECT COUNT(DISTINCT p.id)::int AS project_count
       FROM projects p
       JOIN purchase_orders po ON po.project_id = p.id
       WHERE po.supplier_id = $1 AND po.company_id = $2
         AND po.status NOT IN ('Cancelled','Rejected')`,
      [vendorId, companyId],
      { project_count: 0 }
    );
    return rows[0];
  },

  // ── COMMAND CENTER (CEO / Procurement) ───────────────────────────────────────
  async commandCenterData(companyId) {
    const [topSpend, topNcr, mostDelayed, mostReliable, summary, vendorDist] = await Promise.all([
      q(`SELECT v.id,
                COALESCE(v.vendor_name, v.name) AS name,
                v.vendor_code, v.status,
                COALESCE(SUM(COALESCE(po.total_amount_inr, po.total_amount)),0)::numeric AS total_spend,
                COUNT(DISTINCT po.id)::int AS po_count
         FROM vendors v
         JOIN purchase_orders po ON po.supplier_id = v.id
         WHERE v.company_id = $1 AND po.company_id = $1
           AND po.status NOT IN ('Cancelled','Rejected')
         GROUP BY v.id, v.vendor_name, v.name, v.vendor_code, v.status
         ORDER BY total_spend DESC LIMIT 10`, [companyId]),

      q(`SELECT v.id,
                COALESCE(v.vendor_name, v.name) AS name, v.vendor_code,
                COUNT(nr.id)::int AS ncr_count,
                COUNT(CASE WHEN nr.status != 'Closed' THEN 1 END)::int AS open_ncrs
         FROM vendors v
         JOIN ncr_reports nr ON nr.vendor_id = v.id
         WHERE v.company_id = $1 AND nr.company_id = $1
         GROUP BY v.id, v.vendor_name, v.name, v.vendor_code
         ORDER BY ncr_count DESC LIMIT 10`, [companyId]),

      q(`SELECT v.id,
                COALESCE(v.vendor_name, v.name) AS name, v.vendor_code,
                COUNT(CASE WHEN po.expected_delivery_date < NOW()
                            AND po.status NOT IN ('Received','Completed','Cancelled') THEN 1 END)::int AS delayed_count,
                COUNT(po.id)::int AS total_pos
         FROM vendors v
         JOIN purchase_orders po ON po.supplier_id = v.id
         WHERE v.company_id = $1 AND po.company_id = $1
         GROUP BY v.id, v.vendor_name, v.name, v.vendor_code
         HAVING COUNT(CASE WHEN po.expected_delivery_date < NOW()
                            AND po.status NOT IN ('Received','Completed','Cancelled') THEN 1 END) > 0
         ORDER BY delayed_count DESC LIMIT 10`, [companyId]),

      q(`SELECT v.id,
                COALESCE(v.vendor_name, v.name) AS name, v.vendor_code,
                COUNT(po.id)::int AS total_pos,
                COUNT(CASE WHEN po.status IN ('Received','Completed') THEN 1 END)::int AS completed_pos,
                CASE WHEN COUNT(po.id) > 0
                  THEN ROUND((COUNT(CASE WHEN po.status IN ('Received','Completed') THEN 1 END)::numeric
                               / COUNT(po.id)) * 100, 1)
                  ELSE 0 END AS reliability_pct
         FROM vendors v
         JOIN purchase_orders po ON po.supplier_id = v.id
         WHERE v.company_id = $1 AND po.company_id = $1
         GROUP BY v.id, v.vendor_name, v.name, v.vendor_code
         HAVING COUNT(po.id) >= 3
         ORDER BY reliability_pct DESC LIMIT 10`, [companyId]),

      q1(`SELECT
            (SELECT COUNT(*) FROM vendors WHERE company_id = $1)::int AS active_vendors,
            (SELECT COUNT(*) FROM rfqs WHERE company_id = $1 AND status IN ('Open','Pending','Draft'))::int AS open_rfqs,
            (SELECT COUNT(*) FROM purchase_orders WHERE company_id = $1 AND status IN ('Approved','Sent','Partial'))::int AS open_pos,
            (SELECT COUNT(*) FROM purchase_orders WHERE company_id = $1
               AND expected_delivery_date < NOW()
               AND status NOT IN ('Received','Completed','Cancelled'))::int AS delayed_deliveries`,
         [companyId],
         { active_vendors: 0, open_rfqs: 0, open_pos: 0, delayed_deliveries: 0 }),

      q(`SELECT COALESCE(status,'Unknown') AS status, COUNT(*)::int AS count
         FROM vendors WHERE company_id = $1 GROUP BY status`, [companyId]),
    ]);

    return {
      top_spend_vendors:    topSpend.rows.map(r => ({ ...r, total_spend: parseFloat(r.total_spend) })),
      top_ncr_vendors:      topNcr.rows,
      most_delayed_vendors: mostDelayed.rows,
      most_reliable_vendors: mostReliable.rows.map(r => ({ ...r, reliability_pct: parseFloat(r.reliability_pct) })),
      vendor_distribution:  vendorDist.rows,
      summary:              summary.rows[0],
    };
  },
};
