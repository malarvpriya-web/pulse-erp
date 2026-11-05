/**
 * 20260915000002_reversed_entries_stay_posted.js
 *
 * Finance audit finding F06.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * Reversing a journal entry inserted an opposite, POSTED entry and then set the
 * ORIGINAL to status='reversed'. Every accounting report selects status='posted'.
 * So the reversing leg stayed in the reports and the original dropped out.
 *
 * Reversing a 100 credit to revenue left revenue reporting -100, not 0. The
 * reversal counted, unopposed, and the ledger swung by the full amount in the
 * wrong direction.
 *
 * It was worse than that, because the two posting paths never agreed on
 * `is_posted`: the API route set only `status`, while journalRepo.postEntry()
 * set `is_posted = true` as well. Repository reports filter
 * `is_posted OR status='posted'`, accounting.routes.js filters `status='posted'`.
 * So whether a reversed original survived depended on which code had posted it:
 *
 *   posted via the API route      -> is_posted false -> dropped from EVERY report
 *   posted via journalRepo        -> is_posted true  -> kept by repo reports,
 *                                                       dropped by the others
 *
 * Same entry, opposite answers.
 *
 * ── WHAT CHANGED IN CODE ────────────────────────────────────────────────────
 * A reversal no longer un-posts the original. Both legs stay posted and net to
 * zero, which is both correct double entry and a readable audit trail.
 * "Reversed" is a RELATIONSHIP — the reversing entry's `reversal_of_id` — and is
 * derived for display as `is_reversed`, not stored as a status. The reverse
 * handler now also refuses a second reversal, which the status change used to
 * prevent by accident.
 *
 * ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
 * Existing rows still carry status='reversed' and would stay invisible forever,
 * so they are brought back into the ledger — but ONLY where doing so is provably
 * correct:
 *
 *   PAIRED   an entry marked 'reversed' that HAS a reversing entry pointing at
 *            it. Restoring it re-creates a matched pair that nets to zero. The
 *            reported totals do not move; they are corrected.
 *
 *   ORPHANED an entry marked 'reversed' with NO reversing entry. Restoring it
 *            would add an unopposed amount to the ledger and CHANGE reported
 *            figures. These are left exactly as they are and listed in the
 *            migration output for a human to look at. A migration may repair an
 *            inconsistency; it must not invent a number.
 *
 * Every row it touches is recorded in `finance_reversal_backfill` with its prior
 * values, so down() restores precisely those rows and nothing else.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS finance_reversal_backfill (
      entry_id         uuid PRIMARY KEY,
      prior_status     character varying(20),
      prior_is_posted  boolean,
      migration        text NOT NULL,
      applied_at       timestamptz NOT NULL DEFAULT now()
    )
  `);

  // 1. Record the paired rows before changing them.
  await knex.raw(`
    INSERT INTO finance_reversal_backfill (entry_id, prior_status, prior_is_posted, migration)
    SELECT je.id, je.status, je.is_posted, '20260915000002_reversed_entries_stay_posted'
      FROM journal_entries je
     WHERE je.status = 'reversed'
       AND EXISTS (
             SELECT 1 FROM journal_entries r
              WHERE r.reversal_of_id = je.id
                AND r.deleted_at IS NULL
           )
    ON CONFLICT (entry_id) DO NOTHING
  `);

  // 2. Bring them back into the ledger, both columns agreeing.
  const paired = await knex.raw(`
    UPDATE journal_entries je
       SET status = 'posted', is_posted = true
     WHERE je.status = 'reversed'
       AND EXISTS (
             SELECT 1 FROM journal_entries r
              WHERE r.reversal_of_id = je.id
                AND r.deleted_at IS NULL
           )
    RETURNING je.id
  `);
  const pairedCount = paired?.rows?.length ?? paired?.rowCount ?? 0;

  // 3. Make is_posted agree with status for everything already posted. These
  //    rows are already included by the `is_posted OR status='posted'` filters,
  //    so this changes no report — it removes the ambiguity that let a later
  //    status change hide an entry from one report family but not the other.
  const aligned = await knex.raw(`
    UPDATE journal_entries
       SET is_posted = true
     WHERE status = 'posted' AND is_posted IS DISTINCT FROM true
    RETURNING id
  `);
  const alignedCount = aligned?.rows?.length ?? aligned?.rowCount ?? 0;

  // 4. Report, do not touch, the orphans.
  const orphans = await knex.raw(`
    SELECT je.entry_number, je.entry_date, je.company_id, je.total_debit, je.total_credit
      FROM journal_entries je
     WHERE je.status = 'reversed'
       AND NOT EXISTS (
             SELECT 1 FROM journal_entries r
              WHERE r.reversal_of_id = je.id
                AND r.deleted_at IS NULL
           )
     ORDER BY je.entry_date
  `);
  const orphanRows = orphans?.rows ?? [];

  console.log(
    `[migration 20260915000002] restored ${pairedCount} reversed-but-paired entr(ies) to posted; ` +
    `aligned is_posted on ${alignedCount} already-posted row(s).`
  );
  if (orphanRows.length) {
    console.warn(
      `[migration 20260915000002] ${orphanRows.length} entr(ies) are marked 'reversed' but have NO ` +
      `reversing entry. LEFT UNCHANGED — restoring them would alter reported figures. Review:`
    );
    for (const r of orphanRows) {
      console.warn(
        `  ${r.entry_number}  ${String(r.entry_date).slice(0, 10)}  company=${r.company_id ?? 'null'}  ` +
        `dr=${r.total_debit} cr=${r.total_credit}`
      );
    }
  }
}

export async function down(knex) {
  // Restore exactly the rows this migration changed, to exactly their prior
  // values. Rows it deliberately left alone are not referenced here either.
  await knex.raw(`
    UPDATE journal_entries je
       SET status    = b.prior_status,
           is_posted = b.prior_is_posted
      FROM finance_reversal_backfill b
     WHERE b.entry_id = je.id
       AND b.migration = '20260915000002_reversed_entries_stay_posted'
  `);
  await knex.raw(`
    DELETE FROM finance_reversal_backfill
     WHERE migration = '20260915000002_reversed_entries_stay_posted'
  `);
  // The is_posted alignment in step 3 is intentionally NOT reverted: it changed
  // no report, and the prior values were an artefact of two posting paths that
  // no longer disagree.
}
