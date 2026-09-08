import express from 'express';
import pool from '../../shared/db.js';
import repo from '../repositories/advancedInventory.repository.js';
import purchaseRequestRepo from '../../procurement/repositories/purchaseRequest.repository.js';
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
 *  2. No tenant check at all. `inventory_batches` has no `company_id` column, so
 *     the boundary has to be enforced through the parents, and it was not: any
 *     authenticated caller with inventory-add could book stock against another
 *     company's item and warehouse.
 *  3. It created a BATCH WITH NO LEDGER ENTRY. A batch is usable stock — it is
 *     what allocation, valuation and `v_batch_stock` read — so this was a way to
 *     conjure stock that the ledger, the thing an auditor reconciles against,
 *     has no record of. That is exactly the divergence migration 20260903000011
 *     had to clean up after the GRN path, reachable by hand from a screen.
 *
 * Batch and ledger are now written together on one transaction client, the same
 * rule grn.service.postAcceptedStock follows.
 *
 * ⚠ NOT fixed here: `inventory_batches` still has no `company_id` of its own, so
 * its tenancy remains transitive through the item and warehouse checked below.
 * Giving it the column is a migration that also touches the GRN write path, and
 * is worth doing on its own rather than as a rider on this route.
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

router.get('/batches', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const batches = await repo.getBatches(req.query);
    res.json(batches);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put('/batches/:id/consume', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { quantity } = req.body;
    const batch = await repo.updateBatchQuantity(req.params.id, quantity, 'consume');
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
    const reservation = await repo.createReservation({ ...req.body, reserved_by: req.user.userId ?? req.user.id });
    res.status(201).json(reservation);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reservations', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const reservations = await repo.getReservations(req.query);
    res.json(reservations);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/reservations/:id/consume', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { quantity_consumed } = req.body;
    const reservation = await repo.consumeReservation(req.params.id, quantity_consumed);
    res.json(reservation);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/reservations/:id/cancel', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const reservation = await repo.cancelReservation(req.params.id);
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
    const allocation = await repo.createAllocation({ ...req.body, allocated_by: req.user.userId ?? req.user.id });
    res.status(201).json(allocation);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/allocations', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const allocations = await repo.getAllocations(req.query);
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
    const alerts = await repo.getStockAlerts(req.query);
    res.json(alerts);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/alerts/:id/acknowledge', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const alert = await repo.acknowledgeAlert(req.params.id, req.user.userId ?? req.user.id);
    res.json(alert);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/alerts/:id/resolve', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const uid = req.user?.userId ?? req.user?.id;
    const { rows } = await pool.query(
      `UPDATE stock_alerts SET status='resolved', resolved_by=$1, resolved_at=NOW()
       WHERE id=$2 RETURNING *`,
      [uid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Alert not found' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/purchase-suggestions', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const suggestions = await repo.getPurchaseSuggestions(req.query);
    res.json(suggestions);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/purchase-suggestions/:id/reject', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { reason } = req.body;
    const uid = req.user?.userId ?? req.user?.id;
    const result = await repo.rejectSuggestion(req.params.id, uid, reason || '');
    if (!result) return res.status(404).json({ error: 'Suggestion not found' });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/purchase-suggestions/:id/convert', requirePermission('inventory', 'add'), async (req, res) => {
  // Was calling purchaseRequestRepo.create(data) — that repository's real
  // signature is create(client, data); passing just one arg meant `client`
  // silently became the data object and `data` was undefined, throwing
  // immediately ("Cannot destructure property 'request_number' of 'data'")
  // on every real call. Also never inserted the suggestion as a line item
  // (purchase_request_items) or called recomputeTotal() — the same
  // "empty PR" bug class already fixed for the RFQ-award path elsewhere in
  // this codebase — so even a naive arity fix alone would still ship a
  // ₹0 header with no items. Now mirrors POST /purchase-requests's own
  // create+createItem+recomputeTotal transaction exactly.
  const client = await pool.connect();
  try {
    const suggestion = (await repo.getPurchaseSuggestions({ id: req.params.id }))?.[0];
    if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });

    await client.query('BEGIN');
    // The company and the transaction client both matter: without the company
    // the number ignores the configured pr_prefix, and without the client it is
    // drawn on a different connection and is not part of this unit of work.
    const companyId = companyOf(req);
    const prNumber = await purchaseRequestRepo.getNextNumber(client, companyId);
    const pr = await purchaseRequestRepo.create(client, {
      request_number: prNumber,
      // employeeOf(), never req.user.userId: this column FKs employees(id), and
      // the users.id fallback that used to sit here FK-violates for any account
      // whose users.id is not coincidentally also an employees.id.
      requested_by_employee_id: await employeeOf(req, pool),
      request_date: new Date(),
      // Without this the requisition is born NULL-company and is invisible to
      // every company-scoped user, including the buyer who converted it.
      company_id: companyId,
      notes: `Generated from purchase suggestion for item ${suggestion.item_code}`,
    });
    await purchaseRequestRepo.createItem(client, {
      pr_id: pr.id,
      item_id: suggestion.item_id,
      item_name: suggestion.item_name,
      quantity: suggestion.suggested_quantity,
      // Best-effort so the PR's total isn't a silent ₹0 (recomputeTotal sums
      // quantity × expected_price, and that total drives approval routing) —
      // real quote pricing isn't known yet at this stage, so the item's own
      // standard cost is the closest honest estimate available.
      expected_price: suggestion.standard_cost || 0,
    });
    await purchaseRequestRepo.recomputeTotal(client, pr.id);
    await repo.convertSuggestionToPR(req.params.id, pr.id, client);
    await client.query('COMMIT');
    res.status(201).json(await purchaseRequestRepo.findById(pr.id, companyId));
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.status || 500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// =====================================================
// ANALYTICS
// =====================================================
router.get('/stock-summary', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const summary = await repo.getStockSummary(req.query);
    res.json(summary);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/stock-aging', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const aging = await repo.getStockAgingReport(req.query.warehouse_id);
    res.json(aging);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/material-consumption', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const consumption = await repo.getMaterialConsumptionByProject(req.query.project_id);
    res.json(consumption);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reserved-vs-available', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const data = await repo.getReservedVsAvailableStock(req.query.warehouse_id);
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/dashboard', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM stock_alerts        WHERE status = 'active')::int  AS low_stock_alerts,
        (SELECT COUNT(*) FROM inventory_reservations WHERE status = 'active')::int AS active_reservations,
        (SELECT COUNT(*) FROM purchase_suggestions WHERE status = 'pending')::int AS pending_suggestions,
        (SELECT COUNT(*) FROM inventory_batches
           WHERE expiry_date IS NOT NULL
             AND expiry_date <= NOW() + INTERVAL '30 days'
             AND expiry_date  > NOW()
             AND deleted_at IS NULL)::int AS expiring_batches,
        COALESCE((
          SELECT SUM(ir.quantity_remaining * COALESCE(ii.standard_cost, 0))
          FROM inventory_reservations ir
          JOIN inventory_items ii ON ii.id = ir.item_id
          WHERE ir.status = 'active' AND ii.deleted_at IS NULL
        ), 0)::numeric AS total_reserved_value,
        COALESCE((
          SELECT SUM(vs.current_stock * vs.avg_rate)
          FROM v_stock_summary vs
          WHERE vs.current_stock > 0
        ), 0)::numeric AS total_available_value
    `);
    res.json(rows[0]);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
