/**
 * Phase 49C — Vendor Approval Workflow
 * SCM → Quality → Finance → Management multi-stage approval.
 * Includes vendor contacts, bank details, NCR, CAPA, and CEO traceability.
 */
import express from 'express';
import multer from 'multer';
import pool from '../../../config/db.js';
import { verifyToken, allowRoles } from '../../../middlewares/auth.middleware.js';
import { requireProcurement } from '../procurement.authz.js';
import { logAudit } from '../../../services/AuditService.js';
import { dimension } from '../../../shared/dashboardFilters.js';
import VendorService from '../services/vendor.service.js';
import { uploadFile } from '../../../services/StorageService.js';
import { companyOf } from '../../../shared/scope.js';
import { resolveVendorParty } from '../services/vendorIdentity.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();
const cid = req => companyOf(req);
const uid = req => req.user?.userId ?? req.user?.id ?? null;

// All routes require authentication
router.use(verifyToken);

/**
 * AUTHORIZATION AND TENANT SCOPE — what this router had, and what it has now.
 *
 * Every route below was reachable by ANY authenticated account. `verifyToken`
 * was the whole gate on 25 of the 31 routes, and the six that carried
 * `allowRoles` named FOUR ROLE CODES THAT DO NOT EXIST — `procurement`, `scm`,
 * `quality` and `director`. `allowRoles` matches on the code, so each phantom
 * simply never matched: the SCM review was in practice open to
 * admin/super_admin/manager and closed to the procurement team whose review it
 * is, and the management review was open to any `manager` — the second-largest
 * role in this database, 8 accounts, with `can_view = FALSE` on procurement.
 * Same failure as the `ceo`/`cfo`/`chro` phantoms found in the roles pass.
 *
 * The consequences were not theoretical. Ungated and unscoped, these were live:
 *   POST /vendors/:vendorId/banks     — add bank details to any vendor, in any
 *                                        company. This is the destination of an
 *                                        invoice-fraud attempt.
 *   POST /vendors/:vendorId/contacts   — inject a contact into the vendor master
 *   DELETE /contacts/:id               — delete another tenant's vendor contact
 *   PUT  /:id/*-review                 — approve another tenant's vendor
 *   POST /ncr, /capa, /vendors/:id/risk — write another tenant's quality record
 *
 * Gates now come from `requireProcurement(action, ...alsoAllowRoles)`, which ORs
 * the role_permissions matrix with named roles — the same helper the rest of the
 * module uses, so the matrix stays the single source of truth and the named
 * roles are only the documented exceptions (quality works NCR/CAPA, finance
 * works bank verification).
 */

/**
 * Load a vendor registration the caller is allowed to see.
 *
 * `vendor_registrations.company_id` exists and NOTHING read it: every query in
 * this file keyed on the path id alone, so a registration — including its
 * bank account number, GSTIN and PAN — was readable and approvable by any
 * tenant. Returns null when the row is absent OR belongs to someone else; both
 * are a 404 to the caller, which is the correct answer to "does this id exist"
 * from someone who may not know.
 */
async function ownedRegistration(req, id) {
  const { rows } = await pool.query(
    `SELECT * FROM vendor_registrations
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
    [id, cid(req)]
  );
  return rows[0] ?? null;
}

/** The same check for a vendor id appearing in a path. */
async function ownsVendor(req, vendorId) {
  const { rows } = await pool.query(
    `SELECT id FROM vendors
      WHERE id = $1 AND deleted_at IS NULL
        AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
    [vendorId, cid(req)]
  );
  return rows.length > 0;
}

/**
 * Guard for a `:vendorId` path segment. Placed before the handler so a foreign
 * or non-existent vendor is refused before any query runs against its children.
 */
const scopeVendor = async (req, res, next) => {
  if (!(await ownsVendor(req, req.params.vendorId))) {
    return res.status(404).json({ error: 'Vendor not found' });
  }
  next();
};

/**
 * The approval stages, in the order they must happen.
 *
 * Nothing enforced the sequence: management-review could be called directly on a
 * brand-new registration, skipping the SCM, quality and finance reviews
 * entirely — which is the whole point of a four-stage approval. Each stage
 * therefore now asserts that the stage before it has recorded a decision.
 */
