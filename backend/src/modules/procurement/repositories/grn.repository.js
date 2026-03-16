import pool from '../../shared/db.js';

class GRNRepository {
  async create(client, data) {
    const { grn_number, po_id, received_by, received_date, warehouse_id, notes } = data;
    const result = await client.query(
      `INSERT INTO goods_receipt_notes (grn_number, po_id, received_by, received_date, warehouse_id, notes) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [grn_number, po_id, received_by, received_date, warehouse_id, notes]
    );
    return result.rows[0];
  }

  async createItem(client, data) {
    const { grn_id, po_item_id, item_id, quantity_received, quantity_rejected, rate, remarks } = data;
    const result = await client.query(
      `INSERT INTO grn_items (grn_id, po_item_id, item_id, quantity_received, quantity_rejected, rate, remarks) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [grn_id, po_item_id, item_id, quantity_received, quantity_rejected, rate, remarks]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = `SELECT grn.*, po.po_number, w.warehouse_name 
                 FROM goods_receipt_notes grn
                 JOIN purchase_orders po ON grn.po_id = po.id
                 JOIN warehouses w ON grn.warehouse_id = w.id
                 WHERE grn.deleted_at IS NULL`;
    const params = [];
    
    if (filters.po_id) {
      params.push(filters.po_id);
      query += ` AND grn.po_id = $${params.length}`;
    }
    
    query += ' ORDER BY grn.received_date DESC';
    const result = await pool.query(query, params);
    return result.rows;
  }

  async findById(id) {
    const result = await pool.query(
      `SELECT grn.*, po.po_number, w.warehouse_name 
       FROM goods_receipt_notes grn
       JOIN purchase_orders po ON grn.po_id = po.id
       JOIN warehouses w ON grn.warehouse_id = w.id
       WHERE grn.id = $1 AND grn.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  }

  async getItems(grnId) {
    const result = await pool.query(
      `SELECT gi.*, ii.item_code, ii.item_name, ii.unit_of_measure 
       FROM grn_items gi
       JOIN inventory_items ii ON gi.item_id = ii.id
       WHERE gi.grn_id = $1 ORDER BY gi.created_at`,
      [grnId]
    );
    return result.rows;
  }

  async getNextNumber() {
    const result = await pool.query(
      `SELECT grn_number FROM goods_receipt_notes 
       WHERE grn_number LIKE 'GRN%' 
       ORDER BY grn_number DESC LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return 'GRN0001';
    }
    
    const lastNum = parseInt(result.rows[0].grn_number.replace('GRN', '')) + 1;
    return `GRN${lastNum.toString().padStart(4, '0')}`;
  }
}

export default new GRNRepository();
