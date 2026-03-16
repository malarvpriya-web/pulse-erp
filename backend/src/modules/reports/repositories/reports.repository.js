import pool from '../../shared/db.js';

const reportsRepository = {
  async createSavedReport(data) {
    const { report_name, module_name, report_type, filters_json, columns_json, created_by, is_public } = data;
    const result = await pool.query(
      `INSERT INTO saved_reports (report_name, module_name, report_type, filters_json, columns_json, created_by, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [report_name, module_name, report_type, JSON.stringify(filters_json), JSON.stringify(columns_json), created_by, is_public]
    );
    return result.rows[0];
  },

  async findSavedReports(user_id) {
    const result = await pool.query(
      `SELECT sr.*, e.name as created_by_name
       FROM saved_reports sr
       LEFT JOIN employees e ON sr.created_by = e.id
       WHERE sr.deleted_at IS NULL AND (sr.created_by = $1 OR sr.is_public = true)
       ORDER BY sr.created_at DESC`,
      [user_id]
    );
    return result.rows;
  },

  async deleteSavedReport(id) {
    await pool.query(`UPDATE saved_reports SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  // Prebuilt Reports
  async getAttendanceReport(filters) {
    const { start_date, end_date, department } = filters;
    let query = `
      SELECT e.id, e.name, e.department, e.designation,
        COUNT(*) as total_days,
        COUNT(*) FILTER (WHERE status = 'present') as present_days,
        COUNT(*) FILTER (WHERE status = 'absent') as absent_days,
        COUNT(*) FILTER (WHERE status = 'leave') as leave_days
      FROM employees e
      LEFT JOIN attendance a ON e.id = a.employee_id
      WHERE e.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (start_date && end_date) {
      query += ` AND a.date BETWEEN $${paramCount} AND $${paramCount + 1}`;
      params.push(start_date, end_date);
      paramCount += 2;
    }

    if (department) {
      query += ` AND e.department = $${paramCount}`;
      params.push(department);
      paramCount++;
    }

    query += ` GROUP BY e.id, e.name, e.department, e.designation ORDER BY e.name`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async getLeaveReport(filters) {
    const { start_date, end_date, status } = filters;
    let query = `
      SELECT l.*, e.name as employee_name, e.department
      FROM leaves l
      JOIN employees e ON l.employee_id = e.id
      WHERE l.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (start_date && end_date) {
      query += ` AND l.start_date >= $${paramCount} AND l.end_date <= $${paramCount + 1}`;
      params.push(start_date, end_date);
      paramCount += 2;
    }

    if (status) {
      query += ` AND l.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    query += ` ORDER BY l.created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async getSalesReport(filters) {
    const { start_date, end_date } = filters;
    let query = `
      SELECT 
        DATE_TRUNC('month', so.order_date) as month,
        COUNT(*) as order_count,
        SUM(so.total_amount) as total_revenue,
        AVG(so.total_amount) as avg_order_value
      FROM sales_orders so
      WHERE so.deleted_at IS NULL AND so.order_status = 'completed'
    `;
    const params = [];
    let paramCount = 1;

    if (start_date && end_date) {
      query += ` AND so.order_date BETWEEN $${paramCount} AND $${paramCount + 1}`;
      params.push(start_date, end_date);
      paramCount += 2;
    }

    query += ` GROUP BY DATE_TRUNC('month', so.order_date) ORDER BY month DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async getStockReport() {
    const result = await pool.query(`
      SELECT 
        ii.item_code,
        ii.item_name,
        ii.category,
        ii.unit,
        COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) as current_stock,
        ii.reorder_level,
        CASE 
          WHEN COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) <= ii.reorder_level THEN 'Low Stock'
          ELSE 'In Stock'
        END as stock_status
      FROM inventory_items ii
      LEFT JOIN stock_ledger sl ON ii.id = sl.item_id
      WHERE ii.deleted_at IS NULL
      GROUP BY ii.id, ii.item_code, ii.item_name, ii.category, ii.unit, ii.reorder_level
      ORDER BY ii.item_name
    `);
    return result.rows;
  },

  async getProjectCostReport() {
    const result = await pool.query(`
      SELECT 
        p.project_code,
        p.project_name,
        p.budget_amount,
        COALESCE(pcs.labour_cost, 0) as labour_cost,
        COALESCE(pcs.material_cost, 0) as material_cost,
        COALESCE(pcs.expense_cost, 0) as expense_cost,
        COALESCE(pcs.total_cost, 0) as total_cost,
        p.budget_amount - COALESCE(pcs.total_cost, 0) as variance
      FROM projects p
      LEFT JOIN project_cost_summary pcs ON p.id = pcs.project_id
      WHERE p.deleted_at IS NULL
      ORDER BY p.created_at DESC
    `);
    return result.rows;
  }
};

export default reportsRepository;
