/**
 * Add `offer_letters.created_by` — enables the segregation-of-duties check on
 * offer approval.
 *
 * approveSourceItem()'s 'requisition' case already refuses to let the person who
 * raised a requisition approve it, by comparing job_requisitions.requested_by to the
 * actor's employee id. The 'offer' case carried a comment explaining why it could not
 * do the same: offer_letters had no created_by/requested_by column at all. So the
 * more consequential of the two approvals — sending a salaried offer, a real
 * financial commitment — was the one with no self-approval guard.
 *
 * FKs `employees(id)`, not `users(id)`, so it can be compared directly against
 * myEmployeeId(req) the way requested_by is. (employees-vs-users on a *_by column is a
 * recurring mix-up here; candidate_stage_history.moved_by and stock_ledger.created_by
 * are both employees too.)
 *
 * Existing rows stay NULL — there is no record anywhere of who created them, and
 * inventing one would be worse than admitting the gap. The check treats NULL as
 * "author unknown, allow", exactly as the requisition case treats a null requested_by.
 *
 * Scope note: this migration deliberately does NOT touch offer_expiry_date. That
 * column is owned by 20260813000001_offer_expiry_date.js, which lands the column,
 * its backfill and its index. An earlier draft of this file added both and collided
 * with that one on the index name; the expiry half was removed rather than left to
 * race on whichever filename sorted first.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS created_by INTEGER
  `);

  // ADD CONSTRAINT has no IF NOT EXISTS in Postgres, so it needs its own guard to
  // stay re-runnable.
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'offer_letters_created_by_fkey'
      ) THEN
        ALTER TABLE offer_letters
          ADD CONSTRAINT offer_letters_created_by_fkey
          FOREIGN KEY (created_by) REFERENCES employees(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE offer_letters DROP CONSTRAINT IF EXISTS offer_letters_created_by_fkey
  `);
  await knex.raw(`
    ALTER TABLE offer_letters DROP COLUMN IF EXISTS created_by
  `);
}
