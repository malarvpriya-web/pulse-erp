/**
 * creditNotes.routes.js — Native Credit Note Engine
 *
 * Credit notes are issued to customers to reverse or reduce a sales invoice.
 * Used for: sales returns, price revisions, post-sale discounts, service deficiency.
 * Required for GSTR-1 Table 9 (CDNR) and Table 10 (CDNUR) compliance.
 *
 * Mounted at /api/v1/finance/credit-notes
 */

import { Router } from 'express';
import pool from './db.js';
import { validateGstSplit } from '../../utils/gst.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { companyOf } from '../../shared/scope.js';
import journalRepo from './repositories/journal.repository.js';
import { nextCreditNoteNumber } from './services/creditNoteNumber.service.js';
import { assertBalanced, assertAccountsUsable, assertNotLocked, assertPeriodOpen } from './services/postingGuards.js';

const router = Router();
const uid = req => req.user?.userId ?? req.user?.id ?? null;
// The caller's company — never the request body's (a body company_id used to
// choose the tenant whenever the scope was empty).
const cid = req => companyOf(req);

const safe = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── credit lines against invoice lines ──────────────────────────────────────
   A credit-note line that names original_item_id credits that invoice line. It
   must be a line of the credit note's original invoice, of the same company,
   and the quantity credited on it — by this note and every other ISSUED note —
   may not exceed the quantity the line billed. The invoice lines are locked in
   id order, so two notes against the same line are checked one after the
   other. A posted note (issued, with its journal) releases what it credits on
   a line that billed a pick line: pick_line_invoiced_qty (migration
   20261028000001) counts it, so that quantity can be invoiced again — once. */
class CreditNoteError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}
// Quantity releases (credit_note_items.released_qty, migration 20261028000006):
// only a note whose reason means the quantity came back (sales_return) or was
// billed in error and is not coming back (quantity_correction, migration
// 20261028000007) releases. price_revision, post_sale_discount,
// deficiency_of_service and other credit price only — 'other' used to release
// too, which left a price credit able to free quantity. The same rule is the
// database's (credit_note_items_release_guard / credit_notes_issue_guard).
const RELEASE_REASONS = ['sales_return', 'quantity_correction'];

