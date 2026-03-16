import pool from '../../shared/db.js';

const leavesRepository = {
  async getLeaveTypes() {
    const result = await pool.query(
      `SELECT * FROM leave_types WHERE deleted_at IS NULL AND is_active = true ORDER BY leave_name`
    );
    return result.rows;
  },

  async getLeaveBalance(employee_id, year) {
    const result = await pool.query(`
      SELECT lb.*, lt.leave_name, lt.leave_code
      FROM leave_balances lb
      JOIN leave_types lt ON lb.leave_type_id = lt.id
      WHERE lb.employee_id = $1 AND lb.year = $2
      ORDER BY lt.leave_name
    `, [employee_id, year || new Date().getFullYear()]);
    return result.rows;
  },

  async initializeLeaveBalance(employee_id, year) {
    const leaveTypes = await this.getLeaveTypes();
    
    for (const leaveType of leaveTypes) {
      await pool.query(
        `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`,
        [employee_id, leaveType.id, year, leaveType.annual_quota]
      );
    }
  },

  async applyLeave(data) {
    const { employee_id, leave_type_id, start_date, end_date, number_of_days, reason, attachment_url, manager_id } = data;
    
    const result = await pool.query(
      `INSERT INTO leave_applications (employee_id, leave_type_id, start_date, end_date, number_of_days, reason, attachment_url, manager_id, manager_status, hr_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'pending') RETURNING *`,
      [employee_id, leave_type_id, start_date, end_date, number_of_days, reason, attachment_url, manager_id]
    );
    return result.rows[0];
  },

  async findApplications(filters = {}) {
    let query = `
      SELECT la.*, 
        e.name as employee_name,
        e.department,
        lt.leave_name,
        lt.leave_code,
        m.name as manager_name,
        h.name as hr_name
      FROM leave_applications la
      JOIN employees e ON la.employee_id = e.id
      JOIN leave_types lt ON la.leave_type_id = lt.id
      LEFT JOIN employees m ON la.manager_id = m.id
      LEFT JOIN employees h ON la.hr_id = h.id
      WHERE la.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.employee_id) {
      query += ` AND la.employee_id = $${paramCount}`;
      params.push(filters.employee_id);
      paramCount++;
    }

    if (filters.manager_id) {
      query += ` AND la.manager_id = $${paramCount}`;
      params.push(filters.manager_id);
      paramCount++;
    }

    if (filters.status) {
      query += ` AND la.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    if (filters.start_date && filters.end_date) {
      query += ` AND la.start_date >= $${paramCount} AND la.end_date <= $${paramCount + 1}`;
      params.push(filters.start_date, filters.end_date);
      paramCount += 2;
    }

    query += ` ORDER BY la.applied_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT la.*, 
        e.name as employee_name,
        e.department,
        lt.leave_name,
        m.name as manager_name,
        h.name as hr_name
       FROM leave_applications la
       JOIN employees e ON la.employee_id = e.id
       JOIN leave_types lt ON la.leave_type_id = lt.id
       LEFT JOIN employees m ON la.manager_id = m.id
       LEFT JOIN employees h ON la.hr_id = h.id
       WHERE la.id = $1 AND la.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  async approveByManager(id, manager_id, comments) {
    const result = await pool.query(
      `UPDATE leave_applications
       SET manager_status = 'approved',
           manager_comments = $2,
           manager_approved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [id, comments]
    );

    // Log approval history
    await pool.query(
      `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments)
       VALUES ($1, $2, 1, 'approved', $3)`,
      [id, manager_id, comments]
    );

    return result.rows[0];
  },

  async rejectByManager(id, manager_id, comments) {
    const result = await pool.query(
      `UPDATE leave_applications
       SET manager_status = 'rejected',
           status = 'rejected',
           manager_comments = $2,
           manager_approved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [id, comments]
    );

    await pool.query(
      `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments)
       VALUES ($1, $2, 1, 'rejected', $3)`,
      [id, manager_id, comments]
    );

    return result.rows[0];
  },

  async approveByHR(id, hr_id, comments) {
    const result = await pool.query(
      `UPDATE leave_applications
       SET hr_status = 'approved',
           status = 'approved',
           hr_comments = $2,
           hr_id = $3,
           hr_approved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND manager_status = 'approved' RETURNING *`,
      [id, comments, hr_id]
    );

    await pool.query(
      `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments)
       VALUES ($1, $2, 2, 'approved', $3)`,
      [id, hr_id, comments]
    );

    return result.rows[0];
  },

  async rejectByHR(id, hr_id, comments) {
    const result = await pool.query(
      `UPDATE leave_applications
       SET hr_status = 'rejected',
           status = 'rejected',
           hr_comments = $2,
           hr_id = $3,
           hr_approved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [id, comments, hr_id]
    );

    await pool.query(
      `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments)
       VALUES ($1, $2, 2, 'rejected', $3)`,
      [id, hr_id, comments]
    );

    return result.rows[0];
  },

  async getLeaveCalendar(filters = {}) {
    let query = `
      SELECT la.*, e.name as employee_name, e.department, lt.leave_name
      FROM leave_applications la
      JOIN employees e ON la.employee_id = e.id
      JOIN leave_types lt ON la.leave_type_id = lt.id
      WHERE la.status = 'approved' AND la.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.start_date && filters.end_date) {
      query += ` AND la.start_date <= $${paramCount + 1} AND la.end_date >= $${paramCount}`;
      params.push(filters.start_date, filters.end_date);
      paramCount += 2;
    }

    if (filters.department) {
      query += ` AND e.department = $${paramCount}`;
      params.push(filters.department);
      paramCount++;
    }

    query += ` ORDER BY la.start_date`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async getLeaveAnalytics(filters = {}) {
    let query = `
      SELECT 
        lt.leave_name,
        COUNT(la.id) as application_count,
        SUM(la.number_of_days) as total_days,
        COUNT(*) FILTER (WHERE la.status = 'approved') as approved_count,
        COUNT(*) FILTER (WHERE la.status = 'rejected') as rejected_count
      FROM leave_applications la
      JOIN leave_types lt ON la.leave_type_id = lt.id
      WHERE la.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.start_date && filters.end_date) {
      query += ` AND la.start_date >= $${paramCount} AND la.end_date <= $${paramCount + 1}`;
      params.push(filters.start_date, filters.end_date);
      paramCount += 2;
    }

    query += ` GROUP BY lt.leave_name ORDER BY total_days DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  }
};

export default leavesRepository;
