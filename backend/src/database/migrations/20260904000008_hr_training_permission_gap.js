/**
 * 20260904000008_hr_training_permission_gap.js
 *
 * Grants the `hr` role access to the `training` module.
 *
 * WHY
 * ---
 * `training` grants view to admin, hr_exec, hr_manager and super_admin. The
 * plain `hr` role — which is the role actually provisioned to HR staff in this
 * deployment (`hr@manifest.in` holds it, and nothing else) — has an all-false
 * deny row.
 *
 * That was invisible while the training routes carried no gate at all: everyone
 * could read them, including HR, so nobody noticed HR had no permission. Gating
 * those routes on 2026-09-04 turned the hole into a 403 for the very people who
 * run training.
 *
 * ⚠ This is the failure mode of adding a gate to a module whose matrix row was
 * never exercised. The gate is correct; the matrix was wrong, and only closing
 * the gate revealed it. Check who ACTUALLY holds a module before restricting to
 * it — an all-false row and an absent row look the same from the route.
 *
 * GRANT: mirrored from `hr_exec`, which is the closest analogue — the same
 * function at the same level. Deliberately not `hr_manager`'s grant, which
 * carries approve/delete; nothing here suggests plain HR staff should be able to
 * delete a training record.
 */

export async function up(knex) {
  const { rows: [source] } = await knex.raw(
    `SELECT rp.can_view, rp.can_add, rp.can_edit, rp.can_delete, rp.can_approve, rp.can_export
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
      WHERE rp.module = 'training' AND LOWER(r.code) = 'hr_exec'`
  );

  if (!source) {
    console.log('[hr_training_permission_gap] no hr_exec row to mirror — skipped');
    return;
  }

  // The row is ABSENT, not all-false — `hr` has no `training` row at all. Both
  // look identical from a route (requirePermission returns
  // PERMISSION_NOT_CONFIGURED for a missing row and PERMISSION_DENIED for a
  // false one, and both are a 403), which is why an UPDATE-only version of this
  // migration reported "0 rows" and changed nothing. Upsert covers both shapes.
  const { rowCount } = await knex.raw(
    `INSERT INTO role_permissions
       (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
     SELECT r.id, 'training', $1, $2, $3, $4, $5, $6
       FROM roles r
      WHERE LOWER(r.code) = 'hr'
     ON CONFLICT (role_id, module) DO UPDATE
        SET can_view = EXCLUDED.can_view, can_add = EXCLUDED.can_add,
            can_edit = EXCLUDED.can_edit, can_delete = EXCLUDED.can_delete,
            can_approve = EXCLUDED.can_approve, can_export = EXCLUDED.can_export
      WHERE role_permissions.can_view = false`,
    [source.can_view, source.can_add, source.can_edit,
     source.can_delete, source.can_approve, source.can_export]
  );

  console.log(`[hr_training_permission_gap] ${rowCount ?? 0} row(s): hr now mirrors hr_exec on training`);
}

export async function down(knex) {
  await knex.raw(
    `UPDATE role_permissions rp
        SET can_view = false, can_add = false, can_edit = false,
            can_delete = false, can_approve = false, can_export = false
       FROM roles r
      WHERE r.id = rp.role_id AND rp.module = 'training' AND LOWER(r.code) = 'hr'`
  );
}