async function assertCreditLines(client, { companyId, originalInvoiceId, items, reason = null, excludeNoteId = null }) {
  const hasValue = (v) => v != null && String(v).trim() !== '';
  // A quantity correction IS a set of release lines: each names its invoice
  // line and releases exactly the quantity it credits.
  if (reason === 'quantity_correction') {
    if (!(items || []).length) {
      throw new CreditNoteError(422, 'QUANTITY_CORRECTION_LINES_REQUIRED', 'A quantity correction must name the invoice lines it corrects.');
    }
    for (const i of items) {
      if (!i || !hasValue(i.original_item_id) || !hasValue(i.released_qty) || Number(i.released_qty) !== Number(i.quantity)) {
        throw new CreditNoteError(422, 'QUANTITY_CORRECTION_LINE_INVALID',
          'Every line of a quantity correction names its original invoice line and releases exactly the quantity it credits (released_qty = quantity).');
      }
    }
  }
  for (const i of items || []) {
    if (!i || !hasValue(i.released_qty)) continue;
    const r = Number(i.released_qty);
    if (!Number.isFinite(r) || r <= 0) throw new CreditNoteError(422, 'RELEASE_QTY_INVALID', 'released_qty must be a positive quantity.');
    if (!RELEASE_REASONS.includes(reason)) {
      throw new CreditNoteError(422, 'RELEASE_NOT_ALLOWED_FOR_REASON',
        `A ${reason || 'credit'} note credits price only; it cannot release invoiced quantity (only ${RELEASE_REASONS.join(' or ')} notes can).`);
    }
    if (!hasValue(i.original_item_id)) {
      throw new CreditNoteError(422, 'RELEASE_LINE_REQUIRED', 'A quantity release must name the original invoice line (original_item_id).');
    }
    if (r > Number(i.quantity ?? 1) + 1e-9) {
      throw new CreditNoteError(422, 'RELEASE_EXCEEDS_CREDITED', `Line ${i.original_item_id}: the release (${r}) exceeds the quantity credited (${Number(i.quantity ?? 1)}).`);
    }
  }
  const linked = (items || []).filter(i => i && i.original_item_id != null && String(i.original_item_id).trim() !== '');
  if (!linked.length) return;
  if (!originalInvoiceId) {
    throw new CreditNoteError(422, 'ORIGINAL_INVOICE_REQUIRED', 'A credit line that names an invoice line needs the credit note\'s original_invoice_id.');
  }
  const { rows: [inv] } = await client.query(
    `SELECT id FROM invoices WHERE id = $1 AND company_id IS NOT DISTINCT FROM $2`, [originalInvoiceId, companyId]);
  if (!inv) throw new CreditNoteError(404, 'ORIGINAL_INVOICE_NOT_FOUND', 'Original invoice not found.');
  const want = new Map();
  const release = new Map();
  for (const i of linked) {
    const id = Number(i.original_item_id), q = Number(i.quantity);
    if (!Number.isInteger(id) || id <= 0) throw new CreditNoteError(422, 'CREDIT_LINE_INVALID', 'original_item_id must be an invoice line id.');
    if (!Number.isFinite(q) || q <= 0) throw new CreditNoteError(422, 'CREDIT_QUANTITY_INVALID', `Credit quantity for invoice line ${id} must be positive.`);
    want.set(id, (want.get(id) || 0) + q);
    if (hasValue(i.released_qty)) release.set(id, (release.get(id) || 0) + Number(i.released_qty));
  }
  const ids = [...want.keys()].sort((a, b) => a - b);
  const { rows: lines } = await client.query(
    `SELECT id, invoice_id, quantity, pick_list_line_id FROM invoice_items WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [ids]);
  const byId = new Map(lines.map(l => [l.id, l]));
  for (const id of ids) {
    const line = byId.get(id);
    if (!line || Number(line.invoice_id) !== Number(originalInvoiceId)) {
      throw new CreditNoteError(422, 'CREDIT_LINE_NOT_ON_INVOICE', `Invoice line ${id} is not a line of the original invoice.`);
    }
    const { rows: [done] } = await client.query(`
      SELECT COALESCE(SUM(cni.quantity), 0)::float AS q
        FROM credit_note_items cni JOIN credit_notes cn ON cn.id = cni.credit_note_id
       WHERE cni.original_item_id = $1 AND cn.status = 'issued' AND cn.deleted_at IS NULL
         AND cn.id IS DISTINCT FROM $2`, [id, excludeNoteId]);
    const creditable = Number(line.quantity) - done.q;
    if (want.get(id) > creditable + 1e-9) {
      throw new CreditNoteError(409, 'CREDIT_EXCEEDS_INVOICED',
        `Invoice line ${id} billed ${Number(line.quantity)}; ${done.q} already credited, so at most ${creditable} more can be.`,
        { invoice_item_id: id, creditable });
    }
    if (!release.has(id)) continue;
    if (line.pick_list_line_id == null) {
      throw new CreditNoteError(422, 'NO_QUANTITY_TO_RELEASE', `Invoice line ${id} bills no shipped goods, so it has no quantity to release.`);
    }
    const { rows: [rel] } = await client.query(`
      SELECT COALESCE(SUM(cni.released_qty), 0)::float AS q
        FROM credit_note_items cni JOIN credit_notes cn ON cn.id = cni.credit_note_id
       WHERE cni.original_item_id = $1 AND cn.status = 'issued' AND cn.deleted_at IS NULL
         AND cn.id IS DISTINCT FROM $2`, [id, excludeNoteId]);
    const releasable = Number(line.quantity) - rel.q;
    if (release.get(id) > releasable + 1e-9) {
      throw new CreditNoteError(409, 'RELEASE_EXCEEDS_INVOICED',
        `Invoice line ${id} billed ${Number(line.quantity)}; ${rel.q} already released, so at most ${releasable} more can be.`,
        { invoice_item_id: id, creditable: releasable });
    }
  }
  // A sales-return release gives back units that CAME BACK: never more, per
  // order item, than the order's returns received (so_item_returned_qty) less
  // what earlier sales-return notes released — or the same units would be
  // billable again while sitting in our stock.
  if (reason === 'sales_return' && release.size) {
    const { rows: groups } = await client.query(`
      SELECT p.sales_order_id AS so, l.item_id, array_agg(ii.id) AS item_ids
        FROM invoice_items ii JOIN pick_list_lines l ON l.id = ii.pick_list_line_id JOIN pick_lists p ON p.id = l.pick_list_id
       WHERE ii.id = ANY($1::int[]) GROUP BY p.sales_order_id, l.item_id`, [[...release.keys()]]);
    for (const g of groups) {
      const mine = g.item_ids.reduce((t, x) => t + (release.get(Number(x)) || 0), 0);
      const { rows: [r] } = await client.query(`
        SELECT so_item_returned_qty($1, $2)::float AS returned,
               (SELECT COALESCE(SUM(c2.released_qty), 0) FROM credit_note_items c2
                  JOIN credit_notes n2 ON n2.id = c2.credit_note_id
                  JOIN invoice_items i2 ON i2.id = c2.original_item_id
                  JOIN pick_list_lines l2 ON l2.id = i2.pick_list_line_id
                  JOIN pick_lists p2 ON p2.id = l2.pick_list_id
                 WHERE n2.reason = 'sales_return' AND n2.status = 'issued' AND n2.deleted_at IS NULL
                   AND n2.id IS DISTINCT FROM $3 AND p2.sales_order_id = $1 AND l2.item_id = $2)::float AS released`,
        [g.so, g.item_id, excludeNoteId]);
      if (mine > r.returned - r.released + 1e-9) {
        throw new CreditNoteError(409, 'RELEASE_EXCEEDS_RETURNED',
          `A sales-return credit can release only units that came back: item ${g.item_id} of order ${g.so} — ${r.returned} returned, ${r.released} already released, ${mine} requested.`,
          { invoice_item_id: Number(g.item_ids[0]), creditable: Math.max(0, r.returned - r.released) });
      }
    }
  }
}
const sendCreditError = (res, e) => res.status(e.status).json({ success: false, error: e.message, code: e.code,
  ...(e.creditable != null ? { creditable: e.creditable, invoice_item_id: e.invoice_item_id } : {}) });

/* ── number generator ─────────────────────────────────────────────────────────
   One generator for every credit note (creditNoteNumber.service.js): per
   company and year, under a lock, inside the creating transaction. This file
   used COUNT(*)+1 across all companies, and fulfilment.routes.js a sequence of
   its own — the two collided. */

/* ══════════════════════════════════════════════════════════════════════════════
   LIST
   ══════════════════════════════════════════════════════════════════════════════ */
router.get('/', requirePermission('finance', 'view'), safe(async (req, res) => {
  const { status, party_id, from, to, limit = 50, offset = 0 } = req.query;
  const companyId = cid(req);
  const params = [];
  let idx = 1;
  let where = 'WHERE cn.deleted_at IS NULL';

  if (companyId) { where += ` AND cn.company_id = $${idx++}`; params.push(companyId); }
  if (status)    { where += ` AND cn.status = $${idx++}`;     params.push(status); }
  if (party_id)  { where += ` AND cn.party_id = $${idx++}`;   params.push(parseInt(party_id)); }
  if (from)      { where += ` AND cn.credit_note_date >= $${idx++}`; params.push(from); }
  if (to)        { where += ` AND cn.credit_note_date <= $${idx++}`; params.push(to); }

  params.push(parseInt(limit)); params.push(parseInt(offset));
  const { rows } = await pool.query(
    `SELECT cn.*,
            i.invoice_number AS original_invoice_number,
            (SELECT json_agg(ci) FROM credit_note_items ci WHERE ci.credit_note_id = cn.id) AS items
     FROM credit_notes cn
     LEFT JOIN invoices i ON i.id = cn.original_invoice_id
     ${where}
     ORDER BY cn.credit_note_date DESC, cn.id DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    params
  );
  const { rows: [{ total }] } = await pool.query(
    `SELECT COUNT(*) AS total FROM credit_notes cn ${where.replace(/LIMIT.*/,'')}`,
    params.slice(0, -2)
  );
  res.json({ success: true, data: rows, total: parseInt(total) });
}));

