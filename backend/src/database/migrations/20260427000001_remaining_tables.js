/**
 * 20260427000001_remaining_tables.js
 * Adds stock_ledger (missing from tracked migrations) and fills gaps
 * left after the 20260426000001 module_tables run.
 */
export async function up(knex) {
  // ── stock_ledger (referenced by stockLedger.repository.js) ─────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS stock_ledger (
      id               SERIAL PRIMARY KEY,
      item_id          INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
      warehouse_id     INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      transaction_type VARCHAR(50) NOT NULL,
      quantity_in      NUMERIC(12,4) DEFAULT 0,
      quantity_out     NUMERIC(12,4) DEFAULT 0,
      balance_qty      NUMERIC(12,4) DEFAULT 0,
      rate             NUMERIC(12,2) DEFAULT 0,
      value            NUMERIC(14,2) DEFAULT 0,
      reference_type   VARCHAR(50),
      reference_id     INTEGER,
      transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
      remarks          TEXT,
      created_by       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Add month/year/employee columns to payroll_runs so service queries work ─
  await knex.raw(`
    ALTER TABLE payroll_runs
      ADD COLUMN IF NOT EXISTS month         INTEGER,
      ADD COLUMN IF NOT EXISTS year          INTEGER,
      ADD COLUMN IF NOT EXISTS employee_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS gross         NUMERIC(14,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS net_pay       NUMERIC(14,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_deductions NUMERIC(14,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS employee_pf   NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS employer_pf   NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS employee_esi  NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS employer_esi  NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tds           NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS professional_tax NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS ctc_monthly   NUMERIC(14,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS payment_mode  VARCHAR(50),
      ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(200),
      ADD COLUMN IF NOT EXISTS generated_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS tax_regime    VARCHAR(20),
      ADD COLUMN IF NOT EXISTS annual_taxable_income NUMERIC(14,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS annual_tax    NUMERIC(14,2) DEFAULT 0
  `);

  // ── pdc_register (finance extended routes) ──────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS pdc_register (
      id                SERIAL PRIMARY KEY,
      cheque_type       VARCHAR(20) NOT NULL CHECK (cheque_type IN ('receivable','payable')),
      cheque_number     VARCHAR(50),
      cheque_date       DATE NOT NULL,
      amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
      party_id          UUID REFERENCES parties(id) ON DELETE SET NULL,
      bank_account_id   INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,
      reference_type    VARCHAR(50),
      reference_id      INTEGER,
      status            VARCHAR(20) DEFAULT 'pending',
      cleared_date      DATE,
      bounce_reason     TEXT,
      bounce_charges    NUMERIC(10,2) DEFAULT 0,
      notes             TEXT,
      deleted_at        TIMESTAMP,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── expense_categories (finance extended routes) ────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(200) NOT NULL,
      description TEXT,
      is_active   BOOLEAN DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── expense_claims / expense_claim_items (analytics routes) ─────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS expense_claims (
      id                SERIAL PRIMARY KEY,
      employee_id       INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      claim_number      VARCHAR(50) UNIQUE,
      claim_date        DATE DEFAULT CURRENT_DATE,
      total_amount      NUMERIC(14,2) DEFAULT 0,
      status            VARCHAR(20) DEFAULT 'pending',
      notes             TEXT,
      deleted_at        TIMESTAMP,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS expense_claim_items (
      id                SERIAL PRIMARY KEY,
      expense_claim_id  INTEGER REFERENCES expense_claims(id) ON DELETE CASCADE,
      category_id       INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
      description       TEXT,
      amount            NUMERIC(12,2) DEFAULT 0,
      gst_amount        NUMERIC(10,2) DEFAULT 0,
      is_gst_claimable  BOOLEAN DEFAULT false,
      bill_status       VARCHAR(20) DEFAULT 'with_bill',
      bill_number       VARCHAR(100),
      receipt_url       TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── budgets (finance extended routes) ───────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS budgets (
      id            SERIAL PRIMARY KEY,
      budget_name   VARCHAR(300) NOT NULL,
      fiscal_year   VARCHAR(10),
      account_id    INTEGER REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
      period_type   VARCHAR(20) DEFAULT 'monthly',
      jan_amount    NUMERIC(14,2) DEFAULT 0,
      feb_amount    NUMERIC(14,2) DEFAULT 0,
      mar_amount    NUMERIC(14,2) DEFAULT 0,
      apr_amount    NUMERIC(14,2) DEFAULT 0,
      may_amount    NUMERIC(14,2) DEFAULT 0,
      jun_amount    NUMERIC(14,2) DEFAULT 0,
      jul_amount    NUMERIC(14,2) DEFAULT 0,
      aug_amount    NUMERIC(14,2) DEFAULT 0,
      sep_amount    NUMERIC(14,2) DEFAULT 0,
      oct_amount    NUMERIC(14,2) DEFAULT 0,
      nov_amount    NUMERIC(14,2) DEFAULT 0,
      dec_amount    NUMERIC(14,2) DEFAULT 0,
      total_amount  NUMERIC(14,2) DEFAULT 0,
      notes         TEXT,
      deleted_at    TIMESTAMP,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── ticket_categories + sla_policies (finance ticketing routes) ─────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ticket_categories (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(200) NOT NULL,
      description TEXT,
      is_active   BOOLEAN DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sla_policies (
      id                    SERIAL PRIMARY KEY,
      name                  VARCHAR(200) NOT NULL,
      priority              VARCHAR(20) DEFAULT 'normal',
      response_time_hours   INTEGER DEFAULT 4,
      resolution_time_hours INTEGER DEFAULT 24,
      is_active             BOOLEAN DEFAULT true,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id              SERIAL PRIMARY KEY,
      ticket_number   VARCHAR(50) UNIQUE,
      title           VARCHAR(300) NOT NULL,
      description     TEXT,
      category_id     INTEGER REFERENCES ticket_categories(id) ON DELETE SET NULL,
      priority        VARCHAR(20) DEFAULT 'normal',
      status          VARCHAR(20) DEFAULT 'open',
      assigned_to     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      sla_policy_id   INTEGER REFERENCES sla_policies(id) ON DELETE SET NULL,
      due_date        DATE,
      resolved_at     TIMESTAMPTZ,
      deleted_at      TIMESTAMP,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticket_conversations (
      id          SERIAL PRIMARY KEY,
      ticket_id   INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
      message     TEXT NOT NULL,
      is_internal BOOLEAN DEFAULT false,
      created_by  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── local_purchase_requests (procurement) ───────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS local_purchase_requests (
      id                          SERIAL PRIMARY KEY,
      request_number              VARCHAR(50) UNIQUE,
      requested_by_employee_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      request_date                DATE DEFAULT CURRENT_DATE,
      description                 TEXT,
      vendor_name_text            VARCHAR(300),
      amount                      NUMERIC(12,2) DEFAULT 0,
      bill_status                 VARCHAR(20) DEFAULT 'pending',
      status                      VARCHAR(20) DEFAULT 'pending',
      notes                       TEXT,
      deleted_at                  TIMESTAMP,
      created_at                  TIMESTAMPTZ DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── document_signings ────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS document_signings (
      id                SERIAL PRIMARY KEY,
      title             VARCHAR(300) NOT NULL,
      doc_type          VARCHAR(100) NOT NULL DEFAULT 'Other',
      recipient_name    VARCHAR(200) NOT NULL,
      recipient_email   VARCHAR(200) NOT NULL,
      message           TEXT,
      status            VARCHAR(30)  NOT NULL DEFAULT 'sent',
      sent_date         DATE NOT NULL DEFAULT CURRENT_DATE,
      signed_date       DATE,
      expiry_date       DATE,
      sign_token        VARCHAR(64) UNIQUE,
      declined_reason   TEXT,
      created_by        INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── price_history ─────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS price_history (
      id              SERIAL PRIMARY KEY,
      item_id         INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
      item_name_text  VARCHAR(300),
      vendor_id       INTEGER,
      vendor_name_text VARCHAR(300),
      unit_price      NUMERIC(14,4) NOT NULL,
      quantity        NUMERIC(12,2),
      currency        VARCHAR(10) DEFAULT 'INR',
      price_type      VARCHAR(30) DEFAULT 'purchase',
      reference_type  VARCHAR(30),
      reference_id    INTEGER,
      reference_number VARCHAR(100),
      price_date      DATE NOT NULL DEFAULT CURRENT_DATE,
      notes           TEXT,
      created_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_price_history_item ON price_history(item_id, price_date DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_price_history_vendor ON price_history(vendor_id, price_date DESC)`);
}

export async function down(knex) {
  // Intentionally empty
}
