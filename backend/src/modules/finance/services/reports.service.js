import pool from '../db.js';
import journalRepo from '../repositories/journal.repository.js';
import invoiceRepo from '../repositories/invoice.repository.js';
import billRepo from '../repositories/bill.repository.js';
import partiesRepo from '../repositories/parties.repository.js';

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
    const result = await pool.query(
      `SELECT 
        payment_method,
        SUM(CASE WHEN debit > 0 THEN debit ELSE 0 END) as cash_in,
        SUM(CASE WHEN credit > 0 THEN credit ELSE 0 END) as cash_out
       FROM journal_entry_lines jel
       JOIN journal_entries je ON jel.journal_entry_id = je.id
       JOIN chart_of_accounts coa ON jel.account_id = coa.id
       WHERE coa.code IN ('1110', '1120')
       AND je.entry_date BETWEEN $1 AND $2
       AND je.is_posted = true
       GROUP BY payment_method`,
      [startDate, endDate]
    );
    
    return result.rows;
  }

  async getCustomerOutstanding() {
    const customers = await partiesRepo.findAll({ party_type: 'Customer', is_active: true });
    const outstanding = [];
    
    for (const customer of customers) {
      const balance = await partiesRepo.getOutstandingBalance(customer.id, 'Customer');
      if (balance > 0) {
        outstanding.push({
          customer_id: customer.id,
          customer_name: customer.name,
          outstanding_balance: balance
        });
      }
    }
    
    return outstanding.sort((a, b) => b.outstanding_balance - a.outstanding_balance);
  }

  async getSupplierOutstanding() {
    const suppliers = await partiesRepo.findAll({ party_type: 'Supplier', is_active: true });
    const outstanding = [];
    
    for (const supplier of suppliers) {
      const balance = await partiesRepo.getOutstandingBalance(supplier.id, 'Supplier');
      if (balance > 0) {
        outstanding.push({
          supplier_id: supplier.id,
          supplier_name: supplier.name,
          outstanding_balance: balance
        });
      }
    }
    
    return outstanding.sort((a, b) => b.outstanding_balance - a.outstanding_balance);
  }

  async getFinanceDashboard() {
    const today = new Date().toISOString().split('T')[0];
    const firstDayOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    
    const overdueInvoices = await invoiceRepo.getOverdue();
    const dueSoonInvoices = await invoiceRepo.getDueSoon(7);
    const dueSoonBills = await billRepo.getDueSoon(7);
    
    const monthlyRevenue = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) as revenue 
       FROM invoices 
       WHERE invoice_date >= $1 AND status != 'Cancelled' AND deleted_at IS NULL`,
      [firstDayOfMonth]
    );
    
    const monthlyExpenses = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) as expenses 
       FROM bills 
       WHERE bill_date >= $1 AND status != 'Cancelled' AND deleted_at IS NULL`,
      [firstDayOfMonth]
    );
    
    const pendingBills = await billRepo.findAll({ approval_status: 'Pending' });
    
    return {
      overdue_invoices: overdueInvoices.length,
      overdue_amount: overdueInvoices.reduce((sum, inv) => sum + parseFloat(inv.balance), 0),
      due_soon_invoices: dueSoonInvoices.length,
      due_soon_bills: dueSoonBills.length,
      monthly_revenue: parseFloat(monthlyRevenue.rows[0].revenue),
      monthly_expenses: parseFloat(monthlyExpenses.rows[0].expenses),
      pending_approvals: pendingBills.length,
      alerts: [
        ...overdueInvoices.map(inv => ({
          type: 'overdue_invoice',
          message: `Invoice ${inv.invoice_number} is overdue by ${Math.floor((new Date() - new Date(inv.due_date)) / (1000 * 60 * 60 * 24))} days`,
          amount: inv.balance,
          customer: inv.customer_name
        })),
        ...dueSoonInvoices.map(inv => ({
          type: 'due_soon_invoice',
          message: `Invoice ${inv.invoice_number} due in ${Math.floor((new Date(inv.due_date) - new Date()) / (1000 * 60 * 60 * 24))} days`,
          amount: inv.balance,
          customer: inv.customer_name
        })),
        ...dueSoonBills.map(bill => ({
          type: 'due_soon_bill',
          message: `Bill ${bill.bill_number} due in ${Math.floor((new Date(bill.due_date) - new Date()) / (1000 * 60 * 60 * 24))} days`,
          amount: bill.balance,
          supplier: bill.supplier_name
        }))
      ]
    };
  }
}

export default new ReportsService();
