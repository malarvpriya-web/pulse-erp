/**
 * suggestionToPr.service.js — THE canonical purchase-suggestion → purchase-
 * requisition conversion.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * There were two implementations of this conversion, and they were near-copies:
 *
 *   A. `POST /inventory/advanced/purchase-suggestions/:id/convert`
 *      (advancedInventory.routes.js) — the Convert button. TWO frontend callers:
 *      `inventory/pages/StockAlertsAndSuggestions.jsx` and
 *      `procurement/pages/MRPPlanning.jsx`.
 *   B. `draftPrFromSuggestion()` in `jobs/reorderPr.cron.js` — daily 10:15.
 *
 * Both ran the same four steps (getNextNumber → create → createItem →
 * recomputeTotal → convertSuggestionToPR) and had already diverged in four ways,
 * each of which is a real behavioural difference nobody chose:
 *
 *   1. STATUS. (A) let `purchaseRequestRepo.create()` default it, which is
 *      `PR_INITIAL_STATUS = 'pending_approval'`. (B) passed `'draft'` explicitly.
 *      So the same suggestion became an approval-queue item or a draft depending
 *      on whether a human or the clock converted it.
 *   2. REQUESTER. (A) `employeeOf(req)` — whoever clicked. (B) an arbitrary
 *      active procurement_manager/exec for the company.
 *   3. TENANT. (A) read the suggestion with NO company predicate whatsoever, so
 *      any authenticated caller holding `inventory:add` could convert ANOTHER
 *      company's suggestion into a requisition in THEIR OWN company — moving a
 *      purchase commitment across the tenant boundary, in the direction that
 *      creates spend.
 *   4. NOTES. Different wording, which is fine, and is why it stays a parameter.
 *
 * Divergence 1, 2 and 4 are legitimate differences between a click and a cron and
 * are preserved as arguments. Divergence 3 was a defect in (A) and is closed.
 *
 * Keeping two copies also meant the concurrency fix below had to be made twice or
 * it was not made at all. That is the actual argument for one implementation:
 * not tidiness, but that a correctness property can only be maintained in one
 * place.
 *
 * WHICH IMPLEMENTATION IS CANONICAL
 * =================================
 * Neither, structurally: the shared transaction body is lifted here and BOTH
 * callers delegate. The cron's shape won on the two points where they disagreed
 * on substance —
 *
 *   - it passed `company_id` on the requisition (A did too, after an earlier
 *     fix), and
 *   - its comment block correctly identified that `getNextNumber` must take both
 *     the transaction client and the company or the document number is drawn
 *     outside the unit of work and ignores the company's configured `pr_prefix`.
 *
 * — while the route's `status` default is preserved for the route, because
 * changing what the Convert button produces is a product change and not this
 * batch's business.
 *
 * IDEMPOTENCE AND CONCURRENCY
 * ===========================
 * Three independent mechanisms, deliberately. The first two are code and the
 * third is the database; the database one is the only one that holds against a
 * caller that does not exist yet.
 *
 *   1. `SELECT ... FOR UPDATE` on the `purchase_suggestions` row, taken BEFORE
 *      anything is read from it. Two concurrent converts of the same suggestion
 *      now queue; the loser proceeds only after the winner has committed, and so
 *      sees `status = 'converted_to_pr'`.
 *
 *   2. The status re-check AFTER the lock. This is the half that was missing:
 *      both old implementations read the suggestion with a plain SELECT and
 *      trusted what they saw. In READ COMMITTED (this database's default) two
 *      transactions both see 'pending' and both commit — producing two
 *      requisitions, two line items, and a `converted_to_pr_id` pointing at the
 *      second, with the FIRST left in the register attributable to nothing. That
 *      is a duplicate purchase order of real money arising from a double-click.
 *      An already-converted suggestion now returns the EXISTING requisition with
 *      `created: false` — a retry is a no-op that answers correctly, which is
 *      what idempotent means here.
 *
 *   3. `uq_pr_source_suggestion`, a unique index on
 *      `purchase_requests.source_suggestion_id` (migration 20260926000011). If a
 *      second requisition for one suggestion is ever attempted — by a caller that
 *      skips this service, by two app instances, from psql — the INSERT raises
 *      23505 and the transaction dies rather than double-ordering. This service
 *      catches that code and converts it into the same idempotent "here is the
 *      existing one" answer, so the constraint is a safety net rather than a new
 *      failure mode for the legitimate retry path.
 */
