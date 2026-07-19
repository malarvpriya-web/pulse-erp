/**
 * Roles become many-to-many.
 *
 * Until now `users.role` was a single VARCHAR and the `roles` table was just a
 * registry whose `code` had to string-match it (see the comment in
 * 20260428000001_platform_foundation.js). One member could hold exactly one
 * role, so every gate in the app — allowRoles(), requirePermission(),
 * home.service.js's `isEmployee` fork — was an exact match on one string.
 *
 * This adds `user_roles` as the real assignment table:
 *   user_roles(user_id, role_id, company_id, is_primary)
 *
 * `users.role` is deliberately KEPT and now means "primary role". It is still
 * read by old JWTs, by mint-token.js, and by a long tail of reporting queries,
 * so dropping it would be a much wider blast radius than this change needs.
 * The invariant from here on: users.role always equals the code of the
 * user_roles row with is_primary = true. admin.routes.js maintains both sides.
 *
 * Also registers `department_head`, which 3 live users held despite it being
 * absent from `roles` entirely (so it had zero role_permissions rows and fell
 * through every allowRoles list while still getting the full management
 * dashboard). It inherits the `manager` permission matrix.
 *
 * company_id on the junction is the BUG 1 scoping dimension: a role assignment
 * belongs to the company it was granted in and must not leak across companies.
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT user_roles_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT user_roles_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT user_roles_sp');
      console.warn(`[user_roles_junction] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // ── 1. Registry gaps ────────────────────────────────────────────────────────
  // roles.role_name is NOT NULL on older installs; label is the newer column.
  // Write both so this works regardless of which migration created the table.
  await safe('register department_head', `
    INSERT INTO roles (code, role_name, label, description, is_active, company_id)
    SELECT 'department_head', 'Department Head', 'Department Head',
           'Heads a department — manager-tier access across their function',
           TRUE,
           (SELECT company_id FROM roles WHERE code = 'manager' LIMIT 1)
    WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'department_head')
  `);

  // department_head inherits manager's matrix rather than inventing one.
  await safe('clone manager permissions to department_head', `
    INSERT INTO role_permissions
      (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
    SELECT dh.id, rp.module, rp.can_view, rp.can_add, rp.can_edit,
           rp.can_delete, rp.can_approve, rp.can_export
      FROM role_permissions rp
      JOIN roles m  ON m.id = rp.role_id AND m.code = 'manager'
      CROSS JOIN roles dh
     WHERE dh.code = 'department_head'
    ON CONFLICT (role_id, module) DO NOTHING
  `);

  // ── 2. The junction table ───────────────────────────────────────────────────
  await safe('create user_roles', `
    CREATE TABLE IF NOT EXISTS user_roles (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      company_id INTEGER,
      is_primary BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by INTEGER,
      UNIQUE (user_id, role_id)
    )
  `);

  await safe('idx user_roles.user_id',    `CREATE INDEX IF NOT EXISTS idx_user_roles_user    ON user_roles(user_id)`);
  await safe('idx user_roles.role_id',    `CREATE INDEX IF NOT EXISTS idx_user_roles_role    ON user_roles(role_id)`);
  await safe('idx user_roles.company_id', `CREATE INDEX IF NOT EXISTS idx_user_roles_company ON user_roles(company_id)`);

  // At most one primary role per user — this is what keeps users.role coherent.
  await safe('one primary role per user', `
    CREATE UNIQUE INDEX IF NOT EXISTS user_roles_one_primary_uidx
      ON user_roles(user_id) WHERE is_primary
  `);

  // ── 3. Backfill from users.role ─────────────────────────────────────────────
  // Matched case-insensitively: users.role is free text and has drifted before.
  await safe('backfill user_roles from users.role', `
    INSERT INTO user_roles (user_id, role_id, company_id, is_primary)
    SELECT u.id, r.id, u.company_id, TRUE
      FROM users u
      JOIN roles r ON LOWER(r.code) = LOWER(u.role)
     WHERE u.role IS NOT NULL AND TRIM(u.role) <> ''
    ON CONFLICT (user_id, role_id) DO NOTHING
  `);

  // Any users.role that matches no registry code would silently lose its
  // assignment above. Surface it loudly instead of dropping it on the floor.
  const { rows: orphans } = await knex.raw(`
    SELECT u.role, COUNT(*) AS n
      FROM users u
      LEFT JOIN roles r ON LOWER(r.code) = LOWER(u.role)
     WHERE u.role IS NOT NULL AND TRIM(u.role) <> '' AND r.id IS NULL
     GROUP BY u.role
  `);
  if (orphans?.length) {
    for (const o of orphans) {
      console.warn(`[user_roles_junction] WARNING: users.role='${o.role}' (${o.n} user(s)) matches no roles.code — no user_roles row created. Register the role, then re-run.`);
    }
  }
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS user_roles`).catch(() => {});
  await knex.raw(`
    DELETE FROM role_permissions
     WHERE role_id IN (SELECT id FROM roles WHERE code = 'department_head')
  `).catch(() => {});
  await knex.raw(`DELETE FROM roles WHERE code = 'department_head'`).catch(() => {});
}
