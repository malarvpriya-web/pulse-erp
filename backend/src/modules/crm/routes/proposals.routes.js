/**
 * proposals.routes.js
 *
 * Technical Proposal (TP) and Commercial Proposal (CP) as first-class CRM
 * entities in the industrial B2B pipeline:
 *
 *   Opportunity → Technical Proposal → Commercial Proposal → Quotation → SO
 *
 * Mounts under /api/crm
 *   Technical:  GET/POST   /technical-proposals
 *               GET/PUT    /technical-proposals/:id
 *               POST       /technical-proposals/:id/submit
 *               POST       /technical-proposals/:id/approve
 *               POST       /technical-proposals/:id/revise
 *               DELETE     /technical-proposals/:id
 *
 *   Commercial: GET/POST   /commercial-proposals
 *               GET/PUT    /commercial-proposals/:id
 *               POST       /commercial-proposals/:id/items         (line items)
 *               GET        /commercial-proposals/:id/items
 *               POST       /commercial-proposals/:id/submit
 *               POST       /commercial-proposals/:id/approve
 *               POST       /commercial-proposals/:id/revise
 *               POST       /commercial-proposals/:id/create-quotation
 *               DELETE     /commercial-proposals/:id
 */

import express from 'express';
import pool from '../../shared/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import * as drive from '../../../services/googleDrive.service.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

/* ── Helpers ──────────────────────────────────────────────────────────── */
const cid = req => req.scope?.company_id ?? companyOf(req);
const uid = req => req.user?.userId ?? req.user?.id ?? null;

