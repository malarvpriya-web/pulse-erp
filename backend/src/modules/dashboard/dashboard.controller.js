import pool from "../../config/db.js";
import { resolveRange, assertDateParams, PERIOD_PRESETS as SHARED_PERIOD_PRESETS, FY_START_SQL as FY_START } from "../../shared/dashboardFilters.js";
import { analyticsQuery } from "../../shared/analyticsQuery.js";

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
import {
  EMPLOYEE_ACTIVE, EMPLOYEE_EXITED, TICKET_CLOSED, PROJECT_CLOSED,
  INVOICE_PAID, BILL_PAID, TIMESHEET_PENDING, LEAVE_APPROVED, LEAVE_PENDING, OPENING_OPEN,
  isIn, notIn, sqlInvoiceOutstanding, sqlBillOutstanding,
} from '../../shared/statusSets.js';

const cidClause = (cid, idx) =>
  cid != null ? ` AND company_id = $${idx}` : '';
const cidParams = (cid, base = []) =>
  cid != null ? [...base, cid] : base;

/**
 * PENDING_APPROVALS_SQL — the one definition of "pending approvals".
 *
 * Three endpoints answered this question with three different queries:
 * /dashboard/summary and /dashboard/approvals summed leave_requests +
 * expense_claims + approvals and got 168, while /dashboard/live-kpis summed six
 * queues but read `leave_applications` (4 rows) instead of `leave_requests`
 * (769) and got 11. Same label, same screen family, two answers an order of
 * magnitude apart.
 *
 * `leave_requests` is the live ledger. Every queue below is scoped, and every
 * caller binds exactly one parameter: the company id (or null for global).
 */
const PENDING_APPROVALS_SQL = `SELECT (
  COALESCE((SELECT COUNT(*) FROM leave_requests lr
             WHERE ${isIn('lr.status', LEAVE_PENDING)} AND ($1::int IS NULL OR lr.company_id = $1)),0) +
  COALESCE((SELECT COUNT(*) FROM expense_claims ec
             WHERE LOWER(ec.status)='pending' AND ($1::int IS NULL OR ec.company_id = $1)),0) +
  COALESCE((SELECT COUNT(*) FROM purchase_requests pr
             WHERE pr.status IN ('pending_approval','pending') AND ($1::int IS NULL OR pr.company_id = $1)),0) +
  COALESCE((SELECT COUNT(*) FROM attendance_regularization_requests arr
             WHERE arr.status='pending' AND ($1::int IS NULL OR arr.company_id = $1)),0) +
  COALESCE((SELECT COUNT(*) FROM attendance_ot_records ot
             WHERE ot.status='pending' AND ($1::int IS NULL OR ot.company_id = $1)),0) +
  COALESCE((SELECT COUNT(*) FROM approvals ap
             WHERE ap.status='Pending' AND ($1::int IS NULL OR ap.company_id = $1)),0)
) AS total`;

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
      `SELECT COUNT(*) AS total FROM leave_requests WHERE ${isIn('status', LEAVE_PENDING)}${cidClause(cid, 1)}`,
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
// `invoices` has no `amount` column — the previous COALESCE(total_amount, amount, 0)
// raised "column amount does not exist" on every call, which safeQuery swallowed
// into an empty result, so this endpoint reported no revenue at all regardless of
// the data. total_amount is the only amount column on the table.
//
// TENANT SCOPING: the note that used to sit here said invoices/projects/tasks
// "do not have company_id". That was stale — invoices, bills, expense_claims,
// opportunities and projects all carry company_id (verified against
// information_schema), and every other finance query in this file already binds
// it. This endpoint feeds the revenue chart on three dashboards, so it was the
// widest-reaching unscoped read in the module. It now takes the caller's company.
//
// BUSINESS DATE: windows on invoice_date, not created_at. created_at is the row's
// insert timestamp; a back-dated invoice landed in the wrong month and made this
// series disagree with /ceo-intelligence/executive-summary, which has always used
// invoice_date. Falls back to created_at only where invoice_date is null.
const revSql = (filter, cidIdx) =>
  `SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(invoice_date, created_at)), 'Mon ''YY') AS month,
          TO_CHAR(DATE_TRUNC('month', COALESCE(invoice_date, created_at)), 'Mon')       AS short_month,
          COALESCE(SUM(COALESCE(total_amount, 0)), 0)::numeric AS value,
          DATE_TRUNC('month', COALESCE(invoice_date, created_at)) AS month_ts
   FROM invoices
   WHERE ${isIn('status', INVOICE_PAID)} AND ${filter}
     AND ($${cidIdx}::int IS NULL OR company_id = $${cidIdx})
   GROUP BY DATE_TRUNC('month', COALESCE(invoice_date, created_at))
   ORDER BY DATE_TRUNC('month', COALESCE(invoice_date, created_at))`;

