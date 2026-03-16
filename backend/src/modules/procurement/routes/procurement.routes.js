import express from 'express';
import pool from '../../shared/db.js';
import prRepo from '../repositories/purchaseRequest.repository.js';
import poRepo from '../repositories/purchaseOrder.repository.js';
import grnService from '../services/grn.service.js';

const router = express.Router();

// =====================================================
// PURCHASE REQUESTS
// =====================================================
router.post('/purchase-requests', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const prNumber = await prRepo.getNextNumber();
      const pr = await prRepo.create(client, {
        ...req.body,
        request_number: prNumber
      });

      for (const item of req.body.items) {
        await prRepo.createItem(client, {
          pr_id: pr.id,
          ...item
        });
      }

      await client.query('COMMIT');
      res.status(201).json(await prRepo.findById(pr.id));
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

router.get('/purchase-requests', async (req, res) => {
  try {
    const prs = await prRepo.findAll(req.query);
    res.json(prs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/purchase-requests/:id', async (req, res) => {
  try {
    const pr = await prRepo.findById(req.params.id);
    if (!pr) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }
    pr.items = await prRepo.getItems(req.params.id);
    res.json(pr);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/purchase-requests/:id/approve', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pr = await prRepo.updateStatus(client, req.params.id, 'approved', req.user.id);
      await client.query('COMMIT');
      res.json(pr);
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
// PURCHASE ORDERS
// =====================================================
router.post('/purchase-orders', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const poNumber = await poRepo.getNextNumber();
      const po = await poRepo.create(client, {
        ...req.body,
        po_number: poNumber,
        created_by: req.user.id
      });

      for (const item of req.body.items) {
        await poRepo.createItem(client, {
          po_id: po.id,
          ...item
        });
      }

      if (req.body.pr_id) {
        await prRepo.updateStatus(client, req.body.pr_id, 'converted_to_po');
      }

      await client.query('COMMIT');
      res.status(201).json(await poRepo.findById(po.id));
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

router.get('/purchase-orders', async (req, res) => {
  try {
    const pos = await poRepo.findAll(req.query);
    res.json(pos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/purchase-orders/:id', async (req, res) => {
  try {
    const po = await poRepo.findById(req.params.id);
    if (!po) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }
    po.items = await poRepo.getItems(req.params.id);
    res.json(po);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/purchase-orders/:id/status', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const po = await poRepo.updateStatus(client, req.params.id, req.body.status);
      await client.query('COMMIT');
      res.json(po);
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
// GOODS RECEIPT NOTES
// =====================================================
router.post('/grn', async (req, res) => {
  try {
    const grn = await grnService.createGRN(req.body, req.user.id);
    res.status(201).json(grn);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/grn', async (req, res) => {
  try {
    const grns = await grnService.getGRNs(req.query);
    res.json(grns);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/grn/:id', async (req, res) => {
  try {
    const grn = await grnService.getGRNById(req.params.id);
    if (!grn) {
      return res.status(404).json({ error: 'GRN not found' });
    }
    res.json(grn);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// LOCAL PURCHASE REQUESTS
// =====================================================
router.post('/local-purchase', async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO local_purchase_requests (request_number, requested_by_employee_id, request_date, description, vendor_name_text, amount, bill_status, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        `LPR${Date.now()}`,
        req.body.requested_by_employee_id,
        req.body.request_date,
        req.body.description,
        req.body.vendor_name_text,
        req.body.amount,
        req.body.bill_status,
        req.body.notes
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/local-purchase', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM local_purchase_requests WHERE deleted_at IS NULL ORDER BY request_date DESC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// DASHBOARDS & ANALYTICS
// =====================================================
router.get('/dashboard', async (req, res) => {
  try {
    const pendingPRs = await pool.query(
      `SELECT COUNT(*) as count FROM purchase_requests WHERE status = 'pending_approval' AND deleted_at IS NULL`
    );
    
    const pendingPOs = await pool.query(
      `SELECT COUNT(*) as count FROM purchase_orders WHERE status IN ('draft', 'sent') AND deleted_at IS NULL`
    );
    
    const lateDeliveries = await poRepo.getLateDeliveries();
    
    const monthlyPurchase = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) as total 
       FROM purchase_orders 
       WHERE order_date >= DATE_TRUNC('month', CURRENT_DATE) 
       AND status != 'cancelled' AND deleted_at IS NULL`
    );

    res.json({
      pending_prs: parseInt(pendingPRs.rows[0].count),
      pending_pos: parseInt(pendingPOs.rows[0].count),
      late_deliveries: lateDeliveries.length,
      monthly_purchase: parseFloat(monthlyPurchase.rows[0].total)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

