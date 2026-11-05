// backend/src/modules/hr/selfservice.routes.js
import express from 'express';
import multer from 'multer';
import pool from '../../config/db.js';
import { uploadFile } from '../../services/StorageService.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { companyOf } from '../../shared/scope.js';
import { ownEmployeeId } from '../payroll/payrollAccess.js';
import { can } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

function getCurrentFY() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

const isId = (v) => /^\d+$/.test(String(v ?? ''));
const NOT_LINKED = 'No employee record is linked to this account';

/* ─── Whose record may this request touch? (§202) ───────────────────
 * One rule for every route in this file, decided by explicit matrix grants —
 * never by holding a payroll-, finance- or HR-flavoured role:
 *
 *   own record        the signed-in account's employee (token, else
 *                     users.employee_id — never ?employee_id= or a body field),
 *                     AND self_service:<view|add|edit>. A login with no linked
 *                     employee (a Super Admin, a service account) has no own
 *                     record and is refused.
 *   someone else's    <module>:<action> (it_declarations, employee_documents),
 *                     AND the employee must be in the caller's company — 404
 *                     otherwise, the same answer as an id that does not exist.
 *
 * This replaces resolveReadableEmployee()/PAYROLL_READ_ROLES here, which let
 * manager and finance_manager read any colleague's IT declarations, and the
 * self-service portal reachable by roles that do not hold the HR menu. */
const SELF_ACTION = { view: 'view', add: 'add', edit: 'edit', approve: 'edit', delete: 'edit' };

async function resolveEmployeeFor(req, requestedId, module, action) {
  const requested = requestedId == null || requestedId === '' ? null : String(requestedId);
  if (requested != null && !isId(requested)) return { status: 400, message: 'Invalid employee id' };
  const own = await ownEmployeeId(req);
  if (requested == null || (own != null && requested === String(own))) {
    if (own == null) return { status: 403, message: NOT_LINKED };
    if (!(await can(req, 'self_service', SELF_ACTION[action] || 'view'))) {
      return { status: 403, message: 'Self-service is not available for your role' };
    }
    return { employeeId: Number(own), self: true };
  }
  if (!module || !(await can(req, module, action))) return { status: 403, message: 'You may only view your own records' };
  const cid = companyOf(req);
  if (cid == null) return { status: 400, message: 'Company context required' };
  const { rows } = await pool.query('SELECT 1 FROM employees WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL', [Number(requested), cid]);
  if (!rows.length) return { status: 404, message: 'Employee not found' };
  return { employeeId: Number(requested), self: false };
}

/* ─── IT declarations ─────────────────────────────────────────────
 * Declarations feed TDS (payroll reads 'submitted' and 'approved' ones).
 * Own declarations: self_service. A colleague's: it_declarations:view to read,
 * :add to file on their behalf, :approve to review — never one's own. PUT /:id
 * used to have no ownership check and to take status / reviewed_by from the
 * body, so an employee could approve their own declaration
 * (PAYROLL_DATA_FLOW_AUDIT.md Part 12). */
const DECL_REVIEW_STATUSES = ['submitted', 'approved', 'rejected'];

/* ─── GET /self-service/it-declarations ──────────────────────── */
router.get('/it-declarations', async (req, res) => {
  const fy = req.query.financial_year || getCurrentFY();
  try {
    const who = await resolveEmployeeFor(req, req.query.employee_id, 'it_declarations', 'view');
    if (who.status) return res.status(who.status).json({ message: who.message });
    const { rows } = await pool.query(
      `SELECT * FROM it_declarations WHERE employee_id=$1 AND financial_year=$2 ORDER BY declaration_type`,
      [who.employeeId, fy]
    );
    res.json(rows);
  } catch { res.status(500).json({ message: 'Could not load declarations' }); }
});

