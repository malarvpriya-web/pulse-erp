import pool from '../../shared/db.js';

const performanceRepository = {
  // Goals
  async createGoal(data) {
    const { employee_id, review_period, goal_title, goal_description, target_value, weightage } = data;
    const result = await pool.query(
      `INSERT INTO performance_goals (employee_id, review_period, goal_title, goal_description, target_value, weightage)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [employee_id, review_period, goal_title, goal_description, target_value, weightage]
    );
    return result.rows[0];
  },

  async findGoals(filters = {}) {
    let query = `SELECT pg.*, e.name as employee_name FROM performance_goals pg
                 JOIN employees e ON pg.employee_id = e.id
                 WHERE pg.deleted_at IS NULL`;
    const params = [];
    let paramCount = 1;

    if (filters.employee_id) {
      query += ` AND pg.employee_id = $${paramCount}`;
      params.push(filters.employee_id);
      paramCount++;
    }

    if (filters.review_period) {
      query += ` AND pg.review_period = $${paramCount}`;
      params.push(filters.review_period);
      paramCount++;
    }

    query += ` ORDER BY pg.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async updateGoal(id, data) {
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
      `UPDATE performance_goals SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  // Reviews
  async createReview(data) {
    const { employee_id, review_period, review_type } = data;
    const result = await pool.query(
      `INSERT INTO performance_reviews (employee_id, review_period, review_type)
       VALUES ($1, $2, $3) RETURNING *`,
      [employee_id, review_period, review_type]
    );
    return result.rows[0];
  },

  async findReviews(filters = {}) {
    let query = `
      SELECT pr.*, 
        e.name as employee_name,
        m.name as manager_name
      FROM performance_reviews pr
      JOIN employees e ON pr.employee_id = e.id
      LEFT JOIN employees m ON pr.manager_id = m.id
      WHERE pr.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.employee_id) {
      query += ` AND pr.employee_id = $${paramCount}`;
      params.push(filters.employee_id);
      paramCount++;
    }

    if (filters.manager_id) {
      query += ` AND pr.manager_id = $${paramCount}`;
      params.push(filters.manager_id);
      paramCount++;
    }

    if (filters.status) {
      query += ` AND pr.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    query += ` ORDER BY pr.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findReviewById(id) {
    const result = await pool.query(
      `SELECT pr.*, 
        e.name as employee_name,
        m.name as manager_name
       FROM performance_reviews pr
       JOIN employees e ON pr.employee_id = e.id
       LEFT JOIN employees m ON pr.manager_id = m.id
       WHERE pr.id = $1 AND pr.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  async updateReview(id, data) {
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
      `UPDATE performance_reviews SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async submitSelfReview(id, data) {
    const { self_rating, self_comments, achievements, challenges } = data;
    const result = await pool.query(
      `UPDATE performance_reviews 
       SET self_rating = $1, self_comments = $2, achievements = $3, challenges = $4,
           self_submitted_at = CURRENT_TIMESTAMP, status = 'self_submitted'
       WHERE id = $5 RETURNING *`,
      [self_rating, self_comments, achievements, challenges, id]
    );
    return result.rows[0];
  },

  async submitManagerReview(id, data) {
    const { manager_id, manager_rating, manager_comments, promotion_recommendation, salary_revision_percentage, final_rating } = data;
    const result = await pool.query(
      `UPDATE performance_reviews 
       SET manager_id = $1, manager_rating = $2, manager_comments = $3, 
           promotion_recommendation = $4, salary_revision_percentage = $5, final_rating = $6,
           manager_submitted_at = CURRENT_TIMESTAMP, status = 'completed'
       WHERE id = $7 RETURNING *`,
      [manager_id, manager_rating, manager_comments, promotion_recommendation, salary_revision_percentage, final_rating, id]
    );
    return result.rows[0];
  },

  // Analytics
  async getTopPerformers(limit = 10) {
    const result = await pool.query(`
      SELECT 
        e.id,
        e.name,
        e.department,
        AVG(pr.final_rating) as avg_rating,
        COUNT(pr.id) as review_count
      FROM employees e
      JOIN performance_reviews pr ON e.id = pr.employee_id
      WHERE pr.status = 'completed' AND pr.deleted_at IS NULL
      GROUP BY e.id, e.name, e.department
      HAVING AVG(pr.final_rating) >= 4.0
      ORDER BY avg_rating DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  },

  async getDepartmentPerformance() {
    const result = await pool.query(`
      SELECT 
        e.department,
        COUNT(DISTINCT e.id) as employee_count,
        AVG(pr.final_rating) as avg_rating,
        COUNT(pr.id) FILTER (WHERE pr.promotion_recommendation = true) as promotion_recommendations
      FROM employees e
      LEFT JOIN performance_reviews pr ON e.id = pr.employee_id AND pr.status = 'completed' AND pr.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
      GROUP BY e.department
      ORDER BY avg_rating DESC NULLS LAST
    `);
    return result.rows;
  },

  async getGoalCompletionRate() {
    const result = await pool.query(`
      SELECT 
        review_period,
        COUNT(*) as total_goals,
        COUNT(*) FILTER (WHERE status = 'achieved') as achieved_goals,
        ROUND((COUNT(*) FILTER (WHERE status = 'achieved')::numeric / COUNT(*) * 100), 2) as completion_rate
      FROM performance_goals
      WHERE deleted_at IS NULL
      GROUP BY review_period
      ORDER BY review_period DESC
    `);
    return result.rows;
  }
};

export default performanceRepository;
