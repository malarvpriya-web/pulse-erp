import express from 'express';
import pool from '../../shared/db.js';
import repo from '../repositories/advancedInventory.repository.js';
import purchaseRequestRepo from '../../procurement/repositories/purchaseRequest.repository.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';

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
router.post('/batches', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const batch = await repo.createBatch(req.body);
    res.status(201).json(batch);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
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
  try {
    const suggestion = (await repo.getPurchaseSuggestions({ id: req.params.id }))?.[0];
    if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });

    const prNumber = await purchaseRequestRepo.getNextNumber();
    const pr = await purchaseRequestRepo.create({
      request_number: prNumber,
      requested_by_employee_id: req.user.employee_id ?? req.user.userId ?? req.user.id,
      request_date: new Date(),
      notes: `Generated from purchase suggestion for item ${suggestion.item_code}`,
      items: [{
        item_id: suggestion.item_id,
        item_name: suggestion.item_name,
        quantity: suggestion.suggested_quantity
      }]
    });
    await repo.convertSuggestionToPR(req.params.id, pr.id);
    res.status(201).json(pr);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
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
