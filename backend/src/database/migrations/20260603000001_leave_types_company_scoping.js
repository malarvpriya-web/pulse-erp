/**
 * Add company_id to leave_types so each tenant's leave catalogue is isolated.
 *
 * Strategy:
 *  - company_id IS NULL  → global / seed type (visible to every company)
 *  - company_id NOT NULL → tenant-specific type (visible only to that company)
 *
 * After this migration the GET /types route returns:
 *   WHERE is_active = true AND (company_id IS NULL OR company_id = $tenantId)
 *
 * Cleanup: soft-delete obviously junk entries (name < 2 printable chars,
 * or name that contains only digits/special characters like "te1").
 * Non-standard types that already exist are pinned to the first company so
 * they stop leaking across tenants.
 */
export async function up(knex) {
  // 1. Add company_id column (nullable → FK)
  await knex.raw(`
    ALTER TABLE leave_types
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE
  `);

  // 2. Soft-delete junk entries — names that are clearly test / garbage:
  //    • shorter than 2 real characters
  //    • do not contain at least one ASCII letter
  await knex.raw(`
    UPDATE leave_types
    SET is_active = false, deleted_at = NOW()
    WHERE deleted_at IS NULL
      AND (
        LENGTH(TRIM(leave_name)) < 2
        OR leave_name !~ '[A-Za-z]'
      )
  `);

  // 3. Pin non-standard types to the first company so they stop being global.
  //    Standard seed names remain NULL (global) and visible everywhere.
  await knex.raw(`
    UPDATE leave_types
    SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1)
    WHERE company_id IS NULL
      AND deleted_at IS NULL
      AND LOWER(TRIM(leave_name)) NOT IN (
        'annual leave', 'sick leave', 'casual leave',
        'compensatory leave', 'compensatory off', 'comp off',
        'maternity leave', 'paternity leave',
        'earned leave', 'privilege leave', 'unpaid leave',
        'bereavement leave', 'study leave'
      )
  `);

  // 4. Drop the old blanket UNIQUE constraints that block per-company duplicates
  await knex.raw(`ALTER TABLE leave_types DROP CONSTRAINT IF EXISTS leave_types_leave_name_key`);
  await knex.raw(`ALTER TABLE leave_types DROP CONSTRAINT IF EXISTS leave_types_leave_code_key`);

  // 5. Partial unique index — global types unique by name
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS leave_types_global_name_uidx
    ON leave_types (LOWER(leave_name))
    WHERE company_id IS NULL AND deleted_at IS NULL
  `);

  // 6. Partial unique index — per-company types unique by (name, company)
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS leave_types_company_name_uidx
    ON leave_types (LOWER(leave_name), company_id)
    WHERE company_id IS NOT NULL AND deleted_at IS NULL
  `);

  // 7. Add name-format check constraint (idempotent via DO block)
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'leave_types' AND constraint_name = 'leave_types_name_format'
      ) THEN
        ALTER TABLE leave_types
          ADD CONSTRAINT leave_types_name_format
          CHECK (LENGTH(TRIM(leave_name)) >= 2 AND leave_name ~ '[A-Za-z]');
      END IF;
    END $$
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE leave_types DROP CONSTRAINT IF EXISTS leave_types_name_format`);
  await knex.raw(`DROP INDEX IF EXISTS leave_types_company_name_uidx`);
  await knex.raw(`DROP INDEX IF EXISTS leave_types_global_name_uidx`);
  await knex.raw(`
    ALTER TABLE leave_types
      ADD CONSTRAINT leave_types_leave_name_key UNIQUE (leave_name)
  `);
  await knex.raw(`ALTER TABLE leave_types DROP COLUMN IF EXISTS company_id`);
}
