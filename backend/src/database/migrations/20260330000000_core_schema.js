/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  // Existing Table Checks and Alterations from migrations.js
  
  // 1. Employees Table alterations
  await knex.raw(`
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS company_phone VARCHAR(20),
    ADD COLUMN IF NOT EXISTS employee_role VARCHAR(50),
    ADD COLUMN IF NOT EXISTS marital_status VARCHAR(20),
    ADD COLUMN IF NOT EXISTS father_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS mother_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS spouse_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS anniversary_date DATE,
    ADD COLUMN IF NOT EXISTS current_address TEXT,
    ADD COLUMN IF NOT EXISTS permanent_address TEXT,
    ADD COLUMN IF NOT EXISTS highest_qualification VARCHAR(50),
    ADD COLUMN IF NOT EXISTS basic_qualification VARCHAR(50),
    ADD COLUMN IF NOT EXISTS reporting_manager VARCHAR(100),
    ADD COLUMN IF NOT EXISTS location VARCHAR(100),
    ADD COLUMN IF NOT EXISTS employment_type VARCHAR(50),
    ADD COLUMN IF NOT EXISTS skill_type VARCHAR(50),
    ADD COLUMN IF NOT EXISTS zone VARCHAR(50),
    ADD COLUMN IF NOT EXISTS previous_company_1 VARCHAR(200),
    ADD COLUMN IF NOT EXISTS previous_role_1 VARCHAR(100),
    ADD COLUMN IF NOT EXISTS previous_years_1 INTEGER,
    ADD COLUMN IF NOT EXISTS previous_company_2 VARCHAR(200),
    ADD COLUMN IF NOT EXISTS previous_role_2 VARCHAR(100),
    ADD COLUMN IF NOT EXISTS previous_years_2 INTEGER,
    ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS branch_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS account_number VARCHAR(50),
    ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(20),
    ADD COLUMN IF NOT EXISTS nominee_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS emergency_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS emergency_phone VARCHAR(20),
    ADD COLUMN IF NOT EXISTS emergency_relationship VARCHAR(50),
    ADD COLUMN IF NOT EXISTS pan_number VARCHAR(20),
    ADD COLUMN IF NOT EXISTS aadhaar_number VARCHAR(20),
    ADD COLUMN IF NOT EXISTS pf_number VARCHAR(50),
    ADD COLUMN IF NOT EXISTS uan_number VARCHAR(50),
    ADD COLUMN IF NOT EXISTS esic_number VARCHAR(50),
    ADD COLUMN IF NOT EXISTS notes TEXT,
    ADD COLUMN IF NOT EXISTS basic_salary NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS gender VARCHAR(20)
  `);

  // 2. New Module Tables
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id SERIAL PRIMARY KEY,
      item_code VARCHAR(50) UNIQUE,
      item_name VARCHAR(255) NOT NULL,
      item_type VARCHAR(50),
      unit_of_measure VARCHAR(20),
      reorder_level NUMERIC(12,2) DEFAULT 0,
      current_stock NUMERIC(12,2) DEFAULT 0,
      standard_cost NUMERIC(12,2) DEFAULT 0,
      inventory_account_id INTEGER,
      expense_account_id INTEGER,
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      lead_source VARCHAR(100),
      company_name VARCHAR(255),
      contact_person VARCHAR(255),
      email VARCHAR(255),
      phone VARCHAR(50),
      industry VARCHAR(100),
      location VARCHAR(200),
      assigned_to INTEGER REFERENCES employees(id),
      status VARCHAR(50) DEFAULT 'New',
      value NUMERIC(12,2) DEFAULT 0,
      notes TEXT,
      created_by INTEGER,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS opportunities (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER REFERENCES leads(id),
      opportunity_name VARCHAR(255),
      expected_value NUMERIC(12,2) DEFAULT 0,
      probability_percentage INTEGER DEFAULT 0,
      expected_closing_date DATE,
      stage VARCHAR(50) DEFAULT 'Prospecting',
      assigned_to INTEGER REFERENCES employees(id),
      created_by INTEGER,
      notes TEXT,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER REFERENCES employees(id),
      leave_type VARCHAR(100),
      start_date DATE,
      end_date DATE,
      duration_days INTEGER,
      reason TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      manager_comment TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS holidays (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      date DATE NOT NULL,
      type VARCHAR(50) DEFAULT 'Optional',
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS travel_requests (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER REFERENCES employees(id),
      destination VARCHAR(255),
      purpose TEXT,
      from_date DATE,
      to_date DATE,
      budget NUMERIC(10,2) DEFAULT 0,
      estimated_amount NUMERIC(10,2) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'Pending',
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS timesheets (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER REFERENCES employees(id),
      week_start DATE NOT NULL,
      week_end DATE NOT NULL,
      status VARCHAR(50) DEFAULT 'draft',
      total_hours NUMERIC(5,2) DEFAULT 0,
      billable_hours NUMERIC(5,2) DEFAULT 0,
      submitted_at TIMESTAMP,
      approved_by INTEGER,
      approved_at TIMESTAMP,
      rejection_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (employee_id, week_start)
    );

    CREATE TABLE IF NOT EXISTS timesheet_entries (
      id SERIAL PRIMARY KEY,
      timesheet_id INTEGER REFERENCES timesheets(id) ON DELETE CASCADE,
      entry_date DATE NOT NULL,
      project_name VARCHAR(255),
      task_description TEXT,
      hours NUMERIC(4,2) DEFAULT 0,
      billable BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id SERIAL PRIMARY KEY,
      complaint_number VARCHAR(30) UNIQUE,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      customer_name VARCHAR(255) NOT NULL,
      customer_email VARCHAR(255),
      customer_phone VARCHAR(50),
      category VARCHAR(100) DEFAULT 'General',
      priority VARCHAR(20) DEFAULT 'Medium',
      status VARCHAR(30) DEFAULT 'open',
      assigned_to_name VARCHAR(255),
      resolved_at TIMESTAMP,
      created_by INTEGER,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS complaint_history (
      id SERIAL PRIMARY KEY,
      complaint_id INTEGER REFERENCES complaints(id) ON DELETE CASCADE,
      from_status VARCHAR(30),
      to_status VARCHAR(30),
      comment TEXT,
      changed_by_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      check_in VARCHAR(10),
      check_out VARCHAR(10),
      status VARCHAR(30) DEFAULT 'Present',
      work_hours NUMERIC(5,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(employee_id, date)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      project_code VARCHAR(50) UNIQUE,
      project_name VARCHAR(255) NOT NULL,
      customer_name VARCHAR(255),
      manager_name VARCHAR(255),
      status VARCHAR(50) DEFAULT 'planning',
      budget_amount NUMERIC(12,2) DEFAULT 0,
      actual_cost NUMERIC(12,2) DEFAULT 0,
      total_tasks INTEGER DEFAULT 0,
      completed_tasks INTEGER DEFAULT 0,
      start_date DATE,
      end_date DATE,
      team_size INTEGER DEFAULT 1,
      description TEXT,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id SERIAL PRIMARY KEY,
      ticket_number VARCHAR(30) UNIQUE,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(100) DEFAULT 'General',
      priority VARCHAR(20) DEFAULT 'Medium',
      status VARCHAR(30) DEFAULT 'Open',
      team VARCHAR(100),
      assigned_to VARCHAR(255),
      requester_name VARCHAR(255),
      requester_email VARCHAR(255),
      resolved_at TIMESTAMP,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticket_comments (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
      author VARCHAR(255),
      body TEXT,
      is_internal BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      title VARCHAR(255) NOT NULL,
      message TEXT,
      module_name VARCHAR(100),
      reference_id INTEGER,
      notification_type VARCHAR(50) DEFAULT 'info',
      is_read BOOLEAN DEFAULT false,
      read_at TIMESTAMP,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id               SERIAL PRIMARY KEY,
      name             VARCHAR(255) NOT NULL,
      email            VARCHAR(255) UNIQUE NOT NULL,
      password_hash    VARCHAR(255) NOT NULL,
      role             VARCHAR(50)  DEFAULT 'employee',
      department       VARCHAR(100),
      employee_id      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      is_active        BOOLEAN DEFAULT TRUE,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_at       TIMESTAMP DEFAULT NOW()
    );
  `);
  
  // 3. Indexes
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_timesheets_employee ON timesheets(employee_id);
    CREATE INDEX IF NOT EXISTS idx_timesheets_week     ON timesheets(week_start);
    CREATE INDEX IF NOT EXISTS idx_timesheet_entries   ON timesheet_entries(timesheet_id);
    CREATE INDEX IF NOT EXISTS idx_complaints_status   ON complaints(status);
    CREATE INDEX IF NOT EXISTS idx_complaints_customer ON complaints(customer_name);
    CREATE INDEX IF NOT EXISTS idx_complaint_history   ON complaint_history(complaint_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_emp_date ON attendance(employee_id, date);
    CREATE INDEX IF NOT EXISTS idx_attendance_date     ON attendance(date);
    CREATE INDEX IF NOT EXISTS idx_projects_status     ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status   ON support_tickets(status);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets(priority);
    CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket   ON ticket_comments(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user    ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_employees_status     ON employees(status);
    CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
    CREATE INDEX IF NOT EXISTS idx_leave_requests_emp   ON leave_requests(employee_id);
    CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_status      ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_crm_leads_status     ON leads(status);
  `);
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  // Not rolling back baseline schema in this context
}
