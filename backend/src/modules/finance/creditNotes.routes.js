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

const router = Router();
const uid = req => req.user?.userId ?? req.user?.id ?? null;
const cid = req => req.scope?.company_id ?? req.body?.company_id ?? null;

const safe = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── number generator ───────────────────────────────────────────────────────── */
async function nextCreditNoteNumber() {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM credit_notes WHERE credit_note_number LIKE $1`,
    [`CN-${year}-%`]
  );
  const seq = String(parseInt(rows[0].n) + 1).padStart(4, '0');
  return `CN-${year}-${seq}`;
}

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

  const credit_note_number = await nextCreditNoteNumber();
  const companyId = cid(req);
  const userId = uid(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
            unit_price, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
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
        ]
      );
      insertedItems.push(li);
    }

    await client.query('COMMIT');

    logAudit({ userId, module: 'finance', recordId: cn.id, recordType: 'credit_note', action: 'create', newData: cn, req });
    res.status(201).json({ success: true, data: { ...cn, items: insertedItems } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/* ══════════════════════════════════════════════════════════════════════════════
   UPDATE (draft only)
   ══════════════════════════════════════════════════════════════════════════════ */
router.put('/:id', requirePermission('finance', 'edit'), safe(async (req, res) => {
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM credit_notes WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
  );
  if (!existing) return res.status(404).json({ success: false, error: 'Credit note not found' });
  if (existing.status !== 'draft') {
    return res.status(409).json({ success: false, error: 'Only draft credit notes can be edited' });
  }

  const {
    party_name, party_gstin, credit_note_date, reason, supply_type,
    taxable_value, cgst, sgst, igst, cess, total_amount, notes,
  } = req.body;

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
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM credit_notes WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
  );
  if (!existing) return res.status(404).json({ success: false, error: 'Credit note not found' });
  if (existing.status !== 'draft') {
    return res.status(409).json({ success: false, error: `Cannot issue a credit note with status '${existing.status}'` });
  }

  const companyId = cid(req);
  const userId = uid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [updated] } = await client.query(
      `UPDATE credit_notes SET status = 'issued', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
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

    if (totalAmt > 0) {
      const { rows: accts } = await client.query(
        `SELECT id, code, name FROM chart_of_accounts WHERE code IN ('4001','2010','2011','2012','1010') AND is_active = true`
      );
      const am = accts.reduce((m, a) => { m[a.code] = a; return m; }, {});
      if (am['4001'] && am['1010']) {
        const { rows: [{ n }] } = await client.query(`SELECT COALESCE(MAX(id),0)+1 AS n FROM journal_entries`);
        const entryNumber = `JE-${new Date().getFullYear()}-${String(n).padStart(5,'0')}`;
        const { rows: [je] } = await client.query(
          `INSERT INTO journal_entries (entry_number, entry_date, entry_type, description, reference_type, reference_id, status, total_debit, total_credit, company_id, created_by)
           VALUES ($1, $2, 'CreditNote', $3, 'credit_note', $4, 'posted', $5, $5, $6, $7) RETURNING id`,
          [entryNumber, existing.credit_note_date || new Date().toISOString().split('T')[0],
           `Credit note issued — ${existing.credit_note_number}`, existing.id, totalAmt, companyId, userId]
        );
        const insertLine = (acctCode, debit, credit) => {
          const a = am[acctCode];
          if (!a || (debit === 0 && credit === 0)) return Promise.resolve();
          return client.query(
            `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, company_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [je.id, a.id, acctCode, a.name, debit, credit, `Credit note — ${existing.credit_note_number}`, companyId]
          );
        };
        await insertLine('4001', taxableVal, 0);
        if (cgst > 0) await insertLine('2010', cgst, 0);
        if (sgst > 0) await insertLine('2011', sgst, 0);
        if (igst > 0) await insertLine('2012', igst, 0);
        await insertLine('1010', 0, totalAmt);
        await client.query(`UPDATE credit_notes SET journal_entry_id = $1 WHERE id = $2`, [je.id, existing.id]);
      }
    }

    await client.query('COMMIT');
    logAudit({ userId, module: 'finance', recordId: updated.id, recordType: 'credit_note', action: 'issue', newData: updated, req });
    res.json({ success: true, data: updated });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/* ══════════════════════════════════════════════════════════════════════════════
   CANCEL
   ══════════════════════════════════════════════════════════════════════════════ */
router.post('/:id/cancel', requirePermission('finance', 'edit'), safe(async (req, res) => {
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM credit_notes WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
  );
  if (!existing) return res.status(404).json({ success: false, error: 'Credit note not found' });
  if (existing.status === 'cancelled') {
    return res.status(409).json({ success: false, error: 'Already cancelled' });
  }

  const { reason } = req.body;
  const { rows: [updated] } = await pool.query(
    `UPDATE credit_notes SET status = 'cancelled', notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id, reason ? `CANCELLED: ${reason}` : null]
  );
  logAudit({ userId: uid(req), module: 'finance', recordId: updated.id, recordType: 'credit_note', action: 'cancel', newData: updated, req });
  res.json({ success: true, data: updated });
}));

/* ══════════════════════════════════════════════════════════════════════════════
   DELETE (soft)
   ══════════════════════════════════════════════════════════════════════════════ */
router.delete('/:id', requirePermission('finance', 'delete'), safe(async (req, res) => {
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM credit_notes WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
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
