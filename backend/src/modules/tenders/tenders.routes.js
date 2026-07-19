/**
 * tenders.routes.js — Government Tender workspace (Manifest OS gap).
 *
 * A dedicated view over the tender-flavoured `opportunities` (those with a
 * tender_number / bid_type / EMD), plus EMD-lifecycle and a document checklist
 * (tender_documents). Gated on the `crm` permission module — a tender IS an
 * opportunity, so tender access must match opportunity access (and 'crm' has a
 * real permission matrix, so this enforces rather than failing open). Scoped via
 * companyOf() — the only correct tenant read for CRM data.
 */

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { pickUpdatable } from '../../shared/safeUpdate.js';

const router = Router();
const crm = (a) => requirePermission('crm', a);

// A row is a "tender" when it carries any tender marker.
const TENDER_PRED = `(o.tender_number IS NOT NULL OR o.bid_type IS NOT NULL OR o.emd_amount IS NOT NULL)`;

// ── GET /tenders ──────────────────────────────────────────────────────────────
router.get('/', crm('view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { stage, source, search } = req.query;
    const params = [];
    let q = `
      SELECT o.id, o.opportunity_number, o.opportunity_name, o.tender_number, o.tender_source,
             o.bid_type, o.stage, o.expected_value, o.submission_deadline,
             o.emd_amount, o.emd_status, o.emd_refund_date, o.loa_received,
             l.company_name,
             CASE WHEN o.submission_deadline IS NOT NULL AND o.submission_deadline < CURRENT_DATE
                    AND LOWER(o.stage) NOT IN ('won','lost') THEN true ELSE false END AS is_overdue,
             CASE WHEN o.submission_deadline IS NOT NULL AND o.submission_deadline >= CURRENT_DATE
                    AND o.submission_deadline < CURRENT_DATE + INTERVAL '14 days' THEN true ELSE false END AS due_soon,
             (SELECT COUNT(*)::int FROM tender_documents d WHERE d.opportunity_id = o.id) AS docs_total,
             (SELECT COUNT(*)::int FROM tender_documents d WHERE d.opportunity_id = o.id AND d.status = 'submitted') AS docs_submitted
        FROM opportunities o
        LEFT JOIN leads l ON l.id = o.lead_id
       WHERE o.deleted_at IS NULL AND ${TENDER_PRED}`;
    if (cid != null) { params.push(cid); q += ` AND o.company_id = $${params.length}`; }
    if (stage)  { params.push(stage);  q += ` AND o.stage = $${params.length}`; }
    if (source) { params.push(source); q += ` AND o.tender_source = $${params.length}`; }
    if (search) { params.push(`%${search}%`); q += ` AND (o.opportunity_name ILIKE $${params.length} OR o.tender_number ILIKE $${params.length})`; }
    q += ` ORDER BY o.submission_deadline ASC NULLS LAST, o.id DESC`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /tenders/summary ──────────────────────────────────────────────────────
router.get('/summary', crm('view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const params = [];
    let scope = `o.deleted_at IS NULL AND ${TENDER_PRED}`;
    if (cid != null) { params.push(cid); scope += ` AND o.company_id = $${params.length}`; }
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE LOWER(o.stage) NOT IN ('won','lost'))::int AS active,
        COUNT(*) FILTER (WHERE LOWER(o.stage) = 'won')::int  AS won,
        COUNT(*) FILTER (WHERE LOWER(o.stage) = 'lost')::int AS lost,
        COUNT(*) FILTER (WHERE o.submission_deadline >= CURRENT_DATE
                           AND o.submission_deadline < CURRENT_DATE + INTERVAL '14 days'
                           AND LOWER(o.stage) NOT IN ('won','lost'))::int AS due_soon,
        COUNT(*) FILTER (WHERE o.loa_received = true)::int AS loa_received,
        COALESCE(SUM(o.emd_amount) FILTER (
            WHERE o.emd_refund_date IS NULL
              AND COALESCE(LOWER(o.emd_status),'') NOT IN ('refunded','returned','forfeited')
          ), 0)::float AS emd_blocked
      FROM opportunities o WHERE ${scope}`, params);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /tenders/:id ──────────────────────────────────────────────────────────
router.get('/:id', crm('view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const params = [req.params.id];
    let q = `SELECT o.*, l.company_name FROM opportunities o LEFT JOIN leads l ON l.id = o.lead_id
             WHERE o.id = $1 AND o.deleted_at IS NULL`;
    if (cid != null) { params.push(cid); q += ` AND o.company_id = $2`; }
    const { rows } = await pool.query(q, params);
    if (!rows.length) return res.status(404).json({ error: 'tender not found' });
    const docs = (await pool.query(`SELECT * FROM tender_documents WHERE opportunity_id = $1 ORDER BY COALESCE(due_date,'9999-12-31'), id`, [req.params.id])).rows;
    res.json({ ...rows[0], documents: docs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /tenders ─────────────────────────────────────────────────────────────
const TENDER_FIELDS = ['tender_number', 'tender_source', 'bid_type', 'submission_deadline',
  'emd_amount', 'emd_status', 'emd_mode', 'emd_expiry_date', 'emd_refund_date',
  'loa_received', 'loa_date', 'loa_amount', 'product_category', 'expected_value',
  'expected_closing_date', 'region', 'notes', 'lead_id', 'assigned_to'];

router.post('/', crm('add'), async (req, res) => {
  try {
    const cid = companyOf(req) ?? 1;
    const { opportunity_name, stage = 'Bidding' } = req.body || {};
    if (!opportunity_name) return res.status(400).json({ error: 'opportunity_name (tender title) is required' });
    const nn = (v) => (v === '' || v === undefined ? null : v);

    const cols = ['opportunity_name', 'stage', 'company_id', 'created_by'];
    const vals = [opportunity_name, stage, cid, req.user?.userId ?? null];
    for (const f of TENDER_FIELDS) if (req.body[f] !== undefined) { cols.push(f); vals.push(nn(req.body[f])); }
    // opportunity_number is a GENERATED column ('IPM-' || lpad(id,6,'0')) — never set it.
    const ph = vals.map((_, i) => `$${i + 1}`);
    const { rows } = await pool.query(
      `INSERT INTO opportunities (${cols.join(', ')}) VALUES (${ph.join(', ')}) RETURNING *`,
      vals);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /tenders/:id ──────────────────────────────────────────────────────────
router.put('/:id', crm('edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const safe = await pickUpdatable('opportunities', req.body, { protect: ['opportunity_number', 'lead_id'] });
    const keys = Object.keys(safe);
    if (!keys.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    for (const k of ['submission_deadline', 'emd_expiry_date', 'emd_refund_date', 'loa_date', 'expected_closing_date']) {
      if (k in safe && safe[k] === '') safe[k] = null;
    }
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map((k) => safe[k]);
    vals.push(req.params.id);
    let q = `UPDATE opportunities SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} AND deleted_at IS NULL`;
    if (cid != null) { vals.push(cid); q += ` AND company_id = $${vals.length}`; }
    q += ` RETURNING *`;
    const { rows } = await pool.query(q, vals);
    if (!rows.length) return res.status(404).json({ error: 'tender not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Documents ─────────────────────────────────────────────────────────────────
router.get('/:id/documents', crm('view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM tender_documents WHERE opportunity_id = $1 ORDER BY id`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/documents', crm('add'), async (req, res) => {
  try {
    const cid = companyOf(req) ?? 1;
    const { doc_name, doc_type = 'other', status = 'pending', due_date = null, file_url = null, notes = null } = req.body || {};
    if (!doc_name) return res.status(400).json({ error: 'doc_name is required' });
    const { rows } = await pool.query(
      `INSERT INTO tender_documents (company_id, opportunity_id, doc_name, doc_type, status, due_date, file_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cid, req.params.id, doc_name, doc_type, status, due_date || null, file_url, notes]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/documents/:docId', crm('edit'), async (req, res) => {
  try {
    const safe = await pickUpdatable('tender_documents', req.body, { protect: ['opportunity_id'] });
    const keys = Object.keys(safe);
    if (!keys.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    if ('due_date' in safe && safe.due_date === '') safe.due_date = null;
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map((k) => safe[k]);
    vals.push(req.params.docId);
    const { rows } = await pool.query(
      `UPDATE tender_documents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'document not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/documents/:docId', crm('delete'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM tender_documents WHERE id = $1`, [req.params.docId]);
    if (!rowCount) return res.status(404).json({ error: 'document not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
