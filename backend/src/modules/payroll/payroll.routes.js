import express from 'express';
import PDFDocument from 'pdfkit';
import { verifyToken, requirePermission, can } from '../../middlewares/auth.middleware.js';
import pool from '../../config/db.js';
import { planLoan, LoanInputError, installmentFor, remainingInstallments } from './loanSchedule.js';
import { canReadAnyPayroll, ownEmployeeId } from './payrollAccess.js';
import {
  listPayroll,
  getPayrollSummary,
  getEmployeePayslip,
  getPayslipByQuery,
  generatePayroll,
  runPayroll,
  markPaid,
  getPayrollTrend,
  getForm16,
  getCompliance,
  computeSlip,
  generatePdfData,
  streamPayslipPdf,
  emailPayslip,
  bulkGenerateSlips,
  getMyPayslips,
  saveSlip,
  getPayrollHistory,
  getEligibility,
  approvePayroll,
  getForm16Status,
  streamForm16Pdf,
  getPayrollCycle,
  getStatutoryRules,
  addStatutoryRule,
  getReleaseReadiness,
  listRuleChanges,
  decideRuleChange,
} from './payroll.controller.js';
import { companyOf } from '../../shared/scope.js';
import { buildPeriodContext } from './payroll.service.js';
import { computePayroll, PayrollInputError, computeStatutoryBonus, periodEndDate } from './payrollEngine.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { csvCell } from '../../shared/csv.js';
import * as ops from './payroll.service.js';
import * as compliance from './payrollCompliance.service.js';
import * as adjustments from './payrollAdjustments.service.js';
import * as salesIncentive from '../sales/services/salesIncentive.service.js';
import { logAudit } from '../../services/AuditService.js';
import { loadRules as loadRulesForExport, loadRuleRows as loadRuleRowsForBonus, resolveRules as resolveRulesForBonus } from './statutoryRules.js';

const uidOf = (req) => req.user?.userId ?? req.user?.id ?? null;
// One error shape for the routes below (PayrollHttpError carries status + details).
const act = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof ops.PayrollHttpError) return res.status(e.status).json({ success: false, message: e.message, ...(e.details || {}) });
    console.error('[payroll]', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

const router = express.Router();

// ── Bank account numbers (PC-02a PD-16, 04 Nov 26) ──────────────────────────
// Full account numbers go only to employee_bank:view holders — the rule the
// employee APIs already apply (employee.controller.js withBankMasking). The
// payroll list, payslips and register used to hand the full number to every
// payroll:view holder (finance_manager, payroll_admin, …). Everyone else gets
// XXXX + the last four digits, in every JSON response of this router and in
// the register CSV. IFSC is not masked.
const BANK_ACCOUNT_KEYS = new Set(['bank_account', 'account_number']);
export const maskAccountNumber = (v) => {
  if (v == null || v === '') return v;
  const s = String(v).replace(/s/g, '');
  return /^X{4}/.test(s) ? s : `XXXX${s.slice(-4)}`;
};
export function maskBankDeep(v) {
  if (Array.isArray(v)) return v.map(maskBankDeep);
  if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = BANK_ACCOUNT_KEYS.has(k) ? maskAccountNumber(x) : maskBankDeep(x);
    return out;
  }
  return v;
}
const seesFullBank = (req) => (req.user ? can(req, 'employee_bank', 'view') : Promise.resolve(false));
router.use((req, res, next) => {
  const send = res.json.bind(res);
  res.json = (body) => {
    seesFullBank(req).then(full => send(full ? body : maskBankDeep(body))).catch(() => send(maskBankDeep(body)));
    return res;
  };
  next();
});

// ── Access (PC-01, 04 Nov 26) ─────────────────────────────────────────────────
// The permission matrix is the authority for every route below — never a role
// list in code. This router used one list (PAYROLL_READ_ROLES) for every read
// AND write, which gave manager, hr_exec and finance_manager rights the matrix
// denies them. Mapping (PC-01_PERMISSION_MAPPING_PROPOSAL.md §2, §6):
//   payroll:view    reads, previews, payslips/Form 16 of colleagues
//   payroll:add     generate / save runs
//   payroll:edit    arrears and loan entry
//   payroll:export  file downloads (register CSV, PF ECR, ESI challan, statutory bonus)
//   payroll:approve approve a period, approve arrears (Finance: D1)
//   payroll_payment:approve       record a payment with its bank reference (PC-02a; finance_manager,
//                                 admin, super_admin) — never the preparer or approver; retired
//                                 when Finance salary batches arrive (PC-02b)
//   payroll_statutory_config:edit record statutory rule versions / the CTC policy (D3)
const perm = (action) => requirePermission('payroll', action);

// Self-service guard for the PayslipViewer page: a payroll:view holder may look
// up any employee's payslip in their company; everyone else (employee, finance,
// ...) reaches only their own record. Mirrors the ownEmployeeId anti-spoof
// pattern used by travel/service-desk self-service routes.
async function ownPayslipOrForbidden(req, res, next) {
  if (await canReadAnyPayroll(req)) return next();
  req.payslipSelfService = true;

  const ownId = await ownEmployeeId(req);
  if (ownId == null) return res.status(403).json({ success: false, message: 'No employee record linked to this account' });

  const requestedId = req.params.id ?? req.query.employee_id ?? req.body?.employee_id ?? null;
  if (requestedId != null && String(requestedId) !== String(ownId)) {
    return res.status(403).json({ success: false, message: 'You may only view your own payslip' });
  }
  if (req.query && !req.query.employee_id) req.query.employee_id = String(ownId);
  if (req.body && requestedId == null) req.body.employee_id = ownId;
  next();
}

// ── Validation middleware ─────────────────────────────────────────────────────
const validateGenerate = (req, res, next) => {
  const { month, year } = req.body;
  if (!month || !year) {
    return res.status(400).json({ success: false, message: 'month and year are required' });
  }
  if (month < 1 || month > 12) {
    return res.status(400).json({ success: false, message: 'month must be between 1 and 12' });
  }
  if (year < 2000 || year > 2100) {
    return res.status(400).json({ success: false, message: 'year is out of valid range' });
  }
  next();
};

const validateMarkPaid = (req, res, next) => {
  const { month, year } = req.body;
  if (!month || !year) {
    return res.status(400).json({ success: false, message: 'month and year are required' });
  }
  if (!req.params.id || isNaN(Number(req.params.id))) {
    return res.status(400).json({ success: false, message: 'valid employee id is required' });
  }
  // PC-02a PD-1: no payment is recorded without bank evidence. The service
  // checks the format; this refuses the request before anything is looked up.
  if (!String(req.body.reference ?? '').trim()) {
    return res.status(400).json({ success: false, code: 'UTR_REQUIRED', message: 'A bank transaction reference (UTR) is required to record a payment' });
  }
  if (!String(req.body.value_date ?? '').trim()) {
    return res.status(400).json({ success: false, code: 'VALUE_DATE_REQUIRED', message: 'The bank value date is required to record a payment' });
  }
  next();
};

