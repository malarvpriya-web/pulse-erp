/**
 * googleDrive.service.js — Google Drive integration for document storage
 *
 * Folder hierarchy (customer-first):
 *   DRIVE_ROOT/
 *     Customers/
 *       [Customer Name]/
 *         Opportunities/
 *         Technical Proposals/
 *         Commercial Proposals/
 *         Quotations/
 *         Purchase Orders/
 *         Contracts/
 *         Drawings/
 *         BOM/
 *         FAT Reports/
 *         SAT Reports/
 *         Commissioning Reports/
 *         Service Reports/
 *         AMC Documents/
 *         Invoices/
 *         Delivery Notes/
 *
 * Internal docs use:
 *   DRIVE_ROOT / [Module] /
 *
 * Setup:
 *   1. Create a Google Cloud project & enable Drive API
 *   2. Create a Service Account → download JSON key
 *   3. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON or GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH
 *   4. Set GOOGLE_DRIVE_ROOT_FOLDER_ID (shared Drive folder ID)
 *   5. Share that folder with the service account email (editor)
 */

import { Readable } from 'stream';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import pool from '../config/db.js';

/* ── Lazy-load googleapis ─────────────────────────────────────────────── */
let _drive = null;

async function getDriveClient() {
  if (_drive) return _drive;

  let google;
  try {
    const mod = await import('googleapis');
    google = mod.google;
  } catch (_) {
    throw new Error(
      'googleapis package not installed. Run: npm install googleapis\n' +
      'Google Drive integration will not work without this package.'
    );
  }

  let credentials;
  if (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH) {
    const raw = fs.readFileSync(
      path.resolve(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH), 'utf8'
    );
    credentials = JSON.parse(raw);
  } else {
    throw new Error(
      'Google Drive not configured. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON or ' +
      'GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH environment variable.'
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

export function isDriveConfigured() {
  return !!(
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH
  );
}

/* ── In-memory folder cache (avoids repeated Drive API list calls) ───── */
const _folderCache = new Map();

async function _findOrCreateFolder(name, parentId) {
  const cacheKey = `${parentId}/${name}`;
  if (_folderCache.has(cacheKey)) return _folderCache.get(cacheKey);

  const drive   = await getDriveClient();
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = [
    `name = '${escaped}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `'${parentId}' in parents`,
    `trashed = false`,
  ].join(' and ');

  const list = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  if (list.data.files?.length) {
    const folderId = list.data.files[0].id;
    _folderCache.set(cacheKey, folderId);
    return folderId;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  _folderCache.set(cacheKey, created.data.id);
  return created.data.id;
}

/* ── Exported ensureFolder (legacy / module-based upload paths) ──────── */
export async function ensureFolder(name, parentId = null) {
  const parent = parentId || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!parent) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID not set');
  return _findOrCreateFolder(name, parent);
}

/* ── Document type constants ─────────────────────────────────────────────
 *  Use these across the codebase for consistent folder names.
 */
export const DOC_TYPES = {
  OPPORTUNITY:          'Opportunities',
  TECHNICAL_PROPOSAL:   'Technical Proposals',
  COMMERCIAL_PROPOSAL:  'Commercial Proposals',
  QUOTATION:            'Quotations',
  PURCHASE_ORDER:       'Purchase Orders',
  CONTRACT:             'Contracts',
  DRAWING:              'Drawings',
  BOM:                  'BOM',
  FAT_REPORT:           'FAT Reports',
  SAT_REPORT:           'SAT Reports',
  COMMISSIONING_REPORT: 'Commissioning Reports',
  SERVICE_REPORT:       'Service Reports',
  AMC_DOCUMENT:         'AMC Documents',
  DELIVERY_NOTE:        'Delivery Notes',
  INVOICE:              'Invoices',
};

/* ── Customer folder helper ──────────────────────────────────────────────
 *  Returns Drive folder ID for:
 *    DRIVE_ROOT / Customers / [customerName] / [docType]
 *
 *  DB cache table `customer_drive_folders` avoids repeated Drive API calls.
 */
export async function ensureCustomerDocFolder(customerName, docType, companyId = null) {
  if (!customerName) throw new Error('customerName required');
  if (!docType)      throw new Error('docType required');

  // Check DB cache first
  try {
    const { rows } = await pool.query(
      `SELECT drive_folder_id FROM customer_drive_folders
       WHERE ($1::int IS NULL OR company_id=$1) AND customer_name=$2 AND doc_type=$3`,
      [companyId ?? null, customerName, docType]
    );
    if (rows[0]?.drive_folder_id) {
      _folderCache.set(`${companyId}/${customerName}/${docType}`, rows[0].drive_folder_id);
      return rows[0].drive_folder_id;
    }
  } catch (_) { /* table may not exist in older installs */ }

  const rootId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID not set');

  // Build path: root → Customers → customerName → docType
  const customersFolder = await _findOrCreateFolder('Customers', rootId);
  const customerFolder  = await _findOrCreateFolder(customerName, customersFolder);
  const docTypeFolder   = await _findOrCreateFolder(docType, customerFolder);

  // Persist to DB cache (upsert)
  try {
    await pool.query(
      `INSERT INTO customer_drive_folders (company_id, customer_name, doc_type, drive_folder_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (company_id, customer_name, doc_type)
       DO UPDATE SET drive_folder_id = EXCLUDED.drive_folder_id`,
      [companyId ?? null, customerName, docType, docTypeFolder]
    );
  } catch (_) { /* safe skip if table not yet migrated */ }

  return docTypeFolder;
}

/* ── Module-based internal folder (non-customer docs) ────────────────── */
const MODULE_FOLDER_MAP = {
  engineering:  'Engineering',
  quality:      'Quality',
  hr:           'Human Resources',
  finance:      'Finance',
  operations:   'Operations',
  project:      'Projects',
  procurement:  'Procurement',
  sales:        'Sales & CRM',
  maintenance:  'Maintenance',
  default:      'General',
};

export async function getModuleFolder(moduleType) {
  const folderName = MODULE_FOLDER_MAP[moduleType] || MODULE_FOLDER_MAP.default;
  const rootId     = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID not set');
  return _findOrCreateFolder(folderName, rootId);
}

/* ── Upload a file buffer to Drive ──────────────────────────────────────
 *
 *  Priority:
 *    customerName + docType  →  Customers/[Name]/[DocType]/filename
 *    moduleType + entityLabel →  [Module]/[entityLabel]/filename  (legacy)
 */
export async function uploadFile({
  buffer,
  originalName,
  mimeType,
  customerName  = null,
  docType       = null,
  moduleType    = 'default',
  entityLabel   = null,
  companyId     = null,
}) {
  const drive = await getDriveClient();

  let folderId;
  if (customerName && docType) {
    folderId = await ensureCustomerDocFolder(customerName, docType, companyId);
  } else {
    folderId = await getModuleFolder(moduleType);
    if (entityLabel) folderId = await _findOrCreateFolder(entityLabel, folderId);
  }

  const checksum = createHash('sha256').update(buffer).digest('hex');
  const stream   = Readable.from(buffer);

  const response = await drive.files.create({
    requestBody: { name: originalName, parents: [folderId] },
    media:       { mimeType: mimeType || 'application/octet-stream', body: stream },
    fields:      'id,name,webViewLink,webContentLink,size',
  });

  const file = response.data;
  return {
    drive_file_id:   file.id,
    drive_link:      file.webViewLink,
    drive_folder_id: folderId,
    file_name:       file.name,
    file_size_bytes: buffer.length,
    checksum_sha256: checksum,
  };
}

/* ── Upload a JSON object as a Drive record ──────────────────────────────
 *  Used for auto-generating Drive records from ERP data (FAT, commissioning,
 *  AMC docs etc.) when no binary PDF is available.
 */
export async function uploadJsonRecord({
  data,
  fileName,
  customerName,
  docType,
  companyId = null,
}) {
  const json   = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(json, 'utf8');
  return uploadFile({
    buffer,
    originalName: fileName,
    mimeType:     'application/json',
    customerName,
    docType,
    companyId,
  });
}

/* ── File operations ────────────────────────────────────────────────────── */
export async function getFileMetadata(driveFileId) {
  const drive = await getDriveClient();
  const resp  = await drive.files.get({
    fileId: driveFileId,
    fields: 'id,name,webViewLink,webContentLink,size,mimeType,createdTime,modifiedTime',
  });
  return resp.data;
}

export async function downloadFile(driveFileId) {
  const drive = await getDriveClient();
  const resp  = await drive.files.get(
    { fileId: driveFileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(resp.data);
}

export async function deleteFile(driveFileId) {
  const drive = await getDriveClient();
  await drive.files.delete({ fileId: driveFileId });
}

export async function moveFile(driveFileId, newParentId) {
  const drive     = await getDriveClient();
  const meta      = await drive.files.get({ fileId: driveFileId, fields: 'parents' });
  const prevParents = (meta.data.parents || []).join(',');
  await drive.files.update({
    fileId:        driveFileId,
    addParents:    newParentId,
    removeParents: prevParents,
    fields:        'id,parents',
  });
}

export async function ping() {
  const drive  = await getDriveClient();
  const rootId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) return { ok: false, error: 'GOOGLE_DRIVE_ROOT_FOLDER_ID not set' };
  try {
    await drive.files.get({ fileId: rootId, fields: 'id,name' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