export const getDashboardRevenue = async (req, res) => {
  try {
    const period  = req.query.period || '6m';
    const year    = parseInt(req.query.year) || new Date().getFullYear();
    const compare = req.query.compare === 'true';
    const cid     = req.scope?.company_id ?? null;
    const DATE_COL = 'COALESCE(invoice_date, created_at)';

    let sql, params, prevSql, prevParams;

    // This endpoint predates the shared dashboard filter vocabulary and has its
    // own '6m' / 'fy' / 'cy' values, still used by CeoDashboard and CFODashboard.
    // Shared presets (mtd, fytd, last30, custom, …) are handled first; anything
    // else falls through to the original branches, so existing callers are
    // unaffected.
    const usesSharedVocabulary =
      SHARED_PERIOD_PRESETS.includes(String(period).toLowerCase()) || req.query.from || req.query.to;

    if (usesSharedVocabulary) {
      const range = resolveRange(req.query, { defaultPeriod: 'fytd' });
      // Both bounds NULL-tolerant so period=all reads as "no date filter".
      sql = revSql(`($1::date IS NULL OR ${DATE_COL} >= $1::date)
                    AND ($2::date IS NULL OR ${DATE_COL} < ($2::date + INTERVAL '1 day'))`, 3);
      params = [range.from, range.to, cid];
      // Prior window of equal length, for the compare series.
      const span = range.from && range.to
        ? Math.max(1, Math.round((new Date(range.to) - new Date(range.from)) / 86400000) + 1)
        : null;
      const shift = (d, days) => {
        const c = new Date(d);
        c.setDate(c.getDate() - days);
        return c.toISOString().slice(0, 10);
      };
      prevSql = sql;
      prevParams = span
        ? [shift(range.from, span), shift(range.to, span), cid]
        : [null, null, cid];
    } else if (period === 'fy') {
      sql        = revSql(`${DATE_COL} >= $1::date AND ${DATE_COL} < $2::date`, 3);
      params     = [`${year - 1}-04-01`, `${year}-04-01`, cid];
      prevSql    = sql;
      prevParams = [`${year - 2}-04-01`, `${year - 1}-04-01`, cid];
    } else if (period === 'cy') {
      sql        = revSql(`EXTRACT(year FROM ${DATE_COL}) = $1`, 2);
      params     = [year, cid];
      prevSql    = sql;
      prevParams = [year - 1, cid];
    } else {
      sql        = revSql(`${DATE_COL} >= NOW() - INTERVAL '6 months'`, 1);
      params     = [cid];
      prevSql    = revSql(`${DATE_COL} >= NOW() - INTERVAL '18 months' AND ${DATE_COL} < NOW() - INTERVAL '6 months'`, 1);
      prevParams = [cid];
    }

    const [rows, prevRows] = await Promise.all([
      safeQuery(sql, params),
      compare ? safeQuery(prevSql, prevParams) : Promise.resolve([]),
    ]);

    // `thisMonth` used to be rows.at(-1) — the last month that PRODUCED A ROW,
    // not the current month. A month with no paid invoices is simply absent from
    // a GROUP BY, so on 21 Aug the CFO Dashboard rendered "This month Rs 2.4L",
    // which was April's revenue, and `lastMonth` fell to 0 so the trend divided by
    // zero. Both are now looked up by calendar month and are 0 when the month is
    // genuinely empty.
    const monthKey = (d) => new Date(d).toISOString().slice(0, 7);
    const now      = new Date();
    const curKey   = monthKey(now);
    const prevKey  = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const byMonth  = new Map(rows.map(r => [monthKey(r.month_ts), safeFloat(r.value)]));

    // `windowTotal` is the sum over whatever window was requested. The old name
    // `ytd` was wrong for every period except fytd — on the default '6m' branch it
    // was a rolling six-month total labelled year-to-date. `ytd` is kept as an
    // alias so existing callers keep working, but it now only carries a
    // year-to-date figure when the caller actually asked for one.
    const windowTotal = rows.reduce((s, r) => s + safeFloat(r.value), 0);

    res.json({
      months      : rows.map(r => r.month),
      shortMonths : rows.map(r => r.short_month),
      values      : rows.map(r => safeFloat(r.value)),
      prevValues  : compare ? prevRows.map(r => safeFloat(r.value)) : undefined,
      monthDates  : rows.map(r => r.month_ts),
      thisMonth   : byMonth.get(curKey)  ?? 0,
      lastMonth   : byMonth.get(prevKey) ?? 0,
      windowTotal,
      periodLabel : String(period),
      ytd         : windowTotal,
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
    // expense_claim_items has no company_id of its own — scope through its parent
    // claim, which does. This read was previously cross-tenant.
    const cid = req.scope?.company_id ?? null;
    const rows = await safeQuery(`
      -- expense_claim_items stores the category as free text in a category column;
      -- there is no category_id FK to expense_categories. Joining on one made
      -- the query throw, so safeQuery returned nothing and the expense breakdown
      -- on both CEO Intelligence and the CFO Dashboard was permanently empty.
      SELECT COALESCE(NULLIF(TRIM(eci.category), ''), 'Uncategorised') AS category,
             SUM(eci.amount)::numeric   AS total
      FROM expense_claim_items eci
      LEFT JOIN expense_claims  cl ON cl.id = eci.expense_claim_id
      WHERE eci.created_at >= DATE_TRUNC('month', NOW())
        AND ($1::int IS NULL OR cl.company_id = $1 OR cl.id IS NULL)
      GROUP BY 1 ORDER BY total DESC LIMIT 6
    `, [cid]);
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
      safeOne(`SELECT COUNT(*) AS total FROM employees WHERE ${isIn('status', EMPLOYEE_ACTIVE)}${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM employees WHERE joining_date >= DATE_TRUNC('month', NOW()) AND ${notIn('status', EMPLOYEE_EXITED)}${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM employees WHERE ${isIn('status', EMPLOYEE_EXITED)} AND updated_at >= DATE_TRUNC('month', NOW())${cf}`, cp),
      safeOne(`
        SELECT
          COUNT(*) FILTER (WHERE a.status = 'present') AS present_count,
          (SELECT COUNT(*) FROM employees WHERE ${isIn('status', EMPLOYEE_ACTIVE)}${cf}) AS total_emp
        FROM attendance a WHERE a.date = CURRENT_DATE
      `, cp),
      // `leaves` is a near-empty legacy table (single-digit rows); the live leave
      // ledger the whole app writes to is `leave_requests`. Reading the wrong one
      // made "On Leave Today" report 0 on three dashboards while people were
      // genuinely on leave.
      safeOne(`
        SELECT COUNT(*) AS total FROM leave_requests
        WHERE ${isIn('status', LEAVE_APPROVED)} AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE${cf}
      `, cp),
      safeOne(`SELECT COUNT(*) AS total FROM employees WHERE LOWER(status) = 'probation'${cf}`, cp),
      safeQuery(`
        SELECT department, COUNT(*) AS count
        FROM employees WHERE ${isIn('status', EMPLOYEE_ACTIVE)} AND department IS NOT NULL AND department != ''${cf}
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

    const [leaveCnt, expCnt, apprCnt, pendingTotal, recent] = await Promise.all([
      safeOne(`SELECT COUNT(*) AS total FROM leave_requests WHERE ${isIn('status', LEAVE_PENDING)}${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM expense_claims WHERE LOWER(status) = 'pending'${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM approvals WHERE status = 'Pending'${cf}`, cp),
      // The headline total comes from the shared definition, so this endpoint,
      // /dashboard/summary and /dashboard/live-kpis cannot disagree about how
      // many approvals are pending. The three counts above remain as the
      // per-category breakdown the UI renders beside it.
      safeOne(PENDING_APPROVALS_SQL, [cid]),
      safeQuery(`
        SELECT l.id,
               -- leave_requests carries no employee_email column; the name comes
               -- from the joined employee row, or a generic label when unlinked.
               COALESCE(NULLIF(TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')), ''), 'Employee') AS employee_name,
               e.department,
               l.leave_type AS type, l.start_date, l.end_date, l.status, l.created_at,
               (CURRENT_DATE - l.created_at::date) AS days_waiting
        FROM leave_requests l
        -- leave_requests links to employees by id, not by an email column it does
        -- not have. Joining on l.employee_email threw, so this approval queue was
        -- permanently empty.
        LEFT JOIN employees e ON e.id = l.employee_id
        -- Both joined tables carry company_id, so the unqualified cf fragment
        -- was ambiguous (42702) and the whole statement rejected — the approval
        -- queue rendered empty against 159 pending requests. Qualify it.
        WHERE ${isIn('l.status', LEAVE_PENDING)}
          AND ($1::int IS NULL OR l.company_id = $1)
        ORDER BY l.created_at ASC LIMIT ${limit}
      `, [cid]),
    ]);

    const summary = [
      { type: "Leave",    count: safeInt(leaveCnt?.total)  },
      { type: "Expense",  count: safeInt(expCnt?.total)    },
      { type: "Approvals",count: safeInt(apprCnt?.total)   },
    ].filter(s => s.count > 0);

    const base = {
      summary,
      pending : recent,
      // From PENDING_APPROVALS_SQL, not a sum of the three breakdown counts —
      // those cover only three of the six queues, so adding them up produced a
      // total this endpoint's own siblings disagreed with.
      total   : safeInt(pendingTotal?.total),
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
// audit_logs has no `action`, `module`, `description` or `performed_by` column —
// the real names are action_type / module_name / reference_type+reference_id, and
// the actor comes from the joined user. Selecting the wrong four raised 42703 on
// every call, which safeQuery turned into an empty feed, so this endpoint reported
// "no activity" against 1,955 rows. The response keys are unchanged so no caller
// has to move.
export const getDashboardActivity = async (req, res) => {
  const q = analyticsQuery('dashboard/activity');
  try {
    const cid = req.scope?.company_id ?? null;
    const rows = await q.rows(`
      SELECT a.id,
             a.action_type AS action,
             a.module_name AS module,
             CASE WHEN a.reference_type IS NULL THEN a.action_type
                  ELSE a.reference_type || COALESCE(' #' || a.reference_id, '') END AS description,
             COALESCE(u.name, u.email, 'System') AS performed_by,
             a.created_at
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE ($1::int IS NULL OR a.company_id = $1)
      ORDER BY a.created_at DESC
      LIMIT 50
    `, [cid], 'activity');
    res.json({ activities: rows, ...q.report() });
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
      safeOne(`SELECT COUNT(*) AS total FROM leave_requests WHERE ${isIn('status', LEAVE_PENDING)}${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM invoices WHERE due_date < NOW() AND status NOT IN ('paid','cancelled')${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM employees
               WHERE LOWER(status) = 'probation' AND joining_date IS NOT NULL
                 AND (joining_date::date + INTERVAL '165 days')::date <= CURRENT_DATE
                 AND (joining_date::date + INTERVAL '180 days')::date >= CURRENT_DATE${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM tasks t
              WHERE t.status NOT IN ('done','cancelled') AND t.due_date < CURRENT_DATE
                ${cid != null ? 'AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.company_id = $1)' : ''}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM expense_claims WHERE LOWER(status) = 'pending'${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM inventory_items WHERE current_stock <= reorder_level AND current_stock > 0${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM timesheets WHERE ${isIn('status', TIMESHEET_PENDING)}${cf}`, cp),
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
    // invoices/bills/payments/receipts/bank_accounts all carry company_id; none
    // of these queries used it, so the cash position summed every tenant.
    const cid = req.scope?.company_id ?? null;
    const C = (idx) => cidClause(cid, idx);
    const P = (base = []) => cidParams(cid, base);

    const [receivable, payable, inflow, outflow, receiptsTotal, paymentsTotal, bankBalRow, arAgingRows, apAgingRows] = await Promise.all([
      safeOne(`SELECT COALESCE(SUM(total_amount),0)::numeric AS total FROM invoices WHERE LOWER(status) NOT IN ('paid','cancelled') AND deleted_at IS NULL ${C(1)}`, P()),
      safeOne(`SELECT COALESCE(SUM(total_amount),0)::numeric AS total FROM bills WHERE LOWER(status) NOT IN ('paid','cancelled') AND deleted_at IS NULL ${C(1)}`, P()),
      safeOne(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payments WHERE payment_date >= DATE_TRUNC('month', NOW()) ${C(1)}`, P()),
      safeOne(`SELECT COALESCE(SUM(total_amount),0)::numeric AS total FROM bills WHERE LOWER(status) = 'paid' AND updated_at >= DATE_TRUNC('month', NOW()) ${C(1)}`, P()),
      safeOne(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM receipts WHERE 1=1 ${C(1)}`, P()),
      safeOne(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payments WHERE 1=1 ${C(1)}`, P()),
      safeOne(`SELECT COALESCE(SUM(current_balance),0)::numeric AS total FROM bank_accounts WHERE is_active = true ${C(1)}`, P()),
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
        WHERE LOWER(status) NOT IN ('paid','cancelled') AND deleted_at IS NULL ${C(1)}
        GROUP BY 1 ORDER BY MIN(due_date)`, P()),
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
        WHERE LOWER(status) NOT IN ('paid','cancelled') AND deleted_at IS NULL ${C(1)}
        GROUP BY 1 ORDER BY MIN(due_date)`, P()),
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
        SELECT party_name AS client_name, invoice_number, total_amount, due_date,
               (CURRENT_DATE - due_date::date) AS days_overdue
        FROM invoices
        WHERE status NOT IN ('paid','cancelled') AND due_date < CURRENT_DATE ${C(1)}
        ORDER BY days_overdue DESC, total_amount DESC
        LIMIT 10
      `, P());
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
    // opportunities carries company_id; the pipeline summed every tenant's deals.
    const cid = req.scope?.company_id ?? null;
    const rows = await safeQuery(`
      SELECT stage, COUNT(*) AS count, COALESCE(SUM(expected_value),0)::numeric AS value
      FROM opportunities
      WHERE deleted_at IS NULL ${cidClause(cid, 1)}
      GROUP BY stage
      ORDER BY CASE stage
        WHEN 'prospecting'   THEN 1
        WHEN 'qualification' THEN 2
        WHEN 'proposal'      THEN 3
        WHEN 'negotiation'   THEN 4
        WHEN 'closed_won'    THEN 5
        ELSE 6 END
    `, cidParams(cid));
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
      // Every predicate below now comes from shared/statusSets.js. Previously each
      // was a hand-written literal list, and the ticket predicate here
      // (`NOT IN ('Resolved','Closed')`) differed from the one in
      // /ceo-intelligence/service-amc (`NOT IN ('resolved','closed')`) by casing
      // alone — so CEO Intelligence showed one open-ticket count on its Operations
      // tab and a different one on its Collections tab, on the same page load.
      safeOne(
        `SELECT COUNT(*) AS total FROM projects
          WHERE ${notIn('status', PROJECT_CLOSED)} AND deleted_at IS NULL
            AND ($1::int IS NULL OR company_id = $1)`, [cid]),
      safeOne(`SELECT COUNT(*) AS total FROM support_tickets WHERE ${notIn('status', TICKET_CLOSED)} AND deleted_at IS NULL${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM inventory_items WHERE current_stock <= reorder_level AND current_stock > 0${cf}`, cp),
      safeOne(
        `SELECT COUNT(*) AS total FROM invoices
          WHERE ${sqlInvoiceOutstanding()} AND ($1::int IS NULL OR company_id = $1)`, [cid]),
      // leave_requests, not the near-empty legacy `leaves` table.
      safeOne(
        `SELECT COUNT(*) AS total FROM leave_requests
          WHERE ${isIn('status', LEAVE_APPROVED)}
            AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE${cf}`, cp),
      safeOne(
        `SELECT COUNT(*) AS total FROM tasks t
          LEFT JOIN projects p ON p.id = t.project_id
          -- tasks has no completed_at column. updated_at is when the row last
          -- changed, which for a task in a done state is when it was completed.
          WHERE LOWER(t.status) IN ('done','completed') AND t.updated_at >= DATE_TRUNC('month', NOW())
            AND ($1::int IS NULL OR p.company_id = $1 OR p.id IS NULL)`, [cid]),
      safeOne(
        `SELECT COUNT(*) AS total FROM tasks t
          LEFT JOIN projects p ON p.id = t.project_id
          WHERE LOWER(t.status) NOT IN ('done','completed','cancelled') AND t.due_date < CURRENT_DATE
            AND ($1::int IS NULL OR p.company_id = $1 OR p.id IS NULL)`, [cid]),
      // Timesheet awaiting-approval states are written with mixed casing across
      // the app ('submitted' from the API, 'Submitted' from the manager UI).
      safeOne(`SELECT COUNT(*) AS total FROM timesheets WHERE ${isIn('status', TIMESHEET_PENDING)}${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM job_openings WHERE ${isIn('status', OPENING_OPEN)} AND deleted_at IS NULL${cf}`, cp),
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
        SELECT t.id, t.task_title AS title, t.due_date, t.priority,
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
    // Every query below reads a table that carries company_id. Without this the
    // whole finance dashboard — AR, AP, cash, aging, top overdue invoices —
    // aggregated across every tenant in the database. Proven by seeding a second
    // company: its 7,777,777 invoice appeared in the first company's receivable.
    const cid = req.scope?.company_id ?? null;
    const C = (idx) => cidClause(cid, idx);
    const P = (base = []) => cidParams(cid, base);

    const [invoiceStats, billStats, monthlyRev, expByMonth, overdueInvoices,
      upcomingPayments, expByCategory, arAging, apAging,
      receiptsTotal, paymentsTotal, expMTD] = await Promise.all([
      safeOne(`
        SELECT
          COUNT(*) FILTER (WHERE status='pending')  AS pending_count,
          COUNT(*) FILTER (WHERE status='overdue' OR (due_date < NOW() AND status NOT IN ('paid','cancelled'))) AS overdue_count,
          COALESCE(SUM(total_amount) FILTER (WHERE ${isIn('status', INVOICE_PAID)} AND COALESCE(invoice_date, created_at) >= DATE_TRUNC('month', NOW())),0)::numeric AS collected_mtd,
          COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('paid','cancelled')),0)::numeric AS outstanding
        FROM invoices
        WHERE 1=1 ${C(1)}
      `, P()),
      safeOne(`
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('paid','cancelled')),0)::numeric AS payable,
          COALESCE(SUM(amount) FILTER (WHERE due_date BETWEEN NOW() AND NOW() + INTERVAL '30 days' AND status NOT IN ('paid','cancelled')),0)::numeric AS due_30days
        FROM bills
        WHERE 1=1 ${C(1)}
      `, P()),
      safeQuery(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month,
               SUM(total_amount)::numeric AS revenue,
               DATE_TRUNC('month', created_at) AS month_date
        FROM invoices WHERE created_at >= NOW() - INTERVAL '6 months' ${C(1)}
        GROUP BY DATE_TRUNC('month', created_at) ORDER BY month_date
      `, P()),
      safeQuery(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month,
               SUM(amount)::numeric AS expenses
        FROM expense_claims WHERE created_at >= NOW() - INTERVAL '6 months' ${C(1)}
        GROUP BY DATE_TRUNC('month', created_at) ORDER BY DATE_TRUNC('month', created_at)
      `, P()),
      safeQuery(`
        SELECT invoice_number, party_name, total_amount::numeric, due_date, status,
               EXTRACT(DAY FROM NOW() - due_date)::int AS days_overdue
        FROM invoices
        WHERE (status='overdue' OR (due_date < NOW() AND status NOT IN ('paid','cancelled')))
          ${C(1)}
        ORDER BY due_date ASC LIMIT 8
      `, P()),
      safeQuery(`
        SELECT id, bill_number, party_name, amount::numeric, due_date,
               EXTRACT(DAY FROM due_date - NOW())::int AS days_until_due
        FROM bills
        WHERE due_date BETWEEN NOW() AND NOW() + INTERVAL '30 days' AND status NOT IN ('paid','cancelled')
          ${C(1)}
        ORDER BY due_date ASC LIMIT 8
      `, P()),
      safeQuery(`
        SELECT category, SUM(amount)::numeric AS total FROM expense_claims
        WHERE created_at >= DATE_TRUNC('month', NOW()) ${C(1)}
        GROUP BY category ORDER BY total DESC
      `, P()),
      safeQuery(`
        SELECT CASE
          WHEN due_date >= NOW() - INTERVAL '30 days' THEN '0–30 days'
          WHEN due_date >= NOW() - INTERVAL '60 days' THEN '31–60 days'
          WHEN due_date >= NOW() - INTERVAL '90 days' THEN '61–90 days'
          ELSE '90+ days' END AS bucket,
          COALESCE(SUM(total_amount),0)::numeric AS amount
        FROM invoices WHERE status NOT IN ('paid','cancelled') AND due_date < NOW() ${C(1)}
        GROUP BY 1 ORDER BY MIN(due_date) DESC
      `, P()),
      safeQuery(`
        SELECT CASE
          WHEN due_date >= NOW() - INTERVAL '30 days' THEN '0–30 days'
          WHEN due_date >= NOW() - INTERVAL '60 days' THEN '31–60 days'
          WHEN due_date >= NOW() - INTERVAL '90 days' THEN '61–90 days'
          ELSE '90+ days' END AS bucket,
          COALESCE(SUM(amount),0)::numeric AS amount
        FROM bills WHERE status NOT IN ('paid','cancelled') AND due_date < NOW() ${C(1)}
        GROUP BY 1 ORDER BY MIN(due_date) DESC
      `, P()),
      safeOne(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM receipts WHERE 1=1 ${C(1)}`, P()),
      safeOne(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payments WHERE 1=1 ${C(1)}`, P()),
      safeOne(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM expense_claims
                WHERE created_at >= DATE_TRUNC('month', NOW()) ${C(1)}`, P()),
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
      safeOne(`SELECT COUNT(*) AS total FROM leave_requests WHERE ${isIn('status', LEAVE_PENDING)}${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM leave_requests WHERE ${isIn('status', LEAVE_APPROVED)} AND created_at >= DATE_TRUNC('month', NOW())${cf}`, cp),
      safeOne(`SELECT COUNT(*) AS total FROM leave_requests WHERE ${isIn('status', LEAVE_APPROVED)} AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE${cf}`, cp),
      // Was `FROM leaves`, which carries no company_id — the ${cf} fragment made
      // it raise 42703 on every call and safeQuery emptied the breakdown. The
      // other three counts on this endpoint already read leave_requests (769 rows
      // vs 1), so the breakdown now reads the same table and agrees with them.
      safeQuery(`
        SELECT leave_type, COUNT(*) AS count FROM leave_requests
        WHERE ${isIn('status', LEAVE_APPROVED)} AND created_at >= DATE_TRUNC('month', NOW())${cf}
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
        (SELECT COUNT(*) FROM leave_requests WHERE ${isIn('status', LEAVE_PENDING)}${cf}), 0
      ) + COALESCE(
        (SELECT COUNT(*) FROM expense_claims WHERE status='pending'${cf}), 0
      ) + COALESCE(
        (SELECT COUNT(*) FROM approvals WHERE status='Pending'), 0
      ) AS total
    `, cp),
    safeOne(`SELECT COALESCE(SUM(total_amount),0)::numeric AS total FROM invoices
              WHERE created_at >= DATE_TRUNC('month', NOW()) AND status NOT IN ('cancelled')${cf}`, cp),
    safeOne(`SELECT COUNT(*) AS total FROM projects
              WHERE status NOT IN ('completed','cancelled')${cf}`, cp),
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
    safeOne(`SELECT COUNT(*) AS total FROM leave_requests WHERE ${isIn('status', LEAVE_PENDING)}${cf}`, cp),
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
    safeOne(`SELECT COUNT(*) AS total FROM leave_requests WHERE ${isIn('status', LEAVE_PENDING)}`),
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
      // Carried four defects in one line: no status filter (so drafts and
      // cancellations counted as revenue), the CALENDAR year rather than the
      // financial year everything else uses, created_at rather than invoice_date,
      // and no company filter. It reported Rs 62,90,800 against a canonical
      // Rs 2,41,900 — the widest KPI divergence in the module.
      safeOne(`SELECT COALESCE(SUM(total_amount),0)::numeric AS ytd
               FROM invoices
               WHERE ${isIn('status', INVOICE_PAID)}
                 AND COALESCE(invoice_date, created_at::date) >= ${FY_START}${cf}`, cp),
      // EMPLOYEE_ACTIVE, not a hand-written list: the literal ('active','probation')
      // silently drops everyone on notice, which is why this tile read 32 where
      // /analytics/headcount and /dashboard/workforce both read 33.
      safeOne(`SELECT COUNT(*) AS total FROM employees WHERE ${isIn('status', EMPLOYEE_ACTIVE)}${cf}`, cp),
      safeOne(PENDING_APPROVALS_SQL, [cid]),
      safeOne(`SELECT COUNT(*) AS total FROM projects
                WHERE ${notIn('status', PROJECT_CLOSED)} AND deleted_at IS NULL${cf}`, cp),
      safeOne(`SELECT COUNT(*) FILTER (WHERE a.status='present') AS present,
                      (SELECT COUNT(*) FROM employees WHERE ${isIn('status', EMPLOYEE_ACTIVE)}${cf}) AS total_emp
               FROM attendance a
               JOIN employees e ON e.id = a.employee_id
               WHERE a.date = CURRENT_DATE AND ($1::int IS NULL OR e.company_id = $1)`, [cid]),
      safeOne(`SELECT COUNT(*) AS total FROM (
        SELECT 1 FROM leave_requests WHERE ${isIn('status', LEAVE_PENDING)}${cf}
        UNION ALL SELECT 1 FROM invoices
          WHERE due_date < NOW() AND status NOT IN ('paid','cancelled')${cf}
        UNION ALL SELECT 1 FROM tasks t
          WHERE t.status NOT IN ('done','cancelled') AND t.due_date < CURRENT_DATE
            ${cid != null ? 'AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.company_id = $1)' : ''}
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
    // invoices carries company_id; without it this leaderboard mixed tenants.
    const cid = req.scope?.company_id ?? null;
    const rows = await safeQuery(`
      SELECT party_name AS name,
             COALESCE(SUM(total_amount),0)::numeric AS revenue,
             COUNT(*) AS invoice_count
      FROM invoices
      WHERE status = 'paid'
        AND created_at >= NOW() - INTERVAL '12 months'
        AND party_name IS NOT NULL AND party_name != ''
        ${cidClause(cid, 1)}
      GROUP BY party_name
      ORDER BY revenue DESC LIMIT 5
    `, cidParams(cid));
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
    // bills carries company_id; without it this leaderboard mixed tenants.
    const cid = req.scope?.company_id ?? null;
    const rows = await safeQuery(`
      SELECT party_name AS name,
             COALESCE(SUM(amount),0)::numeric AS spend,
             COUNT(*) AS bill_count
      FROM bills
      WHERE status = 'paid'
        AND created_at >= NOW() - INTERVAL '12 months'
        AND party_name IS NOT NULL AND party_name != ''
        ${cidClause(cid, 1)}
      GROUP BY party_name
      ORDER BY spend DESC LIMIT 5
    `, cidParams(cid));
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
      // REVENUE — three defects fixed together:
      //   1. `COALESCE(total_amount, amount, 0)` names `invoices.amount`, which has
      //      never existed, so all three raised 42703 and reported Rs 0 revenue.
      //   2. No company filter, on a table that carries company_id.
      //   3. Windowed on created_at (the insert timestamp) and the calendar year,
      //      while every other revenue figure in the app uses invoice_date and the
      //      Indian financial year. Now matches INVOICE_PAID + FY_START, so this
      //      agrees with /analytics/ceo/kpis and /ceo-intelligence.
      safeOne(`SELECT COALESCE(SUM(total_amount),0)::numeric AS v
               FROM invoices
               WHERE COALESCE(invoice_date, created_at::date) = CURRENT_DATE
                 AND ${isIn('status', INVOICE_PAID)}${cf}`, cp),
      safeOne(`SELECT COALESCE(SUM(total_amount),0)::numeric AS v
               FROM invoices
               WHERE COALESCE(invoice_date, created_at::date) >= DATE_TRUNC('month', CURRENT_DATE)
                 AND ${isIn('status', INVOICE_PAID)}${cf}`, cp),
      safeOne(`SELECT COALESCE(SUM(total_amount),0)::numeric AS v
               FROM invoices
               WHERE COALESCE(invoice_date, created_at::date) >= ${FY_START}
                 AND ${isIn('status', INVOICE_PAID)}${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM purchase_orders WHERE LOWER(status) IN ('pending','approved','in_progress','open')${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM inventory_items WHERE current_stock <= reorder_level AND reorder_level > 0${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM projects WHERE LOWER(status) NOT IN ('completed','cancelled','closed') AND deleted_at IS NULL${cf}`, cp),
      // tasks has no company_id of its own — scope through the owning project.
      safeOne(`SELECT COUNT(*)::int AS v FROM tasks t
                WHERE t.status NOT IN ('done','cancelled') AND t.due_date < CURRENT_DATE
                  AND ($1::int IS NULL OR EXISTS (
                        SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.company_id = $1))`, [cid]),
      safeOne(`SELECT COUNT(*)::int AS v FROM invoices WHERE due_date < CURRENT_DATE AND LOWER(status) NOT IN ('paid','cancelled')${cf}`, cp),
      // One definition, shared with /dashboard/summary and /dashboard/approvals.
      // This block used to inline its own six-queue variant that read
      // leave_applications (4 rows) where the others read leave_requests (769),
      // so the same label reported 11 here and 168 two endpoints away.
      safeOne(PENDING_APPROVALS_SQL.replace(/AS total$/, "AS v"), [cid]),
      // EMPLOYEE_ACTIVE, not a hand-written ('active','probation'): that literal
      // drops everyone on notice, and made this tile report 32 where
      // /analytics/headcount and /dashboard/workforce both reported 33.
      safeOne(`SELECT COUNT(*)::int AS v FROM employees WHERE ${isIn('status', EMPLOYEE_ACTIVE)}${cf}`, cp),
      // leave_requests is the populated table (769 rows vs 1 in `leaves`) and it
      // carries company_id directly, so both branches now read one table.
      safeOne(`SELECT COUNT(*)::int AS v FROM leave_requests
                WHERE ${isIn('status', LEAVE_APPROVED)}
                  AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE${cf}`, cp),
      safeQuery(`SELECT a.action_type AS action, a.module_name AS module,
                        CASE WHEN a.reference_type IS NULL THEN a.action_type
                             ELSE a.reference_type || COALESCE(' #' || a.reference_id, '') END AS description,
                        COALESCE(u.name, u.email, 'System') AS performed_by, a.created_at
                 FROM audit_logs a
                 LEFT JOIN users u ON u.id = a.user_id
                 WHERE ($1::int IS NULL OR a.company_id = $1)
                 ORDER BY a.created_at DESC LIMIT 8`, [cid]),
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
    // Three defects fixed together here, all of them silent under safeOne():
    //   * no company scoping — active_projects counted every tenant's projects;
    //   * projects.budget_used / .total_budget do not exist (they are
    //     budget_spent / budget_amount), so budget_used was permanently null;
    //   * tasks.completed_at does not exist, so completed_this_month was
    //     permanently 0 rather than a real count.
    // `tasks` carries no company_id of its own, so it is scoped through its
    // project — the same approach /analytics/productivity already uses.
    const cid = req.scope?.company_id ?? null;
    const C = (idx) => cidClause(cid, idx);
    const P = (base = []) => cidParams(cid, base);
    const taskScope = cid != null
      ? `AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.company_id = $1)`
      : '';

    const [active, overdue, atRisk, doneMTD, budget] = await Promise.all([
      safeOne(`SELECT COUNT(*) AS total FROM projects
                WHERE status NOT IN ('completed','cancelled') ${C(1)}`, P()),
      safeOne(`SELECT COUNT(*) AS total FROM tasks t
                WHERE t.status NOT IN ('done','cancelled') AND t.due_date < CURRENT_DATE
                  ${taskScope}`, P()),
      safeOne(`
        SELECT COUNT(DISTINCT t.project_id) AS total FROM tasks t
        WHERE t.status NOT IN ('done','cancelled') AND t.due_date < CURRENT_DATE
          AND t.project_id IS NOT NULL ${taskScope}
      `, P()),
      // `tasks` records no completion timestamp; updated_at is the closest
      // honest proxy for "moved to done this month" and is labelled as such in
      // the response so the number is not read as a certified completion date.
      safeOne(`SELECT COUNT(*) AS total FROM tasks t
                WHERE t.status = 'done' AND t.updated_at >= DATE_TRUNC('month', NOW())
                  ${taskScope}`, P()),
      safeOne(`
        SELECT
          COALESCE(SUM(budget_spent),0)::numeric  AS used,
          COALESCE(SUM(budget_amount),0)::numeric AS total
        FROM projects
        WHERE budget_amount > 0 AND status NOT IN ('completed','cancelled') ${C(1)}
      `, P()),
    ]);

    const budgetUsed  = safeFloat(budget?.total) > 0
      ? Math.round((safeFloat(budget?.used) / safeFloat(budget?.total)) * 100)
      : null;

    res.json({
      active_projects       : safeInt(active?.total),
      overdue_tasks         : safeInt(overdue?.total),
      at_risk               : safeInt(atRisk?.total),
      completed_this_month  : safeInt(doneMTD?.total),
      completed_basis       : 'tasks.updated_at (tasks records no completion timestamp)',
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
    const cid      = req.scope?.company_id ?? null;
    const now      = new Date();
    const year     = now.getFullYear();
    const month    = now.getMonth() + 1; // 1-12
    const todayStr = now.toISOString().slice(0, 10);

    // Indian fiscal year: Apr 1 → Mar 31. fyYear = year the FY started.
    const currentFyYear = month >= 4 ? year : year - 1;
    // Optional ?fyStart=YYYY-04-01 lets a legacy caller pick a past/future FY.
    let fyYear = currentFyYear;
    const fyStartParam = req.query.fyStart;
    if (fyStartParam && /^\d{4}-\d{2}-\d{2}$/.test(fyStartParam)) {
      const parsed = parseInt(fyStartParam.slice(0, 4), 10);
      if (!Number.isNaN(parsed)) fyYear = parsed;
    }
    const fyLabel = `FY${fyYear}-${String(fyYear + 1).slice(2)}`;
    // For a past/future FY, YTD spans the whole year; for the live FY it stops today.
    const ytdEnd = fyYear === currentFyYear ? todayStr : `${fyYear + 1}-03-31`;

    /**
     * Legacy FY vocabulary — `?period=YTD|Q1|Q2|Q3|Q4` (+ optional `?fyStart=`).
     *
     * Kept alongside the shared preset vocabulary for exactly the reason §107
     * kept `6m`/`fy`/`cy` on /dashboard/revenue: this endpoint has callers that
     * are not the dashboard page. `backend/scripts/audit/kpi-reconcile.mjs`,
     * `perf-probe.mjs` and five assertions in
     * `tests/suites/16-analytics-contract.spec.ts` all request `?period=YTD`,
     * and this handler answers an unknown period with 400 — dropping the
     * vocabulary would have turned every one of them red.
     *
     * These are *financial-year* quarters (Apr–Jun … Jan–Mar), which the shared
     * presets deliberately do not model: `qtd` is the current CALENDAR quarter
     * to date. They are not the same window and must not be aliased onto each
     * other; the filter bar reaches an FY quarter through `custom` instead.
     */
    const LEGACY_RANGES = {
      YTD: [`${fyYear}-04-01`,     ytdEnd,                 `${fyLabel} to date`],
      Q1:  [`${fyYear}-04-01`,     `${fyYear}-06-30`,      `${fyLabel} Q1 · Apr–Jun`],
      Q2:  [`${fyYear}-07-01`,     `${fyYear}-09-30`,      `${fyLabel} Q2 · Jul–Sep`],
      Q3:  [`${fyYear}-10-01`,     `${fyYear}-12-31`,      `${fyLabel} Q3 · Oct–Dec`],
      Q4:  [`${fyYear + 1}-01-01`, `${fyYear + 1}-03-31`,  `${fyLabel} Q4 · Jan–Mar`],
    };

    const rawPeriod = String(req.query.period || '').trim();
    const legacyKey = rawPeriod.toUpperCase();
    const preset    = rawPeriod.toLowerCase();
    // An explicit from/to pair is a custom range even without ?period=custom —
    // same tolerance resolveRange() itself applies.
    const hasBounds = !!(req.query.from || req.query.to);

    let startDate, endDate, period, periodLabel;

    if (Object.prototype.hasOwnProperty.call(LEGACY_RANGES, legacyKey)) {
      [startDate, endDate, periodLabel] = LEGACY_RANGES[legacyKey];
      period = legacyKey;
    } else if (rawPeriod === '' || SHARED_PERIOD_PRESETS.includes(preset) || hasBounds) {
      // ── Shared vocabulary (hooks/useDashboardFilters + DashboardFilterBar) ──
      // resolveRange() silently ignores an unparseable date and falls back to
      // the default window. That is the right default for endpoints that only
      // ever get from/to from the filter bar, but this one answers a bad
      // ?period with 400 — so `?from=not-a-date` quietly returning FY figures
      // would make the same class of mistake loud in one param and silent in
      // the next.
      const badDates = assertDateParams(req.query);
      if (badDates) return res.status(badDates.status).json(badDates.body);
      const range = resolveRange(req.query, { defaultPeriod: 'fytd' });
      period      = range.period;
      periodLabel = range.label;
      endDate     = range.to || todayStr;
      if (range.from) {
        startDate = range.from;
      } else {
        /* `period=all` is unbounded, but this handler's rate metrics — DSO, DPO
         * and monthly burn — divide by the LENGTH of the window. Binding a fake
         * epoch as the lower bound would not just be cosmetic: a 1970 start
         * makes `monthsInPeriod` ~670 and reports a burn rate two orders of
         * magnitude too low, which is a confidently wrong number rather than a
         * missing one. Use the first day the business actually recorded
         * anything, so "all time" means the real span of the book. */
        const firstRow = await safeOne(
          `SELECT MIN(d)::date AS first_day FROM (
             SELECT MIN(COALESCE(invoice_date, created_at::date)) AS d
               FROM invoices      WHERE ($1::int IS NULL OR company_id = $1)
             UNION ALL
             SELECT MIN(created_at::date)
               FROM expense_claims WHERE ($1::int IS NULL OR company_id = $1)
           ) t`,
          [cid],
        );
        const firstDay = firstRow?.first_day
          ? new Date(firstRow.first_day).toISOString().slice(0, 10)
          : null;
        startDate = firstDay || `${fyYear}-04-01`;
      }
    } else {
      /* An unrecognised ?period used to fall back to YTD and then echo the bogus
       * value back in the response, so `?period=NOT_A_PERIOD` returned 200 with
       * YTD figures labelled NOT_A_PERIOD — a caller (or a chart axis) reading
       * the label believed it had data for a period that does not exist. A bad
       * request is the client's mistake to fix, so say so. */
      return res.status(400).json({
        error: `Unknown period "${req.query.period}".`,
        allowed: [...SHARED_PERIOD_PRESETS, ...Object.keys(LEGACY_RANGES)],
      });
    }

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
      glPlRow,
      glPlUnscopedRow,
    ] = await Promise.all([

      // Paid invoices revenue for period
      // Windows on invoice_date (the business date), matching every other revenue
      // query in the module. created_at is the insert timestamp and put back-dated
      // invoices in the wrong period.
      safeOne(
        `SELECT COALESCE(SUM(COALESCE(total_amount,0)),0)::numeric AS total
         FROM invoices WHERE ${isIn('status', INVOICE_PAID)}
           AND COALESCE(invoice_date, created_at) >= $1::date
           AND COALESCE(invoice_date, created_at) <= $2::date${cidClause(cid, 3)}`,
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
      // AR now uses the shared outstanding predicate, so CEO Intelligence's
      // "Outstanding Collections" and this tile cannot report different figures
      // for the same receivable book again.
      safeOne(
        `SELECT COALESCE(SUM(COALESCE(total_amount,0)),0)::numeric AS total
         FROM invoices WHERE ${sqlInvoiceOutstanding()}${cidClause(cid, 1)}`,
        cidParams(cid)
      ),
      // Outstanding bills (AP snapshot)
      safeOne(
        `SELECT COALESCE(SUM(amount),0)::numeric AS total
         FROM bills WHERE ${sqlBillOutstanding()}${cidClause(cid, 1)}`,
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

      // Historical revenue for forecast: last 9 months of paid invoices.
      // `invoices.amount` does not exist — this raised 42703 on every call and
      // safeQuery emptied it, so the CFO's Revenue Forecast card and the whole
      // historicalRevenue series rendered blank. Also windows on invoice_date now,
      // matching every other revenue figure, and uses INVOICE_PAID rather than a
      // lone 'paid' literal.
      safeQuery(
        `SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(invoice_date, created_at::date)),'Mon') AS month,
                DATE_TRUNC('month', COALESCE(invoice_date, created_at::date)) AS month_ts,
                COALESCE(SUM(total_amount),0)::numeric AS revenue
         FROM invoices WHERE ${isIn('status', INVOICE_PAID)}
           AND COALESCE(invoice_date, created_at::date) >= (CURRENT_DATE - INTERVAL '9 months')${cidClause(cid, 1)}
         GROUP BY 2 ORDER BY 2`,
        cidParams(cid)
      ),

      // Expense breakdown by category for period
      // Scoped through the parent claim; expense_claim_items has no company_id.
      safeQuery(
        `SELECT COALESCE(NULLIF(TRIM(eci.category), ''), 'Uncategorised') AS category,
                SUM(eci.amount)::numeric AS total
         FROM expense_claim_items eci
         LEFT JOIN expense_claims  cl ON cl.id = eci.expense_claim_id
         WHERE eci.created_at >= $1::date AND eci.created_at <= $2::date
           AND ($3::int IS NULL OR cl.company_id = $3 OR cl.id IS NULL)
         GROUP BY 1 ORDER BY total DESC LIMIT 8`,
        [startDate, endDate, cid]
      ),

      // Overdue invoices count + amount
      safeOne(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(COALESCE(total_amount,0)),0)::numeric AS amount
         FROM invoices WHERE due_date < CURRENT_DATE AND ${sqlInvoiceOutstanding()}${cidClause(cid, 1)}`,
        cidParams(cid)
      ),
      // Pending expense claims
      safeOne(
        `SELECT COUNT(*)::int AS total FROM expense_claims WHERE status='pending'${cidClause(cid, 1)}`,
        cidParams(cid)
      ),
      // Overdue tasks (no company_id column on tasks)
      safeOne(`SELECT COUNT(*)::int AS total FROM tasks t
                WHERE LOWER(t.status) NOT IN ('done','completed','cancelled') AND t.due_date < CURRENT_DATE
                  AND ($1::int IS NULL OR EXISTS (
                        SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.company_id = $1))`, [cid]),
      // `leaves` is a near-empty legacy table; the live ledger is leave_requests.
      // Reading the wrong one meant this alert never fired while a real approval
      // queue was building up.
      safeOne(
        `SELECT COUNT(*)::int AS total FROM leave_requests WHERE ${isIn('status', LEAVE_PENDING)}${cidClause(cid, 1)}`,
        cidParams(cid)
      ),
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
          -- invoices.amount does not exist; this raised 42703 every call, so the
          -- Cash Flow card rendered "No cash flow data for this period" with
          -- Inflow/Outflow/Net all at zero over a book of paid invoices.
          SELECT DATE_TRUNC('month', COALESCE(invoice_date, created_at::date)) AS mt,
                 SUM(total_amount) AS inflow
          FROM invoices WHERE ${isIn('status', INVOICE_PAID)}
            AND COALESCE(invoice_date, created_at::date) >= (CURRENT_DATE - INTERVAL '6 months')${cidClause(cid, 1)}
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
         FROM bills WHERE ${isIn('status', BILL_PAID)}
           AND updated_at >= NOW() - INTERVAL '6 months'${cidClause(cid, 1)}
         GROUP BY 1 ORDER BY 1`,
        cidParams(cid)
      ),

      // ── Real P&L from the general ledger ─────────────────────────────────
      // Net profit and EBITDA used to be manufactured in JS:
      //     netProfit = grossProfit * 0.78     // "estimated 22% interest + tax"
      //     ebitda    = netProfit + opex*0.05  // "estimated D&A"
      // Neither coefficient came from anywhere. They were presented as the CFO's
      // two headline results. The posted general ledger already carries the real
      // figures — same account-type logic as /finance/reports/profit-loss — so
      // both are read from it. When no journal entries are posted for the period
      // the KPIs report null and the UI shows "Not posted" rather than a number
      // derived from a guess.
      safeOne(
        `SELECT
           COALESCE(SUM(CASE WHEN coa.account_type='Revenue' AND COALESCE(coa.sub_type,'') <> 'other'
                             THEN jl.credit - jl.debit ELSE 0 END), 0)::numeric AS revenue,
           COALESCE(SUM(CASE WHEN coa.account_type='Revenue' AND coa.sub_type = 'other'
                             THEN jl.credit - jl.debit ELSE 0 END), 0)::numeric AS other_income,
           COALESCE(SUM(CASE WHEN coa.account_type='Expense' AND coa.sub_type = 'cogs'
                             THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric AS cogs,
           COALESCE(SUM(CASE WHEN coa.account_type='Expense' AND COALESCE(coa.sub_type,'') NOT IN ('cogs')
                             THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric AS opex,
           COALESCE(SUM(CASE WHEN coa.account_type='Expense'
                             AND (LOWER(coa.name) LIKE '%depreciation%' OR LOWER(coa.name) LIKE '%amorti%')
                             THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric AS depreciation,
           COALESCE(SUM(CASE WHEN coa.account_type='Expense'
                             AND (LOWER(coa.name) LIKE '%interest%' OR LOWER(coa.name) LIKE '%finance cost%')
                             THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric AS interest,
           COALESCE(SUM(CASE WHEN coa.account_type='Expense'
                             AND (LOWER(coa.name) LIKE '%tax%')
                             THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric AS tax,
           COUNT(jl.id)::int AS line_count
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN chart_of_accounts coa ON coa.id = jl.account_id
         WHERE LOWER(je.status) = 'posted'
           AND je.entry_date BETWEEN $1::date AND $2::date
           AND coa.account_type IN ('Revenue','Expense')
           ${cid != null ? 'AND je.company_id = $3' : ''}`,
        cid != null ? [startDate, endDate, cid] : [startDate, endDate]
      ),

      // Same window and status, WITHOUT the company filter. Used only to tell
      // "nothing is posted" apart from "nothing is posted that belongs to your
      // company" — every journal_entries row currently carries a NULL
      // company_id, so a company-scoped CFO correctly sees an empty ledger
      // while nine posted entries exist. Reporting that as "no journal entries
      // posted" is true of the tenant and false of the database, and the
      // difference is the thing an accountant needs to act on. This count is
      // never used as a figure — only to choose the explanation.
      safeOne(
        `SELECT COUNT(jl.id)::int AS line_count
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN chart_of_accounts coa ON coa.id = jl.account_id
          WHERE LOWER(je.status) = 'posted'
            AND je.entry_date BETWEEN $1::date AND $2::date
            AND coa.account_type IN ('Revenue','Expense')`,
        [startDate, endDate]
      ),
    ]);

    // ── Core KPIs ──────────────────────────────────────────────────────────────
    // Cash-basis figures, from invoices/claims/bills.
    const revenue     = safeFloat(revRow?.total);
    const opex        = safeFloat(expRow?.total) + safeFloat(billsPaidRow?.total);
    const grossProfit = revenue - opex;

    // Accrual figures, from the posted general ledger. `glPosted` is false when
    // no journal entries exist for the period — the KPIs then report null and the
    // UI labels them "Not posted" instead of showing a manufactured number.
    const gl        = glPlRow || {};
    const unscopedGlLines = safeInt(glPlUnscopedRow?.line_count, 0);
    const glPosted  = safeInt(gl.line_count, 0) > 0;
    const glRevenue = safeFloat(gl.revenue);
    const glCogs    = safeFloat(gl.cogs);
    const glOpex    = safeFloat(gl.opex);
    const glOther   = safeFloat(gl.other_income);
    const glDep     = safeFloat(gl.depreciation);
    const glInt     = safeFloat(gl.interest);
    const glTax     = safeFloat(gl.tax);

    const glGrossProfit     = glPosted ? glRevenue - glCogs : null;
    const glOperatingProfit = glPosted ? glGrossProfit - glOpex : null;
    const netProfit         = glPosted ? glOperatingProfit + glOther : null;
    // EBITDA = operating profit + D&A, both taken from real posted accounts.
    const ebitda            = glPosted ? glOperatingProfit + glDep : null;

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
    // Margins that depend on GL figures return null (not 0) when nothing is
    // posted, so "no data" and "zero margin" stay distinguishable.
    const currentRatio  = ap > 0 ? Math.round((ar / ap) * 10) / 10 : null;
    const quickRatio    = ap > 0 ? Math.round(((cashBalance + ar) / ap) * 10) / 10 : null;
    const grossMargin   = revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 10 : null;
    const netMargin     = glPosted && glRevenue > 0 ? Math.round((netProfit / glRevenue) * 1000) / 10 : null;
    const ebitdaMargin  = glPosted && glRevenue > 0 ? Math.round((ebitda / glRevenue) * 1000) / 10 : null;

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
    let growthRateUsed = 0;   // surfaced in forecastMeta so the card can state it
    if (hasHistory) {
      const lastN = histVals.slice(-3);
      const avgRev = lastN.reduce((s, v) => s + v, 0) / lastN.length;
      let growthRate = 0.04;   // default when there is too little history to infer one
      if (lastN.length >= 2 && lastN[0] > 0) {
        growthRate = Math.max(-0.10, Math.min(0.20,
          (lastN[lastN.length - 1] - lastN[0]) / lastN[0] / Math.max(1, lastN.length - 1)));
      }
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      growthRateUsed = growthRate;
      let baseVal = avgRev;
      for (let i = 1; i <= 6; i++) {
        baseVal = baseVal * (1 + growthRate);
        forecastData.push({
          month:        MONTHS[(now.getMonth() + i) % 12],
          base:         Math.round(baseVal),
          // +/-20% of the base line. These are FIXED MULTIPLIERS, not modelled
          // scenarios and not a confidence interval — the card labels them
          // "Optimistic / Conservative", which reads as scenario planning, so the
          // method travels with the data and the UI states it.
          optimistic:   Math.round(baseVal * 1.2),
          conservative: Math.round(baseVal * 0.8),
        });
      }
    }
    const forecastMeta = {
      method: 'last-3-month average projected forward at the observed growth rate',
      growth_rate: hasHistory ? Number((growthRateUsed * 100).toFixed(1)) : null,
      band: 'fixed +/-20% of the base line — not a statistical confidence interval',
      basis_months: histVals.length,
      is_forecast: true,
    };

    // ── Expense Breakdown ──────────────────────────────────────────────────────
    const expByCategory = expByCatRows.length > 0
      ? expByCatRows.map(r => ({ name: r.category || 'Other', value: safeFloat(r.total) }))
      : [];

    // ── Alerts ────────────────────────────────────────────────────────────────
    const alerts = [];
    if (safeInt(overdueInvRow?.total) > 0) {
      const amt = safeFloat(overdueInvRow.amount);
      const amtStr = amt >= 100000 ? `₹${(amt/100000).toFixed(1)}L` : `₹${Math.round(amt/1000)}K`;
      // `action` is a routing key the frontend maps to a page. It used to be
      // free prose ('Follow Up', 'Review', 'View') that matched none of the keys
      // in ALERT_ACTION_PAGE, so every alert button on the CFO dashboard was a
      // no-op. These strings are now the map's actual keys.
      alerts.push({ level:'high',   msg:`${overdueInvRow.total} overdue invoice${overdueInvRow.total>1?'s':''} — ${amtStr} at risk`, action:'View Invoices', module:'invoices' });
    }
    if (safeInt(pendingExpRow?.total) > 0) {
      alerts.push({ level:'medium', msg:`${pendingExpRow.total} expense claim${pendingExpRow.total>1?'s':''} pending approval`,      action:'Manage Expenses', module:'expenses' });
    }
    if (safeInt(overdueTasksRow?.total) > 0) {
      alerts.push({ level:'medium', msg:`${overdueTasksRow.total} overdue task${overdueTasksRow.total>1?'s':''}`,                    action:'View Projects', module:'projects' });
    }
    if (safeInt(pendingLeavesRow?.total) > 0) {
      alerts.push({ level:'low',    msg:`${pendingLeavesRow.total} leave request${pendingLeavesRow.total>1?'s':''} pending approval`, action:'Review Leaves', module:'leaves' });
    }
    if (safeInt(lowStockRow?.total) > 0) {
      alerts.push({ level:'low',    msg:`${lowStockRow.total} inventory item${lowStockRow.total>1?'s':''} below reorder level`,      action:'View Inventory', module:'inventory'});
    }
    if (alerts.length === 0) {
      alerts.push({ level:'info', msg:'All financial metrics within normal range', action:null, module:'system' });
    }

    res.json({
      period,
      /* The window the figures below were actually computed over. The UI labels
       * its cards from `period_label` rather than from the preset it sent —
       * asserting a fixed window in the client is how a filter change ends up
       * relabelling numbers it did not move (manual §121). `period_scoped`
       * names which parts of this payload the window governs: the rest are
       * point-in-time balances and backlog, and a narrow period must never hide
       * work awaiting action. */
      period_label: periodLabel,
      from: startDate,
      to: endDate,
      period_scoped: {
        applies_to: ['kpis.revenue', 'kpis.opex', 'kpis.grossProfit', 'kpis.netProfit',
                     'kpis.ebitda', 'kpis.dso', 'kpis.dpo', 'kpis.monthlyBurn',
                     'ratios', 'gauges', 'expByCategory'],
        point_in_time: ['kpis.cashBalance', 'kpis.ar', 'kpis.ap', 'alerts'],
        fixed_window: ['cashFlowMonthly (trailing 6 months)',
                       'historicalRevenue (trailing 9 months)',
                       'forecastData (next 6 months)'],
      },
      kpis: {
        revenue, opex, grossProfit, netProfit, ebitda, cashBalance, ar, ap,
        dso, dpo, monthlyBurn, runway,
      },
      // Tells the UI which figures are accrual (GL) and whether the GL has
      // anything posted for this period at all.
      accounting: {
        glPosted,
        glRevenue: glPosted ? glRevenue : null,
        cogs:      glPosted ? glCogs    : null,
        operatingProfit: glOperatingProfit,
        depreciation:    glPosted ? glDep : null,
        interest:        glPosted ? glInt : null,
        tax:             glPosted ? glTax : null,
        basis: glPosted
          ? 'posted general ledger'
          : (unscopedGlLines > 0
              ? 'journal entries exist for this period but none are attributed to your company '
                + '(journal_entries.company_id is null) — accrual figures cannot be reported for this tenant'
              : 'no journal entries posted for this period'),
        // Lets the UI distinguish "the books are empty" from "the books are not
        // attributed", and lets a monitor alert on the second.
        unattributedLedgerLines: glPosted ? 0 : unscopedGlLines,
      },
      ratios: { currentRatio, quickRatio, grossMargin, netMargin, ebitdaMargin, dso, dpo },
      gauges: { collectionsPct, cashRatioPct, liquidityPct },
      cashFlowMonthly,
      forecastData,
      forecastMeta,
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
      safeOne(`SELECT COUNT(*)::int AS v FROM ncr_reports WHERE status = 'open'${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM test_runs
               WHERE LOWER(test_type) IN ('fat','sat','fat/sat')
                 AND (overall_result IS NULL OR overall_result = 'pending')${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM engineering_changes
               WHERE status IN ('draft','submitted')${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM inventory_items
               WHERE current_stock <= reorder_level AND reorder_level > 0${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM amc_contracts
               WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
                 AND status = 'active'${cf}`, cp),
      safeOne(`SELECT COUNT(*)::int AS v FROM support_tickets
               WHERE ${notIn('status', TICKET_CLOSED)} AND deleted_at IS NULL${cf}`, cp),
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
