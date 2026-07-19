/**
 * rd.routes.js — R&D / PLM module (Manifest OS gap).
 *
 * Three surfaces the engineering module lacked:
 *   /rd/artifacts  — versioned PCB/firmware/software/… repository
 *   /rd/patents    — patent / IP tracker
 *   /rd/lifecycle  — product-lifecycle (PLM) spine over product_lines
 *
 * Mounted /rd + verifyToken, gated on the `rd` permission module (fails open),
 * company-scoped via req.scope.company_id.
 */

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { pickUpdatable } from '../../shared/safeUpdate.js';

const router = Router();
const cid = (req) => req.scope?.company_id ?? null;
const perm = (a) => requirePermission('rd', a);

const ARTIFACT_TYPES = new Set(['pcb', 'firmware', 'software', 'schematic', 'mechanical', 'document']);
const ARTIFACT_STATUS = new Set(['draft', 'in_review', 'released', 'superseded', 'obsolete']);
const IP_TYPES = new Set(['patent', 'trademark', 'design', 'copyright']);
const PATENT_STATUS = new Set(['idea', 'drafting', 'filed', 'published', 'granted', 'rejected', 'lapsed', 'abandoned']);
const STAGES = ['concept', 'design', 'prototype', 'validation', 'production', 'maintenance', 'eol'];