/* ══════════════════════════════════════════════════════════════════════════════
   GET SINGLE
   ══════════════════════════════════════════════════════════════════════════════ */
router.get('/:id', requirePermission('finance', 'view'), safe(async (req, res) => {
  const companyId = cid(req);
  const { rows } = await pool.query(
    `SELECT cn.*,
            i.invoice_number AS original_invoice_number,
            (SELECT json_agg(ci) FROM credit_note_items ci WHERE ci.credit_note_id = cn.id) AS items
     FROM credit_notes cn
     LEFT JOIN invoices i ON i.id = cn.original_invoice_id
     WHERE cn.id = $1 AND cn.deleted_at IS NULL
       ${companyId ? 'AND cn.company_id = $2' : ''}`,
    companyId ? [req.params.id, companyId] : [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Credit note not found' });
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════════
   CREATE
   ══════════════════════════════════════════════════════════════════════════════ */
router.post('/', requirePermission('finance', 'add'), safe(async (req, res) => {
  const {
    original_invoice_id,
    party_id, party_name, party_gstin,
    credit_note_date,
    reason,
    supply_type = 'B2B',
    taxable_value, cgst = 0, sgst = 0, igst = 0, cess = 0,
    total_amount,
    notes,
    items = [],
  } = req.body;

  if (!reason)         return res.status(400).json({ success: false, error: 'reason is required' });
  if (!taxable_value)  return res.status(400).json({ success: false, error: 'taxable_value is required' });

  // GST head consistency: intra-state → CGST+SGST (equal), inter-state → IGST only.
  const gstCheck = validateGstSplit({ cgst, sgst, igst });
  if (!gstCheck.valid) return res.status(422).json({ success: false, error: gstCheck.error });

  const companyId = cid(req);
  const userId = uid(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (original_invoice_id) {
      const { rows: [inv] } = await client.query(
        `SELECT id FROM invoices WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [original_invoice_id, companyId]);
      if (!inv) throw new CreditNoteError(404, 'ORIGINAL_INVOICE_NOT_FOUND', 'Original invoice not found.');
    }
    await assertCreditLines(client, { companyId, originalInvoiceId: original_invoice_id || null, items, reason });
    const credit_note_number = await nextCreditNoteNumber(client, companyId);

    const { rows: [cn] } = await client.query(
      `INSERT INTO credit_notes
         (credit_note_number, original_invoice_id, party_id, party_name, party_gstin,
          credit_note_date, reason, supply_type, taxable_value, cgst, sgst, igst, cess,
          total_amount, status, notes, created_by, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15,$16,$17)
       RETURNING *`,
      [
        credit_note_number,
        original_invoice_id || null,
        party_id || null, party_name || null, party_gstin || null,
        credit_note_date || new Date().toISOString().split('T')[0],
        reason, supply_type,
        parseFloat(taxable_value), parseFloat(cgst), parseFloat(sgst), parseFloat(igst), parseFloat(cess),
        parseFloat(total_amount || taxable_value),
        notes || null, userId, companyId,
      ]
    );

    const insertedItems = [];
    for (const item of items) {
      const { rows: [li] } = await client.query(
        `INSERT INTO credit_note_items
           (credit_note_id, original_item_id, description, hsn_code, quantity,
            unit_price, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, released_qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          cn.id,
          item.original_item_id || null,
          item.description || null,
          item.hsn_code || null,
          parseFloat(item.quantity || 1),
          parseFloat(item.unit_price || 0),
          parseFloat(item.taxable_value || 0),
          parseFloat(item.gst_rate || 0),
          parseFloat(item.cgst_amount || 0),
          parseFloat(item.sgst_amount || 0),
          parseFloat(item.igst_amount || 0),
          item.released_qty != null && String(item.released_qty).trim() !== '' ? Number(item.released_qty) : null,
        ]
      );
      insertedItems.push(li);
    }

    await client.query('COMMIT');

    logAudit({ userId, module: 'finance', recordId: cn.id, recordType: 'credit_note', action: 'create', newData: cn, req });
    res.status(201).json({ success: true, data: { ...cn, items: insertedItems } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof CreditNoteError) return sendCreditError(res, err);
    throw err;
  } finally {
    client.release();
  }
}));

/* ══════════════════════════════════════════════════════════════════════════════
   UPDATE (draft only)
   ══════════════════════════════════════════════════════════════════════════════ */
router.put('/:id', requirePermission('finance', 'edit'), captureBefore('credit_notes'), safe(async (req, res) => {
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM credit_notes WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
    [req.params.id, cid(req)]
  );
  if (!existing) return res.status(404).json({ success: false, error: 'Credit note not found' });
  if (existing.status !== 'draft') {
    return res.status(409).json({ success: false, error: 'Only draft credit notes can be edited' });
  }

  const {
    party_name, party_gstin, credit_note_date, reason, supply_type,
    taxable_value, cgst, sgst, igst, cess, total_amount, notes,
  } = req.body;
  if (reason && !RELEASE_REASONS.includes(reason)) {
    const { rows: [rel] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM credit_note_items WHERE credit_note_id = $1 AND released_qty IS NOT NULL`, [existing.id]);
    if (rel.n > 0) {
      return res.status(422).json({ success: false, code: 'RELEASE_NOT_ALLOWED_FOR_REASON',
        error: `This note releases invoiced quantity; a ${reason} note credits price only.` });
    }
  }

  const { rows: [updated] } = await pool.query(
    `UPDATE credit_notes SET
       party_name = COALESCE($1, party_name),
       party_gstin = COALESCE($2, party_gstin),
       credit_note_date = COALESCE($3, credit_note_date),
       reason = COALESCE($4, reason),
       supply_type = COALESCE($5, supply_type),
       taxable_value = COALESCE($6, taxable_value),
       cgst = COALESCE($7, cgst),
       sgst = COALESCE($8, sgst),
       igst = COALESCE($9, igst),
       cess = COALESCE($10, cess),
       total_amount = COALESCE($11, total_amount),
       notes = COALESCE($12, notes),
       updated_at = NOW()
     WHERE id = $13 RETURNING *`,
    [party_name, party_gstin, credit_note_date, reason, supply_type,
     taxable_value ? parseFloat(taxable_value) : null,
     cgst ? parseFloat(cgst) : null,
     sgst ? parseFloat(sgst) : null,
     igst ? parseFloat(igst) : null,
     cess ? parseFloat(cess) : null,
     total_amount ? parseFloat(total_amount) : null,
     notes, req.params.id]
  );
  logAudit({ userId: uid(req), module: 'finance', recordId: updated.id, recordType: 'credit_note', action: 'update', newData: updated, req });
  res.json({ success: true, data: updated });
}));

/* ══════════════════════════════════════════════════════════════════════════════
   ISSUE (draft → issued)
   Creates double-entry: DR Revenue (4001) + GST payables / CR Accounts Receivable (1010)
   ══════════════════════════════════════════════════════════════════════════════ */
router.post('/:id/issue', requirePermission('finance', 'approve'), safe(async (req, res) => {
  const companyId = cid(req);
  const userId = uid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Claimed under a row lock: a second, concurrent issue waits, then finds it
    // issued and is refused — one journal, one release, never two.
    const { rows: [existing] } = await client.query(
      `SELECT * FROM credit_notes WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
         FOR UPDATE`, [req.params.id, companyId]);
    if (!existing) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Credit note not found' }); }
    if (existing.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: `Cannot issue a credit note with status '${existing.status}'`, code: 'CREDIT_NOTE_NOT_DRAFT' });
    }
    const { rows: items } = await client.query(`SELECT * FROM credit_note_items WHERE credit_note_id = $1`, [existing.id]);
    try {
      await assertCreditLines(client, { companyId: existing.company_id, originalInvoiceId: existing.original_invoice_id,
                                        items, reason: existing.reason, excludeNoteId: existing.id });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof CreditNoteError) return sendCreditError(res, e);
      throw e;
    }

    const { rows: [updated] } = await client.query(
      `UPDATE credit_notes SET status = 'issued', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [existing.id]
    );

    // Journal entry: reverse revenue and GST for issued credit note
    // DR: 4001 (Sales Revenue) = taxable_value
    // DR: 2010 (CGST Payable) = cgst, DR: 2011 (SGST Payable) = sgst, DR: 2012 (IGST Payable) = igst
    // CR: 1010 (Accounts Receivable) = total_amount
    const taxableVal = parseFloat(existing.taxable_value) || 0;
    const cgst = parseFloat(existing.cgst) || 0;
    const sgst = parseFloat(existing.sgst) || 0;
    const igst = parseFloat(existing.igst) || 0;
    const totalAmt = parseFloat(existing.total_amount) || 0;

    let journalId = null;
    if (totalAmt > 0) {
      const { rows: accts } = await client.query(
        `SELECT id, code, name FROM chart_of_accounts WHERE code IN ('4001','2010','2011','2012','1010') AND is_active = true`
      );
      const am = accts.reduce((m, a) => { m[a.code] = a; return m; }, {});
      if (am['4001'] && am['1010']) {
        // The entry number came from MAX(id)+1 over journal_entries — whose id
        // is a UUID, so the query always failed and no credit note with an
        // amount could ever be issued. The shared journal numbering is used.
        const entryNumber = await journalRepo.getNextEntryNumber(client);
        const { rows: [je] } = await client.query(
          `INSERT INTO journal_entries (entry_number, entry_date, entry_type, description, reference_type, reference_id, status, total_debit, total_credit, company_id, created_by)
           VALUES ($1, $2, 'CreditNote', $3, 'credit_note', $4, 'posted', $5, $5, $6, $7) RETURNING id`,
          [entryNumber, existing.credit_note_date || new Date().toISOString().split('T')[0],
           `Credit note issued — ${existing.credit_note_number}`, existing.id, totalAmt, existing.company_id, userId]
        );
        const insertLine = (acctCode, debit, credit) => {
          const a = am[acctCode];
          if (!a || (debit === 0 && credit === 0)) return Promise.resolve();
          return client.query(
            `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, company_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [je.id, a.id, acctCode, a.name, debit, credit, `Credit note — ${existing.credit_note_number}`, existing.company_id]
          );
        };
        await insertLine('4001', taxableVal, 0);
        if (cgst > 0) await insertLine('2010', cgst, 0);
        if (sgst > 0) await insertLine('2011', sgst, 0);
        if (igst > 0) await insertLine('2012', igst, 0);
        await insertLine('1010', 0, totalAmt);
        // journal_entry_id is INTEGER and cannot hold the UUID; the posted
        // journal is recorded in posted_journal_entry_id (20261028000001).
        await client.query(`UPDATE credit_notes SET posted_journal_entry_id = $1 WHERE id = $2`, [je.id, existing.id]);
        journalId = je.id;
      }
    }

    await client.query('COMMIT');
    logAudit({ userId, module: 'finance', recordId: updated.id, recordType: 'credit_note', action: 'issue',
               newData: { ...updated, posted_journal_entry_id: journalId }, req, company_id: existing.company_id });
    res.json({ success: true, data: { ...updated, posted_journal_entry_id: journalId } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

/* ══════════════════════════════════════════════════════════════════════════════
   CANCEL
   A DRAFT note is cancelled as before: it is not a tax document yet, posted
   nothing and released nothing.

   An ISSUED note may be cancelled only while it is NOT filed in GSTR-1
   (decision, 2026-10-28: "cancel if not yet filed"); a filed note needs a
   GSTR-1 amendment and stays as it is (409 CREDIT_NOTE_FILED). Cancelling an
   issued note needs finance:approve and a reason, and — in one transaction,
   under the locks invoicing takes (orders, then pick lines, in id order):
     - its posted journal is reversed by a balanced mirror entry (each line's
       debit and credit swapped), linked by reversal_of_id, POSTED on the
       cancellation date through the same posting guards every journal passes
       (balanced, usable accounts, lock date, open period);
     - the quantity it released is taken back — refused (409
       CREDIT_RELEASE_CONSUMED) if that quantity has been invoiced again;
     - the note records who, when, why and the reversing journal.
   The database enforces the same rule (credit_notes_issue_guard,
   credit_notes_cancel_guard, migration 20261028000010).
   ══════════════════════════════════════════════════════════════════════════════ */
const needApprove = requirePermission('finance', 'approve');
const hasApprove = (req, res) => new Promise((resolveP) => {
  let decided = false;
  const fakeRes = { status: () => ({ json: () => { decided = true; resolveP(false); } }) };
  needApprove(req, fakeRes, () => { if (!decided) resolveP(true); });
});

router.post('/:id/cancel', requirePermission('finance', 'edit'), safe(async (req, res) => {
  const companyId = cid(req);
  const reason = String(req.body?.reason ?? '').trim();
  const client = await pool.connect();
  const refuse = async (status, code, error, extra = {}) => {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(status).json({ success: false, code, error, ...extra });
  };
  try {
    await client.query('BEGIN');
    const { rows: [existing] } = await client.query(
      `SELECT * FROM credit_notes WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
         FOR UPDATE`, [req.params.id, companyId]);
    if (!existing) return refuse(404, 'NOT_FOUND', 'Credit note not found');
    if (existing.status === 'cancelled') return refuse(409, 'ALREADY_CANCELLED', 'Already cancelled');

    if (existing.status !== 'issued') {
      const { rows: [updated] } = await client.query(
        `UPDATE credit_notes SET status = 'cancelled', notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $1 RETURNING *`,
        [existing.id, reason ? `CANCELLED: ${reason}` : null]);
      await client.query('COMMIT');
      logAudit({ userId: uid(req), module: 'finance', recordId: updated.id, recordType: 'credit_note', action: 'cancel',
                 newData: updated, req, company_id: existing.company_id });
      return res.json({ success: true, data: updated });
    }

    // ── An issued note ──
    if (!(await hasApprove(req, res))) return refuse(403, 'FORBIDDEN', 'Cancelling an issued credit note needs finance approval rights.');
    if (existing.gstr1_filed) {
      return refuse(409, 'CREDIT_NOTE_FILED',
        `${existing.credit_note_number} is filed in GSTR-1; it cannot be cancelled here — amend it in GSTR-1.`);
    }
    if (!reason) return refuse(400, 'REASON_REQUIRED', 'A reason is required to cancel an issued credit note.');

    // The orders, then the pick lines, its releases touch — the order invoicing locks them in.
    const { rows: touched } = await client.query(`
      SELECT DISTINCT l.id AS line_id, p.sales_order_id AS so
        FROM credit_note_items c
        JOIN invoice_items ii ON ii.id = c.original_item_id
        JOIN pick_list_lines l ON l.id = ii.pick_list_line_id
        JOIN pick_lists p ON p.id = l.pick_list_id
       WHERE c.credit_note_id = $1 AND c.released_qty IS NOT NULL`, [existing.id]);
    const sos = [...new Set(touched.map(t => t.so).filter(Boolean))].sort((a, b) => a - b);
    const lines = [...new Set(touched.map(t => t.line_id))].sort((a, b) => a - b);
    if (sos.length) await client.query(`SELECT id FROM sales_orders WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [sos]);
    if (lines.length) await client.query(`SELECT id FROM pick_list_lines WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [lines]);

    // The reversing journal, posted through the same guards as every journal.
    let reversalId = null;
    if (existing.posted_journal_entry_id) {
      const { rows: [je] } = await client.query(
        `SELECT * FROM journal_entries WHERE id = $1 AND company_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL FOR UPDATE`,
        [existing.posted_journal_entry_id, existing.company_id]);
      if (!je || je.status !== 'posted') {
        return refuse(409, 'JOURNAL_ORIGINAL_UNVERIFIED', `The journal ${existing.credit_note_number} was posted with is missing or not posted; nothing was changed.`);
      }
      const { rows: [prior] } = await client.query(
        `SELECT entry_number FROM journal_entries WHERE reversal_of_id = $1 AND deleted_at IS NULL LIMIT 1`, [je.id]);
      if (prior) return refuse(409, 'JOURNAL_ALREADY_REVERSED', `Its journal has already been reversed by ${prior.entry_number}.`);
      const { rows: origLines } = await client.query(`SELECT * FROM journal_lines WHERE entry_id = $1 ORDER BY id`, [je.id]);
      const mirror = origLines.map(l => ({ ...l, debit: Number(l.credit || 0), credit: Number(l.debit || 0) }));
      const today = new Date().toISOString().split('T')[0];
      try {
        assertBalanced(mirror);
        await assertAccountsUsable(client, mirror, existing.company_id);
        await assertNotLocked(client, existing.company_id, today);
        await assertPeriodOpen(client, existing.company_id, today);
      } catch (e) {
        return refuse(e.status === 400 ? 422 : (e.status || 409), e.code || 'POSTING_REFUSED', e.message);
      }
      const entryNumber = await journalRepo.getNextEntryNumber(client);
      const { rows: [rev] } = await client.query(
        `INSERT INTO journal_entries (entry_number, entry_date, entry_type, description, reference_type, reference_id,
                                      status, is_posted, posted_at, reversal_of_id, total_debit, total_credit, company_id, created_by)
         VALUES ($1, $2, 'CreditNoteCancellation', $3, 'credit_note', $4, 'posted', true, NOW(), $5, $6, $7, $8, $9) RETURNING id`,
        [entryNumber, today, `Cancellation of credit note ${existing.credit_note_number} — ${reason}`.slice(0, 500),
         existing.id, je.id, je.total_credit, je.total_debit, existing.company_id, uid(req)]);
      for (const l of mirror) {
        await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, cost_centre, project_id, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [rev.id, l.account_id, l.account_code, l.account_name, l.debit, l.credit,
           `Reversal: ${l.narration || ''}`.slice(0, 500), l.cost_centre, l.project_id, existing.company_id]);
      }
      reversalId = rev.id;
    }

    // The quantity it released, taken back — refused if already invoiced again
    // (the database's credit_notes_cancel_guard checks the same after the update).
    let updated;
    try {
      ({ rows: [updated] } = await client.query(
        `UPDATE credit_notes SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2, cancel_reason = $3,
                cancellation_journal_entry_id = $4, updated_at = NOW()
          WHERE id = $1 RETURNING *`, [existing.id, uid(req), reason, reversalId]));
    } catch (e) {
      if (e.code === '23514') {
        return refuse(409, /invoiced again|beyond what shipped/.test(e.message) ? 'CREDIT_RELEASE_CONSUMED' : 'CANCEL_REFUSED', e.message);
      }
      throw e;
    }
    await client.query('COMMIT');
    logAudit({ userId: uid(req), module: 'finance', recordId: updated.id, recordType: 'credit_note', action: 'cancel_issued',
               oldData: existing, newData: { ...updated, cancellation_journal_entry_id: reversalId }, req, company_id: existing.company_id });
    res.json({ success: true, data: updated, cancellation_journal_entry_id: reversalId,
               ...(existing.posted_journal_entry_id ? {} : { journal_note: 'the note was issued without a posted journal, so there was none to reverse' }) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

/* POST /:id/mark-gstr1-filed — record that an issued note has been reported in
   GSTR-1. One-way (the database refuses un-filing), issued notes only. After
   it, the note can no longer be cancelled here. finance:approve. */
router.post('/:id/mark-gstr1-filed', requirePermission('finance', 'approve'), safe(async (req, res) => {
  const { rows: [cn] } = await pool.query(
    `SELECT id, status, gstr1_filed, company_id FROM credit_notes WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
    [req.params.id, cid(req)]);
  if (!cn) return res.status(404).json({ success: false, error: 'Credit note not found' });
  if (cn.status !== 'issued') return res.status(409).json({ success: false, code: 'NOT_ISSUED', error: `Only an issued credit note can be filed; this one is ${cn.status}.` });
  if (cn.gstr1_filed) return res.status(409).json({ success: false, code: 'ALREADY_FILED', error: 'Already marked as filed in GSTR-1.' });
  const { rows: [updated] } = await pool.query(
    `UPDATE credit_notes SET gstr1_filed = true, gstr1_filed_at = NOW(), gstr1_filed_by = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'issued' AND NOT COALESCE(gstr1_filed, false) RETURNING *`, [cn.id, uid(req)]);
  if (!updated) return res.status(409).json({ success: false, code: 'ALREADY_FILED', error: 'Already marked as filed in GSTR-1.' });
  logAudit({ userId: uid(req), module: 'finance', recordId: cn.id, recordType: 'credit_note', action: 'gstr1_filed',
             newData: { gstr1_filed: true }, req, company_id: cn.company_id });
  res.json({ success: true, data: updated });
}));

/* ══════════════════════════════════════════════════════════════════════════════
   DELETE (soft)
   ══════════════════════════════════════════════════════════════════════════════ */
router.delete('/:id', requirePermission('finance', 'delete'), captureBefore('credit_notes'), safe(async (req, res) => {
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM credit_notes WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
    [req.params.id, cid(req)]
  );
  if (!existing) return res.status(404).json({ success: false, error: 'Credit note not found' });
  if (existing.status === 'issued') {
    return res.status(409).json({ success: false, error: 'Cannot delete an issued credit note — cancel it first' });
  }
  await pool.query(`UPDATE credit_notes SET deleted_at = NOW() WHERE id = $1`, [req.params.id]);
  logAudit({ userId: uid(req), module: 'finance', recordId: existing.id, recordType: 'credit_note', action: 'delete', req });
  res.json({ success: true, message: 'Credit note deleted' });
}));

/* ══════════════════════════════════════════════════════════════════════════════
   GSTR-1 SUMMARY (CDNR)
   ══════════════════════════════════════════════════════════════════════════════ */
router.get('/gst/cdnr-summary', requirePermission('finance', 'view'), safe(async (req, res) => {
  const { from, to } = req.query;
  const companyId = cid(req);
  const params = [from || new Date().toISOString().substr(0, 7) + '-01'];
  let where = `WHERE status = 'issued' AND deleted_at IS NULL AND credit_note_date >= $1`;
  let idx = 2;
  if (to) { where += ` AND credit_note_date <= $${idx++}`; params.push(to); }
  if (companyId) { where += ` AND company_id = $${idx++}`; params.push(companyId); }

  const { rows } = await pool.query(
    `SELECT party_gstin, party_name, supply_type,
            SUM(taxable_value) AS taxable_value,
            SUM(cgst) AS cgst, SUM(sgst) AS sgst, SUM(igst) AS igst,
            SUM(total_amount) AS total_amount,
            COUNT(*) AS note_count
     FROM credit_notes ${where}
     GROUP BY party_gstin, party_name, supply_type
     ORDER BY party_name`,
    params
  );
  res.json({ success: true, data: rows });
}));

export default router;
