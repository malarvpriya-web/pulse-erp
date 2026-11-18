/**
 * 20261111000003 — "Raise a Support Ticket" failed for everyone.
 *
 * 20260904000002 seeded validation rule `service_priority_valid` with the
 * pattern ^(low|medium|high|critical|urgent)$. Every ticket screen sends
 * Title case (MyTickets / AllTickets offer Low · Medium · High · Critical) and
 * every stored support_tickets row is Title case (High 5 · Medium 6 · Low 4 on
 * 11 Nov 26). The engine builds `new RegExp(pattern)` with no flags, so every
 * POST /servicedesk/tickets came back 422 "Priority must be low, medium, high,
 * critical or urgent". There is no CHECK constraint on support_tickets.priority.
 *
 * The rule now accepts the values in either case. Stored data is unchanged.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() restores the lowercase-only pattern.
 */
const CODE = 'service_priority_valid';
const FIXED = '^([Ll]ow|[Mm]edium|[Hh]igh|[Cc]ritical|[Uu]rgent)$';
const OLD = '^(low|medium|high|critical|urgent)$';

const setPattern = (knex, pattern, msg) => knex.raw(
  `UPDATE validation_rules SET rule_expr = $1, error_message = $2 WHERE code = $3`,
  [JSON.stringify({ pattern }), msg, CODE],
);

export async function up(knex) {
  await setPattern(knex, FIXED, 'Priority must be Low, Medium, High, Critical or Urgent');
}

export async function down(knex) {
  await setPattern(knex, OLD, 'Priority must be low, medium, high, critical or urgent');
}
