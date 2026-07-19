/**
 * Migration: Add missing Chart of Accounts entries identified in finance audit
 * - 1031: Work In Progress (WIP)
 * - 1060: Advance Tax Paid
 * - 2033: Customer Advances Received
 * - 2050: Deferred Revenue
 * - 2060: GST CESS Payable
 * - 5060: Bad Debts Written Off
 * - 5070: Warranty Provision Expense
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT sp');
      console.warn(`[20260613000004] Skipped (${label}): ${e.message}`);
    }
  };

  await safe('seed missing COA accounts', `
    INSERT INTO chart_of_accounts
      (company_id, code, name, account_type, sub_type, description, is_active)
    SELECT
      c.id AS company_id,
      acct.code,
      acct.name,
      acct.account_type,
      acct.sub_type,
      acct.description,
      true AS is_active
    FROM companies c
    CROSS JOIN (VALUES
      ('1031', 'Work In Progress',           'asset',    'current_asset',    'WIP inventory — partially completed production orders'),
      ('1060', 'Advance Tax Paid',           'asset',    'current_asset',    'TDS/advance income tax deposited to government'),
      ('2033', 'Customer Advances',          'liability','current_liability', 'Advances received from customers before invoice'),
      ('2050', 'Deferred Revenue',           'liability','current_liability', 'Revenue received but not yet earned (annual contracts, maintenance)'),
      ('2060', 'GST CESS Payable',           'liability','current_liability', 'CESS component of GST payable to government'),
      ('5060', 'Bad Debts Written Off',      'expense',  'operating_expense', 'Irrecoverable trade receivables written off'),
      ('5070', 'Warranty Provision Expense', 'expense',  'operating_expense', 'Provision for estimated warranty claims on sold products')
    ) AS acct(code, name, account_type, sub_type, description)
    ON CONFLICT (company_id, code) DO NOTHING
  `);
}

export async function down(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT sp');
    try { await knex.raw(sql); await knex.raw('RELEASE SAVEPOINT sp'); }
    catch (e) { await knex.raw('ROLLBACK TO SAVEPOINT sp'); console.warn(`[20260613000004 down] ${label}: ${e.message}`); }
  };
  await safe('delete seeded accounts', `
    DELETE FROM chart_of_accounts
    WHERE code IN ('1031','1060','2033','2050','2060','5060','5070')
  `);
}
