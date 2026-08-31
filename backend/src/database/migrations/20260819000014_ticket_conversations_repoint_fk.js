/**
 * ticket_conversations.ticket_id — repoint the FK at support_tickets.
 *
 * The Finance ticket repository now reads and writes `support_tickets` (the
 * canonical Service Desk table with the live tickets) instead of the empty
 * parallel `tickets` table. Its conversation FK still pointed at `tickets`,
 * so posting a reply to a real ticket failed the constraint — the repointing
 * was only half done without this.
 *
 * Safe to move: `ticket_conversations` holds 0 rows, so there is nothing to
 * re-parent and no risk of orphaning history.
 */

export async function up(knex) {
  const { rows } = await knex.raw(`SELECT COUNT(*)::int AS n FROM ticket_conversations`);
  if ((rows[0]?.n ?? 0) > 0) {
    throw new Error(
      `ticket_conversations has ${rows[0].n} row(s) parented to \`tickets\`; ` +
      `re-parent them to support_tickets before moving the foreign key.`
    );
  }
  await knex.raw(`ALTER TABLE ticket_conversations DROP CONSTRAINT IF EXISTS ticket_conversations_ticket_id_fkey;`);
  await knex.raw(`
    ALTER TABLE ticket_conversations
      ADD CONSTRAINT ticket_conversations_ticket_id_fkey
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE;
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE ticket_conversations DROP CONSTRAINT IF EXISTS ticket_conversations_ticket_id_fkey;`);
  await knex.raw(`
    ALTER TABLE ticket_conversations
      ADD CONSTRAINT ticket_conversations_ticket_id_fkey
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
  `);
}
