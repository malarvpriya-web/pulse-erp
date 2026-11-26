/**
 * travel-reimbursement.routes.js
 * Phase 47 — Expense Claims & Reimbursement Workflow
 *
 * THE authoritative claim record (§202): every reimbursement claim — a trip
 * expense filed from Travel → Expense Claims, or a medical / internet / other
 * claim filed from Employee Self-Service → Reimbursements — is one
 * `expense_claims` row, moved through this file and nowhere else. The Approval
 * Center acts through these same endpoints. The old `reimbursement_claims`
 * table (self-service) and Finance's `/finance/expenses` mutations are retired.
 *
 * Status flow:
 *   Draft → Submitted → Manager Approved → Accounts Verified → Mgmt Approved → Paid
 *                ↘ Manager Rejected   ↘ Accounts Rejected   ↘ Mgmt Rejected
 *
 * Who does what (each step is ONE atomic transition from the expected status;
 * a second attempt finds the claim already moved and gets 409):
 *   file / edit / submit   the claimant themself — never on someone's behalf
 *   1 manager approval     the reporting manager or the claim's delegate; HR or an
 *                          admin only when the claimant has no active reporting
 *                          manager (shared/managerApprovalAuthz.js, §203)
 *   2 accounts verification  expense_claims:edit
 *   3 management approval    expense_claims:approve
 *   4 payment                expense_payments:approve
 * Nobody acts on their own claim at any level. Every claim is read and moved
 * inside the caller's company. Reading a colleague's claim takes
 * expense_claims:view, or being their reporting manager / the claim's delegate.
 */
import express from 'express';
import pool from '../shared/db.js';
import { can, rolesOf } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';
import { companyOf } from '../../shared/scope.js';
import { resolveRange, dimension } from '../../shared/dashboardFilters.js';
import { authorizeManagerApproval, DENIED_MESSAGE } from '../../shared/managerApprovalAuthz.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { validateStatutoryProfile } from '../payroll/payrollEligibility.js';
import { policyRuleFor, policyLimitFor, MANDATORY_REPORT_TYPES, todayLocal } from './travelAccess.js';
import { postClaimPayment, TravelGlError } from './travelGl.service.js';
import { resolveLinks, travelClosureBlockers } from './travel.routes.js';

const router = express.Router();
const uid = req => req.user?.userId ?? req.user?.id ?? null;
const cid = req => companyOf(req);
const isId = (v) => /^\d+$/.test(String(v ?? ''));
const NOT_LINKED = 'No employee record is linked to this account';

async function ownEmployeeId(req) {
  if (req.user?.employee_id != null) return req.user.employee_id;
  const userId = uid(req);
  if (!userId) return null;
  try {
    const { rows } = await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
    return rows[0]?.employee_id ?? null;
  } catch { return null; }
}

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

const REJECTED = ['Manager Rejected', 'Accounts Rejected', 'Mgmt Rejected'];
const DECISIONS = ['Approved', 'Rejected'];
// Payment modes that move money into the employee's bank account — these need
// the bank details payroll would need (validateStatutoryProfile).
const BANK_MODES = new Set(['neft', 'rtgs', 'imps', 'bank_transfer', 'bank transfer', 'upi']);

/**
 * Next claim number, EC-<year>-NNNN. claim_number is UNIQUE across ALL
 * companies, and this used to be COUNT(*)+1 within one company — so the second
 * company's first claim collided with the first company's, and a deleted row
 * made the next number repeat. Allocated from the global maximum under a
 * transaction-scoped advisory lock: call inside a transaction.
 */
async function nextClaimNumber(client) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('expense_claims.claim_number'))`);
  const yr = new Date().getFullYear();
  const { rows: [r] } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(substring(claim_number FROM '^EC-${yr}-([0-9]+)$'), '')::int), 0) + 1 AS seq
       FROM expense_claims WHERE claim_number LIKE $1`, [`EC-${yr}-%`]);
  return `EC-${yr}-${String(r.seq).padStart(4, '0')}`;
}

/**
 * The same claim filed twice: the same bill number, or the same expense
 * (date, type, amount) for the same employee, on a claim that has not been
 * rejected. Checked under a per-employee advisory lock so two simultaneous
 * submissions cannot both pass.
 */
async function findDuplicate(client, { employeeId, companyId, billNumber, expenseDate, expenseType, total, excludeId = null }) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('expense_claims.employee'), $1)`, [Number(employeeId)]);
  const { rows: [dup] } = await client.query(
    `SELECT claim_number, status FROM expense_claims
      WHERE employee_id = $1 AND company_id = $2 AND deleted_at IS NULL
        AND status <> ALL($3) AND ($4::int IS NULL OR id <> $4)
        AND ( ($5::text IS NOT NULL AND LOWER(BTRIM(bill_number)) = LOWER(BTRIM($5)))
           OR (expense_date = $6::date AND expense_type = $7 AND total_amount = $8) )
      LIMIT 1`,
    [Number(employeeId), companyId, REJECTED, excludeId, billNumber || null, expenseDate, expenseType, total]);
  return dup || null;
}

/** The claim, inside the caller's company — or null (callers answer 404). */
async function loadClaim(req, id, client = pool, { lock = false } = {}) {
  if (!isId(id)) return null;
  const companyId = cid(req);
  if (companyId == null) return null;
  const { rows: [claim] } = await client.query(
    `SELECT * FROM expense_claims WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
    [Number(id), companyId]);
  return claim || null;
}

/** Is the caller the claimant? (employee record, or the login that filed it) */
async function isClaimant(req, claim) {
  const eid = await ownEmployeeId(req);
  return (eid != null && Number(claim.employee_id) === Number(eid)) ||
         (claim.created_by != null && Number(claim.created_by) === Number(uid(req)));
}