/* ─── POST /self-service/it-declarations ─────────────────────── */
router.post('/it-declarations', async (req, res) => {
  const { declaration_type, amount, description, proof_url, financial_year } = req.body || {};
  if (!declaration_type || !(parseFloat(amount) > 0)) return res.status(400).json({ message: 'declaration_type and an amount > 0 are required' });
  const fy = financial_year || getCurrentFY();
  try {
    // Own record by default; it_declarations:add files for a colleague of the company.
    const who = await resolveEmployeeFor(req, req.body?.employee_id, 'it_declarations', 'add');
    if (who.status) return res.status(who.status).json({ message: who.message });
    // The same declaration filed twice (same section, amount and description in
    // the same year, not rejected) is refused — the review screen and TDS read
    // these rows, so a double submit would count the deduction twice.
    const { rows: dup } = await pool.query(
      `SELECT id, status FROM it_declarations
        WHERE employee_id = $1 AND financial_year = $2 AND declaration_type = $3 AND amount = $4
          AND LOWER(BTRIM(COALESCE(description, ''))) = LOWER(BTRIM(COALESCE($5, '')))
          AND COALESCE(status, '') <> 'rejected' LIMIT 1`,
      [who.employeeId, fy, declaration_type, amount, description ?? null]);
    if (dup.length) return res.status(409).json({ code: 'DUPLICATE_DECLARATION', message: `This declaration is already on file (#${dup[0].id}, ${dup[0].status}).` });
    // status is never taken from the client: a new declaration is 'submitted'.
    const { rows } = await pool.query(
      `INSERT INTO it_declarations (employee_id, financial_year, declaration_type, amount, description, proof_url)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [who.employeeId, fy, declaration_type, amount, description ?? null, proof_url ?? null]
    );
    res.status(201).json(rows[0]);
  } catch { res.status(500).json({ message: 'Could not save the declaration' }); }
});

/* ─── PUT /self-service/it-declarations/:id ─────────────────── */
//   owner        amount / description / proof_url, while still 'submitted'
//   it_declarations:approve  the same fields and the review status (submitted|approved|
//                rejected) for employees of their company — not on their own
//                declaration. reviewed_by = the reviewer's users.id, set here.
//                A rejection needs `remarks`; every review writes an
//                it_declaration audit entry (old → new status, remarks) that
//                GET /it-declarations/:id/history reads back.
// Anything the caller may not touch is 404, the same as a missing id.
router.put('/it-declarations/:id', captureBefore('it_declarations'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid declaration id' });
  const { amount, description, proof_url, status, remarks } = req.body || {};
  try {
    const { rows: [decl] } = await pool.query(
      `SELECT d.id, d.employee_id, d.status, d.amount, e.company_id
         FROM it_declarations d JOIN employees e ON e.id = d.employee_id
        WHERE d.id = $1`, [Number(req.params.id)]);
    const own = await ownEmployeeId(req);
    const isOwner = decl && own != null && String(decl.employee_id) === String(own) && await can(req, 'self_service', 'edit');
    const cid = companyOf(req);
    const isReviewer = decl && cid != null && decl.company_id === cid && await can(req, 'it_declarations', 'approve');
    if (!decl || (!isOwner && !isReviewer)) return res.status(404).json({ message: 'Not found' });

    if (status !== undefined && status !== null) {
      if (!isReviewer || isOwner) return res.status(403).json({ message: 'Declarations are reviewed by holders of the IT declaration review permission, and never on their own declaration' });
      if (!DECL_REVIEW_STATUSES.includes(status)) return res.status(400).json({ message: `status must be one of: ${DECL_REVIEW_STATUSES.join(', ')}` });
      if (status === 'rejected' && !String(remarks || '').trim()) return res.status(400).json({ message: 'A reason is required to reject a declaration' });
      if (status === decl.status) return res.status(409).json({ message: `This declaration is already ${decl.status}` });
    }
    if (!isReviewer && decl.status !== 'submitted') {
      return res.status(409).json({ message: `This declaration is ${decl.status} and can no longer be edited` });
    }
    if (amount !== undefined && amount !== null && !(parseFloat(amount) > 0)) return res.status(400).json({ message: 'amount must be greater than 0' });

    const reviewing = status !== undefined && status !== null;
    const { rows } = await pool.query(
      `UPDATE it_declarations SET amount=COALESCE($1,amount), description=COALESCE($2,description),
       proof_url=COALESCE($3,proof_url), status=COALESCE($4,status),
       reviewed_by=CASE WHEN $5::boolean THEN $6::int ELSE reviewed_by END,
       reviewed_at=CASE WHEN $5::boolean THEN NOW() ELSE reviewed_at END,
       updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [amount ?? null, description ?? null, proof_url ?? null, reviewing ? status : null,
       reviewing, req.user?.userId ?? req.user?.id ?? null, decl.id]
    );
    logAudit({
      userId: req.user?.userId ?? req.user?.id ?? null, module: 'it_declarations', recordId: decl.id,
      recordType: 'it_declaration', action: reviewing ? (status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'reopen') : 'update',
      oldData: { status: decl.status, amount: decl.amount },
      newData: { status: rows[0].status, amount: rows[0].amount, remarks: remarks ?? null, reviewed_by: rows[0].reviewed_by },
      req, company_id: decl.company_id,
    });
    res.json(rows[0]);
  } catch { res.status(500).json({ message: 'Could not update the declaration' }); }
});

