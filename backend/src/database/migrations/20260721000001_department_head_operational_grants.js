/**
 * 20260721000001_department_head_operational_grants.js
 *
 * `department_head` was registered in [20260716000009_user_roles_junction.js]
 * as "manager-tier access across their function" and clones `manager`'s
 * permission matrix — but that clone ran AFTER manager's out-of-domain modules
 * were hard-revoked in [20260708000002_tighten_manager_hr_permissions.js], so
 * department_head inherited explicit DENY rows (all-false) on inventory,
 * production, servicedesk and procurement. That's backwards for the one role
 * meant to cover an operational team lead (warehouse/production/service) who
 * has no other menu path into their own function's modules.
 *
 * Grants VAEPX (view/add/edit/approve/export, no delete) — the same shape
 * `manager` already holds on its own in-domain 'projects' module — rather than
 * cloning a domain manager's FULL grant, since department_head is a coarse
 * role that may cover any function, not a specialized operator.
 *
 * UPDATE not INSERT: the 07-16 clone already created these rows as denies, so
 * ON CONFLICT DO NOTHING (the usual gap-filler pattern) would no-op here.
 */
const MODULES = ['inventory', 'production', 'servicedesk', 'procurement'];

export async function up(knex) {
  await knex.raw(
    `UPDATE role_permissions
        SET can_view = true, can_add = true, can_edit = true,
            can_approve = true, can_export = true
      WHERE module = ANY($1)
        AND role_id IN (SELECT id FROM roles WHERE code = 'department_head')`,
    [MODULES]
  );
}

export async function down(knex) {
  await knex.raw(
    `UPDATE role_permissions
        SET can_view = false, can_add = false, can_edit = false,
            can_approve = false, can_export = false
      WHERE module = ANY($1)
        AND role_id IN (SELECT id FROM roles WHERE code = 'department_head')`,
    [MODULES]
  );
}
