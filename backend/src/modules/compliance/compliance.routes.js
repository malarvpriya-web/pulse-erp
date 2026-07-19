/**
 * compliance.routes.js — organisational compliance standards register + audit
 * calendar (Manifest OS gap). Gated on the `compliance` permission module and
 * company-scoped via req.scope.company_id.
 *
 *   GET/POST/PUT/DELETE /compliance/standards[/:id]
 *   GET  /compliance/standards/:id/evidence · POST · DELETE /compliance/evidence/:id
 *   GET/POST/PUT /compliance/audits[/:id]
 *   GET  /compliance/summary   — KPIs for the dashboard header
 */

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { pickUpdatable } from '../../shared/safeUpdate.js';

const router = Router();
const cid = (req) => req.scope?.company_id ?? null;
const perm = (a) => requirePermission('compliance', a);

const STATUS   = new Set(['not_started', 'in_progress', 'certified', 'expired', 'lapsed']);
const CATEGORY = new Set(['management_system', 'product', 'regulatory']);
const AUDIT_TYPE = new Set(['internal', 'external', 'surveillance', 'recertification']);

// ── STANDARDS ───────────────────────────────────────────────────────────────
router.get('/standards', perm('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, category, search } = req.query;
    const params = [];
    let q = `
      SELECT s.*,
             (s.expiry_date IS NOT NULL AND s.expiry_date < CURRENT_DATE)                              AS is_expired,
             (s.expiry_date IS NOT NULL AND s.expiry_date >= CURRENT_DATE
                AND s.expiry_date < CURRENT_DATE + INTERVAL '90 days')                                 AS expiring_soon,
             (SELECT COUNT(*)::int FROM compliance_evidence e WHERE e.standard_id = s.id)              AS evidence_count,
             (SELECT MIN(a.scheduled_date) FROM compliance_audits a
                WHERE a.standard_id = s.id AND a.status = 'scheduled' AND a.scheduled_date >= CURRENT_DATE) AS next_audit_date
        FROM compliance_standards s
       WHERE s.deleted_at IS NULL`;
    if (companyId != null) { params.push(companyId); q += ` AND s.company_id = $${params.length}`; }
    if (status)   { params.push(status);   q += ` AND s.status = $${params.length}`; }
    if (category) { params.push(category); q += ` AND s.category = $${params.length}`; }
    if (search)   { params.push(`%${search}%`); q += ` AND (s.code ILIKE $${params.length} OR s.title ILIKE $${params.length})`; }
    q += ` ORDER BY s.category, s.code`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/standards/:id', perm('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const params = [req.params.id];
    let q = `SELECT * FROM compliance_standards WHERE id = $1 AND deleted_at IS NULL`;
    if (companyId != null) { params.push(companyId); q += ` AND company_id = $2`; }
    const { rows } = await pool.query(q, params);
    if (!rows.length) return res.status(404).json({ error: 'standard not found' });
    const [{ rows: evidence }, { rows: audits }] = await Promise.all([
      pool.query(`SELECT * FROM compliance_evidence WHERE standard_id = $1 ORDER BY created_at DESC`, [req.params.id]),
      pool.query(`SELECT * FROM compliance_audits WHERE standard_id = $1 ORDER BY COALESCE(scheduled_date, completed_date) DESC`, [req.params.id]),
    ]);
    res.json({ ...rows[0], evidence, audits });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/standards', perm('add'), async (req, res) => {
  try {
    const companyId = cid(req) ?? 1;
    const { code, title, category = 'management_system', scope = null, certifying_body = null,
            certificate_number = null, status = 'not_started', issue_date = null, expiry_date = null, owner_name = null, notes = null } = req.body || {};
    if (!code || !title) return res.status(400).json({ error: 'code and title are required' });
    if (!STATUS.has(status))     return res.status(400).json({ error: `invalid status: ${status}` });
    if (!CATEGORY.has(category)) return res.status(400).json({ error: `invalid category: ${category}` });
    const { rows } = await pool.query(
      `INSERT INTO compliance_standards
         (company_id, code, title, category, scope, certifying_body, certificate_number, status, issue_date, expiry_date, owner_name, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [companyId, code, title, category, scope, certifying_body, certificate_number, status,
       issue_date || null, expiry_date || null, owner_name, notes, req.user?.userId ?? null]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'a standard with this code already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/standards/:id', perm('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    if (req.body.status && !STATUS.has(req.body.status)) return res.status(400).json({ error: `invalid status: ${req.body.status}` });
    if (req.body.category && !CATEGORY.has(req.body.category)) return res.status(400).json({ error: `invalid category: ${req.body.category}` });
    const safe = await pickUpdatable('compliance_standards', req.body, { protect: ['code'] });
    const keys = Object.keys(safe);
    if (!keys.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    for (const k of ['issue_date', 'expiry_date']) if (k in safe && safe[k] === '') safe[k] = null;
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map((k) => safe[k]);
    vals.push(req.params.id);
    let q = `UPDATE compliance_standards SET ${sets.join(', ')}, updated_at = NOW()
             WHERE id = $${vals.length} AND deleted_at IS NULL`;
    if (companyId != null) { vals.push(companyId); q += ` AND company_id = $${vals.length}`; }
    q += ` RETURNING *`;
    const { rows } = await pool.query(q, vals);
    if (!rows.length) return res.status(404).json({ error: 'standard not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/standards/:id', perm('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const vals = [req.params.id];
    let q = `UPDATE compliance_standards SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`;
    if (companyId != null) { vals.push(companyId); q += ` AND company_id = $2`; }
    const { rowCount } = await pool.query(q, vals);
    if (!rowCount) return res.status(404).json({ error: 'standard not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EVIDENCE ────────────────────────────────────────────────────────────────
router.get('/standards/:id/evidence', perm('view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM compliance_evidence WHERE standard_id = $1 ORDER BY created_at DESC`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/standards/:id/evidence', perm('add'), async (req, res) => {
  try {
    const companyId = cid(req) ?? 1;
    const { title, doc_url = null } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title is required' });
    const { rows } = await pool.query(
      `INSERT INTO compliance_evidence (standard_id, company_id, title, doc_url, uploaded_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, companyId, title, doc_url, req.user?.userId ?? null]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/evidence/:id', perm('delete'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM compliance_evidence WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'evidence not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUDIT CALENDAR ──────────────────────────────────────────────────────────
router.get('/audits', perm('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, upcoming } = req.query;
    const params = [];
    let q = `
      SELECT a.*, s.code AS standard_code, s.title AS standard_title,
             (a.status = 'scheduled' AND a.scheduled_date < CURRENT_DATE) AS is_overdue
        FROM compliance_audits a
        LEFT JOIN compliance_standards s ON s.id = a.standard_id
       WHERE 1 = 1`;
    if (companyId != null) { params.push(companyId); q += ` AND a.company_id = $${params.length}`; }
    if (status)   { params.push(status); q += ` AND a.status = $${params.length}`; }
    if (upcoming) { q += ` AND a.status = 'scheduled' AND a.scheduled_date >= CURRENT_DATE`; }
    q += ` ORDER BY COALESCE(a.scheduled_date, a.completed_date) DESC NULLS LAST LIMIT 300`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/audits', perm('add'), async (req, res) => {
  try {
    const companyId = cid(req) ?? 1;
    const { standard_id = null, audit_type = 'internal', title = null, scheduled_date = null,
            auditor = null, next_due_date = null, notes = null } = req.body || {};
    if (!AUDIT_TYPE.has(audit_type)) return res.status(400).json({ error: `invalid audit_type: ${audit_type}` });
    const { rows } = await pool.query(
      `INSERT INTO compliance_audits (company_id, standard_id, audit_type, title, scheduled_date, auditor, next_due_date, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled') RETURNING *`,
      [companyId, standard_id || null, audit_type, title, scheduled_date || null, auditor, next_due_date || null, notes]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/audits/:id', perm('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    if (req.body.audit_type && !AUDIT_TYPE.has(req.body.audit_type)) return res.status(400).json({ error: `invalid audit_type: ${req.body.audit_type}` });
    const safe = await pickUpdatable('compliance_audits', req.body);
    const keys = Object.keys(safe);
    if (!keys.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    for (const k of ['scheduled_date', 'completed_date', 'next_due_date']) if (k in safe && safe[k] === '') safe[k] = null;
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map((k) => safe[k]);
    vals.push(req.params.id);
    let q = `UPDATE compliance_audits SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`;
    if (companyId != null) { vals.push(companyId); q += ` AND company_id = $${vals.length}`; }
    q += ` RETURNING *`;
    const { rows } = await pool.query(q, vals);
    if (!rows.length) return res.status(404).json({ error: 'audit not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SUMMARY (dashboard KPIs) ──────────────────────────────────────────────────
router.get('/summary', perm('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const p = companyId != null ? [companyId] : [null];
    const scope = `($1::int IS NULL OR company_id = $1)`;
    const [std, aud] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int                                                                          AS total,
          COUNT(*) FILTER (WHERE status = 'certified')::int                                      AS certified,
          COUNT(*) FILTER (WHERE status IN ('in_progress','not_started'))::int                   AS in_progress,
          COUNT(*) FILTER (WHERE status = 'expired' OR (expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE))::int AS expired,
          COUNT(*) FILTER (WHERE expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE
                             AND expiry_date < CURRENT_DATE + INTERVAL '90 days')::int           AS expiring_soon
        FROM compliance_standards WHERE deleted_at IS NULL AND ${scope}`, p),
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_date < CURRENT_DATE)::int AS overdue_audits,
               COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_date >= CURRENT_DATE
                                  AND scheduled_date < CURRENT_DATE + INTERVAL '30 days')::int     AS audits_due_30d
        FROM compliance_audits WHERE ${scope}`, p),
    ]);
    res.json({ ...std.rows[0], ...aud.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
