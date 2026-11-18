/**
 * 20261116000010_exit_clearance_history_cascade.js — follow-up to 20261116000007.
 *
 * exit_clearance_history rows belong to their exit and employee. With plain
 * foreign keys a hard delete of an exit request or employee (which
 * exit_clearance itself never blocked) was refused. ON DELETE CASCADE: the
 * history goes with what it describes. Employees are soft-deleted in the app,
 * so this only affects deliberate hard deletes (clean-ups, tests).
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE exit_clearance_history
      DROP CONSTRAINT IF EXISTS exit_clearance_history_employee_id_fkey,
      DROP CONSTRAINT IF EXISTS exit_clearance_history_exit_request_id_fkey,
      ADD CONSTRAINT exit_clearance_history_employee_id_fkey
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
      ADD CONSTRAINT exit_clearance_history_exit_request_id_fkey
        FOREIGN KEY (exit_request_id) REFERENCES exit_requests(id) ON DELETE CASCADE`);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE exit_clearance_history
      DROP CONSTRAINT IF EXISTS exit_clearance_history_employee_id_fkey,
      DROP CONSTRAINT IF EXISTS exit_clearance_history_exit_request_id_fkey,
      ADD CONSTRAINT exit_clearance_history_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id),
      ADD CONSTRAINT exit_clearance_history_exit_request_id_fkey FOREIGN KEY (exit_request_id) REFERENCES exit_requests(id)`);
}
