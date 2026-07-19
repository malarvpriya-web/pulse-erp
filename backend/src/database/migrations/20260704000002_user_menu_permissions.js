/**
 * Per-employee Page Access overrides.
 *
 * Layers on top of the role-level menu_permissions: for a single user, an admin
 * can override individual sections. Resolution order for a logged-in user:
 *   user override > role override > built-in registry default.
 *
 *   access_level: 'hidden' | 'view' | 'edit'   (absence = inherit from role)
 *
 * Idempotent.
 */

export async function up(knex) {
  const db = knex.raw ? { query: (sql, b) => knex.raw(sql, b) } : knex;

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_menu_permissions (
      id           SERIAL PRIMARY KEY,
      company_id   INT         NOT NULL,
      user_id      INT         NOT NULL,
      module_id    VARCHAR(80) NOT NULL,
      access_level VARCHAR(10) NOT NULL DEFAULT 'view'
                   CHECK (access_level IN ('hidden','view','edit')),
      updated_by   INT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, user_id, module_id)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_user_menu_permissions_lookup
      ON user_menu_permissions (company_id, user_id)
  `);

  console.log('[migration 20260704000002] user_menu_permissions table ready.');
}

export async function down(knex) {
  const db = knex.raw ? { query: (sql, b) => knex.raw(sql, b) } : knex;
  await db.query(`DROP TABLE IF EXISTS user_menu_permissions`);
}
