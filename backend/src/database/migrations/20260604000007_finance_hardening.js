/**
 * 20260604000007_finance_hardening.js
 *
 * Finance module hardening:
 * 1. Performance indexes on key finance tables
 * 2. Soft-delete columns on expense_claims, tds_deductees, budgets, payment_batches
 * 3. journal_entry_id FK on credit_notes and debit_notes
 * 4. Expand Chart of Accounts with industrial + compliance accounts
 *
 * Uses SAVEPOINT around every statement so individual failures don't abort
 * the PostgreSQL transaction (compatible with the custom migration shim).
 */

export async function up(knex) {

  // Helper: run a single statement inside its own savepoint so one failure
  // doesn't poison the surrounding transaction with 25P02.
  const safe = async (label, sql, params) => {
    await knex.raw('SAVEPOINT safe_sp');
    try {
      await knex.raw(sql, params || []);
      await knex.raw('RELEASE SAVEPOINT safe_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT safe_sp');
      console.warn(`[migration 20260604000007] Skipped (${label}): ${e.message}`);
    }
  };

  // ── 1. Performance Indexes ──────────────────────────────────────────────────
  await safe('idx invoices status',
    `CREATE INDEX IF NOT EXISTS idx_invoices_company_status_due
       ON invoices(company_id, status, due_date) WHERE deleted_at IS NULL`);

  await safe('idx invoices date',
    `CREATE INDEX IF NOT EXISTS idx_invoices_company_date
       ON invoices(company_id, invoice_date) WHERE deleted_at IS NULL`);

  await safe('idx bills status',
    `CREATE INDEX IF NOT EXISTS idx_bills_company_status_due
       ON bills(company_id, status, due_date, approval_status) WHERE deleted_at IS NULL`);

  await safe('idx bills date',
    `CREATE INDEX IF NOT EXISTS idx_bills_company_date
       ON bills(company_id, bill_date) WHERE deleted_at IS NULL`);

  await safe('idx payments date',
    `CREATE INDEX IF NOT EXISTS idx_payments_company_date
       ON payments(company_id, payment_date)`);

  await safe('idx receipts date',
    `CREATE INDEX IF NOT EXISTS idx_receipts_company_date
       ON receipts(company_id, receipt_date)`);

  await safe('idx journal lines account_id',
    `CREATE INDEX IF NOT EXISTS idx_journal_lines_account_id_entry
       ON journal_entry_lines(account_id, journal_entry_id)`);

  await safe('idx parties type',
    `CREATE INDEX IF NOT EXISTS idx_parties_company_type
       ON parties(company_id, party_type) WHERE is_active = true`);

  await safe('idx expense claims status',
    `CREATE INDEX IF NOT EXISTS idx_expense_claims_company_status
       ON expense_claims(company_id, status, claim_date)`);

  await safe('idx bank txn reconciled',
    `CREATE INDEX IF NOT EXISTS idx_bank_txn_account_reconciled
       ON bank_transactions(bank_account_id, reconciled)`);

  await safe('idx pdc status',
    `CREATE INDEX IF NOT EXISTS idx_pdc_company_status_due
       ON pdc_register(company_id, status, due_date) WHERE deleted_at IS NULL`);

  await safe('idx tds transactions fy',
    `CREATE INDEX IF NOT EXISTS idx_tds_transactions_company_fy
       ON tds_transactions(company_id, financial_year, quarter)`);

  // ── 2. Soft-delete columns ──────────────────────────────────────────────────
  for (const table of ['expense_claims', 'tds_deductees', 'budgets', 'payment_batches']) {
    await safe(`deleted_at on ${table}`,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`);
  }

  // ── 3. journal_entry_id FK on credit_notes and debit_notes ─────────────────
  for (const table of ['credit_notes', 'debit_notes']) {
    await safe(`journal_entry_id on ${table}`,
      `ALTER TABLE ${table}
         ADD COLUMN IF NOT EXISTS journal_entry_id INTEGER
           REFERENCES journal_entries(id) ON DELETE SET NULL`);
  }

  // ── 4. Expand Chart of Accounts ────────────────────────────────────────────
  const seedAccount = async (code, name, type, subType, parentCode) => {
    let parentId = null;
    if (parentCode) {
      await knex.raw('SAVEPOINT coa_lookup_sp');
      try {
        const { rows } = await knex.raw(
          `SELECT id FROM chart_of_accounts WHERE code = $1 LIMIT 1`, [parentCode]
        );
        parentId = rows[0]?.id ?? null;
        await knex.raw('RELEASE SAVEPOINT coa_lookup_sp');
      } catch {
        await knex.raw('ROLLBACK TO SAVEPOINT coa_lookup_sp');
      }
    }
    await safe(`coa ${code}`,
      `INSERT INTO chart_of_accounts (code, name, account_type, sub_type, parent_id, is_active, opening_balance)
       VALUES ($1, $2, $3, $4, $5, true, 0)
       ON CONFLICT (code) DO NOTHING`,
      [code, name, type, subType ?? null, parentId]
    );
  };

  // Group / header accounts
  await seedAccount('1000', 'Assets (Group)',                  'Asset',    'group', null);
  await seedAccount('1050', 'Current Assets (Group)',          'Asset',    'group', '1000');
  await seedAccount('1150', 'Fixed Assets (Group)',            'Asset',    'group', '1000');
  await seedAccount('2000', 'Liabilities (Group)',             'Liability','group', null);
  await seedAccount('2050', 'Current Liabilities (Group)',     'Liability','group', '2000');
  await seedAccount('2150', 'Long-term Liabilities (Group)',   'Liability','group', '2000');
  await seedAccount('3000', 'Equity (Group)',                  'Equity',   'group', null);
  await seedAccount('4000', 'Revenue (Group)',                 'Revenue',  'group', null);
  await seedAccount('5000', 'Expenses (Group)',                'Expense',  'group', null);

  // Inventory
  await seedAccount('1033', 'Consumables & Stores',            'Asset',    'current',    '1050');
  await seedAccount('1034', 'Packing Material',                'Asset',    'current',    '1050');

  // CWIP / deposits
  await seedAccount('1060', 'Capital Work in Progress (CWIP)', 'Asset',    'noncurrent', '1150');
  await seedAccount('1061', 'Security Deposits',               'Asset',    'noncurrent', '1150');

  // GST Cess
  await seedAccount('1023', 'CESS Input Credit',               'Asset',    'current',    '1050');
  await seedAccount('2013', 'CESS Payable',                    'Liability','current',    '2050');
  await seedAccount('2014', 'GST RCM Payable',                 'Liability','current',    '2050');

  // Retention money
  await seedAccount('1062', 'Retention Money Receivable',      'Asset',    'current',    '1050');
  await seedAccount('2051', 'Retention Money Payable',         'Liability','current',    '2050');

  // Provisions
  await seedAccount('2052', 'Warranty Provision',              'Liability','current',    '2050');

  // Revenue
  await seedAccount('4007', 'AMC Revenue',                     'Revenue',  'operating',  '4000');
  await seedAccount('4008', 'Warranty Claim Recovery',         'Revenue',  'other',      '4000');
  await seedAccount('4009', 'Installation Revenue',            'Revenue',  'operating',  '4000');
  await seedAccount('4010', 'Foreign Exchange Gain',           'Revenue',  'other',      '4000');
  await seedAccount('4100', 'Gain on Disposal of Asset',       'Revenue',  'other',      '4000');

  // Expenses
  await seedAccount('5004', 'Sub-contractor Charges',          'Expense',  'cogs',       '5000');
  await seedAccount('5005', 'Quality Inspection Cost',         'Expense',  'cogs',       '5000');
  await seedAccount('5050', 'Installation Cost',               'Expense',  'operating',  '5000');
  await seedAccount('5051', 'Commissioning Cost',              'Expense',  'operating',  '5000');
  await seedAccount('5052', 'Warranty Cost',                   'Expense',  'operating',  '5000');
  await seedAccount('5053', 'R&D Expense',                     'Expense',  'operating',  '5000');
  await seedAccount('5054', 'Project Mobilization Cost',       'Expense',  'operating',  '5000');
  await seedAccount('5055', 'Foreign Exchange Loss',           'Expense',  'finance',    '5000');
  await seedAccount('5800', 'Loss on Disposal of Asset',       'Expense',  'other',      '5000');

  console.log('[migration 20260604000007] Finance hardening complete.');
}

export async function down(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT safe_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT safe_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT safe_sp');
      console.warn(`[migration 20260604000007 down] Skipped (${label}): ${e.message}`);
    }
  };

  await safe('drop idx invoices status',        `DROP INDEX IF EXISTS idx_invoices_company_status_due`);
  await safe('drop idx invoices date',          `DROP INDEX IF EXISTS idx_invoices_company_date`);
  await safe('drop idx bills status',           `DROP INDEX IF EXISTS idx_bills_company_status_due`);
  await safe('drop idx bills date',             `DROP INDEX IF EXISTS idx_bills_company_date`);
  await safe('drop idx payments date',          `DROP INDEX IF EXISTS idx_payments_company_date`);
  await safe('drop idx receipts date',          `DROP INDEX IF EXISTS idx_receipts_company_date`);
  await safe('drop idx journal lines',          `DROP INDEX IF EXISTS idx_journal_lines_account_id_entry`);
  await safe('drop idx parties type',           `DROP INDEX IF EXISTS idx_parties_company_type`);
  await safe('drop idx expense claims',         `DROP INDEX IF EXISTS idx_expense_claims_company_status`);
  await safe('drop idx bank txn',               `DROP INDEX IF EXISTS idx_bank_txn_account_reconciled`);
  await safe('drop idx pdc status',             `DROP INDEX IF EXISTS idx_pdc_company_status_due`);
  await safe('drop idx tds transactions',       `DROP INDEX IF EXISTS idx_tds_transactions_company_fy`);
}
