import pool from "../../config/db.js";

/* ── safe query helpers ────────────────────────────────────────────────────── */
const safeQuery = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
};
const safeOne = async (sql, params = []) => {
  const rows = await safeQuery(sql, params);
  return rows[0] || null;
};
const safeInt  = (v, fallback = 0) => parseInt(v   ?? fallback) || fallback;
const safeFloat = (v, fallback = 0) => parseFloat(v ?? fallback) || fallback;

// Returns parameterised company_id filter fragment.
// When cid is null the fragment always evaluates true (no filter = backward compat).
// Usage: append cidClause(cid, nextIdx) to SQL, push cid into params.
const cidClause = (cid, idx) =>
  cid != null ? ` AND company_id = $${idx}` : '';
const cidParams = (cid, base = []) =>
  cid != null ? [...base, cid] : base;

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/data  — role-aware summary
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardData = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const role   = req.user?.role;
    const cid    = req.scope?.company_id ?? null;
    let data = {};
    if (role === "super_admin" || role === "admin") {
      data = await getExecutiveData(cid);
    } else if (role === "manager" || role === "department_head") {
      data = await getManagerData(userId, cid);
    } else {
      data = await getEmployeeData(userId, cid);
    }
    res.json(data);
  } catch (err) {
    console.error("getDashboardData error:", err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/insights
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardInsights = async (req, res) => {
  try {
    const role = req.user?.role;
    const cid  = req.scope?.company_id ?? null;
    const emp = await safeOne(
      `SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) IN ('active', 'probation')${cidClause(cid, 1)}`,
      cidParams(cid)
    );
    const lv = await safeOne(
      `SELECT COUNT(*) AS total FROM leaves WHERE status = 'pending'${cidClause(cid, 1)}`,
      cidParams(cid)
    );
    res.json({
      totalEmployees : safeInt(emp?.total),
      pendingLeaves  : safeInt(lv?.total),
      message        : getInsightMessage(role),
      trend          : "up",
    });
  } catch (err) {
    console.error("getDashboardInsights error:", err);
    res.status(500).json({ error: "Failed to fetch insights" });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/revenue  — ?period=6m|cy|fy  &year=YYYY  &compare=true
══════════════════════════════════════════════════════════════════════════════ */
// NOTE: invoices/bills/expense_claims/crm_opportunities/projects/tasks do not have company_id.
// Multi-tenant isolation for these tables requires a Phase 46 schema migration.
// Queries on these tables currently return cross-company data (single-tenant safe).
const revSql = (filter) =>
  `SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon ''YY') AS month,
          TO_CHAR(DATE_TRUNC('month', created_at), 'Mon')       AS short_month,
          COALESCE(SUM(COALESCE(total_amount, amount, 0)), 0)::numeric AS value,
          DATE_TRUNC('month', created_at) AS month_ts
   FROM invoices
   WHERE LOWER(COALESCE(status, '')) = 'paid' AND ${filter}
   GROUP BY DATE_TRUNC('month', created_at)
   ORDER BY DATE_TRUNC('month', created_at)`;

export const getDashboardRevenue = async (req, res) => {
  try {
    const period  = req.query.period || '6m';
    const year    = parseInt(req.query.year) || new Date().getFullYear();
    const compare = req.query.compare === 'true';

    let sql, params, prevSql, prevParams;

    if (period === 'fy') {
      sql        = revSql(`created_at >= $1::date AND created_at < $2::date`);
      params     = [`${year - 1}-04-01`, `${year}-04-01`];
      prevSql    = sql;
      prevParams = [`${year - 2}-04-01`, `${year - 1}-04-01`];
    } else if (period === 'cy') {
      sql        = revSql(`EXTRACT(year FROM created_at) = $1`);
      params     = [year];
      prevSql    = sql;
      prevParams = [year - 1];
    } else {
      sql        = revSql(`created_at >= NOW() - INTERVAL '6 months'`);
      params     = [];
      prevSql    = revSql(`created_at >= NOW() - INTERVAL '18 months' AND created_at < NOW() - INTERVAL '6 months'`);
      prevParams = [];
    }

    const [rows, prevRows] = await Promise.all([
      safeQuery(sql, params),
      compare ? safeQuery(prevSql, prevParams) : Promise.resolve([]),
    ]);

    res.json({
      months      : rows.map(r => r.month),
      shortMonths : rows.map(r => r.short_month),
      values      : rows.map(r => safeFloat(r.value)),
      prevValues  : compare ? prevRows.map(r => safeFloat(r.value)) : undefined,
      monthDates  : rows.map(r => r.month_ts),
      thisMonth   : safeFloat(rows.at(-1)?.value),
      lastMonth   : safeFloat(rows.at(-2)?.value),
      ytd         : rows.reduce((s, r) => s + safeFloat(r.value), 0),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch revenue" });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/expenses  — current month from expense_claims
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardExpenses = async (req, res) => {
  try {
    const rows = await safeQuery(`
      SELECT COALESCE(ec.name, 'Other') AS category,
             SUM(eci.amount)::numeric   AS total
      FROM expense_claim_items eci
      LEFT JOIN expense_categories ec ON ec.id = eci.category_id
      WHERE eci.created_at >= DATE_TRUNC('month', NOW())
      GROUP BY ec.name ORDER BY total DESC LIMIT 6
    `);
    res.json({
      labels : rows.map(r => r.category || 'Other'),
      values : rows.map(r => safeFloat(r.total)),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/workforce  — live employee counts, attendance, departments
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardWorkforce = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const cf  = cidClause(cid, 1);
    const cp  = cidParams(cid);

    const [total, newHires, attrRow, attRow, onLeave, probation, byDept] = await Promise.all([
      safeOne(`SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) IN ('active','probation')${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM employees WHERE joining_date >= DATE_TRUNC('month', NOW()) AND LOWER(status) != 'left'${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) IN ('inactive','terminated','left') AND updated_at >= DATE_TRUNC('month', NOW())${cf}`, cp),
      safeOne(`
        SELECT
          COUNT(*) FILTER (WHERE a.status = 'present') AS present_count,
          (SELECT COUNT(*) FROM employees WHERE LOWER(status) IN ('active','probation')${cf}) AS total_emp
        FROM attendance a WHERE a.date = CURRENT_DATE
      `, cp),
      safeOne(`
        SELECT COUNT(*) AS total FROM leaves
        WHERE status = 'approved' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE${cf}
      `, cp),
      safeOne(`SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) = 'probation'${cf}`, cp),
      safeQuery(`
        SELECT department, COUNT(*) AS count
        FROM employees WHERE LOWER(status) IN ('active','probation') AND department IS NOT NULL AND department != ''${cf}
        GROUP BY department ORDER BY count DESC LIMIT 8
      `, cp),
    ]);

    const totalEmp     = safeInt(total?.total, 0);
    const presentCount = safeInt(attRow?.present_count, 0);
    const empCount     = safeInt(attRow?.total_emp, 0) || 1;
    const attendanceRate = empCount > 1 ? Math.round((presentCount / empCount) * 100) : 0;

    res.json({
      total          : totalEmp,
      newHires       : safeInt(newHires?.total),
      attrition      : safeInt(attrRow?.total),
      onLeave        : safeInt(onLeave?.total),
      probation      : safeInt(probation?.total),
      attendanceRate,
      byDepartment   : byDept.map(r => ({ department: r.department, count: safeInt(r.count) })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch workforce data" });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/approvals  — pending leaves + expenses + approvals table
   ?detail=true  → returns top-20 pending items with age and department context
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardApprovals = async (req, res) => {
  try {
    const detail = req.query.detail === 'true';
    const cid = req.scope?.company_id ?? null;
    const cf  = cidClause(cid, 1);
    const cp  = cidParams(cid);
    const limit = detail ? 20 : 8;

    const [leaveCnt, expCnt, apprCnt, recent] = await Promise.all([
      safeOne(`SELECT COUNT(*) AS total FROM leaves WHERE status = 'pending'${cf}`, cp),
      safeOne("SELECT COUNT(*) AS total FROM expense_claims WHERE status = 'pending'"),
      safeOne("SELECT COUNT(*) AS total FROM approvals WHERE status = 'Pending'"),
      safeQuery(`
        SELECT l.id,
               COALESCE(e.first_name || ' ' || e.last_name, l.employee_email, 'Employee') AS employee_name,
               e.department,
               l.leave_type AS type, l.start_date, l.end_date, l.status, l.created_at,
               (CURRENT_DATE - l.created_at::date) AS days_waiting
        FROM leaves l
        LEFT JOIN employees e ON e.company_email = l.employee_email
        WHERE l.status = 'pending'${cf}
        ORDER BY l.created_at ASC LIMIT ${limit}
      `, cp),
    ]);

    const summary = [
      { type: "Leave",    count: safeInt(leaveCnt?.total)  },
      { type: "Expense",  count: safeInt(expCnt?.total)    },
      { type: "Approvals",count: safeInt(apprCnt?.total)   },
    ].filter(s => s.count > 0);

    const base = {
      summary,
      pending : recent,
      total   : safeInt(leaveCnt?.total) + safeInt(expCnt?.total) + safeInt(apprCnt?.total),
    };

    if (detail) {
      // Oldest pending (highest risk) surfaced at the top
      const oldest = recent.sort((a, b) => safeInt(b.days_waiting) - safeInt(a.days_waiting));
      base.detail = {
        top_pending: oldest,
        oldest_days: safeInt(oldest[0]?.days_waiting),
        action_url: '/leaves',
      };
    }

    res.json(base);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch approvals" });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/activity  — latest audit log entries
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardActivity = async (req, res) => {
  try {
    const rows = await safeQuery(`
      SELECT id, action, module, description, performed_by, created_at
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.json({ activities: rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch activity" });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/alerts  — comprehensive live alert scanning
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardAlerts = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const cf  = cidClause(cid, 1);
    const cp  = cidParams(cid);

    const [leaves, overdueInv, probDue, overdueTasks, pendExp, lowStock, pendTS] = await Promise.all([
      safeOne(`SELECT COUNT(*) AS total FROM leaves WHERE status = 'pending'${cf}`, cp),
      safeOne("SELECT COUNT(*) AS total FROM invoices WHERE due_date < NOW() AND status NOT IN ('paid','cancelled')"),
      safeOne(`SELECT COUNT(*) AS total FROM employees
               WHERE LOWER(status) = 'probation' AND joining_date IS NOT NULL
                 AND (joining_date::date + INTERVAL '165 days')::date <= CURRENT_DATE
                 AND (joining_date::date + INTERVAL '180 days')::date >= CURRENT_DATE${cf}`, cp),
      safeOne("SELECT COUNT(*) AS total FROM tasks WHERE status NOT IN ('done','cancelled') AND due_date < CURRENT_DATE"),
      safeOne("SELECT COUNT(*) AS total FROM expense_claims WHERE status = 'pending'"),
      safeOne(`SELECT COUNT(*) AS total FROM inventory_items WHERE current_stock <= reorder_level AND current_stock > 0${cf}`, cp),
      safeOne("SELECT COUNT(*) AS total FROM timesheets WHERE status = 'submitted'"),
    ]);

    const alerts = [];
    if (safeInt(leaves?.total)       > 0) alerts.push({ type:"approval",  message:`${leaves.total} pending leave request${leaves.total > 1 ? 's' : ''} awaiting approval`,       priority:"high",   module:"leaves"     });
    if (safeInt(overdueInv?.total)   > 0) alerts.push({ type:"finance",   message:`${overdueInv.total} overdue invoice${overdueInv.total > 1 ? 's' : ''} need attention`,         priority:"high",   module:"finance"    });
    if (safeInt(probDue?.total)      > 0) alerts.push({ type:"probation", message:`${probDue.total} employee probation${probDue.total > 1 ? 's' : ''} ending in ≤15 days`,        priority:"high",   module:"employees"  });
    if (safeInt(overdueTasks?.total) > 0) alerts.push({ type:"tasks",     message:`${overdueTasks.total} overdue task${overdueTasks.total > 1 ? 's' : ''}`,                       priority:"medium", module:"projects"   });
    if (safeInt(pendExp?.total)      > 0) alerts.push({ type:"expense",   message:`${pendExp.total} expense claim${pendExp.total > 1 ? 's' : ''} pending approval`,               priority:"medium", module:"finance"    });
    if (safeInt(lowStock?.total)     > 0) alerts.push({ type:"inventory", message:`${lowStock.total} item${lowStock.total > 1 ? 's' : ''} below reorder level`,                   priority:"medium", module:"inventory"  });
    if (safeInt(pendTS?.total)       > 0) alerts.push({ type:"timesheet", message:`${pendTS.total} submitted timesheet${pendTS.total > 1 ? 's' : ''} awaiting review`,            priority:"low",    module:"timesheets" });

    if (alerts.length === 0)
      alerts.push({ type:"info", message:"All systems running smoothly — no alerts", priority:"low", module:"system" });

    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch alerts" });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/cash  — live cash position
   ?detail=true  → includes top-10 overdue invoices from the same invoice table
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardCashPosition = async (req, res) => {
  try {
    const detail = req.query.detail === 'true';

    const [receivable, payable, inflow, outflow, receiptsTotal, paymentsTotal, bankBalRow, arAgingRows, apAgingRows] = await Promise.all([
      safeOne("SELECT COALESCE(SUM(total_amount),0)::numeric AS total FROM invoices WHERE LOWER(status) NOT IN ('paid','cancelled') AND deleted_at IS NULL"),
      safeOne("SELECT COALESCE(SUM(total_amount),0)::numeric AS total FROM bills WHERE LOWER(status) NOT IN ('paid','cancelled') AND deleted_at IS NULL"),
      safeOne("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payments WHERE payment_date >= DATE_TRUNC('month', NOW())"),
      safeOne("SELECT COALESCE(SUM(total_amount),0)::numeric AS total FROM bills WHERE LOWER(status) = 'paid' AND updated_at >= DATE_TRUNC('month', NOW())"),
      safeOne("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM receipts"),
      safeOne("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payments"),
      safeOne("SELECT COALESCE(SUM(current_balance),0)::numeric AS total FROM bank_accounts WHERE is_active = true"),
      safeQuery(`SELECT
        CASE
          WHEN due_date >= CURRENT_DATE THEN 'Current'
          WHEN CURRENT_DATE - due_date::date <= 30  THEN '1-30 days'
          WHEN CURRENT_DATE - due_date::date <= 60  THEN '31-60 days'
          WHEN CURRENT_DATE - due_date::date <= 90  THEN '61-90 days'
          ELSE '90+ days'
        END AS bucket,
        COALESCE(SUM(balance),0)::numeric AS amount
        FROM invoices
        WHERE LOWER(status) NOT IN ('paid','cancelled') AND deleted_at IS NULL
        GROUP BY 1 ORDER BY MIN(due_date)`),
      safeQuery(`SELECT
        CASE
          WHEN due_date >= CURRENT_DATE THEN 'Current'
          WHEN CURRENT_DATE - due_date::date <= 30  THEN '1-30 days'
          WHEN CURRENT_DATE - due_date::date <= 60  THEN '31-60 days'
          WHEN CURRENT_DATE - due_date::date <= 90  THEN '61-90 days'
          ELSE '90+ days'
        END AS bucket,
        COALESCE(SUM(balance),0)::numeric AS amount
        FROM bills
        WHERE LOWER(status) NOT IN ('paid','cancelled') AND deleted_at IS NULL
        GROUP BY 1 ORDER BY MIN(due_date)`),
    ]);

    const bankBal = safeFloat(bankBalRow?.total);
    const balance = bankBal > 0
      ? bankBal
      : safeFloat(receiptsTotal?.total) - safeFloat(paymentsTotal?.total);
    const base = {
      balance,
      accountsReceivable : safeFloat(receivable?.total),
      accountsPayable    : safeFloat(payable?.total),
      inflow             : safeFloat(inflow?.total),
      outflow            : safeFloat(outflow?.total),
      arAging            : arAgingRows.map(r => ({ bucket: r.bucket, amount: safeFloat(r.amount) })),
      apAging            : apAgingRows.map(r => ({ bucket: r.bucket, amount: safeFloat(r.amount) })),
    };

    if (detail) {
      // Top overdue invoices — same table as receivable aggregate above
      const overdueRows = await safeQuery(`
        SELECT client_name, invoice_number, total_amount, due_date,
               (CURRENT_DATE - due_date::date) AS days_overdue
        FROM invoices
        WHERE status NOT IN ('paid','cancelled') AND due_date < CURRENT_DATE
        ORDER BY days_overdue DESC, total_amount DESC
        LIMIT 10
      `);
      base.detail = {
        top_overdue_invoices: overdueRows.map(r => ({ ...r, days_overdue: safeInt(r.days_overdue) })),
        action_url: '/finance/invoices',
      };
    }

    res.json(base);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch cash position" });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/sales  — CRM pipeline by stage
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardSalesPipeline = async (req, res) => {
  try {
    const rows = await safeQuery(`
      SELECT stage, COUNT(*) AS count, COALESCE(SUM(expected_value),0)::numeric AS value
      FROM opportunities
      WHERE deleted_at IS NULL
      GROUP BY stage
      ORDER BY CASE stage
        WHEN 'prospecting'   THEN 1
        WHEN 'qualification' THEN 2
        WHEN 'proposal'      THEN 3
        WHEN 'negotiation'   THEN 4
        WHEN 'closed_won'    THEN 5
        ELSE 6 END
    `);
    res.json({ stages: rows.map(r => ({ stage: r.stage, count: safeInt(r.count), value: safeFloat(r.value) })) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sales pipeline" });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/operations  — all operational counters
   ?detail=true  → includes top shortage items, top overdue tasks
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardOperations = async (req, res) => {
  try {
    const detail = req.query.detail === 'true';
    const cid = req.scope?.company_id ?? null;
    const cf  = cidClause(cid, 1);
    const cp  = cidParams(cid);

    const results = await Promise.all([
      safeOne("SELECT COUNT(*) AS total FROM projects WHERE status NOT IN ('completed','cancelled')"),
      safeOne(`SELECT COUNT(*) AS total FROM support_tickets WHERE status NOT IN ('Resolved','Closed') AND deleted_at IS NULL${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM inventory_items WHERE current_stock <= reorder_level AND current_stock > 0${cf}`, cp),
      safeOne("SELECT COUNT(*) AS total FROM invoices WHERE status = 'pending'"),
      safeOne(`SELECT COUNT(*) AS total FROM leaves WHERE status = 'approved' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE${cf}`, cp),
      safeOne("SELECT COUNT(*) AS total FROM tasks WHERE status = 'done' AND completed_at >= DATE_TRUNC('month', NOW())"),
      safeOne("SELECT COUNT(*) AS total FROM tasks WHERE status NOT IN ('done','cancelled') AND due_date < CURRENT_DATE"),
      safeOne("SELECT COUNT(*) AS total FROM timesheets WHERE status = 'submitted'"),
      safeOne(`SELECT COUNT(*) AS total FROM job_openings WHERE status = 'open' AND deleted_at IS NULL${cf}`, cp),
    ]);

    const [activeProjects, openTickets, lowStock, pendingInvoices, onLeave,
      tasksCompleted, overdueTasks, timesheetsPending, openRecruitments] = results;

    const base = {
      active_projects    : safeInt(activeProjects?.total),
      open_tickets       : safeInt(openTickets?.total),
      low_stock          : safeInt(lowStock?.total),
      pending_invoices   : safeInt(pendingInvoices?.total),
      on_leave           : safeInt(onLeave?.total),
      tasks_completed    : safeInt(tasksCompleted?.total),
      overdue_tasks      : safeInt(overdueTasks?.total),
      timesheets_pending : safeInt(timesheetsPending?.total),
      open_recruitments  : safeInt(openRecruitments?.total),
    };

    if (detail) {
      // Top shortage items — same WHERE as low_stock aggregate above
      const shortageRows = await safeQuery(`
        SELECT name, category, current_stock, reorder_level, unit,
               (reorder_level - current_stock) AS shortage_qty
        FROM inventory_items
        WHERE current_stock <= reorder_level AND current_stock > 0
          ${cf ? `AND company_id = ${cp[0]}` : ''}
        ORDER BY shortage_qty DESC, current_stock ASC
        LIMIT 10
      `);
      // Top overdue tasks — same WHERE as overdue_tasks aggregate above
      const overdueTaskRows = await safeQuery(`
        SELECT t.id, t.title, t.due_date, t.priority,
               (CURRENT_DATE - t.due_date::date) AS days_overdue,
               e.first_name || ' ' || e.last_name AS assigned_to_name
        FROM tasks t
        LEFT JOIN employees e ON e.id = t.assigned_to
        WHERE t.status NOT IN ('done','cancelled') AND t.due_date < CURRENT_DATE
        ORDER BY days_overdue DESC
        LIMIT 10
      `);
      base.detail = {
        top_shortage_items: shortageRows,
        top_overdue_tasks:  overdueTaskRows,
        action_urls: { low_stock: '/inventory', overdue_tasks: '/projects' },
      };
    }

    res.json(base);
  } catch (err) {
    console.error('getDashboardOperations error:', err);
    res.status(500).json({ error: 'Failed to fetch operations data' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/finance  — full finance dashboard
══════════════════════════════════════════════════════════════════════════════ */
export const getFinanceDashboard = async (req, res) => {
  try {
    const [invoiceStats, billStats, monthlyRev, expByMonth, overdueInvoices,
      upcomingPayments, expByCategory, arAging, apAging,
      receiptsTotal, paymentsTotal, expMTD] = await Promise.all([
      safeOne(`
        SELECT
          COUNT(*) FILTER (WHERE status='pending')  AS pending_count,
          COUNT(*) FILTER (WHERE status='overdue' OR (due_date < NOW() AND status NOT IN ('paid','cancelled'))) AS overdue_count,
          COALESCE(SUM(total_amount) FILTER (WHERE status='paid' AND created_at >= DATE_TRUNC('month', NOW())),0)::numeric AS collected_mtd,
          COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('paid','cancelled')),0)::numeric AS outstanding
        FROM invoices
      `),
      safeOne(`
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('paid','cancelled')),0)::numeric AS payable,
          COALESCE(SUM(amount) FILTER (WHERE due_date BETWEEN NOW() AND NOW() + INTERVAL '30 days' AND status NOT IN ('paid','cancelled')),0)::numeric AS due_30days
        FROM bills
      `),
      safeQuery(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month,
               SUM(total_amount)::numeric AS revenue,
               DATE_TRUNC('month', created_at) AS month_date
        FROM invoices WHERE created_at >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', created_at) ORDER BY month_date
      `),
      safeQuery(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month,
               SUM(amount)::numeric AS expenses
        FROM expense_claims WHERE created_at >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', created_at) ORDER BY DATE_TRUNC('month', created_at)
      `),
      safeQuery(`
        SELECT invoice_number, party_name, total_amount::numeric, due_date, status,
               EXTRACT(DAY FROM NOW() - due_date)::int AS days_overdue
        FROM invoices
        WHERE (status='overdue' OR (due_date < NOW() AND status NOT IN ('paid','cancelled')))
        ORDER BY due_date ASC LIMIT 8
      `),
      safeQuery(`
        SELECT id, bill_number, party_name, amount::numeric, due_date,
               EXTRACT(DAY FROM due_date - NOW())::int AS days_until_due
        FROM bills
        WHERE due_date BETWEEN NOW() AND NOW() + INTERVAL '30 days' AND status NOT IN ('paid','cancelled')
        ORDER BY due_date ASC LIMIT 8
      `),
      safeQuery(`
        SELECT category, SUM(amount)::numeric AS total FROM expense_claims
        WHERE created_at >= DATE_TRUNC('month', NOW()) GROUP BY category ORDER BY total DESC
      `),
      safeQuery(`
        SELECT CASE
          WHEN due_date >= NOW() - INTERVAL '30 days' THEN '0–30 days'
          WHEN due_date >= NOW() - INTERVAL '60 days' THEN '31–60 days'
          WHEN due_date >= NOW() - INTERVAL '90 days' THEN '61–90 days'
          ELSE '90+ days' END AS bucket,
          COALESCE(SUM(total_amount),0)::numeric AS amount
        FROM invoices WHERE status NOT IN ('paid','cancelled') AND due_date < NOW()
        GROUP BY 1 ORDER BY MIN(due_date) DESC
      `),
      safeQuery(`
        SELECT CASE
          WHEN due_date >= NOW() - INTERVAL '30 days' THEN '0–30 days'
          WHEN due_date >= NOW() - INTERVAL '60 days' THEN '31–60 days'
          WHEN due_date >= NOW() - INTERVAL '90 days' THEN '61–90 days'
          ELSE '90+ days' END AS bucket,
          COALESCE(SUM(amount),0)::numeric AS amount
        FROM bills WHERE status NOT IN ('paid','cancelled') AND due_date < NOW()
        GROUP BY 1 ORDER BY MIN(due_date) DESC
      `),
      safeOne("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM receipts"),
      safeOne("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payments"),
      safeOne("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM expense_claims WHERE created_at >= DATE_TRUNC('month', NOW())"),
    ]);

    const cashBalance = safeFloat(receiptsTotal?.total) - safeFloat(paymentsTotal?.total);
    const netProfit   = safeFloat(invoiceStats?.collected_mtd) - safeFloat(expMTD?.total);

    res.json({
      kpis: {
        receivable      : safeFloat(invoiceStats?.outstanding),
        payable         : safeFloat(billStats?.payable),
        collectedMTD    : safeFloat(invoiceStats?.collected_mtd),
        overdueCount    : safeInt(invoiceStats?.overdue_count),
        pendingInvoices : safeInt(invoiceStats?.pending_count),
        due30Days       : safeFloat(billStats?.due_30days),
        cashBalance, netProfit,
      },
      monthlyRev    : monthlyRev.map(r => ({ month: r.month, revenue: safeFloat(r.revenue) })),
      expByMonth    : expByMonth.map(r => ({ month: r.month, expenses: safeFloat(r.expenses) })),
      overdueInvoices, upcomingPayments,
      expByCategory : expByCategory.map(r => ({ name: r.category || 'Other', value: safeFloat(r.total) })),
      arAging : arAging.map(r => ({ bucket: r.bucket, amount: safeFloat(r.amount) })),
      apAging : apAging.map(r => ({ bucket: r.bucket, amount: safeFloat(r.amount) })),
    });
  } catch (err) {
    console.error('getFinanceDashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch finance dashboard' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/hires  — recent new employees (live)
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardHires = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const rows = await safeQuery(`
      SELECT id, first_name, last_name, department, designation,
             joining_date, office_id, status
      FROM employees
      WHERE joining_date IS NOT NULL
        AND LOWER(COALESCE(status,'active')) NOT IN ('left','terminated','resigned','inactive','ex-employee')
        ${cidClause(cid, 1)}
      ORDER BY joining_date DESC
      LIMIT 8
    `, cidParams(cid));
    res.json({ hires: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recent hires' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/leave-summary  — leave stats for current month
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardLeaveSummary = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const cf  = cidClause(cid, 1);
    const cp  = cidParams(cid);

    const [pending, approved, onLeave, byType] = await Promise.all([
      safeOne(`SELECT COUNT(*) AS total FROM leaves WHERE status = 'pending'${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM leaves WHERE status = 'approved' AND created_at >= DATE_TRUNC('month', NOW())${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM leaves WHERE status = 'approved' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE${cf}`, cp),
      safeQuery(`
        SELECT leave_type, COUNT(*) AS count FROM leaves
        WHERE status = 'approved' AND created_at >= DATE_TRUNC('month', NOW())${cf}
        GROUP BY leave_type ORDER BY count DESC LIMIT 6
      `, cp),
    ]);
    res.json({
      pending  : safeInt(pending?.total),
      approved : safeInt(approved?.total),
      onLeave  : safeInt(onLeave?.total),
      byType   : byType.map(r => ({ type: r.leave_type, count: safeInt(r.count) })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leave summary' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   Private helpers  — accept cid so exported handlers can pass scope down
══════════════════════════════════════════════════════════════════════════════ */

const getExecutiveData = async (cid = null) => {
  const cf = cidClause(cid, 1);
  const cp = cidParams(cid);

  const [emp, newHires, attrRow, attRow, pendAppr, revRow, openProj] = await Promise.all([
    safeOne(`SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) IN ('active', 'probation')${cf}`, cp),
    safeOne(`SELECT COUNT(*) AS total FROM employees WHERE joining_date >= DATE_TRUNC('month', NOW()) AND LOWER(status) != 'left'${cf}`, cp),
    safeOne(`SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) IN ('inactive','terminated','left') AND updated_at >= DATE_TRUNC('month', NOW())${cf}`, cp),
    safeOne(`
      SELECT COUNT(*) FILTER (WHERE status = 'present') AS present_count,
             (SELECT COUNT(*) FROM employees WHERE LOWER(status) IN ('active', 'probation')${cf}) AS total_emp
      FROM attendance WHERE date = CURRENT_DATE
    `, cp),
    safeOne(`
      SELECT COALESCE(
        (SELECT COUNT(*) FROM leaves WHERE status='pending'${cf}), 0
      ) + COALESCE(
        (SELECT COUNT(*) FROM expense_claims WHERE status='pending'), 0
      ) + COALESCE(
        (SELECT COUNT(*) FROM approvals WHERE status='Pending'), 0
      ) AS total
    `, cp),
    safeOne("SELECT COALESCE(SUM(total_amount),0)::numeric AS total FROM invoices WHERE created_at >= DATE_TRUNC('month', NOW()) AND status NOT IN ('cancelled')"),
    safeOne("SELECT COUNT(*) AS total FROM projects WHERE status NOT IN ('completed','cancelled')"),
  ]);

  const totalEmp     = safeInt(emp?.total);
  const presentCount = safeInt(attRow?.present_count);
  const empCount     = safeInt(attRow?.total_emp) || 1;
  const attendanceRate = empCount > 1 ? Math.round((presentCount / empCount) * 100) : 0;
  const revMTD = safeFloat(revRow?.total);

  return {
    workforce: { total: totalEmp, newHires: safeInt(newHires?.total), attrition: safeInt(attrRow?.total), attendanceRate },
    kpis: [
      { label: "Total Employees",   value: totalEmp,                 trend: "up"     },
      { label: "Revenue (MTD)",     value: revMTD,                   trend: "up"     },
      { label: "Pending Approvals", value: safeInt(pendAppr?.total), trend: "down"   },
      { label: "Open Projects",     value: safeInt(openProj?.total), trend: "stable" },
    ],
  };
};

const getManagerData = async (userId, cid = null) => {
  const cf = cidClause(cid, 1);
  const cp = cidParams(cid);

  const [teamSize, pendAppr, overdueTasks, attRow] = await Promise.all([
    safeOne(`SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) IN ('active','probation')${cf}`, cp),
    safeOne(`SELECT COUNT(*) AS total FROM leaves WHERE status = 'pending'${cf}`, cp),
    safeOne("SELECT COUNT(*) AS total FROM tasks WHERE status NOT IN ('done','cancelled') AND due_date < CURRENT_DATE"),
    safeOne(`
      SELECT COUNT(*) FILTER (WHERE status = 'present') AS present,
             (SELECT COUNT(*) FROM employees WHERE LOWER(status) IN ('active','probation')${cf}) AS total
      FROM attendance WHERE date = CURRENT_DATE
    `, cp),
  ]);
  const present = safeInt(attRow?.present);
  const total   = safeInt(attRow?.total) || 1;
  const rate    = total > 1 ? Math.round((present / total) * 100) : 0;

  return {
    kpis: [
      { label: "Team Size",         value: safeInt(teamSize?.total) },
      { label: "Pending Approvals", value: safeInt(pendAppr?.total) },
      { label: "Tasks Overdue",     value: safeInt(overdueTasks?.total) },
      { label: "Attendance Rate",   value: `${rate}%` },
    ],
  };
};

const getEmployeeData = async (userId, cid = null) => {
  const [tasks, leaveBal, attRow, pendActions] = await Promise.all([
    safeOne("SELECT COUNT(*) AS total FROM tasks WHERE status NOT IN ('done','cancelled') AND due_date <= NOW() + INTERVAL '7 days'"),
    safeOne("SELECT COALESCE(SUM(days_remaining), 0) AS total FROM leave_balances WHERE CURRENT_DATE BETWEEN valid_from AND valid_to"),
    safeOne("SELECT COUNT(*) AS total FROM attendance WHERE date = CURRENT_DATE AND status = 'present'"),
    safeOne("SELECT COUNT(*) AS total FROM leaves WHERE status = 'pending'"),
  ]);

  return {
    kpis: [
      { label: "My Tasks Due",    value: safeInt(tasks?.total)      },
      { label: "Leave Balance",   value: safeInt(leaveBal?.total)   },
      { label: "Pending Actions", value: safeInt(pendActions?.total)},
    ],
  };
};

const getInsightMessage = (role) => ({
  super_admin     : "Executive overview — all modules active",
  admin           : "Admin panel — manage your team",
  manager         : "Team dashboard — approvals need your attention",
  department_head : "Department overview",
  employee        : "Your personal workspace",
}[role] || "Welcome to Pulse ERP");

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/summary  — all 6 KPIs in one call (P1 fix)
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardSummary = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const cf  = cidClause(cid, 1);
    const cp  = cidParams(cid);

    const [rev, emp, appr, proj, att, alertCount] = await Promise.all([
      safeOne(`SELECT COALESCE(SUM(total_amount),0)::numeric AS ytd
               FROM invoices WHERE EXTRACT(year FROM created_at) = EXTRACT(year FROM CURRENT_DATE)`),
      safeOne(`SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) IN ('active','probation')${cf}`, cp),
      safeOne(`SELECT (
        COALESCE((SELECT COUNT(*) FROM leaves WHERE status='pending'${cf}),0) +
        COALESCE((SELECT COUNT(*) FROM expense_claims WHERE status='pending'),0) +
        COALESCE((SELECT COUNT(*) FROM approvals WHERE status='Pending'),0)
      ) AS total`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM projects WHERE status NOT IN ('completed','cancelled')`),
      safeOne(`SELECT COUNT(*) FILTER (WHERE status='present') AS present,
                      (SELECT COUNT(*) FROM employees WHERE LOWER(status) IN ('active','probation')${cf}) AS total_emp
               FROM attendance WHERE date = CURRENT_DATE`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM (
        SELECT 1 FROM leaves WHERE status='pending'${cf}
        UNION ALL SELECT 1 FROM invoices WHERE due_date < NOW() AND status NOT IN ('paid','cancelled')
        UNION ALL SELECT 1 FROM tasks WHERE status NOT IN ('done','cancelled') AND due_date < CURRENT_DATE
      ) x`, cp),
    ]);
    const totalEmp = safeInt(att?.total_emp) || 1;
    res.json({
      revenueYTD       : safeFloat(rev?.ytd),
      totalEmployees   : safeInt(emp?.total),
      pendingApprovals : safeInt(appr?.total),
      activeProjects   : safeInt(proj?.total),
      attendanceRate   : totalEmp > 1 ? Math.round((safeInt(att?.present) / totalEmp) * 100) : 0,
      openAlerts       : safeInt(alertCount?.total),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/top-customers  — top 5 by paid invoice revenue (last 12 months)
══════════════════════════════════════════════════════════════════════════════ */
export const getTopCustomers = async (req, res) => {
  try {
    const rows = await safeQuery(`
      SELECT party_name AS name,
             COALESCE(SUM(total_amount),0)::numeric AS revenue,
             COUNT(*) AS invoice_count
      FROM invoices
      WHERE status = 'paid'
        AND created_at >= NOW() - INTERVAL '12 months'
        AND party_name IS NOT NULL AND party_name != ''
      GROUP BY party_name
      ORDER BY revenue DESC LIMIT 5
    `);
    res.json({ customers: rows.map(r => ({ name: r.name, revenue: safeFloat(r.revenue), invoiceCount: safeInt(r.invoice_count) })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch top customers' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/top-vendors  — top 5 by paid bills spend (last 12 months)
══════════════════════════════════════════════════════════════════════════════ */
export const getTopVendors = async (req, res) => {
  try {
    const rows = await safeQuery(`
      SELECT party_name AS name,
             COALESCE(SUM(amount),0)::numeric AS spend,
             COUNT(*) AS bill_count
      FROM bills
      WHERE status = 'paid'
        AND created_at >= NOW() - INTERVAL '12 months'
        AND party_name IS NOT NULL AND party_name != ''
      GROUP BY party_name
      ORDER BY spend DESC LIMIT 5
    `);
    res.json({ vendors: rows.map(r => ({ name: r.name, spend: safeFloat(r.spend), billCount: safeInt(r.bill_count) })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch top vendors' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/live-kpis  — single call aggregating all real-time KPIs for home
══════════════════════════════════════════════════════════════════════════════ */
export const getLiveKPIs = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const cf  = cidClause(cid, 1);
    const cp  = cidParams(cid);

    const [
      todayRev, monthRev, ytdRev,
      openPOs, lowStock,
      activeProjects, overdueTasks,
      overdueInv, pendingApprovals,
      empCount, onLeave,
      recentActivity,
      celebrationsRows,
      attendanceRow,
    ] = await Promise.allSettled([
      safeOne(`SELECT COALESCE(SUM(COALESCE(total_amount,amount,0)),0)::numeric AS v
               FROM invoices WHERE DATE(created_at) = CURRENT_DATE AND LOWER(status) = 'paid'`),
      safeOne(`SELECT COALESCE(SUM(COALESCE(total_amount,amount,0)),0)::numeric AS v
               FROM invoices WHERE created_at >= DATE_TRUNC('month', NOW()) AND LOWER(status) NOT IN ('cancelled')`),
      safeOne(`SELECT COALESCE(SUM(COALESCE(total_amount,amount,0)),0)::numeric AS v
               FROM invoices WHERE EXTRACT(year FROM created_at) = EXTRACT(year FROM NOW()) AND LOWER(status) NOT IN ('cancelled')`),
      safeOne(`SELECT COUNT(*)::int AS v FROM purchase_orders WHERE LOWER(status) IN ('pending','approved','in_progress','open')${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM inventory_items WHERE current_stock <= reorder_level AND reorder_level > 0${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM projects WHERE LOWER(status) NOT IN ('completed','cancelled','closed')`),
      safeOne(`SELECT COUNT(*)::int AS v FROM tasks WHERE status NOT IN ('done','cancelled') AND due_date < CURRENT_DATE`),
      safeOne(`SELECT COUNT(*)::int AS v FROM invoices WHERE due_date < CURRENT_DATE AND LOWER(status) NOT IN ('paid','cancelled')`),
      safeOne(`SELECT (
        COALESCE((SELECT COUNT(*) FROM leave_applications la
                  LEFT JOIN employees e ON e.id::text = la.employee_id::text
                  WHERE la.status='pending'${cf}),0)+
        COALESCE((SELECT COUNT(*) FROM expense_claims WHERE LOWER(status)='pending'),0)+
        COALESCE((SELECT COUNT(*) FROM purchase_requests pr
                  LEFT JOIN employees e ON e.id = pr.requested_by_employee_id
                  WHERE pr.status IN ('pending_approval','pending')${cf}),0)+
        COALESCE((SELECT COUNT(*) FROM attendance_regularization_requests WHERE status='pending'${cf}),0)+
        COALESCE((SELECT COUNT(*) FROM attendance_ot_records WHERE status='pending'${cf}),0)+
        COALESCE((SELECT COUNT(*) FROM approvals WHERE status='Pending'),0)
      ) AS v`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM employees WHERE LOWER(status) IN ('active','probation')${cf}`, cp),
      safeOne(
        cid != null
          // `leaves` has no company_id column — scope via the employee's company.
          ? `SELECT COUNT(*)::int AS v FROM leaves l
               JOIN employees e ON e.id::text = l.employee_id::text
              WHERE l.status='approved' AND l.start_date<=CURRENT_DATE AND l.end_date>=CURRENT_DATE
                AND e.company_id = $1`
          : `SELECT COUNT(*)::int AS v FROM leaves
              WHERE status='approved' AND start_date<=CURRENT_DATE AND end_date>=CURRENT_DATE`,
        cidParams(cid)
      ),
      safeQuery(`SELECT action, module, description, performed_by, created_at
                 FROM audit_logs ORDER BY created_at DESC LIMIT 8`),
      safeQuery(`SELECT id, first_name, last_name, department,
                        dob, joining_date, anniversary_date
                 FROM employees
                 WHERE LOWER(status) IN ('active','probation')
                   AND (
                     (dob IS NOT NULL
                      AND EXTRACT(month FROM dob) = EXTRACT(month FROM CURRENT_DATE)
                      AND EXTRACT(day   FROM dob) = EXTRACT(day   FROM CURRENT_DATE))
                     OR
                     (joining_date IS NOT NULL
                      AND joining_date < CURRENT_DATE
                      AND EXTRACT(month FROM joining_date) = EXTRACT(month FROM CURRENT_DATE)
                      AND EXTRACT(day   FROM joining_date) = EXTRACT(day   FROM CURRENT_DATE))
                     OR
                     (anniversary_date IS NOT NULL
                      AND EXTRACT(month FROM anniversary_date) = EXTRACT(month FROM CURRENT_DATE)
                      AND EXTRACT(day   FROM anniversary_date) = EXTRACT(day   FROM CURRENT_DATE))
                   )${cf}
                 LIMIT 20`, cp),
      safeOne(`SELECT COUNT(*) FILTER (WHERE status = 'present') AS present,
                      (SELECT COUNT(*) FROM employees
                        WHERE LOWER(status) IN ('active','probation')${cf}) AS total
               FROM attendance WHERE date = CURRENT_DATE`, cp),
    ]);

    const val = (p) => (p.status === 'fulfilled' ? p.value : null);

    // Build celebrations from DB-filtered employees (today's date matches)
    const nowDate  = new Date();
    const todayM   = nowDate.getMonth() + 1;
    const todayD   = nowDate.getDate();
    const todayY   = nowDate.getFullYear();
    const parseLD  = str => {
      if (!str) return null;
      const s = String(str).slice(0, 10);
      const [yr, mo, dy] = s.split('-').map(Number);
      return (yr && mo && dy) ? { yr, mo, dy } : null;
    };
    const celebrations = (val(celebrationsRows) || []).flatMap(emp => {
      const name  = `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || 'Employee';
      const dept  = emp.department || '';
      const items = [];
      const dob   = parseLD(emp.dob);
      if (dob && dob.mo === todayM && dob.dy === todayD)
        items.push({ employeeId: emp.id, name, dept, type: 'Birthday', icon: '🎂' });
      const join  = parseLD(emp.joining_date);
      if (join && join.mo === todayM && join.dy === todayD && todayY > join.yr)
        items.push({ employeeId: emp.id, name, dept, type: 'Work Anniversary', icon: '🏆', years: todayY - join.yr });
      const ann   = parseLD(emp.anniversary_date);
      if (ann && ann.mo === todayM && ann.dy === todayD)
        items.push({ employeeId: emp.id, name, dept, type: 'Wedding Anniversary', icon: '💍' });
      return items;
    });

    const attRowV  = val(attendanceRow);
    const attTotal = safeInt(attRowV?.total);
    const attRate  = attTotal > 0 ? Math.round((safeInt(attRowV?.present) / attTotal) * 100) : 0;

    res.json({
      revenue: {
        today: safeFloat(val(todayRev)?.v),
        mtd:   safeFloat(val(monthRev)?.v),
        ytd:   safeFloat(val(ytdRev)?.v),
      },
      procurement: {
        openPOs: safeInt(val(openPOs)?.v),
      },
      inventory: {
        lowStockAlerts: safeInt(val(lowStock)?.v),
      },
      projects: {
        active:       safeInt(val(activeProjects)?.v),
        overdueTasks: safeInt(val(overdueTasks)?.v),
      },
      finance: {
        overdueInvoices:  safeInt(val(overdueInv)?.v),
        pendingApprovals: safeInt(val(pendingApprovals)?.v),
      },
      workforce: {
        total:   safeInt(val(empCount)?.v),
        onLeave: safeInt(val(onLeave)?.v),
      },
      recentActivity: (val(recentActivity) || []).map(r => ({
        action:      r.action,
        module:      r.module,
        description: r.description,
        performedBy: r.performed_by,
        time:        r.created_at,
      })),
      celebrations,
      attendance: { rate: attRate, total: attTotal, present: safeInt(attRowV?.present) },
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('getLiveKPIs error:', err);
    res.status(500).json({ error: 'Failed to fetch live KPIs' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/project-health  — project KPIs + budget utilisation
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardProjectHealth = async (req, res) => {
  try {
    const [active, overdue, atRisk, doneMTD, budget] = await Promise.all([
      safeOne(`SELECT COUNT(*) AS total FROM projects WHERE status NOT IN ('completed','cancelled')`),
      safeOne(`SELECT COUNT(*) AS total FROM tasks WHERE status NOT IN ('done','cancelled') AND due_date < CURRENT_DATE`),
      safeOne(`
        SELECT COUNT(DISTINCT project_id) AS total FROM tasks
        WHERE status NOT IN ('done','cancelled') AND due_date < CURRENT_DATE AND project_id IS NOT NULL
      `),
      safeOne(`SELECT COUNT(*) AS total FROM tasks WHERE status = 'done' AND completed_at >= DATE_TRUNC('month', NOW())`),
      safeOne(`
        SELECT
          COALESCE(SUM(budget_used),0)::numeric  AS used,
          COALESCE(SUM(total_budget),0)::numeric AS total
        FROM projects WHERE total_budget > 0 AND status NOT IN ('completed','cancelled')
      `),
    ]);

    const budgetUsed  = safeFloat(budget?.total) > 0
      ? Math.round((safeFloat(budget?.used) / safeFloat(budget?.total)) * 100)
      : null;

    res.json({
      active_projects       : safeInt(active?.total),
      overdue_tasks         : safeInt(overdue?.total),
      at_risk               : safeInt(atRisk?.total),
      completed_this_month  : safeInt(doneMTD?.total),
      budget_used           : budgetUsed,
    });
  } catch (err) {
    console.error('getDashboardProjectHealth error:', err);
    res.status(500).json({ error: 'Failed to fetch project health' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/headcount-trend  — monthly hires vs attrition (last 12 months)
══════════════════════════════════════════════════════════════════════════════ */
export const getHeadcountTrend = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const cf  = cidClause(cid, 1);
    const cp  = cidParams(cid);

    const [hireRows, attrRows] = await Promise.all([
      safeQuery(`SELECT TO_CHAR(DATE_TRUNC('month', joining_date), 'Mon ''YY') AS month,
                        DATE_TRUNC('month', joining_date) AS month_ts, COUNT(*) AS cnt
                 FROM employees
                 WHERE joining_date >= NOW() - INTERVAL '12 months' AND joining_date IS NOT NULL${cf}
                 GROUP BY DATE_TRUNC('month', joining_date) ORDER BY 2`, cp),
      safeQuery(`SELECT TO_CHAR(DATE_TRUNC('month', updated_at), 'Mon ''YY') AS month,
                        DATE_TRUNC('month', updated_at) AS month_ts, COUNT(*) AS cnt
                 FROM employees
                 WHERE LOWER(status) IN ('left','terminated','inactive')
                   AND updated_at >= NOW() - INTERVAL '12 months'${cf}
                 GROUP BY DATE_TRUNC('month', updated_at) ORDER BY 2`, cp),
    ]);
    const map = {};
    for (const r of hireRows)  map[r.month] = { month: r.month, ts: r.month_ts, hires: safeInt(r.cnt), attrition: 0 };
    for (const r of attrRows) {
      if (map[r.month]) map[r.month].attrition = safeInt(r.cnt);
      else              map[r.month] = { month: r.month, ts: r.month_ts, hires: 0, attrition: safeInt(r.cnt) };
    }
    const trend = Object.values(map).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    res.json({ trend });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch headcount trend' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/celebrations  — birthdays today/this week + work anniversaries
   Reads employees.dob and employees.joining_date (both company-scoped)
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardCelebrations = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const cf  = cidClause(cid, 1);
    const cp  = cidParams(cid);

    const [birthdaysToday, birthdaysWeek, anniversariesToday, anniversariesMonth] = await Promise.all([
      // Birthdays today
      safeQuery(`
        SELECT first_name, last_name, department, designation,
               dob AS date_of_birth,
               EXTRACT(YEAR FROM AGE(dob)) AS age
        FROM employees
        WHERE LOWER(status) IN ('active','probation')
          AND dob IS NOT NULL
          AND TO_CHAR(dob, 'MM-DD') = TO_CHAR(CURRENT_DATE, 'MM-DD')${cf}
        ORDER BY first_name
      `, cp),

      // Birthdays this week (next 7 days, excluding today)
      safeQuery(`
        SELECT first_name, last_name, department, designation, dob AS date_of_birth,
               (DATE_TRUNC('year', CURRENT_DATE) +
                (dob - DATE_TRUNC('year', dob)))::date AS birthday_this_year
        FROM employees
        WHERE LOWER(status) IN ('active','probation')
          AND dob IS NOT NULL
          AND TO_CHAR(dob, 'MM-DD') > TO_CHAR(CURRENT_DATE, 'MM-DD')
          AND TO_CHAR(dob, 'MM-DD') <= TO_CHAR(CURRENT_DATE + INTERVAL '7 days', 'MM-DD')${cf}
        ORDER BY TO_CHAR(dob, 'MM-DD')
        LIMIT 5
      `, cp),

      // Work anniversaries today
      safeQuery(`
        SELECT first_name, last_name, department, designation, joining_date,
               EXTRACT(YEAR FROM AGE(joining_date))::int AS years
        FROM employees
        WHERE LOWER(status) IN ('active','probation')
          AND joining_date IS NOT NULL
          AND TO_CHAR(joining_date, 'MM-DD') = TO_CHAR(CURRENT_DATE, 'MM-DD')
          AND joining_date::date < CURRENT_DATE${cf}
        ORDER BY first_name
      `, cp),

      // Work anniversaries this month
      safeQuery(`
        SELECT first_name, last_name, department, joining_date,
               EXTRACT(YEAR FROM AGE(joining_date))::int AS years
        FROM employees
        WHERE LOWER(status) IN ('active','probation')
          AND joining_date IS NOT NULL
          AND EXTRACT(MONTH FROM joining_date) = EXTRACT(MONTH FROM CURRENT_DATE)
          AND TO_CHAR(joining_date, 'MM-DD') > TO_CHAR(CURRENT_DATE, 'MM-DD')
          AND joining_date::date < CURRENT_DATE${cf}
        ORDER BY TO_CHAR(joining_date, 'DD')
        LIMIT 5
      `, cp),
    ]);

    res.json({
      birthdays: {
        today: birthdaysToday.map(r => ({
          name:        `${r.first_name} ${r.last_name}`,
          department:  r.department || '',
          designation: r.designation || '',
          age:         safeInt(r.age),
        })),
        this_week: birthdaysWeek.map(r => ({
          name:        `${r.first_name} ${r.last_name}`,
          department:  r.department || '',
          date:        r.date_of_birth,
        })),
      },
      anniversaries: {
        today: anniversariesToday.map(r => ({
          name:       `${r.first_name} ${r.last_name}`,
          department: r.department || '',
          years:      safeInt(r.years),
        })),
        this_month: anniversariesMonth.map(r => ({
          name:       `${r.first_name} ${r.last_name}`,
          department: r.department || '',
          years:      safeInt(r.years),
          date:       r.joining_date,
        })),
      },
    });
  } catch (err) {
    console.error('getDashboardCelebrations error:', err);
    res.status(500).json({ error: 'Failed to fetch celebrations' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/cfo  — CFO Dashboard: all KPIs, ratios, cash flow, forecast,
                     expense breakdown, and alerts in one period-aware call.
   ?period=YTD|Q1|Q2|Q3|Q4  (default: YTD, Indian fiscal year Apr–Mar)
══════════════════════════════════════════════════════════════════════════════ */
export const getCFODashboard = async (req, res) => {
  try {
    const period   = ((req.query.period || 'YTD')).toUpperCase();
    const cid      = req.scope?.company_id ?? null;
    const now      = new Date();
    const year     = now.getFullYear();
    const month    = now.getMonth() + 1; // 1-12
    const todayStr = now.toISOString().slice(0, 10);

    // Indian fiscal year: Apr 1 → Mar 31. fyYear = year the FY started.
    const currentFyYear = month >= 4 ? year : year - 1;
    // Optional ?fyStart=YYYY-04-01 lets the client pick a past/future FY.
    let fyYear = currentFyYear;
    const fyStartParam = req.query.fyStart;
    if (fyStartParam && /^\d{4}-\d{2}-\d{2}$/.test(fyStartParam)) {
      const parsed = parseInt(fyStartParam.slice(0, 4), 10);
      if (!Number.isNaN(parsed)) fyYear = parsed;
    }
    // For a past/future FY, YTD spans the whole year; for the live FY it stops today.
    const ytdEnd = fyYear === currentFyYear ? todayStr : `${fyYear + 1}-03-31`;
    const periodRanges = {
      YTD: [`${fyYear}-04-01`,         ytdEnd],
      Q1:  [`${fyYear}-04-01`,         `${fyYear}-06-30`],
      Q2:  [`${fyYear}-07-01`,         `${fyYear}-09-30`],
      Q3:  [`${fyYear}-10-01`,         `${fyYear}-12-31`],
      Q4:  [`${fyYear + 1}-01-01`,     `${fyYear + 1}-03-31`],
    };
    const [startDate, endDate] = periodRanges[period] || periodRanges.YTD;
    const daysInPeriod = Math.max(1,
      Math.round((new Date(endDate) - new Date(startDate)) / 86400000));
    const monthsInPeriod = Math.max(1, daysInPeriod / 30.44);

    const [
      revRow,
      expRow,
      billsPaidRow,
      arRow,
      apRow,
      receiptsRow,
      paymentsRow,
      histRevRows,
      expByCatRows,
      overdueInvRow,
      pendingExpRow,
      overdueTasksRow,
      pendingLeavesRow,
      lowStockRow,
      monthlyInflowRows,
      monthlyExpRows,
      monthlyBillsRows,
    ] = await Promise.all([

      // Paid invoices revenue for period
      safeOne(
        `SELECT COALESCE(SUM(COALESCE(total_amount,amount,0)),0)::numeric AS total
         FROM invoices WHERE LOWER(status)='paid'
           AND created_at >= $1::date AND created_at <= $2::date${cidClause(cid, 3)}`,
        cidParams(cid, [startDate, endDate])
      ),
      // Approved expense claims for period
      safeOne(
        `SELECT COALESCE(SUM(amount),0)::numeric AS total
         FROM expense_claims WHERE LOWER(status)='approved'
           AND created_at >= $1::date AND created_at <= $2::date${cidClause(cid, 3)}`,
        cidParams(cid, [startDate, endDate])
      ),
      // Paid bills for period
      safeOne(
        `SELECT COALESCE(SUM(amount),0)::numeric AS total
         FROM bills WHERE LOWER(status)='paid'
           AND updated_at >= $1::date AND updated_at <= $2::date${cidClause(cid, 3)}`,
        cidParams(cid, [startDate, endDate])
      ),
      // Outstanding invoices (AR snapshot)
      safeOne(
        `SELECT COALESCE(SUM(COALESCE(total_amount,amount,0)),0)::numeric AS total
         FROM invoices WHERE status NOT IN ('paid','cancelled')${cidClause(cid, 1)}`,
        cidParams(cid)
      ),
      // Outstanding bills (AP snapshot)
      safeOne(
        `SELECT COALESCE(SUM(amount),0)::numeric AS total
         FROM bills WHERE status NOT IN ('paid','cancelled')${cidClause(cid, 1)}`,
        cidParams(cid)
      ),
      // All-time receipts (cash in)
      safeOne(
        `SELECT COALESCE(SUM(amount),0)::numeric AS total FROM receipts${cidClause(cid, 1).replace(' AND ', ' WHERE ')}`,
        cidParams(cid)
      ),
      // All-time payments (cash out)
      safeOne(
        `SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payments${cidClause(cid, 1).replace(' AND ', ' WHERE ')}`,
        cidParams(cid)
      ),

      // Historical revenue for forecast: last 9 months of paid invoices
      safeQuery(
        `SELECT TO_CHAR(DATE_TRUNC('month',created_at),'Mon') AS month,
                DATE_TRUNC('month',created_at) AS month_ts,
                COALESCE(SUM(COALESCE(total_amount,amount,0)),0)::numeric AS revenue
         FROM invoices WHERE LOWER(status)='paid'
           AND created_at >= NOW() - INTERVAL '9 months'${cidClause(cid, 1)}
         GROUP BY DATE_TRUNC('month',created_at) ORDER BY 2`,
        cidParams(cid)
      ),

      // Expense breakdown by category for period
      safeQuery(
        `SELECT COALESCE(ec.name, 'Other') AS category,
                SUM(eci.amount)::numeric AS total
         FROM expense_claim_items eci
         LEFT JOIN expense_categories ec ON ec.id = eci.category_id
         WHERE eci.created_at >= $1::date AND eci.created_at <= $2::date
         GROUP BY 1 ORDER BY total DESC LIMIT 8`,
        [startDate, endDate]
      ),

      // Overdue invoices count + amount
      safeOne(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(COALESCE(total_amount,amount,0)),0)::numeric AS amount
         FROM invoices WHERE due_date < CURRENT_DATE AND status NOT IN ('paid','cancelled')${cidClause(cid, 1)}`,
        cidParams(cid)
      ),
      // Pending expense claims
      safeOne(
        `SELECT COUNT(*)::int AS total FROM expense_claims WHERE status='pending'${cidClause(cid, 1)}`,
        cidParams(cid)
      ),
      // Overdue tasks (no company_id column on tasks)
      safeOne(`SELECT COUNT(*)::int AS total FROM tasks WHERE status NOT IN ('done','cancelled') AND due_date < CURRENT_DATE`),
      // Pending leaves (no company_id column on leaves)
      safeOne(`SELECT COUNT(*)::int AS total FROM leaves WHERE status='pending'`),
      // Low stock inventory
      safeOne(
        `SELECT COUNT(*)::int AS total FROM inventory_items WHERE current_stock <= reorder_level AND reorder_level > 0${cidClause(cid, 1)}`,
        cidParams(cid)
      ),

      // Monthly cash inflow: paid invoices by month (last 6 months, all months present)
      safeQuery(`
        SELECT TO_CHAR(m.month_ts,'Mon') AS month,
               m.month_ts,
               COALESCE(i.inflow,0)::numeric AS inflow
        FROM (
          SELECT generate_series(
            DATE_TRUNC('month', NOW() - INTERVAL '5 months'),
            DATE_TRUNC('month', NOW()),
            '1 month'::interval
          ) AS month_ts
        ) m
        LEFT JOIN (
          SELECT DATE_TRUNC('month',created_at) AS mt,
                 SUM(COALESCE(total_amount,amount,0)) AS inflow
          FROM invoices WHERE LOWER(status)='paid'
            AND created_at >= NOW() - INTERVAL '6 months'${cidClause(cid, 1)}
          GROUP BY 1
        ) i ON i.mt = m.month_ts
        ORDER BY m.month_ts
      `, cidParams(cid)),

      // Monthly expense outflow: approved claims by month
      safeQuery(
        `SELECT DATE_TRUNC('month',created_at) AS month_ts,
                SUM(amount)::numeric AS outflow
         FROM expense_claims WHERE LOWER(status)='approved'
           AND created_at >= NOW() - INTERVAL '6 months'${cidClause(cid, 1)}
         GROUP BY 1 ORDER BY 1`,
        cidParams(cid)
      ),

      // Monthly bills outflow: paid bills by month
      safeQuery(
        `SELECT DATE_TRUNC('month',updated_at) AS month_ts,
                SUM(amount)::numeric AS outflow
         FROM bills WHERE LOWER(status)='paid'
           AND updated_at >= NOW() - INTERVAL '6 months'${cidClause(cid, 1)}
         GROUP BY 1 ORDER BY 1`,
        cidParams(cid)
      ),
    ]);

    // ── Core KPIs ──────────────────────────────────────────────────────────────
    const revenue     = safeFloat(revRow?.total);
    const opex        = safeFloat(expRow?.total) + safeFloat(billsPaidRow?.total);
    const grossProfit = revenue - opex;
    // Net profit: after estimated 22% for interest + tax (only deducted when profitable)
    const netProfit   = grossProfit > 0 ? grossProfit * 0.78 : grossProfit;
    // EBITDA = net profit + estimated D&A (5% of opex). Always >= net profit.
    const ebitda      = netProfit + opex * 0.05;
    const cashBalance = safeFloat(receiptsRow?.total) - safeFloat(paymentsRow?.total);
    const ar          = safeFloat(arRow?.total);
    const ap          = safeFloat(apRow?.total);

    // DSO = AR / (Revenue / daysInPeriod)
    const dso = revenue > 0 ? Math.round(ar / (revenue / daysInPeriod)) : 0;
    // DPO = AP / (OpEx / daysInPeriod)
    const dpo = opex > 0 ? Math.round(ap / (opex / daysInPeriod)) : 0;
    // Monthly burn = opex / months in period
    const monthlyBurn = opex > 0 ? Math.round(opex / monthsInPeriod) : 0;
    // Runway: null when cash is zero or negative (shows N/A in UI, not "0 mo")
    const runway = (monthlyBurn > 0 && cashBalance > 0)
      ? Math.round(cashBalance / monthlyBurn) : null;

    // ── Financial Ratios ───────────────────────────────────────────────────────
    const currentRatio  = ap > 0 ? Math.round((ar / ap) * 10) / 10 : null;
    const quickRatio    = ap > 0 ? Math.round(((cashBalance + ar) / ap) * 10) / 10 : null;
    const grossMargin   = revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 10 : 0;
    const netMargin     = revenue > 0 ? Math.round((netProfit / revenue) * 1000) / 10 : 0;
    const ebitdaMargin  = revenue > 0 ? Math.round((ebitda / revenue) * 1000) / 10 : 0;

    // Working capital gauge inputs (as % of benchmark)
    const collectionsPct = (revenue + ar) > 0
      ? Math.min(100, Math.round(revenue / (revenue + ar) * 100)) : 0;
    const cashRatioPct  = ap > 0
      ? Math.min(100, Math.round(cashBalance / ap * 100)) : 0;
    const liquidityPct  = ap > 0
      ? Math.min(100, Math.round((cashBalance + ar) / ap * 50)) : 0;

    // ── Monthly Cash Flow ──────────────────────────────────────────────────────
    const outflowMap = {};
    const toYM = v => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 7);
    for (const r of monthlyExpRows)   outflowMap[toYM(r.month_ts)] = (outflowMap[toYM(r.month_ts)] || 0) + safeFloat(r.outflow);
    for (const r of monthlyBillsRows) outflowMap[toYM(r.month_ts)] = (outflowMap[toYM(r.month_ts)] || 0) + safeFloat(r.outflow);

    const cashFlowMonthly = monthlyInflowRows.map(r => {
      const key       = toYM(r.month_ts);
      const inflow    = safeFloat(r.inflow);
      const outflow   = outflowMap[key] || 0;
      const operating = Math.round(inflow - outflow);
      return { month: r.month, operating, investing: 0, financing: 0, net: operating };
    });

    // ── Revenue Forecast ───────────────────────────────────────────────────────
    // Only generate forecast when there is actual revenue history to trend from.
    const histVals   = histRevRows.map(r => safeFloat(r.revenue));
    const hasHistory = histVals.some(v => v > 0);
    let forecastData = [];
    if (hasHistory) {
      const lastN = histVals.slice(-3);
      const avgRev = lastN.reduce((s, v) => s + v, 0) / lastN.length;
      let growthRate = 0.04;
      if (lastN.length >= 2 && lastN[0] > 0) {
        growthRate = Math.max(-0.10, Math.min(0.20,
          (lastN[lastN.length - 1] - lastN[0]) / lastN[0] / Math.max(1, lastN.length - 1)));
      }
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      let baseVal = avgRev;
      for (let i = 1; i <= 6; i++) {
        baseVal = baseVal * (1 + growthRate);
        forecastData.push({
          month:        MONTHS[(now.getMonth() + i) % 12],
          base:         Math.round(baseVal),
          optimistic:   Math.round(baseVal * 1.2),
          conservative: Math.round(baseVal * 0.8),
        });
      }
    }

    // ── Expense Breakdown ──────────────────────────────────────────────────────
    const expByCategory = expByCatRows.length > 0
      ? expByCatRows.map(r => ({ name: r.category || 'Other', value: safeFloat(r.total) }))
      : [];

    // ── Alerts ────────────────────────────────────────────────────────────────
    const alerts = [];
    if (safeInt(overdueInvRow?.total) > 0) {
      const amt = safeFloat(overdueInvRow.amount);
      const amtStr = amt >= 100000 ? `₹${(amt/100000).toFixed(1)}L` : `₹${Math.round(amt/1000)}K`;
      alerts.push({ level:'high',   msg:`${overdueInvRow.total} overdue invoice${overdueInvRow.total>1?'s':''} — ${amtStr} at risk`, action:'Follow Up', module:'invoices' });
    }
    if (safeInt(pendingExpRow?.total) > 0) {
      alerts.push({ level:'medium', msg:`${pendingExpRow.total} expense claim${pendingExpRow.total>1?'s':''} pending approval`,      action:'Review', module:'expenses' });
    }
    if (safeInt(overdueTasksRow?.total) > 0) {
      alerts.push({ level:'medium', msg:`${overdueTasksRow.total} overdue task${overdueTasksRow.total>1?'s':''}`,                    action:'View',   module:'projects' });
    }
    if (safeInt(pendingLeavesRow?.total) > 0) {
      alerts.push({ level:'low',    msg:`${pendingLeavesRow.total} leave request${pendingLeavesRow.total>1?'s':''} pending approval`, action:'Review', module:'leaves'   });
    }
    if (safeInt(lowStockRow?.total) > 0) {
      alerts.push({ level:'low',    msg:`${lowStockRow.total} inventory item${lowStockRow.total>1?'s':''} below reorder level`,      action:'View',   module:'inventory'});
    }
    if (alerts.length === 0) {
      alerts.push({ level:'info', msg:'All financial metrics within normal range', action:null, module:'system' });
    }

    res.json({
      period,
      kpis: { revenue, opex, grossProfit, netProfit, ebitda, cashBalance, ar, ap, dso, dpo, monthlyBurn, runway },
      ratios: { currentRatio, quickRatio, grossMargin, netMargin, ebitdaMargin, dso, dpo },
      gauges: { collectionsPct, cashRatioPct, liquidityPct },
      cashFlowMonthly,
      forecastData,
      expByCategory,
      alerts,
      historicalRevenue: histRevRows.map(r => ({ month: r.month, revenue: safeFloat(r.revenue) })),
    });
  } catch (err) {
    console.error('getCFODashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch CFO dashboard' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   /dashboard/manufacturing  — Manufacturing Command Center KPIs
   7 live counters: production orders, NCRs, FAT, ECN, MRP shortages,
   AMC renewals due ≤30 days, open service tickets.
   All queries run in parallel via Promise.all.
══════════════════════════════════════════════════════════════════════════════ */
export const getDashboardManufacturing = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const cf  = cidClause(cid, 1);
    const cp  = cidParams(cid);

    const [
      prodOrders,
      openNcrs,
      pendingFat,
      ecnPending,
      mrpShortages,
      amcRenewals,
      serviceTickets,
    ] = await Promise.all([
      safeOne(`SELECT COUNT(*)::int AS v FROM production_orders
               WHERE status NOT IN ('completed','cancelled')${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM ncr_reports WHERE status = 'open'`),
      safeOne(`SELECT COUNT(*)::int AS v FROM test_runs
               WHERE LOWER(test_type) IN ('fat','sat','fat/sat')
                 AND (overall_result IS NULL OR overall_result = 'pending')`),
      safeOne(`SELECT COUNT(*)::int AS v FROM engineering_changes
               WHERE status IN ('draft','submitted')${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM inventory_items
               WHERE current_stock <= reorder_level AND reorder_level > 0${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM amc_contracts
               WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
                 AND status = 'active'`),
      safeOne(`SELECT COUNT(*)::int AS v FROM support_tickets
               WHERE status NOT IN ('Resolved','Closed') AND deleted_at IS NULL${cf}`, cp),
    ]);

    res.json({
      production_orders    : safeInt(prodOrders?.v),
      open_ncrs            : safeInt(openNcrs?.v),
      pending_fat          : safeInt(pendingFat?.v),
      ecn_pending          : safeInt(ecnPending?.v),
      mrp_shortages        : safeInt(mrpShortages?.v),
      amc_renewals         : safeInt(amcRenewals?.v),
      open_service_tickets : safeInt(serviceTickets?.v),
    });
  } catch (err) {
    console.error('getDashboardManufacturing error:', err);
    res.status(500).json({ error: 'Failed to fetch manufacturing dashboard' });
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   Celebrations wall — today's celebrants + wishes anyone logged-in can send
══════════════════════════════════════════════════════════════════════════════ */
const CELEBRATION_TYPES = ['Birthday', 'Work Anniversary', 'Wedding Anniversary'];

// Shared: today's celebrants WITH employee ids (employees.dob is the only DOB column).
// All date matching happens in SQL — pg returns timestamps as JS Dates whose string
// form is not ISO, so JS-side MM-DD comparisons are timezone traps.
const fetchTodayCelebrants = async (cid) => {
  const cf = cidClause(cid, 1);
  const cp = cidParams(cid);
  const rows = await safeQuery(`
    SELECT id, first_name, last_name, department,
           (dob IS NOT NULL
            AND TO_CHAR(dob, 'MM-DD') = TO_CHAR(CURRENT_DATE, 'MM-DD'))             AS is_birthday,
           (joining_date IS NOT NULL AND joining_date < CURRENT_DATE
            AND TO_CHAR(joining_date, 'MM-DD') = TO_CHAR(CURRENT_DATE, 'MM-DD'))    AS is_work_anniv,
           (anniversary_date IS NOT NULL
            AND TO_CHAR(anniversary_date, 'MM-DD') = TO_CHAR(CURRENT_DATE, 'MM-DD')) AS is_wedding_anniv,
           GREATEST(EXTRACT(YEAR FROM CURRENT_DATE) - EXTRACT(YEAR FROM joining_date), 0)::int AS work_years
    FROM employees
    WHERE LOWER(status) IN ('active','probation')
      AND (
        (dob IS NOT NULL
         AND TO_CHAR(dob, 'MM-DD') = TO_CHAR(CURRENT_DATE, 'MM-DD'))
        OR
        (joining_date IS NOT NULL AND joining_date < CURRENT_DATE
         AND TO_CHAR(joining_date, 'MM-DD') = TO_CHAR(CURRENT_DATE, 'MM-DD'))
        OR
        (anniversary_date IS NOT NULL
         AND TO_CHAR(anniversary_date, 'MM-DD') = TO_CHAR(CURRENT_DATE, 'MM-DD'))
      )${cf}
    LIMIT 30
  `, cp);

  return rows.flatMap(emp => {
    const name = `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || 'Employee';
    const dept = emp.department || '';
    const items = [];
    if (emp.is_birthday)
      items.push({ employeeId: emp.id, name, dept, type: 'Birthday', icon: '🎂' });
    if (emp.is_work_anniv && emp.work_years > 0)
      items.push({ employeeId: emp.id, name, dept, type: 'Work Anniversary', icon: '🏆', years: emp.work_years });
    if (emp.is_wedding_anniv)
      items.push({ employeeId: emp.id, name, dept, type: 'Wedding Anniversary', icon: '💍' });
    return items;
  });
};

// GET /dashboard/celebrations-today
export const getCelebrationsToday = async (req, res) => {
  try {
    const celebrants = await fetchTodayCelebrants(req.scope?.company_id ?? null);
    res.json({ celebrants });
  } catch (err) {
    console.error('getCelebrationsToday error:', err);
    res.status(500).json({ error: 'Failed to fetch celebrations' });
  }
};

// GET /dashboard/celebration-wishes — all wishes for today's celebrations
export const getCelebrationWishes = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const rows = await safeQuery(`
      SELECT id, employee_id, celebration_type, emoji, message,
             sender_name, sender_user_id, created_at
      FROM celebration_wishes
      WHERE celebration_date = CURRENT_DATE
        ${cid != null ? 'AND (company_id = $1 OR company_id IS NULL)' : ''}
      ORDER BY created_at ASC
      LIMIT 500
    `, cid != null ? [cid] : []);
    res.json({ wishes: rows });
  } catch (err) {
    console.error('getCelebrationWishes error:', err);
    res.status(500).json({ error: 'Failed to fetch wishes' });
  }
};

// POST /dashboard/celebration-wishes — { employee_id, celebration_type, emoji?, message? }
// Emoji-only wishes toggle: sending the same emoji again removes the reaction.
export const postCelebrationWish = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const cid    = req.scope?.company_id ?? null;
    const empId  = parseInt(req.body?.employee_id);
    const type   = String(req.body?.celebration_type || '');
    const emoji  = req.body?.emoji ? String(req.body.emoji).slice(0, 16) : null;
    const message = req.body?.message ? String(req.body.message).trim().slice(0, 300) : null;

    if (!empId || !CELEBRATION_TYPES.includes(type))
      return res.status(400).json({ error: 'Valid employee_id and celebration_type are required' });
    if (!emoji && !message)
      return res.status(400).json({ error: 'Send an emoji or a message' });

    const emp = await safeOne(
      `SELECT id, company_id FROM employees
       WHERE id = $1 AND LOWER(status) IN ('active','probation')${cidClause(cid, 2)}`,
      cidParams(cid, [empId])
    );
    if (!emp) return res.status(404).json({ error: 'Celebrant not found' });

    const senderRow = await safeOne(`
      SELECT COALESCE(
               NULLIF(TRIM(CONCAT(e.first_name, ' ', COALESCE(e.last_name, ''))), ''),
               u.name,
               SPLIT_PART(u.email, '@', 1)
             ) AS sender_name
      FROM users u
      LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.id = $1
    `, [userId]);
    const senderName = senderRow?.sender_name || 'Someone';

    if (emoji && !message) {
      // Toggle: remove an identical existing reaction instead of duplicating
      const del = await pool.query(
        `DELETE FROM celebration_wishes
         WHERE employee_id = $1 AND celebration_type = $2 AND celebration_date = CURRENT_DATE
           AND sender_user_id = $3 AND emoji = $4 AND message IS NULL
         RETURNING id`,
        [empId, type, userId, emoji]
      );
      if (del.rowCount > 0) return res.json({ removed: true });
    }

    const { rows } = await pool.query(
      `INSERT INTO celebration_wishes
         (company_id, employee_id, celebration_type, sender_user_id, sender_name, emoji, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id, employee_id, celebration_type, emoji, message, sender_name, sender_user_id, created_at`,
      [emp.company_id ?? cid, empId, type, userId, senderName, emoji, message]
    );
    res.status(201).json({ wish: rows[0] ?? null });
  } catch (err) {
    console.error('postCelebrationWish error:', err);
    res.status(500).json({ error: 'Failed to send wish' });
  }
};
