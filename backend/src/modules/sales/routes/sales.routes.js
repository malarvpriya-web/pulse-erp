import express from 'express';
const router = express.Router();
import quotationsRepository from '../repositories/quotations.repository.js';
import salesOrdersRepository from '../repositories/salesOrders.repository.js';
import salesTargetsRepository from '../repositories/salesTargets.repository.js';

// Quotations
router.get('/quotations', async (req, res) => {
  try {
    const quotations = await quotationsRepository.findAll(req.query);
    res.json(quotations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/quotations/next-number', async (req, res) => {
  try {
    const number = await quotationsRepository.getNextQuotationNumber();
    res.json({ number });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/quotations/:id', async (req, res) => {
  try {
    const quotation = await quotationsRepository.findById(req.params.id);
    if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
    res.json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/quotations', async (req, res) => {
  try {
    const quotation = await quotationsRepository.create({ ...req.body, created_by: req.user?.id });
    res.status(201).json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/quotations/:id', async (req, res) => {
  try {
    const quotation = await quotationsRepository.update(req.params.id, req.body);
    res.json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/quotations/:id', async (req, res) => {
  try {
    await quotationsRepository.delete(req.params.id);
    res.json({ message: 'Quotation deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/quotations/:id/items', async (req, res) => {
  try {
    const items = await quotationsRepository.getItems(req.params.id);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/quotations/:id/items', async (req, res) => {
  try {
    const item = await quotationsRepository.addItem({ ...req.body, quotation_id: req.params.id });
    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sales Orders
router.get('/orders', async (req, res) => {
  try {
    const orders = await salesOrdersRepository.findAll(req.query);
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/next-number', async (req, res) => {
  try {
    const number = await salesOrdersRepository.getNextOrderNumber();
    res.json({ number });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const order = await salesOrdersRepository.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders', async (req, res) => {
  try {
    const order = await salesOrdersRepository.create({ ...req.body, created_by: req.user?.id });
    
    // Update quotation status if created from quotation
    if (req.body.quotation_id) {
      await quotationsRepository.update(req.body.quotation_id, { status: 'accepted' });
    }
    
    res.status(201).json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/orders/:id', async (req, res) => {
  try {
    const order = await salesOrdersRepository.update(req.params.id, req.body);
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/orders/:id', async (req, res) => {
  try {
    await salesOrdersRepository.delete(req.params.id);
    res.json({ message: 'Order deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/:id/items', async (req, res) => {
  try {
    const items = await salesOrdersRepository.getItems(req.params.id);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders/:id/items', async (req, res) => {
  try {
    const item = await salesOrdersRepository.addItem({ ...req.body, order_id: req.params.id });
    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sales Targets
router.get('/targets', async (req, res) => {
  try {
    const targets = await salesTargetsRepository.findAll(req.query);
    res.json(targets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/targets', async (req, res) => {
  try {
    const target = await salesTargetsRepository.upsert(req.body);
    res.json(target);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Analytics
router.get('/analytics/monthly-revenue', async (req, res) => {
  try {
    const data = await salesOrdersRepository.getMonthlyRevenue();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/top-customers', async (req, res) => {
  try {
    const limit = req.query.limit || 10;
    const data = await salesOrdersRepository.getTopCustomers(limit);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/sales-vs-target', async (req, res) => {
  try {
    const data = await salesTargetsRepository.getSalesVsTarget();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

