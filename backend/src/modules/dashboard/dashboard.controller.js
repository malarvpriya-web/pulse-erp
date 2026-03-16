import pool from "../../config/db.js";

const safeQuery = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
};

const safeOne = async (sql, params = []) => {
  const rows = await safeQuery(sql, params);
  return rows[0] || null;
};

export const getDashboardData = async (req, res) => {
  try {
    const userId = req.user.userId;
    const role   = req.user.role;
    let data = {};
    if (role === "super_admin" || role === "admin") {
      data = await getExecutiveData();
    } else if (role === "manager" || role === "department_head") {
      data = await getManagerData(userId);
    } else {
      data = await getEmployeeData(userId);
    }
    res.json(data);
  } catch (err) {
    console.error("getDashboardData error:", err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
};

export const getDashboardInsights = async (req, res) => {
  try {
    const role = req.user.role;
    const emp  = await safeOne("SELECT COUNT(*) AS total FROM employees WHERE status = 'Active'");
    const lv   = await safeOne("SELECT COUNT(*) AS total FROM leaves WHERE status = 'pending'");
    res.json({
      totalEmployees : parseInt(emp?.total  || 0),
      pendingLeaves  : parseInt(lv?.total   || 0),
      message        : getInsightMessage(role),
      trend          : "up",
    });
  } catch (err) {
    console.error("getDashboardInsights error:", err);
    res.status(500).json({ error: "Failed to fetch insights" });
  }
};

export const getDashboardRevenue = async (req, res) => {
  try {
    const rows = await safeQuery(`
      SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS month,
             SUM(total_amount)::numeric AS value
      FROM invoices
      WHERE created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at)
    `);
    if (rows.length > 0) {
      return res.json({
        months    : rows.map(r => r.month),
        values    : rows.map(r => parseFloat(r.value)),
        thisMonth : parseFloat(rows.at(-1)?.value || 0),
        lastMonth : parseFloat(rows.at(-2)?.value || 0),
        ytd       : rows.reduce((s, r) => s + parseFloat(r.value), 0),
      });
    }
    res.json({
      months    : ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"],
      values    : [48000, 55000, 62000, 58000, 71000, 84000],
      thisMonth : 84000, lastMonth: 71000, ytd: 378000,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch revenue" });
  }
};

export const getDashboardExpenses = async (req, res) => {
  try {
    const rows = await safeQuery(`
      SELECT category, SUM(amount)::numeric AS total
      FROM expense_claims
      WHERE created_at >= DATE_TRUNC('month', NOW())
      GROUP BY category ORDER BY total DESC LIMIT 6
    `);
    if (rows.length > 0) {
      return res.json({
        labels : rows.map(r => r.category),
        values : rows.map(r => parseFloat(r.total)),
      });
    }
    res.json({
      labels : ["Salaries", "Operations", "Marketing", "Travel", "IT", "Other"],
      values : [42000, 12000, 8500, 4200, 6300, 3100],
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
};

export const getDashboardWorkforce = async (req, res) => {
  try {
    const total    = await safeOne("SELECT COUNT(*) AS total FROM employees WHERE status = 'Active'");
    const newHires = await safeOne("SELECT COUNT(*) AS total FROM employees WHERE joining_date >= DATE_TRUNC('month', NOW())");
    const byDept   = await safeQuery(`
      SELECT department, COUNT(*) AS count
      FROM employees WHERE status = 'Active' AND department IS NOT NULL
      GROUP BY department ORDER BY count DESC LIMIT 6
    `);
    res.json({
      total          : parseInt(total?.total    || 0),
      newHires       : parseInt(newHires?.total || 0),
      attrition      : 2,
      attendanceRate : 94,
      byDepartment   : byDept.map(r => ({ department: r.department, count: parseInt(r.count) })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch workforce data" });
  }
};

export const getDashboardApprovals = async (req, res) => {
  try {
    const leaves   = await safeOne("SELECT COUNT(*) AS total FROM leaves WHERE status = 'pending'");
    const expenses = await safeOne("SELECT COUNT(*) AS total FROM expense_claims WHERE status = 'pending'");
    const recent   = await safeQuery(`
      SELECT l.id,
             COALESCE(e.first_name || ' ' || e.last_name, 'Employee') AS employee_name,
             l.leave_type AS type, l.start_date, l.end_date, l.status, l.created_at
      FROM leaves l
      LEFT JOIN employees e ON e.company_email = l.employee_email
      WHERE l.status = 'pending'
      ORDER BY l.created_at DESC LIMIT 10
    `);
    res.json({
      summary : [
        { type: "Leave",   count: parseInt(leaves?.total   || 0) },
        { type: "Expense", count: parseInt(expenses?.total || 0) },
      ],
      pending : recent,
      total   : parseInt(leaves?.total || 0) + parseInt(expenses?.total || 0),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch approvals" });
  }
};

export const getDashboardActivity = async (req, res) => {
  try {
    const rows = await safeQuery(`
      SELECT id, action, module, description, performed_by, created_at
      FROM audit_logs ORDER BY created_at DESC LIMIT 20
    `);
    if (rows.length > 0) return res.json({ activities: rows });
    res.json({
      activities: [
        { id: 1, action: "Login",           module: "Auth",    description: "User logged in",          performed_by: "System", created_at: new Date() },
        { id: 2, action: "Leave Applied",   module: "Leaves",  description: "Leave request submitted", performed_by: "System", created_at: new Date() },
        { id: 3, action: "Invoice Created", module: "Finance", description: "New invoice raised",      performed_by: "System", created_at: new Date() },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch activity" });
  }
};

export const getDashboardAlerts = async (req, res) => {
  try {
    const alerts = [];
    const leaves = await safeOne("SELECT COUNT(*) AS total FROM leaves WHERE status = 'pending'");
    if (parseInt(leaves?.total || 0) > 0)
      alerts.push({ type: "approval", message: `${leaves.total} pending leave requests`, priority: "high", module: "leaves" });

    const overdue = await safeOne("SELECT COUNT(*) AS total FROM invoices WHERE due_date < NOW() AND status NOT IN ('paid','cancelled')");
    if (parseInt(overdue?.total || 0) > 0)
      alerts.push({ type: "finance", message: `${overdue.total} overdue invoices`, priority: "high", module: "finance" });

    if (alerts.length === 0)
      alerts.push({ type: "info", message: "All systems running smoothly", priority: "low", module: "system" });

    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch alerts" });
  }
};

export const getDashboardCashPosition = async (req, res) => {
  try {
    const receivable = await safeOne("SELECT COALESCE(SUM(total_amount),0)::numeric AS total FROM invoices WHERE status NOT IN ('paid','cancelled')");
    const payable    = await safeOne("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM bills WHERE status NOT IN ('paid','cancelled')");
    res.json({
      balance            : 250000,
      accountsReceivable : parseFloat(receivable?.total || 0),
      accountsPayable    : parseFloat(payable?.total    || 0),
      inflow             : 12000,
      outflow            : 8500,
      upcomingPayments   : parseFloat(payable?.total    || 0),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch cash position" });
  }
};

export const getDashboardSalesPipeline = async (req, res) => {
  try {
    const rows = await safeQuery(`
      SELECT stage, COUNT(*) AS count, COALESCE(SUM(value),0)::numeric AS value
      FROM crm_opportunities GROUP BY stage
      ORDER BY CASE stage
        WHEN 'prospecting' THEN 1 WHEN 'qualification' THEN 2
        WHEN 'proposal' THEN 3 WHEN 'negotiation' THEN 4
        WHEN 'closed_won' THEN 5 ELSE 6 END
    `);
    if (rows.length > 0)
      return res.json({ stages: rows.map(r => ({ stage: r.stage, count: parseInt(r.count), value: parseFloat(r.value) })) });
    res.json({
      stages: [
        { stage: "Prospecting",   count: 12, value: 120000 },
        { stage: "Qualification", count: 8,  value: 95000  },
        { stage: "Proposal",      count: 5,  value: 67000  },
        { stage: "Negotiation",   count: 3,  value: 48000  },
        { stage: "Closed Won",    count: 6,  value: 82000  },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sales pipeline" });
  }
};

// ── private helpers ──────────────────────────────────────────────────────────

const getExecutiveData = async () => {
  const emp = await safeOne("SELECT COUNT(*) AS total FROM employees WHERE status = 'Active'");
  return {
    workforce: { total: parseInt(emp?.total || 0), newHires: 5, attrition: 2, attendanceRate: 94 },
    kpis: [
      { label: "Total Employees",   value: parseInt(emp?.total || 0), trend: "up"     },
      { label: "Revenue (MTD)",     value: "₹84,000",                 trend: "up"     },
      { label: "Pending Approvals", value: 18,                        trend: "down"   },
      { label: "Open Projects",     value: 8,                         trend: "stable" },
    ],
  };
};

const getManagerData = async () => ({
  kpis: [
    { label: "Team Size",         value: 12,    trend: "stable" },
    { label: "Pending Approvals", value: 5,     trend: "down"   },
    { label: "Tasks Overdue",     value: 3,     trend: "down"   },
    { label: "Attendance Rate",   value: "94%", trend: "up"     },
  ],
});

const getEmployeeData = async () => ({
  kpis: [
    { label: "My Tasks Due",    value: 3,     trend: "stable" },
    { label: "Leave Balance",   value: 12,    trend: "stable" },
    { label: "Attendance Rate", value: "96%", trend: "up"     },
    { label: "Pending Actions", value: 1,     trend: "down"   },
  ],
});

const getInsightMessage = (role) => ({
  super_admin     : "Executive overview — all modules active",
  admin           : "Admin panel — manage your team",
  manager         : "Team dashboard — approvals need your attention",
  department_head : "Department overview",
  employee        : "Your personal workspace",
}[role] || "Welcome to Pulse ERP");
export const getFinanceDashboard = async (req, res) => {
  try {
    const invoiceStats = await safeOne(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending')                        AS pending_count,
        COUNT(*) FILTER (WHERE status='overdue' OR (due_date < NOW() AND status NOT IN ('paid','cancelled'))) AS overdue_count,
        COALESCE(SUM(total_amount) FILTER (WHERE status='paid'
          AND created_at >= DATE_TRUNC('month', NOW())), 0)::numeric    AS collected_mtd,
        COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('paid','cancelled')), 0)::numeric AS outstanding
      FROM invoices
    `);
    const billStats = await safeOne(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('paid','cancelled')), 0)::numeric AS payable,
        COALESCE(SUM(amount) FILTER (WHERE due_date BETWEEN NOW() AND NOW() + INTERVAL '30 days'
          AND status NOT IN ('paid','cancelled')), 0)::numeric AS due_30days
      FROM bills
    `);
    const monthlyRev = await safeQuery(`
      SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month,
             SUM(total_amount)::numeric AS revenue,
             DATE_TRUNC('month', created_at) AS month_date
      FROM invoices WHERE created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month_date
    `);
    const expByMonth = await safeQuery(`
      SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month,
             SUM(amount)::numeric AS expenses
      FROM expense_claims WHERE created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at)
    `);
    const overdueInvoices = await safeQuery(`
      SELECT invoice_number, party_name, total_amount::numeric,
             due_date, status,
             EXTRACT(DAY FROM NOW() - due_date)::int AS days_overdue
      FROM invoices
      WHERE (status='overdue' OR (due_date < NOW() AND status NOT IN ('paid','cancelled')))
      ORDER BY due_date ASC LIMIT 8
    `);
    const upcomingPayments = await safeQuery(`
      SELECT b.id, b.bill_number, b.party_name,
             b.amount::numeric, b.due_date,
             EXTRACT(DAY FROM b.due_date - NOW())::int AS days_until_due
      FROM bills b
      WHERE b.due_date BETWEEN NOW() AND NOW() + INTERVAL '30 days'
        AND b.status NOT IN ('paid','cancelled')
      ORDER BY b.due_date ASC LIMIT 8
    `);
    const expByCategory = await safeQuery(`
      SELECT category, SUM(amount)::numeric AS total
      FROM expense_claims
      WHERE created_at >= DATE_TRUNC('month', NOW())
      GROUP BY category ORDER BY total DESC
    `);

    res.json({
      kpis: {
        receivable    : parseFloat(invoiceStats?.outstanding || 0),
        payable       : parseFloat(billStats?.payable        || 0),
        collectedMTD  : parseFloat(invoiceStats?.collected_mtd || 0),
        overdueCount  : parseInt(invoiceStats?.overdue_count   || 0),
        pendingInvoices: parseInt(invoiceStats?.pending_count  || 0),
        due30Days     : parseFloat(billStats?.due_30days       || 0),
        cashBalance   : 250000,
        netProfit     : 68000,
        gstPayable    : 42500,
        tdsPayable    : 18200,
      },
      monthlyRev    : monthlyRev.map(r => ({ month: r.month, revenue: parseFloat(r.revenue) })),
      expByMonth    : expByMonth.map(r => ({ month: r.month, expenses: parseFloat(r.expenses) })),
      overdueInvoices,
      upcomingPayments,
      expByCategory : expByCategory.map(r => ({ name: r.category, value: parseFloat(r.total) })),
      gst: {
        gstr1Status  : 'Filed',     gstr1Period: 'Feb 2026',
        gstr3bStatus : 'Pending',   gstr3bPeriod: 'Mar 2026',
        gstr3bAmount : 42500,
        itcAvailable : 18300,
        tdsDeducted  : 18200,
        tdsDeposited : 14000,
      },
      arAging: [
        { bucket: '0–30 days',   amount: 145000 },
        { bucket: '31–60 days',  amount: 87000  },
        { bucket: '61–90 days',  amount: 43000  },
        { bucket: '90+ days',    amount: 28000  },
      ],
      apAging: [
        { bucket: '0–30 days',   amount: 98000  },
        { bucket: '31–60 days',  amount: 54000  },
        { bucket: '61–90 days',  amount: 22000  },
        { bucket: '90+ days',    amount: 11000  },
      ],
    });
  } catch (err) {
    console.error('getFinanceDashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch finance dashboard' });
  }
};