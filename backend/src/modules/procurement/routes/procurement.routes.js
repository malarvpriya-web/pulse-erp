import express from 'express';
import multer from 'multer';
import pool from '../../shared/db.js';
import { dimension } from '../../../shared/dashboardFilters.js';
import prRepo from '../repositories/purchaseRequest.repository.js';
import poRepo from '../repositories/purchaseOrder.repository.js';
import grnService from '../services/grn.service.js';
import { logAudit } from '../../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../../services/WorkflowNotificationService.js';
import { nextRfqNumber, nextPurchaseOrderNumber } from '../../../shared/docNumber.js';
import { uploadFile } from '../../../services/StorageService.js';
import { checkAndCreateAlerts } from '../../../services/stockAlerts.js';
import { sendPurchaseOrderToVendor, sendRfqToVendor } from '../../../utils/mailer.js';
import { companyOf } from '../../../shared/scope.js';
import { hasRole, allowRoles } from '../../../middlewares/auth.middleware.js';
import { requiredBand, assertCanDecideAmount } from '../procurement.authz.js';
import { rankOptions, TCO_DEFAULTS } from '../engines/tcoEngine.js';
import {
  loadTcoParams, loadVendorPerformance, loadAnnualDemand, masterRate, tcoBasis,
} from '../services/tco.service.js';

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

      const poNumber = await poRepo.getNextNumber();
      const po = await poRepo.create(client, {
        po_number:      poNumber,
        pr_id:          pr.id,
        supplier_id:    supplierId,
        order_date:     new Date().toISOString().slice(0, 10),
        subtotal,
        tax_amount:     0,
        total_amount:   subtotal,
        notes:          pr.notes,
        // purchase_orders.created_by FKs employees(id), not users(id) — same
        // recurring bug as stock_ledger.created_by (project_stock_ledger_created_by_fk).
        // Surfaced live while verifying §5.2: this 500'd on every convert for
        // any actor without a matching employees row, including super_admin.
        created_by:     req.user?.employee_id ?? null,
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
router.get('/purchase-orders/stats', async (req, res) => {
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
router.post('/tco/advisory', async (req, res) => {
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
  const itemTax = n(it.gst_rate ?? it.default_gst_rate);

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
        // Same purchase_orders.created_by FK-to-employees bug as convert-to-po above.
        created_by: req.user?.employee_id ?? null
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

      const po = await poRepo.updateStatus(client, req.params.id, 'approved');
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
        poRepo.findById(po.id).then(async (fullPo) => {
          if (!fullPo?.supplier_email) return;
          const items = await poRepo.getItems(po.id);
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
      // stock_ledger.created_by FKs employees(id), not users(id) — see
      // project_stock_ledger_created_by_fk memory; a users.id here FK-violates
      // for any actor without a matching employees row (e.g. super_admin).
      req.user.employee_id ?? null
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
router.get('/rfqs/:id', async (req, res) => {
  try {
    const { rows: rfqRows } = await pool.query(`SELECT * FROM rfqs WHERE id=$1`, [req.params.id]);
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
  const itemTax = n(itemRow.gst_rate ?? itemRow.default_gst_rate);

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

router.post('/rfqs', async (req, res) => {
  const client = await pool.connect();
  try {
    const { item_description, quantity, unit, required_by, linked_pr_id, vendor_ids, items } = req.body;
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
    const rfq_number = await nextRfqNumber();
    const first = lineItems[0];
    const { rows } = await client.query(`
      INSERT INTO rfqs (rfq_number, pr_id, item_description, quantity, unit, required_by, vendor_ids, status, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)
      RETURNING *
    `, [
      rfq_number, linked_pr_id || null,
      first.item_name || first.item_description || '', first.quantity || 1, first.unit || 'Nos',
      required_by || null, JSON.stringify(vendor_ids || []), cid(req),
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

router.post('/rfqs/:rfqId/responses/:vendorId', async (req, res) => {
  try {
    const { rfqId, vendorId } = req.params;
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const poNum = await nextPurchaseOrderNumber();
      const { rows: poRows } = await client.query(`
        INSERT INTO purchase_orders (po_number, supplier_id, pr_id, total_amount, status, order_date, company_id)
        VALUES ($1,$2,$3,$4,'draft',CURRENT_DATE,$5) RETURNING *
      `, [poNum, vendorId, rfqRows[0].pr_id || null, quoteRows[0]?.total_amount || 0, cid(req)]);
      po = poRows[0];

      // Carry real line items onto the PO — an RFQ-award that only writes the
      // header (no purchase_order_items) ships completely empty and breaks
      // GRN's 3-way match (nothing to select as "received against"). Prefer the
      // linked PR's real lines (same carryover convert-to-po uses above); else
      // fall back to the RFQ's own rfq_items rows — real multi-line data since
      // the rfq_items table was added, not the old single-scalar-field guess.
      const prItems = rfqRows[0].pr_id ? await prRepo.getItems(rfqRows[0].pr_id, client) : [];
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
          : [{ item_id: null, item_name: rfqRows[0].item_description, quantity: rfqRows[0].quantity || 1 }];
        const totalQty  = lineItems.reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0) || 1;
        const totalAmt  = parseFloat(quoteRows[0]?.total_amount) || 0;
        const unitPrice = parseFloat(quoteRows[0]?.unit_price) || null;
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
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.warn('[award] PO auto-create skipped:', e.message);
      po = null;
    } finally {
      client.release();
    }
    // Freeze what this award was decided on. The rates behind a TCO can change
    // at any time, and once they do nobody can show what the comparison said on
    // the day — so the figures and the basis are stored, never recomputed.
    const decision = await recordAwardDecision({
      rfqId, vendorId, poId: po?.id ?? null, req,
    }).catch((e) => {
      // A failed audit write must not undo a completed award. It is reported
      // rather than swallowed, because a silent gap here is exactly the debt
      // this table exists to remove.
      console.warn('[award] TCO decision record failed:', e.message);
      return null;
    });

    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'procurement', recordId: rfqRows[0].id, recordType: 'rfq', action: 'award', oldData: null, newData: { ...rfqRows[0], awarded_vendor_id: vendorId, quote: quoteRows[0] ?? null, tco_decision: decision }, req });
    res.json({ success: true, rfq: rfqRows[0], quote: quoteRows[0], po, tco_decision: decision });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
router.get('/award-decisions', async (req, res) => {
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

// Extracted so §5.6's GRN-creation auto-trigger can run the exact same
// matching logic as the manual POST below instead of a second
// re-implementation. Behavior unchanged from the original inline handler.
async function createThreeWayMatchRecord(companyId, { po_id, grn_id, vendor_invoice_no, vendor_invoice_date, vendor_invoice_amount }) {
  if (!po_id) throw Object.assign(new Error('po_id is required'), { status: 400 });
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
  `, [companyId, po_id, grn_id || null, vendor_invoice_no || null, vendor_invoice_date || null, inv_amount, po_amount, grn_amount, match_status]);
  return rows[0];
}

router.post('/three-way-match', async (req, res) => {
  try {
    const match = await createThreeWayMatchRecord(cid(req), req.body);
    res.status(201).json(match);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
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
      pool.query(`SELECT COUNT(*) AS count FROM rfqs WHERE status NOT IN ('closed','cancelled')${cidFilter}`, params),
      pool.query(`SELECT COUNT(*) AS count FROM goods_receipt_notes WHERE (status IS NULL OR status = 'pending') AND deleted_at IS NULL${cidFilter}`, params),
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

    // "Block payment on 3-way-match mismatch" was written and read only by
    // Settings' own CRUD — no bill/approval/payment route ever checked it, so
    // a flagged discrepancy could be freely approved (and the bill this
    // creates freely paid) regardless of the setting. This is the one place
    // a discrepancy actually turns into a payable bill, so it's the correct
    // choke point: block the approval itself unless the discrepancy has
    // already been cleared via PATCH /three-way-match/:id/resolve.
    const { rows: existingRows } = await pool.query(
      `SELECT match_status FROM three_way_matches WHERE id=$1`, [req.params.id]
    );
    if (!existingRows[0]) return res.status(404).json({ error: 'Match record not found' });
    if (existingRows[0].match_status === 'discrepancy') {
      const settings = await getProcSettings(companyId);
      if (settings.block_payment_on_mismatch) {
        return res.status(400).json({
          error: 'This PO/GRN/invoice match has a flagged discrepancy and payment-blocking is enabled in Procurement Settings. Resolve the discrepancy first (PATCH /three-way-match/:id/resolve) before approving for payment.',
        });
      }
    }

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
      ON CONFLICT (company_id, bill_number) DO NOTHING
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

    // ON CONFLICT DO NOTHING returns zero rows on a duplicate invoice number —
    // this used to be swallowed silently, so the match record showed
    // "approved" with bill_id: null forever and nobody was told a payable
    // bill was never created. Surface the existing bill instead so the
    // approval is traceable to a real (possibly pre-existing) bill.
    let billId = billRes.rows[0]?.id ?? null;
    let duplicateBill = false;
    if (!billId) {
      const { rows: dupRows } = await pool.query(
        `SELECT id FROM bills WHERE company_id = $1 AND bill_number = $2 AND deleted_at IS NULL LIMIT 1`,
        [companyId, rows[0].vendor_invoice_no]
      );
      billId = dupRows[0]?.id ?? null;
      duplicateBill = true;
    }

    logAudit({
      userId, module: 'procurement', recordId: rows[0].id,
      recordType: 'three_way_match', action: 'approve',
      oldData: null, newData: rows[0], req,
    });

    res.json({ ...rows[0], bill_id: billId, ...(duplicateBill ? { duplicate_invoice: true } : {}) });
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
  // TCO costing rates — mirrored from the engine so a company with no settings
  // row still gets a defensible model rather than zeros (zeros would disable
  // half the cost drivers and make every vendor look identical).
  ...TCO_DEFAULTS,
};

// The TCO rates the settings PUT owns. Kept as a list so the INSERT, the
// ON CONFLICT SET and the validation cannot drift apart the way the 19
// hand-written columns above already have to be kept in step by eye.
const TCO_SETTING_COLS = Object.keys(TCO_DEFAULTS);

// Rates are percentages and per-event costs, not free numbers. A negative
// carrying rate turns holding cost into a rebate and inverts every ranking on
// the comparison page, so it is rejected at the door rather than clamped
// silently — a buyer who typed -18 needs to know it did not take.
const TCO_RANGES = {
  cost_of_capital_pct:          [0, 100],
  inventory_carrying_pct:       [0, 100],
  rework_cost_pct:              [0, 500],
  default_freight_pct:          [0, 100],
  gst_input_credit_pct:         [0, 100],
  single_source_risk_pct:       [0, 100],
  service_level_z:              [0, 5],
  ordering_cost_per_po:         [0, 1e9],
  inspection_cost_per_receipt:  [0, 1e9],
  expedite_cost_per_late_order: [0, 1e9],
  tco_horizon_months:           [1, 120],
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
router.post('/rtv', async (req, res) => {
  try {
    const grn = await grnService.createRTV(
      { ...req.body, company_id: cid(req) },
      req.user?.employee_id ?? null
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

