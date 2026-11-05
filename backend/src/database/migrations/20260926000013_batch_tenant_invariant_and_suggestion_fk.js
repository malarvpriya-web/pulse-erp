/**
 * 20260926000013_batch_tenant_invariant_and_suggestion_fk.js
 *
 * Closes the two schema-level risks left open by 20260926000010/11/12.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PART 1 — `inventory_batches.company_id` becomes a real tenant column
 * ═══════════════════════════════════════════════════════════════════════════
 * The Advanced Inventory pass scoped every read and write through
 * `inventory_items.company_id`, because that is the only column in the graph that
 * authoritatively says who owns the stock. `inventory_batches` DOES have its own
 * `company_id`, but it was:
 *
 *   - NULLABLE, so a lot could be born tenant-less and invisible to every
 *     company-scoped reader, and
 *   - UNCONSTRAINED against the item's company, so the two could disagree.
 *
 * Both matter more than they look. `uq_batches_company_item_number` leads with
 * `company_id`, and NULL <> NULL in Postgres, so a NULL-tenant lot ALSO slipped
 * past the duplicate-batch-number guard. And if the two columns ever disagreed,
 * "scoped by the item" and "scoped by the batch" would return different sets — so
 * whichever one a future query happened to pick would decide whether the boundary
 * held.
 *
 * WHY THIS IS SAFE TO CONSTRAIN NOW (all measured 2026-09-26):
 *   - `inventory_batches` has exactly ONE INSERT site in the whole codebase:
 *     `advancedInventory.repository.createBatch()`. Its only two callers
 *     (`grn.service.postAcceptedStock` and `POST /advanced/batches`) both pass
 *     `company_id` explicitly, and the INSERT itself already COALESCEs onto the
 *     item's company when they do not. The "NOT NULL turns a silent NULL into a
 *     500" failure mode therefore has no path here.
 *   - 15 of 15 live rows carry a company_id; 0 are NULL.
 *   - 0 rows disagree with their item's company.
 *   - 0 rows point at a missing item.
 *
 * THE TRIGGER FILLS, THEN VALIDATES — in that order, and the order is the design:
 *   - FILL when NULL: no caller breaks by omission, and a lot can never again be
 *     born tenant-less however it is written (psql, a fixture, a future route).
 *   - RAISE on MISMATCH: a caller that supplies the WRONG company is a tenant bug,
 *     and silently overwriting it would hide exactly the class of defect this
 *     batch exists to close. Loud beats tidy.
 *
 * A CHECK constraint cannot do this — it cannot reference another table — which is
 * why it is a trigger and not a CHECK.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PART 2 — `purchase_suggestions.converted_to_pr_id` gets its foreign key
 * ═══════════════════════════════════════════════════════════════════════════
 * That column has never had one, and it shows: suggestion 9 points at
 * purchase_request 1451, which does not exist. 20260926000011 left it alone
 * because the choice looked binary — lose the record that suggestion 9 was
 * converted, or keep a dangling pointer forever.
 *
 * It is not binary. `ADD CONSTRAINT ... NOT VALID` adds the constraint and skips
 * the initial table scan: every INSERT and UPDATE from now on is checked, while
 * the one pre-existing row is grandfathered. So:
 *
 *   - no historical fact is destroyed (suggestion 9 still records that it WAS
 *     converted, and into which id),
 *   - no NEW dangling pointer can be created, and
 *   - `ALTER TABLE ... VALIDATE CONSTRAINT` remains available for whenever a human
 *     decides what to do about row 9 — the decision is deferred, not lost.
 *
 * ⚠ A NOT VALID foreign key IS enforced on any UPDATE of a grandfathered row. So
 * updating suggestion 9 will now fail until its pointer is resolved. Nothing does:
 * `rejectSuggestion()` requires `status = 'pending'` and `convertSuggestionToPR()`
 * requires `status <> 'converted_to_pr'`, and row 9 is 'converted_to_pr'. Failing
 * loudly is the right outcome if some future path tries.
 *
 * ON DELETE SET NULL, matching `source_suggestion_id`'s direction: deleting a
 * requisition must not cascade into deleting the reorder signal that produced it.
 */

const TRIGGER_FN = 'inventory_batches_tenant_guard';

