/**
 * Phase 49C — Vendor Self-Registration Portal
 * Public routes (no auth) for registration, OTP, and status check.
 * Authenticated routes for internal staff to list/manage registrations.
 */
import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import pool from '../../../config/db.js';
import { verifyToken } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { uploadFile } from '../../../services/StorageService.js';
import { companyOf } from '../../../shared/scope.js';
import { generateOtp } from '../../../utils/otp.js';
import { dbRateLimit } from '../../../middlewares/rateLimit.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// /submit is unauthenticated, writes a row, and dispatches two OTPs (email +
// SMS) per call — so it is both a junk-data and a billing vector. Keyed on IP
// because there is no prior resource to key on: the registration does not exist
// until this call succeeds.
const submitLimit = dbRateLimit({
  windowMs: 60 * 60 * 1000,
  max:      5,
  bucket:   'vendreg_submit',
});

// Resend is keyed on the registration id, not the IP: the abuse worth stopping
// is repeatedly texting one vendor's phone, which an attacker would otherwise
// do from rotating addresses.
const resendLimit = dbRateLimit({
  windowMs: 60 * 60 * 1000,
  max:      5,
  bucket:   'vendreg_resend',
  key:      req => req.params.id,
});

const router = express.Router();
const cid = req => companyOf(req);
const uid = req => req.user?.userId ?? req.user?.id ?? null;

const VENDOR_TYPES = [
  'Raw Material', 'Electrical Components', 'Electronics', 'Semiconductors',
  'Transformers', 'Fabrication', 'Machining', 'Packaging', 'Logistics',
  'Service Provider', 'Commissioning Partner', 'AMC Partner', 'Consultant',
  'Contract Labour', 'Other',
];

function genOTP() { return generateOtp(); }

