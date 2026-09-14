import pool from "../../config/db.js";
import { logAudit } from '../../services/AuditService.js';
import {
  notIn, INVOICE_VOID, INVOICE_PAID, BILL_VOID, BILL_PAID,
} from '../../shared/statusSets.js';

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

    // Every query below ran unscoped, so this dashboard's AR, AP, revenue,
    // expenses, overdue and bank figures were cross-tenant totals -- while
    // getCFODashboard immediately below computes the same quantities scoped.
    // Two dashboards over the same numbers have to agree, and the scoped one is
    // the correct half.
    const companyId = req.scope?.company_id ?? null;
    // Each query gets its own params array: a shared one would leave the
    // company placeholder unreferenced in some statements, which Postgres
    // rejects outright rather than ignoring.
    const cid1 = companyId != null ? ' AND company_id = $1' : '';
    const p1   = companyId != null ? [companyId] : [];
    const cid3 = companyId != null ? ' AND company_id = $3' : '';
    const p3   = (a, b) => (companyId != null ? [a, b, companyId] : [a, b]);

    const [
      arRow, apRow, revRow, expRow,
      overdueInvoicesRow, overdueInvoicesCount,
      upcomingBillsCount,
    ] = await Promise.all([
      // Accounts receivable — open invoices
      safeRows(`SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount,0)), 0) AS value
                FROM invoices WHERE LOWER(status) NOT IN ('paid','cancelled')${cid1}`, p1),
      // Accounts payable — open bills
      safeRows(`SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount,0)), 0) AS value
                FROM bills WHERE LOWER(status) NOT IN ('paid','cancelled')${cid1}`, p1),
      // Month revenue — invoices issued this month
      safeRows(`SELECT COALESCE(SUM(total_amount), 0) AS value FROM invoices
                WHERE invoice_date >= $1 AND invoice_date < $2${cid3}`, p3(monthStart, nextMonth)),
      // Month expenses — bills issued this month
      safeRows(`SELECT COALESCE(SUM(total_amount), 0) AS value FROM bills
                WHERE bill_date >= $1 AND bill_date < $2${cid3}`, p3(monthStart, nextMonth)),
      // Overdue invoices count (due_date < today and not paid)
      safeRows(`SELECT COUNT(*) AS value FROM invoices
                WHERE due_date < NOW() AND LOWER(status) NOT IN ('paid','cancelled')${cid1}`, p1),
      // Overdue invoices total
      safeRows(`SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount,0)), 0) AS value
                FROM invoices WHERE due_date < NOW() AND LOWER(status) NOT IN ('paid','cancelled')${cid1}`, p1),
      // Bills due in next 7 days
      safeRows(`SELECT COUNT(*) AS value FROM bills
                WHERE due_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'
                  AND LOWER(status) NOT IN ('paid','cancelled')${cid1}`, p1),
    ]);

    // Cash/bank balance — primary: bank_accounts.current_balance; fallback: journal_lines
    const bankAccountsBalance = await safeValue(
      `SELECT COALESCE(SUM(current_balance), 0) AS value
       FROM bank_accounts WHERE is_active = true AND deleted_at IS NULL${cid1}`, p1
    );
    const cashBankBalance = bankAccountsBalance > 0
      ? bankAccountsBalance
      : await safeValue(
          `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS value
           FROM journal_lines jl
           JOIN chart_of_accounts coa ON coa.id = jl.account_id
           JOIN journal_entries   je  ON je.id  = jl.entry_id
           WHERE coa.code IN ('1001','1002') AND je.status = 'posted'
             ${companyId != null ? 'AND je.company_id = $1' : ''}`, p1
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
    // Revenue is company-scoped via invoices; expenses via bills — both have a real
    // company_id column, so both are scoped the same way (safeRows-guarded).
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
      safeRows(`SELECT COALESCE(SUM(total_amount), 0) AS value FROM bills
                WHERE bill_date >= date_trunc('year', NOW())${invCid}`, invParams),
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
        COUNT(*) FILTER (WHERE LOWER(status) = 'paid')                 AS paid,
        COUNT(*) FILTER (WHERE due_date < NOW()
                           AND LOWER(status) NOT IN ('paid','cancelled')) AS overdue,
        COALESCE(SUM(total_amount - COALESCE(paid_amount,0))
          FILTER (WHERE LOWER(status) NOT IN ('paid','cancelled')), 0) AS outstanding
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

    const periodParams = [id];
    let periodScope = '';
    if (companyId != null) { periodParams.push(companyId); periodScope = ` AND company_id = $${periodParams.length}`; }
    const { rows: periods } = await pool.query(
      `SELECT * FROM accounting_periods WHERE id = $1 AND status = 'open'${periodScope}`,
      periodParams
    );
    if (!periods.length) {
      return res.status(404).json({ error: "Period not found or already closed" });
    }
    const period = periods[0];

    // Refuse to close over an inconsistent ledger — everything in range must be posted or reversed first.
    const draftParams = [period.start_date, period.end_date];
    let draftScope = '';
    if (companyId != null) { draftParams.push(companyId); draftScope = ` AND company_id = $${draftParams.length}`; }
    const { rows: drafts } = await pool.query(
      `SELECT COUNT(*) FROM journal_entries WHERE status = 'draft' AND entry_date BETWEEN $1 AND $2${draftScope}`,
      draftParams
    );
    if (parseInt(drafts[0].count) > 0) {
      return res.status(400).json({ error: `Cannot close period: ${drafts[0].count} draft journal entries exist within this period.` });
    }

    const summaryParams = [period.start_date, period.end_date];
    let summaryScope = '';
    if (companyId != null) { summaryParams.push(companyId); summaryScope = ` AND je.company_id = $${summaryParams.length}`; }
    const { rows: summary } = await pool.query(
      `SELECT
         COALESCE(SUM(jl.debit),0) AS total_debits,
         COALESCE(SUM(jl.credit),0) AS total_credits,
         SUM(CASE WHEN coa.account_type='Revenue' THEN jl.credit - jl.debit ELSE 0 END) -
         SUM(CASE WHEN coa.account_type='Expense' THEN jl.debit - jl.credit ELSE 0 END) AS net_income
       FROM journal_entries je
       JOIN journal_lines jl ON jl.entry_id = je.id
       JOIN chart_of_accounts coa ON coa.id = jl.account_id
       WHERE je.status = 'posted' AND je.entry_date BETWEEN $1 AND $2${summaryScope}`,
      summaryParams
    );
    const periodSummary = {
      total_debits: parseFloat(summary[0]?.total_debits) || 0,
      total_credits: parseFloat(summary[0]?.total_credits) || 0,
      net_income: parseFloat(summary[0]?.net_income) || 0,
    };

    const result = await pool.query(
      `UPDATE accounting_periods
       SET status = 'closed', closed_by = $1, closed_at = NOW(), period_summary = $2
       WHERE id = $3
       RETURNING *`,
      [req.user?.userId ?? req.user?.id ?? req.user?.email, JSON.stringify(periodSummary), id]
    );
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Finance', recordId: id, recordType: 'accounting_period', action: 'close_period', oldData: period, newData: result.rows[0], req });
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
      "SELECT * FROM bills ORDER BY bill_date DESC LIMIT $1", [limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /finance/periods/:id/summary
 *
 * The figures a period close is decided on: what the period earned and spent,
 * what is still owed in and out, how many journals it contains, and how many
 * bank lines are still unreconciled.
 *
 * This exists because PeriodClosing.jsx rendered all of it from a hardcoded
 * `CURRENT_SUMMARY` object -- a Finance Manager was deciding whether to close an
 * accounting period against invented figures, including a fixed
 * "3 unreconciled transactions" warning that never reflected the bank at all.
 *
 * Metric definitions are deliberately the same ones getCFODashboard and
 * getInvoiceStats/getBillStats use (revenue = invoices.total_amount,
 * expenses = bills.total_amount, receivable/payable net of what is already
 * paid), so the close screen and the CFO dashboard cannot disagree. The window
 * is the period's own start_date..end_date rather than a fiscal-year-to-date,
 * because that is the span being closed.
 *
 * Deliberately NOT using the safeRows() helper the older handlers in this file
 * use: it turns a failing query into an empty array, which here would silently
 * become a confident "0 unreconciled, safe to close".
 */
export const getPeriodSummary = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.scope?.company_id ?? null;

    const { rows: periods } = await pool.query(
      `SELECT id, name, start_date, end_date, status
         FROM accounting_periods
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [id, companyId]
    );
    if (!periods.length) return res.status(404).json({ error: 'Period not found.' });
    const period = periods[0];

    // Each query gets its OWN parameter array. Sharing one fixed-position array
    // across sibling queries leaves $1 unreferenced in the two "as at end_date"
    // ones, and Postgres rejects the whole statement with "could not determine
    // data type of parameter $1" rather than ignoring the spare.
    const win   = [period.start_date, period.end_date, companyId];
    const asAt  = [period.end_date, companyId];

    const [revRow, expRow, arRow, apRow, jvRow, bankRow, gstRow] = await Promise.all([
      // Billed revenue in the window.
      pool.query(
        `SELECT COALESCE(SUM(total_amount),0) AS v
           FROM invoices
          WHERE invoice_date BETWEEN $1 AND $2
            AND deleted_at IS NULL
            AND ${notIn('status', INVOICE_VOID)}
            AND ($3::int IS NULL OR company_id = $3)`, win),
      pool.query(
        `SELECT COALESCE(SUM(total_amount),0) AS v
           FROM bills
          WHERE bill_date BETWEEN $1 AND $2
            AND deleted_at IS NULL
            AND ${notIn('status', BILL_VOID)}
            AND ($3::int IS NULL OR company_id = $3)`, win),
      // Outstanding is a position as at the period end, not a flow inside it,
      // so these two are bounded by end_date only.
      pool.query(
        `SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount,0)),0) AS v
           FROM invoices
          WHERE invoice_date <= $1
            AND deleted_at IS NULL
            AND ${notIn('status', [...INVOICE_VOID, ...INVOICE_PAID])}
            AND ($2::int IS NULL OR company_id = $2)`, asAt),
      pool.query(
        `SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount,0)),0) AS v
           FROM bills
          WHERE bill_date <= $1
            AND deleted_at IS NULL
            AND ${notIn('status', [...BILL_VOID, ...BILL_PAID])}
            AND ($2::int IS NULL OR company_id = $2)`, asAt),
      pool.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE status='draft')::int AS drafts
           FROM journal_entries
          WHERE entry_date BETWEEN $1 AND $2
            AND ($3::int IS NULL OR company_id = $3)`, win),
      // bank_transactions carries no company_id of its own; it scopes through
      // the account it belongs to.
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE bt.reconciled IS NOT TRUE)::int AS unreconciled
           FROM bank_transactions bt
           JOIN bank_accounts ba ON ba.id = bt.bank_account_id
          WHERE bt.transaction_date BETWEEN $1 AND $2
            AND ($3::int IS NULL OR ba.company_id = $3)`, win),
      // Net GST = output tax charged on sales less input credit actually
      // eligible on purchases. Neither gst table carries company_id, so both
      // scope through the invoice/bill they were raised against.
      pool.query(
        `SELECT
           COALESCE((SELECT SUM(gi.total_gst)
                       FROM gst_invoices gi
                       JOIN invoices i ON i.id = gi.invoice_id
                      WHERE gi.invoice_date BETWEEN $1 AND $2
                        AND ($3::int IS NULL OR i.company_id = $3)), 0) AS output_tax,
           COALESCE((SELECT SUM(COALESCE(gp.igst,0) + COALESCE(gp.cgst,0) + COALESCE(gp.sgst,0))
                       FROM gst_purchase_invoices gp
                       JOIN bills b ON b.id = gp.bill_id
                      WHERE gp.invoice_date BETWEEN $1 AND $2
                        AND gp.itc_eligible IS TRUE
                        AND ($3::int IS NULL OR b.company_id = $3)), 0) AS input_credit`, win),
    ]);

    const revenue  = parseFloat(revRow.rows[0].v) || 0;
    const expenses = parseFloat(expRow.rows[0].v) || 0;

    res.json({
      period_id:   period.id,
      period_name: period.name,
      start_date:  period.start_date,
      end_date:    period.end_date,
      status:      period.status,
      revenue,
      expenses,
      netProfit:        revenue - expenses,
      arOutstanding:    parseFloat(arRow.rows[0].v) || 0,
      apOutstanding:    parseFloat(apRow.rows[0].v) || 0,
      taxPayable:       (parseFloat(gstRow.rows[0].output_tax) || 0)
                        - (parseFloat(gstRow.rows[0].input_credit) || 0),
      jvCount:          jvRow.rows[0].n,
      draftJvCount:     jvRow.rows[0].drafts,
      unreconciledTxns: bankRow.rows[0].unreconciled,
    });
  } catch (err) {
    console.error('[GET /finance/periods/:id/summary]', err.message);
    res.status(500).json({ error: 'Failed to compute period summary.' });
  }
};
