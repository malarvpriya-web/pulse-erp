import express from 'express';
import multer from 'multer';
import pool from '../../shared/db.js';
import prRepo from '../repositories/purchaseRequest.repository.js';
import poRepo from '../repositories/purchaseOrder.repository.js';
import grnService from '../services/grn.service.js';
import { logAudit } from '../../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../../services/WorkflowNotificationService.js';
import { nextRfqNumber, nextPurchaseOrderNumber } from '../../../shared/docNumber.js';
import { uploadFile } from '../../../services/StorageService.js';
import { checkAndCreateAlerts } from '../../../services/stockAlerts.js';
import { companyOf } from '../../../shared/scope.js';
import { hasRole, allowRoles } from '../../../middlewares/auth.middleware.js';
import { requiredBand, assertCanDecideAmount } from '../procurement.authz.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();
const DEFAULT_ORDERING_COST = parseFloat(process.env.DEFAULT_ORDERING_COST || '500');
const DEFAULT_LEAD_TIME_DAYS = parseInt(process.env.DEFAULT_LEAD_TIME_DAYS || '14', 10);
const DEFAULT_HOLDING_RATE = parseFloat(process.env.INVENTORY_HOLDING_COST_RATE || '0.18');

const VALID_PO_STATUSES = new Set(['draft', 'sent', 'approved', 'partial', 'received', 'invoiced', 'completed', 'cancelled', 'closed']);

const cid = req => companyOf(req);

// =====================================================
// PURCHASE REQUESTS
// =====================================================

