/**
 * debitNotes.routes.js — Native Debit Note Engine
 *
 * Debit notes are issued to suppliers to record purchase returns or price disputes.
 * Used for: purchase returns, quality rejections, price revisions, short supply.
 * Required for ITC reversal and GST compliance on purchase-side corrections.
 *
 * Mounted at /api/v1/finance/debit-notes
 */

import { Router } from 'express';
import pool from './db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { validateGstSplit } from '../../utils/gst.js';

const router = Router();
const uid = req => req.user?.userId ?? req.user?.id ?? null;
const cid = req => req.scope?.company_id ?? req.body?.company_id ?? null;

const safe = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── number generator ───────────────────────────────────────────────────────── */
async function nextDebitNoteNumber() {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM debit_notes WHERE debit_note_number LIKE $1`,
    [`DN-${year}-%`]
  );
  const seq = String(parseInt(rows[0].n) + 1).padStart(4, '0');
  return `DN-${year}-${seq}`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   KPIs — totals for dashboard cards
   ══════════════════════════════════════════════════════════════════════════════ */
router.get('/kpis', requirePermission('finance', 'view'), safe(async (req, res) => {
  const companyId = cid(req);
  const where = companyId
    ? 'WHERE deleted_at IS NULL AND company_id = $1'
    : 'WHERE deleted_at IS NULL';
  const params = companyId ? [companyId] : [];

  const { rows: [kpi] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status != 'cancelled')                  AS total_count,
       COUNT(*) FILTER (WHERE status = 'draft')                       AS draft_count,
       COUNT(*) FILTER (WHERE status = 'issued')                      AS issued_count,
       COALESCE(SUM(total_amount) FILTER (WHERE status = 'issued'), 0) AS issued_amount,
       COALESCE(SUM(total_amount) FILTER (WHERE status != 'cancelled'), 0) AS total_value
     FROM debit_notes ${where}`,
    params
  );
  res.json({ success: true, data: kpi });
}));

/* ══════════════════════════════════════════════════════════════════════════════
   LIST
   ══════════════════════════════════════════════════════════════════════════════ */
