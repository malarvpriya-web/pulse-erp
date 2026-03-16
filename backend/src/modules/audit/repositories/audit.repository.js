import pool from '../../shared/db.js';

const auditRepository = {
  async create(data) {
    const { user_id, module_name, action_type, reference_id, reference_type, old_data_json, new_data_json, ip_address, user_agent } = data;
    const result = await pool.query(
      `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, old_data_json, new_data_json, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [user_id, module_name, action_type, reference_id, reference_type, 
       old_data_json ? JSON.stringify(old_data_json) : null,
       new_data_json ? JSON.stringify(new_data_json) : null,
       ip_address, user_agent]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    let query = `
      SELECT al.*, e.name as user_name
      FROM audit_logs al
      LEFT JOIN employees e ON al.user_id = e.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (filters.user_id) {
      query += ` AND al.user_id = $${paramCount}`;
      params.push(filters.user_id);
      paramCount++;
    }

    if (filters.module_name) {
      query += ` AND al.module_name = $${paramCount}`;
      params.push(filters.module_name);
      paramCount++;
    }

    if (filters.action_type) {
      query += ` AND al.action_type = $${paramCount}`;
      params.push(filters.action_type);
      paramCount++;
    }

    if (filters.start_date && filters.end_date) {
      query += ` AND al.created_at BETWEEN $${paramCount} AND $${paramCount + 1}`;
      params.push(filters.start_date, filters.end_date);
      paramCount += 2;
    }

    query += ` ORDER BY al.created_at DESC LIMIT 100`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findByReference(reference_id, reference_type) {
    const result = await pool.query(
      `SELECT al.*, e.name as user_name
       FROM audit_logs al
       LEFT JOIN employees e ON al.user_id = e.id
       WHERE al.reference_id = $1 AND al.reference_type = $2
       ORDER BY al.created_at DESC`,
      [reference_id, reference_type]
    );
    return result.rows;
  },

  async getActivitySummary(filters = {}) {
    let query = `
      SELECT 
        module_name,
        action_type,
        COUNT(*) as count,
        DATE_TRUNC('day', created_at) as date
      FROM audit_logs
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (filters.start_date && filters.end_date) {
      query += ` AND created_at BETWEEN $${paramCount} AND $${paramCount + 1}`;
      params.push(filters.start_date, filters.end_date);
      paramCount += 2;
    }

    query += ` GROUP BY module_name, action_type, DATE_TRUNC('day', created_at)
               ORDER BY date DESC, count DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  // Helper methods for common audit actions
  async logCreate(user_id, module_name, reference_id, reference_type, new_data, ip_address) {
    return this.create({
      user_id,
      module_name,
      action_type: 'create',
      reference_id,
      reference_type,
      new_data_json: new_data,
      ip_address
    });
  },

  async logUpdate(user_id, module_name, reference_id, reference_type, old_data, new_data, ip_address) {
    return this.create({
      user_id,
      module_name,
      action_type: 'update',
      reference_id,
      reference_type,
      old_data_json: old_data,
      new_data_json: new_data,
      ip_address
    });
  },

  async logDelete(user_id, module_name, reference_id, reference_type, old_data, ip_address) {
    return this.create({
      user_id,
      module_name,
      action_type: 'delete',
      reference_id,
      reference_type,
      old_data_json: old_data,
      ip_address
    });
  }
};

export default auditRepository;
