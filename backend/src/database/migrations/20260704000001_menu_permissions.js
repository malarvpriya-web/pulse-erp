/**
 * Menu / Page Access Control
 *
 * Backs the "Access Control → Page Access" admin screen. Stores, per company +
 * role + registry module id, whether that page/section is Hidden, View-only or
 * Editable. These rows are OVERRIDES layered on top of the hardcoded module
 * registry: when a row exists it wins, otherwise the app falls back to the
 * built-in role defaults (so nothing changes until an admin configures it).
 *
 *   access_level:
 *     'hidden' → page not shown in the sidebar and route is blocked
 *     'view'   → page visible, read-only (edit/add/delete suppressed)
 *     'edit'   → page visible and fully editable
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS + IF NOT EXISTS indexes.
 */

export async function up(knex) {
  const db = knex.raw ? { query: (sql, b) => knex.raw(sql, b) } : knex;

  await db.query(`
    CREATE TABLE IF NOT EXISTS menu_permissions (
      id           SERIAL PRIMARY KEY,
      company_id   INT         NOT NULL,
      role_code    VARCHAR(50) NOT NULL,
      module_id    VARCHAR(80) NOT NULL,
      access_level VARCHAR(10) NOT NULL DEFAULT 'view'
                   CHECK (access_level IN ('hidden','view','edit')),
      updated_by   INT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, role_code, module_id)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_menu_permissions_lookup
      ON menu_permissions (company_id, role_code)
  `);

  console.log('[migration 20260704000001] menu_permissions table ready.');
}

export async function down(knex) {
  const db = knex.raw ? { query: (sql, b) => knex.raw(sql, b) } : knex;
  await db.query(`DROP TABLE IF EXISTS menu_permissions`);
}
