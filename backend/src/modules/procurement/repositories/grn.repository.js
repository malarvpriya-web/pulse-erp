import pool from '../../shared/db.js';
import { nextGrnNumber } from '../../../shared/docNumber.js';

class GRNRepository {
  async create(client, data) {
    const { grn_number, po_id, received_by, received_date, warehouse_id, notes, company_id } = data;
    const result = await client.query(
      `INSERT INTO goods_receipt_notes (grn_number, po_id, received_by, received_date, warehouse_id, notes, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [grn_number, po_id, received_by, received_date, warehouse_id, notes, company_id ?? null]
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
    let query = `SELECT grn.*, po.po_number, COALESCE(w.warehouse_name, '') AS warehouse_name
                 FROM goods_receipt_notes grn
                 JOIN purchase_orders po ON grn.po_id = po.id
                 LEFT JOIN warehouses w ON grn.warehouse_id = w.id
                 WHERE grn.deleted_at IS NULL`;
    const params = [];

    if (filters.company_id) {
      params.push(filters.company_id);
      query += ` AND grn.company_id = $${params.length}`;
    }

    if (filters.po_id) {
      params.push(filters.po_id);
      query += ` AND grn.po_id = $${params.length}`;
    }

    if (filters.vendor_id) {
      params.push(filters.vendor_id);
      query += ` AND po.supplier_id = $${params.length}`;
    }

    if (filters.from_date) {
      params.push(filters.from_date);
      query += ` AND grn.received_date >= $${params.length}`;
    }

    if (filters.to_date) {
      params.push(filters.to_date);
      query += ` AND grn.received_date <= $${params.length}`;
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

  async getNextNumber(client) {
    return nextGrnNumber(client);
  }
}

export default new GRNRepository();
