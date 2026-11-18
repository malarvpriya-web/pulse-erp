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
import { OLD_REGIME_LIMITS, getMonthName } from '../payroll/payrollEngine.js';
import { normalizePayrollSettings, declarationStatusesFor } from '../payroll/payrollSettings.js';

// The old-regime ceiling per declared section (payrollEngine.oldRegimeDeductions).
// 80C includes the employee's own PF; HRA and LTA depend on salary (no fixed ceiling).
const SECTION_LIMITS = { '80C': OLD_REGIME_LIMITS.c80, '80CCD': OLD_REGIME_LIMITS.nps_extra, '80D': OLD_REGIME_LIMITS.d80, HOME_LOAN: OLD_REGIME_LIMITS.home_loan_interest };

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
// Owner decision 2026-11-11 (migration 20261111000001): employees no longer
// change their own records — self_service:add/edit are off for every role.
// Finance files IT declarations (it_declarations:add); HR files documents and
// profile changes (employee_documents / employees grants).
const SELF_WRITES_OFF = 'Changes to your record are made by HR (documents, profile) or Finance (IT declarations). Please contact them.';

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
      return { status: 403, message: action === 'view' ? 'Self-service is not available for your role' : SELF_WRITES_OFF };
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
 * Declarations feed TDS (payroll reads 'submitted' and 'approved' ones, old
 * regime only). Own declarations: self_service. A colleague's:
 * it_declarations:view to read, :add to file on their behalf, :approve to
 * review — never one's own. PUT /:id used to have no ownership check and to
 * take status / reviewed_by from the body, so an employee could approve their
 * own declaration (PAYROLL_DATA_FLOW_AUDIT.md Part 12).
 *
 * §263: amount   = the figure payroll uses; claimed_amount = what the employee
 *                  declared. A reviewer may approve less than claimed (with a
 *                  reason), never more; reopening restores the claim.
 *       A reviewer never edits a declaration without a decision — an approved
 *       amount used to be changeable silently.
 *       Filing is for the current or the next financial year only, and the
 *       year, amount, description and proof link are checked. */
const DECL_REVIEW_STATUSES = ['submitted', 'approved', 'rejected'];

// 80CCD = the employee's own NPS contribution; HOME_LOAN = interest on a loan for a self-occupied house.
const DECLARATION_TYPES = ['80C', '80CCD', '80D', 'HOME_LOAN', 'HRA', 'LTA', 'other'];
const MAX_DECL_AMOUNT = 99999999;     // ₹9,99,99,999 — numeric(12,2) overflowed into a 500
const MAX_DESCRIPTION = 500;
const MAX_PROOF_URL = 2000;

const fyStartOf = (fy) => {
  const m = /^(\d{4})-(\d{4})$/.exec(String(fy ?? ''));
  return m && Number(m[2]) === Number(m[1]) + 1 ? Number(m[1]) : null;
};
/** The years a declaration may be filed for: the current one and the next. */
const fileableYears = () => {
  const s = fyStartOf(getCurrentFY());
  return [`${s}-${s + 1}`, `${s + 1}-${s + 2}`];
};

/**
 * Checks the employee-editable fields. `partial` = a PUT, where a missing
 * field means "unchanged". Returns { error } or { values }.
 */