// Segregation of duties on payment (PC-01 D2, PC-02a PD-3): the person who
// recorded a payment may be neither the run's PREPARER (generated_by) nor its
// APPROVER (approved_by) — both hold users.id, compared whatever roles anyone
// holds, administrators included. A run whose preparer or approver is unknown
// cannot be shown to have a separate payer, so it is refused too. Runs the
// service would refuse anyway (not approved, not found) fall through to it.
async function paymentSeparation(req, res, next) {
  const cid = companyOf(req);
  if (cid == null) return res.status(403).json({ success: false, code: 'NO_COMPANY', message: 'No company context for this login' });
  try {
    const { rows: [run] } = await pool.query(
      `SELECT pr.generated_by, pr.approved_by, pr.status FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
        WHERE pr.employee_id = $1 AND pr.month = $2 AND pr.year = $3 AND e.company_id = $4 AND pr.is_test = false`,
      [Number(req.params.id), parseInt(req.body.month, 10), parseInt(req.body.year, 10), cid]);
    if (!run || !['approved', 'paid'].includes(run.status)) return next();
    const payer = req.user?.userId ?? req.user?.id ?? null;
    if (run.generated_by == null) {
      return res.status(409).json({ success: false, code: 'PREPARER_UNKNOWN', message: 'This run has no recorded preparer, so a separate payer cannot be confirmed. Regenerate it before payment.' });
    }
    if (run.approved_by == null) {
      return res.status(409).json({ success: false, code: 'APPROVER_UNKNOWN', message: 'This run has no recorded approver, so a separate payer cannot be confirmed.' });
    }
    if (payer != null && Number(run.generated_by) === Number(payer)) {
      return res.status(403).json({ success: false, code: 'PAYER_IS_PREPARER', message: 'You prepared this payroll run, so you cannot record its payment. Another authorised Finance user must do it.' });
    }
    if (payer != null && Number(run.approved_by) === Number(payer)) {
      return res.status(403).json({ success: false, code: 'PAYER_IS_APPROVER', message: 'You approved this payroll run, so you cannot record its payment. Another authorised Finance user must do it.' });
    }
    next();
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// ── Read ──────────────────────────────────────────────────────────────────────
// List/summary/trend: payroll:view — employees use /my-payslips
router.get('/',                   verifyToken, perm('view'), listPayroll);
router.get('/summary',            verifyToken, perm('view'), getPayrollSummary);
router.get('/trend',              verifyToken, perm('view'), getPayrollTrend);
router.get('/compliance',         verifyToken, perm('view'), getCompliance);
// The ONE eligibility rule (payrollEligibility.js), per employee with reasons.
router.get('/eligibility',        verifyToken, perm('view'), getEligibility);
// Pay-cycle dates (attendance cutoff, pay date) and overdue state for a month.
router.get('/cycle',              verifyToken, perm('view'), getPayrollCycle);
// Release gate: what blocks APPROVAL of a period (settings, statutory rules).
router.get('/release-readiness',  verifyToken, perm('view'), getReleaseReadiness);
// Effective-dated statutory rules: what applies on a date, and its source.
router.get('/statutory-rules',    verifyToken, perm('view'), getStatutoryRules);
// Recording a rule version (incl. the CTC policy) clears release blockers: D3.
router.post('/statutory-rules',   verifyToken, requirePermission('payroll_statutory_config', 'edit'), addStatutoryRule);
// A rule change proposed by one person is confirmed or rejected by another.
router.get('/statutory-rules/changes', verifyToken, perm('view'), listRuleChanges);
router.post('/statutory-rules/changes/:id/confirm', verifyToken, requirePermission('payroll_statutory_config', 'edit'), (req, res) => { req.params.decision = 'confirm'; return decideRuleChange(req, res); });
router.post('/statutory-rules/changes/:id/reject', verifyToken, requirePermission('payroll_statutory_config', 'edit'), (req, res) => { req.params.decision = 'reject'; return decideRuleChange(req, res); });
// Form 16 lifecycle for a FY (must precede /form16/:employeeId).
router.get('/form16-status',      verifyToken, perm('view'), getForm16Status);
// Employee self-service: no permission — controller filters by JWT userId
router.get('/my-payslips',        verifyToken, getMyPayslips);
router.get('/employee/:id',       verifyToken, perm('view'), getEmployeePayslip);
// PayslipViewer self-service: a payroll:view holder can look up any employee,
// everyone else is scoped to their own record by ownPayslipOrForbidden.
router.get('/payslips',           verifyToken, ownPayslipOrForbidden, getPayslipByQuery);
router.get('/payslips/:id',       verifyToken, perm('view'), getEmployeePayslip);
router.get('/form16/:employeeId',   verifyToken, perm('view'), getForm16);
router.get('/form16/:employeeId/pdf', verifyToken, perm('view'), streamForm16Pdf);
// Form No. 123 (formerly 12BA): the statement of perquisites, with the annual certificate.
router.get('/form123/:employeeId', verifyToken, perm('view'), act(async (req, res) => {
  res.json({ success: true, data: await compliance.form123({ company_id: companyOf(req), employee_id: req.params.employeeId, financial_year: req.query.financial_year }) });
}));
router.get('/form123/:employeeId/pdf', verifyToken, perm('view'), act(async (req, res) => {
  const f = await compliance.form123({ company_id: companyOf(req), employee_id: req.params.employeeId, financial_year: req.query.financial_year });
  const status = await getForm16StatusData(companyOf(req), f.financial_year, req.params.employeeId);
  if (!status?.can_generate) return res.status(409).json({ success: false, message: `${f.form} is issued with the annual certificate, which is not ready`, blockers: status?.blockers || [] });
  streamForm123Pdf(res, f);
}));
// Everyone downloads the same server PDF; self-service callers only their own released payslip.
router.get('/payslip-pdf/:id',      verifyToken, ownPayslipOrForbidden, streamPayslipPdf);
router.get('/history/:employeeId',  verifyToken, perm('view'), getPayrollHistory);

// ── Approval workflow ─────────────────────────────────────────────────────────
// POST /payroll/approve — Finance approves a period: pending → approved (D1:
// payroll:approve = admin, super_admin, finance_manager, payroll_admin).
// Blocks on missing/invalid bank or PAN data (payrollEligibility.js), records
// loan repayments and marks this period's arrears paid — see approvePayroll().
// The release gate, PREPARER_UNKNOWN and MAKER_CHECKER live in approvePayroll
// and are unchanged.
router.post('/approve', verifyToken, perm('approve'), approvePayroll);

// ── Write ─────────────────────────────────────────────────────────────────────
router.post('/generate',                verifyToken, perm('add'), validateGenerate, generatePayroll);
router.post('/run',                     verifyToken, perm('add'), validateGenerate, runPayroll);
// Previews compute without writing: view.
router.post('/compute-slip',            verifyToken, perm('view'), computeSlip);
router.post('/save-slip',               verifyToken, perm('add'), saveSlip);
router.post('/generate-pdf-data/:id',   verifyToken, perm('view'), generatePdfData);
router.post('/email-payslip',           verifyToken, ownPayslipOrForbidden, emailPayslip);
router.post('/bulk-generate',           verifyToken, perm('view'), bulkGenerateSlips);
// D2 (temporary until PC-02): explicitly authorised Finance payer, never the preparer.
router.post('/:id/mark-paid',           verifyToken, requirePermission('payroll_payment', 'approve'), validateMarkPaid, paymentSeparation, markPaid);

// ── Go-live controls (2026-11-09) ─────────────────────────────────────────────
// What Generate Payroll would produce now (the confirmation box) — writes nothing.
router.get('/preview-run', verifyToken, perm('view'), act(async (req, res) => {
  res.json({ success: true, data: await ops.previewRun({ company_id: companyOf(req), month: req.query.month, year: req.query.year }) });
}));
// Reopen an approved, unpaid month (reverses the accrual journal).
router.post('/reopen', verifyToken, perm('approve'), act(async (req, res) => {
  const { month, year, reason } = req.body || {};
  const data = await ops.reopenPayroll({ month, year, reason, company_id: companyOf(req), userId: uidOf(req) });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: null, recordType: 'payroll_run', action: 'reopen', newData: { month, year, reason, ...data }, req });
  res.json({ success: true, data, message: `${data.reopened} record(s) back to draft; ${data.journals_reversed} accrual journal(s) reversed` });
}));
// Hold one employee's salary out of approval, or release it.
router.post('/:id/hold', verifyToken, perm('add'), act(async (req, res) => {
  const { month, year, reason, hold = true } = req.body || {};
  if (hold && String(reason || '').trim().length < 5) return res.status(400).json({ success: false, message: 'Give the reason for holding this salary' });
  const data = await ops.setHold({ employee_id: req.params.id, month, year, company_id: companyOf(req), hold: hold !== false });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: data.run_id, recordType: 'payroll_run', action: hold !== false ? 'hold' : 'release_hold', newData: { employee_id: Number(req.params.id), month, year, reason }, req });
  res.json({ success: true, data });
}));
// Delete drafts for a month (or one employee). Approved payroll is never touched.
router.post('/discard', verifyToken, perm('add'), act(async (req, res) => {
  const { month, year, employee_id = null } = req.body || {};
  const data = await ops.discardDrafts({ month, year, employee_id, company_id: companyOf(req) });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: null, recordType: 'payroll_run', action: 'discard_drafts', oldData: { rows: data.rows }, newData: { month, year, employee_id, discarded: data.discarded }, req });
  res.json({ success: true, data: { discarded: data.discarded }, message: `${data.discarded} draft record(s) discarded` });
}));
// One-time earnings and deductions for one employee in one month (§261).
router.get('/adjustments', verifyToken, perm('view'), act(async (req, res) => {
  res.json({ success: true, data: await adjustments.listAdjustments({ company_id: companyOf(req), month: req.query.month, year: req.query.year }) });
}));
router.get('/adjustments/accounts', verifyToken, perm('view'), act(async (req, res) => {
  res.json({ success: true, data: await adjustments.creditAccounts({ company_id: companyOf(req) }) });
}));
router.post('/adjustments', verifyToken, perm('edit'), act(async (req, res) => {
  const b = req.body || {};
  const row = await adjustments.addAdjustment({ company_id: companyOf(req), employee_id: b.employee_id, month: b.month, year: b.year,
    kind: b.kind, label: b.label, amount: b.amount, account_code: b.account_code, reason: b.reason, userId: uidOf(req) });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: row.id, recordType: 'payroll_adjustment', action: 'create', newData: row, req });
  res.status(201).json({ success: true, data: row,
    message: row.draft_needs_regenerate ? 'Saved. Generate the payroll again for this month so the draft includes it.' : 'Saved. It is included when the month is generated.' });
}));
router.delete('/adjustments/:id', verifyToken, perm('edit'), act(async (req, res) => {
  const r = await adjustments.removeAdjustment({ company_id: companyOf(req), id: req.params.id });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: r.removed.id, recordType: 'payroll_adjustment', action: 'delete', oldData: r.removed, req });
  res.json({ success: true, data: { id: r.removed.id },
    message: r.draft_needs_regenerate ? 'Removed. Generate the payroll again for this month so the draft no longer includes it.' : 'Removed.' });
}));
// Yearly sales incentive: each salesperson's target, achievement and slab for a
// financial year, and adding it to a payroll month as a one-time earning.
router.get('/sales-incentives', verifyToken, perm('view'), act(async (req, res) => {
  res.json({ success: true, data: await salesIncentive.incentiveReport({ companyId: companyOf(req), fy: req.query.fy }) });
}));
router.post('/sales-incentives/add', verifyToken, perm('edit'), act(async (req, res) => {
  const b = req.body || {};
  if (companyOf(req) == null) return res.status(400).json({ success: false, message: 'Payroll is per company — select a company first' });
  const ids = Array.isArray(b.employee_ids) ? b.employee_ids.map(Number).filter(Number.isInteger) : null;
  const data = await salesIncentive.addIncentivesToPayroll({ companyId: companyOf(req), fy: Number(b.fy), month: b.month, year: b.year, userId: uidOf(req), employeeIds: ids });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: null, recordType: 'sales_incentive', action: 'add_to_payroll', newData: { fy: b.fy, month: b.month, year: b.year, added: data.added.map(a => ({ employee_id: a.employee_id, amount: a.amount, adjustment_id: a.adjustment_id })) }, req });
  res.json({ success: true, data, message: `${data.added.length} incentive(s) added to payroll${data.skipped.length ? `, ${data.skipped.length} skipped` : ''}. Generate the month again so the drafts include them.` });
}));
// Statutory dues of a month, and payments to the authorities.
router.get('/statutory-dues', verifyToken, perm('view'), act(async (req, res) => {
  res.json({ success: true, data: await compliance.statutoryDues({ company_id: companyOf(req), month: req.query.month, year: req.query.year }) });
}));
router.post('/remittances', verifyToken, requirePermission('payroll_payment', 'approve'), act(async (req, res) => {
  const row = await compliance.recordRemittance({ ...req.body, company_id: companyOf(req), userId: uidOf(req) });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: row.id, recordType: 'payroll_statutory_remittance', action: 'create', newData: row, req });
  res.status(201).json({ success: true, data: row });
}));
// A payment recorded wrongly: its journal is reversed and the levy is due again (§262).
router.put('/remittances/:id/cancel', verifyToken, requirePermission('payroll_payment', 'approve'), act(async (req, res) => {
  const r = await compliance.cancelRemittance({ company_id: companyOf(req), id: req.params.id, reason: req.body?.reason, userId: uidOf(req) });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: r.row.id, recordType: 'payroll_statutory_remittance', action: 'cancel', oldData: r.before, newData: r.row, req });
  res.json({ success: true, data: r.row,
    message: `${r.label} payment record cancelled${r.row.reversal_journal_id ? ' and its journal reversed' : ''}. Record the correct payment now.` });
}));
// Employees who are not PF members (excluded employees, Form 11) — §262.
router.put('/pf-exclusions/:employeeId', verifyToken, perm('edit'), act(async (req, res) => {
  const r = await compliance.setPfExclusion({ ...req.body, employee_id: req.params.employeeId, company_id: companyOf(req), userId: uidOf(req) });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: r.row.id, recordType: 'payroll_pf_exclusion', action: 'create', newData: r.row, req });
  res.status(201).json({ success: true, data: r.row,
    message: `Recorded: no PF from ${req.body.effective_from} (PF wage ₹${Math.round(r.pf_wage).toLocaleString('en-IN')} is above the ₹${r.ceiling.toLocaleString('en-IN')} ceiling). Generate any draft from that month again.` });
}));
router.put('/pf-exclusions/:employeeId/end', verifyToken, perm('edit'), act(async (req, res) => {
  const r = await compliance.endPfExclusion({ ...req.body, employee_id: req.params.employeeId, company_id: companyOf(req), userId: uidOf(req) });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: r.row.id, recordType: 'payroll_pf_exclusion', action: 'end', oldData: r.before, newData: r.row, req });
  res.json({ success: true, data: r.row, message: `PF will be deducted from the month of ${req.body.ended_on}. Generate any draft from that month again.` });
}));
// Tax regime and opening balances.
router.get('/tax-setup', verifyToken, perm('view'), act(async (req, res) => {
  res.json({ success: true, data: await compliance.taxSetup({ company_id: companyOf(req), financial_year: req.query.financial_year }) });
}));
// Only the Finance Manager records a regime (tax_regime:edit, migration 20261111000002).
router.put('/tax-regime/:employeeId', verifyToken, requirePermission('tax_regime', 'edit'), act(async (req, res) => {
  const row = await compliance.setTaxRegime({ ...req.body, employee_id: req.params.employeeId, company_id: companyOf(req), userId: uidOf(req) });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: row.id, recordType: 'employee_tax_regime', action: 'update', newData: row, req });
  res.json({ success: true, data: row });
}));
router.put('/my-tax-regime', verifyToken, act(async (req, res) => {
  const own = await ownEmployeeId(req);
  if (own == null) return res.status(403).json({ success: false, message: 'No employee record linked to this account' });
  // 2026-11-11: Finance records each employee's regime (PUT /tax-regime/:id,
  // Payroll Center → Tax setup). Self-declaring needs self_service:edit, which
  // no role holds since migration 20261111000001.
  if (!(await can(req, 'self_service', 'edit'))) {
    return res.status(403).json({ success: false, message: 'Your tax regime is recorded by Finance. Please tell Finance which regime you choose.' });
  }
  const row = await compliance.setTaxRegime({ ...req.body, employee_id: own, company_id: companyOf(req), userId: uidOf(req), selfService: true });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: row.id, recordType: 'employee_tax_regime', action: 'self_declare', newData: row, req });
  res.json({ success: true, data: row });
}));
router.get('/my-tax-regime', verifyToken, act(async (req, res) => {
  const own = await ownEmployeeId(req);
  if (own == null) return res.status(403).json({ success: false, message: 'No employee record linked to this account' });
  const fy = req.query.financial_year;
  const { employees, financial_year } = await compliance.taxSetup({ company_id: companyOf(req), financial_year: fy });
  const me = employees.find(e => e.employee_id === own);
  res.json({ success: true, data: { financial_year, regime: me?.regime || 'new', declared: !!me?.regime_declared } });
}));
router.put('/opening-balances/:employeeId', verifyToken, perm('edit'), act(async (req, res) => {
  const row = await compliance.setOpeningBalance({ ...req.body, employee_id: req.params.employeeId, company_id: companyOf(req), userId: uidOf(req) });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: row.id, recordType: 'payroll_opening_balance', action: 'update', newData: row, req });
  res.json({ success: true, data: row });
}));
// The salary transfer list for the payer (full account numbers; audited).
router.get('/bank-file', verifyToken, requirePermission('payroll_payment', 'approve'), act(async (req, res) => {
  const f = await compliance.bankFile({ company_id: companyOf(req), month: req.query.month, year: req.query.year });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: null, recordType: 'payroll_bank_file', action: 'export', newData: { month: req.query.month, year: req.query.year, count: f.count, total: f.total }, req });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Salary_transfers_${f.label.replace(' ', '_')}.xlsx"`);
  res.send(f.buffer);
}));

