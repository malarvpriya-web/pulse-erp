/**
 * documentMaster.routes.js — Google Drive Document Architecture (Phase 30E)
 *
 * Files live in Google Drive; metadata + traceability in ERP DB.
 * Every download is audited. Signed documents cannot be deleted.
 * Revision history is preserved.
 *
 * Access control (LEGACY_MIS_TO_PULSE_AUDIT.md, P0 Task 2). Before this, no
 * route here checked a permission or a company, so any logged-in user could
 * list, download, approve or delete any company's documents.
 *  - Every route requires a `documents` permission (view / add / edit /
 *    approve / delete) from the role matrix via requirePermission.
 *  - Every query is limited to the caller's company (companyOf). Only a global
 *    super admin (verifyToken's isGlobal scope) sees across companies; a caller
 *    with no company and no global scope gets nothing.
 *  - Confidential documents (is_confidential, or access_level restricted /
 *    confidential) are visible only to their uploader and to document managers
 *    (documents:edit). Anything a caller cannot see answers 404, the same as a
 *    document that does not exist, so ids of other companies' documents leak
 *    nothing.
 *  - Nobody approves a document they uploaded; the approver is always the
 *    authenticated user, never a value from the request.
 */

import { Router } from 'express';
import multer from 'multer';
import pool from '../../shared/db.js';
import * as drive from '../../../services/googleDrive.service.js';
import { requirePermission, permissionFor } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB

const userId   = req => req.user?.userId ?? req.user?.id ?? null;
const userName = req => req.user?.name ?? req.user?.email ?? 'Unknown';

const safe = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── Tenant + confidentiality ─────────────────────────────────────────────── */

// The caller's company, or null for a global super admin (all companies).
// Callers with neither are stopped by requireTenant before any query runs.
const tenantOf = (req) => companyOf(req);
const isGlobal = (req) => companyOf(req) == null && req.scope?.isGlobal === true;

const requireTenant = (req, res, next) => {
  if (tenantOf(req) == null && !isGlobal(req)) {
    return res.status(403).json({ success: false, error: 'No company is assigned to this login.' });
  }
  next();
};

// Document managers (documents:edit) may see confidential documents of their
// company; everyone else only their own.
const canSeeConfidential = async (req) => Boolean((await permissionFor(req, 'documents'))?.can_edit);

/**
 * WHERE fragment limiting `alias` rows to what the caller may see, numbered
 * from $start. Returns { sql, params }.
 */
async function visibleTo(req, alias, start) {
  const c = `$${start}`, all = `$${start + 1}`, me = `$${start + 2}`;
  return {
    sql: `(${c}::int IS NULL OR ${alias}.company_id = ${c}::int)
      AND (${all}::boolean
           OR NOT (COALESCE(${alias}.is_confidential, false)
                   OR LOWER(COALESCE(${alias}.access_level, '')) IN ('restricted', 'confidential'))
           OR ${alias}.uploaded_by = ${me}::int)`,
    params: [tenantOf(req), await canSeeConfidential(req), userId(req)],
  };
}

/** The document if the caller may see it, else null (→ 404). */
async function findVisible(req, id, { withSigning = false } = {}) {
  const docId = parseInt(id, 10);
  if (!Number.isInteger(docId)) return null;
  const v = await visibleTo(req, 'dm', 2);
  const { rows } = await pool.query(
    withSigning
      ? `SELECT dm.*, ds.status AS signing_status, ds.signed_date, ds.typed_name, ds.is_locked
           FROM document_master dm
           LEFT JOIN document_signings ds ON ds.id = dm.signing_id
          WHERE dm.id = $1 AND dm.deleted_at IS NULL AND ${v.sql}`
      : `SELECT dm.* FROM document_master dm
          WHERE dm.id = $1 AND dm.deleted_at IS NULL AND ${v.sql}`,
    [docId, ...v.params]
  );
  return rows[0] || null;
}

const notFound = res => res.status(404).json({ success: false, error: 'Not found' });

// Leave applications attach their supporting document here (ApplyLeave.jsx),
// and the employees who file them hold documents:view, not documents:add.
// That one self-service upload needs only view, and is always stored
// confidential: a medical certificate is for its owner and document managers
// (who approve the leave), not every viewer of the company.
const isLeaveAttachment = body =>
  body?.module_type === 'leave' && body?.linked_entity_type === 'leave_application';

// Runs after multer (the fields live in the multipart body).
const requireUploadPermission = (req, res, next) =>
  requirePermission('documents', isLeaveAttachment(req.body) ? 'view' : 'add')(req, res, next);