function checkDeclarationFields(body, { partial = false, type } = {}) {
  const v = {};
  if (!partial || body.amount !== undefined && body.amount !== null) {
    const a = Number(body.amount);
    if (!(Number.isFinite(a) && a > 0)) return { error: 'amount must be greater than 0' };
    if (a > MAX_DECL_AMOUNT) return { error: `amount cannot exceed ₹${MAX_DECL_AMOUNT.toLocaleString('en-IN')}` };
    v.amount = Math.round(a * 100) / 100;
  }
  if (body.description !== undefined && body.description !== null) {
    const d = String(body.description).trim();
    if (d.length > MAX_DESCRIPTION) return { error: `description cannot be longer than ${MAX_DESCRIPTION} characters` };
    v.description = d || null;
  }
  if (body.proof_url !== undefined && body.proof_url !== null) {
    const u = String(body.proof_url).trim();
    if (u && !/^https?:\/\/\S+$/i.test(u)) return { error: 'proof link must be a web address starting with http:// or https://' };
    if (u.length > MAX_PROOF_URL) return { error: 'proof link is too long' };
    v.proof_url = u || null;
  }
  if (body.metro_city !== undefined && body.metro_city !== null) {
    if (typeof body.metro_city !== 'boolean') return { error: 'metro_city must be true or false' };
    if (body.metro_city && type !== 'HRA') return { error: 'metro_city applies to an HRA declaration only' };
    v.metro_city = body.metro_city;
  }
  // §264: HRA landlord, 80D self / parents.
  for (const k of ['landlord_name', 'landlord_pan']) {
    if (body[k] === undefined || body[k] === null) continue;
    const t = String(body[k]).trim();
    if (t && type !== 'HRA') return { error: 'Landlord details apply to an HRA declaration only' };
    if (k === 'landlord_name' && t.length > 200) return { error: 'landlord name is too long' };
    if (k === 'landlord_pan' && t && !PAN_RE.test(t.toUpperCase())) return { error: 'Landlord PAN must look like ABCDE1234F' };
    v[k] = k === 'landlord_pan' ? (t.toUpperCase() || null) : (t || null);
  }
  if (body.insured_for !== undefined && body.insured_for !== null) {
    if (type !== '80D') return { error: 'insured_for applies to an 80D declaration only' };
    if (!['self', 'parents'].includes(body.insured_for)) return { error: "insured_for must be 'self' or 'parents'" };
    v.insured_for = body.insured_for;
  }
  if (body.parents_senior !== undefined && body.parents_senior !== null) {
    if (typeof body.parents_senior !== 'boolean') return { error: 'parents_senior must be true or false' };
    v.parents_senior = body.parents_senior;
  }
  return { values: v };
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// ⚖ Form 12BB practice under the 1961 Rules: the landlord's PAN is needed when
// the year's rent is over ₹1,00,000. Confirm the Income-tax Act 2025 equivalent.
const LANDLORD_PAN_ABOVE = 100000;

/** Rules across fields, on the declaration as it will be saved. */
function crossCheckDeclaration(d) {
  if (d.declaration_type === 'HRA') {
    if (!d.landlord_name) return "Give the landlord's name for an HRA declaration";
    if (Number(d.amount) > LANDLORD_PAN_ABOVE && !d.landlord_pan) {
      return `The landlord's PAN is needed when the year's rent is over ₹${LANDLORD_PAN_ABOVE.toLocaleString('en-IN')}`;
    }
  }
  if (d.parents_senior && !(d.declaration_type === '80D' && d.insured_for === 'parents')) {
    return 'parents_senior applies to an 80D declaration for parents only';
  }
  return null;
}

/** The proof cut-off for a company (Payroll Center → Settings, §264). */
async function declarationPolicy(companyId) {
  const { rows: [r] } = await pool.query(
    `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'payroll' LIMIT 1`, [companyId ?? 0]);
  const { settings } = normalizePayrollSettings(r?.settings || {});
  const cutoff = Number(settings.declaration_proof_cutoff_month) || 0;
  const month = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', month: 'numeric' }));
  return {
    cutoff_month: cutoff,
    cutoff_label: cutoff >= 1 && cutoff <= 12 ? getMonthName(cutoff) : null,
    counts_now: declarationStatusesFor(month, cutoff),
  };
}

/** Tells the employee their declaration was decided. Best effort: never fails the review. */
async function notifyDeclarationOwner(decl, status, amount, remarks) {
  const section = decl.declaration_type;
  const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
  const title = status === 'approved' ? 'IT declaration approved'
    : status === 'rejected' ? 'IT declaration rejected' : 'IT declaration reopened';
  const message = status === 'approved'
    ? (Number(amount) < Number(decl.claimed_amount)
      ? `Your ${section} declaration for ${decl.financial_year} was approved at ${money(amount)} of the ${money(decl.claimed_amount)} you declared. Reason: ${remarks}`
      : `Your ${section} declaration of ${money(amount)} for ${decl.financial_year} was approved.`)
    : status === 'rejected'
      ? `Your ${section} declaration of ${money(decl.claimed_amount)} for ${decl.financial_year} was rejected. Reason: ${remarks}`
      : `Your ${section} declaration for ${decl.financial_year} is back for review${remarks ? `: ${remarks}` : ''}. Finance may update it.`;
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, notification_type, title, message, module_name, reference_id, link)
       SELECT u.id, 'it_declaration_review', $2, $3, 'it_declarations', $4, '/MyEmployeeRecord'
         FROM users u WHERE u.employee_id = $1`,
      [decl.employee_id, title, message, decl.id]);
  } catch { /* the decision stands; the bell is a courtesy */ }
}

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
  const body = req.body || {};
  const { declaration_type } = body;
  if (!declaration_type) return res.status(400).json({ message: 'declaration_type and an amount > 0 are required' });
  // The types payroll reads (payroll.service buildPeriodContext, §262). Anything
  // else was stored and silently never reduced tax.
  if (!DECLARATION_TYPES.includes(declaration_type)) {
    return res.status(400).json({ message: `declaration_type must be one of ${DECLARATION_TYPES.join(', ')}` });
  }
  const checked = checkDeclarationFields(body, { type: declaration_type });
  if (checked.error) return res.status(400).json({ message: checked.error });
  const { amount, description = null, proof_url = null, metro_city = false,
    landlord_name = null, landlord_pan = null, parents_senior = false } = checked.values;
  const insured_for = declaration_type === '80D' ? (checked.values.insured_for || 'self') : null;
  const cross = crossCheckDeclaration({ declaration_type, amount, landlord_name, landlord_pan, insured_for, parents_senior });
  if (cross) return res.status(400).json({ message: cross });
  const fy = body.financial_year || getCurrentFY();
  // Any text used to be stored as the year; payroll and review never read it again.
  if (!fileableYears().includes(fy)) {
    return res.status(400).json({ message: `Declarations can be filed for ${fileableYears().join(' or ')} only` });
  }
  try {
    // Own record by default; it_declarations:add files for a colleague of the company.
    const who = await resolveEmployeeFor(req, body.employee_id, 'it_declarations', 'add');
    if (who.status) return res.status(who.status).json({ message: who.message });
    // The same declaration filed twice (same section, amount and description in
    // the same year, not rejected) is refused — the review screen and TDS read
    // these rows, so a double submit would count the deduction twice.
    const { rows: dup } = await pool.query(
      `SELECT id, status FROM it_declarations
        WHERE employee_id = $1 AND financial_year = $2 AND declaration_type = $3 AND claimed_amount = $4
          AND LOWER(BTRIM(COALESCE(description, ''))) = LOWER(BTRIM(COALESCE($5, '')))
          AND COALESCE(status, '') <> 'rejected' LIMIT 1`,
      [who.employeeId, fy, declaration_type, amount, description]);
    if (dup.length) return res.status(409).json({ code: 'DUPLICATE_DECLARATION', message: `This declaration is already on file (#${dup[0].id}, ${dup[0].status}).` });
    // status is never taken from the client: a new declaration is 'submitted'.
    const { rows } = await pool.query(
      `INSERT INTO it_declarations (employee_id, financial_year, declaration_type, amount, claimed_amount, description, proof_url, metro_city,
                                    landlord_name, landlord_pan, insured_for, parents_senior)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [who.employeeId, fy, declaration_type, amount, description, proof_url, metro_city,
       landlord_name, landlord_pan, insured_for, parents_senior]
    );
    res.status(201).json(rows[0]);
  } catch { res.status(500).json({ message: 'Could not save the declaration' }); }
});

/* ─── PUT /self-service/it-declarations/:id ─────────────────── */
//   owner        amount / description / proof_url / metro_city (HRA), while
//                still 'submitted'. Changing the amount changes the claim.
//   it_declarations:approve  a review decision only — status submitted|approved|
//                rejected — for employees of their company, never on their own
//                declaration. reviewed_by = the reviewer's users.id, set here.
//                  approved   optional `amount` up to the claim; below the
//                             claim needs `remarks` (the reason)
//                  rejected   needs `remarks`
//                  submitted  (reopen) restores amount to the claim
//                Every change writes an it_declaration audit entry (old → new
//                status and amount, remarks) that GET /:id/history reads back,
//                and a decision notifies the employee.
// Anything the caller may not touch is 404, the same as a missing id.
router.put('/it-declarations/:id', captureBefore('it_declarations'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid declaration id' });
  const body = req.body || {};
  const { status } = body;
  const remarks = String(body.remarks ?? '').trim();
  try {
    const { rows: [decl] } = await pool.query(
      `SELECT d.id, d.employee_id, d.status, d.amount, d.claimed_amount, d.declaration_type, d.financial_year,
              d.landlord_name, d.landlord_pan, d.insured_for, d.parents_senior, e.company_id
         FROM it_declarations d JOIN employees e ON e.id = d.employee_id
        WHERE d.id = $1`, [Number(req.params.id)]);
    const own = await ownEmployeeId(req);
    // Whose declaration it is — decided by the record alone, never by a grant:
    // the "never review your own" rule must hold even when self_service:edit is
    // off (it is, for every role, since 2026-11-11).
    const ownDecl = !!decl && own != null && String(decl.employee_id) === String(own);
    const isOwner = ownDecl && await can(req, 'self_service', 'edit');
    const cid = companyOf(req);
    const isReviewer = decl && cid != null && decl.company_id === cid && await can(req, 'it_declarations', 'approve');
    // 2026-11-11: Finance enters declarations for employees (it_declarations:add)
    // and may correct one while it waits — but not one of its own, and not when
    // the same login also reviews (a reviewer never edits without a decision).
    const isFiler = decl && cid != null && decl.company_id === cid && !isReviewer
      && !ownDecl && await can(req, 'it_declarations', 'add');
    if (!decl || (!isOwner && !isReviewer && !isFiler)) return res.status(404).json({ message: 'Not found' });
    if (remarks.length > MAX_DESCRIPTION) return res.status(400).json({ message: `remarks cannot be longer than ${MAX_DESCRIPTION} characters` });
    const userId = req.user?.userId ?? req.user?.id ?? null;
    const claimed = Number(decl.claimed_amount ?? decl.amount);

    if (status !== undefined && status !== null) {
      /* ── a review decision ── */
      if (!isReviewer || ownDecl) return res.status(403).json({ message: 'Declarations are reviewed by holders of the IT declaration review permission, and never on their own declaration' });
      if (!DECL_REVIEW_STATUSES.includes(status)) return res.status(400).json({ message: `status must be one of: ${DECL_REVIEW_STATUSES.join(', ')}` });
      if (status === 'rejected' && !remarks) return res.status(400).json({ message: 'A reason is required to reject a declaration' });
      if (status === decl.status) return res.status(409).json({ message: `This declaration is already ${decl.status}` });
      for (const f of ['description', 'proof_url', 'metro_city', 'landlord_name', 'landlord_pan', 'insured_for', 'parents_senior']) {
        if (body[f] !== undefined) return res.status(400).json({ message: `A reviewer decides a declaration; ${f} is the employee's to change` });
      }
      let amount = Number(decl.amount);
      if (status === 'approved') {
        if (body.amount !== undefined && body.amount !== null) {
          const a = Number(body.amount);
          if (!(Number.isFinite(a) && a > 0)) return res.status(400).json({ message: 'The approved amount must be greater than 0' });
          if (a > claimed) return res.status(400).json({ message: `The approved amount cannot be more than the ₹${claimed.toLocaleString('en-IN')} declared` });
          amount = Math.round(a * 100) / 100;
        } else {
          amount = claimed;
        }
        if (amount < claimed && !remarks) return res.status(400).json({ message: 'Give a reason for approving less than was declared' });
      } else if (body.amount !== undefined && body.amount !== null) {
        return res.status(400).json({ message: 'An amount can be set only when approving' });
      } else if (status === 'submitted') {
        amount = claimed;   // reopen: back to the employee's claim
      }
      const { rows } = await pool.query(
        `UPDATE it_declarations SET status = $1, amount = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
          WHERE id = $4 AND status = $5 RETURNING *`,
        [status, amount, userId, decl.id, decl.status]);
      if (!rows.length) return res.status(409).json({ message: 'Someone else changed this declaration; reload and try again' });
      logAudit({
        userId, module: 'it_declarations', recordId: decl.id, recordType: 'it_declaration',
        action: status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'reopen',
        oldData: { status: decl.status, amount: decl.amount, claimed_amount: decl.claimed_amount },
        newData: { status: rows[0].status, amount: rows[0].amount, claimed_amount: rows[0].claimed_amount, remarks: remarks || null, reviewed_by: rows[0].reviewed_by },
        req, company_id: decl.company_id,
      });
      await notifyDeclarationOwner(decl, status, amount, remarks);
      return res.json(rows[0]);
    }

    /* ── an edit, while it waits for review: by Finance who entered it (or the owner, if self_service:edit is ever granted again) ── */
    if (!isOwner && !isFiler) {
      return res.status(403).json({ message: 'A reviewer approves, rejects or reopens a declaration; Finance (who entered it) edits it' });
    }
    if (decl.status !== 'submitted') {
      return res.status(409).json({ message: `This declaration is ${decl.status} and can no longer be edited` });
    }
    const checked = checkDeclarationFields(body, { partial: true, type: decl.declaration_type });
    if (checked.error) return res.status(400).json({ message: checked.error });
    const v = checked.values;
    const merged = { ...decl, ...v, amount: v.amount ?? decl.amount };
    const cross = crossCheckDeclaration(merged);
    if (cross) return res.status(400).json({ message: cross });
    const { rows } = await pool.query(
      `UPDATE it_declarations SET
         amount = COALESCE($1, amount), claimed_amount = COALESCE($1, claimed_amount),
         description = CASE WHEN $2::boolean THEN $3 ELSE description END,
         proof_url   = CASE WHEN $4::boolean THEN $5 ELSE proof_url END,
         metro_city  = COALESCE($6, metro_city),
         landlord_name = CASE WHEN $8::boolean THEN $9 ELSE landlord_name END,
         landlord_pan  = CASE WHEN $10::boolean THEN $11 ELSE landlord_pan END,
         insured_for   = COALESCE($12, insured_for),
         parents_senior = COALESCE($13, parents_senior),
         updated_at = NOW()
       WHERE id = $7 AND status = 'submitted' RETURNING *`,
      [v.amount ?? null, 'description' in v, v.description ?? null, 'proof_url' in v, v.proof_url ?? null,
       v.metro_city ?? null, decl.id, 'landlord_name' in v, v.landlord_name ?? null, 'landlord_pan' in v, v.landlord_pan ?? null,
       v.insured_for ?? null, v.parents_senior ?? null]);
    if (!rows.length) return res.status(409).json({ message: 'This declaration was reviewed meanwhile and can no longer be edited' });
    logAudit({
      userId, module: 'it_declarations', recordId: decl.id, recordType: 'it_declaration', action: 'update',
      oldData: { status: decl.status, amount: decl.amount, claimed_amount: decl.claimed_amount },
      newData: { status: rows[0].status, amount: rows[0].amount, claimed_amount: rows[0].claimed_amount, remarks: null },
      req, company_id: decl.company_id,
    });
    res.json(rows[0]);
  } catch { res.status(500).json({ message: 'Could not update the declaration' }); }
});

