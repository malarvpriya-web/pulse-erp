import pool from '../db.js';
import journalRepo from '../repositories/journal.repository.js';
import invoiceRepo from '../repositories/invoice.repository.js';
import billRepo from '../repositories/bill.repository.js';
import partiesRepo from '../repositories/parties.repository.js';
import { hasChartAccountLink } from '../repositories/bankAccount.repository.js';

class ReportsService {
  async getProfitAndLoss(startDate, endDate) {
    const trialBalance = await journalRepo.getTrialBalance(startDate, endDate);
    
    const revenue = trialBalance
      .filter(acc => acc.account_type === 'Revenue')
      .reduce((sum, acc) => sum + parseFloat(acc.total_credit) - parseFloat(acc.total_debit), 0);
    
    const expenses = trialBalance
      .filter(acc => acc.account_type === 'Expense')
      .reduce((sum, acc) => sum + parseFloat(acc.total_debit) - parseFloat(acc.total_credit), 0);
    
    return {
      revenue_accounts: trialBalance.filter(acc => acc.account_type === 'Revenue'),
      expense_accounts: trialBalance.filter(acc => acc.account_type === 'Expense'),
      total_revenue: revenue,
      total_expenses: expenses,
      net_profit: revenue - expenses,
      period: { start_date: startDate, end_date: endDate }
    };
  }

  async getBalanceSheet(asOfDate) {
    const trialBalance = await journalRepo.getTrialBalance('1900-01-01', asOfDate);
    
    const assets = trialBalance
      .filter(acc => acc.account_type === 'Asset')
      .reduce((sum, acc) => sum + parseFloat(acc.total_debit) - parseFloat(acc.total_credit), 0);
    
    const liabilities = trialBalance
      .filter(acc => acc.account_type === 'Liability')
      .reduce((sum, acc) => sum + parseFloat(acc.total_credit) - parseFloat(acc.total_debit), 0);
    
    const equity = trialBalance
      .filter(acc => acc.account_type === 'Equity')
      .reduce((sum, acc) => sum + parseFloat(acc.total_credit) - parseFloat(acc.total_debit), 0);
    
    return {
      asset_accounts: trialBalance.filter(acc => acc.account_type === 'Asset'),
      liability_accounts: trialBalance.filter(acc => acc.account_type === 'Liability'),
      equity_accounts: trialBalance.filter(acc => acc.account_type === 'Equity'),
      total_assets: assets,
      total_liabilities: liabilities,
      total_equity: equity,
      as_of_date: asOfDate
    };
  }

  async getCashFlow(startDate, endDate) {
    // Cash & bank accounts are classified under Asset type with sub_type 'bank' or 'cash',
    // or explicitly account_code starting with '1001' (Cash & Bank in seeded CoA).
    const result = await pool.query(
      `SELECT
        coa.code    AS account_code,
        coa.name    AS account_name,
        COALESCE(SUM(jel.debit),  0) AS cash_in,
        COALESCE(SUM(jel.credit), 0) AS cash_out,
        COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0) AS net_movement
       FROM journal_entry_lines jel
       JOIN journal_entries je  ON jel.journal_entry_id = je.id
       JOIN chart_of_accounts coa ON jel.account_id = coa.id
       WHERE coa.account_type = 'Asset'
         AND (coa.sub_type IN ('bank', 'cash') OR coa.code LIKE '1001%')
         AND je.entry_date BETWEEN $1 AND $2
         AND (je.is_posted = true OR je.status = 'posted')
         AND je.deleted_at IS NULL
       GROUP BY coa.code, coa.name
       ORDER BY coa.code`,
      [startDate, endDate]
    );

    const cash_in  = result.rows.reduce((s, r) => s + parseFloat(r.cash_in  || 0), 0);
    const cash_out = result.rows.reduce((s, r) => s + parseFloat(r.cash_out || 0), 0);
    return { accounts: result.rows, total_cash_in: cash_in, total_cash_out: cash_out, net_change: cash_in - cash_out };
  }