router.use(requireTenant);

/* ══════════════════════════════════════════════════════════════════════════
   DRIVE STATUS
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/drive-status', requirePermission('documents', 'view'), safe(async (req, res) => {
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
router.get('/', requirePermission('documents', 'view'), safe(async (req, res) => {
  const { module_type, linked_entity_type, linked_entity_id, approval_status, limit = 100 } = req.query;
  const v = await visibleTo(req, 'dm', 1);
  let q = `SELECT dm.* FROM document_master dm WHERE dm.deleted_at IS NULL AND ${v.sql}`;
  const params = [...v.params];
  let i = params.length + 1;

  if (module_type)          { q += ` AND dm.module_type = $${i++}`;          params.push(module_type); }
  if (linked_entity_type)   { q += ` AND dm.linked_entity_type = $${i++}`;   params.push(linked_entity_type); }
  if (linked_entity_id)     { q += ` AND dm.linked_entity_id = $${i++}`;     params.push(parseInt(linked_entity_id)); }
  if (approval_status)      { q += ` AND dm.approval_status = $${i++}`;      params.push(approval_status); }

  q += ` ORDER BY dm.uploaded_at DESC LIMIT $${i}`;
  params.push(parseInt(limit) || 100);

  const { rows } = await pool.query(q, params);
  res.json({ success: true, data: rows });
}));

/* ══════════════════════════════════════════════════════════════════════════
   UPLOAD — multipart file → Drive → DB record
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/upload', upload.single('file'), requireUploadPermission, safe(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file provided' });

  const {
    module_type = 'default',
    linked_entity_type,
    linked_entity_id,
    revision_label,
    supersedes_id,
    access_level = 'internal',
    expiry_date,
  } = req.body;
  const is_confidential = isLeaveAttachment(req.body)
    || req.body.is_confidential === 'true' || req.body.is_confidential === true;

  // Always the caller's company. A company_id in the body used to win, which let
  // any user plant documents in another company; only a global super admin
  // (no company of their own) may still name one.
  const cid = isGlobal(req)
    ? (req.body.company_id != null && req.body.company_id !== '' ? parseInt(req.body.company_id, 10) : null)
    : tenantOf(req);

  // A new revision may only supersede a document of the same company.
  if (supersedes_id) {
    const { rows: sup } = await pool.query(
      `SELECT id FROM document_master
        WHERE id = $1 AND deleted_at IS NULL AND company_id IS NOT DISTINCT FROM $2::int`,
      [parseInt(supersedes_id, 10) || 0, cid]
    );
    if (!sup.length) {
      return res.status(400).json({ success: false, error: 'supersedes_id does not match a document of this company.' });
    }
  }

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

  // Get next revision number for this entity (within this company)
  let revision = 1;
  if (linked_entity_type && linked_entity_id) {
    const { rows: revRows } = await pool.query(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS next_rev
       FROM document_master
       WHERE linked_entity_type = $1 AND linked_entity_id = $2 AND deleted_at IS NULL
         AND company_id IS NOT DISTINCT FROM $3::int`,
      [linked_entity_type, parseInt(linked_entity_id), cid]
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
        uploaded_by, uploaded_by_name, company_id, expiry_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft','unsigned',$15,$16,$17,$18,$19,$20)
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
      is_confidential,
      access_level,
      userId(req),
      userName(req),
      cid,
      expiry_date || null,
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
router.get('/:id', requirePermission('documents', 'view'), safe(async (req, res) => {
  const doc = await findVisible(req, req.params.id, { withSigning: true });
  if (!doc) return notFound(res);
  delete doc.is_locked; // joined only for DELETE; keep the GET shape as before
  res.json({ success: true, data: doc });
}));

/* ══════════════════════════════════════════════════════════════════════════
   DOWNLOAD — audit log every download
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/:id/download', requirePermission('documents', 'view'), safe(async (req, res) => {
  const doc = await findVisible(req, req.params.id);
  if (!doc) return notFound(res);

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
router.post('/:id/approve', requirePermission('documents', 'approve'), safe(async (req, res) => {
  const doc = await findVisible(req, req.params.id);
  if (!doc) return notFound(res);
  const me = userId(req);
  if (me == null || Number(doc.uploaded_by) === Number(me)) {
    return res.status(403).json({ success: false, error: 'You cannot approve a document you uploaded.', code: 'SELF_APPROVAL' });
  }
  const { rows } = await pool.query(
    `UPDATE document_master
     SET approval_status='approved', approved_by=$2, approved_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND deleted_at IS NULL AND company_id IS NOT DISTINCT FROM $3::int RETURNING *`,
    [doc.id, me, doc.company_id]
  );
  if (!rows[0]) return notFound(res);
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   REJECT document
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/reject', requirePermission('documents', 'approve'), safe(async (req, res) => {
  const doc = await findVisible(req, req.params.id);
  if (!doc) return notFound(res);
  const { rows } = await pool.query(
    `UPDATE document_master
     SET approval_status='rejected', updated_at=NOW()
     WHERE id=$1 AND deleted_at IS NULL AND company_id IS NOT DISTINCT FROM $2::int RETURNING *`,
    [doc.id, doc.company_id]
  );
  if (!rows[0]) return notFound(res);
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   SET/UPDATE EXPIRY — powers documentExpiry.cron.js (§25.1); most rows
   never set this, only genuinely time-bound documents (certs, licenses,
   contracts stored as plain document_master rows).
   ══════════════════════════════════════════════════════════════════════════ */
