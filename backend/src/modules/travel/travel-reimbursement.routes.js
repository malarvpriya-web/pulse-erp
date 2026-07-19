/**
 * travel-reimbursement.routes.js
 * Phase 47 — Expense Claims & Reimbursement Workflow
 *
 * Status flow:
 *   Draft → Submitted → Manager Approved → Accounts Verified → Mgmt Approved → Paid → Closed
 *
 * Approval levels:
 *   1: Reporting Manager
 *   2: Accounts Verification
 *   3: Management Approval
 *   4: Finance Payment
 */
import express from 'express';
import pool from '../shared/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();
const uid = req => req.user?.userId ?? req.user?.id ?? null;
const cid = req => companyOf(req);

// ── Employee self-scoping ─────────────────────────────────────────────────────
// Employees may only see / file their own claims. Ownership is matched on both
// employee_id (employees.id, from the JWT / users.employee_id) and created_by
// (users.id).
const isEmployeeRole = (req) => String(req.user?.role || '').toLowerCase() === 'employee';

async function ownEmployeeId(req) {
  if (req.user?.employee_id != null) return req.user.employee_id;
  const userId = uid(req);
  if (!userId) return null;
  try {
    const { rows } = await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
    return rows[0]?.employee_id ?? null;
  } catch { return null; }
}

// ── Startup schema bootstrap ─────────────────────────────────────────────────
;(async () => {
  try {
    await pool.query(`
      ALTER TABLE expense_claims
        ADD COLUMN IF NOT EXISTS advance_adjusted NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS net_payable      NUMERIC(12,2)
    `);
  } catch (e) { console.warn('[reimbursement] alter expense_claims advance cols:', e.message); }
})();

// Travel type → cost type mapping (Part 8)
const COST_TYPE_MAP = {
  'Sales Visit':            'SALES_TRAVEL',
  'Customer Meeting':       'SALES_TRAVEL',
  'Tender Discussion':      'SALES_TRAVEL',
  'Site Survey':            'SITE_SURVEY',
  'Application Engineering':'APPLICATION_ENGINEERING',
  'Design Discussion':      'APPLICATION_ENGINEERING',
  'FAT Support':            'FAT',
  'Installation':           'INSTALLATION',
  'Commissioning':          'COMMISSIONING',
  'Service Visit':          'SERVICE',
  'AMC Visit':              'AMC',
  'Training':               'TRAINING',
  'Internal Meeting':       'INTERNAL',
};

