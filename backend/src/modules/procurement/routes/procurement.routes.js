import express from 'express';
import multer from 'multer';
import pool from '../../shared/db.js';
import { dimension } from '../../../shared/dashboardFilters.js';
import prRepo from '../repositories/purchaseRequest.repository.js';
import poRepo from '../repositories/purchaseOrder.repository.js';
import grnService from '../services/grn.service.js';
import { logAudit } from '../../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../../services/WorkflowNotificationService.js';
import { nextRfxNumber, nextPurchaseOrderNumber, nextLocalPurchaseNumber } from '../../../shared/docNumber.js';
import { uploadFile } from '../../../services/StorageService.js';
import { checkAndCreateAlerts } from '../../../services/stockAlerts.js';
import { sendPurchaseOrderToVendor, sendRfqToVendor } from '../../../utils/mailer.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { resolveGstRate } from '../../../shared/gstRate.js';
import { rollupQualityStatus } from '../../quality/services/qualityRollup.service.js';
import { resolveSourcingAdvisory } from '../services/sourcingAdvisory.service.js';
import { hasRole, allowRoles, permissionFor } from '../../../middlewares/auth.middleware.js';
import { requiredBand, assertCanDecideAmount, requireProcurement } from '../procurement.authz.js';
import { rankOptions, TCO_DEFAULTS } from '../engines/tcoEngine.js';
import {
  loadTcoParams, loadVendorPerformance, loadAnnualDemand, masterRate, tcoBasis,
} from '../services/tco.service.js';
import {
  loadSpendFacets, loadSpendTrend, loadInvoiceSpend, poSpendInr,
  resolveLimit as resolveSpendLimit,
} from '../services/spendAnalytics.service.js';
import { loadTcoPortfolio } from '../services/tcoPortfolio.service.js';
import {
  createInitiative, changeStage, postRealisation, getInitiative,
  loadPipeline, listInitiatives,
} from '../services/savingsRegister.service.js';
import { sqlPoCommitted } from '../../../shared/statusSets.js';
import { resolveVendorParty } from '../services/vendorIdentity.service.js';
import {
  PROC_DEFAULTS, TCO_SETTING_COLS, TCO_RANGES, getProcSettings,
} from '../services/procurementSettings.service.js';
import threeWayMatchRoutes, { createThreeWayMatchRecord } from './threeWayMatch.routes.js';
import { assertTransition, isNoop } from '../procurement.stateMachine.js';
import { captureBefore } from '../../../middlewares/captureBefore.js';

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
router.get('/purchase-requests/stats', requireProcurement('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    // Scope on the PR's own company_id — see the note in
    // purchaseRequest.repository.findAll. Scoping through the requester's
    // employees row via a LEFT JOIN dropped every PR with a NULL requester,
    // which was all of them, so these KPIs counted a fraction of the register.
    const cidFilter = companyId ? `AND pr.company_id = $1` : '';
    const params = companyId ? [companyId] : [];
    // Every status gets a bucket, so the counts reconcile against the `total`
    // reported beside them. They did not: `draft` had none, and a register of
    // 22 requisitions answered with buckets summing to 15. No screen consumes
    // this endpoint today — the requisition page filters the list itself — but
    // an endpoint that reports a total and a breakdown that disagree is a trap
    // for whoever wires it up next. `other` catches a status added later
    // instead of silently unbalancing the response again.
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                                       AS total,
        COUNT(*) FILTER (WHERE pr.status = 'draft')                    AS draft,
        COUNT(*) FILTER (WHERE pr.status = 'pending_approval')         AS pending_approval,
        COUNT(*) FILTER (WHERE pr.status = 'approved')                 AS approved,
        COUNT(*) FILTER (WHERE pr.status = 'converted_to_po')          AS ordered,
        COUNT(*) FILTER (WHERE pr.status = 'rejected')                 AS rejected,
        COUNT(*) FILTER (WHERE pr.status NOT IN
          ('draft','pending_approval','approved','converted_to_po','rejected')) AS other
      FROM purchase_requests pr
      WHERE pr.deleted_at IS NULL ${cidFilter}
    `, params);
    const s = rows[0];
    res.json({
      total:            parseInt(s.total),
      draft:            parseInt(s.draft),
      pending_approval: parseInt(s.pending_approval),
      approved:         parseInt(s.approved),
      ordered:          parseInt(s.ordered),
      rejected:         parseInt(s.rejected),
      other:            parseInt(s.other),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/purchase-requests', requireProcurement('add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items.filter(i => String(i.item_name || '').trim() || i.item_id) : [];
    if (!items.length) return res.status(400).json({ error: 'At least one line item is required.' });
    if (items.some(i => !(parseFloat(i.quantity) > 0))) {
      return res.status(400).json({ error: 'Every line item needs a quantity greater than zero.' });
    }

    const companyId = cid(req);
    // Stamp the raiser from the session. The drawer has no requester field — it
    // is always "me" — and this route never derived one, so every requisition
    // the app created stored requested_by_employee_id = NULL. That is what the
    // approval notification addresses, what the PR list prints in "Requested
    // by", and (before the scoping fix in the repository) what the list filtered
    // on, which is how a freshly-raised PR could vanish from the screen that
    // raised it. employeeOf falls back to the users row when the JWT predates
    // the employee_id claim.
    const requesterEmpId = b.requested_by_employee_id ?? await employeeOf(req, pool);

    await client.query('BEGIN');

    const prNumber = await prRepo.getNextNumber(client, companyId);
    const pr = await prRepo.create(client, {
      ...b,
      requested_by_employee_id: requesterEmpId,
      company_id: companyId,
      request_number: prNumber,
    });

    for (const item of items) {
      await prRepo.createItem(client, { pr_id: pr.id, ...item });
    }

    // Value the header from its line items so approval routing sees a real amount
    await prRepo.recomputeTotal(client, pr.id);

    await client.query('COMMIT');

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'procurement', recordId: pr.id,
      recordType: 'purchase_request', action: 'create',
      oldData: null, newData: pr, req,
    });

    const created = await prRepo.findById(pr.id, companyId);
    created.items = await prRepo.getItems(pr.id, null, companyId);
    res.status(201).json(created);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

router.get('/purchase-requests', requireProcurement('view'), async (req, res) => {
  try {
    const prs = await prRepo.findAll({ ...req.query, company_id: cid(req) });
    res.json(prs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/purchase-requests/export', requireProcurement('export'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, from_date, to_date } = req.query;
    const params = [];
    const conditions = ['pr.deleted_at IS NULL'];
    if (companyId) { params.push(companyId); conditions.push(`pr.company_id = $${params.length}`); }
    if (status)    { params.push(status);    conditions.push(`pr.status = $${params.length}`); }
    if (from_date) { params.push(from_date); conditions.push(`pr.request_date >= $${params.length}`); }
    if (to_date)   { params.push(to_date);   conditions.push(`pr.request_date <= $${params.length}`); }
    // total_amount was the literal `0`, so every row of this export reported a
    // ₹0 requisition regardless of its lines — a spend extract that was wrong on
    // its only money column. The header total is maintained by recomputeTotal();
    // fall back to summing the lines when an older row predates it.
    const { rows } = await pool.query(`
      SELECT pr.request_number, pr.request_date, pr.notes AS description,
             pr.priority,
             COALESCE(e.first_name||' '||e.last_name, '') AS requested_by,
             COALESCE(NULLIF(pr.total_amount, 0), (
               SELECT COALESCE(SUM(COALESCE(pri.quantity,0) * COALESCE(pri.expected_price,0)), 0)
               FROM purchase_request_items pri WHERE pri.pr_id = pr.id
             ), 0) AS total_amount,
             pr.status, pr.created_at
      FROM purchase_requests pr
      LEFT JOIN employees e ON e.id = pr.requested_by_employee_id
      WHERE ${conditions.join(' AND ')} ORDER BY pr.request_date DESC
    `, params);
    const header = 'PR No,Date,Description,Priority,Requested By,Amount,Status,Created';
    const csvRows = rows.map(r => [
      r.request_number||'', r.request_date||'', r.description||'', r.priority||'',
      r.requested_by||'', r.total_amount||0, r.status||'',
      r.created_at ? new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '',
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="purchase-requests-${Date.now()}.csv"`);
    res.send([header, ...csvRows].join('\n'));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/purchase-requests/:id', requireProcurement('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const pr = await prRepo.findById(req.params.id, companyId);
    if (!pr) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }
    pr.items = await prRepo.getItems(req.params.id, null, companyId);
    res.json(pr);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// requiredApprovalLevel / canApprove moved to ../procurement.authz.js as
// requiredBand / assertCanDecideAmount. The originals read only the caller's
// PRIMARY role, keyed on three roles that do not exist (`senior_manager`,
// `cfo`, `finance_head`), omitted `finance`/`finance_manager` entirely, and
// ignored the configured `cfo_approval_above`. See that file for detail.