router.patch('/:id/expiry', requirePermission('documents', 'edit'), safe(async (req, res) => {
  const doc = await findVisible(req, req.params.id);
  if (!doc) return notFound(res);
  const { expiry_date } = req.body;
  const { rows } = await pool.query(
    `UPDATE document_master SET expiry_date=$2, updated_at=NOW()
     WHERE id=$1 AND deleted_at IS NULL AND company_id IS NOT DISTINCT FROM $3::int RETURNING *`,
    [doc.id, expiry_date || null, doc.company_id]
  );
  if (!rows[0]) return notFound(res);
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   LINK to signature request
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/link-signature', requirePermission('documents', 'edit'), safe(async (req, res) => {
  const { signing_id } = req.body;
  if (!signing_id) return res.status(400).json({ success: false, error: 'signing_id required' });

  const doc = await findVisible(req, req.params.id);
  if (!doc) return notFound(res);

  // The signature request must belong to the same company as the document.
  const { rows: sig } = await pool.query(
    `SELECT id FROM document_signings WHERE id = $1 AND company_id IS NOT DISTINCT FROM $2::int`,
    [parseInt(signing_id, 10) || 0, doc.company_id]
  );
  if (!sig.length) return res.status(400).json({ success: false, error: 'signing_id does not match a signature request of this company.' });

  const { rows } = await pool.query(
    `UPDATE document_master SET signing_id=$2, signed_status='pending', updated_at=NOW()
     WHERE id=$1 AND deleted_at IS NULL AND company_id IS NOT DISTINCT FROM $3::int RETURNING *`,
    [doc.id, sig[0].id, doc.company_id]
  );
  if (!rows[0]) return notFound(res);
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   REVISION HISTORY for an entity
   GET /document-master/entity/:type/:id/revisions
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/entity/:type/:id/revisions', requirePermission('documents', 'view'), safe(async (req, res) => {
  const v = await visibleTo(req, 'dm', 3);
  const { rows } = await pool.query(
    `SELECT dm.* FROM document_master dm
     WHERE dm.linked_entity_type=$1 AND dm.linked_entity_id=$2 AND dm.deleted_at IS NULL
       AND ${v.sql}
     ORDER BY dm.revision DESC`,
    [req.params.type, parseInt(req.params.id), ...v.params]
  );
  res.json({ success: true, data: rows });
}));

/* ══════════════════════════════════════════════════════════════════════════
   SOFT DELETE — blocked for signed/locked documents
   ══════════════════════════════════════════════════════════════════════════ */
router.delete('/:id', requirePermission('documents', 'delete'), safe(async (req, res) => {
  const doc = await findVisible(req, req.params.id, { withSigning: true });
  if (!doc) return notFound(res);
  if (doc.is_locked) {
    return res.status(409).json({ success: false, error: 'Cannot delete a signed and locked document — immutable for audit trail.' });
  }
  if (doc.approval_status === 'approved') {
    return res.status(409).json({ success: false, error: 'Cannot delete an approved document. Reject first if needed.' });
  }

  await pool.query(
    `UPDATE document_master SET deleted_at=NOW()
      WHERE id=$1 AND company_id IS NOT DISTINCT FROM $2::int`,
    [doc.id, doc.company_id]
  );

  // Optionally purge from Drive
  if (doc.drive_file_id && drive.isDriveConfigured() && req.query.purge_drive === 'true') {
    try { await drive.deleteFile(doc.drive_file_id); } catch (_) {}
  }

  res.json({ success: true });
}));

export default router;
