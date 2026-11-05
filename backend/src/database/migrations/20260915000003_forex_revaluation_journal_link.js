/**
 * 20260915000003_forex_revaluation_journal_link.js
 *
 * Finance audit finding F13.
 *
 * PUT /forex/revaluations/:id/post was named "post" but only ran:
 *
 *     UPDATE forex_revaluations SET status='posted' WHERE ...
 *
 * No journal entry was ever created. An unrealised exchange gain or loss was
 * computed, displayed, marked "posted", and never reached the general ledger —
 * so the P&L and balance sheet carried none of it while the UI showed the
 * revaluation as complete.
 *
 * Posting now writes a real journal through journalRepo (and therefore through
 * the posting guards). These columns record the link, so a revaluation can be
 * traced to its entry and a second post attempt can be refused rather than
 * producing a duplicate.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE forex_revaluations
      ADD COLUMN IF NOT EXISTS journal_entry_id uuid,
      ADD COLUMN IF NOT EXISTS posted_at timestamptz,
      ADD COLUMN IF NOT EXISTS posted_by integer
  `);

  // Note the deliberate absence of a FK to journal_entries: this migration must
  // not fail on a database where an older journal_entries shape is present, and
  // the application always writes the id it just created inside one transaction.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_forex_revaluations_journal
      ON forex_revaluations (journal_entry_id)
     WHERE journal_entry_id IS NOT NULL
  `);

  console.log('[migration 20260915000003] forex_revaluations can now record its journal entry.');
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_forex_revaluations_journal`);
  await knex.raw(`
    ALTER TABLE forex_revaluations
      DROP COLUMN IF EXISTS journal_entry_id,
      DROP COLUMN IF EXISTS posted_at,
      DROP COLUMN IF EXISTS posted_by
  `);
}
