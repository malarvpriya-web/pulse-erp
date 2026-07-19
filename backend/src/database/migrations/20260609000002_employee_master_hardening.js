/**
 * Employee master hardening — adds missing HR columns:
 * confirmation_date, probation_end_date, grade, band, work_centre_id
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT emp_hard_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT emp_hard_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT emp_hard_sp');
      console.warn(`[employee_master_hardening] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  await safe('confirmation_date', `ALTER TABLE employees ADD COLUMN IF NOT EXISTS confirmation_date DATE`);
  await safe('probation_end_date', `ALTER TABLE employees ADD COLUMN IF NOT EXISTS probation_end_date DATE`);
  await safe('grade', `ALTER TABLE employees ADD COLUMN IF NOT EXISTS grade VARCHAR(50)`);
  await safe('band', `ALTER TABLE employees ADD COLUMN IF NOT EXISTS band VARCHAR(50)`);
  await safe('work_centre_id', `ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_centre_id INTEGER`);

  // Backfill probation_end_date for active probation employees (joining_date + 90 days default)
  await safe('backfill probation_end_date', `
    UPDATE employees
    SET probation_end_date = joining_date + INTERVAL '90 days'
    WHERE probation_end_date IS NULL
      AND joining_date IS NOT NULL
      AND LOWER(status) IN ('probation','active')
  `);

  // Auto-set confirmation_date from probation_end_date for confirmed employees
  await safe('backfill confirmation_date', `
    UPDATE employees
    SET confirmation_date = probation_end_date
    WHERE confirmation_date IS NULL
      AND probation_end_date IS NOT NULL
      AND LOWER(status) = 'active'
  `);

  await safe('idx employees grade', `CREATE INDEX IF NOT EXISTS idx_employees_grade ON employees(grade)`);
  await safe('idx employees band',  `CREATE INDEX IF NOT EXISTS idx_employees_band  ON employees(band)`);
  await safe('idx employees work_centre_id', `CREATE INDEX IF NOT EXISTS idx_employees_work_centre_id ON employees(work_centre_id)`);

  // master_grades table for MasterSetup
  await safe('master_grades', `
    CREATE TABLE IF NOT EXISTS master_grades (
      id         SERIAL       PRIMARY KEY,
      name       VARCHAR(100) NOT NULL UNIQUE,
      company_id INTEGER      REFERENCES companies(id),
      is_active  BOOLEAN      NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  // master_bands table for MasterSetup
  await safe('master_bands', `
    CREATE TABLE IF NOT EXISTS master_bands (
      id         SERIAL       PRIMARY KEY,
      name       VARCHAR(100) NOT NULL UNIQUE,
      company_id INTEGER      REFERENCES companies(id),
      is_active  BOOLEAN      NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS confirmation_date`).catch(() => {});
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS probation_end_date`).catch(() => {});
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS grade`).catch(() => {});
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS band`).catch(() => {});
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS work_centre_id`).catch(() => {});
  await knex.raw(`DROP TABLE IF EXISTS master_grades`).catch(() => {});
  await knex.raw(`DROP TABLE IF EXISTS master_bands`).catch(() => {});
}
