/**
 * 20261116000007_exit_clearance_history.js — HR audit 2026-11-16, B7 (11-03 F-15).
 *
 * exit_clearance is one row per EMPLOYEE. Since §274 a new exit starts that row
 * from nothing (exitCase.freshClearance), so a rehire's second exit no longer
 * inherits the first exit's ticks — but the first exit's clearance (who signed
 * the HR, Finance and manager NOCs, what was returned) was overwritten and
 * survived only inside an audit entry.
 *
 * exit_clearance_history keeps it: freshClearance() copies the old row here,
 * linked to the exit it belonged to, before clearing it. GET
 * /exit/clearance/:employee_id/history reads it. Existing data is untouched.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS exit_clearance_history (
      id              SERIAL PRIMARY KEY,
      employee_id     INTEGER NOT NULL REFERENCES employees(id),
      exit_request_id INTEGER REFERENCES exit_requests(id),
      clearance       JSONB   NOT NULL,
      archived_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_exit_clearance_history_employee
                    ON exit_clearance_history (employee_id, archived_at DESC)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS exit_clearance_history`);
}
