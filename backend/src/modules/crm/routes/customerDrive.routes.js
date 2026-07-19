// backend/src/modules/crm/routes/customerDrive.routes.js
// Google Drive integration endpoints for Customer 360
import express from 'express';
import multer from 'multer';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import * as ctrl from '../customerDrive.controller.js';

const router   = express.Router();
const upload   = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Drive health ──────────────────────────────────────────────────────────────
// GET /api/crm/customer-drive/status
router.get('/customer-drive/status', requirePermission('crm', 'view'), ctrl.getDriveStatus);

// ── Folder provisioning ───────────────────────────────────────────────────────
// POST /api/crm/customer-drive/provision/:customerId
// Creates 14 standard subfolders in Drive for this customer (idempotent).
router.post('/customer-drive/provision/:customerId', requirePermission('crm', 'add'), ctrl.provisionCustomerFolders);

// ── Folder listing ────────────────────────────────────────────────────────────
// GET /api/crm/customer-drive/:customerId/folders
// Returns cached folder links (no Drive API call needed).
router.get('/customer-drive/:customerId/folders', requirePermission('crm', 'view'), ctrl.getCustomerFolders);

// ── File listing ──────────────────────────────────────────────────────────────
// GET /api/crm/customer-drive/:customerId/files?doc_type=07+FAT+Reports&limit=50
router.get('/customer-drive/:customerId/files', requirePermission('crm', 'view'), ctrl.getCustomerFiles);

// ── File upload ───────────────────────────────────────────────────────────────
// POST /api/crm/customer-drive/:customerId/upload
// multipart/form-data: file + doc_type + (optional) entity_type + entity_id
router.post(
  '/customer-drive/:customerId/upload',
  requirePermission('crm', 'add'),
  upload.single('file'),
  ctrl.uploadCustomerFile
);

// ── Auto document routing (called by other ERP modules) ──────────────────────
// POST /api/crm/customer-drive/auto-route
// Body: { customer_id, doc_type, file_name, file_buffer_b64, mime_type, entity_type, entity_id }
router.post('/customer-drive/auto-route', requirePermission('crm', 'add'), ctrl.autoRouteDocument);

export default router;
