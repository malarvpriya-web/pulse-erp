/**
 * Phase 46 addendum — Add company_id to announcements for multi-tenant isolation.
 * Safe to run on existing data: column is nullable, no backfill required.
 *
 * Uses knex.raw() (the shim provided by the migration runner).
 * Index is non-CONCURRENTLY because CONCURRENTLY cannot run inside a transaction.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS company_id INTEGER;
    CREATE INDEX IF NOT EXISTS idx_announcements_company_active
      ON announcements(company_id, is_active, to_date);
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_announcements_company_active;
    ALTER TABLE announcements DROP COLUMN IF EXISTS company_id;
  `);
}
