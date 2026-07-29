/**
 * Exit Clearance Engine — audit trail for who granted each manual NOC.
 * The three human-judgment clearances (Finance/Reporting-Manager/HR) stay
 * boolean flags, but final settlement is now gated on them (see exit.routes.js
 * computeClearanceBlockers) so recording who signed off matters for audit.
 * Assets/Travel-advances/IT-access are NOT tracked here — those blockers are
 * computed live from employee_asset_allocations/travel_advances/users, not
 * stored, so they can't drift from reality.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE exit_clearance
      ADD COLUMN IF NOT EXISTS finance_noc_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS manager_noc_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS hr_noc_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE exit_clearance
      DROP COLUMN IF EXISTS finance_noc_by,
      DROP COLUMN IF EXISTS manager_noc_by,
      DROP COLUMN IF EXISTS hr_noc_by
  `);
}