/* ─── GET /self-service/it-declarations/review ──────────────── */
// The reviewer queue (HR → IT Declaration Review): every declaration of the
// caller's company for a financial year, it_declarations:view only. Same rows
// as each employee's own list — this reads them, it never copies them.
//   ?financial_year=2026-2027  ?status=submitted|approved|rejected|all (default submitted)
// Each row says whether the caller may act on it (it_declarations:approve and
// not their own) and carries the latest review remark from the audit history.
router.get('/it-declarations/review', async (req, res) => {
  const cid = companyOf(req);
  if (cid == null) return res.status(400).json({ message: 'Company context required' });
  if (!(await can(req, 'it_declarations', 'view'))) return res.status(403).json({ message: 'Reviewing IT declarations needs the IT declaration permission' });
  const fy = String(req.query.financial_year || getCurrentFY());
  if (!/^\d{4}-\d{4}$/.test(fy)) return res.status(400).json({ message: 'financial_year must look like 2026-2027' });
  const status = String(req.query.status || 'submitted');
  if (status !== 'all' && !DECL_REVIEW_STATUSES.includes(status)) return res.status(400).json({ message: 'status must be submitted, approved, rejected or all' });
  try {
    const own = await ownEmployeeId(req);
    const canApprove = await can(req, 'it_declarations', 'approve');
    const { rows } = await pool.query(
      `SELECT d.id, d.employee_id, d.financial_year, d.declaration_type, d.amount, d.description, d.proof_url,
              d.status, d.reviewed_at, d.created_at,
              COALESCE(NULLIF(TRIM(CONCAT(e.first_name, ' ', e.last_name)), ''), e.name) AS employee_name,
              e.office_id AS employee_code, e.department,
              COALESCE(NULLIF(TRIM(CONCAT(re.first_name, ' ', re.last_name)), ''), ru.name, ru.email) AS reviewed_by_name,
              (SELECT a.new_data_json->>'remarks' FROM audit_logs a
                WHERE a.reference_type = 'it_declaration' AND a.reference_id = d.id::text
                ORDER BY a.id DESC LIMIT 1) AS last_remarks
         FROM it_declarations d
         JOIN employees e ON e.id = d.employee_id
         LEFT JOIN users ru ON ru.id = d.reviewed_by
         LEFT JOIN employees re ON re.id = ru.employee_id
        WHERE e.company_id = $1 AND e.deleted_at IS NULL AND d.financial_year = $2
          AND ($3::text = 'all' OR d.status = $3)
        ORDER BY d.created_at ASC, d.id ASC`,
      [cid, fy, status]);
    res.json(rows.map(r => ({ ...r, can_review: canApprove && !(own != null && String(r.employee_id) === String(own)) })));
  } catch { res.status(500).json({ message: 'Could not load declarations for review' }); }
});