router.get('/', requirePermission('finance', 'view'), safe(async (req, res) => {
  const { status, party_id, party_name, from, to, limit = 50, offset = 0 } = req.query;
  const companyId = cid(req);
  const params = [];
  let idx = 1;
  let where = 'WHERE dn.deleted_at IS NULL';

  if (companyId)   { where += ` AND dn.company_id = $${idx++}`;          params.push(companyId); }
  if (status)      { where += ` AND dn.status = $${idx++}`;              params.push(status); }
  if (party_id)    { where += ` AND dn.party_id = $${idx++}`;            params.push(parseInt(party_id)); }
  if (party_name)  { where += ` AND dn.party_name ILIKE $${idx++}`;      params.push(`%${party_name}%`); }
  if (from)        { where += ` AND dn.debit_note_date >= $${idx++}`;    params.push(from); }
  if (to)          { where += ` AND dn.debit_note_date <= $${idx++}`;    params.push(to); }

  params.push(parseInt(limit)); params.push(parseInt(offset));
  const { rows } = await pool.query(
    `SELECT dn.id, dn.debit_note_number, dn.debit_note_date,
            dn.party_name, dn.party_gstin,
            dn.reason, dn.taxable_value, dn.cgst, dn.sgst, dn.igst, dn.total_amount,
            dn.status, dn.notes, dn.journal_entry_id, dn.created_at,
            b.bill_number AS original_bill_number
     FROM debit_notes dn
     LEFT JOIN bills b ON b.id = dn.original_bill_id
     ${where}
     ORDER BY dn.debit_note_date DESC, dn.id DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    params
  );
  const { rows: [{ total }] } = await pool.query(
    `SELECT COUNT(*) AS total FROM debit_notes dn ${where}`,
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
    `SELECT dn.*,
            b.bill_number AS original_bill_number,
            (SELECT json_agg(di) FROM debit_note_items di WHERE di.debit_note_id = dn.id) AS items
     FROM debit_notes dn
     LEFT JOIN bills b ON b.id = dn.original_bill_id
     WHERE dn.id = $1 AND dn.deleted_at IS NULL
       ${companyId ? 'AND dn.company_id = $2' : ''}`,
    companyId ? [req.params.id, companyId] : [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Debit note not found' });
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════════
   CREATE
   ══════════════════════════════════════════════════════════════════════════════ */
router.post('/', requirePermission('finance', 'add'), safe(async (req, res) => {
  const {
    original_bill_id,
    party_id, party_name, party_gstin,
    debit_note_date,
    reason,
    taxable_value, cgst = 0, sgst = 0, igst = 0, cess = 0,
    total_amount,
    notes,
    items = [],
  } = req.body;

  if (!reason)        return res.status(400).json({ success: false, error: 'reason is required' });
  if (!taxable_value) return res.status(400).json({ success: false, error: 'taxable_value is required' });

  // GST head consistency: intra-state → CGST+SGST (equal), inter-state → IGST only.
  const gstCheck = validateGstSplit({ cgst, sgst, igst });
  if (!gstCheck.valid) return res.status(422).json({ success: false, error: gstCheck.error });

  const debit_note_number = await nextDebitNoteNumber();
  const companyId = cid(req);
  const userId = uid(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [dn] } = await client.query(
      `INSERT INTO debit_notes
         (debit_note_number, original_bill_id, party_id, party_name, party_gstin,
          debit_note_date, reason, taxable_value, cgst, sgst, igst, cess,
          total_amount, status, notes, created_by, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft',$14,$15,$16)
       RETURNING *`,
      [
        debit_note_number,
        original_bill_id || null,
        party_id || null, party_name || null, party_gstin || null,
        debit_note_date || new Date().toISOString().split('T')[0],
        reason,
        parseFloat(taxable_value), parseFloat(cgst), parseFloat(sgst), parseFloat(igst), parseFloat(cess),
        parseFloat(total_amount || taxable_value),
        notes || null, userId, companyId,
      ]
    );

    const insertedItems = [];
    for (const item of items) {
      const { rows: [li] } = await client.query(
        `INSERT INTO debit_note_items
           (debit_note_id, original_item_id, description, hsn_code, quantity,
            unit_price, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          dn.id,
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

    logAudit({ userId, module: 'finance', recordId: dn.id, recordType: 'debit_note', action: 'create', newData: dn, req });
    res.status(201).json({ success: true, data: { ...dn, items: insertedItems } });
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
    `SELECT * FROM debit_notes WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
  );
  if (!existing) return res.status(404).json({ success: false, error: 'Debit note not found' });
  if (existing.status !== 'draft') {
    return res.status(409).json({ success: false, error: 'Only draft debit notes can be edited' });
  }

  const {
    party_name, party_gstin, debit_note_date, reason,
    taxable_value, cgst, sgst, igst, cess, total_amount, notes,
  } = req.body;

  const { rows: [updated] } = await pool.query(
    `UPDATE debit_notes SET
       party_name = COALESCE($1, party_name),
       party_gstin = COALESCE($2, party_gstin),
       debit_note_date = COALESCE($3, debit_note_date),
       reason = COALESCE($4, reason),
       taxable_value = COALESCE($5, taxable_value),
       cgst = COALESCE($6, cgst),
       sgst = COALESCE($7, sgst),
       igst = COALESCE($8, igst),
       cess = COALESCE($9, cess),
       total_amount = COALESCE($10, total_amount),
       notes = COALESCE($11, notes),
       updated_at = NOW()
     WHERE id = $12 RETURNING *`,
    [
      party_name, party_gstin, debit_note_date, reason,
      taxable_value ? parseFloat(taxable_value) : null,
      cgst ? parseFloat(cgst) : null,
      sgst ? parseFloat(sgst) : null,
      igst ? parseFloat(igst) : null,
      cess ? parseFloat(cess) : null,
      total_amount ? parseFloat(total_amount) : null,
      notes, req.params.id,
    ]
  );
  logAudit({ userId: uid(req), module: 'finance', recordId: updated.id, recordType: 'debit_note', action: 'update', newData: updated, req });
  res.json({ success: true, data: updated });
}));

/* ══════════════════════════════════════════════════════════════════════════════
   ISSUE (draft → issued)
   Creates double-entry: DR Accounts Payable (2001) / CR Expense (5022) + GST inputs
   ══════════════════════════════════════════════════════════════════════════════ */
router.post('/:id/issue', requirePermission('finance', 'approve'), safe(async (req, res) => {
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM debit_notes WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
  );
  if (!existing) return res.status(404).json({ success: false, error: 'Debit note not found' });
  if (existing.status !== 'draft') {
    return res.status(409).json({ success: false, error: `Cannot issue a debit note with status '${existing.status}'` });
  }

  const companyId = cid(req);
  const userId = uid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [updated] } = await client.query(
      `UPDATE debit_notes SET status = 'issued', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    // Journal entry: reduce AP and reverse GST input credits
    // DR: 2001 (Accounts Payable) = total_amount
    // CR: 5022 (Expense) = taxable_value, CR: 1020 (CGST Input) = cgst, CR: 1021 (SGST Input) = sgst, CR: 1022 (IGST Input) = igst
    const taxableVal = parseFloat(existing.taxable_value) || 0;
    const cgst = parseFloat(existing.cgst) || 0;
    const sgst = parseFloat(existing.sgst) || 0;
    const igst = parseFloat(existing.igst) || 0;
    const totalAmt = parseFloat(existing.total_amount) || 0;

    if (totalAmt > 0) {
      const { rows: accts } = await client.query(
        `SELECT id, code, name FROM chart_of_accounts WHERE code IN ('2001','5022','1020','1021','1022') AND is_active = true`
      );
      const am = accts.reduce((m, a) => { m[a.code] = a; return m; }, {});
      if (am['2001'] && am['5022']) {
        const { rows: [{ n }] } = await client.query(`SELECT COALESCE(MAX(id),0)+1 AS n FROM journal_entries`);
        const entryNumber = `JE-${new Date().getFullYear()}-${String(n).padStart(5,'0')}`;
        const { rows: [je] } = await client.query(
          `INSERT INTO journal_entries (entry_number, entry_date, entry_type, description, reference_type, reference_id, status, total_debit, total_credit, company_id, created_by)
           VALUES ($1, $2, 'DebitNote', $3, 'debit_note', $4, 'posted', $5, $5, $6, $7) RETURNING id`,
          [entryNumber, existing.debit_note_date || new Date().toISOString().split('T')[0],
           `Debit note issued — ${existing.debit_note_number}`, existing.id, totalAmt, companyId, userId]
        );
        const insertLine = (acctCode, debit, credit) => {
          const a = am[acctCode];
          if (!a || (debit === 0 && credit === 0)) return Promise.resolve();
          return client.query(
            `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, company_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [je.id, a.id, acctCode, a.name, debit, credit, `Debit note — ${existing.debit_note_number}`, companyId]
          );
        };
        await insertLine('2001', totalAmt, 0);
        await insertLine('5022', 0, taxableVal);
        if (cgst > 0) await insertLine('1020', 0, cgst);
        if (sgst > 0) await insertLine('1021', 0, sgst);
        if (igst > 0) await insertLine('1022', 0, igst);
        await client.query(`UPDATE debit_notes SET journal_entry_id = $1 WHERE id = $2`, [je.id, existing.id]);
      }
    }

    await client.query('COMMIT');
    logAudit({ userId, module: 'finance', recordId: updated.id, recordType: 'debit_note', action: 'issue', newData: updated, req });
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
    `SELECT * FROM debit_notes WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
  );
  if (!existing) return res.status(404).json({ success: false, error: 'Debit note not found' });
  if (existing.status === 'cancelled') {
    return res.status(409).json({ success: false, error: 'Already cancelled' });
  }

  const { reason } = req.body;
  const { rows: [updated] } = await pool.query(
    `UPDATE debit_notes SET status = 'cancelled', notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id, reason ? `CANCELLED: ${reason}` : null]
  );
  logAudit({ userId: uid(req), module: 'finance', recordId: updated.id, recordType: 'debit_note', action: 'cancel', newData: updated, req });
  res.json({ success: true, data: updated });
}));

/* ══════════════════════════════════════════════════════════════════════════════
   DELETE (soft)
   ══════════════════════════════════════════════════════════════════════════════ */
router.delete('/:id', requirePermission('finance', 'delete'), safe(async (req, res) => {
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM debit_notes WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
  );
  if (!existing) return res.status(404).json({ success: false, error: 'Debit note not found' });
  if (existing.status === 'issued') {
    return res.status(409).json({ success: false, error: 'Cannot delete an issued debit note — cancel it first' });
  }
  await pool.query(`UPDATE debit_notes SET deleted_at = NOW() WHERE id = $1`, [req.params.id]);
  logAudit({ userId: uid(req), module: 'finance', recordId: existing.id, recordType: 'debit_note', action: 'delete', req });
  res.json({ success: true, message: 'Debit note deleted' });
}));

export default router;
