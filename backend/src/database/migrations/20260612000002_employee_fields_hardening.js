/**
 * Employee fields hardening — adds:
 * branch_id FK, passport_number, driving_license_number, notice_period_days
 * Also adds indexes for new fields and backfills reporting_manager_id from org_relationships.
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT emp_fields_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT emp_fields_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT emp_fields_sp');
      console.warn(`[employee_fields_hardening] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // New columns on employees
  await safe('branch_id', `ALTER TABLE employees ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL`);
  await safe('passport_number', `ALTER TABLE employees ADD COLUMN IF NOT EXISTS passport_number VARCHAR(20)`);
  await safe('driving_license_number', `ALTER TABLE employees ADD COLUMN IF NOT EXISTS driving_license_number VARCHAR(30)`);
  await safe('notice_period_days', `ALTER TABLE employees ADD COLUMN IF NOT EXISTS notice_period_days INTEGER`);

  // Indexes
  await safe('idx branch_id', `CREATE INDEX IF NOT EXISTS idx_employees_branch_id ON employees(branch_id)`);
  await safe('idx passport_number', `CREATE INDEX IF NOT EXISTS idx_employees_passport_number ON employees(passport_number) WHERE passport_number IS NOT NULL`);

  // Backfill reporting_manager_id from org_relationships where it is still NULL
  await safe('backfill reporting_manager_id', `
    UPDATE employees e
    SET reporting_manager_id = org.manager_id
    FROM org_relationships org
    WHERE org.employee_id = e.id
      AND e.reporting_manager_id IS NULL
      AND org.manager_id IS NOT NULL
  `);

  // Sync reporting_manager VARCHAR from reporting_manager_id where they diverge
  await safe('sync reporting_manager name', `
    UPDATE employees e
    SET reporting_manager = TRIM(m.first_name || ' ' || COALESCE(m.last_name, ''))
    FROM employees m
    WHERE m.id = e.reporting_manager_id
      AND e.reporting_manager_id IS NOT NULL
      AND (e.reporting_manager IS NULL OR e.reporting_manager = '')
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS branch_id`).catch(() => {});
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS passport_number`).catch(() => {});
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS driving_license_number`).catch(() => {});
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS notice_period_days`).catch(() => {});
}
