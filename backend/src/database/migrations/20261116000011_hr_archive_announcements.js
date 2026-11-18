/**
 * 20261116000011_hr_archive_announcements.js — owner decision 2026-11-17:
 * HR may archive announcements (and restore them), not only admin.
 *
 * Archive / restore / the archived list need announcements:delete
 * (Announcements.jsx canArchive; DELETE /announcements/:id). Only admin and
 * super_admin held it. Granted to the HR roles — hr, hr_manager, hr_exec — who
 * already add and edit announcements. Managers and department heads, who can
 * also post, are unchanged. Only rows still false are touched, so a later
 * change in Roles Setup is not undone by a re-run.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const ROLES = ['hr', 'hr_manager', 'hr_exec'];

export async function up(knex) {
  await knex.raw(
    `UPDATE role_permissions rp SET can_delete = true
       FROM roles r
      WHERE r.id = rp.role_id AND rp.module = 'announcements'
        AND LOWER(r.code) = ANY($1::text[]) AND rp.can_delete IS NOT TRUE`, [ROLES]);
}

export async function down(knex) {
  await knex.raw(
    `UPDATE role_permissions rp SET can_delete = false
       FROM roles r
      WHERE r.id = rp.role_id AND rp.module = 'announcements' AND LOWER(r.code) = ANY($1::text[])`, [ROLES]);
}
