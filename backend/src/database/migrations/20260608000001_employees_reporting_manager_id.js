export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT emp_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT emp_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT emp_sp');
      console.warn(`[employees_reporting_manager_id] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  await safe('add reporting_manager_id column', `
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS reporting_manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL
  `);

  await safe('backfill reporting_manager_id', `
    UPDATE employees e
    SET reporting_manager_id = m.id
    FROM employees m
    WHERE e.reporting_manager_id IS NULL
      AND e.reporting_manager IS NOT NULL
      AND e.reporting_manager != ''
      AND LOWER(TRIM(m.first_name || ' ' || COALESCE(m.last_name, '')))
          = LOWER(TRIM(e.reporting_manager))
      AND m.deleted_at IS NULL
      AND LOWER(m.status) IN ('active', 'probation')
  `);

  await safe('idx employees reporting_manager_id', `
    CREATE INDEX IF NOT EXISTS idx_employees_reporting_manager_id
      ON employees(reporting_manager_id)
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS reporting_manager_id`).catch(() => {});
}