/** May the caller read this claim? Owner, expense_claims:view, or its approver. */
async function canSeeClaim(req, claim) {
  if (await isClaimant(req, claim)) return true;
  if (await can(req, 'expense_claims', 'view')) return true;
  const eid = await ownEmployeeId(req);
  if (eid == null) return false;
  if (claim.delegate_approver_id != null && Number(claim.delegate_approver_id) === Number(eid)) return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM employees WHERE id = $1 AND reporting_manager_id = $2`, [claim.employee_id, eid]);
  return rows.length > 0;
}

const SELF_REVIEW = 'You cannot approve, verify or pay your own claim';

/**
 * Move a claim from `from` to `set.status` in one statement. 0 rows means it is
 * no longer in `from` (someone else acted first) — the caller answers 409.
 */
async function transition(client, claimId, from, set) {
  const cols = Object.keys(set);
  const assigns = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
  const { rows: [row] } = await client.query(
    `UPDATE expense_claims SET ${assigns}, updated_at = NOW()
      WHERE id = $1 AND status = $2 RETURNING *`,
    [claimId, from, ...cols.map(c => set[c])]);
  return row || null;
}

async function recordLevel(client, claimId, level, levelName, { status, approverId, remarks }) {
  await client.query(
    `UPDATE expense_claim_approvals SET status=$1, approver_id=$2, remarks=$3, actioned_at=NOW()
      WHERE claim_id=$4 AND level=$5`, [status, approverId, remarks ?? null, claimId, level]);
}
async function openLevel(client, claimId, level, levelName) {
  await client.query(
    `INSERT INTO expense_claim_approvals (claim_id, level, level_name, status)
     SELECT $1, $2, $3, 'Pending'
      WHERE NOT EXISTS (SELECT 1 FROM expense_claim_approvals WHERE claim_id = $1 AND level = $2)`,
    [claimId, level, levelName]);
}

// ── GET /reimbursement/claims ─────────────────────────────────────────────────
// expense_claims:view → the company's claims (filters apply). Everyone else →
// their own claims plus those they approve at level 1 (their direct reports'
// and claims delegated to them). It used to self-scope the literal 'employee'
// role only, so every other role — sales_exec, store_keeper, … — read every
// claim of the company.
router.get('/claims', async (req, res) => {
  try {
    const { employee_id, status, project_id, customer_id, from_date, to_date, limit = 200 } = req.query;
    const companyId = cid(req);
    if (companyId == null) return res.status(400).json({ error: 'Company context required' });
    const conditions = ['ec.company_id = $1', 'ec.deleted_at IS NULL'];
    const params = [companyId];
    let idx = 2;

    if (await can(req, 'expense_claims', 'view')) {
      if (employee_id) {
        if (!isId(employee_id)) return res.status(400).json({ error: 'Invalid employee id' });
        conditions.push(`ec.employee_id=$${idx++}`); params.push(Number(employee_id));
      }
    } else {
      const eid = await ownEmployeeId(req);
      conditions.push(`(ec.employee_id = $${idx} OR ec.created_by = $${idx + 1}
        OR ec.delegate_approver_id = $${idx}
        OR ec.employee_id IN (SELECT id FROM employees WHERE reporting_manager_id = $${idx}))`);
      params.push(eid ?? -1, uid(req) ?? -1);
      idx += 2;
      if (employee_id) {
        if (!isId(employee_id)) return res.status(400).json({ error: 'Invalid employee id' });
        conditions.push(`ec.employee_id=$${idx++}`); params.push(Number(employee_id));
      }
    }
    if (status) { conditions.push(`ec.status=$${idx++}`); params.push(String(status)); }
    if (project_id) { conditions.push(`ec.project_id=$${idx++}`); params.push(project_id); }
    if (customer_id) { conditions.push(`ec.customer_id=$${idx++}`); params.push(customer_id); }
    if (from_date) { conditions.push(`ec.expense_date>=$${idx++}`); params.push(from_date); }
    if (to_date) { conditions.push(`ec.expense_date<=$${idx++}`); params.push(to_date); }
    const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);

    const { rows } = await pool.query(`
      SELECT ec.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_full_name,
             e.designation, e.department AS emp_department,
             COALESCE(tr.request_number, CASE WHEN tr.id IS NOT NULL THEN 'TR-' || LPAD(tr.id::text,3,'0') END) AS trip_number,
             tr.destination AS trip_destination, tr.travel_type,
             -- manager_approved_by / accounts_verified_by hold the deciding
             -- LOGIN (users.id); joining them straight to employees.id named
             -- whoever's employee number happened to match.
             COALESCE(NULLIF(TRIM(CONCAT(me.first_name,' ',me.last_name)), ''), mu.name) AS manager_name,
             COALESCE(NULLIF(TRIM(CONCAT(ae.first_name,' ',ae.last_name)), ''), au.name) AS accounts_name
      FROM expense_claims ec
      LEFT JOIN employees e ON e.id = ec.employee_id
      LEFT JOIN travel_requests tr ON tr.id = ec.travel_request_id
      LEFT JOIN users mu ON mu.id = ec.manager_approved_by
      LEFT JOIN employees me ON me.id = mu.employee_id
      LEFT JOIN users au ON au.id = ec.accounts_verified_by
      LEFT JOIN employees ae ON ae.id = au.employee_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ec.created_at DESC
      LIMIT ${lim}
    `, params);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Could not load claims' }); }
});

// ── GET /reimbursement/claims/:id ─────────────────────────────────────────────
router.get('/claims/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid claim id' });
    const claim = await loadClaim(req, req.params.id);
    // Another company's claim and a claim the caller may not see read the same.
    if (!claim || !(await canSeeClaim(req, claim))) return res.status(404).json({ error: 'Claim not found' });
    const { rows: [emp] } = await pool.query(
      `SELECT CONCAT(first_name,' ',last_name) AS employee_full_name, designation, department AS emp_department, grade
         FROM employees WHERE id = $1`, [claim.employee_id]);
    const { rows: approvals } = await pool.query(`
      SELECT eca.*, COALESCE(CONCAT(e.first_name,' ',e.last_name), u.email) AS approver_name
      FROM expense_claim_approvals eca
      LEFT JOIN users u ON u.id = eca.approver_id
      LEFT JOIN employees e ON e.id = u.employee_id
      WHERE eca.claim_id=$1 ORDER BY level`, [claim.id]);
    res.json({ ...claim, ...(emp || {}), approvals });
  } catch { res.status(500).json({ error: 'Could not load the claim' }); }
});

// ── Claim body → stored values (shared by create and edit) ────────────────────
// The trip, customer, project and opportunity are LINKS (ids from pickers) —
// they were free text, so no paid claim ever reached a project's cost ledger.
// A trip must be the claimant's own and approved; its customer / project are
// used when the claim names none. The policy limit, over-policy flag and cost
// type are worked out here on create AND on every edit (an edit used to keep
// the flags of the first save).
async function prepareClaim(client, req, b, emp, actorId, companyId) {
  const bad = (status, m) => { const e = new Error(m); e.status = status; throw e; };
  const amount = Number(b.amount);
  const gst = b.gst_amount == null || b.gst_amount === '' ? 0 : Number(b.gst_amount);
  if (!(amount > 0)) bad(400, 'amount must be greater than 0');
  if (!(gst >= 0)) bad(400, 'gst_amount cannot be negative');
  if (!b.expense_type || !String(b.expense_type).trim()) bad(400, 'expense_type is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.expense_date || ''))) bad(400, 'expense_date (YYYY-MM-DD) is required');
  if (String(b.expense_date) > todayLocal()) bad(400, 'The expense date cannot be in the future');

  let tr = null;
  if (b.travel_request_id) {
    if (!isId(b.travel_request_id)) bad(400, 'Invalid travel request id');
    ({ rows: [tr] } = await client.query(
      `SELECT id, travel_type, employee_id, created_by, company_id, status, from_date, to_date,
              customer_id, project_id, opportunity_id, site_name, po_number
         FROM travel_requests WHERE id=$1`, [Number(b.travel_request_id)]));
    const mine = tr && (tr.company_id == null || tr.company_id === companyId) &&
      (Number(tr.employee_id) === Number(emp.id) || Number(tr.created_by) === Number(actorId));
    if (!mine) bad(404, 'Travel request not found');
    if (tr.status !== 'Approved') bad(409, `Claims are filed only against an approved trip — this one is ${tr.status}`);
  }
  const links = await resolveLinks(client, companyId, {
    customer_id: b.customer_id || tr?.customer_id, project_id: b.project_id || tr?.project_id,
    opportunity_id: b.opportunity_id || tr?.opportunity_id,
  });

  const rule = await policyRuleFor(client, companyId, emp, b.expense_date);
  const policyLimit = policyLimitFor(rule, String(b.expense_type));
  const policyCompliant = !(policyLimit && amount > policyLimit);
  const total = Math.round((amount + gst) * 100) / 100;
  return {
    tr, amount, gst, total, policyLimit, policyCompliant,
    costType: tr ? (COST_TYPE_MAP[tr.travel_type] ?? null) : null,
    borneBy: b.borne_by === 'personal' ? 'personal' : 'company',
    ...links,
    site_name: b.site_name || tr?.site_name || null,
    po_number: b.po_number || tr?.po_number || null,
  };
}

// ── POST /reimbursement/claims ─────────────────────────────────────────────────
// Filed for the caller only: employee_id / employee_name / department come from
// the caller's employee record, never the body. Always created as 'Draft'.
router.post('/claims', async (req, res) => {
  const b = req.body || {};
  const companyId = cid(req);
  if (companyId == null) return res.status(400).json({ error: 'Company context required' });
  const empId = await ownEmployeeId(req);
  if (empId == null) return res.status(403).json({ error: NOT_LINKED });
  if (b.employee_id != null && b.employee_id !== '' && String(b.employee_id) !== String(empId)) {
    return res.status(403).json({ error: 'You can only file a claim for yourself' });
  }
  const actorId = uid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [emp] } = await client.query(
      `SELECT id, first_name, last_name, department, grade, designation, company_id
         FROM employees WHERE id = $1 AND deleted_at IS NULL`, [empId]);
    if (!emp || emp.company_id !== companyId) { await client.query('ROLLBACK'); return res.status(403).json({ error: NOT_LINKED }); }
    const c = await prepareClaim(client, req, b, emp, actorId, companyId);

    const dup = await findDuplicate(client, {
      employeeId: empId, companyId, billNumber: b.bill_number ? String(b.bill_number) : null,
      expenseDate: b.expense_date, expenseType: String(b.expense_type), total: c.total,
    });
    if (dup) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'DUPLICATE_CLAIM', error: `This looks like claim ${dup.claim_number} (${dup.status}) filed again — same bill number, or same date, type and amount.` });
    }

    const claimNumber = await nextClaimNumber(client);
    const { rows: [claim] } = await client.query(`
      INSERT INTO expense_claims
        (claim_number, travel_request_id, employee_id, employee_name, department,
         customer_id, customer_name, project_id, project_number,
         site_id, site_name, opportunity_id, po_number, cost_centre_id,
         expense_date, claim_date, expense_type, expense_category,
         amount, gst_amount, total_amount,
         remarks, bill_number, bill_attachment, google_drive_link, vendor_name,
         policy_limit, over_policy, over_policy_reason, policy_compliant,
         cost_type, borne_by, status, company_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,
              $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,'Draft',$32,$33)
      RETURNING *
    `, [claimNumber, c.tr?.id ?? null, empId,
        `${emp.first_name || ''} ${emp.last_name || ''}`.trim(), emp.department || null,
        c.customer_id, c.customer_name, c.project_id, c.project_number,
        null, c.site_name, c.opportunity_id, c.po_number, b.cost_centre_id || null,
        b.expense_date, String(b.expense_type), b.expense_category || null,
        c.amount, c.gst, c.total,
        b.remarks ?? null, b.bill_number || null, b.bill_attachment || null, b.google_drive_link || null, b.vendor_name || null,
        c.policyLimit, !c.policyCompliant, b.over_policy_reason || null, c.policyCompliant,
        c.costType, c.borneBy, companyId, actorId]);
    await client.query('COMMIT');

    logAudit({ userId: actorId, module: 'reimbursement', recordId: claim.id,
      recordType: 'expense_claim', action: 'create', newData: claim, req });
    res.status(201).json(claim);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err?.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Could not save the claim' });
  } finally { client.release(); }
});

// ── PUT /reimbursement/claims/:id ─────────────────────────────────────────────
// The claimant edits their own Draft — or a REJECTED claim, which goes back to
// Draft so it can be corrected and submitted again (a rejected claim used to be
// a dead end). Nobody else edits a claim's content.
router.put('/claims/:id', captureBefore('expense_claims'), async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await loadClaim(req, req.params.id, client, { lock: true });
    if (!claim || !(await isClaimant(req, claim))) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Claim not found or not editable' });
    }
    if (claim.status !== 'Draft' && !REJECTED.includes(claim.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This claim is ${claim.status} and can no longer be edited` });
    }
    const { rows: [emp] } = await client.query(
      `SELECT id, department, grade, designation FROM employees WHERE id = $1`, [claim.employee_id]);
    const merged = { ...claim, expense_date: String(claim.expense_date || '').slice(0, 10), ...b };
    const c = await prepareClaim(client, req, merged, emp, uid(req), claim.company_id);
    const dup = await findDuplicate(client, {
      employeeId: claim.employee_id, companyId: claim.company_id,
      billNumber: merged.bill_number || null, expenseDate: merged.expense_date,
      expenseType: String(merged.expense_type), total: c.total, excludeId: claim.id,
    });
    if (dup) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'DUPLICATE_CLAIM', error: `This would duplicate claim ${dup.claim_number} (${dup.status}).` });
    }

    const { rows: [updated] } = await client.query(`
      UPDATE expense_claims SET
        travel_request_id=$1, expense_date=$2, claim_date=$2, expense_type=$3, expense_category=$4,
        amount=$5, gst_amount=$6, total_amount=$7, remarks=$8, bill_number=$9, bill_attachment=$10,
        google_drive_link=$11, vendor_name=$12, customer_id=$13, customer_name=$14, project_id=$15,
        project_number=$16, opportunity_id=$17, site_name=$18, po_number=$19, borne_by=$20,
        policy_limit=$21, over_policy=$22, over_policy_reason=$23, policy_compliant=$24, cost_type=$25,
        status='Draft', submitted_at=NULL,
        manager_approved_by=NULL, manager_approved_at=NULL, manager_remarks=NULL,
        accounts_verified_by=NULL, accounts_verified_at=NULL, accounts_remarks=NULL,
        mgmt_approved_by=NULL, mgmt_approved_at=NULL, mgmt_remarks=NULL,
        gst_verified=FALSE, bill_match_verified=FALSE, duplicate_checked=FALSE,
        updated_at=NOW()
      WHERE id=$26 AND status=$27 RETURNING *
    `, [c.tr?.id ?? null, merged.expense_date, String(merged.expense_type), merged.expense_category || null,
        c.amount, c.gst, c.total, merged.remarks ?? null, merged.bill_number || null, merged.bill_attachment || null,
        merged.google_drive_link || null, merged.vendor_name || null, c.customer_id, c.customer_name, c.project_id,
        c.project_number, c.opportunity_id, c.site_name, c.po_number, c.borneBy,
        c.policyLimit, !c.policyCompliant, merged.over_policy_reason || null, c.policyCompliant, c.costType,
        claim.id, claim.status]);
    if (!updated) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This claim was acted on by someone else — reload it' });
    }
    // A corrected rejection starts a fresh approval trail.
    if (REJECTED.includes(claim.status)) await client.query(`DELETE FROM expense_claim_approvals WHERE claim_id = $1`, [claim.id]);
    await client.query('COMMIT');
    logAudit({ userId: uid(req), module: 'reimbursement', recordId: claim.id, recordType: 'expense_claim',
      action: REJECTED.includes(claim.status) ? 'reopen' : 'update', oldData: claim, newData: updated, req });
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err?.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Could not update the claim' });
  } finally { client.release(); }
});

