import pool from '../../shared/db.js';

const salesTargetsRepository = {
  async findAll(filters = {}, companyId = null) {
    const { period_type, period_year, period_value } = filters;
    const params = [companyId];
    let where = `WHERE ($1::int IS NULL OR st.company_id = $1)`;
    let p = 2;

    if (period_type)  { where += ` AND st.period_type = $${p++}`;               params.push(period_type); }
    if (period_year)  { where += ` AND st.period_year = $${p++}`;               params.push(parseInt(period_year)); }
    if (period_value) { where += ` AND st.period_value = $${p++}`;              params.push(parseInt(period_value)); }

    const result = await pool.query(`
      SELECT
        st.id,
        st.period_type,
        st.period_year,
        st.period_value,
        st.target_amount,
        COALESCE(st.achieved_amount, 0)                                       AS achieved_amount,
        st.currency,
        st.notes,
        st.owner_id,
        COALESCE(e.name, CONCAT(e.first_name, ' ', e.last_name))              AS owner_name,
        e.designation,
        ROUND(
          COALESCE(st.achieved_amount, 0) / NULLIF(st.target_amount, 0) * 100,
          1
        )                                                                     AS achievement_pct
      FROM sales_targets st
      JOIN employees e ON e.id = st.owner_id
        AND e.status IN ('active', 'probation')
      ${where}
      ORDER BY achievement_pct DESC NULLS LAST
    `, params);
    return result.rows;
  },

  async getStats(filters = {}, companyId = null) {
    const { period_type, period_year, period_value } = filters;
    const params = [companyId];
    let where = `WHERE ($1::int IS NULL OR st.company_id = $1)`;
    let p = 2;

    if (period_type)  { where += ` AND st.period_type = $${p++}`;  params.push(period_type); }
    if (period_year)  { where += ` AND st.period_year = $${p++}`;  params.push(parseInt(period_year)); }
    if (period_value) { where += ` AND st.period_value = $${p++}`; params.push(parseInt(period_value)); }

    const result = await pool.query(`
      SELECT
        COUNT(DISTINCT st.owner_id)::int                                      AS rep_count,
        COALESCE(SUM(st.target_amount), 0)                                    AS total_target,
        COALESCE(SUM(COALESCE(st.achieved_amount, 0)), 0)                     AS total_achieved,
        ROUND(
          COALESCE(SUM(COALESCE(st.achieved_amount, 0)), 0)
          / NULLIF(SUM(st.target_amount), 0) * 100,
          1
        )                                                                     AS team_achievement_pct
      FROM sales_targets st
      ${where}
    `, params);
    return result.rows[0] || { rep_count: 0, total_target: 0, total_achieved: 0, team_achievement_pct: 0 };
  },

  async upsert(data, companyId) {
    const { owner_id, period_type, period_year, period_value, target_amount, achieved_amount, notes, created_by } = data;
    const result = await pool.query(`
      INSERT INTO sales_targets
        (company_id, owner_id, period_type, period_year, period_value,
         target_amount, achieved_amount, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (company_id, owner_id, period_type, period_year, period_value)
      DO UPDATE SET
        target_amount   = EXCLUDED.target_amount,
        achieved_amount = COALESCE(EXCLUDED.achieved_amount, sales_targets.achieved_amount),
        notes           = EXCLUDED.notes,
        updated_at      = NOW()
      RETURNING *
    `, [
      companyId,
      owner_id,
      period_type,
      parseInt(period_year),
      parseInt(period_value),
      target_amount,
      achieved_amount ?? 0,
      notes || null,
      created_by || null,
    ]);
    return result.rows[0];
  },

  async deleteById(id, companyId) {
    await pool.query(
      `DELETE FROM sales_targets WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [id, companyId]
    );
  },

  // Legacy — used by /analytics/sales-vs-target
  async getSalesVsTarget(companyId) {
    const result = await pool.query(`
      SELECT
        COALESCE(e.name, CONCAT(e.first_name, ' ', e.last_name)) AS employee_name,
        CONCAT(st.period_type, ' ', st.period_year)              AS month,
        st.target_amount,
        COALESCE(st.achieved_amount, 0)                          AS achieved_amount,
        ROUND(
          COALESCE(st.achieved_amount, 0) / NULLIF(st.target_amount, 0) * 100,
          2
        )                                                        AS achievement_percentage
      FROM sales_targets st
      JOIN employees e ON st.owner_id = e.id
      WHERE ($1::int IS NULL OR st.company_id = $1)
      ORDER BY st.period_year DESC, achievement_percentage DESC
    `, [companyId || null]);
    return result.rows;
  },
};

export default salesTargetsRepository;
