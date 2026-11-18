import * as service from './payroll.service.js';
import { PayrollHttpError, FINAL_STATUSES } from './payroll.service.js';
import pool from '../shared/db.js';
import { getMonthName, normalizeState } from './payrollEngine.js';
import { logAudit } from '../../services/AuditService.js';
import { sendPayslipEmail, isEmailConfigured } from '../../utils/mailer.js';
import { companyOf } from '../../shared/scope.js';
import { rolesOf } from '../../middlewares/auth.middleware.js';
import { RULE_KEYS, STATE_RULE_GAPS, ruleValueProblems, sameValue } from './statutoryRules.js';
import { SETTLEMENT_RULE_KEYS, settlementRuleProblem } from '../hr/settlementRules.js';
import { POLICY_KEY, resolvePolicy } from './ctcService.js';
import { ownEmployeeId } from './payrollAccess.js';

// A company CTC definition must spell out every choice — nothing defaults.
function ctcPolicyProblems(v) {
  const p = [];
  if (!v || typeof v !== 'object') return ['value must be an object'];
  if (!String(v.version || '').trim()) p.push('version is required');
  for (const k of ['employer_pf', 'employer_esi', 'employer_lwf', 'gratuity']) {
    if (typeof v.include?.[k] !== 'boolean') p.push(`include.${k} must be true or false`);
  }
  if (v.include?.gratuity) {
    if (!['code_wages', 'basic'].includes(v.gratuity?.base)) p.push("gratuity.base must be 'code_wages' or 'basic'");
    if (!(Number(v.gratuity?.days_per_year) > 0) || !(Number(v.gratuity?.divisor) > 0)) p.push('gratuity.days_per_year and gratuity.divisor are required');
  }
  if (v.rules_basis !== 'effective_date') p.push("rules_basis must be 'effective_date' (the only basis implemented)");
  if (v.residual !== 'report') p.push("residual must be 'report' (the only residual handling implemented)");
  if (typeof v.maker_checker !== 'boolean') p.push('maker_checker must be true or false');
  return p;
}
import PDFDocument from 'pdfkit';

const uid = (req) => req.user?.userId ?? req.user?.id ?? null;

function fail(res, err) {
  if (err instanceof PayrollHttpError) {
    return res.status(err.status).json({ success: false, message: err.message, error: err.message, ...(err.details || {}) });
  }
  console.error('[payroll]', err);
  return res.status(500).json({ success: false, message: err.message, error: err.message });
}
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e); } };

/**
 * One payslip shape for every screen and the PDF.
 *   earnings                — what the employee earned
 *   deductions              — EMPLOYEE deductions only; these sum to total_deductions
 *   employer_contributions  — employer PF / ESI / LWF: shown for transparency,
 *                             never deducted. Employer PF used to be listed under
 *                             "Deductions" on the viewer, the generator, the
 *                             Run Payroll modal and the PDF, so the deductions
 *                             column did not add up to total deductions.
 */