  async getCustomerOutstanding(companyId, asOfDate) {
    const d         = asOfDate || new Date().toISOString().split('T')[0];
    const cidClause = companyId != null ? 'AND inv.company_id = $2' : '';
    const params    = companyId != null ? [d, companyId] : [d];

    // Invoice-level rows with ageing bucket tags (matches CustomerOutstanding.jsx invoice view)
    const result = await pool.query(
      `SELECT
         inv.id,
         inv.invoice_number,
         inv.invoice_date::text,
         inv.due_date::text,
         inv.total_amount::numeric  AS total_amount,
         COALESCE(inv.paid_amount, 0)::numeric AS paid_amount,
         inv.balance::numeric,
         p.id   AS customer_id,
         p.name AS customer_name,
         ($1::date - inv.due_date)  AS ageing_days,
         CASE
           WHEN inv.due_date >= $1::date                         THEN 'current'
           WHEN ($1::date - inv.due_date) BETWEEN 1  AND 30     THEN '1-30'
           WHEN ($1::date - inv.due_date) BETWEEN 31 AND 60     THEN '31-60'
           WHEN ($1::date - inv.due_date) BETWEEN 61 AND 90     THEN '61-90'
           ELSE '90+'
         END AS ageing_bucket
       FROM invoices inv
       JOIN parties p ON p.id = inv.customer_id
       WHERE inv.status NOT IN ('Paid','Cancelled','paid','cancelled')
         AND inv.deleted_at IS NULL
         AND inv.invoice_date <= $1::date
         AND inv.balance > 0
         ${cidClause}
       ORDER BY ($1::date - inv.due_date) DESC`,
      params
    );

    const rows = result.rows;
    const summary = rows.reduce(
      (acc, r) => {
        const b   = parseFloat(r.balance || 0);
        const bkt = r.ageing_bucket;
        return {
          total:       acc.total       + b,
          current:     acc.current     + (bkt === 'current' ? b : 0),
          days_1_30:   acc.days_1_30   + (bkt === '1-30'    ? b : 0),
          days_31_60:  acc.days_31_60  + (bkt === '31-60'   ? b : 0),
          days_61_90:  acc.days_61_90  + (bkt === '61-90'   ? b : 0),
          days_90plus: acc.days_90plus + (bkt === '90+'     ? b : 0),
        };
      },
      { total: 0, current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90plus: 0 }
    );
    return { rows, summary, as_of_date: d };
  }

  async getSupplierOutstanding(companyId, asOfDate) {
    const d = asOfDate || new Date().toISOString().split('T')[0];
    const cidClause = companyId != null ? 'AND b.company_id = $2' : '';
    const params    = companyId != null ? [d, companyId] : [d];

    const result = await pool.query(
      `SELECT
         p.id            AS supplier_id,
         p.name          AS supplier_name,
         p.gstin,
         COALESCE(SUM(b.total_amount), 0)::numeric  AS total,
         COALESCE(SUM(b.paid_amount),  0)::numeric  AS paid,
         COALESCE(SUM(b.balance),      0)::numeric  AS balance,
         COALESCE(SUM(CASE WHEN b.due_date >= $1::date
                           THEN b.balance ELSE 0 END), 0)::numeric  AS not_yet_due,
         COALESCE(SUM(CASE WHEN ($1::date - b.due_date) BETWEEN 1  AND 30
                           THEN b.balance ELSE 0 END), 0)::numeric  AS due_1_30,
         COALESCE(SUM(CASE WHEN ($1::date - b.due_date) BETWEEN 31 AND 60
                           THEN b.balance ELSE 0 END), 0)::numeric  AS due_31_60,
         COALESCE(SUM(CASE WHEN ($1::date - b.due_date) BETWEEN 61 AND 90
                           THEN b.balance ELSE 0 END), 0)::numeric  AS due_61_90,
         COALESCE(SUM(CASE WHEN ($1::date - b.due_date) > 90
                           THEN b.balance ELSE 0 END), 0)::numeric  AS due_90plus
       FROM bills b
       JOIN parties p ON p.id = b.supplier_id
       WHERE b.status NOT IN ('Paid','Cancelled','paid','cancelled')
         AND b.deleted_at IS NULL
         AND b.bill_date <= $1::date
         AND b.balance > 0
         ${cidClause}
       GROUP BY p.id, p.name, p.gstin
       HAVING COALESCE(SUM(b.balance), 0) > 0
       ORDER BY SUM(b.balance) DESC`,
      params
    );

    const rows = result.rows;
    const summary = rows.reduce(
      (acc, r) => ({
        total:       acc.total       + parseFloat(r.total      || 0),
        paid:        acc.paid        + parseFloat(r.paid       || 0),
        balance:     acc.balance     + parseFloat(r.balance    || 0),
        not_yet_due: acc.not_yet_due + parseFloat(r.not_yet_due|| 0),
        due_1_30:    acc.due_1_30    + parseFloat(r.due_1_30   || 0),
        due_31_60:   acc.due_31_60   + parseFloat(r.due_31_60  || 0),
        due_61_90:   acc.due_61_90   + parseFloat(r.due_61_90  || 0),
        due_90plus:  acc.due_90plus  + parseFloat(r.due_90plus || 0),
      }),
      { total: 0, paid: 0, balance: 0, not_yet_due: 0, due_1_30: 0, due_31_60: 0, due_61_90: 0, due_90plus: 0 }
    );
    return { rows, summary, as_of_date: d };
  }

