/**
 * 20260531000001_users_2fa_columns.js
 *
 * Adds two_fa_enabled and totp_secret to the users table.
 * These columns are referenced by security.routes.js and admin.routes.js
 * but were never formally migrated, causing the /admin/users query to fail
 * silently and return [] (making all user KPI counts show 0).
 *
 * Also adds logout_at (needed by auth.middleware.js) and company_id (for
 * future multi-tenant scoping) in case they are missing on this install.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS two_fa_enabled BOOLEAN      DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS totp_secret    VARCHAR(255) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS logout_at      TIMESTAMPTZ  DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS company_id     INTEGER      DEFAULT NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id)
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS two_fa_enabled,
      DROP COLUMN IF EXISTS totp_secret,
      DROP COLUMN IF EXISTS logout_at,
      DROP COLUMN IF EXISTS company_id
  `);
}
