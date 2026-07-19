// backend/src/modules/crm/customerDrive.controller.js
// Google Drive folder management for Customer 360
import pool from '../../config/db.js';
import { companyOf } from '../../shared/scope.js';
import {
  isDriveConfigured,
  ensureCustomerDocFolder,
  DOC_TYPES,
  uploadFile,
  ping,
} from '../../services/googleDrive.service.js';

// Numbered subfolder names matching 49B-15 spec
const CUSTOMER_SUBFOLDERS = [
  { key: 'Opportunities',           label: '01 Opportunities',          docType: DOC_TYPES.OPPORTUNITY },
  { key: 'Quotations',              label: '02 Quotations',             docType: DOC_TYPES.QUOTATION },
  { key: 'Purchase Orders',         label: '03 Purchase Orders',        docType: DOC_TYPES.PURCHASE_ORDER },
  { key: 'Contracts',               label: '04 Contracts',              docType: DOC_TYPES.CONTRACT },
  { key: 'Drawings',                label: '05 Drawings',               docType: DOC_TYPES.DRAWING },
  { key: 'BOM',                     label: '06 BOM',                    docType: DOC_TYPES.BOM },
  { key: 'FAT Reports',             label: '07 FAT Reports',            docType: DOC_TYPES.FAT_REPORT },
  { key: 'SAT Reports',             label: '08 SAT Reports',            docType: DOC_TYPES.SAT_REPORT },
  { key: 'Commissioning Reports',   label: '09 Commissioning Reports',  docType: DOC_TYPES.COMMISSIONING_REPORT },
  { key: 'Service Reports',         label: '10 Service Reports',        docType: DOC_TYPES.SERVICE_REPORT },
  { key: 'AMC',                     label: '11 AMC',                    docType: DOC_TYPES.AMC_DOCUMENT },
  { key: 'Invoices',                label: '12 Invoices',               docType: DOC_TYPES.INVOICE },
  { key: 'Travel Claims',           label: '13 Travel Claims',          docType: 'Travel Claims' },
  { key: 'Correspondence',          label: '14 Correspondence',         docType: 'Correspondence' },
];

