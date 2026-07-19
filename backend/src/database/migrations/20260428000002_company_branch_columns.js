/**
 * 20260428000002_company_branch_columns.js
 *
 * Phase 1 – Multi-company / branch scoping
 * Adds nullable company_id + branch_id to all core transactional tables.
 * All adds use IF NOT EXISTS — completely safe on existing data.
 * Indexes are created for query performance on scope-filtered reads.
 */

export async function up(knex) {

  // ── users ────────────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
    CREATE INDEX IF NOT EXISTS idx_users_branch  ON users(branch_id);
  `);

  // ── employees ────────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id);
    CREATE INDEX IF NOT EXISTS idx_employees_branch  ON employees(branch_id);
  `);

  // ── projects ─────────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id);
    CREATE INDEX IF NOT EXISTS idx_projects_branch  ON projects(branch_id);
  `);

  // ── leads ────────────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company_id);
    CREATE INDEX IF NOT EXISTS idx_leads_branch  ON leads(branch_id);
  `);

  // ── opportunities ─────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE opportunities
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_opportunities_company ON opportunities(company_id);
    CREATE INDEX IF NOT EXISTS idx_opportunities_branch  ON opportunities(branch_id);
  `);

  // ── complaints ───────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE complaints
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_complaints_company ON complaints(company_id);
    CREATE INDEX IF NOT EXISTS idx_complaints_branch  ON complaints(branch_id);
  `);

  // ── support_tickets ───────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE support_tickets
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_support_tickets_company ON support_tickets(company_id);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_branch  ON support_tickets(branch_id);
  `);

  // ── timesheets + timesheet_entries ────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE timesheets
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_timesheets_company ON timesheets(company_id);

    ALTER TABLE timesheet_entries
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_timesheet_entries_company ON timesheet_entries(company_id);
  `);

  // ── leave_requests ────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE leave_requests
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_leave_requests_company ON leave_requests(company_id);
  `);

  // ── leave_applications (separate table from leave_requests) ──────────────────
  await knex.raw(`
    ALTER TABLE leave_applications
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_leave_applications_company ON leave_applications(company_id);
  `);

  // ── inventory_items ───────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_inventory_items_company ON inventory_items(company_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_items_branch  ON inventory_items(branch_id);
  `);

  // ── purchase_orders ───────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE purchase_orders
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_company ON purchase_orders(company_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_branch  ON purchase_orders(branch_id);
  `);

  // ── purchase_requests ─────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE purchase_requests
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id)  ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_purchase_requests_company ON purchase_requests(company_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_requests_branch  ON purchase_requests(branch_id);
  `);
}

export async function down(knex) {
  // Remove indexes and columns in reverse order
  const tables = [
    'purchase_requests','purchase_orders','inventory_items',
    'leave_applications','leave_requests','timesheet_entries','timesheets',
    'support_tickets','complaints','opportunities','leads','projects',
    'employees','users',
  ];
  for (const t of tables) {
    await knex.raw(`
      ALTER TABLE ${t}
        DROP COLUMN IF EXISTS company_id,
        DROP COLUMN IF EXISTS branch_id
    `).catch(() => {}); // skip if table doesn't exist in test env
  }
}