const EARNING_LABEL = {
  Basic: 'Basic Salary', Conveyance: 'Conveyance Allowance', Medical: 'Medical Allowance',
};
export function shapePayslip(slip, emp = {}) {
  if (!slip) return null;
  const n = (v) => Number(v || 0);
  // Regular earnings: every structure component as computed for the month
  // (earning_lines, stored since 2026-10-21). Before that only five fixed
  // columns were listed, so a component such as LTA was inside gross but on no
  // line. For a run saved before earning_lines existed, whatever gross the
  // fixed lines do not explain is shown as one "not itemised" line so the
  // earnings column still adds up to gross.
  const lines = Array.isArray(slip.earning_lines) && slip.earning_lines.length ? slip.earning_lines : null;
  const regular = lines
    ? lines.map(l => [EARNING_LABEL[l.name] || l.name, l.amount])
    : [['Basic Salary', slip.basic], ['HRA', slip.hra],
       ['Conveyance Allowance', slip.conveyance_allowance], ['Medical Allowance', slip.medical_allowance],
       ['Special Allowance', slip.special_allowance]];
  // One-time amounts HR entered for the month (payroll_adjustments, §261), each on its own line.
  const adj = Array.isArray(slip.adjustment_lines) ? slip.adjustment_lines : [];
  const oneTime = [['Overtime Pay', slip.overtime_pay], ['Night Shift Allowance', slip.night_shift_allowance],
    ['Bonus', slip.bonus], ['Arrears', slip.arrears ?? slip.arrears_amount],
    ...adj.filter(a => a.kind === 'earning').map(a => [a.label, a.amount])];
  const earnings = [...regular, ...oneTime]
    .map(([label, amount]) => ({ label, amount: n(amount) })).filter(e => e.amount > 0);
  const unexplained = Math.round(n(slip.gross) - earnings.reduce((t, e) => t + e.amount, 0));
  if (!lines && unexplained >= 1) earnings.push({ label: 'Other earnings (not itemised on this run)', amount: unexplained });
  const deductions = [
    ['Provident Fund (Employee)', slip.employee_pf], ['ESI (Employee)', slip.employee_esi],
    ['Professional Tax', slip.professional_tax], ['Labour Welfare Fund (Employee)', slip.lwf_employee],
    ['TDS (Income Tax)', slip.tds], ['Loan EMI', slip.loan_deduction], ['Advance Recovery', slip.advance_deduction],
    ...adj.filter(a => a.kind === 'deduction').map(a => [a.label, a.amount]),
  ].map(([label, amount]) => ({ label, amount: n(amount) })).filter(d => d.amount > 0);
  const employer = [
    ['Provident Fund (Employer) — EPS', slip.eps], ['Provident Fund (Employer) — EPF', slip.epf_employer],
    ['ESI (Employer)', slip.employer_esi], ['Labour Welfare Fund (Employer)', slip.lwf_employer],
    ['EDLI and EPF administration (Employer)', Number(slip.edli_employer || 0) + Number(slip.pf_admin_employer || 0)],
  ].map(([label, amount]) => ({ label, amount: n(amount) })).filter(c => c.amount > 0);
  const code = slip.employee_code || emp.office_id || null;
  const acct = emp.account_number ?? emp.bank_account ?? slip.bank_account;
  return {
    ...slip,
    employee_code: code,
    earnings,
    deductions,
    employer_contributions_list: employer,
    employer_contributions_total: employer.reduce((s, c) => s + c.amount, 0),
    // Taxed, never paid: shown so the payslip explains the tax.
    taxable_perquisites: n(slip.perquisite_value) > 0 ? [{ label: 'Loan below the SBI rate (taxable perquisite, not paid)', amount: n(slip.perquisite_value) }] : [],
    lop_note: n(slip.lop_carried_days) > 0 ? `includes ${n(slip.lop_carried_days)} day(s) of absence after last month's cutoff (₹${n(slip.lop_carried_amount).toLocaleString('en-IN')})` : null,
    employee: {
      id: slip.employee_id || emp.id,
      code,
      name: slip.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
      designation: slip.designation || emp.designation,
      department: slip.department || emp.department,
      pan: emp.pan_number || slip.pan_number || null,
      uan: emp.uan_number || slip.uan_number || null,
      bank: acct ? `****${String(acct).slice(-4)}` : null,
    },
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

export const listPayroll = wrap(async (req, res) => {
  const r = await service.listPayroll({ ...req.query, company_id: companyOf(req) });
  res.json({ success: true, data: r.data, pagination: r.pagination, message: 'Payroll list retrieved' });
});

export const getPayrollSummary = wrap(async (req, res) => {
  res.json({ success: true, data: await service.getSummary({ ...req.query, company_id: companyOf(req) }) });
});

export const getEligibility = wrap(async (req, res) => {
  res.json({ success: true, data: await service.getEligibility({ ...req.query, company_id: companyOf(req) }) });
});

export const getReleaseReadiness = wrap(async (req, res) => {
  const cid = companyOf(req);
  if (cid == null) return res.status(400).json({ success: false, message: 'Payroll is per company — sign in to (or select) a company first' });
  const m = parseInt(req.query.month) || new Date().getMonth() + 1, y = parseInt(req.query.year) || new Date().getFullYear();
  const { rules: _rules, ...data } = await service.periodReadiness({ company_id: cid, month: m, year: y });
  res.json({ success: true, data });
});

async function companyHeader(cid) {
  const { rows: [co] } = await pool.query('SELECT name, address FROM companies WHERE id = $1', [cid]);
  return { name: co?.name || null, address: co?.address || '' };
}

export const getPayrollCycle = wrap(async (req, res) => {
  res.json({ success: true, data: await service.getPayrollCycle({ ...req.query, company_id: companyOf(req) }) });
});

export const getEmployeePayslip = wrap(async (req, res) => {
  const data = await service.getEmployeePayslip(req.params.id, { ...req.query, company_id: companyOf(req) });
  res.json({ success: true, data: data.preview && !data.eligible && data.reasons ? data : shapePayslip(data) });
});

// GET /payroll/payslips?employee_id&month&year — Payslip Viewer.
// Self-service callers (ownPayslipOrForbidden set req.payslipSelfService) see
// only FINALISED payslips; HR also sees drafts and previews, labelled as such.
export const getPayslipByQuery = wrap(async (req, res) => {
  const { employee_id, month, year } = req.query;
  if (!employee_id) return res.status(400).json({ success: false, message: 'employee_id is required' });
  const cid = companyOf(req);
  const saved = await service.getSavedRun({ employee_id, month, year, company_id: cid });
  if (req.payslipSelfService) {
    if (!saved || !FINAL_STATUSES.includes(saved.status)) {
      return res.status(404).json({ success: false, message: 'The payslip for this month has not been released yet' });
    }
    return res.json({ success: true, data: { ...shapePayslip(saved), company: await companyHeader(cid) } });
  }
  if (saved) return res.json({ success: true, data: { ...shapePayslip(saved), company: await companyHeader(cid) }, message: `Payslip (${saved.status})` });
  const pv = await service.previewEmployeePayslip({ employee_id, month, year, company_id: cid });
  if (!pv.slip) return res.status(422).json({ success: false, message: 'Employee is not payable for this period', reasons: pv.reasons });
  res.json({ success: true, data: { ...shapePayslip(pv.slip, pv.emp), preview: true, status: 'not_generated', company: await companyHeader(cid) }, message: 'Preview — payroll not generated for this period' });
});

export const getPayrollTrend = wrap(async (req, res) => {
  res.json({ success: true, data: await service.getPayrollTrend({ company_id: companyOf(req) }) });
});

export const getForm16 = wrap(async (req, res) => {
  const data = await service.getForm16(req.params.employeeId, { company_id: companyOf(req), financial_year: req.query.financial_year });
  if (!data) return res.status(404).json({ success: false, message: 'No finalised payroll for this employee in the financial year' });
  res.json({ success: true, data });
});

export const getForm16Status = wrap(async (req, res) => {
  res.json({ success: true, data: await service.getForm16Status({ company_id: companyOf(req), financial_year: req.query.financial_year }) });
});

// GET /payroll/form16/:employeeId/pdf — Part B only, and only when the
// lifecycle says the certificate can be final.
export const streamForm16Pdf = wrap(async (req, res) => {
  const cid = companyOf(req);
  const f16 = await service.getForm16(req.params.employeeId, { company_id: cid, financial_year: req.query.financial_year });
  if (!f16) return res.status(404).json({ success: false, message: 'No finalised payroll for this employee in the financial year' });
  if (!f16.lifecycle.can_generate) {
    return res.status(409).json({ success: false, message: 'Form 16 is not ready', status: f16.lifecycle.status, blockers: f16.lifecycle.blockers });
  }
  const { rows: [co] } = await pool.query(`SELECT name, address, pan, tan FROM companies WHERE id = $1`, [cid]);
  // Income-tax Rules 2026 (G.S.R. 198(E)) renumbered Form 16 as Form No. 130
  // from tax year 2026-27; earlier years remain Form 16 under the 1962 Rules.
  const isNewForms = parseInt(f16.financial_year, 10) >= 2026;
  const fmt = (v) => `Rs. ${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${isNewForms ? 'Form130' : 'Form16'}_PartB_${f16.employee_code || req.params.employeeId}_${f16.financial_year}.pdf"`);
  doc.pipe(res);
  doc.fontSize(15).text(isNewForms ? 'FORM No. 130 (formerly Form 16) — PART B (computed summary)' : 'FORM 16 — PART B (computed summary)', { align: 'center' });
  // Tax years from 2026-27: salary TDS is deducted under s.392 of the Income-tax
  // Act 2025 and the year is a "Tax Year"; earlier years keep s.192 / FY (§200).
  doc.fontSize(9).fillColor('#555').text(`Details of salary paid and tax deducted (${isNewForms ? 's.392, Income-tax Act 2025' : 's.192'}). Part A must be downloaded from TRACES` + (isNewForms ? '; Part C is not produced here.' : '.'), { align: 'center' });
  doc.moveDown().fillColor('#111').fontSize(10);
  [['Employer', co?.name], ['Employer TAN', co?.tan || process.env.EMPLOYER_TAN], ['Employer PAN', co?.pan],
   ['Employee', f16.employee_name], ['Employee code', f16.employee_code], ['Employee PAN', f16.employee_pan],
   [isNewForms ? 'Tax year' : 'Financial year', f16.financial_year], ['Tax regime', f16.tax_regime]].forEach(([k, v]) => doc.text(`${k}: ${v || '—'}`));
  doc.moveDown();
  [['Gross salary', f16.gross_salary], ['Standard deduction', f16.standard_deduction], ['Professional tax', f16.professional_tax],
   ['Employee PF', f16.pf_deduction], ['Taxable income (as computed at last payroll)', f16.taxable_income],
   ['Tax payable', f16.tax_payable], ['Tax deducted at source', f16.tds_deducted]].forEach(([k, v]) => doc.text(`${k}: ${fmt(v)}`));
  doc.moveDown().fontSize(9).fillColor('#555').text(`Months included: ${f16.months_included}`);
  doc.end();
});

export const getCompliance = wrap(async (req, res) => {
  res.json({ success: true, data: await service.getCompliance({ ...req.query, company_id: companyOf(req) }) });
});

// ── Official run ────────────────────────────────────────────────────────────

export const generatePayroll = wrap(async (req, res) => {
  // userId last: the preparer is the authenticated user, never a body field.
  const data = await service.generatePayroll({ ...req.body, company_id: companyOf(req), userId: uid(req) });
  logAudit({ userId: uid(req), module: 'payroll', recordId: null, recordType: 'payroll_run', action: 'create',
    newData: { month: req.body.month, year: req.body.year, count: data.count, skipped: data.skipped.length, errors: data.errors.length, department: req.body.department ?? 'All', employee_id: req.body.employee_id ?? null }, req });
  res.json({ success: true, data, message: data.message });
});
export const runPayroll = generatePayroll;

export const approvePayroll = wrap(async (req, res) => {
  const { month, year } = req.body;
  if (!month || !year) return res.status(400).json({ success: false, message: 'month and year are required' });
  const cid = companyOf(req);
  const result = await service.approvePayroll({ month, year, company_id: cid, userId: uid(req) });
  const rows = result.approvedRows;
  logAudit({ userId: uid(req), module: 'Payroll', recordId: null, recordType: 'payroll_run', action: 'approve',
    newData: { month: parseInt(month), year: parseInt(year), approved_count: rows.length, loan_repayments: result.loan_repayments,
      accrual_journal_entry_id: result.gl_posting?.journal_entry?.id ?? null }, req });
  import('../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
    notifyWorkflowEvent('approved', { module: 'Payroll', recordId: null, submitterId: uid(req), recipientIds: [],
      comments: `Payroll for ${month}/${year} approved (${rows.length} record(s))` }).catch(() => {});
  }).catch(() => {});
  // The accrual journal is posted inside the approval transaction (F-03): a
  // response here means it is in the GL; a refusal never reaches this line.
  res.json({ success: true, message: `${rows.length} payroll record(s) approved for ${month}/${year}`, approved_count: rows.length, loan_repayments: result.loan_repayments, gl_posting: result.gl_posting });
});

