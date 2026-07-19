import pool from '../db.js';

// Build a nested tree from a flat list sorted by code
function buildTree(rows) {
  const byId = {};
  const roots = [];
  for (const r of rows) { byId[r.id] = { ...r, children: [] }; }
  for (const r of rows) {
    if (r.parent_id && byId[r.parent_id]) {
      byId[r.parent_id].children.push(byId[r.id]);
    } else {
      roots.push(byId[r.id]);
    }
  }
  return roots;
}

class ChartOfAccountsRepository {
  async create(data) {
    const { code, name, account_type, parent_id, description, is_active, company_id } = data;
    const result = await pool.query(
      `INSERT INTO chart_of_accounts
         (code, name, account_type, parent_id, description, is_active, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [code, name, account_type, parent_id || null, description || null,
       is_active !== false, company_id || null]
    );
    return result.rows[0];
  }

  async findById(id) {
    const result = await pool.query(
      'SELECT * FROM chart_of_accounts WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    return result.rows[0];
  }

  async findAll(companyId) {
    const result = await pool.query(
      `SELECT * FROM chart_of_accounts
       WHERE deleted_at IS NULL
         AND (company_id = $1 OR company_id IS NULL)
       ORDER BY code`,
      [companyId ?? null]
    );
    return result.rows;
  }

  async findTree(companyId) {
    const result = await pool.query(
      `SELECT * FROM chart_of_accounts
       WHERE deleted_at IS NULL
         AND (company_id = $1 OR company_id IS NULL)
       ORDER BY code`,
      [companyId ?? null]
    );
    return buildTree(result.rows);
  }

  async update(id, data) {
    const { name, is_active, parent_id, description } = data;
    const result = await pool.query(
      `UPDATE chart_of_accounts
       SET name = $1, is_active = $2, parent_id = $3, description = $4,
           updated_at = NOW()
       WHERE id = $5 AND deleted_at IS NULL
       RETURNING *`,
      [name, is_active !== false, parent_id || null, description || null, id]
    );
    return result.rows[0];
  }

  async softDelete(id) {
    const result = await pool.query(
      'UPDATE chart_of_accounts SET deleted_at = NOW() WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0];
  }

  async getBalance(accountId, startDate, endDate) {
    const result = await pool.query(
      `SELECT
         COALESCE(SUM(jel.debit),  0) AS total_debit,
         COALESCE(SUM(jel.credit), 0) AS total_credit
       FROM journal_entry_lines jel
       JOIN journal_entries je ON jel.journal_entry_id = je.id
       WHERE jel.account_id = $1
         AND je.entry_date  BETWEEN $2 AND $3
         AND (je.is_posted = true OR je.status = 'posted')`,
      [accountId, startDate, endDate]
    );
    return result.rows[0];
  }

  // Seed standard Indian SME CoA — idempotent (ON CONFLICT DO NOTHING)
  async seedDefaults(companyId) {
    const accounts = [
      // ASSETS
      { code: '1001', name: 'Cash in Hand',                       type: 'Asset',     sub: 'cash' },
      { code: '1002', name: 'Bank — Current Account',             type: 'Asset',     sub: 'bank' },
      { code: '1003', name: 'Bank — Savings Account',             type: 'Asset',     sub: 'bank' },
      { code: '1010', name: 'Accounts Receivable',                type: 'Asset',     sub: 'receivable' },
      { code: '1011', name: 'TDS Receivable',                     type: 'Asset',     sub: 'receivable' },
      { code: '1012', name: 'Advance to Suppliers',               type: 'Asset',     sub: 'advance' },
      { code: '1013', name: 'Employee Advances',                  type: 'Asset',     sub: 'advance' },
      { code: '1020', name: 'Input CGST Receivable',              type: 'Asset',     sub: 'gst_itc' },
      { code: '1021', name: 'Input SGST Receivable',              type: 'Asset',     sub: 'gst_itc' },
      { code: '1022', name: 'Input IGST Receivable',              type: 'Asset',     sub: 'gst_itc' },
      { code: '1030', name: 'Raw Material Inventory',             type: 'Asset',     sub: 'inventory' },
      { code: '1031', name: 'Work-in-Progress (WIP)',             type: 'Asset',     sub: 'inventory' },
      { code: '1032', name: 'Finished Goods Inventory',           type: 'Asset',     sub: 'inventory' },
      { code: '1040', name: 'Prepaid Expenses',                   type: 'Asset',     sub: 'prepaid' },
      { code: '1100', name: 'Fixed Assets — Plant & Machinery',   type: 'Asset',     sub: 'fixed_asset' },
      { code: '1101', name: 'Fixed Assets — Furniture & Fixtures',type: 'Asset',     sub: 'fixed_asset' },
      { code: '1102', name: 'Fixed Assets — Computers & IT',      type: 'Asset',     sub: 'fixed_asset' },
      { code: '1103', name: 'Fixed Assets — Vehicles',            type: 'Asset',     sub: 'fixed_asset' },
      { code: '1110', name: 'Accumulated Depreciation — P&M',     type: 'Asset',     sub: 'contra_asset' },
      // LIABILITIES
      { code: '2001', name: 'Accounts Payable',                   type: 'Liability', sub: 'payable' },
      { code: '2002', name: 'Advance from Customers',             type: 'Liability', sub: 'advance' },
      { code: '2010', name: 'CGST Payable',                       type: 'Liability', sub: 'gst_payable' },
      { code: '2011', name: 'SGST Payable',                       type: 'Liability', sub: 'gst_payable' },
      { code: '2012', name: 'IGST Payable',                       type: 'Liability', sub: 'gst_payable' },
      { code: '2020', name: 'TDS Payable — 194C (Contractor)',    type: 'Liability', sub: 'tds_payable' },
      { code: '2021', name: 'TDS Payable — 194J (Professional)',  type: 'Liability', sub: 'tds_payable' },
      { code: '2030', name: 'PF Payable',                         type: 'Liability', sub: 'statutory' },
      { code: '2031', name: 'ESI Payable',                        type: 'Liability', sub: 'statutory' },
      { code: '2032', name: 'Professional Tax Payable',           type: 'Liability', sub: 'statutory' },
      { code: '2040', name: 'Salary & Wages Payable',             type: 'Liability', sub: 'accrual' },
      { code: '2100', name: 'Term Loans (Banks)',                  type: 'Liability', sub: 'loan' },
      { code: '2101', name: 'Vehicle Loans',                      type: 'Liability', sub: 'loan' },
      // EQUITY
      { code: '3001', name: 'Share Capital — Equity',             type: 'Equity',    sub: 'capital' },
      { code: '3002', name: 'Retained Earnings',                  type: 'Equity',    sub: 'retained' },
      { code: '3003', name: 'General Reserve',                    type: 'Equity',    sub: 'reserve' },
      { code: '3004', name: 'Current Year Profit / (Loss)',       type: 'Equity',    sub: 'retained' },
      // REVENUE
      { code: '4001', name: 'Sales — Finished Goods',             type: 'Revenue',   sub: 'sales' },
      { code: '4002', name: 'Sales — Trading Goods',              type: 'Revenue',   sub: 'sales' },
      { code: '4003', name: 'Service Revenue',                    type: 'Revenue',   sub: 'service' },
      { code: '4004', name: 'Export Sales (0% GST)',              type: 'Revenue',   sub: 'sales' },
      { code: '4005', name: 'Other Income',                       type: 'Revenue',   sub: 'other' },
      { code: '4006', name: 'Interest Income',                    type: 'Revenue',   sub: 'other' },
      // EXPENSES
      { code: '5001', name: 'Cost of Goods Sold — Raw Material',  type: 'Expense',   sub: 'cogs' },
      { code: '5002', name: 'Cost of Goods Sold — Direct Labour', type: 'Expense',   sub: 'cogs' },
      { code: '5003', name: 'Manufacturing Overhead',             type: 'Expense',   sub: 'cogs' },
      { code: '5010', name: 'Salaries & Wages',                   type: 'Expense',   sub: 'staff' },
      { code: '5011', name: 'Employer PF Contribution',           type: 'Expense',   sub: 'staff' },
      { code: '5012', name: 'Employer ESI Contribution',          type: 'Expense',   sub: 'staff' },
      { code: '5013', name: 'Bonus & Incentives',                 type: 'Expense',   sub: 'staff' },
      { code: '5020', name: 'Rent',                               type: 'Expense',   sub: 'operating' },
      { code: '5021', name: 'Electricity & Power',                type: 'Expense',   sub: 'operating' },
      { code: '5022', name: 'Telephone & Internet',               type: 'Expense',   sub: 'operating' },
      { code: '5023', name: 'Office Supplies',                    type: 'Expense',   sub: 'operating' },
      { code: '5024', name: 'Repairs & Maintenance',              type: 'Expense',   sub: 'operating' },
      { code: '5025', name: 'Insurance',                          type: 'Expense',   sub: 'operating' },
      { code: '5026', name: 'Travelling & Conveyance',            type: 'Expense',   sub: 'operating' },
      { code: '5027', name: 'Professional & Legal Fees',          type: 'Expense',   sub: 'operating' },
      { code: '5028', name: 'Audit Fees',                         type: 'Expense',   sub: 'operating' },
      { code: '5030', name: 'Bank Charges',                       type: 'Expense',   sub: 'finance' },
      { code: '5031', name: 'Interest on Loans',                  type: 'Expense',   sub: 'finance' },
      { code: '5040', name: 'Depreciation',                       type: 'Expense',   sub: 'depreciation' },
      { code: '5041', name: 'Income Tax Expense',                 type: 'Expense',   sub: 'tax' },
      { code: '5042', name: 'Marketing & Advertising',            type: 'Expense',   sub: 'operating' },
    ];

    for (const a of accounts) {
      await pool.query(
        `INSERT INTO chart_of_accounts (code, name, account_type, sub_type, company_id, is_active)
         VALUES ($1,$2,$3,$4,$5,true)
         ON CONFLICT DO NOTHING`,
        [a.code, a.name, a.type, a.sub, companyId || null]
      ).catch(() => {});
    }

    return this.findAll(companyId);
  }
}

export default new ChartOfAccountsRepository();
