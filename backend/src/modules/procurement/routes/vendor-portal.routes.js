import express from 'express';
import pool from '../../../config/db.js';
import { allowRoles } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../../services/WorkflowNotificationService.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);
const uid = req => req.user?.userId ?? req.user?.id ?? null;

const APPROVAL_FLOW = [
  { level: 1, name: 'SCM Review' },
  { level: 2, name: 'Quality Review' },
  { level: 3, name: 'Finance Review' },
  { level: 4, name: 'Management Approval' },
];

// ── GET /vendor-portal/registrations ─────────────────────────────────────────
router.get('/registrations', async (req, res) => {
  try {
    const { status, search } = req.query;
    const companyId = cid(req);
    const conds = [];
    const params = [];
    let idx = 1;
    if (companyId) { conds.push(`(company_id=$${idx++} OR company_id IS NULL)`); params.push(companyId); }
    if (status) { conds.push(`status=$${idx++}`); params.push(status); }
    if (search) { conds.push(`(vendor_name ILIKE $${idx} OR email ILIKE $${idx} OR gstin ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM vendor_registrations ${where} ORDER BY created_at DESC`, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /vendor-portal/registrations/:id ─────────────────────────────────────
router.get('/registrations/:id', async (req, res) => {
  try {
    const { rows: [vr] } = await pool.query(`SELECT * FROM vendor_registrations WHERE id=$1`, [req.params.id]);
    if (!vr) return res.status(404).json({ error: 'Not found' });
    res.json(vr);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /vendor-portal/registrations (self-registration — no auth required) ──
router.post('/registrations', async (req, res) => {
  try {
    const {
      vendor_name, vendor_type, products_services,
      gstin, pan, msme_status, udyam_number,
      bank_name, account_number, ifsc,
      address, city, state, pincode,
      contact_person, email, phone, website,
      iso_certificates, quality_docs_link, nda_signed,
      technical_capability, annual_turnover, num_employees, year_established,
    } = req.body;
    if (!vendor_name || !email) return res.status(400).json({ error: 'vendor_name and email are required' });

    const companyId = cid(req);
    const { rows: [vr] } = await pool.query(`
      INSERT INTO vendor_registrations
        (vendor_name, vendor_type, products_services,
         gstin, pan, msme_status, udyam_number,
         bank_name, account_number, ifsc,
         address, city, state, pincode,
         contact_person, email, phone, website,
         iso_certificates, quality_docs_link, nda_signed,
         technical_capability, annual_turnover, num_employees, year_established,
         status, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,'Submitted',$26)
      RETURNING *
    `, [vendor_name, vendor_type, products_services,
        gstin, pan, msme_status||false, udyam_number,
        bank_name, account_number, ifsc,
        address, city, state, pincode,
        contact_person, email, phone, website,
        iso_certificates, quality_docs_link, nda_signed||false,
        technical_capability, annual_turnover||null, num_employees||null, year_established||null,
        companyId]);
    res.status(201).json({ message: 'Registration submitted successfully', id: vr.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /vendor-portal/registrations/:id/review (stage-based approval) ───────
router.put('/registrations/:id/review', allowRoles('admin','super_admin','procurement','finance','manager','quality'), async (req, res) => {
  try {
    const { stage, status, remarks } = req.body;
    // stage: 'scm' | 'quality' | 'finance' | 'management'
    const actorId = uid(req);
    const now = new Date().toISOString();

    const colMap = {
      scm:        { by: 'scm_reviewed_by',    at: 'scm_reviewed_at',    rem: 'scm_remarks' },
      quality:    { by: 'quality_reviewed_by', at: 'quality_reviewed_at',rem: 'quality_remarks' },
      finance:    { by: 'finance_reviewed_by', at: 'finance_reviewed_at',rem: 'finance_remarks' },
      management: { by: 'mgmt_approved_by',   at: 'mgmt_approved_at',   rem: 'mgmt_remarks' },
    };
    const cols = colMap[stage];
    if (!cols) return res.status(400).json({ error: 'Invalid stage' });

    let newStatus = 'Under Review';
    if (status === 'Rejected') newStatus = 'Rejected';
    else if (stage === 'management' && status === 'Approved') newStatus = 'Approved';
    else if (status === 'Approved') {
      const stageOrder = ['scm','quality','finance','management'];
      const nextStage = stageOrder[stageOrder.indexOf(stage) + 1];
      newStatus = nextStage ? `Pending ${nextStage.charAt(0).toUpperCase() + nextStage.slice(1)} Review` : 'Approved';
    }

    const { rows: [vr] } = await pool.query(`
      UPDATE vendor_registrations
      SET ${cols.by}=$1, ${cols.at}=$2, ${cols.rem}=$3, status=$4, updated_at=NOW()
      WHERE id=$5 RETURNING *
    `, [actorId, now, remarks, newStatus, req.params.id]);

    // Auto-create vendor master on management approval
    if (stage === 'management' && status === 'Approved' && !vr.vendor_id) {
      const { rows: [vendor] } = await pool.query(`
        INSERT INTO vendors (vendor_name, category, gstin, pan, bank_name, account_number, ifsc,
          contact_person, email, phone, city, state, address, status, company_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Active',$14)
        RETURNING id
      `, [vr.vendor_name, vr.vendor_type||'General', vr.gstin, vr.pan,
          vr.bank_name, vr.account_number, vr.ifsc,
          vr.contact_person, vr.email, vr.phone,
          vr.city, vr.state, vr.address, vr.company_id]);
      await pool.query(`UPDATE vendor_registrations SET vendor_id=$1 WHERE id=$2`, [vendor.id, vr.id]);
      vr.vendor_id = vendor.id;
    }

    logAudit({ userId: actorId, module: 'vendor_portal', recordId: vr.id, recordType: 'vendor_registration',
      action: `review_${stage}`, newData: { status, remarks } });
    res.json(vr);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Vendor Scorecard CRUD ─────────────────────────────────────────────────────
router.get('/scorecards', async (req, res) => {
  try {
    const { vendor_id, year, quarter } = req.query;
    const companyId = cid(req);
    const conds = [];
    const params = [];
    let idx = 1;
    if (companyId) { conds.push(`vs.company_id=$${idx++}`); params.push(companyId); }
    if (vendor_id) { conds.push(`vs.vendor_id=$${idx++}`); params.push(vendor_id); }
    if (year) { conds.push(`vs.period_year=$${idx++}`); params.push(year); }
    if (quarter) { conds.push(`vs.period_quarter=$${idx++}`); params.push(quarter); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT vs.*, v.vendor_name, v.category
      FROM vendor_scorecards vs
      LEFT JOIN vendors v ON v.id = vs.vendor_id
      ${where}
      ORDER BY vs.period_year DESC, vs.period_quarter DESC
    `, params);
    res.json(rows);
  } catch { res.json([]); }
});

router.post('/scorecards', allowRoles('admin','super_admin','procurement','quality','manager'), async (req, res) => {
  try {
    const {
      vendor_id, period_year, period_quarter,
      quality_score, delivery_score, cost_score,
      support_score, compliance_score, documentation_score,
      remarks,
    } = req.body;
    const actorId = uid(req);
    const companyId = cid(req);
    const overall = ((Number(quality_score||0) + Number(delivery_score||0) + Number(cost_score||0) +
                      Number(support_score||0) + Number(compliance_score||0) + Number(documentation_score||0)) / 6).toFixed(2);
    const risk = overall >= 80 ? 'Low' : overall >= 60 ? 'Medium' : 'High';

    const { rows: [sc] } = await pool.query(`
      INSERT INTO vendor_scorecards
        (vendor_id, period_year, period_quarter,
         quality_score, delivery_score, cost_score,
         support_score, compliance_score, documentation_score,
         overall_score, risk_rating, remarks, evaluated_by, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (vendor_id, period_year, period_quarter)
      DO UPDATE SET
        quality_score=$4, delivery_score=$5, cost_score=$6,
        support_score=$7, compliance_score=$8, documentation_score=$9,
        overall_score=$10, risk_rating=$11, remarks=$12, evaluated_by=$13,
        updated_at=NOW()
      RETURNING *
    `, [vendor_id, period_year, period_quarter,
        quality_score, delivery_score, cost_score,
        support_score, compliance_score, documentation_score,
        overall, risk, remarks, actorId, companyId]);
    res.status(201).json(sc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Top vendors by score (for CEO dashboard) ──────────────────────────────────
router.get('/scorecards/top', async (req, res) => {
  try {
    const companyId = cid(req);
    const cFilter = companyId ? `WHERE vs.company_id=${companyId}` : '';
    const { rows } = await pool.query(`
      SELECT v.vendor_name, v.category,
             AVG(vs.overall_score)::numeric(5,2) AS avg_score,
             vs.risk_rating,
             COUNT(vs.id) AS eval_count
      FROM vendor_scorecards vs
      JOIN vendors v ON v.id = vs.vendor_id
      ${cFilter}
      GROUP BY v.vendor_name, v.category, vs.risk_rating
      ORDER BY avg_score DESC LIMIT 10
    `);
    res.json(rows);
  } catch { res.json([]); }
});

export default router;
