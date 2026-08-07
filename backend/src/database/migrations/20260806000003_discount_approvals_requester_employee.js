/**
 * 20260806000003_discount_approvals_requester_employee.js
 *
 * Automation Opportunity Audit §30.2 — manager-hierarchy-aware approval
 * routing. discount_approvals.requested_by is a free-text display string
 * (req.user?.name || req.user?.email), not an employee FK, so
 * shared/managerApprovalAuthz.js's hierarchy check (which needs
 * employees.id) has nothing to join against. purchase_requests already
 * carries both a display requested_by and an FK requested_by_employee_id —
 * same shape here. Purely additive; requested_by stays for existing
 * list/detail UI, this is only consulted by the new approval gate.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE discount_approvals
      ADD COLUMN IF NOT EXISTS requested_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE discount_approvals
      DROP COLUMN IF EXISTS requested_by_employee_id
  `);
}