// Auto-generate claim number
async function nextClaimNumber(companyId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)+1 AS seq FROM expense_claims WHERE company_id=$1`, [companyId]
  );
  const seq = String(rows[0].seq).padStart(4, '0');
  const yr  = new Date().getFullYear();
  return `EC-${yr}-${seq}`;
}

// ── GET /reimbursement/claims ─────────────────────────────────────────────────
router.get('/claims', async (req, res) => {
  try {
    const { employee_id, status, project_id, customer_id, from_date, to_date, limit = 200 } = req.query;
    const companyId = cid(req);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (companyId) { conditions.push(`ec.company_id=$${idx++}`); params.push(companyId); }
    if (isEmployeeRole(req)) {
      // Employees always see only their own claims — any employee_id query
      // param from the client is ignored.
      const eid = await ownEmployeeId(req);
      conditions.push(`(ec.employee_id=$${idx} OR ec.created_by=$${idx + 1})`);
      params.push(eid ?? -1, uid(req) ?? -1);
      idx += 2;
    } else if (employee_id) { conditions.push(`ec.employee_id=$${idx++}`); params.push(employee_id); }
    if (status) { conditions.push(`ec.status=$${idx++}`); params.push(status); }
    if (project_id) { conditions.push(`ec.project_id=$${idx++}`); params.push(project_id); }
    if (customer_id) { conditions.push(`ec.customer_id=$${idx++}`); params.push(customer_id); }
    if (from_date) { conditions.push(`ec.expense_date>=$${idx++}`); params.push(from_date); }
    if (to_date) { conditions.push(`ec.expense_date<=$${idx++}`); params.push(to_date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT ec.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_full_name,
             e.designation, e.department AS emp_department,
             CONCAT(m.first_name,' ',m.last_name) AS manager_name,
             CONCAT(a.first_name,' ',a.last_name) AS accounts_name
      FROM expense_claims ec
      LEFT JOIN employees e ON e.id = ec.employee_id
      LEFT JOIN employees m ON m.id = ec.manager_approved_by
      LEFT JOIN employees a ON a.id = ec.accounts_verified_by
      ${where}
      ORDER BY ec.created_at DESC
      LIMIT ${parseInt(limit)}
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /reimbursement/claims/:id ─────────────────────────────────────────────
router.get('/claims/:id', async (req, res) => {
  try {
    const { rows: [claim] } = await pool.query(`
      SELECT ec.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_full_name,
             e.designation, e.department AS emp_department, e.grade
      FROM expense_claims ec
      LEFT JOIN employees e ON e.id = ec.employee_id
      WHERE ec.id=$1`, [req.params.id]);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });

    if (isEmployeeRole(req)) {
      const eid = await ownEmployeeId(req);
      const owns = (eid != null && claim.employee_id === eid) || claim.created_by === uid(req);
      if (!owns) return res.status(403).json({ error: 'You can only view your own expense claims' });
    }

    const { rows: approvals } = await pool.query(`
      SELECT eca.*, CONCAT(e.first_name,' ',e.last_name) AS approver_name
      FROM expense_claim_approvals eca
      LEFT JOIN employees e ON e.id = eca.approver_id
      WHERE eca.claim_id=$1 ORDER BY level`, [req.params.id]);

    res.json({ ...claim, approvals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /reimbursement/claims ─────────────────────────────────────────────────
router.post('/claims', async (req, res) => {
  try {
    const {
      travel_request_id, employee_id, employee_name, department,
      customer_id, customer_name, project_id, project_number,
      site_id, site_name, opportunity_id, po_number, cost_centre_id,
      expense_date, expense_type, expense_category,
      amount, gst_amount, remarks, bill_number, bill_attachment,
      google_drive_link, vendor_name, over_policy, over_policy_reason,
      borne_by,
    } = req.body;

    const actorId = uid(req);
    const companyId = cid(req);
    // Employees can only file claims for themselves.
    const empId = isEmployeeRole(req) ? ((await ownEmployeeId(req)) ?? null) : employee_id;
    const totalAmount = (Number(amount) || 0) + (Number(gst_amount) || 0);
    const claimNumber = await nextClaimNumber(companyId);
    // Anything unrecognised falls back to 'company' — the reimbursable default,
    // and the only value the pre-split rows could have meant.
    const borneBy = borne_by === 'personal' ? 'personal' : 'company';

    // Look up cost_type from travel_request travel_type
    let costType = null;
    if (travel_request_id) {
      const { rows: [tr] } = await pool.query(
        `SELECT travel_type FROM travel_requests WHERE id=$1`, [travel_request_id]);
      costType = tr ? COST_TYPE_MAP[tr.travel_type] : null;
    }

    // Policy check: look up limit for this expense_type
    let policyLimit = null;
    let policyCompliant = true;
    if (empId && expense_type) {
      const { rows: [emp] } = await pool.query(
        `SELECT grade, designation, department FROM employees WHERE id=$1`, [empId]);
      if (emp) {
        const { rows: [rule] } = await pool.query(`
          SELECT * FROM travel_policy_rules
          WHERE is_active=TRUE AND company_id=$1
            AND (grade=$2 OR role=$3 OR department=$4)
          ORDER BY id LIMIT 1
        `, [companyId, emp.grade || '', emp.designation || '', emp.department || '']);
        if (rule) {
          if (expense_type === 'Accommodation') policyLimit = rule.hotel_limit_per_day;
          else if (expense_type === 'Food') policyLimit = rule.meal_limit_per_day;
          else if (expense_type === 'Travel') policyLimit = rule.local_conveyance_limit;
          else policyLimit = rule.miscellaneous_limit;
          if (policyLimit && policyLimit > 0 && Number(amount) > policyLimit) policyCompliant = false;
        }
      }
    }

    const { rows: [claim] } = await pool.query(`
      INSERT INTO expense_claims
        (claim_number, travel_request_id, employee_id, employee_name, department,
         customer_id, customer_name, project_id, project_number,
         site_id, site_name, opportunity_id, po_number, cost_centre_id,
         expense_date, expense_type, expense_category,
         amount, gst_amount, total_amount,
         remarks, bill_number, bill_attachment, google_drive_link, vendor_name,
         policy_limit, over_policy, over_policy_reason, policy_compliant,
         cost_type, borne_by, status, company_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
              $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,'Draft',$32,$33)
      RETURNING *
    `, [claimNumber, travel_request_id, empId, employee_name, department,
        customer_id, customer_name, project_id, project_number,
        site_id, site_name, opportunity_id, po_number, cost_centre_id,
        expense_date, expense_type, expense_category,
        Number(amount)||0, Number(gst_amount)||0, totalAmount,
        remarks, bill_number, bill_attachment, google_drive_link, vendor_name,
        policyLimit, over_policy || !policyCompliant, over_policy_reason, policyCompliant,
        costType, borneBy, companyId, actorId]);

    logAudit({ userId: actorId, module: 'reimbursement', recordId: claim.id,
      recordType: 'expense_claim', action: 'create', newData: claim });
    res.status(201).json(claim);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /reimbursement/claims/:id ─────────────────────────────────────────────
router.put('/claims/:id', async (req, res) => {
  try {
    const {
      expense_date, expense_type, expense_category,
      amount, gst_amount, remarks, bill_number, bill_attachment,
      google_drive_link, vendor_name, customer_name, project_number, site_name,
      borne_by,
    } = req.body;

    if (isEmployeeRole(req)) {
      const { rows: [existing] } = await pool.query(
        `SELECT employee_id, created_by FROM expense_claims WHERE id=$1`, [req.params.id]);
      const eid = await ownEmployeeId(req);
      const owns = existing &&
        ((eid != null && existing.employee_id === eid) || existing.created_by === uid(req));
      if (!owns) return res.status(403).json({ error: 'You can only edit your own expense claims' });
    }

    const totalAmount = (Number(amount)||0) + (Number(gst_amount)||0);
    const { rows: [updated] } = await pool.query(`
      UPDATE expense_claims SET
        expense_date=$1, expense_type=$2, expense_category=$3,
        amount=$4, gst_amount=$5, total_amount=$6,
        remarks=$7, bill_number=$8, bill_attachment=$9,
        google_drive_link=$10, vendor_name=$11,
        customer_name=$12, project_number=$13, site_name=$14,
        borne_by=COALESCE($15, borne_by),
        updated_at=NOW()
      WHERE id=$16 AND status='Draft' RETURNING *
    `, [expense_date, expense_type, expense_category,
        Number(amount)||0, Number(gst_amount)||0, totalAmount,
        remarks, bill_number, bill_attachment, google_drive_link, vendor_name,
        customer_name, project_number, site_name,
        // Omitting borne_by leaves the stored value alone rather than
        // silently resetting an edited claim back to 'company'.
        borne_by === 'personal' ? 'personal' : borne_by === 'company' ? 'company' : null,
        req.params.id]);
    if (!updated) return res.status(404).json({ error: 'Claim not found or not editable' });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /reimbursement/claims/:id/submit ─────────────────────────────────────
router.post('/claims/:id/submit', async (req, res) => {
  try {
    const actorId = uid(req);

    if (isEmployeeRole(req)) {
      const { rows: [existing] } = await pool.query(
        `SELECT employee_id, created_by FROM expense_claims WHERE id=$1`, [req.params.id]);
      const eid = await ownEmployeeId(req);
      const owns = existing &&
        ((eid != null && existing.employee_id === eid) || existing.created_by === actorId);
      if (!owns) return res.status(403).json({ error: 'You can only submit your own expense claims' });
    }

    const { rows: [claim] } = await pool.query(
      `UPDATE expense_claims SET status='Submitted', submitted_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='Draft' RETURNING *`, [req.params.id]);
    if (!claim) return res.status(400).json({ error: 'Claim not found or already submitted' });

    // Seed level 1 approval row
    await pool.query(`
      INSERT INTO expense_claim_approvals (claim_id, level, level_name, status)
      VALUES ($1, 1, 'Reporting Manager', 'Pending')
      ON CONFLICT DO NOTHING`, [claim.id]);

    notifyWorkflowEvent('submitted', { module: 'ExpenseClaim', recordId: claim.id,
      submitterUserId: claim.employee_id });
    logAudit({ userId: actorId, module: 'reimbursement', recordId: claim.id,
      recordType: 'expense_claim', action: 'submit', newData: claim });
    res.json(claim);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /reimbursement/claims/:id/manager-approve ─────────────────────────────
router.put('/claims/:id/manager-approve',
  allowRoles('admin','super_admin','manager','hr'), async (req, res) => {
  try {
    const { status, remarks } = req.body; // 'Approved' | 'Rejected'
    const actorId = uid(req);
    const { rows: [claim] } = await pool.query(
      `SELECT * FROM expense_claims WHERE id=$1`, [req.params.id]);
    if (!claim || claim.status !== 'Submitted') return res.status(400).json({ error: 'Invalid state' });

    const newStatus = status === 'Approved' ? 'Manager Approved' : 'Manager Rejected';
    await pool.query(`
      UPDATE expense_claims SET status=$1, manager_approved_by=$2, manager_approved_at=NOW(),
        manager_remarks=$3, updated_at=NOW() WHERE id=$4
    `, [newStatus, actorId, remarks, claim.id]);

    await pool.query(`
      UPDATE expense_claim_approvals SET status=$1, approver_id=$2, remarks=$3, actioned_at=NOW()
      WHERE claim_id=$4 AND level=1`, [status, actorId, remarks, claim.id]);

    if (status === 'Approved') {
      await pool.query(`
        INSERT INTO expense_claim_approvals (claim_id, level, level_name, status)
        VALUES ($1, 2, 'Accounts Verification', 'Pending') ON CONFLICT DO NOTHING`, [claim.id]);
    }

    logAudit({ userId: actorId, module: 'reimbursement', recordId: claim.id,
      recordType: 'expense_claim', action: `manager_${status.toLowerCase()}`,
      newData: { status: newStatus, remarks } });
    res.json({ message: `Manager ${status}`, status: newStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /reimbursement/claims/:id/accounts-verify ─────────────────────────────
router.put('/claims/:id/accounts-verify',
  allowRoles('admin','super_admin','finance'), async (req, res) => {
  try {
    const { status, remarks, gst_verified, bill_match_verified, duplicate_checked } = req.body;
    const actorId = uid(req);
    const { rows: [claim] } = await pool.query(
      `SELECT * FROM expense_claims WHERE id=$1`, [req.params.id]);
    if (!claim || claim.status !== 'Manager Approved') return res.status(400).json({ error: 'Invalid state' });

    const newStatus = status === 'Approved' ? 'Accounts Verified' : 'Accounts Rejected';
    await pool.query(`
      UPDATE expense_claims SET status=$1,
        accounts_verified_by=$2, accounts_verified_at=NOW(), accounts_remarks=$3,
        gst_verified=$4, bill_match_verified=$5, duplicate_checked=$6, updated_at=NOW()
      WHERE id=$7
    `, [newStatus, actorId, remarks, gst_verified||false, bill_match_verified||false,
        duplicate_checked||false, claim.id]);

    await pool.query(`
      UPDATE expense_claim_approvals SET status=$1, approver_id=$2, remarks=$3, actioned_at=NOW()
      WHERE claim_id=$4 AND level=2`, [status, actorId, remarks, claim.id]);

    if (status === 'Approved') {
      await pool.query(`
        INSERT INTO expense_claim_approvals (claim_id, level, level_name, status)
        VALUES ($1, 3, 'Management Approval', 'Pending') ON CONFLICT DO NOTHING`, [claim.id]);
    }

    logAudit({ userId: actorId, module: 'reimbursement', recordId: claim.id,
      recordType: 'expense_claim', action: `accounts_${status.toLowerCase()}`,
      newData: { status: newStatus, remarks } });
    res.json({ message: `Accounts ${status}`, status: newStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /reimbursement/claims/:id/mgmt-approve ────────────────────────────────
router.put('/claims/:id/mgmt-approve',
  allowRoles('admin','super_admin'), async (req, res) => {
  try {
    const { status, remarks } = req.body;
    const actorId = uid(req);
    const { rows: [claim] } = await pool.query(
      `SELECT * FROM expense_claims WHERE id=$1`, [req.params.id]);
    if (!claim || claim.status !== 'Accounts Verified') return res.status(400).json({ error: 'Invalid state' });

    const newStatus = status === 'Approved' ? 'Mgmt Approved' : 'Mgmt Rejected';
    await pool.query(`
      UPDATE expense_claims SET status=$1, mgmt_approved_by=$2, mgmt_approved_at=NOW(),
        mgmt_remarks=$3, updated_at=NOW() WHERE id=$4
    `, [newStatus, actorId, remarks, claim.id]);

    await pool.query(`
      UPDATE expense_claim_approvals SET status=$1, approver_id=$2, remarks=$3, actioned_at=NOW()
      WHERE claim_id=$4 AND level=3`, [status, actorId, remarks, claim.id]);

    if (status === 'Approved') {
      await pool.query(`
        INSERT INTO expense_claim_approvals (claim_id, level, level_name, status)
        VALUES ($1, 4, 'Finance Payment', 'Pending') ON CONFLICT DO NOTHING`, [claim.id]);
    }

    logAudit({ userId: actorId, module: 'reimbursement', recordId: claim.id,
      recordType: 'expense_claim', action: `mgmt_${status.toLowerCase()}`,
      newData: { status: newStatus, remarks } });
    res.json({ message: `Management ${status}`, status: newStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /reimbursement/claims/:id/pay ─────────────────────────────────────────
router.put('/claims/:id/pay',
  allowRoles('admin','super_admin','finance'), async (req, res) => {
  try {
    const { payment_ref, payment_date, payment_mode } = req.body;
    const actorId = uid(req);
    const { rows: [claim] } = await pool.query(
      `SELECT * FROM expense_claims WHERE id=$1`, [req.params.id]);
    if (!claim || claim.status !== 'Mgmt Approved') return res.status(400).json({ error: 'Invalid state' });
    // A personal-borne line is recorded so the trip total is complete, but the
    // company never pays it — paying one would contradict the Payable figure
    // the advances grid reports.
    if (claim.borne_by === 'personal') {
      return res.status(400).json({ error: 'This claim is marked personal — it is not reimbursable and cannot be paid.' });
    }

    // Adjust disbursed travel advances against this bill: the advance is subtracted
    // and finance pays only the balance (oldest advance first).
    let advanceAdjusted = 0;
    const claimTotal = Number(claim.total_amount) || 0;
    if (claim.travel_request_id) {
      const { rows: advances } = await pool.query(
        `SELECT id, amount, COALESCE(settled_amount,0) AS settled_amount
         FROM travel_advances
         WHERE travel_request_id=$1 AND status IN ('Disbursed','Partially Settled')
         ORDER BY created_at ASC`,
        [claim.travel_request_id]);

      for (const adv of advances) {
        const outstanding = Number(adv.amount) - Number(adv.settled_amount);
        if (outstanding <= 0 || advanceAdjusted >= claimTotal) continue;
        const deduct = Math.min(outstanding, claimTotal - advanceAdjusted);
        advanceAdjusted += deduct;
        const newSettled = Number(adv.settled_amount) + deduct;
        await pool.query(
          `UPDATE travel_advances SET settled_amount=$1,
             status = CASE WHEN $1 >= amount THEN 'Settled' ELSE 'Partially Settled' END,
             updated_at=NOW()
           WHERE id=$2`,
          [newSettled, adv.id]);
      }
    }
    const netPayable = claimTotal - advanceAdjusted;

    await pool.query(`
      UPDATE expense_claims SET status='Paid',
        payment_ref=$1, payment_date=$2, payment_mode=$3,
        advance_adjusted=$4, net_payable=$5,
        paid_by=$6, paid_at=NOW(), updated_at=NOW() WHERE id=$7
    `, [payment_ref, payment_date, payment_mode, advanceAdjusted, netPayable, actorId, claim.id]);

    await pool.query(`
      UPDATE expense_claim_approvals SET status='Paid', approver_id=$1, actioned_at=NOW()
      WHERE claim_id=$2 AND level=4`, [actorId, claim.id]);

    // Post to project cost transactions (Part 8)
    if (claim.project_id || claim.customer_id) {
      await pool.query(`
        INSERT INTO travel_cost_transactions
          (source_type, source_id, cost_type, customer_id, customer_name,
           project_id, project_number, site_name, employee_id, employee_name,
           amount, gst_amount, transaction_date, posted_by, company_id)
        VALUES ('expense_claim',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [claim.id, claim.cost_type, claim.customer_id, claim.customer_name,
          claim.project_id, claim.project_number, claim.site_name,
          claim.employee_id, claim.employee_name,
          claim.amount, claim.gst_amount, payment_date, actorId, claim.company_id]);
    }

    notifyWorkflowEvent('paid', { module: 'ExpenseClaim', recordId: claim.id,
      submitterUserId: claim.employee_id });
    logAudit({ userId: actorId, module: 'reimbursement', recordId: claim.id,
      recordType: 'expense_claim', action: 'pay',
      newData: { payment_ref, payment_date, payment_mode, advance_adjusted: advanceAdjusted, net_payable: netPayable } });
    res.json({
      message: advanceAdjusted > 0
        ? `Payment posted — ₹${advanceAdjusted.toLocaleString('en-IN')} advance adjusted, net payable ₹${netPayable.toLocaleString('en-IN')}`
        : 'Payment posted and project cost transaction created',
      advance_adjusted: advanceAdjusted,
      net_payable: netPayable,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /reimbursement/dashboard ──────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const companyId = cid(req);
    const employeeId = uid(req);
    const role = req.user?.role || 'employee';

    const cFilter = companyId ? `company_id=${companyId}` : '1=1';

    const [empStats, managerPending, accountsPending, gstRecoverable] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status NOT IN ('Draft')) AS total_submitted,
          COUNT(*) FILTER (WHERE status IN ('Submitted','Manager Approved','Accounts Verified','Mgmt Approved')) AS pending,
          COUNT(*) FILTER (WHERE status='Paid') AS reimbursed,
          COUNT(*) FILTER (WHERE status LIKE '%Rejected%') AS rejected,
          COALESCE(SUM(total_amount) FILTER (WHERE status='Paid'), 0)    AS reimbursed_amount,
          COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('Draft','Paid') AND status NOT LIKE '%Rejected%'), 0) AS pending_amount
        FROM expense_claims WHERE employee_id=$1 AND ${cFilter}
      `, [employeeId]),
      pool.query(`SELECT COUNT(*) FROM expense_claims WHERE status='Submitted' AND ${cFilter}`),
      pool.query(`SELECT COUNT(*) FROM expense_claims WHERE status='Manager Approved' AND ${cFilter}`),
      pool.query(`SELECT COALESCE(SUM(gst_amount),0) AS total FROM expense_claims WHERE gst_verified=TRUE AND status='Paid' AND ${cFilter}`),
    ]);

    const monthlyPaid = await pool.query(`
      SELECT COALESCE(SUM(total_amount),0) AS total
      FROM expense_claims
      WHERE status='Paid' AND DATE_TRUNC('month',paid_at)=DATE_TRUNC('month',NOW()) AND ${cFilter}
    `);

    res.json({
      // Employee view
      total_submitted:    parseInt(empStats.rows[0].total_submitted),
      pending_claims:     parseInt(empStats.rows[0].pending),
      reimbursed_claims:  parseInt(empStats.rows[0].reimbursed),
      rejected_claims:    parseInt(empStats.rows[0].rejected),
      reimbursed_amount:  parseFloat(empStats.rows[0].reimbursed_amount),
      pending_amount:     parseFloat(empStats.rows[0].pending_amount),
      // Manager view
      manager_pending:    parseInt(managerPending.rows[0].count),
      // Accounts view
      accounts_pending:   parseInt(accountsPending.rows[0].count),
      gst_recoverable:    parseFloat(gstRecoverable.rows[0].total),
      monthly_paid:       parseFloat(monthlyPaid.rows[0].total),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /reimbursement/pending-for-approval ────────────────────────────────────
router.get('/pending-for-approval', allowRoles('admin','super_admin','manager','hr','finance'), async (req, res) => {
  try {
    const companyId = cid(req);
    const role = req.user?.role;
    let statusFilter;
    if (role === 'finance') statusFilter = `ec.status IN ('Manager Approved')`;
    else if (role === 'admin' || role === 'super_admin') statusFilter = `ec.status IN ('Accounts Verified')`;
    else statusFilter = `ec.status = 'Submitted'`;

    const cFilter = companyId ? `AND ec.company_id=${companyId}` : '';
    const { rows } = await pool.query(`
      SELECT ec.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_full_name,
             e.designation, e.department AS emp_department
      FROM expense_claims ec
      LEFT JOIN employees e ON e.id = ec.employee_id
      WHERE ${statusFilter} ${cFilter}
      ORDER BY ec.submitted_at ASC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /reimbursement/over-policy ────────────────────────────────────────────
