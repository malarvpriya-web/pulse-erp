/**
 * payrollCompliance.service.js — what payroll owes and pays after approval.
 *
 *   statutoryDues      PF / ESI / PT / LWF / TDS for a month: amount, due date,
 *                      and whether it has been paid
 *   recordRemittance   a PF / ESI / PT / LWF payment to the authority, with its
 *                      challan reference, posted Dr payable / Cr bank in one tx
 *   opening balances   salary, tax and PF before Pulse or with a previous employer
 *   tax regime         each employee's regime for a tax year (default: new)
 *   bankFile           the salary transfer list for Finance (full account numbers)
 *   recordLoanPayout   the payout of an employee loan: Dr receivable / Cr bank
 *
 * Amounts always come from approved / paid runs; no caller supplies one.
 */
import pool from '../shared/db.js';
import XLSX from 'xlsx';
import journalRepo from '../finance/repositories/journal.repository.js';
import { getLoanGlMapping } from '../finance/services/loanGlMapping.service.js';
import { loadRules } from './statutoryRules.js';
import { getMonthName, indianFinancialYear, periodEndDate, parseFinancialYear, oldRegimeDeductions, hraExemption } from './payrollEngine.js';
import { PayrollHttpError, FINAL_STATUSES, todayIST, fetchPayrollSettings, previewEmployeePayslip } from './payroll.service.js';
import { normalizeState } from './payrollEngine.js';

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const next = (m, y) => (m === 12 ? [1, y + 1] : [m + 1, y]);

export const REMITTANCE_ACCOUNTS = { pf: '2030', esi: '2031', pt: '2032', lwf: '2033' };
const BANK_ACCOUNT = '1001';

function requireCompany(company_id) {
  if (company_id == null) throw new PayrollHttpError(400, 'Payroll is per company — sign in to (or select) a company first');
}
function periodOf(month, year) {
  const m = parseInt(month), y = parseInt(year);
  if (!(m >= 1 && m <= 12) || !(y >= 2000 && y <= 2100)) throw new PayrollHttpError(400, 'A valid month and year are required');
  return { m, y, label: `${getMonthName(m)} ${y}` };
}

/**
 * When each levy for wage month m/y is due.
 *   PF, ESI   15th of the following month
 *   TDS       7th of the following month; tax deducted in March by 30 April
 *   PT (TN)   half-yearly: the April–September half by 30 September, the
 *             October–March half by 31 March (ULB Rules 2023 r.277)
 *   LWF (TN)  by 31 January for the calendar year — NOT confirmed (see rule notes)
 */
export function dueDates(m, y, state) {
  const [nm, ny] = next(m, y);
  const tn = normalizeState(state) === 'TN';
  return {
    pf: { date: iso(ny, nm, 15), basis: 'EPF: 15th of the following month' },
    esi: { date: iso(ny, nm, 15), basis: 'ESI: 15th of the following month' },
    tds: { date: m === 3 ? iso(y, 4, 30) : iso(ny, nm, 7), basis: m === 3 ? 'Tax deducted in March: 30 April' : 'Tax deducted: 7th of the following month' },
    pt: tn ? { date: m >= 4 && m <= 9 ? iso(y, 9, 30) : iso(m >= 10 ? y + 1 : y, 3, 31), basis: 'Tamil Nadu: half-yearly, by 30 September / 31 March' }
      : { date: null, basis: 'Check your state professional tax due date' },
    // the calendar year's contribution (deducted from December wages) is due by 31 January of the next year
    lwf: tn ? { date: iso(y + 1, 1, 31), basis: 'Tamil Nadu: by 31 January (not confirmed: check rule 12 with the Labour Welfare Board)' }
      : { date: null, basis: 'Check your state labour welfare fund due date' },
  };
}

