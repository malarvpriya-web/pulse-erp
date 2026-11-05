import express from 'express';
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
} from './payroll.controller.js';
import { companyOf } from '../../shared/scope.js';
import { buildPeriodContext } from './payroll.service.js';
import { computePayroll, PayrollInputError } from './payrollEngine.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { csvCell } from '../../shared/csv.js';

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
router.get('/payslip-pdf/:id',      verifyToken, perm('view'), streamPayslipPdf);
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
        pr.lop_days,
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
      'Total Deductions','Net Pay','LOP Days','Status','Payment Mode','Bank Account','IFSC Code'
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
    const lines = rows.map(r => [
      String(r.uan_number).trim(),
      `${r.first_name || ''} ${r.last_name || ''}`.trim().toUpperCase(),
      Math.round(Number(r.gross)), Math.round(Number(r.pf_contribution_wage)),
      Math.round(Number(r.eps_wage || 0)), Math.round(Number(r.pf_contribution_wage)),
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
        pr.gross            AS gross_wages,
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

    const monthName = ['', 'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'][m];
    const fileName = `ESI_Challan_${monthName}_${y}.csv`;

    const totEmpESI  = rows.reduce((s, r) => s + parseFloat(r.employee_esi || 0), 0);
    const totEmrESI  = rows.reduce((s, r) => s + parseFloat(r.employer_esi || 0), 0);
    const totESI     = totEmpESI + totEmrESI;

    const csvLines = [
      `ESI Challan - ${monthName} ${y}`,
      ``,
      `IP Number,Employee Code,Employee Name,Gross Wages,Employee ESI (0.75%),Employer ESI (3.25%),Total ESI`,
      ...rows.map(r => {
        const name = `${r.first_name || ''} ${r.last_name || ''}`.trim();
        return `${csvCell(r.ip_number || 'PENDING', { minimal: true })},${csvCell(r.employee_code || r.employee_id, { minimal: true })},${csvCell(name)},${parseFloat(r.gross_wages || 0).toFixed(2)},${parseFloat(r.employee_esi || 0).toFixed(2)},${parseFloat(r.employer_esi || 0).toFixed(2)},${(parseFloat(r.employee_esi || 0) + parseFloat(r.employer_esi || 0)).toFixed(2)}`;
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

// ── Statutory Bonus (Payment of Bonus Act 1965) ───────────────────────────────
// GET /payroll/statutory-bonus?year=&department=
// Bonus Act: eligible employees earn ≤ ₹21,000/month; bonus = 8.33% of wages (min)
// Wage basis: basic salary (no DA in this model). Bonus year = Apr to Mar.
router.get('/statutory-bonus', verifyToken, perm('export'), async (req, res) => {
  const bonusYear = parseInt(req.query.year) || new Date().getFullYear();
  const dept      = req.query.department;
  const cid       = companyOf(req);
  // FY: Apr (bonusYear) → Mar (bonusYear+1)
  const fyStart   = bonusYear, fyEnd = bonusYear + 1;

  try {
    // Aggregate annual wages from payroll_runs for the FY
    let q = `
      SELECT
        pr.employee_id,
        TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
        e.office_id  AS emp_code,
        e.department, e.designation,
        e.joining_date,
        COUNT(DISTINCT pr.month || '-' || pr.year)::INT AS months_worked,
        ROUND(AVG(pr.basic))::NUMERIC                    AS avg_basic,
        ROUND(SUM(pr.basic))::NUMERIC                    AS annual_basic_wages
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE (
        (pr.year = $1 AND pr.month >= 4)
        OR (pr.year = $2 AND pr.month <= 3)
      )
      AND e.company_id = $3 AND pr.is_test = false
      AND pr.status IN ('approved', 'paid')
    `;
    const params = [fyStart, fyEnd, cid];
    if (dept) { params.push(dept); q += ` AND e.department = $${params.length}`; }
    q += ` GROUP BY pr.employee_id, e.first_name, e.last_name, e.office_id, e.department, e.designation, e.joining_date`;

    const { rows } = await pool.query(q, params);

    const BONUS_WAGE_CEILING = 21000;    // gross eligibility ceiling
    const MIN_BONUS_PCT      = 8.33 / 100;
    const MAX_BONUS_PCT      = 20.00 / 100;
    const BONUS_CALC_CEILING = 7000;     // wage ceiling for bonus calculation

    const result = rows.map(r => {
      const avgBasic    = parseFloat(r.avg_basic || 0);
      const eligible    = avgBasic <= BONUS_WAGE_CEILING;
      const calcWage    = Math.min(avgBasic, BONUS_CALC_CEILING);
      const minBonus    = eligible ? Math.round(calcWage * 12 * MIN_BONUS_PCT) : 0;
      const maxBonus    = eligible ? Math.round(calcWage * 12 * MAX_BONUS_PCT) : 0;
      return {
        employee_id:    r.employee_id,
        employee_name:  r.employee_name,
        emp_code:       r.emp_code,
        department:     r.department,
        designation:    r.designation,
        months_worked:  r.months_worked,
        avg_basic:      avgBasic,
        eligible:       eligible,
        reason:         eligible ? null : `Average basic ₹${avgBasic.toLocaleString('en-IN')} exceeds ₹21,000 ceiling`,
        bonus_wage:     eligible ? calcWage : 0,
        min_bonus:      minBonus,
        max_bonus:      maxBonus,
        recommended_bonus: minBonus, // 8.33% minimum
      };
    });

    const eligibleCount  = result.filter(r => r.eligible).length;
    const totalMinBonus  = result.reduce((s, r) => s + r.min_bonus, 0);
    const totalMaxBonus  = result.reduce((s, r) => s + r.max_bonus, 0);

    res.json({
      financial_year: `${fyStart}-${fyEnd}`,
      total_employees: result.length,
      eligible_count:  eligibleCount,
      total_min_bonus: totalMinBonus,
      total_max_bonus: totalMaxBonus,
      bonus_wage_ceiling: BONUS_WAGE_CEILING,
      calc_wage_ceiling:  BONUS_CALC_CEILING,
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
    const cfg = { ...item.config, overtime_hours: 0, night_shift_days: 0, bonus: 0, recoveries: [], arrears: null, ytd: null, tds_auto_calculate: false };
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

// ── Loan / Advance management ─────────────────────────────────────────────────
// The month's recovery is loanSchedule.installmentFor() — the same function the
// payroll draft and approval use. Run Payroll deducts it; APPROVAL records it in
// payroll_loan_repayments and reduces the principal outstanding (closing the
// loan at zero). Test/seed loans (is_test) are never listed or recovered.
// PAYROLL_DATA_FLOW_AUDIT.md Part 11.
const withRemaining = (l) => ({ ...l, remaining_installments: remainingInstallments(l), next_installment: installmentFor(l) });

router.get('/loan-advances', verifyToken, perm('view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.*, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
              e.office_id AS employee_code,
              COALESCE((SELECT SUM(r.amount) FROM payroll_loan_repayments r WHERE r.loan_id = l.id), 0) AS repaid_amount,
              (SELECT COUNT(*)::int FROM payroll_loan_repayments r WHERE r.loan_id = l.id AND r.source = 'payroll') AS installments_paid
         FROM payroll_loans l JOIN employees e ON e.id = l.employee_id
        WHERE e.company_id = $1 AND l.status = 'active' AND l.is_test = false
        ORDER BY l.created_at DESC`, [companyOf(req)]);
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

// POST /payroll/loan-advances — principal, start_date, and EMI and/or
// tenure_months; interest_rate (annual %, reducing balance) defaults to 0.
// A one-month recovery needs single_installment: true.
router.post('/loan-advances', verifyToken, perm('edit'), async (req, res) => {
  const { employee_id, reason } = req.body || {};
  if (!employee_id) return res.status(400).json({ message: 'employee_id is required' });
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
                                  emi_schedule, interest_rate, tenure_months, single_installment)
       VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [employee_id, plan.loan_type, plan.principal, plan.emi, plan.start_date, reason ?? null,
       JSON.stringify(plan.schedule), plan.interest_rate, plan.tenure_months, req.body.single_installment === true]);
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

export default router;