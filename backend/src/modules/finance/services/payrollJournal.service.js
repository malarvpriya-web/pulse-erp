/**
 * payrollJournal.service.js
 *
 * Posts a completed/approved payroll period to the General Ledger.
 * DR: 5010 (Salaries), 5011 (Employer PF), 5012 (Employer ESI), 5014 (Staff
 *     Welfare, only for the employer's LWF share — no dedicated employer-LWF
 *     expense account exists in the COA)
 * CR: 2030 (PF Payable, employee+employer), 2031 (ESI Payable,
 *     employee+employer), 2033 (LWF Payable, employee+employer), 2003 (TDS
 *     Payable), 2032 (Professional Tax Payable), 2040 (Salary Payable, net)
 *
 * Previously this only ever debited gross+employer PF/ESI and credited net
 * pay — the gap between gross and net (employee PF/ESI/TDS/professional
 * tax/LWF, all real liabilities to statutory authorities) was never
 * credited anywhere, so the entry silently didn't balance whenever any of
 * those applied. Every component now gets its own credit line so
 * total_debit == total_credit unconditionally (verified in a live
 * rolled-back-transaction smoke test, not just by inspection).
 *
 * Extracted from accounting.routes.js's POST /payroll-journal handler so the
 * same posting logic can be triggered automatically when Payroll approves a
 * period (payroll.routes.js POST /approve), not only via a manual API call.
 */

import pool from '../db.js';
import { nextAccountingJournalNumber } from '../../../shared/docNumber.js';

export async function postPayrollJournal({
  payroll_run_id, payroll_month, net_salary, pf_employer, esi_employer, gross_salary,
  pf_employee = 0, esi_employee = 0, tds = 0, professional_tax = 0,
  lwf_employee = 0, lwf_employer = 0,
  companyId = null, userId = null,
}) {
  if (!payroll_run_id || !payroll_month) {
    throw new Error('payroll_run_id and payroll_month are required');
  }

  const grossAmt = parseFloat(gross_salary || net_salary || 0);
  const empPf = parseFloat(pf_employer || 0);
  const empEsi = parseFloat(esi_employer || 0);
  const empLwf = parseFloat(lwf_employer || 0);
  const eePf = parseFloat(pf_employee || 0);
  const eeEsi = parseFloat(esi_employee || 0);
  const eeLwf = parseFloat(lwf_employee || 0);
  const tdsAmt = parseFloat(tds || 0);
  const ptAmt = parseFloat(professional_tax || 0);
  const totalExp = grossAmt + empPf + empEsi + empLwf;
  const salaryPayable = parseFloat(net_salary || grossAmt);
  const pfPayable = eePf + empPf;
  const esiPayable = eeEsi + empEsi;
  const lwfPayable = eeLwf + empLwf;

  if (totalExp <= 0) {
    return { skipped: true, reason: 'Salary amounts must be greater than zero' };
  }

  // Idempotent — a period already posted (manually or by a previous approval) is left alone.
  const { rows: existing } = await pool.query(
    `SELECT id FROM journal_entries WHERE reference_type = 'payroll_run' AND reference_id = $1`,
    [String(payroll_run_id)]
  );
  if (existing.length > 0) {
    return { skipped: true, reason: 'already_posted', journal_entry_id: existing[0].id };
  }

  const { rows: accts } = await pool.query(
    `SELECT id, code, name FROM chart_of_accounts
     WHERE code IN ('5010','5011','5012','5014','2030','2031','2032','2033','2003','2040') AND is_active = true`
  );
  const am = accts.reduce((m, a) => { m[a.code] = a; return m; }, {});
  if (!am['5010'] || !am['2040']) {
    return { skipped: true, reason: 'Required accounts 5010 (Salaries) and 2040 (Salary Payable) not found in COA' };
  }
  // Any nonzero component whose payable/expense account is missing would
  // otherwise post an unbalanced entry — skip gracefully instead, same
  // discipline as the 5010/2040 check above.
  const requiredIfNonzero = [
    [empPf || eePf, '2030', 'PF Payable'], [empEsi || eeEsi, '2031', 'ESI Payable'],
    [empLwf || eeLwf, '2033', 'LWF Payable'], [tdsAmt, '2003', 'TDS Payable'],
    [ptAmt, '2032', 'Professional Tax Payable'], [empLwf, '5014', 'Staff Welfare'],
  ];
  for (const [amt, code, label] of requiredIfNonzero) {
    if (amt > 0 && !am[code]) {
      return { skipped: true, reason: `Required account ${code} (${label}) not found in COA` };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entryNumber = await nextAccountingJournalNumber(client);
    const [y, m] = payroll_month.split('-').map(Number);
    const entryDate = `${payroll_month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; // last day of payroll month
    const totalCredit = pfPayable + esiPayable + lwfPayable + tdsAmt + ptAmt + salaryPayable;
    const { rows: [je] } = await client.query(
      `INSERT INTO journal_entries
         (entry_number, entry_date, entry_type, description, reference_type, reference_id, status, total_debit, total_credit, company_id, created_by)
       VALUES ($1, $2, 'Payroll', $3, 'payroll_run', $4, 'posted', $5, $6, $7, $8) RETURNING *`,
      [entryNumber, entryDate, `Payroll journal — ${payroll_month}`, String(payroll_run_id), totalExp, totalCredit, companyId, userId]
    );

    const insertLine = (code, debit, credit, narration) => {
      const a = am[code];
      if (!a || (debit === 0 && credit === 0)) return Promise.resolve();
      return client.query(
        `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [je.id, a.id, code, a.name, debit, credit, narration, companyId]
      );
    };
    await insertLine('5010', grossAmt, 0, `Gross salary — ${payroll_month}`);
    if (empPf > 0) await insertLine('5011', empPf, 0, `PF employer contribution — ${payroll_month}`);
    if (empEsi > 0) await insertLine('5012', empEsi, 0, `ESI employer contribution — ${payroll_month}`);
    if (empLwf > 0) await insertLine('5014', empLwf, 0, `LWF employer contribution — ${payroll_month}`);
    if (pfPayable > 0) await insertLine('2030', 0, pfPayable, `PF payable (employee ${eePf} + employer ${empPf}) — ${payroll_month}`);
    if (esiPayable > 0) await insertLine('2031', 0, esiPayable, `ESI payable (employee ${eeEsi} + employer ${empEsi}) — ${payroll_month}`);
    if (lwfPayable > 0) await insertLine('2033', 0, lwfPayable, `LWF payable (employee ${eeLwf} + employer ${empLwf}) — ${payroll_month}`);
    if (tdsAmt > 0) await insertLine('2003', 0, tdsAmt, `TDS on salary — ${payroll_month}`);
    if (ptAmt > 0) await insertLine('2032', 0, ptAmt, `Professional tax — ${payroll_month}`);
    await insertLine('2040', 0, salaryPayable, `Salary payable — ${payroll_month}`);

    await client.query('COMMIT');
    return {
      success: true,
      journal_entry: { id: je.id, entry_number: je.entry_number, status: 'posted' },
      summary: {
        gross_salary: grossAmt, pf_employer: empPf, esi_employer: empEsi, lwf_employer: empLwf,
        pf_payable: pfPayable, esi_payable: esiPayable, lwf_payable: lwfPayable,
        tds: tdsAmt, professional_tax: ptAmt, salary_payable: salaryPayable,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
