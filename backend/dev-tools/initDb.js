import pool from './src/config/db.js';

async function initDb() {
  console.log('🛠️  Initialising database tables...');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── uuid extension ────────────────────────────────────────────────
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ── users ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(255),
        email         VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        role          VARCHAR(50)  DEFAULT 'employee',
        department    VARCHAR(100),
        is_active     BOOLEAN      DEFAULT true,
        created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── employees ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id               SERIAL PRIMARY KEY,
        name             VARCHAR(255),
        first_name       VARCHAR(100),
        last_name        VARCHAR(100),
        company_email    VARCHAR(255) UNIQUE,
        department       VARCHAR(100),
        designation      VARCHAR(100),
        joining_date     DATE,
        employment_type  VARCHAR(50),
        status           VARCHAR(20)  DEFAULT 'Active',
        created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── leaves ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS leaves (
        id             SERIAL PRIMARY KEY,
        employee_id    INTEGER REFERENCES employees(id) ON DELETE CASCADE,
        leave_type     VARCHAR(50),
        start_date     DATE,
        end_date       DATE,
        days           DECIMAL(4,1)  DEFAULT 1,
        status         VARCHAR(20)   DEFAULT 'pending',
        reason         TEXT,
        manager_comment TEXT,
        created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── chart of accounts ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS chart_of_accounts (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        code         VARCHAR(20)  UNIQUE NOT NULL,
        name         VARCHAR(255) NOT NULL,
        account_type VARCHAR(50)  NOT NULL,
        parent_id    UUID         REFERENCES chart_of_accounts(id),
        is_active    BOOLEAN      DEFAULT true,
        description  TEXT,
        created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        deleted_at   TIMESTAMP
      )
    `);

    // ── parties (customers / suppliers) ───────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS parties (
        id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        party_code     VARCHAR(20)  UNIQUE NOT NULL,
        party_type     VARCHAR(20)  NOT NULL,
        name           VARCHAR(255) NOT NULL,
        contact_person VARCHAR(255),
        email          VARCHAR(255),
        phone          VARCHAR(50),
        address        TEXT,
        tax_id         VARCHAR(50),
        credit_limit   DECIMAL(15,2) DEFAULT 0,
        payment_terms  INTEGER       DEFAULT 30,
        is_active      BOOLEAN       DEFAULT true,
        created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        deleted_at     TIMESTAMP
      )
    `);

    // ── financial periods ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS financial_periods (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        period_name VARCHAR(50)  NOT NULL,
        start_date  DATE         NOT NULL,
        end_date    DATE         NOT NULL,
        is_locked   BOOLEAN      DEFAULT false,
        status      VARCHAR(20)  DEFAULT 'Open',
        closed_by   VARCHAR(255),
        closed_date TIMESTAMP,
        created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── journal entries ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        entry_number   VARCHAR(50)  UNIQUE NOT NULL,
        entry_date     DATE         NOT NULL,
        entry_type     VARCHAR(50)  NOT NULL,
        reference_type VARCHAR(50),
        reference_id   VARCHAR(100),
        description    TEXT,
        total_debit    DECIMAL(15,2) NOT NULL DEFAULT 0,
        total_credit   DECIMAL(15,2) NOT NULL DEFAULT 0,
        is_posted      BOOLEAN       DEFAULT false,
        posted_at      TIMESTAMP,
        created_by     INTEGER,
        created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        deleted_at     TIMESTAMP
      )
    `);

    // ── journal entry lines ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_entry_lines (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
        account_id       UUID NOT NULL REFERENCES chart_of_accounts(id),
        description      TEXT,
        debit            DECIMAL(15,2) DEFAULT 0,
        credit           DECIMAL(15,2) DEFAULT 0,
        created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── invoices (hybrid: party_name for seed compat, customer_id nullable for complex routes) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id               SERIAL PRIMARY KEY,
        invoice_number   VARCHAR(50)   UNIQUE NOT NULL,
        party_name       VARCHAR(255),
        customer_id      UUID          REFERENCES parties(id),
        invoice_date     DATE          DEFAULT CURRENT_DATE,
        due_date         DATE,
        subtotal         DECIMAL(15,2) DEFAULT 0,
        tax_amount       DECIMAL(15,2) DEFAULT 0,
        total_amount     DECIMAL(15,2) DEFAULT 0,
        paid_amount      DECIMAL(15,2) DEFAULT 0,
        balance          DECIMAL(15,2) DEFAULT 0,
        status           VARCHAR(20)   DEFAULT 'pending',
        notes            TEXT,
        journal_entry_id UUID          REFERENCES journal_entries(id),
        created_by       INTEGER,
        created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        deleted_at       TIMESTAMP
      )
    `);

    // ── invoice items ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoice_items (
        id           SERIAL PRIMARY KEY,
        invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        description  TEXT    NOT NULL,
        quantity     DECIMAL(10,2) NOT NULL DEFAULT 1,
        unit_price   DECIMAL(15,2) NOT NULL,
        tax_rate     DECIMAL(5,2)  DEFAULT 0,
        amount       DECIMAL(15,2) NOT NULL,
        created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── bills (hybrid: party_name + amount for dashboard compat) ──────
    await client.query(`
      CREATE TABLE IF NOT EXISTS bills (
        id              SERIAL PRIMARY KEY,
        bill_number     VARCHAR(50)   UNIQUE,
        party_name      VARCHAR(255),
        supplier_id     UUID          REFERENCES parties(id),
        bill_date       DATE          DEFAULT CURRENT_DATE,
        due_date        DATE,
        amount          DECIMAL(15,2) DEFAULT 0,
        subtotal        DECIMAL(15,2) DEFAULT 0,
        tax_amount      DECIMAL(15,2) DEFAULT 0,
        total_amount    DECIMAL(15,2) DEFAULT 0,
        paid_amount     DECIMAL(15,2) DEFAULT 0,
        balance         DECIMAL(15,2) DEFAULT 0,
        status          VARCHAR(20)   DEFAULT 'pending',
        approval_status VARCHAR(20)   DEFAULT 'Pending',
        approved_by     INTEGER,
        approved_at     TIMESTAMP,
        notes           TEXT,
        journal_entry_id UUID         REFERENCES journal_entries(id),
        created_by      INTEGER,
        created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        deleted_at      TIMESTAMP
      )
    `);

    // ── expense claims ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS expense_claims (
        id               SERIAL PRIMARY KEY,
        claim_number     VARCHAR(50)   UNIQUE,
        employee_email   VARCHAR(255),
        employee_id      INTEGER,
        claim_date       DATE          DEFAULT CURRENT_DATE,
        category         VARCHAR(100),
        amount           DECIMAL(15,2) DEFAULT 0,
        total_amount     DECIMAL(15,2) DEFAULT 0,
        status           VARCHAR(20)   DEFAULT 'pending',
        description      TEXT,
        notes            TEXT,
        approved_by      INTEGER,
        approved_at      TIMESTAMP,
        rejection_reason TEXT,
        payment_id       INTEGER,
        journal_entry_id UUID          REFERENCES journal_entries(id),
        created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        deleted_at       TIMESTAMP
      )
    `);

    // ── expense claim items ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS expense_claim_items (
        id               SERIAL PRIMARY KEY,
        expense_claim_id INTEGER NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
        expense_date     DATE    NOT NULL,
        category         VARCHAR(100) NOT NULL,
        description      TEXT    NOT NULL,
        amount           DECIMAL(15,2) NOT NULL,
        receipt_path     VARCHAR(500),
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── payments ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id               SERIAL PRIMARY KEY,
        payment_number   VARCHAR(50)   UNIQUE NOT NULL,
        payment_date     DATE          NOT NULL,
        payment_type     VARCHAR(20)   NOT NULL,
        party_id         UUID          REFERENCES parties(id),
        amount           DECIMAL(15,2) NOT NULL,
        payment_method   VARCHAR(50),
        reference_number VARCHAR(100),
        notes            TEXT,
        journal_entry_id UUID          REFERENCES journal_entries(id),
        created_by       INTEGER,
        created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        deleted_at       TIMESTAMP
      )
    `);

    // ── receipts ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS receipts (
        id               SERIAL PRIMARY KEY,
        receipt_number   VARCHAR(50)   UNIQUE NOT NULL,
        receipt_date     DATE          NOT NULL,
        customer_id      UUID          REFERENCES parties(id),
        amount           DECIMAL(15,2) NOT NULL,
        payment_method   VARCHAR(50),
        reference_number VARCHAR(100),
        notes            TEXT,
        journal_entry_id UUID          REFERENCES journal_entries(id),
        created_by       INTEGER,
        created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        deleted_at       TIMESTAMP
      )
    `);

    // ── bank accounts ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id             SERIAL PRIMARY KEY,
        account_name   VARCHAR(255) NOT NULL,
        bank_name      VARCHAR(255),
        account_number VARCHAR(50)  UNIQUE,
        ifsc_code      VARCHAR(20),
        account_type   VARCHAR(50)  DEFAULT 'Savings',
        balance        DECIMAL(15,2) DEFAULT 0,
        currency       VARCHAR(10)   DEFAULT 'INR',
        is_active      BOOLEAN       DEFAULT true,
        created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── finance tickets ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS finance_tickets (
        id           SERIAL PRIMARY KEY,
        ticket_number VARCHAR(20) UNIQUE NOT NULL,
        title        VARCHAR(255) NOT NULL,
        description  TEXT,
        category     VARCHAR(50),
        priority     VARCHAR(20) DEFAULT 'Medium',
        status       VARCHAR(20) DEFAULT 'Open',
        created_by   INTEGER,
        assigned_to  INTEGER,
        created_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── service desk tickets ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id             SERIAL PRIMARY KEY,
        ticket_number  VARCHAR(20)  UNIQUE NOT NULL,
        title          VARCHAR(255) NOT NULL,
        description    TEXT,
        category       VARCHAR(50),
        priority       VARCHAR(20)  DEFAULT 'Medium',
        status         VARCHAR(20)  DEFAULT 'Open',
        requester_name VARCHAR(255),
        requester_email VARCHAR(255),
        assigned_to    INTEGER,
        team           VARCHAR(100),
        sla_due_date   TIMESTAMP,
        resolved_at    TIMESTAMP,
        created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── service desk ticket comments ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ticket_comments (
        id         SERIAL PRIMARY KEY,
        ticket_id  INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        author     VARCHAR(255),
        body       TEXT,
        is_internal BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── CRM leads ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_leads (
        id            SERIAL PRIMARY KEY,
        lead_name     VARCHAR(255) NOT NULL,
        company       VARCHAR(255),
        email         VARCHAR(255),
        phone         VARCHAR(50),
        source        VARCHAR(100),
        status        VARCHAR(50)  DEFAULT 'New',
        owner         VARCHAR(255),
        lead_score    INTEGER      DEFAULT 0,
        notes         TEXT,
        created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── CRM lead activities ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_lead_activities (
        id          SERIAL PRIMARY KEY,
        lead_id     INTEGER NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
        activity    VARCHAR(100),
        description TEXT,
        performed_by VARCHAR(255),
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── CRM opportunities ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_opportunities (
        id           SERIAL PRIMARY KEY,
        title        VARCHAR(255) NOT NULL,
        company      VARCHAR(255),
        contact      VARCHAR(255),
        value        DECIMAL(15,2) DEFAULT 0,
        stage        VARCHAR(50)   DEFAULT 'prospecting',
        probability  INTEGER       DEFAULT 0,
        expected_close DATE,
        owner        VARCHAR(255),
        lead_id      INTEGER       REFERENCES crm_leads(id),
        notes        TEXT,
        created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── CRM accounts ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_accounts (
        id           SERIAL PRIMARY KEY,
        account_name VARCHAR(255) NOT NULL,
        industry     VARCHAR(100),
        website      VARCHAR(255),
        phone        VARCHAR(50),
        email        VARCHAR(255),
        address      TEXT,
        account_type VARCHAR(50)  DEFAULT 'Customer',
        annual_revenue DECIMAL(15,2) DEFAULT 0,
        employees_count INTEGER,
        owner        VARCHAR(255),
        status       VARCHAR(20)  DEFAULT 'Active',
        created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── CRM contacts ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_contacts (
        id           SERIAL PRIMARY KEY,
        full_name    VARCHAR(255) NOT NULL,
        account_id   INTEGER      REFERENCES crm_accounts(id),
        title        VARCHAR(100),
        email        VARCHAR(255),
        phone        VARCHAR(50),
        department   VARCHAR(100),
        lead_source  VARCHAR(100),
        status       VARCHAR(20)  DEFAULT 'Active',
        notes        TEXT,
        created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── audit logs ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id           SERIAL PRIMARY KEY,
        action       VARCHAR(100),
        module       VARCHAR(100),
        description  TEXT,
        performed_by VARCHAR(255),
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── projects ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_code       VARCHAR(50)   UNIQUE NOT NULL,
        project_name       VARCHAR(255)  NOT NULL,
        customer_id        UUID          REFERENCES parties(id),
        start_date         DATE          NOT NULL,
        end_date           DATE,
        project_manager_id INTEGER,
        status             VARCHAR(20)   DEFAULT 'planning',
        billing_model      VARCHAR(50),
        project_type       VARCHAR(20)   DEFAULT 'external',
        health_score       DECIMAL(5,2)  DEFAULT 100,
        budget_amount      DECIMAL(15,2) DEFAULT 0,
        description        TEXT,
        created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        created_by         INTEGER,
        deleted_at         TIMESTAMP
      )
    `);

    // ── tasks ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id       UUID REFERENCES projects(id) ON DELETE CASCADE,
        task_title       VARCHAR(255) NOT NULL,
        task_description TEXT,
        assigned_to      INTEGER,
        priority         VARCHAR(20)   DEFAULT 'medium',
        status           VARCHAR(20)   DEFAULT 'todo',
        start_date       DATE,
        due_date         DATE,
        estimated_hours  DECIMAL(8,2),
        actual_hours     DECIMAL(8,2)  DEFAULT 0,
        created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        created_by       INTEGER,
        deleted_at       TIMESTAMP
      )
    `);

    // ── project cost summary ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_cost_summary (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id    UUID UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        labour_cost   DECIMAL(15,2) DEFAULT 0,
        material_cost DECIMAL(15,2) DEFAULT 0,
        expense_cost  DECIMAL(15,2) DEFAULT 0,
        total_cost    DECIMAL(15,2) GENERATED ALWAYS AS (labour_cost + material_cost + expense_cost) STORED,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── timesheet entries ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS timesheet_entries (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id      INTEGER,
        project_id       UUID REFERENCES projects(id),
        task_id          UUID REFERENCES tasks(id),
        work_date        DATE          NOT NULL,
        hours_worked     DECIMAL(5,2)  NOT NULL,
        description      TEXT,
        is_billable      BOOLEAN       DEFAULT true,
        is_locked        BOOLEAN       DEFAULT false,
        status           VARCHAR(20)   DEFAULT 'draft',
        submitted_at     TIMESTAMP,
        approved_at      TIMESTAMP,
        approved_by      INTEGER,
        rejection_reason TEXT,
        created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        deleted_at       TIMESTAMP
      )
    `);

    // ── timesheet approvals ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS timesheet_approvals (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id     INTEGER,
        week_start_date DATE NOT NULL,
        week_end_date   DATE NOT NULL,
        total_hours     DECIMAL(8,2),
        status          VARCHAR(20) DEFAULT 'pending',
        submitted_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approved_by     INTEGER,
        approved_at     TIMESTAMP,
        comments        TEXT,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query('COMMIT');
    console.log('✅ All tables created successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Init failed:', err.message);
    throw err;
  } finally {
    client.release();
  }

  // ── seed default chart of accounts ───────────────────────────────────
  try {
    const existing = await pool.query('SELECT COUNT(*) FROM chart_of_accounts');
    if (parseInt(existing.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO chart_of_accounts (code, name, account_type, description) VALUES
        ('1000','Assets','Asset','All Assets'),
        ('1100','Current Assets','Asset','Current Assets'),
        ('1110','Cash','Asset','Cash on Hand'),
        ('1120','Bank Account','Asset','Bank Accounts'),
        ('1130','Accounts Receivable','Asset','Customer Receivables'),
        ('1200','Fixed Assets','Asset','Fixed Assets'),
        ('2000','Liabilities','Liability','All Liabilities'),
        ('2100','Current Liabilities','Liability','Current Liabilities'),
        ('2110','Accounts Payable','Liability','Supplier Payables'),
        ('2120','Tax Payable','Liability','Tax Liabilities'),
        ('3000','Equity','Equity','Owner Equity'),
        ('3100','Retained Earnings','Equity','Retained Earnings'),
        ('4000','Revenue','Revenue','All Revenue'),
        ('4100','Sales Revenue','Revenue','Sales Income'),
        ('4200','Service Revenue','Revenue','Service Income'),
        ('5000','Expenses','Expense','All Expenses'),
        ('5100','Operating Expenses','Expense','Operating Expenses'),
        ('5110','Salaries & Wages','Expense','Employee Salaries'),
        ('5120','Rent Expense','Expense','Rent Payments'),
        ('5130','Utilities','Expense','Utility Bills'),
        ('5140','Office Supplies','Expense','Office Supplies'),
        ('5150','Travel & Entertainment','Expense','Travel Expenses')
        ON CONFLICT (code) DO NOTHING
      `);
      console.log('✅ Default chart of accounts seeded');
    }
  } catch (e) {
    console.log('Chart of accounts:', e.message);
  }

  // ── seed default financial periods ───────────────────────────────────
  try {
    const existing = await pool.query('SELECT COUNT(*) FROM financial_periods');
    if (parseInt(existing.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO financial_periods (period_name, start_date, end_date, status) VALUES
        ('Jan 2026','2026-01-01','2026-01-31','Closed'),
        ('Feb 2026','2026-02-01','2026-02-28','Closed'),
        ('Mar 2026','2026-03-01','2026-03-31','Open'),
        ('Apr 2026','2026-04-01','2026-04-30','Open'),
        ('Q1 FY2026','2026-01-01','2026-03-31','Open')
        ON CONFLICT DO NOTHING
      `);
      console.log('✅ Financial periods seeded');
    }
  } catch (e) {
    console.log('Financial periods:', e.message);
  }

  // ── seed default parties ──────────────────────────────────────────────
  try {
    const existing = await pool.query('SELECT COUNT(*) FROM parties');
    if (parseInt(existing.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO parties (party_code, party_type, name, email, phone, payment_terms, credit_limit) VALUES
        ('CUST-001','Customer','TechCorp Ltd',         'billing@techcorp.com',    '9900110011', 30, 500000),
        ('CUST-002','Customer','Global Services',      'accounts@globalsvcs.com', '9900220022', 30, 300000),
        ('CUST-003','Customer','Alpha Solutions',      'finance@alphasol.com',    '9900330033', 45, 400000),
        ('CUST-004','Customer','Beta Systems',         'pay@betasys.com',         '9900440044', 30, 200000),
        ('CUST-005','Customer','Gamma Corp',           'ar@gammacorp.com',        '9900550055', 30, 350000),
        ('CUST-006','Customer','Delta Industries',     'billing@deltaind.com',    '9900660066', 45, 250000),
        ('CUST-007','Customer','Epsilon Tech',         'pay@epsilontech.com',     '9900770077', 30, 300000),
        ('CUST-008','Customer','Zeta Partners',        'ar@zetapartners.com',     '9900880088', 30, 600000),
        ('CUST-009','Customer','Eta Enterprises',      'billing@eta.com',         '9900990099', 30, 200000),
        ('CUST-010','Customer','Theta Group',          'finance@theta.com',       '9911001100', 30, 400000),
        ('SUPP-001','Supplier','Office Supplies Co',   'ap@officesup.com',        '9922002200', 30, 0),
        ('SUPP-002','Supplier','Cloud Services Ltd',   'billing@cloudsvc.com',    '9922003300', 15, 0),
        ('SUPP-003','Supplier','Marketing Agency',     'invoice@mktgagency.com',  '9922004400', 30, 0),
        ('SUPP-004','Supplier','IT Hardware Store',    'sales@ithardware.com',    '9922005500', 30, 0)
        ON CONFLICT (party_code) DO NOTHING
      `);
      console.log('✅ Parties seeded');
    }
  } catch (e) {
    console.log('Parties:', e.message);
  }

  console.log('🎉 Database initialisation complete');
  process.exit(0);
}

initDb().catch(e => { console.error('❌', e.message); process.exit(1); });
