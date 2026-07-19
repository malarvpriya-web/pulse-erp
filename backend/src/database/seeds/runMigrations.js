/**
 * runMigrations.js — Create all tables, then run masterSeed.js
 * Run: node src/database/seeds/runMigrations.js
 *
 * Uses CREATE TABLE IF NOT EXISTS so it is safe to run multiple times.
 * Covers every table referenced by any route file in the Pulse ERP system.
 */

import pool from '../../../config/db.js';
import { runSeed } from './masterSeed.js';

async function createTables() {
  const client = await pool.connect();
  try {
    console.log('\n📦 Running Pulse ERP migrations...\n');

    // ════════════════════════════════════════
    // CORE: USERS
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(150) NOT NULL,
        email         VARCHAR(255) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          VARCHAR(50) NOT NULL DEFAULT 'employee',
        avatar_url    TEXT,
        is_active     BOOLEAN DEFAULT true,
        last_login    TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ users');

    // ════════════════════════════════════════
    // CORE: EMPLOYEES
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id                 SERIAL PRIMARY KEY,
        employee_code      VARCHAR(20) NOT NULL UNIQUE,
        full_name          VARCHAR(150) NOT NULL,
        email              VARCHAR(255) UNIQUE,
        phone              VARCHAR(20),
        department         VARCHAR(100),
        designation        VARCHAR(150),
        joining_date       DATE,
        basic_salary       NUMERIC(12,2) DEFAULT 0,
        pan_number         VARCHAR(20),
        aadhaar_last4      VARCHAR(4),
        bank_account       VARCHAR(30),
        ifsc               VARCHAR(20),
        status             VARCHAR(20) DEFAULT 'active',
        manager_id         INTEGER REFERENCES employees(id),
        user_id            INTEGER REFERENCES users(id),
        date_of_birth      DATE,
        gender             VARCHAR(10),
        address            TEXT,
        emergency_contact  VARCHAR(200),
        probation_end_date DATE,
        deleted_at         TIMESTAMPTZ,
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ employees');

    // ════════════════════════════════════════
    // CORE: ATTENDANCE
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id          SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id),
        date        DATE NOT NULL,
        status      VARCHAR(20) DEFAULT 'present',
        check_in    TIME,
        check_out   TIME,
        work_hours  NUMERIC(4,2),
        notes       TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, date)
      )
    `);
    console.log('✅ attendance');

    // ════════════════════════════════════════
    // CORE: LEAVES
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS leaves (
        id           SERIAL PRIMARY KEY,
        employee_id  INTEGER NOT NULL REFERENCES employees(id),
        leave_type   VARCHAR(50),
        start_date   DATE,
        end_date     DATE,
        days         INTEGER DEFAULT 1,
        reason       TEXT,
        status       VARCHAR(20) DEFAULT 'pending',
        approved_by  INTEGER REFERENCES employees(id),
        approved_at  TIMESTAMPTZ,
        rejection_reason TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ leaves');

    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_balances (
        id               SERIAL PRIMARY KEY,
        employee_id      INTEGER NOT NULL REFERENCES employees(id),
        year             INTEGER NOT NULL,
        annual_total     INTEGER DEFAULT 12,
        annual_used      INTEGER DEFAULT 0,
        annual_remaining INTEGER DEFAULT 12,
        sick_total       INTEGER DEFAULT 6,
        sick_used        INTEGER DEFAULT 0,
        sick_remaining   INTEGER DEFAULT 6,
        casual_total     INTEGER DEFAULT 6,
        casual_used      INTEGER DEFAULT 0,
        casual_remaining INTEGER DEFAULT 6,
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, year)
      )
    `);
    console.log('✅ leave_balances');

    // ════════════════════════════════════════
    // CORE: HOLIDAYS
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS holidays (
        id           SERIAL PRIMARY KEY,
        date         DATE NOT NULL UNIQUE,
        name         VARCHAR(150) NOT NULL,
        holiday_type VARCHAR(30) DEFAULT 'national',
        description  TEXT,
        year         INTEGER,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ holidays');

    // ════════════════════════════════════════
    // FINANCE: CHART OF ACCOUNTS
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS chart_of_accounts (
        id                  SERIAL PRIMARY KEY,
        account_code        VARCHAR(20) NOT NULL UNIQUE,
        account_name        VARCHAR(200) NOT NULL,
        account_type        VARCHAR(50) NOT NULL,
        account_subtype     VARCHAR(100),
        is_cash_account     BOOLEAN DEFAULT false,
        parent_account_code VARCHAR(20),
        balance             NUMERIC(15,2) DEFAULT 0,
        is_active           BOOLEAN DEFAULT true,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ chart_of_accounts');

    // ════════════════════════════════════════
    // FINANCE: PARTIES
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS parties (
        id             SERIAL PRIMARY KEY,
        party_code     VARCHAR(30) NOT NULL UNIQUE,
        party_name     VARCHAR(200) NOT NULL,
        party_type     VARCHAR(20) NOT NULL,
        gstin          VARCHAR(20),
        pan            VARCHAR(20),
        credit_limit   NUMERIC(15,2) DEFAULT 0,
        payment_terms  INTEGER DEFAULT 30,
        website        VARCHAR(200),
        email          VARCHAR(200),
        phone          VARCHAR(20),
        city           VARCHAR(100),
        state          VARCHAR(100),
        country        VARCHAR(100) DEFAULT 'India',
        address        TEXT,
        is_active      BOOLEAN DEFAULT true,
        opening_balance NUMERIC(15,2) DEFAULT 0,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ parties');

    // ════════════════════════════════════════
    // FINANCE: INVOICES
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id              SERIAL PRIMARY KEY,
        invoice_number  VARCHAR(50) NOT NULL UNIQUE,
        party_id        INTEGER REFERENCES parties(id),
        invoice_date    DATE,
        due_date        DATE,
        subtotal        NUMERIC(15,2) DEFAULT 0,
        cgst_amount     NUMERIC(15,2) DEFAULT 0,
        sgst_amount     NUMERIC(15,2) DEFAULT 0,
        igst_amount     NUMERIC(15,2) DEFAULT 0,
        total_amount    NUMERIC(15,2) DEFAULT 0,
        paid_amount     NUMERIC(15,2) DEFAULT 0,
        balance_amount  NUMERIC(15,2) DEFAULT 0,
        status          VARCHAR(30) DEFAULT 'draft',
        description     TEXT,
        notes           TEXT,
        terms           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS invoice_items (
        id           SERIAL PRIMARY KEY,
        invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        description  VARCHAR(500),
        quantity     NUMERIC(10,2) DEFAULT 1,
        unit_price   NUMERIC(12,2) DEFAULT 0,
        amount       NUMERIC(12,2) DEFAULT 0,
        tax_rate     NUMERIC(5,2) DEFAULT 18,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ invoices, invoice_items');

    // ════════════════════════════════════════
    // FINANCE: BILLS
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS bills (
        id           SERIAL PRIMARY KEY,
        bill_number  VARCHAR(50) NOT NULL UNIQUE,
        party_id     INTEGER REFERENCES parties(id),
        bill_date    DATE,
        due_date     DATE,
        subtotal     NUMERIC(15,2) DEFAULT 0,
        gst_amount   NUMERIC(15,2) DEFAULT 0,
        total_amount NUMERIC(15,2) DEFAULT 0,
        paid_amount  NUMERIC(15,2) DEFAULT 0,
        status       VARCHAR(30) DEFAULT 'unpaid',
        description  TEXT,
        notes        TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bill_items (
        id          SERIAL PRIMARY KEY,
        bill_id     INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
        description VARCHAR(500),
        quantity    NUMERIC(10,2) DEFAULT 1,
        unit_price  NUMERIC(12,2) DEFAULT 0,
        amount      NUMERIC(12,2) DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ bills, bill_items');

    // ════════════════════════════════════════
    // FINANCE: PAYMENTS & RECEIPTS
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id              SERIAL PRIMARY KEY,
        payment_number  VARCHAR(50) UNIQUE,
        party_id        INTEGER REFERENCES parties(id),
        bill_id         INTEGER REFERENCES bills(id),
        payment_date    DATE,
        amount          NUMERIC(15,2) DEFAULT 0,
        payment_mode    VARCHAR(50) DEFAULT 'bank_transfer',
        reference       VARCHAR(200),
        notes           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS receipts (
        id             SERIAL PRIMARY KEY,
        receipt_number VARCHAR(50) UNIQUE,
        party_id       INTEGER REFERENCES parties(id),
        invoice_id     INTEGER REFERENCES invoices(id),
        receipt_date   DATE,
        amount         NUMERIC(15,2) DEFAULT 0,
        payment_mode   VARCHAR(50) DEFAULT 'bank_transfer',
        reference      VARCHAR(200),
        notes          TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ payments, receipts');

    // ════════════════════════════════════════
    // FINANCE: JOURNAL ENTRIES
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id               SERIAL PRIMARY KEY,
        reference_number VARCHAR(50) UNIQUE,
        entry_date       DATE,
        narration        TEXT,
        total_debit      NUMERIC(15,2) DEFAULT 0,
        total_credit     NUMERIC(15,2) DEFAULT 0,
        status           VARCHAR(20) DEFAULT 'draft',
        created_by       INTEGER REFERENCES users(id),
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_lines (
        id               SERIAL PRIMARY KEY,
        journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
        account_code     VARCHAR(20),
        party_id         INTEGER REFERENCES parties(id),
        debit_amount     NUMERIC(15,2) DEFAULT 0,
        credit_amount    NUMERIC(15,2) DEFAULT 0,
        description      TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ journal_entries, journal_lines');

    // ════════════════════════════════════════
    // FINANCE: ACCOUNTING PERIODS & BANK ACCOUNTS
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounting_periods (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(100),
        start_date DATE,
        end_date   DATE,
        status     VARCHAR(20) DEFAULT 'open',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id             SERIAL PRIMARY KEY,
        account_name   VARCHAR(200),
        bank_name      VARCHAR(200),
        account_number VARCHAR(50),
        ifsc_code      VARCHAR(20),
        account_type   VARCHAR(30),
        opening_balance NUMERIC(15,2) DEFAULT 0,
        current_balance NUMERIC(15,2) DEFAULT 0,
        is_active      BOOLEAN DEFAULT true,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_batches (
        id          SERIAL PRIMARY KEY,
        batch_number VARCHAR(50) UNIQUE,
        description TEXT,
        total_amount NUMERIC(15,2) DEFAULT 0,
        status      VARCHAR(20) DEFAULT 'draft',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_batch_items (
        id         SERIAL PRIMARY KEY,
        batch_id   INTEGER REFERENCES payment_batches(id),
        party_id   INTEGER REFERENCES parties(id),
        amount     NUMERIC(15,2) DEFAULT 0,
        reference  VARCHAR(200),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ accounting_periods, bank_accounts, payment_batches');

    // ════════════════════════════════════════
    // PAYROLL
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS payroll_runs (
        id           SERIAL PRIMARY KEY,
        period_label VARCHAR(20) NOT NULL UNIQUE,
        period_name  VARCHAR(100),
        period_start DATE,
        period_end   DATE,
        status       VARCHAR(30) DEFAULT 'draft',
        total_gross  NUMERIC(15,2) DEFAULT 0,
        total_net    NUMERIC(15,2) DEFAULT 0,
        processed_by INTEGER REFERENCES users(id),
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payslips (
        id                    SERIAL PRIMARY KEY,
        payroll_run_id        INTEGER NOT NULL REFERENCES payroll_runs(id),
        employee_id           INTEGER NOT NULL REFERENCES employees(id),
        basic_salary          NUMERIC(12,2) DEFAULT 0,
        hra                   NUMERIC(12,2) DEFAULT 0,
        conveyance_allowance  NUMERIC(12,2) DEFAULT 0,
        medical_allowance     NUMERIC(12,2) DEFAULT 0,
        special_allowance     NUMERIC(12,2) DEFAULT 0,
        other_allowances      NUMERIC(12,2) DEFAULT 0,
        gross_salary          NUMERIC(12,2) DEFAULT 0,
        pf_deduction          NUMERIC(12,2) DEFAULT 0,
        esi_deduction         NUMERIC(12,2) DEFAULT 0,
        professional_tax      NUMERIC(12,2) DEFAULT 0,
        tds_deduction         NUMERIC(12,2) DEFAULT 0,
        other_deductions      NUMERIC(12,2) DEFAULT 0,
        total_deductions      NUMERIC(12,2) DEFAULT 0,
        net_pay               NUMERIC(12,2) DEFAULT 0,
        status                VARCHAR(20) DEFAULT 'pending',
        paid_on               DATE,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(payroll_run_id, employee_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS salary_structures (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(200),
        description TEXT,
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_salary_assignments (
        id                 SERIAL PRIMARY KEY,
        employee_id        INTEGER REFERENCES employees(id),
        salary_structure_id INTEGER REFERENCES salary_structures(id),
        effective_date     DATE,
        basic_salary       NUMERIC(12,2),
        created_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS loan_advances (
        id           SERIAL PRIMARY KEY,
        employee_id  INTEGER REFERENCES employees(id),
        loan_type    VARCHAR(50),
        amount       NUMERIC(12,2),
        emi_amount   NUMERIC(12,2),
        total_emis   INTEGER,
        paid_emis    INTEGER DEFAULT 0,
        status       VARCHAR(20) DEFAULT 'active',
        approved_by  INTEGER REFERENCES users(id),
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ payroll_runs, payslips, salary_structures, loan_advances');

    // ════════════════════════════════════════
    // PROJECTS
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id                   SERIAL PRIMARY KEY,
        project_code         VARCHAR(30) UNIQUE,
        project_name         VARCHAR(300) NOT NULL,
        description          TEXT,
        client_name          VARCHAR(200),
        start_date           DATE,
        end_date             DATE,
        budget               NUMERIC(15,2) DEFAULT 0,
        actual_cost          NUMERIC(15,2) DEFAULT 0,
        project_manager_id   INTEGER REFERENCES employees(id),
        status               VARCHAR(30) DEFAULT 'planning',
        progress_percentage  INTEGER DEFAULT 0,
        priority             VARCHAR(20) DEFAULT 'medium',
        color                VARCHAR(20) DEFAULT '#7c3aed',
        created_at           TIMESTAMPTZ DEFAULT NOW(),
        updated_at           TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id           SERIAL PRIMARY KEY,
        project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        parent_id    INTEGER REFERENCES tasks(id),
        title        VARCHAR(500) NOT NULL,
        description  TEXT,
        status       VARCHAR(30) DEFAULT 'todo',
        priority     VARCHAR(20) DEFAULT 'medium',
        assigned_to  INTEGER REFERENCES employees(id),
        start_date   DATE,
        due_date     DATE,
        completed_at TIMESTAMPTZ,
        estimated_hours NUMERIC(6,2),
        actual_hours    NUMERIC(6,2),
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS task_comments (
        id         SERIAL PRIMARY KEY,
        task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        author_id  INTEGER REFERENCES employees(id),
        comment    TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_costs (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER REFERENCES projects(id),
        cost_type   VARCHAR(100),
        amount      NUMERIC(12,2),
        description TEXT,
        cost_date   DATE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_resources (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER REFERENCES projects(id),
        employee_id INTEGER REFERENCES employees(id),
        role        VARCHAR(100),
        allocation_percentage INTEGER DEFAULT 100,
        start_date  DATE,
        end_date    DATE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_milestones (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER REFERENCES projects(id),
        title       VARCHAR(300),
        due_date    DATE,
        status      VARCHAR(20) DEFAULT 'pending',
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ projects, tasks, task_comments, project_costs, project_resources, project_milestones');

    // ════════════════════════════════════════
    // TIMESHEETS
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS timesheets (
        id              SERIAL PRIMARY KEY,
        employee_id     INTEGER NOT NULL REFERENCES employees(id),
        week_start_date DATE NOT NULL,
        week_end_date   DATE,
        total_hours     NUMERIC(6,2) DEFAULT 0,
        status          VARCHAR(20) DEFAULT 'draft',
        approved_by     INTEGER REFERENCES employees(id),
        approved_at     TIMESTAMPTZ,
        submitted_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, week_start_date)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS timesheet_entries (
        id           SERIAL PRIMARY KEY,
        timesheet_id INTEGER NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
        project_id   INTEGER REFERENCES projects(id),
        task_id      INTEGER REFERENCES tasks(id),
        date         DATE,
        hours        NUMERIC(4,2) DEFAULT 0,
        description  TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ timesheets, timesheet_entries');

    // ════════════════════════════════════════
    // CRM
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id             SERIAL PRIMARY KEY,
        account_code   VARCHAR(30) UNIQUE,
        account_name   VARCHAR(300) NOT NULL,
        segment        VARCHAR(50),
        industry       VARCHAR(100),
        website        VARCHAR(200),
        email          VARCHAR(200),
        phone          VARCHAR(30),
        city           VARCHAR(100),
        state          VARCHAR(100),
        annual_revenue NUMERIC(15,2),
        employee_count INTEGER,
        is_active      BOOLEAN DEFAULT true,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id               SERIAL PRIMARY KEY,
        lead_code        VARCHAR(30) UNIQUE,
        company_name     VARCHAR(300),
        contact_person   VARCHAR(200),
        email            VARCHAR(200),
        phone            VARCHAR(30),
        lead_source      VARCHAR(100),
        status           VARCHAR(50) DEFAULT 'Prospecting',
        estimated_value  NUMERIC(15,2),
        requirements     TEXT,
        owner_id         INTEGER REFERENCES employees(id),
        account_id       INTEGER REFERENCES accounts(id),
        next_follow_up   DATE,
        notes            TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id          SERIAL PRIMARY KEY,
        account_id  INTEGER REFERENCES accounts(id),
        full_name   VARCHAR(200),
        designation VARCHAR(200),
        email       VARCHAR(200),
        phone       VARCHAR(30),
        is_primary  BOOLEAN DEFAULT false,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS opportunities (
        id                   SERIAL PRIMARY KEY,
        opportunity_code     VARCHAR(30) UNIQUE,
        opportunity_name     VARCHAR(300),
        account_id           INTEGER REFERENCES accounts(id),
        lead_code            VARCHAR(30),
        deal_value           NUMERIC(15,2),
        stage                VARCHAR(50) DEFAULT 'Prospecting',
        probability          INTEGER DEFAULT 10,
        expected_close_date  DATE,
        owner_id             INTEGER REFERENCES employees(id),
        notes                TEXT,
        created_at           TIMESTAMPTZ DEFAULT NOW(),
        updated_at           TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_activities (
        id             SERIAL PRIMARY KEY,
        lead_id        INTEGER REFERENCES leads(id),
        opportunity_id INTEGER REFERENCES opportunities(id),
        activity_type  VARCHAR(50),
        subject        VARCHAR(300),
        description    TEXT,
        activity_date  DATE,
        duration_mins  INTEGER,
        performed_by   INTEGER REFERENCES employees(id),
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_emails (
        id          SERIAL PRIMARY KEY,
        lead_id     INTEGER REFERENCES leads(id),
        subject     VARCHAR(500),
        body        TEXT,
        sent_at     TIMESTAMPTZ,
        sent_by     INTEGER REFERENCES employees(id),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_email_accounts (
        id          SERIAL PRIMARY KEY,
        email       VARCHAR(200),
        provider    VARCHAR(50),
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_email_templates (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(200),
        subject     VARCHAR(500),
        body        TEXT,
        category    VARCHAR(100),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_email_sequences (
        id           SERIAL PRIMARY KEY,
        name         VARCHAR(200),
        description  TEXT,
        status       VARCHAR(20) DEFAULT 'active',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ accounts, leads, contacts, opportunities, crm_activities, crm_emails, crm_email_*');

    // ════════════════════════════════════════
    // SALES
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS quotations (
        id              SERIAL PRIMARY KEY,
        quotation_number VARCHAR(50) UNIQUE,
        party_id        INTEGER REFERENCES parties(id),
        lead_id         INTEGER REFERENCES leads(id),
        quotation_date  DATE,
        valid_until     DATE,
        subtotal        NUMERIC(15,2) DEFAULT 0,
        tax_amount      NUMERIC(15,2) DEFAULT 0,
        total_amount    NUMERIC(15,2) DEFAULT 0,
        status          VARCHAR(30) DEFAULT 'draft',
        notes           TEXT,
        created_by      INTEGER REFERENCES employees(id),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS quotation_items (
        id            SERIAL PRIMARY KEY,
        quotation_id  INTEGER REFERENCES quotations(id) ON DELETE CASCADE,
        description   VARCHAR(500),
        quantity      NUMERIC(10,2) DEFAULT 1,
        unit_price    NUMERIC(12,2) DEFAULT 0,
        amount        NUMERIC(12,2) DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_orders (
        id               SERIAL PRIMARY KEY,
        order_number     VARCHAR(50) UNIQUE,
        party_id         INTEGER REFERENCES parties(id),
        quotation_id     INTEGER REFERENCES quotations(id),
        order_date       DATE,
        delivery_date    DATE,
        total_amount     NUMERIC(15,2) DEFAULT 0,
        status           VARCHAR(30) DEFAULT 'confirmed',
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id           SERIAL PRIMARY KEY,
        order_id     INTEGER REFERENCES sales_orders(id) ON DELETE CASCADE,
        description  VARCHAR(500),
        quantity     NUMERIC(10,2),
        unit_price   NUMERIC(12,2),
        amount       NUMERIC(12,2),
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_targets (
        id          SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id),
        period      VARCHAR(20),
        target_amount NUMERIC(15,2),
        achieved_amount NUMERIC(15,2) DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_forecasts (
        id          SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id),
        period      VARCHAR(20),
        forecast_amount NUMERIC(15,2),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS competitors (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(200),
        website     VARCHAR(200),
        strengths   TEXT,
        weaknesses  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS territories (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(200),
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // sales_partners is NOT created here. It is owned by migration
    // 20260717000004, which is the only definition that produces the real shape
    // (ipu_number, association_type, company_id NOT NULL, gstin, address cols).
    //
    // This block used to create a THIRD, wrong-shaped variant — `commission_rate`
    // instead of commission_pct, no company_id, nullable name. Because both used
    // CREATE TABLE IF NOT EXISTS, whichever ran first on a fresh database won, and
    // the migration's ALTERs would then bolt columns onto the wrong base and leave
    // the partner routes throwing on a missing commission_pct.

    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_playbooks (
        id          SERIAL PRIMARY KEY,
        title       VARCHAR(300),
        content     TEXT,
        category    VARCHAR(100),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_documents (
        id          SERIAL PRIMARY KEY,
        title       VARCHAR(300),
        file_url    TEXT,
        category    VARCHAR(100),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id              SERIAL PRIMARY KEY,
        party_id        INTEGER REFERENCES parties(id),
        plan_name       VARCHAR(200),
        billing_cycle   VARCHAR(30),
        amount          NUMERIC(12,2),
        status          VARCHAR(20) DEFAULT 'active',
        next_billing    DATE,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS price_lists (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(200),
        currency    VARCHAR(10) DEFAULT 'INR',
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS price_list_items (
        id            SERIAL PRIMARY KEY,
        price_list_id INTEGER REFERENCES price_lists(id),
        item_name     VARCHAR(300),
        unit_price    NUMERIC(12,2),
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS discount_rules (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(200),
        discount_type VARCHAR(30),
        discount_value NUMERIC(10,2),
        conditions    JSONB,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS commission_plans (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(200),
        description TEXT,
        rules       JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS commissions (
        id          SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id),
        period      VARCHAR(20),
        amount      NUMERIC(12,2),
        status      VARCHAR(20) DEFAULT 'pending',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS commission_entries (
        id            SERIAL PRIMARY KEY,
        commission_id INTEGER REFERENCES commissions(id),
        invoice_id    INTEGER REFERENCES invoices(id),
        amount        NUMERIC(12,2),
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ sales module tables (quotations, orders, targets, forecasts, commissions, etc.)');

    // ════════════════════════════════════════
    // PROCUREMENT
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_requests (
        id           SERIAL PRIMARY KEY,
        pr_number    VARCHAR(50) NOT NULL UNIQUE,
        requested_by INTEGER REFERENCES employees(id),
        request_date DATE,
        description  TEXT,
        status       VARCHAR(20) DEFAULT 'draft',
        approved_by  INTEGER REFERENCES employees(id),
        approved_at  TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_request_items (
        id          SERIAL PRIMARY KEY,
        pr_id       INTEGER REFERENCES purchase_requests(id) ON DELETE CASCADE,
        item_name   VARCHAR(300),
        quantity    NUMERIC(10,2),
        estimated_cost NUMERIC(12,2),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id                      SERIAL PRIMARY KEY,
        po_number               VARCHAR(50) NOT NULL UNIQUE,
        supplier_id             INTEGER REFERENCES parties(id),
        pr_id                   INTEGER REFERENCES purchase_requests(id),
        po_date                 DATE,
        expected_delivery_date  DATE,
        total_amount            NUMERIC(15,2) DEFAULT 0,
        status                  VARCHAR(30) DEFAULT 'draft',
        notes                   TEXT,
        created_at              TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS po_items (
        id          SERIAL PRIMARY KEY,
        po_id       INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
        item_name   VARCHAR(300),
        quantity    NUMERIC(10,2),
        unit_price  NUMERIC(12,2),
        amount      NUMERIC(12,2),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS goods_receipts (
        id            SERIAL PRIMARY KEY,
        grn_number    VARCHAR(50) NOT NULL UNIQUE,
        po_id         INTEGER REFERENCES purchase_orders(id),
        received_date DATE,
        notes         TEXT,
        status        VARCHAR(20) DEFAULT 'completed',
        received_by   INTEGER REFERENCES employees(id),
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS grn_items (
        id          SERIAL PRIMARY KEY,
        grn_id      INTEGER REFERENCES goods_receipts(id) ON DELETE CASCADE,
        item_name   VARCHAR(300),
        ordered_qty NUMERIC(10,2),
        received_qty NUMERIC(10,2),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vendors (
        id          SERIAL PRIMARY KEY,
        party_id    INTEGER REFERENCES parties(id),
        vendor_code VARCHAR(30) UNIQUE,
        rating      NUMERIC(3,1),
        is_approved BOOLEAN DEFAULT false,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vendor_documents (
        id          SERIAL PRIMARY KEY,
        vendor_id   INTEGER REFERENCES vendors(id),
        doc_type    VARCHAR(100),
        file_url    TEXT,
        expiry_date DATE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vendor_scorecards (
        id          SERIAL PRIMARY KEY,
        vendor_id   INTEGER REFERENCES vendors(id),
        period      VARCHAR(20),
        quality_score NUMERIC(3,1),
        delivery_score NUMERIC(3,1),
        price_score NUMERIC(3,1),
        overall_score NUMERIC(3,1),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rfq_headers (
        id          SERIAL PRIMARY KEY,
        rfq_number  VARCHAR(50) UNIQUE,
        pr_id       INTEGER REFERENCES purchase_requests(id),
        description TEXT,
        deadline    DATE,
        status      VARCHAR(20) DEFAULT 'open',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rfq_items (
        id          SERIAL PRIMARY KEY,
        rfq_id      INTEGER REFERENCES rfq_headers(id) ON DELETE CASCADE,
        item_name   VARCHAR(300),
        quantity    NUMERIC(10,2),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rfq_vendors (
        id          SERIAL PRIMARY KEY,
        rfq_id      INTEGER REFERENCES rfq_headers(id) ON DELETE CASCADE,
        vendor_id   INTEGER REFERENCES vendors(id),
        invited_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vendor_quotes (
        id          SERIAL PRIMARY KEY,
        rfq_id      INTEGER REFERENCES rfq_headers(id),
        vendor_id   INTEGER REFERENCES vendors(id),
        total_amount NUMERIC(15,2),
        validity_days INTEGER,
        notes       TEXT,
        submitted_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS three_way_match (
        id          SERIAL PRIMARY KEY,
        po_id       INTEGER REFERENCES purchase_orders(id),
        grn_id      INTEGER REFERENCES goods_receipts(id),
        bill_id     INTEGER REFERENCES bills(id),
        status      VARCHAR(20) DEFAULT 'matched',
        discrepancy_notes TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ procurement tables (PRs, POs, GRNs, vendors, RFQ, 3-way match)');

    // ════════════════════════════════════════
    // INVENTORY
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        id               SERIAL PRIMARY KEY,
        item_code        VARCHAR(50) NOT NULL UNIQUE,
        item_name        VARCHAR(300) NOT NULL,
        category         VARCHAR(100),
        unit_of_measure  VARCHAR(30) DEFAULT 'unit',
        current_quantity NUMERIC(12,2) DEFAULT 0,
        unit_cost        NUMERIC(12,2) DEFAULT 0,
        reorder_point    NUMERIC(12,2) DEFAULT 0,
        warehouse        VARCHAR(200) DEFAULT 'Chennai HQ',
        description      TEXT,
        is_active        BOOLEAN DEFAULT true,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_ledger (
        id          SERIAL PRIMARY KEY,
        item_id     INTEGER REFERENCES inventory_items(id),
        txn_type    VARCHAR(50),
        quantity    NUMERIC(12,2),
        unit_cost   NUMERIC(12,2),
        reference   VARCHAR(200),
        txn_date    DATE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS warehouses (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(200),
        code        VARCHAR(50) UNIQUE,
        address     TEXT,
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS warehouse_zones (
        id           SERIAL PRIMARY KEY,
        warehouse_id INTEGER REFERENCES warehouses(id),
        zone_code    VARCHAR(50),
        zone_name    VARCHAR(200),
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bin_locations (
        id       SERIAL PRIMARY KEY,
        zone_id  INTEGER REFERENCES warehouse_zones(id),
        bin_code VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_transfers (
        id            SERIAL PRIMARY KEY,
        transfer_number VARCHAR(50) UNIQUE,
        from_warehouse VARCHAR(200),
        to_warehouse   VARCHAR(200),
        item_id       INTEGER REFERENCES inventory_items(id),
        quantity      NUMERIC(12,2),
        status        VARCHAR(20) DEFAULT 'completed',
        transfer_date DATE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_adjustments (
        id            SERIAL PRIMARY KEY,
        item_id       INTEGER REFERENCES inventory_items(id),
        adjustment_type VARCHAR(30),
        quantity      NUMERIC(12,2),
        reason        TEXT,
        adjusted_by   INTEGER REFERENCES employees(id),
        adjusted_at   DATE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reorder_rules (
        id          SERIAL PRIMARY KEY,
        item_id     INTEGER REFERENCES inventory_items(id),
        reorder_qty NUMERIC(12,2),
        preferred_supplier_id INTEGER REFERENCES parties(id),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS landed_costs (
        id          SERIAL PRIMARY KEY,
        grn_id      INTEGER REFERENCES goods_receipts(id),
        cost_type   VARCHAR(100),
        amount      NUMERIC(12,2),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS abc_analysis (
        id          SERIAL PRIMARY KEY,
        item_id     INTEGER REFERENCES inventory_items(id),
        category    CHAR(1),
        annual_consumption NUMERIC(15,2),
        analysis_date DATE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ inventory tables (items, stock_ledger, warehouses, adjustments, reorder_rules, abc_analysis)');

    // ════════════════════════════════════════
    // HR MODULE EXTRAS
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id              SERIAL PRIMARY KEY,
        title           VARCHAR(300) NOT NULL,
        content         TEXT,
        start_date      DATE,
        end_date        DATE,
        author_id       INTEGER REFERENCES employees(id),
        target_audience VARCHAR(50) DEFAULT 'all',
        priority        VARCHAR(20) DEFAULT 'medium',
        is_active       BOOLEAN DEFAULT true,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS probation_records (
        id                 SERIAL PRIMARY KEY,
        employee_id        INTEGER REFERENCES employees(id),
        start_date         DATE,
        end_date           DATE,
        status             VARCHAR(20) DEFAULT 'in_progress',
        review_notes       TEXT,
        reviewed_by        INTEGER REFERENCES employees(id),
        created_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS offboarding (
        id              SERIAL PRIMARY KEY,
        employee_id     INTEGER REFERENCES employees(id),
        resignation_date DATE,
        last_working_day DATE,
        reason          TEXT,
        status          VARCHAR(20) DEFAULT 'initiated',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS exit_interviews (
        id          SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id),
        interview_date DATE,
        interviewer_id INTEGER REFERENCES employees(id),
        feedback    TEXT,
        rating      INTEGER,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fnf_settlements (
        id              SERIAL PRIMARY KEY,
        employee_id     INTEGER REFERENCES employees(id),
        settlement_date DATE,
        gratuity_amount NUMERIC(12,2) DEFAULT 0,
        leave_encashment NUMERIC(12,2) DEFAULT 0,
        notice_pay      NUMERIC(12,2) DEFAULT 0,
        total_amount    NUMERIC(12,2) DEFAULT 0,
        status          VARCHAR(20) DEFAULT 'pending',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS training_programs (
        id          SERIAL PRIMARY KEY,
        title       VARCHAR(300),
        description TEXT,
        trainer     VARCHAR(200),
        start_date  DATE,
        end_date    DATE,
        mode        VARCHAR(30) DEFAULT 'online',
        status      VARCHAR(20) DEFAULT 'planned',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS training_enrollments (
        id          SERIAL PRIMARY KEY,
        program_id  INTEGER REFERENCES training_programs(id),
        employee_id INTEGER REFERENCES employees(id),
        status      VARCHAR(20) DEFAULT 'enrolled',
        completed_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS skill_matrix (
        id          SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id),
        skill_name  VARCHAR(200),
        proficiency VARCHAR(30),
        certified   BOOLEAN DEFAULT false,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS succession_assessments (
        id           SERIAL PRIMARY KEY,
        employee_id  INTEGER REFERENCES employees(id),
        role_id      INTEGER,
        readiness    VARCHAR(30),
        notes        TEXT,
        assessed_by  INTEGER REFERENCES employees(id),
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS critical_roles (
        id          SERIAL PRIMARY KEY,
        title       VARCHAR(200),
        department  VARCHAR(100),
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS talent_assessments (
        id          SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id),
        performance_rating NUMERIC(3,1),
        potential_rating   NUMERIC(3,1),
        category    VARCHAR(50),
        assessed_at DATE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS biometric_devices (
        id          SERIAL PRIMARY KEY,
        device_name VARCHAR(200),
        location    VARCHAR(200),
        ip_address  VARCHAR(50),
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS biometric_logs (
        id          SERIAL PRIMARY KEY,
        device_id   INTEGER REFERENCES biometric_devices(id),
        employee_id INTEGER REFERENCES employees(id),
        log_type    VARCHAR(20),
        logged_at   TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS gate_passes (
        id          SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id),
        visitor_id  INTEGER,
        pass_type   VARCHAR(20) DEFAULT 'exit',
        valid_from  TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        reason      TEXT,
        approved_by INTEGER REFERENCES employees(id),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS visitors (
        id           SERIAL PRIMARY KEY,
        visitor_name VARCHAR(200),
        company      VARCHAR(200),
        phone        VARCHAR(30),
        host_id      INTEGER REFERENCES employees(id),
        purpose      TEXT,
        check_in     TIMESTAMPTZ,
        check_out    TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ HR extras (announcements, probation, offboarding, training, skill_matrix, biometric, visitors)');

    // ════════════════════════════════════════
    // SERVICE DESK
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id            SERIAL PRIMARY KEY,
        ticket_number VARCHAR(50) NOT NULL UNIQUE,
        title         VARCHAR(500) NOT NULL,
        description   TEXT,
        category      VARCHAR(100),
        priority      VARCHAR(20) DEFAULT 'medium',
        status        VARCHAR(30) DEFAULT 'open',
        raised_by     INTEGER REFERENCES employees(id),
        assigned_to   INTEGER REFERENCES employees(id),
        resolved_at   TIMESTAMPTZ,
        resolution    TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ticket_comments (
        id          SERIAL PRIMARY KEY,
        ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        author_id   INTEGER REFERENCES employees(id),
        comment     TEXT,
        is_internal BOOLEAN DEFAULT false,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ticket_attachments (
        id          SERIAL PRIMARY KEY,
        ticket_id   INTEGER REFERENCES tickets(id),
        file_name   VARCHAR(300),
        file_url    TEXT,
        uploaded_by INTEGER REFERENCES employees(id),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sla_policies (
        id                SERIAL PRIMARY KEY,
        name              VARCHAR(200),
        priority          VARCHAR(20),
        response_hours    INTEGER,
        resolution_hours  INTEGER,
        is_active         BOOLEAN DEFAULT true,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ticket_sla_tracking (
        id               SERIAL PRIMARY KEY,
        ticket_id        INTEGER REFERENCES tickets(id),
        sla_policy_id    INTEGER REFERENCES sla_policies(id),
        response_due     TIMESTAMPTZ,
        resolution_due   TIMESTAMPTZ,
        response_met     BOOLEAN,
        resolution_met   BOOLEAN,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_base_articles (
        id          SERIAL PRIMARY KEY,
        title       VARCHAR(500),
        content     TEXT,
        category    VARCHAR(100),
        tags        TEXT[],
        author_id   INTEGER REFERENCES employees(id),
        is_published BOOLEAN DEFAULT false,
        views       INTEGER DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS service_contracts (
        id              SERIAL PRIMARY KEY,
        party_id        INTEGER REFERENCES parties(id),
        contract_name   VARCHAR(300),
        start_date      DATE,
        end_date        DATE,
        sla_hours       INTEGER,
        monthly_value   NUMERIC(12,2),
        status          VARCHAR(20) DEFAULT 'active',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS field_visits (
        id              SERIAL PRIMARY KEY,
        ticket_id       INTEGER REFERENCES tickets(id),
        engineer_id     INTEGER REFERENCES employees(id),
        visit_date      DATE,
        visit_time      TIME,
        status          VARCHAR(20) DEFAULT 'scheduled',
        notes           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS service_engineers (
        id          SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id),
        skill_set   TEXT[],
        zone        VARCHAR(100),
        is_available BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS csat_surveys (
        id          SERIAL PRIMARY KEY,
        ticket_id   INTEGER REFERENCES tickets(id),
        rating      INTEGER,
        feedback    TEXT,
        submitted_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ service desk tables (tickets, comments, SLA, KB, contracts, CSAT)');

    // ════════════════════════════════════════
    // TRAVEL
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS travel_requests (
        id                SERIAL PRIMARY KEY,
        employee_id       INTEGER REFERENCES employees(id),
        destination       VARCHAR(200),
        travel_start_date DATE,
        travel_end_date   DATE,
        purpose           TEXT,
        status            VARCHAR(30) DEFAULT 'pending',
        estimated_cost    NUMERIC(12,2) DEFAULT 0,
        actual_cost       NUMERIC(12,2) DEFAULT 0,
        approved_by       INTEGER REFERENCES employees(id),
        approved_at       TIMESTAMPTZ,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS travel_bookings (
        id                SERIAL PRIMARY KEY,
        travel_request_id INTEGER REFERENCES travel_requests(id),
        booking_type      VARCHAR(30),
        vendor            VARCHAR(200),
        amount            NUMERIC(12,2),
        booking_reference VARCHAR(100),
        booked_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS travel_expenses (
        id                SERIAL PRIMARY KEY,
        travel_request_id INTEGER REFERENCES travel_requests(id),
        expense_type      VARCHAR(100),
        amount            NUMERIC(12,2),
        receipt_url       TEXT,
        expense_date      DATE,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS travel_advances (
        id                SERIAL PRIMARY KEY,
        travel_request_id INTEGER REFERENCES travel_requests(id),
        employee_id       INTEGER REFERENCES employees(id),
        amount_requested  NUMERIC(12,2),
        amount_approved   NUMERIC(12,2),
        status            VARCHAR(20) DEFAULT 'pending',
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ travel tables (requests, bookings, expenses, advances)');

    // ════════════════════════════════════════
    // PERFORMANCE
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS performance_reviews (
        id                   SERIAL PRIMARY KEY,
        employee_id          INTEGER NOT NULL REFERENCES employees(id),
        review_period        VARCHAR(50),
        review_year          INTEGER,
        work_quality_rating  NUMERIC(3,1),
        productivity_rating  NUMERIC(3,1),
        teamwork_rating      NUMERIC(3,1),
        communication_rating NUMERIC(3,1),
        overall_rating       NUMERIC(3,1),
        strengths            TEXT,
        improvements         TEXT,
        goals_set            TEXT,
        status               VARCHAR(20) DEFAULT 'draft',
        reviewer_id          INTEGER REFERENCES employees(id),
        reviewed_at          TIMESTAMPTZ,
        created_at           TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, review_period)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS review_ratings (
        id          SERIAL PRIMARY KEY,
        review_id   INTEGER REFERENCES performance_reviews(id),
        category    VARCHAR(100),
        rating      NUMERIC(3,1),
        comments    TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS goals (
        id                  SERIAL PRIMARY KEY,
        employee_id         INTEGER REFERENCES employees(id),
        title               VARCHAR(500),
        description         TEXT,
        category            VARCHAR(100),
        start_date          DATE,
        due_date            DATE,
        progress_percentage INTEGER DEFAULT 0,
        status              VARCHAR(30) DEFAULT 'not_started',
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ performance_reviews, review_ratings, goals');

    // ════════════════════════════════════════
    // RECRUITMENT
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS job_openings (
        id             SERIAL PRIMARY KEY,
        job_code       VARCHAR(30) UNIQUE,
        job_title      VARCHAR(300) NOT NULL,
        department     VARCHAR(100),
        location       VARCHAR(200),
        openings_count INTEGER DEFAULT 1,
        min_salary     NUMERIC(12,2),
        max_salary     NUMERIC(12,2),
        status         VARCHAR(20) DEFAULT 'active',
        posted_date    DATE,
        closing_date   DATE,
        description    TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS candidates (
        id              SERIAL PRIMARY KEY,
        candidate_code  VARCHAR(30) UNIQUE,
        job_id          INTEGER REFERENCES job_openings(id),
        full_name       VARCHAR(200) NOT NULL,
        email           VARCHAR(200),
        phone           VARCHAR(30),
        experience      VARCHAR(50),
        current_stage   VARCHAR(100) DEFAULT 'Resume Screening',
        status          VARCHAR(30) DEFAULT 'applied',
        resume_url      TEXT,
        applied_date    DATE,
        notes           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS interviews (
        id               SERIAL PRIMARY KEY,
        candidate_id     INTEGER REFERENCES candidates(id),
        interview_type   VARCHAR(50),
        scheduled_date   DATE,
        scheduled_time   TIME,
        interviewer_id   INTEGER REFERENCES employees(id),
        status           VARCHAR(20) DEFAULT 'scheduled',
        location         VARCHAR(200),
        feedback         TEXT,
        rating           INTEGER,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS job_offers (
        id            SERIAL PRIMARY KEY,
        candidate_id  INTEGER REFERENCES candidates(id),
        offered_salary NUMERIC(12,2),
        joining_date  DATE,
        offer_date    DATE,
        valid_until   DATE,
        status        VARCHAR(20) DEFAULT 'sent',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS onboarding_checklists (
        id           SERIAL PRIMARY KEY,
        employee_id  INTEGER REFERENCES employees(id),
        task_name    VARCHAR(300),
        is_completed BOOLEAN DEFAULT false,
        due_date     DATE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_templates (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(200),
        subject     VARCHAR(500),
        body        TEXT,
        category    VARCHAR(100),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ recruitment tables (job_openings, candidates, interviews, offers, onboarding)');

    // ════════════════════════════════════════
    // NOTIFICATIONS & AUDIT
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id                SERIAL PRIMARY KEY,
        user_id           INTEGER REFERENCES users(id),
        title             VARCHAR(300) NOT NULL,
        message           TEXT,
        notification_type VARCHAR(50),
        priority          VARCHAR(20) DEFAULT 'info',
        is_read           BOOLEAN DEFAULT false,
        action_url        TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ notifications');

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER REFERENCES users(id),
        action      VARCHAR(100),
        table_name  VARCHAR(100),
        record_id   INTEGER,
        old_values  JSONB,
        new_values  JSONB,
        ip_address  VARCHAR(50),
        user_agent  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ audit_logs');

    // ════════════════════════════════════════
    // REPORTS
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_reports (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(300),
        module      VARCHAR(100),
        filters     JSONB,
        created_by  INTEGER REFERENCES users(id),
        is_public   BOOLEAN DEFAULT false,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ saved_reports');

    // ════════════════════════════════════════
    // MARKETING
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id           SERIAL PRIMARY KEY,
        name         VARCHAR(300),
        campaign_type VARCHAR(50),
        status       VARCHAR(20) DEFAULT 'draft',
        start_date   DATE,
        end_date     DATE,
        budget       NUMERIC(12,2),
        target_leads INTEGER,
        actual_leads INTEGER DEFAULT 0,
        created_by   INTEGER REFERENCES employees(id),
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_leads (
        id           SERIAL PRIMARY KEY,
        campaign_id  INTEGER REFERENCES campaigns(id),
        lead_id      INTEGER REFERENCES leads(id),
        added_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ campaigns, campaign_leads');

    // ════════════════════════════════════════
    // OPERATIONS (WORKFLOW)
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_rules (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(300),
        module      VARCHAR(100),
        trigger_event VARCHAR(100),
        conditions  JSONB,
        actions     JSONB,
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_executions (
        id          SERIAL PRIMARY KEY,
        rule_id     INTEGER REFERENCES workflow_rules(id),
        trigger_data JSONB,
        status      VARCHAR(20) DEFAULT 'completed',
        executed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ workflow_rules, workflow_executions');

    // ════════════════════════════════════════
    // ADMIN
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_settings (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(200),
        provider    VARCHAR(100),
        config      JSONB,
        is_active   BOOLEAN DEFAULT false,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS security_events (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER REFERENCES users(id),
        event_type  VARCHAR(100),
        description TEXT,
        ip_address  VARCHAR(50),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ip_whitelist (
        id          SERIAL PRIMARY KEY,
        ip_address  VARCHAR(50),
        description TEXT,
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        id          SERIAL PRIMARY KEY,
        token_hash  TEXT,
        revoked_at  TIMESTAMPTZ DEFAULT NOW(),
        user_id     INTEGER REFERENCES users(id)
      )
    `);
    console.log('✅ admin tables (integration_settings, security_events, ip_whitelist, revoked_tokens)');

    // ════════════════════════════════════════
    // MODULE SETTINGS (per-company JSONB config store)
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS company_settings (
        id         SERIAL        PRIMARY KEY,
        company_id INTEGER       NOT NULL DEFAULT 0,
        module     VARCHAR(100)  NOT NULL,
        settings   JSONB         NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        UNIQUE (company_id, module)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_company_settings_lookup
      ON company_settings(company_id, module)
    `);
    console.log('✅ company_settings');

    // Add payroll_runs component-breakdown columns (safe to re-run — IF NOT EXISTS)
    await client.query(`
      ALTER TABLE payroll_runs
        ADD COLUMN IF NOT EXISTS basic                NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS hra                  NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS conveyance_allowance NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS medical_allowance    NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS special_allowance    NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS lop_days             NUMERIC(5,2)  DEFAULT 0,
        ADD COLUMN IF NOT EXISTS bonus                NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS loan_deduction       NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS advance_deduction    NUMERIC(12,2) DEFAULT 0
    `);
    console.log('✅ payroll_runs component columns');

    // ════════════════════════════════════════
    // COMPLAINTS
    // ════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS complaints (
        id                SERIAL PRIMARY KEY,
        complaint_number  VARCHAR(50) UNIQUE,
        title             VARCHAR(500),
        description       TEXT,
        customer_name     VARCHAR(200),
        customer_email    VARCHAR(200),
        customer_phone    VARCHAR(30),
        category          VARCHAR(100),
        priority          VARCHAR(20) DEFAULT 'medium',
        status            VARCHAR(30) DEFAULT 'open',
        assigned_to_name  VARCHAR(200),
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ complaints');

    console.log('\n✅ All tables created successfully!\n');

  } finally {
    client.release();
  }
}

async function main() {
  try {
    await createTables();
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🌱 Starting master seed...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    await runSeed();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Migration/Seed failed:', err.message);
    process.exit(1);
  }
}

main();
