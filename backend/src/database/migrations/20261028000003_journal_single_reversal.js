/**
 * 20261028000003 — a journal entry is reversed at most once.
 *
 * A reversing entry points at what it reverses (journal_entries.reversal_of_id).
 * Both writers refuse a second reversal by first looking for one — accounting's
 * POST /journal-entries/:id/reverse and, from Phase 3F, the IoT service-part
 * reversal — but a look-then-insert lets two simultaneous requests both see
 * none and both insert, leaving two offsetting legs against one entry. This
 * unique index makes the database refuse the second.
 *
 * Only live reversals count (deleted_at IS NULL), matching the writers' own
 * check. No reversal exists in the dev database (459 entries, 0 with
 * reversal_of_id), so this cannot fail on existing data.
 *
 * Rollback: down() drops the index; the writers' own checks remain.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_journal_entries_single_reversal
      ON journal_entries (reversal_of_id) WHERE reversal_of_id IS NOT NULL AND deleted_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ux_journal_entries_single_reversal`);
}