export const markPaid = wrap(async (req, res) => {
  const { month, year, payment_mode, reference, value_date } = req.body;
  // Only the fields of a payment — the company and the payer come from the session.
  const data = await service.markPaid(req.params.id, {
    month, year, payment_mode, reference, value_date, company_id: companyOf(req), userId: uid(req),
  });
  // An administrator recording a payment uses the PD-3 authority, not the
  // Finance role: it is audited as such, every time (maker-checker and the bank
  // reference still applied above).
  const roles = rolesOf(req);
  const authority = roles.includes('finance_manager') ? 'finance_manager'
    : roles.some(r => r === 'admin' || r === 'super_admin') ? 'administrator' : 'granted';
  if (data.already_paid) {
    logAudit({ userId: uid(req), module: 'payroll', recordId: data.run_id, recordType: 'payroll_run', action: 'payment_replay',
      newData: { employee_id: Number(req.params.id), month, year, reference: data.reference, authority }, req });
  } else {
    logAudit({ userId: uid(req), module: 'payroll', recordId: data.run_id, recordType: 'payroll_run', action: 'payment_recorded',
      oldData: { status: 'approved' },
      newData: { status: 'paid', employee_id: Number(req.params.id), month, year, payment_mode: payment_mode ?? 'bank_transfer',
        reference: data.reference, value_date: data.value_date, amount: data.amount, journal_entry_id: data.journal_entry_id,
        reconciled: false, authority }, req });
    if (authority === 'administrator') {
      logAudit({ userId: uid(req), module: 'payroll', recordId: data.run_id, recordType: 'payroll_run', action: 'payment_admin_authority',
        newData: { employee_id: Number(req.params.id), month, year, reference: data.reference, roles }, req });
    }
  }
  res.json({ success: true, data, message: data.message });
});

// ── Payslip Generator: PREVIEW only ─────────────────────────────────────────
// Uses exactly the official inputs (salary revision, structure, settings,
// attendance, loans); the what-if fields only change this preview. Nothing here
// writes payroll_runs — the official record is created by Run Payroll and
// becomes a payslip only on approval.

function previewOverrides(body) {
  const o = {};
  for (const k of ['lop_days', 'bonus', 'loan_deduction', 'advance_deduction']) {
    if (body[k] !== undefined && body[k] !== '' && body[k] !== null) o[k] = body[k];
  }
  return o;
}

