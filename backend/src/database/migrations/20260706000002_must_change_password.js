/**
 * 20260706000002_must_change_password.js
 *
 * Adds users.must_change_password so auto-provisioned employee logins (which all
 * share the same default password) are forced to set their own password on first
 * sign-in. The login payload carries this flag; the frontend gates the app behind
 * a change-password screen until it's cleared. changePassword / resetPassword
 * clear it.
 *
 * Back-fill: flag every employee-linked login (role 'employee' with an employee_id)
 * that was auto-created with the shared default password.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
  `);

  await knex.raw(`
    UPDATE users
       SET must_change_password = true
     WHERE role = 'employee'
       AND employee_id IS NOT NULL
  `);
}

export async function down(knex) {
  // Keep the column — dropping it would strip the forced-change gate. No-op.
}