// ── DELETE /reimbursement/claims/:id ──────────────────────────────────────────
// The claimant discards their own Draft (soft delete).
router.delete('/claims/:id', async (req, res) => {
  try {
    const claim = await loadClaim(req, req.params.id);
    if (!claim || !(await isClaimant(req, claim))) return res.status(404).json({ error: 'Claim not found' });
    const { rows: [gone] } = await pool.query(
      `UPDATE expense_claims SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'Draft' AND deleted_at IS NULL RETURNING id`, [claim.id]);
    if (!gone) return res.status(409).json({ error: `Only a draft can be deleted — this claim is ${claim.status}` });
    logAudit({ userId: uid(req), module: 'reimbursement', recordId: claim.id, recordType: 'expense_claim', action: 'delete', oldData: claim, req });
    res.json({ message: 'Draft deleted' });
  } catch { res.status(500).json({ error: 'Could not delete the claim' }); }
});

// ── POST /reimbursement/claims/:id/submit ─────────────────────────────────────
router.post('/claims/:id/submit', async (req, res) => {
  try {
    const actorId = uid(req);
    const claim = await loadClaim(req, req.params.id);
    if (!claim || !(await isClaimant(req, claim))) return res.status(404).json({ error: 'Claim not found' });
    if (claim.over_policy && !String(claim.over_policy_reason || '').trim()) {
      return res.status(422).json({ code: 'OVER_POLICY_REASON', error: `This claim is over your policy limit of ₹${Number(claim.policy_limit || 0).toLocaleString('en-IN')} — edit it and give a reason before submitting.` });
    }
    // Visit-type trips need their visit report submitted before the spend is claimed.
    if (claim.travel_request_id) {
      const { rows: [tr] } = await pool.query(
        `SELECT tr.travel_type, EXISTS (SELECT 1 FROM visit_reports vr WHERE vr.travel_request_id = tr.id
                  AND vr.status IN ('Submitted','Completed')) AS has_report
           FROM travel_requests tr WHERE tr.id = $1`, [claim.travel_request_id]);
      if (tr && MANDATORY_REPORT_TYPES.has(tr.travel_type) && !tr.has_report) {
        return res.status(422).json({ code: 'VISIT_REPORT_REQUIRED', error: `A ${tr.travel_type} needs its visit report submitted first (Travel Desk → Visit Reports).` });
      }
    }
    const submitted = await transition(pool, claim.id, 'Draft', { status: 'Submitted', submitted_at: new Date() });
    if (!submitted) return res.status(409).json({ error: `This claim is ${claim.status} — only a draft can be submitted` });
    await openLevel(pool, claim.id, 1, 'Reporting Manager');

    // recipientIds are employees.id — resolved to the claimant's login.
    notifyWorkflowEvent('submitted', { module: 'ExpenseClaim', recordId: claim.id, recipientIds: [claim.employee_id] });
    logAudit({ userId: actorId, module: 'reimbursement', recordId: claim.id,
      recordType: 'expense_claim', action: 'submit', newData: { status: 'Submitted' }, req });
    res.json(submitted);
  } catch { res.status(500).json({ error: 'Could not submit the claim' }); }
});