// ── ARTIFACT REPOSITORY ───────────────────────────────────────────────────────
// Latest version per family (company, product_line, type, name).
router.get('/artifacts', perm('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { artifact_type, product_line_id, status, search } = req.query;
    const params = [];
    let q = `
      SELECT DISTINCT ON (a.company_id, COALESCE(a.product_line_id,0), a.artifact_type, a.name)
             a.*, pl.display_name AS product_line,
             (SELECT COUNT(*)::int FROM rd_artifacts v
               WHERE v.company_id = a.company_id AND COALESCE(v.product_line_id,0) = COALESCE(a.product_line_id,0)
                 AND v.artifact_type = a.artifact_type AND v.name = a.name AND v.deleted_at IS NULL) AS version_count
        FROM rd_artifacts a
        LEFT JOIN product_lines pl ON pl.id = a.product_line_id
       WHERE a.deleted_at IS NULL`;
    if (companyId != null)   { params.push(companyId);       q += ` AND a.company_id = $${params.length}`; }
    if (artifact_type)       { params.push(artifact_type);   q += ` AND a.artifact_type = $${params.length}`; }
    if (product_line_id)     { params.push(product_line_id); q += ` AND a.product_line_id = $${params.length}`; }
    if (status)              { params.push(status);          q += ` AND a.status = $${params.length}`; }
    if (search)              { params.push(`%${search}%`);   q += ` AND (a.name ILIKE $${params.length} OR a.description ILIKE $${params.length})`; }
    q += ` ORDER BY a.company_id, COALESCE(a.product_line_id,0), a.artifact_type, a.name,
                    (a.status='released') DESC, a.created_at DESC`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All versions of the family that :id belongs to.
router.get('/artifacts/:id/versions', perm('view'), async (req, res) => {
  try {
    const base = (await pool.query(`SELECT * FROM rd_artifacts WHERE id = $1`, [req.params.id])).rows[0];
    if (!base) return res.status(404).json({ error: 'artifact not found' });
    const { rows } = await pool.query(
      `SELECT * FROM rd_artifacts
        WHERE company_id = $1 AND COALESCE(product_line_id,0) = COALESCE($2,0)
          AND artifact_type = $3 AND name = $4 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [base.company_id, base.product_line_id, base.artifact_type, base.name]);
    res.json({ family: { name: base.name, artifact_type: base.artifact_type, product_line_id: base.product_line_id }, versions: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/artifacts', perm('add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = cid(req) ?? 1;
    const { product_line_id = null, artifact_type = 'document', name, version, status = 'draft',
            file_url = null, checksum = null, description = null } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!ARTIFACT_TYPES.has(artifact_type)) return res.status(400).json({ error: `invalid artifact_type: ${artifact_type}` });
    if (!ARTIFACT_STATUS.has(status)) return res.status(400).json({ error: `invalid status: ${status}` });

    await client.query('BEGIN');
    // Auto-version when not supplied: v{existing+1}.
    let ver = version;
    if (!ver) {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int n FROM rd_artifacts
          WHERE company_id=$1 AND COALESCE(product_line_id,0)=COALESCE($2,0) AND artifact_type=$3 AND name=$4 AND deleted_at IS NULL`,
        [companyId, product_line_id, artifact_type, name]);
      ver = `v${rows[0].n + 1}`;
    }
    // Releasing a new version supersedes the family's prior released one.
    if (status === 'released') {
      await client.query(
        `UPDATE rd_artifacts SET status='superseded', updated_at=NOW()
          WHERE company_id=$1 AND COALESCE(product_line_id,0)=COALESCE($2,0) AND artifact_type=$3 AND name=$4
            AND status='released' AND deleted_at IS NULL`,
        [companyId, product_line_id, artifact_type, name]);
    }
    const { rows } = await client.query(
      `INSERT INTO rd_artifacts (company_id, product_line_id, artifact_type, name, version, status, file_url, checksum, description, released_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [companyId, product_line_id || null, artifact_type, name, ver, status, file_url, checksum, description,
       status === 'released' ? new Date() : null, req.user?.userId ?? null]);
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'that version already exists for this artifact' });
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.put('/artifacts/:id', perm('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    if (req.body.status && !ARTIFACT_STATUS.has(req.body.status)) return res.status(400).json({ error: `invalid status: ${req.body.status}` });
    // Promote to released → supersede siblings + stamp released_at.
    if (req.body.status === 'released') {
      const base = (await pool.query(`SELECT * FROM rd_artifacts WHERE id=$1`, [req.params.id])).rows[0];
      if (base) {
        await pool.query(
          `UPDATE rd_artifacts SET status='superseded', updated_at=NOW()
            WHERE company_id=$1 AND COALESCE(product_line_id,0)=COALESCE($2,0) AND artifact_type=$3 AND name=$4
              AND status='released' AND id<>$5 AND deleted_at IS NULL`,
          [base.company_id, base.product_line_id, base.artifact_type, base.name, base.id]);
        req.body.released_at = new Date();
      }
    }
    const safe = await pickUpdatable('rd_artifacts', req.body, { allow: ['released_at'] });
    const keys = Object.keys(safe);
    if (!keys.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map((k) => safe[k]);
    vals.push(req.params.id);
    let q = `UPDATE rd_artifacts SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} AND deleted_at IS NULL`;
    if (companyId != null) { vals.push(companyId); q += ` AND company_id=$${vals.length}`; }
    q += ` RETURNING *`;
    const { rows } = await pool.query(q, vals);
    if (!rows.length) return res.status(404).json({ error: 'artifact not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/artifacts/:id', perm('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const vals = [req.params.id];
    let q = `UPDATE rd_artifacts SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL`;
    if (companyId != null) { vals.push(companyId); q += ` AND company_id=$2`; }
    const { rowCount } = await pool.query(q, vals);
    if (!rowCount) return res.status(404).json({ error: 'artifact not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATENTS ───────────────────────────────────────────────────────────────────
router.get('/patents', perm('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, ip_type, search } = req.query;
    const params = [];
    let q = `SELECT p.*, pl.display_name AS product_line FROM rd_patents p
             LEFT JOIN product_lines pl ON pl.id = p.product_line_id WHERE p.deleted_at IS NULL`;
    if (companyId != null) { params.push(companyId); q += ` AND p.company_id = $${params.length}`; }
    if (status)  { params.push(status);  q += ` AND p.status = $${params.length}`; }
    if (ip_type) { params.push(ip_type); q += ` AND p.ip_type = $${params.length}`; }
    if (search)  { params.push(`%${search}%`); q += ` AND (p.title ILIKE $${params.length} OR p.application_no ILIKE $${params.length})`; }
    q += ` ORDER BY p.filing_date DESC NULLS LAST, p.created_at DESC`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/patents', perm('add'), async (req, res) => {
  try {
    const companyId = cid(req) ?? 1;
    const { title, ip_type = 'patent', application_no = null, jurisdiction = null, status = 'idea',
            filing_date = null, grant_date = null, expiry_date = null, inventors = null, product_line_id = null, notes = null } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!IP_TYPES.has(ip_type)) return res.status(400).json({ error: `invalid ip_type: ${ip_type}` });
    if (!PATENT_STATUS.has(status)) return res.status(400).json({ error: `invalid status: ${status}` });
    const { rows } = await pool.query(
      `INSERT INTO rd_patents (company_id, title, ip_type, application_no, jurisdiction, status, filing_date, grant_date, expiry_date, inventors, product_line_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [companyId, title, ip_type, application_no, jurisdiction, status, filing_date || null, grant_date || null, expiry_date || null, inventors, product_line_id || null, notes, req.user?.userId ?? null]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/patents/:id', perm('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    if (req.body.status && !PATENT_STATUS.has(req.body.status)) return res.status(400).json({ error: `invalid status: ${req.body.status}` });
    const safe = await pickUpdatable('rd_patents', req.body);
    const keys = Object.keys(safe);
    if (!keys.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    for (const k of ['filing_date', 'grant_date', 'expiry_date']) if (k in safe && safe[k] === '') safe[k] = null;
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map((k) => safe[k]);
    vals.push(req.params.id);
    let q = `UPDATE rd_patents SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} AND deleted_at IS NULL`;
    if (companyId != null) { vals.push(companyId); q += ` AND company_id=$${vals.length}`; }
    q += ` RETURNING *`;
    const { rows } = await pool.query(q, vals);
    if (!rows.length) return res.status(404).json({ error: 'patent not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/patents/:id', perm('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const vals = [req.params.id];
    let q = `UPDATE rd_patents SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL`;
    if (companyId != null) { vals.push(companyId); q += ` AND company_id=$2`; }
    const { rowCount } = await pool.query(q, vals);
    if (!rowCount) return res.status(404).json({ error: 'patent not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PRODUCT LIFECYCLE (PLM) ───────────────────────────────────────────────────
// Every product line, with its lifecycle stage if tracked (LEFT JOIN — honest
// about which products aren't in PLM yet rather than asserting a stage).
router.get('/lifecycle', perm('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const params = [];
    let q = `
      SELECT pl.id AS product_line_id, pl.display_name AS product_line, pl.voltage_class,
             lc.id AS lifecycle_id, lc.current_stage, lc.stage_entered_at, lc.owner_name,
             (SELECT COUNT(*)::int FROM rd_artifacts a WHERE a.product_line_id = pl.id AND a.deleted_at IS NULL) AS artifact_count,
             (SELECT COUNT(*)::int FROM rd_patents p WHERE p.product_line_id = pl.id AND p.deleted_at IS NULL) AS patent_count
        FROM product_lines pl
        LEFT JOIN product_lifecycle lc ON lc.product_line_id = pl.id
       WHERE pl.deleted_at IS NULL`;
    if (companyId != null) { params.push(companyId); q += ` AND pl.company_id = $${params.length}`; }
    q += ` ORDER BY pl.display_name`;
    const { rows } = await pool.query(q, params);
    res.json({ stages: STAGES, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/lifecycle/:productLineId', perm('view'), async (req, res) => {
  try {
    const lc = (await pool.query(`SELECT * FROM product_lifecycle WHERE product_line_id = $1`, [req.params.productLineId])).rows[0];
    if (!lc) return res.json({ tracked: false, events: [] });
    const events = (await pool.query(`SELECT * FROM product_lifecycle_events WHERE product_lifecycle_id = $1 ORDER BY created_at DESC`, [lc.id])).rows;
    res.json({ tracked: true, ...lc, events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upsert the stage for a product line and log the transition.
router.post('/lifecycle/:productLineId/set-stage', perm('edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = cid(req) ?? 1;
    const { to_stage, note = null, owner_name } = req.body || {};
    if (!STAGES.includes(to_stage)) return res.status(400).json({ error: `invalid stage: ${to_stage}` });
    await client.query('BEGIN');
    const existing = (await client.query(`SELECT * FROM product_lifecycle WHERE product_line_id = $1`, [req.params.productLineId])).rows[0];
    let lc, fromStage = null;
    if (existing) {
      fromStage = existing.current_stage;
      lc = (await client.query(
        `UPDATE product_lifecycle SET current_stage=$2, stage_entered_at=NOW(), owner_name=COALESCE($3,owner_name), updated_at=NOW()
          WHERE id=$1 RETURNING *`, [existing.id, to_stage, owner_name ?? null])).rows[0];
    } else {
      lc = (await client.query(
        `INSERT INTO product_lifecycle (company_id, product_line_id, current_stage, owner_name) VALUES ($1,$2,$3,$4) RETURNING *`,
        [companyId, req.params.productLineId, to_stage, owner_name ?? null])).rows[0];
    }
    await client.query(
      `INSERT INTO product_lifecycle_events (product_lifecycle_id, from_stage, to_stage, changed_by, changed_by_name, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [lc.id, fromStage, to_stage, req.user?.userId ?? null, req.user?.name ?? null, note]);
    await client.query('COMMIT');
    res.json(lc);
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ── SUMMARY ───────────────────────────────────────────────────────────────────
router.get('/summary', perm('view'), async (req, res) => {
  try {
    const p = [cid(req)];
    const scope = `($1::int IS NULL OR company_id = $1)`;
    const [art, pat, plm] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='released')::int released,
                         (SELECT COUNT(*)::int FROM (
                            SELECT DISTINCT COALESCE(product_line_id,0), artifact_type, name
                              FROM rd_artifacts WHERE deleted_at IS NULL AND ${scope}) fam) AS families
                    FROM rd_artifacts WHERE deleted_at IS NULL AND ${scope}`, p),
      pool.query(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='granted')::int granted,
                         COUNT(*) FILTER (WHERE status IN ('filed','published','drafting'))::int pending
                    FROM rd_patents WHERE deleted_at IS NULL AND ${scope}`, p),
      pool.query(`SELECT COUNT(*) FILTER (WHERE current_stage='production')::int in_production,
                         COUNT(*)::int tracked FROM product_lifecycle WHERE ${scope}`, p),
    ]);
    res.json({ artifacts: art.rows[0], patents: pat.rows[0], lifecycle: plm.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
