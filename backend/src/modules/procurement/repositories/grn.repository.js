import pool from '../../shared/db.js';
import { nextGrnNumber } from '../../../shared/docNumber.js';

class GRNRepository {
  /**
   * `status` and `quality_status` are written EXPLICITLY, never left to the
   * column default.
   *
   * The default was 'draft', and nothing set one — so every receipt the
   * application has ever created was 'draft', a value GoodsReceipt.jsx does not
   * count in its KPI strip, does not offer as a filter tab, and does not render
   * the Confirm button for. The screen looked right only because its badge
   * helper falls back to the "Pending" colour for an unrecognised status. Same
   * failure as purchase_requests.status ('pending' vs 'pending_approval'): a
   * column default silently defining a workflow the product does not speak.
   * See migration 20260903000011 for the vocabulary and its CHECK constraint.
   */
  async create(client, data) {
    const {
      grn_number, po_id, received_by, received_date, warehouse_id, notes, company_id,
      status, quality_status, idempotency_key, vendor_dc_number, vendor_dc_date,
    } = data;
    const result = await client.query(
      `INSERT INTO goods_receipt_notes
         (grn_number, po_id, received_by, received_date, warehouse_id, notes, company_id,
          status, quality_status, idempotency_key, vendor_dc_number, vendor_dc_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [grn_number, po_id, received_by, received_date, warehouse_id, notes, company_id ?? null,
       status || 'pending', quality_status || 'not_required',
       idempotency_key ?? null, vendor_dc_number ?? null, vendor_dc_date ?? null]
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

  /**
   * Tenant-scoped single-record read.
   *
   * Both joins are LEFT. They were inner joins, which made a GRN disappear
   * entirely — read as a 404 by the route — whenever its warehouse row had been
   * removed or `warehouse_id` was never set (the column is nullable and the RTV
   * path does not always populate it). A receipt that exists must be viewable;
   * a missing warehouse is a blank cell, not a missing document.
   */
  async findById(id, companyId = null, client = null) {
    const db = client ?? pool;
    const result = await db.query(
      `SELECT grn.*, po.po_number, w.warehouse_name
       FROM goods_receipt_notes grn
       LEFT JOIN purchase_orders po ON grn.po_id = po.id
       LEFT JOIN warehouses w ON grn.warehouse_id = w.id
       WHERE grn.id = $1 AND grn.deleted_at IS NULL
         AND ($2::int IS NULL OR grn.company_id = $2)`,
      [id, companyId]
    );
    return result.rows[0];
  }

  async getItems(grnId, companyId = null) {
    const result = await pool.query(
      `SELECT gi.*, ii.item_code, ii.item_name, ii.unit_of_measure
       FROM grn_items gi
       JOIN goods_receipt_notes grn ON grn.id = gi.grn_id
       LEFT JOIN inventory_items ii ON gi.item_id = ii.id
       WHERE gi.grn_id = $1 AND ($2::int IS NULL OR grn.company_id = $2)
       ORDER BY gi.created_at`,
      [grnId, companyId]
    );
    return result.rows;
  }

  async getNextNumber(client, companyId = null) {
    return nextGrnNumber(client, companyId);
  }
}

export default new GRNRepository();