export async function up(knex) {
  // ── PART 1a: backfill, so NOT NULL cannot fail on data ────────────────────
  // Re-runnable and scoped to exactly the rows that need it. A lot whose item is
  // missing is left alone rather than guessed at — and the count below reports it
  // rather than letting the ALTER fail with no explanation.
  const { rows: filled } = await knex.raw(`
    UPDATE inventory_batches ib
       SET company_id = ii.company_id
      FROM inventory_items ii
     WHERE ii.id = ib.item_id
       AND ib.company_id IS NULL
       AND ii.company_id IS NOT NULL
    RETURNING ib.id
  `);
  if (filled.length) {
    console.log(`[20260926000013] stamped company_id on ${filled.length} batch row(s) from their item`);
  }

  // ── PART 1b: NOT NULL, but only over data this migration can prove is clean ──
  // Re-count first and SKIP with a warning rather than failing the deploy. This
  // same file runs against databases whose history is not this one's.
  const { rows: [remaining] } = await knex.raw(
    `SELECT COUNT(*)::int AS n FROM inventory_batches WHERE company_id IS NULL`);
  if (remaining.n > 0) {
    console.warn(
      `[20260926000013] ⚠ SKIPPING NOT NULL on inventory_batches.company_id — ` +
      `${remaining.n} row(s) still have no tenant and no item to derive one from. ` +
      `Resolve those rows and re-run, or the transitive tenant scoping in ` +
      `advancedInventory.repository.js remains the only boundary for them.`);
  } else {
    await knex.raw(`ALTER TABLE inventory_batches ALTER COLUMN company_id SET NOT NULL`);
  }

  // ── PART 1c: the invariant that makes transitive scoping sound ─────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${TRIGGER_FN}() RETURNS trigger AS $fn$
    DECLARE
      item_company INTEGER;
    BEGIN
      SELECT ii.company_id INTO item_company
        FROM inventory_items ii WHERE ii.id = NEW.item_id;

      IF item_company IS NULL THEN
        -- Either the item does not exist (the FK will say so more clearly) or the
        -- item itself is tenant-less. Neither is something to invent a tenant for.
        RETURN NEW;
      END IF;

      IF NEW.company_id IS NULL THEN
        -- FILL: a lot can never again be born tenant-less, whoever writes it.
        NEW.company_id := item_company;
      ELSIF NEW.company_id <> item_company THEN
        -- VALIDATE: a supplied company that disagrees with the item's is a tenant
        -- bug. Overwriting it silently would hide the defect; say so instead.
        RAISE EXCEPTION
          'inventory_batches.company_id (%) does not match inventory_items.company_id (%) for item % — a lot belongs to the tenant that owns the item',
          NEW.company_id, item_company, NEW.item_id
          USING ERRCODE = 'check_violation';
      END IF;

      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql
  `);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_${TRIGGER_FN} ON inventory_batches`);
  await knex.raw(`
    CREATE TRIGGER trg_${TRIGGER_FN}
      BEFORE INSERT OR UPDATE OF company_id, item_id ON inventory_batches
      FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}()
  `);

  // ── PART 2: the grandfathering foreign key ────────────────────────────────
  const { rows: existing } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'fk_suggestions_converted_pr'`);
  if (!existing.length) {
    const { rows: dangling } = await knex.raw(`
      SELECT ps.id, ps.converted_to_pr_id
        FROM purchase_suggestions ps
        LEFT JOIN purchase_requests pr ON pr.id = ps.converted_to_pr_id
       WHERE ps.converted_to_pr_id IS NOT NULL AND pr.id IS NULL
       ORDER BY ps.id`);

    await knex.raw(`
      ALTER TABLE purchase_suggestions
        ADD CONSTRAINT fk_suggestions_converted_pr
        FOREIGN KEY (converted_to_pr_id) REFERENCES purchase_requests(id)
        ON DELETE SET NULL
        NOT VALID
    `);

    if (dangling.length) {
      console.log(
        `[20260926000013] fk_suggestions_converted_pr added NOT VALID — ` +
        `${dangling.length} pre-existing dangling pointer(s) grandfathered: ` +
        dangling.map(d => `suggestion ${d.id} -> PR ${d.converted_to_pr_id}`).join(', ') +
        `. New writes are checked; run VALIDATE CONSTRAINT once these are resolved.`);
    } else {
      // Nothing to grandfather, so make it a fully validated constraint straight
      // away rather than leaving a NOT VALID one behind for no reason.
      await knex.raw(
        `ALTER TABLE purchase_suggestions VALIDATE CONSTRAINT fk_suggestions_converted_pr`);
      console.log(`[20260926000013] fk_suggestions_converted_pr added and VALIDATED (no dangling pointers)`);
    }
  }
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE purchase_suggestions DROP CONSTRAINT IF EXISTS fk_suggestions_converted_pr`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_${TRIGGER_FN} ON inventory_batches`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${TRIGGER_FN}()`);
  // The NOT NULL is dropped, but the backfilled company_id values are LEFT IN
  // PLACE: they were derived from each row's own item and are correct regardless
  // of whether the constraint is enforced. Rolling back the constraint is the
  // reversible part; re-NULLing rows to recreate a defect is not.
  await knex.raw(`ALTER TABLE inventory_batches ALTER COLUMN company_id DROP NOT NULL`);
}
