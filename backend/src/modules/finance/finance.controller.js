import pool from "../../config/db.js";
import { logAudit } from '../../services/AuditService.js';

// ── Safe query helper — returns [] instead of throwing on missing tables ──────
async function safeRows(sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch {
    return [];
  }
}

async function safeValue(sql, params, fallback = 0) {
  const rows = await safeRows(sql, params);
  return rows[0] ? parseFloat(Object.values(rows[0])[0]) || fallback : fallback;
}

// ── P0-01 FIX: Real finance dashboard KPIs ────────────────────────────────────
export const getFinanceDashboard = async (req, res) => {
  try {
    const now     = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const nextMonth  = new Date(now.getFullYear(), now.getMonth() + 1, 1)
                         .toISOString().slice(0, 10);

    const [
      arRow, apRow, revRow, expRow,
      overdueInvoicesRow, overdueInvoicesCount,
      upcomingBillsCount,
    ] = await Promise.all([
      // Accounts receivable — open invoices
      safeRows(`SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount,0)), 0) AS value
                FROM invoices WHERE status NOT IN ('paid','cancelled')`),
      // Accounts payable — open supplier bills
      safeRows(`SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount,0)), 0) AS value
                FROM supplier_bills WHERE status NOT IN ('paid','cancelled')`),
      // Month revenue — invoices issued this month
      safeRows(`SELECT COALESCE(SUM(total_amount), 0) AS value FROM invoices
                WHERE invoice_date >= $1 AND invoice_date < $2`, [monthStart, nextMonth]),
      // Month expenses — bills issued this month
      safeRows(`SELECT COALESCE(SUM(total_amount), 0) AS value FROM supplier_bills
                WHERE bill_date >= $1 AND bill_date < $2`, [monthStart, nextMonth]),
      // Overdue invoices count (due_date < today and not paid)
      safeRows(`SELECT COUNT(*) AS value FROM invoices
                WHERE due_date < NOW() AND status NOT IN ('paid','cancelled')`),
      // Overdue invoices total
      safeRows(`SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount,0)), 0) AS value
                FROM invoices WHERE due_date < NOW() AND status NOT IN ('paid','cancelled')`),
      // Bills due in next 7 days
      safeRows(`SELECT COUNT(*) AS value FROM supplier_bills
                WHERE due_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'
                  AND status NOT IN ('paid','cancelled')`),
    ]);

    // Cash/bank balance — primary: bank_accounts.current_balance; fallback: journal_lines
    const bankAccountsBalance = await safeValue(
      `SELECT COALESCE(SUM(current_balance), 0) AS value
       FROM bank_accounts WHERE is_active = true AND deleted_at IS NULL`
    );
    const cashBankBalance = bankAccountsBalance > 0
      ? bankAccountsBalance
      : await safeValue(
          `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS value
           FROM journal_lines jl
           JOIN chart_of_accounts coa ON coa.id = jl.account_id
           JOIN journal_entries   je  ON je.id  = jl.entry_id
           WHERE coa.code IN ('1001','1002') AND je.status = 'posted'`
        );

    const ar            = parseFloat(arRow[0]?.value) || 0;
    const ap            = parseFloat(apRow[0]?.value) || 0;
    const monthRevenue  = parseFloat(revRow[0]?.value) || 0;
    const monthExpenses = parseFloat(expRow[0]?.value) || 0;
    const overdueCount  = parseInt(overdueInvoicesRow[0]?.value) || 0;
    const overdueAmt    = parseFloat(overdueInvoicesCount[0]?.value) || 0;
    const upcomingCount = parseInt(upcomingBillsCount[0]?.value) || 0;

    const kpis = {
      bankBalance:         cashBankBalance,
      cashBalance:         cashBankBalance,
      accountsReceivable:  ar,
      accountsPayable:     ap,
      monthRevenue,
      monthExpenses,
      netProfit: monthRevenue - monthExpenses,
    };

    const alerts = [];
    if (overdueCount > 0) {
      alerts.push({
        title:    "Overdue Invoices",
        message:  `${overdueCount} invoice${overdueCount > 1 ? 's' : ''} overdue — ₹${overdueAmt.toLocaleString()} outstanding`,
        severity: "high",
      });
    }
    if (cashBankBalance < 50000) {
      alerts.push({
        title:    "Low Bank Balance",
        message:  `Bank balance ₹${cashBankBalance.toLocaleString()} is below ₹50,000 threshold`,
        severity: "medium",
      });
    }
    if (upcomingCount > 0) {
      alerts.push({
        title:    "Upcoming Payments",
        message:  `${upcomingCount} bill${upcomingCount > 1 ? 's' : ''} due in the next 7 days`,
        severity: "low",
      });
    }

    res.json({ kpis, alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── P0-02 FIX: Real CFO dashboard ────────────────────────────────────────────
export const getCFODashboard = async (req, res) => {
  try {
    // chart_of_accounts is a global (company_id NULL) table by design — not scoped.
    // Revenue is company-scoped via invoices. supplier_bills has no company_id column
    // in the base schema, so expenses remain unscoped (safeRows-guarded).
    const companyId = req.scope?.company_id ?? null;
    const invCid = companyId != null ? ' AND company_id = $1' : '';
    const invParams = companyId != null ? [companyId] : [];
    const [assetsRow, liabRow, revenueRow, expensesRow, prevRevenueRow] = await Promise.all([
      safeRows(`SELECT COALESCE(SUM(opening_balance), 0) AS value
                FROM chart_of_accounts WHERE account_type = 'Asset' AND is_active = true`),
      safeRows(`SELECT COALESCE(SUM(opening_balance), 0) AS value
                FROM chart_of_accounts WHERE account_type = 'Liability' AND is_active = true`),
      safeRows(`SELECT COALESCE(SUM(total_amount), 0) AS value FROM invoices
                WHERE invoice_date >= date_trunc('year', NOW())${invCid}`, invParams),
      safeRows(`SELECT COALESCE(SUM(total_amount), 0) AS value FROM supplier_bills
                WHERE bill_date >= date_trunc('year', NOW())`),
      safeRows(`SELECT COALESCE(SUM(total_amount), 0) AS value FROM invoices
                WHERE invoice_date >= date_trunc('year', NOW()) - INTERVAL '1 year'
                  AND invoice_date <  date_trunc('year', NOW())${invCid}`, invParams),
    ]);

    const totalAssets      = parseFloat(assetsRow[0]?.value)      || 0;
    const totalLiabilities = parseFloat(liabRow[0]?.value)        || 0;
    const equity           = totalAssets - totalLiabilities;
    const ytdRevenue       = parseFloat(revenueRow[0]?.value)     || 0;
    const ytdExpenses      = parseFloat(expensesRow[0]?.value)    || 0;
    const prevRevenue      = parseFloat(prevRevenueRow[0]?.value) || 0;

    const grossProfit = ytdRevenue - ytdExpenses;
    const grossMargin = ytdRevenue > 0 ? (grossProfit / ytdRevenue) * 100 : 0;
    const netMargin   = ytdRevenue > 0 ? ((grossProfit * 0.7) / ytdRevenue) * 100 : 0;
    const roa         = totalAssets > 0 ? ((grossProfit * 0.7) / totalAssets) * 100 : 0;
    const roe         = equity > 0      ? ((grossProfit * 0.7) / equity) * 100 : 0;
    const revenueGrowth = prevRevenue > 0
      ? ((ytdRevenue - prevRevenue) / prevRevenue) * 100
      : 0;

    res.json({
      totalAssets,
      totalLiabilities,
      equity,
      currentRatio:   totalLiabilities > 0 ? totalAssets / totalLiabilities : 0,
      debtToEquity:   equity > 0 ? totalLiabilities / equity : 0,
      roa:            parseFloat(roa.toFixed(2)),
      roe:            parseFloat(roe.toFixed(2)),
      grossMargin:    parseFloat(grossMargin.toFixed(2)),
      netMargin:      parseFloat(netMargin.toFixed(2)),
      ytdRevenue,
      ytdExpenses,
      grossProfit,
      revenueGrowth:  parseFloat(revenueGrowth.toFixed(2)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── P0-03 FIX: Real invoice stats ────────────────────────────────────────────
export const getInvoiceStats = async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const cFilter   = companyId != null ? ' AND company_id = $1' : '';
    const params    = companyId != null ? [companyId] : [];
    const rows = await safeRows(`
      SELECT
        COUNT(*)                                                        AS total,
        COUNT(*) FILTER (WHERE status = 'paid')                        AS paid,
        COUNT(*) FILTER (WHERE due_date < NOW()
                           AND status NOT IN ('paid','cancelled'))      AS overdue,
        COALESCE(SUM(total_amount - COALESCE(paid_amount,0))
          FILTER (WHERE status NOT IN ('paid','cancelled')), 0)        AS outstanding
      FROM invoices
      WHERE deleted_at IS NULL${cFilter}
    `, params);
    const r = rows[0] || {};
    res.json({
      totalInvoices:   parseInt(r.total)         || 0,
      paidInvoices:    parseInt(r.paid)          || 0,
      overdueInvoices: parseInt(r.overdue)       || 0,
      outstanding:     parseFloat(r.outstanding) || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── P0-04 FIX: Real bill stats ────────────────────────────────────────────────
export const getBillStats = async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const cFilter   = companyId != null ? ' AND company_id = $1' : '';
    const params    = companyId != null ? [companyId] : [];
    const rows = await safeRows(`
      SELECT
        COUNT(*)                                                                             AS total,
        COALESCE(SUM(total_amount)
          FILTER (WHERE EXTRACT(YEAR FROM bill_date) = EXTRACT(YEAR FROM CURRENT_DATE)), 0) AS total_amount_ytd,
        COUNT(*) FILTER (WHERE LOWER(status) IN ('pending','approved'))                     AS pending_count,
        COALESCE(SUM(balance) FILTER (WHERE LOWER(status) IN ('pending','approved')), 0)    AS pending_amount,
        COUNT(*) FILTER (WHERE LOWER(status) = 'pending')                                   AS awaiting_approval,
        COUNT(*) FILTER (WHERE due_date < NOW()
                           AND LOWER(status) NOT IN ('paid','cancelled','rejected'))         AS overdue_count,
        COALESCE(SUM(balance) FILTER (WHERE due_date < NOW()
                           AND LOWER(status) NOT IN ('paid','cancelled','rejected')), 0)    AS overdue_amount,
        COUNT(*) FILTER (WHERE LOWER(status) = 'paid'
                           AND EXTRACT(MONTH FROM updated_at) = EXTRACT(MONTH FROM CURRENT_DATE)
                           AND EXTRACT(YEAR  FROM updated_at) = EXTRACT(YEAR  FROM CURRENT_DATE)) AS paid_month_count,
        COALESCE(SUM(total_amount) FILTER (WHERE LOWER(status) = 'paid'
                           AND EXTRACT(MONTH FROM updated_at) = EXTRACT(MONTH FROM CURRENT_DATE)
                           AND EXTRACT(YEAR  FROM updated_at) = EXTRACT(YEAR  FROM CURRENT_DATE)), 0) AS paid_month_amount
      FROM bills
      WHERE deleted_at IS NULL${cFilter}
    `, params);
    const r = rows[0] || {};
    res.json({
      totalBills:       parseInt(r.total)            || 0,
      totalAmountYtd:   parseFloat(r.total_amount_ytd) || 0,
      pendingCount:     parseInt(r.pending_count)    || 0,
      pendingAmount:    parseFloat(r.pending_amount) || 0,
      awaitingApproval: parseInt(r.awaiting_approval) || 0,
      overdueCount:     parseInt(r.overdue_count)    || 0,
      overdueAmount:    parseFloat(r.overdue_amount) || 0,
      paidMonthCount:   parseInt(r.paid_month_count) || 0,
      paidMonthAmount:  parseFloat(r.paid_month_amount) || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── P1-01 FIX: Correct column name entry_date ─────────────────────────────────
export const getJournalEntries = async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;

    const params = [];
    let where = 'WHERE 1=1';
    if (companyId != null) { params.push(companyId); where += ` AND company_id = $${params.length}`; }

    const totalRow = await pool.query(
      `SELECT COUNT(*)::int AS total FROM journal_entries ${where}`, params
    );
    const total = totalRow.rows[0]?.total ?? 0;

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT * FROM journal_entries ${where}
       ORDER BY entry_date DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    // Backward-compatible: return an array (bounded by LIMIT); expose paging via headers.
    res.setHeader('X-Total-Count', total);
    res.setHeader('X-Page', page);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── P0-05 + P2-03/04 FIX: Transaction, correct table/column names, validation ─
export const createJournalEntry = async (req, res) => {
  const { date, entry_date, reference, description, narration, lines } = req.body;
  const effectiveDate = entry_date || date;

  // Input validation
  if (!effectiveDate) {
    return res.status(400).json({ error: "date is required" });
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "lines must be a non-empty array" });
  }

  const totalDebit  = lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return res.status(400).json({
      error: `Journal entry must balance: debits (${totalDebit}) ≠ credits (${totalCredit})`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Generate next entry number
    const { rows: seqRows } = await client.query(
      `SELECT COUNT(*) AS n FROM journal_entries WHERE entry_number LIKE 'JE-%'`
    );
    const seq         = parseInt(seqRows[0].n) + 1;
    const entryNumber = `JE-${String(seq).padStart(5, "0")}`;

    const companyId = req.scope?.company_id ?? null;
    const { rows: entryRows } = await client.query(
      `INSERT INTO journal_entries
         (entry_number, entry_date, description, status, total_debit, total_credit, company_id)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6) RETURNING *`,
      [entryNumber, effectiveDate, description || narration || reference || "", totalDebit, totalCredit, companyId]
    );
    const entry = entryRows[0];

    for (const line of lines) {
      await client.query(
        `INSERT INTO journal_lines
           (entry_id, account_code, account_name, debit, credit, narration)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          entry.id,
          line.account || line.account_code || null,
          line.account_name || line.description || null,
          parseFloat(line.debit)  || 0,
          parseFloat(line.credit) || 0,
          line.narration || line.description || null,
        ]
      );
    }

    await client.query("COMMIT");
    res.json(entry);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

// ── P1-03 FIX: Not-found check on closePeriod ─────────────────────────────────
export const getPeriods = async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const params = [];
    let where = '';
    if (companyId != null) { params.push(companyId); where = ` WHERE company_id = $${params.length}`; }
    const result = await pool.query(
      `SELECT * FROM accounting_periods${where} ORDER BY start_date DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const closePeriod = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.scope?.company_id ?? null;
    const params = [req.user?.userId ?? req.user?.id ?? req.user?.email, id];
    let scope = '';
    if (companyId != null) { params.push(companyId); scope = ` AND company_id = $${params.length}`; }
    const result = await pool.query(
      `UPDATE accounting_periods
       SET status = 'closed', closed_by = $1, closed_at = NOW()
       WHERE id = $2 AND status = 'open'${scope}
       RETURNING *`,
      params
    );
    if (!result.rows.length) {
      return res.status(404).json({
        error: "Period not found or already closed",
      });
    }
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Finance', recordId: id, recordType: 'accounting_period', action: 'close_period', oldData: null, newData: result.rows[0], req });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const reopenPeriod = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.scope?.company_id ?? null;
    const params = [id];
    let scope = '';
    if (companyId != null) { params.push(companyId); scope = ` AND company_id = $${params.length}`; }
    const result = await pool.query(
      `UPDATE accounting_periods
       SET status = 'open', closed_by = NULL, closed_at = NULL
       WHERE id = $1 AND status = 'closed'${scope}
       RETURNING *`,
      params
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Period not found or already open' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── P1-02 + P2-02 FIX: Correct column names for chart_of_accounts ─────────────
export const getAccounts = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM chart_of_accounts ORDER BY code"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const createAccount = async (req, res) => {
  const { code, account_code, name, account_name, type, account_type, parent, is_active } = req.body;
  const resolvedCode = account_code || code;
  const resolvedName = account_name || name;
  const resolvedType = account_type || type;

  if (!resolvedCode || !resolvedName || !resolvedType) {
    return res.status(400).json({ error: "account_code, account_name, and account_type are required" });
  }

  const validTypes = ["Asset", "Liability", "Equity", "Revenue", "Expense"];
  if (!validTypes.includes(resolvedType)) {
    return res.status(400).json({
      error: `account_type must be one of: ${validTypes.join(", ")}`,
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO chart_of_accounts
         (code, name, account_type, parent_id, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [resolvedCode, resolvedName, resolvedType, parent || null, is_active !== false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: `Account code '${resolvedCode}' already exists` });
    }
    res.status(500).json({ error: err.message });
  }
};

export const getInvoices = async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 200));
    const params = [];
    let where = 'WHERE deleted_at IS NULL';
    if (companyId != null) { params.push(companyId); where += ` AND company_id = $${params.length}`; }
    params.push(limit);
    const result = await pool.query(
      `SELECT * FROM invoices ${where} ORDER BY invoice_date DESC LIMIT $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getBills = async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 200));
    const result = await pool.query(
      "SELECT * FROM supplier_bills ORDER BY bill_date DESC LIMIT $1", [limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
