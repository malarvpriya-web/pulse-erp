/**
 * ticket_conversations — the two columns the reply path writes.
 *
 * Posting a reply writes `created_by_name` and `attachments`; neither exists, so
 * every reply threw 42703 and no conversation could ever be recorded (the table
 * holds 0 rows).
 *
 * Both are legitimate: `created_by_name` preserves who replied even after a user
 * record changes or is purged, and `attachments` carries the file list. Added
 * rather than remapped — there is nothing else on the table that means either.
 *
 * The companion change lives in finance/repositories/ticket.repository.js, which
 * is repointed off the empty `tickets` table and onto `support_tickets`, the
 * canonical Service Desk table that actually holds the 15 live tickets. That
 * removes the parallel ticket system rather than giving it the columns to keep
 * running as a second source of truth.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE ticket_conversations ADD COLUMN IF NOT EXISTS created_by_name text;`);
  await knex.raw(`ALTER TABLE ticket_conversations ADD COLUMN IF NOT EXISTS attachments     jsonb;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ticket_conversations_ticket ON ticket_conversations (ticket_id, created_at);`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_ticket_conversations_ticket;`);
  await knex.raw(`ALTER TABLE ticket_conversations DROP COLUMN IF EXISTS attachments;`);
  await knex.raw(`ALTER TABLE ticket_conversations DROP COLUMN IF EXISTS created_by_name;`);
}
