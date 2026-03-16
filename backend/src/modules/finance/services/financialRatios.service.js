import pool from '../db.js';
import journalRepo from '../repositories/journal.repository.js';

class FinancialRatiosService {
  async calculateRatios(asOfDate) {
    const trialBalance = await journalRepo.getTrialBalance('1900-01-01', asOfDate);
    
    // Calculate account type totals
    const currentAssets = this.sumAccountsByCode(trialBalance, ['1100', '1110', '1120', '1130'], 'Asset');
    const totalAssets = this.sumAccountsByType(trialBalance, 'Asset');
    const currentLiabilities = this.sumAccountsByCode(trialBalance, ['2100', '2110', '2120'], 'Liability');
    const totalLiabilities = this.sumAccountsByType(trialBalance, 'Liability');
    const totalEquity = this.sumAccountsByType(trialBalance, 'Equity');
    const inventory = this.sumAccountsByCode(trialBalance, ['1140'], 'Asset');
    
    // Get P&L data for the year
    const yearStart = new Date(asOfDate);
    yearStart.setMonth(0, 1);
    const plData = await this.getPLData(yearStart.toISOString().split('T')[0], asOfDate);
    
    // Get receivables and payables
    const receivables = await this.getReceivables();
    const payables = await this.getPayables();
    
    // Get sales and COGS
    const sales = plData.revenue;
    const cogs = this.sumAccountsByCode(trialBalance, ['5200'], 'Expense'); // Cost of Goods Sold
    const operatingExpenses = plData.expenses - cogs;
    const interestExpense = this.sumAccountsByCode(trialBalance, ['5300'], 'Expense');
    
    // Calculate ratios
    const ratios = {
      // Liquidity Ratios
      current_ratio: currentLiabilities > 0 ? (currentAssets / currentLiabilities).toFixed(2) : 0,
      quick_ratio: currentLiabilities > 0 ? ((currentAssets - inventory) / currentLiabilities).toFixed(2) : 0,
      cash_ratio: currentLiabilities > 0 ? (this.sumAccountsByCode(trialBalance, ['1110', '1120'], 'Asset') / currentLiabilities).toFixed(2) : 0,
      
      // Profitability Ratios
      gross_margin: sales > 0 ? (((sales - cogs) / sales) * 100).toFixed(2) : 0,
      operating_margin: sales > 0 ? (((sales - cogs - operatingExpenses) / sales) * 100).toFixed(2) : 0,
      net_margin: sales > 0 ? ((plData.net_profit / sales) * 100).toFixed(2) : 0,
      return_on_assets: totalAssets > 0 ? ((plData.net_profit / totalAssets) * 100).toFixed(2) : 0,
      return_on_equity: totalEquity > 0 ? ((plData.net_profit / totalEquity) * 100).toFixed(2) : 0,
      
      // Efficiency Ratios
      asset_turnover: totalAssets > 0 ? (sales / totalAssets).toFixed(2) : 0,
      inventory_turnover: inventory > 0 ? (cogs / inventory).toFixed(2) : 0,
      receivables_turnover: receivables > 0 ? (sales / receivables).toFixed(2) : 0,
      payables_turnover: payables > 0 ? (cogs / payables).toFixed(2) : 0,
      days_sales_outstanding: receivables > 0 && sales > 0 ? ((receivables / sales) * 365).toFixed(0) : 0,
      days_payable_outstanding: payables > 0 && cogs > 0 ? ((payables / cogs) * 365).toFixed(0) : 0,
      
      // Leverage Ratios
      debt_to_equity: totalEquity > 0 ? (totalLiabilities / totalEquity).toFixed(2) : 0,
      debt_to_assets: totalAssets > 0 ? ((totalLiabilities / totalAssets) * 100).toFixed(2) : 0,
      equity_ratio: totalAssets > 0 ? ((totalEquity / totalAssets) * 100).toFixed(2) : 0,
      interest_coverage: interestExpense > 0 ? ((plData.net_profit + interestExpense) / interestExpense).toFixed(2) : 0,
      
      // Working Capital
      working_capital: (currentAssets - currentLiabilities).toFixed(2),
      
      // Raw Data
      current_assets: currentAssets.toFixed(2),
      current_liabilities: currentLiabilities.toFixed(2),
      total_assets: totalAssets.toFixed(2),
      total_liabilities: totalLiabilities.toFixed(2),
      total_equity: totalEquity.toFixed(2),
      revenue: sales.toFixed(2),
      net_profit: plData.net_profit.toFixed(2)
    };
    
    return ratios;
  }

  sumAccountsByType(trialBalance, accountType) {
    return trialBalance
      .filter(acc => acc.account_type === accountType)
      .reduce((sum, acc) => {
        if (accountType === 'Asset' || accountType === 'Expense') {
          return sum + (parseFloat(acc.total_debit) - parseFloat(acc.total_credit));
        } else {
          return sum + (parseFloat(acc.total_credit) - parseFloat(acc.total_debit));
        }
      }, 0);
  }

  sumAccountsByCode(trialBalance, codes, accountType) {
    return trialBalance
      .filter(acc => codes.some(code => acc.code.startsWith(code)))
      .reduce((sum, acc) => {
        if (accountType === 'Asset' || accountType === 'Expense') {
          return sum + (parseFloat(acc.total_debit) - parseFloat(acc.total_credit));
        } else {
          return sum + (parseFloat(acc.total_credit) - parseFloat(acc.total_debit));
        }
      }, 0);
  }

  async getPLData(startDate, endDate) {
    const trialBalance = await journalRepo.getTrialBalance(startDate, endDate);
    
    const revenue = trialBalance
      .filter(acc => acc.account_type === 'Revenue')
      .reduce((sum, acc) => sum + parseFloat(acc.total_credit) - parseFloat(acc.total_debit), 0);
    
    const expenses = trialBalance
      .filter(acc => acc.account_type === 'Expense')
      .reduce((sum, acc) => sum + parseFloat(acc.total_debit) - parseFloat(acc.total_credit), 0);
    
    return {
      revenue,
      expenses,
      net_profit: revenue - expenses
    };
  }

  async getReceivables() {
    const result = await pool.query(
      `SELECT COALESCE(SUM(balance), 0) as total 
       FROM invoices 
       WHERE status NOT IN ('Paid', 'Cancelled') AND deleted_at IS NULL`
    );
    return parseFloat(result.rows[0].total);
  }

  async getPayables() {
    const result = await pool.query(
      `SELECT COALESCE(SUM(balance), 0) as total 
       FROM bills 
       WHERE status NOT IN ('Paid', 'Cancelled') AND deleted_at IS NULL`
    );
    return parseFloat(result.rows[0].total);
  }

  async getComparativeRatios(currentDate, previousDate) {
    const current = await this.calculateRatios(currentDate);
    const previous = await this.calculateRatios(previousDate);
    
    const comparison = {};
    for (const key in current) {
      comparison[key] = {
        current: current[key],
        previous: previous[key],
        change: previous[key] > 0 ? (((current[key] - previous[key]) / previous[key]) * 100).toFixed(2) : 0
      };
    }
    
    return comparison;
  }
}

export default new FinancialRatiosService();
