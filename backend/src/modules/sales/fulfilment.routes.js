/**
 * fulfilment.routes.js — delivery notes and credit notes.
 *
 * Rewritten during the CRM remediation (2026-08-19). Every route in this file
 * was broken, and each failure was hidden rather than reported:
 *
 *   • `delivery_orders` has never existed in any migration. GET swallowed the
 *     error and returned `[]` (indistinguishable from "no deliveries"), and
 *     POST 500'd. The real table is `delivery_notes`.
 *
 *   • `credit_notes` was written as `(order_id, amount, reason)`. None of those
 *     three columns exist. `credit_notes` is a GST document raised against an
 *     INVOICE, carrying a taxable value and a CGST/SGST/IGST split — adding
 *     `order_id` and a bare `amount` would have given one table two meanings,
 *     which is the exact anti-pattern the customer-master consolidation removed.
 *     A credit note is therefore now raised against an invoice; the caller may
 *     still pass a sales order, and the invoice is resolved from it.
 *
 *   • The whole router was mounted with `verifyToken` but no permission check,
 *     so any authenticated user — including a self-service employee — could
 *     issue a credit note against a customer invoice. Both routes now require
 *     the `sales` permission, and writes are audited.
 */
import express from 'express';
import pool from '../shared/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { respondError } from '../../shared/pgErrors.js';
import { logAudit } from '../../services/AuditService.js';

const router = express.Router();

/**
 * GST credit-note reasons. This is a CHECK constraint on `credit_notes.reason`,
 * not free text — the previous route passed whatever the caller typed, which
 * would have failed the constraint even once the column names were right. Any
 * narrative explanation belongs in `notes`.
 */
const CREDIT_NOTE_REASONS = [
  'sales_return', 'price_revision', 'deficiency_of_service', 'post_sale_discount', 'other',
];

// ── Delivery notes ───────────────────────────────────────────────────────────

router.get('/deliveries', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dn.id, dn.dn_number, dn.customer_name, dn.delivery_date, dn.delivered_by,
              dn.items_delivered, dn.status, dn.notes, dn.created_at
         FROM delivery_notes dn
        WHERE ($1::int IS NULL OR dn.company_id = $1)
        ORDER BY dn.delivery_date DESC NULLS LAST, dn.created_at DESC
        LIMIT 500`,
      [companyOf(req)]
    );
    res.json(rows);
  } catch (e) { respondError(res, e); }
});

router.post('/deliveries', requirePermission('sales', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const cid = companyOf(req);
    const userId = req.user?.userId ?? req.user?.id ?? null;
    const { customer_name, delivery_date, items_delivered, delivered_by, status, notes, ticket_id } = req.body;

    if (!customer_name?.trim()) {
      return res.status(400).json({ error: 'customer_name is required' });
    }

    await client.query('BEGIN');
    await client.query(`CREATE SEQUENCE IF NOT EXISTS delivery_note_number_seq`);
    const { rows: seq } = await client.query(`SELECT nextval('delivery_note_number_seq')::bigint AS n`);
    const dnNumber = `DN-${new Date().getFullYear()}-${String(seq[0].n).padStart(4, '0')}`;

    const { rows } = await client.query(
      `INSERT INTO delivery_notes
         (dn_number, customer_name, delivery_date, delivered_by, items_delivered,
          status, notes, ticket_id, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        dnNumber, customer_name.trim(), delivery_date || null, delivered_by || null,
        items_delivered || null, status || 'pending', notes || null,
        ticket_id || null, cid,
      ]
    );
    await client.query('COMMIT');

    logAudit({ userId, module: 'Sales', recordId: rows[0].id, recordType: 'delivery_note',
               action: 'create', newData: { dn_number: dnNumber, customer_name }, req });
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    respondError(res, e);
  } finally { client.release(); }
});

// ── Credit notes ─────────────────────────────────────────────────────────────

