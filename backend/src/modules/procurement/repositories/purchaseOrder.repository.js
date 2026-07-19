import pool from '../../shared/db.js';
import { nextPurchaseOrderNumber } from '../../../shared/docNumber.js';

class PurchaseOrderRepository {
  async create(client, data) {
    const { po_number, pr_id, supplier_id, order_date, expected_delivery_date, subtotal, tax_amount, total_amount, terms_conditions, notes, created_by, company_id } = data;
    const result = await client.query(
      `INSERT INTO purchase_orders (po_number, pr_id, supplier_id, order_date, expected_delivery_date, subtotal, tax_amount, total_amount, terms_conditions, notes, created_by, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [po_number, pr_id ?? null, supplier_id, order_date, expected_delivery_date ?? null, subtotal ?? 0, tax_amount ?? 0, total_amount ?? 0, terms_conditions ?? null, notes ?? null, created_by, company_id ?? null]
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

  async getStats(companyId) {
    const params = companyId ? [companyId] : [];
    const companyFilter = companyId ? 'AND company_id = $1' : '';
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent')                                                      AS pending,
        COUNT(*) FILTER (WHERE status = 'approved')                                                  AS approved,
        COUNT(*) FILTER (WHERE status = 'received')                                                  AS received,
        COUNT(*) FILTER (WHERE status = 'sent' AND created_at < NOW() - INTERVAL '7 days')           AS follow_up,
        COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled')), 0)                    AS total_value,
        COUNT(*)                                                                                      AS total
      FROM purchase_orders
      WHERE deleted_at IS NULL ${companyFilter}
    `, params);
    const s = rows[0];
    return {
      pending:     parseInt(s.pending),
      approved:    parseInt(s.approved),
      received:    parseInt(s.received),
      follow_up:   parseInt(s.follow_up),
      total_value: parseFloat(s.total_value),
      total:       parseInt(s.total),
    };
  }

  async findById(id) {
    const result = await pool.query(
      `SELECT po.*, COALESCE(v.vendor_name, '') as supplier_name, v.email as supplier_email
       FROM purchase_orders po
       LEFT JOIN vendors v ON po.supplier_id = v.id
       WHERE po.id = $1 AND po.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  }

  async getItems(poId) {
    const result = await pool.query(
      `SELECT poi.*, ii.item_code, ii.item_name, ii.unit_of_measure 
       FROM purchase_order_items poi
       JOIN inventory_items ii ON poi.item_id = ii.id
       WHERE poi.po_id = $1 ORDER BY poi.created_at`,
      [poId]
    );
    return result.rows;
  }

  async updateStatus(client, id, status) {
    const result = await client.query(
      'UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [status, id]
    );
    return result.rows[0];
  }

  async updateItemReceived(client, itemId, quantity) {
    const result = await client.query(
      'UPDATE purchase_order_items SET received_quantity = received_quantity + $1 WHERE id = $2 RETURNING *',
      [quantity, itemId]
    );
    return result.rows[0];
  }

  async getNextNumber(client) {
    return nextPurchaseOrderNumber(client);
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
