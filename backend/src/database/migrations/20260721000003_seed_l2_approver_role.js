/**
 * 20260721000003_seed_l2_approver_role.js
 *
 * `l2_approver` is referenced throughout the leave-approval path —
 * `leaves.routes.js` (POST /approve/l2/:id, /reject/l2/:id, plus the two
 * own-team visibility checks at line ~611/1192) and the frontend's
 * `LeaveApprovals.jsx` L2 queue definition (`roles: ['department_head',
 * 'l2_approver', 'admin', 'super_admin', 'hr_manager']`, labelled "L2 — Dept
 * Head") — but has no row in `roles`, so nobody can be assigned it and
 * `requirePermission('leaves', 'approve')` on the L2 routes could never pass
 * for it. The frontend already treats it as a distinct alternative to
 * `department_head` for the same L2 escalation tier (a dedicated leave
 * approver who isn't necessarily an operational department head), so this
 * seeds it for real rather than folding it into department_head.
 *
 * Scope is deliberately narrow — leaves approval authority + attendance
 * context, nothing else. Not added to `APPROVER_ROLES` in approvals.authz.js:
 * that array grants the GENERIC Approval Center authority (attendance
 * regularization, OT, procurement PRs, timesheets…), which is broader than
 * this role's actual job.
 */

export async function up(knex) {
  await knex.raw(`
    INSERT INTO roles (code, role_name, label, description, is_active, company_id)
    SELECT 'l2_approver', 'L2 Approver', 'L2 Leave Approver',
           'Second-level leave approval (L1-approved queue) — the dedicated escalation tier the leave workflow treats as an alternative to department_head',
           TRUE,
           (SELECT company_id FROM roles WHERE code = 'manager' LIMIT 1)
    WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'l2_approver')
  `);

  // Mirrors manager/department_head's own 'leaves' grant shape (view/add/edit/
  // approve, no delete/export) — see role_permissions row for role_id=3 in
  // baseline-data.sql.
  await knex.raw(`
    INSERT INTO role_permissions
      (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
    SELECT r.id, 'leaves', true, true, true, false, true, false
      FROM roles r WHERE r.code = 'l2_approver'
    ON CONFLICT (role_id, module) DO NOTHING
  `);

  // View-only attendance context for the employee whose leave is being decided.
  await knex.raw(`
    INSERT INTO role_permissions
      (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
    SELECT r.id, 'attendance', true, false, false, false, false, false
      FROM roles r WHERE r.code = 'l2_approver'
    ON CONFLICT (role_id, module) DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw(`
    DELETE FROM role_permissions
     WHERE role_id IN (SELECT id FROM roles WHERE code = 'l2_approver')
  `);
  await knex.raw(`DELETE FROM roles WHERE code = 'l2_approver'`);
}