/* ─── GET /self-service/it-declarations/policy ──────────────── */
// Which declarations reduce TDS this month (§264, decision paper C7 option C):
// before the proof cut-off month both submitted and approved, from it on only
// approved ones. The cut-off is Payroll Center → Settings. Anyone signed in to
// the company may read it: the employee sees the deadline, the reviewer the rule.
router.get('/it-declarations/policy', async (req, res) => {
  const cid = companyOf(req);
  if (cid == null) return res.status(400).json({ message: 'Company context required' });
  try { res.json(await declarationPolicy(cid)); }
  catch { res.status(500).json({ message: 'Could not load the declaration policy' }); }
});

/* ─── POST /self-service/it-declarations/:id/proof ──────────── */
// Attach (or replace) the proof file of a declaration that waits for review:
// the employee's own, or a colleague's with it_declarations:add (HR filing on
// their behalf). PDF, JPEG or PNG, up to 10 MB. Served by /api/files to the
// employee and it_declarations:view in the company only.
const PROOF_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
router.post('/it-declarations/:id/proof', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB' : 'The file could not be read' });
    next();
  });
}, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid declaration id' });
  if (!req.file) return res.status(400).json({ message: 'Choose a file to upload' });
  if (!PROOF_TYPES[req.file.mimetype]) return res.status(400).json({ message: 'Proof must be a PDF, JPEG or PNG file' });
  try {
    const { rows: [decl] } = await pool.query(
      `SELECT d.id, d.employee_id, d.status, d.proof_file, e.company_id
         FROM it_declarations d JOIN employees e ON e.id = d.employee_id WHERE d.id = $1`, [Number(req.params.id)]);
    const own = await ownEmployeeId(req);
    const ownDecl = !!decl && own != null && String(decl.employee_id) === String(own);
    const isOwner = ownDecl && await can(req, 'self_service', 'edit');
    const cid = companyOf(req);
    // Finance attaches proof for employees — never to its own declaration.
    const isFiler = decl && cid != null && decl.company_id === cid && !ownDecl && await can(req, 'it_declarations', 'add');
    if (!decl || (!isOwner && !isFiler)) return res.status(404).json({ message: 'Not found' });
    if (decl.status !== 'submitted') return res.status(409).json({ message: `This declaration is ${decl.status}; proof can be attached only while it waits for review` });
    let stored;
    try {
      stored = await uploadFile(req.file.buffer, `itdecl_${decl.id}.${PROOF_TYPES[req.file.mimetype]}`, req.file.mimetype);
    } catch {
      return res.status(502).json({ message: 'The file could not be stored. Nothing was saved — please try again.' });
    }
    const { rows } = await pool.query(
      `UPDATE it_declarations SET proof_file = $1, updated_at = NOW() WHERE id = $2 AND status = 'submitted' RETURNING *`,
      [stored, decl.id]);
    if (!rows.length) return res.status(409).json({ message: 'This declaration was reviewed meanwhile; the proof was not attached' });
    logAudit({
      userId: req.user?.userId ?? req.user?.id ?? null, module: 'it_declarations', recordId: decl.id, recordType: 'it_declaration',
      action: 'proof', oldData: { proof_file: decl.proof_file }, newData: { proof_file: stored, remarks: null }, req, company_id: decl.company_id,
    });
    res.json(rows[0]);
  } catch { res.status(500).json({ message: 'Could not attach the proof' }); }
});

