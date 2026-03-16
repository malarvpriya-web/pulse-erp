import pool from '../../shared/db.js';

const salesTargetsRepository = {
  async upsert(data) {
    const { employee_id, month, target_amount } = data;
    const result = await pool.query(
      `INSERT INTO sales_targets (employee_id, month, target_amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id, month)
       DO UPDATE SET target_amount = $3, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [employee_id, month, target_amount]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    let query = `
      SELECT st.*, e.name as employee_name
      FROM sales_targets st
      JOIN employees e ON st.employee_id = e.id
      WHERE st.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.employee_id) {
      query += ` AND st.employee_id = $${paramCount}`;
      params.push(filters.employee_id);
      paramCount++;
    }

    if (filters.month) {
      query += ` AND st.month = $${paramCount}`;
      params.push(filters.month);
      paramCount++;
    }

    query += ` ORDER BY st.month DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async updateAchieved(employee_id, month, achieved_amount) {
    await pool.query(
      `UPDATE sales_targets SET achieved_amount = $1, updated_at = CURRENT_TIMESTAMP
       WHERE employee_id = $2 AND month = $3`,
      [achieved_amount, employee_id, month]
    );
  },

  async getSalesVsTarget() {
    const result = await pool.query(`
      SELECT 
        e.name as employee_name,
        st.month,
        st.target_amount,
        st.achieved_amount,
        ROUND(((st.achieved_amount / NULLIF(st.target_amount, 0)) * 100)::numeric, 2) as achievement_percentage
      FROM sales_targets st
      JOIN employees e ON st.employee_id = e.id
      WHERE st.deleted_at IS NULL
      ORDER BY st.month DESC, achievement_percentage DESC
    `);
    return result.rows;
  }
};

export default salesTargetsRepository;
