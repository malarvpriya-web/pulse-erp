/**
 * Role Access Alignment — backs the `finance` role that the UI already offers
 *
 * The role picker (RolesSetup / UserSetup) lets admins assign `finance`, but no
 * migration ever created that role or its permissions — so a `finance` user got
 * an empty permission set (deny-all defaults) and the Finance menu was actually
 * hidden from them while unrelated menus leaked through the sidebar fall-through.
 *
 * This migration:
 *   1. Ensures the `finance` role exists in `roles`.
 *   2. Seeds `role_permissions` for it, scoped to the finance domain only,
 *      using the SAME module keys the frontend checks (finance, reports, …).
 *
 * Idempotent: ON CONFLICT DO UPDATE everywhere.
 *
 * NOTE: frontend menu/route visibility for finance (and manager/hr/employee) is
 * governed by ROLE_SECTION_ALLOWLIST in frontend/src/config/menuCatalog.js.
 * Keep the two in sync when a role's domain changes.
 */

export async function up(knex) {
  // 1. Ensure the finance role exists (older installs seeded only 5 roles and
  //    Phase 42 seeded granular codes — neither created a plain `finance`).
  await knex.raw(`
    INSERT INTO roles (role_name, code, is_active)
    VALUES ('Finance', 'finance', true)
    ON CONFLICT (code) DO NOTHING
  `);

  // 2. Seed finance permissions. Columns: view, add, edit, delete, approve, export
  //    Finance domain: full CRUD on finance (no destructive delete), report
  //    export, payment approval, and read-only supporting access.
  const perms = [
    // module        view   add    edit   del    appr   export
    ['finance',      true,  true,  true,  false, true,  true ],
    ['reports',      true,  false, false, false, false, true ],
    ['dashboard',    true,  false, false, false, false, false],
    ['notifications',true,  false, false, false, false, false],
    ['approvals',    true,  false, false, false, true,  false],
    ['documents',    true,  false, false, false, false, false],
  ];

  for (const [module, v, a, e, d, ap, ex] of perms) {
    await knex.raw(
      `INSERT INTO role_permissions
         (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
       SELECT r.id, $1, $2, $3, $4, $5, $6, $7
         FROM roles r WHERE r.code = 'finance'
       ON CONFLICT (role_id, module)
       DO UPDATE SET can_view = EXCLUDED.can_view, can_add = EXCLUDED.can_add,
                     can_edit = EXCLUDED.can_edit, can_delete = EXCLUDED.can_delete,
                     can_approve = EXCLUDED.can_approve, can_export = EXCLUDED.can_export`,
      [module, v, a, e, d, ap, ex]
    );
  }

  console.log('[migration 20260708000001] finance role + permissions seeded.');
}

export async function down(knex) {
  await knex.raw(`
    DELETE FROM role_permissions
     WHERE role_id = (SELECT id FROM roles WHERE code = 'finance')
  `);
  // Leave the role row in place — dropping it could orphan assigned users.
}
