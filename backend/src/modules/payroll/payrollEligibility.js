/**
 * payrollEligibility.js — THE payroll eligibility rule, and the statutory data
 * checks that gate final output. Pure functions; payroll.service.js supplies
 * the rows.
 *
 * Before this file the answer to "who is on payroll for September?" depended
 * on the screen: Employee Directory and Payslip Generator counted 32 (status
 * only), Run Payroll showed 0 (a response-envelope bug), and generation paid
 * every active-status employee — 24 of them ₹2,850 each with no salary on
 * record, because a "0" basic still produced fixed allowances.
 *
 * An employee is ELIGIBLE for wage month M when ALL of these hold:
 *   E1  employee belongs to the company and is not deleted
 *   E2  lifecycle status is Active, Probation or Notice (case-insensitive)
 *   E3  joining_date is set and on or before the last day of M
 *   E4  exit_date is empty or on or after the first day of M
 *   E5  a salary revision (employee_salary_assignments) is in force on the last
 *       day of M — effective_from <= period end — with basic_salary > 0
 *   E6  a salary structure applies: the revision's own, else the company's
 *       default structure
 * Nothing else. In particular `employees.basic_salary` is NOT a source: it is a
 * denormalised copy kept in step by the hire/increment paths; when an employee
 * has a figure there but no revision, the reason says so and names the fix.
 * There is no separate "payroll eligibility flag" and no separate "structure
 * assignment" step — Add Employee's salary IS the first revision.
 */

export const ELIGIBILITY_RULE = [
  { code: 'E1', text: 'Belongs to this company and is not deleted' },
  { code: 'E2', text: 'Status is Active, Probation or Notice' },
  { code: 'E3', text: 'Joining date is on or before the last day of the month' },
  { code: 'E4', text: 'No exit date, or exit date on or after the first day of the month' },
  { code: 'E5', text: 'A salary revision with Basic > 0 is effective on or before the last day of the month' },
  { code: 'E6', text: 'A salary structure applies (the revision\'s, or the company default)' },
];

export const PAYABLE_STATUSES = ['active', 'probation', 'notice'];

const iso = (d) => (d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)));

/**
 * @param row  employee row with: status, joining_date, exit_date, deleted_at,
 *             revision_basic, revision_effective_from, master_basic,
 *             structure_components
 * @param period { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
 */
export function evaluateEligibility(row, period) {
  const reasons = [];
  if (row.deleted_at) reasons.push({ code: 'E1', message: 'Employee record is deleted' });
  const st = String(row.status || '').toLowerCase();
  if (!PAYABLE_STATUSES.includes(st)) reasons.push({ code: 'E2', message: `Status is "${row.status || 'blank'}"` });
  const doj = iso(row.joining_date);
  if (!doj) reasons.push({ code: 'E3', message: 'Joining date is missing' });
  else if (doj > period.end) reasons.push({ code: 'E3', message: `Joins on ${doj}, after this period` });
  const exit = iso(row.exit_date);
  if (exit && exit < period.start) reasons.push({ code: 'E4', message: `Exited on ${exit}, before this period` });
  const basic = parseFloat(row.revision_basic);
  if (!(basic > 0)) {
    const master = parseFloat(row.master_basic);
    const offer = parseFloat(row.offer_annual_ctc);
    const offerNote = offer > 0
      ? ` Accepted offer: Annual CTC ₹${offer.toLocaleString('en-IN')} — convert it to a MONTHLY Basic under the company's CTC definition before recording it.`
      : '';
    reasons.push({
      code: 'E5',
      message: (master > 0
        ? `No salary revision effective by ${period.end}. Employee master shows Basic ₹${master.toLocaleString('en-IN')} — record it as a salary revision (Salary Structure → Assign) to make it payable`
        : `No salary revision effective by ${period.end}`) + offerNote,
    });
  }
  const hasApprovedBreakdown = Array.isArray(row.revision_breakdown?.monthly?.components) && row.revision_breakdown.monthly.components.length > 0;
  if (!hasApprovedBreakdown && (!Array.isArray(row.structure_components) || !row.structure_components.length)) {
    reasons.push({ code: 'E6', message: 'No salary structure, and no company default structure' });
  }
  return { eligible: reasons.length === 0, reasons };
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCT_RE = /^[0-9]{9,18}$/;
const UAN_RE = /^[0-9]{12}$/;
const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

export const isValidPAN = (v) => PAN_RE.test(String(v || '').trim().toUpperCase());
export const isValidTAN = (v) => TAN_RE.test(String(v || '').trim().toUpperCase());

/**
 * Data an approved payslip / statutory file cannot be produced without.
 * severity 'error' blocks approval; 'warning' is shown but does not block.
 *   bank account / IFSC  → error: salary cannot be disbursed
 *   PAN when TDS > 0     → error: s.192 deduction cannot be reported in Form 138
 *   PAN when TDS = 0     → warning (needed before year end)
 *   UAN when PF > 0      → warning: blocks the ECR, not the payslip
 */
export function validateStatutoryProfile(emp, slip = {}) {
  const issues = [];
  const add = (field, severity, message) => issues.push({ field, severity, message });
  const pan = String(emp.pan_number || '').trim().toUpperCase();
  if (!pan) add('pan_number', (slip.tds || 0) > 0 ? 'error' : 'warning', 'PAN is missing');
  else if (!PAN_RE.test(pan)) add('pan_number', (slip.tds || 0) > 0 ? 'error' : 'warning', `PAN "${emp.pan_number}" is not in the format AAAAA9999A`);
  const acct = String(emp.account_number ?? emp.bank_account ?? '').replace(/\s/g, '');
  if (!acct) add('account_number', 'error', 'Bank account number is missing');
  else if (!ACCT_RE.test(acct)) add('account_number', 'error', 'Bank account number must be 9–18 digits');
  const ifsc = String(emp.ifsc_code || '').trim().toUpperCase();
  if (!ifsc) add('ifsc_code', 'error', 'IFSC is missing');
  else if (!IFSC_RE.test(ifsc)) add('ifsc_code', 'error', `IFSC "${emp.ifsc_code}" is not in the format AAAA0XXXXXX`);
  if ((slip.employee_pf || 0) > 0) {
    const uan = String(emp.uan_number || '').trim();
    if (!uan) add('uan_number', 'warning', 'UAN is missing — required for the PF ECR');
    else if (!UAN_RE.test(uan)) add('uan_number', 'warning', 'UAN must be 12 digits — required for the PF ECR');
  }
  return issues;
}

export const blockingIssues = (issues) => (issues || []).filter(i => i.severity === 'error');
