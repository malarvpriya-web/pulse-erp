/**
 * chartOfAccounts.js — seed standard Indian SME Chart of Accounts.
 *
 * Usage (standalone):
 *   node -e "import('./src/seeds/chartOfAccounts.js').then(m=>m.seedChartOfAccounts())"
 *
 * Usage (from code):
 *   import { seedChartOfAccounts } from './seeds/chartOfAccounts.js';
 *   await seedChartOfAccounts(pool);
 *
 * Strategy: global rows (company_id = NULL) are visible to every tenant via
 *   WHERE company_id = $cid OR company_id IS NULL
 * The UNIQUE constraint is on `code` alone, so one global set covers all companies.
 * If a company needs custom overrides they insert company-scoped rows with the same
 * code — the finance queries return both and the frontend merges by code.
 *
 * Safe to re-run: ON CONFLICT (code) DO NOTHING.
 */

import pool from '../config/db.js';

const ACCOUNTS = [
  // ASSETS — Cash & Bank (1000s)
  { code: '1000', name: 'Cash in Hand',                   type: 'Asset',     sub: 'cash'            },
  { code: '1001', name: 'Petty Cash',                     type: 'Asset',     sub: 'cash'            },
  { code: '1002', name: 'Bank — Current Account',         type: 'Asset',     sub: 'bank'            },
  { code: '1003', name: 'Bank — Savings Account',         type: 'Asset',     sub: 'bank'            },

  // ASSETS — Receivables
  { code: '1010', name: 'Accounts Receivable',            type: 'Asset',     sub: 'receivable'      },
  { code: '1011', name: 'TDS Receivable',                 type: 'Asset',     sub: 'receivable'      },
  { code: '1012', name: 'Advance to Suppliers',           type: 'Asset',     sub: 'advance'         },
  { code: '1013', name: 'Employee Advances',              type: 'Asset',     sub: 'advance'         },
  { code: '1014', name: 'Security Deposits Paid',         type: 'Asset',     sub: 'deposit'         },

  // ASSETS — GST Input Tax Credit
  { code: '1020', name: 'Input CGST Receivable',          type: 'Asset',     sub: 'gst_itc'         },
  { code: '1021', name: 'Input SGST Receivable',          type: 'Asset',     sub: 'gst_itc'         },
  { code: '1022', name: 'Input IGST Receivable',          type: 'Asset',     sub: 'gst_itc'         },

  // ASSETS — Inventory
  { code: '1030', name: 'Raw Material Inventory',         type: 'Asset',     sub: 'inventory'       },
  { code: '1031', name: 'Work-in-Progress (WIP)',         type: 'Asset',     sub: 'inventory'       },
  { code: '1032', name: 'Finished Goods Inventory',       type: 'Asset',     sub: 'inventory'       },
  { code: '1033', name: 'Stores & Spares Inventory',      type: 'Asset',     sub: 'inventory'       },

  // ASSETS — Prepaid & Other Current
  { code: '1040', name: 'Prepaid Expenses',               type: 'Asset',     sub: 'prepaid'         },
  { code: '1041', name: 'Advance Tax Paid',               type: 'Asset',     sub: 'tax'             },

  // ASSETS — Fixed Assets
  { code: '1100', name: 'Fixed Assets (Gross)',           type: 'Asset',     sub: 'fixed_asset'     },
  { code: '1101', name: 'Fixed Assets — Plant & Machinery', type: 'Asset',  sub: 'fixed_asset'     },
  { code: '1102', name: 'Fixed Assets — Computers & IT', type: 'Asset',     sub: 'fixed_asset'     },
  { code: '1103', name: 'Fixed Assets — Vehicles',       type: 'Asset',     sub: 'fixed_asset'     },
  { code: '1110', name: 'Accumulated Depreciation',       type: 'Asset',     sub: 'contra_asset'    },
  { code: '1111', name: 'Accumulated Depreciation — P&M', type: 'Asset',    sub: 'contra_asset'    },
  { code: '1112', name: 'Accumulated Depreciation — Computers', type: 'Asset', sub: 'contra_asset' },
  { code: '1113', name: 'Accumulated Depreciation — Vehicles',  type: 'Asset', sub: 'contra_asset' },
  { code: '1900', name: 'Capital Work in Progress',       type: 'Asset',     sub: 'fixed_asset'     },

  // LIABILITIES — Current (2000s)
  { code: '2000', name: 'Accounts Payable',               type: 'Liability', sub: 'payable'         },
  { code: '2001', name: 'Salary Payable',                 type: 'Liability', sub: 'accrual'         },
  { code: '2002', name: 'Advance from Customers',         type: 'Liability', sub: 'advance'         },

  // LIABILITIES — GST Payable
  { code: '2010', name: 'CGST Payable',                   type: 'Liability', sub: 'gst_payable'     },
  { code: '2011', name: 'SGST Payable',                   type: 'Liability', sub: 'gst_payable'     },
  { code: '2012', name: 'IGST Payable',                   type: 'Liability', sub: 'gst_payable'     },

  // LIABILITIES — TDS
  { code: '2020', name: 'TDS Payable — 194C (Contractor)', type: 'Liability', sub: 'tds_payable'   },
  { code: '2021', name: 'TDS Payable — 194J (Professional)', type: 'Liability', sub: 'tds_payable' },
  { code: '2022', name: 'TDS Payable — 194I (Rent)',      type: 'Liability', sub: 'tds_payable'     },

  // LIABILITIES — Statutory
  { code: '2030', name: 'PF Payable (Employer + Employee)', type: 'Liability', sub: 'statutory'    },
  { code: '2031', name: 'ESI Payable (Employer + Employee)', type: 'Liability', sub: 'statutory'   },
  { code: '2032', name: 'Professional Tax Payable',       type: 'Liability', sub: 'statutory'       },

  // LIABILITIES — Accruals
  { code: '2040', name: 'Salary & Wages Payable',         type: 'Liability', sub: 'accrual'         },
  { code: '2041', name: 'Audit Fee Payable',              type: 'Liability', sub: 'accrual'         },

  // LIABILITIES — Long-term
  { code: '2500', name: 'Long-Term Loans',                type: 'Liability', sub: 'loan'            },
  { code: '2501', name: 'Term Loans (Banks)',             type: 'Liability', sub: 'loan'            },
  { code: '2502', name: 'Vehicle Loans',                  type: 'Liability', sub: 'loan'            },

  // EQUITY (3000s)
  { code: '3000', name: 'Share Capital',                  type: 'Equity',    sub: 'capital'         },
  { code: '3001', name: 'Share Capital — Equity',         type: 'Equity',    sub: 'capital'         },
  { code: '3100', name: 'Retained Earnings',              type: 'Equity',    sub: 'retained'        },
  { code: '3200', name: 'Opening Balance Equity',         type: 'Equity',    sub: 'equity'          },
  { code: '3300', name: 'Forex Gain / Loss',              type: 'Equity',    sub: 'equity'          },

  // REVENUE (4000s)
  { code: '4000', name: 'Product Sales',                  type: 'Revenue',   sub: 'sales'           },
  { code: '4001', name: 'Sales — Finished Goods',         type: 'Revenue',   sub: 'sales'           },
  { code: '4002', name: 'Sales — Trading Goods',          type: 'Revenue',   sub: 'sales'           },
  { code: '4003', name: 'Service Revenue',                type: 'Revenue',   sub: 'service'         },
  { code: '4004', name: 'Export Sales (0% GST)',          type: 'Revenue',   sub: 'sales'           },
  { code: '4005', name: 'Other Income',                   type: 'Revenue',   sub: 'other'           },
  { code: '4100', name: 'Interest Income',                type: 'Revenue',   sub: 'other'           },

  // EXPENSES — Direct / COGS (5000s)
  { code: '5000', name: 'Salaries & Wages',               type: 'Expense',   sub: 'staff'           },
  { code: '5001', name: 'PF Contribution (Employer)',     type: 'Expense',   sub: 'staff'           },
  { code: '5002', name: 'ESI Contribution (Employer)',    type: 'Expense',   sub: 'staff'           },
  { code: '5010', name: 'Salaries & Wages (Staff)',       type: 'Expense',   sub: 'staff'           },
  { code: '5011', name: 'Employer PF Contribution',       type: 'Expense',   sub: 'staff'           },
  { code: '5012', name: 'Employer ESI Contribution',      type: 'Expense',   sub: 'staff'           },
  { code: '5100', name: 'Raw Materials / COGS',           type: 'Expense',   sub: 'cogs'            },
  { code: '5101', name: 'COGS — Raw Material',            type: 'Expense',   sub: 'cogs'            },
  { code: '5102', name: 'COGS — Direct Labour',           type: 'Expense',   sub: 'cogs'            },
  { code: '5103', name: 'COGS — Manufacturing Overhead',  type: 'Expense',   sub: 'cogs'            },

  // EXPENSES — Operating
  { code: '5200', name: 'Rent & Utilities',               type: 'Expense',   sub: 'operating'       },
  { code: '5201', name: 'Electricity & Power',            type: 'Expense',   sub: 'operating'       },
  { code: '5202', name: 'Telephone & Internet',           type: 'Expense',   sub: 'operating'       },
  { code: '5203', name: 'Office Supplies',                type: 'Expense',   sub: 'operating'       },
  { code: '5300', name: 'Marketing & Advertising',        type: 'Expense',   sub: 'operating'       },
  { code: '5400', name: 'Travel & Conveyance',            type: 'Expense',   sub: 'operating'       },
  { code: '5401', name: 'Travelling & Conveyance (Staff)', type: 'Expense',  sub: 'operating'       },
  { code: '5500', name: 'IT & Software',                  type: 'Expense',   sub: 'operating'       },
  { code: '5501', name: 'Professional & Legal Fees',      type: 'Expense',   sub: 'operating'       },
  { code: '5502', name: 'Repairs & Maintenance',          type: 'Expense',   sub: 'operating'       },
  { code: '5503', name: 'Insurance',                      type: 'Expense',   sub: 'operating'       },
  { code: '5504', name: 'Audit Fees',                     type: 'Expense',   sub: 'operating'       },

  // EXPENSES — Finance
  { code: '5600', name: 'Depreciation',                   type: 'Expense',   sub: 'depreciation'    },
  { code: '5700', name: 'Interest Expense',               type: 'Expense',   sub: 'finance'         },
  { code: '5800', name: 'Bank Charges',                   type: 'Expense',   sub: 'finance'         },
  { code: '5801', name: 'Late Payment Charges',           type: 'Expense',   sub: 'finance'         },

  // EXPENSES — Tax & Bad Debt
  { code: '5900', name: 'Bad Debt Expense',               type: 'Expense',   sub: 'operating'       },
  { code: '5950', name: 'Income Tax Provision',           type: 'Expense',   sub: 'tax'             },
  { code: '5951', name: 'Income Tax Expense',             type: 'Expense',   sub: 'tax'             },
];