router.get('/over-policy', allowRoles('admin','super_admin','manager','hr','finance'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cFilter = companyId ? `AND ec.company_id=${companyId}` : '';
    const { rows } = await pool.query(`
      SELECT ec.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_full_name,
             e.grade
      FROM expense_claims ec
      LEFT JOIN employees e ON e.id = ec.employee_id
      WHERE ec.over_policy=TRUE ${cFilter}
      ORDER BY ec.created_at DESC LIMIT 50
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /reimbursement/closure-check ──────────────────────────────────────────
router.get('/closure-check', async (req, res) => {
  try {
    const { project_id, opportunity_id, service_ticket_id } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;
    if (project_id) { conditions.push(`project_id=$${idx++}`); params.push(project_id); }
    if (opportunity_id) { conditions.push(`opportunity_id=$${idx++}`); params.push(opportunity_id); }

    if (!conditions.length) return res.json({ canClose: true, blocking: [] });
    const where = conditions.join(' OR ');

    const pending = await pool.query(
      `SELECT COUNT(*) FROM expense_claims
       WHERE (${where}) AND status NOT IN ('Paid','Closed','Manager Rejected','Accounts Rejected','Mgmt Rejected')`,
      params);

    const count = parseInt(pending.rows[0].count);
    res.json({
      canClose: count === 0,
      blocking: count > 0 ? [{ type: 'expense_claims', count }] : [],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /reimbursement/project-cost-summary ────────────────────────────────────
router.get('/project-cost-summary', async (req, res) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.json([]);
    const { rows } = await pool.query(`
      SELECT cost_type,
             COUNT(*) AS count,
             COALESCE(SUM(amount),0) AS total_amount,
             COALESCE(SUM(gst_amount),0) AS total_gst,
             COALESCE(SUM(amount+gst_amount),0) AS grand_total
      FROM travel_cost_transactions
      WHERE project_id=$1
      GROUP BY cost_type ORDER BY grand_total DESC
    `, [project_id]);
    res.json(rows.map(r => ({
      ...r,
      total_amount: parseFloat(r.total_amount),
      total_gst: parseFloat(r.total_gst),
      grand_total: parseFloat(r.grand_total),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
