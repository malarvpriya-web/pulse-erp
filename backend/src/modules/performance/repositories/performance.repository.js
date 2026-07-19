import pool from '../../shared/db.js';

/* ── helper ── */
function cidWhere(companyId, params, alias = '') {
  if (!companyId) return '';
  const col = alias ? `${alias}.company_id` : 'company_id';
  params.push(companyId);
  return ` AND ${col} = $${params.length}`;
}

const performanceRepository = {
  /* ───────── Goals ───────── */
  async createGoal(data) {
    const {
      employee_id, review_period, goal_title, goal_description,
      target_value, weightage, priority, category, due_date,
      unit, goal_type, parent_goal_id, department_id, cycle_id, company_id,
    } = data;
    const result = await pool.query(
      `INSERT INTO performance_goals
         (employee_id, review_period, goal_title, goal_description, target_value,
          weightage, priority, category, due_date, unit, goal_type,
          parent_goal_id, department_id, cycle_id, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [employee_id, review_period, goal_title, goal_description,
       target_value, weightage, priority || 'Medium', category || null,
       due_date || null, unit || null, goal_type || 'individual',
       parent_goal_id || null, department_id || null, cycle_id || null, company_id]
    );
    return result.rows[0];
  },

  async findGoals(filters = {}) {
    const params = [];
    let where = 'WHERE pg.deleted_at IS NULL';
    where += cidWhere(filters.company_id, params, 'pg');
    if (filters.employee_id)   { params.push(filters.employee_id);   where += ` AND pg.employee_id=$${params.length}`; }
    if (filters.review_period) { params.push(filters.review_period); where += ` AND pg.review_period=$${params.length}`; }
    if (filters.goal_type)     { params.push(filters.goal_type);     where += ` AND pg.goal_type=$${params.length}`; }
    if (filters.department_id) { params.push(filters.department_id); where += ` AND pg.department_id=$${params.length}`; }
    const result = await pool.query(
      `SELECT pg.*, e.name AS employee_name
       FROM performance_goals pg
       JOIN employees e ON pg.employee_id = e.id
       ${where}
       ORDER BY pg.created_at DESC`,
      params
    );
    return result.rows;
  },

  async updateGoal(id, data) {
    const fields = [];
    const values = [];
    let n = 1;
    const allowed = [
      'goal_title','goal_description','target_value','achieved_value',
      'weightage','priority','category','due_date','unit','status',
      'progress_pct','goal_type','parent_goal_id',
    ];
    for (const key of allowed) {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${n++}`);
        values.push(data[key]);
      }
    }
    if (!fields.length) return null;
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    const result = await pool.query(
      `UPDATE performance_goals SET ${fields.join(', ')} WHERE id = $${n} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  /* ───────── Reviews ───────── */
  async createReview(data) {
    const {
      employee_id, review_period, review_type, manager_id,
      review_cycle_id, company_id,
    } = data;
    const result = await pool.query(
      `INSERT INTO performance_reviews
         (employee_id, review_period, review_type, manager_id, review_cycle_id, company_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [employee_id, review_period, review_type || 'annual',
       manager_id || null, review_cycle_id || null, company_id]
    );
    return result.rows[0];
  },

  async findReviews(filters = {}) {
    const params = [];
    let where = 'WHERE pr.deleted_at IS NULL';
    where += cidWhere(filters.company_id, params, 'pr');
    if (filters.employee_id)      { params.push(filters.employee_id);      where += ` AND pr.employee_id=$${params.length}`; }
    if (filters.manager_id)       { params.push(filters.manager_id);       where += ` AND pr.manager_id=$${params.length}`; }
    if (filters.status)           { params.push(filters.status);           where += ` AND pr.status=$${params.length}`; }
    if (filters.review_cycle_id)  { params.push(filters.review_cycle_id);  where += ` AND pr.review_cycle_id=$${params.length}`; }
    const result = await pool.query(
      `SELECT pr.*,
         e.name AS employee_name,
         m.name AS manager_name,
         rc.name AS cycle_name
       FROM performance_reviews pr
       JOIN employees e ON pr.employee_id = e.id
       LEFT JOIN employees m ON pr.manager_id = m.id
       LEFT JOIN review_cycles rc ON pr.review_cycle_id = rc.id
       ${where}
       ORDER BY pr.created_at DESC`,
      params
    );
    return result.rows;
  },

  async findReviewById(id, companyId) {
    const params = [id];
    let where = 'WHERE pr.id = $1 AND pr.deleted_at IS NULL';
    if (companyId) { params.push(companyId); where += ` AND pr.company_id=$2`; }
    const result = await pool.query(
      `SELECT pr.*,
         e.name AS employee_name,
         m.name AS manager_name,
         rc.name AS cycle_name
       FROM performance_reviews pr
       JOIN employees e ON pr.employee_id = e.id
       LEFT JOIN employees m ON pr.manager_id = m.id
       LEFT JOIN review_cycles rc ON pr.review_cycle_id = rc.id
       ${where}`,
      params
    );
    return result.rows[0];
  },

  async updateReview(id, data) {
    const fields = [];
    const values = [];
    let n = 1;
    const allowed = [
      'self_rating','self_comments','achievements','challenges','learnings','next_goals',
      'manager_rating','manager_comments','final_rating','calibrated_rating',
      'kra_score','behavioral_score','promotion_recommendation',
      'salary_revision_percentage','status','review_period','review_type',
    ];
    for (const key of allowed) {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${n++}`);
        values.push(data[key]);
      }
    }
    if (!fields.length) return null;
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    const result = await pool.query(
      `UPDATE performance_reviews SET ${fields.join(', ')} WHERE id = $${n} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  /* ───────── Analytics ───────── */
  async getTopPerformers(limit = 10, companyId) {
    const params = [Number(limit)];
    const cw = cidWhere(companyId, params, 'pr');
    const result = await pool.query(`
      SELECT
        e.id, e.name, e.department, e.designation,
        ROUND(AVG(COALESCE(pr.calibrated_rating, pr.final_rating))::numeric, 2) AS avg_rating,
        COUNT(pr.id) AS review_count
      FROM employees e
      JOIN performance_reviews pr ON e.id = pr.employee_id
      WHERE pr.status = 'completed' AND pr.deleted_at IS NULL${cw}
      GROUP BY e.id, e.name, e.department, e.designation
      HAVING AVG(COALESCE(pr.calibrated_rating, pr.final_rating)) >= 4.0
      ORDER BY avg_rating DESC
      LIMIT $1
    `, params);
    return result.rows;
  },

  async getDepartmentPerformance(companyId) {
    const params = [];
    const cw_pr = cidWhere(companyId, params, 'pr');
    const cw_e  = companyId ? ` AND e.company_id=$${params.length}` : '';
    const result = await pool.query(`
      SELECT
        e.department,
        COUNT(DISTINCT e.id)::int AS employee_count,
        ROUND(AVG(COALESCE(pr.calibrated_rating, pr.final_rating))::numeric, 2) AS avg_rating,
        COUNT(pr.id) FILTER (WHERE pr.promotion_recommendation = true)::int AS promotion_recommendations
      FROM employees e
      LEFT JOIN performance_reviews pr
        ON e.id = pr.employee_id
        AND pr.status = 'completed'
        AND pr.deleted_at IS NULL${cw_pr}
      WHERE e.deleted_at IS NULL${cw_e}
      GROUP BY e.department
      ORDER BY avg_rating DESC NULLS LAST
    `, params);
    return result.rows;
  },

  async getGoalCompletionRate(companyId) {
    const params = [];
    const cw = cidWhere(companyId, params);
    const result = await pool.query(`
      SELECT
        review_period,
        COUNT(*)::int AS total_goals,
        COUNT(*) FILTER (WHERE status = 'achieved')::int AS achieved_goals,
        ROUND(
          (COUNT(*) FILTER (WHERE status = 'achieved')::numeric / NULLIF(COUNT(*), 0) * 100),
          2
        ) AS completion_rate
      FROM performance_goals
      WHERE deleted_at IS NULL${cw}
      GROUP BY review_period
      ORDER BY review_period DESC
    `, params);
    return result.rows;
  },
};

export default performanceRepository;
