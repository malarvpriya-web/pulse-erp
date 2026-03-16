import pool from '../../shared/db.js';

class RMIssueRepository {
  async create(client, data) {
    const { issue_number, department_id, issued_by, issue_date, warehouse_id, purpose, notes } = data;
    const result = await client.query(
      `INSERT INTO rm_issues (issue_number, department_id, issued_by, issue_date, warehouse_id, purpose, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [issue_number, department_id, issued_by, issue_date, warehouse_id, purpose, notes]
    );
    return result.rows[0];
  }

  async createItem(client, data) {
    const { issue_id, item_id, quantity, rate, remarks } = data;
    const result = await client.query(
      `INSERT INTO rm_issue_items (issue_id, item_id, quantity, rate, remarks) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [issue_id, item_id, quantity, rate, remarks]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = `SELECT ri.*, w.warehouse_name 
                 FROM rm_issues ri
                 JOIN warehouses w ON ri.warehouse_id = w.id
                 WHERE ri.deleted_at IS NULL`;
    const params = [];
    
    if (filters.department_id) {
      params.push(filters.department_id);
      query += ` AND ri.department_id = $${params.length}`;
    }
    
    query += ' ORDER BY ri.issue_date DESC';
    const result = await pool.query(query, params);
    return result.rows;
  }

  async findById(id) {
    const result = await pool.query(
      `SELECT ri.*, w.warehouse_name 
       FROM rm_issues ri
       JOIN warehouses w ON ri.warehouse_id = w.id
       WHERE ri.id = $1 AND ri.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  }

  async getItems(issueId) {
    const result = await pool.query(
      `SELECT rii.*, ii.item_code, ii.item_name, ii.unit_of_measure 
       FROM rm_issue_items rii
       JOIN inventory_items ii ON rii.item_id = ii.id
       WHERE rii.issue_id = $1 ORDER BY rii.created_at`,
      [issueId]
    );
    return result.rows;
  }

  async getNextNumber() {
    const result = await pool.query(
      `SELECT issue_number FROM rm_issues 
       WHERE issue_number LIKE 'RMI%' 
       ORDER BY issue_number DESC LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return 'RMI0001';
    }
    
    const lastNum = parseInt(result.rows[0].issue_number.replace('RMI', '')) + 1;
    return `RMI${lastNum.toString().padStart(4, '0')}`;
  }

  async getConsumptionTrends(startDate, endDate) {
    const result = await pool.query(
      `SELECT 
        ii.item_code, ii.item_name, ii.item_type,
        SUM(rii.quantity) as total_consumed,
        COUNT(DISTINCT ri.id) as issue_count,
        AVG(rii.quantity) as avg_quantity
       FROM rm_issue_items rii
       JOIN rm_issues ri ON rii.issue_id = ri.id
       JOIN inventory_items ii ON rii.item_id = ii.id
       WHERE ri.issue_date BETWEEN $1 AND $2
       AND ri.deleted_at IS NULL
       GROUP BY ii.item_code, ii.item_name, ii.item_type
       ORDER BY total_consumed DESC`,
      [startDate, endDate]
    );
    return result.rows;
  }
}

export default new RMIssueRepository();
