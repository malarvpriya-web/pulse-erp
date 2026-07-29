/**
 * Travel Approval Hierarchy — reporting-manager delegation.
 * Lets the actual reporting manager (or an HR/admin override) hand off a
 * specific pending request/advance/claim to a named delegate, mirroring the
 * existing `leave_applications.delegate_approver_id` pattern
 * (leaves.routes.js `POST /delegate/:id`).
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE travel_requests
      ADD COLUMN IF NOT EXISTS delegate_approver_id INTEGER REFERENCES employees(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE travel_advances
      ADD COLUMN IF NOT EXISTS delegate_approver_id INTEGER REFERENCES employees(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE expense_claims
      ADD COLUMN IF NOT EXISTS delegate_approver_id INTEGER REFERENCES employees(id) ON DELETE SET NULL
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE travel_requests  DROP COLUMN IF EXISTS delegate_approver_id`);
  await knex.raw(`ALTER TABLE travel_advances  DROP COLUMN IF EXISTS delegate_approver_id`);
  await knex.raw(`ALTER TABLE expense_claims   DROP COLUMN IF EXISTS delegate_approver_id`);
}
