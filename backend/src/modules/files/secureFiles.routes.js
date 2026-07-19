/**
 * secureFiles.routes.js
 *
 * Replaces the public express.static("/uploads") mount.
 * Every file download requires a valid JWT and ownership check:
 *   - super_admin / admin: any file
 *   - hr_manager / hr / payroll_admin: employee documents
 *   - employee: only files linked to their own employee record
 *
 * Access is audit-logged on every successful download.
 */

import { Router } from 'express';
import path        from 'path';
import fs          from 'fs';
import { fileURLToPath } from 'url';
import { verifyToken }   from '../../middlewares/auth.middleware.js';
import pool              from '../../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Resolved uploads root — two levels up from src/modules/files/ → backend/uploads/
const UPLOADS_ROOT = path.resolve(__dirname, '../../../../uploads');

const router = Router();

// All file requests require a valid token
router.use(verifyToken);

/**
 * GET /api/files/:filename
 *
 * Security checks (in order):
 * 1. Path traversal prevention — filename must not contain .. or /
 * 2. File must exist on disk
 * 3. Ownership check — the file must be linked to an employee record
 *    that belongs to the requester's company_id.
 *    For non-admin roles: file must belong to the requesting user's employee.
 * 4. Audit log on success.
 */
router.get('/:filename', async (req, res) => {
  const { filename } = req.params;

  // 1. Path traversal guard
  if (!filename || /[/\\]/.test(filename) || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const absPath = path.join(UPLOADS_ROOT, filename);

  // 2. File must exist
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const { userId, role } = req.user;
  const companyId = req.scope?.company_id ?? null;
  const isAdmin   = ['super_admin', 'admin'].includes((role || '').toLowerCase());
  const isHR      = ['hr_manager', 'hr_exec', 'hr', 'payroll_admin', 'finance_manager'].includes((role || '').toLowerCase());

  try {
    // 3. Ownership check via DB
    // Employee documents store file paths in employees table columns:
    // photo_url, pan_url, aadhaar_url, cancelled_cheque_url, bank_statement_url,
    // resume_url, offer_letter_url
    // We look for a row where any of these columns contains this filename.
    const { rows } = await pool.query(
      `SELECT e.id AS employee_id, e.company_id, u.id AS user_id
         FROM employees e
         LEFT JOIN users u ON u.email = e.email
        WHERE e.deleted_at IS NULL
          AND (
            e.photo_url             LIKE $1 OR
            e.pan_url               LIKE $1 OR
            e.aadhaar_url           LIKE $1 OR
            e.cancelled_cheque_url  LIKE $1 OR
            e.bank_statement_url    LIKE $1 OR
            e.resume_url            LIKE $1 OR
            e.offer_letter_url      LIKE $1
          )
        LIMIT 1`,
      [`%${filename}`]
    );

    if (rows.length > 0) {
      const rec = rows[0];

      // Company isolation — even admins cannot cross company boundaries
      if (companyId != null && rec.company_id !== companyId) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // Role-based access: admin/HR see all; employees only own files
      if (!isAdmin && !isHR) {
        if (String(rec.user_id) !== String(userId)) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
    } else {
      // File not linked to any employee record — admin-only access
      if (!isAdmin) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // 4. Audit log (fire-and-forget)
    pool.query(
      `INSERT INTO audit_logs (user_id, module_name, action_type, reference_type, new_data_json, ip_address)
       VALUES ($1, 'files', 'download', 'file', $2, $3)`,
      [userId, JSON.stringify({ filename }), req.ip || null]
    ).catch(() => {});

    // Stream the file with a safe Content-Disposition
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.sendFile(absPath);

  } catch (err) {
    console.error('[secureFiles]', err.message);
    res.status(500).json({ error: 'File access failed' });
  }
});

export default router;
