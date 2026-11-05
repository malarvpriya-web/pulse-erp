/**
 * 20260926000011_suggestion_to_pr_idempotency.js
 *
 * Make "two purchase requisitions drafted from one purchase suggestion"
 * UNREPRESENTABLE, rather than merely unlikely.
 *
 * THE DEFECT
 * ----------
 * Two code paths convert a `purchase_suggestions` row into a
 * `purchase_requests` row:
 *
 *   1. POST /api/v1/inventory/advanced/purchase-suggestions/:id/convert
 *      (advancedInventory.routes.js) — the Convert button, called from BOTH
 *      StockAlertsAndSuggestions.jsx and procurement/MRPPlanning.jsx.
 *   2. reorderPr.cron.js `draftPrFromSuggestion()` — the daily 10:15 job.
 *
 * Each ran the same four-statement transaction, and each read the suggestion
 * with a plain SELECT before writing. Nothing serialised them and nothing
 * re-checked the status after acquiring any lock, so:
 *
 *   - Two simultaneous clicks (or a click plus a retry after a timeout, which is
 *     the common case — the frontend `convert()` has no in-flight guard) both
 *     saw `status = 'pending'`, both minted a PR number, both inserted a
 *     requisition with a line item, and both UPDATEd the suggestion. The second
 *     UPDATE overwrote `converted_to_pr_id`, so the FIRST requisition was left
 *     in the register with nothing pointing at it: a duplicate order, of real
 *     money, that no screen attributes to anything.
 *   - The cron racing a click did the same thing, across a process boundary.
 *
 * The cron's file comment claimed the dedup was "structural, not bolted on",
 * reasoning that the status flip happens inside the transaction. It does — but a
 * status flip inside a transaction only excludes a concurrent writer if that
 * writer READS the row under a lock, and neither path did. Two transactions in
 * READ COMMITTED (this database's default, verified) both see 'pending' and both
 * commit.
 *
 * WHY A COLUMN AND NOT JUST A LOCK
 * --------------------------------
 * The canonical service added in this batch does take `SELECT ... FOR UPDATE` on
 * the suggestion, which closes the race for every caller that goes through it.
 * But a lock is a property of code, and this table has already been written by
 * two implementations that both believed they were safe. A unique index is a
 * property of the DATABASE: it holds for the cron, the button, a future third
 * caller, a psql session and a partially-deployed rollout, and it fails loudly
 * (23505) instead of silently double-ordering.
 *
 * `purchase_suggestions.converted_to_pr_id` cannot carry that guarantee, because
 * it is the LAST writer's answer — the column the losing transaction overwrites.
 * The constraint has to live on the side that is created once per conversion, so
 * it goes on `purchase_requests`.
 *
 * WHY NOT AN FK ON THE EXISTING COLUMN TOO
 * ----------------------------------------
 * `purchase_suggestions.converted_to_pr_id` has no foreign key, and it shows:
 * suggestion 9 points at purchase_request 1451, which does not exist. Adding the
 * FK would require deleting or nulling that historical pointer, and losing the
 * record that suggestion 9 WAS converted (in order to gain referential integrity
 * over the PR it was converted into) is a worse trade than leaving the pointer
 * dangling and documented. It is left exactly as it is; the new column carries
 * the FK instead.
 *
 * WHAT THE BACKFILL DOES
 * ----------------------
 * Every one of the 14 already-converted suggestions gets its requisition stamped
 * with `source_suggestion_id`, so the new index protects history as well as new
 * rows — a retry against an OLD suggestion is caught too, not just one converted
 * after this deploy. Suggestion 9's dangling pointer resolves to no row, so
 * nothing is stamped for it and nothing is invented.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE purchase_requests
      ADD COLUMN IF NOT EXISTS source_suggestion_id INTEGER
        REFERENCES purchase_suggestions(id) ON DELETE SET NULL
  `);

  // Stamp the existing conversions before the index goes on, so history is
  // covered by it. `WHERE pr.source_suggestion_id IS NULL` keeps this re-runnable
  // and keeps it from touching a row a later conversion already owns.
  const { rows: backfilled } = await knex.raw(`
    UPDATE purchase_requests pr
       SET source_suggestion_id = ps.id
      FROM purchase_suggestions ps
     WHERE ps.converted_to_pr_id = pr.id
       AND pr.source_suggestion_id IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM purchase_requests other
              WHERE other.source_suggestion_id = ps.id AND other.id <> pr.id)
    RETURNING pr.id, ps.id AS suggestion_id
  `);
  console.log(`[20260926000011] stamped source_suggestion_id on ${backfilled.length} existing requisition(s)`);

  // The constraint itself. Partial on NOT NULL because the overwhelming majority
  // of requisitions are raised by hand and have no source suggestion — NULLs do
  // not collide in Postgres, but saying so explicitly keeps the index small and
  // states the intent.
  //
  // `deleted_at` is deliberately NOT in the predicate. A soft-deleted requisition
  // still consumed its suggestion; allowing a second conversion because the first
  // PR was cancelled would re-open exactly the duplicate-ordering hole this
  // closes. Re-converting a suggestion whose PR was cancelled is a decision for a
  // person (reject the suggestion, or raise a requisition directly), not
  // something a retry should be able to do by accident.
  const { rows: existing } = await knex.raw(
    `SELECT 1 FROM pg_indexes WHERE indexname = 'uq_pr_source_suggestion'`);
  if (!existing.length) {
    await knex.raw(`
      CREATE UNIQUE INDEX uq_pr_source_suggestion
        ON purchase_requests (source_suggestion_id)
       WHERE source_suggestion_id IS NOT NULL
    `);
  }

  // Lookup support for the idempotent read path: "has this suggestion already
  // been converted, and into what?" is asked on EVERY convert attempt now, and
  // the unique index above already serves it — this is only the reverse lookup
  // used when reporting a suggestion's requisition back to the caller.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_purchase_suggestions_converted_pr
      ON purchase_suggestions (converted_to_pr_id)
     WHERE converted_to_pr_id IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS uq_pr_source_suggestion`);
  await knex.raw(`DROP INDEX IF EXISTS idx_purchase_suggestions_converted_pr`);
  // The column is left in place on purpose: dropping it would discard the
  // suggestion→requisition provenance this migration recovered for 14 historical
  // rows, and that data is not reconstructible from anything else once
  // `converted_to_pr_id` drifts. Rolling back the CONSTRAINT is the reversible
  // part; rolling back the fact is not.
}