/**
 * A FINALISED month has one payslip: the approved run. With no what-if inputs
 * the generator shows that stored run; it used to recompute the month from
 * today's data — after approval had reduced a loan balance (or a later revision
 * or rule version existed) the recomputed EMI / net differed from what was
 * approved, and the PDF of it carried no watermark. What-if inputs on a
 * finalised month still give a preview, watermarked as such.
 */
async function finalisedRun(req, employee_id, month, year) {
  if (Object.keys(previewOverrides(req.body)).length) return null;
  const saved = await service.getSavedRun({ employee_id, month, year, company_id: companyOf(req) });
  return saved && FINAL_STATUSES.includes(saved.status) ? saved : null;
}

export const computeSlip = wrap(async (req, res) => {
  const { employee_id, month, year } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  const saved = await finalisedRun(req, employee_id, month, year);
  if (saved) return res.json({ ...shapePayslip(saved), preview: false, source: 'approved_run', run_status: saved.status, validation_issues: [] });
  const pv = await service.previewEmployeePayslip({ employee_id, month, year, company_id: companyOf(req), overrides: previewOverrides(req.body) });
  if (!pv.slip) return res.status(422).json({ error: 'Employee is not payable for this period', reasons: pv.reasons, preview: true });
  res.json({ ...shapePayslip(pv.slip, pv.emp), preview: true, run_status: pv.run_status, validation_issues: pv.validation, settings_conflicts: pv.settings_conflicts, rules_applied: pv.rules_applied });
});

export const generatePdfData = wrap(async (req, res) => {
  const saved = await finalisedRun(req, req.params.id, req.body.month, req.body.year);
  const pv = saved ? null : await service.previewEmployeePayslip({ employee_id: req.params.id, month: req.body.month, year: req.body.year, company_id: companyOf(req), overrides: previewOverrides(req.body) });
  if (pv && !pv.slip) return res.status(422).json({ error: 'Employee is not payable for this period', reasons: pv.reasons });
  const slip = saved || pv.slip;
  const { rows: [co] } = await pool.query(`SELECT name, address, gstin FROM companies WHERE id = $1`, [companyOf(req)]);
  const shaped = saved ? shapePayslip(saved) : shapePayslip(pv.slip, pv.emp);
  res.json({
    preview: !saved,
    source: saved ? 'approved_run' : 'preview',
    watermark: saved ? null
      : (pv.run_status === 'approved' || pv.run_status === 'paid' ? 'WHAT-IF PREVIEW — NOT THE ISSUED PAYSLIP' : 'PREVIEW — NOT AN ISSUED PAYSLIP'),
    company: { name: co?.name || '—', address: co?.address || '', gstin: co?.gstin || null },
    employee: {
      name: shaped.employee.name, code: shaped.employee_code || '—',
      designation: shaped.employee.designation || '—', department: shaped.employee.department || '—',
      pan: (saved ? saved.pan_number : pv.emp.pan_number) || '—', bank_account: shaped.employee.bank || '—',
    },
    period: saved
      ? { period_label: saved.period_label, working_days: saved.working_days ?? '—', lop_days: saved.lop_days, paid_days: saved.paid_days ?? '—', days_in_month: saved.days_in_month ?? '—' }
      : { period_label: pv.slip.payroll_period, working_days: pv.slip.working_days, lop_days: pv.slip.lop_days, paid_days: pv.slip.paid_days, days_in_month: pv.slip.days_in_month },
    earnings: shaped.earnings.map(e => ({ name: e.label, monthly: e.amount })),
    deductions: shaped.deductions.map(d => ({ name: d.label, monthly: d.amount })),
    employer_contributions: shaped.employer_contributions_list.map(c => ({ name: c.label, monthly: c.amount })),
    taxable_perquisites: shaped.taxable_perquisites.map(c => ({ name: c.label, monthly: c.amount })),
    lop_note: shaped.lop_note,
    gross: slip.gross,
    total_deductions: slip.total_deductions,
    net_pay: slip.net_pay,
    form16_summary: { tax_regime: slip.tax_regime, annual_taxable_income: slip.annual_taxable_income, annual_tax: slip.annual_tax },
  });
});

// POST /payroll/save-slip — kept for API compatibility. It used to write a
// payroll_runs row from the Payslip Generator's inputs (employee master basic,
// no settings, manual overrides), overwriting even APPROVED rows. It now runs
// the official generator for this one employee; what-if overrides are ignored.
export const saveSlip = wrap(async (req, res) => {
  const { employee_id, month, year } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  const data = await service.generatePayroll({ employee_id, month, year, company_id: companyOf(req), userId: uid(req) });
  const ignored = Object.keys(previewOverrides(req.body));
  res.json({ success: data.count > 0, ...data,
    message: data.message + (ignored.length ? ` (preview-only inputs ignored: ${ignored.join(', ')})` : '') });
});

export const bulkGenerateSlips = wrap(async (req, res) => {
  const cid = companyOf(req);
  const ctx = await service.buildPeriodContext({ company_id: cid, month: req.body.month, year: req.body.year });
  const results = ctx.items.filter(i => !i.emp.deleted_at).map(i => {
    const base = { employee_id: i.emp.id, employee_code: i.emp.office_id, name: `${i.emp.first_name || ''} ${i.emp.last_name || ''}`.trim(), department: i.emp.department };
    if (!i.eligibility.eligible) return { ...base, status: 'not_eligible', reasons: i.eligibility.reasons };
    return { ...base, status: 'eligible' };
  });
  res.json({ preview: true, processed: results.filter(r => r.status === 'eligible').length, total: results.length, results });
});

// ── Email: finalised payslips only ──────────────────────────────────────────

/**
 * Email one finalised payslip, with the PDF attached (§262). Used by the Email
 * button, "Email all payslips" and the automatic send after payment. Returns
 * { status: 'sent' | 'failed' | 'no_email' | 'not_final', sent_to?, error? };
 * every attempt with an address is written to payslip_email_log.
 */
