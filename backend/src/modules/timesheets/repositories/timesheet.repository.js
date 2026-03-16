import pool from '../../shared/db.js';

const timesheetRepository = {
  async create(data) {
    const { employee_id, project_id, task_id, work_date, hours_worked, description, is_billable, status } = data;
    const result = await pool.query(
      `INSERT INTO timesheet_entries (employee_id, project_id, task_id, work_date, hours_worked, description, is_billable, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [employee_id, project_id, task_id, work_date, hours_worked, description, is_billable, status]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    let query = `
      SELECT te.*, 
        e.name as employee_name,
        p.project_name,
        t.task_title
      FROM timesheet_entries te
      LEFT JOIN employees e ON te.employee_id = e.id
      LEFT JOIN projects p ON te.project_id = p.id
      LEFT JOIN tasks t ON te.task_id = t.id
      WHERE te.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.employee_id) {
      query += ` AND te.employee_id = $${paramCount}`;
      params.push(filters.employee_id);
      paramCount++;
    }

    if (filters.project_id) {
      query += ` AND te.project_id = $${paramCount}`;
      params.push(filters.project_id);
      paramCount++;
    }

    if (filters.status) {
      query += ` AND te.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    if (filters.start_date && filters.end_date) {
      query += ` AND te.work_date BETWEEN $${paramCount} AND $${paramCount + 1}`;
      params.push(filters.start_date, filters.end_date);
      paramCount += 2;
    }

    query += ` ORDER BY te.work_date DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT te.*, 
        e.name as employee_name,
        p.project_name,
        t.task_title
       FROM timesheet_entries te
       LEFT JOIN employees e ON te.employee_id = e.id
       LEFT JOIN projects p ON te.project_id = p.id
       LEFT JOIN tasks t ON te.task_id = t.id
       WHERE te.id = $1 AND te.deleted_at IS NULL`,
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
      `UPDATE timesheet_entries SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE timesheet_entries SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async submitWeek(employee_id, week_start, week_end) {
    await pool.query(
      `UPDATE timesheet_entries 
       SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP
       WHERE employee_id = $1 
         AND work_date BETWEEN $2 AND $3 
         AND status = 'draft'`,
      [employee_id, week_start, week_end]
    );
  },

  async approveEntries(ids, approved_by) {
    await pool.query(
      `UPDATE timesheet_entries 
       SET status = 'approved', approved_at = CURRENT_TIMESTAMP, approved_by = $1
       WHERE id = ANY($2)`,
      [approved_by, ids]
    );
  },

  async rejectEntries(ids, approved_by, reason) {
    await pool.query(
      `UPDATE timesheet_entries 
       SET status = 'rejected', approved_by = $1, rejection_reason = $2
       WHERE id = ANY($3)`,
      [approved_by, reason, ids]
    );
  },

  async getWeeklySummary(employee_id, week_start, week_end) {
    const result = await pool.query(`
      SELECT 
        work_date,
        SUM(hours_worked) as total_hours,
        SUM(CASE WHEN is_billable THEN hours_worked ELSE 0 END) as billable_hours,
        SUM(CASE WHEN NOT is_billable THEN hours_worked ELSE 0 END) as non_billable_hours
      FROM timesheet_entries
      WHERE employee_id = $1 
        AND work_date BETWEEN $2 AND $3
        AND deleted_at IS NULL
      GROUP BY work_date
      ORDER BY work_date
    `, [employee_id, week_start, week_end]);
    return result.rows;
  },

  async getUtilization(employee_id, start_date, end_date) {
    const result = await pool.query(`
      SELECT 
        COUNT(DISTINCT work_date) as working_days,
        SUM(hours_worked) as total_hours,
        SUM(CASE WHEN is_billable THEN hours_worked ELSE 0 END) as billable_hours,
        ROUND((SUM(CASE WHEN is_billable THEN hours_worked ELSE 0 END) / NULLIF(SUM(hours_worked), 0) * 100)::numeric, 2) as utilization_percentage
      FROM timesheet_entries
      WHERE employee_id = $1 
        AND work_date BETWEEN $2 AND $3
        AND status = 'approved'
        AND deleted_at IS NULL
    `, [employee_id, start_date, end_date]);
    return result.rows[0];
  },

  async getPendingApprovals(manager_id) {
    const result = await pool.query(`
      SELECT te.*, 
        e.name as employee_name,
        p.project_name
      FROM timesheet_entries te
      JOIN employees e ON te.employee_id = e.id
      JOIN projects p ON te.project_id = p.id
      WHERE te.status = 'submitted'
        AND (p.project_manager_id = $1 OR e.manager_id = $1)
        AND te.deleted_at IS NULL
      ORDER BY te.submitted_at ASC
    `, [manager_id]);
    return result.rows;
  }
};

export default timesheetRepository;
