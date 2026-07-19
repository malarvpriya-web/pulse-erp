import pool from '../../shared/db.js';
import { nextProjectCode } from '../../../shared/docNumber.js';
import { pickUpdatable } from '../../../shared/safeUpdate.js';

const projectRepository = {
  async create(data) {
    const { project_code, project_name, customer_name, start_date, end_date, project_manager_id, status, budget_amount, description, created_by, company_id, opportunity_id,
      project_type, zone, site_address, site_city, site_state, latitude, longitude,
      production_stage, target_date, forecast_date, product_type, product_line_id, billing_type } = data;
    const result = await pool.query(
      `INSERT INTO projects (project_code, project_name, customer_name, start_date, end_date, project_manager_id, status, budget_amount, description, created_by, company_id, opportunity_id,
         project_type, zone, site_address, site_city, site_state, latitude, longitude,
         production_stage, target_date, forecast_date, product_type, product_line_id, billing_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25) RETURNING *`,
      [project_code, project_name, customer_name || null, start_date, end_date || null, project_manager_id || null, status, budget_amount || null, description || null, created_by || null, company_id || null, opportunity_id || null,
        project_type || 'EPC', zone || null, site_address || null, site_city || null, site_state || null,
        (latitude === '' || latitude === undefined ? null : latitude),
        (longitude === '' || longitude === undefined ? null : longitude),
        production_stage || null, target_date || null, forecast_date || null,
        // product_type is the legacy LV/MV/HV class; product_line_id supersedes it
        // and reads COALESCE the two. Both are accepted so older callers still work.
        product_type || null,
        (product_line_id === '' || product_line_id === undefined ? null : product_line_id),
        billing_type || 'fixed']
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    const cid = filters.company_id ?? null;
    let query = `
      SELECT p.*,
        CONCAT(e.first_name, ' ', e.last_name) as manager_name,
        COUNT(DISTINCT t.id) as total_tasks,
        COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) as completed_tasks,
        COALESCE(pcs.total_cost, p.actual_cost, 0) AS actual_cost
      FROM projects p
      LEFT JOIN employees e ON p.project_manager_id = e.id
      LEFT JOIN tasks t ON p.id = t.project_id AND t.deleted_at IS NULL
      LEFT JOIN project_cost_summary pcs ON pcs.project_id = p.id
      WHERE p.deleted_at IS NULL
        AND ($1::int IS NULL OR p.company_id = $1)
    `;
    const params = [cid];
    let paramCount = 2;

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

    query += ` GROUP BY p.id, e.first_name, e.last_name, pcs.total_cost ORDER BY p.created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id, company_id = null) {
    const result = await pool.query(
      `SELECT p.*,
        CONCAT(e.first_name, ' ', e.last_name) as manager_name
       FROM projects p
       LEFT JOIN employees e ON p.project_manager_id = e.id
       WHERE p.id = $1 AND p.deleted_at IS NULL
         AND ($2::int IS NULL OR p.company_id = $2)`,
      [id, company_id]
    );
    return result.rows[0];
  },

  /**
   * @param {number|string} id
   * @param {object} data          caller-supplied payload; filtered by pickUpdatable
   * @param {number|null} company_id  tenant scope. NULL = unscoped, matching
   *   findById and the app-wide `($n::int IS NULL OR company_id = $n)` convention
   *   that lets super_admin (whose req.scope.company_id is null) reach every row.
   *   Callers holding a request MUST pass cid(req) — omitting it updates across
   *   tenants by id.
   */
  async update(id, data, company_id = null) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    // The route calls update(req.params.id, req.body), and `key` is interpolated
    // into the SET clause below rather than bound — so unfiltered it allows both
    // mass assignment (company_id, created_by, deleted_at) and injection of extra
    // assignments. pickUpdatable validates every key against the live `projects`
    // columns minus the protected set. Schema-derived rather than a hand-written
    // list because this table is wide and drifts: a static list silently drops
    // legitimate fields the moment a migration adds one.
    const safe = await pickUpdatable('projects', data);

    Object.keys(safe).forEach(key => {
      fields.push(`${key} = $${paramCount}`);
      values.push(safe[key]);
      paramCount++;
    });

    // Every key was rejected — do not emit `SET updated_at=…` alone, which would
    // silently report success for a write that changed nothing.
    if (!fields.length) return this.findById(id, company_id);

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);          // $paramCount
    values.push(company_id);  // $paramCount + 1

    // Scoped in the statement itself, not only by a findById check in the route:
    // a check-then-act guard is easy to omit (PUT /projects/:id did exactly that)
    // and leaves the write reachable across tenants by id.
    const result = await pool.query(
      `UPDATE projects SET ${fields.join(', ')}
        WHERE id = $${paramCount}
          AND ($${paramCount + 1}::int IS NULL OR company_id = $${paramCount + 1})
        RETURNING *`,
      values
    );
    return result.rows[0];
  },

  /** company_id: NULL = unscoped (super_admin). See update() above. */
  async delete(id, company_id = null) {
    const result = await pool.query(
      `UPDATE projects SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)
        RETURNING id`,
      [id, company_id]
    );
    return result.rows[0];
  },

  async getNextProjectCode(client) {
    return nextProjectCode(client);
  },

  async getDashboard(company_id = null) {
    const cid = company_id ?? null;
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') as active_projects,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_projects,
        COUNT(*) FILTER (WHERE status = 'on_hold') as on_hold_projects,
        SUM(budget_amount) as total_budget
      FROM projects
      WHERE deleted_at IS NULL
        AND ($1::int IS NULL OR company_id = $1)
    `, [cid]);

    const overdueTasks = await pool.query(`
      SELECT COUNT(*) as count
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.due_date < CURRENT_DATE
        AND t.status NOT IN ('done')
        AND t.deleted_at IS NULL
        AND ($1::int IS NULL OR p.company_id = $1)
    `, [cid]);

    return {
      ...stats.rows[0],
      overdue_tasks: overdueTasks.rows[0].count
    };
  }
};

export default projectRepository;
