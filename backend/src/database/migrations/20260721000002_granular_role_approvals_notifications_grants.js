/**
 * 20260721000002_granular_role_approvals_notifications_grants.js
 *
 * [20260529000001_phase42_security_roles.js]'s `modules` list never included
 * 'approvals' or 'notifications', so none of the 18 non-employee granular
 * Phase-42 roles (hr_manager … service_engineer) hold a role_permissions row
 * for either module. Sidebar.jsx's top-level Approvals/Notifications NAV_ITEMS
 * now carry `module: 'approvals'` / `module: 'notifications'` (previously
 * unset, which hid them unconditionally for every non-allowlisted role — see
 * routes.jsx), and its fallback gate is `hasPermission(item.module, 'view')`.
 * With no row at all, hasPermission returns false, so every granular role was
 * silently locked out of both — reported first for procurement_manager, who
 * is in APPROVER_ROLES [approvals.authz.js] but had no in-app way to reach the
 * approval queue the backend already treats them as owning.
 *
 * Grants mirror the existing 6-role baseline (baseline-data.sql roles 3/4/45
 * manager/hr/department_head vs role 5 employee):
 *   - approvals:     APPROVER_ROLES members get VAEP (view/add/edit/approve),
 *                     matching manager/hr/department_head. Non-approver
 *                     exec/engineer grades get VA (view/submit own requests,
 *                     matching employee) — they show up in the nav so they can
 *                     track requests they raised, but cannot approve anything;
 *                     that authority is unchanged, enforced separately by
 *                     approvals.authz.js's APPROVER_ROLES allowlist.
 *   - notifications:  manager-tier gets VAE (matches manager/department_head),
 *                     exec/engineer-tier gets V-only (matches employee/hr/
 *                     finance) — nobody needs more than their own feed.
 *
 * INSERT ON CONFLICT DO NOTHING: these rows don't exist yet for any of the 18
 * roles (confirmed against baseline-data.sql), so this only fills gaps and
 * can never overwrite a decision made later in the Page Access UI.
 */
const APPROVER_TIER = [
  'hr_manager', 'finance_manager', 'payroll_admin', 'procurement_manager',
  'production_manager', 'qc_manager', 'project_manager', 'sales_manager',
  'service_manager',
];

const EXEC_TIER = [
  'hr_exec', 'accounts_exec', 'procurement_exec', 'store_keeper',
  'production_engineer', 'qc_engineer', 'design_engineer', 'sales_exec',
  'service_engineer',
];

// can_view, can_add, can_edit, can_delete, can_approve, can_export
const VAEP = [true, true, true, false, true, false];
const VA   = [true, true, false, false, false, false];
const VAE  = [true, true, true, false, false, false];
const V    = [true, false, false, false, false, false];

async function grant(knex, roleCode, module, [v, a, e, d, ap, ex]) {
  await knex.raw(
    `INSERT INTO role_permissions
       (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
     SELECT r.id, $2, $3, $4, $5, $6, $7, $8
       FROM roles r WHERE r.code = $1
     ON CONFLICT (role_id, module) DO NOTHING`,
    [roleCode, module, v, a, e, d, ap, ex]
  );
}

export async function up(knex) {
  for (const role of APPROVER_TIER) {
    await grant(knex, role, 'approvals', VAEP);
    await grant(knex, role, 'notifications', VAE);
  }
  for (const role of EXEC_TIER) {
    await grant(knex, role, 'approvals', VA);
    await grant(knex, role, 'notifications', V);
  }
}

export async function down(knex) {
  const roles = [...APPROVER_TIER, ...EXEC_TIER];
  await knex.raw(
    `DELETE FROM role_permissions
      WHERE module = ANY($1)
        AND role_id IN (SELECT id FROM roles WHERE code = ANY($2))`,
    [['approvals', 'notifications'], roles]
  );
}
