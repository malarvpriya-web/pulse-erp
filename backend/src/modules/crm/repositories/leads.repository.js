import pool from '../../shared/db.js';

const leadsRepository = {
  async create(data) {
    const { lead_source, company_name, contact_person, email, phone, industry, location, assigned_to, status, notes, created_by } = data;
    const result = await pool.query(
      `INSERT INTO leads (lead_source, company_name, contact_person, email, phone, industry, location, assigned_to, status, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [lead_source, company_name, contact_person, email, phone, industry, location, assigned_to, status, notes, created_by]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    let query = `
      SELECT l.*, e.name as assigned_to_name
      FROM leads l
      LEFT JOIN employees e ON l.assigned_to = e.id
      WHERE l.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.status) {
      query += ` AND l.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    if (filters.lead_source) {
      query += ` AND l.lead_source = $${paramCount}`;
      params.push(filters.lead_source);
      paramCount++;
    }

    if (filters.assigned_to) {
      query += ` AND l.assigned_to = $${paramCount}`;
      params.push(filters.assigned_to);
      paramCount++;
    }

    query += ` ORDER BY l.created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT l.*, e.name as assigned_to_name
       FROM leads l
       LEFT JOIN employees e ON l.assigned_to = e.id
       WHERE l.id = $1 AND l.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  async update(id, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(data[key]);
        paramCount++;
      }
    });

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE leads SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE leads SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async getLeadsBySource() {
    const result = await pool.query(`
      SELECT lead_source, COUNT(*) as count
      FROM leads
      WHERE deleted_at IS NULL
      GROUP BY lead_source
      ORDER BY count DESC
    `);
    return result.rows;
  },

  async getConversionRate() {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'converted') as converted,
        COUNT(*) as total,
        ROUND((COUNT(*) FILTER (WHERE status = 'converted')::numeric / NULLIF(COUNT(*), 0) * 100), 2) as conversion_rate
      FROM leads
      WHERE deleted_at IS NULL
    `);
    return result.rows[0];
  },

  async addActivity(data) {
    const { lead_id, activity_type, activity_date, notes, next_followup_date, created_by } = data;
    const result = await pool.query(
      `INSERT INTO lead_activities (lead_id, activity_type, activity_date, notes, next_followup_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [lead_id, activity_type, activity_date, notes, next_followup_date, created_by]
    );
    return result.rows[0];
  },

  async getActivities(lead_id) {
    const result = await pool.query(
      `SELECT la.*, e.name as created_by_name
       FROM lead_activities la
       LEFT JOIN employees e ON la.created_by = e.id
       WHERE la.lead_id = $1 AND la.deleted_at IS NULL
       ORDER BY la.activity_date DESC`,
      [lead_id]
    );
    return result.rows;
  }
};

export default leadsRepository;
