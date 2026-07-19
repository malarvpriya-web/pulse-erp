import express from 'express';
const router = express.Router();
import { verifyToken, requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../../services/WorkflowNotificationService.js';
import quotationsRepository from '../repositories/quotations.repository.js';
import salesOrdersRepository from '../repositories/salesOrders.repository.js';
import salesTargetsRepository from '../repositories/salesTargets.repository.js';
import pool from '../../../config/db.js';
import { nextLifecycleNumber } from '../../../shared/docNumber.js';
import * as drive from '../../../services/googleDrive.service.js';
import { calculateCommission } from '../../../services/commissionService.js';
import { companyOf } from '../../../shared/scope.js';

async function autoBootstrapLifecycleOnOrderAccept(salesOrderId, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const soRes = await client.query(
      `SELECT * FROM sales_orders WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [salesOrderId]
    );
    if (!soRes.rows.length) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'sales_order_not_found' };
    }
    const so = soRes.rows[0];
    const status = String(so.order_status || '').toLowerCase();
    const eligible = ['accepted', 'confirmed', 'won', 'approved', 'released'].includes(status);
    if (!eligible) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'status_not_eligible', status: so.order_status };
    }

    const existing = await client.query(
      `SELECT id FROM lifecycle_instances WHERE sales_order_id=$1 AND status IN ('active','on_hold') LIMIT 1`,
      [salesOrderId]
    );
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'already_exists', lifecycle_id: existing.rows[0].id };
    }

    const lifecycleNo = await nextLifecycleNumber(client);
    const actorId = user?.userId || user?.id || null;
    const actorName = user?.name || user?.email || 'System';
    const ins = await client.query(
      `INSERT INTO lifecycle_instances
        (lifecycle_number, sales_order_id, customer_id, current_stage, status, stage_notes, created_by, created_by_name)
       VALUES ($1,$2,$3,'order','active',$4,$5,$6)
       RETURNING id`,
      [lifecycleNo, salesOrderId, so.customer_id || null, 'Auto-bootstrapped on sales order acceptance', actorId, actorName]
    );
    await client.query(
      `INSERT INTO lifecycle_stage_history
        (lifecycle_instance_id, from_stage, to_stage, action, remarks, actor_id, actor_name, gate_snapshot)
       VALUES ($1,NULL,'order','advance',$2,$3,$4,'{}')`,
      [ins.rows[0].id, 'Auto lifecycle started from sales order status change', actorId, actorName]
    );
    const lifecycleId = ins.rows[0].id;

    // Auto-create a Project linked to this sales order + lifecycle
    let projectId = null;
    try {
      const yr  = new Date().getFullYear();
      const seqR = await client.query(
        `SELECT COUNT(*)::int AS n FROM projects WHERE ($1::int IS NULL OR company_id=$1)`,
        [so.company_id]
      );
      const seq  = String((seqR.rows[0]?.n || 0) + 1).padStart(4, '0');
      const code = `PRJ-${yr}-${seq}`;
      // Carry the pursuit (IPM) forward: opportunity -> quotation -> this SO.
      // Lets the Delivery Tracker show the IPM<->IPP link with no manual step.
      let oppId = null;
      if (so.quotation_id) {
        const oppR = await client.query(
          `SELECT opportunity_id FROM quotations WHERE id=$1`, [so.quotation_id]
        );
        oppId = oppR.rows[0]?.opportunity_id || null;
      }
      const projRes = await client.query(
        `INSERT INTO projects
           (project_code, project_name, company_id, customer_name,
            sales_order_ref, opportunity_id, status, start_date, project_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'planning',CURRENT_DATE,'EPC',$7)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [code,
         `Project for ${so.customer_name || 'Customer'} — ${so.order_number}`,
         so.company_id, so.customer_name || null,
         so.order_number || so.id.toString(), oppId, actorId]
      );
      projectId = projRes.rows[0]?.id || null;
      if (projectId) {
        await client.query(
          `UPDATE lifecycle_instances SET project_id=$1, updated_at=NOW() WHERE id=$2`,
          [projectId, lifecycleId]
        );
      }
    } catch (projErr) {
      console.error('[autoBootstrap] project creation failed (non-fatal):', projErr.message);
    }

    await client.query('COMMIT');
    return { skipped: false, lifecycle_id: lifecycleId, project_id: projectId };
  } catch (e) {
    await client.query('ROLLBACK');
    return { skipped: true, reason: 'error', error: e.message };
  } finally {
    client.release();
  }
}


router.use(verifyToken);

// ── Quotations ────────────────────────────────────────────────────────────────

