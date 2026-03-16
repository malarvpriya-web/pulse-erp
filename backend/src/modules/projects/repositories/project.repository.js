import pool from '../../shared/db.js';

const projectRepository = {
  async create(data) {
    const { project_code, project_name, customer_id, start_date, end_date, project_manager_id, status, budget_amount, description, created_by } = data;
    const result = await pool.query(
      `INSERT INTO projects (project_code, project_name, customer_id, start_date, end_date, project_manager_id, status, budget_amount, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [project_code, project_name, customer_id, start_date, end_date, project_manager_id, status, budget_amount, description, created_by]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    let query = `
      SELECT p.*, 
        pa.name as customer_name,
        e.name as manager_name,
        COUNT(DISTINCT t.id) as total_tasks,
        COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) as completed_tasks
      FROM projects p
      LEFT JOIN parties pa ON p.customer_id = pa.id
      LEFT JOIN employees e ON p.project_manager_id = e.id
      LEFT JOIN tasks t ON p.id = t.project_id AND t.deleted_at IS NULL
      WHERE p.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.status) {
      query += ` AND p.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    if (filters.project_manager_id) {
      query += ` AND p.project_manager_id = $${paramCount}`;
      params.push(filters.project_manager_id);
      paramCount++;
    }

    query += ` GROUP BY p.id, pa.name, e.name ORDER BY p.created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT p.*, 
        pa.name as customer_name,
        e.name as manager_name
       FROM projects p
       LEFT JOIN parties pa ON p.customer_id = pa.id
       LEFT JOIN employees e ON p.project_manager_id = e.id
       WHERE p.id = $1 AND p.deleted_at IS NULL`,
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
      `UPDATE projects SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async getNextProjectCode() {
    const result = await pool.query(
      `SELECT project_code FROM projects WHERE project_code LIKE 'PRJ-%' ORDER BY created_at DESC LIMIT 1`
    );
    if (result.rows.length === 0) return 'PRJ-0001';
    const lastCode = result.rows[0].project_code;
    const num = parseInt(lastCode.split('-')[1]) + 1;
    return `PRJ-${num.toString().padStart(4, '0')}`;
  },

  async getDashboard() {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'active') as active_projects,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_projects,
        COUNT(*) FILTER (WHERE status = 'on_hold') as on_hold_projects,
        SUM(budget_amount) as total_budget
      FROM projects WHERE deleted_at IS NULL
    `);

    const overdueTasks = await pool.query(`
      SELECT COUNT(*) as count
      FROM tasks 
      WHERE due_date < CURRENT_DATE 
        AND status NOT IN ('done') 
        AND deleted_at IS NULL
    `);

    return {
      ...stats.rows[0],
      overdue_tasks: overdueTasks.rows[0].count
    };
  }
};

export default projectRepository;
