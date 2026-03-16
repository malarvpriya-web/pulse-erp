import pool from '../../shared/db.js';

class PurchaseOrderRepository {
  async create(client, data) {
    const { po_number, pr_id, supplier_id, order_date, expected_delivery_date, subtotal, tax_amount, total_amount, terms_conditions, notes, created_by } = data;
    const result = await client.query(
      `INSERT INTO purchase_orders (po_number, pr_id, supplier_id, order_date, expected_delivery_date, subtotal, tax_amount, total_amount, terms_conditions, notes, created_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [po_number, pr_id, supplier_id, order_date, expected_delivery_date, subtotal, tax_amount, total_amount, terms_conditions, notes, created_by]
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
    let query = `SELECT po.*, p.name as supplier_name 
                 FROM purchase_orders po
                 JOIN parties p ON po.supplier_id = p.id
                 WHERE po.deleted_at IS NULL`;
    const params = [];
    
    if (filters.status) {
      params.push(filters.status);
      query += ` AND po.status = $${params.length}`;
    }
    
    if (filters.supplier_id) {
      params.push(filters.supplier_id);
      query += ` AND po.supplier_id = $${params.length}`;
    }
    
    query += ' ORDER BY po.order_date DESC';
    const result = await pool.query(query, params);
    return result.rows;
  }

  async findById(id) {
    const result = await pool.query(
      `SELECT po.*, p.name as supplier_name, p.email as supplier_email 
       FROM purchase_orders po
       JOIN parties p ON po.supplier_id = p.id
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

  async getNextNumber() {
    const result = await pool.query(
      `SELECT po_number FROM purchase_orders 
       WHERE po_number LIKE 'PO%' 
       ORDER BY po_number DESC LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return 'PO0001';
    }
    
    const lastNum = parseInt(result.rows[0].po_number.replace('PO', '')) + 1;
    return `PO${lastNum.toString().padStart(4, '0')}`;
  }

  async getLateDeliveries() {
    const result = await pool.query(
      `SELECT po.*, p.name as supplier_name 
       FROM purchase_orders po
       JOIN parties p ON po.supplier_id = p.id
       WHERE po.expected_delivery_date < CURRENT_DATE 
       AND po.status NOT IN ('completed', 'cancelled')
       AND po.deleted_at IS NULL
       ORDER BY po.expected_delivery_date`
    );
    return result.rows;
  }
}

export default new PurchaseOrderRepository();