export async function sendPayslipFor({ company_id, employee_id, month, year }) {
  const run = await service.getSavedRun({ employee_id, month, year, company_id });
  if (!run || !FINAL_STATUSES.includes(run.status)) return { status: 'not_final', run_status: run?.status || null };
  const { rows: [emp] } = await pool.query(
    `SELECT first_name, last_name, company_email, personal_email FROM employees WHERE id = $1 AND company_id = $2`, [employee_id, company_id]);
  // The old code read emp.work_email || emp.email — neither column exists on
  // employees, so every send failed "no email address on file".
  const recipient = emp?.company_email || emp?.personal_email;
  const empName = `${emp?.first_name || ''} ${emp?.last_name || ''}`.trim();
  if (!recipient) return { status: 'no_email', employee_name: empName };
  const periodLabel = `${getMonthName(run.month)} ${run.year}`;
  const log = (status, error = null) => pool.query(
    `INSERT INTO payslip_email_log (employee_id, month, year, sent_to, sent_at, status, error)
     VALUES ($1,$2,$3,$4,NOW(),$5,$6)
     ON CONFLICT (employee_id, month, year) DO UPDATE SET sent_to=$4, sent_at=NOW(), status=$5, error=$6`,
    [employee_id, run.month, run.year, recipient, status, error]).catch(() => null);
  try {
    const pdf = await payslipPdfBuffer(run, company_id);
    await sendPayslipEmail(recipient, { empName, month: run.month, year: run.year, periodLabel, gross: run.gross, netPay: run.net_pay,
      totalDeductions: run.total_deductions, companyId: company_id,
      attachments: [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }] });
  } catch (mailErr) {
    await log('failed', mailErr.message);
    return { status: 'failed', sent_to: recipient, employee_name: empName, error: mailErr.message };
  }
  await log('sent');
  return { status: 'sent', sent_to: recipient, employee_name: empName, period: periodLabel };
}

/**
 * Email every finalised (or, with onlyPaid, paid) payslip of a month that has not
 * been emailed yet, so running it twice sends nobody a second copy. Used by the
 * morning job (jobs/payrollReminders.cron.js) when "Email payslips once paid" is on.
 */
export async function emailMonthPayslips({ company_id, month, year, onlyPaid = false }) {
  const { rows } = await pool.query(`
    SELECT pr.employee_id, e.office_id, (l.status = 'sent') AS already_sent
      FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
      LEFT JOIN payslip_email_log l ON l.employee_id = pr.employee_id AND l.month = pr.month AND l.year = pr.year
     WHERE e.company_id = $1 AND pr.month = $2 AND pr.year = $3 AND pr.is_test = false AND pr.status = ANY($4::text[])
     ORDER BY e.office_id`, [company_id, parseInt(month), parseInt(year), onlyPaid ? ['paid'] : FINAL_STATUSES]);
  const out = { sent: 0, skipped: 0, failed: [], no_email: [] };
  for (const r of rows) {
    if (r.already_sent) { out.skipped++; continue; }
    const x = await sendPayslipFor({ company_id, employee_id: r.employee_id, month, year });
    if (x.status === 'sent') out.sent++;
    else if (x.status === 'no_email') out.no_email.push(r.office_id);
    else if (x.status === 'failed') out.failed.push({ employee_code: r.office_id, error: x.error });
  }
  return { ...out, finalised: rows.length };
}

export const emailPayslip = wrap(async (req, res) => {
  const cid = companyOf(req);
  const { employee_id, month, year } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  const run = await service.getSavedRun({ employee_id, month, year, company_id: cid });
  if (!run || !FINAL_STATUSES.includes(run.status)) {
    return res.status(409).json({ success: false, error: `Only approved payslips can be emailed — this one is ${run ? `"${run.status}"` : 'not generated'}` });
  }
  if (!(await isEmailConfigured(cid))) {
    return res.status(503).json({ success: false, error: 'Email service is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS environment variables.' });
  }
  const r = await sendPayslipFor({ company_id: cid, employee_id, month: run.month, year: run.year });
  if (r.status === 'no_email') return res.status(422).json({ error: 'Employee has no email address on file' });
  if (r.status === 'failed') return res.status(502).json({ success: false, error: `Failed to send email: ${r.error}` });
  res.json({ success: true, sent_to: r.sent_to, message: `Payslip for ${r.period} sent to ${r.employee_name} (${r.sent_to}), with the PDF attached` });
});

export const getMyPayslips = wrap(async (req, res) => {
  // Each slip carries the SAME earnings / deductions / employer lists as the
  // Payslip Viewer and the PDF (shapePayslip), so the Home widget prints the
  // official payslip instead of rebuilding one from a few fixed columns.
  // The employee is the signed-in account's own (token, else users.employee_id).
  const list = await service.getMyPayslipList(req.user?.email, await ownEmployeeId(req));
  res.json({ success: true, data: list.map(p => ({ ...p, slip: shapePayslip(p.slip) })) });
});

// GET /payroll/payslip-pdf/:id?month&year — saved run; a draft or a preview is
// watermarked so it cannot pass for an issued payslip.
export const streamPayslipPdf = wrap(async (req, res) => {
  const cid = companyOf(req);
  const { id } = req.params;
  let slip = await service.getSavedRun({ employee_id: id, month: req.query.month, year: req.query.year, company_id: cid });
  let watermark = null;
  if (req.payslipSelfService && (!slip || !FINAL_STATUSES.includes(slip.status))) {
    return res.status(404).json({ success: false, message: 'The payslip for this month has not been released yet' });
  }
  if (!slip) {
    const pv = await service.previewEmployeePayslip({ employee_id: id, month: req.query.month, year: req.query.year, company_id: cid });
    if (!pv.slip) return res.status(422).json({ error: 'Employee is not payable for this period', reasons: pv.reasons });
    slip = { ...pv.slip, ...{ name: `${pv.emp.first_name || ''} ${pv.emp.last_name || ''}`.trim(), pan_number: pv.emp.pan_number, department: pv.emp.department, designation: pv.emp.designation } };
    watermark = 'PREVIEW — PAYROLL NOT GENERATED';
  } else if (!FINAL_STATUSES.includes(slip.status)) {
    watermark = slip.status === 'on_hold' ? 'ON HOLD — NOT AN ISSUED PAYSLIP' : 'DRAFT — AWAITING APPROVAL';
  }
  const shaped = shapePayslip(slip);
  const { rows: [co] } = await pool.query(`SELECT name, address FROM companies WHERE id = $1`, [cid]);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${payslipFileName(shaped, slip, id)}"`);
  doc.pipe(res);
  drawPayslip(doc, { slip, shaped, co, watermark });
});

