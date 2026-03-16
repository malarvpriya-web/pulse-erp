import express from 'express';
import pool from '../../shared/db.js';
import itemRepo from '../repositories/inventoryItem.repository.js';
import stockLedgerRepo from '../repositories/stockLedger.repository.js';
import rmIssueService from '../services/rmIssue.service.js';

const router = express.Router();

// =====================================================
// INVENTORY ITEMS
// =====================================================
router.post('/items', async (req, res) => {
  try {
    const itemCode = await itemRepo.getNextCode();
    const item = await itemRepo.create({ ...req.body, item_code: itemCode });
    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/items', async (req, res) => {
  try {
    const items = await itemRepo.findAll(req.query);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/items/:id', async (req, res) => {
  try {
    const item = await itemRepo.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/items/:id', async (req, res) => {
  try {
    const item = await itemRepo.update(req.params.id, req.body);
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// WAREHOUSES
// =====================================================
router.get('/warehouses', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM warehouses WHERE deleted_at IS NULL ORDER BY warehouse_name'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// STOCK SUMMARY & REPORTS
// =====================================================
router.get('/stock/summary', async (req, res) => {
  try {
    const summary = await stockLedgerRepo.getStockSummary(req.query);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stock/low-stock', async (req, res) => {
  try {
    const lowStock = await stockLedgerRepo.getLowStockItems();
    res.json(lowStock);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stock/movement', async (req, res) => {
  try {
    const { item_id, warehouse_id, start_date, end_date } = req.query;
    const movement = await stockLedgerRepo.getStockMovement(item_id, warehouse_id, start_date, end_date);
    res.json(movement);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stock/valuation', async (req, res) => {
  try {
    const valuation = await stockLedgerRepo.getInventoryValuation(req.query.warehouse_id);
    res.json(valuation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// RM ISSUES
// =====================================================
router.post('/rm-issues', async (req, res) => {
  try {
    const issue = await rmIssueService.createIssue(req.body, req.user.id);
    res.status(201).json(issue);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/rm-issues', async (req, res) => {
  try {
    const issues = await rmIssueService.getIssues(req.query);
    res.json(issues);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/rm-issues/:id', async (req, res) => {
  try {
    const issue = await rmIssueService.getIssueById(req.params.id);
    if (!issue) {
      return res.status(404).json({ error: 'RM Issue not found' });
    }
    res.json(issue);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// STOCK TRANSFERS
// =====================================================
router.post('/stock-transfers', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const transferNumber = `STR${Date.now()}`;
      const result = await client.query(
        `INSERT INTO stock_transfers (transfer_number, from_warehouse_id, to_warehouse_id, transfer_date, transferred_by, notes) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [transferNumber, req.body.from_warehouse_id, req.body.to_warehouse_id, req.body.transfer_date, req.user.id, req.body.notes]
      );
      const transfer = result.rows[0];

      for (const item of req.body.items) {
        await client.query(
          `INSERT INTO stock_transfer_items (transfer_id, item_id, quantity) VALUES ($1, $2, $3)`,
          [transfer.id, item.item_id, item.quantity]
        );

        // Stock out from source warehouse
        await stockLedgerRepo.createEntry(client, {
          item_id: item.item_id,
          warehouse_id: req.body.from_warehouse_id,
          transaction_type: 'transfer',
          quantity_in: 0,
          quantity_out: item.quantity,
          rate: 0,
          reference_type: 'transfer',
          reference_id: transfer.id,
          transaction_date: req.body.transfer_date,
          remarks: `Transfer ${transferNumber} - Out`,
          created_by: req.user.id
        });

        // Stock in to destination warehouse
        await stockLedgerRepo.createEntry(client, {
          item_id: item.item_id,
          warehouse_id: req.body.to_warehouse_id,
          transaction_type: 'transfer',
          quantity_in: item.quantity,
          quantity_out: 0,
          rate: 0,
          reference_type: 'transfer',
          reference_id: transfer.id,
          transaction_date: req.body.transfer_date,
          remarks: `Transfer ${transferNumber} - In`,
          created_by: req.user.id
        });
      }

      await client.query('COMMIT');
      res.status(201).json(transfer);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stock-transfers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT st.*, wf.warehouse_name as from_warehouse, wt.warehouse_name as to_warehouse 
       FROM stock_transfers st
       JOIN warehouses wf ON st.from_warehouse_id = wf.id
       JOIN warehouses wt ON st.to_warehouse_id = wt.id
       WHERE st.deleted_at IS NULL ORDER BY st.transfer_date DESC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// STOCK ADJUSTMENTS
// =====================================================
router.post('/stock-adjustments', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const adjustmentNumber = `ADJ${Date.now()}`;
      const result = await client.query(
        `INSERT INTO stock_adjustments (adjustment_number, warehouse_id, adjustment_date, adjustment_type, reason, notes) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [adjustmentNumber, req.body.warehouse_id, req.body.adjustment_date, req.body.adjustment_type, req.body.reason, req.body.notes]
      );
      const adjustment = result.rows[0];

      for (const item of req.body.items) {
        await client.query(
          `INSERT INTO stock_adjustment_items (adjustment_id, item_id, quantity, remarks) VALUES ($1, $2, $3, $4)`,
          [adjustment.id, item.item_id, item.quantity, item.remarks]
        );

        const qtyIn = req.body.adjustment_type === 'increase' ? item.quantity : 0;
        const qtyOut = req.body.adjustment_type === 'decrease' ? item.quantity : 0;

        await stockLedgerRepo.createEntry(client, {
          item_id: item.item_id,
          warehouse_id: req.body.warehouse_id,
          transaction_type: 'adjustment',
          quantity_in: qtyIn,
          quantity_out: qtyOut,
          rate: 0,
          reference_type: 'adjustment',
          reference_id: adjustment.id,
          transaction_date: req.body.adjustment_date,
          remarks: `Adjustment ${adjustmentNumber}`,
          created_by: req.user.id
        });
      }

      await client.query('COMMIT');
      res.status(201).json(adjustment);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// ANALYTICS
// =====================================================
router.get('/analytics/consumption-trends', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const trends = await rmIssueService.getConsumptionTrends(start_date, end_date);
    res.json(trends);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const totalItems = await pool.query(
      `SELECT COUNT(*) as count FROM inventory_items WHERE is_active = true AND deleted_at IS NULL`
    );
    
    const lowStock = await stockLedgerRepo.getLowStockItems();
    
    const totalValue = await pool.query(
      `SELECT COALESCE(SUM((quantity_in - quantity_out) * rate), 0) as value 
       FROM stock_ledger`
    );

    res.json({
      total_items: parseInt(totalItems.rows[0].count),
      low_stock_items: lowStock.length,
      total_inventory_value: parseFloat(totalValue.rows[0].value)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

