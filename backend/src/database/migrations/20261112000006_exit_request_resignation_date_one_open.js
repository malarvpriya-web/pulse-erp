/**
 * 20261112000006_exit_request_resignation_date_one_open.js — §274 (exit fixes).
 *
 * 1. exit_requests.resignation_date: the day notice started (resignation handed
 *    in, or termination notice served). F&F measures notice served from it; with
 *    no column, it fell back to the exit's creation date (warning
 *    NOTICE_START_UNKNOWN) unless HR typed it into the calculator every time.
 * 2. One open exit per employee (11-03 audit F-14). The three create paths
 *    (POST /exit/initiate, POST /exit/requests, POST /employees/:id/offboard)
 *    now refuse a second one; this index makes it hold under a race too.
 *    "Open" = what GET /exit/active lists: anything not closed, paid,
 *    cancelled or rejected. Measured 11-12: 5 rows, 4 open, on 4 different
 *    employees, so the index builds on the live data.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE exit_requests ADD COLUMN IF NOT EXISTS resignation_date DATE`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS exit_requests_one_open_per_employee
      ON exit_requests (employee_id)
      WHERE status NOT IN ('closed', 'paid', 'cancelled', 'rejected')`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS exit_requests_one_open_per_employee`);
  await knex.raw(`ALTER TABLE exit_requests DROP COLUMN IF EXISTS resignation_date`);
}