// One handler shape for the three review levels.
function reviewStep({ level, levelName, from, approved, rejected, nextLevel, byCol, atCol, remarksCol, authorize, action }) {
  return async (req, res) => {
    const { status, remarks } = req.body || {};
    if (!DECISIONS.includes(status)) return res.status(400).json({ error: `status must be one of: ${DECISIONS.join(', ')}` });
    if (status === 'Rejected' && !String(remarks || '').trim()) return res.status(400).json({ error: 'A reason is required to reject a claim' });
    try {
      const actorId = uid(req);
      const claim = await loadClaim(req, req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });
      if (await isClaimant(req, claim)) return res.status(403).json({ error: SELF_REVIEW });
      const allowed = await authorize(req, claim);
      if (allowed !== true) return res.status(403).json({ error: allowed || 'You do not have permission for this step' });
      if (claim.status !== from) return res.status(409).json({ error: `This claim is ${claim.status} — this step needs ${from}` });
      // Accounts verification is the accountant's own check — it used to be
      // sent as "all three verified" by the button itself.
      if (action === 'accounts' && status === 'Approved' && !(req.body.bill_match_verified === true && req.body.duplicate_checked === true)) {
        return res.status(400).json({ error: 'Tick "bill matches the claim" and "checked for duplicates" before verifying' });
      }

      const newStatus = status === 'Approved' ? (typeof approved === 'function' ? approved(claim) : approved) : rejected;
      const client = await pool.connect();
      let moved;
      try {
        await client.query('BEGIN');
        const set = { status: newStatus, [byCol]: actorId, [atCol]: new Date(), [remarksCol]: remarks ?? null };
        if (action === 'accounts') {
          set.gst_verified = !!req.body.gst_verified;
          set.bill_match_verified = !!req.body.bill_match_verified;
          set.duplicate_checked = !!req.body.duplicate_checked;
        }
        moved = await transition(client, claim.id, from, set);
        if (moved) {
          await recordLevel(client, claim.id, level, levelName, { status, approverId: actorId, remarks });
          if (status === 'Approved' && nextLevel && newStatus !== 'Closed') await openLevel(client, claim.id, nextLevel.level, nextLevel.name);
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
      if (!moved) return res.status(409).json({ error: 'This claim was acted on by someone else — reload it' });

      notifyWorkflowEvent(status === 'Approved' ? 'approved' : 'rejected', {
        module: 'ExpenseClaim', recordId: claim.id, recipientIds: [claim.employee_id], comments: remarks });
      logAudit({ userId: actorId, module: 'reimbursement', recordId: claim.id,
        recordType: 'expense_claim', action: `${action}_${status.toLowerCase()}`,
        newData: { status: newStatus, remarks }, req });
      res.json({ message: `${levelName}: ${status}`, status: newStatus });
    } catch { res.status(500).json({ error: 'Could not record the decision' }); }
  };
}

// ── PUT /reimbursement/claims/:id/manager-approve ─────────────────────────────
// Identity-gated (reporting manager / delegate; HR/admin only as the no-manager
// fallback — shared/managerApprovalAuthz.js, §203),
// not a bare role check — claim.employee_id is a real employees.id here.
router.put('/claims/:id/manager-approve', reviewStep({
  level: 1, levelName: 'Reporting Manager', from: 'Submitted',
  approved: 'Manager Approved', rejected: 'Manager Rejected',
  nextLevel: { level: 2, name: 'Accounts Verification' },
  byCol: 'manager_approved_by', atCol: 'manager_approved_at', remarksCol: 'manager_remarks', action: 'manager',
  authorize: async (req, claim) => {
    const auth = await authorizeManagerApproval({
      actorEmployeeId: await ownEmployeeId(req),
      actorRole: req.user?.role,
      actorRoles: rolesOf(req),
      requesterEmployeeId: claim.employee_id,
      delegateApproverId: claim.delegate_approver_id,
    });
    return auth.authorized ? true : DENIED_MESSAGE;
  },
}));

// Delegate this claim's manager-approval to another employee of the company
// (same authorization-to-delegate rule as travel.routes.js's /requests/:id/delegate).
router.post('/claims/:id/delegate', async (req, res) => {
  try {
    const { delegate_employee_id } = req.body || {};
    if (!isId(delegate_employee_id)) return res.status(400).json({ error: 'delegate_employee_id is required' });
    const claim = await loadClaim(req, req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (await isClaimant(req, claim)) return res.status(403).json({ error: 'You cannot choose the approver of your own claim' });
    if (claim.status !== 'Submitted') return res.status(409).json({ error: 'Only a submitted claim can be delegated' });
    const auth = await authorizeManagerApproval({
      actorEmployeeId: await ownEmployeeId(req),
      actorRole: req.user?.role,
      actorRoles: rolesOf(req),
      requesterEmployeeId: claim.employee_id,
      delegateApproverId: claim.delegate_approver_id,
    });
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    if (Number(delegate_employee_id) === Number(claim.employee_id)) return res.status(400).json({ error: 'A claim cannot be delegated to the claimant' });
    const { rows: inCo } = await pool.query(
      `SELECT 1 FROM employees WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`, [Number(delegate_employee_id), claim.company_id]);
    if (!inCo.length) return res.status(404).json({ error: 'Employee not found' });

    const { rows: [updated] } = await pool.query(
      `UPDATE expense_claims SET delegate_approver_id=$1, updated_at=NOW() WHERE id=$2 AND status='Submitted' RETURNING *`,
      [Number(delegate_employee_id), claim.id]);
    if (!updated) return res.status(409).json({ error: 'This claim was acted on by someone else — reload it' });
    logAudit({ userId: uid(req), module: 'reimbursement', recordId: updated.id,
      recordType: 'expense_claim', action: 'delegate', newData: { delegate_employee_id }, req });
    res.json(updated);
  } catch { res.status(500).json({ error: 'Could not delegate the claim' }); }
});

// ── PUT /reimbursement/claims/:id/accounts-verify ─────────────────────────────
// expense_claims:edit. Was allowRoles('admin','super_admin','finance'): the
// legacy 'finance' code only, so finance_manager and accounts_exec — the people
// who actually verify bills — could not.
router.put('/claims/:id/accounts-verify', reviewStep({
  level: 2, levelName: 'Accounts Verification', from: 'Manager Approved',
  approved: 'Accounts Verified', rejected: 'Accounts Rejected',
  nextLevel: { level: 3, name: 'Management Approval' },
  byCol: 'accounts_verified_by', atCol: 'accounts_verified_at', remarksCol: 'accounts_remarks', action: 'accounts',
  authorize: async (req) => (await can(req, 'expense_claims', 'edit')) || 'Accounts verification needs the expense-claims verification permission',
}));

// ── PUT /reimbursement/claims/:id/mgmt-approve ────────────────────────────────
router.put('/claims/:id/mgmt-approve', reviewStep({
  level: 3, levelName: 'Management Approval', from: 'Accounts Verified',
  // A personal-borne line is never paid, so once approved it is finished —
  // it used to wait at 'Mgmt Approved' forever and block project closure.
  approved: (claim) => (claim.borne_by === 'personal' ? 'Closed' : 'Mgmt Approved'), rejected: 'Mgmt Rejected',
  nextLevel: { level: 4, name: 'Finance Payment' },
  byCol: 'mgmt_approved_by', atCol: 'mgmt_approved_at', remarksCol: 'mgmt_remarks', action: 'mgmt',
  authorize: async (req) => (await can(req, 'expense_claims', 'approve')) || 'Management approval needs the expense-claims approval permission',
}));

// ── PUT /reimbursement/claims/:id/pay ─────────────────────────────────────────
// expense_payments:approve. Records a payment made outside Pulse (NEFT / cheque
// / cash reference) — it moves no money and changes no bank record.
// ONE payment per claim: the claim row is locked, must be 'Mgmt Approved', and
// the advance settlement, the claim's Paid status, the level-4 ledger row and
// the project cost transaction are written in one transaction. A second call
// finds the claim 'Paid' and gets 409 — nothing is settled or posted twice.
router.put('/claims/:id/pay', async (req, res) => {
  const { payment_ref, payment_date, payment_mode } = req.body || {};
  if (!String(payment_ref || '').trim()) return res.status(400).json({ error: 'payment_ref is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payment_date || ''))) return res.status(400).json({ error: 'payment_date (YYYY-MM-DD) is required' });
  if (!String(payment_mode || '').trim()) return res.status(400).json({ error: 'payment_mode is required' });
  if (!(await can(req, 'expense_payments', 'approve'))) return res.status(403).json({ error: 'Recording a payment needs the expense-payment permission' });

  const actorId = uid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await loadClaim(req, req.params.id, client, { lock: true });
    if (!claim) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Claim not found' }); }
    if (await isClaimant(req, claim)) { await client.query('ROLLBACK'); return res.status(403).json({ error: SELF_REVIEW }); }
    if (claim.status !== 'Mgmt Approved') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: claim.status === 'Paid' ? `Already paid (ref ${claim.payment_ref})` : `This claim is ${claim.status} — only a management-approved claim can be paid` });
    }
    // A personal-borne line is recorded so the trip total is complete, but the
    // company never pays it.
    if (claim.borne_by === 'personal') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This claim is marked personal — it is not reimbursable and cannot be paid.' });
    }
    // A bank payment needs the bank details payroll needs: present and valid.
    if (BANK_MODES.has(String(payment_mode).trim().toLowerCase())) {
      const { rows: [bank] } = await client.query(`SELECT account_number, ifsc_code FROM employees WHERE id = $1`, [claim.employee_id]);
      const issues = validateStatutoryProfile(bank || {}, {})
        .filter(i => i.severity === 'error' && ['account_number', 'ifsc_code'].includes(i.field));
      if (issues.length) {
        await client.query('ROLLBACK');
        return res.status(422).json({ code: 'BANK_DETAILS_MISSING', error: `Payment blocked: ${issues.map(i => i.message).join('; ')}. HR must complete the employee's bank details.` });
      }
    }

    // Adjust disbursed travel advances against this bill: the advance is
    // subtracted and finance pays only the balance (oldest advance first).
    let advanceAdjusted = 0;
    const claimTotal = Number(claim.total_amount) || 0;
    if (claim.travel_request_id) {
      const { rows: advances } = await client.query(
        `SELECT id, amount, COALESCE(settled_amount,0) AS settled_amount
           FROM travel_advances
          WHERE travel_request_id=$1 AND status IN ('Disbursed','Partially Settled')
          ORDER BY created_at ASC FOR UPDATE`,
        [claim.travel_request_id]);
      for (const adv of advances) {
        const outstanding = Number(adv.amount) - Number(adv.settled_amount);
        if (outstanding <= 0 || advanceAdjusted >= claimTotal) continue;
        const deduct = Math.min(outstanding, claimTotal - advanceAdjusted);
        advanceAdjusted += deduct;
        await client.query(
          `UPDATE travel_advances SET settled_amount=$1,
             status = CASE WHEN $1 >= amount THEN 'Settled' ELSE 'Partially Settled' END,
             updated_at=NOW()
           WHERE id=$2`,
          [Number(adv.settled_amount) + deduct, adv.id]);
      }
    }
    const netPayable = claimTotal - advanceAdjusted;

    const paid = await transition(client, claim.id, 'Mgmt Approved', {
      status: 'Paid', payment_ref: String(payment_ref).trim(), payment_date, payment_mode: String(payment_mode).trim(),
      advance_adjusted: advanceAdjusted, net_payable: netPayable, paid_by: actorId, paid_at: new Date(),
    });
    if (!paid) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This claim was acted on by someone else — reload it' }); }
    await recordLevel(client, claim.id, 4, 'Finance Payment', { status: 'Paid', approverId: actorId, remarks: null });

    // Post it to the books in the same transaction (travelGl.service.js) — a
    // paid claim used to leave no journal entry at all. Refused until Finance
    // has chosen the travel ledger accounts.
    const je = await postClaimPayment(client, claim, { date: payment_date, userId: actorId, advanceAdjusted, netPayable });
    await client.query(`UPDATE expense_claims SET journal_entry_id = $1 WHERE id = $2`, [je.id, claim.id]);

    // Post to project cost transactions (Part 8) — once per claim.
    if (claim.project_id || claim.customer_id) {
      await client.query(`
        INSERT INTO travel_cost_transactions
          (source_type, source_id, cost_type, customer_id, customer_name,
           project_id, project_number, site_name, employee_id, employee_name,
           amount, gst_amount, transaction_date, posted_by, company_id)
        SELECT 'expense_claim',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
         WHERE NOT EXISTS (SELECT 1 FROM travel_cost_transactions WHERE source_type='expense_claim' AND source_id=$1)
      `, [claim.id, claim.cost_type, claim.customer_id, claim.customer_name,
          claim.project_id, claim.project_number, claim.site_name,
          claim.employee_id, claim.employee_name,
          claim.amount, claim.gst_amount, payment_date, actorId, claim.company_id]);
    }
    await client.query('COMMIT');

    notifyWorkflowEvent('paid', { module: 'ExpenseClaim', recordId: claim.id, recipientIds: [claim.employee_id] });
    logAudit({ userId: actorId, module: 'reimbursement', recordId: claim.id,
      recordType: 'expense_claim', action: 'pay',
      newData: { payment_ref, payment_date, payment_mode, advance_adjusted: advanceAdjusted, net_payable: netPayable }, req });
    res.json({
      message: advanceAdjusted > 0
        ? `Payment recorded — ₹${advanceAdjusted.toLocaleString('en-IN')} advance adjusted, net payable ₹${netPayable.toLocaleString('en-IN')}`
        : 'Payment recorded',
      advance_adjusted: advanceAdjusted,
      net_payable: netPayable,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof TravelGlError) return res.status(err.status).json({ code: err.code, error: err.message, problems: err.problems });
    // Ledger guards (closed period, locked date, inactive account) carry a 4xx.
    if (err?.status && err.status < 500) return res.status(err.status).json({ code: err.code, error: err.message });
    res.status(500).json({ error: 'Could not record the payment' });
  } finally { client.release(); }
});