  async getFinanceDashboard(opts = {}) {
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const fyScoped = isDate(opts.fyStart) && isDate(opts.fyEnd);

    const today = new Date().toISOString().split('T')[0];
    const firstDayOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

    // When an FY range is supplied, revenue/expenses cover that whole FY;
    // otherwise they fall back to month-to-date. Overdue/due-soon/pending
    // stay live — they are actionable relative to today regardless of FY.
    const periodStart = fyScoped ? opts.fyStart : firstDayOfMonth;
    const periodEnd   = fyScoped ? opts.fyEnd   : today;

    const overdueInvoices = await invoiceRepo.getOverdue();
    const dueSoonInvoices = await invoiceRepo.getDueSoon(7);
    const dueSoonBills = await billRepo.getDueSoon(7);

    const monthlyRevenue = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) as revenue
       FROM invoices
       WHERE invoice_date >= $1 AND invoice_date <= $2 AND status != 'Cancelled' AND deleted_at IS NULL`,
      [periodStart, periodEnd]
    );

    const monthlyExpenses = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) as expenses
       FROM bills
       WHERE bill_date >= $1 AND bill_date <= $2 AND status != 'Cancelled' AND deleted_at IS NULL`,
      [periodStart, periodEnd]
    );

    const pendingBills = await billRepo.findAll({ approval_status: 'Pending' });

    // ── Enrichment: AR/AP snapshots + ageing (live) and cash movement (FY) ──
    // Wrapped defensively so the core dashboard still returns if any of these fail.
    let accountsReceivable = 0, accountsPayable = 0;
    let arAging = [], apAging = [];
    let cashBalance = 0, cashInflow = 0, cashOutflow = 0;
    try {
      const [arData, apData, cashRow, inflowRow, outflowRow] = await Promise.all([
        this.getCustomerOutstanding(null, today),
        this.getSupplierOutstanding(null, today),
        pool.query(`SELECT COALESCE(SUM(current_balance), 0) AS total FROM bank_accounts WHERE is_active = true AND deleted_at IS NULL`),
        pool.query(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM receipts WHERE receipt_date >= $1 AND receipt_date <= $2`,
          [periodStart, periodEnd]
        ),
        pool.query(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE payment_date >= $1 AND payment_date <= $2`,
          [periodStart, periodEnd]
        ),
      ]);

      const arS = arData.summary;
      const apS = apData.summary;
      accountsReceivable = arS.total;
      accountsPayable    = apS.balance;
      arAging = [
        { bucket: 'Current',    amount: arS.current     },
        { bucket: '1-30 days',  amount: arS.days_1_30   },
        { bucket: '31-60 days', amount: arS.days_31_60  },
        { bucket: '61-90 days', amount: arS.days_61_90  },
        { bucket: '90+ days',   amount: arS.days_90plus },
      ];
      apAging = [
        { bucket: 'Current',    amount: apS.not_yet_due },
        { bucket: '1-30 days',  amount: apS.due_1_30    },
        { bucket: '31-60 days', amount: apS.due_31_60   },
        { bucket: '61-90 days', amount: apS.due_61_90   },
        { bucket: '90+ days',   amount: apS.due_90plus  },
      ];
      // Cash balance: bank_accounts.current_balance is only maintained by
      // payment-batch disbursement and manual bank transactions, so it is
      // usually stale (stuck at opening balance). We instead compute cash the
      // SAME way GET /balance-sheet does — opening_balance + net posted movement
      // from the legacy `journal_lines` ledger — so this figure agrees with the
      // Balance Sheet. Scoped to the GL accounts linked to bank accounts.
      // current_balance is only a last resort when no GL mapping exists.
      if (await hasChartAccountLink()) {
        const cashGL = await pool.query(
          `SELECT COALESCE(SUM(coa.opening_balance), 0)
                + COALESCE(SUM(mv.debit - mv.credit), 0) AS total,
                  COUNT(*) AS mapped
           FROM chart_of_accounts coa
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(jl.debit), 0) AS debit,
                    COALESCE(SUM(jl.credit), 0) AS credit
             FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.entry_id
             WHERE jl.account_id = coa.id
               AND je.status = 'posted'
               AND je.entry_date <= CURRENT_DATE
           ) mv ON true
           WHERE coa.id IN (
             SELECT DISTINCT chart_account_id FROM bank_accounts
             WHERE chart_account_id IS NOT NULL AND deleted_at IS NULL
           )`
        );
        cashBalance = parseInt(cashGL.rows[0].mapped, 10) > 0
          ? parseFloat(cashGL.rows[0].total)
          : parseFloat(cashRow.rows[0].total);
      } else {
        cashBalance = parseFloat(cashRow.rows[0].total);
      }
      cashInflow  = parseFloat(inflowRow.rows[0].total);
      cashOutflow = parseFloat(outflowRow.rows[0].total);
    } catch (err) {
      console.error('getFinanceDashboard enrichment failed:', err.message);
    }

    return {
      overdue_invoices: overdueInvoices.length,
      overdue_amount: overdueInvoices.reduce((sum, inv) => sum + parseFloat(inv.balance ?? (inv.total_amount - (inv.paid_amount ?? 0))), 0),
      due_soon_invoices: dueSoonInvoices.length,
      due_soon_bills: dueSoonBills.length,
      monthly_revenue: parseFloat(monthlyRevenue.rows[0].revenue),
      monthly_expenses: parseFloat(monthlyExpenses.rows[0].expenses),
      fy_scoped: fyScoped,
      period_start: periodStart,
      period_end: periodEnd,
      accounts_receivable: accountsReceivable,
      accounts_payable: accountsPayable,
      arAging,
      apAging,
      cash_balance: cashBalance,
      cash_inflow: cashInflow,
      cash_outflow: cashOutflow,
      pending_approvals: pendingBills.length,
      alerts: [
        ...overdueInvoices.map(inv => ({
          type: 'overdue_invoice',
          message: `Invoice ${inv.invoice_number} is overdue by ${Math.floor((new Date() - new Date(inv.due_date)) / (1000 * 60 * 60 * 24))} days`,
          amount: inv.balance ?? (inv.total_amount - (inv.paid_amount ?? 0)),
          customer: inv.customer_name
        })),
        ...dueSoonInvoices.map(inv => ({
          type: 'due_soon_invoice',
          message: `Invoice ${inv.invoice_number} due in ${Math.floor((new Date(inv.due_date) - new Date()) / (1000 * 60 * 60 * 24))} days`,
          amount: inv.balance ?? (inv.total_amount - (inv.paid_amount ?? 0)),
          customer: inv.customer_name
        })),
        ...dueSoonBills.map(bill => ({
          type: 'due_soon_bill',
          message: `Bill ${bill.bill_number} due in ${Math.floor((new Date(bill.due_date) - new Date()) / (1000 * 60 * 60 * 24))} days`,
          amount: bill.balance ?? (bill.total_amount - (bill.paid_amount ?? 0)),
          supplier: bill.supplier_name
        }))
      ]
    };
  }
}

export default new ReportsService();