/* ─── GET /self-service/it-declarations/review ──────────────── */
// The reviewer queue (Payroll Center → Tax & Statutory → IT declarations, §265): every declaration of the
// caller's company for a financial year, it_declarations:view only. Same rows
// as each employee's own list — this reads them, it never copies them.
//   ?financial_year=2026-2027  ?status=submitted|approved|rejected|all (default submitted)
// Each row says whether the caller may act on it (it_declarations:approve and
// not their own) and carries the latest review remark from the audit history,
// the employee's tax regime for the year (only the old regime uses
// declarations), and the employee's section total against the statutory limit.
router.get('/it-declarations/review', async (req, res) => {
  const cid = companyOf(req);
  if (cid == null) return res.status(400).json({ message: 'Company context required' });
  if (!(await can(req, 'it_declarations', 'view'))) return res.status(403).json({ message: 'Reviewing IT declarations needs the IT declaration permission' });
  const fy = String(req.query.financial_year || getCurrentFY());
  if (fyStartOf(fy) == null) return res.status(400).json({ message: 'financial_year must look like 2026-2027' });
  const status = String(req.query.status || 'submitted');
  if (status !== 'all' && !DECL_REVIEW_STATUSES.includes(status)) return res.status(400).json({ message: 'status must be submitted, approved, rejected or all' });
  try {
    const own = await ownEmployeeId(req);
    const canApprove = await can(req, 'it_declarations', 'approve');
    const [{ rows }, { rows: [cs] }] = await Promise.all([
      pool.query(
        `SELECT d.id, d.employee_id, d.financial_year, d.declaration_type, d.amount, d.claimed_amount, d.metro_city,
                d.description, d.proof_url, d.proof_file, d.landlord_name, d.landlord_pan, d.insured_for, d.parents_senior,
                d.status, d.reviewed_at, d.created_at, d.updated_at, e.dob,
                COALESCE(NULLIF(TRIM(CONCAT(e.first_name, ' ', e.last_name)), ''), e.name) AS employee_name,
                e.office_id AS employee_code, e.department, etr.regime AS employee_regime,
                COALESCE(NULLIF(TRIM(CONCAT(re.first_name, ' ', re.last_name)), ''), ru.name, ru.email) AS reviewed_by_name,
                (SELECT a.new_data_json->>'remarks' FROM audit_logs a
                  WHERE a.reference_type = 'it_declaration' AND a.reference_id = d.id::text
                    AND a.action_type IN ('approve', 'reject', 'reopen')
                  ORDER BY a.id DESC LIMIT 1) AS last_remarks,
                (SELECT SUM(x.amount) FROM it_declarations x
                  WHERE x.employee_id = d.employee_id AND x.financial_year = d.financial_year
                    AND x.declaration_type = d.declaration_type AND x.status <> 'rejected'
                    AND COALESCE(x.insured_for, '') = COALESCE(d.insured_for, '')) AS section_total
           FROM it_declarations d
           JOIN employees e ON e.id = d.employee_id
           LEFT JOIN employee_tax_regime etr ON etr.employee_id = e.id AND etr.financial_year = d.financial_year
           LEFT JOIN users ru ON ru.id = d.reviewed_by
           LEFT JOIN employees re ON re.id = ru.employee_id
          WHERE e.company_id = $1 AND e.deleted_at IS NULL AND d.financial_year = $2
            AND ($3::text = 'all' OR d.status = $3)
          ORDER BY d.created_at ASC, d.id ASC`,
        [cid, fy, status]),
      pool.query(`SELECT settings->>'regime' AS regime FROM company_settings WHERE company_id = $1 AND module = 'payroll' LIMIT 1`, [cid]),
    ]);
    const companyRegime = cs?.regime === 'old' ? 'old' : 'new';
    const fyEnd = new Date(`${fyStartOf(fy) + 1}-03-31T00:00:00Z`);
    const ageAtFyEnd = (dob) => {
      if (!dob) return null;
      const b = new Date(dob);
      if (Number.isNaN(b.getTime())) return null;
      return fyEnd.getUTCFullYear() - b.getUTCFullYear()
        - ((fyEnd.getUTCMonth() < b.getUTCMonth() || (fyEnd.getUTCMonth() === b.getUTCMonth() && fyEnd.getUTCDate() < b.getUTCDate())) ? 1 : 0);
    };
    // 80D has two limits, self / family and parents, each higher for someone 60 or over.
    const limitFor = (r) => {
      if (r.declaration_type !== '80D') return SECTION_LIMITS[r.declaration_type] ?? null;
      const senior = r.insured_for === 'parents' ? r.parents_senior === true : (ageAtFyEnd(r.dob) ?? 0) >= 60;
      return senior ? OLD_REGIME_LIMITS.d80_senior : OLD_REGIME_LIMITS.d80;
    };
    res.json(rows.map(({ employee_regime, dob, ...r }) => {
      const regime = employee_regime === 'old' || employee_regime === 'new' ? employee_regime : companyRegime;
      return {
        ...r,
        regime,
        regime_source: employee_regime ? 'employee' : 'company',
        // 'other' is stored for the record only; nothing reduces tax under the new regime.
        counts_for_tax: regime === 'old' && r.declaration_type !== 'other',
        section_limit: limitFor({ ...r, dob }),
        can_review: canApprove && !(own != null && String(r.employee_id) === String(own)),
      };
    }));
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
              a.old_data_json->>'amount' AS from_amount, a.new_data_json->>'amount' AS to_amount,
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
    if (!(await can(req, 'self_service', 'add'))) return res.status(403).json({ message: SELF_WRITES_OFF });
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
      if (!(await can(req, 'self_service', 'edit'))) return res.status(403).json({ message: SELF_WRITES_OFF });
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
  if (!(await can(req, 'self_service', 'edit'))) return res.status(403).json({ message: SELF_WRITES_OFF });
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
