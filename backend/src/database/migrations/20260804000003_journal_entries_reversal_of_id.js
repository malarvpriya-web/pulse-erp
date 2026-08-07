/**
 * `POST /journal-entries/:id/reverse` (accounting.routes.js:184-230) has
 * always inserted a `reversal_of_id` value on the reversing entry, but the
 * live `journal_entries` table never had that column — confirmed live 500
 * (`column "reversal_of_id" of relation "journal_entries" does not exist`)
 * while cleaning up test data during the period-close live-verification
 * pass (see MODULE_FEATURE_CONNECTION_MANUAL.md §24 Addendum 2/4). An
 * older migration (20260423000001_accounting_schema.js) defined this
 * column against a SERIAL-id version of journal_entries, but the live
 * table was later rebuilt on a `uuid` id (baseline.sql) without carrying
 * the column forward.
 *
 * uuid, not int, to match the live journal_entries.id type.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE journal_entries
      ADD COLUMN IF NOT EXISTS reversal_of_id UUID REFERENCES journal_entries(id)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_journal_entries_reversal_of_id
      ON journal_entries(reversal_of_id)
  `);
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_journal_entries_reversal_of_id');
  await knex.raw('ALTER TABLE journal_entries DROP COLUMN IF EXISTS reversal_of_id');
}
