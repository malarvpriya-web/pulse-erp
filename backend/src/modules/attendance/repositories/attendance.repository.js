import pool from '../../shared/db.js';

const attendanceRepository = {
  async markAttendance(data) {
    const { employee_id, attendance_date, check_in_time, check_out_time, status, late_minutes, early_leave_minutes, remarks } = data;
    
    const total_hours = check_in_time && check_out_time ? 
      await this.calculateHours(check_in_time, check_out_time) : null;
    
    const result = await pool.query(
      `INSERT INTO attendance_records (employee_id, attendance_date, check_in_time, check_out_time, total_hours, status, late_minutes, early_leave_minutes, remarks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (employee_id, attendance_date)
       DO UPDATE SET 
         check_in_time = COALESCE($3, attendance_records.check_in_time),
         check_out_time = COALESCE($4, attendance_records.check_out_time),
         total_hours = COALESCE($5, attendance_records.total_hours),
         status = COALESCE($6, attendance_records.status),
         late_minutes = COALESCE($7, attendance_records.late_minutes),
         early_leave_minutes = COALESCE($8, attendance_records.early_leave_minutes),
         remarks = COALESCE($9, attendance_records.remarks),
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [employee_id, attendance_date, check_in_time, check_out_time, total_hours, status, late_minutes, early_leave_minutes, remarks]
    );
    return result.rows[0];
  },

  async calculateHours(check_in, check_out) {
    const result = await pool.query(
      `SELECT EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600 as hours`,
      [check_out, check_in]
    );
    return Math.abs(parseFloat(result.rows[0].hours).toFixed(2));
  },

  async findByEmployee(employee_id, filters = {}) {
    let query = `
      SELECT ar.*, e.name as employee_name
      FROM attendance_records ar
      JOIN employees e ON ar.employee_id = e.id
      WHERE ar.employee_id = $1 AND ar.deleted_at IS NULL
    `;
    const params = [employee_id];
    let paramCount = 2;

    if (filters.start_date && filters.end_date) {
      query += ` AND ar.attendance_date BETWEEN $${paramCount} AND $${paramCount + 1}`;
      params.push(filters.start_date, filters.end_date);
      paramCount += 2;
    }

    if (filters.status) {
      query += ` AND ar.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    query += ` ORDER BY ar.attendance_date DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findByDate(attendance_date, filters = {}) {
    let query = `
      SELECT ar.*, e.name as employee_name, e.department
      FROM attendance_records ar
      JOIN employees e ON ar.employee_id = e.id
      WHERE ar.attendance_date = $1 AND ar.deleted_at IS NULL
    `;
    const params = [attendance_date];
    let paramCount = 2;

    if (filters.department) {
      query += ` AND e.department = $${paramCount}`;
      params.push(filters.department);
      paramCount++;
    }

    query += ` ORDER BY e.name`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async getEmployeeSummary(employee_id, month, year) {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_days,
        COUNT(*) FILTER (WHERE status = 'present') as present_days,
        COUNT(*) FILTER (WHERE status = 'absent') as absent_days,
        COUNT(*) FILTER (WHERE status = 'half_day') as half_days,
        COUNT(*) FILTER (WHERE status = 'wfh') as wfh_days,
        COUNT(*) FILTER (WHERE late_minutes > 0) as late_arrivals,
        SUM(late_minutes) as total_late_minutes,
        SUM(total_hours) as total_hours_worked
      FROM attendance_records
      WHERE employee_id = $1
        AND EXTRACT(MONTH FROM attendance_date) = $2
        AND EXTRACT(YEAR FROM attendance_date) = $3
        AND deleted_at IS NULL
    `, [employee_id, month, year]);
    return result.rows[0];
  },

  async getTeamSummary(manager_id, date) {
    const result = await pool.query(`
      SELECT 
        e.id,
        e.name,
        e.department,
        ar.status,
        ar.check_in_time,
        ar.late_minutes
      FROM employees e
      LEFT JOIN org_relationships org ON e.id = org.employee_id
      LEFT JOIN attendance_records ar ON e.id = ar.employee_id AND ar.attendance_date = $2
      WHERE org.manager_id = $1 AND e.deleted_at IS NULL
      ORDER BY e.name
    `, [manager_id, date]);
    return result.rows;
  },

  async getLateArrivals(filters = {}) {
    let query = `
      SELECT ar.*, e.name as employee_name, e.department
      FROM attendance_records ar
      JOIN employees e ON ar.employee_id = e.id
      WHERE ar.late_minutes > 0 AND ar.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.start_date && filters.end_date) {
      query += ` AND ar.attendance_date BETWEEN $${paramCount} AND $${paramCount + 1}`;
      params.push(filters.start_date, filters.end_date);
      paramCount += 2;
    }

    if (filters.department) {
      query += ` AND e.department = $${paramCount}`;
      params.push(filters.department);
      paramCount++;
    }

    query += ` ORDER BY ar.attendance_date DESC, ar.late_minutes DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async getMonthlyTrend(employee_id, year) {
    const result = await pool.query(`
      SELECT 
        EXTRACT(MONTH FROM attendance_date) as month,
        COUNT(*) FILTER (WHERE status = 'present') as present,
        COUNT(*) FILTER (WHERE status = 'absent') as absent,
        COUNT(*) FILTER (WHERE status = 'wfh') as wfh
      FROM attendance_records
      WHERE employee_id = $1 AND EXTRACT(YEAR FROM attendance_date) = $2
        AND deleted_at IS NULL
      GROUP BY EXTRACT(MONTH FROM attendance_date)
      ORDER BY month
    `, [employee_id, year]);
    return result.rows;
  }
};

export default attendanceRepository;
