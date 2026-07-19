import pool from '../../shared/db.js';
import { nextPurchaseRequestNumber } from '../../../shared/docNumber.js';

class PurchaseRequestRepository {
  async create(client, data) {
    const { request_number, requested_by_employee_id, department_id, department, request_date, required_date, notes, company_id } = data;
    const result = await client.query(
      `INSERT INTO purchase_requests (request_number, requested_by_employee_id, department_id, department, request_date, required_date, notes, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [request_number, requested_by_employee_id, department_id ?? null, department ?? null, request_date, required_date, notes, company_id ?? null]
    );
    return result.rows[0];
  }

  async createItem(client, data) {
    const { pr_id, item_id, item_name, quantity, expected_price, required_date, remarks } = data;
    const result = await client.query(
      `INSERT INTO purchase_request_items (pr_id, item_id, item_name, quantity, expected_price, required_date, remarks)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [pr_id, item_id, item_name, quantity, expected_price, required_date, remarks]
    );
    return result.rows[0];
  }

  // Recompute and persist the header total from the current line items.
  // The header total drives amount-based approval routing (L1/L2/CFO) and all
  // PR value reporting — it MUST reflect SUM(quantity * expected_price), never
  // be left at the column default of 0. Call inside the create/edit transaction
  // after the line items have been written.
  async recomputeTotal(client, prId) {
    const db = client ?? pool;
    const result = await db.query(
      `UPDATE purchase_requests
       SET total_amount = COALESCE((
             SELECT SUM(COALESCE(quantity, 0) * COALESCE(expected_price, 0))
             FROM purchase_request_items WHERE pr_id = $1
           ), 0),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING total_amount`,
      [prId]
    );
    return parseFloat(result.rows[0]?.total_amount ?? 0);
  }

  async findAll(filters = {}) {
    const cid = filters.company_id != null ? filters.company_id : null;
    let query = `SELECT pr.*, e.first_name, e.last_name
                 FROM purchase_requests pr
                 LEFT JOIN employees e ON pr.requested_by_employee_id = e.id
                 WHERE pr.deleted_at IS NULL`;
    const params = [];

    if (cid != null) {
      params.push(cid);
      query += ` AND e.company_id = $${params.length}`;
    }

    if (filters.status) {
      params.push(filters.status);
      query += ` AND pr.status = $${params.length}`;
    }

    if (filters.requested_by) {
      params.push(filters.requested_by);
      query += ` AND pr.requested_by_employee_id = $${params.length}`;
    }

    query += ' ORDER BY pr.request_date DESC';
    const result = await pool.query(query, params);
    return result.rows;
  }

  async findById(id) {
    const result = await pool.query(
      `SELECT pr.*, e.first_name, e.last_name 
       FROM purchase_requests pr
       LEFT JOIN employees e ON pr.requested_by_employee_id = e.id
       WHERE pr.id = $1 AND pr.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  }

  // Pass the active transaction client when reading inside a transaction (e.g.
  // convert-to-po); a pool read would use a different connection/snapshot and
  // silently miss uncommitted rows.
  async getItems(prId, client = null) {
    const db = client ?? pool;
    const result = await db.query(
      `SELECT pri.*, ii.item_code, ii.unit_of_measure
       FROM purchase_request_items pri
       LEFT JOIN inventory_items ii ON pri.item_id = ii.id
       WHERE pri.pr_id = $1 ORDER BY pri.created_at`,
      [prId]
    );
    return result.rows;
  }

  async updateStatus(client, id, status, userId = null) {
    let query = 'UPDATE purchase_requests SET status = $1, updated_at = CURRENT_TIMESTAMP';
    const params = [status, id];
    
    if (status === 'approved' && userId) {
      query += ', approved_by = $3, approved_at = CURRENT_TIMESTAMP';
      params.push(userId);
    }
    
    query += ' WHERE id = $2 RETURNING *';
    const result = await client.query(query, params);
    return result.rows[0];
  }

  async getNextNumber(client) {
    return nextPurchaseRequestNumber(client);
  }
}

export default new PurchaseRequestRepository();