router.get('/quotations', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const quotations = await quotationsRepository.findAll({
      ...req.query,
      company_id: companyOf(req),
    });
    res.json(quotations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Static sub-routes MUST come before /:id
router.get('/quotations/next-number', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const number = await quotationsRepository.getNextQuotationNumber();
    res.json({ number });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/quotations/stats', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const r = await pool.query(`
      SELECT
        COUNT(*)::int                                                                      AS total,
        COUNT(*) FILTER (WHERE status = 'accepted')::int                                  AS accepted,
        COUNT(*) FILTER (WHERE status IN ('sent','draft'))::int                            AS sent_pending,
        COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('rejected','expired')), 0) AS total_value,
        ROUND(
          COUNT(*) FILTER (WHERE status = 'accepted')::numeric
          / NULLIF(COUNT(*), 0) * 100, 1
        )                                                                                  AS acceptance_rate
      FROM quotations
      WHERE deleted_at IS NULL
        AND ($1::int IS NULL OR company_id = $1)
    `, [companyId]);
    res.json({ data: r.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/quotations/:id', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const quotation = await quotationsRepository.findById(req.params.id);
    if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
    res.json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/quotations', requirePermission('sales', 'add'), async (req, res) => {
  try {
    const userId    = req.user?.userId ?? req.user?.id;
    const companyId = companyOf(req);
    const quotation_number = req.body.quotation_number
      || await quotationsRepository.getNextQuotationNumber();
    const quotation = await quotationsRepository.create({
      ...req.body,
      quotation_number,
      company_id: companyId,
      created_by: userId,
    });
    logAudit({ userId, module: 'sales', recordId: quotation.id, recordType: 'quotation', action: 'create', newData: quotation, req });
    res.status(201).json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/quotations/:id', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const quotation = await quotationsRepository.update(req.params.id, req.body);
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: req.params.id, recordType: 'quotation', action: 'update', newData: quotation, req });
    res.json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/quotations/:id', requirePermission('sales', 'delete'), async (req, res) => {
  try {
    await quotationsRepository.delete(req.params.id);
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: req.params.id, recordType: 'quotation', action: 'delete', req });
    res.json({ message: 'Quotation deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/quotations/:id/items', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const items = await quotationsRepository.getItems(req.params.id);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/quotations/:id/items', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const item = await quotationsRepository.addItem({ ...req.body, quotation_id: req.params.id });
    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Status transitions
router.patch('/quotations/:id/send', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const quotation = await quotationsRepository.update(req.params.id, { status: 'sent' });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: req.params.id, recordType: 'quotation', action: 'update', newData: { status: 'sent' }, req });

    // Auto-upload quotation record to Drive under customer folder
    if (drive.isDriveConfigured() && quotation?.customer_name) {
      const qNo = quotation.quotation_number || `QT-${quotation.id}`;
      drive.uploadJsonRecord({
        data:         quotation,
        fileName:     `${qNo}-Quotation.json`,
        customerName: quotation.customer_name,
        docType:      drive.DOC_TYPES.QUOTATION,
        companyId:    companyOf(req),
      }).then(driveRes =>
        pool.query(
          `UPDATE quotations SET drive_file_id=$1, drive_link=$2, drive_folder_id=$3, updated_at=NOW() WHERE id=$4`,
          [driveRes.drive_file_id, driveRes.drive_link, driveRes.drive_folder_id, quotation.id]
        )
      ).catch(e => console.error('[quotation/send/drive]', e.message));
    }

    res.json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/quotations/:id/accept', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const quotation = await quotationsRepository.update(req.params.id, { status: 'accepted' });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: req.params.id, recordType: 'quotation', action: 'update', newData: { status: 'accepted' }, req });
    res.json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/quotations/:id/reject', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const quotation = await quotationsRepository.update(req.params.id, { status: 'rejected' });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: req.params.id, recordType: 'quotation', action: 'update', newData: { status: 'rejected' }, req });
    res.json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/quotations/:id/convert-to-order', requirePermission('sales', 'add'), async (req, res) => {
  try {
    const quotation = await quotationsRepository.findById(req.params.id);
    if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
    const userId    = req.user?.userId ?? req.user?.id;
    const companyId = companyOf(req);
    const items     = await quotationsRepository.getItems(req.params.id);
    const orderNumber = await salesOrdersRepository.getNextOrderNumber();
    const order = await salesOrdersRepository.create({
      order_number:  orderNumber,
      company_id:    companyId,
      customer_id:   quotation.customer_id,
      customer_name: quotation.customer_name,
      quotation_id:  quotation.id,
      order_date:    new Date().toISOString().split('T')[0],
      subtotal:      quotation.subtotal,
      tax_amount:    quotation.tax_amount,
      total_amount:  quotation.total_amount,
      notes:         quotation.notes,
      order_status:  'confirmed',
      created_by:    userId,
    });
    for (const it of items) {
      await salesOrdersRepository.addItem({
        order_id:         order.id,
        item_description: it.item_description || it.description,
        quantity:         it.quantity,
        rate:             it.rate || it.unit_price || 0,
        tax_percentage:   it.tax_percentage || 0,
        tax_amount:       it.tax_amount || 0,
        total:            it.total || it.amount || 0,
      });
    }
    await quotationsRepository.update(req.params.id, { status: 'converted' });
    logAudit({ userId, module: 'sales', recordId: req.params.id, recordType: 'quotation', action: 'update', newData: { status: 'converted' }, req });
    res.status(201).json({ quotation_id: quotation.id, order_id: order.id, order_number: order.order_number || orderNumber });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Atomic accept + convert — avoids the two-step race condition in the frontend
router.patch('/quotations/:id/accept-and-convert', requirePermission('sales', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId    = req.user?.userId ?? req.user?.id;
    const companyId = companyOf(req);

    const qRes = await client.query(
      `SELECT * FROM quotations WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, companyId]
    );
    if (!qRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Quotation not found' }); }
    const quotation = qRes.rows[0];
    if (quotation.status === 'converted') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Quotation is already converted to a Sales Order' }); }

    const items = await quotationsRepository.getItems(req.params.id);
    const orderNumber = await salesOrdersRepository.getNextOrderNumber();
    const order = await salesOrdersRepository.create({
      order_number:  orderNumber,
      company_id:    companyId,
      customer_id:   quotation.customer_id,
      customer_name: quotation.customer_name,
      quotation_id:  quotation.id,
      order_date:    new Date().toISOString().split('T')[0],
      subtotal:      quotation.subtotal,
      tax_amount:    quotation.tax_amount,
      total_amount:  quotation.total_amount,
      notes:         quotation.notes,
      order_status:  'confirmed',
      created_by:    userId,
    });
    for (const it of items) {
      await salesOrdersRepository.addItem({
        order_id:         order.id,
        item_description: it.item_description || it.description,
        quantity:         it.quantity,
        rate:             it.rate || it.unit_price || 0,
        tax_percentage:   it.tax_percentage || 0,
        tax_amount:       it.tax_amount || 0,
        total:            it.total || it.amount || 0,
      });
    }
    await client.query(
      `UPDATE quotations SET status = 'converted', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    await client.query('COMMIT');
    logAudit({ userId, module: 'sales', recordId: req.params.id, recordType: 'quotation', action: 'update', newData: { status: 'converted' }, req });
    res.status(201).json({ quotation_id: quotation.id, order_id: order.id, order_number: order.order_number || orderNumber });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Revision routes
router.get('/quotations/:id/revisions', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const revisions = await quotationsRepository.getRevisions(req.params.id);
    res.json(revisions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/quotations/:id/revise', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const newRevision = await quotationsRepository.createRevision(req.params.id, req.user?.userId ?? req.user?.id);
    res.status(201).json(newRevision);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sales Orders
router.get('/orders', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const orders = await salesOrdersRepository.findAll({
      ...req.query,
      company_id: companyOf(req),
    });
    res.json({ data: orders });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/next-number', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const number = await salesOrdersRepository.getNextOrderNumber();
    res.json({ number });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/stats', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int                                                           AS total,
         COALESCE(SUM(total_amount), 0)::numeric                                AS total_value,
         COUNT(*) FILTER (WHERE order_status = 'draft')::int                   AS draft,
         COUNT(*) FILTER (WHERE order_status = 'confirmed')::int               AS confirmed,
         COUNT(*) FILTER (WHERE order_status = 'pending')::int                 AS pending,
         COUNT(*) FILTER (WHERE order_status = 'dispatched')::int              AS dispatched,
         COUNT(*) FILTER (WHERE order_status = 'delivered')::int               AS delivered,
         COUNT(*) FILTER (WHERE order_status = 'invoiced')::int                AS invoiced,
         COUNT(*) FILTER (WHERE order_status = 'cancelled')::int               AS cancelled
       FROM sales_orders
       WHERE deleted_at IS NULL
         AND ($1::int IS NULL OR company_id = $1)`,
      [cid ?? null]
    );
    const r = rows[0];
    res.json({
      data: {
        total:       parseInt(r.total)       || 0,
        total_value: parseFloat(r.total_value) || 0,
        by_status: {
          draft:      parseInt(r.draft)      || 0,
          confirmed:  parseInt(r.confirmed)  || 0,
          pending:    parseInt(r.pending)    || 0,
          dispatched: parseInt(r.dispatched) || 0,
          delivered:  parseInt(r.delivered)  || 0,
          invoiced:   parseInt(r.invoiced)   || 0,
          cancelled:  parseInt(r.cancelled)  || 0,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/customer-summary', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT
         p.id,
         p.name   AS customer_name,
         p.city,
         COUNT(so.id)::int                                                             AS total_orders,
         COALESCE(SUM(so.total_amount), 0)::numeric                                   AS total_value,
         COALESCE(SUM(so.tax_amount),   0)::numeric                                   AS total_gst,
         COUNT(so.id) FILTER (WHERE so.order_status NOT IN ('cancelled','draft'))::int AS active_orders,
         MAX(so.order_date)::text                                                      AS last_order_date
       FROM sales_orders so
       JOIN parties p ON p.id = so.customer_id
       WHERE so.deleted_at IS NULL
         AND ($1::int IS NULL OR so.company_id = $1)
       GROUP BY p.id, p.name, p.city
       ORDER BY total_value DESC
       LIMIT 100`,
      [cid ?? null]
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders/:id', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const order = await salesOrdersRepository.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders', requirePermission('sales', 'add'), async (req, res) => {
  try {
    const userId    = req.user?.userId ?? req.user?.id;
    const companyId = companyOf(req);
    const orderNumber = req.body.order_number || await salesOrdersRepository.getNextOrderNumber();
    const order = await salesOrdersRepository.create({
      ...req.body,
      order_number: orderNumber,
      company_id:   companyId,
      created_by:   userId,
    });
    logAudit({ userId, module: 'sales', recordId: order.id, recordType: 'sales_order', action: 'create', newData: order, req });

    if (req.body.quotation_id) {
      await quotationsRepository.update(req.body.quotation_id, { status: 'accepted' });
    }

    res.status(201).json({ data: order });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/orders/:id', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const order = await salesOrdersRepository.update(req.params.id, req.body);
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: req.params.id, recordType: 'sales_order', action: 'update', newData: order, req });
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/orders/:id', requirePermission('sales', 'delete'), async (req, res) => {
  try {
    await salesOrdersRepository.delete(req.params.id);
    res.json({ message: 'Order deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/:id/items', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const items = await salesOrdersRepository.getItems(req.params.id);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders/:id/items', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const item = await salesOrdersRepository.addItem({ ...req.body, order_id: req.params.id });
    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/:id/linked-invoice', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, invoice_number, total_amount, status, created_at
       FROM invoices WHERE sales_order_id = $1 AND company_id = $2 LIMIT 1`,
      [req.params.id, companyOf(req)]
    );
    res.json(r.rows[0] || null);
  } catch {
    res.json(null);
  }
});

// ── PATCH status transitions ─────────────────────────────────────────────────

router.patch('/orders/:id/confirm', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE sales_orders SET order_status='confirmed', updated_at=NOW()
       WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
      [req.params.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: req.params.id, recordType: 'sales_order', action: 'update', newData: { order_status: 'confirmed' }, req });
    await autoBootstrapLifecycleOnOrderAccept(req.params.id, req.user);
    notifyWorkflowEvent('order_confirmed', { module: 'Sales Order', recordId: req.params.id, submitterUserId: order.created_by ?? null });
    calculateCommission(req.params.id, companyOf(req));
    res.json({ data: order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/orders/:id/invoice', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const userId    = req.user?.userId ?? req.user?.id;
    const companyId = companyOf(req);

    // Fetch the order
    const soRes = await pool.query(
      `SELECT * FROM sales_orders WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]
    );
    if (!soRes.rows.length) return res.status(404).json({ error: 'Order not found' });
    const so = soRes.rows[0];

    // Create finance invoice
    let invoiceId = null;
    try {
      const items = await salesOrdersRepository.getItems(req.params.id);
      const invRes = await pool.query(
        `INSERT INTO invoices
           (company_id, customer_id, customer_name, invoice_date, due_date,
            subtotal, tax_amount, total_amount, status, sales_order_id, created_by)
         VALUES ($1,$2,$3,CURRENT_DATE,CURRENT_DATE+30,$4,$5,$6,'draft',$7,$8)
         RETURNING id, invoice_number`,
        [companyId, so.customer_id ?? null, so.customer_name ?? null,
         so.subtotal ?? 0, so.tax_amount ?? 0, so.total_amount ?? 0,
         req.params.id, userId]
      );
      invoiceId = invRes.rows[0]?.id;

      if (items.length && invoiceId) {
        for (const it of items) {
          await pool.query(
            `INSERT INTO invoice_items
               (invoice_id, item_description, quantity, rate, tax_percentage, tax_amount, total)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [invoiceId, it.item_description, it.quantity, it.rate, it.tax_percentage, it.tax_amount, it.total]
          ).catch(() => {});
        }
      }
    } catch { /* finance invoice creation non-fatal */ }

    const { rows } = await pool.query(
      `UPDATE sales_orders
       SET order_status='invoiced', invoiced_at=NOW(), invoice_id=$1, updated_at=NOW()
       WHERE id=$2 AND deleted_at IS NULL RETURNING *`,
      [invoiceId, req.params.id]
    );
    logAudit({ userId, module: 'sales', recordId: req.params.id, recordType: 'sales_order', action: 'update', newData: { order_status: 'invoiced' }, req });
    res.json({ data: rows[0], invoice_id: invoiceId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/orders/:id/cancel', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason is required to cancel an order' });
    const { rows } = await pool.query(
      `UPDATE sales_orders SET order_status='cancelled', cancel_reason=$1, updated_at=NOW()
       WHERE id=$2 AND deleted_at IS NULL RETURNING *`,
      [reason, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: req.params.id, recordType: 'sales_order', action: 'update', newData: { order_status: 'cancelled', cancel_reason: reason }, req });
    res.json({ data: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Convert quotation → sales order
router.post('/orders/from-quotation/:quotationId', requirePermission('sales', 'add'), async (req, res) => {
  try {
    const userId    = req.user?.userId ?? req.user?.id;
    const companyId = companyOf(req);
    const quotation = await quotationsRepository.findById(req.params.quotationId);
    if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
    const items   = await quotationsRepository.getItems(req.params.quotationId);
    const orderNumber = await salesOrdersRepository.getNextOrderNumber();
    const order = await salesOrdersRepository.create({
      order_number:  orderNumber,
      company_id:    companyId,
      customer_id:   quotation.customer_id,
      customer_name: quotation.customer_name,
      quotation_id:  quotation.id,
      order_date:    new Date().toISOString().split('T')[0],
      subtotal:      quotation.subtotal,
      tax_amount:    quotation.tax_amount,
      total_amount:  quotation.total_amount,
      notes:         quotation.notes,
      order_status:  'confirmed',
      created_by:    userId,
    });
    for (const it of (items || [])) {
      await salesOrdersRepository.addItem({
        order_id:         order.id,
        item_description: it.item_description || it.description,
        quantity:         it.quantity,
        rate:             it.rate || it.unit_price || 0,
        tax_percentage:   it.tax_percentage || 0,
        tax_amount:       it.tax_amount || 0,
        total:            it.total || it.amount || 0,
      });
    }
    await quotationsRepository.update(req.params.quotationId, { status: 'converted' });
    logAudit({ userId, module: 'sales', recordId: order.id, recordType: 'sales_order', action: 'create', newData: order, req });
    res.status(201).json({ data: order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Order status transitions
router.put('/orders/:id/status', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const order = await salesOrdersRepository.update(req.params.id, { order_status: req.body.status });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: req.params.id, recordType: 'sales_order', action: 'update', newData: { order_status: req.body.status }, req });
    const status = String(req.body.status || '').toLowerCase();
    if (['accepted', 'confirmed', 'won', 'approved', 'released'].includes(status)) {
      await autoBootstrapLifecycleOnOrderAccept(req.params.id, req.user);
      notifyWorkflowEvent('order_confirmed', { module: 'Sales Order', recordId: req.params.id, submitterUserId: order?.created_by ?? null });
    }
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/orders/:id/dispatch', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { carrier, tracking_number, dispatch_date } = req.body;
    const dispatchedAt = dispatch_date ? new Date(dispatch_date) : new Date();
    const { rows } = await pool.query(
      `UPDATE sales_orders
       SET order_status='dispatched', carrier=$1, tracking_number=$2, dispatched_at=$3, updated_at=NOW()
       WHERE id=$4 AND deleted_at IS NULL RETURNING *`,
      [carrier || null, tracking_number || null, dispatchedAt, req.params.id]
    );
    const order = rows[0];
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: req.params.id, recordType: 'sales_order', action: 'update', newData: { order_status: 'dispatched', carrier, tracking_number }, req });
    notifyWorkflowEvent('dispatched', { module: 'Sales Order', recordId: req.params.id, submitterUserId: order?.created_by ?? null });
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/orders/:id/deliver', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE sales_orders
       SET order_status='delivered', delivered_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
      [req.params.id]
    );
    const order = rows[0];
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: req.params.id, recordType: 'sales_order', action: 'update', newData: { order_status: 'delivered' }, req });
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Fulfilment & Credit Control ──────────────────────────────────────────────

router.get('/fulfilment/delivery-orders', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT
         so.id, so.order_number, so.total_amount, so.order_status AS status,
         so.delivery_date, so.dispatched_at, so.delivered_at,
         so.tracking_number, so.carrier,
         so.created_at,
         p.name AS customer_name,
         CASE WHEN so.delivery_date < CURRENT_DATE
              AND so.order_status NOT IN ('delivered','invoiced','cancelled')
              THEN true ELSE false END AS is_overdue,
         COUNT(soi.id)::int AS item_count
       FROM sales_orders so
       LEFT JOIN parties p ON p.id = so.customer_id
       LEFT JOIN sales_order_items soi ON soi.order_id = so.id
       WHERE so.deleted_at IS NULL
         AND ($1::int IS NULL OR so.company_id = $1)
         AND so.order_status IN ('confirmed','pending','dispatched')
       GROUP BY so.id, p.name
       ORDER BY so.delivery_date ASC NULLS LAST`,
      [cid]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fulfilment/stats', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE order_status = 'confirmed')::int             AS pending_dispatch,
         COUNT(*) FILTER (WHERE order_status = 'dispatched')::int            AS in_transit,
         COUNT(*) FILTER (
           WHERE delivery_date < CURRENT_DATE
             AND order_status NOT IN ('delivered','invoiced','cancelled')
         )::int                                                               AS overdue,
         COUNT(*) FILTER (
           WHERE order_status = 'delivered'
             AND DATE_TRUNC('month', delivered_at) = DATE_TRUNC('month', NOW())
         )::int                                                               AS delivered_this_month
       FROM sales_orders
       WHERE deleted_at IS NULL
         AND ($1::int IS NULL OR company_id = $1)`,
      [cid]
    );
    res.json(rows[0] || { pending_dispatch: 0, in_transit: 0, overdue: 0, delivered_this_month: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fulfilment/credit-control', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT
         p.id,
         p.name AS customer,
         COALESCE(ccs.credit_limit, 0)::numeric                                  AS credit_limit,
         COALESCE(ccs.credit_terms_days, 30)                                      AS credit_terms_days,
         COALESCE(ccs.is_blocked, false)                                          AS is_blocked,
         ccs.block_reason,
         COALESCE(SUM(so.total_amount) FILTER (
           WHERE so.order_status NOT IN ('cancelled','invoiced')
         ), 0)::numeric                                                            AS open_orders_value,
         COALESCE(SUM(inv.balance_due) FILTER (
           WHERE inv.status IN ('sent','overdue','Sent','Overdue')
         ), 0)::numeric                                                            AS outstanding_invoices,
         COALESCE(ccs.credit_limit, 0) -
           COALESCE(SUM(so.total_amount) FILTER (
             WHERE so.order_status NOT IN ('cancelled','invoiced')
           ), 0) -
           COALESCE(SUM(inv.balance_due) FILTER (
             WHERE inv.status IN ('sent','overdue','Sent','Overdue')
           ), 0)                                                                   AS available_credit,
         CASE
           WHEN COALESCE(ccs.credit_limit, 0) = 0 THEN 'no_limit'
           WHEN (
             COALESCE(SUM(so.total_amount) FILTER (
               WHERE so.order_status NOT IN ('cancelled','invoiced')
             ), 0) +
             COALESCE(SUM(inv.balance_due) FILTER (
               WHERE inv.status IN ('sent','overdue','Sent','Overdue')
             ), 0)
           ) > COALESCE(ccs.credit_limit, 0) THEN 'exceeded'
           ELSE 'ok'
         END AS credit_status
       FROM parties p
       LEFT JOIN customer_credit_settings ccs
         ON ccs.account_id = p.id AND ($1::int IS NULL OR ccs.company_id = $1)
       LEFT JOIN sales_orders so
         ON so.customer_id = p.id
         AND so.deleted_at IS NULL
         AND ($1::int IS NULL OR so.company_id = $1)
       LEFT JOIN invoices inv ON inv.customer_id = p.id
       WHERE p.deleted_at IS NULL
         AND ($1::int IS NULL OR p.company_id = $1)
         AND p.party_type IN ('customer','Customer')
       GROUP BY p.id, p.name, ccs.credit_limit, ccs.credit_terms_days, ccs.is_blocked, ccs.block_reason
       ORDER BY credit_status DESC, p.name`,
      [cid]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/fulfilment/credit-control/:accountId', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { accountId } = req.params;
    const { credit_limit, credit_terms_days, is_blocked, block_reason } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO customer_credit_settings
         (company_id, account_id, credit_limit, credit_terms_days, is_blocked, block_reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (company_id, account_id) DO UPDATE SET
         credit_limit      = EXCLUDED.credit_limit,
         credit_terms_days = EXCLUDED.credit_terms_days,
         is_blocked        = EXCLUDED.is_blocked,
         block_reason      = EXCLUDED.block_reason,
         updated_at        = NOW()
       RETURNING *`,
      [cid, accountId, credit_limit ?? 0, credit_terms_days ?? 30, is_blocked ?? false, block_reason ?? null]
    );
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'sales', recordId: accountId, recordType: 'credit_settings', action: 'upsert', newData: rows[0], req });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fulfilment/analytics', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);

    const [monthly, timing, topCustomers] = await Promise.all([
      pool.query(
        `SELECT
           TO_CHAR(DATE_TRUNC('month', delivered_at), 'Mon YY') AS month,
           DATE_TRUNC('month', delivered_at)                    AS month_start,
           COUNT(*)::int                                         AS count
         FROM sales_orders
         WHERE order_status = 'delivered'
           AND delivered_at >= NOW() - INTERVAL '12 months'
           AND deleted_at IS NULL
           AND ($1::int IS NULL OR company_id = $1)
         GROUP BY DATE_TRUNC('month', delivered_at)
         ORDER BY month_start`,
        [cid]
      ),
      pool.query(
        `SELECT
           ROUND(AVG(EXTRACT(EPOCH FROM (dispatched_at - created_at)) / 86400)
             FILTER (WHERE dispatched_at IS NOT NULL), 1)          AS avg_dispatch_days,
           ROUND(AVG(EXTRACT(EPOCH FROM (delivered_at - dispatched_at)) / 86400)
             FILTER (WHERE delivered_at IS NOT NULL AND dispatched_at IS NOT NULL), 1) AS avg_delivery_days,
           ROUND(
             100.0 * COUNT(*) FILTER (
               WHERE order_status = 'delivered'
                 AND delivered_at IS NOT NULL
                 AND delivery_date IS NOT NULL
                 AND delivered_at::date <= delivery_date
             ) / NULLIF(COUNT(*) FILTER (WHERE order_status = 'delivered'), 0),
           1)                                                       AS on_time_rate
         FROM sales_orders
         WHERE deleted_at IS NULL
           AND ($1::int IS NULL OR company_id = $1)`,
        [cid]
      ),
      pool.query(
        `SELECT
           p.name AS customer,
           COUNT(so.id)::int AS order_count,
           COALESCE(SUM(so.total_amount), 0)::numeric AS total_value
         FROM sales_orders so
         JOIN parties p ON p.id = so.customer_id
         WHERE so.deleted_at IS NULL
           AND ($1::int IS NULL OR so.company_id = $1)
         GROUP BY p.id, p.name
         ORDER BY order_count DESC
         LIMIT 5`,
        [cid]
      ),
    ]);

    const t = timing.rows[0] || {};
    res.json({
      monthly_fulfilled: monthly.rows.map(r => ({ month: r.month, count: r.count })),
      avg_dispatch_time_days: parseFloat(t.avg_dispatch_days) || 0,
      avg_delivery_time_days: parseFloat(t.avg_delivery_days) || 0,
      on_time_delivery_rate:  parseFloat(t.on_time_rate) || 0,
      top_customers:          topCustomers.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Legacy Fulfilment KPIs
router.get('/fulfilment-rate', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE order_status = 'delivered') AS delivered,
        COUNT(*) FILTER (WHERE order_status NOT IN ('cancelled','draft')) AS total,
        COUNT(*) FILTER (WHERE order_status IN ('pending','picking','packed')) AS pending_dispatches,
        ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/3600)
          FILTER (WHERE order_status = 'delivered'), 1) AS avg_fulfilment_hours,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'
          AND order_status NOT IN ('cancelled','draft')) AS total_orders_30d
      FROM sales_orders WHERE deleted_at IS NULL
    `);
    const row = r.rows[0];
    const total = parseInt(row.total) || 0;
    const delivered = parseInt(row.delivered) || 0;
    res.json({
      on_time_delivery_pct: total > 0 ? parseFloat(((delivered / total) * 100).toFixed(1)) : 0,
      fill_rate_pct: total > 0 ? parseFloat(((delivered / total) * 100).toFixed(1)) : 0,
      pending_dispatches: parseInt(row.pending_dispatches) || 0,
      avg_fulfilment_hours: parseFloat(row.avg_fulfilment_hours) || 0,
      total_orders_30d: parseInt(row.total_orders_30d) || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/delivery-performance', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        DATE(created_at) AS date,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE order_status = 'delivered') AS on_time,
        COUNT(*) FILTER (WHERE order_status = 'delivered') AS delivered
      FROM sales_orders
      WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `);
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Credit limits
router.get('/credit-limits', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT cl.*,
        ROUND((cl.current_outstanding / NULLIF(cl.credit_limit, 0)) * 100, 1) AS utilization_pct,
        cl.credit_limit - cl.current_outstanding AS available_credit
      FROM credit_limits cl
      ORDER BY cl.customer_name
    `);
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/credit-limits', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { customer_id, customer_name, credit_limit, credit_terms_days } = req.body;
    const r = await pool.query(
      `INSERT INTO credit_limits (customer_id, customer_name, credit_limit, credit_terms_days)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [customer_id, customer_name, credit_limit || 0, credit_terms_days || 30]
    );
    res.status(201).json(r.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/credit-limits/:id/release-hold', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE credit_limits SET credit_hold=false, hold_reason=NULL, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Sales', recordId: req.params.id, recordType: 'credit_limit', action: 'update', newData: r.rows[0], req });
    res.json(r.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/credit-check', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const { customer_id, order_amount } = req.body;
    const r = await pool.query(
      `SELECT *, credit_limit - current_outstanding AS available_credit FROM credit_limits WHERE customer_id=$1`,
      [customer_id]
    );
    if (r.rows.length === 0) {
      return res.json({ status: 'approved', message: 'No credit limit configured. Order approved.' });
    }
    const cl = r.rows[0];
    if (cl.credit_hold) {
      return res.json({ status: 'blocked', message: `Customer is on credit hold. Reason: ${cl.hold_reason || 'Manual hold'}`, available_credit: cl.available_credit });
    }
    const newOutstanding = parseFloat(cl.current_outstanding) + parseFloat(order_amount);
    const util = newOutstanding / parseFloat(cl.credit_limit);
    if (newOutstanding > parseFloat(cl.credit_limit)) {
      return res.json({ status: 'blocked', message: `Exceeds credit limit. Available: ₹${parseFloat(cl.available_credit).toLocaleString('en-IN')}`, available_credit: cl.available_credit });
    }
    if (util > 0.8) {
      return res.json({ status: 'warning', message: `Order will utilize ${(util * 100).toFixed(1)}% of credit limit.`, available_credit: cl.available_credit });
    }
    res.json({ status: 'approved', message: 'Order approved.', available_credit: cl.available_credit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sales Targets
router.get('/targets/stats', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const stats = await salesTargetsRepository.getStats(req.query, companyOf(req));
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/targets', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const targets = await salesTargetsRepository.findAll(req.query, companyOf(req));
    res.json(targets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/targets', requirePermission('sales', 'add'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const createdBy = req.user?.userId ?? req.user?.id;
    const target = await salesTargetsRepository.upsert({ ...req.body, created_by: createdBy }, companyId);
    res.json(target);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/targets/:id', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { owner_id, period_type, period_year, period_value, target_amount, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE sales_targets
       SET owner_id     = COALESCE($1, owner_id),
           period_type  = COALESCE($2, period_type),
           period_year  = COALESCE($3, period_year),
           period_value = COALESCE($4, period_value),
           target_amount = COALESCE($5, target_amount),
           notes        = $6,
           updated_at   = NOW()
       WHERE id = $7 AND company_id = $8 RETURNING *`,
      [owner_id || null, period_type || null, period_year || null, period_value || null,
       target_amount || null, notes || null, req.params.id, cid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Target not found' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/targets/:id', requirePermission('sales', 'delete'), async (req, res) => {
  try {
    await salesTargetsRepository.deleteById(req.params.id, companyOf(req));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Forecasts — auto-computed from opportunities (weighted) + sales_orders (achieved)

router.get('/forecasts/summary', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { period_type = 'monthly', period_year, period_value } = req.query;
    const now  = new Date();
    const year = parseInt(period_year)  || now.getFullYear();
    const pval = parseInt(period_value) || (
      period_type === 'quarterly'
        ? Math.ceil((now.getMonth() + 1) / 3)
        : (now.getMonth() + 1)
    );
    const params = [cid, period_type, year, pval];
    const pf = (col) => `
      AND EXTRACT(YEAR FROM ${col}) = $3
      AND ($2 = 'annual'
           OR ($2 = 'monthly'   AND EXTRACT(MONTH FROM ${col}) = $4)
           OR ($2 = 'quarterly' AND CEIL(EXTRACT(MONTH FROM ${col})/3.0) = $4))`;

    const [fR, aR, tR] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(expected_value * probability_percentage / 100.0), 0) AS val
        FROM opportunities WHERE company_id=$1 AND deleted_at IS NULL AND LOWER(stage) NOT IN ('won','lost') ${pf('expected_closing_date')}`, params),
      pool.query(`SELECT COALESCE(SUM(total_amount), 0) AS val
        FROM sales_orders WHERE company_id=$1 AND deleted_at IS NULL AND order_status IN ('confirmed','dispatched','delivered','invoiced') ${pf('created_at')}`, params),
      pool.query(`SELECT COALESCE(SUM(target_amount), 0) AS val
        FROM sales_targets WHERE company_id=$1 AND period_type=$2 AND period_year=$3 AND ($2='annual' OR period_value=$4)`, params),
    ]);

    const forecasted             = parseFloat(fR.rows[0]?.val) || 0;
    const achieved               = parseFloat(aR.rows[0]?.val) || 0;
    const target                 = parseFloat(tR.rows[0]?.val) || 0;
    const achievement_pct        = target > 0 ? parseFloat((achieved   / target * 100).toFixed(1)) : null;
    const forecast_vs_target_pct = target > 0 ? parseFloat((forecasted / target * 100).toFixed(1)) : null;
    res.json({ forecasted, achieved, target, achievement_pct, forecast_vs_target_pct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/forecasts/by-month', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid  = companyOf(req);
    const year = parseInt(req.query.period_year) || new Date().getFullYear();
    const { rows } = await pool.query(`
      SELECT m.month,
        COALESCE(SUM(o.expected_value * o.probability_percentage / 100.0), 0) AS forecasted,
        COALESCE(SUM(so.total_amount), 0)                                      AS achieved,
        COALESCE(SUM(st.target_amount), 0)                                     AS target
      FROM generate_series(1, 12) AS m(month)
      LEFT JOIN opportunities o ON
        EXTRACT(MONTH FROM o.expected_closing_date) = m.month
        AND EXTRACT(YEAR FROM o.expected_closing_date) = $2
        AND o.company_id = $1 AND o.deleted_at IS NULL
        AND LOWER(o.stage) NOT IN ('won','lost')
      LEFT JOIN sales_orders so ON
        EXTRACT(MONTH FROM so.created_at) = m.month
        AND EXTRACT(YEAR FROM so.created_at) = $2
        AND so.company_id = $1 AND so.deleted_at IS NULL
        AND so.order_status IN ('confirmed','dispatched','delivered','invoiced')
      LEFT JOIN sales_targets st ON
        st.period_type='monthly' AND st.period_value=m.month
        AND st.period_year=$2 AND st.company_id=$1
      GROUP BY m.month ORDER BY m.month
    `, [cid, year]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/forecasts/by-rep', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { period_type = 'monthly', period_year, period_value } = req.query;
    const now  = new Date();
    const year = parseInt(period_year)  || now.getFullYear();
    const pval = parseInt(period_value) || (
      period_type === 'quarterly' ? Math.ceil((now.getMonth() + 1) / 3) : (now.getMonth() + 1)
    );
    const pf = (col) => `($2='annual' OR ($2='monthly' AND EXTRACT(MONTH FROM ${col})=$4) OR ($2='quarterly' AND CEIL(EXTRACT(MONTH FROM ${col})/3.0)=$4))`;
    const { rows } = await pool.query(`
      SELECT e.id,
        COALESCE(e.name, e.first_name || ' ' || e.last_name) AS name,
        e.designation,
        COALESCE(SUM(o.expected_value * o.probability_percentage / 100.0), 0) AS forecasted,
        COALESCE(SUM(so.total_amount), 0)                                      AS achieved,
        COALESCE(MAX(st.target_amount), 0)                                     AS target
      FROM employees e
      LEFT JOIN opportunities o ON o.assigned_to=e.id AND o.company_id=$1 AND o.deleted_at IS NULL
        AND LOWER(o.stage) NOT IN ('won','lost')
        AND EXTRACT(YEAR FROM o.expected_closing_date)=$3 AND ${pf('o.expected_closing_date')}
      LEFT JOIN sales_orders so ON so.created_by=e.id AND so.company_id=$1 AND so.deleted_at IS NULL
        AND so.order_status IN ('confirmed','dispatched','delivered','invoiced')
        AND EXTRACT(YEAR FROM so.created_at)=$3 AND ${pf('so.created_at')}
      LEFT JOIN sales_targets st ON st.owner_id=e.id AND st.company_id=$1
        AND st.period_type=$2 AND st.period_year=$3 AND ($2='annual' OR st.period_value=$4)
      WHERE e.company_id=$1 AND e.status IN ('active','probation')
      GROUP BY e.id, e.name, e.first_name, e.last_name, e.designation
      HAVING COALESCE(SUM(o.expected_value * o.probability_percentage / 100.0), 0) > 0
          OR COALESCE(SUM(so.total_amount), 0) > 0
    `, [cid, period_type, year, pval]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/forecasts/pipeline-breakdown', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { period_type = 'monthly', period_year, period_value } = req.query;
    const now  = new Date();
    const year = parseInt(period_year)  || now.getFullYear();
    const pval = parseInt(period_value) || (
      period_type === 'quarterly' ? Math.ceil((now.getMonth() + 1) / 3) : (now.getMonth() + 1)
    );
    const { rows } = await pool.query(`
      SELECT stage,
        COUNT(*)::int                                                      AS deal_count,
        COALESCE(SUM(expected_value), 0)                                   AS gross_value,
        COALESCE(SUM(expected_value * probability_percentage / 100.0), 0) AS weighted_value,
        ROUND(AVG(probability_percentage), 1)                              AS avg_probability
      FROM opportunities
      WHERE company_id=$1 AND deleted_at IS NULL AND LOWER(stage) NOT IN ('won','lost')
        AND EXTRACT(YEAR FROM expected_closing_date)=$3
        AND ($2='annual'
             OR ($2='monthly'   AND EXTRACT(MONTH FROM expected_closing_date)=$4)
             OR ($2='quarterly' AND CEIL(EXTRACT(MONTH FROM expected_closing_date)/3.0)=$4))
      GROUP BY stage ORDER BY weighted_value DESC
    `, [cid, period_type, year, pval]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Analytics
router.get('/analytics/monthly-revenue', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const data = await salesOrdersRepository.getMonthlyRevenue(companyOf(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/top-customers', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const limit = req.query.limit || 10;
    const data = await salesOrdersRepository.getTopCustomers(limit, companyOf(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/sales-vs-target', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const data = await salesTargetsRepository.getSalesVsTarget(companyOf(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Sales Documents ─────────────────────────────────────────────────────────────
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales_documents (
        id SERIAL PRIMARY KEY,
        company_id INTEGER,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) DEFAULT 'Other',
        customer_name VARCHAR(255),
        file_url TEXT,
        file_size INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { console.error('[sales_documents] init error:', e.message); }
})();

router.get('/documents', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `SELECT * FROM sales_documents WHERE company_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [companyId, limit]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/documents', requirePermission('sales', 'add'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { name, type = 'Other', customer_name, file_url, file_size } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO sales_documents (company_id, name, type, customer_name, file_url, file_size)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [companyId, name, type, customer_name || null, file_url || null, file_size || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sales Partners ─────────────────────────────────────────────────────────
// MOVED OUT. The partner master (IPU) now lives in routes/partners.routes.js,
// mounted at /api/sales/partners AHEAD of this router, and its table is owned by
// migration 20260717000004 instead of the fire-and-forget CREATE TABLE that used
// to sit here. Do not re-add /partners handlers to this file — Express matches in
// registration order and anything defined here would be shadowed anyway.

// ── Sales Territories ──────────────────────────────────────────────────────
// Still bootstrapped in-process. Left as-is deliberately: it is out of scope for
// the partner rebuild, and quietly reshaping a second table under a change that
// was not about it is how the partners/territories pair got into this state.
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales_territories (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER,
        name            TEXT NOT NULL,
        region          TEXT,
        assigned_to     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        target_revenue  NUMERIC(15,2) DEFAULT 0,
        status          TEXT DEFAULT 'active',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  } catch (e) { console.error('[sales] territories migration:', e.message); }
})();

router.get('/territories', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `SELECT t.*, e.first_name || ' ' || e.last_name AS assigned_to_name
       FROM sales_territories t
       LEFT JOIN employees e ON e.id = t.assigned_to
       WHERE ($1::int IS NULL OR t.company_id=$1) ORDER BY t.name LIMIT $2`,
      [cid, limit]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/territories', requirePermission('sales', 'add'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { name, region, assigned_to, target_revenue, states } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const statesJson = JSON.stringify(Array.isArray(states) ? states : (states ? [states] : []));
    const { rows } = await pool.query(
      `INSERT INTO sales_territories (company_id, name, region, assigned_to, target_revenue, states)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [cid, name, region || null, assigned_to || null, target_revenue || 0, statesJson]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/territories/:id', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { name, region, assigned_to, target_revenue, status, states } = req.body;
    const statesJson = JSON.stringify(Array.isArray(states) ? states : (states ? [states] : []));
    const { rows } = await pool.query(
      `UPDATE sales_territories SET name=$1, region=$2, assigned_to=$3, target_revenue=$4, status=$5, states=$6
       WHERE id=$7 AND ($8::int IS NULL OR company_id=$8) RETURNING *`,
      [name, region || null, assigned_to || null, target_revenue || 0, status || 'active', statesJson, req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Territory not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/territories/:id', requirePermission('sales', 'delete'), async (req, res) => {
  try {
    const cid = companyOf(req);
    await pool.query(`DELETE FROM sales_territories WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`, [req.params.id, cid]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sales Playbooks ───────────────────────────────────────────────────────────

router.get('/playbooks', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid    = companyOf(req);
    const cat    = req.query.category || '';
    const search = req.query.search   || '';
    const { rows } = await pool.query(
      `SELECT sp.*,
              COUNT(ps.id)::int AS step_count,
              e.name            AS created_by_name
       FROM   sales_playbooks sp
       LEFT JOIN playbook_steps ps ON ps.playbook_id = sp.id
       LEFT JOIN employees e       ON e.id = sp.created_by
       WHERE  sp.company_id = $1
         AND  ($2 = '' OR sp.category = $2)
         AND  ($3 = '' OR sp.name ILIKE '%' || $3 || '%')
       GROUP BY sp.id, e.name
       ORDER BY sp.category, sp.name`,
      [cid, cat, search]
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/playbooks/:id', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const pb  = await pool.query(
      `SELECT sp.*, e.name AS created_by_name
       FROM   sales_playbooks sp
       LEFT JOIN employees e ON e.id = sp.created_by
       WHERE  sp.id = $1 AND sp.company_id = $2`,
      [req.params.id, cid]
    );
    if (!pb.rows.length) return res.status(404).json({ error: 'Playbook not found' });
    const steps = await pool.query(
      `SELECT * FROM playbook_steps WHERE playbook_id = $1 ORDER BY step_order`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...pb.rows[0], steps: steps.rows } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/playbooks', requirePermission('sales', 'add'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { name, description, category, applicable_stage } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO sales_playbooks (company_id, name, description, category, applicable_stage, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [cid, name, description || null, category || null, applicable_stage || null, req.user?.id || null]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/playbooks/:id', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { name, description, category, applicable_stage, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE sales_playbooks
       SET    name             = COALESCE($3, name),
              description      = COALESCE($4, description),
              category         = COALESCE($5, category),
              applicable_stage = COALESCE($6, applicable_stage),
              is_active        = COALESCE($7, is_active),
              updated_at       = NOW()
       WHERE  id = $1 AND company_id = $2
       RETURNING *`,
      [req.params.id, cid, name, description, category, applicable_stage, is_active]
    );
    if (!rows.length) return res.status(404).json({ error: 'Playbook not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/playbooks/:id', requirePermission('sales', 'delete'), async (req, res) => {
  try {
    const cid = companyOf(req);
    await pool.query(
      `DELETE FROM sales_playbooks WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/playbooks/:id/steps', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const pb = await pool.query(
      `SELECT id FROM sales_playbooks WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid]
    );
    if (!pb.rows.length) return res.status(404).json({ error: 'Playbook not found' });
    const { title, description, step_type, content, is_mandatory } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const ord = await pool.query(
      `SELECT COALESCE(MAX(step_order), 0) + 1 AS next FROM playbook_steps WHERE playbook_id = $1`,
      [req.params.id]
    );
    const { rows } = await pool.query(
      `INSERT INTO playbook_steps (playbook_id, step_order, title, description, step_type, content, is_mandatory)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, ord.rows[0].next, title, description || null,
       step_type || 'action', content || null, is_mandatory !== false]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// reorder must come before /:stepId
router.put('/playbooks/:id/steps/reorder', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const pb = await pool.query(
      `SELECT id FROM sales_playbooks WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid]
    );
    if (!pb.rows.length) return res.status(404).json({ error: 'Playbook not found' });
    const { ordered_ids } = req.body;
    if (!Array.isArray(ordered_ids)) return res.status(400).json({ error: 'ordered_ids must be an array' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < ordered_ids.length; i++) {
        await client.query(
          `UPDATE playbook_steps SET step_order = $1 WHERE id = $2 AND playbook_id = $3`,
          [i + 1, ordered_ids[i], req.params.id]
        );
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/playbooks/:id/steps/:stepId', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const pb = await pool.query(
      `SELECT id FROM sales_playbooks WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid]
    );
    if (!pb.rows.length) return res.status(404).json({ error: 'Playbook not found' });
    const { title, description, step_type, content, is_mandatory } = req.body;
    const { rows } = await pool.query(
      `UPDATE playbook_steps
       SET    title        = COALESCE($3, title),
              description  = COALESCE($4, description),
              step_type    = COALESCE($5, step_type),
              content      = COALESCE($6, content),
              is_mandatory = COALESCE($7, is_mandatory)
       WHERE  id = $1 AND playbook_id = $2
       RETURNING *`,
      [req.params.stepId, req.params.id, title, description, step_type, content, is_mandatory]
    );
    if (!rows.length) return res.status(404).json({ error: 'Step not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/playbooks/:id/steps/:stepId', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const pb = await pool.query(
      `SELECT id FROM sales_playbooks WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid]
    );
    if (!pb.rows.length) return res.status(404).json({ error: 'Playbook not found' });
    await pool.query(
      `DELETE FROM playbook_steps WHERE id = $1 AND playbook_id = $2`,
      [req.params.stepId, req.params.id]
    );
    // Renumber remaining steps
    await pool.query(
      `WITH ranked AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY step_order) AS rn
         FROM   playbook_steps WHERE playbook_id = $1
       )
       UPDATE playbook_steps ps SET step_order = r.rn FROM ranked r WHERE ps.id = r.id`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sales Calendar Events ─────────────────────────────────────────────────────
;(async () => {
  try {
    // Repair: if table exists with wrong UUID type for company_id, drop and recreate
    const { rows: evCols } = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'sales_events' AND column_name = 'company_id'
    `);
    if (evCols.length > 0 && evCols[0].data_type === 'uuid') {
      await pool.query(`DROP TABLE IF EXISTS sales_events`);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id INTEGER NOT NULL,
        title VARCHAR(255) NOT NULL,
        type VARCHAR(30) DEFAULT 'meeting',
        start_at TIMESTAMPTZ NOT NULL,
        end_at TIMESTAMPTZ,
        all_day BOOLEAN DEFAULT false,
        owner_id UUID,
        account_id UUID,
        opportunity_id UUID,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { console.error('[sales_events] init error:', e.message); }
})();

router.get('/calendar/events', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { month, year } = req.query;
    let rows;
    if (month && year) {
      const r = await pool.query(
        `SELECT * FROM sales_events
         WHERE company_id = $1
           AND DATE_TRUNC('month', start_at) = DATE_TRUNC('month', MAKE_DATE($2::int,$3::int,1))
         ORDER BY start_at`,
        [companyId, parseInt(year), parseInt(month)]
      );
      rows = r.rows;
    } else {
      const r = await pool.query(
        `SELECT * FROM sales_events WHERE company_id = $1 ORDER BY start_at DESC LIMIT 200`,
        [companyId]
      );
      rows = r.rows;
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/calendar/events', requirePermission('sales', 'add'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const ownerId   = req.user?.userId ?? req.user?.id;
    const { title, type, start_at, end_at, all_day, account_id, opportunity_id, notes } = req.body;
    if (!title || !start_at) return res.status(400).json({ error: 'title and start_at are required' });
    const { rows } = await pool.query(
      `INSERT INTO sales_events (company_id, title, type, start_at, end_at, all_day, owner_id, account_id, opportunity_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [companyId, title, type || 'meeting', start_at, end_at || null, all_day || false,
       ownerId, account_id || null, opportunity_id || null, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/calendar/events/:id', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { title, type, start_at, end_at, all_day, account_id, opportunity_id, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE sales_events SET
         title=COALESCE($1,title), type=COALESCE($2,type),
         start_at=COALESCE($3,start_at), end_at=$4, all_day=COALESCE($5,all_day),
         account_id=$6, opportunity_id=$7, notes=$8
       WHERE id=$9 AND company_id=$10 RETURNING *`,
      [title||null, type||null, start_at||null, end_at||null, all_day??null,
       account_id||null, opportunity_id||null, notes||null,
       req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/calendar/events/:id', requirePermission('sales', 'delete'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    await pool.query(`DELETE FROM sales_events WHERE id=$1 AND company_id=$2`, [req.params.id, companyId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Documents DELETE ───────────────────────────────────────────────────────────
router.delete('/documents/:id', async (req, res) => {
  try {
    const companyId = companyOf(req);
    await pool.query(`DELETE FROM sales_documents WHERE id=$1 AND company_id=$2`, [req.params.id, companyId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Territories: add states column if missing ─────────────────────────────────
;(async () => {
  try {
    await pool.query(`ALTER TABLE sales_territories ADD COLUMN IF NOT EXISTS states JSONB DEFAULT '[]'`);
  } catch (e) { console.error('[territories] states migration:', e.message); }
})();

// ── Subscriptions ─────────────────────────────────────────────────────────────
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id INTEGER NOT NULL,
        customer_id INTEGER,
        customer_name VARCHAR(255),
        plan_name VARCHAR(255) NOT NULL,
        amount NUMERIC(14,2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'INR',
        billing_cycle VARCHAR(20) DEFAULT 'monthly',
        status VARCHAR(20) DEFAULT 'active',
        start_date DATE NOT NULL,
        next_billing_date DATE,
        end_date DATE,
        auto_renew BOOLEAN DEFAULT true,
        owner_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Fix existing tables that were created with wrong UUID type for company_id
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='subscriptions' AND column_name='company_id' AND udt_name='uuid'
        ) THEN
          ALTER TABLE subscriptions DROP COLUMN company_id;
          ALTER TABLE subscriptions ADD COLUMN company_id INTEGER;
        END IF;
      END $$
    `);
  } catch (e) { console.error('[subscriptions] init error:', e.message); }
})();

router.get('/subscriptions/stats', async (req, res) => {
  try {
    const cid = companyOf(req);
    await pool.query(
      `UPDATE subscriptions SET status='expired'
       WHERE status='active' AND end_date IS NOT NULL AND end_date < CURRENT_DATE AND company_id=$1`,
      [cid]
    );
    const r = await pool.query(
      `SELECT
         COUNT(*)::int                                                           AS total,
         COUNT(*) FILTER (WHERE status='active')::int                           AS active,
         COUNT(*) FILTER (WHERE status='paused')::int                           AS paused,
         COUNT(*) FILTER (WHERE status='cancelled')::int                        AS cancelled,
         COUNT(*) FILTER (WHERE status='expired')::int                          AS expired,
         COUNT(*) FILTER (WHERE status='cancelled'
           AND DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW()))::int   AS churn_count,
         COALESCE(SUM(CASE
           WHEN status='active' AND billing_cycle='monthly'   THEN amount
           WHEN status='active' AND billing_cycle='quarterly' THEN amount/3
           WHEN status='active' AND billing_cycle='annual'    THEN amount/12
           ELSE 0 END),0) AS mrr
       FROM subscriptions WHERE company_id=$1`,
      [cid]
    );
    const row = r.rows[0];
    const mrr = parseFloat(row.mrr) || 0;
    res.json({
      total:       parseInt(row.total)       || 0,
      active:      parseInt(row.active)      || 0,
      paused:      parseInt(row.paused)      || 0,
      cancelled:   parseInt(row.cancelled)   || 0,
      expired:     parseInt(row.expired)     || 0,
      mrr:         parseFloat(mrr.toFixed(2)),
      arr:         parseFloat((mrr * 12).toFixed(2)),
      churn_count: parseInt(row.churn_count) || 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/subscriptions', async (req, res) => {
  try {
    const cid = companyOf(req);
    await pool.query(
      `UPDATE subscriptions SET status='expired'
       WHERE status='active' AND end_date IS NOT NULL AND end_date < CURRENT_DATE AND company_id=$1`,
      [cid]
    );
    const { status } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const params = [cid];
    let where = 'WHERE company_id=$1';
    if (status && status !== 'all') { params.push(status); where += ` AND status=$${params.length}`; }
    const { rows } = await pool.query(
      `SELECT * FROM subscriptions ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/subscriptions', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { customer_name, plan_name, amount, currency, billing_cycle, start_date, next_billing_date, end_date, auto_renew } = req.body;
    if (!customer_name || !plan_name || !amount || !start_date) return res.status(400).json({ error: 'customer_name, plan_name, amount, start_date required' });
    let computedNextBilling = next_billing_date || null;
    if (!computedNextBilling && start_date) {
      const d = new Date(start_date);
      const cycle = billing_cycle || 'monthly';
      if (cycle === 'monthly')   d.setMonth(d.getMonth() + 1);
      else if (cycle === 'quarterly') d.setMonth(d.getMonth() + 3);
      else if (cycle === 'annual')    d.setFullYear(d.getFullYear() + 1);
      computedNextBilling = d.toISOString().split('T')[0];
    }
    const { rows } = await pool.query(
      `INSERT INTO subscriptions (company_id, customer_name, plan_name, amount, currency, billing_cycle, start_date, next_billing_date, end_date, auto_renew)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [cid, customer_name||null, plan_name, amount, currency||'INR', billing_cycle||'monthly',
       start_date, computedNextBilling, end_date||null, auto_renew !== false]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/subscriptions/:id/pause', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `UPDATE subscriptions SET status='paused' WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/subscriptions/:id/cancel', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `UPDATE subscriptions SET status='cancelled' WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/subscriptions/:id/renew', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `UPDATE subscriptions SET status='active' WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Competitors ───────────────────────────────────────────────────────────────
;(async () => {
  try {
    // Repair: if table exists with wrong UUID type for company_id, drop and recreate
    const { rows: compCols } = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'competitors' AND column_name = 'company_id'
    `);
    if (compCols.length > 0 && compCols[0].data_type === 'uuid') {
      await pool.query(`DROP TABLE IF EXISTS competitors`);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS competitors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id INTEGER NOT NULL,
        name VARCHAR(255) NOT NULL,
        website VARCHAR(255),
        strengths TEXT,
        weaknesses TEXT,
        win_rate NUMERIC(5,2),
        notes TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { console.error('[competitors] init error:', e.message); }
})();

router.get('/competitors', async (req, res) => {
  try {
    const cid = companyOf(req);
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `SELECT * FROM competitors WHERE company_id=$1 AND is_active=true ORDER BY name LIMIT $2`,
      [cid, limit]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/competitors', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { name, website, strengths, weaknesses, win_rate, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO competitors (company_id, name, website, strengths, weaknesses, win_rate, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cid, name, website||null, strengths||null, weaknesses||null, win_rate||null, notes||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/competitors/:id', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { name, website, strengths, weaknesses, win_rate, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE competitors SET name=$1,website=$2,strengths=$3,weaknesses=$4,win_rate=$5,notes=$6
       WHERE id=$7 AND company_id=$8 RETURNING *`,
      [name, website||null, strengths||null, weaknesses||null, win_rate||null, notes||null,
       req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Competitor not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/competitors/:id', async (req, res) => {
  try {
    const cid = companyOf(req);
    await pool.query(
      `UPDATE competitors SET is_active=false WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sales Settings ────────────────────────────────────────────────────────────
;(async () => {
  try {
    // Repair: if table exists with wrong UUID type for company_id, drop and recreate
    const { rows: cols } = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'sales_settings' AND column_name = 'company_id'
    `);
    if (cols.length > 0 && cols[0].data_type === 'uuid') {
      await pool.query(`DROP TABLE IF EXISTS sales_settings`);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales_settings (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL UNIQUE,
        default_currency VARCHAR(10) DEFAULT 'INR',
        quotation_validity_days INTEGER DEFAULT 30,
        order_prefix VARCHAR(10) DEFAULT 'SO',
        quotation_prefix VARCHAR(10) DEFAULT 'QUO',
        default_tax_rate NUMERIC(5,2) DEFAULT 18,
        default_place_of_supply VARCHAR(100) DEFAULT 'Karnataka',
        auto_invoice_on_delivery BOOLEAN DEFAULT false,
        require_approval_above NUMERIC(14,2),
        fiscal_year_start INTEGER DEFAULT 4,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { console.error('[sales_settings] init error:', e.message); }
})();

router.get('/settings', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const { rows } = await pool.query(`SELECT * FROM sales_settings WHERE company_id=$1 LIMIT 1`, [cid]);
    if (rows.length) return res.json(rows[0]);
    res.json({
      default_currency: 'INR',
      quotation_validity_days: 30,
      order_prefix: 'SO',
      quotation_prefix: 'QUO',
      default_tax_rate: 18,
      default_place_of_supply: 'Karnataka',
      auto_invoice_on_delivery: false,
      require_approval_above: null,
      fiscal_year_start: 4,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const role = req.user?.role || '';
    if (!['admin','super_admin'].includes(role.toLowerCase())) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { default_currency, quotation_validity_days, order_prefix, quotation_prefix,
            default_tax_rate, default_place_of_supply, auto_invoice_on_delivery,
            require_approval_above, fiscal_year_start } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO sales_settings
         (company_id, default_currency, quotation_validity_days, order_prefix, quotation_prefix,
          default_tax_rate, default_place_of_supply, auto_invoice_on_delivery,
          require_approval_above, fiscal_year_start)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (company_id) DO UPDATE SET
         default_currency=EXCLUDED.default_currency,
         quotation_validity_days=EXCLUDED.quotation_validity_days,
         order_prefix=EXCLUDED.order_prefix,
         quotation_prefix=EXCLUDED.quotation_prefix,
         default_tax_rate=EXCLUDED.default_tax_rate,
         default_place_of_supply=EXCLUDED.default_place_of_supply,
         auto_invoice_on_delivery=EXCLUDED.auto_invoice_on_delivery,
         require_approval_above=EXCLUDED.require_approval_above,
         fiscal_year_start=EXCLUDED.fiscal_year_start
       RETURNING *`,
      [cid, default_currency||'INR', quotation_validity_days||30, order_prefix||'SO',
       quotation_prefix||'QUO', default_tax_rate||18, default_place_of_supply||'Karnataka',
       auto_invoice_on_delivery||false, require_approval_above||null, fiscal_year_start||4]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quotation PDF (server-rendered HTML → browser print → PDF) ───────────────
router.get('/quotations/:id/pdf', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const quotation = await quotationsRepository.findById(req.params.id, cid);
    if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
    const items = await quotationsRepository.getItems(req.params.id);

    // Fetch company info for header
    let company = {};
    try {
      const cr = await pool.query(`SELECT * FROM companies WHERE id = $1`, [cid]);
      company = cr.rows[0] || {};
    } catch (_) {}

    const fmt = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(n || 0);
    const itemRows = (items || []).map((item, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${item.item_description || ''}</td>
        <td style="text-align:right">${item.hsn_code || ''}</td>
        <td style="text-align:right">${item.quantity || 0}</td>
        <td style="text-align:right">${fmt(item.rate)}</td>
        <td style="text-align:right">${item.tax_percentage || 0}%</td>
        <td style="text-align:right">${fmt(item.cgst_amount || item.tax_amount / 2 || 0)}</td>
        <td style="text-align:right">${fmt(item.sgst_amount || item.tax_amount / 2 || 0)}</td>
        <td style="text-align:right"><strong>${fmt(item.total)}</strong></td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Quotation ${quotation.quotation_number}</title>
<style>
  @page { size: A4; margin: 20mm; }
  body { font-family: Arial, sans-serif; font-size: 12px; color: #222; margin: 0; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; border-bottom: 2px solid #0d6efd; padding-bottom: 14px; }
  .company-name { font-size: 20px; font-weight: bold; color: #0d6efd; }
  .company-sub  { font-size: 11px; color: #555; margin-top: 2px; }
  .doc-title    { text-align: right; }
  .doc-title h2 { font-size: 22px; color: #0d6efd; margin: 0; }
  .doc-title .qno { font-size: 14px; font-weight: bold; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 16px 0; }
  .meta-box { border: 1px solid #dee2e6; border-radius: 4px; padding: 10px 14px; }
  .meta-box h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; color: #6c757d; }
  .meta-box p  { margin: 2px 0; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 11px; }
  th { background: #0d6efd; color: #fff; padding: 7px 8px; text-align: left; }
  th:not(:first-child):not(:nth-child(2)) { text-align: right; }
  td { padding: 6px 8px; border-bottom: 1px solid #e9ecef; }
  tr:nth-child(even) td { background: #f8f9fa; }
  .totals { display: flex; justify-content: flex-end; margin-top: 12px; }
  .totals table { width: 300px; }
  .totals td { border: none; padding: 4px 8px; }
  .totals .grand { font-size: 14px; font-weight: bold; color: #0d6efd; border-top: 2px solid #0d6efd; }
  .footer { margin-top: 30px; border-top: 1px solid #dee2e6; padding-top: 10px; font-size: 10px; color: #888; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: bold;
           background: #e9ecef; color: #495057; }
  @media print { body { -webkit-print-color-adjust: exact; } }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="company-name">${company.name || 'Company Name'}</div>
    <div class="company-sub">${company.address || ''} ${company.city || ''} ${company.state || ''}</div>
    <div class="company-sub">GSTIN: ${company.gstin || 'N/A'} | PAN: ${company.pan || 'N/A'}</div>
  </div>
  <div class="doc-title">
    <h2>QUOTATION</h2>
    <div class="qno">${quotation.quotation_number}</div>
    <div><span class="badge">${(quotation.status || 'draft').toUpperCase()}</span>
      ${quotation.version > 1 ? `<span class="badge" style="background:#fff3cd;color:#856404">Rev ${quotation.version}</span>` : ''}
    </div>
  </div>
</div>

<div class="meta-grid">
  <div class="meta-box">
    <h4>Bill To</h4>
    <p><strong>${quotation.customer_name || 'N/A'}</strong></p>
  </div>
  <div class="meta-box">
    <h4>Quotation Details</h4>
    <p>Date: <strong>${quotation.quotation_date ? new Date(quotation.quotation_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'N/A'}</strong></p>
    <p>Valid Until: <strong>${quotation.validity_date ? new Date(quotation.validity_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'N/A'}</strong></p>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>#</th><th>Description</th><th>HSN/SAC</th><th>Qty</th>
      <th>Rate</th><th>Tax%</th><th>CGST</th><th>SGST</th><th>Total</th>
    </tr>
  </thead>
  <tbody>${itemRows}</tbody>
</table>

<div class="totals">
  <table>
    <tr><td>Subtotal</td><td style="text-align:right">${fmt(quotation.subtotal)}</td></tr>
    <tr><td>Tax</td><td style="text-align:right">${fmt(quotation.tax_amount)}</td></tr>
    <tr class="grand"><td><strong>Total</strong></td><td style="text-align:right"><strong>${fmt(quotation.total_amount)}</strong></td></tr>
  </table>
</div>

${quotation.notes ? `<div style="margin-top:20px;padding:10px;background:#f8f9fa;border-radius:4px;">
  <strong>Notes / Terms:</strong><br>${quotation.notes.replace(/\n/g,'<br>')}
</div>` : ''}

<div class="footer">
  This is a computer-generated quotation. Generated on ${new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}.
  <script>window.onload = function(){ window.print(); }</script>
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quotations CSV Export ─────────────────────────────────────────────────────
router.get('/quotations/export', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const rows = await quotationsRepository.findAll({ company_id: cid, status: req.query.status });

    const headers = ['Quotation #','Version','Customer','Status','Date','Valid Until','Subtotal','Tax','Total','Notes'];
    const toRow = r => [
      r.quotation_number, r.version || 1, r.customer_name, r.status,
      r.quotation_date ? new Date(r.quotation_date).toISOString().split('T')[0] : '',
      r.validity_date  ? new Date(r.validity_date).toISOString().split('T')[0]  : '',
      r.subtotal, r.tax_amount, r.total_amount,
      (r.notes || '').replace(/[\r\n,]/g, ' '),
    ].map(v => `"${(v ?? '').toString().replace(/"/g, '""')}"`).join(',');

    const csv = [headers.join(','), ...rows.map(toRow)].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="quotations_${Date.now()}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;