import pool from '../../shared/db.js';
import purchaseRequestRepo from '../../procurement/repositories/purchaseRequest.repository.js';
import advancedInventoryRepo from '../repositories/advancedInventory.repository.js';

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Convert one purchase suggestion into one purchase requisition, exactly once.
 *
 * @param {object}  args
 * @param {number}  args.suggestionId
 * @param {number|null} args.companyId            the CALLER's tenant. The suggestion must
 *                                                belong to it; null = global scope.
 * @param {number|null} args.requestedByEmployeeId an employees.id, or null. Never a users.id —
 *                                                 `purchase_requests.requested_by_employee_id`
 *                                                 FKs employees, and a users.id there
 *                                                 FK-violates for most accounts in this
 *                                                 database.
 * @param {string}  [args.status]                 requisition status to create with. Omit to
 *                                                take purchaseRequestRepo's PR_INITIAL_STATUS.
 * @param {string}  [args.notes]
 * @param {string}  [args.priority]
 * @returns {Promise<{ created: boolean, purchase_request: object, suggestion_id: number }>}
 *          `created: false` means this suggestion was already converted and the
 *          requisition returned is the pre-existing one.
 */
export async function convertSuggestionToPurchaseRequest({
  suggestionId,
  companyId = null,
  requestedByEmployeeId = null,
  status,
  notes,
  priority,
}) {
  const sid = parseInt(suggestionId, 10);
  if (!Number.isFinite(sid)) {
    throw Object.assign(new Error('A numeric suggestion id is required'), { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /**
     * The lock and the tenant check, in one statement.
     *
     * `FOR UPDATE OF ps` locks only the suggestion — the joined item and warehouse
     * are read for their descriptive columns and must NOT be locked, or converting
     * a suggestion would block every other write touching that item for the
     * duration of the transaction.
     *
     * A cross-tenant id and a non-existent id are indistinguishable from here on,
     * which is the point: the caller learns nothing about another company's
     * suggestion backlog by probing integers.
     */
    const { rows: [suggestion] } = await client.query(
      `SELECT ps.id, ps.item_id, ps.warehouse_id, ps.suggested_quantity, ps.status,
              ps.converted_to_pr_id,
              ii.item_code, ii.item_name, ii.standard_cost, ii.unit_of_measure,
              ii.company_id AS item_company_id
         FROM purchase_suggestions ps
         JOIN inventory_items ii ON ii.id = ps.item_id
        WHERE ps.id = $1 AND ($2::int IS NULL OR ii.company_id = $2)
        FOR UPDATE OF ps`,
      [sid, companyId ?? null]);

    if (!suggestion) {
      await client.query('ROLLBACK');
      throw Object.assign(new Error('Suggestion not found'), { status: 404 });
    }

    // ── Mechanism 2: the post-lock re-check ────────────────────────────────────
    if (suggestion.status === 'converted_to_pr') {
      await client.query('ROLLBACK');
      // ⚠ `client`, NOT the pool. See the note on findRequisitionForSuggestion:
      // asking the pool for a second connection while still holding this one
      // deadlocks the pool under concurrency.
      const existing = await findRequisitionForSuggestion(client, sid, suggestion.converted_to_pr_id, companyId);
      if (!existing) {
        // The suggestion says converted but the requisition is gone — the state
        // one dangling pointer in this database is already in (suggestion 9 →
        // purchase_request 1451, which does not exist; see migration
        // 20260926000011). Do NOT silently mint a replacement: that is how a
        // suggestion whose requisition was deliberately hard-deleted gets
        // re-ordered. Say what is wrong and let a human decide.
        throw Object.assign(new Error(
          `Suggestion ${sid} is already marked converted, but requisition ` +
          `${suggestion.converted_to_pr_id} no longer exists. Raise a requisition ` +
          `directly rather than re-converting this suggestion.`), { status: 409 });
      }
      return { created: false, purchase_request: existing, suggestion_id: sid };
    }

    if (suggestion.status !== 'pending') {
      await client.query('ROLLBACK');
      throw Object.assign(new Error(
        `Suggestion ${sid} is '${suggestion.status}' and cannot be converted.`), { status: 422 });
    }

    // The requisition's company is the ITEM's company, never the caller's claimed
    // one. For a company-scoped caller the predicate above has already forced them
    // equal; for a global (super-admin) caller `companyId` is null, and a
    // requisition born NULL-company is invisible to every company-scoped user —
    // including the buyer who has to act on it.
    const prCompanyId = suggestion.item_company_id ?? companyId ?? null;

    const prNumber = await purchaseRequestRepo.getNextNumber(client, prCompanyId);
    const pr = await purchaseRequestRepo.create(client, {
      request_number: prNumber,
      requested_by_employee_id: requestedByEmployeeId ?? null,
      request_date: new Date(),
      company_id: prCompanyId,
      // Undefined means "let the repository's PR_INITIAL_STATUS decide", which is
      // what the Convert button did before this consolidation.
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      notes: notes ?? `Generated from purchase suggestion for item ${suggestion.item_code}`,
      // ── Mechanism 3 ────────────────────────────────────────────────────────
      source_suggestion_id: sid,
    });

    await purchaseRequestRepo.createItem(client, {
      pr_id: pr.id,
      item_id: suggestion.item_id,
      item_name: suggestion.item_name,
      quantity: suggestion.suggested_quantity,
      // Real quote pricing is not known at this stage; the item's standard cost is
      // the closest honest estimate, and a total of 0 would mis-route the
      // amount-banded approval this requisition is about to enter.
      expected_price: suggestion.standard_cost || 0,
    });
    await purchaseRequestRepo.recomputeTotal(client, pr.id);

    const flipped = await advancedInventoryRepo.convertSuggestionToPR(sid, pr.id, client);
    if (!flipped) {
      // Belt and braces: the repository's own `status <> 'converted_to_pr'` guard
      // matched nothing, which under the lock above should be unreachable. Abort
      // rather than commit a requisition whose suggestion does not point back.
      await client.query('ROLLBACK');
      throw Object.assign(new Error(
        `Suggestion ${sid} changed state during conversion; nothing was created.`), { status: 409 });
    }

    await client.query('COMMIT');
    // Still on `client` — this connection is ours until the finally block, and
    // reaching for a pool connection here is what deadlocked the pool.
    const full = await purchaseRequestRepo.findById(pr.id, prCompanyId, client);
    return { created: true, purchase_request: full ?? pr, suggestion_id: sid };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    // Mechanism 3 firing. Two writers got past the lock — different processes, a
    // caller bypassing this service, or a lock that was never taken because the
    // suggestion row was inserted concurrently. The winner's requisition is the
    // right answer; return it instead of a 500.
    if (err?.code === UNIQUE_VIOLATION && String(err.constraint || '').includes('uq_pr_source_suggestion')) {
      const existing = await findRequisitionForSuggestion(client, sid, null, companyId);
      if (existing) return { created: false, purchase_request: existing, suggestion_id: sid };
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The requisition a suggestion produced.
 *
 * Looked up by `source_suggestion_id` FIRST — that is the column the unique index
 * protects and the one a losing concurrent writer can trust. `converted_to_pr_id`
 * is the fallback for the 14 historical conversions, and is the column a racing
 * writer could have overwritten, which is exactly why it is second.
 *
 * ⚠⚠ TAKES A DB HANDLE, AND EVERY CALLER PASSES THE CONNECTION IT ALREADY HOLDS.
 *
 * This read happens on the two paths where a caller has LOST the race, and both of
 * them are still holding a pooled client (the `finally` that releases it has not
 * run yet). An earlier version of this function called `pool.query()` directly,
 * which asks the pool for a SECOND connection while the first is still checked out.
 *
 * That deadlocks. Measured: `config/db.js` caps the pool at 6 in test mode, so
 * eight simultaneous converts filled it — one winner made progress and five losers
 * each tried to acquire a seventh connection that could only become free when one
 * of them released, which none of them would until the read they were blocked on
 * returned. The symptom was a bare 500 from one request after a ~4s stall, which
 * reads as a flake rather than as pool starvation; it is the same class of fault
 * the vitest worker/pool budget in vitest.config.js exists to prevent, arriving
 * from application code instead of from the runner.
 *
 * Reading on the caller's own client is correct as well as necessary: it has just
 * ROLLBACKed, so the connection is idle and outside a transaction, and the row it
 * wants was committed by the winner.
 */
async function findRequisitionForSuggestion(db, suggestionId, convertedToPrId, companyId) {
  const { rows } = await db.query(
    `SELECT id FROM purchase_requests
      WHERE source_suggestion_id = $1 AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    [suggestionId]);
  const prId = rows[0]?.id ?? convertedToPrId ?? null;
  if (!prId) return null;
  return purchaseRequestRepo.findById(prId, companyId ?? null, db);
}

export default { convertSuggestionToPurchaseRequest };
