/**
 * Patch: Fix issues discovered after running migrations 20260613000001-4
 *
 * 1. accounting_periods index — migration 2 tried to index non-existent columns
 *    (fiscal_year, period_number). Correct index uses start_date, end_date.
 *
 * 2. chart_of_accounts — global COA (company_id=NULL, unique on code only).
 *    Migration 4 used ON CONFLICT (company_id, code) which doesn't match the
 *    actual constraint. Seed using ON CONFLICT (code) DO NOTHING instead.
 *
 * 3. Form 16A fix — tds.routes.js now queries `companies` not `company_profiles`
 *    (code fix, no schema change needed).
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT sp');
      console.warn(`[20260613000005] Skipped (${label}): ${e.message}`);
    }
  };

  // Fix 1: accounting_periods — correct index using columns that actually exist
  await safe('idx accounting_periods company start end',
    `CREATE INDEX IF NOT EXISTS idx_accounting_periods_company_dates
     ON accounting_periods (company_id, start_date, end_date)`);

  // Fix 2: chart_of_accounts — seed 7 missing accounts (global COA, company_id=NULL)
  const accounts = [
    ['1031', 'Work In Progress',           'asset',    'current_asset',    'WIP inventory — partially completed production orders'],
    ['1060', 'Advance Tax Paid',           'asset',    'current_asset',    'TDS/advance income tax deposited to government'],
    ['2033', 'Customer Advances',          'liability','current_liability', 'Advances received from customers before invoice'],
    ['2050', 'Deferred Revenue',           'liability','current_liability', 'Revenue received but not yet earned (annual contracts, maintenance)'],
    ['2060', 'GST CESS Payable',           'liability','current_liability', 'CESS component of GST payable to government'],
    ['5060', 'Bad Debts Written Off',      'expense',  'operating_expense', 'Irrecoverable trade receivables written off'],
    ['5070', 'Warranty Provision Expense', 'expense',  'operating_expense', 'Provision for estimated warranty claims on sold products'],
  ];

  for (const [code, name, account_type, sub_type, description] of accounts) {
    await safe(`seed COA ${code}`, `
      INSERT INTO chart_of_accounts (code, name, account_type, sub_type, description, is_active)
      VALUES ('${code}', '${name}', '${account_type}', '${sub_type}', '${description}', true)
      ON CONFLICT (code) DO NOTHING
    `);
  }
}

export async function down(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT sp');
    try { await knex.raw(sql); await knex.raw('RELEASE SAVEPOINT sp'); }
    catch (e) { await knex.raw('ROLLBACK TO SAVEPOINT sp'); console.warn(`[20260613000005 down] ${label}: ${e.message}`); }
  };
  await safe('drop idx dates', `DROP INDEX IF EXISTS idx_accounting_periods_company_dates`);
  await safe('delete seeded accounts',
    `DELETE FROM chart_of_accounts WHERE code IN ('1031','1060','2033','2050','2060','5060','5070') AND company_id IS NULL`);
}