// GET /purchase-requests/stats — must be before /:id route
router.get('/purchase-requests/stats', async (req, res) => {
  try {
    const companyId = cid(req);
    const cidFilter = companyId ? `AND e.company_id = $1` : '';
    const params = companyId ? [companyId] : [];
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                                       AS total,
        COUNT(*) FILTER (WHERE pr.status = 'pending_approval')         AS pending_approval,
        COUNT(*) FILTER (WHERE pr.status = 'approved')                 AS approved,
        COUNT(*) FILTER (WHERE pr.status = 'converted_to_po')          AS ordered,
        COUNT(*) FILTER (WHERE pr.status = 'rejected')                 AS rejected
      FROM purchase_requests pr
      LEFT JOIN employees e ON e.id = pr.requested_by_employee_id
      WHERE pr.deleted_at IS NULL ${cidFilter}
    `, params);
    const s = rows[0];
    res.json({
      total:            parseInt(s.total),
      pending_approval: parseInt(s.pending_approval),
      approved:         parseInt(s.approved),
      ordered:          parseInt(s.ordered),
      rejected:         parseInt(s.rejected),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/purchase-requests', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const prNumber = await prRepo.getNextNumber();
      const pr = await prRepo.create(client, {
        ...req.body,
        company_id: cid(req),
        request_number: prNumber
      });

      for (const item of req.body.items) {
        await prRepo.createItem(client, {
          pr_id: pr.id,
          ...item
        });
      }

      // Value the header from its line items so approval routing sees a real amount
      await prRepo.recomputeTotal(client, pr.id);

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
    const prs = await prRepo.findAll({ ...req.query, company_id: cid(req) });
    res.json(prs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/purchase-requests/export', async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, from_date, to_date } = req.query;
    const params = [];
    const conditions = ['pr.deleted_at IS NULL'];
    if (companyId) { params.push(companyId); conditions.push(`e.company_id = $${params.length}`); }
    if (status)    { params.push(status);    conditions.push(`pr.status = $${params.length}`); }
    if (from_date) { params.push(from_date); conditions.push(`pr.request_date >= $${params.length}`); }
    if (to_date)   { params.push(to_date);   conditions.push(`pr.request_date <= $${params.length}`); }
    const { rows } = await pool.query(`
      SELECT pr.request_number, pr.request_date, pr.notes AS description,
             COALESCE(e.first_name||' '||e.last_name, '') AS requested_by,
             0 AS total_amount, pr.status, pr.created_at
      FROM purchase_requests pr
      LEFT JOIN employees e ON e.id = pr.requested_by_employee_id
      WHERE ${conditions.join(' AND ')} ORDER BY pr.request_date DESC
    `, params);
    const header = 'PR No,Date,Description,Requested By,Amount,Status,Created';
    const csvRows = rows.map(r => [
      r.request_number||'', r.request_date||'', r.description||'',
      r.requested_by||'', r.total_amount||0, r.status||'',
      r.created_at ? new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '',
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="purchase-requests-${Date.now()}.csv"`);
    res.send([header, ...csvRows].join('\n'));
  } catch (error) { res.status(500).json({ error: error.message }); }
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

// Helper: load procurement settings for current company
async function getProcSettings(companyId) {
  if (!companyId) return PROC_DEFAULTS;
  const { rows } = await pool.query(`SELECT * FROM procurement_settings WHERE company_id=$1 LIMIT 1`, [companyId]).catch(() => ({ rows: [] }));
  return rows[0] ? { ...PROC_DEFAULTS, ...rows[0] } : PROC_DEFAULTS;
}

// requiredApprovalLevel / canApprove moved to ../procurement.authz.js as
// requiredBand / assertCanDecideAmount. The originals read only the caller's
// PRIMARY role, keyed on three roles that do not exist (`senior_manager`,
// `cfo`, `finance_head`), omitted `finance`/`finance_manager` entirely, and
// ignored the configured `cfo_approval_above`. See that file for detail.

router.put('/purchase-requests/:id/approve', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const oldPr = await prRepo.findById(req.params.id);
      if (!oldPr) return res.status(404).json({ error: 'PR not found' });

      // Enforce approval limits from procurement settings
      const settings = await getProcSettings(cid(req));
      // Trust the persisted header total, but if it is missing/zero while line
      // items exist, derive the amount live so a stale total can never silently
      // downgrade a high-value PR to 'auto' and skip the role gate.
      let amount = parseFloat(oldPr.total_amount || 0);
      if (!(amount > 0)) {
        const { rows: [agg] } = await client.query(
          `SELECT COALESCE(SUM(COALESCE(quantity, 0) * COALESCE(expected_price, 0)), 0) AS total
           FROM purchase_request_items WHERE pr_id = $1`,
          [req.params.id]
        );
        amount = parseFloat(agg?.total || 0);
      }
      const required = requiredBand(amount, settings);
      const decide   = assertCanDecideAmount(req, amount, settings, 'approve');
      if (decide) {
        await client.query('ROLLBACK');
        return res.status(decide.status).json(decide.body);
      }

      const actorId = req.user.userId ?? req.user.id;
      // purchase_requests.approved_by FKs employees(id), NOT users(id) — the
      // same trap as stock_ledger.created_by. Passing userId raised a foreign
      // key violation for every approver whose users.id did not coincidentally
      // exist as an employees.id, which meant PR approval 500'd for the admin
      // accounts (employee_id IS NULL) that are the only ones able to clear
      // high-value requests. NULL is accepted by the column.
      const approverEmpId = req.user?.employee_id ?? null;
      const pr = await prRepo.updateStatus(client, req.params.id, 'approved', approverEmpId);
      await client.query('COMMIT');

      logAudit({
        userId: actorId, module: 'procurement', recordId: pr.id,
        recordType: 'purchase_request', action: 'approve',
        oldData: oldPr ?? null, newData: pr, req,
      });

      notifyWorkflowEvent('approved', {
        module: 'Purchase Request', recordId: pr.id,
        submitterUserId: pr.requested_by_employee_id,
      });

      res.json({ ...pr, approval_level: required });
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

router.put('/purchase-requests/:id/reject', async (req, res) => {
  try {
    const actorId = req.user.userId ?? req.user.id;
    const { remarks } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const oldPr = await prRepo.findById(req.params.id);
      if (!oldPr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'PR not found' }); }

      // Rejecting requires the same authority as approving. This route had no
      // check at all, so anyone who could not approve a PR could still reject
      // it — a denial-of-procurement with the same commercial weight.
      const settings = await getProcSettings(cid(req));
      const decide = assertCanDecideAmount(req, oldPr.total_amount, settings, 'reject');
      if (decide) { await client.query('ROLLBACK'); return res.status(decide.status).json(decide.body); }

      const pr = await prRepo.updateStatus(client, req.params.id, 'rejected', actorId);
      await client.query('COMMIT');
      logAudit({
        userId: actorId, module: 'procurement', recordId: pr.id,
        recordType: 'purchase_request', action: 'reject',
        oldData: oldPr ?? null, newData: { ...pr, remarks }, req,
      });
      notifyWorkflowEvent('rejected', {
        module: 'Purchase Request', recordId: pr.id,
        submitterUserId: pr.requested_by_employee_id,
      });
      res.json(pr);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Convert approved PR → new draft PO
router.patch('/purchase-requests/:id/convert-to-po', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pr = await prRepo.findById(req.params.id);
      if (!pr) return res.status(404).json({ error: 'Purchase request not found' });

      // Carry the requisition's line items onto the PO — a converted PO must not
      // be an empty ₹0 header (which would break GRN receipt and 3-way match).
      // Seed each PO line's rate from the requested expected_price, and derive
      // the header subtotal/total from the lines so the PO is self-consistent.
      const prItems  = await prRepo.getItems(pr.id, client);
      const subtotal = prItems.reduce(
        (s, it) => s + (parseFloat(it.quantity) || 0) * (parseFloat(it.expected_price) || 0),
        0
      );

      const poNumber = await poRepo.getNextNumber();
      const po = await poRepo.create(client, {
        po_number:      poNumber,
        pr_id:          pr.id,
        supplier_id:    req.body.supplier_id || null,
        order_date:     new Date().toISOString().slice(0, 10),
        subtotal,
        tax_amount:     0,
        total_amount:   subtotal,
        notes:          pr.notes,
        created_by:     req.user?.userId ?? req.user?.id,
        company_id:     cid(req),
      });

      for (const it of prItems) {
        const qty  = parseFloat(it.quantity) || 0;
        const rate = parseFloat(it.expected_price) || 0;
        await poRepo.createItem(client, {
          po_id:        po.id,
          item_id:      it.item_id ?? null,
          quantity:     qty,
          rate,
          tax_rate:     0,
          tax_amount:   0,
          total_amount: qty * rate,
        });
      }

      await prRepo.updateStatus(client, pr.id, 'converted_to_po');
      await client.query('COMMIT');

      logAudit({
        userId: req.user?.userId ?? req.user?.id,
        module: 'procurement', recordId: po.id,
        recordType: 'purchase_order', action: 'create',
        oldData: null, newData: po, req,
      });

      res.status(201).json({ po_id: po.id, po_number: po.po_number });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// PURCHASE ORDERS
// =====================================================

// GET /purchase-orders/stats — must be before /:id route
router.get('/purchase-orders/stats', async (req, res) => {
  try {
    const stats = await poRepo.getStats(cid(req));
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/purchase-orders', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const poNumber = await poRepo.getNextNumber();
      const po = await poRepo.create(client, {
        ...req.body,
        po_number:  poNumber,
        company_id: cid(req),
        created_by: req.user.userId ?? req.user.id
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
    const companyId = companyOf(req);
    const pos = await poRepo.findAll({ ...req.query, company_id: companyId });
    res.json(pos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/purchase-orders/export', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { status } = req.query;
    const params = [];
    let where = 'WHERE po.deleted_at IS NULL';
    if (companyId) { params.push(companyId); where += ` AND po.company_id = $${params.length}`; }
    if (status)    { params.push(status);    where += ` AND po.status = $${params.length}`; }

    const { rows } = await pool.query(`
      SELECT
        po.po_number,
        COALESCE(v.vendor_name, '') AS vendor_name,
        (SELECT COUNT(*) FROM purchase_order_items WHERE po_id = po.id)::INT AS items_count,
        po.total_amount,
        po.status,
        po.created_at
      FROM purchase_orders po
      LEFT JOIN vendors v ON v.id = po.supplier_id
      ${where}
      ORDER BY po.created_at DESC
    `, params);

    const header = 'PO No,Vendor,Items,Value,Status,Created Date';
    const csvRows = rows.map(r => [
      r.po_number || '',
      r.vendor_name || '',
      r.items_count || 0,
      r.total_amount || 0,
      r.status || '',
      r.created_at ? new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

    const csv = [header, ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="purchase-orders-${Date.now()}.csv"`);
    res.send(csv);
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
    const { status } = req.body;
    if (!VALID_PO_STATUSES.has(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${[...VALID_PO_STATUSES].join(', ')}` });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const oldPo = await poRepo.findById(req.params.id);
      const po = await poRepo.updateStatus(client, req.params.id, status);
      await client.query('COMMIT');

      logAudit({
        userId: req.user?.userId ?? req.user?.id,
        module: 'procurement',
        recordId: po.id,
        recordType: 'purchase_order',
        action: 'update',
        oldData: oldPo ?? null,
        newData: po,
        req,
      });

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

router.patch('/purchase-orders/:id/send', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const oldPo = await poRepo.findById(req.params.id);
      if (!oldPo) return res.status(404).json({ error: 'Purchase order not found' });
      const po = await poRepo.updateStatus(client, req.params.id, 'sent');
      await client.query('COMMIT');
      logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'procurement', recordId: po.id, recordType: 'purchase_order', action: 'send', oldData: oldPo, newData: po, req });
      res.json(po);
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.patch('/purchase-orders/:id/approve', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const oldPo = await poRepo.findById(req.params.id);
      if (!oldPo) return res.status(404).json({ error: 'Purchase order not found' });

      // Enforce PO approval limits
      const settings = await getProcSettings(cid(req));
      const amount   = parseFloat(oldPo.total_amount || 0);
      const required = requiredBand(amount, settings);
      const decide   = assertCanDecideAmount(req, amount, settings, 'approve');
      if (decide) {
        await client.query('ROLLBACK');
        return res.status(decide.status).json(decide.body);
      }

      // Check min vendor rating if supplier set
      if (oldPo.supplier_id && settings.min_vendor_rating > 0) {
        const { rows: vRows } = await pool.query(`SELECT COALESCE(quality_rating,0) + COALESCE(delivery_rating,0) + COALESCE(price_rating,0) AS total_rating FROM vendors WHERE id=$1`, [oldPo.supplier_id]);
        const avgRating = vRows[0] ? parseFloat(vRows[0].total_rating) / 3 : 0;
        if (avgRating > 0 && avgRating < settings.min_vendor_rating) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Vendor rating (${avgRating.toFixed(1)}) is below minimum required (${settings.min_vendor_rating}). Update vendor rating or override in Settings.` });
        }
      }

      const po = await poRepo.updateStatus(client, req.params.id, 'approved');
      await client.query('COMMIT');
      logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'procurement', recordId: po.id, recordType: 'purchase_order', action: 'approve', oldData: oldPo, newData: po, req });

      // Send notification if enabled
      if (settings.notify_po_approval) {
        notifyWorkflowEvent('approved', { module: 'Purchase Order', recordId: po.id });
      }

      res.json({ ...po, approval_level: required });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.patch('/purchase-orders/:id/cancel', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const oldPo = await poRepo.findById(req.params.id);
      if (!oldPo) return res.status(404).json({ error: 'Purchase order not found' });

      // Cancelling a live PO is as consequential as approving it — it can halt
      // a delivery already in motion — so it takes the same authority. This
      // route was unchecked, which meant a caller blocked from approving a PO
      // could simply cancel it instead.
      const settings = await getProcSettings(cid(req));
      const decide = assertCanDecideAmount(req, oldPo.total_amount, settings, 'cancel');
      if (decide) { await client.query('ROLLBACK'); return res.status(decide.status).json(decide.body); }

      const po = await poRepo.updateStatus(client, req.params.id, 'cancelled');
      await client.query('COMMIT');
      logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'procurement', recordId: po.id, recordType: 'purchase_order', action: 'cancel', oldData: oldPo, newData: po, req });
      res.json(po);
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// =====================================================
// GOODS RECEIPT NOTES
// =====================================================
router.post('/grn', async (req, res) => {
  try {
    const grn = await grnService.createGRN(
      { ...req.body, company_id: cid(req) },
      req.user.userId ?? req.user.id
    );

    // Send notification if enabled
    const settings = await getProcSettings(cid(req)).catch(() => PROC_DEFAULTS);
    if (settings.notify_grn_receipt) {
      notifyWorkflowEvent('received', { module: 'Goods Receipt', recordId: grn.id });
    }

    // Fire-and-forget: check low stock for each received item
    const wid = req.body.warehouse_id;
    if (wid && Array.isArray(req.body.items)) {
      for (const item of req.body.items) {
        checkAndCreateAlerts(item.item_id, wid);
      }
    }

    res.status(201).json(grn);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/grn', async (req, res) => {
  try {
    const grns = await grnService.getGRNs({ ...req.query, company_id: cid(req) });
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

router.put('/grn/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const { rows } = await pool.query(
      `UPDATE goods_receipt_notes SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'GRN not found' });
    res.json(rows[0]);
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

// ── Vendors: with avg ratings from vendor_ratings ────────────────────────────
router.get('/vendors', async (req, res) => {
  try {
    const { search, category, status } = req.query;
    const companyId = cid(req);
    const conditions = ['1=1'];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`(v.company_id = $${idx++} OR v.company_id IS NULL)`); params.push(companyId); }
    if (search)    { conditions.push(`(v.vendor_name ILIKE $${idx} OR v.contact_person ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (category)  { conditions.push(`v.category = $${idx++}`); params.push(category); }
    if (status)    { conditions.push(`v.status = $${idx++}`); params.push(status); }

    // Try query with vendor_ratings join; fall back to plain select if table not yet created
    let rows;
    try {
      const r = await pool.query(`
        SELECT v.*,
          ROUND(AVG(vr.quality_score)::NUMERIC, 1)  AS avg_quality,
          ROUND(AVG(vr.delivery_score)::NUMERIC, 1) AS avg_delivery,
          ROUND(AVG(vr.price_score)::NUMERIC, 1)    AS avg_price,
          ROUND(AVG(vr.overall_score)::NUMERIC, 1)  AS avg_overall
        FROM vendors v
        LEFT JOIN vendor_ratings vr ON vr.vendor_id = v.id
        WHERE ${conditions.join(' AND ')}
        GROUP BY v.id
        ORDER BY v.vendor_name
      `, params);
      rows = r.rows;
    } catch {
      const r = await pool.query(
        `SELECT * FROM vendors WHERE ${conditions.join(' AND ')} ORDER BY vendor_name`,
        params
      );
      rows = r.rows;
    }
    res.json({ vendors: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RFQs: with response_count and lowest_quote ────────────────────────────────
router.get('/rfqs', async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, search } = req.query;
    const conditions = ['1=1'];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`r.company_id = $${idx++}`); params.push(companyId); }
    if (status)    { conditions.push(`r.status = $${idx++}`); params.push(status); }
    if (search)    { conditions.push(`(r.item_description ILIKE $${idx} OR r.rfq_number ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

    // Try with rfq_quotes join; fall back to plain rfqs if table not yet created
    let rows;
    try {
      const r = await pool.query(`
        SELECT r.*, COUNT(rq.id)::INT AS response_count, MIN(rq.unit_price) AS lowest_quote
        FROM rfqs r
        LEFT JOIN rfq_quotes rq ON rq.rfq_id = r.id
        WHERE ${conditions.join(' AND ')}
        GROUP BY r.id
        ORDER BY r.created_at DESC
      `, params);
      rows = r.rows;
    } catch {
      const r = await pool.query(
        `SELECT *, 0 AS response_count, NULL AS lowest_quote FROM rfqs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
        params
      );
      rows = r.rows;
    }
    res.json({ rfqs: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rfqs', async (req, res) => {
  try {
    const { item_description, quantity, unit, required_by, linked_pr_id, vendor_ids } = req.body;
    const rfq_number = await nextRfqNumber();
    const { rows } = await pool.query(`
      INSERT INTO rfqs (rfq_number, pr_id, item_description, quantity, unit, required_by, vendor_ids, status, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)
      RETURNING *
    `, [rfq_number, linked_pr_id || null, item_description, quantity || 1, unit || 'Nos', required_by || null, JSON.stringify(vendor_ids || []), cid(req)]);
    res.status(201).json({ ...rows[0], quotes: [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rfqs/:id/send-to-vendors', async (req, res) => {
  try {
    const { id } = req.params;
    const { vendor_ids } = req.body;
    if (!vendor_ids?.length) return res.status(400).json({ error: 'vendor_ids required' });
    for (const vendor_id of vendor_ids) {
      await pool.query(
        `INSERT INTO rfq_quotes (rfq_id, vendor_id) VALUES ($1,$2) ON CONFLICT (rfq_id, vendor_id) DO NOTHING`,
        [id, vendor_id]
      );
    }
    const { rows } = await pool.query(
      `UPDATE rfqs SET status='sent', vendor_ids=$1 WHERE id=$2 RETURNING *`,
      [JSON.stringify(vendor_ids), id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'RFQ not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rfqs/:rfqId/responses/:vendorId', async (req, res) => {
  try {
    const { rfqId, vendorId } = req.params;
    const { unit_price, total_amount, delivery_days, payment_terms, notes } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO rfq_quotes (rfq_id, vendor_id, unit_price, total_amount, delivery_days, payment_terms, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (rfq_id, vendor_id) DO UPDATE SET
        unit_price=EXCLUDED.unit_price, total_amount=EXCLUDED.total_amount,
        delivery_days=EXCLUDED.delivery_days, payment_terms=EXCLUDED.payment_terms, notes=EXCLUDED.notes
      RETURNING *
    `, [rfqId, vendorId, unit_price, total_amount, delivery_days, payment_terms, notes]);
    await pool.query(`UPDATE rfqs SET status='responses_received' WHERE id=$1 AND status='sent'`, [rfqId]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/rfqs/:rfqId/award/:vendorId', async (req, res) => {
  try {
    const { rfqId, vendorId } = req.params;
    await pool.query(`UPDATE rfq_quotes SET is_winner=false WHERE rfq_id=$1`, [rfqId]);
    await pool.query(`UPDATE rfq_quotes SET is_winner=true  WHERE rfq_id=$1 AND vendor_id=$2`, [rfqId, vendorId]);
    const { rows: rfqRows }   = await pool.query(`UPDATE rfqs SET status='closed' WHERE id=$1 RETURNING *`, [rfqId]);
    const { rows: quoteRows } = await pool.query(
      `SELECT rq.*, v.vendor_name FROM rfq_quotes rq LEFT JOIN vendors v ON v.id=rq.vendor_id WHERE rq.rfq_id=$1 AND rq.vendor_id=$2`,
      [rfqId, vendorId]
    );
    if (!rfqRows[0]) return res.status(404).json({ error: 'RFQ not found' });
    let po = null;
    try {
      const poNum = await nextPurchaseOrderNumber();
      const { rows: poRows } = await pool.query(`
        INSERT INTO purchase_orders (po_number, supplier_id, pr_id, total_amount, status, order_date, company_id)
        VALUES ($1,$2,$3,$4,'draft',CURRENT_DATE,$5) RETURNING *
      `, [poNum, vendorId, rfqRows[0].pr_id || null, quoteRows[0]?.total_amount || 0, cid(req)]);
      po = poRows[0];
    } catch (e) { console.warn('[award] PO auto-create skipped:', e.message); }
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'procurement', recordId: rfqRows[0].id, recordType: 'rfq', action: 'award', oldData: null, newData: { ...rfqRows[0], awarded_vendor_id: vendorId, quote: quoteRows[0] ?? null }, req });
    res.json({ success: true, rfq: rfqRows[0], quote: quoteRows[0], po });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 3-Way Match ───────────────────────────────────────────────────────────────
router.get('/three-way-match', async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, po_id } = req.query;
    const conditions = ['1=1'];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`twm.company_id = $${idx++}`); params.push(companyId); }
    if (status)    { conditions.push(`twm.match_status = $${idx++}`); params.push(status); }
    if (po_id)     { conditions.push(`twm.po_id = $${idx++}`); params.push(po_id); }
    try {
      const { rows } = await pool.query(`
        SELECT twm.*, po.po_number, v.vendor_name
        FROM three_way_matches twm
        JOIN purchase_orders po ON po.id = twm.po_id
        LEFT JOIN vendors v ON v.id = po.supplier_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY twm.created_at DESC
      `, params);
      res.json({ matches: rows });
    } catch {
      // three_way_matches table may not exist yet — return empty list gracefully
      res.json({ matches: [] });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/three-way-match', async (req, res) => {
  try {
    const { po_id, grn_id, vendor_invoice_no, vendor_invoice_date, vendor_invoice_amount } = req.body;
    if (!po_id) return res.status(400).json({ error: 'po_id is required' });
    const { rows: poRows } = await pool.query('SELECT total_amount FROM purchase_orders WHERE id=$1', [po_id]);
    const po_amount  = parseFloat(poRows[0]?.total_amount || 0);
    const inv_amount = parseFloat(vendor_invoice_amount  || 0);
    let grn_amount   = 0;
    if (grn_id) {
      // goods_receipt_notes has no value column — derive the GRN leg from its own
      // lines. Value the ACCEPTED quantity (received - rejected), since that is
      // what entered stock and what the vendor should be paid for. Errors are no
      // longer swallowed: a silent catch here is what pinned grn_amount at 0 and
      // made every 3-way match classify as a discrepancy.
      const { rows: gr } = await pool.query(
        `SELECT COALESCE(SUM(
                  GREATEST(COALESCE(gi.quantity_received, 0) - COALESCE(gi.quantity_rejected, 0), 0)
                  * COALESCE(gi.rate, 0)
                ), 0) AS amt
         FROM grn_items gi WHERE gi.grn_id = $1`, [grn_id]
      );
      grn_amount = parseFloat(gr[0]?.amt || 0);
    }
    let match_status = 'pending';
    if (po_amount > 0) {
      const pct = Math.max(Math.abs(po_amount - inv_amount), Math.abs(po_amount - grn_amount)) / po_amount;
      match_status = pct <= 0.01 ? 'matched' : 'discrepancy';
    }
    const { rows } = await pool.query(`
      INSERT INTO three_way_matches (company_id, po_id, grn_id, vendor_invoice_no, vendor_invoice_date, vendor_invoice_amount, po_amount, grn_amount, match_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [cid(req), po_id, grn_id || null, vendor_invoice_no || null, vendor_invoice_date || null, inv_amount, po_amount, grn_amount, match_status]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Create vendor ─────────────────────────────────────────────────────────────
router.post('/vendors', async (req, res) => {
  try {
    const companyId = cid(req);
    const { vendor_name, category, gstin, pan, bank_name, account_number, ifsc, contact_person, email, phone, city, state, address, status } = req.body;
    if (!vendor_name?.trim()) return res.status(400).json({ error: 'Vendor name is required.' });
    const { rows } = await pool.query(
      `INSERT INTO vendors (vendor_name, category, gstin, pan, bank_name, account_number, ifsc, contact_person, email, phone, city, state, address, status, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [vendor_name.trim(), category || 'Raw Materials', gstin || null, pan || null, bank_name || null, account_number || null, ifsc || null, contact_person || null, email || null, phone || null, city || null, state || null, address || null, status || 'active', companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Update vendor ─────────────────────────────────────────────────────────────
router.put('/vendors/:id', async (req, res) => {
  try {
    const companyId = cid(req);
    const { id } = req.params;
    const { vendor_name, category, gstin, pan, bank_name, account_number, ifsc, contact_person, email, phone, city, state, address, status } = req.body;
    if (!vendor_name?.trim()) return res.status(400).json({ error: 'Vendor name is required.' });
    const cidCond = companyId ? 'AND (company_id = $15 OR company_id IS NULL)' : '';
    const params = [vendor_name.trim(), category || 'Raw Materials', gstin || null, pan || null, bank_name || null, account_number || null, ifsc || null, contact_person || null, email || null, phone || null, city || null, state || null, address || null, status || 'active', ...(companyId ? [companyId, id] : [id])];
    const idParam = companyId ? '$16' : '$15';
    const { rows } = await pool.query(
      `UPDATE vendors SET vendor_name=$1, category=$2, gstin=$3, pan=$4, bank_name=$5, account_number=$6, ifsc=$7, contact_person=$8, email=$9, phone=$10, city=$11, state=$12, address=$13, status=$14, updated_at=NOW()
       WHERE id=${idParam} ${cidCond} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Vendor not found.' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Vendor Scorecard & Ratings ────────────────────────────────────────────────
router.get('/vendors/:id/scorecard', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT vr.*, po.po_number
      FROM vendor_ratings vr
      LEFT JOIN purchase_orders po ON po.id = vr.po_id
      WHERE vr.vendor_id = $1
      ORDER BY vr.rated_at DESC
    `, [req.params.id]);
    const cnt = rows.length;
    const avg = f => cnt ? parseFloat((rows.reduce((s, r) => s + (+r[f] || 0), 0) / cnt).toFixed(1)) : 0;
    res.json({ ratings: rows, avg_quality: avg('quality_score'), avg_delivery: avg('delivery_score'), avg_price: avg('price_score'), avg_overall: avg('overall_score') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendor-ratings', async (req, res) => {
  try {
    const { vendor_id, po_id, quality_score, delivery_score, price_score, comments } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required' });
    const overall = parseFloat(((+quality_score + +delivery_score + +price_score) / 3).toFixed(1));
    // rated_by FKs employees(id) — use the token's employee_id, not the users.id.
    // Validate it exists so a missing/stale reference degrades to NULL instead of a FK 500.
    let ratedBy = req.user?.employee_id ?? null;
    if (ratedBy != null) {
      const chk = await pool.query('SELECT 1 FROM employees WHERE id = $1', [ratedBy]);
      if (!chk.rows.length) ratedBy = null;
    }
    const { rows } = await pool.query(`
      INSERT INTO vendor_ratings (company_id, vendor_id, po_id, quality_score, delivery_score, price_score, overall_score, comments, rated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [cid(req), vendor_id, po_id || null, quality_score, delivery_score, price_score, overall, comments || null, ratedBy]);
    await pool.query(`
      UPDATE vendors SET
        quality_rating  = (SELECT ROUND(AVG(quality_score)::NUMERIC,1)  FROM vendor_ratings WHERE vendor_id=$1),
        delivery_rating = (SELECT ROUND(AVG(delivery_score)::NUMERIC,1) FROM vendor_ratings WHERE vendor_id=$1),
        price_rating    = (SELECT ROUND(AVG(price_score)::NUMERIC,1)    FROM vendor_ratings WHERE vendor_id=$1)
      WHERE id=$1
    `, [vendor_id]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =====================================================
// DASHBOARDS & ANALYTICS
// =====================================================
router.get('/dashboard', async (req, res) => {
  try {
    const companyId = cid(req);
    const cidFilter = companyId ? ` AND company_id = $1` : '';
    const params = companyId ? [companyId] : [];

    const pendingPRs = await pool.query(
      `SELECT COUNT(*) as count FROM purchase_requests WHERE status = 'pending_approval' AND deleted_at IS NULL${cidFilter}`, params
    );
    const pendingPOs = await pool.query(
      `SELECT COUNT(*) as count FROM purchase_orders WHERE status IN ('draft', 'sent') AND deleted_at IS NULL${cidFilter}`, params
    );
    const lateDeliveries = await poRepo.getLateDeliveries(companyId);
    const monthlyPurchase = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) as total
       FROM purchase_orders
       WHERE order_date >= DATE_TRUNC('month', CURRENT_DATE)
       AND status != 'cancelled' AND deleted_at IS NULL${cidFilter}`, params
    );

    // Additional live KPIs
    const [openRFQs, pendingGRNs, ytdSpend, spendByVendor] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM rfqs WHERE status NOT IN ('closed','cancelled') AND deleted_at IS NULL${cidFilter}`, params),
      pool.query(`SELECT COUNT(*) AS count FROM goods_receipt_notes WHERE status IS NULL OR status = 'pending' AND deleted_at IS NULL${cidFilter}`, params),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS total FROM purchase_orders WHERE EXTRACT(year FROM order_date)=EXTRACT(year FROM CURRENT_DATE) AND status!='cancelled' AND deleted_at IS NULL${cidFilter}`, params),
      companyId ? pool.query(`SELECT COALESCE(v.vendor_name,'Unknown') AS vendor, SUM(po.total_amount) AS spend FROM purchase_orders po LEFT JOIN vendors v ON v.id=po.supplier_id WHERE po.company_id=$1 AND po.status!='cancelled' AND po.deleted_at IS NULL AND po.order_date>=DATE_TRUNC('month',CURRENT_DATE) GROUP BY v.vendor_name ORDER BY spend DESC LIMIT 5`, [companyId]) : Promise.resolve({ rows: [] }),
    ]);

    res.json({
      pending_prs:      parseInt(pendingPRs.rows[0].count),
      pending_pos:      parseInt(pendingPOs.rows[0].count),
      late_deliveries:  lateDeliveries.length,
      late_pos:         lateDeliveries,
      monthly_purchase: parseFloat(monthlyPurchase.rows[0].total),
      open_rfqs:        parseInt(openRFQs.rows[0].count),
      pending_grns:     parseInt(pendingGRNs.rows[0].count),
      ytd_spend:        parseFloat(ytdSpend.rows[0].total),
      top_vendors_spend: spendByVendor.rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Enhanced dashboard: spend trend (last 12 months) ─────────────────────────
router.get('/dashboard/spend-trend', async (req, res) => {
  try {
    const companyId = cid(req);
    const params = companyId ? [companyId] : [];
    const cidFilter = companyId ? 'AND company_id = $1' : '';
    const { rows } = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', order_date),'YYYY-MM') AS month,
             COALESCE(SUM(total_amount),0) AS spend,
             COUNT(*) AS po_count
      FROM purchase_orders
      WHERE order_date >= CURRENT_DATE - INTERVAL '12 months'
        AND status != 'cancelled' AND deleted_at IS NULL ${cidFilter}
      GROUP BY DATE_TRUNC('month', order_date)
      ORDER BY month ASC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Spend analytics: by vendor, category, department ─────────────────────────
router.get('/analytics/spend', async (req, res) => {
  try {
    const companyId = cid(req);
    const { from_date, to_date, group_by = 'vendor' } = req.query;
    const params = [];
    const conditions = ['po.deleted_at IS NULL', "po.status != 'cancelled'"];
    if (companyId) { params.push(companyId); conditions.push(`po.company_id = $${params.length}`); }
    if (from_date) { params.push(from_date); conditions.push(`po.order_date >= $${params.length}`); }
    if (to_date)   { params.push(to_date);   conditions.push(`po.order_date <= $${params.length}`); }

    let selectGroup, groupByClause;
    if (group_by === 'category') {
      selectGroup = `COALESCE(v.category, 'Uncategorised') AS label`;
      groupByClause = `v.category`;
    } else if (group_by === 'month') {
      selectGroup = `TO_CHAR(DATE_TRUNC('month', po.order_date),'YYYY-MM') AS label`;
      groupByClause = `DATE_TRUNC('month', po.order_date)`;
    } else {
      selectGroup = `COALESCE(v.vendor_name, 'Unknown') AS label`;
      groupByClause = `v.vendor_name`;
    }

    const { rows } = await pool.query(`
      SELECT ${selectGroup},
             ROUND(SUM(po.total_amount)::NUMERIC, 2) AS spend,
             COUNT(DISTINCT po.id)::INT              AS po_count
      FROM purchase_orders po
      LEFT JOIN vendors v ON v.id = po.supplier_id
      WHERE ${conditions.join(' AND ')}
      GROUP BY ${groupByClause}
      ORDER BY spend DESC
      LIMIT 20
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 3-Way Match: approve with proper bill creation ────────────────────────────
// Releases an invoice for payment once PO/GRN/invoice reconcile — a financial
// control, so it takes finance or procurement authority rather than any login.
router.patch('/three-way-match/:id/approve', allowRoles('super_admin','admin','finance','finance_manager','procurement_manager'), async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id ?? null;
    const companyId = cid(req);
    const { rows } = await pool.query(`
      UPDATE three_way_matches SET match_status='approved', approved_by=$1, approved_at=NOW()
      WHERE id=$2 RETURNING *
    `, [userId, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Match record not found' });

    // Bill creation. Procurement's `vendors` (integer PK) and Finance's `parties`
    // (uuid PK, what bills.supplier_id actually FKs) are separate, unbridged
    // masters — there is no linking column between them. The previous version
    // wrote po.supplier_id (a vendors.id integer) into bills.party_id, a dead
    // legacy integer column SupplierBills.jsx never reads, so these bills always
    // showed up with a blank vendor and couldn't be filtered by vendor at all.
    // Best-effort: resolve a real parties.id by name match so linked bills work
    // when the vendor is already a Finance party; always also store the vendor's
    // name on party_name so the bill is never blank even when no match is found.
    const { rows: poRows } = await pool.query(
      `SELECT v.id AS vendor_id, v.vendor_name
       FROM purchase_orders po JOIN vendors v ON v.id = po.supplier_id
       WHERE po.id = $1`,
      [rows[0].po_id]
    );
    const vendorName = poRows[0]?.vendor_name || null;
    const { rows: partyRows } = vendorName
      ? await pool.query(`SELECT id FROM parties WHERE LOWER(name) = LOWER($1) AND deleted_at IS NULL LIMIT 1`, [vendorName])
      : { rows: [] };
    const matchedPartyId = partyRows[0]?.id ?? null;

    const billRes = await pool.query(`
      INSERT INTO bills
        (supplier_id, party_name, bill_number, bill_date, total_amount, subtotal, status, notes, company_id, created_by)
      VALUES
        ($1, $2, $3, $4::date, $5::numeric, $5::numeric,
        'unpaid', 'Auto-created from 3-way match approval', $6, $7)
      ON CONFLICT (bill_number) DO NOTHING
      RETURNING id
    `, [
      matchedPartyId,
      vendorName,
      rows[0].vendor_invoice_no,
      rows[0].vendor_invoice_date,
      rows[0].vendor_invoice_amount,
      companyId,
      userId,
    ]);

    logAudit({
      userId, module: 'procurement', recordId: rows[0].id,
      recordType: 'three_way_match', action: 'approve',
      oldData: null, newData: rows[0], req,
    });

    res.json({ ...rows[0], bill_id: billRes.rows[0]?.id ?? null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 3-Way Match: resolve discrepancy ─────────────────────────────────────────
router.patch('/three-way-match/:id/resolve', async (req, res) => {
  try {
    const { discrepancy_reason } = req.body;
    const { rows } = await pool.query(
      `UPDATE three_way_matches SET match_status='matched', discrepancy_reason=$1 WHERE id=$2 RETURNING *`,
      [discrepancy_reason || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Match record not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =====================================================
// EOQ / INVENTORY COST PLANNING
// =====================================================
router.get('/analytics/eoq', async (req, res) => {
  try {
    const itemId = parseInt(req.query.item_id, 10);
    if (!Number.isFinite(itemId)) {
      return res.status(400).json({ error: 'item_id is required' });
    }

    const orderingCost = Number.isFinite(parseFloat(req.query.ordering_cost))
      ? parseFloat(req.query.ordering_cost)
      : DEFAULT_ORDERING_COST;
    const holdingRate = Number.isFinite(parseFloat(req.query.holding_rate))
      ? parseFloat(req.query.holding_rate)
      : DEFAULT_HOLDING_RATE;
    const leadTimeDays = Number.isFinite(parseInt(req.query.lead_time_days, 10))
      ? parseInt(req.query.lead_time_days, 10)
      : DEFAULT_LEAD_TIME_DAYS;

    const itemResult = await pool.query(
      `SELECT id, item_code, item_name, COALESCE(reorder_level, 0) AS reorder_level
       FROM inventory_items WHERE id = $1`,
      [itemId]
    );
    if (!itemResult.rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = itemResult.rows[0];

    // Annual demand from last 12 months consumption/outflow
    const demandResult = await pool.query(
      `SELECT COALESCE(SUM(quantity_out), 0) AS annual_demand
       FROM stock_ledger
       WHERE item_id = $1
         AND quantity_out > 0
         AND transaction_date >= CURRENT_DATE - INTERVAL '12 months'`,
      [itemId]
    );
    const annualDemand = parseFloat(demandResult.rows[0]?.annual_demand || 0);

    // Unit cost from recent purchase rates / fallback stock rate.
    const costResult = await pool.query(
      `SELECT COALESCE(AVG(x.rate), 0) AS unit_cost
       FROM (
         SELECT poi.rate
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.po_id
         WHERE poi.item_id = $1 AND poi.rate > 0
         ORDER BY po.order_date DESC
         LIMIT 20
       ) x`,
      [itemId]
    );
    let unitCost = parseFloat(costResult.rows[0]?.unit_cost || 0);
    if (unitCost <= 0) {
      const fallback = await pool.query(
        `SELECT COALESCE(AVG(rate), 0) AS unit_cost
         FROM stock_ledger
         WHERE item_id = $1 AND rate > 0`,
        [itemId]
      );
      unitCost = parseFloat(fallback.rows[0]?.unit_cost || 0);
    }

    const annualHoldingPerUnit = unitCost * holdingRate;
    const eoq = annualDemand > 0 && annualHoldingPerUnit > 0
      ? Math.sqrt((2 * annualDemand * orderingCost) / annualHoldingPerUnit)
      : 0;

    const orderingCostAnnual = eoq > 0 ? (annualDemand / eoq) * orderingCost : 0;
    const holdingCostAnnual = eoq > 0 ? (eoq / 2) * annualHoldingPerUnit : 0;
    const purchaseCostAnnual = annualDemand * unitCost;
    const totalAnnualInventoryCost = purchaseCostAnnual + orderingCostAnnual + holdingCostAnnual;

    const dailyDemand = annualDemand / 365;
    const reorderPoint = dailyDemand * leadTimeDays;
    const expectedDeliveryDate = new Date();
    expectedDeliveryDate.setDate(expectedDeliveryDate.getDate() + leadTimeDays);

    res.json({
      item_id: item.id,
      item_code: item.item_code,
      item_name: item.item_name,
      annual_demand: annualDemand,
      unit_cost: unitCost,
      ordering_cost: orderingCost,
      holding_cost_rate_annual: holdingRate,
      annual_holding_cost_per_unit: annualHoldingPerUnit,
      eoq: parseFloat(eoq.toFixed(2)),
      reorder_level_master: parseFloat(item.reorder_level || 0),
      reorder_point_calculated: parseFloat(reorderPoint.toFixed(2)),
      lead_time_days: leadTimeDays,
      expected_delivery_date: expectedDeliveryDate.toISOString().slice(0, 10),
      annual_cost_breakup: {
        purchase_cost: parseFloat(purchaseCostAnnual.toFixed(2)),
        ordering_cost: parseFloat(orderingCostAnnual.toFixed(2)),
        holding_cost: parseFloat(holdingCostAnnual.toFixed(2)),
      },
      total_annual_inventory_cost: parseFloat(totalAnnualInventoryCost.toFixed(2)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// PRICE HISTORY
// =====================================================

// Items autocomplete — supports ?q= for debounced search
router.get('/price-history/items', async (req, res) => {
  try {
    const q = req.query.q?.trim();
    const params = [];
    let idx = 1;
    let qFilter = '';
    if (q) {
      qFilter = `AND (ii.item_name ILIKE $${idx} OR COALESCE(ii.item_code,'') ILIKE $${idx})`;
      params.push(`%${q}%`);
      idx++;
    }
    const { rows } = await pool.query(`
      SELECT id, item_name, COALESCE(item_code,'') AS item_code, COALESCE(unit_of_measure,'') AS uom
      FROM inventory_items ii
      WHERE is_active = true ${qFilter}
      ORDER BY item_name
      LIMIT 80
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Time-series price trend for a given item
router.get('/price-history', async (req, res) => {
  try {
    const { item_id, vendor_id, from, to, limit = 200 } = req.query;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    const companyId = cid(req);
    const params = [parseInt(item_id)];
    let idx = 2;
    let cidFilter = '';
    let vendorFilter = '';
    let dateFilter = '';

    if (companyId) { cidFilter = ` AND po.company_id = $${idx++}`; params.push(companyId); }
    if (vendor_id) { vendorFilter = ` AND combined.vendor_id = $${idx++}`; params.push(parseInt(vendor_id)); }
    if (from)      { dateFilter  += ` AND combined.price_date >= $${idx++}`; params.push(from); }
    if (to)        { dateFilter  += ` AND combined.price_date <= $${idx++}`; params.push(to); }
    params.push(parseInt(limit));

    const { rows } = await pool.query(`
      SELECT
        combined.price_date,
        combined.unit_price,
        combined.quantity,
        combined.vendor_id,
        COALESCE(v.vendor_name, combined.vendor_name_text, 'Unknown') AS vendor_name,
        combined.reference_type,
        combined.reference_number,
        combined.notes,
        combined.source
      FROM (
        SELECT
          po.order_date        AS price_date,
          poi.rate             AS unit_price,
          poi.quantity         AS quantity,
          po.supplier_id       AS vendor_id,
          NULL::VARCHAR        AS vendor_name_text,
          'PO'                 AS reference_type,
          po.po_number         AS reference_number,
          NULL::TEXT           AS notes,
          'purchase_order'     AS source
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.po_id
        WHERE poi.item_id = $1 AND poi.rate > 0 AND po.order_date IS NOT NULL ${cidFilter}

        UNION ALL

        SELECT
          price_date,
          unit_price,
          quantity,
          vendor_id,
          vendor_name_text,
          reference_type,
          reference_number,
          notes,
          'manual'             AS source
        FROM price_history
        WHERE item_id = $1
      ) combined
      LEFT JOIN vendors v ON v.id = combined.vendor_id
      WHERE 1=1 ${vendorFilter} ${dateFilter}
      ORDER BY combined.price_date DESC
      LIMIT $${idx}
    `, params).catch(() => ({ rows: [] }));

    // Summary stats
    const prices = rows.map(r => parseFloat(r.unit_price)).filter(Boolean);
    const stats = prices.length === 0 ? {} : {
      current_price: prices[0],
      min_price:     Math.min(...prices),
      max_price:     Math.max(...prices),
      avg_price:     parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)),
      price_change_pct: prices.length >= 2
        ? parseFloat((((prices[0] - prices[prices.length - 1]) / prices[prices.length - 1]) * 100).toFixed(1))
        : 0,
      data_points: prices.length,
    };

    res.json({ history: rows, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Vendor comparison for an item
router.get('/price-history/compare', async (req, res) => {
  try {
    const { item_id } = req.query;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    const { rows } = await pool.query(`
      SELECT
        combined.vendor_id,
        COALESCE(v.vendor_name, combined.vendor_name_text, 'Unknown') AS vendor_name,
        COUNT(*)::INT                                                  AS quote_count,
        ROUND(MIN(combined.unit_price)::NUMERIC, 2)                   AS min_price,
        ROUND(MAX(combined.unit_price)::NUMERIC, 2)                   AS max_price,
        ROUND(AVG(combined.unit_price)::NUMERIC, 2)                   AS avg_price,
        ROUND(( SELECT unit_price FROM (
          SELECT unit_price, price_date FROM (
            SELECT poi.rate AS unit_price, po.order_date AS price_date
            FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id
            WHERE poi.item_id = $1 AND po.supplier_id = combined.vendor_id AND poi.rate > 0
            UNION ALL
            SELECT unit_price, price_date FROM price_history
            WHERE item_id = $1 AND vendor_id = combined.vendor_id
          ) sub ORDER BY price_date DESC LIMIT 1
        ) lp )::NUMERIC, 2) AS last_price,
        MAX(combined.price_date) AS last_quoted
      FROM (
        SELECT po.supplier_id AS vendor_id, NULL::VARCHAR AS vendor_name_text,
               poi.rate AS unit_price, po.order_date AS price_date
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.po_id
        WHERE poi.item_id = $1 AND poi.rate > 0

        UNION ALL

        SELECT vendor_id, vendor_name_text, unit_price, price_date
        FROM price_history WHERE item_id = $1
      ) combined
      LEFT JOIN vendors v ON v.id = combined.vendor_id
      GROUP BY combined.vendor_id, v.vendor_name, combined.vendor_name_text
      ORDER BY avg_price ASC
    `, [parseInt(item_id)]).catch(() => ({ rows: [] }));

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Item-based vendor comparison — returns all vendors who quoted for an item, cheapest first
router.get('/vendor-comparison', async (req, res) => {
  try {
    const companyId = cid(req);
    const { item_name } = req.query;
    if (!item_name) return res.status(400).json({ error: 'item_name is required' });

    const { rows: priceRows } = await pool.query(`
      SELECT
        COALESCE(v.vendor_name, combined.vendor_name_text, 'Unknown') AS vendor_name,
        combined.vendor_id,
        combined.unit_price,
        combined.price_date
      FROM (
        SELECT po.supplier_id AS vendor_id, NULL::VARCHAR AS vendor_name_text,
               poi.rate AS unit_price, po.order_date AS price_date
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.po_id
        JOIN inventory_items ii ON ii.id = poi.item_id
        WHERE poi.rate > 0
          AND ii.item_name ILIKE $1
          AND ($2::INTEGER IS NULL OR po.company_id = $2)

        UNION ALL

        SELECT ph.vendor_id, ph.vendor_name_text, ph.unit_price, ph.price_date
        FROM price_history ph
        JOIN inventory_items ii ON ii.id = ph.item_id
        WHERE ph.unit_price > 0
          AND ii.item_name ILIKE $1
      ) combined
      LEFT JOIN vendors v ON v.id = combined.vendor_id
      WHERE combined.unit_price IS NOT NULL
      ORDER BY vendor_name, combined.price_date DESC
    `, [`%${item_name}%`, companyId || null]);

    // Group by vendor
    const vendorMap = {};
    priceRows.forEach(r => {
      const key = r.vendor_id != null ? String(r.vendor_id) : r.vendor_name;
      if (!vendorMap[key]) vendorMap[key] = { vendor_id: r.vendor_id, vendor_name: r.vendor_name, prices: [] };
      vendorMap[key].prices.push({ price: parseFloat(r.unit_price), date: r.price_date });
    });

    // Fetch ratings + last payment terms for vendor IDs
    const vendorIds = Object.values(vendorMap).map(v => v.vendor_id).filter(Boolean);
    const detailMap = {};
    if (vendorIds.length > 0) {
      const ph = vendorIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows: vRows } = await pool.query(`
        SELECT v.id, v.quality_rating, v.delivery_rating, v.price_rating,
          (SELECT payment_terms FROM rfq_quotes
           WHERE vendor_id = v.id AND payment_terms IS NOT NULL
           ORDER BY created_at DESC LIMIT 1) AS payment_terms
        FROM vendors v WHERE v.id IN (${ph})
      `, vendorIds).catch(() => ({ rows: [] }));
      vRows.forEach(r => { detailMap[r.id] = r; });
    }

    const result = Object.values(vendorMap).map(v => {
      const sorted = [...v.prices].sort((a, b) => new Date(b.date) - new Date(a.date));
      const last = sorted[0];
      const prev = sorted[1];
      const det = detailMap[v.vendor_id] || {};
      const q = parseFloat(det.quality_rating || 0);
      const d = parseFloat(det.delivery_rating || 0);
      const p = parseFloat(det.price_rating || 0);
      const rating = (q || d || p) ? parseFloat(((q + d + p) / 3).toFixed(1)) : null;
      return {
        vendor_id:     v.vendor_id,
        vendor_name:   v.vendor_name,
        last_price:    last?.price ?? null,
        last_date:     last?.date  ?? null,
        prev_price:    prev?.price ?? null,
        rating,
        payment_terms: det.payment_terms || null,
      };
    }).sort((a, b) => (a.last_price ?? Infinity) - (b.last_price ?? Infinity));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual price entry
router.post('/price-history', async (req, res) => {
  try {
    const { item_id, item_name_text, vendor_id, vendor_name_text, unit_price, quantity, price_type, reference_type, reference_number, notes, price_date } = req.body;
    if (!item_id || !unit_price) return res.status(400).json({ error: 'item_id and unit_price are required' });
    const { rows } = await pool.query(
      `INSERT INTO price_history (item_id, item_name_text, vendor_id, vendor_name_text, unit_price, quantity, price_type, reference_type, reference_number, notes, price_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [item_id, item_name_text||null, vendor_id||null, vendor_name_text||null, unit_price, quantity||null, price_type||'purchase', reference_type||null, reference_number||null, notes||null, price_date||new Date().toISOString().slice(0,10), req.user?.userId ?? req.user?.id ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================
// PROCUREMENT SETTINGS
// =====================================================
const PROC_DEFAULTS = {
  default_payment_terms_days:  30,
  auto_approve_below:          5000,
  grn_qty_tolerance_pct:       5,
  min_vendor_rating:           3,
  l1_approval_limit:           25000,
  l2_approval_limit:           100000,
  cfo_approval_above:          500000,
  enforce_3way_match:          false,
  block_payment_on_mismatch:   false,
  allowable_price_variance_pct:3,
  pr_prefix:                   'PR',
  po_prefix:                   'PO',
  grn_prefix:                  'GRN',
  rfq_prefix:                  'RFQ',
  notify_po_approval:          false,
  notify_grn_receipt:          false,
  alert_vendor_rating_drop:    false,
  alert_overdue_delivery:      false,
};

router.get('/settings', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT * FROM procurement_settings WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    const data = rows[0] ? { ...PROC_DEFAULTS, ...rows[0] } : PROC_DEFAULTS;
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings', async (req, res) => {
  try {
    // This endpoint sets l1/l2/cfo approval limits, so it is the control that
    // governs every other control in this module — lower the thresholds and any
    // amount becomes self-approvable. hasRole unions all roles held; the old
    // `req.user.role !== 'admin'` check saw only the primary role.
    if (!hasRole(req, 'admin', 'super_admin')) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const companyId = cid(req);
    const b = req.body;
    await pool.query(
      `INSERT INTO procurement_settings (
         company_id,
         default_payment_terms_days, auto_approve_below, grn_qty_tolerance_pct, min_vendor_rating,
         l1_approval_limit, l2_approval_limit, cfo_approval_above,
         enforce_3way_match, block_payment_on_mismatch, allowable_price_variance_pct,
         pr_prefix, po_prefix, grn_prefix, rfq_prefix,
         notify_po_approval, notify_grn_receipt, alert_vendor_rating_drop, alert_overdue_delivery,
         updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
       ON CONFLICT (company_id) DO UPDATE SET
         default_payment_terms_days  = EXCLUDED.default_payment_terms_days,
         auto_approve_below          = EXCLUDED.auto_approve_below,
         grn_qty_tolerance_pct       = EXCLUDED.grn_qty_tolerance_pct,
         min_vendor_rating           = EXCLUDED.min_vendor_rating,
         l1_approval_limit           = EXCLUDED.l1_approval_limit,
         l2_approval_limit           = EXCLUDED.l2_approval_limit,
         cfo_approval_above          = EXCLUDED.cfo_approval_above,
         enforce_3way_match          = EXCLUDED.enforce_3way_match,
         block_payment_on_mismatch   = EXCLUDED.block_payment_on_mismatch,
         allowable_price_variance_pct= EXCLUDED.allowable_price_variance_pct,
         pr_prefix                   = EXCLUDED.pr_prefix,
         po_prefix                   = EXCLUDED.po_prefix,
         grn_prefix                  = EXCLUDED.grn_prefix,
         rfq_prefix                  = EXCLUDED.rfq_prefix,
         notify_po_approval          = EXCLUDED.notify_po_approval,
         notify_grn_receipt          = EXCLUDED.notify_grn_receipt,
         alert_vendor_rating_drop    = EXCLUDED.alert_vendor_rating_drop,
         alert_overdue_delivery      = EXCLUDED.alert_overdue_delivery,
         updated_at                  = NOW()`,
      [
        companyId,
        b.default_payment_terms_days ?? 30,
        b.auto_approve_below          ?? 5000,
        b.grn_qty_tolerance_pct       ?? 5,
        b.min_vendor_rating           ?? 3,
        b.l1_approval_limit           ?? 25000,
        b.l2_approval_limit           ?? 100000,
        b.cfo_approval_above          ?? 500000,
        b.enforce_3way_match          ?? false,
        b.block_payment_on_mismatch   ?? false,
        b.allowable_price_variance_pct?? 3,
        b.pr_prefix                   ?? 'PR',
        b.po_prefix                   ?? 'PO',
        b.grn_prefix                  ?? 'GRN',
        b.rfq_prefix                  ?? 'RFQ',
        b.notify_po_approval          ?? false,
        b.notify_grn_receipt          ?? false,
        b.alert_vendor_rating_drop    ?? false,
        b.alert_overdue_delivery      ?? false,
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PR EXPORT — already registered above before /:id route

// =====================================================
// GRN EXPORT
// =====================================================
router.get('/grn/export', async (req, res) => {
  try {
    const companyId = cid(req);
    const { from_date, to_date, vendor_id } = req.query;
    const params = [];
    const conditions = ['grn.deleted_at IS NULL'];
    if (companyId) { params.push(companyId); conditions.push(`grn.company_id = $${params.length}`); }
    if (from_date) { params.push(from_date); conditions.push(`grn.received_date >= $${params.length}`); }
    if (to_date)   { params.push(to_date);   conditions.push(`grn.received_date <= $${params.length}`); }
    if (vendor_id) { params.push(vendor_id); conditions.push(`po.supplier_id = $${params.length}`); }

    const { rows } = await pool.query(`
      SELECT grn.grn_number, grn.received_date, po.po_number,
             COALESCE(v.vendor_name,'') AS vendor_name,
             COALESCE(w.warehouse_name,'') AS warehouse,
             (SELECT COUNT(*) FROM grn_items WHERE grn_id=grn.id)::INT AS items_count,
             (SELECT SUM(quantity_received) FROM grn_items WHERE grn_id=grn.id) AS total_qty,
             (SELECT SUM(quantity_rejected) FROM grn_items WHERE grn_id=grn.id) AS rejected_qty,
             grn.notes
      FROM goods_receipt_notes grn
      JOIN purchase_orders po ON po.id = grn.po_id
      LEFT JOIN vendors v ON v.id = po.supplier_id
      LEFT JOIN warehouses w ON w.id = grn.warehouse_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY grn.received_date DESC
    `, params);

    const header = 'GRN No,Date,PO No,Vendor,Warehouse,Items,Received Qty,Rejected Qty,Notes';
    const csvRows = rows.map(r => [
      r.grn_number||'', r.received_date||'', r.po_number||'', r.vendor_name||'',
      r.warehouse||'', r.items_count||0, r.total_qty||0, r.rejected_qty||0, r.notes||'',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="grn-${Date.now()}.csv"`);
    res.send([header, ...csvRows].join('\n'));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// =====================================================
// RETURN TO VENDOR (RTV)
// =====================================================
router.post('/rtv', async (req, res) => {
  try {
    const grn = await grnService.createRTV(
      { ...req.body, company_id: cid(req) },
      req.user?.userId ?? req.user?.id
    );
    res.status(201).json(grn);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/rtv', async (req, res) => {
  try {
    const companyId = cid(req);
    const params = [];
    const conditions = ['rtv.deleted_at IS NULL'];
    if (companyId) { params.push(companyId); conditions.push(`rtv.company_id = $${params.length}`); }
    const { rows } = await pool.query(`
      SELECT rtv.*, v.vendor_name, grn.grn_number
      FROM return_to_vendor rtv
      LEFT JOIN vendors v ON v.id = rtv.vendor_id
      LEFT JOIN goods_receipt_notes grn ON grn.id = rtv.grn_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY rtv.return_date DESC
    `, params);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/rtv/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT rtv.*, v.vendor_name FROM return_to_vendor rtv LEFT JOIN vendors v ON v.id=rtv.vendor_id WHERE rtv.id=$1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'RTV not found' });
    const { rows: items } = await pool.query(
      `SELECT ri.*, ii.item_name, ii.item_code FROM rtv_items ri LEFT JOIN inventory_items ii ON ii.id=ri.item_id WHERE ri.rtv_id=$1`,
      [req.params.id]
    );
    res.json({ ...rows[0], items });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// =====================================================
// APPROVED VENDOR LIST (AVL)
// =====================================================
router.get('/avl', async (req, res) => {
  try {
    const companyId = cid(req);
    const { item_id, vendor_id, status } = req.query;
    const params = [];
    const conditions = [];
    if (companyId) { params.push(companyId); conditions.push(`avl.company_id = $${params.length}`); }
    if (item_id)   { params.push(item_id);   conditions.push(`avl.item_id = $${params.length}`); }
    if (vendor_id) { params.push(vendor_id); conditions.push(`avl.vendor_id = $${params.length}`); }
    if (status)    { params.push(status);    conditions.push(`avl.status = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT avl.*, v.vendor_name, ii.item_name, ii.item_code
      FROM approved_vendor_list avl
      LEFT JOIN vendors v ON v.id = avl.vendor_id
      LEFT JOIN inventory_items ii ON ii.id = avl.item_id
      ${where}
      ORDER BY ii.item_name, v.vendor_name
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/avl', async (req, res) => {
  try {
    const { item_id, vendor_id, approved_by_name, valid_from, valid_to, notes, lead_time_days, min_order_qty } = req.body;
    if (!item_id || !vendor_id) return res.status(400).json({ error: 'item_id and vendor_id are required' });
    const { rows } = await pool.query(`
      INSERT INTO approved_vendor_list (company_id, item_id, vendor_id, status, approved_by_name, approved_date, valid_from, valid_to, notes, lead_time_days, min_order_qty)
      VALUES ($1,$2,$3,'approved',$4,CURRENT_DATE,$5,$6,$7,$8,$9)
      ON CONFLICT (company_id, item_id, vendor_id) DO UPDATE SET
        status=EXCLUDED.status, approved_by_name=EXCLUDED.approved_by_name,
        valid_from=EXCLUDED.valid_from, valid_to=EXCLUDED.valid_to,
        notes=EXCLUDED.notes, lead_time_days=EXCLUDED.lead_time_days,
        min_order_qty=EXCLUDED.min_order_qty, updated_at=NOW()
      RETURNING *
    `, [cid(req), item_id, vendor_id, approved_by_name||null, valid_from||null, valid_to||null, notes||null, lead_time_days||null, min_order_qty||null]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/avl/:id/block', async (req, res) => {
  try {
    const { reason } = req.body;
    const { rows } = await pool.query(
      `UPDATE approved_vendor_list SET status='blocked', notes=COALESCE($1,notes), updated_at=NOW() WHERE id=$2 RETURNING *`,
      [reason||null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'AVL entry not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Removing an approved-vendor-list entry changes who may be bought from at all.
router.delete('/avl/:id', allowRoles('super_admin','admin','procurement_manager','qc_manager'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM approved_vendor_list WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =====================================================
// QUALITY INSPECTION (INCOMING)
// =====================================================
router.get('/quality-inspections', async (req, res) => {
  try {
    const companyId = cid(req);
    const { grn_id, status } = req.query;
    const params = [];
    const conditions = [];
    if (companyId) { params.push(companyId); conditions.push(`qi.company_id = $${params.length}`); }
    if (grn_id)    { params.push(grn_id);    conditions.push(`qi.grn_id = $${params.length}`); }
    if (status)    { params.push(status);    conditions.push(`qi.status = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT qi.*, grn.grn_number, COALESCE(e.first_name||' '||e.last_name,'') AS inspector_name
      FROM quality_inspections qi
      LEFT JOIN goods_receipt_notes grn ON grn.id = qi.grn_id
      LEFT JOIN employees e ON e.id = qi.inspector_id
      ${where}
      ORDER BY qi.inspection_date DESC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/quality-inspections', async (req, res) => {
  try {
    const { grn_id, inspector_id, inspection_date, overall_result, notes, items } = req.body;
    if (!grn_id) return res.status(400).json({ error: 'grn_id is required' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [qi] } = await client.query(`
        INSERT INTO quality_inspections (company_id, grn_id, inspector_id, inspection_date, overall_result, notes, status)
        VALUES ($1,$2,$3,$4,$5,$6,'completed') RETURNING *
      `, [cid(req), grn_id, inspector_id||null, inspection_date||new Date().toISOString().slice(0,10), overall_result||'pass', notes||null]);

      for (const item of (items||[])) {
        await client.query(`
          INSERT INTO quality_inspection_items (inspection_id, item_id, parameter, expected_value, actual_value, result, remarks)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [qi.id, item.item_id, item.parameter||null, item.expected_value||null, item.actual_value||null, item.result||'pass', item.remarks||null]);
      }

      await client.query('COMMIT');
      res.status(201).json(qi);
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── NCR (Non-Conformance Report) ─────────────────────────────────────────────
router.get('/ncr', async (req, res) => {
  try {
    const companyId = cid(req);
    const params = companyId ? [companyId] : [];
    const where = companyId ? 'WHERE ncr.company_id=$1' : '';
    const { rows } = await pool.query(`
      SELECT ncr.*, v.vendor_name, grn.grn_number
      FROM non_conformance_reports ncr
      LEFT JOIN vendors v ON v.id=ncr.vendor_id
      LEFT JOIN goods_receipt_notes grn ON grn.id=ncr.grn_id
      ${where}
      ORDER BY ncr.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/ncr', async (req, res) => {
  try {
    const { grn_id, vendor_id, defect_description, quantity_affected, severity, disposition } = req.body;
    const ncrNumber = `NCR-${Date.now()}`;
    const { rows } = await pool.query(`
      INSERT INTO non_conformance_reports (ncr_number, company_id, grn_id, vendor_id, defect_description, quantity_affected, severity, disposition, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open') RETURNING *
    `, [ncrNumber, cid(req), grn_id||null, vendor_id||null, defect_description, quantity_affected||1, severity||'minor', disposition||'return']);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Closing a non-conformance report is a quality sign-off, not a clerical edit.
router.patch('/ncr/:id/close', allowRoles('super_admin','admin','qc_manager','procurement_manager'), async (req, res) => {
  try {
    const { capa_action, capa_due_date } = req.body;
    const { rows } = await pool.query(`
      UPDATE non_conformance_reports SET status='closed', capa_action=$1, capa_due_date=$2, closed_at=NOW() WHERE id=$3 RETURNING *
    `, [capa_action||null, capa_due_date||null, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'NCR not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/ncr/:id/attachment', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const file_url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    const { rows: [ncr] } = await pool.query(
      `UPDATE non_conformance_reports SET attachment_url=$1 WHERE id=$2 RETURNING id, attachment_url`,
      [file_url, req.params.id]
    );
    if (!ncr) return res.status(404).json({ error: 'NCR not found' });
    res.json(ncr);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;