// ── GET /reimbursement/filter-options ─────────────────────────────────────────
// Departments present on claims, for the dashboard filter bar. Not narrowed by
// the active department filter, so the dropdown keeps all its entries.
router.get('/filter-options', async (req, res) => {
  try {
    const companyId = cid(req);
    if (companyId == null) return res.json({ departments: [] });
    const { rows } = await pool.query(
      `SELECT DISTINCT department FROM expense_claims
        WHERE department IS NOT NULL AND TRIM(department) <> '' AND company_id = $1
        ORDER BY department`,
      [companyId]
    );
    res.json({ departments: rows.map(r => r.department) });
  } catch { res.json({ departments: [] }); }
});

// ── GET /reimbursement/dashboard ──────────────────────────────────────────────
// The caller's own figures always; the company queue counts only for holders
// of the matching grant (they were shown to everyone).
router.get('/dashboard', async (req, res) => {
  try {
    const companyId = cid(req);
    if (companyId == null) return res.status(400).json({ error: 'Company context required' });
    // employees.id — this used to compare the users.id with employee_id.
    const employeeId = (await ownEmployeeId(req)) ?? -1;

    // Dashboard filter bar: ?period / ?from / ?to / ?department.
    // Claims are dated by claim_date, falling back to expense_date then
    // created_at for older rows written before claim_date was populated.
    const range = resolveRange(req.query, { defaultPeriod: 'fytd' });
    const department = dimension(req.query, 'department');
    const CLAIM_DATE = `COALESCE(claim_date, expense_date, created_at::date)`;

    const base = [companyId, range.from, range.to, department];
    const scope = `company_id=$1 AND deleted_at IS NULL
      AND ($2::date IS NULL OR ${CLAIM_DATE} >= $2::date)
      AND ($3::date IS NULL OR ${CLAIM_DATE} <= $3::date)
      AND ($4::text IS NULL OR department = $4)`;
    const seesQueue = await can(req, 'expense_claims', 'view');

    const [empStats, managerPending, accountsPending, gstRecoverable, monthlyPaid] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status NOT IN ('Draft')) AS total_submitted,
          COUNT(*) FILTER (WHERE status IN ('Submitted','Manager Approved','Accounts Verified','Mgmt Approved')) AS pending,
          COUNT(*) FILTER (WHERE status='Paid') AS reimbursed,
          COUNT(*) FILTER (WHERE status LIKE '%Rejected%') AS rejected,
          COALESCE(SUM(total_amount) FILTER (WHERE status='Paid'), 0)    AS reimbursed_amount,
          COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('Draft','Paid') AND status NOT LIKE '%Rejected%'), 0) AS pending_amount
        FROM expense_claims WHERE employee_id=$5 AND ${scope}
      `, [...base, employeeId]),
      seesQueue ? pool.query(`SELECT COUNT(*) FROM expense_claims WHERE status='Submitted' AND ${scope}`, base) : null,
      seesQueue ? pool.query(`SELECT COUNT(*) FROM expense_claims WHERE status='Manager Approved' AND ${scope}`, base) : null,
      seesQueue ? pool.query(`SELECT COALESCE(SUM(gst_amount),0) AS total FROM expense_claims WHERE gst_verified=TRUE AND status='Paid' AND ${scope}`, base) : null,
      seesQueue ? pool.query(`SELECT COALESCE(SUM(total_amount),0) AS total FROM expense_claims WHERE status='Paid' AND ${scope}`, base) : null,
    ]);

    res.json({
      period:       range.period,
      period_label: range.label,
      department,
      // Employee view
      total_submitted:    parseInt(empStats.rows[0].total_submitted),
      pending_claims:     parseInt(empStats.rows[0].pending),
      reimbursed_claims:  parseInt(empStats.rows[0].reimbursed),
      rejected_claims:    parseInt(empStats.rows[0].rejected),
      reimbursed_amount:  parseFloat(empStats.rows[0].reimbursed_amount),
      pending_amount:     parseFloat(empStats.rows[0].pending_amount),
      // Queue view (expense_claims:view only)
      manager_pending:    managerPending ? parseInt(managerPending.rows[0].count) : null,
      accounts_pending:   accountsPending ? parseInt(accountsPending.rows[0].count) : null,
      gst_recoverable:    gstRecoverable ? parseFloat(gstRecoverable.rows[0].total) : null,
      monthly_paid:       monthlyPaid ? parseFloat(monthlyPaid.rows[0].total) : null,
    });
  } catch { res.status(500).json({ error: 'Could not load the dashboard' }); }
});

// ── GET /reimbursement/pending-for-approval ────────────────────────────────────
// The claims waiting on the CALLER: level 1 for their direct reports and claims
// delegated to them, level 2 with expense_claims:edit, level 3 with
// expense_claims:approve, level 4 with expense_payments:approve — never their
// own. It used to choose ONE level from the primary role ('finance' → level 2,
// admin → level 3, anyone else → every Submitted claim in the company).
router.get('/pending-for-approval', async (req, res) => {
  try {
    const companyId = cid(req);
    if (companyId == null) return res.json([]);
    const eid = (await ownEmployeeId(req)) ?? -1;
    const [l2, l3, l4] = await Promise.all([
      can(req, 'expense_claims', 'edit'), can(req, 'expense_claims', 'approve'), can(req, 'expense_payments', 'approve'),
    ]);
    const statuses = [...(l2 ? ['Manager Approved'] : []), ...(l3 ? ['Accounts Verified'] : []), ...(l4 ? ['Mgmt Approved'] : [])];
    const { rows } = await pool.query(`
      SELECT ec.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_full_name,
             e.designation, e.department AS emp_department
      FROM expense_claims ec
      LEFT JOIN employees e ON e.id = ec.employee_id
      WHERE ec.company_id = $1 AND ec.deleted_at IS NULL
        AND ec.employee_id IS DISTINCT FROM $2
        AND ( (ec.status = 'Submitted' AND (e.reporting_manager_id = $2 OR ec.delegate_approver_id = $2))
           OR ec.status = ANY($3) )
      ORDER BY ec.submitted_at ASC
    `, [companyId, eid, statuses]);
    // Level 1 also falls to HR / admin when the claimant has no active
    // reporting manager (managerApprovalAuthz) — those claims were decidable
    // but never listed, so nobody saw them waiting.
    const seen = new Set(rows.map(r => r.id));
    const canOverride = rolesOf(req).some(r => ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec'].includes(r));
    const { rows: orphans } = !canOverride ? { rows: [] } : await pool.query(`
      SELECT ec.*, CONCAT(e.first_name,' ',e.last_name) AS employee_full_name, e.designation, e.department AS emp_department
        FROM expense_claims ec LEFT JOIN employees e ON e.id = ec.employee_id
       WHERE ec.company_id = $1 AND ec.deleted_at IS NULL AND ec.status = 'Submitted'
         AND ec.employee_id IS DISTINCT FROM $2
         AND (e.reporting_manager_id IS NULL OR e.reporting_manager_id IS DISTINCT FROM $2)`, [companyId, eid]);
    for (const c of orphans) {
      if (seen.has(c.id)) continue;
      const a = await authorizeManagerApproval({ actorEmployeeId: eid === -1 ? null : eid, actorRole: req.user?.role, actorRoles: rolesOf(req),
        requesterEmployeeId: c.employee_id, delegateApproverId: c.delegate_approver_id });
      if (a.authorized) rows.push(c);
    }
    res.json(rows);
  } catch { res.status(500).json({ error: 'Could not load pending claims' }); }
});

// ── GET /reimbursement/over-policy ────────────────────────────────────────────
router.get('/over-policy', async (req, res) => {
  try {
    const companyId = cid(req);
    if (companyId == null || !(await can(req, 'expense_claims', 'view'))) return res.json([]);
    const { rows } = await pool.query(`
      SELECT ec.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_full_name,
             e.grade
      FROM expense_claims ec
      LEFT JOIN employees e ON e.id = ec.employee_id
      WHERE ec.over_policy=TRUE AND ec.company_id = $1 AND ec.deleted_at IS NULL
      ORDER BY ec.created_at DESC LIMIT 50
    `, [companyId]);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Could not load over-policy claims' }); }
});

// ── GET /reimbursement/closure-check ──────────────────────────────────────────
// Same rule as GET /travel/closure-check and the project / opportunity close
// routes (travel.routes.js travelClosureBlockers).
router.get('/closure-check', async (req, res) => {
  try {
    const blocking = await travelClosureBlockers(cid(req), req.query);
    res.json({ canClose: blocking.length === 0, blocking });
  } catch { res.status(500).json({ error: 'Could not check travel blockers' }); }
});

// ── GET /reimbursement/project-cost-summary ────────────────────────────────────
router.get('/project-cost-summary', async (req, res) => {
  try {
    const { project_id } = req.query;
    const companyId = cid(req);
    if (!project_id || companyId == null) return res.json([]);
    const { rows } = await pool.query(`
      SELECT cost_type,
             COUNT(*) AS count,
             COALESCE(SUM(amount),0) AS total_amount,
             COALESCE(SUM(gst_amount),0) AS total_gst,
             COALESCE(SUM(amount+gst_amount),0) AS grand_total
      FROM travel_cost_transactions
      WHERE project_id=$1 AND company_id = $2
      GROUP BY cost_type ORDER BY grand_total DESC
    `, [project_id, companyId]);
    res.json(rows.map(r => ({
      ...r,
      total_amount: parseFloat(r.total_amount),
      total_gst: parseFloat(r.total_gst),
      grand_total: parseFloat(r.grand_total),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