// ── GET /api/crm/customer-drive/status ────────────────────────────────────────
export async function getDriveStatus(req, res) {
  try {
    const configured = isDriveConfigured();
    if (!configured) {
      return res.json({ configured: false, message: 'Google Drive credentials not set' });
    }
    const result = await ping();
    res.json({ configured: true, connected: result.ok, error: result.error || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/crm/customer-drive/provision/:customerId ────────────────────────
// Provisions all 14 subfolders for a customer in Google Drive.
// Idempotent — safe to call multiple times (uses DB cache).
export async function provisionCustomerFolders(req, res) {
  const { customerId } = req.params;
  const companyId = companyOf(req);

  try {
    const r = await pool.query('SELECT id, name FROM parties WHERE id = $1', [customerId]);
    const party = r.rows[0];
    if (!party) return res.status(404).json({ error: 'Customer not found' });

    if (!isDriveConfigured()) {
      return res.status(503).json({
        error: 'Google Drive not configured',
        hint: 'Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_ROOT_FOLDER_ID',
      });
    }

    const customerName = party.name.replace(/[^a-zA-Z0-9\s\-_.]/g, '').trim();
    const results = [];

    for (const sf of CUSTOMER_SUBFOLDERS) {
      try {
        const folderId = await ensureCustomerDocFolder(customerName, sf.label, companyId);

        // Build Drive folder URL from folder ID
        const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;

        // Upsert into DB cache with customer_id
        await pool.query(
          `INSERT INTO customer_drive_folders
             (company_id, customer_id, customer_name, doc_type, drive_folder_id, drive_folder_url)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (company_id, customer_name, doc_type)
           DO UPDATE SET
             drive_folder_id  = EXCLUDED.drive_folder_id,
             drive_folder_url = EXCLUDED.drive_folder_url,
             customer_id      = EXCLUDED.customer_id,
             updated_at       = NOW()`,
          [companyId, customerId, customerName, sf.label, folderId, folderUrl]
        );

        results.push({ folder: sf.label, folder_id: folderId, url: folderUrl, status: 'ok' });
      } catch (e) {
        results.push({ folder: sf.label, status: 'error', error: e.message });
      }
    }

    const ok = results.filter(r => r.status === 'ok').length;
    res.json({
      customer_id:   customerId,
      customer_name: party.name,
      folders_total: CUSTOMER_SUBFOLDERS.length,
      folders_ok:    ok,
      folders:       results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── GET /api/crm/customer-drive/:customerId/folders ───────────────────────────
// Returns all Drive folder links for a customer (from DB cache).
export async function getCustomerFolders(req, res) {
  const { customerId } = req.params;
  const companyId = companyOf(req);

  try {
    const r = await pool.query('SELECT name FROM parties WHERE id = $1', [customerId]);
    const party = r.rows[0];
    if (!party) return res.status(404).json({ error: 'Customer not found' });

    const { rows } = await pool.query(
      `SELECT doc_type, drive_folder_id, drive_folder_url, updated_at
       FROM customer_drive_folders
       WHERE customer_id = $1 AND ($2::int IS NULL OR company_id = $2)
       ORDER BY doc_type`,
      [customerId, companyId]
    );

    const folderMap = {};
    rows.forEach(row => {
      folderMap[row.doc_type] = {
        folder_id:  row.drive_folder_id,
        folder_url: row.drive_folder_url || `https://drive.google.com/drive/folders/${row.drive_folder_id}`,
        updated_at: row.updated_at,
      };
    });

    // Merge with the expected subfolder list so UI always has the full structure
    const folders = CUSTOMER_SUBFOLDERS.map(sf => ({
      key:        sf.key,
      label:      sf.label,
      doc_type:   sf.label,
      ...( folderMap[sf.label] || { folder_id: null, folder_url: null, updated_at: null }),
      provisioned: !!folderMap[sf.label],
    }));

    // Root folder URL (first provisioned folder's parent)
    const rootRow = rows[0];
    const rootUrl = rootRow
      ? null  // Drive API doesn't return parent URL easily; show folder links instead
      : null;

    res.json({
      customer_id:   customerId,
      customer_name: party.name,
      drive_root:    `Customers/${party.name.replace(/[^a-zA-Z0-9\s\-_.]/g, '').trim()}`,
      provisioned:   rows.length > 0,
      folders,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── GET /api/crm/customer-drive/:customerId/files ─────────────────────────────
// Lists uploaded files for a customer, optionally filtered by doc_type.
export async function getCustomerFiles(req, res) {
  const { customerId } = req.params;
  const { doc_type, limit = 50 } = req.query;
  const companyId = companyOf(req);

  try {
    const params = [customerId, companyId];
    let docTypeFilter = '';
    if (doc_type) {
      params.push(doc_type);
      docTypeFilter = `AND doc_type = $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT id, doc_type, file_name, drive_file_id, drive_link,
              mime_type, file_size_bytes, entity_type, entity_id,
              uploaded_by, created_at
       FROM customer_drive_files
       WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
         ${docTypeFilter}
       ORDER BY created_at DESC
       LIMIT ${parseInt(limit, 10)}`,
      params
    );

    // Counts by doc_type
    const { rows: counts } = await pool.query(
      `SELECT doc_type, COUNT(*)::int AS count,
              MAX(created_at) AS last_uploaded
       FROM customer_drive_files
       WHERE customer_id = $1 AND ($2::int IS NULL OR company_id = $2)
       GROUP BY doc_type`,
      [customerId, companyId]
    );

    const countMap = {};
    counts.forEach(c => { countMap[c.doc_type] = { count: c.count, last_uploaded: c.last_uploaded }; });

    res.json({
      files:      rows,
      counts:     countMap,
      total:      rows.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/crm/customer-drive/:customerId/upload ───────────────────────────
// Uploads a file (multipart) to the appropriate customer Drive subfolder.
// Expects: multipart/form-data with `file` + body field `doc_type`
export async function uploadCustomerFile(req, res) {
  const { customerId } = req.params;
  const companyId = companyOf(req);

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { doc_type, entity_type, entity_id } = req.body;
  if (!doc_type) return res.status(400).json({ error: 'doc_type is required' });

  try {
    const r = await pool.query('SELECT name FROM parties WHERE id = $1', [customerId]);
    const party = r.rows[0];
    if (!party) return res.status(404).json({ error: 'Customer not found' });

    if (!isDriveConfigured()) {
      return res.status(503).json({ error: 'Google Drive not configured' });
    }

    const customerName = party.name.replace(/[^a-zA-Z0-9\s\-_.]/g, '').trim();
    const result = await uploadFile({
      buffer:       req.file.buffer,
      originalName: req.file.originalname,
      mimeType:     req.file.mimetype,
      customerName,
      docType:      doc_type,
      companyId,
    });

    // Persist file record
    const { rows: [fileRow] } = await pool.query(
      `INSERT INTO customer_drive_files
         (company_id, customer_id, customer_name, doc_type, drive_file_id,
          file_name, drive_link, mime_type, file_size_bytes, checksum_sha256,
          entity_type, entity_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (drive_file_id) DO UPDATE SET
         drive_link = EXCLUDED.drive_link
       RETURNING *`,
      [
        companyId, customerId, customerName, doc_type,
        result.drive_file_id, req.file.originalname, result.drive_link,
        req.file.mimetype, req.file.buffer.length, result.checksum_sha256,
        entity_type || null, entity_id || null, req.user?.employee_id || null,
      ]
    );

    res.status(201).json({ file: fileRow, drive: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/crm/customer-drive/auto-route ───────────────────────────────────
// Called internally by other modules (quotation PDF generated, FAT signed, etc.)
// to auto-route documents into the correct customer folder.
export async function autoRouteDocument(req, res) {
  const {
    customer_id,
    customer_name,
    doc_type,      // e.g. '02 Quotations'
    entity_type,   // e.g. 'quotation'
    entity_id,
    file_name,
    file_buffer_b64,  // base64-encoded file content
    mime_type,
    company_id,
  } = req.body;

  if (!customer_id || !doc_type || !file_buffer_b64 || !file_name) {
    return res.status(400).json({ error: 'customer_id, doc_type, file_name, file_buffer_b64 required' });
  }

  try {
    const companyId = company_id ?? companyOf(req);

    let resolvedName = customer_name;
    if (!resolvedName) {
      const r = await pool.query('SELECT name FROM parties WHERE id = $1', [customer_id]);
      resolvedName = r.rows[0]?.name;
    }
    if (!resolvedName) return res.status(404).json({ error: 'Customer not found' });

    if (!isDriveConfigured()) {
      return res.status(503).json({ error: 'Google Drive not configured — document not routed' });
    }

    const cleanName = resolvedName.replace(/[^a-zA-Z0-9\s\-_.]/g, '').trim();
    const buffer = Buffer.from(file_buffer_b64, 'base64');

    const result = await uploadFile({
      buffer,
      originalName: file_name,
      mimeType:     mime_type || 'application/pdf',
      customerName: cleanName,
      docType:      doc_type,
      companyId,
    });

    // Persist
    await pool.query(
      `INSERT INTO customer_drive_files
         (company_id, customer_id, customer_name, doc_type, drive_file_id,
          file_name, drive_link, mime_type, file_size_bytes, checksum_sha256,
          entity_type, entity_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (drive_file_id) DO NOTHING`,
      [
        companyId, customer_id, cleanName, doc_type,
        result.drive_file_id, file_name, result.drive_link,
        mime_type || 'application/pdf', buffer.length, result.checksum_sha256,
        entity_type || null, entity_id || null, req.user?.employee_id || null,
      ]
    );

    res.status(201).json({ drive_link: result.drive_link, drive_file_id: result.drive_file_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