const payslipFileName = (shaped, slip, id) => `payslip_${shaped.employee_code || id}_${slip.month}_${slip.year}.pdf`;

/** The issued payslip, drawn once for the download and the email attachment (§262). */
function drawPayslip(doc, { slip, shaped, co, watermark = null }) {
  const periodLabel = `${getMonthName(slip.month)} ${slip.year}`;
  const fmt = (n) => `Rs.${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  doc.fontSize(18).fillColor('#6B3FDB').text(co?.name || '—', { align: 'center' });
  doc.fontSize(10).fillColor('#555').text(co?.address || '', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(13).fillColor('#111').text(`Pay Slip — ${periodLabel}`, { align: 'center' });
  if (watermark) doc.fontSize(11).fillColor('#dc2626').text(watermark, { align: 'center' });
  doc.moveDown(1);

  const detailY = doc.y;
  doc.fontSize(10).fillColor('#111');
  const days = slip.days_in_month ? `${slip.paid_days ?? slip.days_in_month} of ${slip.days_in_month}` : '—';
  const left = [['Employee Name', shaped.employee.name], ['Designation', shaped.employee.designation || '—'], ['Department', shaped.employee.department || '—'], ['Bank A/c', shaped.employee.bank || '—']];
  const right = [['Employee Code', shaped.employee_code || '—'], ['PAN', shaped.employee.pan || '—'], ['UAN', shaped.employee.uan || '—'], ['Days paid / LOP', `${days} / ${Number(slip.lop_days || 0)}`]];
  left.forEach(([k, v], i) => doc.text(`${k}: ${v}`, 50, detailY + i * 18));
  right.forEach(([k, v], i) => doc.text(`${k}: ${v}`, 310, detailY + i * 18));
  doc.y = detailY + left.length * 18 + 12;

  const tableTop = doc.y;
  const col = { e_label: 50, e_amt: 230, d_label: 295, d_amt: 475 };
  doc.rect(50, tableTop, 495, 18).fill('#6B3FDB');
  doc.fontSize(10).fillColor('#fff');
  doc.text('Earnings', col.e_label, tableTop + 4, { width: 170 });
  doc.text('Amount', col.e_amt, tableTop + 4, { width: 60, align: 'right' });
  doc.text('Deductions', col.d_label, tableTop + 4, { width: 170 });
  doc.text('Amount', col.d_amt, tableTop + 4, { width: 60, align: 'right' });
  const rowsN = Math.max(shaped.earnings.length, shaped.deductions.length);
  for (let i = 0; i < rowsN; i++) {
    const y = tableTop + 18 + i * 18;
    if (i % 2 === 1) doc.rect(50, y, 495, 18).fill('#f5f3ff');
    doc.fillColor('#111').fontSize(10);
    const e = shaped.earnings[i], d = shaped.deductions[i];
    if (e) { doc.text(e.label, col.e_label, y + 4, { width: 170 }); doc.text(fmt(e.amount), col.e_amt, y + 4, { width: 60, align: 'right' }); }
    if (d) { doc.text(d.label, col.d_label, y + 4, { width: 170 }); doc.text(fmt(d.amount), col.d_amt, y + 4, { width: 60, align: 'right' }); }
  }
  const totY = tableTop + 18 + rowsN * 18;
  doc.rect(50, totY, 495, 20).fill('#e9d5ff');
  doc.fillColor('#5b21b6').fontSize(10).font('Helvetica-Bold');
  doc.text('Gross Pay', col.e_label, totY + 5, { width: 170 });
  doc.text(fmt(slip.gross), col.e_amt, totY + 5, { width: 60, align: 'right' });
  doc.text('Total Deductions', col.d_label, totY + 5, { width: 170 });
  doc.text(fmt(slip.total_deductions), col.d_amt, totY + 5, { width: 60, align: 'right' });
  const netY = totY + 24;
  doc.rect(50, netY, 495, 24).fill('#166534');
  doc.fillColor('#fff').fontSize(12);
  doc.text('Net Pay', col.e_label, netY + 6, { width: 250 });
  doc.text(fmt(slip.net_pay), 310, netY + 6, { width: 235, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#111').text(`(Rupees ${amountInWords(Math.round(Number(slip.net_pay || 0)))} only)`, 50, netY + 28, { width: 495, align: 'right' });
  doc.fontSize(10);
  let y = netY + 46;
  if (shaped.lop_note) { doc.fillColor('#555').text(`Loss of pay ${shaped.lop_note}.`, 50, y); y += 16; }
  for (const p of shaped.taxable_perquisites) { doc.fillColor('#555').text(`${p.label}: ${fmt(p.amount)}`, 50, y); y += 16; }
  if (shaped.employer_contributions_list.length) {
    doc.text('Employer contributions (not deducted from your pay)', 50, y); y += 16;
    for (const c of shaped.employer_contributions_list) { doc.fillColor('#555').text(`${c.label}: ${fmt(c.amount)}`, 60, y); y += 14; }
  }
  doc.fontSize(9).fillColor('#9ca3af').text('This is a computer-generated document and does not require a signature.', 50, y + 10, { align: 'center', width: 495 });
  doc.end();
}

/** The payslip PDF as a Buffer, for an email attachment. Only finalised runs are emailed. */
export async function payslipPdfBuffer(slip, company_id) {
  const shaped = shapePayslip(slip);
  const { rows: [co] } = await pool.query(`SELECT name, address FROM companies WHERE id = $1`, [company_id]);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  const done = new Promise((resolve, reject) => { doc.on('data', c => chunks.push(c)); doc.on('end', resolve); doc.on('error', reject); });
  drawPayslip(doc, { slip, shaped, co });
  await done;
  return { buffer: Buffer.concat(chunks), filename: payslipFileName(shaped, slip, slip.employee_id) };
}

/** Indian-system words for a whole rupee amount ("One Lakh Twenty Thousand"). */
export function amountInWords(n) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
    'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const w = (x) => {
    if (x < 20) return ones[x];
    if (x < 100) return tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : '');
    if (x < 1000) return ones[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' + w(x % 100) : '');
    if (x < 100000) return w(Math.floor(x / 1000)) + ' Thousand' + (x % 1000 ? ' ' + w(x % 1000) : '');
    if (x < 10000000) return w(Math.floor(x / 100000)) + ' Lakh' + (x % 100000 ? ' ' + w(x % 100000) : '');
    return w(Math.floor(x / 10000000)) + ' Crore' + (x % 10000000 ? ' ' + w(x % 10000000) : '');
  };
  return n === 0 ? 'Zero' : w(Math.abs(n));
}

// GET /payroll/history/:employeeId — last 12 months: saved runs only; a month
// with no run says so instead of showing a computed figure.
export const getPayrollHistory = wrap(async (req, res) => {
  const cid = companyOf(req);
  const { rows: [emp] } = await pool.query(`SELECT id FROM employees WHERE id = $1 AND company_id = $2`, [req.params.employeeId, cid]);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const { rows } = await pool.query(
    `SELECT month, year, period_label, gross, net_pay, total_deductions, lop_days, bonus, loan_deduction, advance_deduction, status, generated_at
       FROM payroll_runs WHERE employee_id = $1 AND is_test = false ORDER BY year DESC, month DESC LIMIT 24`, [emp.id]);
  const map = new Map(rows.map(r => [`${r.year}-${r.month}`, r]));
  const now = new Date();
  const data = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = d.getMonth() + 1, year = d.getFullYear();
    const r = map.get(`${year}-${month}`);
    if (!r) return { month, year, period_label: `${getMonthName(month)} ${year}`, status: 'not_generated', saved: false, gross: null, net_pay: null, total_deductions: null };
    return { ...r, gross: Number(r.gross), net_pay: Number(r.net_pay), total_deductions: Number(r.total_deductions), saved: true };
  });
  res.json({ success: true, data });
});

// ── Statutory rules (effective-dated) ──────────────────────────────────────

export const getStatutoryRules = wrap(async (req, res) => {
  const cid = companyOf(req);
  const { loadRules, BUILT_IN_RULES } = await import('./statutoryRules.js');
  const onDate = req.query.date || new Date().toISOString().slice(0, 10);
  const resolved = await loadRules(pool, cid, onDate);
  const { rows } = await pool.query(
    `SELECT id, company_id, rule_key, effective_from, value, source_reference, created_at
       FROM payroll_statutory_rules WHERE company_id IS NULL OR company_id = $1 ORDER BY rule_key, effective_from`, [cid]).catch(() => ({ rows: [] }));
  // PT and LWF are entered for the state the company has recorded, never a guessed one.
  const { rows: [st] } = await pool.query(`SELECT settings->>'statutory_state' AS state FROM company_settings WHERE company_id = $1 AND module = 'payroll' LIMIT 1`, [cid ?? 0]);
  res.json({ success: true, data: { on_date: onDate, resolved: resolved.values, applied: resolved.applied, built_in: BUILT_IN_RULES, custom_versions: rows, jurisdiction: normalizeState(st?.state), state_gaps: STATE_RULE_GAPS, ctc_policy: resolvePolicy(onDate, rows) } });
});

/**
 * Check a proposed rule version: the same checks whether it is written now or
 * when a second person confirms it. Returns { error: {status, message} } or the
 * normalised version.
 */
export const NO_SOURCE = 'No source given';

async function checkRuleVersion(body, { cid, roles }) {
  const { rule_key, effective_from, value, scope = 'company' } = body || {};
  // The source is optional (owner decision, 9 Nov 2026). The column requires text,
  // so a blank one says so plainly and is never made to look like a reference;
  // payroll shows such a rule as "no source given" (readiness warning RULE_NO_SOURCE).
  const source_reference = String(body?.source_reference || '').trim() || NO_SOURCE;
  const bad = (status, message) => ({ error: { status, message } });
  if (!RULE_KEYS.includes(rule_key) && !SETTLEMENT_RULE_KEYS.includes(rule_key) && rule_key !== POLICY_KEY) return bad(400, `rule_key must be one of: ${[...RULE_KEYS, POLICY_KEY].join(', ')}`);
  if (SETTLEMENT_RULE_KEYS.includes(rule_key)) {
    const problem = settlementRuleProblem(rule_key, value);
    if (problem) return bad(400, problem);
  }
  if (rule_key === POLICY_KEY) {
    const problems = ctcPolicyProblems(value);
    if (problems.length) return bad(400, `Invalid CTC definition: ${problems.join('; ')}`);
  }
  if (RULE_KEYS.includes(rule_key) && value !== undefined) {
    const problems = ruleValueProblems(rule_key, value);
    if (problems.length) return bad(400, `${rule_key} ${problems.join('; ')}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effective_from || ''))) return bad(400, 'effective_from must be YYYY-MM-DD');
  if (value === undefined) return bad(400, 'value is required');
  if (scope === 'global' && !roles.includes('super_admin')) return bad(403, 'Only a super admin can add a rule version for all companies');
  // A version for a period that is already approved would rewrite history.
  const { rows: [locked] } = await pool.query(
    `SELECT 1 FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
      WHERE e.company_id = $1 AND pr.status = ANY($2::text[]) AND pr.period_end >= $3::date LIMIT 1`,
    [cid, FINAL_STATUSES, effective_from]);
  // Recording the value already in force on that date changes no figure — it
  // is a confirmation, so it is allowed even when later payroll is approved.
  const { resolveRule, loadRuleRows } = await import('./statutoryRules.js');
  const ruleRows = await loadRuleRows(pool, cid);
  // A settlement keeps the rules it was computed with, so a new settlement rule changes no
  // approved payroll or settled figure.
  const isSettlementRule = SETTLEMENT_RULE_KEYS.includes(rule_key);
  const inForce = isSettlementRule ? null : rule_key === POLICY_KEY ? resolvePolicy(effective_from, ruleRows).value : resolveRule(rule_key, effective_from, ruleRows);
  const unchanged = sameValue(inForce, value);
  if (locked && !unchanged && !isSettlementRule) return bad(409, 'Payroll on or after this date is already approved — a new version cannot apply to it. Use arrears for the difference.');
  return { rule_key, effective_from, value, source_reference: String(source_reference).trim(), scope };
}

