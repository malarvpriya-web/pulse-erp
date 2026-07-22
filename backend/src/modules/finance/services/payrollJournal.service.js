/**
 * payrollJournal.service.js
 *
 * Posts a completed/approved payroll period to the General Ledger.
 * DR: 5010 (Salaries), 5011 (PF Employer), 5012 (ESI Employer)
 * CR: 2040 (Salary Payable)
 *
 * Extracted from accounting.routes.js's POST /payroll-journal handler so the
 * same posting logic can be triggered automatically when Payroll approves a
 * period (payroll.routes.js POST /approve), not only via a manual API call.
 */

import pool from '../db.js';
import { nextAccountingJournalNumber } from '../../../shared/docNumber.js';

export async function postPayrollJournal({
  payroll_run_id, payroll_month, net_salary, pf_employer, esi_employer, gross_salary,
  companyId = null, userId = null,
}) {
  if (!payroll_run_id || !payroll_month) {
    throw new Error('payroll_run_id and payroll_month are required');
  }

  const grossAmt = parseFloat(gross_salary || net_salary || 0);
  const pfAmt = parseFloat(pf_employer || 0);
  const esiAmt = parseFloat(esi_employer || 0);
  const totalExp = grossAmt + pfAmt + esiAmt;
  const salaryPayable = parseFloat(net_salary || grossAmt);

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
    `SELECT id, code, name FROM chart_of_accounts WHERE code IN ('5010','5011','5012','2040') AND is_active = true`
  );
  const am = accts.reduce((m, a) => { m[a.code] = a; return m; }, {});
  if (!am['5010'] || !am['2040']) {
    return { skipped: true, reason: 'Required accounts 5010 (Salaries) and 2040 (Salary Payable) not found in COA' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entryNumber = await nextAccountingJournalNumber(client);
    const [y, m] = payroll_month.split('-').map(Number);
    const entryDate = `${payroll_month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; // last day of payroll month
    const { rows: [je] } = await client.query(
      `INSERT INTO journal_entries
         (entry_number, entry_date, entry_type, description, reference_type, reference_id, status, total_debit, total_credit, company_id, created_by)
       VALUES ($1, $2, 'Payroll', $3, 'payroll_run', $4, 'posted', $5, $6, $7, $8) RETURNING *`,
      [entryNumber, entryDate, `Payroll journal — ${payroll_month}`, String(payroll_run_id), totalExp, salaryPayable, companyId, userId]
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
    if (pfAmt > 0 && am['5011']) await insertLine('5011', pfAmt, 0, `PF employer contribution — ${payroll_month}`);
    if (esiAmt > 0 && am['5012']) await insertLine('5012', esiAmt, 0, `ESI employer contribution — ${payroll_month}`);
    await insertLine('2040', 0, salaryPayable, `Salary payable — ${payroll_month}`);

    await client.query('COMMIT');
    return {
      success: true,
      journal_entry: { id: je.id, entry_number: je.entry_number, status: 'posted' },
      summary: { gross_salary: grossAmt, pf_employer: pfAmt, esi_employer: esiAmt, salary_payable: salaryPayable },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
