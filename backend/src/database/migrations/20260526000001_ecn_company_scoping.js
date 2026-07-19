/**
 * 20260526000001_ecn_company_scoping.js
 *
 * Adds company_id to engineering_changes for multi-tenant scoping.
 * Also adds updated_at to employees if it was created without it (initDb.js path).
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE engineering_changes
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_engineering_changes_company ON engineering_changes(company_id);
  `);

  await knex.raw(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);

  // Ensure leaves table has start_date/end_date (some deployments used from_date/to_date)
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'leaves' AND column_name = 'from_date'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'leaves' AND column_name = 'start_date'
      ) THEN
        ALTER TABLE leaves ADD COLUMN start_date DATE;
        ALTER TABLE leaves ADD COLUMN end_date DATE;
        UPDATE leaves SET start_date = from_date, end_date = to_date;
      END IF;
    END $$
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_engineering_changes_company`);
  await knex.raw(`ALTER TABLE engineering_changes DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS updated_at`);
}
