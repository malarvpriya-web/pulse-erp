/**
 * Tighten manager / hr role_permissions to their domain (API-level isolation)
 *
 * platform_foundation (20260428000001) seeded `manager` with can_view=true on
 * EVERY module and `hr` with can_view=true on all-but-admin. The frontend now
 * gates the sidebar/routes to each role's domain (ROLE_SECTION_ALLOWLIST in
 * frontend/src/config/menuCatalog.js), but the backend still answered API calls
 * for out-of-domain modules. This revokes those grants so a crafted direct API
 * request is denied too — matching what each role can actually see.
 *
 * Approach: for each role, hard-revoke (all 6 flags → false) the modules OUTSIDE
 * its domain. In-domain rows are left exactly as previously seeded. Idempotent.
 *
 * Domains kept (must mirror ROLE_SECTION_ALLOWLIST):
 *   manager → employees, attendance, leaves, timesheets, performance, projects,
 *             recruitment, reports, approvals, dashboard, notifications,
 *             documents, announcements
 *   hr      → employees, hr, payroll, attendance, leaves, timesheets,
 *             performance, recruitment, reports, approvals, dashboard,
 *             notifications, documents, announcements
 */

const REVOKE = {
  // Modules to strip from each role (everything not in its domain).
  manager: ['finance', 'payroll', 'inventory', 'procurement', 'sales', 'crm',
            'hr', 'admin', 'audit'],
  hr:      ['finance', 'inventory', 'procurement', 'sales', 'crm', 'projects',
            'admin', 'audit'],
};

export async function up(knex) {
  for (const [roleCode, modules] of Object.entries(REVOKE)) {
    // The migration runner is plain node-postgres ($1 placeholders); pg binds a
    // JS array to a single param, so use `module = ANY($2)` for the module list.
    await knex.raw(
      `UPDATE role_permissions
          SET can_view = false, can_add = false, can_edit = false,
              can_delete = false, can_approve = false, can_export = false
        WHERE role_id = (SELECT id FROM roles WHERE code = $1)
          AND module = ANY($2)`,
      [roleCode, modules]
    );
  }
  console.log('[migration 20260708000002] manager/hr permissions tightened to domain.');
}

export async function down() {
  // No-op: a security tightening is not auto-reverted. To restore the old
  // broad grants, re-run the platform_foundation role_permissions seed for
  // manager/hr (20260428000001) with ON CONFLICT DO UPDATE.
}