router.put('/purchase-requests/:id/approve', requireProcurement('approve'), async (req, res) => {
  try {
    const companyId = cid(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the requisition first: two approvers clicking together would
      // otherwise both read 'pending_approval', both write 'approved', and both
      // fire an approval notification for one decision.
      await client.query('SELECT id FROM purchase_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      const oldPr = await prRepo.findById(req.params.id, companyId, client);
      if (!oldPr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'PR not found' }); }

      // Idempotent, and state-checked: an already-approved requisition is
      // returned as it stands, and one that was rejected or already converted
      // cannot be quietly approved on top.
      if (oldPr.status === 'approved') {
        await client.query('ROLLBACK');
        return res.json({ ...oldPr, already_approved: true });
      }
      const move = assertTransition('purchase_request', oldPr.status, 'approved');
      if (move) { await client.query('ROLLBACK'); return res.status(move.status).json(move.body); }

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
      const pr = await prRepo.updateStatus(client, req.params.id, 'approved', approverEmpId, { companyId });
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

router.put('/purchase-requests/:id/reject', requireProcurement('approve'), async (req, res) => {
  try {
    const companyId = cid(req);
    const actorId = req.user.userId ?? req.user.id;
    const { remarks } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM purchase_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      const oldPr = await prRepo.findById(req.params.id, companyId, client);
      if (!oldPr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'PR not found' }); }

      if (oldPr.status === 'rejected') {
        await client.query('ROLLBACK');
        return res.json({ ...oldPr, already_rejected: true });
      }
      const move = assertTransition('purchase_request', oldPr.status, 'rejected');
      if (move) { await client.query('ROLLBACK'); return res.status(move.status).json(move.body); }

      // Rejecting requires the same authority as approving. This route had no
      // check at all, so anyone who could not approve a PR could still reject
      // it — a denial-of-procurement with the same commercial weight.
      const settings = await getProcSettings(cid(req));
      const decide = assertCanDecideAmount(req, oldPr.total_amount, settings, 'reject');
      if (decide) { await client.query('ROLLBACK'); return res.status(decide.status).json(decide.body); }

      // `actorId` is a users.id and approved_by FKs employees(id) — passing it
      // here was the stock_ledger.created_by trap again. It did not surface as a
      // 500 only because updateStatus quietly ignored the argument on any status
      // other than 'approved', which meant a rejection recorded neither who made
      // it nor why: `rejection_reason` is a real column that nothing had ever
      // written, so the requester saw their PR turn red with no explanation.
      const rejecterEmpId = req.user?.employee_id ?? null;
      const pr = await prRepo.updateStatus(client, req.params.id, 'rejected', rejecterEmpId, {
        reason: (remarks || '').trim() || null,
        companyId,
      });
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
router.patch('/purchase-requests/:id/convert-to-po', requireProcurement('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM purchase_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      const pr = await prRepo.findById(req.params.id, companyId, client);
      if (!pr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase request not found' }); }

      // ── Idempotency + authorisation-by-state ───────────────────────────────
      // Nothing checked the requisition's status, so this route would convert a
      // PR that was still awaiting approval — creating a purchase order for
      // spend nobody had signed off — or one that had been REJECTED, or one
      // already converted. Repeated calls raised a fresh PO every time, so a
      // double-clicked Convert produced two orders for one requirement, each of
      // which could then be approved and received.
      if (pr.status === 'converted_to_po') {
        const { rows: [existingPo] } = await client.query(
          `SELECT id, po_number, supplier_id FROM purchase_orders
            WHERE pr_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`,
          [pr.id]
        );
        await client.query('ROLLBACK');
        if (existingPo) {
          return res.status(200).json({
            po_id: existingPo.id, po_number: existingPo.po_number,
            supplier_id: existingPo.supplier_id, already_converted: true,
          });
        }
        return res.status(409).json({ error: 'This requisition is already marked as converted but no purchase order was found against it. Investigate before converting again.' });
      }
      const move = assertTransition('purchase_request', pr.status, 'converted_to_po');
      if (move) { await client.query('ROLLBACK'); return res.status(move.status).json(move.body); }

      // Carry the requisition's line items onto the PO — a converted PO must not
      // be an empty ₹0 header (which would break GRN receipt and 3-way match).
      // Seed each PO line's rate from the requested expected_price, and derive
      // the header subtotal/total from the lines so the PO is self-consistent.
      const prItems  = await prRepo.getItems(pr.id, client, companyId);

      // ── Tax ────────────────────────────────────────────────────────────────
      // This route used to write tax_amount 0 on the header AND tax_rate 0 on
      // every line, while the manual PO drawer computes GST per line from the
      // rate the buyer picks. So the same two lines keyed by hand produced a
      // ₹1,180 order and converted from a requisition produced a ₹1,000 one.
      //
      // That is not a cosmetic difference. The vendor invoices gross, the
      // invoice leg of the three-way match compares that gross against
      // po.total_amount, and the gap is the whole tax — measured live at
      // "invoice leg differs from the order by 18.00% (tolerance 3%)". With
      // block_payment_on_mismatch on (its purpose), EVERY requisition-driven
      // order's invoice was blocked from becoming a payable.
      //
      // A requisition line carries no tax rate of its own — purchase_request_items
      // has quantity and expected_price and nothing else — so the rate comes
      // from the component master, through the shared resolver.
      const itemIds = [...new Set(prItems.map(it => it.item_id).filter(x => x != null))];
      const taxByItem = new Map();
      if (itemIds.length) {
        const { rows: taxRows } = await client.query(
          `SELECT id, gst_rate, default_gst_rate FROM inventory_items WHERE id = ANY($1::int[])`,
          [itemIds]
        );
        for (const r of taxRows) taxByItem.set(String(r.id), resolveGstRate(r));
      }

      const poLines = prItems.map((it) => {
        const quantity = parseFloat(it.quantity) || 0;
        const rate     = parseFloat(it.expected_price) || 0;
        const taxRate  = taxByItem.get(String(it.item_id)) ?? 0;
        const taxable  = quantity * rate;
        const tax      = taxable * taxRate / 100;
        return {
          item_id:      it.item_id ?? null,
          quantity,
          rate,
          tax_rate:     taxRate,
          tax_amount:   Number(tax.toFixed(2)),
          total_amount: Number((taxable + tax).toFixed(2)),
          taxable,
        };
      });

      const subtotal = Number(poLines.reduce((s, l) => s + l.taxable, 0).toFixed(2));
      const taxTotal = Number(poLines.reduce((s, l) => s + l.tax_amount, 0).toFixed(2));

      // Automation Opportunity Audit §5.2 — a caller-supplied supplier_id
      // always wins; only when the buyer left it blank do we suggest the
      // lowest-quoting vendor from an RFQ raised for this PR (rfqs.pr_id is
      // varchar while purchase_requests.id is integer — real schema drift,
      // cast rather than assume). A vendor can only quote once per RFQ
      // (rfq_quotes has one row per rfq_id/vendor_id), so ordering by
      // total_amount (falling back to unit_price) and taking the first row
      // is the lowest total quote, matching the same MIN() the /rfqs list
      // endpoint already surfaces. This is a suggestion, not a lock — the
      // buyer still reviews/overrides the resulting draft PO before it goes
      // for approval.
      let supplierId = req.body.supplier_id || null;
      let autoSelectedSupplier = false;
      if (!supplierId) {
        const { rows: quoteRows } = await client.query(
          `SELECT rq.vendor_id
           FROM rfqs r
           JOIN rfq_quotes rq ON rq.rfq_id = r.id
           WHERE r.pr_id = $1::text AND rq.vendor_id IS NOT NULL
           ORDER BY COALESCE(rq.total_amount, rq.unit_price) ASC NULLS LAST
           LIMIT 1`,
          [String(pr.id)]
        );
        if (quoteRows[0]) {
          supplierId = quoteRows[0].vendor_id;
          autoSelectedSupplier = true;
        }
      }

      const poNumber = await poRepo.getNextNumber(client, companyId);
      // A requisition carries no supplier commitment — there was no quote. The
      // vendor's own lead time is the only due date available, and it is an
      // assumption, so it is recorded as one. Without this the order goes out
      // with expected_delivery_date NULL and the supplier's OTD has nothing at
      // all to be measured against. See migration 20260910000006.
      const { rows: [convVendor] } = await client.query(
        `SELECT lead_time_days FROM vendors WHERE id = $1`, [supplierId]);
      const convDays = parseInt(convVendor?.lead_time_days, 10) > 0
        ? parseInt(convVendor.lead_time_days, 10) : null;
      const convExpected = convDays == null ? null
        : new Date(Date.now() + convDays * 86400000).toISOString().slice(0, 10);

      const po = await poRepo.create(client, {
        po_number:      poNumber,
        pr_id:          pr.id,
        supplier_id:    supplierId,
        order_date:     new Date().toISOString().slice(0, 10),
        expected_delivery_date:  convExpected,
        expected_delivery_basis: convExpected ? 'lead_time' : null,
        subtotal,
        tax_amount:     taxTotal,
        total_amount:   Number((subtotal + taxTotal).toFixed(2)),
        notes:          pr.notes,
        // purchase_orders.created_by FKs employees(id), not users(id) — same
        // recurring bug as stock_ledger.created_by (project_stock_ledger_created_by_fk).
        // Surfaced live while verifying §5.2: this 500'd on every convert for
        // any actor without a matching employees row, including super_admin.
        //
        // employeeOf(), not the raw claim. `req.user.employee_id` is only
        // present on tokens minted after that field was added, and it is the
        // recipient the PO-approval notification is addressed to — so a token
        // without it produced an order with created_by NULL, and then
        // `if (settings.notify_po_approval && oldPo.created_by)` silently
        // declined to notify anyone while Settings still read "on". employeeOf
        // falls back to the users row, which is what makes the toggle mean
        // something for a legacy session.
        created_by:     await employeeOf(req, pool),
        company_id:     cid(req),
      });

      for (const line of poLines) {
        const { taxable, ...item } = line;   // taxable is a working value, not a column
        await poRepo.createItem(client, { po_id: po.id, ...item });
      }

      await prRepo.updateStatus(client, pr.id, 'converted_to_po', null, { companyId });
      await client.query('COMMIT');

      logAudit({
        userId: req.user?.userId ?? req.user?.id,
        module: 'procurement', recordId: po.id,
        recordType: 'purchase_order', action: 'create',
        oldData: null, newData: po, req,
      });

      res.status(201).json({
        po_id: po.id,
        po_number: po.po_number,
        supplier_id: supplierId,
        auto_selected_supplier: autoSelectedSupplier,
      });
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
router.get('/purchase-orders/stats', requireProcurement('view'), async (req, res) => {
  try {
    const stats = await poRepo.getStats(cid(req));
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /procurement/tco/advisory — "compare before purchasing" for a PO raised
 * WITHOUT an RFQ.
 *
 * An RFQ has competing quotes to rank, so §128 could rank them. A PO typed
 * straight into the form has exactly one vendor and no competition, which is
 * how a direct PO stayed costed on rate alone. This scores the chosen vendor
 * against every OTHER vendor known to supply the same components — from the
 * price book, past POs, RFQ quotes and the price log — and reports whether a
 * cheaper total cost exists.
 *
 * Body: { vendor_id, lines: [{ item_id, quantity, rate }] }
 *
 * Advisory, never blocking. There are good reasons to buy from a dearer source
 * and this route does not know them; it only makes sure the buyer is not
 * unaware of the alternative.
 */
router.post('/tco/advisory', requireProcurement('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const vendorId  = Number(req.body?.vendor_id);
    const lines     = Array.isArray(req.body?.lines) ? req.body.lines : [];

    if (!Number.isFinite(vendorId)) return res.status(422).json({ error: 'vendor_id is required' });

    const params = await loadTcoParams(companyId);
    if (!params.tco_enabled) {
      return res.json({ tco_enabled: false, lines: [], totals: null, advisory: null });
    }

    const priced = lines
      .map(l => ({ item_id: Number(l.item_id), quantity: parseFloat(l.quantity), rate: parseFloat(l.rate) }))
      .filter(l => Number.isFinite(l.item_id) && l.quantity > 0);

    if (!priced.length) {
      return res.json({ tco_enabled: true, lines: [], totals: null, advisory: null,
        note: 'No PO line carried both a catalogued component and a quantity, so nothing could be costed.' });
    }

    const results = [];
    for (const line of priced) {
      const alt = await alternativesForItem(line.item_id, companyId);
      // The chosen vendor is costed at the rate ACTUALLY typed on the PO, not
      // at whatever the price book remembers — that is the commitment being
      // made. Alternatives are costed at their own best known price.
      const chosenKnown = alt.find(a => a.vendor_id === vendorId);
      const options = [
        {
          ...(chosenKnown || { vendor_id: vendorId, vendor_name: null }),
          unit_price: Number.isFinite(line.rate) && line.rate > 0
            ? line.rate
            : (chosenKnown?.unit_price ?? null),
          is_chosen: true,
        },
        ...alt.filter(a => a.vendor_id !== vendorId),
      ].map(o => ({ ...o, quantity: line.quantity }));

      const ranked = rankOptions(options, params);
      const chosen = ranked.options.find(o => o.is_chosen);
      const best   = ranked.options.find(o => o.is_lowest_tco);

      results.push({
        item_id: line.item_id,
        item_name: alt[0]?.item_name ?? null,
        quantity: line.quantity,
        rate: line.rate,
        chosen_vendor_id: vendorId,
        chosen_tco_total: chosen?.tco?.tco_total ?? null,
        chosen_tco_per_unit: chosen?.tco?.tco_per_unit ?? null,
        chosen_confidence: chosen?.tco?.confidence ?? null,
        chosen_assumptions: chosen?.tco?.assumptions ?? [],
        alternative_count: Math.max(0, ranked.options.length - 1),
        best_vendor_id: best && !best.is_chosen ? best.vendor_id : null,
        best_vendor_name: best && !best.is_chosen ? best.vendor_name : null,
        best_tco_total: best && !best.is_chosen ? best.tco?.tco_total ?? null : null,
        saving: best && !best.is_chosen && chosen?.tco?.tco_total != null && best.tco?.tco_total != null
          ? +(chosen.tco.tco_total - best.tco.tco_total).toFixed(2)
          : 0,
      });
    }

    const chosenTotal = results.reduce((s, r) => s + (r.chosen_tco_total || 0), 0);
    const saving      = results.reduce((s, r) => s + (r.saving || 0), 0);
    const better      = results.filter(r => r.saving > 0);

    res.json({
      tco_enabled: true,
      lines: results,
      totals: {
        chosen_tco_total: +chosenTotal.toFixed(2),
        potential_saving: +saving.toFixed(2),
        lines_with_a_cheaper_source: better.length,
      },
      // Null when nothing better was found — an advisory that always says
      // something gets dismissed, and then it says nothing.
      advisory: better.length
        ? {
            message: `${better.length} of ${results.length} line${results.length === 1 ? '' : 's'} has a lower total cost from another approved vendor.`,
            saving: +saving.toFixed(2),
            lines: better.map(b => ({
              item_id: b.item_id, item_name: b.item_name,
              better_vendor: b.best_vendor_name, saving: b.saving,
            })),
          }
        : null,
      basis: tcoBasis(params, { source: 'direct purchase order (no RFQ)' }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * Every vendor known to supply one component, with the best price we know and
 * the performance we have measured — the same four-source fold and the same
 * observed-beats-master-data rule as /items/:id/sourcing, reduced to what the
 * TCO engine needs.
 */
async function alternativesForItem(itemId, companyId) {
  const scoped = companyId == null ? '' : ' AND po.company_id = $2';
  const args   = companyId == null ? [itemId] : [itemId, companyId];

  const [book, poAgg, item, perf] = await Promise.all([
    pool.query(
      `SELECT ivp.vendor_id,
              ivp.unit_price * (1 - COALESCE(ivp.discount_pct,0)/100.0) AS net_price,
              ivp.moq, ivp.pack_size, ivp.lead_time_days, ivp.tax_pct,
              ivp.freight_per_unit, ivp.packaging_per_unit, ivp.duty_pct,
              ivp.tooling_cost, ivp.scrap_rate_pct
         FROM item_vendor_prices ivp
        WHERE ivp.item_id = $1 AND ivp.deleted_at IS NULL`,
      [itemId]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT po.supplier_id AS vendor_id,
              (ARRAY_AGG(poi.rate ORDER BY po.order_date DESC NULLS LAST, po.id DESC))[1] AS last_rate
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.po_id AND po.deleted_at IS NULL
        WHERE poi.item_id = $1 AND poi.rate > 0
          AND LOWER(COALESCE(po.status,'')) NOT IN ('cancelled','rejected')${scoped}
        GROUP BY po.supplier_id`,
      args
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT item_name, gst_rate, default_gst_rate, holding_cost_pct FROM inventory_items WHERE id = $1`,
      [itemId]
    ).catch(() => ({ rows: [] })),
    loadVendorPerformance(itemId, companyId),
  ]);

  const demand = await loadAnnualDemand(itemId, companyId);
  const it = item.rows[0] || {};
  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const itemTax = resolveGstRate(it);

  const byVendor = new Map();
  for (const r of book.rows) {
    byVendor.set(Number(r.vendor_id), {
      vendor_id: Number(r.vendor_id), unit_price: n(r.net_price), price_source: 'Price Book',
      moq: n(r.moq), pack_size: n(r.pack_size), lead_time_days: r.lead_time_days,
      lead_time_basis: r.lead_time_days != null ? 'quoted' : 'assumed',
      tax_pct: n(r.tax_pct) ?? itemTax,
      freight_per_unit: n(r.freight_per_unit), packaging_per_unit: n(r.packaging_per_unit),
      duty_pct: n(r.duty_pct), tooling_cost: n(r.tooling_cost), scrap_rate_pct: n(r.scrap_rate_pct),
    });
  }
  for (const r of poAgg.rows) {
    const k = Number(r.vendor_id);
    if (byVendor.has(k)) continue;   // a negotiated price outranks what we last paid
    byVendor.set(k, { vendor_id: k, unit_price: n(r.last_rate), price_source: 'Last PO', tax_pct: itemTax });
  }
  if (!byVendor.size) return [];

  const { rows: vRows } = await pool.query(
    `SELECT id, vendor_name, lead_time_days, payment_terms_days, on_time_pct,
            defect_rate, is_single_source
       FROM vendors WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
    [[...byVendor.keys()]]
  );
  const vMap = Object.fromEntries(vRows.map(v => [v.id, v]));

  return [...byVendor.values()].map(o => {
    const v  = vMap[o.vendor_id] || {};
    const pf = perf.get(o.vendor_id) || {};
    return {
      ...o,
      item_name: it.item_name ?? null,
      vendor_name: v.vendor_name || `Vendor #${o.vendor_id}`,
      lead_time_days: o.lead_time_days ?? v.lead_time_days ?? null,
      payment_terms_days: v.payment_terms_days ?? null,
      // Same rule as everywhere else: a hand-maintained 0 means never measured.
      reject_rate_pct: pf.reject_rate_pct ?? masterRate(o.scrap_rate_pct) ?? masterRate(v.defect_rate),
      reject_basis:    pf.reject_rate_pct != null ? 'observed' : 'estimated',
      on_time_pct:     pf.on_time_pct ?? masterRate(v.on_time_pct),
      on_time_basis:   pf.on_time_pct != null ? 'observed' : 'estimated',
      freight_pct_observed: pf.freight_pct_observed ?? null,
      is_single_source: !!v.is_single_source,
      annual_demand_qty: demand.annual_demand_qty,
      holding_cost_pct: n(it.holding_cost_pct),
    };
  }).filter(o => o.unit_price != null && o.unit_price > 0);
}

/**
 * Normalise a purchase-order line from either field vocabulary.
 *
 * The PO drawer posts `lines[]` shaped for the buyer's screen — `unit_price`,
 * `gst_rate`, `taxable_amount`, `gst_amount`, `amount` — while this route read
 * `req.body.items` with the column names (`rate`, `tax_rate`, `total_amount`).
 * Nothing bridged them, so `req.body.items` was undefined on every request from
 * the app and the handler threw "req.body.items is not iterable" → 500. Manual
 * PO creation had therefore never once succeeded; the only POs in the system
 * came from convert-to-PO and the RFQ award path, which build their lines
 * server-side. Accept both vocabularies rather than renaming one side, so the
 * integrations already posting `items` keep working.
 *
 * Money is recomputed here from quantity x rate x tax and never taken from the
 * client: the drawer's totals are a display convenience, and a PO header that
 * disagrees with the sum of its own lines breaks three-way match downstream.
 */
function normalisePoLine(raw) {
  const quantity = parseFloat(raw.quantity ?? raw.qty ?? 0) || 0;
  const rate     = parseFloat(raw.rate ?? raw.unit_price ?? 0) || 0;
  const taxRate  = parseFloat(raw.tax_rate ?? raw.gst_rate ?? 0) || 0;
  const taxable  = quantity * rate;
  const tax      = taxable * taxRate / 100;
  return {
    item_id:      raw.item_id ? parseInt(raw.item_id, 10) : null,
    quantity,
    rate,
    tax_rate:     taxRate,
    tax_amount:   Number(tax.toFixed(2)),
    total_amount: Number((taxable + tax).toFixed(2)),
    taxable,
  };
}

router.post('/purchase-orders', requireProcurement('add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const rawLines = Array.isArray(b.items) ? b.items
                   : Array.isArray(b.lines) ? b.lines
                   : null;
    if (!rawLines || !rawLines.length) {
      return res.status(400).json({ error: 'At least one line item is required.' });
    }
    if (!b.supplier_id) {
      return res.status(400).json({ error: 'A supplier is required.' });
    }

    const lines = rawLines.map(normalisePoLine).filter(l => l.quantity > 0);
    if (!lines.length) {
      return res.status(400).json({ error: 'Every line item needs a quantity greater than zero.' });
    }
    const missingItem = lines.find(l => !l.item_id);
    if (missingItem) {
      return res.status(400).json({ error: 'Every line item must reference a component.' });
    }

    const subtotal = lines.reduce((s, l) => s + l.taxable, 0);
    const taxTotal = lines.reduce((s, l) => s + l.tax_amount, 0);

    const companyId = cid(req);
    await client.query('BEGIN');

    // Where the spend is charged. Both are optional, and both are checked
    // against the caller's company when supplied — an unchecked id here would
    // let one tenant book spend against another's project or cost centre, and
    // the FK alone only proves the row exists, not that it is theirs.
    const projectId    = Number.isFinite(parseInt(b.project_id, 10))     ? parseInt(b.project_id, 10)     : null;
    const costCentreId = Number.isFinite(parseInt(b.cost_center_id, 10)) ? parseInt(b.cost_center_id, 10) : null;
    if (projectId != null) {
      const { rows: [p] } = await client.query(
        `SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
        [projectId, companyId]);
      if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Project not found.' }); }
    }
    if (costCentreId != null) {
      const { rows: [c] } = await client.query(
        `SELECT id FROM cost_centers WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
        [costCentreId, companyId]);
      if (!c) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Cost centre not found.' }); }
    }

    // The sourcing decision in force for what is being bought. Advisory, never
    // blocking — see sourcingAdvisory.service.js. Recorded on the order so the
    // strategy and the spend it governs are finally the same record.
    const advisory = await resolveSourcingAdvisory(client, {
      companyId, itemIds: lines.map((l) => l.item_id), vendorId: b.supplier_id,
    });

    const poNumber = await poRepo.getNextNumber(client, companyId);
    const po = await poRepo.create(client, {
      ...b,
      project_id:     projectId,
      cost_center_id: costCentreId,
      sourcing_strategy_id:       advisory.strategy?.id ?? null,
      followed_sourcing_strategy: advisory.followed,
      // The drawer calls it expected_date; the column is expected_delivery_date.
      // Unmapped, every manually-raised PO would have carried a NULL promise date
      // — the field the overdue-delivery report and MRP's due dates both read.
      expected_delivery_date: b.expected_delivery_date || b.expected_date || null,
      subtotal:     Number(subtotal.toFixed(2)),
      tax_amount:   Number(taxTotal.toFixed(2)),
      total_amount: Number((subtotal + taxTotal).toFixed(2)),
      po_number:    poNumber,
      company_id:   companyId,
      // purchase_orders.created_by FKs employees(id), not users(id) — and
      // employeeOf() rather than the raw claim, so a token minted before
      // employee_id existed still yields a real recipient for the approval
      // notification instead of a NULL that silences it. See the same note on
      // the convert-to-po path.
      created_by:   await employeeOf(req, pool),
    });

    for (const line of lines) {
      const { taxable, ...item } = line;   // taxable is a working value, not a column
      await poRepo.createItem(client, { po_id: po.id, ...item });
    }

    if (b.pr_id) {
      await prRepo.updateStatus(client, b.pr_id, 'converted_to_po', null, { companyId });
    }

    await client.query('COMMIT');

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'procurement', recordId: po.id,
      recordType: 'purchase_order', action: 'create',
      oldData: null, newData: po, req,
    });

    const created = await poRepo.findById(po.id, companyId);
    created.items = await poRepo.getItems(po.id, companyId);
    // Returned as well as stored, so the buyer sees the strategy at the moment
    // of the decision rather than discovering it in a report afterwards.
    created.sourcing_advisory = advisory;
    res.status(201).json(created);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

router.get('/purchase-orders', requireProcurement('view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const pos = await poRepo.findAll({ ...req.query, company_id: companyId });
    res.json(pos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/purchase-orders/export', requireProcurement('export'), async (req, res) => {
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

router.get('/purchase-orders/:id', requireProcurement('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const po = await poRepo.findById(req.params.id, companyId);
    if (!po) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }
    po.items = await poRepo.getItems(req.params.id, companyId);
    res.json(po);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/purchase-orders/:id/status', requireProcurement('edit', 'store_keeper'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_PO_STATUSES.has(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${[...VALID_PO_STATUSES].join(', ')}` });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const companyId = cid(req);
      // FOR UPDATE via findById's client is not enough on its own — lock the row
      // so two concurrent status writes cannot both read the same 'from'.
      await client.query('SELECT id FROM purchase_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      const oldPo = await poRepo.findById(req.params.id, companyId, client);
      if (!oldPo) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase order not found' }); }

      // Where the order IS decides where it may go. Checking only that the
      // destination is spelled correctly let a cancelled order be approved, a
      // draft order be marked received, and a received order be pushed back to
      // draft — all 200s. See procurement.stateMachine.js.
      const move = assertTransition('purchase_order', oldPo.status, status);
      if (move) { await client.query('ROLLBACK'); return res.status(move.status).json(move.body); }
      if (isNoop(oldPo.status, status)) { await client.query('ROLLBACK'); return res.json(oldPo); }

      const po = await poRepo.updateStatus(client, req.params.id, status, companyId);
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

router.patch('/purchase-orders/:id/send', requireProcurement('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM purchase_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      const oldPo = await poRepo.findById(req.params.id, companyId, client);
      // ROLLBACK before returning: an early `return` inside an open BEGIN left the
      // pooled connection idle-in-transaction, and the next request to draw it
      // inherited the stale transaction.
      if (!oldPo) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase order not found' }); }

      // Idempotent: re-sending an order already with the vendor returns it
      // rather than issuing a second copy of the same commitment.
      if (oldPo.status === 'sent') { await client.query('ROLLBACK'); return res.json(oldPo); }
      const move = assertTransition('purchase_order', oldPo.status, 'sent');
      if (move) { await client.query('ROLLBACK'); return res.status(move.status).json(move.body); }

      const po = await poRepo.updateStatus(client, req.params.id, 'sent', companyId);
      await client.query('COMMIT');
      logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'procurement', recordId: po.id, recordType: 'purchase_order', action: 'send', oldData: oldPo, newData: po, req });
      res.json(po);
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.patch('/purchase-orders/:id/approve', requireProcurement('approve'), async (req, res) => {
  try {
    const companyId = cid(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // FOR UPDATE serialises two approvers clicking at the same moment: the
      // second blocks here, then reads status 'approved' and takes the
      // already-approved branch instead of running the handler a second time.
      await client.query('SELECT id FROM purchase_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      const oldPo = await poRepo.findById(req.params.id, companyId, client);
      if (!oldPo) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase order not found' }); }

      // ── Idempotency ────────────────────────────────────────────────────────
      // Nothing checked the current status, so a double-click ran the whole
      // handler twice: two audit rows, and — because the tail of this route
      // emails the order to the supplier — A SECOND PURCHASE ORDER SENT TO THE
      // VENDOR for the same commitment. That is how one order becomes two
      // deliveries and two invoices.
      if (oldPo.status === 'approved') {
        await client.query('ROLLBACK');
        return res.json({ ...oldPo, already_approved: true });
      }
      const move = assertTransition('purchase_order', oldPo.status, 'approved');
      if (move) { await client.query('ROLLBACK'); return res.status(move.status).json(move.body); }

      // An order with no lines is not an order. Approving one commits the
      // company to a zero-value document that GRN cannot receive against and
      // 3-way match cannot value.
      const { rows: [lineCount] } = await client.query(
        'SELECT COUNT(*)::int AS n FROM purchase_order_items WHERE po_id = $1', [req.params.id]
      );
      if (!lineCount.n) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'This purchase order has no line items — there is nothing to approve. Add at least one line first.' });
      }
      if (!oldPo.supplier_id) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'This purchase order has no supplier. Set the vendor before approving it.' });
      }

      // Enforce PO approval limits
      const settings = await getProcSettings(cid(req));
      const amount   = parseFloat(oldPo.total_amount || 0);
      const required = requiredBand(amount, settings);
      const decide   = assertCanDecideAmount(req, amount, settings, 'approve');
      if (decide) {
        await client.query('ROLLBACK');
        return res.status(decide.status).json(decide.body);
      }

      // Check min vendor rating if supplier set. `avgRating > 0 &&` used to
      // exempt a vendor with zero rows in vendor_ratings from this check
      // entirely (COALESCE defaults every vendors.*_rating column to 0, so a
      // never-rated vendor and a genuinely-zero-rated one were indistinguishable
      // and both read as avgRating===0) — silently letting exactly the
      // highest-risk, no-track-record vendors bypass the gate every time.
      if (oldPo.supplier_id && settings.min_vendor_rating > 0) {
        const { rows: vRows } = await pool.query(
          `SELECT COALESCE(quality_rating,0) + COALESCE(delivery_rating,0) + COALESCE(price_rating,0) AS total_rating,
                  EXISTS (SELECT 1 FROM vendor_ratings WHERE vendor_id = vendors.id) AS has_history
           FROM vendors WHERE id=$1`,
          [oldPo.supplier_id]
        );
        const avgRating = vRows[0] ? parseFloat(vRows[0].total_rating) / 3 : 0;
        const hasHistory = vRows[0]?.has_history || false;
        if (!hasHistory) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `This vendor has no rating history yet — minimum rating of ${settings.min_vendor_rating} is required before their first PO can be approved. Rate the vendor or override in Settings.` });
        }
        if (avgRating < settings.min_vendor_rating) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Vendor rating (${avgRating.toFixed(1)}) is below minimum required (${settings.min_vendor_rating}). Update vendor rating or override in Settings.` });
        }
      }

      const po = await poRepo.updateStatus(client, req.params.id, 'approved', companyId);
      await client.query('COMMIT');
      logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'procurement', recordId: po.id, recordType: 'purchase_order', action: 'approve', oldData: oldPo, newData: po, req });

      // Send notification if enabled. notifyWorkflowEvent's 'approved' event
      // notifies ctx.submitterUserId by default — never passed here, so this
      // always resolved to an empty recipient list and silently no-op'd
      // despite the toggle showing "on" in Settings. recipientIds (employees.id,
      // resolved to a login internally) is the override path; oldPo.created_by
      // is the PO's requester in that space, per purchase_orders.created_by FK.
      if (settings.notify_po_approval && oldPo.created_by) {
        notifyWorkflowEvent('approved', { module: 'Purchase Order', recordId: po.id, recipientIds: [oldPo.created_by] });
      }

      // Automation Opportunity Audit §5.4 — the notification above is
      // internal-only (WorkflowNotificationService never reaches an
      // external party); this is the separate external leg. Fire-and-forget,
      // same contract as sendPurchaseOrderToVendor() itself (never throws) —
      // a delivery failure must not affect a PO approval that already
      // committed. No PDF pipeline exists for POs, so this sends the same
      // header + line items poRepo.findById/getItems already expose.
      if (po.supplier_id) {
        poRepo.findById(po.id, companyId).then(async (fullPo) => {
          if (!fullPo?.supplier_email) return;
          const items = await poRepo.getItems(po.id, companyId);
          await sendPurchaseOrderToVendor(fullPo.supplier_email, {
            poNumber: fullPo.po_number,
            vendorName: fullPo.supplier_name,
            items,
            totalAmount: fullPo.total_amount,
            expectedDeliveryDate: fullPo.expected_delivery_date,
            termsConditions: fullPo.terms_conditions,
          });
        }).catch((err) => console.error('[procurement] vendor PO email failed:', err.message));
      }

      res.json({ ...po, approval_level: required });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.patch('/purchase-orders/:id/cancel', requireProcurement('approve'), async (req, res) => {
  try {
    const companyId = cid(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM purchase_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      const oldPo = await poRepo.findById(req.params.id, companyId, client);
      if (!oldPo) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase order not found' }); }

      if (oldPo.status === 'cancelled') { await client.query('ROLLBACK'); return res.json({ ...oldPo, already_cancelled: true }); }

      // An order with goods already booked against it cannot simply be
      // cancelled: the stock is in the warehouse and, once matched, payable.
      // Cancelling it left inventory and an AP liability attached to a document
      // that says the order never happened. Reverse the receipt (RTV) first.
      const { rows: [recv] } = await client.query(
        `SELECT COALESCE(SUM(COALESCE(received_quantity,0)),0)::numeric AS qty
           FROM purchase_order_items WHERE po_id = $1`, [req.params.id]
      );
      if (parseFloat(recv.qty) > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Purchase order ${oldPo.po_number} already has ${recv.qty} unit(s) received against it and cannot be cancelled. Return the goods to the vendor (RTV) first, or close the order short instead.`,
          code: 'PO_HAS_RECEIPTS',
        });
      }
      const move = assertTransition('purchase_order', oldPo.status, 'cancelled');
      if (move) { await client.query('ROLLBACK'); return res.status(move.status).json(move.body); }

      // Cancelling a live PO is as consequential as approving it — it can halt
      // a delivery already in motion — so it takes the same authority. This
      // route was unchecked, which meant a caller blocked from approving a PO
      // could simply cancel it instead.
      const settings = await getProcSettings(cid(req));
      const decide = assertCanDecideAmount(req, oldPo.total_amount, settings, 'cancel');
      if (decide) { await client.query('ROLLBACK'); return res.status(decide.status).json(decide.body); }

      const po = await poRepo.updateStatus(client, req.params.id, 'cancelled', companyId);
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
router.post('/grn', requireProcurement('add', 'store_keeper'), async (req, res) => {
  try {
    const grn = await grnService.createGRN(
      {
        ...req.body,
        company_id: cid(req),
        // The audit row needs the ACTOR's users.id; the stock ledger needs the
        // actor's employees.id. They are different id spaces and were being
        // conflated — the service was handed only the employee id and then
        // logged it as a user id, so every GRN audit row named the wrong person
        // or nobody. Pass both, each labelled.
        actor_user_id: req.user?.userId ?? req.user?.id ?? null,
        // An Idempotency-Key header is the standard way a client makes a POST
        // retry-safe; accept it from the body too so the browser fetch does not
        // need a custom header.
        idempotency_key: req.get('Idempotency-Key') || req.body?.idempotency_key || null,
      },
      // stock_ledger.created_by FKs employees(id), not users(id) — see
      // project_stock_ledger_created_by_fk memory; a users.id here FK-violates
      // for any actor without a matching employees row (e.g. super_admin).
      // employeeOf() also recovers the link from users.employee_id when the JWT
      // predates the claim, which req.user.employee_id alone could not.
      await employeeOf(req, pool)
    );

    // Send notification if enabled. This used to call notifyWorkflowEvent('received', ...)
    // — 'received' isn't a key in EVENT_MAP, so `def` came back undefined and the
    // call returned immediately every time, silently no-op'ing regardless of the
    // toggle. Fixed key is 'goods_received'; recipient is the PO's requester
    // (purchase_orders.created_by, an employees.id — same FK as PO-approval above).
    const settings = await getProcSettings(cid(req)).catch(() => PROC_DEFAULTS);
    if (settings.notify_grn_receipt && grn.po_id) {
      const { rows: poRows } = await pool.query('SELECT created_by, po_number FROM purchase_orders WHERE id=$1', [grn.po_id]);
      if (poRows[0]?.created_by) {
        notifyWorkflowEvent('goods_received', {
          module: 'Goods Receipt',
          recordId: grn.id,
          recipientIds: [poRows[0].created_by],
          context: { poNumber: poRows[0].po_number },
        });
      }
    }

    // Fire-and-forget: check low stock for each received item
    const wid = req.body.warehouse_id;
    if (wid && Array.isArray(req.body.items)) {
      for (const item of req.body.items) {
        checkAndCreateAlerts(item.item_id, wid);
      }
    }

    // Automation Opportunity Audit §5.6 — three-way match itself was already
    // fully automatic once invoked (variance classification, auto-bill on
    // match); the only manual step was a human calling POST /three-way-match
    // separately after the GRN. "Invoice already on file" here means the
    // receiving clerk had it in hand at receipt time and included it in this
    // same request — goods_receipt_notes has no invoice columns of its own to
    // check after the fact, so vendor_invoice_no's presence in this request
    // body IS "on file". A match failure (e.g. no PO total yet) must not
    // undo a GRN that already committed.
    if (grn.po_id && req.body.vendor_invoice_no) {
      try {
        await createThreeWayMatchRecord(cid(req), {
          po_id: grn.po_id,
          grn_id: grn.id,
          vendor_invoice_no: req.body.vendor_invoice_no,
          vendor_invoice_date: req.body.vendor_invoice_date,
          vendor_invoice_amount: req.body.vendor_invoice_amount,
        });
      } catch (err) {
        console.error(`[procurement] auto three-way-match failed for GRN ${grn.id}:`, err.message);
      }
    }

    // A replayed request did not create anything, so it is not a 201.
    res.status(grn?.idempotent_replay ? 200 : 201).json(grn);
  } catch (error) {
    // The service raises 400/404/422 for a bad receipt (over-receipt beyond
    // tolerance, a line that is not on the PO, a rejected qty above the received
    // qty). Reporting those as 500 would tell the storekeeper the system broke
    // when in fact the receipt was refused for a stated reason they can act on.
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/grn', requireProcurement('view', 'store_keeper'), async (req, res) => {
  try {
    const grns = await grnService.getGRNs({ ...req.query, company_id: cid(req) });
    res.json(grns);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// GRN EXPORT
// =====================================================
router.get('/grn/export', requireProcurement('export', 'store_keeper'), async (req, res) => {
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

router.get('/grn/:id', requireProcurement('view', 'store_keeper'), async (req, res) => {
  try {
    const grn = await grnService.getGRNById(req.params.id, cid(req));
    if (!grn) {
      return res.status(404).json({ error: 'GRN not found' });
    }
    res.json(grn);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// The receipt lifecycle. `goods_receipt_notes.status` is a bare varchar with no
// check constraint, and this route wrote whatever arrived in the body: a probe
// set a GRN to the string 'hacked-by-tenant-1' and got a 200 back. Anything
// outside this set is a client bug or an attack, not a state.
/**
 * The statuses a goods receipt may hold.
 *
 * Was `draft | received | inspected | rejected | cancelled` — a set that shared
 * exactly ONE value ('received') with what GoodsReceipt.jsx renders, counts and
 * filters on. 'draft' was the DB default and therefore what every receipt the
 * app created actually held, while 'inspected' was written by nothing and read
 * by nothing. Aligned with the UI's vocabulary and enforced by a CHECK
 * constraint in migration 20260903000011.
 */
const VALID_GRN_STATUSES = new Set(['pending', 'partial', 'received', 'rejected', 'cancelled']);

router.put('/grn/:id', requireProcurement('edit', 'store_keeper'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { status } = req.body;
    if (!VALID_GRN_STATUSES.has(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${[...VALID_GRN_STATUSES].join(', ')}` });
    }
    const companyId = cid(req);
    await client.query('BEGIN');
    // Scoped: unscoped, a company-1 caller could rewrite a company-2 receipt.
    const { rows: [oldGrn] } = await client.query(
      `SELECT * FROM goods_receipt_notes
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
        FOR UPDATE`,
      [req.params.id, companyId]
    );
    if (!oldGrn) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'GRN not found' }); }

    if (isNoop(oldGrn.status, status)) { await client.query('ROLLBACK'); return res.json(oldGrn); }
    const move = assertTransition('grn', oldGrn.status, status);
    if (move) { await client.query('ROLLBACK'); return res.status(move.status).json(move.body); }

    // 'received' means "this receipt is confirmed". Whether the ORDER is
    // complete is a different question, and the answer decides which of the two
    // confirmed states this receipt lands in — which is what gives the UI's
    // Partial tab a writer. Nothing had ever written 'partial', so that tab
    // could only ever read zero.
    let effective = status;
    if (status === 'received' && oldGrn.po_id) {
      const { rows: [short] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM purchase_order_items
          WHERE po_id = $1 AND COALESCE(received_quantity,0) < COALESCE(quantity,0)`,
        [oldGrn.po_id]
      );
      if (short.n > 0) effective = 'partial';
    }

    const { rows } = await client.query(
      `UPDATE goods_receipt_notes SET status = $1, updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL AND ($3::int IS NULL OR company_id = $3)
        RETURNING *`,
      [effective, req.params.id, companyId]
    );
    await client.query('COMMIT');

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'procurement', recordId: rows[0].id,
      recordType: 'goods_receipt_note', action: 'update',
      oldData: oldGrn, newData: rows[0], req,
    });
    res.json(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(error.status || 500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// =====================================================
// LOCAL PURCHASE REQUESTS
// =====================================================
router.post('/local-purchase', requireProcurement('add'), async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'A local purchase needs an amount greater than zero.' });
    }
    if (!String(req.body.description || '').trim()) {
      return res.status(400).json({ error: 'A description is required — this is spend outside the PO process and has to say what it was for.' });
    }
    const result = await pool.query(
      `INSERT INTO local_purchase_requests (request_number, requested_by_employee_id, request_date, description, vendor_name_text, amount, bill_status, notes, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        // Was `LPR${Date.now()}` — an epoch stamp, not a document number, and
        // not company-scoped. Local purchases are off-PO spend, which is exactly
        // the spend a finance review has to be able to find and cite.
        await nextLocalPurchaseNumber(pool, cid(req)),
        // requested_by_employee_id FKs employees(id); an unresolvable caller is
        // NULL rather than a users.id written into an employees column.
        req.body.requested_by_employee_id ?? await employeeOf(req, pool),
        req.body.request_date || new Date().toISOString().slice(0, 10),
        String(req.body.description).trim(),
        req.body.vendor_name_text,
        amount,
        req.body.bill_status,
        req.body.notes,
        // The row carried NO company_id at all, so every local purchase in the
        // system was global: invisible to a scoped list and countable in every
        // tenant's off-PO spend.
        cid(req),
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/local-purchase', requireProcurement('view'), async (req, res) => {
  try {
    // Unscoped, this returned every tenant's off-PO spend — description, vendor
    // and amount — to any caller with procurement view.
    const companyId = cid(req);
    const params = [];
    let where = 'deleted_at IS NULL';
    if (companyId) { params.push(companyId); where += ` AND company_id = $${params.length}`; }
    const result = await pool.query(
      `SELECT * FROM local_purchase_requests WHERE ${where} ORDER BY request_date DESC`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Vendors: with avg ratings from vendor_ratings ────────────────────────────
router.get('/vendors', requireProcurement('view'), async (req, res) => {
  try {
    const { search, category, status } = req.query;
    const companyId = cid(req);
    // VendorRiskDashboard has always sent ?risk_rating here, but this handler
    // only destructured search/category/status — the risk filter was silently
    // dropped and the list came back unfiltered. vendor_type is accepted too, so
    // the dashboard filter bar's dimensions both reach the query.
    const riskRating = dimension(req.query, 'risk_rating');
    const vendorType = dimension(req.query, 'vendor_type');
    const conditions = ['1=1'];
    const params = [];
    let idx = 1;
    if (companyId)  { conditions.push(`(v.company_id = $${idx++} OR v.company_id IS NULL)`); params.push(companyId); }
    if (search)     { conditions.push(`(v.vendor_name ILIKE $${idx} OR v.contact_person ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (category)   { conditions.push(`v.category = $${idx++}`); params.push(category); }
    if (status)     { conditions.push(`v.status = $${idx++}`); params.push(status); }
    if (riskRating) { conditions.push(`v.risk_rating = $${idx++}`); params.push(riskRating); }
    if (vendorType) { conditions.push(`v.vendor_type = $${idx++}`); params.push(vendorType); }

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
/**
 * GET /charge-targets — what a purchase order can be charged to.
 *
 * The projects and cost centres of the caller's own company, for the two
 * selectors on the PO drawer.
 *
 * Its own endpoint rather than the existing `/projects` and finance's
 * cost-centre list, because those are gated on `projects:view` and the finance
 * module's grant — permissions a buyer has no reason to hold. Borrowing them
 * would either 403 the dropdown for the people who need it or force those
 * modules to widen their gates for a lookup. This returns id and name only:
 * enough to fill a selector, and nothing about a project's budget or a cost
 * centre's spend that procurement has no business reading.
 */
router.get('/charge-targets', requireProcurement('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const [projects, costCentres] = await Promise.all([
      pool.query(
        `SELECT id, project_name AS name, project_code AS code
           FROM projects
          WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
            -- LOWER() on both sides: projects.status holds lowercase values
            -- here ('active', 'planning'), and a capitalised literal against a
            -- lowercase column excludes nothing at all — the closed projects
            -- would have stayed in the picker while the filter looked correct.
            AND LOWER(COALESCE(status, '')) NOT IN ('completed', 'cancelled', 'closed')
          ORDER BY project_name`, [companyId]),
      pool.query(
        `SELECT id, name, code
           FROM cost_centers
          WHERE ($1::int IS NULL OR company_id = $1)
            AND COALESCE(is_active, true) = true
          ORDER BY name`, [companyId]),
    ]);
    res.json({ projects: projects.rows, cost_centres: costCentres.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/rfqs', requireProcurement('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, search } = req.query;
    const conditions = ['1=1'];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`r.company_id = $${idx++}`); params.push(companyId); }
    if (status)    { conditions.push(`r.status = $${idx++}`); params.push(status); }
    if (search)    { conditions.push(`(r.item_description ILIKE $${idx} OR r.rfq_number ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

    // Try with rfq_quotes/rfq_items joins; fall back to plain rfqs if those tables aren't present yet
    let rows;
    try {
      const r = await pool.query(`
        SELECT r.*, COUNT(DISTINCT rq.id)::INT AS response_count, MIN(rq.unit_price) AS lowest_quote,
               COUNT(DISTINCT ri.id)::INT AS item_count
        FROM rfqs r
        LEFT JOIN rfq_quotes rq ON rq.rfq_id = r.id
        LEFT JOIN rfq_items  ri ON ri.rfq_id = r.id
        WHERE ${conditions.join(' AND ')}
        GROUP BY r.id
        ORDER BY r.created_at DESC
      `, params);
      rows = r.rows;
    } catch {
      const r = await pool.query(
        `SELECT *, 0 AS response_count, NULL AS lowest_quote, 1 AS item_count FROM rfqs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
        params
      );
      rows = r.rows;
    }
    res.json({ rfqs: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Full detail incl. real line items + quotes (with vendor name) — the list
// endpoint above only returns aggregates (item_count/response_count), so
// per-line/per-quote UI (the Award modal) needs to fetch this first.
router.get('/rfqs/:id', requireProcurement('view'), async (req, res) => {
  try {
    // Scoped: unscoped, this answered any tenant with another company's whole
    // sourcing event — its line items, every vendor's quoted unit price and the
    // TCO comparison built on them. rfqs.id is a sequential integer, so the
    // entire quote history was walkable. The list endpoint beside it was
    // already scoped; this one was the gap.
    const { rows: rfqRows } = await pool.query(
      `SELECT * FROM rfqs WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid(req)]
    );
    if (!rfqRows[0]) return res.status(404).json({ error: 'RFQ not found' });
    const { rows: items } = await pool.query(
      `SELECT ri.*, ii.item_code FROM rfq_items ri LEFT JOIN inventory_items ii ON ii.id = ri.item_id WHERE ri.rfq_id=$1 ORDER BY ri.id`,
      [req.params.id]
    );
    const { rows: quotes } = await pool.query(
      `SELECT rq.*, v.vendor_name,
              v.lead_time_days   AS vendor_lead_time_days,
              v.payment_terms_days AS vendor_payment_terms_days,
              v.on_time_pct, v.defect_rate, v.is_single_source
         FROM rfq_quotes rq
         LEFT JOIN vendors v ON v.id = rq.vendor_id
        WHERE rq.rfq_id = $1
        ORDER BY rq.unit_price NULLS LAST`,
      [req.params.id]
    );

    // The Award modal used to badge "Lowest" off MIN(unit_price) and that was
    // the entire basis for awarding an RFQ. Score every quote on total cost of
    // ownership so the buyer sees what the part actually costs before awarding.
    const tco = await scoreRfqQuotes(rfqRows[0], items, quotes, cid(req));

    res.json({ ...rfqRows[0], items, quotes: tco.quotes, tco_comparison: tco.comparison, tco_basis: tco.basis });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Score an RFQ's quotes on TCO.
 *
 * An RFQ quote is stored per-RFQ, not per-line (rfq_quotes has one row per
 * rfq_id/vendor_id with a single unit_price), so the comparison quantity is the
 * RFQ's total quantity: the sum of its item lines, falling back to the legacy
 * scalar `rfqs.quantity` for RFQs raised before rfq_items existed.
 *
 * Item context (holding cost, demand, GST) is only attributable when the RFQ
 * covers exactly ONE component — for a multi-line RFQ the engine is fed the
 * commercial terms alone and the basis block says so, rather than silently
 * borrowing the first line's parameters for the whole basket.
 */
async function scoreRfqQuotes(rfq, items, quotes, companyId) {
  const lineQty = items.reduce((s, i) => s + (parseFloat(i.quantity) || 0), 0);
  const totalQty = lineQty > 0 ? lineQty : (parseFloat(rfq.quantity) || 0) || 1;

  const singleItemId = items.length === 1 && items[0].item_id ? Number(items[0].item_id) : null;

  let itemRow = {}, perf = new Map(), demand = { annual_demand_qty: null };
  const params = await loadTcoParams(companyId);

  // TCO switched off for this company: return the quotes untouched and a
  // ranking with null winners, so the award modal falls back to price without
  // rendering a column of dashes.
  if (!params.tco_enabled) {
    const empty = rankOptions([], params);
    return {
      quotes: quotes.map(q => ({ ...q, tco: null })),
      comparison: {
        quantity: totalQty, best_tco_vendor_id: null, best_price_vendor_id: null,
        best_tco_per_unit: null, tco_spread_pct: 0, recommendation: empty.recommendation, confidence: 0,
      },
      basis: tcoBasis(params, { quantity: totalQty, quantity_basis: lineQty > 0 ? 'sum of RFQ item lines' : 'RFQ header quantity' }),
    };
  }

  if (singleItemId) {
    const [{ rows: ir }, p, d] = await Promise.all([
      pool.query(
        `SELECT gst_rate, default_gst_rate, holding_cost_pct, min_order_qty
           FROM inventory_items WHERE id = $1`, [singleItemId]
      ).catch(() => ({ rows: [] })),
      loadVendorPerformance(singleItemId, companyId),
      loadAnnualDemand(singleItemId, companyId),
    ]);
    itemRow = ir[0] || {}; perf = p; demand = d;
  }

  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const itemTax = resolveGstRate(itemRow);

  const ranked = rankOptions(quotes.map((q) => {
    const pf = perf.get(Number(q.vendor_id)) || {};
    // total_amount is the vendor's own price for the whole RFQ; prefer it over
    // unit_price x qty, which silently disagrees whenever the vendor quoted a
    // slab or a rounded lot total.
    const total = n(q.total_amount);
    const unit = n(q.unit_price) ?? (total != null && totalQty > 0 ? total / totalQty : null);
    return {
      vendor_id: Number(q.vendor_id),
      vendor_name: q.vendor_name || `Vendor #${q.vendor_id}`,
      quote_id: q.id,
      unit_price: unit,
      quantity: totalQty,
      freight_amount:   n(q.freight_amount),
      insurance_amount: n(q.insurance_amount),
      duty_amount:      n(q.duty_amount),
      packaging_amount: n(q.packaging_amount),
      other_charges:    n(q.other_charges),
      tooling_cost:     n(q.tooling_cost),
      tax_pct:          n(q.tax_pct) ?? itemTax,
      moq:              n(q.moq),
      // A quoted delivery is a commitment; the vendor master's standing lead
      // time is a default. The basis label keeps the two apart.
      lead_time_days:  q.delivery_days ?? q.vendor_lead_time_days ?? null,
      lead_time_basis: q.delivery_days != null ? 'quoted'
        : (q.vendor_lead_time_days != null ? 'estimated' : 'assumed'),
      payment_terms_days: parsePaymentTermsDays(q.payment_terms) ?? n(q.vendor_payment_terms_days),
      payment_terms_basis: parsePaymentTermsDays(q.payment_terms) != null ? 'quoted' : 'estimated',
      // masterRate() reads a hand-maintained 0 as "never measured" rather than
      // as a real 0% on-time record, which would fabricate a penalty.
      reject_rate_pct: pf.reject_rate_pct ?? masterRate(q.defect_rate),
      reject_basis:    pf.reject_rate_pct != null ? 'observed' : 'estimated',
      on_time_pct:     pf.on_time_pct ?? masterRate(q.on_time_pct),
      on_time_basis:   pf.on_time_pct != null ? 'observed' : 'estimated',
      freight_pct_observed: pf.freight_pct_observed ?? null,
      is_single_source: !!q.is_single_source,
      annual_demand_qty: demand.annual_demand_qty,
      holding_cost_pct:  n(itemRow.holding_cost_pct),
    };
  }), params);

  const byId = new Map(ranked.options.map(o => [o.quote_id, o]));
  return {
    quotes: quotes.map((q) => {
      const o = byId.get(q.id);
      return o ? {
        ...q,
        tco: o.tco,
        tco_per_unit: o.tco.tco_per_unit,
        tco_total: o.tco.tco_total,
        tco_premium_pct: o.tco.premium_pct,
        tco_vs_best_pct: o.tco_vs_best_pct,
        is_lowest_tco: o.is_lowest_tco,
        is_lowest_price: o.is_lowest_price,
        tco_confidence: o.tco.confidence,
      } : { ...q, tco: null };
    }),
    comparison: {
      quantity: totalQty,
      best_tco_vendor_id: ranked.best_tco_id,
      best_price_vendor_id: ranked.best_price_id,
      best_tco_per_unit: ranked.best_tco_per_unit,
      tco_spread_pct: ranked.tco_spread_pct,
      recommendation: ranked.recommendation,
      confidence: ranked.confidence,
    },
    basis: tcoBasis(params, {
      quantity: totalQty,
      quantity_basis: lineQty > 0 ? 'sum of RFQ item lines' : 'RFQ header quantity',
      // Says plainly why a multi-line RFQ carries no carrying-cost context.
      item_context: singleItemId
        ? 'single-line RFQ — item holding cost, demand and GST applied'
        : 'multi-line RFQ — commercial terms only; per-item holding cost, demand and GST are not attributable',
      annual_demand_qty: demand.annual_demand_qty,
      demand_source: demand.demand_source ?? null,
      tax_pct: itemTax,
    }),
  };
}

/**
 * Credit days from a free-text payment terms string ("Net 30", "45 days",
 * "30 Days from Invoice"). Returns null when nothing parses — an unreadable
 * term must NOT be scored as cash-on-delivery, which would hand the vendor a
 * financing penalty they never earned.
 */
function parsePaymentTermsDays(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  if (/\b(advance|prepaid|pia|payment in advance)\b/i.test(s)) {
    const adv = s.match(/(\d{1,3})\s*(?:days?)?/i);
    return adv ? -Math.abs(parseInt(adv[1], 10)) : -1;
  }
  if (/\b(cod|cash on delivery|immediate|against delivery)\b/i.test(s)) return 0;
  const m = s.match(/(?:net\s*)?(\d{1,3})\s*(?:days?)?/i);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  return Number.isFinite(d) && d >= 0 && d <= 365 ? d : null;
}

router.post('/rfqs', requireProcurement('add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      item_description, quantity, unit, required_by, linked_pr_id, vendor_ids, items,
      // §136 — the same row is now an RFI, an RFP or an RFQ. Every field below is
      // optional and defaults to the old behaviour, so the callers that predate
      // this (VendorComparison's one-click "request quote", the PR path) keep
      // creating plain RFQs without knowing the concept exists.
      rfx_type, category_id, objective,
    } = req.body;

    const rfxType = String(rfx_type || 'RFQ').toUpperCase();
    if (!['RFI', 'RFP', 'RFQ'].includes(rfxType)) {
      return res.status(400).json({ error: `Unknown RFx type '${rfx_type}'` });
    }
    // items[] is the real multi-line path; falling back to the header's own
    // scalar fields keeps any older caller that still posts the single-item
    // shape working unchanged.
    const lineItems = Array.isArray(items) && items.length
      ? items
      : [{ item_id: null, item_name: item_description, quantity: quantity || 1, unit: unit || 'Nos' }];
    if (lineItems.some(it => !String(it.item_name || it.item_description || '').trim() || !(Number(it.quantity) > 0))) {
      return res.status(400).json({ error: 'Every item needs a description and a quantity greater than 0' });
    }

    await client.query('BEGIN');
    const rfq_number = await nextRfxNumber(rfxType, client);
    const first = lineItems[0];
    const { rows } = await client.query(`
      INSERT INTO rfqs (rfq_number, pr_id, item_description, quantity, unit, required_by,
                        vendor_ids, status, company_id, rfx_type, category_id, objective)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11)
      RETURNING *
    `, [
      rfq_number, linked_pr_id || null,
      first.item_name || first.item_description || '', first.quantity || 1, first.unit || 'Nos',
      required_by || null, JSON.stringify(vendor_ids || []), cid(req),
      rfxType, category_id || null, objective || null,
    ]);
    const rfq = rows[0];

    const savedItems = [];
    for (const it of lineItems) {
      const { rows: itemRows } = await client.query(`
        INSERT INTO rfq_items (rfq_id, item_id, item_name, quantity, unit, required_date, remarks)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
      `, [
        rfq.id, it.item_id || null, it.item_name || it.item_description || '',
        it.quantity || 1, it.unit || 'Nos', it.required_date || required_by || null, it.remarks || null,
      ]);
      savedItems.push(itemRows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ ...rfq, items: savedItems, quotes: [] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post('/rfqs/:id/send-to-vendors', requireProcurement('edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { vendor_ids } = req.body;
    const companyId = cid(req);
    if (!vendor_ids?.length) return res.status(400).json({ error: 'vendor_ids required' });

    // Confirm the RFQ is ours BEFORE writing rfq_quotes rows against it. The
    // quote rows were inserted first and unscoped, so a caller could seed
    // another tenant's RFQ with their own vendors and only then be refused by
    // the UPDATE — leaving the foreign RFQ polluted with quote rows.
    const { rows: own } = await pool.query(
      `SELECT id FROM rfqs WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`, [id, companyId]
    );
    if (!own[0]) return res.status(404).json({ error: 'RFQ not found' });

    for (const vendor_id of vendor_ids) {
      await pool.query(
        `INSERT INTO rfq_quotes (rfq_id, vendor_id) VALUES ($1,$2) ON CONFLICT (rfq_id, vendor_id) DO NOTHING`,
        [id, vendor_id]
      );
    }
    const { rows } = await pool.query(
      `UPDATE rfqs SET status='sent', vendor_ids=$1 WHERE id=$2 AND ($3::int IS NULL OR company_id = $3) RETURNING *`,
      [JSON.stringify(vendor_ids), id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'RFQ not found' });

    // "Send to vendors" only ever recorded rfq_quotes rows and flipped the RFQ
    // to 'sent' — no vendor ever received anything, same gap PO approval had
    // before sendPurchaseOrderToVendor. Fire-and-forget, same contract as that
    // one: a delivery failure must not affect an RFQ send that already committed.
    pool.query(
      `SELECT ri.item_name, ri.quantity, ri.unit, ri.remarks FROM rfq_items ri WHERE ri.rfq_id=$1 ORDER BY ri.id`,
      [id]
    ).then(async ({ rows: rfqItems }) => {
      const { rows: vendorRows } = await pool.query(
        `SELECT id, vendor_name, email FROM vendors WHERE id = ANY($1::int[])`,
        [vendor_ids]
      );
      for (const vendor of vendorRows) {
        if (!vendor.email) continue;
        await sendRfqToVendor(vendor.email, {
          rfqNumber: rows[0].rfq_number,
          vendorName: vendor.vendor_name,
          items: rfqItems,
          requiredBy: rows[0].required_by,
        }).catch((err) => console.error(`[procurement] RFQ email to vendor ${vendor.id} failed:`, err.message));
      }
    }).catch((err) => console.error('[procurement] RFQ vendor email dispatch failed:', err.message));

    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rfqs/:rfqId/responses/:vendorId', requireProcurement('edit'), async (req, res) => {
  try {
    const { rfqId, vendorId } = req.params;
    // A quote may only be recorded against an RFQ in the caller's own company.
    const { rows: ownRfq } = await pool.query(
      `SELECT id, rfq_number, status FROM rfqs WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`, [rfqId, cid(req)]
    );
    if (!ownRfq[0]) return res.status(404).json({ error: 'RFQ not found' });
    // A closed event has been awarded; accepting a quote into it would change
    // the field the award was decided against after the fact.
    if (ownRfq[0].status === 'closed' || ownRfq[0].status === 'cancelled') {
      return res.status(409).json({ error: `${ownRfq[0].rfq_number} is ${ownRfq[0].status} and is no longer accepting quotes.` });
    }
    // The vendor must exist in this company's master. Unchecked, a quote could
    // be filed against any integer, and the award route would then try to raise
    // a purchase order to a supplier that does not exist.
    const { rows: ownVendor } = await pool.query(
      `SELECT id FROM vendors WHERE id=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
      [vendorId, cid(req)]
    );
    if (!ownVendor[0]) return res.status(404).json({ error: 'Vendor not found' });

    // Prices are money. A negative quote is not a discount, it is a data error
    // that would win every TCO comparison it entered.
    for (const [field, value] of Object.entries({
      unit_price: req.body.unit_price, total_amount: req.body.total_amount,
      freight_amount: req.body.freight_amount, insurance_amount: req.body.insurance_amount,
      duty_amount: req.body.duty_amount, packaging_amount: req.body.packaging_amount,
      other_charges: req.body.other_charges, tooling_cost: req.body.tooling_cost,
    })) {
      if (value != null && value !== '' && parseFloat(value) < 0) {
        return res.status(400).json({ error: `${field.replace(/_/g, ' ')} cannot be negative.` });
      }
    }
    if (req.body.tax_pct != null && req.body.tax_pct !== '' &&
        (parseFloat(req.body.tax_pct) < 0 || parseFloat(req.body.tax_pct) > 100)) {
      return res.status(400).json({ error: 'Tax percentage must be between 0 and 100.' });
    }
    const {
      unit_price, total_amount, delivery_days, payment_terms, notes,
      // TCO adders. Each is optional and each stays NULL when not supplied —
      // a 0 default would assert "freight is free" and quietly flatter this
      // vendor against one who did declare their charges.
      freight_amount, insurance_amount, duty_amount, packaging_amount,
      other_charges, tooling_cost, tax_pct, warranty_months, moq,
      currency, valid_until,
    } = req.body;
    const nn = (v) => {
      if (v == null || v === '') return null;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };
    const { rows } = await pool.query(`
      INSERT INTO rfq_quotes (
        rfq_id, vendor_id, unit_price, total_amount, delivery_days, payment_terms, notes,
        freight_amount, insurance_amount, duty_amount, packaging_amount,
        other_charges, tooling_cost, tax_pct, warranty_months, moq, currency, valid_until)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (rfq_id, vendor_id) DO UPDATE SET
        unit_price=EXCLUDED.unit_price, total_amount=EXCLUDED.total_amount,
        delivery_days=EXCLUDED.delivery_days, payment_terms=EXCLUDED.payment_terms, notes=EXCLUDED.notes,
        freight_amount=EXCLUDED.freight_amount, insurance_amount=EXCLUDED.insurance_amount,
        duty_amount=EXCLUDED.duty_amount, packaging_amount=EXCLUDED.packaging_amount,
        other_charges=EXCLUDED.other_charges, tooling_cost=EXCLUDED.tooling_cost,
        tax_pct=EXCLUDED.tax_pct, warranty_months=EXCLUDED.warranty_months,
        moq=EXCLUDED.moq, currency=EXCLUDED.currency, valid_until=EXCLUDED.valid_until
      RETURNING *
    `, [rfqId, vendorId, unit_price, total_amount, delivery_days, payment_terms, notes,
        nn(freight_amount), nn(insurance_amount), nn(duty_amount), nn(packaging_amount),
        nn(other_charges), nn(tooling_cost), nn(tax_pct),
        warranty_months == null || warranty_months === '' ? null : parseInt(warranty_months, 10),
        nn(moq), currency || null, valid_until || null]);
    await pool.query(
      `UPDATE rfqs SET status='responses_received' WHERE id=$1 AND status='sent' AND ($2::int IS NULL OR company_id = $2)`,
      [rfqId, cid(req)]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * PATCH /rfqs/:rfqId/award/:vendorId — award the event and raise the order.
 *
 * Rewritten. The previous version had five defects at once, all of them
 * reachable from a single click:
 *
 *  1. NO TENANT SCOPE ANYWHERE. `UPDATE rfq_quotes SET is_winner=false WHERE
 *     rfq_id=$1`, `UPDATE rfqs SET status='closed' WHERE id=$1` and the quote
 *     read all keyed on the path id alone. Any authenticated buyer could award
 *     ANOTHER COMPANY'S sourcing event to a vendor of their choosing, and the
 *     purchase order that followed was created in the caller's own company. The
 *     404 that should have stopped it was checked AFTER those writes had already
 *     committed.
 *
 *  2. THE WRITES WERE NOT IN THE TRANSACTION. The winner flags and the RFQ
 *     closure ran on the pool, in autocommit, BEFORE `BEGIN`. Only the purchase
 *     order was transactional.
 *
 *  3. A FAILED PO WAS SWALLOWED. If PO creation threw, the catch logged
 *     `[award] PO auto-create skipped` and set `po = null` — and the route still
 *     returned `{ success: true }`. The RFQ was closed, a winner was flagged,
 *     and no order existed. The buyer was told the award had worked.
 *
 *  4. NOT IDEMPOTENT. Nothing looked at the RFQ's status, so awarding twice
 *     created TWO purchase orders for one event — each approvable, each
 *     receivable, each payable. A double-clicked Award is a duplicate order.
 *
 *  5. CROSS-TENANT READ ON THE CARRY-OVER. `prRepo.getItems(pr_id, client)` was
 *     called with no companyId, so the requisition lines copied onto the order
 *     were fetched without a tenant predicate.
 *
 * Everything now happens inside one transaction, scoped, with the RFQ row locked
 * so two awards cannot interleave, and a PO failure rolls the award back rather
 * than reporting a success that did not happen.
 */
router.patch('/rfqs/:rfqId/award/:vendorId', requireProcurement('approve'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { rfqId, vendorId } = req.params;
    const companyId = cid(req);

    await client.query('BEGIN');

    const { rows: [rfq] } = await client.query(
      `SELECT * FROM rfqs
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)
        FOR UPDATE`,
      [rfqId, companyId]
    );
    if (!rfq) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'RFQ not found' });
    }

    // ── Idempotency ──────────────────────────────────────────────────────────
    // A closed event has already been awarded. Return the order it produced
    // instead of raising a second one for the same requirement.
    if (rfq.status === 'closed') {
      const { rows: [winner] } = await client.query(
        `SELECT rq.*, v.vendor_name FROM rfq_quotes rq
           LEFT JOIN vendors v ON v.id = rq.vendor_id
          WHERE rq.rfq_id = $1 AND rq.is_winner = true LIMIT 1`,
        [rfqId]
      );
      const { rows: [existingPo] } = await client.query(
        `SELECT * FROM purchase_orders
          WHERE deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
            AND notes LIKE $1 ORDER BY id LIMIT 1`,
        [`%${rfq.rfq_number}%`, companyId]
      );
      await client.query('ROLLBACK');
      if (winner && String(winner.vendor_id) !== String(vendorId)) {
        return res.status(409).json({
          error: `${rfq.rfq_number} was already awarded to ${winner.vendor_name || `vendor ${winner.vendor_id}`}. Reopen the event before awarding it to a different vendor.`,
          code: 'RFQ_ALREADY_AWARDED',
          awarded_vendor_id: winner.vendor_id,
        });
      }
      // A closed event with neither a winning quote nor an order behind it was
      // not awarded — something else closed it. Answering 200 here is what let
      // the preferred-vendor selection silently swallow the award: the buyer
      // clicked Award, got a success response, and no purchase order existed.
      // Say so instead, the same way convert-to-po does for its equivalent.
      if (!winner && !existingPo) {
        return res.status(409).json({
          error: `${rfq.rfq_number} is marked closed but has no winning quote and no purchase order against it, so it cannot be awarded. Reopen the event to award it.`,
          code: 'RFQ_CLOSED_WITHOUT_AWARD',
        });
      }
      return res.json({ success: true, rfq, quote: winner ?? null, po: existingPo ?? null, already_awarded: true });
    }

    // The vendor must actually have quoted. Awarding to a vendor with no quote
    // produced a purchase order with a zero total and no price basis at all.
    const { rows: [quote] } = await client.query(
      `SELECT rq.*, v.vendor_name FROM rfq_quotes rq
         LEFT JOIN vendors v ON v.id = rq.vendor_id
        WHERE rq.rfq_id = $1 AND rq.vendor_id = $2`,
      [rfqId, vendorId]
    );
    if (!quote) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: `Vendor ${vendorId} has not quoted on ${rfq.rfq_number}, so the event cannot be awarded to them.`,
      });
    }

    await client.query(`UPDATE rfq_quotes SET is_winner = false WHERE rfq_id = $1`, [rfqId]);
    await client.query(`UPDATE rfq_quotes SET is_winner = true WHERE rfq_id = $1 AND vendor_id = $2`, [rfqId, vendorId]);
    const { rows: [closedRfq] } = await client.query(
      `UPDATE rfqs SET status = 'closed', evaluated_at = NOW()
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`,
      [rfqId, companyId]
    );

    // ── The order ────────────────────────────────────────────────────────────
    // No longer optional. An award whose purchase order could not be created is
    // not an award, so a failure here rolls the whole thing back.
    const poNum = await nextPurchaseOrderNumber(client, companyId);
    // ── The promised delivery date ───────────────────────────────────────────
    // This path raised orders with expected_delivery_date NULL, and so did
    // convert-to-po — between them, every order this product actually creates.
    // Live before this change: 0 of 2 purchase orders carried one, so the
    // supplier scorecard's OTD had nothing to measure against but
    // order_date + vendors.lead_time_days, master data we typed about them.
    //
    // The winning quote's `delivery_days` is the supplier's own commitment on
    // the bid we just accepted — the strongest promise this system ever holds.
    // Falling back to the vendor's lead time is still better than NULL, but it
    // is an assumption and `expected_delivery_basis` says so; vendorHealth
    // refuses to publish an OTD measured only against 'lead_time' dates.
    const quotedDays = Number.isFinite(parseInt(quote.delivery_days, 10)) && parseInt(quote.delivery_days, 10) > 0
      ? parseInt(quote.delivery_days, 10) : null;
    const { rows: [awardVendor] } = await client.query(
      `SELECT lead_time_days FROM vendors WHERE id = $1`, [vendorId]);
    const fallbackDays = quotedDays == null && parseInt(awardVendor?.lead_time_days, 10) > 0
      ? parseInt(awardVendor.lead_time_days, 10) : null;
    const promisedDays = quotedDays ?? fallbackDays;
    const deliveryBasis = quotedDays != null ? 'quoted' : fallbackDays != null ? 'lead_time' : null;

    const { rows: [po] } = await client.query(`
      INSERT INTO purchase_orders (po_number, supplier_id, pr_id, total_amount, subtotal, status,
                                   order_date, company_id, created_by, notes,
                                   expected_delivery_date, expected_delivery_basis)
      VALUES ($1,$2,$3,$4,$4,'draft',CURRENT_DATE,$5,$6,$7,
              CASE WHEN $8::int IS NULL THEN NULL ELSE CURRENT_DATE + ($8::int || ' days')::interval END,
              $9) RETURNING *
    `, [
      poNum, vendorId,
      // rfqs.pr_id is varchar while purchase_requests.id is integer — real
      // schema drift. A non-numeric value is not a requisition id and must not
      // reach the FK.
      /^\d+$/.test(String(rfq.pr_id ?? '')) ? parseInt(rfq.pr_id, 10) : null,
      quote.total_amount || 0,
      companyId,
      await employeeOf(req, pool),
      // The RFQ number is how the idempotency branch above finds this order
      // again, and how a reviewer traces the price back to the event it was won
      // on. It was never recorded.
      `Awarded from ${rfq.rfq_number}${quote.vendor_name ? ` to ${quote.vendor_name}` : ''}`,
      promisedDays,
      deliveryBasis,
    ]);

    // Carry real line items onto the PO — an RFQ-award that only writes the
    // header (no purchase_order_items) ships completely empty and breaks
    // GRN's 3-way match (nothing to select as "received against"). Prefer the
    // linked PR's real lines (same carryover convert-to-po uses above); else
    // fall back to the RFQ's own rfq_items rows.
    const prIdInt = /^\d+$/.test(String(rfq.pr_id ?? '')) ? parseInt(rfq.pr_id, 10) : null;
    // companyId, not omitted: without it the carry-over read another tenant's
    // requisition lines whenever the drifted pr_id happened to match.
    const prItems = prIdInt ? await prRepo.getItems(prIdInt, client, companyId) : [];
    if (prItems.length) {
      for (const it of prItems) {
        const qty  = parseFloat(it.quantity) || 0;
        const rate = parseFloat(it.expected_price) || 0;
        await poRepo.createItem(client, {
          po_id: po.id, item_id: it.item_id ?? null,
          quantity: qty, rate, tax_rate: 0, tax_amount: 0, total_amount: qty * rate,
        });
      }
    } else {
      const { rows: rfqItemRows } = await client.query(
        `SELECT * FROM rfq_items WHERE rfq_id=$1 ORDER BY id`, [rfqId]
      );
      const lineItems = rfqItemRows.length
        ? rfqItemRows
        : [{ item_id: null, item_name: rfq.item_description, quantity: rfq.quantity || 1 }];
      const totalQty  = lineItems.reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0) || 1;
      const totalAmt  = parseFloat(quote.total_amount) || 0;
      const unitPrice = parseFloat(quote.unit_price) || null;
      for (const it of lineItems) {
        const qty = parseFloat(it.quantity) || 0;
        // A single-line RFQ can use the vendor's quoted unit_price directly.
        // A genuine multi-line RFQ has no per-line vendor pricing anywhere in
        // the schema (the vendor quotes one bundle total), so total_amount is
        // apportioned across lines by a blended per-unit rate — honest given
        // what was actually quoted, not fabricated per-line precision.
        const rate = (lineItems.length === 1 && unitPrice) ? unitPrice : (totalQty ? totalAmt / totalQty : 0);
        let itemId = it.item_id;
        if (!itemId) {
          const { rows: matchRows } = await client.query(
            `SELECT id FROM inventory_items WHERE LOWER(item_name) = LOWER($1) OR LOWER(item_code) = LOWER($1) LIMIT 1`,
            [it.item_name || '']
          );
          itemId = matchRows[0]?.id ?? null;
        }
        await poRepo.createItem(client, {
          po_id: po.id, item_id: itemId,
          quantity: qty, rate, tax_rate: 0, tax_amount: 0, total_amount: qty * rate,
        });
      }
    }

    // Keep the header in step with the lines that were actually written — the
    // quote total and the sum of the carried-over PR lines are not always the
    // same number, and the header is what approval routing and 3-way match read.
    const { rows: [tot] } = await client.query(
      `UPDATE purchase_orders po
          SET subtotal = l.sub, total_amount = l.sub + l.tax, tax_amount = l.tax,
              total_amount_inr = (l.sub + l.tax) * COALESCE(po.exchange_rate, 1)
         FROM (SELECT COALESCE(SUM(quantity * rate),0) AS sub, COALESCE(SUM(tax_amount),0) AS tax
                 FROM purchase_order_items WHERE po_id = $1) l
        WHERE po.id = $1 RETURNING po.*`,
      [po.id]
    );

    // The sourcing decision that was in force for what was just awarded.
    // Resolved here rather than before the INSERT because the line items — and
    // therefore the categories — only exist once the carry-over above has run.
    // Advisory: it records whether the award followed the strategy and never
    // refuses one. See sourcingAdvisory.service.js on why `followed` is narrow
    // and why null is not false.
    const { rows: awardedLines } = await client.query(
      `SELECT item_id FROM purchase_order_items WHERE po_id = $1 AND item_id IS NOT NULL`, [po.id]);
    const advisory = await resolveSourcingAdvisory(client, {
      companyId, itemIds: awardedLines.map((l) => l.item_id), vendorId,
    });
    await client.query(
      `UPDATE purchase_orders SET sourcing_strategy_id = $2, followed_sourcing_strategy = $3 WHERE id = $1`,
      [po.id, advisory.strategy?.id ?? null, advisory.followed]);

    // Also move the requisition on, so an awarded requirement does not sit in
    // the "approved, awaiting conversion" queue forever with an order against it.
    if (prIdInt) {
      await client.query(
        `UPDATE purchase_requests SET status = 'converted_to_po', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'approved' AND ($2::int IS NULL OR company_id = $2)`,
        [prIdInt, companyId]
      );
    }

    await client.query('COMMIT');

    // Freeze what this award was decided on. The rates behind a TCO can change
    // at any time, and once they do nobody can show what the comparison said on
    // the day — so the figures and the basis are stored, never recomputed.
    // Deliberately AFTER the commit and non-fatal: this is an audit artefact of
    // a decision that has already been made, and losing it must not undo the
    // award. It is reported, never swallowed silently.
    const decision = await recordAwardDecision({
      rfqId, vendorId, poId: tot?.id ?? po.id, req,
    }).catch((e) => {
      console.error(`[award] TCO decision record failed for RFQ ${rfqId} — the award stands but has no frozen comparison:`, e.message);
      return null;
    });

    logAudit({
      userId: req.user?.userId ?? req.user?.id, module: 'procurement',
      recordId: closedRfq.id, recordType: 'rfq', action: 'award', oldData: rfq,
      newData: { ...closedRfq, awarded_vendor_id: vendorId, quote, po_id: po.id, tco_decision: decision }, req,
    });
    res.json({ success: true, rfq: closedRfq, quote, po: tot ?? po, tco_decision: decision, sourcing_advisory: advisory });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * Score the RFQ as it stood at award time and write one immutable row.
 *
 * Re-scores rather than trusting anything the client sent: the decision record
 * is an audit artefact, and a caller that could post its own TCO figures could
 * post flattering ones.
 */
async function recordAwardDecision({ rfqId, vendorId, poId, req }) {
  const companyId = cid(req);
  const { rows: rfqRows } = await pool.query(`SELECT * FROM rfqs WHERE id = $1`, [rfqId]);
  if (!rfqRows[0]) return null;

  const { rows: items } = await pool.query(
    `SELECT * FROM rfq_items WHERE rfq_id = $1 ORDER BY id`, [rfqId]
  );
  const { rows: quotes } = await pool.query(
    `SELECT rq.*, v.vendor_name, v.lead_time_days AS vendor_lead_time_days,
            v.payment_terms_days AS vendor_payment_terms_days,
            v.on_time_pct, v.defect_rate, v.is_single_source
       FROM rfq_quotes rq LEFT JOIN vendors v ON v.id = rq.vendor_id
      WHERE rq.rfq_id = $1`,
    [rfqId]
  );

  const scored = await scoreRfqQuotes(rfqRows[0], items, quotes, companyId);
  const cmp = scored.comparison;
  const won = scored.quotes.find(q => Number(q.vendor_id) === Number(vendorId));

  const lowestTco   = scored.quotes.find(q => q.is_lowest_tco);
  const lowestPrice = scored.quotes.find(q => q.is_lowest_price);
  const followed = cmp.best_tco_vendor_id == null
    ? null
    : Number(cmp.best_tco_vendor_id) === Number(vendorId);

  // Only a positive gap is a forgone saving. A negative one would mean the
  // award beat the "best" option, which cannot happen and would signal a bug.
  const forgone = won?.tco_total != null && lowestTco?.tco_total != null
    ? Math.max(0, +(won.tco_total - lowestTco.tco_total).toFixed(2))
    : null;

  const { rows } = await pool.query(
    `INSERT INTO procurement_award_decisions (
       rfq_id, quote_id, awarded_vendor_id, po_id, quantity,
       awarded_unit_price, awarded_tco_total, awarded_tco_per_unit, awarded_confidence,
       lowest_tco_vendor_id, lowest_tco_total, lowest_price_vendor_id, lowest_price_total,
       tco_saving_forgone, followed_recommendation, tco_breakdown, tco_basis,
       tco_enabled, decided_by_user_id, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING id, followed_recommendation, tco_saving_forgone, awarded_tco_total`,
    [
      rfqId, won?.id ?? null, vendorId, poId, cmp.quantity,
      won?.unit_price ?? null, won?.tco_total ?? null, won?.tco_per_unit ?? null,
      won?.tco_confidence ?? null,
      cmp.best_tco_vendor_id, lowestTco?.tco_total ?? null,
      cmp.best_price_vendor_id, lowestPrice?.tco_total ?? null,
      forgone, followed,
      won?.tco ? JSON.stringify(won.tco) : null,
      JSON.stringify(scored.basis),
      scored.basis.tco_enabled !== false,
      req.user?.userId ?? req.user?.id ?? null,
      companyId,
    ]
  );
  return rows[0] ?? null;
}

/**
 * GET /procurement/award-decisions — the review query.
 *
 * `?overridden=true` narrows to awards that did NOT go to the lowest-TCO
 * vendor, which is the list a procurement review actually wants: every one of
 * them is a decision somebody should be able to explain.
 */
router.get('/award-decisions', requireProcurement('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const conds = ['1=1'];
    const params = [];
    if (companyId) { params.push(companyId); conds.push(`d.company_id = $${params.length}`); }
    if (String(req.query.overridden) === 'true') conds.push('d.followed_recommendation = false');
    if (req.query.rfq_id) { params.push(Number(req.query.rfq_id)); conds.push(`d.rfq_id = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT d.*, r.rfq_number, aw.vendor_name AS awarded_vendor_name,
              lt.vendor_name AS lowest_tco_vendor_name,
              lp.vendor_name AS lowest_price_vendor_name,
              po.po_number, u.name AS decided_by_name
         FROM procurement_award_decisions d
         JOIN rfqs r         ON r.id  = d.rfq_id
         LEFT JOIN vendors aw ON aw.id = d.awarded_vendor_id
         LEFT JOIN vendors lt ON lt.id = d.lowest_tco_vendor_id
         LEFT JOIN vendors lp ON lp.id = d.lowest_price_vendor_id
         LEFT JOIN purchase_orders po ON po.id = d.po_id
         LEFT JOIN users u    ON u.id  = d.decided_by_user_id
        WHERE ${conds.join(' AND ')}
        ORDER BY d.created_at DESC
        LIMIT 200`,
      params
    );

    const overridden = rows.filter(r => r.followed_recommendation === false);
    res.json({
      decisions: rows,
      summary: {
        total: rows.length,
        overridden: overridden.length,
        // The headline for a procurement review: what awarding against total
        // cost of ownership has cost, at the rates in force on each day.
        total_saving_forgone: +overridden
          .reduce((s, r) => s + (parseFloat(r.tco_saving_forgone) || 0), 0).toFixed(2),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 3-Way Match ───────────────────────────────────────────────────────────────
// Three-way match (list, create, approve-into-bill, resolve) now lives in
// ./threeWayMatch.routes.js and is mounted at the bottom of this file at the
// same paths. It is the one path that turns a receipt into a payable, and it was
// split across two halves of this file 600 lines apart — see that module's
// header for what that cost.

// ── Create vendor ─────────────────────────────────────────────────────────────
/**
 * The columns the internal vendor form may set.
 *
 * The form collected fourteen fields while `vendors` carries the full trading
 * identity a supplier needs before it can be paid — vendor_type, MSME/Udyam
 * status, IEC, CIN, website, country/postal code, turnover, headcount, lead time,
 * credit limit and payment terms. Those were reachable only through the external
 * vendor-registration flow, so a vendor added by a buyer internally was a
 * permanently thinner record than the identical vendor who self-registered, and
 * the gap was invisible until finance needed the MSME flag for payment-terms
 * compliance. Whitelisted rather than spread from the body: `vendors` also holds
 * scorecard columns (scm_score, risk_rating, approved_by, classification) that
 * are computed, and a mass-assign here would let a caller write its own risk
 * rating.
 */
const VENDOR_WRITABLE = [
  'vendor_name', 'category', 'vendor_type', 'vendor_category', 'vendor_code',
  'gstin', 'pan', 'udyam_number', 'msme_status', 'iec', 'cin',
  'bank_name', 'account_number', 'ifsc',
  'contact_person', 'email', 'phone', 'website',
  'address', 'city', 'state', 'country', 'postal_code',
  'year_established', 'employee_count', 'annual_turnover',
  'lead_time_days', 'credit_limit', 'payment_terms_days',
  'status',
];

// Numeric columns must be NULL rather than '' when the form leaves them blank —
// Postgres rejects '' for numeric/integer and the whole save would 500.
const VENDOR_NUMERIC = new Set([
  'year_established', 'employee_count', 'annual_turnover',
  'lead_time_days', 'credit_limit', 'payment_terms_days',
]);

/**
 * Tax-identity formats, mirroring the constraints the FINANCE master already
 * enforces (`chk_parties_gstin_format`).
 *
 * `vendors` has no such constraint, so the two masters disagreed about what a
 * valid supplier is: this database holds vendor 6 with GSTIN '27AAAABB12C'
 * (eleven characters where the format is fifteen) and PAN 'AABCT123' (eight
 * where it is ten). Neither can ever become a payable party — the INSERT into
 * `parties` is rejected by the check — so a vendor created that way is
 * permanently unpayable, and the failure surfaces far downstream at the first
 * attempt to raise a bill. Validate at the write instead, where the person who
 * typed it is still on the screen.
 *
 * Blank is allowed; both are optional on an unregistered or foreign supplier.
 */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE   = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function validateVendorTaxIds(fields) {
  if (fields.gstin && !GSTIN_RE.test(String(fields.gstin).toUpperCase())) {
    return 'GSTIN must be 15 characters in the format 22AAAAA0000A1Z5. Leave it blank if the supplier is unregistered.';
  }
  if (fields.pan && !PAN_RE.test(String(fields.pan).toUpperCase())) {
    return 'PAN must be 10 characters in the format AAAAA0000A. Leave it blank if it is not known.';
  }
  return null;
}

function vendorFields(body) {
  const out = {};
  for (const col of VENDOR_WRITABLE) {
    if (!(col in body)) continue;
    let v = body[col];
    if (v === '' || v === undefined) v = null;
    if (v !== null && VENDOR_NUMERIC.has(col)) {
      const n = parseFloat(v);
      v = Number.isFinite(n) ? n : null;
    }
    if (col === 'msme_status' && v !== null) v = v === true || v === 'true';
    // Tax ids are case-insensitive in law and uppercase by convention; both the
    // format check above and the GSTIN match in vendorIdentity are exact, so
    // normalise once here rather than at every comparison.
    if ((col === 'gstin' || col === 'pan') && v !== null) v = String(v).trim().toUpperCase();
    out[col] = v;
  }
  return out;
}

router.post('/vendors', requireProcurement('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const body = req.body || {};
    if (!String(body.vendor_name || '').trim()) {
      return res.status(400).json({ error: 'Vendor name is required.' });
    }

    const fields = vendorFields(body);
    fields.vendor_name = String(body.vendor_name).trim();
    fields.category    = fields.category || 'Raw Materials';
    fields.status      = fields.status || 'active';

    const taxErr = validateVendorTaxIds(fields);
    if (taxErr) return res.status(400).json({ error: taxErr });

    // procurement_settings.default_payment_terms_days had no consumer either:
    // the Settings screen called it the default payment terms and no vendor,
    // PO or bill had ever been created with it. It is a DEFAULT, so it applies
    // only when the form leaves the field blank.
    if (fields.payment_terms_days == null) {
      const settings = await getProcSettings(companyId);
      const dflt = parseInt(settings.default_payment_terms_days, 10);
      if (Number.isFinite(dflt)) fields.payment_terms_days = dflt;
    }

    const cols = [...Object.keys(fields), 'company_id'];
    const vals = [...Object.values(fields), companyId];

    // The vendor row and its finance identity are created in ONE transaction.
    // A vendor without a party cannot be paid — every AP document FKs
    // parties(id) — so committing the vendor alone would produce exactly the
    // half-registered supplier this module used to be full of: 0 of 6 vendors
    // carried a party_id and the 3-way-match bill path fell back to matching
    // the name. resolveVendorParty() is what makes the link deterministic; it
    // belongs to the same commit as the row that needs it.
    const client = await pool.connect();
    let created, identity;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO vendors (${cols.join(', ')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        vals
      );
      created = rows[0];
      identity = await resolveVendorParty(client, created.id);
      created.party_id = identity.party?.id ?? null;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'procurement', recordId: created.id,
      recordType: 'vendor', action: 'create',
      oldData: null, newData: created, req,
    });
    res.status(201).json({
      ...created,
      // Surfaced so a caller can see whether this vendor joined an existing
      // finance party or minted one, rather than having to infer it.
      finance_party: identity.party
        ? { id: identity.party.id, party_code: identity.party.party_code, matched_on: identity.matchedOn }
        : null,
    });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── Update vendor ─────────────────────────────────────────────────────────────
router.put('/vendors/:id', requireProcurement('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { id } = req.params;
    const body = req.body || {};
    if (!String(body.vendor_name || '').trim()) {
      return res.status(400).json({ error: 'Vendor name is required.' });
    }

    // Only the keys the caller actually sent are updated, so the wider form does
    // not blank a column an older client never sends.
    const fields = vendorFields(body);
    fields.vendor_name = String(body.vendor_name).trim();
    if ('category' in fields && !fields.category) fields.category = 'Raw Materials';
    if ('status'   in fields && !fields.status)   fields.status   = 'active';

    const taxErr = validateVendorTaxIds(fields);
    if (taxErr) return res.status(400).json({ error: taxErr });

    const cols = Object.keys(fields);
    const params = Object.values(fields);
    params.push(id);
    const idParam = `$${params.length}`;
    let cidCond = '';
    if (companyId) {
      params.push(companyId);
      cidCond = `AND (company_id = $${params.length} OR company_id IS NULL)`;
    }

    const client = await pool.connect();
    let updated, identity;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE vendors SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=NOW()
         WHERE id=${idParam} AND deleted_at IS NULL ${cidCond} RETURNING *`,
        params
      );
      if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendor not found.' }); }
      updated = rows[0];

      // Bind on edit too, not only on create: every vendor that predates the
      // identity service reaches a bound state the first time somebody saves it,
      // and a vendor whose GSTIN was corrected here can now be matched to the
      // party that already carries it. resolveVendorParty() is idempotent — an
      // already-bound vendor is verified and returned unchanged.
      identity = await resolveVendorParty(client, updated.id);
      updated.party_id = identity.party?.id ?? null;

      // Keep the finance identity in step with the trading identity. Only the
      // fields the caller actually sent are pushed, and only onto a party this
      // vendor exclusively owns (the unique index guarantees that) — a party
      // shared with pre-existing finance data is never rewritten from here.
      const syncable = { name: 'vendor_name', email: 'email', phone: 'phone', address: 'address',
                         city: 'city', state: 'state', website: 'website',
                         gstin: 'gstin', pan: 'pan', payment_terms: 'payment_terms_days' };
      const sets = [], vals = [];
      for (const [partyCol, vendorCol] of Object.entries(syncable)) {
        if (!(vendorCol in fields)) continue;
        const v = vendorCol === 'vendor_name' ? updated.vendor_name : fields[vendorCol];
        if (v == null || v === '') continue;
        vals.push(v);
        sets.push(`${partyCol} = $${vals.length}`);
      }
      if (sets.length && identity.party?.id) {
        vals.push(identity.party.id);
        await client.query(
          `UPDATE parties SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
            WHERE id = $${vals.length} AND deleted_at IS NULL`,
          vals
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'procurement', recordId: updated.id,
      recordType: 'vendor', action: 'update',
      oldData: null, newData: updated, req,
    });
    res.json({
      ...updated,
      finance_party: identity.party
        ? { id: identity.party.id, party_code: identity.party.party_code, matched_on: identity.matchedOn }
        : null,
    });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── Vendor Scorecard & Ratings ────────────────────────────────────────────────
router.get('/vendors/:id/scorecard', requireProcurement('view'), async (req, res) => {
  try {
    // Scoped: unscoped, any tenant could read another's supplier performance
    // history by walking vendor ids.
    const { rows } = await pool.query(`
      SELECT vr.*, po.po_number
      FROM vendor_ratings vr
      JOIN vendors v ON v.id = vr.vendor_id
      LEFT JOIN purchase_orders po ON po.id = vr.po_id
      WHERE vr.vendor_id = $1
        AND ($2::int IS NULL OR v.company_id = $2 OR v.company_id IS NULL)
      ORDER BY vr.rated_at DESC
    `, [req.params.id, cid(req)]);
    const cnt = rows.length;
    const avg = f => cnt ? parseFloat((rows.reduce((s, r) => s + (+r[f] || 0), 0) / cnt).toFixed(1)) : 0;
    res.json({ ratings: rows, avg_quality: avg('quality_score'), avg_delivery: avg('delivery_score'), avg_price: avg('price_score'), avg_overall: avg('overall_score') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendor-ratings', requireProcurement('edit', 'qc_manager'), async (req, res) => {
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
router.get('/dashboard', requireProcurement('view'), async (req, res) => {
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
      `SELECT COALESCE(SUM(${poSpendInr('purchase_orders')}), 0) as total
       FROM purchase_orders
       WHERE order_date >= DATE_TRUNC('month', CURRENT_DATE)
       AND ${sqlPoCommitted('status')} AND deleted_at IS NULL${cidFilter}`, params
    );

    // Additional live KPIs
    const [openRFQs, pendingGRNs, ytdSpend, spendByVendor] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM rfqs WHERE status NOT IN ('closed','cancelled')${cidFilter}`, params),
      pool.query(`SELECT COUNT(*) AS count FROM goods_receipt_notes WHERE (status IS NULL OR status = 'pending') AND deleted_at IS NULL${cidFilter}`, params),
      pool.query(`SELECT COALESCE(SUM(${poSpendInr('purchase_orders')}),0) AS total FROM purchase_orders WHERE EXTRACT(year FROM order_date)=EXTRACT(year FROM CURRENT_DATE) AND ${sqlPoCommitted('status')} AND deleted_at IS NULL${cidFilter}`, params),
      companyId ? pool.query(`SELECT COALESCE(v.vendor_name,'Unknown') AS vendor, SUM(${poSpendInr('po')}) AS spend FROM purchase_orders po LEFT JOIN vendors v ON v.id=po.supplier_id WHERE po.company_id=$1 AND ${sqlPoCommitted('po.status')} AND po.deleted_at IS NULL AND po.order_date>=DATE_TRUNC('month',CURRENT_DATE) GROUP BY v.vendor_name ORDER BY spend DESC LIMIT 5`, [companyId]) : Promise.resolve({ rows: [] }),
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
// Values are INR — see spendAnalytics.service.js for why the raw
// `total_amount` this used to sum was the wrong column.
router.get('/dashboard/spend-trend', requireProcurement('view'), async (req, res) => {
  try {
    const rows = await loadSpendTrend({ companyId: cid(req), months: req.query.months });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Spend analytics: vendor, commodity category, month, supplier type ────────
// Returns every facet in one response rather than one array chosen by
// `group_by`: the Procurement Reports page renders all of them side by side,
// and the old single-array shape meant it read `by_vendor` off an array and
// rendered "No data" on every panel.
//
// `from`/`to` are the documented names. `from_date`/`to_date` are still
// accepted because that is what the old handler read — the page sent
// `from`/`to`, so the date filter silently did nothing.
router.get('/analytics/spend', requireProcurement('view'), async (req, res) => {
  try {
    const { from, to, from_date, to_date, limit } = req.query;
    res.json(await loadSpendFacets({
      companyId: cid(req),
      from: from || from_date || null,
      to: to || to_date || null,
      limit: resolveSpendLimit(limit),
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// SAVINGS REGISTER — identified → negotiated → contracted → realised
// ════════════════════════════════════════════════════════════════════════════
// The module a CPO is measured on, and the one the parity audit found entirely
// absent. See services/savingsRegister.service.js for why almost every rule in
// it is a refusal: a savings register is the most gameable object in
// procurement, and each guard blocks one well-known way of inflating the number.

router.get('/savings/pipeline', requireProcurement('view'), async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(await loadPipeline({ companyId: cid(req), from: from || null, to: to || null }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/savings', requireProcurement('view'), async (req, res) => {
  try {
    res.json(await listInitiatives({
      companyId: cid(req),
      stage: req.query.stage, lever: req.query.lever,
      vendorId: req.query.vendor_id, limit: req.query.limit,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/savings/:id', requireProcurement('view'), async (req, res) => {
  try {
    const one = await getInitiative({ companyId: cid(req), id: parseInt(req.params.id, 10) });
    if (!one) return res.status(404).json({ error: 'Initiative not found' });
    res.json(one);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/savings', requireProcurement('add'), async (req, res) => {
  try {
    const out = await createInitiative({
      companyId: cid(req), userId: req.user?.userId, body: req.body,
    });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.status(201).json(out.initiative);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stage transitions follow a graph — identified → realised in one hop is
// refused, because the intermediate states ARE the evidence.
router.patch('/savings/:id/stage', requireProcurement('edit'), async (req, res) => {
  try {
    const out = await changeStage({
      companyId: cid(req), userId: req.user?.userId,
      id: parseInt(req.params.id, 10),
      toStage: req.body?.stage,
      note: req.body?.note,
      // ⚠ Moving to `realised` needs finance sign-off, and the person who raised
      // the initiative cannot be the one who signs it. `finance:approve`, not
      // `procurement:edit`, is the authority that matters for that transition —
      // so it is checked here rather than trusting the body's own claim.
      financeApproval: req.body?.finance_approval === true
        ? await callerHoldsFinanceApproval(req)
        : false,
    });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json(out.initiative);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/savings/:id/realisation', requireProcurement('edit'), async (req, res) => {
  try {
    const out = await postRealisation({
      companyId: cid(req), userId: req.user?.userId,
      id: parseInt(req.params.id, 10), body: req.body,
    });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.status(201).json(out.event);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Does this caller actually hold finance approval authority?
 *
 * A body flag saying `finance_approval: true` is the caller's own assertion.
 * Trusting it would make the sign-off gate decorative — anyone with
 * `procurement:edit` could self-certify by setting a boolean. The matrix is the
 * authority, so it is consulted.
 */
async function callerHoldsFinanceApproval(req) {
  const perm = await permissionFor(req, 'finance');
  return perm?.can_approve === true;
}

// ── TCO portfolio: the savings board ─────────────────────────────────────────
// The audit's sharpest finding was that the TCO engine "runs at the
// quote-comparison moment and never rolls up into a portfolio view". This is
// that rollup, over the frozen `procurement_award_decisions` rows.
//
// ⚠ Awarded events are NEVER re-scored — vendor performance and the TCO
// parameters both move, so re-running the engine over a past decision reports a
// number that was never on the buyer's screen. Only OPEN events are scored live,
// and they are returned in their own block rather than summed into the result.
router.get('/analytics/tco-portfolio', requireProcurement('view'), async (req, res) => {
  try {
    const { from, to, from_date, to_date, limit } = req.query;
    res.json(await loadTcoPortfolio({
      companyId: cid(req),
      from: from || from_date || null,
      to: to || to_date || null,
      limit,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Invoice spend, non-PO spend and the maverick ratio ───────────────────────
// The cube above measures what was ORDERED. This measures what was INVOICED,
// which is where leakage and off-process buying live. Unlocked by bills.po_id
// (§138) — before that column there was no join from a payable to an order.
router.get('/analytics/invoice-spend', requireProcurement('view'), async (req, res) => {
  try {
    const { from, to, from_date, to_date, limit } = req.query;
    res.json(await loadInvoiceSpend({
      companyId: cid(req),
      from: from || from_date || null,
      to: to || to_date || null,
      limit: resolveSpendLimit(limit),
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 3-Way Match: approve with proper bill creation ────────────────────────────
// Releases an invoice for payment once PO/GRN/invoice reconcile — a financial
// control, so it takes finance or procurement authority rather than any login.
// =====================================================
// EOQ / INVENTORY COST PLANNING
// =====================================================
router.get('/analytics/eoq', requireProcurement('view'), async (req, res) => {
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

    // Every leg below is scoped. Unscoped, this endpoint answered any caller
    // with another tenant's annual demand for a part and the average rate they
    // pay for it — the two numbers a competitor would most like to have.
    const companyId = cid(req);

    const itemResult = await pool.query(
      `SELECT id, item_code, item_name, COALESCE(reorder_level, 0) AS reorder_level
       FROM inventory_items
       WHERE id = $1 AND ($2::INTEGER IS NULL OR company_id = $2)`,
      [itemId, companyId || null]
    );
    if (!itemResult.rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = itemResult.rows[0];

    // Annual demand from last 12 months consumption/outflow
    const demandResult = await pool.query(
      `SELECT COALESCE(SUM(quantity_out), 0) AS annual_demand
       FROM stock_ledger
       WHERE item_id = $1
         AND quantity_out > 0
         AND transaction_date >= CURRENT_DATE - INTERVAL '12 months'
         AND ($2::INTEGER IS NULL OR company_id = $2)`,
      [itemId, companyId || null]
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
           AND ($2::INTEGER IS NULL OR po.company_id = $2)
         ORDER BY po.order_date DESC
         LIMIT 20
       ) x`,
      [itemId, companyId || null]
    );
    let unitCost = parseFloat(costResult.rows[0]?.unit_cost || 0);
    if (unitCost <= 0) {
      const fallback = await pool.query(
        `SELECT COALESCE(AVG(rate), 0) AS unit_cost
         FROM stock_ledger
         WHERE item_id = $1 AND rate > 0
           AND ($2::INTEGER IS NULL OR company_id = $2)`,
        [itemId, companyId || null]
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
router.get('/price-history/items', requireProcurement('view'), async (req, res) => {
  try {
    const q = req.query.q?.trim();
    // This is the component picker behind the Price History and Vendor
    // Comparison screens, so it must not offer another tenant's part numbers.
    const params = [cid(req) || null];
    let idx = 2;
    let qFilter = '';
    if (q) {
      qFilter = `AND (ii.item_name ILIKE $${idx} OR COALESCE(ii.item_code,'') ILIKE $${idx})`;
      params.push(`%${q}%`);
      idx++;
    }
    const { rows } = await pool.query(`
      SELECT id, item_name, COALESCE(item_code,'') AS item_code, COALESCE(unit_of_measure,'') AS uom
      FROM inventory_items ii
      WHERE is_active = true
        AND ($1::INTEGER IS NULL OR ii.company_id = $1)
        ${qFilter}
      ORDER BY item_name
      LIMIT 80
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Time-series price trend for a given item
router.get('/price-history', requireProcurement('view'), async (req, res) => {
  try {
    const { item_id, vendor_id, from, to, limit = 200 } = req.query;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    const companyId = cid(req);
    const params = [parseInt(item_id)];
    let idx = 2;
    let cidFilter = '';
    let phCidFilter = '';
    let vendorFilter = '';
    let dateFilter = '';

    // Both legs of the union take the tenant predicate, on the same bind. The
    // manual leg used to carry none — price_history had no company_id column at
    // all — so scoping the purchase-order leg alone still handed a caller every
    // tenant's hand-keyed prices. See migration 20260904000001.
    //
    // Deliberately NOT `OR company_id IS NULL`, which several other reads in
    // this module allow. A NULL-company row is the codebase's "global" scope and
    // stays visible to a super admin (companyId null ⇒ no predicate at all), but
    // a negotiated unit price nobody could attribute must not become visible to
    // EVERY tenant — that is a smaller copy of the leak this predicate closes.
    if (companyId) {
      const p = idx++;
      cidFilter   = ` AND po.company_id = $${p}`;
      phCidFilter = ` AND company_id = $${p}`;
      params.push(companyId);
    }
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
        WHERE item_id = $1 ${phCidFilter}
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
router.get('/price-history/compare', requireProcurement('view'), async (req, res) => {
  try {
    const { item_id } = req.query;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });
    const companyId = cid(req);

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
              AND ($2::INTEGER IS NULL OR po.company_id = $2)
            UNION ALL
            SELECT unit_price, price_date FROM price_history
            WHERE item_id = $1 AND vendor_id = combined.vendor_id
              AND ($2::INTEGER IS NULL OR company_id = $2)
          ) sub ORDER BY price_date DESC LIMIT 1
        ) lp )::NUMERIC, 2) AS last_price,
        MAX(combined.price_date) AS last_quoted
      FROM (
        SELECT po.supplier_id AS vendor_id, NULL::VARCHAR AS vendor_name_text,
               poi.rate AS unit_price, po.order_date AS price_date
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.po_id
        WHERE poi.item_id = $1 AND poi.rate > 0
          AND ($2::INTEGER IS NULL OR po.company_id = $2)

        UNION ALL

        SELECT vendor_id, vendor_name_text, unit_price, price_date
        FROM price_history WHERE item_id = $1
          AND ($2::INTEGER IS NULL OR company_id = $2)
      ) combined
      LEFT JOIN vendors v ON v.id = combined.vendor_id
      GROUP BY combined.vendor_id, v.vendor_name, combined.vendor_name_text
      ORDER BY avg_price ASC
    `, [parseInt(item_id), companyId || null]);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Item-based vendor comparison — returns all vendors who quoted for an item, cheapest first
router.get('/vendor-comparison', requireProcurement('view'), async (req, res) => {
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
          AND ($2::INTEGER IS NULL OR ph.company_id = $2)
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
router.post('/price-history', requireProcurement('add'), async (req, res) => {
  try {
    const { item_id, item_name_text, vendor_id, vendor_name_text, unit_price, quantity, price_type, reference_type, reference_number, notes, price_date } = req.body;
    if (!item_id || !unit_price) return res.status(400).json({ error: 'item_id and unit_price are required' });

    // price_history.created_by FKs employees(id), not users(id). This route was
    // writing req.user.userId — a users.id — so the INSERT raised a foreign key
    // violation and answered 500 for every one of the 37 active accounts in
    // this database: the button had never once succeeded. Eighth instance of
    // the trap employeeOf() exists to prevent (see the stock_ledger.created_by
    // memory). NULL is accepted and is the honest value for a service account
    // with no employee record.
    const companyId = cid(req);
    const { rows } = await pool.query(
      `INSERT INTO price_history (item_id, item_name_text, vendor_id, vendor_name_text, unit_price, quantity, price_type, reference_type, reference_number, notes, price_date, created_by, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [item_id, item_name_text||null, vendor_id||null, vendor_name_text||null, unit_price, quantity||null, price_type||'purchase', reference_type||null, reference_number||null, notes||null, price_date||new Date().toISOString().slice(0,10), await employeeOf(req, pool), companyId]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================
// PROCUREMENT SETTINGS
// =====================================================
router.get('/settings', requireProcurement('view'), async (req, res) => {
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

    // Validate the TCO rates before they reach SQL. These feed every vendor
    // comparison in the app, so a typo here silently changes which vendor the
    // buyer is told to award — reject it rather than clamp it.
    const tcoValues = [];
    for (const col of TCO_SETTING_COLS) {
      const dflt = TCO_DEFAULTS[col];
      if (typeof dflt === 'boolean') { tcoValues.push(b[col] ?? dflt); continue; }
      if (b[col] == null || b[col] === '') { tcoValues.push(dflt); continue; }
      const v = parseFloat(b[col]);
      const [lo, hi] = TCO_RANGES[col] || [0, Number.MAX_SAFE_INTEGER];
      if (!Number.isFinite(v) || v < lo || v > hi) {
        return res.status(422).json({ error: `${col} must be a number between ${lo} and ${hi}` });
      }
      tcoValues.push(col === 'tco_horizon_months' ? Math.round(v) : v);
    }

    await pool.query(
      `INSERT INTO procurement_settings (
         company_id,
         default_payment_terms_days, auto_approve_below, grn_qty_tolerance_pct, min_vendor_rating,
         l1_approval_limit, l2_approval_limit, cfo_approval_above,
         enforce_3way_match, block_payment_on_mismatch, allowable_price_variance_pct,
         pr_prefix, po_prefix, grn_prefix, rfq_prefix,
         notify_po_approval, notify_grn_receipt, alert_vendor_rating_drop, alert_overdue_delivery,
         ${TCO_SETTING_COLS.join(', ')},
         updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                 ${TCO_SETTING_COLS.map((_, i) => `$${20 + i}`).join(',')},
                 NOW())
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
         ${TCO_SETTING_COLS.map(c => `${c} = EXCLUDED.${c}`).join(', ')},
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
        ...tcoValues,
      ]
    );
    res.json({ ok: true, tco: Object.fromEntries(TCO_SETTING_COLS.map((c, i) => [c, tcoValues[i]])) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PR EXPORT — already registered above before /:id route

// =====================================================
// RETURN TO VENDOR (RTV)
// =====================================================
router.post('/rtv', requireProcurement('add', 'store_keeper'), async (req, res) => {
  try {
    const rtv = await grnService.createRTV(
      {
        ...req.body,
        company_id: cid(req),
        actor_user_id: req.user?.userId ?? req.user?.id ?? null,
      },
      // return_to_vendor.created_by and stock_ledger.created_by both take an
      // employees.id.
      await employeeOf(req, pool)
    );
    res.status(201).json(rtv);
  } catch (error) {
    // The service raises 400/404/422 for a return that is refused for a stated
    // business reason — a quantity above what was received, a receipt belonging
    // to another tenant, a vendor who did not supply it. Those are not 500s.
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/rtv', requireProcurement('view', 'store_keeper'), async (req, res) => {
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

router.get('/rtv/:id', requireProcurement('view', 'store_keeper'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT rtv.*, v.vendor_name FROM return_to_vendor rtv LEFT JOIN vendors v ON v.id=rtv.vendor_id
        WHERE rtv.id=$1 AND ($2::int IS NULL OR rtv.company_id = $2)`,
      [req.params.id, cid(req)]
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
router.get('/avl', requireProcurement('view'), async (req, res) => {
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

router.post('/avl', requireProcurement('add', 'qc_manager'), async (req, res) => {
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

router.patch('/avl/:id/block', requireProcurement('edit', 'qc_manager'), captureBefore('approved_vendor_list'), async (req, res) => {
  try {
    const { reason } = req.body;
    const { rows } = await pool.query(
      `UPDATE approved_vendor_list SET status='blocked', notes=COALESCE($1,notes), updated_at=NOW()
        WHERE id=$2 AND ($3::int IS NULL OR company_id = $3) RETURNING *`,
      [reason||null, req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'AVL entry not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Removing an approved-vendor-list entry changes who may be bought from at all.
router.delete('/avl/:id', allowRoles('super_admin','admin','procurement_manager','qc_manager'), captureBefore('approved_vendor_list'), async (req, res) => {
  try {
    // Reports whether anything was actually removed rather than a blanket ok:
    // unscoped, this returned { ok: true } for another tenant's id it had not
    // touched, which reads to the caller as a successful delist.
    const { rowCount } = await pool.query(
      `DELETE FROM approved_vendor_list WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid(req)]
    );
    if (!rowCount) return res.status(404).json({ error: 'AVL entry not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =====================================================
// QUALITY INSPECTION (INCOMING)
// =====================================================
router.get('/quality-inspections', requireProcurement('view', 'qc_manager', 'qc_engineer'), async (req, res) => {
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

/**
 * POST /quality-inspections — record an incoming inspection against a receipt.
 *
 * This route used to write `quality_inspections` and stop. That made the screen
 * a dead end: a storekeeper marked a receipt "pass", saw it saved, and the goods
 * stayed held for inspection for ever, because the ONLY thing that releases held
 * stock is the rollup over `quality_tests` — and that table lives in the Quality
 * module, which this screen never touched. Verified live: inspection 201, GRN
 * `quality_status` still 'pending', zero stock-ledger rows.
 *
 * So the inspection now also writes the tests it represents. Incoming quality
 * has one system of record; this screen is a writer of it rather than a fourth
 * opinion beside it, and a pass here releases exactly the stock a pass in the
 * Quality module would.
 *
 * A failure is NOT auto-NCR'd here, unlike quality.routes' own test path. This
 * screen already has its own explicit NCR flow beside it (POST /procurement/ncr,
 * which the same page calls), and raising a second automatic one would give the
 * buyer two records of one rejection.
 */
router.post('/quality-inspections', requireProcurement('add', 'qc_manager', 'qc_engineer'), async (req, res) => {
  try {
    const { grn_id, inspector_id, inspection_date, overall_result, notes, items } = req.body;
    if (!grn_id) return res.status(400).json({ error: 'grn_id is required' });
    const companyId = cid(req);
    const verdict   = String(overall_result || 'pass').toLowerCase() === 'fail' ? 'fail' : 'pass';
    const actorEmp  = await employeeOf(req, pool);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Scoped: the receipt has to be this company's before anything is written
      // against it, or an inspection could be filed on another tenant's goods.
      const { rows: [grn] } = await client.query(
        `SELECT id FROM goods_receipt_notes
          WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
        [grn_id, companyId]
      );
      if (!grn) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Goods receipt not found' }); }

      const { rows: [qi] } = await client.query(`
        INSERT INTO quality_inspections (company_id, grn_id, inspector_id, inspection_date, overall_result, notes, status)
        VALUES ($1,$2,$3,$4,$5,$6,'completed') RETURNING *
      `, [companyId, grn_id, inspector_id||null, inspection_date||new Date().toISOString().slice(0,10), verdict, notes||null]);

      const lines = Array.isArray(items) ? items : [];
      for (const item of lines) {
        await client.query(`
          INSERT INTO quality_inspection_items (inspection_id, item_id, parameter, expected_value, actual_value, result, remarks)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [qi.id, item.item_id, item.parameter||null, item.expected_value||null, item.actual_value||null, item.result||'pass', item.remarks||null]);
      }

      // The same inspection, expressed as completed quality_tests so the rollup
      // can act on it. When the inspector recorded no per-parameter lines, the
      // overall verdict is still a result and gets one row — otherwise a
      // header-only "pass" would leave the receipt with no tests at all, which
      // the rollup reads as 'not_required' rather than 'passed', and the goods
      // would stay held exactly as before.
      const tests = lines.length
        ? lines.map((i) => ({
            item_id: i.item_id ?? null,
            test_name: i.parameter || 'Incoming inspection',
            parameter: i.parameter || null,
            expected_value: i.expected_value ?? null,
            actual_value: i.actual_value ?? null,
            result: String(i.result || 'pass').toLowerCase() === 'fail' ? 'fail' : 'pass',
            remarks: i.remarks || null,
          }))
        : [{
            item_id: null,
            test_name: 'Incoming inspection',
            parameter: null, expected_value: null, actual_value: null,
            result: verdict, remarks: notes || null,
          }];

      for (const t of tests) {
        await client.query(`
          INSERT INTO quality_tests
            (company_id, source_type, source_id, grn_id, item_id, stage, test_name, parameter,
             expected_value, actual_value, result, status, remarks, tested_by, tested_at, created_by)
          VALUES ($1,'grn',$2,$2,$3,'IQC',$4,$5,$6,$7,$8,'completed',$9,$10,NOW(),$10)
        `, [companyId, grn_id, t.item_id, t.test_name, t.parameter,
            t.expected_value, t.actual_value, t.result, t.remarks, actorEmp]);
      }

      await client.query('COMMIT');

      // AFTER the commit, deliberately: the rollup reads through the pool, so
      // rows still inside this transaction would be invisible to it and it
      // would compute the receipt's status from a state that does not exist.
      let rollup = null;
      try {
        rollup = await rollupQualityStatus({ grn_id });
      } catch (e) {
        // The inspection is recorded and committed; a release failure must not
        // undo it. Surfaced rather than swallowed, because "inspected, not
        // released" is a state someone has to chase.
        console.error(`[procurement] quality rollup for GRN ${grn_id} failed:`, e.message);
      }

      res.status(201).json({ ...qi, quality_status: rollup?.grn_status ?? null, stock_released: rollup?.released ?? false });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── NCR (Non-Conformance Report) ─────────────────────────────────────────────
router.get('/ncr', requireProcurement('view', 'qc_manager', 'qc_engineer'), async (req, res) => {
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

router.post('/ncr', requireProcurement('add', 'qc_manager', 'qc_engineer'), async (req, res) => {
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
router.patch('/ncr/:id/close', allowRoles('super_admin','admin','qc_manager','procurement_manager'), captureBefore('non_conformance_reports'), async (req, res) => {
  try {
    const { capa_action, capa_due_date } = req.body;
    const { rows } = await pool.query(`
      UPDATE non_conformance_reports SET status='closed', capa_action=$1, capa_due_date=$2, closed_at=NOW()
       WHERE id=$3 AND ($4::int IS NULL OR company_id = $4) RETURNING *
    `, [capa_action||null, capa_due_date||null, req.params.id, cid(req)]);
    if (!rows[0]) return res.status(404).json({ error: 'NCR not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/ncr/:id/attachment', requireProcurement('edit', 'qc_manager', 'qc_engineer'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    // Ownership is checked BEFORE the upload: uploading first and scoping after
    // would push a file into storage on behalf of a record the caller may not
    // own, and that file stays there whatever the UPDATE then returns.
    const { rows: own } = await pool.query(
      `SELECT id FROM non_conformance_reports WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid(req)]
    );
    if (!own[0]) return res.status(404).json({ error: 'NCR not found' });
    const file_url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    const { rows: [ncr] } = await pool.query(
      `UPDATE non_conformance_reports SET attachment_url=$1 WHERE id=$2 RETURNING id, attachment_url`,
      [file_url, req.params.id]
    );
    if (!ncr) return res.status(404).json({ error: 'NCR not found' });
    res.json(ncr);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mounted at '/' so the paths are exactly what they were before the split —
// /three-way-match, /three-way-match/:id/approve, /three-way-match/:id/resolve.
// API compatibility is the point of the mount: no client changes.
router.use('/', threeWayMatchRoutes);

export default router;

// Exported for integration.procurementIntegrity.test.js. The tax-basis defect
// this function carried (comparing a tax-exclusive receipt value against a
// tax-inclusive order total, so every GST-bearing receipt read as a discrepancy)
// is exactly the kind that only a real PO with real tax can catch, and it is
// worth a permanent regression test rather than a one-off manual check.
// Re-exported from its new home so existing importers — the GRN auto-match
// trigger above, and the integration suites — keep working unchanged.
export { createThreeWayMatchRecord };

