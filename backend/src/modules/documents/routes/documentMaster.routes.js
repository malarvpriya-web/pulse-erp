/**
 * documentMaster.routes.js — Google Drive Document Architecture (Phase 30E)
 *
 * Files live in Google Drive; metadata + traceability in ERP DB.
 * Every download is audited. Signed documents cannot be deleted.
 * Revision history is preserved.
 */

import { Router } from 'express';
import multer from 'multer';
import pool from '../../shared/db.js';
import * as drive from '../../../services/googleDrive.service.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB

const userId   = req => req.user?.userId ?? req.user?.id ?? null;
const userName = req => req.user?.name ?? req.user?.email ?? 'Unknown';

const safe = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ══════════════════════════════════════════════════════════════════════════
   DRIVE STATUS
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/drive-status', safe(async (req, res) => {
  const configured = drive.isDriveConfigured();
  if (!configured) {
    return res.json({ configured: false, message: 'Google Drive not configured. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_ROOT_FOLDER_ID.' });
  }
  const status = await drive.ping();
  res.json({ configured: true, ...status });
}));

/* ══════════════════════════════════════════════════════════════════════════
   LIST documents
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/', safe(async (req, res) => {
  const { module_type, linked_entity_type, linked_entity_id, approval_status, limit = 100 } = req.query;
  let q = `SELECT * FROM document_master WHERE deleted_at IS NULL`;
  const params = [];
  let i = 1;

  if (module_type)          { q += ` AND module_type = $${i++}`;          params.push(module_type); }
  if (linked_entity_type)   { q += ` AND linked_entity_type = $${i++}`;   params.push(linked_entity_type); }
  if (linked_entity_id)     { q += ` AND linked_entity_id = $${i++}`;     params.push(parseInt(linked_entity_id)); }
  if (approval_status)      { q += ` AND approval_status = $${i++}`;      params.push(approval_status); }

  q += ` ORDER BY uploaded_at DESC LIMIT $${i}`;
  params.push(parseInt(limit));

  const { rows } = await pool.query(q, params);
  res.json({ success: true, data: rows });
}));

/* ══════════════════════════════════════════════════════════════════════════
   UPLOAD — multipart file → Drive → DB record
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/upload', upload.single('file'), safe(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file provided' });

  const {
    module_type = 'default',
    linked_entity_type,
    linked_entity_id,
    revision_label,
    supersedes_id,
    is_confidential = false,
    access_level = 'internal',
    company_id,
  } = req.body;

  const cid = company_id ?? req.scope?.company_id ?? null;

  // Determine Drive entity label for folder organisation
  const entityLabel = linked_entity_type && linked_entity_id
    ? `${linked_entity_type}_${linked_entity_id}`
    : null;

  let driveResult = null;
  let driveError  = null;

  if (drive.isDriveConfigured()) {
    try {
      driveResult = await drive.uploadFile({
        buffer:       req.file.buffer,
        originalName: req.file.originalname,
        mimeType:     req.file.mimetype,
        moduleType:   module_type,
        entityLabel,
      });
    } catch (e) {
      driveError = e.message;
      console.error('[DocumentMaster/Drive]', e.message);
    }
  }

  // Get next revision number for this entity
  let revision = 1;
  if (linked_entity_type && linked_entity_id) {
    const { rows: revRows } = await pool.query(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS next_rev
       FROM document_master
       WHERE linked_entity_type = $1 AND linked_entity_id = $2 AND deleted_at IS NULL`,
      [linked_entity_type, parseInt(linked_entity_id)]
    );
    revision = revRows[0]?.next_rev ?? 1;
  }

  // Persist metadata
  const { rows } = await pool.query(
    `INSERT INTO document_master
       (file_name, original_file_name, mime_type, file_size_bytes,
        drive_file_id, drive_link, drive_folder_id,
        module_type, linked_entity_type, linked_entity_id,
        revision, revision_label, supersedes_id,
        checksum_sha256, approval_status, signed_status,
        is_confidential, access_level,
        uploaded_by, uploaded_by_name, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft','unsigned',$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      driveResult?.file_name    || req.file.originalname,
      req.file.originalname,
      req.file.mimetype,
      driveResult?.file_size_bytes ?? req.file.size,
      driveResult?.drive_file_id   ?? null,
      driveResult?.drive_link      ?? null,
      driveResult?.drive_folder_id ?? null,
      module_type,
      linked_entity_type || null,
      linked_entity_id ? parseInt(linked_entity_id) : null,
      revision,
      revision_label || `Rev ${String.fromCharCode(64 + revision)}`,
      supersedes_id ? parseInt(supersedes_id) : null,
      driveResult?.checksum_sha256 ?? null,
      is_confidential === 'true' || is_confidential === true,
      access_level,
      userId(req),
      userName(req),
      cid,
    ]
  );

  res.status(201).json({
    success: true,
    data: rows[0],
    drive_stored: !!driveResult,
    drive_error:  driveError,
  });
}));

/* ══════════════════════════════════════════════════════════════════════════
   GET SINGLE
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/:id', safe(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT dm.*,
       ds.status AS signing_status, ds.signed_date, ds.typed_name
     FROM document_master dm
     LEFT JOIN document_signings ds ON ds.id = dm.signing_id
     WHERE dm.id = $1 AND dm.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   DOWNLOAD — audit log every download
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/:id/download', safe(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM document_master WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Not found' });
  const doc = rows[0];

  // Log download
  await pool.query(
    `INSERT INTO document_download_log (document_id, downloaded_by, downloaded_by_name, downloader_ip)
     VALUES ($1,$2,$3,$4)`,
    [doc.id, userId(req), userName(req), req.ip || null]
  );

  if (doc.drive_file_id && drive.isDriveConfigured()) {
    // Stream from Drive
    try {
      const buffer = await drive.downloadFile(doc.drive_file_id);
      res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.original_file_name || doc.file_name)}"`);
      res.send(buffer);
      return;
    } catch (e) {
      return res.status(500).json({ success: false, error: `Drive download failed: ${e.message}` });
    }
  }

  // Fallback: redirect to drive link
  if (doc.drive_link) {
    return res.redirect(doc.drive_link);
  }

  res.status(404).json({ success: false, error: 'File not available for download — Drive not configured and no fallback URL.' });
}));

/* ══════════════════════════════════════════════════════════════════════════
   APPROVE document
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/approve', safe(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE document_master
     SET approval_status='approved', approved_by=$2, approved_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, userId(req)]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   REJECT document
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/reject', safe(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE document_master
     SET approval_status='rejected', updated_at=NOW()
     WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   LINK to signature request
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/link-signature', safe(async (req, res) => {
  const { signing_id } = req.body;
  if (!signing_id) return res.status(400).json({ success: false, error: 'signing_id required' });

  const { rows } = await pool.query(
    `UPDATE document_master SET signing_id=$2, signed_status='pending', updated_at=NOW()
     WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, parseInt(signing_id)]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   REVISION HISTORY for an entity
   GET /document-master/entity/:type/:id/revisions
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/entity/:type/:id/revisions', safe(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM document_master
     WHERE linked_entity_type=$1 AND linked_entity_id=$2 AND deleted_at IS NULL
     ORDER BY revision DESC`,
    [req.params.type, parseInt(req.params.id)]
  );
  res.json({ success: true, data: rows });
}));

/* ══════════════════════════════════════════════════════════════════════════
   SOFT DELETE — blocked for signed/locked documents
   ══════════════════════════════════════════════════════════════════════════ */
router.delete('/:id', safe(async (req, res) => {
  const { rows: existing } = await pool.query(
    `SELECT dm.*, ds.is_locked FROM document_master dm
     LEFT JOIN document_signings ds ON ds.id = dm.signing_id
     WHERE dm.id = $1`,
    [req.params.id]
  );
  if (!existing[0]) return res.status(404).json({ success: false, error: 'Not found' });
  if (existing[0].is_locked) {
    return res.status(409).json({ success: false, error: 'Cannot delete a signed and locked document — immutable for audit trail.' });
  }
  if (existing[0].approval_status === 'approved') {
    return res.status(409).json({ success: false, error: 'Cannot delete an approved document. Reject first if needed.' });
  }

  await pool.query(
    `UPDATE document_master SET deleted_at=NOW() WHERE id=$1`,
    [req.params.id]
  );

  // Optionally purge from Drive
  if (existing[0].drive_file_id && drive.isDriveConfigured() && req.query.purge_drive === 'true') {
    try { await drive.deleteFile(existing[0].drive_file_id); } catch (_) {}
  }

  res.json({ success: true });
}));

export default router;
