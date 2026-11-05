/**
 * 20261021000005 — announcements: HR role grants and the announcement.published rule.
 *
 * 1. role_permissions, module 'announcements'
 *
 *    hr_manager and hr_exec held NO row, so once the routes enforced the matrix
 *    (§187) they were refused the HR Announcements page entirely. Granted VAE
 *    (view / add / edit) — the same as `hr`, and the shape both roles already
 *    hold on `documents`, the other HR publishing module.
 *
 *    NOT can_delete. DELETE /announcements/:id archives, and the established
 *    model withholds delete from every HR role on the publishing modules:
 *    platform_foundation gave `hr` delete only on HR process modules
 *    (employees, leaves, hr, attendance, performance, recruitment), never on
 *    documents or announcements; hr_exec holds delete on no module at all; and
 *    documents is 1110 for hr, hr_manager and hr_exec alike. Granting archive to
 *    HR would be a new delete permission, not a consequence of these roles' HR
 *    responsibilities — so archive stays with admin / super_admin until that is
 *    decided. The matrix has one delete flag; it cannot express "archive but not
 *    hard-delete" separately (no hard delete exists any more).
 *
 *    Same idiom as 20260721000002: INSERT … ON CONFLICT (role_id, module) DO
 *    NOTHING, so an existing row — e.g. one set later in Page Access — is never
 *    overwritten.
 *
 * 2. notification_rules, event_key 'announcement.published', Manifest only
 *
 *    announcement.publisher.js dispatches with this event_key. Without a row the
 *    event is invisible in the admin Notification Rules screen and email can
 *    never be switched on. Seeded with channel 'in_app' — the column default and
 *    the convention for 53 existing rules — so delivery is UNCHANGED: the
 *    repository acts on a rule only when its channel includes 'email'; the in-app
 *    row and push are written regardless. Email to a company-wide audience is
 *    left for an admin to enable deliberately. recipient_roles is documentation
 *    only (nothing reads it); the publisher resolves the audience itself.
 *    is_system_default = true, like the other seeded rules, so the admin UI
 *    treats it as a default (editable, not deletable).
 *
 *    Manifest is the only company in scope; matched by name, as the companies
 *    table has no stable code for it across environments.
 */
const VAE = [true, true, true, false, false, false];

export async function up(knex) {
  for (const role of ['hr_manager', 'hr_exec']) {
    const [v, a, e, d, ap, ex] = VAE;
    await knex.raw(
      `INSERT INTO role_permissions
         (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
       SELECT r.id, 'announcements', $2, $3, $4, $5, $6, $7
         FROM roles r WHERE r.code = $1
       ON CONFLICT (role_id, module) DO NOTHING`,
      [role, v, a, e, d, ap, ex]);
  }

  await knex.raw(`
    INSERT INTO notification_rules
      (company_id, event_key, title, channel, recipient_roles, enabled, is_system_default)
    SELECT c.id, 'announcement.published', 'New Announcement Published', 'in_app',
           ARRAY['employee']::text[], true, true
      FROM companies c
     WHERE c.name ILIKE 'manifest%' AND c.is_active = true
    ON CONFLICT (company_id, event_key) DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw(
    `DELETE FROM role_permissions
      WHERE module = 'announcements'
        AND role_id IN (SELECT id FROM roles WHERE code IN ('hr_manager', 'hr_exec'))`);
  await knex.raw(
    `DELETE FROM notification_rules
      WHERE event_key = 'announcement.published' AND is_system_default = true`);
}
