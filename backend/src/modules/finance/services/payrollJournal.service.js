/**
 * payrollJournal.service.js
 *
 * Posts an approved payroll batch to the General Ledger.
 * DR: 5010 (Salaries), 5011 (Employer PF), 5012 (Employer ESI), 5014 (Staff
 *     Welfare, only for the employer's LWF share — no dedicated employer-LWF
 *     expense account exists in the COA)
 * CR: 2030 (PF Payable, employee+employer), 2031 (ESI Payable,
 *     employee+employer), 2033 (LWF Payable, employee+employer), 2003 (TDS
 *     Payable), 2032 (Professional Tax Payable), 2040 (Salary Payable, net),
 *     and for loan / advance installments recovered from pay: PRINCIPAL to
 *     the receivable and INTEREST to the income account Finance mapped
 *     (loanGlMapping.service.js) — never an assumed account.
 *
 * PC-02a (PD-15, 04 Nov 26):
 *  - accounts are the COMPANY's (its own, else the shared chart) — the lookup
 *    had no company predicate and could post against another tenant's ids;
 *  - the entry goes through journalRepo.postEntry, so the posting guards apply
 *    (balanced, accounts usable, transaction lock date, open period) — it used
 *    to be inserted as status 'posted' directly, past every one of them;
 *  - one journal per company + reference, checked inside the posting
 *    transaction under an advisory lock and backed by the unique index
 *    ux_journal_entries_payroll_reference (migration 20261104000003);
 *  - recoverPayrollJournals() is the ONLY manual path: it posts the accrual an
 *    approval batch is missing, with every amount derived from the approved
 *    runs and their loan-repayment rows. No caller supplies an amount.
 *
 * An approval batch is the set of runs one approval transaction approved: they
 * share company, month, year and approved_at (one NOW() per transaction). Its
 * reference is `YYYY-MM:<lowest run id>` — the same reference the approval
 * posts under (payroll.controller.js approvePayroll), so a recovery can never
 * duplicate an approval's journal or vice versa.
 */

import pool from '../db.js';
import { nextAccountingJournalNumber } from '../../../shared/docNumber.js';
import { getLoanGlMapping } from './loanGlMapping.service.js';
import journalRepo from '../repositories/journal.repository.js';

const cents = (v) => Math.round(v * 100);
const COA_CODES = ['5010', '5011', '5012', '5014', '2030', '2031', '2032', '2033', '2003', '2040'];

export class PayrollJournalError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

/** The company's accounts by code — its own first, else the shared chart (company_id NULL). */
async function companyAccounts(executor, companyId, codes) {
  const { rows } = await executor.query(
    `SELECT DISTINCT ON (code) id, code, name FROM chart_of_accounts
      WHERE code = ANY($1) AND is_active = true AND (company_id = $2 OR company_id IS NULL)
      ORDER BY code, company_id NULLS LAST`, [codes, companyId]);
  return rows.reduce((m, a) => { m[a.code] = a; return m; }, {});
}

/**
 * Post one payroll accrual INSIDE the caller's transaction (`client` has BEGIN
 * open). Throws PayrollJournalError on every refusal — nothing is ever silently
 * skipped — so the caller's whole transaction rolls back with it:
 *   400 COMPANY_REQUIRED · 422 LOAN_GL_MAPPING_REQUIRED · 422 ACCOUNTS_MISSING ·
 *   422 JOURNAL_UNBALANCED · 409 ACCRUAL_JOURNAL_EXISTS · 422 <posting-guard code>
 *   (lock date, closed period, unusable account — journalRepo.postEntry).
 * An all-zero batch (nothing to accrue) returns { posted: false, reason: 'nothing_to_accrue' }.
 *
 * Payroll approval calls this in its own transaction (F-03, 04 Nov 26), so a
 * period is approved — and its payslips released — only with its accrual posted.
 */
