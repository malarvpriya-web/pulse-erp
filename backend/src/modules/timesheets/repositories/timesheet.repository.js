import pool from '../../shared/db.js';
import { pickUpdatable } from '../../../shared/safeUpdate.js';

const timesheetRepository = {
  async create(data) {
    const { employee_id, project_id, task_id, work_date, hours_worked, description, is_billable, status, company_id } = data;
    // entry_date is the table's NOT NULL legacy date column (no default, no
    // trigger); it was never set here, so every create failed with 23502 and
    // POST /timesheets + clock-out had never saved an entry. It mirrors work_date.
    const result = await pool.query(
      `INSERT INTO timesheet_entries (employee_id, project_id, task_id, work_date, entry_date, hours_worked, description, is_billable, status, company_id)
       VALUES ($1, $2, $3, $4::date, $4::date, $5, $6, $7, $8, $9) RETURNING *`,
      [employee_id, project_id, task_id, work_date, hours_worked, description, is_billable, status, company_id ?? null]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    let query = `
      SELECT te.*,
        e.name as employee_name,
        e.department,
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

    if (filters.company_id) {
      query += ` AND te.company_id = $${paramCount}`;
      params.push(filters.company_id);
      paramCount++;
    }

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

  /**
   * Approved hours drive the project labour-cost rollup, so an unscoped write
   * here moves another tenant's cost, profit and margin figures. Unlike `tasks`,
   * timesheet_entries carries its own company_id, so scoping is direct.
   *
   * Callers MUST pass the caller's company (cid(req)); the null default is a
   * genuinely global super-admin scope, not "unknown".
   */
  async findById(id, company_id = null) {
    const result = await pool.query(
      `SELECT te.*,
        e.name as employee_name,
        e.department,
        p.project_name,
        t.task_title
       FROM timesheet_entries te
       LEFT JOIN employees e ON te.employee_id = e.id
       LEFT JOIN projects p ON te.project_id = p.id
       LEFT JOIN tasks t ON te.task_id = t.id
       WHERE te.id = $1 AND te.deleted_at IS NULL
         AND ($2::int IS NULL OR te.company_id = $2)`,
      [id, company_id ?? null]
    );
    return result.rows[0];
  },

  async update(id, data, company_id = null) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    // The route calls update(req.params.id, req.body), and `key` is interpolated
    // into the SET clause below rather than bound — so unfiltered it allows both
    // mass assignment (company_id, created_by, deleted_at) and injection of extra
    // assignments. pickUpdatable validates every key against the live
    // `timesheet_entries` columns minus the protected set.
    const safe = await pickUpdatable('timesheet_entries', data);

    Object.keys(safe).forEach(key => {
      fields.push(`${key} = $${paramCount}`);
      values.push(safe[key]);
      paramCount++;
    });

    // Every key was rejected — don't emit `SET updated_at=…` alone, which would
    // report success for a write that changed nothing.
    if (!fields.length) return this.findById(id, company_id);

    // NO `updated_at` here: timesheet_entries genuinely has no such column
    // (tasks does, which is where this line was copied from). Appending it made
    // every PUT /timesheets/:id fail with `42703 column "updated_at" ... does
    // not exist`, so this endpoint has never once updated a row. The
    // `!fields.length` guard above already stops an empty SET.
    values.push(id);
    values.push(company_id ?? null);
    const idParam = paramCount;
    const cidParam = paramCount + 1;

    const result = await pool.query(
      `UPDATE timesheet_entries SET ${fields.join(', ')}
        WHERE id = $${idParam} AND deleted_at IS NULL
          AND ($${cidParam}::int IS NULL OR company_id = $${cidParam})
        RETURNING *`,
      values
    );
    return result.rows[0];
  },

  /** True when a row was actually soft-deleted — false for an absent, already
   *  deleted, or other-tenant id, so the route can answer 404 rather than a
   *  false "deleted". */
  async delete(id, company_id = null) {
    const result = await pool.query(
      `UPDATE timesheet_entries SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL
          AND ($2::int IS NULL OR company_id = $2)
        RETURNING id`,
      [id, company_id ?? null]
    );
    return result.rowCount > 0;
  },

  async submitWeek(employee_id, week_start, week_end, company_id = null) {
    const result = await pool.query(
      `UPDATE timesheet_entries 
       SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP
       WHERE employee_id = $1 
         AND work_date BETWEEN $2 AND $3 
         AND status = 'draft'
         AND deleted_at IS NULL
         AND ($4::int IS NULL OR company_id = $4)`,
      [employee_id, week_start, week_end, company_id ?? null]
    );
    return result.rowCount;
  },

  /** Returns the rows actually approved, so the caller recalculates cost for
   *  exactly the affected projects rather than reporting success for rows it
   *  never touched. */
  async approveEntries(ids, approved_by, company_id = null) {
    const result = await pool.query(
      `UPDATE timesheet_entries 
       SET status = 'approved', approved_at = CURRENT_TIMESTAMP, approved_by = $1
       WHERE id = ANY($2)
         AND status = 'submitted'
         AND deleted_at IS NULL
         AND ($3::int IS NULL OR company_id = $3)
       RETURNING id, project_id`,
      [approved_by, ids, company_id ?? null]
    );
    return result.rows;
  },

  async rejectEntries(ids, approved_by, reason, company_id = null) {
    const result = await pool.query(
      `UPDATE timesheet_entries 
       SET status = 'rejected', approved_by = $1, rejection_reason = $2
       WHERE id = ANY($3)
         AND status = 'submitted'
         AND deleted_at IS NULL
         AND ($4::int IS NULL OR company_id = $4)
       RETURNING id, project_id`,
      [approved_by, reason, ids, company_id ?? null]
    );
    return result.rows;
  },

  async getWeeklySummary(employee_id, week_start, week_end, company_id = null) {
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
        AND ($4::int IS NULL OR company_id = $4)
      GROUP BY work_date
      ORDER BY work_date
    `, [employee_id, week_start, week_end, company_id ?? null]);
    return result.rows;
  },

  async getUtilization(employee_id, start_date, end_date, company_id = null) {
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
        AND ($4::int IS NULL OR company_id = $4)
    `, [employee_id, start_date, end_date, company_id ?? null]);
    return result.rows[0];
  },

  async getPendingApprovals(manager_id, company_id = null) {
    const result = await pool.query(`
      SELECT te.*, 
        e.name as employee_name,
        p.project_name
      FROM timesheet_entries te
      JOIN employees e ON te.employee_id = e.id
      JOIN projects p ON te.project_id = p.id
      WHERE te.status = 'submitted'
        AND (p.project_manager_id = $1 OR e.reporting_manager_id = $1)
        AND te.deleted_at IS NULL
        AND ($2::int IS NULL OR te.company_id = $2)
      ORDER BY te.submitted_at ASC
    `, [manager_id, company_id ?? null]);
    return result.rows;
  }
};

export default timesheetRepository;