export async function statutoryDues({ company_id, month, year }) {
  requireCompany(company_id);
  const { m, y, label } = periodOf(month, year);
  const [{ rows: [t] }, { rows: rem }, { rows: [tdsDep] }, { settings }, { values: rules }] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE pr.status = 'paid')::int AS paid,
             COALESCE(SUM(pr.employee_pf + pr.employer_pf + pr.edli_employer + pr.pf_admin_employer), 0) AS pf,
             COALESCE(SUM(pr.pf_admin_employer), 0) AS pf_admin, COALESCE(SUM(pr.employee_pf), 0) AS employee_pf,
             COALESCE(SUM(pr.employee_esi + pr.employer_esi), 0) AS esi,
             COALESCE(SUM(pr.professional_tax), 0) AS pt,
             COALESCE(SUM(pr.lwf_employee + pr.lwf_employer), 0) AS lwf,
             COALESCE(SUM(pr.tds), 0) AS tds
        FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
       WHERE e.company_id = $1 AND pr.month = $2 AND pr.year = $3 AND pr.is_test = false AND pr.status = ANY($4::text[])`,
      [company_id, m, y, FINAL_STATUSES]),
    pool.query('SELECT * FROM payroll_statutory_remittances WHERE company_id = $1 AND month = $2 AND year = $3 ORDER BY id', [company_id, m, y]),
    pool.query(`SELECT COALESCE(SUM(total_tds) FILTER (WHERE deposited AND challan_number IS NOT NULL), 0) AS deposited
                  FROM tds_transactions WHERE company_id = $1 AND section = '192' AND payroll_month = $2 AND payroll_year = $3`, [company_id, m, y]),
    fetchPayrollSettings(company_id),
    loadRules(pool, company_id, periodEndDate(m, y)),
  ]);
  // EPF administration has a monthly minimum per establishment (approval accrues the difference).
  const adminTopUp = num(t.employee_pf) > 0 ? Math.max(0, num(rules['pf.admin_min_monthly']) - num(t.pf_admin)) : 0;
  const amounts = { pf: num(t.pf) + adminTopUp, esi: num(t.esi), pt: num(t.pt), lwf: num(t.lwf) };
  const due = dueDates(m, y, settings.statutory_state);
  const today = todayIST();
  // A cancelled record (§262) is history: the levy is due again until the right payment is recorded.
  const byKind = new Map(rem.filter(r => !r.cancelled_at).map(r => [r.kind, r]));
  const items = Object.keys(REMITTANCE_ACCOUNTS).map(kind => {
    const paid = byKind.get(kind);
    const amount = Math.round(amounts[kind] * 100) / 100;
    return {
      kind, amount, due_date: due[kind].date, due_basis: due[kind].basis,
      status: amount <= 0 ? 'nothing_due' : paid ? 'paid' : due[kind].date && today > due[kind].date ? 'overdue' : 'due',
      remittance: paid ? { id: paid.id, challan_reference: paid.challan_reference, paid_on: paid.paid_on, amount: num(paid.amount), journal_entry_id: paid.journal_entry_id } : null,
      cancelled: rem.filter(r => r.kind === kind && r.cancelled_at).map(r => ({
        id: r.id, challan_reference: r.challan_reference, paid_on: r.paid_on, amount: num(r.amount),
        cancelled_at: r.cancelled_at, cancel_reason: r.cancel_reason })),
    };
  });
  const tdsAmount = num(t.tds), tdsDeposited = num(tdsDep.deposited);
  items.push({
    kind: 'tds', amount: tdsAmount, due_date: due.tds.date, due_basis: due.tds.basis,
    status: tdsAmount <= 0 ? 'nothing_due' : Math.round(tdsDeposited) >= Math.round(tdsAmount) ? 'paid' : today > due.tds.date ? 'overdue' : 'due',
    deposited: tdsDeposited, recorded_in: 'Finance → TDS (challan deposits)',
  });
  return { period: label, month: m, year: y, finalised_runs: t.n, paid_runs: t.paid, items };
}

export async function recordRemittance({ company_id, kind, month, year, reference, paid_on, userId }) {
  requireCompany(company_id);
  if (!REMITTANCE_ACCOUNTS[kind]) throw new PayrollHttpError(400, 'kind must be pf, esi, pt or lwf (TDS deposits are recorded in Finance → TDS)');
  const ref = String(reference || '').trim();
  if (ref.length < 4) throw new PayrollHttpError(400, 'Enter the challan / transaction reference from the payment receipt');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(paid_on || ''))) throw new PayrollHttpError(400, 'paid_on (YYYY-MM-DD) is required');
  if (paid_on > todayIST()) throw new PayrollHttpError(400, 'The payment date cannot be in the future');
  const { m, y, label } = periodOf(month, year);
  const dues = await statutoryDues({ company_id, month: m, year: y });
  const item = dues.items.find(i => i.kind === kind);
  if (!(item.amount > 0)) throw new PayrollHttpError(409, `Nothing is due for ${kind.toUpperCase()} in ${label} (only approved payroll counts)`);
  if (item.remittance) throw new PayrollHttpError(409, `${kind.toUpperCase()} for ${label} is already recorded as paid (${item.remittance.challan_reference})`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: accts } = await client.query(`
      SELECT DISTINCT ON (code) id, code FROM chart_of_accounts
       WHERE code = ANY($1) AND is_active = true AND (company_id = $2 OR company_id IS NULL)
       ORDER BY code, company_id NULLS LAST`, [[REMITTANCE_ACCOUNTS[kind], BANK_ACCOUNT], company_id]);
    const payable = accts.find(a => a.code === REMITTANCE_ACCOUNTS[kind]), bank = accts.find(a => a.code === BANK_ACCOUNT);
    if (!payable || !bank) throw new PayrollHttpError(422, `Accounts ${REMITTANCE_ACCOUNTS[kind]} and ${BANK_ACCOUNT} must exist in the chart of accounts`);
    const je = await journalRepo.createEntry(client, {
      entry_number: await journalRepo.getNextEntryNumber(client), entry_date: paid_on, entry_type: 'Payment',
      reference_type: 'statutory_remittance', reference_id: `${kind}:${y}-${String(m).padStart(2, '0')}`,
      description: `${kind.toUpperCase()} for ${label} paid, challan ${ref}`, created_by: userId, company_id,
    });
    await journalRepo.createLine(client, { journal_entry_id: je.id, account_id: payable.id, description: `${kind.toUpperCase()} payable cleared`, debit: item.amount, credit: 0, company_id });
    await journalRepo.createLine(client, { journal_entry_id: je.id, account_id: bank.id, description: `${kind.toUpperCase()} paid (challan ${ref})`, debit: 0, credit: item.amount, company_id });
    try { await journalRepo.postEntry(client, je.id); }
    catch (e) { throw new PayrollHttpError(422, `The payment journal could not be posted: ${e.message}. Nothing was recorded.`); }
    const { rows: [row] } = await client.query(`
      INSERT INTO payroll_statutory_remittances (company_id, kind, month, year, amount, challan_reference, paid_on, journal_entry_id, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [company_id, kind, m, y, item.amount, ref, paid_on, je.id, userId]);
    await client.query('COMMIT');
    return row;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') throw new PayrollHttpError(409, `${kind.toUpperCase()} for ${label} is already recorded`);
    throw e;
  } finally { client.release(); }
}