// ── Reports & Exports ─────────────────────────────────────────────────────────

// Report status semantics (PAYROLL_DATA_FLOW_AUDIT.md Part 12).
//   final  = approved + paid — the payroll that was (or will be) paid; the
//            only basis for statutory output and finalised cost.
//   draft  = pending (and legacy 'draft') — preparation figures, may still change.
// Any other status (on_hold, or a legacy/seed value) belongs to neither and is
// counted as excluded. A payroll month has ONE row per employee: regenerating a
// draft rewrites that row, so there are no superseded rows to exclude — the
// unique index uq_payroll_runs_emp_month_year guarantees it.
const REPORT_FINAL = ['approved', 'paid'];
const REPORT_DRAFT = ['pending', 'draft'];
const STATUS_LABEL = {
  pending: 'DRAFT - not approved', draft: 'DRAFT - not approved',
  approved: 'Approved (final)', paid: 'Paid (final)',
};

// GET /payroll/register?month=&year=&basis=final|preparation — payroll register CSV
//   basis=final (default)  approved + paid rows only
//   basis=preparation      approved + paid + drafts, every row labelled
// It used to export every non-test row, drafts included, under one file name.
router.get('/register', verifyToken, perm('export'), async (req, res) => {
  const m   = parseInt(req.query.month) || new Date().getMonth() + 1;
  const y   = parseInt(req.query.year)  || new Date().getFullYear();
  const cid = companyOf(req);
  const basis = req.query.basis || 'final';
  if (!['final', 'preparation'].includes(basis)) return res.status(400).json({ message: "basis must be 'final' or 'preparation'" });
  const statuses = basis === 'final' ? REPORT_FINAL : [...REPORT_FINAL, ...REPORT_DRAFT];
  const monthName = ['','January','February','March','April','May','June',
    'July','August','September','October','November','December'][m];

  try {
    const { rows } = await pool.query(`
      SELECT
        e.office_id          AS emp_code,
        TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
        e.department, e.designation,
        pr.basic, pr.hra,
        COALESCE(pr.conveyance_allowance, 0) AS conveyance,
        COALESCE(pr.medical_allowance, 0)    AS medical,
        COALESCE(pr.special_allowance, 0)    AS special,
        COALESCE(pr.overtime_pay, 0)         AS overtime,
        COALESCE(pr.bonus, 0)                AS bonus,
        pr.gross,
        pr.employee_pf, pr.employer_pf,
        COALESCE(pr.eps, 0)                  AS eps,
        pr.employee_esi, pr.employer_esi,
        pr.professional_tax,
        COALESCE(pr.lwf_employee, 0)         AS lwf_employee,
        pr.tds,
        COALESCE(pr.loan_deduction, 0)       AS loan_deduction,
        pr.total_deductions,
        pr.net_pay,
        pr.lop_days, pr.paid_days, COALESCE(pr.advance_deduction, 0) AS advance_deduction,
        COALESCE(pr.edli_employer, 0) + COALESCE(pr.pf_admin_employer, 0) AS pf_charges,
        COALESCE(pr.night_shift_allowance, 0) AS night_shift_allowance, COALESCE(pr.arrears_amount, 0) AS arrears_amount,
        COALESCE(pr.other_earnings, 0) AS other_earnings, COALESCE(pr.other_deductions, 0) AS other_deductions,
        pr.status,
        COALESCE(pr.payment_mode, '')        AS payment_mode,
        e.account_number AS bank_account, e.ifsc_code
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE pr.month = $1 AND pr.year = $2
        AND e.company_id = $3 AND pr.is_test = false
        AND pr.status = ANY($4::text[])
      ORDER BY e.department, e.first_name
    `, [m, y, cid, statuses]);

    if (!rows.length) {
      return res.status(404).json({ message: basis === 'final'
        ? 'No approved payroll for this period. Approve the payroll, or export with basis=preparation to include drafts.'
        : 'No payroll data found. Generate payroll first.' });
    }

    const headers = [
      'Emp Code','Employee Name','Department','Designation',
      'Basic','HRA','Conveyance','Medical','Special Allowance','Overtime','Bonus','Gross Pay',
      'Emp PF','Emr PF','EPS','Emp ESI','Emr ESI','Prof Tax','LWF','TDS','Loan Deduction',
      'Total Deductions','Net Pay','LOP Days','Status','Payment Mode','Bank Account','IFSC Code',
      // added 2026-11: at the end, so existing column positions do not move
      'Advance Recovery','EDLI + EPF admin (Emr)','Paid Days',
      // added 2026-11-10 (§261), also at the end
      'Night Shift Allowance','Arrears','One-time Earnings','One-time Deductions'
    ];
    // employee_name and designation were quoted but never escaped, and
    // department was not quoted at all — a department containing a comma
    // shifted every salary column after it. `nm`/`fl` keep each field's
    // existing quoting so the register's format is unchanged.
    const nm = v => csvCell(v);
    const fl = v => csvCell(v, { minimal: true });
    const fullBank = await seesFullBank(req);   // PD-16: masked unless employee_bank:view
    const csvRows = rows.map(r => [
      fl(r.emp_code), nm(r.employee_name), fl(r.department), nm(r.designation || ''),
      r.basic, r.hra, r.conveyance, r.medical, r.special, r.overtime, r.bonus, r.gross,
      r.employee_pf, r.employer_pf, r.eps, r.employee_esi, r.employer_esi,
      r.professional_tax, r.lwf_employee, r.tds, r.loan_deduction,
      r.total_deductions, r.net_pay, r.lop_days, fl(STATUS_LABEL[r.status] || r.status), fl(r.payment_mode),
      fl((fullBank ? r.bank_account : maskAccountNumber(r.bank_account)) || ''), fl(r.ifsc_code || ''),
      r.advance_deduction, r.pf_charges, r.paid_days ?? '',
      r.night_shift_allowance, r.arrears_amount, r.other_earnings, r.other_deductions,
    ].join(','));

    const csv = [headers.join(','), ...csvRows].join('\n');
    const drafts = rows.filter(r => REPORT_DRAFT.includes(r.status)).length;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('X-Payroll-Basis', basis);
    res.setHeader('X-Payroll-Draft-Rows', String(drafts));
    res.setHeader('Content-Disposition', `attachment; filename="Payroll_Register_${monthName}_${y}${basis === 'final' ? '_FINAL' : '_PREPARATION_includes_drafts'}.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /payroll/dept-cost?month=&year= — department-wise cost report.
// `departments` / `grand_total` are FINALISED payroll (approved + paid), with
// approved and paid counted apart. Drafts are reported separately under
// `draft` (preparation view), never inside the finalised totals. It used to sum
// every non-test row, so a draft month read as final cost.
router.get('/dept-cost', verifyToken, perm('view'), async (req, res) => {
  const m   = parseInt(req.query.month) || new Date().getMonth() + 1;
  const y   = parseInt(req.query.year)  || new Date().getFullYear();
  const cid = companyOf(req);

  try {
    const { rows } = await pool.query(`
      SELECT
        CASE WHEN pr.status = ANY($4::text[]) THEN 'final'
             WHEN pr.status = ANY($5::text[]) THEN 'draft' ELSE 'excluded' END AS bucket,
        e.department,
        COUNT(*)::INT                         AS employee_count,
        COUNT(*) FILTER (WHERE pr.status = 'approved')::INT AS approved_count,
        COUNT(*) FILTER (WHERE pr.status = 'paid')::INT     AS paid_count,
        ROUND(SUM(pr.gross))::NUMERIC         AS total_gross,
        ROUND(SUM(pr.net_pay))::NUMERIC       AS total_net,
        ROUND(SUM(pr.employee_pf + pr.employer_pf))::NUMERIC AS total_pf,
        ROUND(SUM(pr.employee_esi + pr.employer_esi))::NUMERIC AS total_esi,
        ROUND(SUM(pr.tds))::NUMERIC           AS total_tds,
        ROUND(SUM(pr.professional_tax))::NUMERIC AS total_pt,
        ROUND(SUM(COALESCE(pr.lwf_employee,0) + COALESCE(pr.lwf_employer,0)))::NUMERIC AS total_lwf,
        -- Employer cost of the month = the stored payroll_runs.ctc_monthly
        -- (gross + employer PF + ESI + LWF), the same total the GL payroll
        -- journal posts. total_ctc is kept as the key for existing callers; it
        -- is employer cost, not a contractual CTC.
        ROUND(SUM(pr.ctc_monthly))::NUMERIC AS total_ctc,
        ROUND(SUM(pr.ctc_monthly))::NUMERIC AS total_employer_cost
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE pr.month = $1 AND pr.year = $2
        AND e.company_id = $3 AND pr.is_test = false
      GROUP BY 1, e.department
      ORDER BY total_gross DESC
    `, [m, y, cid, REPORT_FINAL, REPORT_DRAFT]);

    const ZERO = { employee_count: 0, approved_count: 0, paid_count: 0, total_gross: 0, total_net: 0, total_pf: 0, total_esi: 0, total_tds: 0, total_ctc: 0, total_employer_cost: 0 };
    const total = (list) => list.reduce((acc, r) => {
      const out = { ...acc };
      for (const k of Object.keys(ZERO)) out[k] = acc[k] + parseFloat(r[k] || 0);
      return out;
    }, { ...ZERO });
    const strip = ({ bucket: _b, ...r }) => r;
    const finalRows = rows.filter(r => r.bucket === 'final').map(strip);
    const draftRows = rows.filter(r => r.bucket === 'draft').map(({ bucket: _b, approved_count: _a, paid_count: _p, ...r }) => r);
    const excluded = rows.filter(r => r.bucket === 'excluded').reduce((n, r) => n + r.employee_count, 0);

    res.json({
      month: m, year: y,
      basis: 'final', statuses_included: REPORT_FINAL,
      departments: finalRows, grand_total: total(finalRows),
      draft: {
        label: 'Draft payroll — preparation figures, not approved; excluded from the totals above',
        departments: draftRows, grand_total: (({ approved_count: _a, paid_count: _p, ...t }) => t)(total(draftRows)),
      },
      excluded_rows: excluded,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Statutory Filing Exports ──────────────────────────────────────────────────

// GET /payroll/pf-ecr?month=&year= — EPFO ECR 2.0 text file
router.get('/pf-ecr', verifyToken, perm('export'), async (req, res) => {
  const m   = parseInt(req.query.month) || new Date().getMonth() + 1;
  const y   = parseInt(req.query.year)  || new Date().getFullYear();
  const cid = companyOf(req);
  if (cid == null) return res.status(400).json({ message: 'Company context required' });
  try {
    // Finalised runs only. EPF wages are the wages the engine contributed on
    // (Code on SS 50% rule, capped at the ceiling in force) — this used to send
    // raw Basic, and invented "UAN_PENDING_<code>" for members with no UAN.
    const { rows } = await pool.query(`
      SELECT pr.employee_id, pr.gross, pr.basic, pr.pf_contribution_wage, pr.eps_wage,
             pr.employee_pf, COALESCE(pr.eps, 0) AS eps, COALESCE(pr.epf_employer, 0) AS epf_employer,
             pr.lop_days, pr.status, e.first_name, e.last_name, e.uan_number, e.office_id AS employee_code
        FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
       WHERE pr.month = $1 AND pr.year = $2 AND e.company_id = $3 AND pr.is_test = false
         AND pr.employee_pf > 0
         -- A salary on hold is left out of the month's approval, so it is not part
         -- of this month's ECR either (it used to refuse the whole file, §261).
         AND pr.status <> 'on_hold'
       ORDER BY e.first_name, e.last_name`, [m, y, cid]);
    if (!rows.length) return res.status(404).json({ message: 'No PF contributions for this period. Generate and approve payroll first.' });
    const notFinal = rows.filter(r => !['approved', 'paid'].includes(r.status));
    if (notFinal.length) return res.status(409).json({ message: `Payroll for this period is not approved (${notFinal.length} draft record(s)). The ECR is built from approved payroll only.` });
    const missingUan = rows.filter(r => !/^[0-9]{12}$/.test(String(r.uan_number || '').trim()));
    if (missingUan.length) {
      return res.status(422).json({ message: `${missingUan.length} PF member(s) have no valid 12-digit UAN — the ECR cannot be filed until they do.`,
        employees: missingUan.map(r => ({ employee_code: r.employee_code, name: `${r.first_name || ''} ${r.last_name || ''}`.trim() })) });
    }
    if (rows.some(r => r.pf_contribution_wage == null)) {
      return res.status(409).json({ message: 'Some approved runs predate PF-wage tracking (2026-10-20). Regenerate is not possible for approved payroll; prepare this ECR manually.' });
    }
    // EPFO ECR text file: 11 fields separated by #~#, no header row.
    const { values: ecrRules } = await loadRulesForExport(pool, cid, `${y}-${String(m).padStart(2, '0')}-28`);
    const lines = rows.map(r => [
      String(r.uan_number).trim(),
      `${r.first_name || ''} ${r.last_name || ''}`.trim().toUpperCase(),
      Math.round(Number(r.gross)), Math.round(Number(r.pf_contribution_wage)),
      // EDLI wages never exceed the ceiling, even when PF is paid on full wages.
      Math.round(Number(r.eps_wage || 0)), Math.round(Math.min(Number(r.pf_contribution_wage), ecrRules['pf.wage_ceiling'])),
      Math.round(Number(r.employee_pf)), Math.round(Number(r.eps)), Math.round(Number(r.epf_employer)),
      Math.round(Number(r.lop_days || 0)), 0,
    ].join('#~#'));
    const monthName = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m];
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="PF_ECR_${monthName}_${y}.txt"`);
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /payroll/esi-challan?month=&year= — ESI challan CSV
router.get('/esi-challan', verifyToken, perm('export'), async (req, res) => {
  const m   = parseInt(req.query.month) || new Date().getMonth() + 1;
  const y   = parseInt(req.query.year)  || new Date().getFullYear();
  const cid = companyOf(req);

  try {
    const { rows } = await pool.query(`
      SELECT
        pr.employee_id,
        COALESCE(pr.esi_wage, pr.gross) AS gross_wages,
        pr.employee_esi,
        pr.employer_esi,
        e.first_name, e.last_name,
        e.office_id         AS employee_code,
        COALESCE(e.esic_number, '') AS ip_number
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE pr.month = $1 AND pr.year = $2
        AND pr.employee_esi > 0
        AND e.company_id = $3 AND pr.is_test = false
        AND pr.status IN ('approved', 'paid')
      ORDER BY e.first_name, e.last_name
    `, [m, y, cid]);

    if (!rows.length) return res.status(404).json({ message: 'No ESI-applicable employees for this period.' });
    const noIp = rows.filter(r => !/^[0-9]{10}$/.test(String(r.ip_number || '').trim()));
    if (noIp.length) {
      return res.status(422).json({ message: `${noIp.length} employee(s) have no valid 10-digit ESI IP number — the challan cannot be filed until they do.`,
        employees: noIp.map(r => ({ employee_code: r.employee_code, name: `${r.first_name || ''} ${r.last_name || ''}`.trim() })) });
    }
    const { values: esiRules } = await loadRulesForExport(pool, cid, `${y}-${String(m).padStart(2, '0')}-28`);

    const monthName = ['', 'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'][m];
    const fileName = `ESI_Challan_${monthName}_${y}.csv`;

    const totEmpESI  = rows.reduce((s, r) => s + parseFloat(r.employee_esi || 0), 0);
    const totEmrESI  = rows.reduce((s, r) => s + parseFloat(r.employer_esi || 0), 0);
    const totESI     = totEmpESI + totEmrESI;

    const csvLines = [
      `ESI Challan - ${monthName} ${y}`,
      ``,
      `IP Number,Employee Code,Employee Name,ESI Wages,Employee ESI (${esiRules['esi.employee_rate']}%),Employer ESI (${esiRules['esi.employer_rate']}%),Total ESI`,
      ...rows.map(r => {
        const name = `${r.first_name || ''} ${r.last_name || ''}`.trim();
        return `${csvCell(r.ip_number, { minimal: true })},${csvCell(r.employee_code || r.employee_id, { minimal: true })},${csvCell(name)},${parseFloat(r.gross_wages || 0).toFixed(2)},${parseFloat(r.employee_esi || 0).toFixed(2)},${parseFloat(r.employer_esi || 0).toFixed(2)},${(parseFloat(r.employee_esi || 0) + parseFloat(r.employer_esi || 0)).toFixed(2)}`;
      }),
      ``,
      `TOTAL,,,${rows.reduce((s, r) => s + parseFloat(r.gross_wages || 0), 0).toFixed(2)},${totEmpESI.toFixed(2)},${totEmrESI.toFixed(2)},${totESI.toFixed(2)}`,
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csvLines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Statutory Bonus (Payment of Bonus Act 1965 / Code on Wages s.26) ─────────
// GET /payroll/statutory-bonus?year=&department=
// Eligibility limit, calculation ceiling and rates: rule 'bonus.statutory' on the
// last day of the bonus year; the minimum wage: rule 'wages.minimum_monthly' at
// each month's end. Wage basis: Basic (no DA in this model). Bonus year = Apr–Mar.
// Each month counts the wage actually earned that month — payrollEngine
// computeStatutoryBonus (§261).
router.get('/statutory-bonus', verifyToken, perm('export'), async (req, res) => {
  const bonusYear = parseInt(req.query.year) || new Date().getFullYear();
  const dept      = req.query.department;
  const cid       = companyOf(req);
  if (cid == null) return res.status(400).json({ message: 'Company context required' });
  const fyStart   = bonusYear, fyEnd = bonusYear + 1;
  try {
    let q = `
      SELECT pr.employee_id,
             TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
             e.office_id AS emp_code, e.department, e.designation,
             json_agg(json_build_object('month', pr.month, 'year', pr.year, 'wage', pr.basic,
               'worked_days', CASE WHEN pr.paid_days IS NULL THEN NULL ELSE GREATEST(pr.paid_days - COALESCE(pr.lop_days, 0), 0) END)
               ORDER BY pr.year, pr.month) AS months
        FROM payroll_runs pr
        JOIN employees e ON e.id = pr.employee_id
       WHERE ((pr.year = $1 AND pr.month >= 4) OR (pr.year = $2 AND pr.month <= 3))
         AND e.company_id = $3 AND pr.is_test = false AND pr.status IN ('approved', 'paid')`;
    const params = [fyStart, fyEnd, cid];
    if (dept) { params.push(dept); q += ` AND e.department = $${params.length}`; }
    q += ` GROUP BY pr.employee_id, e.first_name, e.last_name, e.office_id, e.department, e.designation ORDER BY e.first_name`;
    const { rows } = await pool.query(q, params);

    const ruleRows = await loadRuleRowsForBonus(pool, cid);
    const bonusRule = resolveRulesForBonus(`${fyEnd}-03-31`, ruleRows).values['bonus.statutory'];
    const minWage = new Map();
    const minWageOf = (m, y) => {
      const k = `${y}-${m}`;
      if (!minWage.has(k)) minWage.set(k, resolveRulesForBonus(periodEndDate(m, y), ruleRows).values['wages.minimum_monthly'] ?? null);
      return minWage.get(k);
    };

    const result = rows.map(r => {
      const b = computeStatutoryBonus(r.months, bonusRule, minWageOf);
      return {
        employee_id: r.employee_id, employee_name: r.employee_name, emp_code: r.emp_code,
        department: r.department, designation: r.designation,
        months_worked: b.months_worked, worked_days: b.worked_days,
        avg_basic: b.avg_wage, eligible: b.eligible, reason: b.eligible ? null : b.reasons.join('; '),
        bonus_wages: b.eligible ? b.bonus_wages : 0,
        min_bonus: b.min_bonus, max_bonus: b.max_bonus, recommended_bonus: b.min_bonus,
      };
    });
    const minWageAtEnd = minWageOf(3, fyEnd);
    res.json({
      financial_year: `${fyStart}-${fyEnd}`,
      total_employees: result.length,
      eligible_count: result.filter(r => r.eligible).length,
      total_min_bonus: result.reduce((s, r) => s + r.min_bonus, 0),
      total_max_bonus: result.reduce((s, r) => s + r.max_bonus, 0),
      bonus_wage_ceiling: bonusRule.wage_eligibility,
      calc_wage_ceiling: Math.max(bonusRule.calc_ceiling, minWageAtEnd ?? 0),
      calc_ceiling_basis: minWageAtEnd != null && minWageAtEnd > bonusRule.calc_ceiling
        ? `the minimum wage (₹${Number(minWageAtEnd).toLocaleString('en-IN')}), higher than ₹${Number(bonusRule.calc_ceiling).toLocaleString('en-IN')}`
        : `₹${Number(bonusRule.calc_ceiling).toLocaleString('en-IN')}${minWageAtEnd == null ? ' (no minimum wage recorded)' : ''}`,
      employees: result,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Arrears / Retro Pay ───────────────────────────────────────────────────────
//
// Arrears = (pay at the new Basic) − (pay at the old Basic) for each past month,
// computed by the SAME engine, structure, settings and statutory rules that
// month was paid under. The previous calculator assumed HRA 40% + Special 15%
// for everyone, PF on Basic only and a flat 10% TDS, and nothing ever paid the
// result: no code read payroll_arrears when generating payroll. Now an approved
// arrear with paid_in_month/year is added to that month's run as a one-time
// earning (taxed once, not annualised) with its PF differential, and is marked
// paid when that run is approved.

async function computeArrearBreakdown({ company_id, employee_id, fm, fy, tm, ty, oldB, newB }) {
  const months = [];
  let m = fm, y = fy;
  while (y * 100 + m <= ty * 100 + tm) {
    months.push({ month: m, year: y });
    m += 1; if (m === 13) { m = 1; y += 1; }
    if (months.length > 24) throw Object.assign(new Error('Arrears range is limited to 24 months'), { status: 400 });
  }
  const breakdown = [];
  for (const p of months) {
    const ctx = await buildPeriodContext({ company_id, month: p.month, year: p.year, employee_id });
    const item = ctx.items[0];
    if (!item) throw Object.assign(new Error('Employee not found'), { status: 404 });
    if (!item.config.structureComponents) throw Object.assign(new Error('No salary structure applies'), { status: 422 });
    const cfg = { ...item.config, overtime_hours: 0, night_shift_days: 0, bonus: 0, recoveries: [], adjustments: [], arrears: null, ytd: null, tds_auto_calculate: false };
    try {
      // Arrears compare two BASICS through the structure. An approved CTC
      // breakdown on the revision in force would otherwise override both
      // Basics and report zero arrears.
      const a = computePayroll({ ...item.emp, breakdown: null, basic_salary: oldB }, cfg);
      const b = computePayroll({ ...item.emp, breakdown: null, basic_salary: newB }, cfg);
      breakdown.push({ ...p, gross_diff: b.gross - a.gross, basic_diff: b.basic - a.basic,
        employee_pf_diff: b.employee_pf - a.employee_pf, employer_pf_diff: b.employer_pf - a.employer_pf,
        employee_esi_diff: b.employee_esi - a.employee_esi });
    } catch (e) {
      if (!(e instanceof PayrollInputError)) throw e;
      breakdown.push({ ...p, gross_diff: 0, basic_diff: 0, employee_pf_diff: 0, employer_pf_diff: 0, employee_esi_diff: 0, note: e.message });
    }
  }
  const sum = (k) => breakdown.reduce((t, r) => t + r[k], 0);
  return { months, breakdown, total_arrear: sum('gross_diff'), employee_pf_diff: sum('employee_pf_diff'),
    employer_pf_diff: sum('employer_pf_diff'), employee_esi_diff: sum('employee_esi_diff') };
}

async function employeeInCompany(employeeId, cid) {
  const { rows } = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [employeeId, cid]);
  return rows.length > 0;
}

// GET /payroll/arrears/compute — preview (no DB write)
router.get('/arrears/compute', verifyToken, perm('view'), async (req, res) => {
  const { employee_id, from_month, from_year, to_month, to_year, old_basic, new_basic } = req.query;
  if (!employee_id || !from_month || !from_year || !old_basic || !new_basic) {
    return res.status(400).json({ message: 'employee_id, from_month, from_year, old_basic, new_basic required' });
  }
  const cid = companyOf(req);
  if (cid == null) return res.status(400).json({ message: 'Company context required' });
  const oldB = parseFloat(old_basic), newB = parseFloat(new_basic);
  if (!(newB > oldB)) return res.status(400).json({ message: 'new_basic must be greater than old_basic' });
  try {
    if (!(await employeeInCompany(employee_id, cid))) return res.status(404).json({ message: 'Employee not found' });
    const r = await computeArrearBreakdown({
      company_id: cid, employee_id: parseInt(employee_id),
      fm: parseInt(from_month), fy: parseInt(from_year),
      tm: parseInt(to_month) || new Date().getMonth() + 1, ty: parseInt(to_year) || new Date().getFullYear(),
      oldB, newB,
    });
    res.json({
      employee_id: parseInt(employee_id), old_basic: oldB, new_basic: newB, basic_diff: newB - oldB,
      months_count: r.months.length,
      total_arrear: r.total_arrear,
      employee_pf_diff: r.employee_pf_diff, employer_pf_diff: r.employer_pf_diff, employee_esi_diff: r.employee_esi_diff,
      // TDS is not estimated here: the arrear is taxed in the month it is paid,
      // on top of that month's projected income (one-time earning).
      tds_on_arrear: null,
      tds_note: 'TDS is computed in the payout month as a one-time earning',
      month_breakdown: r.breakdown,
    });
  } catch (err) { res.status(err.status || 500).json({ message: err.message }); }
});

// GET /payroll/arrears — list arrears
router.get('/arrears', verifyToken, perm('view'), async (req, res) => {
  const cid = companyOf(req);
  const { employee_id, status } = req.query;
  try {
    let q = `
      SELECT a.*, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
             e.office_id AS employee_code, e.department
        FROM payroll_arrears a JOIN employees e ON e.id = a.employee_id
       WHERE e.company_id = $1 AND a.is_test = false`;
    const params = [cid];
    if (employee_id) { params.push(parseInt(employee_id)); q += ` AND a.employee_id = $${params.length}`; }
    if (status)      { params.push(status);                q += ` AND a.status = $${params.length}`; }
    q += ' ORDER BY a.created_at DESC LIMIT 200';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /payroll/arrears — raise an arrear (status pending)
router.post('/arrears', verifyToken, perm('edit'), async (req, res) => {
  const { employee_id, arrear_type = 'salary_revision', from_month, from_year,
          to_month, to_year, old_basic, new_basic, arrear_amount, reason } = req.body;
  const cid = companyOf(req);
  if (cid == null) return res.status(400).json({ message: 'Company context required' });
  if (!employee_id || !from_month || !from_year) {
    return res.status(400).json({ message: 'employee_id, from_month, from_year required' });
  }
  try {
    if (!(await employeeInCompany(employee_id, cid))) return res.status(404).json({ message: 'Employee not found' });
    let amount, eePf = 0, erPf = 0;
    if (arrear_type === 'salary_revision') {
      // Never trust a client-side figure for a revision arrear — recompute it.
      const oldB = parseFloat(old_basic), newB = parseFloat(new_basic);
      if (!(newB > oldB)) return res.status(400).json({ message: 'A salary-revision arrear needs new_basic > old_basic' });
      const r = await computeArrearBreakdown({ company_id: cid, employee_id: parseInt(employee_id),
        fm: parseInt(from_month), fy: parseInt(from_year), tm: parseInt(to_month || from_month), ty: parseInt(to_year || from_year), oldB, newB });
      amount = r.total_arrear; eePf = r.employee_pf_diff; erPf = r.employer_pf_diff;
    } else {
      amount = parseFloat(arrear_amount);
      if (!(amount > 0)) return res.status(400).json({ message: 'arrear_amount must be > 0' });
      if (!String(reason || '').trim()) return res.status(400).json({ message: 'reason is required for a non-revision arrear' });
    }
    const { rows } = await pool.query(`
      INSERT INTO payroll_arrears
        (employee_id, company_id, arrear_type, from_month, from_year, to_month, to_year,
         old_basic, new_basic, arrear_amount, tds_on_arrear, net_arrear, employee_pf_diff, employer_pf_diff, reason, created_by, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,0,$10::numeric,$11,$12,$13,$14,'pending') RETURNING *`,
      [employee_id, cid, arrear_type, from_month, from_year, to_month || from_month, to_year || from_year,
       old_basic || 0, new_basic || 0, amount, eePf, erPf, reason || null, req.user?.userId ?? null]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// PUT /payroll/arrears/:id/approve — approve and schedule into a payroll month
router.put('/arrears/:id/approve', verifyToken, perm('approve'), captureBefore('payroll_arrears'), async (req, res) => {
  const pm = parseInt(req.body.paid_in_month), py = parseInt(req.body.paid_in_year);
  const cid = companyOf(req);
  if (!(pm >= 1 && pm <= 12) || !(py > 2000)) return res.status(400).json({ message: 'paid_in_month and paid_in_year are required' });
  try {
    const { rows: [locked] } = await pool.query(
      `SELECT 1 FROM payroll_runs pr JOIN payroll_arrears a ON a.employee_id = pr.employee_id
        WHERE a.id = $1 AND pr.month = $2 AND pr.year = $3 AND pr.status IN ('approved','paid')`, [req.params.id, pm, py]);
    if (locked) return res.status(409).json({ message: 'Payroll for that month is already approved — schedule the arrear into an open month' });
    const { rows } = await pool.query(`
      UPDATE payroll_arrears a
         SET status = 'approved', approved_by = $1, approved_at = NOW(), paid_in_month = $2, paid_in_year = $3, updated_at = NOW()
        FROM employees e
       WHERE a.id = $4 AND e.id = a.employee_id AND e.company_id = $5 AND a.status = 'pending' AND a.is_test = false
       RETURNING a.*`, [req.user?.userId ?? null, pm, py, req.params.id, cid]);
    if (!rows.length) return res.status(404).json({ message: 'Pending arrear not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /payroll/arrears/:id/cancel {reason} — withdraw an arrear that has not been
// paid. A pending one needs payroll:edit (who raised it); an approved, scheduled
// one needs payroll:approve. A paid arrear is part of a finalised month and is
// corrected in a later month instead. A draft that included it no longer matches
// and is generated again (DRAFT_OUT_OF_DATE). §261.
router.put('/arrears/:id/cancel', verifyToken, perm('edit'), captureBefore('payroll_arrears'), act(async (req, res) => {
  const cid = companyOf(req);
  if (cid == null) return res.status(400).json({ success: false, message: 'Company context required' });
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) return res.status(400).json({ success: false, message: 'Give the reason for cancelling this arrear (at least 5 characters)' });
  const { rows: [a] } = await pool.query(
    `SELECT a.id, a.status, a.employee_id, a.paid_in_month, a.paid_in_year FROM payroll_arrears a JOIN employees e ON e.id = a.employee_id
      WHERE a.id = $1 AND e.company_id = $2 AND a.is_test = false`, [req.params.id, cid]);
  if (!a) return res.status(404).json({ success: false, message: 'Arrear not found' });
  if (a.status === 'paid') return res.status(409).json({ success: false, message: 'This arrear has been paid in an approved payroll. Correct it with a recovery in a later month.' });
  if (a.status === 'cancelled') return res.status(409).json({ success: false, message: 'This arrear is already cancelled' });
  if (a.status === 'approved' && !(await can(req, 'payroll', 'approve'))) {
    return res.status(403).json({ success: false, message: 'This arrear is approved; cancelling it needs the payroll approval permission' });
  }
  if (a.status === 'approved' && a.paid_in_month) {
    const { rows: [locked] } = await pool.query(
      `SELECT status FROM payroll_runs WHERE employee_id = $1 AND month = $2 AND year = $3 AND status IN ('approved','paid') AND is_test = false`,
      [a.employee_id, a.paid_in_month, a.paid_in_year]);
    if (locked) return res.status(409).json({ success: false, message: 'The payroll month it is scheduled into is already approved. Reopen that month first, or correct it in a later month.' });
  }
  const { rows: [row] } = await pool.query(
    `UPDATE payroll_arrears SET status = 'cancelled', cancelled_by = $2, cancelled_at = NOW(), cancel_reason = $3, updated_at = NOW()
      WHERE id = $1 AND status IN ('pending', 'approved') RETURNING *`, [a.id, uidOf(req), reason]);
  if (!row) return res.status(409).json({ success: false, message: 'The arrear changed meanwhile — reload and try again' });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: row.id, recordType: 'payroll_arrear', action: 'cancel',
    oldData: { status: a.status }, newData: { status: 'cancelled', reason }, req });
  res.json(row);
}));

// ── Loan / Advance management ─────────────────────────────────────────────────
// The month's recovery is loanSchedule.installmentFor() — the same function the
// payroll draft and approval use. Run Payroll deducts it; APPROVAL records it in
// payroll_loan_repayments and reduces the principal outstanding (closing the
// loan at zero). Test/seed loans (is_test) are never listed or recovered.
// PAYROLL_DATA_FLOW_AUDIT.md Part 11.
const withRemaining = (l) => ({ ...l, remaining_installments: remainingInstallments(l), next_installment: installmentFor(l) });

router.get('/loan-advances', verifyToken, perm('view'), async (req, res) => {
  const status = ['active', 'closed', 'all'].includes(req.query.status) ? req.query.status : 'active';
  try {
    const { rows } = await pool.query(
      `SELECT l.*, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
              e.office_id AS employee_code,
              COALESCE((SELECT SUM(r.amount) FROM payroll_loan_repayments r WHERE r.loan_id = l.id), 0) AS repaid_amount,
              (SELECT COUNT(*)::int FROM payroll_loan_repayments r WHERE r.loan_id = l.id AND r.source = 'payroll') AS installments_paid
         FROM payroll_loans l JOIN employees e ON e.id = l.employee_id
        WHERE e.company_id = $1 AND ($2 = 'all' OR l.status = $2) AND l.is_test = false
        ORDER BY l.created_at DESC`, [companyOf(req), status]);
    res.json(rows.map(withRemaining));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/loan-advances/:id/repayments', verifyToken, perm('view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.* FROM payroll_loan_repayments r JOIN payroll_loans l ON l.id = r.loan_id JOIN employees e ON e.id = l.employee_id
        WHERE r.loan_id = $1 AND e.company_id = $2 AND l.is_test = false ORDER BY r.year, r.month, r.id`, [req.params.id, companyOf(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Record the payout of a loan to the employee (Dr loan receivable / Cr bank).
router.post('/loan-advances/:id/payout', verifyToken, requirePermission('payroll_payment', 'approve'), act(async (req, res) => {
  const row = await compliance.recordLoanPayout({ ...req.body, loan_id: req.params.id, company_id: companyOf(req), userId: uidOf(req) });
  logAudit({ userId: uidOf(req), module: 'payroll', recordId: row.id, recordType: 'payroll_loan', action: 'payout', newData: { reference: row.disbursement_reference, disbursed_on: row.disbursed_on }, req });
  res.json({ success: true, data: row });
}));

// POST /payroll/loan-advances — principal, start_date, and EMI and/or
// tenure_months; interest_rate (annual %, reducing balance) defaults to 0.
// A one-month recovery needs single_installment: true.
router.post('/loan-advances', verifyToken, perm('edit'), async (req, res) => {
  const { employee_id, reason, purpose = 'general' } = req.body || {};
  if (!employee_id) return res.status(400).json({ message: 'employee_id is required' });
  // A loan for treatment of a specified illness carries no perquisite (Income-tax Rules 2026, rule 15).
  if (!['general', 'medical'].includes(purpose)) return res.status(400).json({ message: "purpose must be 'general' or 'medical'" });
  let plan;
  try { plan = planLoan(req.body); }
  catch (e) {
    if (e instanceof LoanInputError) return res.status(e.status).json({ code: e.code, message: e.message });
    return res.status(500).json({ message: e.message });
  }
  const cid = companyOf(req);
  try {
    if (!(await employeeInCompany(employee_id, cid))) return res.status(404).json({ message: 'Employee not found' });
    const { rows } = await pool.query(
      `INSERT INTO payroll_loans (employee_id, loan_type, principal_amount, emi_amount, outstanding_balance, start_date, reason,
                                  emi_schedule, interest_rate, tenure_months, single_installment, purpose)
       VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [employee_id, plan.loan_type, plan.principal, plan.emi, plan.start_date, reason ?? null,
       JSON.stringify(plan.schedule), plan.interest_rate, plan.tenure_months, req.body.single_installment === true, purpose]);
    res.status(201).json({ ...withRemaining(rows[0]), total_interest: plan.total_interest, total_repayable: plan.total_repayable });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /payroll/loan-advances/:id/prepay { amount, payment_date, reference }
// Records money received from the employee outside payroll; reduces principal
// and closes the loan when nothing is left. A draft that already deducts this
// loan must be regenerated — approval refuses a draft whose loans changed.
router.post('/loan-advances/:id/prepay', verifyToken, perm('edit'), async (req, res) => {
  const id = Number(req.params.id);
  const amount = Math.round(parseFloat(req.body?.amount) * 100) / 100;
  const payDate = String(req.body?.payment_date || '').slice(0, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Invalid loan id' });
  if (!(amount > 0)) return res.status(400).json({ message: 'amount must be greater than 0' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) return res.status(400).json({ message: 'payment_date (YYYY-MM-DD) is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [loan] } = await client.query(
      `SELECT l.* FROM payroll_loans l JOIN employees e ON e.id = l.employee_id
        WHERE l.id = $1 AND e.company_id = $2 AND l.is_test = false FOR UPDATE OF l`, [id, companyOf(req)]);
    if (!loan) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Loan not found' }); }
    if (loan.status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ message: `Loan is ${loan.status}` }); }
    const outstanding = Number(loan.outstanding_balance);
    if (amount > outstanding) {
      await client.query('ROLLBACK');
      return res.status(422).json({ code: 'PREPAY_EXCEEDS_OUTSTANDING', message: `Prepayment ₹${amount} exceeds the principal outstanding ₹${outstanding}` });
    }
    // Whole rupees unless it settles the loan: a paise balance on an
    // interest-free loan would surface as "interest" on the rounded last installment.
    if (!Number.isInteger(amount) && amount !== outstanding) {
      await client.query('ROLLBACK');
      return res.status(422).json({ code: 'PREPAY_WHOLE_RUPEES', message: 'A part-prepayment must be in whole rupees (only the full outstanding may include paise)' });
    }
    const after = Math.round((outstanding - amount) * 100) / 100;
    const [yy, mm] = payDate.split('-').map(Number);
    await client.query(
      `INSERT INTO payroll_loan_repayments (loan_id, month, year, amount, balance_after, source, principal_component, interest_component, reference, recorded_by)
       VALUES ($1,$2,$3,$4,$5,'prepayment',$4,0,$6,$7)`,
      [id, mm, yy, amount, after, req.body?.reference ?? null, req.user?.userId ?? null]);
    const { rows: [updated] } = await client.query(
      `UPDATE payroll_loans SET outstanding_balance = $2, updated_at = NOW(),
              status = CASE WHEN $2::numeric <= 0 THEN 'closed' ELSE status END,
              closed_at = CASE WHEN $2::numeric <= 0 THEN NOW() ELSE closed_at END,
              closure_type = CASE WHEN $2::numeric <= 0 THEN 'prepaid' ELSE closure_type END,
              closed_by = CASE WHEN $2::numeric <= 0 THEN $3::int ELSE closed_by END
        WHERE id = $1 RETURNING *`, [id, after, req.user?.userId ?? null]);
    await client.query('COMMIT');
    res.json({ success: true, loan: withRemaining(updated) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

// POST /payroll/loan-advances/:id/close — only a loan with nothing outstanding
// closes as-is. A balance must be prepaid (above) or explicitly waived with a
// reason ({ waive: true, reason }), which is recorded as a 'waiver' repayment.
// Close used to set the balance to 0 with no record of where it went.
router.post('/loan-advances/:id/close', verifyToken, perm('edit'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Invalid loan id' });
  const waive = req.body?.waive === true;
  const reason = String(req.body?.reason || '').trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [loan] } = await client.query(
      `SELECT l.* FROM payroll_loans l JOIN employees e ON e.id = l.employee_id
        WHERE l.id = $1 AND e.company_id = $2 FOR UPDATE OF l`, [id, companyOf(req)]);
    if (!loan) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Loan not found' }); }
    if (loan.status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ message: `Loan is already ${loan.status}` }); }
    const outstanding = Number(loan.outstanding_balance);
    if (outstanding > 0 && !waive) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'LOAN_OUTSTANDING', outstanding,
        message: `₹${outstanding.toLocaleString('en-IN')} is still outstanding. Record a prepayment, or waive it with a reason.` });
    }
    if (outstanding > 0 && !reason) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'A waiver needs a reason' }); }
    if (outstanding > 0) {
      const today = (await client.query('SELECT CURRENT_DATE::text AS d')).rows[0].d;
      const [yy, mm] = today.split('-').map(Number);
      await client.query(
        `INSERT INTO payroll_loan_repayments (loan_id, month, year, amount, balance_after, source, principal_component, interest_component, reference, recorded_by)
         VALUES ($1,$2,$3,$4,0,'waiver',$4,0,$5,$6)`, [id, mm, yy, outstanding, reason, req.user?.userId ?? null]);
    }
    await client.query(
      `UPDATE payroll_loans SET status = 'closed', outstanding_balance = 0, closed_at = NOW(), updated_at = NOW(),
              closure_type = $2, closure_note = $3, closed_by = $4
        WHERE id = $1`, [id, outstanding > 0 ? 'waived' : 'repaid', reason || null, req.user?.userId ?? null]);
    await client.query('COMMIT');
    res.json({ success: true, closure_type: outstanding > 0 ? 'waived' : 'repaid', waived_amount: outstanding > 0 ? outstanding : 0 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

// ── Form No. 123 / 12BA helpers ───────────────────────────────────────────────
async function getForm16StatusData(company_id, financial_year, employee_id) {
  const s = await ops.getForm16Status({ company_id, financial_year, employee_id });
  return s.employees[0] || null;
}

function streamForm123Pdf(res, f) {
  const rs = (v) => (v == null ? 'Not provided through Pulse' : `Rs. ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${f.form.replace(/[^A-Za-z0-9]+/g, '')}_${f.employee.code || f.employee.id}_${f.financial_year}.pdf"`);
  doc.pipe(res);
  doc.fontSize(14).text(f.form_label, { align: 'center' });
  doc.fontSize(9).fillColor('#555').text(`Statement showing particulars of perquisites, other fringe benefits or amenities and profits in lieu of salary (${f.basis})`, { align: 'center' });
  doc.moveDown().fillColor('#111').fontSize(10);
  [['1. Name and address of employer', `${f.employer.name || '—'}${f.employer.address ? `, ${f.employer.address}` : ''}`],
   ['2. TAN', f.employer.tan || '—'],
   ['3. TDS assessment range of the employer', '—'],
   ['4. Name, designation and PAN of employee', `${f.employee.name}, ${f.employee.designation || '—'}, PAN ${f.employee.pan || '—'}`],
   ['5. Is the employee a director or a person with substantial interest in the company?', 'Not recorded in Pulse'],
   ['6. Income under the head "Salaries" of the employee (other than from perquisites)', rs(f.salary_excluding_perquisites)],
   [`7. ${f.period_term}`, f.financial_year],
   ['8. Valuation of perquisites', ''],
  ].forEach(([k, v]) => doc.text(`${k}: ${v}`));
  doc.moveDown(0.5).fontSize(8);
  const x = { sl: 40, item: 62, value: 330, rec: 420, ch: 490 };
  let y = doc.y;
  doc.font('Helvetica-Bold').text('Sl.', x.sl, y).text('Nature of perquisite', x.item, y).text('Value as per rules', x.value, y).text('Recovered from employee', x.rec, y, { width: 65 }).text('Chargeable', x.ch, y);
  doc.font('Helvetica');
  y += 22;
  for (const it of f.items) {
    doc.text(String(it.sl), x.sl, y).text(it.label, x.item, y, { width: 260 });
    if (it.value == null) doc.fillColor('#777').text('Not provided through Pulse', x.value, y, { width: 200 }).fillColor('#111');
    else doc.text(rs(it.value), x.value, y, { width: 85 }).text(rs(it.recovered), x.rec, y, { width: 65 }).text(rs(it.chargeable), x.ch, y, { width: 70 });
    y += 16;
  }
  doc.font('Helvetica-Bold').text(`Total value of perquisites: ${rs(f.total_perquisites)}`, x.sl, y + 4).font('Helvetica');
  doc.text('Total value of profits in lieu of salary as per section 17(3) / its successor: Not provided through Pulse', x.sl, y + 18);
  doc.moveDown(1.5).fontSize(10).text('9. Details of tax', x.sl);
  doc.fontSize(9).text(`(a) Tax deducted from salary of the employee: ${rs(f.tax.deducted_from_salary)}`)
    .text(`(b) Tax paid by employer on behalf of the employee: ${rs(f.tax.paid_by_employer)}`)
    .text(`(c) Total tax paid: ${rs(f.tax.total)}`)
    .text(`(d) Date of payment into Government treasury: ${f.tax.deposits.length ? f.tax.deposits.map(d => `${d.month}/${d.year}: challan ${d.challan_number}${d.challan_date ? ` on ${String(d.challan_date instanceof Date ? d.challan_date.toISOString() : d.challan_date).slice(0, 10)}` : ''}${d.bsr_code ? ` (BSR ${d.bsr_code})` : ''}`).join('; ') : 'No challan recorded in Finance → TDS'}`);
  doc.moveDown().fontSize(8).fillColor('#b45309').text(`Note: ${f.note}`);
  doc.moveDown().fillColor('#111').fontSize(9).text('DECLARATION BY EMPLOYER: I, ____________________, son/daughter of ____________________, working as ____________________ (designation), do hereby declare on behalf of the employer named above that the information given above is based on the books of account, documents and other relevant records or information available with us, and the details of value of each such perquisite are in accordance with the Act and the rules, and that it is true, correct and complete.');
  doc.moveDown().text('Signature of the person responsible for deduction of tax: ____________________     Place: ____________     Date: ____________');
  doc.end();
}

export default router;