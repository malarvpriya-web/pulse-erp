import pool from '../../shared/db.js';

const opportunitiesRepository = {
  async create(data) {
    const { lead_id, opportunity_name, expected_value, probability_percentage, expected_closing_date, stage, assigned_to, created_by } = data;
    const result = await pool.query(
      `INSERT INTO opportunities (lead_id, opportunity_name, expected_value, probability_percentage, expected_closing_date, stage, assigned_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [lead_id, opportunity_name, expected_value, probability_percentage, expected_closing_date, stage, assigned_to, created_by]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    let query = `
      SELECT o.*, 
        l.company_name,
        l.contact_person,
        e.name as assigned_to_name
      FROM opportunities o
      LEFT JOIN leads l ON o.lead_id = l.id
      LEFT JOIN employees e ON o.assigned_to = e.id
      WHERE o.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.stage) {
      query += ` AND o.stage = $${paramCount}`;
      params.push(filters.stage);
      paramCount++;
    }

    if (filters.assigned_to) {
      query += ` AND o.assigned_to = $${paramCount}`;
      params.push(filters.assigned_to);
      paramCount++;
    }

    query += ` ORDER BY o.expected_closing_date ASC NULLS LAST`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT o.*, 
        l.company_name,
        l.contact_person,
        l.email,
        l.phone,
        e.name as assigned_to_name
       FROM opportunities o
       LEFT JOIN leads l ON o.lead_id = l.id
       LEFT JOIN employees e ON o.assigned_to = e.id
       WHERE o.id = $1 AND o.deleted_at IS NULL`,
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
      `UPDATE opportunities SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE opportunities SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async getPipelineValue() {
    const result = await pool.query(`
      SELECT 
        stage,
        COUNT(*) as count,
        SUM(expected_value) as total_value,
        AVG(expected_value) as avg_value
      FROM opportunities
      WHERE deleted_at IS NULL AND stage NOT IN ('won', 'lost')
      GROUP BY stage
      ORDER BY 
        CASE stage
          WHEN 'qualification' THEN 1
          WHEN 'proposal' THEN 2
          WHEN 'negotiation' THEN 3
        END
    `);
    return result.rows;
  },

  async getKanbanBoard() {
    const result = await pool.query(`
      SELECT o.*, 
        l.company_name,
        l.contact_person,
        e.name as assigned_to_name
      FROM opportunities o
      LEFT JOIN leads l ON o.lead_id = l.id
      LEFT JOIN employees e ON o.assigned_to = e.id
      WHERE o.deleted_at IS NULL
      ORDER BY o.expected_closing_date ASC NULLS LAST
    `);

    const board = {
      qualification: [],
      proposal: [],
      negotiation: [],
      won: [],
      lost: []
    };

    result.rows.forEach(opp => {
      if (board[opp.stage]) {
        board[opp.stage].push(opp);
      }
    });

    return board;
  },

  async getAverageDealSize() {
    const result = await pool.query(`
      SELECT AVG(expected_value) as avg_deal_size
      FROM opportunities
      WHERE deleted_at IS NULL AND stage = 'won'
    `);
    return result.rows[0];
  }
};

export default opportunitiesRepository;
