/**
 * Accounting module schema — chart_of_accounts, journal_entries,
 * journal_lines, accounting_periods.
 *
 * Extracted from accounting.routes.js where it ran as fire-and-forget
 * DDL on every server startup (P1-04 fix).
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS chart_of_accounts (
      id                SERIAL PRIMARY KEY,
      account_code      VARCHAR(20)  UNIQUE NOT NULL,
      account_name      VARCHAR(200) NOT NULL,
      account_type      VARCHAR(20)  NOT NULL
                          CHECK (account_type IN ('Asset','Liability','Equity','Revenue','Expense')),
      sub_type          VARCHAR(50),
      parent_account_id INT REFERENCES chart_of_accounts(id),
      is_active         BOOLEAN          DEFAULT true,
      opening_balance   NUMERIC(15,2)    DEFAULT 0,
      normal_balance    VARCHAR(10)      DEFAULT 'debit',
      created_at        TIMESTAMPTZ      DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id              SERIAL PRIMARY KEY,
      entry_number    VARCHAR(30)  UNIQUE NOT NULL,
      entry_date      DATE         NOT NULL,
      description     TEXT,
      reference_type  VARCHAR(50),
      reference_id    INT,
      status          VARCHAR(20)  DEFAULT 'draft'
                        CHECK (status IN ('draft','posted','reversed')),
      created_by      INT,
      posted_at       TIMESTAMPTZ,
      reversal_of_id  INT REFERENCES journal_entries(id),
      total_debit     NUMERIC(15,2),
      total_credit    NUMERIC(15,2),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS journal_lines (
      id           SERIAL PRIMARY KEY,
      entry_id     INT  NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id   INT  REFERENCES chart_of_accounts(id),
      account_code VARCHAR(20),
      account_name VARCHAR(200),
      debit        NUMERIC(15,2) DEFAULT 0,
      credit       NUMERIC(15,2) DEFAULT 0,
      narration    TEXT,
      cost_centre  VARCHAR(100),
      project_id   INT
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS accounting_periods (
      id             SERIAL PRIMARY KEY,
      name           VARCHAR(100) NOT NULL,
      start_date     DATE         NOT NULL,
      end_date       DATE         NOT NULL,
      status         VARCHAR(20)  DEFAULT 'open'
                       CHECK (status IN ('open','closed','locked')),
      closed_by      INT,
      closed_at      TIMESTAMPTZ,
      period_summary JSONB,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed chart of accounts (idempotent via ON CONFLICT DO NOTHING)
  await knex.raw(`
    INSERT INTO chart_of_accounts
      (account_code, account_name, account_type)
    VALUES
      ('1001','Cash & Bank',                'Asset'),
      ('1002','Accounts Receivable',        'Asset'),
      ('1003','Inventory',                  'Asset'),
      ('1004','Prepaid Expenses',           'Asset'),
      ('1100','Fixed Assets - Equipment',   'Asset'),
      ('1101','Accumulated Depreciation',   'Asset'),
      ('2001','Accounts Payable',           'Liability'),
      ('2002','GST Payable',                'Liability'),
      ('2003','TDS Payable',                'Liability'),
      ('2100','Long-term Loans',            'Liability'),
      ('3001','Share Capital',              'Equity'),
      ('3002','Retained Earnings',          'Equity'),
      ('4001','Sales Revenue',              'Revenue'),
      ('4002','Service Revenue',            'Revenue'),
      ('4003','Other Income',               'Revenue'),
      ('5001','Cost of Goods Sold',         'Expense'),
      ('5002','Salaries Expense',           'Expense'),
      ('5003','Rent Expense',               'Expense'),
      ('5004','Marketing Expense',          'Expense'),
      ('5005','Depreciation Expense',       'Expense')
    ON CONFLICT (account_code) DO NOTHING
  `);

  // Seed default accounting periods (Indian FY Apr–Mar)
  const currentYear = new Date().getMonth() >= 3
    ? new Date().getFullYear()
    : new Date().getFullYear() - 1;

  await knex.raw(`
    INSERT INTO accounting_periods (name, start_date, end_date, status)
    VALUES
      ($1, $2, $3, 'open'),
      ($4, $5, $6, 'closed')
    ON CONFLICT DO NOTHING
  `, [
    `Apr ${currentYear} - Mar ${currentYear + 1}`,
    `${currentYear}-04-01`,
    `${currentYear + 1}-03-31`,
    `Apr ${currentYear - 1} - Mar ${currentYear}`,
    `${currentYear - 1}-04-01`,
    `${currentYear}-03-31`,
  ]);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS journal_lines CASCADE');
  await knex.raw('DROP TABLE IF EXISTS journal_entries CASCADE');
  await knex.raw('DROP TABLE IF EXISTS chart_of_accounts CASCADE');
  await knex.raw('DROP TABLE IF EXISTS accounting_periods CASCADE');
}
