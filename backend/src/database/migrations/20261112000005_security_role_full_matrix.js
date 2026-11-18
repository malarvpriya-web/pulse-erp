/**
 * 20261112000005_security_role_full_matrix.js — §273 follow-up.
 *
 * Migration 20261112000004 created the `security` role with rows for
 * gate_access and gate_security only. Every other role carries a row for every
 * permission module (the convention the bgv / succession / gate_access
 * migrations follow), so requirePermission never meets PERMISSION_NOT_CONFIGURED
 * and the matrix screen shows the role complete. This gives `security` an
 * all-false row for every module it has none for. Nothing is granted.
 * ON CONFLICT DO NOTHING: its two real grants, and any later edit, survive.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
    SELECT r.id, m.module, false, false, false, false, false, false
      FROM roles r
      CROSS JOIN (SELECT DISTINCT module FROM role_permissions) m
     WHERE LOWER(r.code) = 'security'
    ON CONFLICT (role_id, module) DO NOTHING`);
}

export async function down(knex) {
  await knex.raw(`
    DELETE FROM role_permissions
     WHERE role_id IN (SELECT id FROM roles WHERE LOWER(code) = 'security')
       AND module NOT IN ('gate_access', 'gate_security')
       AND NOT (can_view OR can_add OR can_edit OR can_delete OR can_approve OR can_export)`);
}