/**
 * Cancel a recorded PF / ESI / PT / LWF payment that was recorded wrongly (wrong
 * challan, wrong date, or recorded before the payment went through). The payment
 * journal is reversed (Dr bank / Cr payable, dated today) and the record kept as
 * history; the levy shows as due again so the right payment can be recorded.
 * The money itself is not touched: if the authority really was paid twice or the
 * wrong amount, that is settled with the authority, not here.
 */
export async function cancelRemittance({ company_id, id, reason, userId }) {
  requireCompany(company_id);
  const why = String(reason || '').trim();
  if (why.length < 10) throw new PayrollHttpError(400, 'Say what was wrong with this record (at least 10 characters).', { code: 'REASON_REQUIRED' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query(
      'SELECT * FROM payroll_statutory_remittances WHERE id = $1 AND company_id = $2 FOR UPDATE', [parseInt(id) || 0, company_id]);
    if (!r) throw new PayrollHttpError(404, 'Payment record not found');
    const label = `${r.kind.toUpperCase()} for ${getMonthName(r.month)} ${r.year}`;
    if (r.cancelled_at) throw new PayrollHttpError(409, `${label} (${r.challan_reference}) is already cancelled`);
    let reversalId = null;
    if (r.journal_entry_id) {
      const { rows: [je] } = await client.query(
        'SELECT id, entry_number FROM journal_entries WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL', [r.journal_entry_id, company_id]);
      const { rows: [already] } = je ? await client.query(
        'SELECT id FROM journal_entries WHERE reversal_of_id = $1 AND deleted_at IS NULL', [je.id]) : { rows: [] };
      if (je && !already) {
        const { rows: lines } = await client.query('SELECT account_id, account_code, debit, credit, narration FROM journal_lines WHERE entry_id = $1', [je.id]);
        const rev = await journalRepo.createEntry(client, {
          entry_number: await journalRepo.getNextEntryNumber(client), entry_date: todayIST(), entry_type: 'Payment',
          reference_type: 'statutory_remittance_reversal', reference_id: String(r.id),
          description: `Reversal of ${je.entry_number}: ${label} payment record cancelled (${why})`, created_by: userId, company_id,
        });
        await client.query('UPDATE journal_entries SET reversal_of_id = $2 WHERE id = $1', [rev.id, je.id]);
        for (const l of lines) {
          await journalRepo.createLine(client, { journal_entry_id: rev.id, account_id: l.account_id, account_code: l.account_code,
            description: `Reversal: ${l.narration || ''}`, debit: num(l.credit), credit: num(l.debit), company_id });
        }
        try { await journalRepo.postEntry(client, rev.id); }
        catch (e) { throw new PayrollHttpError(422, `The payment journal ${je.entry_number} could not be reversed: ${e.message}. Nothing was changed.`, { code: 'REVERSAL_REFUSED' }); }
        reversalId = rev.id;
      }
    }
    const { rows: [row] } = await client.query(`
      UPDATE payroll_statutory_remittances SET cancelled_at = NOW(), cancelled_by = $2, cancel_reason = $3, reversal_journal_id = $4
       WHERE id = $1 RETURNING *`, [r.id, userId, why, reversalId]);
    await client.query('COMMIT');
    return { before: r, row, label };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// ── Tax setup: regime and opening balances ───────────────────────────────────

function fyLabel(financial_year) {
  const fy = parseFinancialYear(financial_year || indianFinancialYear());
  if (!fy) throw new PayrollHttpError(400, 'financial_year must look like 2026-2027');
  return fy.label;
}

export async function taxSetup({ company_id, financial_year }) {
  requireCompany(company_id);
  const fy = fyLabel(financial_year);
  const { rows } = await pool.query(`
    SELECT e.id AS employee_id, e.office_id AS employee_code,
           TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS name, e.department,
           COALESCE(r.regime, 'new') AS regime, r.declared_at AS regime_declared_at, (r.id IS NOT NULL) AS regime_declared,
           o.gross AS opening_gross, o.tds AS opening_tds, o.employee_pf AS opening_pf, o.months AS opening_months, o.source AS opening_source,
           x.effective_from AS pf_excluded_from, x.declaration_reference AS pf_declaration_reference
      FROM employees e
      LEFT JOIN payroll_pf_exclusions x ON x.employee_id = e.id AND x.ended_on IS NULL
      LEFT JOIN employee_tax_regime r ON r.employee_id = e.id AND r.financial_year = $2
      LEFT JOIN payroll_opening_balances o ON o.employee_id = e.id AND o.financial_year = $2
     WHERE e.company_id = $1 AND e.deleted_at IS NULL AND LOWER(e.status) IN ('active', 'probation', 'notice')
     ORDER BY e.first_name`, [company_id, fy]);
  return { financial_year: fy, employees: rows };
}

async function ownedEmployee(employee_id, company_id) {
  const { rows } = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [parseInt(employee_id), company_id]);
  if (!rows.length) throw new PayrollHttpError(404, 'Employee not found');
}

async function finalisedInFy(employee_id, fy) {
  const { startYear, endYear } = parseFinancialYear(fy);
  const { rows: [r] } = await pool.query(`
    SELECT COUNT(*)::int AS n FROM payroll_runs WHERE employee_id = $1 AND is_test = false AND status = ANY($2::text[])
       AND ((year = $3 AND month >= 4) OR (year = $4 AND month <= 3))`, [employee_id, FINAL_STATUSES, startYear, endYear]);
  return r.n;
}

/**
 * The employee's regime for TDS (CBDT: the employer deducts under the regime the
 * employee intimates; with no intimation, the new regime). An employee changes
 * their own choice only until the first month of the year is finalised; HR may
 * record it later from a written intimation.
 */
export async function setTaxRegime({ company_id, employee_id, financial_year, regime, userId, selfService = false }) {
  requireCompany(company_id);
  if (!['new', 'old'].includes(regime)) throw new PayrollHttpError(400, "regime must be 'new' or 'old'");
  const fy = fyLabel(financial_year);
  await ownedEmployee(employee_id, company_id);
  if (selfService && await finalisedInFy(parseInt(employee_id), fy)) {
    throw new PayrollHttpError(409, `Payroll for ${fy} has already been finalised with your current choice. Ask HR to record a change from your written intimation.`, { code: 'REGIME_LOCKED' });
  }
  const { rows: [row] } = await pool.query(`
    INSERT INTO employee_tax_regime (employee_id, financial_year, regime, declared_by)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (employee_id, financial_year) DO UPDATE SET regime = EXCLUDED.regime, declared_by = EXCLUDED.declared_by, declared_at = NOW()
    RETURNING *`, [parseInt(employee_id), fy, regime, userId]);
  return row;
}

export async function setOpeningBalance({ company_id, employee_id, financial_year, gross, tds, employee_pf, months, source, userId }) {
  requireCompany(company_id);
  const fy = fyLabel(financial_year);
  await ownedEmployee(employee_id, company_id);
  const vals = { gross: num(gross), tds: num(tds), employee_pf: num(employee_pf), months: parseInt(months) || 0 };
  if ([vals.gross, vals.tds, vals.employee_pf].some(v => v < 0) || vals.months < 0 || vals.months > 12) {
    throw new PayrollHttpError(400, 'Amounts must be 0 or more, and months 0 to 12');
  }
  if (vals.tds > vals.gross) throw new PayrollHttpError(400, 'Tax deducted cannot exceed the salary');
  if (!String(source || '').trim()) throw new PayrollHttpError(400, 'Say where the figures come from, e.g. "Form 12B from previous employer" or "Tally payroll Apr–Oct"');
  const { rows: [row] } = await pool.query(`
    INSERT INTO payroll_opening_balances (company_id, employee_id, financial_year, gross, tds, employee_pf, months, source, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (employee_id, financial_year) DO UPDATE SET gross = EXCLUDED.gross, tds = EXCLUDED.tds,
      employee_pf = EXCLUDED.employee_pf, months = EXCLUDED.months, source = EXCLUDED.source, created_by = EXCLUDED.created_by, updated_at = NOW()
    RETURNING *`, [company_id, parseInt(employee_id), fy, vals.gross, vals.tds, vals.employee_pf, vals.months, String(source).trim(), userId]);
  return row;
}

// ── PF: employees who are not members (§262) ─────────────────────────────────

const UAN_RE = /^[0-9]{12}$/;
const ymOf = (d) => Number(d.slice(0, 4)) * 100 + Number(d.slice(5, 7));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/**
 * Record that an employee is NOT a PF member: an "excluded employee" (EPF Scheme
 * 1952 para 2(f)(ii)) — PF wages above the wage ceiling when they joined, and
 * never a member before. The employee declares it on Form 11; payroll then
 * deducts no PF (and pays no employer PF, EPS, EDLI or admin charge) from
 * effective_from. Refused when:
 *   PF_MEMBER        a valid UAN is on file: they were a member before, and a
 *                    member must keep contributing
 *   PF_CONTRIBUTED   Pulse has already deducted PF for them in an approved month
 *   WAGE_NOT_ABOVE   their PF wage that month is not above the ceiling
 */
export async function setPfExclusion({ company_id, employee_id, effective_from, declaration_reference, reason, userId }) {
  requireCompany(company_id);
  const { rows: [emp] } = await pool.query(
    'SELECT id, office_id, uan_number, joining_date FROM employees WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL', [parseInt(employee_id) || 0, company_id]);
  if (!emp) throw new PayrollHttpError(404, 'Employee not found');
  if (!isDate(effective_from)) throw new PayrollHttpError(400, 'effective_from (YYYY-MM-DD) is required: usually the joining date');
  const ref = String(declaration_reference || '').trim();
  if (ref.length < 3) throw new PayrollHttpError(400, 'Enter the reference of the employee\'s signed Form 11 declaration');
  const joined = emp.joining_date ? (emp.joining_date instanceof Date ? emp.joining_date.toLocaleDateString('en-CA') : String(emp.joining_date).slice(0, 10)) : null;
  if (joined && effective_from < joined) throw new PayrollHttpError(400, `effective_from cannot be before the joining date (${joined})`);
  if (UAN_RE.test(String(emp.uan_number || '').trim())) {
    throw new PayrollHttpError(409, `A UAN (${String(emp.uan_number).trim()}) is on file, so this employee has been a PF member before and must keep contributing. If the UAN is wrong, correct it on the employee record first.`, { code: 'PF_MEMBER' });
  }
  const { rows: [paid] } = await pool.query(`
    SELECT month, year FROM payroll_runs WHERE employee_id = $1 AND is_test = false AND status = ANY($2::text[]) AND employee_pf > 0
     ORDER BY year, month LIMIT 1`, [emp.id, FINAL_STATUSES]);
  if (paid) throw new PayrollHttpError(409, `PF was already deducted for ${getMonthName(paid.month)} ${paid.year}, so this employee is a PF member and must keep contributing.`, { code: 'PF_CONTRIBUTED' });
  const m = Number(effective_from.slice(5, 7)), y = Number(effective_from.slice(0, 4));
  const pv = await previewEmployeePayslip({ employee_id: emp.id, month: m, year: y, company_id });
  if (!pv.slip) throw new PayrollHttpError(422, `The PF wage for ${getMonthName(m)} ${y} cannot be worked out: ${(pv.reasons || []).join('; ') || 'no salary in force'}`);
  const { values: rules } = await loadRules(pool, company_id, periodEndDate(m, y));
  const ceiling = num(rules['pf.wage_ceiling']);
  if (!(num(pv.slip.pf_wage) > ceiling)) {
    throw new PayrollHttpError(409, `The PF wage for ${getMonthName(m)} ${y} is ₹${Math.round(num(pv.slip.pf_wage)).toLocaleString('en-IN')}, not above the ₹${ceiling.toLocaleString('en-IN')} ceiling, so PF membership is compulsory.`, { code: 'WAGE_NOT_ABOVE' });
  }
  try {
    const { rows: [row] } = await pool.query(`
      INSERT INTO payroll_pf_exclusions (company_id, employee_id, effective_from, declaration_reference, reason, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [company_id, emp.id, effective_from, ref, String(reason || '').trim() || null, userId]);
    return { row, pf_wage: num(pv.slip.pf_wage), ceiling };
  } catch (e) {
    if (e.code === '23505') throw new PayrollHttpError(409, 'This employee is already recorded as not a PF member');
    throw e;
  }
}

/**
 * The employee joins PF (an excluded employee may choose to, with the employer's
 * agreement). PF is deducted from the month that contains ended_on; that month
 * must not be approved yet.
 */
export async function endPfExclusion({ company_id, employee_id, ended_on, reason, userId }) {
  requireCompany(company_id);
  if (!isDate(ended_on)) throw new PayrollHttpError(400, 'ended_on (YYYY-MM-DD) is required: PF is deducted from that month');
  if (String(reason || '').trim().length < 5) throw new PayrollHttpError(400, 'Give the reason (at least 5 characters)');
  const { rows: [x] } = await pool.query(`
    SELECT x.* FROM payroll_pf_exclusions x JOIN employees e ON e.id = x.employee_id
     WHERE x.employee_id = $1 AND e.company_id = $2 AND x.ended_on IS NULL`, [parseInt(employee_id) || 0, company_id]);
  if (!x) throw new PayrollHttpError(404, 'This employee is not recorded as excluded from PF');
  const from = x.effective_from instanceof Date ? x.effective_from.toLocaleDateString('en-CA') : String(x.effective_from).slice(0, 10);
  if (ended_on < from) throw new PayrollHttpError(400, `ended_on cannot be before the exclusion started (${from})`);
  const { rows: [fin] } = await pool.query(`
    SELECT month, year FROM payroll_runs WHERE employee_id = $1 AND is_test = false AND status = ANY($2::text[])
       AND (year * 100 + month) >= $3 ORDER BY year, month LIMIT 1`, [x.employee_id, FINAL_STATUSES, ymOf(ended_on)]);
  if (fin) throw new PayrollHttpError(409, `${getMonthName(fin.month)} ${fin.year} is already approved without PF. Choose a date in a month not yet approved.`, { code: 'MONTH_FINALISED' });
  const { rows: [row] } = await pool.query(`
    UPDATE payroll_pf_exclusions SET ended_on = $2, ended_by = $3, end_reason = $4 WHERE id = $1 RETURNING *`,
  [x.id, ended_on, userId, String(reason).trim()]);
  return { before: x, row };
}

// ── Bank file and loan payouts (Finance) ─────────────────────────────────────

/** Approved, unpaid salaries for one month as an .xlsx the bank's bulk upload can be filled from. Account numbers are text cells. */
export async function bankFile({ company_id, month, year }) {
  requireCompany(company_id);
  const { m, y, label } = periodOf(month, year);
  const { rows } = await pool.query(`
    SELECT e.office_id, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS name,
           e.account_number, e.ifsc_code, e.bank_name, pr.net_pay
      FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
     WHERE e.company_id = $1 AND pr.month = $2 AND pr.year = $3 AND pr.is_test = false AND pr.status = 'approved' AND pr.net_pay > 0
     ORDER BY e.first_name`, [company_id, m, y]);
  if (!rows.length) throw new PayrollHttpError(404, `No approved, unpaid salaries for ${label}`);
  const aoa = [['Employee code', 'Beneficiary name', 'Account number', 'IFSC', 'Bank', 'Amount (INR)', 'Narration']];
  for (const r of rows) aoa.push([r.office_id || '', r.name, String(r.account_number || ''), r.ifsc_code || '', r.bank_name || '', Number(r.net_pay), `Salary ${label}`]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let i = 2; i <= aoa.length; i++) { const c = ws[`C${i}`]; if (c) { c.t = 's'; c.z = '@'; } }
  ws['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 22 }, { wch: 14 }, { wch: 20 }, { wch: 14 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Salary transfers');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: rows.length, total: rows.reduce((s, r) => s + Number(r.net_pay), 0), label };
}

/** Record that a loan was paid out to the employee: Dr loan receivable / Cr bank, using Finance's loan account mapping. */
export async function recordLoanPayout({ company_id, loan_id, reference, paid_on, userId }) {
  requireCompany(company_id);
  const ref = String(reference || '').trim();
  if (ref.length < 4) throw new PayrollHttpError(400, 'Enter the bank reference of the payout');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(paid_on || '')) || paid_on > todayIST()) throw new PayrollHttpError(400, 'A payout date (not in the future) is required');
  const mapping = await getLoanGlMapping(company_id);
  if (mapping.status !== 'approved') {
    throw new PayrollHttpError(422, `Finance has not approved the loan accounts (${mapping.problems.join('; ')}). Set them in Accounting → Loan account mapping.`, { code: 'LOAN_GL_MAPPING_REQUIRED' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [loan] } = await client.query(`
      SELECT l.* FROM payroll_loans l JOIN employees e ON e.id = l.employee_id
       WHERE l.id = $1 AND e.company_id = $2 AND l.is_test = false FOR UPDATE OF l`, [parseInt(loan_id), company_id]);
    if (!loan) throw new PayrollHttpError(404, 'Loan not found');
    if (loan.disbursement_journal_id) throw new PayrollHttpError(409, 'The payout of this loan is already recorded');
    const creditCode = mapping.accounts.disbursement?.code || BANK_ACCOUNT;
    const { rows: accts } = await client.query(`
      SELECT DISTINCT ON (code) id, code FROM chart_of_accounts WHERE code = ANY($1) AND is_active = true AND (company_id = $2 OR company_id IS NULL)
       ORDER BY code, company_id NULLS LAST`, [[mapping.accounts.receivable.code, creditCode], company_id]);
    const dr = accts.find(a => a.code === mapping.accounts.receivable.code), cr = accts.find(a => a.code === creditCode);
    if (!dr || !cr) throw new PayrollHttpError(422, `Accounts ${mapping.accounts.receivable.code} and ${creditCode} must exist`);
    const amount = num(loan.principal_amount);
    const je = await journalRepo.createEntry(client, {
      entry_number: await journalRepo.getNextEntryNumber(client), entry_date: paid_on, entry_type: 'Payment',
      reference_type: 'employee_loan_payout', reference_id: String(loan.id),
      description: `Employee ${loan.loan_type} #${loan.id} paid out (${ref})`, created_by: userId, company_id,
    });
    await journalRepo.createLine(client, { journal_entry_id: je.id, account_id: dr.id, description: 'Employee loan receivable', debit: amount, credit: 0, company_id });
    await journalRepo.createLine(client, { journal_entry_id: je.id, account_id: cr.id, description: `Loan paid out (${ref})`, debit: 0, credit: amount, company_id });
    try { await journalRepo.postEntry(client, je.id); }
    catch (e) { throw new PayrollHttpError(422, `The payout journal could not be posted: ${e.message}`); }
    const { rows: [row] } = await client.query(
      `UPDATE payroll_loans SET disbursed_on = $2, disbursement_reference = $3, disbursement_journal_id = $4, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [loan.id, paid_on, ref, je.id]);
    await client.query('COMMIT');
    return row;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// ── Form 138 (Q4) salary details: the year's salary and tax per employee ─────

/**
 * Each employee's salary and tax for a tax year — what the Q4 statement's
 * salary details (Annexure II of the old Form 24Q) carry: salary (approved and
 * paid months plus any opening balance), perquisites, the deductions the regime
 * allows, taxable income, tax with surcharge and cess on it, and the tax
 * actually deducted. A shortfall means the last month (March) must deduct more.
 */
export async function salaryDetailsForYear({ company_id, financial_year }) {
  requireCompany(company_id);
  const fy = parseFinancialYear(financial_year);
  if (!fy) throw new PayrollHttpError(400, 'financial_year must look like 2026-2027');
  const { computeIncomeTaxDetail } = await import('./payrollEngine.js');
  const { values: rules } = await loadRules(pool, company_id, `${fy.endYear}-03-31`);
  const { rows } = await pool.query(`
    SELECT e.id AS employee_id, e.office_id, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS name,
           e.pan_number, e.dob,
           SUM(pr.gross)::numeric AS gross, SUM(pr.perquisite_value)::numeric AS perquisites, SUM(pr.tds)::numeric AS tds,
           SUM(pr.employee_pf)::numeric AS employee_pf, SUM(pr.professional_tax)::numeric AS pt, SUM(pr.basic)::numeric AS basic,
           SUM(pr.hra)::numeric AS hra,
           SUM((SELECT COALESCE(SUM((l->>'amount')::numeric), 0) FROM jsonb_array_elements(COALESCE(pr.earning_lines, '[]'::jsonb)) l
                 WHERE l->>'name' ~* '^(lta|leave travel)'))::numeric AS lta_paid,
           (ARRAY_AGG(pr.tax_regime ORDER BY pr.year DESC, pr.month DESC))[1] AS regime,
           COUNT(*)::int AS months
      FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
     WHERE e.company_id = $1 AND pr.is_test = false AND pr.status = ANY($2::text[])
       AND ((pr.year = $3 AND pr.month >= 4) OR (pr.year = $4 AND pr.month <= 3))
     GROUP BY e.id ORDER BY e.first_name`, [company_id, FINAL_STATUSES, fy.startYear, fy.endYear]);
  const ids = rows.map(r => r.employee_id);
  const { settings } = await fetchPayrollSettings(company_id);
  const [{ rows: ob }, { rows: decl }] = ids.length ? await Promise.all([
    pool.query('SELECT employee_id, gross, tds, employee_pf FROM payroll_opening_balances WHERE financial_year = $1 AND employee_id = ANY($2::int[])', [fy.label, ids]),
    // Year end counts approved declarations only — what monthly TDS counts from the
    // proof cut-off on (§264). 80D is split self / parents (each its own limit).
    pool.query(`SELECT employee_id, LOWER(declaration_type) AS t,
                       SUM(amount) FILTER (WHERE COALESCE(insured_for, 'self') <> 'parents')::numeric AS amount,
                       SUM(amount) FILTER (WHERE insured_for = 'parents')::numeric AS parents_amount,
                       BOOL_OR(parents_senior) AS parents_senior, BOOL_OR(metro_city) AS metro_city
                  FROM it_declarations
                 WHERE financial_year = ANY($1::text[]) AND status = 'approved' AND employee_id = ANY($2::int[]) GROUP BY 1, 2`,
      [[fy.label, `${fy.startYear}-${String(fy.endYear).slice(2)}`], ids]),
  ]) : [{ rows: [] }, { rows: [] }];
  return rows.map(r => {
    const o = ob.find(x => x.employee_id === r.employee_id);
    const dRow = (t) => decl.find(x => x.employee_id === r.employee_id && x.t === t);
    const d = (t) => num(dRow(t)?.amount);
    const regime = r.regime || 'new';
    const rule = rules[regime === 'old' ? 'tax.old' : 'tax.new'];
    const gross = num(r.gross) + num(o?.gross);
    const perquisites = num(r.perquisites);
    const standard = Math.min(rule.standard_deduction, gross);
    const pt = regime === 'old' ? Math.min(num(r.pt), 2500) : 0;
    const fyEnd = `${fy.endYear}-03-31`;
    let age = null;
    if (r.dob) { const b = new Date(r.dob), t = new Date(fyEnd); age = t.getUTCFullYear() - b.getUTCFullYear() - ((t.getUTCMonth() < b.getUTCMonth() || (t.getUTCMonth() === b.getUTCMonth() && t.getUTCDate() < b.getUTCDate())) ? 1 : 0); }
    // the same allowance as monthly TDS (payrollEngine.oldRegimeDeductions, §262)
    const via = regime === 'old'
      ? oldRegimeDeductions({ declarations: { '80c': d('80c'), '80d': d('80d'), '80d_parents': num(dRow('80d')?.parents_amount), '80ccd': d('80ccd'), home_loan: d('home_loan') },
          employee_pf: num(r.employee_pf) + num(o?.employee_pf), basic_year: num(r.basic),
          self_senior: (age ?? 0) >= 60, parents_senior: dRow('80d')?.parents_senior === true }).total
      : 0;
    // HRA and LTA exemptions on the year's actual pay — as monthly TDS allows them
    // (payrollEngine.computePayroll). Year end used to leave both out.
    const hraExempt = regime === 'old'
      ? hraExemption({ hra_received: num(r.hra), rent_paid: d('hra'), basic: num(r.basic),
          metro: settings.hra_metro_city === true || dRow('hra')?.metro_city === true })
      : 0;
    const ltaExempt = regime === 'old' ? Math.min(d('lta'), num(r.lta_paid)) : 0;
    const taxable = Math.max(0, Math.round(gross + perquisites - standard - pt - via - hraExempt - ltaExempt));
    const tax = computeIncomeTaxDetail(taxable, regime, rule, { age });
    const tds = num(r.tds) + num(o?.tds);
    return {
      employee_id: r.employee_id, employee_code: r.office_id, employee_name: r.name, employee_pan: r.pan_number,
      regime, months: r.months, gross_salary: Math.round(gross), perquisites: Math.round(perquisites), standard_deduction: Math.round(standard),
      professional_tax: Math.round(pt), chapter_via: Math.round(via),
      hra_exemption: Math.round(hraExempt), lta_exemption: Math.round(ltaExempt), taxable_income: taxable,
      tax: tax.tax, surcharge: tax.surcharge, cess: tax.cess, tax_payable: tax.total, tds_deducted: Math.round(tds),
      difference: Math.round(tds - tax.total),
    };
  });
}

// ── Form No. 123 (formerly Form 12BA): statement of perquisites ─────────────

/**
 * The statement of perquisites an employer gives with the annual salary
 * certificate (Income-tax Rules 2026 rule 204(2), Form No. 123; Form 12BA under
 * rule 26A of the 1962 Rules before tax year 2026-27). It is due for an employee
 * whose salary for the year exceeds ₹1,50,000.
 *
 * Pulse values ONE perquisite: loans below the SBI rate (rule 15 Table IV),
 * from the approved payroll runs. Every other line is reported as "not provided
 * through Pulse" — never as a value Pulse did not compute.
 */
export const FORM123_ITEMS = [
  'Accommodation', 'Cars / other automotive', 'Sweeper, gardener, watchman or personal attendant',
  'Gas, electricity, water', 'Interest-free or concessional loans', 'Holiday expenses', 'Free or concessional travel',
  'Free meals', 'Free education', 'Gifts, vouchers, etc.', 'Credit card expenses', 'Club expenses',
  'Use of movable assets by employees', 'Transfer of assets to employees', 'Value of any other benefit / amenity / service / privilege',
  'Stock options allotted or transferred by employer', 'Contribution by employer to fund and scheme taxable under the Act',
  'Annual accretion by way of interest, dividend etc. to such fund and scheme', 'Other benefits or amenities',
];
export const FORM123_SALARY_THRESHOLD = 150000;

export async function form123({ company_id, employee_id, financial_year }) {
  requireCompany(company_id);
  const fy = parseFinancialYear(financial_year || indianFinancialYear());
  if (!fy) throw new PayrollHttpError(400, 'financial_year must look like 2026-2027');
  const [{ rows: [emp] }, { rows: [co] }] = await Promise.all([
    pool.query(`SELECT id, office_id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name, designation, pan_number
                  FROM employees WHERE id = $1 AND company_id = $2`, [parseInt(employee_id), company_id]),
    pool.query('SELECT name, address, pan, tan FROM companies WHERE id = $1', [company_id]),
  ]);
  if (!emp) throw new PayrollHttpError(404, 'Employee not found');
  const { rows: [t] } = await pool.query(`
    SELECT COALESCE(SUM(gross), 0)::numeric AS gross, COALESCE(SUM(perquisite_value), 0)::numeric AS perq,
           COALESCE(SUM(tds), 0)::numeric AS tds, COUNT(*)::int AS months
      FROM payroll_runs WHERE employee_id = $1 AND is_test = false AND status = ANY($2::text[])
       AND ((year = $3 AND month >= 4) OR (year = $4 AND month <= 3))`, [emp.id, FINAL_STATUSES, fy.startYear, fy.endYear]);
  const { rows: [ob] } = await pool.query('SELECT gross, tds FROM payroll_opening_balances WHERE employee_id = $1 AND financial_year = $2', [emp.id, fy.label]);
  const { rows: deposits } = await pool.query(`
    SELECT payroll_month AS month, payroll_year AS year, total_tds, challan_number, challan_date, bsr_code
      FROM tds_transactions WHERE employee_id = $1 AND section = '192' AND financial_year = $2 AND deposited AND challan_number IS NOT NULL
     ORDER BY payroll_year, payroll_month`, [emp.id, fy.label]);
  const loanPerq = Math.round(num(t.perq));
  const items = FORM123_ITEMS.map((label, i) => (label === 'Interest-free or concessional loans'
    ? { sl: i + 1, label, value: loanPerq, recovered: 0, chargeable: loanPerq, source: 'payroll' }
    : { sl: i + 1, label, value: null, recovered: null, chargeable: null, source: 'not_in_pulse' }));
  const salary = Math.round(num(t.gross) + num(ob?.gross));
  const isNew = fy.startYear >= 2026;
  return {
    form: isNew ? 'Form No. 123' : 'Form 12BA',
    form_label: isNew ? 'Form No. 123 (formerly Form 12BA)' : 'Form 12BA',
    basis: isNew ? 'Income-tax Rules 2026, rule 204(2); Income-tax Act 2025 s.392' : 'Income-tax Rules 1962, rule 26A; Income-tax Act 1961 s.192',
    financial_year: fy.label, period_term: isNew ? 'Tax Year' : 'Financial year',
    employer: { name: co?.name || null, address: co?.address || null, tan: co?.tan || null, pan: co?.pan || null },
    employee: { id: emp.id, code: emp.office_id, name: emp.name, designation: emp.designation || null, pan: emp.pan_number || null },
    months_included: t.months,
    salary_excluding_perquisites: salary,
    required: salary > FORM123_SALARY_THRESHOLD,
    items,
    total_perquisites: loanPerq,
    tax: {
      deducted_from_salary: Math.round(num(t.tds) + num(ob?.tds)),
      paid_by_employer: 0,
      total: Math.round(num(t.tds) + num(ob?.tds)),
      deposits: deposits.map(d => ({ month: d.month, year: d.year, amount: num(d.total_tds), challan_number: d.challan_number, challan_date: d.challan_date, bsr_code: d.bsr_code })),
    },
    note: 'Only loans below the SBI rate are valued by Pulse. Any other perquisite the company provides (accommodation, car, meals, gifts …) must be valued and added before this statement is issued.',
  };
}
