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
         SELECT vendor_id,
                COUNT(*)::int                                           AS po_count,
                SUM(COALESCE(total_amount_inr, total_amount))::numeric AS po_value
         FROM purchase_orders
         WHERE status NOT IN ('Cancelled', 'Rejected') AND company_id = $1
         GROUP BY vendor_id
       ) po_agg ON po_agg.vendor_id = v.id
       LEFT JOIN LATERAL (
         SELECT (COALESCE(quality_score,0) + COALESCE(delivery_score,0) +
                 COALESCE(cost_score,0)    + COALESCE(support_score,0)  +
                 COALESCE(compliance_score,0)) / 5 AS overall_score
         FROM vendor_scorecards
         WHERE vendor_id = v.id AND company_id = $1
         ORDER BY scored_at DESC
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

  // vendor_contacts has no company_id column; vendor_id FK is the scope boundary
  async contacts(vendorId) {
    const { rows } = await q(
      `SELECT id, vendor_id, contact_name, designation, email, phone, mobile,
              is_primary, department, created_at
       FROM vendor_contacts
       WHERE vendor_id = $1
       ORDER BY is_primary DESC NULLS LAST, created_at ASC`,
      [vendorId]
    );
    return rows;
  },

  // ── PROCUREMENT ──────────────────────────────────────────────────────────────
  async procurementOrders(vendorId, companyId) {
    const { rows } = await q(
      `SELECT po.id, po.po_number, po.order_date, po.expected_delivery_date,
              po.status, po.currency,
              COALESCE(po.total_amount_inr, po.total_amount)::numeric AS total_amount_inr,
              po.project_id, po.incoterm,
              COUNT(poi.id)::int AS line_count
       FROM purchase_orders po
       LEFT JOIN purchase_order_items poi ON poi.po_id = po.id
       WHERE po.vendor_id = $1 AND po.company_id = $2
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
       WHERE vendor_id = $1 AND company_id = $2`,
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
  async grns(vendorId, companyId) {
    const { rows } = await q(
      `SELECT g.id, g.grn_number, g.received_date, g.status, g.po_id, g.notes,
              po.expected_delivery_date, po.order_date,
              CASE
                WHEN g.received_date IS NOT NULL AND po.expected_delivery_date IS NOT NULL
                THEN EXTRACT(DAY FROM
                       (g.received_date::date - po.expected_delivery_date::date))::int
              END AS delay_days
       FROM goods_receipts g
       LEFT JOIN purchase_orders po ON po.id = g.po_id
       WHERE g.vendor_id = $1 AND g.company_id = $2
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
             THEN EXTRACT(DAY FROM (g.received_date::date - po.order_date::date))
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
         COUNT(CASE WHEN g.status = 'partial' THEN 1 END)::int                    AS partial_count
       FROM goods_receipts g
       LEFT JOIN purchase_orders po ON po.id = g.po_id
       WHERE g.vendor_id = $1 AND g.company_id = $2`,
      [vendorId, companyId],
      { total_grns: 0, avg_lead_time_days: 0, on_time_count: 0, delayed_count: 0, partial_count: 0 }
    );
    return rows[0];
  },

  // ── QUALITY ──────────────────────────────────────────────────────────────────
  async ncrs(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, ncr_number, created_at, defect_description, severity, status,
              disposition, quantity_affected, source, containment_action
       FROM ncr_reports
       WHERE vendor_id = $1 AND company_id = $2
       ORDER BY created_at DESC
       LIMIT 50`,
      [vendorId, companyId]
    );
    return rows;
  },

  async capas(vendorId, companyId) {
    const { rows } = await q(
      `SELECT ca.id, ca.ncr_id, ca.action_description, ca.due_date, ca.status,
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

  async qualityInspections(vendorId, companyId) {
    const { rows } = await q(
      `SELECT ir.id, ir.inspection_date, ir.stage, ir.overall_result, ir.status, ir.grn_id
       FROM inspection_reports ir
       JOIN goods_receipts g ON g.id = ir.grn_id
       WHERE g.vendor_id = $1 AND ir.company_id = $2
       ORDER BY ir.inspection_date DESC
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

  // ── INVENTORY ────────────────────────────────────────────────────────────────
  async suppliedMaterials(vendorId, companyId) {
    const { rows } = await q(
      `SELECT poi.item_id,
              poi.item_name,
              COALESCE(poi.item_code, im.item_code)       AS item_code,
              poi.uom,
              SUM(poi.quantity)::numeric                  AS total_ordered,
              SUM(poi.quantity * poi.rate)::numeric       AS total_value,
              COUNT(DISTINCT po.id)::int                  AS po_count,
              MAX(po.order_date)                          AS last_ordered
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.po_id
       LEFT JOIN inventory_items im ON im.id = poi.item_id AND im.company_id = $2
       WHERE po.vendor_id = $1 AND po.company_id = $2
         AND po.status NOT IN ('Cancelled', 'Rejected')
       GROUP BY poi.item_id, poi.item_name, poi.item_code, im.item_code, poi.uom
       ORDER BY total_value DESC
       LIMIT 50`,
      [vendorId, companyId]
    );
    return rows;
  },

  async criticalStock(vendorId, companyId) {
    const { rows } = await q(
      `SELECT im.id, im.item_name, im.item_code, im.uom,
              COALESCE(SUM(
                CASE
                  WHEN it.transaction_type IN ('GRN', 'opening', 'purchase') THEN  it.quantity
                  WHEN it.transaction_type IN ('issue', 'return_to_vendor', 'sale') THEN -it.quantity
                  ELSE 0
                END
              ), 0)::numeric AS current_stock,
              im.reorder_level, im.lead_time_days
       FROM inventory_items im
       LEFT JOIN inventory_transactions it ON it.item_id = im.id
       WHERE im.preferred_vendor_id = $1 AND im.company_id = $2
       GROUP BY im.id, im.item_name, im.item_code, im.uom, im.reorder_level, im.lead_time_days
       ORDER BY current_stock ASC
       LIMIT 30`,
      [vendorId, companyId]
    );
    return rows;
  },

  // ── PROJECTS ─────────────────────────────────────────────────────────────────
  async projectData(vendorId, companyId) {
    const { rows } = await q(
      `SELECT
              p.id, p.name AS project_name, p.status, p.priority,
              p.start_date, p.end_date, p.contract_value,
              SUM(COALESCE(po.total_amount_inr, po.total_amount))::numeric AS vendor_po_value,
              COUNT(po.id)::int AS po_count
       FROM purchase_orders po
       JOIN projects p ON p.id = po.project_id
       WHERE po.vendor_id = $1 AND po.company_id = $2
         AND po.status NOT IN ('Cancelled', 'Rejected')
       GROUP BY p.id, p.name, p.status, p.priority, p.start_date, p.end_date, p.contract_value
       ORDER BY p.start_date DESC
       LIMIT 20`,
      [vendorId, companyId]
    );
    return rows;
  },

  // ── FINANCE ──────────────────────────────────────────────────────────────────
  async billsData(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, bill_number, bill_date, due_date, total_amount, balance,
              net_payable, status, approval_status, payment_terms, tds_amount
       FROM bills
       WHERE supplier_id = $1 AND company_id = $2
       ORDER BY bill_date DESC
       LIMIT 50`,
      [vendorId, companyId]
    );
    return rows;
  },

  async financeMetrics(vendorId, companyId) {
    const { rows } = await q1(
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
             THEN EXTRACT(DAY FROM (due_date::date - bill_date::date))
           END
         ), 0)::numeric(6,1)                                                            AS avg_payment_terms_days,
         COALESCE(SUM(tds_amount), 0)::numeric                                          AS total_tds
       FROM bills
       WHERE supplier_id = $1 AND company_id = $2`,
      [vendorId, companyId],
      { total_spend: 0, paid_amount: 0, outstanding_amount: 0, total_bills: 0,
        pending_bills: 0, avg_payment_terms_days: 0, total_tds: 0 }
    );
    return rows[0];
  },

  // ── SCORECARD ────────────────────────────────────────────────────────────────
  async latestScorecard(vendorId, companyId) {
    const { rows } = await q(
      `SELECT * FROM vendor_scorecards
       WHERE vendor_id = $1 AND company_id = $2
       ORDER BY scored_at DESC
       LIMIT 1`,
      [vendorId, companyId]
    );
    return rows[0] || null;
  },

  async saveScorecard(vendorId, companyId, data, userId) {
    // CREATE TABLE IF NOT EXISTS so the endpoint works before a formal migration lands
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendor_scorecards (
        id               SERIAL       PRIMARY KEY,
        vendor_id        INT          NOT NULL,
        company_id       INT          NOT NULL,
        quality_score    NUMERIC(5,1) NOT NULL DEFAULT 0,
        delivery_score   NUMERIC(5,1) NOT NULL DEFAULT 0,
        cost_score       NUMERIC(5,1) NOT NULL DEFAULT 0,
        support_score    NUMERIC(5,1) NOT NULL DEFAULT 0,
        compliance_score NUMERIC(5,1) NOT NULL DEFAULT 0,
        overall_score    NUMERIC(5,1) NOT NULL DEFAULT 0,
        classification   VARCHAR(20),
        notes            TEXT,
        scored_by        INT,
        scored_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    const { rows: [row] } = await pool.query(
      `INSERT INTO vendor_scorecards
         (vendor_id, company_id, quality_score, delivery_score, cost_score,
          support_score, compliance_score, overall_score, classification, notes, scored_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        vendorId, companyId,
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
  async timelineVendorInfo(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, COALESCE(vendor_name, name) AS name,
              created_at, status, approval_status
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
       WHERE vendor_id = $1 AND company_id = $2
       ORDER BY order_date DESC LIMIT 30`,
      [vendorId, companyId]
    );
    return rows;
  },

  async timelineGRNs(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, grn_number, received_date AS date, status
       FROM goods_receipts
       WHERE vendor_id = $1 AND company_id = $2
       ORDER BY received_date DESC LIMIT 20`,
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

  async timelineBills(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, bill_number, bill_date AS date, total_amount AS amount, status
       FROM bills
       WHERE supplier_id = $1 AND company_id = $2
       ORDER BY bill_date DESC LIMIT 10`,
      [vendorId, companyId]
    );
    return rows;
  },

  async timelineScorecards(vendorId, companyId) {
    const { rows } = await q(
      `SELECT id, scored_at AS date, overall_score
       FROM vendor_scorecards
       WHERE vendor_id = $1 AND company_id = $2
       ORDER BY scored_at DESC LIMIT 5`,
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
       WHERE po.vendor_id = $1 AND po.company_id = $2
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
         JOIN purchase_orders po ON po.vendor_id = v.id
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
         JOIN purchase_orders po ON po.vendor_id = v.id
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
         JOIN purchase_orders po ON po.vendor_id = v.id
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
