// backend/src/modules/hr/selfservice.routes.js
import express from 'express';
import multer from 'multer';
import pool from '../../config/db.js';
import { uploadFile } from '../../services/StorageService.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

const HR_ROLES = ['admin', 'super_admin', 'hr', 'hr_admin', 'hr_manager', 'hr_exec', 'payroll_admin', 'HR', 'Admin', 'SuperAdmin'];

// Case-insensitive HR check — role casing varies across legacy accounts
const isHRUser = (req) =>
  HR_ROLES.some(r => r.toLowerCase() === String(req.user?.role || '').toLowerCase());


function getCurrentFY() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/* ─── GET /self-service/it-declarations ──────────────────────── */
router.get('/it-declarations', async (req, res) => {
  const { employee_id, financial_year } = req.query;
  if (!employee_id) return res.status(400).json({ message: 'employee_id is required' });
  const fy = financial_year || getCurrentFY();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM it_declarations WHERE employee_id=$1 AND financial_year=$2 ORDER BY declaration_type`,
      [employee_id, fy]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /self-service/it-declarations ─────────────────────── */
router.post('/it-declarations', async (req, res) => {
  const { employee_id, declaration_type, amount, description, proof_url, financial_year } = req.body;
  if (!employee_id || !declaration_type || !amount) return res.status(400).json({ message: 'employee_id, declaration_type, amount required' });
  const fy = financial_year || getCurrentFY();
  try {
    const { rows } = await pool.query(
      `INSERT INTO it_declarations (employee_id, financial_year, declaration_type, amount, description, proof_url)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [employee_id, fy, declaration_type, amount, description, proof_url]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /self-service/it-declarations/:id ─────────────────── */
router.put('/it-declarations/:id', async (req, res) => {
  const { amount, description, proof_url, status, reviewed_by } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE it_declarations SET amount=COALESCE($1,amount), description=COALESCE($2,description),
       proof_url=COALESCE($3,proof_url), status=COALESCE($4,status),
       reviewed_by=COALESCE($5,reviewed_by), reviewed_at=CASE WHEN $4 IS NOT NULL THEN NOW() ELSE reviewed_at END,
       updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [amount, description, proof_url, status, reviewed_by, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /self-service/it-declarations/summary ─────────────── */
router.get('/it-declarations/summary', async (req, res) => {
  const { employee_id } = req.query;
  if (!employee_id) return res.status(400).json({ message: 'employee_id is required' });
  const fy = getCurrentFY();
  try {
    const { rows } = await pool.query(
      `SELECT declaration_type, SUM(amount) AS total_declared
       FROM it_declarations WHERE employee_id=$1 AND financial_year=$2 AND status!='rejected'
       GROUP BY declaration_type`,
      [employee_id, fy]
    );
    const byType = {};
    for (const r of rows) byType[r.declaration_type] = parseFloat(r.total_declared);
    const total80C = byType['80C'] || 0;
    const total80D = byType['80D'] || 0;
    const limit80C = 150000;
    const tax_saving_estimate = Math.min(total80C, limit80C) * 0.3 + total80D * 0.3;
    const now = new Date(); const m = now.getMonth() + 1;
    const monthsRemaining = m >= 4 ? 16 - m : m <= 3 ? 3 - m + 1 : 1;
    res.json({ by_type: byType, total_80c_declared: total80C, limit_80c: limit80C, remaining_80c: Math.max(0, limit80C - total80C), tax_saving_estimate: Math.round(tax_saving_estimate), months_remaining_in_fy: monthsRemaining });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /self-service/documents ───────────────────────────── */
/* Supports two modes:
 *   1. Per-employee: ?employee_id=123  (self-service / profile)
 *   2. Cross-employee (HR audit): no employee_id, or employee_id=all
 *      Returns all docs joined with employee name/dept for HR overview.
 *      Optional filters: ?doc_type=PAN+Card  ?status=pending
 */
router.get('/documents', async (req, res) => {
  let { employee_id } = req.query;
  const { doc_type, status } = req.query;
  // Non-HR callers only ever see their own documents — ignore whatever
  // employee_id they sent (including 'all').
  if (!isHRUser(req)) {
    if (!req.user?.employee_id) return res.json([]);
    employee_id = String(req.user.employee_id);
  }
  const isHRMode = !employee_id || employee_id === 'all';
  try {
    const params = [];
    let i = 1;

    let q = `
      SELECT
        d.*,
        emp.first_name || ' ' || emp.last_name AS employee_name,
        emp.office_id AS employee_code,
        emp.department AS employee_department,
        hr.first_name || ' ' || hr.last_name  AS verified_by_name
      FROM employee_documents d
      LEFT JOIN employees emp ON emp.id = d.employee_id
      LEFT JOIN employees hr  ON hr.id  = d.verified_by
      WHERE 1=1
    `;

    if (!isHRMode) {
      q += ` AND d.employee_id = $${i++}`;
      params.push(parseInt(employee_id, 10));
    }
    if (doc_type) {
      q += ` AND d.document_type = $${i++}`;
      params.push(doc_type);
    }
    if (status) {
      q += ` AND COALESCE(d.status, CASE WHEN d.verified THEN 'verified' ELSE 'pending' END) = $${i++}`;
      params.push(status);
    }

    q += ` ORDER BY d.uploaded_at DESC`;
    if (isHRMode) q += ` LIMIT 1000`;

    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /self-service/documents ──────────────────────────── */
router.post('/documents', upload.single('file'), async (req, res) => {
  let { employee_id } = req.body;
  const { document_type, document_name, drive_url, expiry_date, notes, company_id } = req.body;
  let { file_url, file_size } = req.body;
  // Non-HR callers may only upload documents against their own employee record
  if (!isHRUser(req)) {
    if (!req.user?.employee_id) return res.status(403).json({ message: 'Your login is not linked to an employee record' });
    employee_id = req.user.employee_id;
  }
  if (!employee_id || !document_type || !document_name) return res.status(400).json({ message: 'employee_id, document_type, document_name required' });
  const uploadedBy = req.user?.userId ?? req.user?.id ?? null;
  // If a file was attached, upload it via StorageService; fall back to req.body.file_url on error
  if (req.file) {
    try {
      file_url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      file_size = req.file.size;
    } catch (uploadErr) {
      console.error('[selfservice/documents] StorageService upload failed (non-fatal):', uploadErr.message);
      // fall through — use whatever file_url was sent in body
    }
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO employee_documents
         (employee_id, document_type, document_name, file_url, file_size, drive_url, expiry_date, notes, company_id, uploaded_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING *`,
      [employee_id, document_type, document_name, file_url || null, file_size || null, drive_url || null, expiry_date || null, notes || null, company_id || null, uploadedBy]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PATCH /self-service/documents/:id ─────────────────────── */
/* HR can verify, reject, or update notes/drive_url/expiry. */
router.patch('/documents/:id', async (req, res) => {
  if (!isHRUser(req)) return res.status(403).json({ message: 'Only HR can verify or update document records' });
  const { status, notes, drive_url, expiry_date } = req.body;
  const reviewerId = req.user?.userId ?? req.user?.id ?? null;
  try {
    const { rows } = await pool.query(
      `UPDATE employee_documents SET
        status      = COALESCE($1, status),
        notes       = COALESCE($2, notes),
        drive_url   = COALESCE($3, drive_url),
        expiry_date = COALESCE($4, expiry_date),
        verified    = CASE WHEN $1 = 'verified' THEN true ELSE verified END,
        verified_by = CASE WHEN $1 IN ('verified','rejected') THEN $5 ELSE verified_by END,
        verified_at = CASE WHEN $1 IN ('verified','rejected') THEN NOW() ELSE verified_at END
       WHERE id = $6 RETURNING *`,
      [status || null, notes || null, drive_url || null, expiry_date || null, reviewerId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Document not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── DELETE /self-service/documents/:id ────────────────────── */
router.delete('/documents/:id', async (req, res) => {
  try {
    // Non-HR callers may only delete their own (unverified) documents
    const params = [req.params.id];
    let ownershipClause = '';
    if (!isHRUser(req)) {
      if (!req.user?.employee_id) return res.status(403).json({ message: 'Your login is not linked to an employee record' });
      ownershipClause = ' AND employee_id = $2';
      params.push(req.user.employee_id);
    }
    const { rowCount } = await pool.query(
      `DELETE FROM employee_documents WHERE id=$1 AND COALESCE(status,'pending') != 'verified'${ownershipClause}`,
      params
    );
    if (!rowCount) return res.status(400).json({ message: 'Cannot delete verified document or not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /employees/:id/profile ─────────────────────────────── */
router.put('/employees/:id/profile', async (req, res) => {
  const callerId = req.user?.employee_id ?? req.user?.userId ?? req.user?.id;
  const targetId = parseInt(req.params.id, 10);
  if (callerId && parseInt(callerId, 10) !== targetId && !HR_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ message: 'Forbidden: you can only update your own profile' });
  }
  const { address, emergency_contact, blood_group, bank_account, ifsc_code, bank_name } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE employees SET
         current_address=COALESCE($1,current_address),
         emergency_name=COALESCE($2,emergency_name),
         blood_group=COALESCE($3,blood_group),
         account_number=COALESCE($4,account_number),
         ifsc_code=COALESCE($5,ifsc_code),
         bank_name=COALESCE($6,bank_name)
       WHERE id=$7 RETURNING id, name, company_email, phone, department, designation,
         current_address AS address, emergency_name AS emergency_contact, blood_group,
         CONCAT('XXXX',RIGHT(COALESCE(account_number,'0000'),4)) AS masked_bank,
         ifsc_code, bank_name`,
      [address, emergency_contact, blood_group, bank_account, ifsc_code, bank_name, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Employee not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /self-service/reimbursements ──────────────────────── */
router.get('/reimbursements', async (req, res) => {
  const { employee_id, status } = req.query;
  try {
    let q = `SELECT r.*, e.name AS approved_by_name FROM reimbursement_claims r
             LEFT JOIN employees e ON e.id=r.approved_by WHERE 1=1`;
    const params = [];
    if (employee_id) { params.push(employee_id); q += ` AND r.employee_id=$${params.length}`; }
    if (status)      { params.push(status);       q += ` AND r.status=$${params.length}`; }
    q += ' ORDER BY r.created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /self-service/reimbursements ──────────────────────── */
router.post('/reimbursements', async (req, res) => {
  const { employee_id, claim_type, amount, description, receipt_url, claim_date } = req.body;
  if (!employee_id || !claim_type || !amount) return res.status(400).json({ message: 'employee_id, claim_type, amount required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO reimbursement_claims (employee_id, claim_type, amount, description, receipt_url, claim_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,'submitted') RETURNING *`,
      [employee_id, claim_type, amount, description, receipt_url, claim_date || new Date().toISOString().split('T')[0]]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /self-service/reimbursements/:id/approve ───────────── */
router.put('/reimbursements/:id/approve', async (req, res) => {
  const { approved_amount, remarks, approved_by, status = 'approved' } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE reimbursement_claims SET status=$1, approved_amount=$2, remarks=$3,
       approved_by=$4, approved_at=NOW() WHERE id=$5 RETURNING *`,
      [status, approved_amount, remarks, approved_by, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /self-service/dashboard ────────────────────────────── */
router.get('/dashboard', async (req, res) => {
  const { employee_id } = req.query;
  if (!employee_id) return res.status(400).json({ message: 'employee_id is required' });
  const fy = getCurrentFY();
  try {
    const [declRes, docRes, rembRes, leaveRes, tdsRes, expiryRes] = await Promise.allSettled([
      pool.query(`SELECT COUNT(*) FROM it_declarations WHERE employee_id=$1 AND financial_year=$2 AND status='submitted'`, [employee_id, fy]),
      pool.query(`SELECT COUNT(*) FROM employee_documents WHERE employee_id=$1`, [employee_id]),
      pool.query(`SELECT COUNT(*) FROM reimbursement_claims WHERE employee_id=$1 AND status IN ('submitted','draft')`, [employee_id]),
      pool.query(`SELECT COALESCE(SUM(allocated_days - COALESCE(used_days,0)),0) AS leave_balance FROM leave_balances WHERE employee_id=$1`, [employee_id]),
      pool.query(`SELECT COALESCE(SUM(ps.tds_deduction),0) AS ytd_tds FROM payslips ps JOIN payroll_runs pr ON ps.payroll_run_id=pr.id WHERE ps.employee_id=$1 AND EXTRACT(YEAR FROM pr.period_start)=EXTRACT(YEAR FROM CURRENT_DATE)`, [employee_id]),
      pool.query(`SELECT COUNT(*) FROM employee_documents WHERE employee_id=$1 AND expiry_date IS NOT NULL AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`, [employee_id]),
    ]);
    res.json({
      pending_it_declarations:  parseInt(declRes.value?.rows[0]?.count || 0),
      document_count:           parseInt(docRes.value?.rows[0]?.count || 0),
      pending_reimbursements:   parseInt(rembRes.value?.rows[0]?.count || 0),
      leave_balance:            parseFloat(leaveRes.value?.rows[0]?.leave_balance || 0),
      ytd_tax_deducted:         parseFloat(tdsRes.value?.rows[0]?.ytd_tds || 0),
      expiring_docs:            parseInt(expiryRes.value?.rows[0]?.count || 0),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