export async function postAccrualInTransaction(client, {
  payroll_run_id, payroll_month, net_salary, pf_employer, esi_employer, gross_salary,
  pf_employee = 0, esi_employee = 0, tds = 0, professional_tax = 0,
  lwf_employee = 0, lwf_employer = 0, loan_principal = 0, loan_interest = 0,
  companyId = null, userId = null,
}) {
  if (!payroll_run_id || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(payroll_month || ''))) {
    throw new PayrollJournalError(400, 'A payroll reference and a payroll month (YYYY-MM) are required', 'PERIOD_INVALID');
  }
  if (companyId == null) throw new PayrollJournalError(400, 'A payroll journal is posted for one company; none was given', 'COMPANY_REQUIRED');

  const grossAmt = parseFloat(gross_salary || net_salary || 0);
  const empPf = parseFloat(pf_employer || 0);
  const empEsi = parseFloat(esi_employer || 0);
  const empLwf = parseFloat(lwf_employer || 0);
  const eePf = parseFloat(pf_employee || 0);
  const eeEsi = parseFloat(esi_employee || 0);
  const eeLwf = parseFloat(lwf_employee || 0);
  const tdsAmt = parseFloat(tds || 0);
  const ptAmt = parseFloat(professional_tax || 0);
  const loanPrincipal = parseFloat(loan_principal || 0);
  const loanInterest = parseFloat(loan_interest || 0);
  const totalExp = grossAmt + empPf + empEsi + empLwf;
  // `net_salary || gross` made a net pay of 0 (deductions = gross) credit gross.
  const salaryPayable = net_salary == null || net_salary === '' ? grossAmt : parseFloat(net_salary);
  const pfPayable = eePf + empPf;
  const esiPayable = eeEsi + empEsi;
  const lwfPayable = eeLwf + empLwf;
  for (const v of [grossAmt, empPf, empEsi, empLwf, eePf, eeEsi, eeLwf, tdsAmt, ptAmt, loanPrincipal, loanInterest, salaryPayable]) {
    if (!Number.isFinite(v) || v < 0) throw new PayrollJournalError(422, 'Payroll amounts must be non-negative numbers', 'AMOUNT_INVALID');
  }
  if (totalExp <= 0) return { posted: false, reason: 'nothing_to_accrue' };

  // Loan lines use ONLY Finance's approved mapping.
  let loanAccts = null;
  if (loanPrincipal > 0 || loanInterest > 0) {
    const mapping = await getLoanGlMapping(companyId, client);
    if (mapping.status !== 'approved') {
      throw new PayrollJournalError(422, `Loan recoveries cannot be posted: ${mapping.problems.join('; ')}`, 'LOAN_GL_MAPPING_REQUIRED');
    }
    loanAccts = mapping.accounts;
  }

  const am = await companyAccounts(client, companyId, COA_CODES);
  if (loanAccts) {
    am[loanAccts.receivable.code] = loanAccts.receivable;
    am[loanAccts.interest_income.code] = loanAccts.interest_income;
  }
  if (!am['5010'] || !am['2040']) {
    throw new PayrollJournalError(422, 'Required accounts 5010 (Salaries) and 2040 (Salary Payable) not found in the chart of accounts', 'ACCOUNTS_MISSING');
  }
  // Any nonzero component whose payable/expense account is missing would
  // otherwise post an unbalanced entry.
  const requiredIfNonzero = [
    [empPf || eePf, '2030', 'PF Payable'], [empEsi || eeEsi, '2031', 'ESI Payable'],
    [empLwf || eeLwf, '2033', 'LWF Payable'], [tdsAmt, '2003', 'TDS Payable'],
    [ptAmt, '2032', 'Professional Tax Payable'], [empLwf, '5014', 'Staff Welfare'],
  ];
  for (const [amt, code, label] of requiredIfNonzero) {
    if (amt > 0 && !am[code]) {
      throw new PayrollJournalError(422, `Required account ${code} (${label}) not found in the chart of accounts`, 'ACCOUNTS_MISSING');
    }
  }

  // Refuse, never post, an entry that does not balance.
  const debitCents = cents(totalExp);
  const creditCents = cents(pfPayable + esiPayable + lwfPayable + tdsAmt + ptAmt + loanPrincipal + loanInterest + salaryPayable);
  if (debitCents !== creditCents) {
    throw new PayrollJournalError(422, `Payroll journal would not balance (debits ${debitCents / 100}, credits ${creditCents / 100})`, 'JOURNAL_UNBALANCED');
  }

  const ref = String(payroll_run_id);
  // One poster per company + reference at a time; the unique index
  // ux_journal_entries_payroll_reference is the backstop.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`payroll_journal:${companyId}:${ref}`]);
  const { rows: existing } = await client.query(
    `SELECT id FROM journal_entries
      WHERE reference_type = 'payroll_run' AND reference_id = $1 AND company_id = $2
        AND deleted_at IS NULL AND reversal_of_id IS NULL`, [ref, companyId]);
  if (existing.length > 0) {
    throw Object.assign(new PayrollJournalError(409, `An accrual journal already exists for payroll reference ${ref}`, 'ACCRUAL_JOURNAL_EXISTS'), { journal_entry_id: existing[0].id });
  }

  const [y, m] = payroll_month.split('-').map(Number);
  const entryDate = `${payroll_month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; // last day of payroll month
  // A savepoint so a refused posting is rolled back with a precise reason while
  // the caller decides what to do with its own transaction (approval rolls back).
  await client.query('SAVEPOINT payroll_accrual');
  try {
    const je = await journalRepo.createEntry(client, {
      entry_number: await nextAccountingJournalNumber(client), entry_date: entryDate, entry_type: 'Payroll',
      reference_type: 'payroll_run', reference_id: ref, description: `Payroll journal — ${payroll_month}`,
      created_by: userId, company_id: companyId,
    });
    const line = (code, debit, credit, narration) => {
      const a = am[code];
      if (!a || (debit === 0 && credit === 0)) return Promise.resolve();
      return journalRepo.createLine(client, { journal_entry_id: je.id, account_id: a.id, account_code: code, description: narration, debit, credit, company_id: companyId });
    };
    await line('5010', grossAmt, 0, `Gross salary — ${payroll_month}`);
    if (empPf > 0) await line('5011', empPf, 0, `PF employer contribution — ${payroll_month}`);
    if (empEsi > 0) await line('5012', empEsi, 0, `ESI employer contribution — ${payroll_month}`);
    if (empLwf > 0) await line('5014', empLwf, 0, `LWF employer contribution — ${payroll_month}`);
    if (pfPayable > 0) await line('2030', 0, pfPayable, `PF payable (employee ${eePf} + employer ${empPf}) — ${payroll_month}`);
    if (esiPayable > 0) await line('2031', 0, esiPayable, `ESI payable (employee ${eeEsi} + employer ${empEsi}) — ${payroll_month}`);
    if (lwfPayable > 0) await line('2033', 0, lwfPayable, `LWF payable (employee ${eeLwf} + employer ${empLwf}) — ${payroll_month}`);
    if (tdsAmt > 0) await line('2003', 0, tdsAmt, `TDS on salary — ${payroll_month}`);
    if (ptAmt > 0) await line('2032', 0, ptAmt, `Professional tax — ${payroll_month}`);
    if (loanPrincipal > 0) await line(loanAccts.receivable.code, 0, loanPrincipal, `Loan / advance principal recovered — ${payroll_month}`);
    if (loanInterest > 0) await line(loanAccts.interest_income.code, 0, loanInterest, `Interest on employee loans — ${payroll_month}`);
    await line('2040', 0, salaryPayable, `Salary payable — ${payroll_month}`);
    // The posting guards: balanced, accounts usable, lock date, open period.
    const posted = await journalRepo.postEntry(client, je.id);
    await client.query('RELEASE SAVEPOINT payroll_accrual');
    return {
      posted: true,
      journal_entry: { id: je.id, entry_number: je.entry_number, status: posted?.status ?? 'posted', entry_date: entryDate },
      summary: {
        gross_salary: grossAmt, pf_employer: empPf, esi_employer: empEsi, lwf_employer: empLwf,
        pf_payable: pfPayable, esi_payable: esiPayable, lwf_payable: lwfPayable,
        tds: tdsAmt, professional_tax: ptAmt, salary_payable: salaryPayable,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT payroll_accrual').catch(() => {});
    if (err.code === '23505') throw new PayrollJournalError(409, `An accrual journal already exists for payroll reference ${ref}`, 'ACCRUAL_JOURNAL_EXISTS');
    // A posting guard (lock date, closed period, unusable account) refused it.
    if (err.status && err.status < 500) throw new PayrollJournalError(422, err.message, err.code || 'POSTING_REFUSED');
    throw err;
  }
}

/**
 * Standalone posting (recovery): its own transaction around
 * postAccrualInTransaction. Returns { success, journal_entry } or
 * { skipped, code, reason } — a refusal never posts anything.
 */
export async function postPayrollJournal(params) {
  if (!params?.payroll_run_id || !params?.payroll_month) {
    throw new Error('payroll_run_id and payroll_month are required');
  }
  if (params.companyId == null) {
    return { skipped: true, code: 'COMPANY_REQUIRED', reason: 'A payroll journal is posted for one company; none was given' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await postAccrualInTransaction(client, params);
    await client.query('COMMIT');
    if (!r.posted) return { skipped: true, reason: 'Salary amounts must be greater than zero' };
    return { success: true, journal_entry: r.journal_entry, summary: r.summary };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PayrollJournalError) {
      return err.code === 'ACCRUAL_JOURNAL_EXISTS'
        ? { skipped: true, reason: 'already_posted', journal_entry_id: err.journal_entry_id }
        : { skipped: true, code: err.code, reason: err.message };
    }
    throw err;
  } finally {
    client.release();
  }
}

const RUN_TOTALS = ['gross', 'net_pay', 'employer_pf', 'employer_esi', 'employee_pf', 'employee_esi', 'tds',
  'professional_tax', 'lwf_employee', 'lwf_employer'];

/**
 * Post the accrual every approval batch of one company-period is missing.
 * Amounts come only from the approved / paid runs and their payroll loan
 * repayment rows. A batch whose journal exists is reported, never re-posted.
 *
 * @returns {Promise<{ month:number, year:number, batches: Array<{reference, run_count, status, journal_entry_id?, reason?}> }>}
 */
export async function recoverPayrollJournals({ companyId, month, year, userId = null }) {
  if (companyId == null) throw new PayrollJournalError(400, 'Company context required', 'COMPANY_REQUIRED');
  const m = parseInt(month, 10), y = parseInt(year, 10);
  if (!(m >= 1 && m <= 12) || !(y >= 2000 && y <= 2100)) {
    throw new PayrollJournalError(400, 'A valid payroll month (1–12) and year are required', 'PERIOD_INVALID');
  }
  const tag = `${y}-${String(m).padStart(2, '0')}`;
  const { rows: runs } = await pool.query(
    `SELECT pr.id, pr.approved_at, ${RUN_TOTALS.map(c => `pr.${c}`).join(', ')}
       FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
      WHERE e.company_id = $1 AND pr.month = $2 AND pr.year = $3 AND pr.is_test = false
        AND pr.status IN ('approved', 'paid') AND pr.approved_at IS NOT NULL
      ORDER BY pr.approved_at, pr.id`, [companyId, m, y]);
  if (!runs.length) {
    throw new PayrollJournalError(404, `No approved payroll for ${tag} in this company`, 'NO_APPROVED_PAYROLL');
  }
  const batches = new Map();
  for (const r of runs) {
    const k = new Date(r.approved_at).toISOString();
    if (!batches.has(k)) batches.set(k, []);
    batches.get(k).push(r);
  }
  const results = [];
  for (const rows of batches.values()) {
    const ids = rows.map(r => r.id);
    const reference = `${tag}:${Math.min(...ids)}`;
    const t = rows.reduce((a, r) => { for (const k of RUN_TOTALS) a[k] = (a[k] || 0) + Number(r[k] || 0); return a; }, {});
    const { rows: [loan] } = await pool.query(
      `SELECT COALESCE(SUM(principal_component), 0)::numeric AS principal, COALESCE(SUM(interest_component), 0)::numeric AS interest
         FROM payroll_loan_repayments WHERE source = 'payroll' AND payroll_run_id = ANY($1::int[])`, [ids]);
    const r = await postPayrollJournal({
      payroll_run_id: reference, payroll_month: tag, gross_salary: t.gross, net_salary: t.net_pay,
      pf_employer: t.employer_pf, esi_employer: t.employer_esi, pf_employee: t.employee_pf, esi_employee: t.employee_esi,
      tds: t.tds, professional_tax: t.professional_tax, lwf_employee: t.lwf_employee, lwf_employer: t.lwf_employer,
      loan_principal: Number(loan.principal), loan_interest: Number(loan.interest), companyId, userId,
    });
    results.push(r.success
      ? { reference, run_count: ids.length, status: 'posted', journal_entry_id: r.journal_entry.id }
      : { reference, run_count: ids.length, status: r.reason === 'already_posted' ? 'already_posted' : 'refused', journal_entry_id: r.journal_entry_id, reason: r.reason, code: r.code });
  }
  return { month: m, year: y, batches: results };
}
