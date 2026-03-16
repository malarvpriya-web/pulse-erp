import pool from '../../shared/db.js';

class PurchaseRequestRepository {
  async create(client, data) {
    const { request_number, requested_by_employee_id, department_id, request_date, required_date, notes } = data;
    const result = await client.query(
      `INSERT INTO purchase_requests (request_number, requested_by_employee_id, department_id, request_date, required_date, notes) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [request_number, requested_by_employee_id, department_id, request_date, required_date, notes]
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

  async findAll(filters = {}) {
    let query = `SELECT pr.*, e.first_name, e.last_name 
                 FROM purchase_requests pr
                 LEFT JOIN employees e ON pr.requested_by_employee_id = e.id
                 WHERE pr.deleted_at IS NULL`;
    const params = [];
    
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

  async getItems(prId) {
    const result = await pool.query(
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

  async getNextNumber() {
    const result = await pool.query(
      `SELECT request_number FROM purchase_requests 
       WHERE request_number LIKE 'PR%' 
       ORDER BY request_number DESC LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return 'PR0001';
    }
    
    const lastNum = parseInt(result.rows[0].request_number.replace('PR', '')) + 1;
    return `PR${lastNum.toString().padStart(4, '0')}`;
  }
}

export default new PurchaseRequestRepository();
