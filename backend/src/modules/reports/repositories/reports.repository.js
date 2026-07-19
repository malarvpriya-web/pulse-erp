import pool from '../../shared/db.js';

/* safe query — returns [] on any DB error so individual reports degrade gracefully */
const safeQuery = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { console.error('[reports]', e.message); return []; }
};

const reportsRepository = {
  async createSavedReport(data) {
    const { report_name, module_name, report_type, filters_json, columns_json, created_by, is_public, company_id } = data;
    const rows = await safeQuery(
      `INSERT INTO saved_reports (report_name, module_name, report_type, filters_json, columns_json, created_by, is_public, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [report_name, module_name, report_type,
       JSON.stringify(filters_json || {}), JSON.stringify(columns_json || []),
       created_by, is_public ?? false, company_id ?? null]
    );
    return rows[0] || null;
  },

  async findSavedReports(user_id, company_id) {
    const params = [user_id];
    let cidClause = '';
    if (company_id) { params.push(company_id); cidClause = `AND (sr.company_id = $2 OR sr.company_id IS NULL)`; }
    return safeQuery(
      `SELECT sr.*,
              COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS created_by_name
       FROM saved_reports sr
       LEFT JOIN employees e ON sr.created_by = e.id
       WHERE sr.deleted_at IS NULL AND (sr.created_by = $1 OR sr.is_public = true) ${cidClause}
       ORDER BY sr.created_at DESC`,
      params
    );
  },

  async deleteSavedReport(id) {
    await safeQuery(`UPDATE saved_reports SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  // Prebuilt Reports
  async getAttendanceReport(filters) {
    const { start_date, end_date, department, company_id } = filters;
    let query = `
      SELECT e.id,
        COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS name,
        e.department, e.designation,
        COUNT(a.id) AS total_days,
        COUNT(a.id) FILTER (WHERE LOWER(a.status) = 'present') AS present_days,
        COUNT(a.id) FILTER (WHERE LOWER(a.status) = 'absent')  AS absent_days,
        COUNT(a.id) FILTER (WHERE LOWER(a.status) = 'leave')   AS leave_days
      FROM employees e
      LEFT JOIN attendance a ON e.id = a.employee_id
      WHERE e.deleted_at IS NULL
    `;
    const params = [];
    let pIdx = 1;

    if (company_id != null) {
      query += ` AND e.company_id = $${pIdx++}`;
      params.push(company_id);
    }

    if (start_date && end_date) {
      query += ` AND a.date BETWEEN $${pIdx++} AND $${pIdx++}`;
      params.push(start_date, end_date);
    }

    if (department) {
      query += ` AND e.department = $${pIdx++}`;
      params.push(department);
    }

    query += ` GROUP BY e.id, e.name, e.first_name, e.last_name, e.department, e.designation ORDER BY name`;
    return safeQuery(query, params);
  },

  async getLeaveReport(filters) {
    const { start_date, end_date, status, department, employee_id, company_id } = filters;
    const params = [];
    let pIdx = 1;

    let cidClause = '';
    if (company_id != null) {
      cidClause = ` AND e.company_id = $${pIdx++}`;
      params.push(company_id);
    }

    let query = `
      SELECT
        la.id, la.employee_id, la.leave_type_id, la.start_date, la.end_date,
        la.number_of_days, la.reason, la.status, la.manager_status, la.l2_status,
        la.hr_status, la.manager_comments, la.hr_comments, la.applied_at,
        la.attachment_url,
        COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS employee_name,
        e.department, e.designation, e.employee_code,
        lt.leave_name, lt.leave_code
      FROM leave_applications la
      JOIN employees e  ON la.employee_id   = e.id
      JOIN leave_types lt ON la.leave_type_id = lt.id
      WHERE la.deleted_at IS NULL
        AND e.status IS DISTINCT FROM 'Left'${cidClause}
    `;

    if (employee_id) {
      query += ` AND la.employee_id = $${pIdx++}`;
      params.push(employee_id);
    }

    if (department) {
      query += ` AND e.department = $${pIdx++}`;
      params.push(department);
    }

    if (start_date && end_date) {
      query += ` AND la.start_date >= $${pIdx++} AND la.end_date <= $${pIdx++}`;
      params.push(start_date, end_date);
    }

    if (status) {
      query += ` AND la.status = $${pIdx++}`;
      params.push(status);
    }

    query += ` ORDER BY la.applied_at DESC`;
    return safeQuery(query, params);
  },

  async getLeaveSummaryReport(filters) {
    const { year, department, company_id } = filters;
    const resolvedYear = Number(year) || new Date().getFullYear();
    const params = [resolvedYear];
    let pIdx = 2;

    let cidClause = '';
    if (company_id != null) {
      cidClause = ` AND e.company_id = $${pIdx++}`;
      params.push(company_id);
    }

    let deptClause = '';
    if (department) {
      deptClause = ` AND e.department = $${pIdx++}`;
      params.push(department);
    }

    return safeQuery(`
      SELECT
        e.id AS employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS employee_name,
        e.department, e.designation, e.employee_code,
        lt.leave_name,
        COALESCE(lb.allocated_days, 0) AS allocated_days,
        COALESCE(SUM(la.number_of_days) FILTER (WHERE la.status = 'approved'), 0) AS used_days,
        COALESCE(lb.allocated_days, 0)
          - COALESCE(SUM(la.number_of_days) FILTER (WHERE la.status = 'approved'), 0) AS remaining_days,
        COUNT(la.id) FILTER (WHERE la.status = 'pending')  AS pending_count,
        COUNT(la.id) FILTER (WHERE la.status = 'rejected') AS rejected_count
      FROM employees e
      CROSS JOIN leave_types lt
      LEFT JOIN leave_balances lb
        ON lb.employee_id = e.id AND lb.leave_type_id = lt.id AND lb.year = $1
      LEFT JOIN leave_applications la
        ON la.employee_id = e.id AND la.leave_type_id = lt.id
        AND EXTRACT(YEAR FROM la.start_date) = $1
        AND la.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
        AND e.status IS DISTINCT FROM 'Left'
        AND lt.is_active = true AND lt.deleted_at IS NULL${cidClause}${deptClause}
      GROUP BY e.id, e.name, e.first_name, e.last_name, e.department, e.designation, e.employee_code,
               lt.leave_name, lb.allocated_days
      ORDER BY employee_name, lt.leave_name
    `, params);
  },

  async getLeaveLiabilityReport(filters) {
    const { year, company_id } = filters;
    const resolvedYear = Number(year) || new Date().getFullYear();
    const params = [resolvedYear];
    let pIdx = 2;

    let cidClause = '';
    if (company_id != null) {
      cidClause = ` AND e.company_id = $${pIdx++}`;
      params.push(company_id);
    }

    return safeQuery(`
      SELECT
        e.id AS employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS employee_name,
        e.department, e.designation,
        lt.leave_name,
        COALESCE(lb.allocated_days, 0) AS allocated_days,
        COALESCE(SUM(la.number_of_days) FILTER (WHERE la.status='approved'), 0) AS used_days,
        GREATEST(COALESCE(lb.allocated_days, 0)
          - COALESCE(SUM(la.number_of_days) FILTER (WHERE la.status='approved'), 0), 0) AS balance_days,
        COALESCE(e.basic_salary, 0) / 26 AS daily_rate,
        GREATEST(COALESCE(lb.allocated_days, 0)
          - COALESCE(SUM(la.number_of_days) FILTER (WHERE la.status='approved'), 0), 0)
          * (COALESCE(e.basic_salary, 0) / 26) AS liability_amount
      FROM employees e
      CROSS JOIN leave_types lt
      LEFT JOIN leave_balances lb
        ON lb.employee_id = e.id AND lb.leave_type_id = lt.id AND lb.year = $1
      LEFT JOIN leave_applications la
        ON la.employee_id = e.id AND la.leave_type_id = lt.id
        AND EXTRACT(YEAR FROM la.start_date) = $1 AND la.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
        AND e.status IS DISTINCT FROM 'Left'
        AND lt.is_active = true AND lt.deleted_at IS NULL${cidClause}
      GROUP BY e.id, e.name, e.first_name, e.last_name, e.department, e.designation,
               e.basic_salary, lt.leave_name, lb.allocated_days
      HAVING GREATEST(COALESCE(lb.allocated_days,0)
        - COALESCE(SUM(la.number_of_days) FILTER (WHERE la.status='approved'),0),0) > 0
      ORDER BY liability_amount DESC
    `, params);
  },

  async getLOPReport(filters) {
    const { month, year, company_id } = filters;
    const params = [];
    let pIdx = 1;
    let whereClause = `WHERE pas.lop_days > 0`;

    if (month) { whereClause += ` AND pas.month = $${pIdx++}`; params.push(Number(month)); }
    if (year)  { whereClause += ` AND pas.year  = $${pIdx++}`; params.push(Number(year));  }
    if (company_id != null) { whereClause += ` AND pas.company_id = $${pIdx++}`; params.push(company_id); }

    return safeQuery(`
      SELECT
        COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS employee_name,
        e.department, e.designation, e.employee_code,
        pas.month, pas.year, pas.working_days, pas.present_days,
        pas.absent_days, pas.lop_days,
        ROUND((COALESCE(e.basic_salary,0) / NULLIF(pas.working_days,0)) * pas.lop_days, 2) AS lop_amount
      FROM payroll_attendance_summary pas
      JOIN employees e ON pas.employee_id = e.id
      ${whereClause}
      ORDER BY pas.year DESC, pas.month DESC, lop_amount DESC
    `, params);
  },

  async getDepartmentLeaveReport(filters) {
    const { year, month, company_id } = filters;
    const resolvedYear = Number(year) || new Date().getFullYear();
    const params = [resolvedYear];
    let pIdx = 2;

    let monthClause = '';
    if (month) { monthClause = ` AND EXTRACT(MONTH FROM la.start_date) = $${pIdx++}`; params.push(Number(month)); }

    let cidClause = '';
    if (company_id != null) { cidClause = ` AND e.company_id = $${pIdx++}`; params.push(company_id); }

    return safeQuery(`
      SELECT
        e.department,
        COUNT(DISTINCT e.id)                                          AS total_employees,
        COUNT(la.id)                                                  AS total_applications,
        COUNT(la.id) FILTER (WHERE la.status = 'approved')           AS approved,
        COUNT(la.id) FILTER (WHERE la.status = 'rejected')           AS rejected,
        COUNT(la.id) FILTER (WHERE la.status = 'pending')            AS pending,
        COALESCE(SUM(la.number_of_days) FILTER (WHERE la.status='approved'), 0) AS total_days_taken,
        ROUND(
          COALESCE(SUM(la.number_of_days) FILTER (WHERE la.status='approved'), 0)
          / NULLIF(COUNT(DISTINCT e.id), 0), 2
        ) AS avg_days_per_employee
      FROM employees e
      LEFT JOIN leave_applications la
        ON la.employee_id = e.id
        AND EXTRACT(YEAR FROM la.start_date) = $1
        AND la.deleted_at IS NULL${monthClause}
      WHERE e.deleted_at IS NULL
        AND e.status IS DISTINCT FROM 'Left'${cidClause}
      GROUP BY e.department
      ORDER BY total_days_taken DESC
    `, params);
  },

  async getApprovalPerformanceReport(filters) {
    const { start_date, end_date, company_id } = filters;
    const params = [];
    let pIdx = 1;
    let dateClause = '';
    if (start_date && end_date) {
      dateClause = ` AND lah.created_at BETWEEN $${pIdx++} AND $${pIdx++}`;
      params.push(start_date, end_date);
    }
    let cidClause = '';
    if (company_id != null) { cidClause = ` AND e2.company_id = $${pIdx++}`; params.push(company_id); }

    return safeQuery(`
      SELECT
        COALESCE(m.name, CONCAT(m.first_name,' ',COALESCE(m.last_name,''))) AS approver_name,
        m.department,
        lah.approval_level,
        COUNT(*) AS total_actions,
        COUNT(*) FILTER (WHERE lah.action = 'approved') AS approved_count,
        COUNT(*) FILTER (WHERE lah.action = 'rejected') AS rejected_count,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (lah.created_at - la.applied_at)) / 3600
        ), 1) AS avg_response_hours
      FROM leave_approval_history lah
      JOIN employees m ON lah.approver_id = m.id
      JOIN leave_applications la ON lah.leave_application_id = la.id
      JOIN employees e2 ON la.employee_id = e2.id
      WHERE lah.approver_id IS NOT NULL${dateClause}${cidClause}
      GROUP BY m.id, m.name, m.first_name, m.last_name, m.department, lah.approval_level
      ORDER BY avg_response_hours DESC
    `, params);
  },

  async getSalesReport(filters) {
    const { start_date, end_date, company_id } = filters;
    let query = `
      SELECT
        DATE_TRUNC('month', so.order_date) AS month,
        COUNT(*) AS order_count,
        COALESCE(SUM(so.total_amount), 0)::numeric AS total_revenue,
        COALESCE(AVG(so.total_amount), 0)::numeric AS avg_order_value
      FROM sales_orders so
      WHERE so.deleted_at IS NULL
        AND LOWER(COALESCE(so.order_status,'')) = 'completed'
    `;
    const params = [];
    let pIdx = 1;

    if (company_id != null) {
      query += ` AND so.company_id = $${pIdx++}`;
      params.push(company_id);
    }

    if (start_date && end_date) {
      query += ` AND so.order_date BETWEEN $${pIdx++} AND $${pIdx++}`;
      params.push(start_date, end_date);
    }

    query += ` GROUP BY DATE_TRUNC('month', so.order_date) ORDER BY month DESC`;
    return safeQuery(query, params);
  },

  async getStockReport(company_id) {
    const params = company_id != null ? [company_id] : [];
    const cidClause = company_id != null ? ` AND ii.company_id = $1` : '';
    const rows = await safeQuery(`
      SELECT
        ii.item_code, ii.item_name, ii.category, ii.unit,
        COALESCE(SUM(sl.quantity_in - sl.quantity_out), ii.current_stock, 0)::numeric AS current_stock,
        COALESCE(ii.reorder_level, 0) AS reorder_level,
        CASE
          WHEN COALESCE(SUM(sl.quantity_in - sl.quantity_out), ii.current_stock, 0) <= COALESCE(ii.reorder_level, 0)
          THEN 'Low Stock' ELSE 'In Stock'
        END AS stock_status
      FROM inventory_items ii
      LEFT JOIN stock_ledger sl ON ii.id = sl.item_id
      WHERE ii.deleted_at IS NULL${cidClause}
      GROUP BY ii.id, ii.item_code, ii.item_name, ii.category, ii.unit, ii.reorder_level, ii.current_stock
      ORDER BY ii.item_name
    `, params);
    if (rows.length) return rows;
    return safeQuery(`
      SELECT item_code, item_name, category, unit,
             COALESCE(current_stock, 0)::numeric AS current_stock,
             COALESCE(reorder_level, 0) AS reorder_level,
             CASE WHEN COALESCE(current_stock,0) <= COALESCE(reorder_level,0)
               THEN 'Low Stock' ELSE 'In Stock' END AS stock_status
      FROM inventory_items WHERE deleted_at IS NULL${cidClause} ORDER BY item_name
    `, params);
  },

  async getProjectCostReport(company_id) {
    const params = company_id != null ? [company_id] : [];
    const cidClause = company_id != null ? ` AND p.company_id = $1` : '';
    return safeQuery(`
      SELECT
        COALESCE(p.project_code, p.id::text)            AS project_code,
        COALESCE(p.project_name, p.name, 'Unnamed')     AS project_name,
        COALESCE(p.budget_amount, p.total_budget, 0)::numeric AS budget_amount,
        COALESCE(p.budget_used, 0)::numeric              AS total_cost,
        COALESCE(p.budget_amount, p.total_budget, 0)::numeric
          - COALESCE(p.budget_used, 0)::numeric          AS variance,
        p.status,
        p.created_at
      FROM projects p
      WHERE p.deleted_at IS NULL${cidClause}
      ORDER BY p.created_at DESC
    `, params);
  },

  async getHeadcountReport(filters) {
    const { department, company_id } = filters;
    let query = `
      SELECT department,
        COUNT(*) AS total_employees,
        MIN(joining_date) AS earliest_joining,
        MAX(joining_date) AS latest_joining
      FROM employees
      WHERE deleted_at IS NULL
    `;
    const params = [];
    let pIdx = 1;
    if (company_id != null) { query += ` AND company_id = $${pIdx++}`; params.push(company_id); }
    if (department) { query += ` AND department = $${pIdx++}`; params.push(department); }
    query += ` GROUP BY department ORDER BY department`;
    return safeQuery(query, params);
  },

  async getPayrollSummaryReport(filters) {
    const { start_date, end_date, company_id } = filters;
    let query = `
      SELECT pr.year, pr.month, e.department,
        COUNT(*) AS employee_count,
        COALESCE(SUM(pr.gross), 0)::numeric   AS total_gross,
        COALESCE(SUM(pr.net_pay), 0)::numeric AS total_net,
        COALESCE(SUM(pr.tds), 0)::numeric AS total_tds
      FROM payroll_runs pr
      JOIN employees e ON pr.employee_id = e.id
      WHERE e.deleted_at IS NULL
    `;
    const params = [];
    let pIdx = 1;
    if (company_id != null) { query += ` AND pr.company_id = $${pIdx++}`; params.push(company_id); }
    if (start_date) { query += ` AND MAKE_DATE(pr.year, pr.month, 1) >= $${pIdx++}`; params.push(start_date); }
    if (end_date)   { query += ` AND MAKE_DATE(pr.year, pr.month, 1) <= $${pIdx++}`; params.push(end_date); }
    query += ` GROUP BY pr.year, pr.month, e.department ORDER BY pr.year DESC, pr.month DESC`;
    return safeQuery(query, params);
  },

  async getSalesTargetsReport(filters) {
    const { start_date, end_date, company_id } = filters;
    let query = `
      SELECT COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department,
        st.month, COALESCE(st.target_amount, 0)::numeric AS target_amount,
        COALESCE(act.actual_amount, 0)::numeric AS actual_amount,
        CASE WHEN COALESCE(st.target_amount, 0) > 0
          THEN ROUND((COALESCE(act.actual_amount, 0) / st.target_amount) * 100, 2)
          ELSE 0 END AS achievement_pct
      FROM sales_targets st
      JOIN employees e ON st.employee_id = e.id
      LEFT JOIN (
        SELECT DATE_TRUNC('month', order_date) AS order_month,
          SUM(total_amount) AS actual_amount
        FROM sales_orders
        WHERE deleted_at IS NULL
          AND LOWER(COALESCE(order_status,'')) = 'completed'
        GROUP BY DATE_TRUNC('month', order_date)
      ) act ON act.order_month = st.month
      WHERE st.deleted_at IS NULL
    `;
    const params = [];
    let pIdx = 1;
    if (company_id != null) { query += ` AND e.company_id = $${pIdx++}`; params.push(company_id); }
    if (start_date) { query += ` AND st.month >= $${pIdx++}`; params.push(start_date); }
    if (end_date)   { query += ` AND st.month <= $${pIdx++}`; params.push(end_date); }
    query += ` ORDER BY st.month DESC, employee_name`;
    return safeQuery(query, params);
  },

  async getOutstandingInvoicesReport(company_id) {
    const params = company_id != null ? [company_id] : [];
    const cidClause = company_id != null ? ` AND inv.company_id = $1` : '';
    return safeQuery(`
      SELECT
        inv.invoice_number,
        COALESCE(inv.party_name, 'Unknown') AS customer_name,
        inv.invoice_date,
        inv.due_date,
        COALESCE(inv.total_amount, 0)::numeric AS total_amount,
        COALESCE(inv.total_amount, 0)::numeric AS balance,
        CASE WHEN inv.due_date IS NOT NULL
          THEN (CURRENT_DATE - inv.due_date::date)
          ELSE NULL END AS days_overdue,
        CASE
          WHEN inv.due_date IS NULL OR CURRENT_DATE <= inv.due_date THEN 'Not Due'
          WHEN CURRENT_DATE - inv.due_date::date <= 30  THEN '1-30 Days'
          WHEN CURRENT_DATE - inv.due_date::date <= 60  THEN '31-60 Days'
          WHEN CURRENT_DATE - inv.due_date::date <= 90  THEN '61-90 Days'
          ELSE '90+ Days'
        END AS aging_bucket
      FROM invoices inv
      WHERE (inv.deleted_at IS NULL OR inv.deleted_at > NOW())
        AND LOWER(COALESCE(inv.status,'')) NOT IN ('paid','cancelled')${cidClause}
      ORDER BY inv.due_date ASC NULLS LAST
    `, params);
  },

  async getExpenseReport(filters) {
    const { start_date, end_date, department, company_id } = filters;
    let query = `
      SELECT ec.claim_number,
        COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS employee_name,
        e.department,
        COALESCE(ec.claim_date, ec.created_at) AS claim_date,
        COALESCE(ec.total_amount, ec.amount, 0)::numeric AS total_amount,
        ec.status
      FROM expense_claims ec
      LEFT JOIN employees e ON ec.employee_id = e.id
      WHERE (ec.deleted_at IS NULL OR ec.deleted_at > NOW())
    `;
    const params = [];
    let pIdx = 1;
    if (company_id != null) { query += ` AND e.company_id = $${pIdx++}`; params.push(company_id); }
    if (start_date && end_date) {
      query += ` AND COALESCE(ec.claim_date, ec.created_at) BETWEEN $${pIdx++} AND $${pIdx++}`;
      params.push(start_date, end_date);
    }
    if (department) { query += ` AND e.department = $${pIdx++}`; params.push(department); }
    query += ` ORDER BY COALESCE(ec.claim_date, ec.created_at) DESC`;
    return safeQuery(query, params);
  },

  async getGSTReport(filters) {
    const { start_date, end_date, company_id } = filters;
    let query = `
      SELECT DATE_TRUNC('month', COALESCE(invoice_date, created_at)) AS month,
        COUNT(*) AS invoice_count,
        COALESCE(SUM(subtotal), SUM(total_amount), 0)::numeric AS taxable_value,
        COALESCE(SUM(tax_amount), 0)::numeric AS gst_collected,
        COALESCE(SUM(total_amount), 0)::numeric AS gross_amount
      FROM invoices
      WHERE (deleted_at IS NULL OR deleted_at > NOW())
        AND LOWER(COALESCE(status,'')) != 'cancelled'
    `;
    const params = [];
    let pIdx = 1;
    if (company_id != null) { query += ` AND company_id = $${pIdx++}`; params.push(company_id); }
    if (start_date && end_date) {
      query += ` AND COALESCE(invoice_date, created_at) BETWEEN $${pIdx++} AND $${pIdx++}`;
      params.push(start_date, end_date);
    }
    query += ` GROUP BY DATE_TRUNC('month', COALESCE(invoice_date, created_at)) ORDER BY month DESC`;
    return safeQuery(query, params);
  },

  async getPurchaseOrdersReport(filters) {
    const { start_date, end_date, company_id } = filters;
    let query = `
      SELECT po.po_number,
        COALESCE(p.name, p.party_name, po.supplier_name, 'Unknown') AS supplier_name,
        po.order_date, po.expected_delivery_date,
        po.status, COALESCE(po.total_amount, 0)::numeric AS total_amount
      FROM purchase_orders po
      LEFT JOIN parties p ON po.supplier_id = p.id
      WHERE po.deleted_at IS NULL
    `;
    const params = [];
    let pIdx = 1;
    if (company_id != null) { query += ` AND po.company_id = $${pIdx++}`; params.push(company_id); }
    if (start_date && end_date) {
      query += ` AND po.order_date BETWEEN $${pIdx++} AND $${pIdx++}`;
      params.push(start_date, end_date);
    }
    query += ` ORDER BY po.order_date DESC`;
    return safeQuery(query, params);
  },

  async getVendorPerformanceReport(filters) {
    const { start_date, end_date, company_id } = filters;
    let poFilter = `po.deleted_at IS NULL`;
    const params = [];
    let pIdx = 1;
    if (company_id != null) { poFilter += ` AND po.company_id = $${pIdx++}`; params.push(company_id); }
    if (start_date && end_date) {
      poFilter += ` AND po.order_date BETWEEN $${pIdx++} AND $${pIdx++}`;
      params.push(start_date, end_date);
    }
    return safeQuery(`
      SELECT
        COALESCE(p.name, p.party_name, po.supplier_name, 'Unknown') AS vendor_name,
        COUNT(po.id) AS total_orders,
        COALESCE(SUM(po.total_amount), 0)::numeric AS total_spend,
        COUNT(po.id) FILTER (WHERE LOWER(po.status) = 'completed') AS completed_orders,
        CASE WHEN COUNT(po.id) > 0
          THEN ROUND(COUNT(po.id) FILTER (WHERE LOWER(po.status) = 'completed')::numeric / COUNT(po.id) * 100, 2)
          ELSE 0 END AS completion_rate_pct
      FROM purchase_orders po
      LEFT JOIN parties p ON p.id = po.supplier_id
      WHERE ${poFilter}
      GROUP BY COALESCE(p.name, p.party_name, po.supplier_name, 'Unknown')
      ORDER BY total_spend DESC NULLS LAST
    `, params);
  },

  async getPendingPOsReport(company_id) {
    const cidParams = company_id != null ? [company_id] : [];
    const poCidClause = company_id != null ? ` AND po.company_id = $1` : '';
    const prCidClause = company_id != null ? ` AND pr.company_id = $1` : '';
    /* Two separate safe queries — UNION can fail if one subquery references a missing column */
    const [poRows, prRows] = await Promise.all([
      safeQuery(`
        SELECT 'Purchase Order' AS document_type,
          po.po_number AS reference_number,
          COALESCE(p.name, p.party_name, po.supplier_name, 'Unknown') AS party_name,
          po.order_date AS document_date,
          COALESCE(po.total_amount, 0)::numeric AS total_amount,
          po.status
        FROM purchase_orders po
        LEFT JOIN parties p ON po.supplier_id = p.id
        WHERE po.deleted_at IS NULL
          AND LOWER(po.status) NOT IN ('completed','cancelled','received')${poCidClause}
        ORDER BY po.order_date DESC
      `, cidParams),
      safeQuery(`
        SELECT 'Purchase Request' AS document_type,
          COALESCE(pr.request_number, pr.id::text) AS reference_number,
          NULL::text AS party_name,
          COALESCE(pr.request_date, pr.created_at) AS document_date,
          NULL::numeric AS total_amount,
          pr.status
        FROM purchase_requests pr
        WHERE pr.deleted_at IS NULL
          AND LOWER(COALESCE(pr.status,'')) NOT IN ('approved','rejected','cancelled')${prCidClause}
        ORDER BY document_date DESC
      `, cidParams),
    ]);
    return [...poRows, ...prRows].sort((a, b) =>
      new Date(b.document_date || 0) - new Date(a.document_date || 0)
    );
  },

  async getStockMovementReport(filters) {
    const { start_date, end_date, company_id } = filters;
    let query = `
      SELECT sl.transaction_date, sl.transaction_type,
        ii.item_code, ii.item_name, ii.category,
        COALESCE(sl.quantity_in, 0)  AS quantity_in,
        COALESCE(sl.quantity_out, 0) AS quantity_out,
        sl.balance_qty, sl.rate, sl.value,
        sl.reference_type, sl.remarks
      FROM stock_ledger sl
      JOIN inventory_items ii ON sl.item_id = ii.id
      WHERE ii.deleted_at IS NULL
    `;
    const params = [];
    let pIdx = 1;
    if (company_id != null) { query += ` AND ii.company_id = $${pIdx++}`; params.push(company_id); }
    if (start_date && end_date) {
      query += ` AND sl.transaction_date BETWEEN $${pIdx++} AND $${pIdx++}`;
      params.push(start_date, end_date);
    }
    query += ` ORDER BY sl.transaction_date DESC, sl.id DESC`;
    return safeQuery(query, params);
  },

  async getLowStockReport(company_id) {
    const params = company_id != null ? [company_id] : [];
    const cidClause = company_id != null ? ` AND ii.company_id = $1` : '';
    const fbCidClause = company_id != null ? ` AND company_id = $1` : '';
    const rows = await safeQuery(`
      SELECT ii.item_code, ii.item_name, ii.category, ii.unit,
        COALESCE(SUM(sl.quantity_in - sl.quantity_out), ii.current_stock, 0)::numeric AS current_stock,
        COALESCE(ii.reorder_level, 0) AS reorder_level,
        COALESCE(ii.reorder_level, 0)
          - COALESCE(SUM(sl.quantity_in - sl.quantity_out), ii.current_stock, 0)::numeric AS shortage
      FROM inventory_items ii
      LEFT JOIN stock_ledger sl ON ii.id = sl.item_id
      WHERE ii.deleted_at IS NULL${cidClause}
      GROUP BY ii.id, ii.item_code, ii.item_name, ii.category, ii.unit, ii.reorder_level, ii.current_stock
      HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), ii.current_stock, 0) <= COALESCE(ii.reorder_level, 0)
      ORDER BY shortage DESC
    `, params);
    if (rows.length) return rows;
    return safeQuery(`
      SELECT item_code, item_name, category, unit,
             COALESCE(current_stock, 0)::numeric AS current_stock,
             COALESCE(reorder_level, 0) AS reorder_level,
             COALESCE(reorder_level, 0) - COALESCE(current_stock, 0)::numeric AS shortage
      FROM inventory_items
      WHERE deleted_at IS NULL
        AND COALESCE(current_stock, 0) <= COALESCE(reorder_level, 0)${fbCidClause}
      ORDER BY shortage DESC
    `, params);
  }
};

export default reportsRepository;