/** Write a checked version. Saving on a date that already has one corrects it. */
async function writeRuleVersion(v, { cid, userId, req }) {
  // created_at moves too, so a draft computed from the old value reads as out of
  // date; the audit log keeps what it replaced.
  const company = v.scope === 'global' ? null : cid;
  const { rows: [before] } = await pool.query(
    `SELECT * FROM payroll_statutory_rules WHERE COALESCE(company_id, 0) = COALESCE($1::int, 0) AND rule_key = $2 AND effective_from = $3::date`,
    [company, v.rule_key, v.effective_from]);
  const { rows: [row] } = await pool.query(
    `INSERT INTO payroll_statutory_rules (company_id, rule_key, effective_from, value, source_reference, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)
     ON CONFLICT (COALESCE(company_id, 0), rule_key, effective_from)
     DO UPDATE SET value = EXCLUDED.value, source_reference = EXCLUDED.source_reference, created_by = EXCLUDED.created_by, created_at = NOW()
     RETURNING *`,
    [company, v.rule_key, v.effective_from, JSON.stringify(v.value), v.source_reference, userId]);
  logAudit({ userId, module: 'payroll', recordId: row.id, recordType: 'payroll_statutory_rule', action: before ? 'update' : 'create', oldData: before, newData: row, req });
  return row;
}

