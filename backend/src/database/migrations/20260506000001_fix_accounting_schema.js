/**
 * 20260506000001_fix_accounting_schema.js
 *
 * Compliance fix — consolidates the journal schema.
 *
 * Problem: 20260423 migration created `journal_lines` but all repository
 * code references `journal_entry_lines` (the initDb.js name). Also,
 * journal_entries was missing is_posted, entry_type, and deleted_at columns
 * that the repositories rely on.
 *
 * Changes:
 *   1. Add missing columns to journal_entries
 *   2. Create journal_entry_lines as the canonical lines table
 *   3. Backfill is_posted from status for existing rows
 *   4. Add performance indexes
 */

export async function up(knex) {

  // ── 1. Add missing columns to journal_entries ────────────────────────────────
  await knex.raw(`
    ALTER TABLE journal_entries
      ADD COLUMN IF NOT EXISTS is_posted  BOOLEAN     DEFAULT false,
      ADD COLUMN IF NOT EXISTS entry_type VARCHAR(50),
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
  `);

  // Backfill is_posted for any rows already marked status='posted'
  // Guard: status column may not exist on all installs
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'journal_entries' AND column_name = 'status'
      ) THEN
        UPDATE journal_entries
        SET is_posted = true
        WHERE status = 'posted' AND is_posted IS DISTINCT FROM true;
      END IF;
    END $$
  `);

  // ── 2. Create journal_entry_lines (canonical lines table) ────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS journal_entry_lines (
      id               SERIAL PRIMARY KEY,
      journal_entry_id INTEGER      NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id       INTEGER      REFERENCES chart_of_accounts(id),
      account_code     VARCHAR(20),
      description      TEXT,
      debit            NUMERIC(15,2) DEFAULT 0,
      credit           NUMERIC(15,2) DEFAULT 0,
      cost_centre      VARCHAR(100),
      project_id       INTEGER,
      created_at       TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  // ── 3. Indexes ────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_jel_entry_id  ON journal_entry_lines(journal_entry_id);
    CREATE INDEX IF NOT EXISTS idx_jel_account_id ON journal_entry_lines(account_id);
    CREATE INDEX IF NOT EXISTS idx_je_is_posted   ON journal_entries(is_posted);
    CREATE INDEX IF NOT EXISTS idx_je_entry_date  ON journal_entries(entry_date);
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS journal_entry_lines CASCADE');
  await knex.raw(`
    ALTER TABLE journal_entries
      DROP COLUMN IF EXISTS is_posted,
      DROP COLUMN IF EXISTS entry_type,
      DROP COLUMN IF EXISTS deleted_at
  `);
}