/* ─── GET /self-service/it-declarations/:id/history ─────────── */
// Who did what to one declaration, from the audit log: the owner, or
// it_declarations:view in the declaration's company.
router.get('/it-declarations/:id/history', async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid declaration id' });
  try {
    const { rows: [decl] } = await pool.query(
      `SELECT d.id, d.employee_id, d.created_at, e.company_id FROM it_declarations d JOIN employees e ON e.id = d.employee_id WHERE d.id = $1`,
      [Number(req.params.id)]);
    const own = await ownEmployeeId(req);
    const isOwner = decl && own != null && String(decl.employee_id) === String(own);
    const cid = companyOf(req);
    const isViewer = decl && cid != null && decl.company_id === cid && await can(req, 'it_declarations', 'view');
    if (!decl || (!isOwner && !isViewer)) return res.status(404).json({ message: 'Not found' });
    const { rows } = await pool.query(
      `SELECT a.id, a.action_type AS action, a.created_at AS at,
              a.old_data_json->>'status' AS from_status, a.new_data_json->>'status' AS to_status,
              a.new_data_json->>'remarks' AS remarks,
              COALESCE(NULLIF(TRIM(CONCAT(e.first_name, ' ', e.last_name)), ''), u.name, u.email) AS by_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
        WHERE a.reference_type = 'it_declaration' AND a.reference_id = $1
        ORDER BY a.id ASC`, [String(decl.id)]);
    res.json({ declaration_id: decl.id, filed_at: decl.created_at, events: rows });
  } catch { res.status(500).json({ message: 'Could not load the history' }); }
});

