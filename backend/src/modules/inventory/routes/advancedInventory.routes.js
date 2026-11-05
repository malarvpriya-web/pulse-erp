/**
 * advancedInventory.routes.js — mounted at /api/v1/inventory/advanced
 * (inventory.routes.js:2560), behind `verifyToken` (server.js:627).
 *
 * TENANT SCOPING (2026-09-26)
 * ===========================
 * Before this pass, 14 of this router's 20 endpoints applied NO tenant filter at
 * all. `requirePermission('inventory', ...)` was the only gate, and permission is
 * not scope: every authenticated user in every company holds `inventory:view` on
 * their own inventory, and that same grant was reading — and in seven cases
 * WRITING — every other company's.
 *
 * What was reachable cross-tenant, verified against the live schema:
 *
 *   READS   GET /batches · /allocations · /alerts · /purchase-suggestions ·
 *           /stock-summary · /stock-aging · /material-consumption · /dashboard
 *   WRITES  PUT /batches/:id/consume · POST /reservations ·
 *           /reservations/:id/consume · /reservations/:id/cancel ·
 *           /allocations · /alerts/:id/acknowledge · /alerts/:id/resolve ·
 *           /purchase-suggestions/:id/reject · /purchase-suggestions/:id/convert
 *
 * The write set is the serious half. `/batches/:id/consume` drives another
 * tenant's lot to zero; `/reservations/:id/cancel` releases stock they had
 * committed to a production order; `/purchase-suggestions/:id/convert` moved a
 * purchase commitment ACROSS the tenant boundary in the direction that creates
 * spend.
 *
 * Only three endpoints were already correct — GET /reservations,
 * GET /reserved-vs-available and POST /batches — which is why the hole was not
 * obvious: the module looked scoped wherever anyone had last looked.
 *
 * ⚠ FOUR of these tables have no `company_id` column at all
 * (`purchase_suggestions`, `inventory_reservations`, `inventory_allocations`,
 * `stock_alerts`), so the boundary is transitive through
 * `inventory_items.company_id` and has to be re-stated in every query. There is no
 * row-level rule doing it for us. See the repository header.
 *
 * ⚠ A cross-tenant id returns 404, never 403. 403 confirms the row exists, which
 * turns any of these endpoints into an inventory-size oracle for a neighbouring
 * tenant.
 */
import express from 'express';
import pool from '../../shared/db.js';
import repo from '../repositories/advancedInventory.repository.js';
// `purchaseRequestRepo` was imported here to build the requisition inline; the
// conversion moved to suggestionToPr.service.js, which owns that dependency now.
import { convertSuggestionToPurchaseRequest } from '../services/suggestionToPr.service.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
// The one helper that writes a stock_ledger row, updates current_stock and runs
// reorder-breach detection. A batch created without it is stock the ledger has
// no record of.
import { postStock } from '../../production/subcontracting.routes.js';

const router = express.Router();

// ensure resolved_by column exists
(async () => {
  try {
    await pool.query(`ALTER TABLE stock_alerts ADD COLUMN IF NOT EXISTS resolved_by INTEGER`);
  } catch (_) {}
})();

// =====================================================
// BATCH MANAGEMENT
// =====================================================
/**
 * POST /batches — book a batch of stock in by hand (Batch Tracking screen).
 *
 * Three faults, one of which reopened an invariant the procurement pass had
 * just closed:
 *
 *  1. `repo.createBatch(req.body)` mass-assigned the whole request body into an
 *     INSERT. Whatever the caller sent, the column list decided what stuck —
 *     there was no statement of which fields this endpoint accepts.
 *  2. No tenant check at all: any authenticated caller with inventory-add could
 *     book stock against another company's item and warehouse. (At the time
 *     `inventory_batches.company_id` was nullable and unvalidated, so the boundary
 *     had to be enforced through the parents — which is still done below, and is
 *     now backed by the trigger described at point 4.)
 *  3. It created a BATCH WITH NO LEDGER ENTRY. A batch is usable stock — it is
 *     what allocation, valuation and `v_batch_stock` read — so this was a way to
 *     conjure stock that the ledger, the thing an auditor reconciles against,
 *     has no record of. That is exactly the divergence migration 20260903000011
 *     had to clean up after the GRN path, reachable by hand from a screen.
 *
 * Batch and ledger are now written together on one transaction client, the same
 * rule grn.service.postAcceptedStock follows.
 *
 *  4. CLOSED 2026-09-26 (migration 20260926000013), previously listed here as "not
 *     fixed": `inventory_batches.company_id` is now NOT NULL, and
 *     `trg_inventory_batches_tenant_guard` fills it from the item when a caller
 *     omits it and RAISES when a caller supplies one that disagrees with the item's.
 *     So a lot can no longer be born tenant-less, and the batch's company can no
 *     longer drift from its item's — which is what made "scope through the item"
 *     and "scope through the batch" answer differently. The parent checks below are
 *     still the authorization boundary; the trigger is the data invariant beneath
 *     them.
 */
