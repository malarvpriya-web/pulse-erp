/**
 * security_events.user_agent — the column the login audit trail writes.
 *
 * `auth.controller.js` records every login success, login failure, lockout and
 * token event into `security_events`, writing `user_agent` and `detail`. Neither
 * matched the table (`user_agent` did not exist; the column is `details`), and
 * the whole insert is `.catch(() => {})` — so it failed silently on every auth
 * event and the table holds **0 rows**. The Security Center has had nothing to
 * show since it was built.
 *
 * `user_agent` is worth keeping rather than dropping from the insert: for a
 * security event, "which client did this" is half the value of the record.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE security_events ADD COLUMN IF NOT EXISTS user_agent text;`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_security_events_type_time
      ON security_events (event_type, created_at DESC);
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_security_events_type_time;`);
  await knex.raw(`ALTER TABLE security_events DROP COLUMN IF EXISTS user_agent;`);
}
