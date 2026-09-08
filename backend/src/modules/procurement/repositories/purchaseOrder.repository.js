import pool from '../../shared/db.js';
import { nextPurchaseOrderNumber } from '../../../shared/docNumber.js';

class PurchaseOrderRepository {
  async create(client, data) {
    const {
      po_number, pr_id, supplier_id, order_date, expected_delivery_date,
      subtotal, tax_amount, total_amount, terms_conditions, notes,
      created_by, company_id, currency, exchange_rate, project_id, sales_order_id,
    } = data;
    // currency/exchange_rate carry DB defaults ('INR'/1); pass them explicitly so a
    // foreign-currency PO can be raised, and keep total_amount_inr in step with the
    // rate rather than leaving it NULL for every row (finance reads the INR column).
    const rate = exchange_rate == null || exchange_rate === '' ? 1 : parseFloat(exchange_rate);
    const totalInr = (parseFloat(total_amount) || 0) * (Number.isFinite(rate) && rate > 0 ? rate : 1);
    const result = await client.query(
      `INSERT INTO purchase_orders (po_number, pr_id, supplier_id, order_date, expected_delivery_date,
                                    subtotal, tax_amount, total_amount, terms_conditions, notes,
                                    created_by, company_id, currency, exchange_rate, total_amount_inr,
                                    project_id, sales_order_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [po_number, pr_id ?? null, supplier_id, order_date, expected_delivery_date ?? null,
       subtotal ?? 0, tax_amount ?? 0, total_amount ?? 0, terms_conditions ?? null, notes ?? null,
       created_by, company_id ?? null, currency || 'INR', Number.isFinite(rate) && rate > 0 ? rate : 1,
       totalInr, project_id ?? null, sales_order_id ?? null]
    );
    return result.rows[0];
  }

  async createItem(client, data) {
    const { po_id, item_id, quantity, rate, tax_rate, tax_amount, total_amount } = data;
    const result = await client.query(
      `INSERT INTO purchase_order_items (po_id, item_id, quantity, rate, tax_rate, tax_amount, total_amount) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [po_id, item_id, quantity, rate, tax_rate, tax_amount, total_amount]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = `SELECT po.*, COALESCE(v.vendor_name, '') as supplier_name
                 FROM purchase_orders po
                 LEFT JOIN vendors v ON po.supplier_id = v.id
                 WHERE po.deleted_at IS NULL`;
    const params = [];

    if (filters.company_id) {
      params.push(filters.company_id);
      query += ` AND po.company_id = $${params.length}`;
    }

    if (filters.status) {
      params.push(filters.status);
      query += ` AND po.status = $${params.length}`;
    }

    if (filters.reminder_queued === 'true' || filters.reminder_queued === true) {
      query += ` AND po.status = 'sent' AND po.created_at < NOW() - INTERVAL '7 days'`;
    }

    if (filters.supplier_id) {
      params.push(filters.supplier_id);
      query += ` AND po.supplier_id = $${params.length}`;
    }

    query += ' ORDER BY po.order_date DESC';
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * The counts behind the Purchase Orders KPI strip.
   *
   * Every status gets a bucket, because the strip reports a `total` beside them
   * and a reader takes the two as reconciling. It did not: `draft`, `partial`
   * and `cancelled` had no bucket, so a database holding 10 orders showed
   * cards adding to 8 and two orders that no card could select — the same
   * "a chip count that exposes rows no chip can reach" shape as the §133 sales
   * filter sweep.
   *
   * `follow_up` is the one figure that is NOT a bucket: it counts orders that
   * are already inside `pending` and have gone quiet for a week. It is excluded
   * from the reconciliation on purpose, and `other` exists so a status added
   * later surfaces as an unnamed bucket rather than quietly unbalancing the
   * strip again.
   *
   * Invariant, asserted in integration.procurementAnalytics.test.js:
   *   draft + pending + approved + partial + received + cancelled + other === total
   */
  async getStats(companyId) {
    const params = companyId ? [companyId] : [];
    const companyFilter = companyId ? 'AND company_id = $1' : '';
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'draft')                                                     AS draft,
        COUNT(*) FILTER (WHERE status = 'sent')                                                      AS pending,
        COUNT(*) FILTER (WHERE status = 'approved')                                                  AS approved,
        COUNT(*) FILTER (WHERE status = 'partial')                                                   AS partial,
        COUNT(*) FILTER (WHERE status = 'received')                                                  AS received,
        COUNT(*) FILTER (WHERE status = 'cancelled')                                                 AS cancelled,
        COUNT(*) FILTER (WHERE status NOT IN
          ('draft','sent','approved','partial','received','cancelled'))                              AS other,
        COUNT(*) FILTER (WHERE status = 'sent' AND created_at < NOW() - INTERVAL '7 days')           AS follow_up,
        COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled')), 0)                    AS total_value,
        COUNT(*)                                                                                      AS total
      FROM purchase_orders
      WHERE deleted_at IS NULL ${companyFilter}
    `, params);
    const s = rows[0];
    return {
      draft:       parseInt(s.draft),
      pending:     parseInt(s.pending),
      approved:    parseInt(s.approved),
      partial:     parseInt(s.partial),
      received:    parseInt(s.received),
      cancelled:   parseInt(s.cancelled),
      // Any status this strip does not name. Never expected to be non-zero;
      // it exists so that a status added later shows up as an unnamed bucket
      // instead of silently making the strip stop adding up.
      other:       parseInt(s.other),
      // A SUBSET of `pending`, not a bucket — deliberately excluded from the
      // reconciliation below, because an order can be both sent and overdue.
      follow_up:   parseInt(s.follow_up),
      total_value: parseFloat(s.total_value),
      total:       parseInt(s.total),
    };
  }

  /**
   * Single-record read, tenant-scoped.
   *
   * `companyId` is second because every caller that serves an HTTP request must
   * pass it: without the predicate this returned any tenant's PO by id, and the
   * routes built on it (detail drawer, status update, send, approve, cancel)
   * inherited the hole — a company-1 token could read and cancel a company-2
   * order. `null` means a genuinely global scope (super admin with no company),
   * matching companyOf()'s contract; it is never the default.
   */
  async findById(id, companyId = null, client = null) {
    const db = client ?? pool;
    const result = await db.query(
      `SELECT po.*, COALESCE(v.vendor_name, '') as supplier_name, v.email as supplier_email
       FROM purchase_orders po
       LEFT JOIN vendors v ON po.supplier_id = v.id
       WHERE po.id = $1 AND po.deleted_at IS NULL
         AND ($2::int IS NULL OR po.company_id = $2)`,
      [id, companyId]
    );
    return result.rows[0];
  }

  /**
   * @param {object|null} client  the active transaction client, when reading
   *   inside one.
   *
   * grn.service.createGRN() called this WITHOUT a client to decide whether the
   * order was now fully received, immediately after incrementing the very
   * received_quantity values it was about to read. A pool read runs on a
   * different connection and therefore a different snapshot: under READ
   * COMMITTED it cannot see the transaction's uncommitted UPDATEs, so it always
   * returned the PRE-receipt quantities. `allReceived` was consequently false on
   * the receipt that completed the order, and a fully received PO was left at
   * status 'partial' forever — which then kept it in the open-order lists, the
   * pending-receipt count and MRP's inbound supply.
   */
  async getItems(poId, companyId = null, client = null) {
    const db = client ?? pool;
    // LEFT JOIN, not JOIN: a line whose item was since deleted from the item
    // master must still appear on its PO — an inner join silently dropped it and
    // the order read as short-shipped against its own total.
    const result = await db.query(
      `SELECT poi.*, ii.item_code, ii.item_name, ii.unit_of_measure
       FROM purchase_order_items poi
       LEFT JOIN inventory_items ii ON poi.item_id = ii.id
       JOIN purchase_orders po ON po.id = poi.po_id
       WHERE poi.po_id = $1 AND ($2::int IS NULL OR po.company_id = $2)
       ORDER BY poi.created_at`,
      [poId, companyId]
    );
    return result.rows;
  }

  async updateStatus(client, id, status, companyId = null) {
    const result = await client.query(
      `UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND ($3::int IS NULL OR company_id = $3) RETURNING *`,
      [status, id, companyId]
    );
    return result.rows[0];
  }

  /**
   * Book accepted quantity against a PO line.
   *
   * Writes BOTH receipt columns on purpose. `purchase_order_items` carries
   * `received_quantity` (what GRN has always written, and what this module and
   * the GRN screen read) and `received_qty` (added by the 20260426 module-tables
   * migration and never written by anything). They are not aliases to any
   * reader: mrpEngine.service.js computes open supply as
   * `quantity - COALESCE(received_qty, 0)`, so with that column pinned at 0 the
   * planner counted every fully-received PO line as still inbound forever and
   * under-ordered against phantom stock. Keeping the pair in step here fixes the
   * planner without breaking the readers of either name; migration
   * 20260902000001 backfills the rows that already exist.
   */
  async updateItemReceived(client, itemId, quantity) {
    const result = await client.query(
      `UPDATE purchase_order_items
          SET received_quantity = COALESCE(received_quantity, 0) + $1,
              received_qty      = COALESCE(received_quantity, 0) + $1
        WHERE id = $2 RETURNING *`,
      [quantity, itemId]
    );
    return result.rows[0];
  }

  async getNextNumber(client, companyId = null) {
    return nextPurchaseOrderNumber(client, companyId);
  }

  async getLateDeliveries(companyId) {
    const params = [];
    let filter = '';
    if (companyId) { params.push(companyId); filter = ` AND po.company_id = $${params.length}`; }
    const result = await pool.query(
      `SELECT po.*, COALESCE(v.vendor_name, '') as supplier_name
       FROM purchase_orders po
       LEFT JOIN vendors v ON po.supplier_id = v.id
       WHERE po.expected_delivery_date < CURRENT_DATE
       AND po.status NOT IN ('received', 'completed', 'cancelled')
       AND po.deleted_at IS NULL${filter}
       ORDER BY po.expected_delivery_date`,
      params
    );
    return result.rows;
  }
}

export default new PurchaseOrderRepository();