async function nextNumber(prefix, table, col, companyId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ($1::int IS NULL OR company_id=$1)`,
    [companyId]
  );
  const seq = String((rows[0]?.n || 0) + 1).padStart(4, '0');
  const yr  = new Date().getFullYear();
  return `${prefix}-${yr}-${seq}`;
}

async function getCustomerName(accountId) {
  if (!accountId) return null;
  const { rows } = await pool.query(
    `SELECT COALESCE(name, account_name) AS name FROM accounts WHERE id=$1`,
    [accountId]
  );
  return rows[0]?.name || null;
}

/* ════════════════════════════════════════════════════════════════════════
 * TECHNICAL PROPOSALS
 * ════════════════════════════════════════════════════════════════════════ */

router.get('/technical-proposals', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const { opportunity_id, status, search } = req.query;
    let q = `
      SELECT tp.*, e.name AS prepared_by_name,
             a.COALESCE(a.name, a.account_name) AS customer_name,
             o.title AS opportunity_title
      FROM technical_proposals tp
      LEFT JOIN employees e ON e.id = tp.prepared_by
      LEFT JOIN accounts  a ON a.id = tp.account_id
      LEFT JOIN opportunities o ON o.id = tp.opportunity_id
      WHERE tp.deleted_at IS NULL
        AND ($1::int IS NULL OR tp.company_id=$1)`;
    const params = [cid(req)];
    if (opportunity_id) { params.push(opportunity_id); q += ` AND tp.opportunity_id=$${params.length}`; }
    if (status)         { params.push(status);         q += ` AND tp.status=$${params.length}`; }
    if (search)         { params.push(`%${search}%`);  q += ` AND (tp.title ILIKE $${params.length} OR tp.proposal_number ILIKE $${params.length})`; }
    q += ' ORDER BY tp.created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/technical-proposals/:id', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tp.*, e.name AS prepared_by_name,
              rv.name AS reviewed_by_name, ap.name AS approved_by_name,
              COALESCE(a.name, a.account_name) AS customer_name,
              o.title AS opportunity_title
       FROM technical_proposals tp
       LEFT JOIN employees    e  ON e.id  = tp.prepared_by
       LEFT JOIN employees    rv ON rv.id = tp.reviewed_by
       LEFT JOIN employees    ap ON ap.id = tp.approved_by
       LEFT JOIN accounts     a  ON a.id  = tp.account_id
       LEFT JOIN opportunities o  ON o.id  = tp.opportunity_id
       WHERE tp.id=$1 AND tp.deleted_at IS NULL
         AND ($2::int IS NULL OR tp.company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Technical proposal not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/technical-proposals', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const {
      opportunity_id, account_id, title, scope_of_work,
      technical_specs, deliverables, exclusions, assumptions,
      validity_days, prepared_by, notes,
    } = req.body;
    const propNo = await nextNumber('TP', 'technical_proposals', 'proposal_number', companyId);
    const { rows } = await pool.query(
      `INSERT INTO technical_proposals
         (company_id, opportunity_id, account_id, proposal_number, title, status,
          scope_of_work, technical_specs, deliverables, exclusions, assumptions,
          validity_days, prepared_by, notes)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [companyId, opportunity_id||null, account_id||null, propNo, title,
       scope_of_work||null, JSON.stringify(technical_specs||{}),
       JSON.stringify(deliverables||[]), exclusions||null, assumptions||null,
       validity_days||30, prepared_by||uid(req), notes||null]
    );
    // Link to opportunity
    if (opportunity_id) {
      await pool.query(
        `UPDATE opportunities SET tech_proposal_id=$1, updated_at=NOW() WHERE id=$2`,
        [rows[0].id, opportunity_id]
      ).catch(() => {});
    }
    logAudit({ userId: uid(req), module: 'crm', recordId: rows[0].id, recordType: 'technical_proposal', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/technical-proposals/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const {
      title, scope_of_work, technical_specs, deliverables,
      exclusions, assumptions, validity_days, reviewed_by, notes,
    } = req.body;
    const { rows } = await pool.query(
      `UPDATE technical_proposals SET
         title=$1, scope_of_work=$2, technical_specs=$3, deliverables=$4,
         exclusions=$5, assumptions=$6, validity_days=$7,
         reviewed_by=$8, notes=$9, updated_at=NOW()
       WHERE id=$10 AND deleted_at IS NULL
         AND ($11::int IS NULL OR company_id=$11) RETURNING *`,
      [title, scope_of_work||null, JSON.stringify(technical_specs||{}),
       JSON.stringify(deliverables||[]), exclusions||null, assumptions||null,
       validity_days||30, reviewed_by||null, notes||null,
       req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Technical proposal not found' });
    logAudit({ userId: uid(req), module: 'crm', recordId: rows[0].id, recordType: 'technical_proposal', action: 'update', newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/technical-proposals/:id/submit', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE technical_proposals SET status='submitted', submitted_date=CURRENT_DATE, updated_at=NOW()
       WHERE id=$1 AND status='draft' AND deleted_at IS NULL
         AND ($2::int IS NULL OR company_id=$2) RETURNING *`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(422).json({ error: 'Proposal not found or not in draft status' });

    // Auto-upload to Drive under customer folder
    if (drive.isDriveConfigured() && rows[0].account_id) {
      const customerName = await getCustomerName(rows[0].account_id);
      if (customerName) {
        try {
          const driveRes = await drive.uploadJsonRecord({
            data:         rows[0],
            fileName:     `${rows[0].proposal_number}-Technical-Proposal.json`,
            customerName,
            docType:      drive.DOC_TYPES.TECHNICAL_PROPOSAL,
            companyId:    cid(req),
          });
          await pool.query(
            `UPDATE technical_proposals SET drive_file_id=$1, drive_link=$2, updated_at=NOW() WHERE id=$3`,
            [driveRes.drive_file_id, driveRes.drive_link, rows[0].id]
          );
          rows[0].drive_link = driveRes.drive_link;
        } catch (driveErr) {
          console.error('[TP/submit/drive]', driveErr.message);
        }
      }
    }

    logAudit({ userId: uid(req), module: 'crm', recordId: rows[0].id, recordType: 'technical_proposal', action: 'submit', newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/technical-proposals/:id/approve', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE technical_proposals SET status='approved', approved_date=CURRENT_DATE,
         approved_by=$1, updated_at=NOW()
       WHERE id=$2 AND status='submitted' AND deleted_at IS NULL
         AND ($3::int IS NULL OR company_id=$3) RETURNING *`,
      [uid(req), req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(422).json({ error: 'Proposal not found or not in submitted status' });
    logAudit({ userId: uid(req), module: 'crm', recordId: rows[0].id, recordType: 'technical_proposal', action: 'approve', newData: rows[0], req });
    import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
      notifyWorkflowEvent('approved', { module: 'CRM', recordId: rows[0].id, submitterId: uid(req), recipientIds: rows[0].prepared_by ? [rows[0].prepared_by] : [] }).catch(() => {});
    }).catch(() => {});
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/technical-proposals/:id/revise', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const orig = await pool.query(
      `SELECT * FROM technical_proposals WHERE id=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!orig.rows[0]) return res.status(404).json({ error: 'Technical proposal not found' });
    const o = orig.rows[0];
    const propNo = await nextNumber('TP', 'technical_proposals', 'proposal_number', cid(req));
    const { rows } = await pool.query(
      `INSERT INTO technical_proposals
         (company_id, opportunity_id, account_id, proposal_number, title, status, revision,
          original_id, scope_of_work, technical_specs, deliverables, exclusions, assumptions,
          validity_days, prepared_by, notes)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [o.company_id, o.opportunity_id, o.account_id, propNo, o.title,
       (o.revision||1)+1, o.original_id||o.id, o.scope_of_work,
       o.technical_specs, o.deliverables, o.exclusions, o.assumptions,
       o.validity_days, uid(req), req.body.notes||o.notes]
    );
    // Mark original as revised
    await pool.query(`UPDATE technical_proposals SET status='revised', updated_at=NOW() WHERE id=$1`, [o.id]);
    logAudit({ userId: uid(req), module: 'crm', recordId: rows[0].id, recordType: 'technical_proposal', action: 'revise', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/technical-proposals/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE technical_proposals SET deleted_at=NOW() WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * COMMERCIAL PROPOSALS
 * ════════════════════════════════════════════════════════════════════════ */

router.get('/commercial-proposals', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const { opportunity_id, status, search } = req.query;
    let q = `
      SELECT cp.*, e.name AS prepared_by_name,
             COALESCE(a.name, a.account_name) AS customer_name,
             o.title AS opportunity_title, tp.proposal_number AS tech_proposal_number
      FROM commercial_proposals cp
      LEFT JOIN employees          e  ON e.id  = cp.prepared_by
      LEFT JOIN accounts           a  ON a.id  = cp.account_id
      LEFT JOIN opportunities      o  ON o.id  = cp.opportunity_id
      LEFT JOIN technical_proposals tp ON tp.id = cp.technical_proposal_id
      WHERE cp.deleted_at IS NULL
        AND ($1::int IS NULL OR cp.company_id=$1)`;
    const params = [cid(req)];
    if (opportunity_id) { params.push(opportunity_id); q += ` AND cp.opportunity_id=$${params.length}`; }
    if (status)         { params.push(status);         q += ` AND cp.status=$${params.length}`; }
    if (search)         { params.push(`%${search}%`);  q += ` AND (cp.title ILIKE $${params.length} OR cp.proposal_number ILIKE $${params.length})`; }
    q += ' ORDER BY cp.created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/commercial-proposals/:id', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const [propRes, itemsRes] = await Promise.all([
      pool.query(
        `SELECT cp.*, e.name AS prepared_by_name,
                rv.name AS reviewed_by_name, ap.name AS approved_by_name,
                COALESCE(a.name, a.account_name) AS customer_name,
                o.title AS opportunity_title
         FROM commercial_proposals cp
         LEFT JOIN employees   e  ON e.id  = cp.prepared_by
         LEFT JOIN employees   rv ON rv.id = cp.reviewed_by
         LEFT JOIN employees   ap ON ap.id = cp.approved_by
         LEFT JOIN accounts    a  ON a.id  = cp.account_id
         LEFT JOIN opportunities o ON o.id = cp.opportunity_id
         WHERE cp.id=$1 AND cp.deleted_at IS NULL AND ($2::int IS NULL OR cp.company_id=$2)`,
        [req.params.id, cid(req)]
      ),
      pool.query(
        `SELECT * FROM commercial_proposal_items WHERE commercial_proposal_id=$1 ORDER BY line_no`,
        [req.params.id]
      ),
    ]);
    if (!propRes.rows[0]) return res.status(404).json({ error: 'Commercial proposal not found' });
    res.json({ ...propRes.rows[0], items: itemsRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/commercial-proposals', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const {
      opportunity_id, technical_proposal_id, account_id, title,
      equipment_cost, installation_cost, civil_cost, commissioning_cost, amc_cost,
      contingency_pct, tax_percentage, payment_terms, delivery_weeks,
      warranty_months, incoterms, validity_date, notes, prepared_by,
    } = req.body;

    const propNo = await nextNumber('CP', 'commercial_proposals', 'proposal_number', companyId);
    const eqCost   = parseFloat(equipment_cost    || 0);
    const instCost = parseFloat(installation_cost || 0);
    const civCost  = parseFloat(civil_cost        || 0);
    const commCost = parseFloat(commissioning_cost|| 0);
    const amcCost  = parseFloat(amc_cost          || 0);
    const contPct  = parseFloat(contingency_pct   || 0);
    const taxPct   = parseFloat(tax_percentage    || 18);
    const subtotalBeforeCont = eqCost + instCost + civCost + commCost + amcCost;
    const subtotal  = subtotalBeforeCont * (1 + contPct / 100);
    const taxAmt    = subtotal * (taxPct / 100);
    const totalAmt  = subtotal + taxAmt;

    const { rows } = await pool.query(
      `INSERT INTO commercial_proposals
         (company_id, opportunity_id, technical_proposal_id, account_id, proposal_number,
          title, status, equipment_cost, installation_cost, civil_cost, commissioning_cost,
          amc_cost, contingency_pct, tax_percentage, subtotal, tax_amount, total_amount,
          payment_terms, delivery_weeks, warranty_months, incoterms, validity_date,
          prepared_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING *`,
      [companyId, opportunity_id||null, technical_proposal_id||null, account_id||null,
       propNo, title, eqCost, instCost, civCost, commCost, amcCost,
       contPct, taxPct, subtotal, taxAmt, totalAmt,
       payment_terms||null, delivery_weeks||null, warranty_months||12,
       incoterms||null, validity_date||null, prepared_by||uid(req), notes||null]
    );
    if (opportunity_id) {
      await pool.query(
        `UPDATE opportunities SET comm_proposal_id=$1, updated_at=NOW() WHERE id=$2`,
        [rows[0].id, opportunity_id]
      ).catch(() => {});
    }
    logAudit({ userId: uid(req), module: 'crm', recordId: rows[0].id, recordType: 'commercial_proposal', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/commercial-proposals/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const {
      title, equipment_cost, installation_cost, civil_cost, commissioning_cost, amc_cost,
      contingency_pct, tax_percentage, payment_terms, delivery_weeks,
      warranty_months, incoterms, validity_date, reviewed_by, notes,
    } = req.body;
    const eqCost   = parseFloat(equipment_cost    || 0);
    const instCost = parseFloat(installation_cost || 0);
    const civCost  = parseFloat(civil_cost        || 0);
    const commCost = parseFloat(commissioning_cost|| 0);
    const amcCost  = parseFloat(amc_cost          || 0);
    const contPct  = parseFloat(contingency_pct   || 0);
    const taxPct   = parseFloat(tax_percentage    || 18);
    const subtotal = (eqCost + instCost + civCost + commCost + amcCost) * (1 + contPct / 100);
    const taxAmt   = subtotal * (taxPct / 100);
    const totalAmt = subtotal + taxAmt;

    const { rows } = await pool.query(
      `UPDATE commercial_proposals SET
         title=$1, equipment_cost=$2, installation_cost=$3, civil_cost=$4,
         commissioning_cost=$5, amc_cost=$6, contingency_pct=$7, tax_percentage=$8,
         subtotal=$9, tax_amount=$10, total_amount=$11,
         payment_terms=$12, delivery_weeks=$13, warranty_months=$14,
         incoterms=$15, validity_date=$16, reviewed_by=$17, notes=$18, updated_at=NOW()
       WHERE id=$19 AND deleted_at IS NULL AND ($20::int IS NULL OR company_id=$20) RETURNING *`,
      [title, eqCost, instCost, civCost, commCost, amcCost, contPct, taxPct,
       subtotal, taxAmt, totalAmt, payment_terms||null, delivery_weeks||null,
       warranty_months||12, incoterms||null, validity_date||null, reviewed_by||null, notes||null,
       req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Commercial proposal not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Line items
router.get('/commercial-proposals/:id/items', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM commercial_proposal_items WHERE commercial_proposal_id=$1 ORDER BY line_no`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/commercial-proposals/:id/items', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    await pool.query(`DELETE FROM commercial_proposal_items WHERE commercial_proposal_id=$1`, [req.params.id]);
    const inserted = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qty  = parseFloat(it.quantity  || 1);
      const rate = parseFloat(it.rate      || 0);
      const disc = parseFloat(it.discount_pct || 0);
      const tax  = parseFloat(it.tax_pct   || 18);
      const amt  = qty * rate * (1 - disc / 100);
      const { rows } = await pool.query(
        `INSERT INTO commercial_proposal_items
           (commercial_proposal_id, line_no, item_code, description, quantity, unit,
            rate, discount_pct, tax_pct, amount, hsn_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [req.params.id, i+1, it.item_code||null, it.description, qty,
         it.unit||'nos', rate, disc, tax, amt, it.hsn_code||null]
      );
      inserted.push(rows[0]);
    }
    // Recompute totals
    const subtotal = inserted.reduce((s, r) => s + parseFloat(r.amount), 0);
    await pool.query(
      `UPDATE commercial_proposals SET subtotal=$1, updated_at=NOW() WHERE id=$2`,
      [subtotal, req.params.id]
    );
    res.json(inserted);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/commercial-proposals/:id/submit', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE commercial_proposals SET status='submitted', submitted_date=CURRENT_DATE, updated_at=NOW()
       WHERE id=$1 AND status='draft' AND deleted_at IS NULL AND ($2::int IS NULL OR company_id=$2) RETURNING *`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(422).json({ error: 'Not found or not in draft' });

    // Auto-upload to Drive under customer folder
    if (drive.isDriveConfigured() && rows[0].account_id) {
      const customerName = await getCustomerName(rows[0].account_id);
      if (customerName) {
        try {
          const driveRes = await drive.uploadJsonRecord({
            data:         { ...rows[0], items: [] },
            fileName:     `${rows[0].proposal_number}-Commercial-Proposal.json`,
            customerName,
            docType:      drive.DOC_TYPES.COMMERCIAL_PROPOSAL,
            companyId:    cid(req),
          });
          await pool.query(
            `UPDATE commercial_proposals SET drive_file_id=$1, drive_link=$2, updated_at=NOW() WHERE id=$3`,
            [driveRes.drive_file_id, driveRes.drive_link, rows[0].id]
          );
          rows[0].drive_link = driveRes.drive_link;
        } catch (driveErr) { console.error('[CP/submit/drive]', driveErr.message); }
      }
    }
    logAudit({ userId: uid(req), module: 'crm', recordId: rows[0].id, recordType: 'commercial_proposal', action: 'submit', newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/commercial-proposals/:id/approve', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE commercial_proposals SET status='approved', approved_date=CURRENT_DATE,
         approved_by=$1, updated_at=NOW()
       WHERE id=$2 AND status='submitted' AND deleted_at IS NULL AND ($3::int IS NULL OR company_id=$3) RETURNING *`,
      [uid(req), req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(422).json({ error: 'Not found or not in submitted' });
    logAudit({ userId: uid(req), module: 'crm', recordId: rows[0].id, recordType: 'commercial_proposal', action: 'approve', newData: rows[0], req });
    import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
      notifyWorkflowEvent('approved', { module: 'CRM', recordId: rows[0].id, submitterId: uid(req), recipientIds: rows[0].prepared_by ? [rows[0].prepared_by] : [] }).catch(() => {});
    }).catch(() => {});
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/commercial-proposals/:id/revise', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const orig = await pool.query(
      `SELECT * FROM commercial_proposals WHERE id=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!orig.rows[0]) return res.status(404).json({ error: 'Not found' });
    const o = orig.rows[0];
    const propNo = await nextNumber('CP', 'commercial_proposals', 'proposal_number', cid(req));
    const { rows } = await pool.query(
      `INSERT INTO commercial_proposals
         (company_id, opportunity_id, technical_proposal_id, account_id, proposal_number,
          title, status, revision, original_id, equipment_cost, installation_cost, civil_cost,
          commissioning_cost, amc_cost, contingency_pct, tax_percentage, subtotal, tax_amount,
          total_amount, payment_terms, delivery_weeks, warranty_months, incoterms, validity_date,
          prepared_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
      [o.company_id, o.opportunity_id, o.technical_proposal_id, o.account_id,
       propNo, o.title, (o.revision||1)+1, o.original_id||o.id,
       o.equipment_cost, o.installation_cost, o.civil_cost, o.commissioning_cost, o.amc_cost,
       o.contingency_pct, o.tax_percentage, o.subtotal, o.tax_amount, o.total_amount,
       o.payment_terms, o.delivery_weeks, o.warranty_months, o.incoterms, o.validity_date,
       uid(req), req.body.notes||o.notes]
    );
    await pool.query(`UPDATE commercial_proposals SET status='revised', updated_at=NOW() WHERE id=$1`, [o.id]);
    logAudit({ userId: uid(req), module: 'crm', recordId: rows[0].id, recordType: 'commercial_proposal', action: 'revise', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── Convert approved CP → Quotation ────────────────────────────────────
 *  Creates a Quotation pre-filled from the Commercial Proposal and
 *  links the opportunity → quotation.
 */
router.post('/commercial-proposals/:id/create-quotation', requirePermission('sales', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cpRes = await client.query(
      `SELECT cp.*, COALESCE(a.name, a.account_name) AS customer_name
       FROM commercial_proposals cp
       LEFT JOIN accounts a ON a.id = cp.account_id
       WHERE cp.id=$1 AND cp.deleted_at IS NULL AND ($2::int IS NULL OR cp.company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!cpRes.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Commercial proposal not found' }); }
    const cp = cpRes.rows[0];

    // Generate quotation number
    const seqRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM quotations WHERE ($1::int IS NULL OR company_id=$1)`,
      [cp.company_id]
    );
    const seq  = String((seqRes.rows[0]?.n||0)+1).padStart(4,'0');
    const yr   = new Date().getFullYear();
    const qNo  = `QT-${yr}-${seq}`;

    const { rows: qRows } = await client.query(
      `INSERT INTO quotations
         (quotation_number, company_id, customer_id, customer_name, opportunity_id,
          quotation_date, validity_date, subtotal, tax_amount, total_amount, notes, status)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7,$8,$9,$10,'draft') RETURNING *`,
      [qNo, cp.company_id, cp.account_id, cp.customer_name, cp.opportunity_id,
       cp.validity_date, cp.subtotal, cp.tax_amount, cp.total_amount,
       `Generated from Commercial Proposal ${cp.proposal_number}`]
    );

    // Copy line items
    const itemsRes = await client.query(
      `SELECT * FROM commercial_proposal_items WHERE commercial_proposal_id=$1 ORDER BY line_no`,
      [cp.id]
    );
    for (const it of itemsRes.rows) {
      await client.query(
        `INSERT INTO quotation_items (quotation_id, item_description, quantity, rate, tax_percentage, tax_amount, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [qRows[0].id, it.description, it.quantity, it.rate, it.tax_pct,
         it.amount * (it.tax_pct/100), it.amount * (1 + it.tax_pct/100)]
      );
    }

    // Link opportunity → quotation
    if (cp.opportunity_id) {
      await client.query(
        `UPDATE opportunities SET quotation_id=$1, updated_at=NOW() WHERE id=$2`,
        [qRows[0].id, cp.opportunity_id]
      ).catch(() => {});
    }

    await client.query('COMMIT');
    logAudit({ userId: uid(req), module: 'sales', recordId: qRows[0].id, recordType: 'quotation', action: 'create', newData: qRows[0], req });
    res.status(201).json({ quotation: qRows[0], commercial_proposal_id: cp.id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

router.delete('/commercial-proposals/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE commercial_proposals SET deleted_at=NOW() WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
