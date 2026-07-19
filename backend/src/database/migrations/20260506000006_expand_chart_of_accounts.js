/**
 * 20260506000006_expand_chart_of_accounts.js
 *
 * Compliance fix — adds mandatory Indian statutory ledger accounts.
 *
 * Previous seeded CoA had only 20 generic accounts.  A CA audit requires
 * separate ledgers for each GST head, ITC receivable, TDS receivable,
 * statutory payables (PF/ESI/PT), inventory sub-types, and advance accounts.
 *
 * All inserts use ON CONFLICT DO NOTHING so re-running is safe.
 */

export async function up(knex) {

  // Ensure sub_type column exists (used by cash flow query)
  await knex.raw(`
    ALTER TABLE chart_of_accounts
      ADD COLUMN IF NOT EXISTS sub_type VARCHAR(50)
  `);

  await knex.raw(`
    INSERT INTO chart_of_accounts (account_code, account_name, account_type, sub_type)
    VALUES
      -- ── ASSETS: Cash & Bank ─────────────────────────────────────────────────
      ('1001','Cash in Hand',                         'Asset',     'cash'),
      ('1002','Bank — Current Account',               'Asset',     'bank'),
      ('1003','Bank — Savings Account',               'Asset',     'bank'),

      -- ── ASSETS: Receivables ─────────────────────────────────────────────────
      ('1010','Accounts Receivable',                  'Asset',     'receivable'),
      ('1011','TDS Receivable (Deducted by Customers)','Asset',    'receivable'),
      ('1012','Advance to Suppliers',                 'Asset',     'advance'),
      ('1013','Employee Advances',                    'Asset',     'advance'),
      ('1014','Security Deposits Paid',               'Asset',     'deposit'),

      -- ── ASSETS: GST Input Tax Credit ────────────────────────────────────────
      ('1020','Input CGST Receivable',                'Asset',     'gst_itc'),
      ('1021','Input SGST Receivable',                'Asset',     'gst_itc'),
      ('1022','Input IGST Receivable',                'Asset',     'gst_itc'),
      ('1023','Input CESS Receivable',                'Asset',     'gst_itc'),

      -- ── ASSETS: Inventory ───────────────────────────────────────────────────
      ('1030','Raw Material Inventory',               'Asset',     'inventory'),
      ('1031','Work-in-Progress (WIP)',               'Asset',     'inventory'),
      ('1032','Finished Goods Inventory',             'Asset',     'inventory'),
      ('1033','Packing Material Inventory',           'Asset',     'inventory'),
      ('1034','Stores & Spares Inventory',            'Asset',     'inventory'),

      -- ── ASSETS: Prepaid & Other Current ─────────────────────────────────────
      ('1040','Prepaid Expenses',                     'Asset',     'prepaid'),
      ('1041','Advance Tax Paid',                     'Asset',     'tax'),
      ('1042','Self-Assessment Tax Paid',             'Asset',     'tax'),

      -- ── ASSETS: Fixed Assets ────────────────────────────────────────────────
      ('1100','Fixed Assets — Plant & Machinery',     'Asset',     'fixed_asset'),
      ('1101','Fixed Assets — Furniture & Fixtures',  'Asset',     'fixed_asset'),
      ('1102','Fixed Assets — Computers & IT',        'Asset',     'fixed_asset'),
      ('1103','Fixed Assets — Vehicles',              'Asset',     'fixed_asset'),
      ('1104','Fixed Assets — Land & Building',       'Asset',     'fixed_asset'),
      ('1110','Accumulated Depreciation — P&M',       'Asset',     'contra_asset'),
      ('1111','Accumulated Depreciation — Furniture', 'Asset',     'contra_asset'),
      ('1112','Accumulated Depreciation — Computers', 'Asset',     'contra_asset'),
      ('1113','Accumulated Depreciation — Vehicles',  'Asset',     'contra_asset'),
      ('1114','Accumulated Depreciation — Buildings', 'Asset',     'contra_asset'),

      -- ── LIABILITIES: Current ────────────────────────────────────────────────
      ('2001','Accounts Payable',                     'Liability', 'payable'),
      ('2002','Advance from Customers',               'Liability', 'advance'),
      ('2003','Security Deposits Received',           'Liability', 'deposit'),

      -- ── LIABILITIES: GST Payable ────────────────────────────────────────────
      ('2010','CGST Payable',                         'Liability', 'gst_payable'),
      ('2011','SGST Payable',                         'Liability', 'gst_payable'),
      ('2012','IGST Payable',                         'Liability', 'gst_payable'),
      ('2013','CESS Payable',                         'Liability', 'gst_payable'),

      -- ── LIABILITIES: TDS ────────────────────────────────────────────────────
      ('2020','TDS Payable — 194C (Contractor)',       'Liability', 'tds_payable'),
      ('2021','TDS Payable — 194J (Professional)',     'Liability', 'tds_payable'),
      ('2022','TDS Payable — 194I (Rent)',             'Liability', 'tds_payable'),
      ('2023','TDS Payable — 194Q (Goods)',            'Liability', 'tds_payable'),
      ('2024','TDS Payable — Others',                  'Liability', 'tds_payable'),

      -- ── LIABILITIES: Statutory Payables ─────────────────────────────────────
      ('2030','PF Payable (Employer + Employee)',      'Liability', 'statutory'),
      ('2031','ESI Payable (Employer + Employee)',     'Liability', 'statutory'),
      ('2032','Professional Tax Payable',              'Liability', 'statutory'),
      ('2033','Labour Welfare Fund Payable',           'Liability', 'statutory'),

      -- ── LIABILITIES: Accruals & Others ──────────────────────────────────────
      ('2040','Salary & Wages Payable',               'Liability', 'accrual'),
      ('2041','Audit Fee Payable',                    'Liability', 'accrual'),
      ('2042','Electricity Charges Payable',          'Liability', 'accrual'),

      -- ── LIABILITIES: Long-term ──────────────────────────────────────────────
      ('2100','Term Loans (Banks)',                   'Liability', 'loan'),
      ('2101','Vehicle Loans',                        'Liability', 'loan'),
      ('2102','Director Loans',                       'Liability', 'loan'),

      -- ── EQUITY ──────────────────────────────────────────────────────────────
      ('3001','Share Capital — Equity',               'Equity',    'capital'),
      ('3002','Retained Earnings',                    'Equity',    'retained'),
      ('3003','General Reserve',                      'Equity',    'reserve'),
      ('3004','Current Year Profit / (Loss)',         'Equity',    'retained'),

      -- ── REVENUE ─────────────────────────────────────────────────────────────
      ('4001','Sales — Finished Goods',               'Revenue',   'sales'),
      ('4002','Sales — Trading Goods',                'Revenue',   'sales'),
      ('4003','Service Revenue',                      'Revenue',   'service'),
      ('4004','Export Sales (0% GST)',                'Revenue',   'sales'),
      ('4005','Other Income',                         'Revenue',   'other'),
      ('4006','Interest Income',                      'Revenue',   'other'),
      ('4007','Scrap / Waste Sales',                  'Revenue',   'sales'),

      -- ── EXPENSES: Direct ────────────────────────────────────────────────────
      ('5001','Cost of Goods Sold — Raw Material',    'Expense',   'cogs'),
      ('5002','Cost of Goods Sold — Direct Labour',   'Expense',   'cogs'),
      ('5003','Cost of Goods Sold — Manufacturing OH','Expense',   'cogs'),

      -- ── EXPENSES: Staff ─────────────────────────────────────────────────────
      ('5010','Salaries & Wages',                     'Expense',   'staff'),
      ('5011','Employer PF Contribution',             'Expense',   'staff'),
      ('5012','Employer ESI Contribution',            'Expense',   'staff'),
      ('5013','Bonus & Incentives',                   'Expense',   'staff'),
      ('5014','Staff Welfare',                        'Expense',   'staff'),

      -- ── EXPENSES: Operating ─────────────────────────────────────────────────
      ('5020','Rent',                                 'Expense',   'operating'),
      ('5021','Electricity & Power',                  'Expense',   'operating'),
      ('5022','Telephone & Internet',                 'Expense',   'operating'),
      ('5023','Office Supplies',                      'Expense',   'operating'),
      ('5024','Repairs & Maintenance',                'Expense',   'operating'),
      ('5025','Insurance',                            'Expense',   'operating'),
      ('5026','Travelling & Conveyance',              'Expense',   'operating'),
      ('5027','Professional & Legal Fees',            'Expense',   'operating'),
      ('5028','Audit Fees',                           'Expense',   'operating'),

      -- ── EXPENSES: Finance ───────────────────────────────────────────────────
      ('5030','Bank Charges',                         'Expense',   'finance'),
      ('5031','Interest on Loans',                    'Expense',   'finance'),
      ('5032','Late Payment Charges',                 'Expense',   'finance'),

      -- ── EXPENSES: Tax & Depreciation ────────────────────────────────────────
      ('5040','Depreciation',                         'Expense',   'depreciation'),
      ('5041','Income Tax Expense',                   'Expense',   'tax'),
      ('5042','Marketing & Advertising',              'Expense',   'operating')
    ON CONFLICT (account_code) DO NOTHING
  `);
}

export async function down(knex) {
  // Intentionally left empty — removing accounts that may have transactions is unsafe
}
