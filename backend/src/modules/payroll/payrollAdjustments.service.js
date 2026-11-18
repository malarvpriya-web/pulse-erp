/**
 * payrollAdjustments.service.js — one-time earnings and deductions (§261).
 *
 * HR enters an amount for ONE employee in ONE wage month:
 *   earning    incentive, reimbursement paid through salary, one-off allowance —
 *              part of gross, taxed in that month (a one-time earning), and part of
 *              "all remuneration" for the PF / ESI wage
 *   deduction  canteen, fine, notice-pay recovery, any other recovery — taken from
 *              net pay and credited, in the approval journal, to `account_code`
 *              (an active account of the company's chart, chosen by HR)
 * Generate Payroll picks up the month's rows (payroll.service.js
 * buildPeriodContext). A draft generated before an adjustment changed no longer
 * matches (DRAFT_OUT_OF_DATE) until it is generated again. Once the employee's
 * payroll for that month is approved or paid, its adjustments cannot be added,
 * changed or removed — a correction goes into a later month.
 */
import pool from '../shared/db.js';
import { PayrollHttpError, FINAL_STATUSES } from './payroll.service.js';
import { getMonthName } from './payrollEngine.js';

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
export const ADJUSTMENT_KINDS = ['earning', 'deduction'];
const MAX_AMOUNT = 10000000;   // ₹1 crore: anything larger is a typing error

function periodOf(month, year) {
  const m = parseInt(month), y = parseInt(year);
  if (!(m >= 1 && m <= 12) || !(y >= 2000 && y <= 2100)) throw new PayrollHttpError(400, 'A valid month and year are required');
  return { m, y, label: `${getMonthName(m)} ${y}` };
}
function requireCompany(company_id) {
  if (company_id == null) throw new PayrollHttpError(400, 'Payroll is per company — sign in to (or select) a company first');
}

/** The employee's payroll status for the month, or null when none is generated. */
async function runStatus(client, employeeId, m, y) {
  const { rows: [r] } = await client.query(
    'SELECT status FROM payroll_runs WHERE employee_id = $1 AND month = $2 AND year = $3 AND is_test = false', [employeeId, m, y]);
  return r?.status || null;
}

/** Active accounts a deduction may be credited to: the company's own, else the shared chart. */
export async function creditAccounts({ company_id }) {
  requireCompany(company_id);
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (code) code, name, account_type FROM chart_of_accounts
     WHERE is_active = true AND (company_id = $1 OR company_id IS NULL)
     ORDER BY code, company_id NULLS LAST`, [company_id]);
  return rows;
}

export async function listAdjustments({ company_id, month, year }) {
  requireCompany(company_id);
  const { m, y } = periodOf(month, year);
  const { rows } = await pool.query(`
    SELECT a.id, a.employee_id, a.month, a.year, a.kind, a.label, a.amount, a.account_code, a.reason, a.created_at,
           e.office_id AS employee_code, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
           coa.name AS account_name, pr.status AS run_status,
           COALESCE(u.name, u.email) AS created_by_name
      FROM payroll_adjustments a
      JOIN employees e ON e.id = a.employee_id
      LEFT JOIN payroll_runs pr ON pr.employee_id = a.employee_id AND pr.month = a.month AND pr.year = a.year AND pr.is_test = false
      LEFT JOIN LATERAL (SELECT name FROM chart_of_accounts c WHERE c.code = a.account_code AND (c.company_id = a.company_id OR c.company_id IS NULL)
                          ORDER BY c.company_id NULLS LAST LIMIT 1) coa ON true
      LEFT JOIN users u ON u.id = a.created_by
     WHERE a.company_id = $1 AND a.month = $2 AND a.year = $3 AND a.is_test = false
     ORDER BY e.first_name, a.id`, [company_id, m, y]);
  return rows.map(r => ({ ...r, amount: num(r.amount), locked: FINAL_STATUSES.includes(r.run_status) }));
}

export async function addAdjustment({ company_id, employee_id, month, year, kind, label, amount, account_code, reason, userId }) {
  requireCompany(company_id);
  const { m, y, label: period } = periodOf(month, year);
  if (!ADJUSTMENT_KINDS.includes(kind)) throw new PayrollHttpError(400, "kind must be 'earning' or 'deduction'");
  const name = String(label || '').trim();
  if (!name) throw new PayrollHttpError(400, 'Give the adjustment a name, e.g. "Sales incentive" or "Canteen recovery"');
  if (name.length > 80) throw new PayrollHttpError(400, 'The name can be at most 80 characters');
  const amt = Math.round(num(amount));
  if (!(amt > 0) || amt > MAX_AMOUNT) throw new PayrollHttpError(400, 'Enter an amount in whole rupees, more than ₹0 and at most ₹1,00,00,000');
  const why = String(reason || '').trim();
  if (why.length < 5) throw new PayrollHttpError(400, 'Give the reason for this amount (at least 5 characters)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [emp] } = await client.query(
      'SELECT id FROM employees WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL', [parseInt(employee_id), company_id]);
    if (!emp) throw new PayrollHttpError(404, 'Employee not found');
    // Serialise with Generate / approval for this company-month.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`payroll:${company_id}:${y}:${m}`]);
    const st = await runStatus(client, emp.id, m, y);
    if (FINAL_STATUSES.includes(st)) {
      throw new PayrollHttpError(409, `Payroll for ${period} is already ${st} for this employee. Enter the amount in a later month.`, { code: 'PERIOD_FINALISED' });
    }
    let code = null;
    if (kind === 'deduction') {
      code = String(account_code || '').trim();
      if (!code) throw new PayrollHttpError(400, 'Choose the account the deduction is credited to (for example Other Income, or the receivable it recovers)', { code: 'ACCOUNT_REQUIRED' });
      const { rows: acct } = await client.query(
        'SELECT 1 FROM chart_of_accounts WHERE code = $1 AND is_active = true AND (company_id = $2 OR company_id IS NULL) LIMIT 1', [code, company_id]);
      if (!acct.length) throw new PayrollHttpError(400, `Account ${code} is not an active account in the chart of accounts`, { code: 'ACCOUNT_INVALID' });
    }
    const { rows: [row] } = await client.query(`
      INSERT INTO payroll_adjustments (company_id, employee_id, month, year, kind, label, amount, account_code, reason, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [company_id, emp.id, m, y, kind, name, amt, code, why, userId]);
    await client.query('COMMIT');
    return { ...row, amount: num(row.amount), draft_needs_regenerate: st === 'pending' || st === 'draft' || st === 'on_hold' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

export async function removeAdjustment({ company_id, id }) {
  requireCompany(company_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [a] } = await client.query(
      'SELECT * FROM payroll_adjustments WHERE id = $1 AND company_id = $2 AND is_test = false FOR UPDATE', [parseInt(id), company_id]);
    if (!a) throw new PayrollHttpError(404, 'Adjustment not found');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`payroll:${company_id}:${a.year}:${a.month}`]);
    const st = await runStatus(client, a.employee_id, a.month, a.year);
    if (FINAL_STATUSES.includes(st)) {
      throw new PayrollHttpError(409, `Payroll for ${getMonthName(a.month)} ${a.year} is already ${st} for this employee, so this amount is part of it. Correct it in a later month.`, { code: 'PERIOD_FINALISED' });
    }
    await client.query('DELETE FROM payroll_adjustments WHERE id = $1', [a.id]);
    await client.query('COMMIT');
    return { removed: a, draft_needs_regenerate: st != null };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}
