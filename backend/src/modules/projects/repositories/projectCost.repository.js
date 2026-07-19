import pool from '../../shared/db.js';

const projectCostRepository = {
  async upsert(project_id, cost_data) {
    const {
      labour_cost, material_cost, expense_cost,
      travel_cost, manufacturing_cost, subcontractor_cost,
      revenue, planned_value, earned_value, actual_cost_evm,
    } = cost_data;

    const total = parseFloat(labour_cost || 0)
      + parseFloat(material_cost || 0)
      + parseFloat(expense_cost || 0)
      + parseFloat(subcontractor_cost || 0);

    const cpi = actual_cost_evm > 0 ? (earned_value || 0) / actual_cost_evm : 1;
    const spi = planned_value > 0 ? (earned_value || 0) / planned_value : 1;
    const profit = (revenue || 0) - total;
    const margin = (revenue || 0) > 0 ? (profit / (revenue || 1)) * 100 : 0;

    const result = await pool.query(
      `INSERT INTO project_cost_summary
         (project_id, labour_cost, material_cost, expense_cost, travel_cost,
          manufacturing_cost, subcontractor_cost, total_cost, revenue, profit,
          margin_pct, planned_value, earned_value, actual_cost_evm,
          cost_performance_index, schedule_performance_index, last_calculated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
       ON CONFLICT (project_id)
       DO UPDATE SET
         labour_cost           = COALESCE($2, project_cost_summary.labour_cost),
         material_cost         = COALESCE($3, project_cost_summary.material_cost),
         expense_cost          = COALESCE($4, project_cost_summary.expense_cost),
         travel_cost           = COALESCE($5, project_cost_summary.travel_cost),
         manufacturing_cost    = COALESCE($6, project_cost_summary.manufacturing_cost),
         subcontractor_cost    = COALESCE($7, project_cost_summary.subcontractor_cost),
         total_cost            = $8,
         revenue               = COALESCE($9, project_cost_summary.revenue),
         profit                = $10,
         margin_pct            = $11,
         planned_value         = COALESCE($12, project_cost_summary.planned_value),
         earned_value          = COALESCE($13, project_cost_summary.earned_value),
         actual_cost_evm       = COALESCE($14, project_cost_summary.actual_cost_evm),
         cost_performance_index       = $15,
         schedule_performance_index   = $16,
         last_calculated_at    = NOW(),
         updated_at            = NOW()
       RETURNING *`,
      [
        project_id,
        labour_cost ?? null, material_cost ?? null, expense_cost ?? null,
        travel_cost ?? null, manufacturing_cost ?? null, subcontractor_cost ?? null,
        total, revenue ?? null, profit, parseFloat(margin.toFixed(2)),
        planned_value ?? null, earned_value ?? null, actual_cost_evm ?? null,
        parseFloat(cpi.toFixed(3)), parseFloat(spi.toFixed(3)),
      ]
    );
    return result.rows[0];
  },

  async findByProject(project_id) {
    const result = await pool.query(
      `SELECT pcs.*,
              p.budget_amount, p.budget,
              COALESCE(p.budget_amount, p.budget, 0) AS contract_value
       FROM project_cost_summary pcs
       JOIN projects p ON p.id = pcs.project_id
       WHERE pcs.project_id = $1`,
      [project_id]
    );
    return result.rows[0] || null;
  },

  async getProjectProfitability(company_id = null) {
    const result = await pool.query(`
      SELECT
        p.id,
        p.project_code,
        p.project_name,
        p.project_type,
        p.status,
        COALESCE(p.budget_amount, p.budget, 0)              AS budget_amount,
        COALESCE(pcs.revenue, 0)                             AS invoiced_revenue,
        COALESCE(pcs.total_cost, 0)                          AS actual_cost,
        COALESCE(pcs.labour_cost, 0)                         AS labour_cost,
        COALESCE(pcs.material_cost, 0)                       AS material_cost,
        COALESCE(pcs.expense_cost, 0)                        AS expense_cost,
        COALESCE(pcs.subcontractor_cost, 0)                  AS subcontractor_cost,
        COALESCE(pcs.profit, 0)                              AS profit,
        COALESCE(pcs.margin_pct, 0)                          AS profit_margin_percentage,
        COALESCE(pcs.cost_performance_index, 1)              AS cpi,
        COALESCE(pcs.schedule_performance_index, 1)          AS spi,
        COALESCE(pcs.earned_value, 0)                        AS earned_value,
        COALESCE(pcs.planned_value, 0)                       AS planned_value,
        COALESCE(p.progress_percentage, 0)                   AS progress_percentage,
        p.start_date, p.end_date,
        p.baseline_start_date, p.baseline_end_date, p.baseline_budget
      FROM projects p
      LEFT JOIN project_cost_summary pcs ON p.id = pcs.project_id
      WHERE p.deleted_at IS NULL
        AND p.status IN ('active', 'completed', 'planning')
        AND ($1::int IS NULL OR p.company_id = $1)
      ORDER BY COALESCE(pcs.margin_pct, 0) ASC
    `, [company_id]);
    return result.rows;
  },

  async updateLabourCost(project_id) {
    // Use project_members.billing_rate if available; else use employee's billing rate
    const labourResult = await pool.query(`
      SELECT COALESCE(SUM(
        te.hours * COALESCE(
          pm.billing_rate,
          (SELECT billing_rate FROM project_members pm2
           WHERE pm2.project_id = $1 AND pm2.employee_id = te.employee_id LIMIT 1),
          500
        )
      ), 0) AS labour_cost
      FROM timesheet_entries te
      LEFT JOIN project_members pm ON pm.project_id = $1 AND pm.employee_id = te.employee_id
      WHERE te.project_id = $1
        AND te.deleted_at IS NULL
    `, [project_id]);

    await this.upsert(project_id, {
      labour_cost: parseFloat(labourResult.rows[0]?.labour_cost || 0),
    });
  },

  async updateEVMMetrics(project_id) {
    // Compute planned value from milestones: SUM of completed milestone amounts × (milestone due / project end)
    // and earned value from task progress
    const evmResult = await pool.query(`
      SELECT
        COALESCE(SUM(
          CASE WHEN pm.status = 'completed' THEN COALESCE(pm.amount, 0) ELSE 0 END
        ), 0) AS earned_value,
        COALESCE(SUM(COALESCE(pm.amount, 0)), 0) AS total_milestone_value
      FROM project_milestones pm
      WHERE pm.project_id = $1
    `, [project_id]);

    const project = await pool.query(
      `SELECT COALESCE(budget_amount, budget, 0) AS budget, progress_percentage, start_date, end_date FROM projects WHERE id=$1`,
      [project_id]
    );

    const budget = parseFloat(project.rows[0]?.budget || 0);
    const progress = parseFloat(project.rows[0]?.progress_percentage || 0);
    const start = project.rows[0]?.start_date;
    const end = project.rows[0]?.end_date;

    let plannedProgress = 0;
    if (start && end) {
      const now = new Date();
      const startD = new Date(start);
      const endD = new Date(end);
      const total = endD - startD;
      const elapsed = Math.min(now - startD, total);
      plannedProgress = total > 0 ? Math.max(0, elapsed / total) * 100 : 0;
    }

    const ev = (progress / 100) * budget;
    const pv = (plannedProgress / 100) * budget;

    await this.upsert(project_id, {
      earned_value: ev,
      planned_value: pv,
    });
  }
};

export default projectCostRepository;
