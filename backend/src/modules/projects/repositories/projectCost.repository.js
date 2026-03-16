import pool from '../../shared/db.js';

const projectCostRepository = {
  async upsert(project_id, cost_data) {
    const { labour_cost, material_cost, expense_cost } = cost_data;
    const result = await pool.query(
      `INSERT INTO project_cost_summary (project_id, labour_cost, material_cost, expense_cost)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id) 
       DO UPDATE SET 
         labour_cost = COALESCE($2, project_cost_summary.labour_cost),
         material_cost = COALESCE($3, project_cost_summary.material_cost),
         expense_cost = COALESCE($4, project_cost_summary.expense_cost),
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [project_id, labour_cost, material_cost, expense_cost]
    );
    return result.rows[0];
  },

  async findByProject(project_id) {
    const result = await pool.query(
      `SELECT * FROM project_cost_summary WHERE project_id = $1`,
      [project_id]
    );
    return result.rows[0];
  },

  async getProjectProfitability() {
    const result = await pool.query(`
      SELECT 
        p.id,
        p.project_code,
        p.project_name,
        p.budget_amount,
        COALESCE(pcs.total_cost, 0) as actual_cost,
        p.budget_amount - COALESCE(pcs.total_cost, 0) as profit,
        CASE 
          WHEN p.budget_amount > 0 THEN 
            ROUND(((p.budget_amount - COALESCE(pcs.total_cost, 0)) / p.budget_amount * 100)::numeric, 2)
          ELSE 0 
        END as profit_margin_percentage
      FROM projects p
      LEFT JOIN project_cost_summary pcs ON p.id = pcs.project_id
      WHERE p.deleted_at IS NULL AND p.status IN ('active', 'completed')
      ORDER BY profit DESC
    `);
    return result.rows;
  },

  async updateLabourCost(project_id) {
    const labourCost = await pool.query(`
      SELECT COALESCE(SUM(te.hours_worked * 50), 0) as labour_cost
      FROM timesheet_entries te
      WHERE te.project_id = $1 AND te.status = 'approved' AND te.deleted_at IS NULL
    `, [project_id]);

    await this.upsert(project_id, { labour_cost: labourCost.rows[0].labour_cost });
  }
};

export default projectCostRepository;