router.post('/batches', requirePermission('inventory', 'add'), async (req, res) => {
  const b = req.body || {};
  const itemId      = parseInt(b.item_id, 10);
  const warehouseId = parseInt(b.warehouse_id, 10);
  const quantity    = parseFloat(b.quantity_received);
  const rate        = parseFloat(b.rate);

  if (!Number.isFinite(itemId))      return res.status(400).json({ error: 'item_id is required.' });
  if (!Number.isFinite(warehouseId)) return res.status(400).json({ error: 'warehouse_id is required — a batch has to be booked into a location.' });
  if (!(quantity > 0))               return res.status(400).json({ error: 'quantity_received must be greater than zero.' });

  const companyId = companyOf(req);
  const client = await pool.connect();
  try {
    // Both parents, in the caller's company. This is the tenant boundary.
    const { rows: [item] } = await client.query(
      `SELECT id, item_name FROM inventory_items
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [itemId, companyId]);
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    const { rows: [wh] } = await client.query(
      `SELECT id FROM warehouses
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [warehouseId, companyId]);
    if (!wh) return res.status(404).json({ error: 'Warehouse not found.' });

    const receivedDate = b.received_date || new Date().toISOString().slice(0, 10);
    // stock_ledger.created_by FKs employees(id), not users(id).
    const createdBy = await employeeOf(req, pool);

    await client.query('BEGIN');

    // Only the fields the Batch Tracking form actually offers.
    const batch = await repo.createBatch({
      item_id:           itemId,
      warehouse_id:      warehouseId,
      batch_number:      b.batch_number || `BATCH-${Date.now()}`,
      received_date:     receivedDate,
      expiry_date:       b.expiry_date || null,
      supplier_id:       Number.isFinite(parseInt(b.supplier_id, 10)) ? parseInt(b.supplier_id, 10) : null,
      quantity_received: quantity,
      rate:              Number.isFinite(rate) ? rate : 0,
    }, client);

    await postStock(client, {
      itemId,
      warehouseId,
      inQty: quantity,
      txnType: 'batch_receipt',
      refType: 'inventory_batch',
      refId: batch.id,
      rate: Number.isFinite(rate) ? rate : 0,
      remarks: `Batch ${batch.batch_number} booked in manually`,
      createdBy,
      companyId,
      transactionDate: receivedDate,
    });

    await client.query('COMMIT');
    res.status(201).json(batch);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(error.status || 500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// `...req.query` FIRST, then company_id — never the other way round, or a caller
// sending `?company_id=2` overrides their own scope and the filter becomes a
// client-supplied parameter. That ordering is the whole tenant boundary on this
// endpoint; it is repeated in every list handler below for the same reason.
router.get('/batches', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const batches = await repo.getBatches({ ...req.query, company_id: companyOf(req) });
    res.json(batches);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put('/batches/:id/consume', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { quantity } = req.body;
    const batch = await repo.updateBatchQuantity(req.params.id, quantity, 'consume', companyOf(req));
    res.json(batch);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// =====================================================
// RESERVATIONS
// =====================================================
router.post('/reservations', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const reservation = await repo.createReservation({
      ...req.body,
      reserved_by: req.user.userId ?? req.user.id,
      company_id: companyOf(req),
    });
    res.status(201).json(reservation);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reservations', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const reservations = await repo.getReservations({ ...req.query, company_id: companyOf(req) });
    res.json(reservations);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/reservations/:id/consume', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { quantity_consumed } = req.body;
    const reservation = await repo.consumeReservation(req.params.id, quantity_consumed, companyOf(req));
    res.json(reservation);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/reservations/:id/cancel', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const reservation = await repo.cancelReservation(req.params.id, companyOf(req));
    // Was returning `undefined` as a 200 with an empty body for a reservation that
    // does not exist — and now, for one belonging to another tenant. Both are 404.
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    res.json(reservation);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// =====================================================
// ALLOCATIONS
// =====================================================
router.post('/allocations', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const allocation = await repo.createAllocation({
      ...req.body,
      allocated_by: req.user.userId ?? req.user.id,
      company_id: companyOf(req),
    });
    res.status(201).json(allocation);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/allocations', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const allocations = await repo.getAllocations({ ...req.query, company_id: companyOf(req) });
    res.json(allocations);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// =====================================================
// STOCK ALERTS & SUGGESTIONS
// =====================================================
router.get('/alerts', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const alerts = await repo.getStockAlerts({ ...req.query, company_id: companyOf(req) });
    res.json(alerts);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/alerts/:id/acknowledge', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const alert = await repo.acknowledgeAlert(req.params.id, req.user.userId ?? req.user.id, companyOf(req));
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json(alert);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Was an inline UPDATE with no tenant predicate, while `repo.resolveAlert()` sat
// unused one file over. That is how the two drifted: the route grew a
// `resolved_by` the repository function did not have, so nobody went back to the
// repository, and the repository's version stayed dead. One implementation now,
// with the company boundary in it.
router.post('/alerts/:id/resolve', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const uid = req.user?.userId ?? req.user?.id;
    const alert = await repo.resolveAlert(req.params.id, uid, companyOf(req));
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json(alert);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/purchase-suggestions', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const suggestions = await repo.getPurchaseSuggestions({ ...req.query, company_id: companyOf(req) });
    res.json(suggestions);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/purchase-suggestions/:id/reject', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { reason } = req.body;
    const uid = req.user?.userId ?? req.user?.id;
    const result = await repo.rejectSuggestion(req.params.id, uid, reason || '', companyOf(req));
    // Covers three cases with one answer, deliberately: no such suggestion,
    // another tenant's suggestion, or one that is no longer 'pending' (already
    // converted or already rejected). The first two must be indistinguishable;
    // the third is reported as 409 only when the row IS visible to this caller.
    if (!result) {
      const visible = (await repo.getPurchaseSuggestions({ id: req.params.id, company_id: companyOf(req) }))?.[0];
      if (visible) {
        return res.status(409).json({ error: `Suggestion is already '${visible.status}' and cannot be rejected.` });
      }
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

/**
 * POST /purchase-suggestions/:id/convert
 *
 * Delegates to inventory/services/suggestionToPr.service.js, which is now the ONE
 * implementation of this conversion — `jobs/reorderPr.cron.js` calls the same
 * function. Read that file's header for why there is one, and for the three
 * mechanisms (row lock, post-lock status re-check, unique index) that make a
 * double-click or a retry produce one requisition instead of two.
 *
 * Two faults closed here that were properties of THIS handler, not of the shared
 * body:
 *
 *  1. NO TENANT CHECK. `repo.getPurchaseSuggestions({ id })` carried no company
 *     predicate, so any caller holding `inventory:add` could name another
 *     company's suggestion id and convert it — creating a purchase commitment in
 *     their own company against a neighbouring tenant's reorder signal, and
 *     flipping that tenant's suggestion to 'converted_to_pr' so their own buyer
 *     would never see it again. The service resolves the suggestion through
 *     `inventory_items.company_id` and reports a cross-tenant id as 404.
 *
 *  2. NOT IDEMPOTENT. The suggestion was read with a plain SELECT before the
 *     transaction and never re-checked after it, so two simultaneous clicks — or
 *     one click retried after a timeout, which `convert()` in
 *     StockAlertsAndSuggestions.jsx does not guard against — both created a
 *     requisition. The second overwrote `converted_to_pr_id`, leaving the first
 *     requisition in the register with nothing pointing at it.
 *
 * API COMPATIBILITY, deliberately preserved:
 *   - 201 with the full requisition body (purchaseRequestRepo.findById shape) on a
 *     conversion, exactly as before. Both frontend callers
 *     (StockAlertsAndSuggestions.jsx, procurement/MRPPlanning.jsx) ignore the body
 *     and refetch, so the shape is for whoever reads it next.
 *   - The requisition's initial status is still whatever
 *     `purchaseRequestRepo.PR_INITIAL_STATUS` says ('pending_approval'). The cron
 *     passes 'draft' instead; that difference is real and is preserved as an
 *     argument rather than unified, because changing what the Convert button
 *     produces is a product decision, not a refactor.
 *   - A REPEAT convert now answers 200 (not 201) with the requisition that already
 *     exists, rather than the 404/500 it used to give once the status had flipped.
 *     That is a strictly wider set of successful responses, so no existing client
 *     breaks.
 */
router.post('/purchase-suggestions/:id/convert', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const { created, purchase_request } = await convertSuggestionToPurchaseRequest({
      suggestionId: req.params.id,
      companyId: companyOf(req),
      // employeeOf(), never req.user.userId: this column FKs employees(id), and a
      // users.id there FK-violates for most accounts in this database.
      requestedByEmployeeId: await employeeOf(req, pool),
    });
    res.status(created ? 201 : 200).json(purchase_request);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// =====================================================
// ANALYTICS
// =====================================================
router.get('/stock-summary', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const summary = await repo.getStockSummary({ ...req.query, company_id: companyOf(req) });
    res.json(summary);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/stock-aging', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const aging = await repo.getStockAgingReport(req.query.warehouse_id, companyOf(req));
    res.json(aging);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/material-consumption', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const consumption = await repo.getMaterialConsumptionByProject(req.query.project_id, companyOf(req));
    res.json(consumption);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reserved-vs-available', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const data = await repo.getReservedVsAvailableStock(req.query.warehouse_id, companyOf(req));
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

/**
 * GET /dashboard — the tiles on AdvancedInventoryDashboard.jsx.
 *
 * Delegates to `repo.getDashboardMetrics()`, which is now the ONE implementation.
 *
 * ⚠ THERE WERE TWO, AND THEY DISAGREED ON WHAT "RESERVED" MEANS. This handler had
 * its own inline SQL while `repo.getDashboardMetrics()` computed overlapping
 * figures a different way — and that copy derived reserved value from
 * `inventory_batches.quantity_reserved`, a column **nothing in this codebase has
 * ever written** (0 of 15 rows non-zero, no writers, verified 2026-09-26). So one
 * of the two numbers under the label "reserved value" was structurally always
 * zero. Whichever a future caller happened to pick decided the answer.
 *
 * The derivation that survived is the one this handler had — reserved from the open
 * `inventory_reservations`, available from the ledger via `v_stock_summary` — and it
 * now lives in the repository so there is nothing left to disagree with.
 *
 * Every one of the tiles was also unscoped before this batch: a company-scoped user
 * read the whole install's alert count, reservation count, suggestion backlog and
 * stock value.
 *
 * ⚠ RESPONSE SHAPE IS A SUPERSET of what this endpoint returned before — the six
 * original keys are unchanged, plus `active_alerts` and the three holding-cost
 * fields the repository already computed. Additive, so the dashboard does not
 * break. `low_stock_alerts` now genuinely counts only low-stock alerts; the inline
 * version labelled the tile `low_stock_alerts` while counting ALL active alerts, so
 * one expiring-batch alert inflated it. `active_alerts` carries that total for
 * anyone who wanted it.
 */
router.get('/dashboard', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    res.json(await repo.getDashboardMetrics(companyOf(req)));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