// ── DUPLICATE CHECK HELPER ────────────────────────────────────────────────────
async function checkDuplicate(gstin, pan, vendor_name, excludeId = null) {
  const results = [];
  if (gstin) {
    const { rows } = await pool.query(
      `SELECT id, vendor_name FROM vendors WHERE gstin=$1 ${excludeId ? 'AND id<>$2' : ''} LIMIT 1`,
      excludeId ? [gstin, excludeId] : [gstin]
    );
    if (rows[0]) results.push({ field: 'GSTIN', existing: rows[0].vendor_name });
  }
  if (pan) {
    const { rows } = await pool.query(
      `SELECT id, vendor_name FROM vendors WHERE pan=$1 ${excludeId ? 'AND id<>$2' : ''} LIMIT 1`,
      excludeId ? [pan, excludeId] : [pan]
    );
    if (rows[0]) results.push({ field: 'PAN', existing: rows[0].vendor_name });
  }
  if (vendor_name) {
    const { rows } = await pool.query(
      `SELECT id, vendor_name FROM vendors WHERE LOWER(vendor_name)=LOWER($1) ${excludeId ? 'AND id<>$2' : ''} LIMIT 1`,
      excludeId ? [vendor_name, excludeId] : [vendor_name]
    );
    if (rows[0]) results.push({ field: 'Name', existing: rows[0].vendor_name });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS (no verifyToken)
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /vendor-registration/check-duplicate ─────────────────────────────────
router.post('/check-duplicate', async (req, res) => {
  try {
    const { gstin, pan, vendor_name } = req.body;
    const dupes = await checkDuplicate(gstin, pan, vendor_name);
    res.json({ duplicates: dupes, isDuplicate: dupes.length > 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /vendor-registration/submit ─────────────────────────────────────────
// Step 1: basic info + OTP trigger
router.post('/submit', submitLimit, async (req, res) => {
  try {
    const {
      vendor_name, vendor_type, products_services,
      gstin, pan, msme_status, udyam_number, iec, cin,
      website, year_established, employee_count, annual_turnover,
      address, city, state, country, pincode,
      contact_person, email, phone,
      factory_locations, office_locations,
      contact_details,
      bank_name, account_number, ifsc, branch,
      technical_capability,
      company_id,
    } = req.body;

    if (!vendor_name || !email || !phone) {
      return res.status(400).json({ error: 'vendor_name, email, and phone are required' });
    }

    // Duplicate guard
    const dupes = await checkDuplicate(gstin, pan, vendor_name);
    if (dupes.length > 0) {
      return res.status(409).json({
        error: 'Potential duplicate detected',
        duplicates: dupes,
        isDuplicate: true,
      });
    }

    const emailOtp = genOTP();
    const mobileOtp = genOTP();
    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min

    const { rows: [reg] } = await pool.query(`
      INSERT INTO vendor_registrations (
        vendor_name, vendor_type, products_services,
        gstin, pan, msme_status, udyam_number, iec, cin,
        website, year_established, num_employees, annual_turnover,
        address, city, state, country, pincode,
        contact_person, email, phone,
        factory_locations, office_locations, contact_details,
        bank_name, account_number, ifsc,
        technical_capability,
        email_otp, email_otp_expires,
        mobile_otp, mobile_otp_expires,
        status, company_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,'Draft',$33
      ) RETURNING id, vendor_name, email, phone, status
    `, [
      vendor_name, vendor_type, products_services,
      gstin, pan, msme_status || false, udyam_number, iec, cin,
      website, year_established || null, employee_count || null, annual_turnover || null,
      address, city, state, country || 'India', pincode,
      contact_person, email, phone,
      JSON.stringify(factory_locations || []),
      JSON.stringify(office_locations || []),
      JSON.stringify(contact_details || []),
      bank_name, account_number, ifsc,
      technical_capability,
      emailOtp, otpExpiry,
      mobileOtp, otpExpiry,
      company_id || null,
    ]);

    // In production, send OTPs via email/SMS. For now, return them in response (dev mode).
    res.status(201).json({
      message: 'Registration saved. OTPs sent to your email and phone.',
      registration_id: reg.id,
      vendor_name: reg.vendor_name,
      // Remove these in production — send via actual email/SMS
      _dev_email_otp: process.env.NODE_ENV !== 'production' ? emailOtp : undefined,
      _dev_mobile_otp: process.env.NODE_ENV !== 'production' ? mobileOtp : undefined,
    });
  } catch (err) {
    console.error('[POST /vendor-registration/submit]', err.message);
    res.status(500).json({ error: 'Registration failed', detail: err.message });
  }
});

// ── POST /vendor-registration/:id/verify-email ───────────────────────────────
router.post('/:id/verify-email', async (req, res) => {
  try {
    const { otp } = req.body;
    const { rows: [reg] } = await pool.query(
      `SELECT id, email_otp, email_otp_expires, email_verified FROM vendor_registrations WHERE id=$1`,
      [req.params.id]
    );
    if (!reg) return res.status(404).json({ error: 'Registration not found' });
    if (reg.email_verified) return res.json({ message: 'Email already verified' });
    if (new Date(reg.email_otp_expires) < new Date()) {
      return res.status(400).json({ error: 'OTP expired. Please resend.' });
    }
    if (reg.email_otp !== String(otp)) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }
    await pool.query(
      `UPDATE vendor_registrations SET email_verified=true, email_otp=NULL, email_otp_expires=NULL, updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ message: 'Email verified successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /vendor-registration/:id/verify-mobile ──────────────────────────────
router.post('/:id/verify-mobile', async (req, res) => {
  try {
    const { otp } = req.body;
    const { rows: [reg] } = await pool.query(
      `SELECT id, mobile_otp, mobile_otp_expires, mobile_verified FROM vendor_registrations WHERE id=$1`,
      [req.params.id]
    );
    if (!reg) return res.status(404).json({ error: 'Registration not found' });
    if (reg.mobile_verified) return res.json({ message: 'Mobile already verified' });
    if (new Date(reg.mobile_otp_expires) < new Date()) {
      return res.status(400).json({ error: 'OTP expired. Please resend.' });
    }
    if (reg.mobile_otp !== String(otp)) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }
    await pool.query(
      `UPDATE vendor_registrations SET mobile_verified=true, mobile_otp=NULL, mobile_otp_expires=NULL, updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ message: 'Mobile verified successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /vendor-registration/:id/resend-otp ─────────────────────────────────
router.post('/:id/resend-otp', resendLimit, async (req, res) => {
  try {
    const { type } = req.body; // 'email' | 'mobile'
    const newOtp = genOTP();
    const expiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    if (type === 'email') {
      await pool.query(
        `UPDATE vendor_registrations SET email_otp=$1, email_otp_expires=$2, updated_at=NOW() WHERE id=$3`,
        [newOtp, expiry, req.params.id]
      );
    } else {
      await pool.query(
        `UPDATE vendor_registrations SET mobile_otp=$1, mobile_otp_expires=$2, updated_at=NOW() WHERE id=$3`,
        [newOtp, expiry, req.params.id]
      );
    }
    res.json({
      message: `OTP resent to ${type}`,
      _dev_otp: process.env.NODE_ENV !== 'production' ? newOtp : undefined,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /vendor-registration/:id/finalize ───────────────────────────────────
// Submit the registration after OTP verification
router.post('/:id/finalize', async (req, res) => {
  try {
    const { rows: [reg] } = await pool.query(
      `SELECT id, email_verified, mobile_verified FROM vendor_registrations WHERE id=$1`,
      [req.params.id]
    );
    if (!reg) return res.status(404).json({ error: 'Registration not found' });
    if (!reg.email_verified) {
      return res.status(400).json({ error: 'Email not verified. Please verify OTP first.' });
    }
    const { rows: [updated] } = await pool.query(
      `UPDATE vendor_registrations SET status='Submitted', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json({ message: 'Registration submitted successfully', registration: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /vendor-registration/status/:id ──────────────────────────────────────
// Vendor checks their own registration status
router.get('/status/:id', async (req, res) => {
  try {
    const { rows: [reg] } = await pool.query(`
      SELECT id, vendor_name, status, created_at, updated_at,
             email_verified, mobile_verified,
             scm_remarks, quality_remarks, finance_remarks, mgmt_remarks,
             rejection_reason
      FROM vendor_registrations WHERE id=$1
    `, [req.params.id]);
    if (!reg) return res.status(404).json({ error: 'Not found' });
    res.json(reg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /vendor-registration/vendor-types ────────────────────────────────────
router.get('/vendor-types', (_req, res) => res.json(VENDOR_TYPES));

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATED ENDPOINTS (internal staff)
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /vendor-registration (list all registrations) ────────────────────────
router.get('/', verifyToken, async (req, res) => {
  try {
    const { status, search, vendor_type, page = 1, limit = 25 } = req.query;
    const companyId = cid(req);
    const conds = ['1=1'];
    const params = [];
    let idx = 1;

    if (companyId) { conds.push(`(company_id=$${idx++} OR company_id IS NULL)`); params.push(companyId); }
    if (status)    { conds.push(`status=$${idx++}`); params.push(status); }
    if (vendor_type) { conds.push(`vendor_type=$${idx++}`); params.push(vendor_type); }
    if (search) {
      conds.push(`(vendor_name ILIKE $${idx} OR email ILIKE $${idx} OR gstin ILIKE $${idx} OR pan ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = `WHERE ${conds.join(' AND ')}`;
    const offset = (Number(page) - 1) * Number(limit);

    const [{ rows: regs }, { rows: [{ total }] }] = await Promise.all([
      pool.query(
        `SELECT * FROM vendor_registrations ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) AS total FROM vendor_registrations ${where}`, params),
    ]);

    res.json({ registrations: regs, total: Number(total), page: Number(page), limit: Number(limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /vendor-registration/:id (single) ────────────────────────────────────
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { rows: [reg] } = await pool.query(`SELECT * FROM vendor_registrations WHERE id=$1`, [req.params.id]);
    if (!reg) return res.status(404).json({ error: 'Not found' });

    // Fetch related documents
    const { rows: docs } = await pool.query(
      `SELECT * FROM vendor_documents WHERE registration_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    reg.documents = docs;

    res.json(reg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /vendor-registration/stats/summary ───────────────────────────────────
router.get('/stats/summary', verifyToken, async (req, res) => {
  try {
    const companyId = cid(req);
    const cFilter = companyId ? `WHERE (company_id=$1 OR company_id IS NULL)` : '';
    const params = companyId ? [companyId] : [];
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='Draft')             AS draft,
        COUNT(*) FILTER (WHERE status='Submitted')          AS submitted,
        COUNT(*) FILTER (WHERE status='Under Review')       AS under_review,
        COUNT(*) FILTER (WHERE status LIKE 'Pending%')      AS pending_review,
        COUNT(*) FILTER (WHERE status='Approved')           AS approved,
        COUNT(*) FILTER (WHERE status='Rejected')           AS rejected,
        COUNT(*) FILTER (WHERE status='Blocked')            AS blocked,
        COUNT(*) AS total
      FROM vendor_registrations ${cFilter}
    `, params);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /vendor-registration/:id/documents ──────────────────────────────────
router.post('/:id/documents', verifyToken, upload.single('file'), async (req, res) => {
  try {
    const { doc_type, file_name, drive_file_id, drive_file_url, expiry_date, remarks } = req.body;
    let { file_path } = req.body;
    // If a file was attached, upload via StorageService; fall back to req.body.file_path on error
    if (req.file) {
      try {
        file_path = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      } catch (uploadErr) {
        console.error('[vendor-registration/documents] StorageService upload failed (non-fatal):', uploadErr.message);
      }
    }
    const { rows: [doc] } = await pool.query(`
      INSERT INTO vendor_documents
        (registration_id, doc_type, file_name, file_path, drive_file_id, drive_file_url, expiry_date, remarks, company_id, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [req.params.id, doc_type, file_name || req.file?.originalname || null, file_path, drive_file_id, drive_file_url, expiry_date || null, remarks, cid(req), uid(req)]);
    res.status(201).json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /vendor-registration/:id/drive-folder ───────────────────────────────
router.post('/:id/drive-folder', verifyToken, async (req, res) => {
  try {
    const { root_folder_id, root_folder_url, folder_map, vendor_name } = req.body;
    const { rows: [df] } = await pool.query(`
      INSERT INTO vendor_drive_folders (registration_id, vendor_name, root_folder_id, root_folder_url, folder_map)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (registration_id) DO UPDATE
        SET root_folder_id=$3, root_folder_url=$4, folder_map=$5, updated_at=NOW()
      RETURNING *
    `, [req.params.id, vendor_name, root_folder_id, root_folder_url, JSON.stringify(folder_map || {})]);

    await pool.query(
      `UPDATE vendor_registrations SET drive_folder_id=$1, drive_folder_url=$2, updated_at=NOW() WHERE id=$3`,
      [root_folder_id, root_folder_url, req.params.id]
    );
    res.json(df);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