const REVIEW_STAGES = ['scm', 'quality', 'finance', 'mgmt'];
const STAGE_COLUMN  = { scm: 'scm_reviewed_at', quality: 'quality_reviewed_at', finance: 'finance_reviewed_at', mgmt: 'mgmt_approved_at' };
const STAGE_LABEL   = { scm: 'SCM', quality: 'Quality', finance: 'Finance', mgmt: 'Management' };

function assertStageOrder(reg, stage) {
  const idx = REVIEW_STAGES.indexOf(stage);
  for (let i = 0; i < idx; i++) {
    const prior = REVIEW_STAGES[i];
    if (!reg[STAGE_COLUMN[prior]]) {
      return { status: 409, body: {
        error: `${STAGE_LABEL[stage]} review cannot be recorded until the ${STAGE_LABEL[prior]} review is done.`,
        code: 'REVIEW_STAGE_OUT_OF_ORDER',
        awaiting: prior,
      } };
    }
  }
  if (reg.status === 'Rejected') {
    return { status: 409, body: { error: 'This registration was rejected; reopen it before recording another review.', code: 'REGISTRATION_REJECTED' } };
  }
  return null;
}

// ── APPROVAL QUEUE ────────────────────────────────────────────────────────────

// ── GET /vendor-approval/queue ────────────────────────────────────────────────
router.get('/queue', requireProcurement('view'), async (req, res) => {
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
router.get('/:id', requireProcurement('view'), async (req, res) => {
  try {
    // Scoped: this returns the registration's bank account number, GSTIN and
    // PAN, and keyed on the path id alone it returned any tenant's.
    const reg = await ownedRegistration(req, req.params.id);
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
router.put('/:id/scm-review', requireProcurement('approve'), async (req, res) => {
  try {
    const {
      decision, remarks,
      products_verified, capacity_verified, lead_time, moq,
      commercial_terms, references, past_experience, scm_score,
    } = req.body;

    if (!['Approve', 'Reject', 'Hold'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be Approve, Reject, or Hold' });
    }

    // Scope FIRST: keyed on the path id alone, this recorded a review against —
    // and approved — another tenant's vendor registration. Then order: nothing
    // enforced the SCM -> Quality -> Finance -> Management sequence, so a
    // brand-new registration could be sent straight to management approval and
    // promoted into the vendor master having passed none of the checks the
    // workflow exists to make.
    const existing = await ownedRegistration(req, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const order = assertStageOrder(existing, 'scm');
    if (order) return res.status(order.status).json(order.body);

    let newStatus = 'Under Review';
    if (decision === 'Reject')  newStatus = 'Rejected';
    else if (decision === 'Hold') newStatus = 'On Hold';
    else newStatus = 'Pending Quality Review';

    const { rows: [reg] } = await pool.query(`
      UPDATE vendor_registrations SET
        scm_reviewed_by=$1, scm_reviewed_at=NOW(), scm_remarks=$2, scm_score=$3,
        status=$4, updated_at=NOW()
      WHERE id=$5 AND ($6::int IS NULL OR company_id = $6 OR company_id IS NULL) RETURNING *
    `, [uid(req), remarks, scm_score || 0, newStatus, req.params.id, cid(req)]);

    if (!reg) return res.status(404).json({ error: 'Not found' });
    logAudit({ userId: uid(req), module: 'vendor_approval', recordId: reg.id, recordType: 'vendor_registration', action: 'scm_review', newData: { decision, remarks, scm_score } });
    res.json(reg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /vendor-approval/:id/quality-review ──────────────────────────────────
router.put('/:id/quality-review', requireProcurement('approve', 'qc_manager', 'qc_engineer'), async (req, res) => {
  try {
    const {
      decision, remarks,
      iso_verified, inspection_capability, testing_capability,
      quality_processes, ncr_history, quality_score,
    } = req.body;

    if (!['Approve', 'Reject', 'Hold'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be Approve, Reject, or Hold' });
    }

    // Scope FIRST: keyed on the path id alone, this recorded a review against —
    // and approved — another tenant's vendor registration. Then order: nothing
    // enforced the SCM -> Quality -> Finance -> Management sequence, so a
    // brand-new registration could be sent straight to management approval and
    // promoted into the vendor master having passed none of the checks the
    // workflow exists to make.
    const existing = await ownedRegistration(req, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const order = assertStageOrder(existing, 'quality');
    if (order) return res.status(order.status).json(order.body);

    let newStatus = 'Pending Finance Review';
    if (decision === 'Reject')  newStatus = 'Rejected';
    else if (decision === 'Hold') newStatus = 'On Hold';

    const { rows: [reg] } = await pool.query(`
      UPDATE vendor_registrations SET
        quality_reviewed_by=$1, quality_reviewed_at=NOW(), quality_remarks=$2, scm_quality_score=$3,
        status=$4, updated_at=NOW()
      WHERE id=$5 AND ($6::int IS NULL OR company_id = $6 OR company_id IS NULL) RETURNING *
    `, [uid(req), remarks, quality_score || 0, newStatus, req.params.id, cid(req)]);

    if (!reg) return res.status(404).json({ error: 'Not found' });
    logAudit({ userId: uid(req), module: 'vendor_approval', recordId: reg.id, recordType: 'vendor_registration', action: 'quality_review', newData: { decision, remarks, quality_score } });
    res.json(reg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /vendor-approval/:id/finance-review ───────────────────────────────────
router.put('/:id/finance-review', requireProcurement('approve', 'finance', 'finance_manager'), async (req, res) => {
  try {
    const {
      decision, remarks,
      gst_verified, pan_verified, bank_verified,
      credit_terms, financial_stability, compliance_ok, finance_score,
    } = req.body;

    if (!['Approve', 'Reject', 'Hold'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be Approve, Reject, or Hold' });
    }

    // Scope FIRST: keyed on the path id alone, this recorded a review against —
    // and approved — another tenant's vendor registration. Then order: nothing
    // enforced the SCM -> Quality -> Finance -> Management sequence, so a
    // brand-new registration could be sent straight to management approval and
    // promoted into the vendor master having passed none of the checks the
    // workflow exists to make.
    const existing = await ownedRegistration(req, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const order = assertStageOrder(existing, 'finance');
    if (order) return res.status(order.status).json(order.body);

    let newStatus = 'Pending Management Review';
    if (decision === 'Reject')  newStatus = 'Rejected';
    else if (decision === 'Hold') newStatus = 'On Hold';

    const { rows: [reg] } = await pool.query(`
      UPDATE vendor_registrations SET
        finance_reviewed_by=$1, finance_reviewed_at=NOW(), finance_remarks=$2, finance_score=$3,
        status=$4, updated_at=NOW()
      WHERE id=$5 AND ($6::int IS NULL OR company_id = $6 OR company_id IS NULL) RETURNING *
    `, [uid(req), remarks, finance_score || 0, newStatus, req.params.id, cid(req)]);

    if (!reg) return res.status(404).json({ error: 'Not found' });
    logAudit({ userId: uid(req), module: 'vendor_approval', recordId: reg.id, recordType: 'vendor_registration', action: 'finance_review', newData: { decision, remarks, finance_score } });
    res.json(reg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /vendor-approval/:id/management-review ───────────────────────────────
router.put('/:id/management-review', requireProcurement('approve', 'department_head'), async (req, res) => {
  try {
    const { decision, remarks, conditions } = req.body;
    if (!['Approved', 'Conditional Approval', 'Rejected'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be Approved, Conditional Approval, or Rejected' });
    }

    // Scope and order, as for the three reviews before this one. This is the
    // stage that promotes a registration into the vendor master, so reaching it
    // without the SCM, quality and finance reviews meant a supplier could be
    // created having passed none of them.
    const existing = await ownedRegistration(req, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const order = assertStageOrder(existing, 'mgmt');
    if (order) return res.status(order.status).json(order.body);

    const newStatus = decision === 'Rejected' ? 'Rejected' : 'Approved';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // FOR UPDATE: two approvers clicking together would otherwise both pass
      // the `!vendorId` check below and create TWO vendors for one registration.
      await client.query('SELECT id FROM vendor_registrations WHERE id=$1 FOR UPDATE', [req.params.id]);

      const { rows: [reg] } = await client.query(`
        UPDATE vendor_registrations SET
          mgmt_approved_by=$1, mgmt_approved_at=NOW(), mgmt_remarks=$2,
          status=$3, updated_at=NOW()
        WHERE id=$4 AND ($5::int IS NULL OR company_id = $5 OR company_id IS NULL) RETURNING *
      `, [uid(req), remarks, newStatus, req.params.id, cid(req)]);

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

        // A vendor without a finance party cannot be paid — every AP document
        // FKs parties(id). This promotion path created the vendor row and
        // stopped there, so a supplier that came through the full four-stage
        // approval was LESS complete than one typed into the internal form,
        // which binds its party at creation. Same transaction as the vendor
        // row: committing one without the other is what left 0 of 6 vendors
        // bound in the first place. See vendorIdentity.service.js.
        await resolveVendorParty(client, vendorId);

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

router.get('/vendors/:vendorId/contacts', requireProcurement('view'), scopeVendor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vendor_contacts WHERE vendor_id=$1
         AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
       ORDER BY is_primary DESC, contact_type`,
      [req.params.vendorId, cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendors/:vendorId/contacts', requireProcurement('edit'), scopeVendor, async (req, res) => {
  try {
    const { contact_type, name, designation, phone, mobile, email, is_primary } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (is_primary) {
      await pool.query(
        `UPDATE vendor_contacts SET is_primary=false WHERE vendor_id=$1
          AND ($2::int IS NULL OR company_id = $2)`,
        [req.params.vendorId, cid(req)]);
    }
    const { rows: [c] } = await pool.query(`
      INSERT INTO vendor_contacts (vendor_id, contact_type, name, designation, phone, mobile, email, is_primary, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [req.params.vendorId, contact_type || 'Commercial', name, designation, phone, mobile, email, is_primary || false, cid(req)]);
    res.status(201).json(c);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/contacts/:id', requireProcurement('edit'), async (req, res) => {
  try {
    const { contact_type, name, designation, phone, mobile, email, is_primary } = req.body;
    const { rows: [c] } = await pool.query(`
      UPDATE vendor_contacts SET contact_type=$1, name=$2, designation=$3, phone=$4, mobile=$5, email=$6, is_primary=$7, updated_at=NOW()
      WHERE id=$8 AND ($9::int IS NULL OR company_id = $9) RETURNING *
    `, [contact_type, name, designation, phone, mobile, email, is_primary || false, req.params.id, cid(req)]);
    if (!c) return res.status(404).json({ error: 'Contact not found' });
    res.json(c);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/contacts/:id', requireProcurement('delete'), async (req, res) => {
  try {
    // Reports whether anything was actually deleted. The bare DELETE returned
    // "Deleted" for an id in another company that it had not touched.
    const { rowCount } = await pool.query(
      `DELETE FROM vendor_contacts WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid(req)]);
    if (!rowCount) return res.status(404).json({ error: 'Contact not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR BANK DETAILS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/banks', requireProcurement('view', 'finance', 'finance_manager'), scopeVendor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vendor_bank_details WHERE vendor_id=$1
         AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
       ORDER BY is_primary DESC`,
      [req.params.vendorId, cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendors/:vendorId/banks', requireProcurement('approve', 'finance', 'finance_manager'), scopeVendor, async (req, res) => {
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

router.put('/banks/:id/verify', requireProcurement('approve', 'finance', 'finance_manager'), async (req, res) => {
  try {
    const { rows: [b] } = await pool.query(`
      UPDATE vendor_bank_details SET finance_verified=true, finance_verified_by=$1, finance_verified_at=NOW(), updated_at=NOW()
      WHERE id=$2 AND ($3::int IS NULL OR company_id = $3) RETURNING *
    `, [uid(req), req.params.id, cid(req)]);
    if (!b) return res.status(404).json({ error: 'Bank detail not found' });
    res.json(b);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR DOCUMENTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/documents', requireProcurement('view', 'finance', 'finance_manager', 'qc_manager'), scopeVendor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vendor_documents WHERE vendor_id=$1 ORDER BY doc_type, created_at DESC`,
      [req.params.vendorId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendors/:vendorId/documents', requireProcurement('edit', 'qc_manager', 'qc_engineer'), scopeVendor, upload.single('file'), async (req, res) => {
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

router.put('/documents/:id/verify', requireProcurement('approve', 'qc_manager', 'finance', 'finance_manager'), async (req, res) => {
  try {
    const { rows: [doc] } = await pool.query(`
      UPDATE vendor_documents SET verified=true, verified_by=$1, verified_at=NOW(), updated_at=NOW()
      WHERE id=$2 AND ($3::int IS NULL OR company_id = $3) RETURNING *
    `, [uid(req), req.params.id, cid(req)]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// NCR
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/ncr', requireProcurement('view', 'qc_manager', 'qc_engineer'), scopeVendor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vendor_ncr WHERE vendor_id=$1 ORDER BY ncr_date DESC`,
      [req.params.vendorId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/ncr', requireProcurement('add', 'qc_manager', 'qc_engineer'), async (req, res) => {
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

router.put('/ncr/:id', requireProcurement('edit', 'qc_manager', 'qc_engineer'), async (req, res) => {
  try {
    const { status, root_cause, disposition } = req.body;
    // Same interpolated actor id as the CAPA update below, and the same missing
    // company predicate: any authenticated caller could close any tenant's
    // non-conformance report.
    const isClosed = status === 'Closed';
    const { rows: [ncr] } = await pool.query(`
      UPDATE vendor_ncr SET status=$1, root_cause=$2, disposition=$3,
             closed_at = CASE WHEN $5::boolean THEN NOW() ELSE closed_at END,
             closed_by = CASE WHEN $5::boolean THEN $6::int ELSE closed_by END,
             updated_at=NOW()
      WHERE id=$4 AND ($7::int IS NULL OR company_id = $7) RETURNING *
    `, [status, root_cause, disposition, req.params.id, isClosed, uid(req), cid(req)]);
    if (!ncr) return res.status(404).json({ error: 'NCR not found' });
    res.json(ncr);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPA
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/capa', requireProcurement('view', 'qc_manager', 'qc_engineer'), scopeVendor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, n.ncr_number FROM vendor_capa c LEFT JOIN vendor_ncr n ON n.id=c.ncr_id
        WHERE c.vendor_id=$1 AND ($2::int IS NULL OR c.company_id = $2 OR c.company_id IS NULL)
        ORDER BY c.issue_date DESC`,
      [req.params.vendorId, cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/capa', requireProcurement('add', 'qc_manager', 'qc_engineer'), async (req, res) => {
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

router.put('/capa/:id', requireProcurement('edit', 'qc_manager', 'qc_engineer'), async (req, res) => {
  try {
    const { status, effectiveness_rating, root_cause, action_plan } = req.body;
    // `closed_by=${uid(req)}` interpolated a value straight into the SQL string.
    // It is an integer from a signed token today, so it was not exploitable —
    // but an unparameterised value in a SQL string is a habit, not an accident,
    // and a NULL actor produced the literal text `closed_by=null`. Bound as a
    // parameter, with the column set unconditionally so the shape is stable.
    const isClosed = status === 'Closed';
    const { rows: [capa] } = await pool.query(`
      UPDATE vendor_capa SET status=$1, effectiveness_rating=$2, root_cause=$3, action_plan=$4,
             closed_at = CASE WHEN $6::boolean THEN NOW() ELSE closed_at END,
             closed_by = CASE WHEN $6::boolean THEN $7::int ELSE closed_by END,
             updated_at=NOW()
      WHERE id=$5 AND ($8::int IS NULL OR company_id = $8) RETURNING *
    `, [status, effectiveness_rating || null, root_cause, action_plan, req.params.id, isClosed, uid(req), cid(req)]);
    if (!capa) return res.status(404).json({ error: 'CAPA not found' });
    res.json(capa);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// RISK ASSESSMENTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendors/:vendorId/risk', requireProcurement('view', 'qc_manager'), scopeVendor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vendor_risk_assessments WHERE vendor_id=$1 ORDER BY assessment_date DESC LIMIT 12`,
      [req.params.vendorId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendors/:vendorId/risk', requireProcurement('edit', 'qc_manager'), scopeVendor, async (req, res) => {
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

router.get('/vendors/:vendorId/traceability', requireProcurement('view'), scopeVendor, async (req, res) => {
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
      pool.query(`SELECT id, vendor_name, vendor_code, classification, risk_rating, approved_by, approved_at, party_id FROM vendors WHERE id=$1`, [vendorId]),
      // purchase_orders.supplier_id is an integer FK to vendors.id. The old
      // `$1::text` cast made Postgres compare integer = text and threw
      // `operator does not exist`, so this endpoint had never returned once.
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS total_spend, COUNT(*) AS po_count FROM purchase_orders WHERE supplier_id=$1`, [vendorId]),
      pool.query(`SELECT * FROM vendor_ncr WHERE vendor_id=$1 ORDER BY ncr_date DESC`, [vendorId]),
      pool.query(`SELECT * FROM vendor_capa WHERE vendor_id=$1 ORDER BY issue_date DESC`, [vendorId]),
      pool.query(`SELECT * FROM vendor_scorecards WHERE vendor_id=$1 ORDER BY period_year DESC, period_quarter DESC LIMIT 1`, [vendorId]),
      pool.query(`SELECT * FROM vendor_risk_assessments WHERE vendor_id=$1 ORDER BY assessment_date DESC LIMIT 1`, [vendorId]),
      pool.query(`SELECT DISTINCT p.id, p.project_number, p.project_name FROM projects p JOIN purchase_orders po ON po.project_id=p.id WHERE po.supplier_id=$1 LIMIT 20`, [vendorId]).catch(() => ({ rows: [] })),
      // vendor_payments never existed. What a vendor is actually paid against is
      // their bills: `bills` carries supplier_id, status and balance, so paid vs
      // outstanding comes straight off that rather than a phantom table.
      //
      // bills.supplier_id is a uuid pointing at `parties`, while vendors.id is an
      // integer — passing the vendor id straight in threw on every call. The
      // bridge is vendors.party_id, so the lookup goes through that. A vendor with
      // no party link simply has no bills, which is a zero row, not an error.
      pool.query(`SELECT COUNT(*) FILTER (WHERE LOWER(b.status)='paid') AS paid_count,
                         COUNT(*) FILTER (WHERE LOWER(b.status) <> 'paid') AS outstanding_count,
                         COALESCE(SUM(CASE WHEN LOWER(b.status) <> 'paid' THEN b.balance ELSE 0 END),0) AS outstanding_amount
                    FROM bills b
                    JOIN vendors v ON v.party_id = b.supplier_id
                   WHERE v.id = $1 AND b.deleted_at IS NULL`, [vendorId]),
    ]);

    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const openNcrs  = ncrs.filter(n => n.status === 'Open').length;
    const openCapas = capas.filter(c => c.status === 'Open').length;

    // What "traceable" means here: every link in the vendor's chain can actually
    // be followed, and nothing quality-related is still open.
    //
    // The previous expression was `[vendor, spend, ncrs.length === 0 || true,
    // scorecard, risk].every(Boolean)` — `ncrs.length === 0 || true` is always
    // true, `spend` is always a row object, and `vendor` is guaranteed by the
    // 404 above. Only `scorecard` and `risk` could ever be falsy, so the verdict
    // was very nearly a constant and told a CEO nothing.
    //
    // Each check names the link it asserts, so a failure says which one is
    // missing instead of just turning the badge red.
    const checks = [
      {
        key: 'approved', label: 'Approval recorded',
        pass: !!(vendor.approved_by && vendor.approved_at),
        detail: 'Who approved this vendor, and when',
      },
      {
        key: 'classified', label: 'Classified',
        pass: !!vendor.classification,
        detail: 'Approved / Conditional / Blacklisted',
      },
      {
        key: 'risk_assessed', label: 'Risk assessed',
        pass: !!(risk || vendor.risk_rating),
        detail: 'A risk assessment or at least a standing risk rating',
      },
      {
        key: 'performance_rated', label: 'Performance scored',
        pass: !!scorecard,
        detail: 'At least one quarterly scorecard',
      },
      {
        key: 'finance_linked', label: 'Linked to finance',
        pass: !!vendor.party_id,
        detail: 'vendors.party_id — without it no bill or payment can be traced to this vendor',
      },
      {
        key: 'quality_clear', label: 'No open quality issues',
        pass: openNcrs === 0 && openCapas === 0,
        detail: openNcrs || openCapas
          ? `${openNcrs} open NCR(s), ${openCapas} open CAPA(s)`
          : 'All NCRs and CAPAs closed',
      },
    ];
    const failed = checks.filter(c => !c.pass);

    // Three states, not two. An unfinished record is not the same as a vendor
    // with open non-conformances, and lumping them together as one red badge is
    // what made the old verdict useless.
    const verdict = failed.length === 0
      ? 'PASS'
      : (failed.length === 1 && failed[0].key === 'quality_clear' ? 'OPEN QUALITY ISSUES' : 'INCOMPLETE');

    res.json({
      vendor,
      spend: { total: Number(spend?.total_spend || 0), po_count: Number(spend?.po_count || 0) },
      ncr: { count: ncrs.length, open: openNcrs, records: ncrs },
      capa: { count: capas.length, open: openCapas, records: capas },
      scorecard: scorecard || null,
      risk: risk || null,
      projects,
      payments: payments[0] || {},
      traceability: {
        verdict,
        passed: checks.length - failed.length,
        total: checks.length,
        checks,
        failed: failed.map(f => f.label),
      },
      traceability_score: verdict,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD (49C-21)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/dashboard/stats', requireProcurement('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cf = companyId ? `WHERE (company_id=$1 OR company_id IS NULL)` : '';
    const params = companyId ? [companyId] : [];

    // Dashboard filter bar: ?vendor_type / ?risk_rating. No period — the vendor
    // master is a population, not activity. Those columns live only on
    // `vendors`, so the dimensions narrow the vendor-population KPIs; the
    // approval queue and open-NCR count are work queues and stay whole.
    const vendorType = dimension(req.query, 'vendor_type');
    const riskRating = dimension(req.query, 'risk_rating');
    const vParams = [...params];
    let vFilter = '';
    if (vendorType) { vParams.push(vendorType); vFilter += ` AND vendor_type = $${vParams.length}`; }
    if (riskRating) { vParams.push(riskRating); vFilter += ` AND risk_rating = $${vParams.length}`; }
    // `cf` already opens with WHERE when scoped; without it, start one.
    const vWhere = cf ? `${cf}${vFilter}` : (vFilter ? `WHERE TRUE${vFilter}` : '');

    const [{ rows: [vs] }, { rows: [rs] }, { rows: ncrs }] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total_vendors,
          COUNT(*) FILTER (WHERE classification='Preferred') AS preferred,
          COUNT(*) FILTER (WHERE classification='Blocked' OR status='Blocked') AS blocked,
          COUNT(*) FILTER (WHERE risk_rating IN ('High','Critical')) AS high_risk,
          COUNT(*) FILTER (WHERE status='Active') AS active
        FROM vendors ${vWhere}
      `, vParams),
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

// Dimension values for the vendor dashboard filter bar. Not narrowed by the
// active selection, so picking one doesn't empty the other dropdown.
router.get('/dashboard/filter-options', requireProcurement('view'), async (req, res) => {
  const companyId = cid(req);
  const distinct = (col) => pool
    .query(`SELECT DISTINCT ${col} AS v FROM vendors
             WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
               AND ${col} IS NOT NULL AND TRIM(${col}) <> ''
             ORDER BY v`, [companyId])
    .catch(() => ({ rows: [] }));
  const [types, risks] = await Promise.all([distinct('vendor_type'), distinct('risk_rating')]);
  res.json({ vendor_types: types.rows.map(r => r.v), risk_ratings: risks.rows.map(r => r.v) });
});

router.get('/dashboard/charts', requireProcurement('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cf = companyId ? `(company_id=$1 OR company_id IS NULL)` : 'TRUE';
    const params = companyId ? [companyId] : [];

    // Same dimensions as /dashboard/stats. The two vendor-population charts
    // honour them; the scorecard chart joins vendor_scorecards and is left as-is.
    const vendorType = dimension(req.query, 'vendor_type');
    const riskRating = dimension(req.query, 'risk_rating');
    const vParams = [...params];
    let vFilter = '';
    if (vendorType) { vParams.push(vendorType); vFilter += ` AND vendor_type = $${vParams.length}`; }
    if (riskRating) { vParams.push(riskRating); vFilter += ` AND risk_rating = $${vParams.length}`; }

    const [{ rows: dist }, { rows: riskDist }, { rows: qualPerf }] = await Promise.all([
      pool.query(`
        SELECT vendor_type AS category, COUNT(*) AS count
        FROM vendors WHERE ${cf}${vFilter}
        GROUP BY vendor_type ORDER BY count DESC LIMIT 15
      `, vParams),
      pool.query(`
        SELECT risk_rating, COUNT(*) AS count
        FROM vendors WHERE ${cf}${vFilter}
        GROUP BY risk_rating
      `, vParams),
      pool.query(`
        SELECT v.vendor_name,
               AVG(vs.quality_score) AS quality,
               AVG(vs.delivery_score) AS delivery,
               AVG(vs.overall_score) AS overall
        FROM vendor_scorecards vs
        JOIN vendors v ON v.id=vs.vendor_id
        WHERE ${cf.replaceAll('company_id', 'vs.company_id')}
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

router.get('/reports/vendor-master', requireProcurement('export'), async (req, res) => {
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

router.get('/reports/approval-status', requireProcurement('export'), async (req, res) => {
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

router.get('/reports/ncr-summary', requireProcurement('export', 'qc_manager'), async (req, res) => {
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