const rolesOfReq = (req) => (req.user?.roles || [req.user?.role]).map(r => String(r || '').toLowerCase());

/**
 * POST /payroll/statutory-rules. With "Rule changes need a second person" on
 * (Payroll Settings, the default), a version is saved as a PROPOSAL (202) and is
 * applied only when a different authorised person confirms it. A version that
 * equals the value already in force is a confirmation, not a change, and is
 * written at once.
 */
export const addStatutoryRule = wrap(async (req, res) => {
  const cid = companyOf(req);
  const v = await checkRuleVersion(req.body, { cid, roles: rolesOfReq(req) });
  if (v.error) return res.status(v.error.status).json({ success: false, message: v.error.message });
  const { settings } = await service.fetchPayrollSettings(cid);
  const { loadRuleRows, resolveRule } = await import('./statutoryRules.js');
  const rows = await loadRuleRows(pool, cid);
  const inForce = SETTLEMENT_RULE_KEYS.includes(v.rule_key) ? undefined
    : v.rule_key === POLICY_KEY ? resolvePolicy(v.effective_from, rows).value : resolveRule(v.rule_key, v.effective_from, rows);
  if (settings.rules_two_person !== false && !sameValue(inForce, v.value)) {
    const { rows: [change] } = await pool.query(
      `INSERT INTO payroll_statutory_rule_changes (company_id, scope, rule_key, effective_from, value, source_reference, proposed_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
      [cid, v.scope, v.rule_key, v.effective_from, JSON.stringify(v.value), v.source_reference, uid(req)]);
    logAudit({ userId: uid(req), module: 'payroll', recordId: change.id, recordType: 'payroll_statutory_rule_change', action: 'propose', newData: change, req });
    return res.status(202).json({ success: true, pending: true, data: change,
      message: 'Saved as a proposal. It takes effect when a different authorised person confirms it (Settings → Statutory rules).' });
  }
  const row = await writeRuleVersion(v, { cid, userId: uid(req), req });
  res.status(201).json({ success: true, data: row });
});

export const listRuleChanges = wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, pu.name AS proposed_by_name, du.name AS decided_by_name
       FROM payroll_statutory_rule_changes c
       LEFT JOIN users pu ON pu.id = c.proposed_by LEFT JOIN users du ON du.id = c.decided_by
      WHERE c.company_id = $1 OR c.scope = 'global'
      ORDER BY (c.status = 'pending') DESC, c.proposed_at DESC LIMIT 100`, [companyOf(req)]);
  res.json({ success: true, data: rows });
});

/**
 * Confirm (apply) or reject a proposed rule version. Not by the person who proposed
 * it, EXCEPT a super admin (owner decision, 10 Nov 2026: "superadmin have all
 * approval"). A super admin deciding their own proposal is audited as 'self_confirm'
 * / 'self_reject' and the decision note says so, so the record never claims a second person.
 */
export const decideRuleChange = wrap(async (req, res) => {
  const cid = companyOf(req);
  const confirm = req.params.decision === 'confirm';
  const { rows: [c] } = await pool.query(
    `SELECT * FROM payroll_statutory_rule_changes WHERE id = $1 AND status = 'pending' AND (company_id = $2 OR scope = 'global')`, [req.params.id, cid]);
  if (!c) return res.status(404).json({ success: false, message: 'No pending rule change with that id' });
  const self = Number(c.proposed_by) === Number(uid(req));
  if (self && !rolesOfReq(req).includes('super_admin')) {
    return res.status(403).json({ success: false, code: 'SAME_PERSON', message: 'You proposed this change, so a different authorised person must confirm or reject it.' });
  }
  if (c.scope === 'global' && !rolesOfReq(req).includes('super_admin')) return res.status(403).json({ success: false, message: 'Only a super admin can decide a change for all companies' });
  const typed = String(req.body?.note || '').trim();
  const note = self ? ['Decided by the super admin who proposed it (no second person).', typed].filter(Boolean).join(' ') : (typed || null);
  let applied = null;
  if (confirm) {
    // Checked again now: payroll may have been approved since it was proposed.
    const v = await checkRuleVersion({ rule_key: c.rule_key, effective_from: String(c.effective_from instanceof Date ? c.effective_from.toISOString() : c.effective_from).slice(0, 10),
      value: c.value, source_reference: c.source_reference, scope: c.scope }, { cid, roles: ['super_admin'] });
    if (v.error) return res.status(v.error.status).json({ success: false, message: v.error.message });
    applied = await writeRuleVersion(v, { cid, userId: c.proposed_by, req });
  }
  const { rows: [done] } = await pool.query(
    `UPDATE payroll_statutory_rule_changes SET status = $2, decided_by = $3, decided_at = NOW(), decision_note = $4, applied_rule_id = $5
      WHERE id = $1 AND status = 'pending' RETURNING *`, [c.id, confirm ? 'confirmed' : 'rejected', uid(req), note, applied?.id ?? null]);
  logAudit({ userId: uid(req), module: 'payroll', recordId: c.id, recordType: 'payroll_statutory_rule_change', action: (self ? 'self_' : '') + (confirm ? 'confirm' : 'reject'), oldData: c, newData: done, req });
  res.json({ success: true, data: { change: done, applied } });
});
