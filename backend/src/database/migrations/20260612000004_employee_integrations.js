/**
 * Employee integrations hardening:
 * 1. project_members table — formal Employee → Project assignment
 * 2. complaints.assigned_to_id FK — replaces text-only assigned_to_name
 * 3. Indexes for new tables
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT emp_integrations_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT emp_integrations_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT emp_integrations_sp');
      console.warn(`[employee_integrations] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // Project members — formal assignment
  await safe('project_members', `
    CREATE TABLE IF NOT EXISTS project_members (
      id                  SERIAL       PRIMARY KEY,
      company_id          INTEGER      REFERENCES companies(id) ON DELETE CASCADE,
      project_id          INTEGER      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      employee_id         INTEGER      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      role_in_project     VARCHAR(100) NOT NULL DEFAULT 'Member',
      allocation_pct      NUMERIC(5,2) NOT NULL DEFAULT 100
                            CHECK (allocation_pct > 0 AND allocation_pct <= 100),
      billing_rate        NUMERIC(12,2),
      start_date          DATE,
      end_date            DATE,
      is_billable         BOOLEAN      NOT NULL DEFAULT true,
      notes               TEXT,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, employee_id)
    )
  `);

  await safe('idx project_members employee', `CREATE INDEX IF NOT EXISTS idx_project_members_employee ON project_members(employee_id)`);
  await safe('idx project_members project',  `CREATE INDEX IF NOT EXISTS idx_project_members_project  ON project_members(project_id)`);
  await safe('idx project_members company',  `CREATE INDEX IF NOT EXISTS idx_project_members_company  ON project_members(company_id)`);

  // Add assigned_to_id (employee FK) to complaints — keeps assigned_to_name for legacy display
  await safe('complaints assigned_to_id', `ALTER TABLE complaints ADD COLUMN IF NOT EXISTS assigned_to_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await safe('idx complaints assigned_to_id', `CREATE INDEX IF NOT EXISTS idx_complaints_assigned_to_id ON complaints(assigned_to_id) WHERE assigned_to_id IS NOT NULL`);

  // company_settings: probation_period_days setting (defaults to 90)
  await safe('company_settings probation_period_days', `
    INSERT INTO company_settings (key, value, label, description, type, module)
    VALUES (
      'probation_period_days', '90',
      'Default Probation Period (Days)',
      'Number of days for the standard employee probation period. Used when adding new employees.',
      'number',
      'hr'
    )
    ON CONFLICT (key) DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS project_members CASCADE`).catch(() => {});
  await knex.raw(`ALTER TABLE complaints DROP COLUMN IF EXISTS assigned_to_id`).catch(() => {});
}