/* ─── GET /self-service/it-declarations/summary ─────────────── */
router.get('/it-declarations/summary', async (req, res) => {
  const fy = getCurrentFY();
  try {
    const who = await resolveEmployeeFor(req, req.query.employee_id, 'it_declarations', 'view');
    if (who.status) return res.status(who.status).json({ message: who.message });
    const employee_id = who.employeeId;
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
  // Without employee_documents:view a caller only ever sees their own
  // documents (and only with self_service:view) — whatever employee_id they
  // sent, 'all' included, is ignored. The caller's own employee comes from
  // the account (token, else users.employee_id).
  const hrView = await can(req, 'employee_documents', 'view');
  if (!hrView) {
    const own = await ownEmployeeId(req);
    if (own == null || !(await can(req, 'self_service', 'view'))) return res.json([]);
    employee_id = String(own);
  }
  const isHRMode = !employee_id || employee_id === 'all';
  if (!isHRMode && !/^\d+$/.test(String(employee_id))) return res.status(400).json({ message: 'Invalid employee id' });
  try {
    // HR naming one employee: that employee must be in the caller's company —
    // 404 otherwise, the same answer as an id that does not exist.
    if (!isHRMode && hrView && companyOf(req) != null) {
      const { rows: inCo } = await pool.query('SELECT 1 FROM employees WHERE id = $1 AND company_id = $2', [Number(employee_id), companyOf(req)]);
      if (!inCo.length) return res.status(404).json({ message: 'Employee not found' });
    }
    const params = [];
    let i = 1;

    // Tenant predicate on the EMPLOYEE the document hangs off, not on
    // d.company_id: that column is nullable and was historically written from
    // the request body, so filtering on it alone would both leak rows that
    // carry a NULL and trust a value the client supplied. The employee row is
    // the record's own truth. A null companyId is a global super-admin scope.
    const companyId = companyOf(req);
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
      WHERE ($${i}::int IS NULL OR emp.company_id = $${i}::int)
    `;
    params.push(companyId); i++;

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
  // `company_id` is deliberately NOT read from the body any more. It used to be,
  // which meant the tenant a personnel document was filed under was whatever the
  // client said — and when the client said nothing (as the profile page does)
  // the row was stored with a NULL company. It is derived from the employee
  // below instead, which is the only place that answer actually lives.
  const { document_type, document_name, drive_url, expiry_date, notes } = req.body;
  let { file_url, file_size } = req.body;
  // Without employee_documents:add a caller may only upload against their own
  // employee record, and only with self_service:add.
  if (!(await can(req, 'employee_documents', 'add'))) {
    const own = await ownEmployeeId(req);
    if (own == null) return res.status(403).json({ message: 'Your login is not linked to an employee record' });
    if (!(await can(req, 'self_service', 'add'))) return res.status(403).json({ message: 'Self-service is not available for your role' });
    employee_id = own;
  }
  if (!employee_id || !document_type || !document_name) return res.status(400).json({ message: 'employee_id, document_type, document_name required' });
  if (!/^\d+$/.test(String(employee_id))) return res.status(400).json({ message: 'Invalid employee id' });

  // Confirm the target employee is inside the caller's tenant BEFORE the file is
  // written to storage — otherwise a refused insert still leaves the bytes on
  // disk. Doubles as the source of the row's company_id.
  const callerCompany = companyOf(req);
  let targetCompany = null;
  try {
    const { rows } = await pool.query(
      `SELECT company_id FROM employees WHERE id = $1 AND deleted_at IS NULL`,
      [parseInt(employee_id, 10)]
    );
    if (!rows.length) return res.status(404).json({ message: 'Employee not found' });
    targetCompany = rows[0].company_id;
    if (callerCompany != null && targetCompany !== callerCompany) {
      return res.status(404).json({ message: 'Employee not found' });
    }
  } catch { return res.status(500).json({ message: 'Could not verify employee' }); }

  const uploadedBy = req.user?.userId ?? req.user?.id ?? null;
  // If a file was attached, upload it via StorageService; fall back to req.body.file_url on error
  if (req.file) {
    try {
      file_url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      file_size = req.file.size;
    } catch (uploadErr) {
      console.error('[selfservice/documents] StorageService upload failed:', uploadErr.message);
      // Previously this fell through and inserted the row anyway, leaving a
      // document record with no document behind it: it lists in the employee's
      // Documents tab, reads as uploaded, and opens nothing. A failed upload is
      // a failed upload — say so and write nothing.
      return res.status(502).json({ message: 'The file could not be stored. Nothing was saved — please try again.' });
    }
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO employee_documents
         (employee_id, document_type, document_name, file_url, file_size, drive_url, expiry_date, notes, company_id, uploaded_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING *`,
      [employee_id, document_type, document_name, file_url || null, file_size || null, drive_url || null, expiry_date || null, notes || null, targetCompany, uploadedBy]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PATCH /self-service/documents/:id ─────────────────────── */
/* employee_documents:edit verifies, rejects, or updates notes/drive_url/expiry —
 * within the caller's company, and never on the caller's own document. */
router.patch('/documents/:id', captureBefore('employee_documents'), async (req, res) => {
  if (!(await can(req, 'employee_documents', 'edit'))) return res.status(403).json({ message: 'Verifying documents needs the HR document permission' });
  if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ message: 'Invalid document id' });
  const { status, notes, drive_url, expiry_date } = req.body || {};
  if (status != null && !['pending', 'verified', 'rejected'].includes(status)) {
    return res.status(400).json({ message: 'status must be one of: pending, verified, rejected' });
  }
  try {
    // verified_by is an employees.id — the list joins it to employees for the
    // reviewer's name. It used to be written with users.id, which named
    // whichever employee happened to share that number.
    const reviewerId = await ownEmployeeId(req);
    const { rows: [doc] } = await pool.query('SELECT employee_id FROM employee_documents WHERE id = $1', [Number(req.params.id)]);
    if (doc && reviewerId != null && String(doc.employee_id) === String(reviewerId)) {
      return res.status(403).json({ message: 'You cannot verify or reject your own document' });
    }
    const { rows } = await pool.query(
      `UPDATE employee_documents SET
        status      = COALESCE($1, status),
        notes       = COALESCE($2, notes),
        drive_url   = COALESCE($3, drive_url),
        expiry_date = COALESCE($4, expiry_date),
        verified    = CASE WHEN $1 = 'verified' THEN true ELSE verified END,
        verified_by = CASE WHEN $1 IN ('verified','rejected') THEN $5 ELSE verified_by END,
        verified_at = CASE WHEN $1 IN ('verified','rejected') THEN NOW() ELSE verified_at END
       WHERE id = $6
         AND ($7::int IS NULL OR employee_id IN (
               SELECT id FROM employees WHERE company_id = $7::int AND deleted_at IS NULL))
       RETURNING *`,
      [status || null, notes || null, drive_url || null, expiry_date || null, reviewerId, req.params.id, companyOf(req)]
    );
    if (!rows.length) return res.status(404).json({ message: 'Document not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── DELETE /self-service/documents/:id ────────────────────── */
router.delete('/documents/:id', captureBefore('employee_documents'), async (req, res) => {
  try {
    // Non-HR callers may only delete their own (unverified) documents
    // $2 is always the caller's company, so the tenant predicate is part of
    // every delete rather than something the HR branch could skip. Ownership
    // narrows it further for a caller without employee_documents:delete.
    if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ message: 'Invalid document id' });
    const params = [req.params.id, companyOf(req)];
    let ownershipClause = '';
    if (!(await can(req, 'employee_documents', 'delete'))) {
      const own = await ownEmployeeId(req);
      if (own == null) return res.status(403).json({ message: 'Your login is not linked to an employee record' });
      ownershipClause = ' AND employee_id = $3';
      params.push(own);
    }
    const { rowCount } = await pool.query(
      `DELETE FROM employee_documents
        WHERE id = $1
          AND COALESCE(status,'pending') != 'verified'
          AND ($2::int IS NULL OR employee_id IN (
                SELECT id FROM employees WHERE company_id = $2::int AND deleted_at IS NULL))
          ${ownershipClause}`,
      params
    );
    if (!rowCount) return res.status(400).json({ message: 'Cannot delete verified document or not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /employees/:id/profile ─────────────────────────────── */
// Self-service only: the caller's OWN record (token, else users.employee_id),
// with self_service:edit, and only three personal fields: address, emergency
// contact and blood group. Salary, designation, department and status are not
// columns this statement can reach, whatever the body carries.
//
// Bank details are NOT self-service (management decision, §202): only an HR
// user holding employee_bank:edit changes them, through Edit Employee
// (PUT /employees/:id), which notifies Accounts. A body carrying a bank field
// is refused outright rather than silently dropped, so the page cannot appear
// to have saved a change it did not make.
//
// A blank or absent field means "leave it alone": the form used to post '' for
// every field the employee did not touch, and COALESCE('', col) kept the '', so
// saving a blood group wiped the bank account, address and emergency contact.
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
const BANK_FIELDS = ['bank_account', 'account_number', 'ifsc_code', 'bank_name', 'branch_name'];
const given = (v) => (v == null ? null : (String(v).trim() || null));

router.put('/employees/:id/profile', captureBefore('employees'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid employee id' });
  const own = await ownEmployeeId(req);
  if (own == null) return res.status(403).json({ message: NOT_LINKED });
  if (String(own) !== String(Number(req.params.id))) {
    return res.status(403).json({ message: 'You can only update your own profile' });
  }
  if (!(await can(req, 'self_service', 'edit'))) return res.status(403).json({ message: 'Self-service is not available for your role' });
  const body = req.body || {};
  if (BANK_FIELDS.some(k => given(body[k]) != null)) {
    return res.status(403).json({ code: 'BANK_DETAILS_HR_ONLY', message: 'Bank details are maintained by HR. Ask HR to update them.' });
  }
  const address = given(body.address);
  const emergency = given(body.emergency_contact);
  const blood = given(body.blood_group);
  if (blood && !BLOOD_GROUPS.includes(blood)) return res.status(400).json({ message: 'Invalid blood group' });
  if (emergency && emergency.length > 150) return res.status(400).json({ message: 'Emergency contact is too long' });
  if (address && address.length > 1000) return res.status(400).json({ message: 'Address is too long' });
  try {
    const { rows } = await pool.query(
      `UPDATE employees SET
         current_address=COALESCE($1,current_address),
         emergency_name=COALESCE($2,emergency_name),
         blood_group=COALESCE($3,blood_group)
       WHERE id=$4 AND deleted_at IS NULL AND ($5::int IS NULL OR company_id = $5)
       RETURNING id, current_address AS address, emergency_name AS emergency_contact, blood_group,
         CASE WHEN account_number IS NULL OR account_number = '' THEN NULL
              ELSE CONCAT('XXXX', RIGHT(account_number, 4)) END AS masked_bank,
         ifsc_code, bank_name`,
      [address, emergency, blood, Number(own), companyOf(req)]
    );
    if (!rows.length) return res.status(404).json({ message: 'Employee not found' });
    res.json(rows[0]);
  } catch { res.status(500).json({ message: 'Could not update the profile' }); }
});

/* ─── Reimbursements → the one claim workflow (§202) ──────────────
 * `reimbursement_claims` was a second, independent claims system: no reviewer
 * screen, no payment path, nothing in payroll or finance read it. The
 * authoritative claim record is `expense_claims`, owned by the Travel →
 * Expense Claims workflow (travel-reimbursement.routes.js, /reimbursement/…):
 * submission, manager / accounts / management approval, payment, advance
 * adjustment and project costing all live there, and the Approval Center acts
 * through it. The Self-Service Reimbursements tab now files and lists through
 * those endpoints, so these three answer 410 and say where to go. The legacy
 * table and its rows are left untouched (read-only history). */
const CLAIMS_MOVED = {
  code: 'CLAIMS_MOVED',
  message: 'Reimbursement claims are filed and tracked through Expense Claims.',
  endpoint: '/reimbursement/claims',
};
router.get('/reimbursements', (req, res) => res.status(410).json(CLAIMS_MOVED));
router.post('/reimbursements', (req, res) => res.status(410).json(CLAIMS_MOVED));
router.put('/reimbursements/:id/approve', (req, res) => res.status(410).json(CLAIMS_MOVED));

/* ─── GET /self-service/dashboard ────────────────────────────── */
// The caller's OWN dashboard only (self_service:view). ?employee_id= used to be
// trusted as-is, so any signed-in user could read any employee's YTD tax
// (PAYROLL_DATA_FLOW_AUDIT.md Part 12); no screen reads a colleague's, so no
// grant opens one (§202).
router.get('/dashboard', async (req, res) => {
  const fy = getCurrentFY();
  try {
    const who = await resolveEmployeeFor(req, req.query.employee_id, null, 'view');
    if (who.status) return res.status(who.status).json({ message: who.message });
    const employee_id = who.employeeId;
    const [declRes, docRes, rembRes, leaveRes, tdsRes, expiryRes] = await Promise.allSettled([
      pool.query(`SELECT COUNT(*) FROM it_declarations WHERE employee_id=$1 AND financial_year=$2 AND status='submitted'`, [employee_id, fy]),
      pool.query(`SELECT COUNT(*) FROM employee_documents WHERE employee_id=$1`, [employee_id]),
      // In-flight claims on the authoritative record (expense_claims), not the
      // retired reimbursement_claims table.
      pool.query(`SELECT COUNT(*) FROM expense_claims WHERE employee_id=$1 AND status IN ('Draft','Submitted','Manager Approved','Accounts Verified','Mgmt Approved')`, [employee_id]),
      pool.query(`SELECT COALESCE(SUM(allocated_days - COALESCE(used_days,0)),0) AS leave_balance FROM leave_balances WHERE employee_id=$1`, [employee_id]),
      // YTD = FINALISED payroll of the current Indian FY (Apr–Mar). It used to sum
      // the legacy `payslips` table (seed rows only) by calendar year.
      pool.query(`SELECT COALESCE(SUM(pr.tds),0) AS ytd_tds FROM payroll_runs pr
                   WHERE pr.employee_id=$1 AND pr.is_test = false AND pr.status IN ('approved','paid')
                     AND make_date(pr.year, pr.month, 1) BETWEEN make_date(split_part($2,'-',1)::int, 4, 1) AND make_date(split_part($2,'-',2)::int, 3, 1)`, [employee_id, fy]),
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