export async function seedChartOfAccounts(db = pool) {
  // Check if global accounts already seeded
  const { rows: existing } = await db.query(
    `SELECT COUNT(*) AS n FROM chart_of_accounts WHERE company_id IS NULL`
  );
  const existingCount = parseInt(existing[0]?.n ?? 0);

  let inserted = 0;
  let skipped  = 0;

  for (const { code, name, type, sub } of ACCOUNTS) {
    try {
      const { rowCount } = await db.query(
        `INSERT INTO chart_of_accounts (code, name, account_type, sub_type, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (code) DO NOTHING`,
        [code, name, type, sub]
      );
      if (rowCount > 0) inserted++;
      else skipped++;
    } catch (err) {
      console.warn(`[CoA seed] skipped ${code} — ${err.message.split('\n')[0]}`);
      skipped++;
    }
  }

  console.log(`[CoA seed] Done — inserted ${inserted}, skipped ${skipped} (${existingCount} already existed).`);
  return { inserted, skipped };
}

// Standalone run
if (process.argv[1] && process.argv[1].endsWith('chartOfAccounts.js')) {
  seedChartOfAccounts()
    .then(({ inserted }) => {
      console.log(`[CoA seed] Complete. ${inserted} new accounts inserted.`);
      process.exit(0);
    })
    .catch(err => {
      console.error('[CoA seed] Fatal:', err);
      process.exit(1);
    });
}

export default seedChartOfAccounts;
