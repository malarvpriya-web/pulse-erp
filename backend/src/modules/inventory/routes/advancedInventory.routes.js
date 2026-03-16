import express from 'express';
import repo from '../repositories/advancedInventory.repository.js';
import purchaseRequestRepo from '../../procurement/repositories/purchaseRequest.repository.js';

const router = express.Router();

// =====================================================
// BATCH MANAGEMENT
// =====================================================
router.post('/batches', async (req, res) => {
  try {
    const batch = await repo.createBatch(req.body);
    res.status(201).json(batch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/batches', async (req, res) => {
  try {
    const batches = await repo.getBatches(req.query);
    res.json(batches);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/batches/:id/consume', async (req, res) => {
  try {
    const { quantity } = req.body;
    const batch = await repo.updateBatchQuantity(req.params.id, quantity, 'consume');
    res.json(batch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// RESERVATIONS
// =====================================================
router.post('/reservations', async (req, res) => {
  try {
    const reservation = await repo.createReservation({ ...req.body, reserved_by: req.user.id });
    res.status(201).json(reservation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reservations', async (req, res) => {
  try {
    const reservations = await repo.getReservations(req.query);
    res.json(reservations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/reservations/:id/consume', async (req, res) => {
  try {
    const { quantity_consumed } = req.body;
    const reservation = await repo.consumeReservation(req.params.id, quantity_consumed);
    res.json(reservation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/reservations/:id/cancel', async (req, res) => {
  try {
    const reservation = await repo.cancelReservation(req.params.id);
    res.json(reservation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// ALLOCATIONS
// =====================================================
router.post('/allocations', async (req, res) => {
  try {
    const allocation = await repo.createAllocation({ ...req.body, allocated_by: req.user.id });
    res.status(201).json(allocation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/allocations', async (req, res) => {
  try {
    const allocations = await repo.getAllocations(req.query);
    res.json(allocations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// STOCK ALERTS & SUGGESTIONS
// =====================================================
router.get('/alerts', async (req, res) => {
  try {
    const alerts = await repo.getStockAlerts(req.query);
    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/alerts/:id/acknowledge', async (req, res) => {
  try {
    const alert = await repo.acknowledgeAlert(req.params.id, req.user.id);
    res.json(alert);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/purchase-suggestions', async (req, res) => {
  try {
    const suggestions = await repo.getPurchaseSuggestions(req.query);
    res.json(suggestions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/purchase-suggestions/:id/convert', async (req, res) => {
    try {
        const suggestion = (await repo.getPurchaseSuggestions({ id: req.params.id }))?.[0];
        if (!suggestion) {
            return res.status(404).json({ error: 'Suggestion not found' });
        }
        const prNumber = await purchaseRequestRepo.getNextNumber();
        const pr = await purchaseRequestRepo.create({
            request_number: prNumber,
            requested_by_employee_id: req.user.id,
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
        res.status(500).json({ error: error.message });
    }
});

// =====================================================
// ANALYTICS
// =====================================================
router.get('/stock-summary', async (req, res) => {
  try {
    const summary = await repo.getStockSummary(req.query);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stock-aging', async (req, res) => {
  try {
    const aging = await repo.getStockAgingReport(req.query.warehouse_id);
    res.json(aging);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/material-consumption', async (req, res) => {
  try {
    const consumption = await repo.getMaterialConsumptionByProject(req.query.project_id);
    res.json(consumption);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const metrics = await repo.getDashboardMetrics();
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reserved-vs-available', async (req, res) => {
  try {
    const data = await repo.getReservedVsAvailableStock(req.query.warehouse_id);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;