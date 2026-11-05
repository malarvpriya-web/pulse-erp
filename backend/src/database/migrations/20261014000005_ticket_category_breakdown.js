/**
 * 20261014000005_ticket_category_breakdown.js
 *
 * Adds the ticket category 'Breakdown' to the single ticket-category master.
 *
 * WHY
 *   modules/iot/alertActions.js files every IoT alert ticket under the category
 *   'Breakdown'. The master (`ticket_categories`, made the one vocabulary for
 *   support_tickets.category by 20260917000020) never held it, so:
 *     - the Service Desk and Tickets pickers (both read GET
 *       /finance/ticket-categories) could not offer the value an IoT ticket
 *       carries — a form re-saving such a ticket had no option matching it;
 *     - integration.ticketCategories' invariant "every category live tickets
 *       are filed under is in the master" fails whenever such a ticket exists
 *       (seen in the full suite when an IoT fixture ticket was live).
 *
 * WHAT
 *   One row, inserted only when no category with that name exists, compared
 *   the way the unique index compares (LOWER(BTRIM(name))). Running it twice,
 *   or on a database where an admin already added 'Breakdown' (in any case or
 *   spacing), inserts nothing. An existing row is never modified — if an admin
 *   deactivated 'Breakdown' on purpose, that decision stands.
 *
 *   No ticket is touched: support_tickets.category is the column everything
 *   reads, and it already says 'Breakdown'. category_id is deliberately NOT
 *   backfilled here (it would be an update to ticket records).
 *
 * ROLLBACK
 *   Removes only the row this migration inserted (identified by its
 *   description), and only if no ticket points at it through category_id;
 *   otherwise it refuses, naming how many tickets reference it. A 'Breakdown'
 *   row created by an admin through the UI survives a rollback.
 */

const NAME = 'Breakdown';
const MARKER = 'Equipment breakdown — the category IoT alert tickets are filed under (iot/alertActions.js)';

export async function up(knex) {
  // $1 cast explicitly: bare, it is inferred as varchar by the INSERT target
  // and as text by BTRIM(), and Postgres refuses with "inconsistent types".
  await knex.raw(
    `INSERT INTO ticket_categories (name, description, is_active)
     SELECT $1::text, $2::text, true
      WHERE NOT EXISTS (
        SELECT 1 FROM ticket_categories t
         WHERE LOWER(BTRIM(t.name)) = LOWER(BTRIM($1::text))
      )`,
    [NAME, MARKER]
  );
}

export async function down(knex) {
  const { rows: [{ n }] } = await knex.raw(
    `SELECT COUNT(*)::int AS n
       FROM support_tickets s
       JOIN ticket_categories t ON t.id = s.category_id
      WHERE t.name = $1 AND t.description = $2`,
    [NAME, MARKER]
  );
  if (n > 0) {
    throw new Error(
      `Refusing to roll back 20261014000005_ticket_category_breakdown: ${n} ticket(s) reference the ` +
      `'Breakdown' category by category_id. Re-point them first.`);
  }
  await knex.raw(`DELETE FROM ticket_categories WHERE name = $1 AND description = $2`, [NAME, MARKER]);
}
