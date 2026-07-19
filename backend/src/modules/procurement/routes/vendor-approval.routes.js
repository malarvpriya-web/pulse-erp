/**
 * Phase 49C — Vendor Approval Workflow
 * SCM → Quality → Finance → Management multi-stage approval.
 * Includes vendor contacts, bank details, NCR, CAPA, and CEO traceability.
 */
import express from 'express';
import multer from 'multer';
import pool from '../../../config/db.js';
import { verifyToken, allowRoles } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import VendorService from '../services/vendor.service.js';
import { uploadFile } from '../../../services/StorageService.js';
import { companyOf } from '../../../shared/scope.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();
const cid = req => companyOf(req);
const uid = req => req.user?.userId ?? req.user?.id ?? null;

// All routes require authentication
router.use(verifyToken);

// ── APPROVAL QUEUE ────────────────────────────────────────────────────────────

// ── GET /vendor-approval/queue ────────────────────────────────────────────────
router.get('/queue', async (req, res) => {
  try {
    const { stage, status = 'pending', page = 1, limit = 25 } = req.query;
    const companyId = cid(req);
    const userRole = req.user?.role;

    // Determine which statuses show for each role
    const roleStatusMap = {
      scm:        ['Submitted', 'Pending SCM Review'],
      quality:    ['Pending Quality Review'],
      finance:    ['Pending Finance Review'],
      management: ['Pending Management Review'],
      admin:      ['Submitted', 'Under Review', 'Pending SCM Review', 'Pending Quality Review', 'Pending Finance Review', 'Pending Management Review'],
      super_admin:['Submitted', 'Under Review', 'Pending SCM Review', 'Pending Quality Review', 'Pending Finance Review', 'Pending Management Review'],
    };

    const allowedStatuses = roleStatusMap[userRole] || roleStatusMap['admin'];
    const conds = [`status = ANY($1)`];
    const params = [allowedStatuses];
    let idx = 2;

    if (companyId) { conds.push(`(company_id=$${idx++} OR company_id IS NULL)`); params.push(companyId); }
    if (stage) { conds.push(`status ILIKE $${idx++}`); params.push(`%${stage}%`); }

    const where = `WHERE ${conds.join(' AND ')}`;
    const offset = (Number(page) - 1) * Number(limit);

    const [{ rows }, { rows: [ct] }] = await Promise.all([
      pool.query(
        `SELECT id, vendor_name, vendor_type, email, phone, gstin, pan, city, state, status, created_at, scm_remarks, quality_remarks, finance_remarks, mgmt_remarks, scm_score, scm_quality_score, finance_score
         FROM vendor_registrations ${where}
         ORDER BY created_at ASC
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) AS total FROM vendor_registrations ${where}`, params),
    ]);

    res.json({ queue: rows, total: Number(ct.total), page: Number(page), limit: Number(limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /vendor-approval/:id ──────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows: [reg] } = await pool.query(`SELECT * FROM vendor_registrations WHERE id=$1`, [req.params.id]);
    if (!reg) return res.status(404).json({ error: 'Not found' });

    const [{ rows: docs }, { rows: contacts }, { rows: banks }] = await Promise.all([
      pool.query(`SELECT * FROM vendor_documents WHERE registration_id=$1 ORDER BY doc_type`, [reg.id]),
      pool.query(`SELECT * FROM vendor_contacts WHERE vendor_id=$1 ORDER BY is_primary DESC`, [reg.vendor_id || -1]),
      pool.query(`SELECT * FROM vendor_bank_details WHERE registration_id=$1 ORDER BY is_primary DESC`, [reg.id]),
    ]);

    res.json({ ...reg, documents: docs, contacts, banks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /vendor-approval/:id/scm-review ──────────────────────────────────────
router.put('/:id/scm-review', allowRoles('admin', 'super_admin', 'procurement', 'scm', 'manager'), async (req, res) => {
  try {
    const {
      decision, remarks,
      products_verified, capacity_verified, lead_time, moq,
      commercial_terms, references, past_experience, scm_score,
    } = req.body;

    if (!['Approve', 'Reject', 'Hold'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be Approve, Reject, or Hold' });
    }

    let newStatus = 'Under Review';
    if (decision === 'Reject')  newStatus = 'Rejected';
    else if (decision === 'Hold') newStatus = 'On Hold';
    else newStatus = 'Pending Quality Review';

    const { rows: [reg] } = await pool.query(`
      UPDATE vendor_registrations SET
        scm_reviewed_by=$1, scm_reviewed_at=NOW(), scm_remarks=$2, scm_score=$3,
        status=$4, updated_at=NOW()
      WHERE id=$5 RETURNING *
    `, [uid(req), remarks, scm_score || 0, newStatus, req.params.id]);

    if (!reg) return res.status(404).json({ error: 'Not found' });
    logAudit({ userId: uid(req), module: 'vendor_approval', recordId: reg.id, recordType: 'vendor_registration', action: 'scm_review', newData: { decision, remarks, scm_score } });
    res.json(reg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /vendor-approval/:id/quality-review ──────────────────────────────────
router.put('/:id/quality-review', allowRoles('admin', 'super_admin', 'quality', 'manager'), async (req, res) => {
  try {
    const {
      decision, remarks,
      iso_verified, inspection_capability, testing_capability,
      quality_processes, ncr_history, quality_score,
    } = req.body;

    if (!['Approve', 'Reject', 'Hold'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be Approve, Reject, or Hold' });
    }

    let newStatus = 'Pending Finance Review';
    if (decision === 'Reject')  newStatus = 'Rejected';
    else if (decision === 'Hold') newStatus = 'On Hold';

    const { rows: [reg] } = await pool.query(`
      UPDATE vendor_registrations SET
        quality_reviewed_by=$1, quality_reviewed_at=NOW(), quality_remarks=$2, scm_quality_score=$3,
        status=$4, updated_at=NOW()
      WHERE id=$5 RETURNING *
    `, [uid(req), remarks, quality_score || 0, newStatus, req.params.id]);

    if (!reg) return res.status(404).json({ error: 'Not found' });
    logAudit({ userId: uid(req), module: 'vendor_approval', recordId: reg.id, recordType: 'vendor_registration', action: 'quality_review', newData: { decision, remarks, quality_score } });
    res.json(reg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /vendor-approval/:id/finance-review ───────────────────────────────────
router.put('/:id/finance-review', allowRoles('admin', 'super_admin', 'finance', 'manager'), async (req, res) => {
  try {
    const {
      decision, remarks,
      gst_verified, pan_verified, bank_verified,
      credit_terms, financial_stability, compliance_ok, finance_score,
    } = req.body;

    if (!['Approve', 'Reject', 'Hold'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be Approve, Reject, or Hold' });
    }

    let newStatus = 'Pending Management Review';
    if (decision === 'Reject')  newStatus = 'Rejected';
    else if (decision === 'Hold') newStatus = 'On Hold';

    const { rows: [reg] } = await pool.query(`
      UPDATE vendor_registrations SET
        finance_reviewed_by=$1, finance_reviewed_at=NOW(), finance_remarks=$2, finance_score=$3,
        status=$4, updated_at=NOW()
      WHERE id=$5 RETURNING *
    `, [uid(req), remarks, finance_score || 0, newStatus, req.params.id]);

    if (!reg) return res.status(404).json({ error: 'Not found' });
    logAudit({ userId: uid(req), module: 'vendor_approval', recordId: reg.id, recordType: 'vendor_registration', action: 'finance_review', newData: { decision, remarks, finance_score } });
    res.json(reg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /vendor-approval/:id/management-review ───────────────────────────────
router.put('/:id/management-review', allowRoles('admin', 'super_admin', 'manager', 'director'), async (req, res) => {
  try {
    const { decision, remarks, conditions } = req.body;
    if (!['Approved', 'Conditional Approval', 'Rejected'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be Approved, Conditional Approval, or Rejected' });
    }

    const newStatus = decision === 'Rejected' ? 'Rejected' : 'Approved';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [reg] } = await client.query(`
        UPDATE vendor_registrations SET
          mgmt_approved_by=$1, mgmt_approved_at=NOW(), mgmt_remarks=$2,
          status=$3, updated_at=NOW()
        WHERE id=$4 RETURNING *
      `, [uid(req), remarks, newStatus, req.params.id]);

      if (!reg) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

      let vendorId = reg.vendor_id;

      // Auto-promote to vendor master on approval
      if (newStatus === 'Approved' && !vendorId) {
        const riskScore = await VendorService.computeInitialRisk(reg);

        // Generate vendor code
        const { rows: [ct] } = await client.query(`SELECT COUNT(*) AS cnt FROM vendors WHERE company_id=$1 OR company_id IS NULL`, [reg.company_id]);
        const code = `VND-${String(Number(ct.cnt) + 1).padStart(4, '0')}`;

        const { rows: [vendor] } = await client.query(`
          INSERT INTO vendors (
            vendor_name, category, vendor_type, vendor_category, vendor_code,
            gstin, pan, udyam_number, msme_status, iec, cin, website,
            address, city, state, country, postal_code,
            contact_person, email, phone,
            annual_turnover, employee_count, year_established,
            bank_name, account_number, ifsc,
            status, classification,
            risk_score, risk_rating,
            approved_by, approved_at, registration_id, company_id
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,'Active','Approved',$27,$28,$29,NOW(),$30,$31
          ) RETURNING id
        `, [
          reg.vendor_name, reg.vendor_type || 'General', reg.vendor_type, reg.vendor_type, code,
          reg.gstin, reg.pan, reg.udyam_number, reg.msme_status, reg.iec, reg.cin, reg.website,
          reg.address, reg.city, reg.state, reg.country || 'India', reg.pincode,
          reg.contact_person, reg.email, reg.phone,
          reg.annual_turnover, reg.num_employees, reg.year_established,
          reg.bank_name, reg.account_number, reg.ifsc,
          riskScore, riskScore >= 70 ? 'High' : riskScore >= 40 ? 'Medium' : 'Low',
          uid(req), reg.id, reg.company_id,
        ]);

        vendorId = vendor.id;
        await client.query(`UPDATE vendor_registrations SET vendor_id=$1, updated_at=NOW() WHERE id=$2`, [vendorId, reg.id]);

        // Migrate contacts to vendor_contacts
        if (reg.contact_details) {
          const contacts = Array.isArray(reg.contact_details) ? reg.contact_details : JSON.parse(reg.contact_details || '[]');
          for (const c of contacts) {
            await client.query(`
              INSERT INTO vendor_contacts (vendor_id, contact_type, name, designation, phone, mobile, email, company_id)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `, [vendorId, c.type || 'Commercial', c.name, c.designation, c.phone, c.mobile, c.email, reg.company_id]);
          }
        }

        // Migrate bank details
        if (reg.bank_name) {
          await client.query(`
            INSERT INTO vendor_bank_details (vendor_id, bank_name, account_number, ifsc, is_primary, company_id)
            VALUES ($1,$2,$3,$4,true,$5)
          `, [vendorId, reg.bank_name, reg.account_number, reg.ifsc, reg.company_id]);
        }

        // Migrate documents
        await client.query(
          `UPDATE vendor_documents SET vendor_id=$1, updated_at=NOW() WHERE registration_id=$2`,
          [vendorId, reg.id]
        );

        // Initial risk assessment
        await client.query(`
          INSERT INTO vendor_risk_assessments
            (vendor_id, financial_risk, quality_risk, delivery_risk, compliance_risk, dependency_risk, overall_risk_score, risk_rating, assessed_by, company_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [vendorId, riskScore * 0.3, riskScore * 0.25, riskScore * 0.2, riskScore * 0.15, riskScore * 0.1,
            riskScore, riskScore >= 70 ? 'High' : riskScore >= 40 ? 'Medium' : 'Low',
            uid(req), reg.company_id]);
      }

      await client.query('COMMIT');

      logAudit({ userId: uid(req), module: 'vendor_approval', recordId: reg.id, recordType: 'vendor_registration', action: 'management_review', newData: { decision, remarks } });
      res.json({ ...reg, status: newStatus, vendor_id: vendorId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR CONTACTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/contacts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vendor_contacts WHERE vendor_id=$1 ORDER BY is_primary DESC, contact_type`,
      [req.params.vendorId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendors/:vendorId/contacts', async (req, res) => {
  try {
    const { contact_type, name, designation, phone, mobile, email, is_primary } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (is_primary) {
      await pool.query(`UPDATE vendor_contacts SET is_primary=false WHERE vendor_id=$1`, [req.params.vendorId]);
    }
    const { rows: [c] } = await pool.query(`
      INSERT INTO vendor_contacts (vendor_id, contact_type, name, designation, phone, mobile, email, is_primary, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [req.params.vendorId, contact_type || 'Commercial', name, designation, phone, mobile, email, is_primary || false, cid(req)]);
    res.status(201).json(c);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/contacts/:id', async (req, res) => {
  try {
    const { contact_type, name, designation, phone, mobile, email, is_primary } = req.body;
    const { rows: [c] } = await pool.query(`
      UPDATE vendor_contacts SET contact_type=$1, name=$2, designation=$3, phone=$4, mobile=$5, email=$6, is_primary=$7, updated_at=NOW()
      WHERE id=$8 RETURNING *
    `, [contact_type, name, designation, phone, mobile, email, is_primary || false, req.params.id]);
    res.json(c);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/contacts/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM vendor_contacts WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR BANK DETAILS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/banks', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vendor_bank_details WHERE vendor_id=$1 ORDER BY is_primary DESC`,
      [req.params.vendorId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendors/:vendorId/banks', async (req, res) => {
  try {
    const { bank_name, account_number, ifsc, branch, account_type, is_primary } = req.body;
    if (is_primary) {
      await pool.query(`UPDATE vendor_bank_details SET is_primary=false WHERE vendor_id=$1`, [req.params.vendorId]);
    }
    const { rows: [b] } = await pool.query(`
      INSERT INTO vendor_bank_details (vendor_id, bank_name, account_number, ifsc, branch, account_type, is_primary, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.params.vendorId, bank_name, account_number, ifsc, branch, account_type || 'Current', is_primary || false, cid(req)]);
    res.status(201).json(b);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/banks/:id/verify', allowRoles('admin', 'super_admin', 'finance'), async (req, res) => {
  try {
    const { rows: [b] } = await pool.query(`
      UPDATE vendor_bank_details SET finance_verified=true, finance_verified_by=$1, finance_verified_at=NOW(), updated_at=NOW()
      WHERE id=$2 RETURNING *
    `, [uid(req), req.params.id]);
    res.json(b);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR DOCUMENTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/documents', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vendor_documents WHERE vendor_id=$1 ORDER BY doc_type, created_at DESC`,
      [req.params.vendorId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendors/:vendorId/documents', upload.single('file'), async (req, res) => {
  try {
    const { doc_type, file_name, drive_file_id, drive_file_url, expiry_date, remarks } = req.body;
    let { file_path } = req.body;
    // If a file was attached, upload via StorageService; fall back to req.body.file_path on error
    if (req.file) {
      try {
        file_path = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      } catch (uploadErr) {
        console.error('[vendor-approval/documents] StorageService upload failed (non-fatal):', uploadErr.message);
      }
    }
    const { rows: [doc] } = await pool.query(`
      INSERT INTO vendor_documents (vendor_id, doc_type, file_name, file_path, drive_file_id, drive_file_url, expiry_date, remarks, company_id, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [req.params.vendorId, doc_type, file_name || req.file?.originalname || null, file_path, drive_file_id, drive_file_url, expiry_date || null, remarks, cid(req), uid(req)]);
    res.status(201).json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/documents/:id/verify', allowRoles('admin', 'super_admin', 'quality', 'finance'), async (req, res) => {
  try {
    const { rows: [doc] } = await pool.query(`
      UPDATE vendor_documents SET verified=true, verified_by=$1, verified_at=NOW(), updated_at=NOW()
      WHERE id=$2 RETURNING *
    `, [uid(req), req.params.id]);
    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// NCR
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/ncr', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vendor_ncr WHERE vendor_id=$1 ORDER BY ncr_date DESC`,
      [req.params.vendorId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/ncr', async (req, res) => {
  try {
    const { vendor_id, grn_id, po_id, defect_type, description, quantity_rejected, severity } = req.body;
    const companyId = cid(req);
    const { rows: [ct] } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM vendor_ncr WHERE company_id=$1 OR company_id IS NULL`,
      [companyId]
    );
    const ncrNumber = `NCR-${String(Number(ct.cnt) + 1).padStart(4, '0')}`;
    const { rows: [ncr] } = await pool.query(`
      INSERT INTO vendor_ncr (ncr_number, vendor_id, grn_id, po_id, defect_type, description, quantity_rejected, severity, company_id, raised_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [ncrNumber, vendor_id, grn_id || null, po_id || null, defect_type, description, quantity_rejected || null, severity || 'Minor', companyId, uid(req)]);
    res.status(201).json(ncr);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/ncr/:id', async (req, res) => {
  try {
    const { status, root_cause, disposition } = req.body;
    const closed = status === 'Closed' ? `closed_at=NOW(), closed_by=${uid(req)},` : '';
    const { rows: [ncr] } = await pool.query(`
      UPDATE vendor_ncr SET status=$1, root_cause=$2, disposition=$3, ${closed} updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [status, root_cause, disposition, req.params.id]);
    res.json(ncr);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPA
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/capa', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, n.ncr_number FROM vendor_capa c LEFT JOIN vendor_ncr n ON n.id=c.ncr_id WHERE c.vendor_id=$1 ORDER BY c.issue_date DESC`,
      [req.params.vendorId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/capa', async (req, res) => {
  try {
    const { ncr_id, vendor_id, capa_type, due_date, description, root_cause, action_plan, verification_method } = req.body;
    const companyId = cid(req);
    const { rows: [ct] } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM vendor_capa WHERE company_id=$1 OR company_id IS NULL`,
      [companyId]
    );
    const capaNumber = `CAPA-${String(Number(ct.cnt) + 1).padStart(4, '0')}`;
    const { rows: [capa] } = await pool.query(`
      INSERT INTO vendor_capa (capa_number, ncr_id, vendor_id, capa_type, due_date, description, root_cause, action_plan, verification_method, company_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [capaNumber, ncr_id || null, vendor_id, capa_type || 'Corrective', due_date || null, description, root_cause, action_plan, verification_method, companyId, uid(req)]);
    res.status(201).json(capa);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/capa/:id', async (req, res) => {
  try {
    const { status, effectiveness_rating, root_cause, action_plan } = req.body;
    const closed = status === 'Closed' ? `closed_at=NOW(), closed_by=${uid(req)},` : '';
    const { rows: [capa] } = await pool.query(`
      UPDATE vendor_capa SET status=$1, effectiveness_rating=$2, root_cause=$3, action_plan=$4, ${closed} updated_at=NOW()
      WHERE id=$5 RETURNING *
    `, [status, effectiveness_rating || null, root_cause, action_plan, req.params.id]);
    res.json(capa);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// RISK ASSESSMENTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/risk', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vendor_risk_assessments WHERE vendor_id=$1 ORDER BY assessment_date DESC LIMIT 12`,
      [req.params.vendorId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendors/:vendorId/risk', async (req, res) => {
  try {
    const { financial_risk, quality_risk, delivery_risk, compliance_risk, dependency_risk, notes } = req.body;
    const scores = [financial_risk, quality_risk, delivery_risk, compliance_risk, dependency_risk].map(Number);
    const overall = scores.reduce((a, b) => a + b, 0) / scores.length;
    const rating = overall >= 70 ? 'Critical' : overall >= 50 ? 'High' : overall >= 30 ? 'Medium' : 'Low';

    const { rows: [ra] } = await pool.query(`
      INSERT INTO vendor_risk_assessments
        (vendor_id, financial_risk, quality_risk, delivery_risk, compliance_risk, dependency_risk, overall_risk_score, risk_rating, notes, assessed_by, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [req.params.vendorId, ...scores, parseFloat(overall.toFixed(2)), rating, notes, uid(req), cid(req)]);

    // Update vendor master risk fields
    await pool.query(
      `UPDATE vendors SET risk_score=$1, risk_rating=$2, updated_at=NOW() WHERE id=$3`,
      [ra.overall_risk_score, ra.risk_rating, req.params.vendorId]
    );
    res.status(201).json(ra);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CEO TRACEABILITY (49C-25)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/traceability', async (req, res) => {
  try {
    const { vendorId } = req.params;
    const companyId = cid(req);

    const [
      { rows: [vendor] },
      { rows: [spend] },
      { rows: ncrs },
      { rows: capas },
      { rows: [scorecard] },
      { rows: [risk] },
      { rows: projects },
      { rows: payments },
    ] = await Promise.all([
      pool.query(`SELECT id, vendor_name, vendor_code, classification, risk_rating, approved_by, approved_at FROM vendors WHERE id=$1`, [vendorId]),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS total_spend, COUNT(*) AS po_count FROM purchase_orders WHERE supplier_id=$1::text`, [vendorId]),
      pool.query(`SELECT * FROM vendor_ncr WHERE vendor_id=$1 ORDER BY ncr_date DESC`, [vendorId]),
      pool.query(`SELECT * FROM vendor_capa WHERE vendor_id=$1 ORDER BY issue_date DESC`, [vendorId]),
      pool.query(`SELECT * FROM vendor_scorecards WHERE vendor_id=$1 ORDER BY period_year DESC, period_quarter DESC LIMIT 1`, [vendorId]),
      pool.query(`SELECT * FROM vendor_risk_assessments WHERE vendor_id=$1 ORDER BY assessment_date DESC LIMIT 1`, [vendorId]),
      pool.query(`SELECT DISTINCT p.id, p.project_number, p.project_name FROM projects p JOIN purchase_orders po ON po.project_id::text=p.id::text WHERE po.supplier_id=$1::text LIMIT 20`, [vendorId]).catch(() => ({ rows: [] })),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status='Paid') AS paid_count, COUNT(*) FILTER (WHERE status='Pending') AS outstanding_count, COALESCE(SUM(CASE WHEN status='Pending' THEN amount ELSE 0 END),0) AS outstanding_amount FROM vendor_payments WHERE vendor_id=$1`, [vendorId]).catch(() => ({ rows: [{ paid_count: 0, outstanding_count: 0, outstanding_amount: 0 }] })),
    ]);

    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    res.json({
      vendor,
      spend: { total: Number(spend?.total_spend || 0), po_count: Number(spend?.po_count || 0) },
      ncr: { count: ncrs.length, open: ncrs.filter(n => n.status === 'Open').length, records: ncrs },
      capa: { count: capas.length, open: capas.filter(c => c.status === 'Open').length, records: capas },
      scorecard: scorecard || null,
      risk: risk || null,
      projects,
      payments: payments[0] || {},
      traceability_score: [vendor, spend, ncrs.length === 0 || true, scorecard, risk].every(Boolean) ? 'PASS' : 'VENDOR TRACEABILITY FAILURE',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD (49C-21)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/dashboard/stats', async (req, res) => {
  try {
    const companyId = cid(req);
    const cf = companyId ? `WHERE (company_id=$1 OR company_id IS NULL)` : '';
    const params = companyId ? [companyId] : [];

    const [{ rows: [vs] }, { rows: [rs] }, { rows: ncrs }] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total_vendors,
          COUNT(*) FILTER (WHERE classification='Preferred') AS preferred,
          COUNT(*) FILTER (WHERE classification='Blocked' OR status='Blocked') AS blocked,
          COUNT(*) FILTER (WHERE risk_rating IN ('High','Critical')) AS high_risk,
          COUNT(*) FILTER (WHERE status='Active') AS active
        FROM vendors ${cf}
      `, params),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('Submitted','Pending SCM Review','Pending Quality Review','Pending Finance Review','Pending Management Review')) AS pending_approvals,
          COUNT(*) FILTER (WHERE status='Approved') AS approved
        FROM vendor_registrations ${cf}
      `, params),
      pool.query(`SELECT COUNT(*) AS open_ncr FROM vendor_ncr WHERE status='Open' AND (company_id=$1 OR company_id IS NULL)`, [companyId || 0]).catch(() => ({ rows: [{ open_ncr: 0 }] })),
    ]);

    res.json({
      total_vendors: Number(vs.total_vendors),
      pending_approvals: Number(rs.pending_approvals),
      preferred_vendors: Number(vs.preferred),
      blocked_vendors: Number(vs.blocked),
      high_risk_vendors: Number(vs.high_risk),
      open_vendor_ncr: Number(ncrs[0]?.open_ncr || 0),
      active_vendors: Number(vs.active),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/dashboard/charts', async (req, res) => {
  try {
    const companyId = cid(req);
    const cf = companyId ? `(company_id=$1 OR company_id IS NULL)` : 'TRUE';
    const params = companyId ? [companyId] : [];

    const [{ rows: dist }, { rows: riskDist }, { rows: qualPerf }] = await Promise.all([
      pool.query(`
        SELECT vendor_type AS category, COUNT(*) AS count
        FROM vendors WHERE ${cf}
        GROUP BY vendor_type ORDER BY count DESC LIMIT 15
      `, params),
      pool.query(`
        SELECT risk_rating, COUNT(*) AS count
        FROM vendors WHERE ${cf}
        GROUP BY risk_rating
      `, params),
      pool.query(`
        SELECT v.vendor_name,
               AVG(vs.quality_score) AS quality,
               AVG(vs.delivery_score) AS delivery,
               AVG(vs.overall_score) AS overall
        FROM vendor_scorecards vs
        JOIN vendors v ON v.id=vs.vendor_id
        WHERE ${cf.replace('company_id', 'vs.company_id').replace('company_id', 'vs.company_id')}
        GROUP BY v.vendor_name
        ORDER BY overall DESC LIMIT 10
      `, params),
    ]);

    res.json({ vendor_distribution: dist, risk_distribution: riskDist, quality_performance: qualPerf });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS (49C-20)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/reports/vendor-master', async (req, res) => {
  try {
    const companyId = cid(req);
    const cf = companyId ? `WHERE (v.company_id=$1 OR v.company_id IS NULL)` : '';
    const params = companyId ? [companyId] : [];
    const { rows } = await pool.query(`
      SELECT v.*, vc.name AS primary_contact_name, vc.email AS primary_contact_email
      FROM vendors v
      LEFT JOIN vendor_contacts vc ON vc.vendor_id=v.id AND vc.is_primary=true
      ${cf}
      ORDER BY v.vendor_name
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/reports/approval-status', async (req, res) => {
  try {
    const companyId = cid(req);
    const cf = companyId ? `WHERE (company_id=$1 OR company_id IS NULL)` : '';
    const params = companyId ? [companyId] : [];
    const { rows } = await pool.query(
      `SELECT * FROM vendor_registrations ${cf} ORDER BY created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/reports/ncr-summary', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(`
      SELECT n.*, v.vendor_name, v.vendor_code
      FROM vendor_ncr n
      JOIN vendors v ON v.id=n.vendor_id
      WHERE (n.company_id=$1 OR n.company_id IS NULL)
      ORDER BY n.ncr_date DESC
    `, [companyId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