router.get('/credit', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cn.id, cn.credit_note_number, cn.original_invoice_id, cn.party_name,
              cn.party_gstin, cn.credit_note_date, cn.reason, cn.taxable_value,
              cn.cgst, cn.sgst, cn.igst, cn.cess, cn.total_amount, cn.status,
              cn.notes, cn.created_at,
              i.invoice_number
         FROM credit_notes cn
         LEFT JOIN invoices i ON i.id = cn.original_invoice_id
        WHERE cn.deleted_at IS NULL
          AND ($1::int IS NULL OR cn.company_id = $1)
        ORDER BY cn.created_at DESC
        LIMIT 500`,
      [companyOf(req)]
    );
    res.json(rows);
  } catch (e) { respondError(res, e); }
});

/**
 * POST /delivery/credit — raise a credit note against an invoice.
 *
 * Accepts either `invoice_id` directly, or `order_id` (a sales order) from which
 * the invoice is resolved. A sales order that has not been invoiced cannot be
 * credited — there is nothing to reverse — and that is reported rather than
 * silently written as an orphan.
 *
 * The tax split mirrors the original invoice's supply type: intra-state credits
 * split CGST/SGST, inter-state credit IGST. Passing an explicit split overrides
 * the proportional default.
 */
router.post('/credit', requirePermission('sales', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const cid = companyOf(req);
    const userId = req.user?.userId ?? req.user?.id ?? null;
    const { invoice_id, order_id, amount, reason, notes } = req.body;

    if (!reason || !CREDIT_NOTE_REASONS.includes(reason)) {
      return res.status(400).json({
        error: `reason must be one of: ${CREDIT_NOTE_REASONS.join(', ')}`,
        allowed: CREDIT_NOTE_REASONS,
      });
    }
    if (!invoice_id && !order_id) {
      return res.status(400).json({ error: 'invoice_id (or order_id) is required — a credit note reverses an invoice' });
    }

    await client.query('BEGIN');

    // Resolve the invoice, directly or through the sales order.
    const invRes = await client.query(
      `SELECT i.*, p.name AS resolved_party_name, p.gstin AS resolved_gstin
         FROM invoices i
         LEFT JOIN parties p ON p.id = i.customer_id
        WHERE i.deleted_at IS NULL
          AND ($3::int IS NULL OR i.company_id = $3)
          AND ( ($1::int IS NOT NULL AND i.id = $1)
             OR ($2::int IS NOT NULL AND i.sales_order_id = $2) )
        ORDER BY i.invoice_date DESC
        LIMIT 1`,
      [invoice_id || null, order_id || null, cid]
    );
    if (!invRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: order_id
          ? 'That sales order has no invoice yet — there is nothing to credit.'
          : 'Invoice not found',
      });
    }
    const inv = invRes.rows[0];

    const num = v => parseFloat(v || 0);
    const invoiceTotal = num(inv.total_amount);
    const creditTotal  = amount != null ? num(amount) : invoiceTotal;
    if (creditTotal <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Credit amount must be greater than zero' });
    }
    if (creditTotal > invoiceTotal) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Credit of ${creditTotal} exceeds the invoice total of ${invoiceTotal}`,
      });
    }

    // Split the credit proportionally across the invoice's own tax components,
    // so a partial credit reverses the same tax heads in the same ratio.
    const ratio       = invoiceTotal > 0 ? creditTotal / invoiceTotal : 1;
    const taxableValue = +(num(inv.subtotal) * ratio).toFixed(2);
    const cgst         = +(num(inv.cgst) * ratio).toFixed(2);
    const sgst         = +(num(inv.sgst) * ratio).toFixed(2);
    const igst         = +(num(inv.igst) * ratio).toFixed(2);
    const cess         = +(num(inv.cess) * ratio).toFixed(2);

    await client.query(`CREATE SEQUENCE IF NOT EXISTS credit_note_number_seq`);
    const { rows: seq } = await client.query(`SELECT nextval('credit_note_number_seq')::bigint AS n`);
    const cnNumber = `CN-${new Date().getFullYear()}-${String(seq[0].n).padStart(4, '0')}`;

    const { rows } = await client.query(
      `INSERT INTO credit_notes
         (credit_note_number, original_invoice_id, party_name, party_gstin,
          credit_note_date, reason, supply_type, taxable_value,
          cgst, sgst, igst, cess, total_amount, status, notes, created_by, company_id)
       VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13,$14,$15)
       RETURNING *`,
      [
        cnNumber, inv.id,
        inv.resolved_party_name || inv.party_name || null,
        inv.resolved_gstin || null,
        reason, inv.supply_type || null,
        taxableValue, cgst, sgst, igst, cess, creditTotal,
        notes || null, userId, cid,
      ]
    );
    await client.query('COMMIT');

    logAudit({ userId, module: 'Sales', recordId: rows[0].id, recordType: 'credit_note',
               action: 'create',
               newData: { credit_note_number: cnNumber, invoice_id: inv.id, total_amount: creditTotal },
               req });
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    respondError(res, e);
  } finally { client.release(); }
});

export default router;
