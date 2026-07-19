import express from 'express';
import pool from '../../shared/db.js';
import itemRepo from '../repositories/inventoryItem.repository.js';
import stockLedgerRepo from '../repositories/stockLedger.repository.js';
import rmIssueService from '../services/rmIssue.service.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { validate } from '../../../services/ValidationEngineService.js';
import { evaluateRules } from '../../../services/RuleEngineService.js';
import { logAudit } from '../../../services/AuditService.js';
import purchaseRequestRepo from '../../procurement/repositories/purchaseRequest.repository.js';
import advInventoryRouter from './advancedInventory.routes.js';
import serialNumbersRouter from './serialNumbers.routes.js';
import componentCatalogRouter from './componentCatalog.routes.js';
import { checkAndCreateAlerts } from '../../../services/stockAlerts.js';

const router = express.Router();

// =====================================================
// INVENTORY ITEMS
// =====================================================
router.post('/items', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const { valid, errors } = await validate('inventory', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'inventory', errors });
    const itemCode = await itemRepo.getNextCode();
    const item = await itemRepo.create({ ...req.body, item_code: itemCode, company_id: req.scope?.company_id ?? null });
    logAudit({ userId: req.user?.userId, module: 'inventory', recordId: item.id, recordType: 'inventory_item', action: 'create', newData: item, req });
    const ruleResults = await evaluateRules('inventory', item).catch(() => []);
    const ruleAlerts = ruleResults.filter(r => r.triggered);
    res.status(201).json({ ...item, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/items', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const items = await itemRepo.findAll({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/items/:id', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const item = await itemRepo.findById(req.params.id, req.scope?.company_id ?? null);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/items/:id', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const company_id = req.scope?.company_id ?? null;
    const { valid, errors } = await validate('inventory', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'inventory', errors });
    const oldItem = await itemRepo.findById(req.params.id, company_id);
    if (!oldItem) return res.status(404).json({ error: 'Item not found' });
    const item = await itemRepo.update(req.params.id, req.body, company_id);
    if (!item) return res.status(404).json({ error: 'Item not found or access denied' });
    logAudit({ userId: req.user?.userId, module: 'inventory', recordId: req.params.id, recordType: 'inventory_item', action: 'update', oldData: oldItem, newData: item, req });
    const ruleResults = await evaluateRules('inventory', item).catch(() => []);
    const ruleAlerts = ruleResults.filter(r => r.triggered);
    res.json({ ...item, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/items/:id', requirePermission('inventory', 'delete'), async (req, res) => {
  try {
    const company_id = req.scope?.company_id ?? null;
    const deleted = await itemRepo.softDelete(req.params.id, company_id);
    if (!deleted) return res.status(404).json({ error: 'Item not found' });
    logAudit({ userId: req.user?.userId, module: 'inventory', recordId: req.params.id, recordType: 'inventory_item', action: 'delete', req });
    res.json({ message: 'Item deleted', id: deleted.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// WAREHOUSES
// =====================================================
router.get('/warehouses', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const result = companyId != null
      ? await pool.query(
          'SELECT * FROM warehouses WHERE company_id = $1 AND deleted_at IS NULL ORDER BY warehouse_name',
          [companyId]
        )
      : await pool.query(
          'SELECT * FROM warehouses WHERE deleted_at IS NULL ORDER BY warehouse_name'
        );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/warehouses', requirePermission('inventory', 'add'), async (req, res) => {
  const { warehouse_name, warehouse_code, warehouse_type, location, capacity } = req.body;
  if (!warehouse_name?.trim()) {
    return res.status(422).json({ error: 'warehouse_name is required' });
  }
  try {
    const companyId = req.scope?.company_id ?? null;
    const result = await pool.query(
      `INSERT INTO warehouses (name, warehouse_name, warehouse_code, warehouse_type, location, capacity, company_id, status)
       VALUES ($1, $1, $2, $3, $4, $5, $6, 'active')
       RETURNING *`,
      [
        warehouse_name.trim(),
        warehouse_code?.trim() || null,
        warehouse_type?.trim() || null,
        location?.trim() || null,
        (() => { const n = parseInt(capacity, 10); return isNaN(n) ? null : n; })(),
        companyId,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Warehouse code already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// STOCK SUMMARY & REPORTS
// =====================================================
router.get('/stock/summary', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const summary = await stockLedgerRepo.getStockSummary({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stock/low-stock', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const lowStock = await stockLedgerRepo.getLowStockItems(req.scope?.company_id ?? null);
    res.json(lowStock);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stock Add / Remove — single-item transactional stock movement
router.post('/stock/movement', requirePermission('inventory', 'add'), async (req, res) => {
  const { item_id, warehouse_id, movement_type, quantity, rate = 0, reference, notes } = req.body;
  if (!item_id || !warehouse_id || !movement_type || !quantity) {
    return res.status(422).json({ error: 'item_id, warehouse_id, movement_type, and quantity are required' });
  }
  const qty = parseFloat(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(422).json({ error: 'quantity must be a positive number' });
  }
  const isIN = movement_type === 'IN';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!isIN) {
      const balRes = await client.query(
        `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS balance FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2`,
        [item_id, warehouse_id]
      );
      const balance = parseFloat(balRes.rows[0].balance);
      if (balance < qty) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: `Insufficient stock. Available: ${balance}, Requested: ${qty}` });
      }
    }

    const entry = await stockLedgerRepo.createEntry(client, {
      item_id,
      warehouse_id,
      transaction_type: isIN ? 'receipt' : 'issue',
      quantity_in:  isIN ? qty : 0,
      quantity_out: isIN ? 0   : qty,
      rate: parseFloat(rate) || 0,
      reference_type: 'manual',
      reference_id: null,
      transaction_date: new Date().toISOString().split('T')[0],
      remarks: reference || notes || '',
      created_by: req.user?.employee_id ?? null,
    });

    await client.query('COMMIT');
    res.status(201).json({ ...entry, movement_type, quantity: qty, reference, notes });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/stock/movement', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { item_id, warehouse_id, start_date, end_date, search, limit } = req.query;

    // When all four legacy params are present, use the precise filtered query.
    // Otherwise use the flexible query that works with any combination of params.
    if (item_id && warehouse_id && start_date && end_date) {
      const movement = await stockLedgerRepo.getStockMovement(item_id, warehouse_id, start_date, end_date);
      return res.json(movement);
    }

    const movements = await stockLedgerRepo.getRecentMovements({ item_id, warehouse_id, start_date, end_date, search, limit });
    res.json(movements);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stock/valuation', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const cid = companyId != null ? companyId : 0;

    let valuationMethod = 'Weighted Average';
    try {
      const { rows: [cfg] } = await pool.query(
        `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'inventory' LIMIT 1`, [cid]
      );
      valuationMethod = cfg?.settings?.valuation_method || 'Weighted Average';
    } catch { /* use default */ }

    const valuation = await stockLedgerRepo.getInventoryValuation(req.query.warehouse_id, valuationMethod);
    res.json({ valuation_method: valuationMethod, items: valuation });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// RM ISSUES
// =====================================================
router.post('/rm-issues', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const { valid, errors } = await validate('inventory', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'inventory', errors });
    const issue = await rmIssueService.createIssue(req.body, req.user?.employee_id ?? null);
    logAudit({ userId: req.user?.userId, module: 'inventory', recordId: issue.id, recordType: 'rm_issue', action: 'create', newData: issue, req });
    const ruleResults = await evaluateRules('inventory', issue).catch(() => []);
    const ruleAlerts = ruleResults.filter(r => r.triggered);
    res.status(201).json({ ...issue, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/rm-issues', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const issues = await rmIssueService.getIssues(req.query);
    res.json(issues);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/rm-issues/:id', requirePermission('inventory', 'view'), async (req, res) => {
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
router.post('/stock-transfers', requirePermission('inventory', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { valid, errors } = await validate('inventory', req.body);
    if (!valid) { client.release(); return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'inventory', errors }); }
    try {
      await client.query('BEGIN');

      const transferNumber = `STR${Date.now()}`;
      const result = await client.query(
        `INSERT INTO stock_transfers (transfer_number, from_warehouse_id, to_warehouse_id, transfer_date, transferred_by, notes) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [transferNumber, req.body.from_warehouse_id, req.body.to_warehouse_id, req.body.transfer_date, req.user.userId ?? req.user.id, req.body.notes]
      );
      const transfer = result.rows[0];

      for (const item of req.body.items) {
        // Guard: ensure sufficient stock exists in the source warehouse
        const balRes = await client.query(
          `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS balance FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2`,
          [item.item_id, req.body.from_warehouse_id]
        );
        const available = parseFloat(balRes.rows[0].balance);
        if (available < parseFloat(item.quantity)) {
          throw Object.assign(new Error(`Insufficient stock for item ${item.item_id}. Available: ${available}, Requested: ${item.quantity}`), { status: 422 });
        }

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
          created_by: req.user?.employee_id ?? null
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
          created_by: req.user?.employee_id ?? null
        });
      }

      await client.query('COMMIT');
      res.status(201).json(transfer);
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(error.status || 500).json({ error: error.message });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stock-transfers', requirePermission('inventory', 'view'), async (req, res) => {
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
router.post('/stock-adjustments', requirePermission('inventory', 'add'), async (req, res) => {
  // Accept both formats:
  //   Array format:  { items: [{item_id, quantity, remarks}], warehouse_id, adjustment_type, adjustment_date, reason, notes }
  //   Flat format:   { item_id, quantity, adjustment_type, reason, notes, reference }   (sent by StockMovements.jsx)
  const body = req.body;

  // Normalise items to array
  const rawItems = Array.isArray(body.items) && body.items.length > 0
    ? body.items
    : [{ item_id: body.item_id, quantity: body.quantity, remarks: body.reason || body.reference || '' }];

  if (!rawItems[0]?.item_id || !rawItems[0]?.quantity) {
    return res.status(422).json({ error: 'item_id and quantity are required' });
  }

  // Normalise adjustment_type: frontend may send 'Addition', 'Deduction', 'Write-off', 'Transfer'
  const typeMap = {
    addition: 'increase', increase: 'increase',
    deduction: 'decrease', decrease: 'decrease',
    'write-off': 'decrease', writeoff: 'decrease',
    transfer: 'decrease',
  };
  const rawType = String(body.adjustment_type || 'increase').toLowerCase().replace(/\s/g, '');
  const adjType = typeMap[rawType] || 'increase';

  // Fallback date to today if not supplied
  const adjDate = body.adjustment_date || new Date().toISOString().split('T')[0];

  // warehouse_id: use supplied, or fall back to the first active warehouse
  let warehouseId = body.warehouse_id;
  if (!warehouseId) {
    const wRes = await pool.query(`SELECT id FROM warehouses WHERE deleted_at IS NULL ORDER BY id LIMIT 1`);
    warehouseId = wRes.rows[0]?.id || null;
  }
  if (!warehouseId) {
    return res.status(422).json({ error: 'warehouse_id is required and no warehouse exists in the system' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const adjustmentNumber = `ADJ${Date.now()}`;
    const result = await client.query(
      `INSERT INTO stock_adjustments (adjustment_number, warehouse_id, adjustment_date, adjustment_type, reason, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [adjustmentNumber, warehouseId, adjDate, adjType, body.reason, body.notes]
    );
    const adjustment = result.rows[0];

    for (const item of rawItems) {
      const qty = parseFloat(item.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw Object.assign(new Error(`Invalid quantity: ${item.quantity}`), { status: 422 });
      }

      // Guard: prevent negative stock on decrease
      if (adjType === 'decrease') {
        const balRes = await client.query(
          `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS balance FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2`,
          [item.item_id, warehouseId]
        );
        const available = parseFloat(balRes.rows[0].balance);
        if (available < qty) {
          throw Object.assign(
            new Error(`Insufficient stock for item ${item.item_id}. Available: ${available}, Requested: ${qty}`),
            { status: 422 }
          );
        }
      }

      await client.query(
        `INSERT INTO stock_adjustment_items (adjustment_id, item_id, quantity, remarks) VALUES ($1, $2, $3, $4)`,
        [adjustment.id, item.item_id, qty, item.remarks || '']
      );

      await stockLedgerRepo.createEntry(client, {
        item_id: item.item_id,
        warehouse_id: warehouseId,
        transaction_type: 'adjustment',
        quantity_in:  adjType === 'increase' ? qty : 0,
        quantity_out: adjType === 'decrease' ? qty : 0,
        rate: 0,
        reference_type: 'adjustment',
        reference_id: adjustment.id,
        transaction_date: adjDate,
        remarks: `Adjustment ${adjustmentNumber}${item.remarks ? ': ' + item.remarks : ''}`,
        created_by: req.user?.employee_id ?? null,
      });
    }

    await client.query('COMMIT');

    // Fire-and-forget: check low stock for each adjusted item
    for (const item of rawItems) {
      checkAndCreateAlerts(item.item_id, warehouseId);
    }

    res.status(201).json(adjustment);
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
router.get('/analytics/consumption-trends', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const trends = await rmIssueService.getConsumptionTrends(start_date, end_date);
    res.json(trends);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/dashboard', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const holdingRate = (() => {
      const parsed = Number.parseFloat(process.env.INVENTORY_HOLDING_COST_RATE ?? '0.18');
      if (!Number.isFinite(parsed) || parsed < 0) return 0.18;
      return parsed;
    })();

    const companyId = req.scope?.company_id ?? null;
    const cid = companyId != null ? companyId : 0;

    const [totalItemsRes, lowStock, totalValueRes, pendingPosRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) as count FROM inventory_items WHERE is_active = true AND deleted_at IS NULL${companyId != null ? ' AND company_id = $1' : ''}`,
        companyId != null ? [companyId] : []
      ),
      stockLedgerRepo.getLowStockItems(companyId),
      pool.query(`SELECT COALESCE(SUM((quantity_in - quantity_out) * rate), 0) as value FROM stock_ledger`),
      pool.query(
        `SELECT COUNT(*) as count FROM purchase_orders WHERE status IN ('pending','approved','sent') AND deleted_at IS NULL${companyId != null ? ' AND company_id = $1' : ''}`,
        companyId != null ? [companyId] : []
      ).catch(() => ({ rows: [{ count: 0 }] })),
    ]);

    const totalInventoryValue = parseFloat(totalValueRes.rows[0].value);
    res.json({
      total_items: parseInt(totalItemsRes.rows[0].count),
      low_stock_count: lowStock.length,
      low_stock_items: lowStock.length,
      total_value: totalInventoryValue,
      total_inventory_value: totalInventoryValue,
      holding_cost_rate_annual: holdingRate,
      total_holding_cost_annual: totalInventoryValue * holdingRate,
      total_holding_cost_monthly: (totalInventoryValue * holdingRate) / 12,
      pending_pos: parseInt(pendingPosRes.rows[0].count) || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// REORDER ALERTS  (InventoryIntelligence tab 0)
// =====================================================
router.get('/reorder-alerts', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const cid = companyId != null ? companyId : 0;

    // Read auto_generate_pr from company_settings
    let autoCreatePo = false;
    try {
      const { rows: [cfg] } = await pool.query(
        `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'inventory' LIMIT 1`, [cid]
      );
      autoCreatePo = cfg?.settings?.auto_generate_pr === true;
    } catch { /* use default */ }

    const result = await pool.query(`
      SELECT
        ii.id,
        ii.item_code,
        ii.item_name,
        ii.unit_of_measure,
        ii.reorder_level                                                              AS reorder_point,
        COALESCE(ii.safety_stock, 0)                                                  AS safety_stock,
        COALESCE(ii.lead_time_days, 7)                                                AS lead_time_days,
        ii.preferred_vendor_id,
        v.vendor_name,
        w.id                                                                          AS warehouse_id,
        w.warehouse_name,
        COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)                            AS current_stock,
        ii.reorder_level - COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)         AS shortfall,
        GREATEST(
          ii.reorder_level * 2 - COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0),
          ii.reorder_level
        )                                                                             AS reorder_qty
      FROM inventory_items ii
      CROSS JOIN warehouses w
      LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
      LEFT JOIN vendors v ON v.id = ii.preferred_vendor_id
      WHERE ii.deleted_at IS NULL AND w.deleted_at IS NULL AND ii.is_active = true
        AND ii.reorder_level > 0
      GROUP BY ii.id, ii.item_code, ii.item_name, ii.unit_of_measure,
               ii.reorder_level, ii.safety_stock, ii.lead_time_days,
               ii.preferred_vendor_id, v.vendor_name, w.id, w.warehouse_name
      HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) <= ii.reorder_level
      ORDER BY shortfall DESC
    `);
    res.json(result.rows.map(r => ({ ...r, auto_create_po: autoCreatePo })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/reorder-alerts/generate-pos', requirePermission('inventory', 'add'), async (req, res) => {
  const { item_ids = [] } = req.body;
  const created = [];
  const failed = [];
  for (const id of item_ids) {
    try {
      const itemRes = await pool.query(`SELECT * FROM inventory_items WHERE id = $1 AND deleted_at IS NULL`, [id]);
      const item = itemRes.rows[0];
      if (!item) { failed.push({ item_id: id, error: 'Item not found' }); continue; }
      const prNumber = await purchaseRequestRepo.getNextNumber();
      const pr = await purchaseRequestRepo.create({
        request_number: prNumber,
        requested_by_employee_id: req.user.employee_id ?? req.user.userId ?? req.user.id,
        request_date: new Date(),
        notes: `Auto-generated reorder alert for ${item.item_name}`,
        items: [{ item_id: item.id, item_name: item.item_name, quantity: item.reorder_level * 2 }],
      });
      created.push(pr);
    } catch (err) {
      failed.push({ item_id: id, error: err.message });
    }
  }
  res.json({ purchase_orders: created, count: created.length, failed, failed_count: failed.length });
});

// =====================================================
// ABC ANALYSIS  (InventoryIntelligence tab 2)
// =====================================================
router.get('/abc-analysis', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const cached = await pool.query(`SELECT * FROM abc_analysis_cache ORDER BY computed_at DESC LIMIT 1`);
    if (cached.rows.length === 0) return res.json(null);
    const row = cached.rows[0];
    res.json({ last_computed: row.computed_at, stats: row.stats, items: row.items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/abc-analysis/run', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const result = await pool.query(`
      WITH item_values AS (
        SELECT
          ii.id          AS item_id,
          ii.item_code,
          ii.item_name,
          COALESCE(SUM(sl.quantity_out * sl.rate), 0) AS annual_consumption_value
        FROM inventory_items ii
        LEFT JOIN stock_ledger sl
          ON ii.id = sl.item_id
          AND sl.transaction_date >= CURRENT_DATE - INTERVAL '12 months'
          AND sl.quantity_out > 0
        WHERE ii.deleted_at IS NULL
        GROUP BY ii.id, ii.item_code, ii.item_name
      ),
      total AS (SELECT NULLIF(SUM(annual_consumption_value), 0) AS grand_total FROM item_values),
      ranked AS (
        SELECT
          iv.*,
          ROUND(
            100.0 * SUM(iv.annual_consumption_value) OVER (ORDER BY iv.annual_consumption_value DESC)
            / t.grand_total,
          2) AS cumulative_pct
        FROM item_values iv, total t
        WHERE t.grand_total IS NOT NULL
      )
      SELECT
        item_id, item_code, item_name, annual_consumption_value, cumulative_pct,
        CASE
          WHEN cumulative_pct <= 70 THEN 'A'
          WHEN cumulative_pct <= 90 THEN 'B'
          ELSE 'C'
        END AS category
      FROM ranked
      ORDER BY annual_consumption_value DESC
    `);

    const items = result.rows;
    const stats = { A: { count: 0, value: 0 }, B: { count: 0, value: 0 }, C: { count: 0, value: 0 } };
    items.forEach(r => {
      stats[r.category].count++;
      stats[r.category].value += parseFloat(r.annual_consumption_value);
    });

    await pool.query(`INSERT INTO abc_analysis_cache (stats, items) VALUES ($1, $2)`, [
      JSON.stringify(stats),
      JSON.stringify(items),
    ]);

    res.json({ last_computed: new Date(), stats, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// SLOW MOVERS  (InventoryIntelligence tab 2)
// =====================================================
router.get('/slow-movers', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const cid = companyId != null ? companyId : 0;

    let slowMoverDays = 90;
    try {
      const { rows: [cfg] } = await pool.query(
        `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'inventory' LIMIT 1`, [cid]
      );
      const parsed = parseInt(cfg?.settings?.slow_mover_days, 10);
      if (Number.isFinite(parsed) && parsed > 0) slowMoverDays = parsed;
    } catch { /* use default */ }

    const result = await pool.query(`
      SELECT
        ii.id,
        ii.item_code,
        ii.item_name,
        COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)      AS current_stock,
        COALESCE(AVG(NULLIF(sl.rate, 0)), 0)                    AS unit_cost,
        COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)
          * COALESCE(AVG(NULLIF(sl.rate, 0)), 0)                AS stock_value,
        MAX(CASE WHEN sl.quantity_out > 0 THEN sl.transaction_date END) AS last_movement_date
      FROM inventory_items ii
      LEFT JOIN stock_ledger sl ON ii.id = sl.item_id
      WHERE ii.deleted_at IS NULL AND ii.is_active = true
      GROUP BY ii.id, ii.item_code, ii.item_name
      HAVING
        COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) > 0
        AND (
          MAX(CASE WHEN sl.quantity_out > 0 THEN sl.transaction_date END) IS NULL
          OR MAX(CASE WHEN sl.quantity_out > 0 THEN sl.transaction_date END) < CURRENT_DATE - ($1 || ' days')::INTERVAL
        )
      ORDER BY stock_value DESC
    `, [slowMoverDays]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// WAREHOUSE TRANSFERS (staged workflow — InventoryIntelligence tab 1)
// =====================================================
router.get('/warehouse-transfers', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        wt.*,
        wf.warehouse_name AS from_warehouse,
        wt2.warehouse_name AS to_warehouse
      FROM warehouse_transfers wt
      LEFT JOIN warehouses wf  ON wt.from_warehouse_id = wf.id
      LEFT JOIN warehouses wt2 ON wt.to_warehouse_id   = wt2.id
      WHERE wt.deleted_at IS NULL
      ORDER BY wt.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/warehouse-transfers', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const { from_warehouse_id, to_warehouse_id, items = [], notes, transfer_date } = req.body;
    if (!from_warehouse_id || !to_warehouse_id) {
      return res.status(422).json({ error: 'from_warehouse_id and to_warehouse_id are required' });
    }
    if (String(from_warehouse_id) === String(to_warehouse_id)) {
      return res.status(422).json({ error: 'Source and destination warehouses must differ' });
    }
    const transferNumber = `WT${Date.now()}`;
    const result = await pool.query(
      `INSERT INTO warehouse_transfers
         (transfer_number, from_warehouse_id, to_warehouse_id, items, status, transfer_date, notes, created_by)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7) RETURNING *`,
      [transferNumber, from_warehouse_id, to_warehouse_id, JSON.stringify(items),
       transfer_date || new Date().toISOString().split('T')[0],
       notes, req.user.userId ?? req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/warehouse-transfers/:id/dispatch', requirePermission('inventory', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txRes = await client.query(
      `SELECT * FROM warehouse_transfers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [req.params.id]
    );
    if (!txRes.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Transfer not found' }); }
    const tx = txRes.rows[0];
    if (tx.status !== 'draft') { await client.query('ROLLBACK'); return res.status(422).json({ error: `Transfer is already ${tx.status}` }); }

    const items = Array.isArray(tx.items) ? tx.items : [];
    for (const item of items) {
      const qty = parseFloat(item.qty || item.quantity || 0);
      if (!item.item_id || !qty) continue;
      // Guard: sufficient stock in source warehouse
      const balRes = await client.query(
        `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS balance FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2`,
        [item.item_id, tx.from_warehouse_id]
      );
      const available = parseFloat(balRes.rows[0].balance);
      if (available < qty) {
        throw Object.assign(
          new Error(`Insufficient stock for item ${item.item_id}. Available: ${available}, Requested: ${qty}`),
          { status: 422 }
        );
      }
      // Deduct from source warehouse on dispatch
      await stockLedgerRepo.createEntry(client, {
        item_id: item.item_id,
        warehouse_id: tx.from_warehouse_id,
        transaction_type: 'transfer',
        quantity_in: 0,
        quantity_out: qty,
        rate: 0,
        reference_type: 'warehouse_transfer',
        reference_id: tx.id,
        transaction_date: tx.transfer_date || new Date().toISOString().split('T')[0],
        remarks: `Warehouse Transfer ${tx.transfer_number} - Dispatched`,
        created_by: req.user?.employee_id ?? null,
      });
    }

    const updated = await client.query(
      `UPDATE warehouse_transfers SET status = 'in-transit' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.status || 500).json({ error: error.message });
  } finally {
    client.release();
  }
});

router.put('/warehouse-transfers/:id/receive', requirePermission('inventory', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txRes = await client.query(
      `SELECT * FROM warehouse_transfers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [req.params.id]
    );
    if (!txRes.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Transfer not found' }); }
    const tx = txRes.rows[0];
    if (tx.status !== 'in-transit') { await client.query('ROLLBACK'); return res.status(422).json({ error: `Transfer must be in-transit to receive (current: ${tx.status})` }); }

    const items = Array.isArray(tx.items) ? tx.items : [];
    const receivedDate = new Date().toISOString().split('T')[0];
    for (const item of items) {
      const qty = parseFloat(item.qty || item.quantity || 0);
      if (!item.item_id || !qty) continue;
      // Add to destination warehouse on receive
      await stockLedgerRepo.createEntry(client, {
        item_id: item.item_id,
        warehouse_id: tx.to_warehouse_id,
        transaction_type: 'transfer',
        quantity_in: qty,
        quantity_out: 0,
        rate: 0,
        reference_type: 'warehouse_transfer',
        reference_id: tx.id,
        transaction_date: receivedDate,
        remarks: `Warehouse Transfer ${tx.transfer_number} - Received`,
        created_by: req.user?.employee_id ?? null,
      });
    }

    const updated = await client.query(
      `UPDATE warehouse_transfers SET status = 'received', received_date = $1 WHERE id = $2 RETURNING *`,
      [receivedDate, req.params.id]
    );
    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.status || 500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// =====================================================
// LANDED COSTS  (InventoryIntelligence tab 3)
// =====================================================
router.get('/landed-costs', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT lc.*,
             po.po_number,
             v.vendor_name
      FROM landed_costs lc
      LEFT JOIN purchase_orders po ON lc.po_id = po.id
      LEFT JOIN vendors         v  ON po.vendor_id = v.id
      ORDER BY lc.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/landed-costs', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const { po_id, freight_cost = 0, customs_duty = 0, insurance = 0, other_charges = 0, allocation_method = 'value' } = req.body;
    const total = parseFloat(freight_cost) + parseFloat(customs_duty) + parseFloat(insurance) + parseFloat(other_charges);
    const result = await pool.query(
      `INSERT INTO landed_costs
         (po_id, freight_cost, customs_duty, insurance, other_charges, total_landed_cost, allocation_method, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [po_id || null, freight_cost, customs_duty, insurance, other_charges, total, allocation_method,
       req.user.userId ?? req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/landed-costs/:id/allocate', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const lcRes = await pool.query(`SELECT * FROM landed_costs WHERE id = $1`, [req.params.id]);
    if (!lcRes.rows[0]) return res.status(404).json({ error: 'Landed cost record not found' });
    const lc = lcRes.rows[0];

    // Fetch PO items if po_id is set, otherwise return generic allocation
    let allocated_items = [];
    if (lc.po_id) {
      const poItems = await pool.query(
        `SELECT poi.*, ii.item_name, ii.item_code
         FROM purchase_order_items poi
         JOIN inventory_items ii ON poi.item_id = ii.id
         WHERE poi.po_id = $1`,
        [lc.po_id]
      );
      const rows = poItems.rows;
      const totalBase = rows.reduce((s, r) => {
        const base = lc.allocation_method === 'qty'
          ? parseFloat(r.quantity || 0)
          : parseFloat(r.total_amount || (r.quantity * r.unit_price) || 0);
        return s + base;
      }, 0);
      allocated_items = rows.map(r => {
        const base = lc.allocation_method === 'qty'
          ? parseFloat(r.quantity || 0)
          : parseFloat(r.total_amount || (r.quantity * r.unit_price) || 0);
        const share = totalBase > 0 ? base / totalBase : 0;
        return {
          item_id: r.item_id,
          item_code: r.item_code,
          item_name: r.item_name,
          allocated_cost: parseFloat((lc.total_landed_cost * share).toFixed(2)),
        };
      });
    }

    const updated = await pool.query(
      `UPDATE landed_costs
       SET status = 'allocated', allocated_at = NOW(), allocated_items = $1
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(allocated_items), req.params.id]
    );
    res.json({ ...updated.rows[0], allocated_items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// ADVANCED DASHBOARD  (AdvancedInventoryDashboard.jsx)
// =====================================================
router.get('/advanced-dashboard', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const company_id = req.scope?.company_id ?? null;
    const p = company_id != null ? [company_id] : [];
    const iif = company_id != null ? 'AND ii.company_id = $1' : '';   // inventory_items with alias ii
    const inf = company_id != null ? 'AND company_id = $1' : '';       // inventory_items no alias
    const wf  = company_id != null ? 'AND w.company_id = $1' : '';    // warehouses with alias w

    const [
      totalValRes,
      byCategoryRes,
      byWarehouseRes,
      movementRes,
      issuedValueRes,
      currentValueRes,
      turnoverByCatRes,
      agingRes,
      topValueRes,
      topMovementRes,
      deadStockRes,
      warehouseUtilRes,
    ] = await Promise.all([

      // 1. Total stock valuation
      pool.query(`
        SELECT COALESCE(SUM(sq.sv), 0)::numeric AS total_value
        FROM (
          SELECT COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) * COALESCE(ii.standard_cost, 0) AS sv
          FROM inventory_items ii
          LEFT JOIN stock_ledger sl ON ii.id = sl.item_id
          WHERE ii.deleted_at IS NULL AND ii.is_active = true ${iif}
          GROUP BY ii.id, ii.standard_cost
        ) sq
      `, p),

      // 2. Valuation by item_type (category)
      pool.query(`
        SELECT
          COALESCE(ii.item_type, 'Other') AS category,
          COALESCE(SUM(COALESCE(sq.qty, 0) * COALESCE(ii.standard_cost, 0)), 0)::numeric AS value,
          COUNT(DISTINCT ii.id)::int AS item_count
        FROM inventory_items ii
        LEFT JOIN (
          SELECT item_id, COALESCE(SUM(quantity_in - quantity_out), 0) AS qty
          FROM stock_ledger GROUP BY item_id
        ) sq ON sq.item_id = ii.id
        WHERE ii.deleted_at IS NULL AND ii.is_active = true ${iif}
        GROUP BY COALESCE(ii.item_type, 'Other')
        ORDER BY value DESC
      `, p),

      // 3. Valuation by warehouse
      pool.query(`
        SELECT
          w.warehouse_name AS warehouse,
          COALESCE(SUM(COALESCE(sq.qty, 0) * COALESCE(ii.standard_cost, 0)), 0)::numeric AS value,
          COUNT(DISTINCT ii.id)::int AS item_count
        FROM warehouses w
        LEFT JOIN (
          SELECT warehouse_id, item_id, COALESCE(SUM(quantity_in - quantity_out), 0) AS qty
          FROM stock_ledger GROUP BY warehouse_id, item_id
        ) sq ON sq.warehouse_id = w.id
        LEFT JOIN inventory_items ii ON sq.item_id = ii.id AND ii.deleted_at IS NULL ${iif}
        WHERE w.deleted_at IS NULL ${wf}
        GROUP BY w.id, w.warehouse_name
        ORDER BY value DESC
      `, p),

      // 4. Movement trend — last 12 months (receipts vs issues per month)
      pool.query(`
        WITH months AS (
          SELECT generate_series(
            date_trunc('month', NOW() - INTERVAL '11 months'),
            date_trunc('month', NOW()),
            '1 month'::interval
          ) AS m
        )
        SELECT
          to_char(months.m, 'Mon YYYY') AS month,
          COALESCE(SUM(CASE WHEN sl.quantity_in  > 0 THEN sl.quantity_in  END), 0)::numeric AS receipts_qty,
          COALESCE(SUM(CASE WHEN sl.quantity_out > 0 THEN sl.quantity_out END), 0)::numeric AS issues_qty,
          COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::numeric AS net_change
        FROM months
        LEFT JOIN stock_ledger sl
          ON date_trunc('month', sl.transaction_date) = months.m
          AND sl.item_id IN (
            SELECT id FROM inventory_items WHERE deleted_at IS NULL ${inf}
          )
        GROUP BY months.m
        ORDER BY months.m
      `, p),

      // 5. Issues value last 12 months (numerator for turnover)
      pool.query(`
        SELECT COALESCE(SUM(sl.quantity_out * sl.rate), 0)::numeric AS issues_value
        FROM stock_ledger sl
        JOIN inventory_items ii ON sl.item_id = ii.id
        WHERE ii.deleted_at IS NULL ${iif}
          AND sl.transaction_date >= NOW() - INTERVAL '12 months'
          AND sl.quantity_out > 0
      `, p),

      // 6. Current inventory value (denominator for turnover)
      pool.query(`
        SELECT COALESCE(SUM(COALESCE(sq.qty, 0) * COALESCE(ii.standard_cost, 0)), 0)::numeric AS current_value
        FROM inventory_items ii
        LEFT JOIN (
          SELECT item_id, COALESCE(SUM(quantity_in - quantity_out), 0) AS qty
          FROM stock_ledger GROUP BY item_id
        ) sq ON sq.item_id = ii.id
        WHERE ii.deleted_at IS NULL AND ii.is_active = true ${iif}
      `, p),

      // 7. Turnover by category
      pool.query(`
        SELECT
          COALESCE(ii.item_type, 'Other') AS category,
          COALESCE(SUM(sl.quantity_out * sl.rate), 0)::numeric AS issues_value,
          COALESCE(SUM(COALESCE(sq.qty, 0) * COALESCE(ii.standard_cost, 0)), 0)::numeric AS current_value
        FROM inventory_items ii
        LEFT JOIN stock_ledger sl
          ON sl.item_id = ii.id
          AND sl.transaction_date >= NOW() - INTERVAL '12 months'
          AND sl.quantity_out > 0
        LEFT JOIN (
          SELECT item_id, COALESCE(SUM(quantity_in - quantity_out), 0) AS qty
          FROM stock_ledger GROUP BY item_id
        ) sq ON sq.item_id = ii.id
        WHERE ii.deleted_at IS NULL AND ii.is_active = true ${iif}
        GROUP BY COALESCE(ii.item_type, 'Other')
      `, p),

      // 8. Stock aging buckets (days since last movement)
      pool.query(`
        WITH stock AS (
          SELECT
            ii.id,
            COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) AS current_stock,
            COALESCE(ii.standard_cost, 0) AS unit_cost,
            MAX(sl.transaction_date) AS last_move
          FROM inventory_items ii
          LEFT JOIN stock_ledger sl ON ii.id = sl.item_id
          WHERE ii.deleted_at IS NULL AND ii.is_active = true ${iif}
          GROUP BY ii.id, ii.standard_cost
          HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) > 0
        )
        SELECT
          CASE
            WHEN last_move IS NULL OR (CURRENT_DATE - last_move::date) > 90 THEN '90+'
            WHEN (CURRENT_DATE - last_move::date) > 60                       THEN '61-90'
            WHEN (CURRENT_DATE - last_move::date) > 30                       THEN '31-60'
            ELSE '0-30'
          END AS bucket,
          COUNT(*)::int AS count,
          COALESCE(SUM(current_stock * unit_cost), 0)::numeric AS value
        FROM stock
        GROUP BY bucket
      `, p),

      // 9. Top 5 items by stock value
      pool.query(`
        SELECT
          ii.item_code,
          ii.item_name,
          COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::numeric AS current_stock,
          COALESCE(ii.standard_cost, 0)::numeric AS unit_cost,
          (COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) * COALESCE(ii.standard_cost, 0))::numeric AS stock_value
        FROM inventory_items ii
        LEFT JOIN stock_ledger sl ON ii.id = sl.item_id
        WHERE ii.deleted_at IS NULL AND ii.is_active = true ${iif}
        GROUP BY ii.id, ii.item_code, ii.item_name, ii.standard_cost
        HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) * COALESCE(ii.standard_cost, 0) > 0
        ORDER BY stock_value DESC
        LIMIT 5
      `, p),

      // 10. Top 5 items by movement count (last 30 days)
      pool.query(`
        SELECT
          ii.item_code,
          ii.item_name,
          COUNT(sl.id)::int AS movement_count,
          COALESCE(SUM(sl.quantity_in + sl.quantity_out), 0)::numeric AS total_movement_qty
        FROM inventory_items ii
        JOIN stock_ledger sl ON ii.id = sl.item_id
          AND sl.transaction_date >= NOW() - INTERVAL '30 days'
        WHERE ii.deleted_at IS NULL ${iif}
        GROUP BY ii.id, ii.item_code, ii.item_name
        ORDER BY movement_count DESC
        LIMIT 5
      `, p),

      // 11. Dead stock — positive balance, no movement in 90+ days
      pool.query(`
        SELECT
          ii.item_code,
          ii.item_name,
          COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::numeric AS current_stock,
          COALESCE(ii.standard_cost, 0)::numeric AS unit_cost,
          MAX(sl.transaction_date) AS last_movement_date
        FROM inventory_items ii
        LEFT JOIN stock_ledger sl ON ii.id = sl.item_id
        WHERE ii.deleted_at IS NULL AND ii.is_active = true ${iif}
        GROUP BY ii.id, ii.item_code, ii.item_name, ii.standard_cost
        HAVING
          COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) > 0
          AND (
            MAX(sl.transaction_date) IS NULL
            OR MAX(sl.transaction_date) < NOW() - INTERVAL '90 days'
          )
        ORDER BY (COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) * COALESCE(ii.standard_cost, 0)) DESC
        LIMIT 10
      `, p),

      // 12. Warehouse utilization
      pool.query(`
        SELECT
          w.warehouse_name,
          COUNT(DISTINCT sq.item_id)::int AS item_count,
          COALESCE(SUM(COALESCE(sq.qty, 0) * COALESCE(ii.standard_cost, 0)), 0)::numeric AS total_value
        FROM warehouses w
        LEFT JOIN (
          SELECT warehouse_id, item_id, COALESCE(SUM(quantity_in - quantity_out), 0) AS qty
          FROM stock_ledger
          GROUP BY warehouse_id, item_id
          HAVING COALESCE(SUM(quantity_in - quantity_out), 0) > 0
        ) sq ON sq.warehouse_id = w.id
        LEFT JOIN inventory_items ii ON sq.item_id = ii.id AND ii.deleted_at IS NULL ${iif}
        WHERE w.deleted_at IS NULL ${wf}
        GROUP BY w.id, w.warehouse_name
        ORDER BY total_value DESC
      `, p),
    ]);

    const issuesValue  = parseFloat(issuedValueRes.rows[0]?.issues_value  || 0);
    const currentValue = parseFloat(currentValueRes.rows[0]?.current_value || 0);
    const overallRate  = currentValue > 0 ? issuesValue / currentValue : 0;

    const agingMap = {};
    for (const r of agingRes.rows) {
      agingMap[r.bucket] = { count: r.count, value: parseFloat(r.value) };
    }

    res.json({
      data: {
        valuation: {
          total_value: parseFloat(totalValRes.rows[0]?.total_value || 0),
          by_category: byCategoryRes.rows.map(r => ({
            category: r.category,
            value: parseFloat(r.value),
            item_count: r.item_count,
          })),
          by_warehouse: byWarehouseRes.rows.map(r => ({
            warehouse: r.warehouse,
            value: parseFloat(r.value),
            item_count: r.item_count,
          })),
        },
        movement_trend: movementRes.rows.map(r => ({
          month:        r.month,
          receipts_qty: parseFloat(r.receipts_qty),
          issues_qty:   parseFloat(r.issues_qty),
          net_change:   parseFloat(r.net_change),
        })),
        turnover: {
          overall_rate: parseFloat(overallRate.toFixed(2)),
          by_category: turnoverByCatRes.rows.map(r => {
            const cv = parseFloat(r.current_value || 0);
            return {
              category: r.category,
              rate: cv > 0 ? parseFloat((parseFloat(r.issues_value) / cv).toFixed(2)) : 0,
            };
          }),
        },
        aging: {
          '0-30':  agingMap['0-30']  || { count: 0, value: 0 },
          '31-60': agingMap['31-60'] || { count: 0, value: 0 },
          '61-90': agingMap['61-90'] || { count: 0, value: 0 },
          '90+':   agingMap['90+']   || { count: 0, value: 0 },
        },
        top_items: {
          by_value: topValueRes.rows.map(r => ({
            ...r,
            current_stock: parseFloat(r.current_stock),
            unit_cost:     parseFloat(r.unit_cost),
            stock_value:   parseFloat(r.stock_value),
          })),
          by_movement: topMovementRes.rows.map(r => ({
            ...r,
            total_movement_qty: parseFloat(r.total_movement_qty),
          })),
          dead_stock: deadStockRes.rows.map(r => ({
            ...r,
            current_stock: parseFloat(r.current_stock),
            unit_cost:     parseFloat(r.unit_cost),
          })),
        },
        warehouse_utilization: warehouseUtilRes.rows.map(r => ({
          warehouse_name:    r.warehouse_name,
          item_count:        r.item_count,
          total_value:       parseFloat(r.total_value),
          capacity_used_pct: null,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// MATERIAL CONSUMPTION  (MaterialConsumption.jsx)
// =====================================================

// GET /consumption/by-project — grouped by project_id
router.get('/consumption/by-project', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const params = [];
    const cond = companyId != null ? (params.push(companyId), `AND ii.company_id = $${params.length}`) : '';

    const result = await pool.query(`
      SELECT
        ia.project_id,
        p.project_name,
        p.project_code,
        ii.item_code,
        ii.item_name,
        ii.unit_of_measure,
        SUM(ia.quantity)              AS total_consumed,
        COALESCE(AVG(NULLIF(ia.rate,0)), 0) AS avg_rate,
        SUM(ia.quantity * ia.rate)    AS total_value,
        COUNT(*)                      AS transaction_count
      FROM inventory_allocations ia
      JOIN inventory_items ii ON ia.item_id = ii.id
      LEFT JOIN projects p ON ia.project_id = p.id
      WHERE ia.project_id IS NOT NULL ${cond}
      GROUP BY ia.project_id, p.project_name, p.project_code,
               ii.item_code, ii.item_name, ii.unit_of_measure
      ORDER BY total_value DESC
    `, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /consumption/by-type — grouped by reference_type
router.get('/consumption/by-type', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const params = [];
    const cond = companyId != null ? (params.push(companyId), `AND ii.company_id = $${params.length}`) : '';

    const result = await pool.query(`
      SELECT
        COALESCE(ia.reference_type, 'manual') AS reference_type,
        ia.item_id,
        ii.item_code,
        ii.item_name,
        w.warehouse_name,
        ia.reference_id,
        ia.quantity,
        ia.rate,
        ia.quantity * ia.rate AS value,
        ia.allocation_date,
        ia.purpose
      FROM inventory_allocations ia
      JOIN inventory_items ii ON ia.item_id = ii.id
      JOIN warehouses w ON ia.warehouse_id = w.id
      WHERE 1=1 ${cond}
      ORDER BY ia.reference_type, ia.allocation_date DESC
    `, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /consumption — full list with optional date filter
router.get('/consumption', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const { start_date, end_date, item_id } = req.query;
    const params = [];
    let cond = '';

    if (companyId != null) {
      params.push(companyId);
      cond += ` AND ii.company_id = $${params.length}`;
    }
    if (start_date) {
      params.push(start_date);
      cond += ` AND ia.allocation_date >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      cond += ` AND ia.allocation_date <= $${params.length}`;
    }
    if (item_id) {
      params.push(item_id);
      cond += ` AND ia.item_id = $${params.length}`;
    }

    const result = await pool.query(`
      SELECT
        ia.*,
        ii.item_code,
        ii.item_name,
        ii.unit_of_measure,
        w.warehouse_name,
        p.project_name,
        p.project_code
      FROM inventory_allocations ia
      JOIN inventory_items ii ON ia.item_id = ii.id
      JOIN warehouses w ON ia.warehouse_id = w.id
      LEFT JOIN projects p ON ia.project_id = p.id
      WHERE 1=1 ${cond}
      ORDER BY ia.allocation_date DESC
      LIMIT 500
    `, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /consumption — log a consumption entry, deduct from stock
router.post('/consumption', requirePermission('inventory', 'add'), async (req, res) => {
  const { item_id, warehouse_id, quantity, reference_type = 'manual', reference_id, project_id, notes } = req.body;
  if (!item_id || !warehouse_id || !quantity) {
    return res.status(422).json({ error: 'item_id, warehouse_id, and quantity are required' });
  }
  const qty = parseFloat(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(422).json({ error: 'quantity must be a positive number' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Guard: sufficient stock
    const balRes = await client.query(
      `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS balance FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2`,
      [item_id, warehouse_id]
    );
    const available = parseFloat(balRes.rows[0].balance);
    if (available < qty) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: `Insufficient stock. Available: ${available}, Requested: ${qty}` });
    }

    // Fetch current rate for valuation
    const rateRes = await client.query(
      `SELECT COALESCE(AVG(NULLIF(rate,0)), 0) AS avg_rate FROM stock_ledger WHERE item_id = $1`,
      [item_id]
    );
    const rate = parseFloat(rateRes.rows[0].avg_rate) || 0;

    // Stock ledger: issue entry
    await stockLedgerRepo.createEntry(client, {
      item_id,
      warehouse_id,
      transaction_type: 'issue',
      quantity_in: 0,
      quantity_out: qty,
      rate,
      reference_type: reference_type || 'manual',
      reference_id: reference_id || null,
      transaction_date: new Date().toISOString().split('T')[0],
      remarks: notes || 'Material consumption',
      created_by: req.user?.employee_id ?? null,
    });

    // Allocation record
    const alloc = await client.query(
      `INSERT INTO inventory_allocations
         (item_id, warehouse_id, allocation_type, reference_type, reference_id, quantity, rate, allocation_date, allocated_by, purpose, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8, $9, $10)
       RETURNING *`,
      [item_id, warehouse_id, reference_type || 'manual', reference_type || 'manual',
       reference_id || null, qty, rate,
       req.user?.userId ?? req.user?.id,
       notes || null, project_id || null]
    );

    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId, module: 'inventory', recordId: alloc.rows[0].id, recordType: 'material_consumption', action: 'create', newData: alloc.rows[0], req });
    res.status(201).json(alloc.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// =====================================================
// INVENTORY REPORT  (InventoryReport.jsx)
// Types: stock_valuation | movement_summary | abc_analysis | aging | low_stock
// =====================================================
router.get('/inventory-report', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { type = 'stock_valuation', from_date, to_date } = req.query;
    let rows = [];

    if (type === 'stock_valuation') {
      const params = [];
      const companyId = req.scope?.company_id ?? null;
      const cond = companyId != null ? (params.push(companyId), `AND ii.company_id = $${params.length}`) : '';
      const result = await pool.query(`
        SELECT
          ii.item_code,
          ii.item_name,
          ii.unit_of_measure,
          COALESCE(ii.item_type, 'Other') AS category,
          COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::numeric AS current_stock,
          COALESCE(AVG(NULLIF(sl.rate, 0)), COALESCE(ii.standard_cost, 0), 0)::numeric AS unit_cost,
          (COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) *
           COALESCE(AVG(NULLIF(sl.rate, 0)), COALESCE(ii.standard_cost, 0), 0))::numeric AS stock_value
        FROM inventory_items ii
        LEFT JOIN stock_ledger sl ON ii.id = sl.item_id
        WHERE ii.deleted_at IS NULL AND ii.is_active = true ${cond}
        GROUP BY ii.id, ii.item_code, ii.item_name, ii.unit_of_measure, ii.item_type, ii.standard_cost
        HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) > 0
        ORDER BY stock_value DESC
      `, params);
      rows = result.rows;

    } else if (type === 'movement_summary') {
      const params = [];
      const companyId = req.scope?.company_id ?? null;
      let cond = companyId != null ? (params.push(companyId), `AND ii.company_id = $${params.length}`) : '';
      if (from_date) { params.push(from_date); cond += ` AND sl.transaction_date >= $${params.length}`; }
      if (to_date)   { params.push(to_date);   cond += ` AND sl.transaction_date <= $${params.length}`; }
      const result = await pool.query(`
        SELECT
          ii.item_code,
          ii.item_name,
          ii.unit_of_measure,
          COALESCE(SUM(sl.quantity_in), 0)::numeric  AS total_in,
          COALESCE(SUM(sl.quantity_out), 0)::numeric AS total_out,
          (COALESCE(SUM(sl.quantity_in), 0) - COALESCE(SUM(sl.quantity_out), 0))::numeric AS net_change,
          COUNT(sl.id)::int AS transaction_count
        FROM inventory_items ii
        JOIN stock_ledger sl ON ii.id = sl.item_id
        WHERE ii.deleted_at IS NULL ${cond}
        GROUP BY ii.id, ii.item_code, ii.item_name, ii.unit_of_measure
        ORDER BY (COALESCE(SUM(sl.quantity_in), 0) + COALESCE(SUM(sl.quantity_out), 0)) DESC
      `, params);
      rows = result.rows;

    } else if (type === 'abc_analysis') {
      const params = [];
      const companyId = req.scope?.company_id ?? null;
      const cond = companyId != null ? (params.push(companyId), `AND ii.company_id = $${params.length}`) : '';
      const result = await pool.query(`
        WITH item_values AS (
          SELECT
            ii.id AS item_id, ii.item_code, ii.item_name, ii.unit_of_measure,
            COALESCE(SUM(sl.quantity_out * sl.rate), 0) AS annual_value
          FROM inventory_items ii
          LEFT JOIN stock_ledger sl
            ON ii.id = sl.item_id
            AND sl.transaction_date >= CURRENT_DATE - INTERVAL '12 months'
            AND sl.quantity_out > 0
          WHERE ii.deleted_at IS NULL ${cond}
          GROUP BY ii.id, ii.item_code, ii.item_name, ii.unit_of_measure
        ),
        total AS (SELECT NULLIF(SUM(annual_value), 0) AS grand_total FROM item_values),
        ranked AS (
          SELECT iv.*,
            ROUND(100.0 * SUM(iv.annual_value) OVER (ORDER BY iv.annual_value DESC) / t.grand_total, 2) AS cumulative_pct
          FROM item_values iv, total t WHERE t.grand_total IS NOT NULL
        )
        SELECT item_code, item_name, unit_of_measure,
          annual_value::numeric,
          cumulative_pct::numeric,
          CASE WHEN cumulative_pct <= 70 THEN 'A' WHEN cumulative_pct <= 90 THEN 'B' ELSE 'C' END AS abc_class
        FROM ranked ORDER BY annual_value DESC
      `, params);
      rows = result.rows;

    } else if (type === 'aging') {
      const params = [];
      const companyId = req.scope?.company_id ?? null;
      const cond = companyId != null ? (params.push(companyId), `AND ii.company_id = $${params.length}`) : '';
      const result = await pool.query(`
        SELECT
          ii.item_code, ii.item_name, ii.unit_of_measure,
          COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::numeric AS current_stock,
          COALESCE(AVG(NULLIF(sl.rate, 0)), COALESCE(ii.standard_cost, 0), 0)::numeric AS unit_cost,
          (COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) *
           COALESCE(AVG(NULLIF(sl.rate, 0)), COALESCE(ii.standard_cost, 0), 0))::numeric AS stock_value,
          MAX(sl.transaction_date) AS last_movement,
          CASE
            WHEN MAX(sl.transaction_date) IS NULL OR
                 (CURRENT_DATE - MAX(sl.transaction_date)::date) > 90 THEN '90+ days'
            WHEN (CURRENT_DATE - MAX(sl.transaction_date)::date) > 60 THEN '61-90 days'
            WHEN (CURRENT_DATE - MAX(sl.transaction_date)::date) > 30 THEN '31-60 days'
            ELSE '0-30 days'
          END AS aging_bucket
        FROM inventory_items ii
        LEFT JOIN stock_ledger sl ON ii.id = sl.item_id
        WHERE ii.deleted_at IS NULL AND ii.is_active = true ${cond}
        GROUP BY ii.id, ii.item_code, ii.item_name, ii.unit_of_measure, ii.standard_cost
        HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) > 0
        ORDER BY COALESCE(CURRENT_DATE - MAX(sl.transaction_date)::date, 9999) DESC
      `, params);
      rows = result.rows;

    } else if (type === 'low_stock') {
      const params = [];
      const companyId = req.scope?.company_id ?? null;
      const cond = companyId != null ? (params.push(companyId), `AND ii.company_id = $${params.length}`) : '';
      const result = await pool.query(`
        SELECT
          ii.item_code, ii.item_name, ii.unit_of_measure,
          ii.reorder_level,
          COALESCE(ii.safety_stock, 0)::numeric AS safety_stock,
          COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::numeric AS current_stock,
          (ii.reorder_level - COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0))::numeric AS shortfall,
          v.vendor_name AS preferred_vendor
        FROM inventory_items ii
        LEFT JOIN stock_ledger sl ON ii.id = sl.item_id
        LEFT JOIN vendors v ON v.id = ii.preferred_vendor_id
        WHERE ii.deleted_at IS NULL AND ii.is_active = true AND ii.reorder_level > 0 ${cond}
        GROUP BY ii.id, ii.item_code, ii.item_name, ii.unit_of_measure,
                 ii.reorder_level, ii.safety_stock, ii.preferred_vendor_id, v.vendor_name
        HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) <= ii.reorder_level
        ORDER BY shortfall DESC
      `, params);
      rows = result.rows;

    } else {
      return res.status(400).json({ error: `Unknown report type: ${type}` });
    }

    res.json({ type, rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// INVENTORY REPORT — MONTHWISE ₹ VIEW  (InventoryReport.jsx)
// Store + Financial-Year (Apr–Mar) tabbed category pivot.
// Same stock_ledger source as /stores-dashboard — the ₹-value
// view of the same quantity-based ledger, per material category.
//   Tabs:  day | purchased | used | balance | place_order
//   Row per item_type (category); 12 FY month columns + opening/total/closing.
//   Closing = Opening + Purchased − Used  (computed here, not stored).
// =====================================================
const FY_MONTH_ORDER = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]; // Apr → Mar
const FY_MONTH_LABELS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

router.get('/inventory-report/monthwise', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;

    // ── Financial year (April–March). ?fy = start calendar year, e.g. 2026 → Apr 2026–Mar 2027.
    const now = new Date();
    const defaultFyStartYear = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
    const fyStartYear = Number.isInteger(+req.query.fy) && +req.query.fy > 1900 ? +req.query.fy : defaultFyStartYear;
    const fyStart = `${fyStartYear}-04-01`;
    const fyEnd   = `${fyStartYear + 1}-03-31`;
    const fyLabel = `FY${fyStartYear}-${String(fyStartYear + 1).slice(-2)} (Apr ${fyStartYear} - Mar ${fyStartYear + 1})`;

    // ── Optional store filter. ?warehouse_id = id | 'all'
    const whRaw = req.query.warehouse_id;
    const warehouseId = whRaw && whRaw !== 'all' && Number.isInteger(+whRaw) ? +whRaw : null;

    // Shared scoping builders — mirror /stores-dashboard: NULL company_id rows stay
    // invisible to scoped users by design (see company_id NULL scoping gotcha).
    const iiScope = (params) => (companyId != null ? (params.push(companyId), ` AND ii.company_id = $${params.length}`) : '');
    const whScope = (params) => (warehouseId != null ? (params.push(warehouseId), ` AND sl.warehouse_id = $${params.length}`) : '');

    // ── A) Opening stock value per category (balance carried in before FY start, at standard cost) ──
    const openParams = [fyStart];
    let openWhScope = '';
    if (warehouseId != null) { openParams.push(warehouseId); openWhScope = ` AND sl.warehouse_id = $${openParams.length}`; }
    const openIiScope = iiScope(openParams);
    const openingRes = await pool.query(`
      SELECT COALESCE(ii.item_type, 'Other') AS category,
             COALESCE(SUM((sl.quantity_in - sl.quantity_out) * COALESCE(ii.standard_cost, 0)), 0)::numeric AS opening_value
      FROM inventory_items ii
      LEFT JOIN stock_ledger sl
        ON sl.item_id = ii.id AND sl.transaction_date < $1${openWhScope}
      WHERE ii.deleted_at IS NULL${openIiScope}
      GROUP BY COALESCE(ii.item_type, 'Other')
    `, openParams);

    // ── B) Monthly purchased / used ₹ per category within the FY ──
    const flowParams = [fyStart, fyEnd];
    const flowIiScope = iiScope(flowParams);
    const flowWhScope = whScope(flowParams);
    const flowRes = await pool.query(`
      SELECT COALESCE(ii.item_type, 'Other') AS category,
             EXTRACT(MONTH FROM sl.transaction_date)::int AS mon,
             COALESCE(SUM(sl.quantity_in  * COALESCE(sl.rate, 0)), 0)::numeric AS purchased,
             COALESCE(SUM(sl.quantity_out * COALESCE(sl.rate, 0)), 0)::numeric AS used
      FROM inventory_items ii
      JOIN stock_ledger sl ON sl.item_id = ii.id
      WHERE ii.deleted_at IS NULL
        AND sl.transaction_date >= $1 AND sl.transaction_date <= $2${flowIiScope}${flowWhScope}
      GROUP BY 1, 2
    `, flowParams);

    // ── Assemble category pivot in JS (small data; avoids a fragile crosstab) ──
    const catMap = new Map();
    const ensureCat = (name) => {
      if (!catMap.has(name)) {
        catMap.set(name, {
          category: name,
          opening_value: 0,
          purchased: new Array(12).fill(0),
          used: new Array(12).fill(0),
          balance: new Array(12).fill(0),
        });
      }
      return catMap.get(name);
    };
    openingRes.rows.forEach(r => { ensureCat(r.category).opening_value = parseFloat(r.opening_value) || 0; });
    flowRes.rows.forEach(r => {
      const idx = FY_MONTH_ORDER.indexOf(r.mon);
      if (idx < 0) return;
      const c = ensureCat(r.category);
      c.purchased[idx] += parseFloat(r.purchased) || 0;
      c.used[idx]      += parseFloat(r.used) || 0;
    });

    // Derived columns: running balance, totals, closing (= opening + purchased − used).
    const categories = [...catMap.values()].map(c => {
      let running = c.opening_value;
      const balance = FY_MONTH_ORDER.map((_, i) => {
        running += c.purchased[i] - c.used[i];
        return running;
      });
      const purchased_total = c.purchased.reduce((a, b) => a + b, 0);
      const used_total = c.used.reduce((a, b) => a + b, 0);
      return {
        ...c,
        balance,
        purchased_total,
        used_total,
        closing_value: c.opening_value + purchased_total - used_total,
      };
    }).sort((a, b) => b.closing_value - a.closing_value);

    // ── C) Day Report — daily purchased/used ₹ across the store for the FY ──
    const dayParams = [fyStart, fyEnd];
    let dayScope = '';
    if (companyId != null) { dayParams.push(companyId); dayScope += ` AND sl.company_id = $${dayParams.length}`; }
    if (warehouseId != null) { dayParams.push(warehouseId); dayScope += ` AND sl.warehouse_id = $${dayParams.length}`; }
    const dayRes = await pool.query(`
      SELECT sl.transaction_date AS day,
             COALESCE(SUM(sl.quantity_in  * COALESCE(sl.rate, 0)), 0)::numeric AS purchased,
             COALESCE(SUM(sl.quantity_out * COALESCE(sl.rate, 0)), 0)::numeric AS used,
             COUNT(*)::int AS txns
      FROM stock_ledger sl
      WHERE sl.transaction_date >= $1 AND sl.transaction_date <= $2${dayScope}
      GROUP BY sl.transaction_date
      ORDER BY sl.transaction_date DESC
    `, dayParams);
    const days = dayRes.rows.map(r => ({
      day: r.day,
      purchased: parseFloat(r.purchased) || 0,
      used: parseFloat(r.used) || 0,
      net: (parseFloat(r.purchased) || 0) - (parseFloat(r.used) || 0),
      txns: r.txns,
    }));

    // ── D) Place Order — items at/below reorder level for the store ──
    const poParams = [];
    const poIiScope = companyId != null ? (poParams.push(companyId), ` AND ii.company_id = $${poParams.length}`) : '';
    const poWhScope = warehouseId != null ? (poParams.push(warehouseId), ` AND sl.warehouse_id = $${poParams.length}`) : '';
    const poRes = await pool.query(`
      SELECT ii.id, ii.item_code, ii.item_name, ii.unit_of_measure,
             COALESCE(ii.item_type, 'Other')                                              AS category,
             ii.reorder_level::numeric                                                    AS reorder_level,
             COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::numeric                  AS current_stock,
             GREATEST(ii.reorder_level - COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0), 0)::numeric AS shortfall,
             GREATEST(ii.reorder_level * 2 - COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0), ii.reorder_level)::numeric AS suggested_qty,
             v.vendor_name                                                                AS preferred_vendor
      FROM inventory_items ii
      LEFT JOIN stock_ledger sl ON sl.item_id = ii.id${poWhScope}
      LEFT JOIN vendors v ON v.id = ii.preferred_vendor_id
      WHERE ii.deleted_at IS NULL AND ii.is_active = true AND ii.reorder_level > 0${poIiScope}
      GROUP BY ii.id, ii.item_code, ii.item_name, ii.unit_of_measure, ii.item_type,
               ii.reorder_level, v.vendor_name
      HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) <= ii.reorder_level
      ORDER BY shortfall DESC
    `, poParams);

    res.json({
      fy: { start_year: fyStartYear, start: fyStart, end: fyEnd, label: fyLabel },
      warehouse_id: warehouseId,
      month_labels: FY_MONTH_LABELS,
      categories,
      days,
      place_order: poRes.rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// STORES DASHBOARD  (StoresDashboard.jsx)
// =====================================================
router.get('/stores-dashboard', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const company_id = req.scope?.company_id ?? null;
    const p   = company_id != null ? [company_id] : [];
    const iif = company_id != null ? 'AND ii.company_id = $1' : '';
    const wf  = company_id != null ? 'AND w.company_id = $1' : '';

    const [warehouseRes, todayRes] = await Promise.all([
      pool.query(`
        SELECT
          w.id,
          w.warehouse_name                                                              AS name,
          w.warehouse_code                                                              AS code,
          COUNT(DISTINCT
            CASE WHEN COALESCE(s.balance, 0) > 0 THEN s.item_id END
          )::int                                                                        AS total_skus,
          COUNT(DISTINCT s.item_id)::int                                                AS total_items,
          COALESCE(SUM(
            GREATEST(COALESCE(s.balance, 0), 0) * COALESCE(ii.standard_cost, 0)
          ), 0)::numeric                                                                AS total_value,
          COUNT(DISTINCT
            CASE WHEN COALESCE(s.balance, 0) <= 0 AND s.item_id IS NOT NULL
              THEN s.item_id END
          )::int                                                                        AS out_of_stock_count,
          COUNT(DISTINCT
            CASE WHEN COALESCE(s.balance, 0) > 0
              AND COALESCE(ii.reorder_level, 0) > 0
              AND COALESCE(s.balance, 0) <= COALESCE(ii.reorder_level, 0)
              THEN s.item_id END
          )::int                                                                        AS low_stock_count,
          MAX(s.last_txn)                                                               AS last_activity_at
        FROM warehouses w
        LEFT JOIN (
          SELECT warehouse_id, item_id,
            SUM(quantity_in - quantity_out) AS balance,
            MAX(transaction_date)           AS last_txn
          FROM stock_ledger
          GROUP BY warehouse_id, item_id
        ) s ON s.warehouse_id = w.id
        LEFT JOIN inventory_items ii
          ON ii.id = s.item_id AND ii.deleted_at IS NULL ${iif}
        WHERE w.deleted_at IS NULL ${wf}
        GROUP BY w.id, w.warehouse_name, w.warehouse_code
        ORDER BY total_value DESC
      `, p),

      pool.query(`
        SELECT
          COUNT(DISTINCT CASE WHEN transaction_type = 'receipt'    THEN id END)::int AS receipts_count,
          COUNT(DISTINCT CASE WHEN transaction_type IN ('issue','rm_issue') THEN id END)::int AS issues_count,
          COUNT(DISTINCT CASE WHEN transaction_type = 'adjustment' THEN id END)::int AS adjustments_count
        FROM stock_ledger
        WHERE transaction_date = CURRENT_DATE
      `),
    ]);

    res.json({
      data: {
        warehouses: warehouseRes.rows.map(r => ({
          id:               r.id,
          name:             r.name,
          code:             r.code,
          total_skus:       r.total_skus,
          total_items:      r.total_items,
          total_value:      parseFloat(r.total_value),
          low_stock_count:  r.low_stock_count,
          out_of_stock_count: r.out_of_stock_count,
          last_activity_at: r.last_activity_at,
        })),
        today: {
          receipts_count:    todayRes.rows[0]?.receipts_count    ?? 0,
          issues_count:      todayRes.rows[0]?.issues_count      ?? 0,
          adjustments_count: todayRes.rows[0]?.adjustments_count ?? 0,
          pending_qc_count:  0,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// DEPARTMENT STORES COST ANALYSIS  (StoresCostAnalysis.jsx)
// EOQ / ROP / ABC per department store + consolidated
// =====================================================
const DEPT_LABELS = {
  admin: 'Admin Store',
  service: 'Service Store',
  rnd: 'R&D Store',
  production: 'Production Store',
  general: 'General / Main',
};

function computeEoqMetrics(annualDemand, unitCost, orderingCost, holdingRate, leadTimeDays, safetyStock, currentStock) {
  const D = annualDemand;
  const H = unitCost * holdingRate;               // annual holding cost per unit
  const eoq = D > 0 && H > 0 ? Math.sqrt((2 * D * orderingCost) / H) : 0;
  const numOrders = eoq > 0 ? D / eoq : 0;
  const daysBetweenOrders = numOrders > 0 ? 365 / numOrders : 0;
  const dailyDemand = D / 365;
  const rop = dailyDemand * leadTimeDays + safetyStock;
  const maxInventory = eoq + safetyStock;
  const avgInventory = eoq / 2 + safetyStock;
  const annualHoldingCost = avgInventory * H;
  const annualSetupCost = numOrders * orderingCost;
  const annualPurchaseCost = D * unitCost;
  const r2 = n => parseFloat(n.toFixed(2));
  return {
    annual_demand: r2(D),
    unit_cost: r2(unitCost),
    current_stock: r2(currentStock),
    stock_value: r2(currentStock * unitCost),
    annual_consumption_value: r2(D * unitCost),
    eoq: r2(eoq),
    num_orders: r2(numOrders),
    days_between_orders: r2(daysBetweenOrders),
    rop: r2(rop),
    safety_stock: r2(safetyStock),
    lead_time_days: leadTimeDays,
    max_inventory: r2(maxInventory),
    avg_inventory: r2(avgInventory),
    annual_holding_cost: r2(annualHoldingCost),
    annual_setup_cost: r2(annualSetupCost),
    annual_purchase_cost: r2(annualPurchaseCost),
    total_annual_inventory_cost: r2(annualPurchaseCost + annualHoldingCost + annualSetupCost),
  };
}

// Rank items by annual consumption value and assign A (≤70%), B (≤90%), C classes
function assignAbc(items) {
  const sorted = [...items].sort((a, b) => b.annual_consumption_value - a.annual_consumption_value);
  const grandTotal = sorted.reduce((s, it) => s + it.annual_consumption_value, 0);
  let running = 0;
  for (const it of sorted) {
    if (grandTotal > 0 && it.annual_consumption_value > 0) {
      running += it.annual_consumption_value;
      const cumPct = (100 * running) / grandTotal;
      it.cumulative_pct = parseFloat(cumPct.toFixed(2));
      it.abc_category = cumPct <= 70 ? 'A' : cumPct <= 90 ? 'B' : 'C';
    } else {
      it.cumulative_pct = null;
      it.abc_category = 'C';
    }
  }
  return sorted;
}

function summarize(items) {
  const totals = {
    item_count: items.length,
    stock_value: 0,
    annual_consumption_value: 0,
    annual_holding_cost: 0,
    annual_setup_cost: 0,
    annual_purchase_cost: 0,
    total_annual_inventory_cost: 0,
    abc: { A: { count: 0, value: 0 }, B: { count: 0, value: 0 }, C: { count: 0, value: 0 } },
  };
  for (const it of items) {
    totals.stock_value += it.stock_value;
    totals.annual_consumption_value += it.annual_consumption_value;
    totals.annual_holding_cost += it.annual_holding_cost;
    totals.annual_setup_cost += it.annual_setup_cost;
    totals.annual_purchase_cost += it.annual_purchase_cost;
    totals.total_annual_inventory_cost += it.total_annual_inventory_cost;
    totals.abc[it.abc_category].count++;
    totals.abc[it.abc_category].value += it.annual_consumption_value;
  }
  for (const k of ['stock_value', 'annual_consumption_value', 'annual_holding_cost', 'annual_setup_cost', 'annual_purchase_cost', 'total_annual_inventory_cost']) {
    totals[k] = parseFloat(totals[k].toFixed(2));
  }
  for (const c of ['A', 'B', 'C']) totals.abc[c].value = parseFloat(totals.abc[c].value.toFixed(2));
  return totals;
}

router.get('/dept-cost-analysis', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const cid = companyId != null ? companyId : 0;

    // Cost parameters: query override → company_settings → env default
    let orderingCost = Number.parseFloat(process.env.DEFAULT_ORDERING_COST ?? '500');
    let holdingRate = Number.parseFloat(process.env.INVENTORY_HOLDING_COST_RATE ?? '0.18');
    if (!Number.isFinite(orderingCost) || orderingCost <= 0) orderingCost = 500;
    if (!Number.isFinite(holdingRate) || holdingRate <= 0) holdingRate = 0.18;
    try {
      const { rows: [cfg] } = await pool.query(
        `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'inventory' LIMIT 1`, [cid]
      );
      const cfgOrdering = parseFloat(cfg?.settings?.ordering_cost);
      const cfgHolding = parseFloat(cfg?.settings?.holding_cost_rate);
      if (Number.isFinite(cfgOrdering) && cfgOrdering > 0) orderingCost = cfgOrdering;
      if (Number.isFinite(cfgHolding) && cfgHolding > 0) holdingRate = cfgHolding;
    } catch { /* use defaults */ }
    const qOrdering = parseFloat(req.query.ordering_cost);
    const qHolding = parseFloat(req.query.holding_rate);
    if (Number.isFinite(qOrdering) && qOrdering > 0) orderingCost = qOrdering;
    if (Number.isFinite(qHolding) && qHolding > 0) holdingRate = qHolding;

    const p = companyId != null ? [companyId] : [];
    const iif = companyId != null ? 'AND ii.company_id = $1' : '';
    const wf = companyId != null ? 'AND w.company_id = $1' : '';

    const [deptItemsRes, whListRes] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(w.department, 'general')                          AS department,
          ii.id                                                       AS item_id,
          ii.item_code,
          ii.item_name,
          ii.unit_of_measure,
          COALESCE(ii.item_type, 'Other')                            AS item_type,
          COALESCE(ii.safety_stock, 0)::numeric                      AS safety_stock,
          COALESCE(ii.lead_time_days, 14)::int                       AS lead_time_days,
          COALESCE(uc.unit_cost, ii.standard_cost, 0)::numeric       AS unit_cost,
          COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::numeric AS current_stock,
          COALESCE(SUM(
            CASE WHEN sl.quantity_out > 0
                  AND COALESCE(sl.transaction_type, '') <> 'transfer'
                  AND sl.transaction_date >= CURRENT_DATE - INTERVAL '12 months'
                 THEN sl.quantity_out ELSE 0 END
          ), 0)::numeric                                             AS annual_demand
        FROM stock_ledger sl
        JOIN warehouses w      ON w.id = sl.warehouse_id AND w.deleted_at IS NULL ${wf}
        JOIN inventory_items ii ON ii.id = sl.item_id AND ii.deleted_at IS NULL AND ii.is_active = true ${iif}
        LEFT JOIN (
          SELECT item_id, AVG(rate) AS unit_cost
          FROM stock_ledger WHERE rate > 0 GROUP BY item_id
        ) uc ON uc.item_id = ii.id
        GROUP BY COALESCE(w.department, 'general'), ii.id, ii.item_code, ii.item_name,
                 ii.unit_of_measure, ii.item_type, ii.safety_stock, ii.lead_time_days,
                 uc.unit_cost, ii.standard_cost
      `, p),
      pool.query(`
        SELECT
          COALESCE(w.department, 'general') AS department,
          json_agg(json_build_object(
            'id', w.id,
            'name', COALESCE(w.warehouse_name, w.name),
            'code', w.warehouse_code
          ) ORDER BY w.id) AS warehouses
        FROM warehouses w
        WHERE w.deleted_at IS NULL ${wf}
        GROUP BY COALESCE(w.department, 'general')
      `, p),
    ]);

    const buildItem = r => {
      const metrics = computeEoqMetrics(
        parseFloat(r.annual_demand),
        parseFloat(r.unit_cost),
        orderingCost,
        holdingRate,
        r.lead_time_days,
        parseFloat(r.safety_stock),
        parseFloat(r.current_stock)
      );
      return {
        item_id: r.item_id,
        item_code: r.item_code,
        item_name: r.item_name,
        unit_of_measure: r.unit_of_measure,
        item_type: r.item_type,
        ...metrics,
      };
    };

    // Per-department groups
    const deptMap = {};
    for (const r of deptItemsRes.rows) {
      (deptMap[r.department] ||= []).push(buildItem(r));
    }
    const warehousesByDept = {};
    for (const r of whListRes.rows) warehousesByDept[r.department] = r.warehouses;

    const deptOrder = ['admin', 'service', 'rnd', 'production', 'general'];
    const allDepts = [...new Set([...deptOrder, ...Object.keys(deptMap), ...Object.keys(warehousesByDept)])]
      .filter(d => deptMap[d] || warehousesByDept[d]);

    const departments = allDepts.map(dept => {
      const items = assignAbc(deptMap[dept] || []);
      return {
        department: dept,
        label: DEPT_LABELS[dept] || dept,
        warehouses: warehousesByDept[dept] || [],
        items,
        totals: summarize(items),
      };
    });

    // Consolidated: aggregate the same rows per item across all departments
    const consolidatedMap = {};
    for (const r of deptItemsRes.rows) {
      const key = r.item_id;
      const acc = (consolidatedMap[key] ||= { ...r, annual_demand: 0, current_stock: 0 });
      acc.annual_demand = parseFloat(acc.annual_demand) + parseFloat(r.annual_demand);
      acc.current_stock = parseFloat(acc.current_stock) + parseFloat(r.current_stock);
    }
    const consolidatedItems = assignAbc(Object.values(consolidatedMap).map(buildItem));

    res.json({
      config: {
        ordering_cost: orderingCost,
        holding_cost_rate_annual: holdingRate,
        demand_window_months: 12,
        working_days_basis: 365,
      },
      departments,
      consolidated: {
        items: consolidatedItems,
        totals: summarize(consolidatedItems),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.use('/advanced', advInventoryRouter);
router.use('/serials', serialNumbersRouter);
router.use('/catalog', componentCatalogRouter);

export default router;

