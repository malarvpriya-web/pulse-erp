// backend/src/modules/hr/fnf.service.js
// Full & Final settlement: reads what the calculation needs, runs settlementEngine.js,
// and keeps every result as a new version in fnf_settlements (manual §253). Used by
// POST /fnf/compute/:employee_id and by the fnfAutoTrigger cron.
import { computeIncomeTax, computePayroll, periodEndDate, indianFinancialYear, quarterOfMonth } from '../payroll/payrollEngine.js';
import journalRepo from '../finance/repositories/journal.repository.js';
import { fetchPayrollSettings, normaliseUtr } from '../payroll/payroll.service.js';
import { loadRuleRows, resolveRules } from '../payroll/statutoryRules.js';
import { computeSettlement } from './settlementEngine.js';
import { resolveSettlementRules, unconfirmedRules } from './settlementRules.js';
import { incentiveAtExit } from '../sales/services/salesIncentive.service.js';

const iso = (col) => `to_char(${col}, 'YYYY-MM-DD')`;
const num = (v) => Number(v) || 0;

/** Validate what HR may supply with a compute. Returns an error message, or null. */
export function settlementOptionsProblem(o = {}, lwd = null) {
  if (o.lop_days != null && !(Number(o.lop_days) >= 0 && Number(o.lop_days) <= 31)) return 'Loss of pay days must be between 0 and 31.';
  if (o.waive_notice_days != null && !(Number(o.waive_notice_days) >= 0)) return 'Waived notice days cannot be negative.';
  if (Number(o.waive_notice_days) > 0 && !String(o.waive_reason ?? '').trim()) return 'A notice waiver needs a reason.';
  if (o.notice_start != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(o.notice_start))) return 'The notice start must be a date.';
  if (o.notice_start != null && lwd && String(o.notice_start) > lwd) return 'Notice cannot start after the last working day.';
  if (o.asset_recovery_amount != null && !(Number(o.asset_recovery_amount) >= 0)) return 'The asset value cannot be negative.';
  if (Number(o.asset_recovery_amount) > 0 && !String(o.asset_recovery_reason ?? '').trim()) return 'An asset recovery needs a reason.';
  if (o.sales_incentive_decision != null) {
    if (!['pay', 'not_pay', 'undecided'].includes(o.sales_incentive_decision)) return 'The sales incentive decision must be pay, not pay or undecided.';
    if (o.sales_incentive_decision === 'pay' && !(Number(o.sales_incentive_amount) > 0 && Number(o.sales_incentive_amount) <= 10000000)) return 'Enter the sales incentive to pay, more than ₹0.';
    if (o.sales_incentive_decision !== 'undecided' && String(o.sales_incentive_reason ?? '').trim().length < 5) return 'Give the reason for the sales incentive decision (at least 5 characters).';
  }
  return null;
}

/**
 * Computes the settlement for an employee's most recent exit request, stores it as a new
 * version, and writes the draft net_payable onto exit_requests. Accepts a pg Pool or an
 * in-transaction Client. Returns null if the employee has no exit request.
 *
 * `companyId` is REQUIRED (2026-10-20): the employee — salary included — and the exit
 * request it writes are read and written only inside that company. `null` is a deliberate
 * global scope (a super admin), `undefined` means the caller forgot and throws.
 * A settlement already PAID is never recomputed (409).
 */
export async function computeFnf(db, employeeId, { companyId, actorId = null, options = {} } = {}) {
  if (companyId === undefined) throw new Error('computeFnf requires a company scope');
  const { rows: [row] } = await db.query(
    `SELECT e.id, e.company_id, e.office_id, e.dob, e.employment_type, e.notice_period_days,
            e.basic_salary AS master_basic, ${iso('e.joining_date')} AS joining_date,
            (SELECT b.state FROM branches b WHERE b.id = e.branch_id) AS state,
            (SELECT c.state FROM companies c WHERE c.id = e.company_id) AS work_state,
            er.id AS exit_id, er.separation_type, er.notice_period, er.fnf_status AS exit_fnf_status,
            ${iso('er.last_working_date')} AS last_working_date, ${iso('er.created_at')} AS exit_created_at,
            ${iso('er.resignation_date')} AS resignation_date
       FROM employees e JOIN exit_requests er ON er.employee_id = e.id
      WHERE e.id = $1 AND e.deleted_at IS NULL AND ($2::int IS NULL OR e.company_id = $2::int)
      ORDER BY er.created_at DESC LIMIT 1`,
    [employeeId, companyId]);
  if (!row) return null;
  if (row.exit_fnf_status === 'paid') {
    throw Object.assign(new Error('F&F is already paid — it cannot be recomputed'), { statusCode: 409 });
  }
  if (!row.last_working_date) {
    throw Object.assign(new Error('Enter the last working day before computing the settlement.'), { statusCode: 422 });
  }
  const problem = settlementOptionsProblem(options, row.last_working_date);
  if (problem) throw Object.assign(new Error(problem), { statusCode: 422 });

  const lwd = row.last_working_date;
  const year = Number(lwd.slice(0, 4)), month = Number(lwd.slice(5, 7));
  const fyStart = `${month >= 4 ? year : year - 1}-04-01`;
  const company = row.company_id;

  // The salary in force on the last working day, exactly as payroll reads it.
  const { rows: [salary] } = await db.query(
    `SELECT esa.basic_salary, esa.breakdown, COALESCE(ss.components, ds.components) AS components
       FROM (SELECT 1) x
       LEFT JOIN LATERAL (SELECT basic_salary, structure_id, breakdown FROM employee_salary_assignments
                           WHERE employee_id = $1 AND effective_from <= $2::date
                           ORDER BY effective_from DESC, created_at DESC LIMIT 1) esa ON true
       LEFT JOIN salary_structures ss ON ss.id = esa.structure_id
       LEFT JOIN LATERAL (SELECT components FROM salary_structures
                           WHERE is_default = true AND (company_id = $3 OR company_id IS NULL)
                           ORDER BY company_id NULLS LAST, id LIMIT 1) ds ON true`,
    [employeeId, lwd, company]);
  const basicSalary = num(salary?.basic_salary) || num(row.master_basic);

  const ruleRows = await loadRuleRows(db, company);
  const payrollRules = resolveRules(periodEndDate(month, year), ruleRows).values;
  const { values: rules, applied } = resolveSettlementRules(lwd, ruleRows);
  const settings = await fetchPayrollSettings(company);
  const person = {
    id: row.id, office_id: row.office_id, basic_salary: basicSalary, dob: row.dob, state: row.state, work_state: row.work_state,
    revision_breakdown: salary?.breakdown ?? null,
  };
  // An employee excluded from PF (§262) has no PF in the final settlement either.
  const { rows: [pfx] } = await db.query(
    `SELECT 1 FROM payroll_pf_exclusions WHERE employee_id = $1 AND effective_from <= $2::date AND (ended_on IS NULL OR ended_on > $2::date)`,
    [employeeId, lwd]);
  const config = { ...settings, ...(pfx ? { pf_enabled: false } : {}), month, year, rules: payrollRules,
    structureComponents: salary?.components ?? null, recoveries: [], arrears: null };

  let wage = null, finalSlip = null;
  const warnings = [];
  if (basicSalary > 0) {
    const full = computePayroll({ ...person, joining_date: null, exit_date: null }, { ...config, lop_days: 0 });
    wage = { gross: full.gross, basic: full.basic, code_wages: full.pf_wage };
    finalSlip = computePayroll({ ...person, joining_date: row.joining_date, exit_date: lwd }, { ...config, lop_days: num(options.lop_days) });
    if (!num(salary?.basic_salary)) warnings.push({ code: 'SALARY_FROM_MASTER', message: 'No salary revision is in force on the last working day, so the employee master salary was used.' });
  }

  const { rows: leave } = await db.query(
    `SELECT lb.year, lb.opening_balance, lb.allocated_days, lb.carried_forward_days, lb.used_days, lb.encashed_days, lt.leave_name, lt.annual_quota
       FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE lb.employee_id = $1 AND lb.year = $2 AND lt.is_encashable = true AND lt.deleted_at IS NULL`,
    [employeeId, year]);
  const { rows: loanRows } = await db.query(
    `SELECT id, loan_type, outstanding_balance, is_test FROM payroll_loans WHERE employee_id = $1 AND status = 'active'`, [employeeId]);
  const loans = loanRows.filter((l) => !l.is_test);
  if (loans.length < loanRows.length) warnings.push({ code: 'TEST_LOANS_IGNORED', message: `${loanRows.length - loans.length} test loan(s) were ignored.` });

  // travel_advances.employee_id stores users.id for most rows (see computeClearanceBlockers).
  // Only money actually handed over is recoverable.
  const { rows: [adv] } = await db.query(
    // 'Partially Settled' still owes the rest. Matched on the traveller's login or
    // the advance's trip — `employee_id = $1` compared an employees.id with a
    // users.id and could pick up someone else's advance.
    `SELECT COALESCE(SUM(amount - COALESCE(settled_amount, 0)), 0) AS outstanding FROM travel_advances
      WHERE status IN ('Disbursed', 'Partially Settled')
        AND (employee_id IN (SELECT id FROM users WHERE employee_id = $1)
             OR travel_request_id IN (SELECT id FROM travel_requests WHERE employee_id = $1))`, [employeeId]);
  const { rows: [bonus] } = await db.query(
    `SELECT COALESCE(SUM(bonus), 0) AS paid FROM payroll_runs
      WHERE employee_id = $1 AND LOWER(status) IN ('approved', 'paid', 'processed')
        AND make_date(year, month, 1) BETWEEN $2::date AND $3::date`, [employeeId, fyStart, lwd]);
  const { rows: [finalRun] } = await db.query(
    `SELECT id, status FROM payroll_runs WHERE employee_id = $1 AND month = $2 AND year = $3 ORDER BY id DESC LIMIT 1`, [employeeId, month, year]);
  const { rows: [earlier] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM payroll_runs
      WHERE employee_id = $1 AND LOWER(status) = 'pending' AND make_date(year, month, 1) < make_date($2::int, $3::int, 1)`, [employeeId, year, month]);
  if (earlier?.n) warnings.push({ code: 'EARLIER_RUNS_UNPAID', message: `${earlier.n} earlier payroll run(s) are still unpaid and are not included here. Pay or remove them separately.` });
  const { rows: [claims] } = await db.query(
    // Claims still in the workflow (it never writes 'approved', so this warning
    // could not fire). Company-borne only — a personal line is never paid.
    `SELECT COUNT(*)::int AS n FROM expense_claims
      WHERE employee_id = $1 AND deleted_at IS NULL AND borne_by = 'company'
        AND status IN ('Submitted', 'Manager Approved', 'Accounts Verified', 'Mgmt Approved')`, [employeeId]);
  // Leave encashment claims (encashment.routes.js). A pending one would pay
  // the same days this settlement pays; an approved one not yet paid sits in a
  // payroll month that may never be generated for a leaver.
  const { rows: [enc] } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'approved')::int AS unpaid
       FROM leave_encashments WHERE employee_id = $1`, [employeeId]);
  if (enc?.pending) warnings.push({ code: 'ENCASHMENT_CLAIMS_PENDING', message: `${enc.pending} leave encashment claim(s) are still pending. Cancel them on the Encashment page — this settlement pays the unused leave.` });
  if (enc?.unpaid) warnings.push({ code: 'ENCASHMENT_CLAIMS_UNPAID', message: `${enc.unpaid} approved leave encashment(s) are not yet paid in payroll. Their days are already out of the balance here, so pay them in the final payroll month.` });
  if (claims?.n) warnings.push({ code: 'EXPENSE_CLAIMS_UNPAID', message: `${claims.n} expense claim(s) are still being approved or are unpaid. Finish and pay them through the claims process; they are not part of this settlement.` });
  const { rows: [ytd] } = await db.query(
    `SELECT COALESCE(SUM(gross), 0) AS gross, COALESCE(SUM(tds), 0) AS tds FROM payroll_runs
      WHERE employee_id = $1 AND LOWER(status) IN ('approved', 'paid', 'processed')
        AND make_date(year, month, 1) BETWEEN $2::date AND $3::date`, [employeeId, fyStart, lwd]);
  const regime = settings.regime ?? settings.tax_regime ?? 'new';
  const taxRule = payrollRules[regime === 'old' ? 'tax.old' : 'tax.new'];
  const { rows: assets } = await db.query(
    `SELECT asset_name FROM employee_asset_allocations WHERE employee_id = $1 AND status NOT IN ('returned', 'disposed', 'damaged')`, [employeeId]);
  // The sales incentive is paid once a year, so it is never added automatically. HR sees
  // what it would be on the sales up to the last working day and decides: pay an amount,
  // or not pay, with a reason (owner, 2026-11-12). The decision is kept on later
  // recalculations until HR changes it, and Finance is told when it changes.
  const atExit = await incentiveAtExit({ companyId: company, employeeId, lwd }).catch(() => null);
  const { rows: [prevVersion] } = await db.query(
    `SELECT inputs FROM fnf_settlements WHERE exit_request_id = $1 ORDER BY version DESC LIMIT 1`, [row.exit_id]);
  const prevSi = prevVersion?.inputs?.options?.sales_incentive ?? null;
  let si = prevSi;
  if (options.sales_incentive_decision === 'undecided') si = null;
  else if (options.sales_incentive_decision) {
    si = { decision: options.sales_incentive_decision, amount: options.sales_incentive_decision === 'pay' ? Math.round(num(options.sales_incentive_amount)) : 0, reason: String(options.sales_incentive_reason).trim() };
  }
  const siChanged = JSON.stringify(si ?? null) !== JSON.stringify(prevSi ?? null);
  if (assets.length) warnings.push({ code: 'ASSETS_NOT_RETURNED', message: `${assets.length} asset(s) not returned. Nothing is deducted for them unless a value is agreed.` });

  const inputs = {
    exit: { separation_type: row.separation_type, last_working_date: lwd, notice_period: row.notice_period, created_at: row.exit_created_at },
    employee: { joining_date: row.joining_date, employment_type: row.employment_type, notice_period_days: row.notice_period_days },
    wage, finalRun: finalRun ?? null, leave, loans, bonusPlans: payrollRules['bonus.plans']?.plans ?? [], advanceOutstanding: num(adv?.outstanding), bonusPaidInYear: num(bonus?.paid),
    options: {
      // The calculator's date wins (a one-off check); else the date recorded on the exit (§274).
      lop_days: num(options.lop_days), notice_start: options.notice_start ?? row.resignation_date ?? null,
      waive_notice_days: num(options.waive_notice_days), waive_reason: options.waive_reason ?? null,
      forfeit_gratuity_reason: options.forfeit_gratuity_reason || null, bonus_disqualified_reason: options.bonus_disqualified_reason || null,
      asset_recovery_amount: num(options.asset_recovery_amount), asset_recovery_reason: options.asset_recovery_reason || null,
      sales_incentive: si,
    },
    salesIncentive: atExit || si ? { suggested: atExit, decision: si?.decision ?? null, amount: si?.amount ?? 0, reason: si?.reason ?? null } : null,
    tax: { regime, ytd_gross: num(ytd?.gross), ytd_tds: num(ytd?.tds), standard_deduction: num(taxRule?.standard_deduction) },
  };
  const result = computeSettlement({ ...inputs, finalSlip, tax: { ...inputs.tax, taxOf: (income) => computeIncomeTax(income, regime, taxRule) } }, rules);
  result.warnings.push(...warnings);
  const rulesUnconfirmed = unconfirmedRules(applied);

  // The figure and its record are written together, or not at all.
  // A caller's open client keeps its own transaction; only a Pool needs one of ours.
  const own = typeof db.totalCount === 'number';
  const client = own ? await db.connect() : db;
  let settlement;
  try {
    if (own) await client.query('BEGIN');
    const { rows: [updated] } = await client.query(
      `UPDATE exit_requests er SET fnf_status = 'draft', net_payable = $1
        WHERE er.id = $2 AND er.fnf_status IS DISTINCT FROM 'paid'
          AND EXISTS (SELECT 1 FROM employees e WHERE e.id = er.employee_id AND ($3::int IS NULL OR e.company_id = $3::int))
        RETURNING er.id`,
      [result.net_payable, row.exit_id, companyId]);
    if (!updated) {
      // Paid between the read and the write (or the row moved company).
      throw Object.assign(new Error('F&F is already paid — it cannot be recomputed'), { statusCode: 409 });
    }
    ({ rows: [settlement] } = await client.query(
      `INSERT INTO fnf_settlements (exit_request_id, employee_id, company_id, version, separation_type, last_working_date,
          total_payable, total_recoverable, net_payable, lines, warnings, inputs, rules, rules_unconfirmed, computed_by)
       SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
         FROM fnf_settlements WHERE exit_request_id = $1
       RETURNING id, version`,
      [row.exit_id, employeeId, company, result.separation, lwd, result.total_payable, result.total_recoverable, result.net_payable,
        JSON.stringify(result.lines), JSON.stringify(result.warnings), JSON.stringify(inputs), JSON.stringify(applied), JSON.stringify(rulesUnconfirmed), actorId]));
    if (own) await client.query('COMMIT');
  } catch (e) {
    if (own) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (own) client.release();
  }

  return {
    id: row.exit_id,
    settlement_id: settlement.id,
    version: settlement.version,
    status: 'draft',
    net_payable: result.net_payable,
    computation_details: {
      ...result,
      rules_unconfirmed: rulesUnconfirmed,
      summary: { total_payable: result.total_payable, total_recoverable: result.total_recoverable, net_payable: result.net_payable },
      // For the screen: what the slabs give on the sales to the last day, and HR's decision.
      sales_incentive: inputs.salesIncentive,
    },
    // The route tells Finance when HR's incentive decision is new or different.
    sales_incentive_decision_changed: siChanged && si ? { ...si, suggested: atExit, employee_code: row.office_id, version: settlement.version } : null,
  };
}

/** Every version computed for an employee's exits, newest first. */
export async function settlementHistory(db, employeeId, companyId) {
  const { rows } = await db.query(
    `SELECT s.id, s.exit_request_id, s.version, s.net_payable, s.total_payable, s.total_recoverable, s.computed_by, s.computed_at,
            cu.name AS computed_by_name
       FROM fnf_settlements s JOIN employees e ON e.id = s.employee_id
       LEFT JOIN users cu ON cu.id = s.computed_by
      WHERE s.employee_id = $1 AND ($2::int IS NULL OR e.company_id = $2::int)
      ORDER BY s.computed_at DESC, s.id DESC`,
    [employeeId, companyId]);
  return rows;
}

export class SettlementError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.statusCode = status; this.code = code; this.extra = extra; }
}

// A settlement with one of these cannot be approved: the figure rests on something missing.
const BLOCKING_WARNINGS = ['SALARY_MISSING', 'JOINING_DATE_MISSING', 'NOTICE_DAYS_UNKNOWN', 'SEPARATION_TYPE_UNKNOWN'];

async function latestSettlement(client, exitId) {
  const { rows: [s] } = await client.query(
    `SELECT * FROM fnf_settlements WHERE exit_request_id = $1 ORDER BY version DESC LIMIT 1`, [exitId]);
  return s ?? null;
}

function assertCurrent(s, settlementId) {
  if (!s) throw new SettlementError(409, 'SETTLEMENT_NOT_COMPUTED', 'Compute the settlement first.');
  if (Number(settlementId) !== s.id) throw new SettlementError(409, 'SETTLEMENT_STALE', 'The settlement has been recalculated. Review the latest version.', { latest_settlement_id: s.id });
}

/**
 * Finance approves a specific version. The person who computed it cannot approve it, every
 * rule it used must be confirmed, and nothing the figure rests on may be missing.
 * Runs inside the caller's transaction. Repeating an approval of the same version is harmless.
 */
export async function approveSettlement(client, { exitId, settlementId, userId, companyId }) {
  const s = await latestSettlement(client, exitId);
  assertCurrent(s, settlementId);
  const { rows: [done] } = await client.query(`SELECT 1 FROM fnf_settlement_events WHERE settlement_id = $1 AND action = 'approve'`, [s.id]);
  if (done) return s;
  if (s.computed_by != null && userId != null && Number(s.computed_by) === Number(userId)) {
    throw new SettlementError(409, 'SELF_APPROVAL', 'The person who computed a settlement cannot approve it.');
  }
  if (s.rules_unconfirmed.length) {
    throw new SettlementError(409, 'RULES_UNCONFIRMED', 'Confirm the settlement rules, then recalculate, before approving.', { rules: s.rules_unconfirmed.map((r) => r.key) });
  }
  const blocking = s.warnings.filter((w) => BLOCKING_WARNINGS.includes(w.code));
  if (blocking.length) throw new SettlementError(409, 'SETTLEMENT_INCOMPLETE', blocking.map((w) => w.message).join(' '), { warnings: blocking.map((w) => w.code) });
  await client.query(
    `INSERT INTO fnf_settlement_events (settlement_id, exit_request_id, company_id, action, actor_id, amount) VALUES ($1, $2, $3, 'approve', $4, $5)`,
    [s.id, exitId, companyId ?? s.company_id, userId, s.net_payable]);
  return s;
}

// Which account each line posts to, and on which side.
const GL_BY_LINE = {
  FINAL_SALARY: ['salary_expense', 'debit'], LEAVE: ['leave_expense', 'debit'], BONUS: ['bonus_expense', 'debit'], FESTIVAL_BONUS: ['bonus_expense', 'debit'], SALES_INCENTIVE: ['salary_expense', 'debit'], GRATUITY: ['gratuity_expense', 'debit'],
  RETRENCHMENT: ['retrenchment_expense', 'debit'],
  FINAL_STATUTORY: ['statutory_payable', 'credit'], FINAL_TDS: ['tds_payable', 'credit'], SETTLEMENT_TDS: ['tds_payable', 'credit'],
  LEAVE_NEGATIVE: ['salary_expense', 'credit'], LOAN: ['loan_receivable', 'credit'], TRAVEL_ADVANCE: ['advance_receivable', 'credit'], ASSET_RECOVERY: ['asset_recovery_income', 'credit'],
};
const glFor = (line) => {
  if (line.code === 'NOTICE') return line.direction === 'payable' ? ['salary_expense', 'debit'] : ['notice_recovery_income', 'credit'];
  return GL_BY_LINE[line.code];
};

/**
 * Finance records the payment of the approved version: payer differs from approver, with a UTR,
 * a value date and a company bank account. The event, the journal, the closed loans and advances
 * and the TDS record all commit together or not at all. Runs inside the caller's transaction.
 */
export async function paySettlement(client, { exitId, employeeId, companyId, userId, settlementId, utr: rawUtr, value_date, bank_account_id }) {
  const s = await latestSettlement(client, exitId);
  assertCurrent(s, settlementId);
  const { rows: [paid] } = await client.query(`SELECT utr FROM fnf_settlement_events WHERE settlement_id = $1 AND action = 'pay'`, [s.id]);
  if (paid) throw new SettlementError(409, 'ALREADY_PAID', 'This settlement is already paid.');
  const { rows: [approval] } = await client.query(`SELECT actor_id, created_at FROM fnf_settlement_events WHERE settlement_id = $1 AND action = 'approve'`, [s.id]);
  if (!approval) throw new SettlementError(409, 'NOT_APPROVED', 'This version must be approved before it is paid.');
  if (approval.actor_id != null && userId != null && Number(approval.actor_id) === Number(userId)) {
    throw new SettlementError(409, 'SELF_PAYMENT', 'The person who approved a settlement cannot record its payment.');
  }
  const net = Number(s.net_payable);
  if (net < 0) throw new SettlementError(422, 'EMPLOYEE_OWES', 'The employee owes money on this settlement. Collect it or write it off outside this step.');

  let utr = null, bankChart = null;
  if (net > 0) {
    utr = normaliseUtr(rawUtr);
    if (!utr) throw new SettlementError(400, 'UTR_REQUIRED', 'A bank transaction reference (UTR) is required: 6-35 letters or digits.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value_date ?? ''))) throw new SettlementError(400, 'VALUE_DATE_REQUIRED', 'The bank value date is required.');
    const { rows: [d] } = await client.query(
      `SELECT ($1::date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS future, ($1::date < ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date) AS early`, [value_date, approval.created_at]);
    if (d.future) throw new SettlementError(400, 'VALUE_DATE_FUTURE', 'The value date cannot be in the future.');
    if (d.early) throw new SettlementError(400, 'VALUE_DATE_EARLY', 'The value date cannot be before the approval.');
    const { rows: used } = await client.query(
      `SELECT 1 FROM fnf_settlement_events WHERE UPPER(utr) = $1 UNION ALL SELECT 1 FROM payroll_runs WHERE UPPER(payment_reference) = $1 LIMIT 1`, [utr]);
    if (used.length) throw new SettlementError(409, 'UTR_USED', 'This bank reference is already recorded against another payment.');
    const { rows: [bank] } = await client.query(
      `SELECT chart_account_id FROM bank_accounts WHERE id = $1 AND company_id = $2 AND is_active = true AND deleted_at IS NULL`, [bank_account_id, s.company_id]);
    if (!bank) throw new SettlementError(422, 'BANK_ACCOUNT_INVALID', 'Choose an active bank account of this company.');
    if (!bank.chart_account_id) throw new SettlementError(422, 'BANK_ACCOUNT_NOT_MAPPED', 'This bank account has no ledger account linked to it.');
    bankChart = bank.chart_account_id;
    const { rows: [emp] } = await client.query(`SELECT account_number, ifsc_code FROM employees WHERE id = $1`, [employeeId]);
    if (!emp?.account_number || !emp?.ifsc_code) throw new SettlementError(422, 'EMPLOYEE_BANK_MISSING', 'The employee has no bank account and IFSC on record.');
    // §275: the same format check payroll applies (payrollEligibility.js). Presence alone
    // let a settlement go to IFSC "21312" — the value on file for a live employee.
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(emp.ifsc_code).trim().toUpperCase()) || !/^[0-9]{9,18}$/.test(String(emp.account_number).replace(/\s/g, ''))) {
      throw new SettlementError(422, 'EMPLOYEE_BANK_INVALID', 'The employee\'s bank account number or IFSC is not valid. Correct it on the employee record before paying.');
    }
  }

  // The accounts Finance mapped, resolved in this company.
  const { values } = resolveSettlementRules(s.last_working_date, await loadRuleRows(client, s.company_id));
  const map = values['settlement.gl'];
  const posting = s.lines.filter((l) => Number(l.amount) > 0);
  const missing = [...new Set(posting.map((l) => glFor(l)?.[0] ?? `unmapped line ${l.code}`).filter((k) => !map[k]))];
  if (missing.length) throw new SettlementError(422, 'GL_MAPPING_REQUIRED', `Finance must set these account codes first: ${missing.join(', ')}.`, { missing });
  const accountOf = async (code) => {
    const { rows: [a] } = await client.query(
      `SELECT id FROM chart_of_accounts WHERE code = $1 AND (company_id = $2 OR company_id IS NULL) AND is_active = true ORDER BY company_id DESC NULLS LAST LIMIT 1`, [String(code), s.company_id]);
    if (!a) throw new SettlementError(422, 'GL_ACCOUNT_NOT_FOUND', `Account code ${code} is not an active account of this company.`);
    return a.id;
  };

  let journalEntryId = null;
  if (posting.length) {
    const date = net > 0 ? value_date : s.last_working_date.toISOString?.().slice(0, 10) ?? String(s.last_working_date).slice(0, 10);
    try {
      const je = await journalRepo.createEntry(client, {
        entry_number: await journalRepo.getNextEntryNumber(client), entry_date: date, entry_type: 'Payment',
        reference_type: 'fnf_settlement', reference_id: String(s.id),
        description: `Final settlement, employee ${employeeId}, version ${s.version}${utr ? `, UTR ${utr}` : ''}`, created_by: userId, company_id: s.company_id,
      });
      for (const l of posting) {
        const [key, side] = glFor(l);
        await journalRepo.createLine(client, { journal_entry_id: je.id, account_id: await accountOf(map[key]), description: l.label, debit: side === 'debit' ? Number(l.amount) : 0, credit: side === 'credit' ? Number(l.amount) : 0, company_id: s.company_id });
      }
      if (net > 0) await journalRepo.createLine(client, { journal_entry_id: je.id, account_id: bankChart, description: `Settlement paid (UTR ${utr})`, debit: 0, credit: net, company_id: s.company_id });
      await journalRepo.postEntry(client, je.id);
      journalEntryId = je.id;
    } catch (e) {
      if (e instanceof SettlementError) throw e;
      throw new SettlementError(422, 'JOURNAL_REFUSED', `Payment not recorded: the journal could not be posted: ${e.message}. Nothing was changed.`);
    }
  }

  // What the settlement recovered is now closed at its source.
  for (const l of s.lines.filter((x) => x.code === 'LOAN' && x.source_id)) {
    await client.query(
      `UPDATE payroll_loans SET outstanding_balance = 0, status = 'closed', closed_at = NOW(), closure_type = 'repaid', closure_note = $2, closed_by = $3 WHERE id = $1 AND employee_id = $4`,
      [l.source_id, `Recovered in final settlement ${s.id}`, userId, employeeId]);
  }
  if (s.lines.some((x) => x.code === 'TRAVEL_ADVANCE' && Number(x.amount) > 0)) {
    await client.query(
      `UPDATE travel_advances SET settled_amount = amount, status = 'Settled', updated_at = NOW()
        WHERE status IN ('Disbursed', 'Partially Settled')
          AND (employee_id IN (SELECT id FROM users WHERE employee_id = $1)
               OR travel_request_id IN (SELECT id FROM travel_requests WHERE employee_id = $1))`, [employeeId]);
  }
  const tds = s.lines.filter((x) => ['SETTLEMENT_TDS', 'FINAL_TDS'].includes(x.code)).reduce((sum, x) => sum + Number(x.amount), 0);
  if (tds > 0) {
    const lwd = String(s.last_working_date instanceof Date ? s.last_working_date.toISOString() : s.last_working_date).slice(0, 10);
    const month = Number(lwd.slice(5, 7)), year = Number(lwd.slice(0, 4));
    const { rows: [e] } = await client.query(`SELECT first_name, last_name, pan_number FROM employees WHERE id = $1`, [employeeId]);
    const { rows: [deductee] } = await client.query(
      `INSERT INTO tds_deductees (party_name, pan, deductee_type, section, threshold_limit, rate_with_pan, rate_without_pan, employee_id)
       VALUES ($1,$2,'individual','192',250000,0,20,$3)
       ON CONFLICT (employee_id) WHERE employee_id IS NOT NULL DO UPDATE SET party_name=EXCLUDED.party_name, pan=EXCLUDED.pan RETURNING id`,
      [`${e.first_name || ''} ${e.last_name || ''}`.trim(), e.pan_number || null, employeeId]);
    await client.query(
      `INSERT INTO tds_transactions (deductee_id, section, payment_date, payment_amount, tds_rate, tds_amount, surcharge, education_cess, total_tds, quarter, financial_year, employee_id, payroll_month, payroll_year, company_id)
       SELECT $1,'192',$2,$3,0,$4,0,0,$4,$5,$6,$7,$8,$9,$10
        WHERE NOT EXISTS (SELECT 1 FROM tds_transactions WHERE employee_id=$7 AND payroll_month=$8 AND payroll_year=$9 AND section='192')`,
      [deductee.id, net > 0 ? value_date : lwd, Number(s.total_payable), tds, quarterOfMonth(month), indianFinancialYear(month, year), employeeId, month, year, s.company_id]);
  }
  await client.query(
    `INSERT INTO fnf_settlement_events (settlement_id, exit_request_id, company_id, action, actor_id, amount, utr, value_date, bank_account_id, journal_entry_id)
     VALUES ($1, $2, $3, 'pay', $4, $5, $6, $7, $8, $9)`,
    [s.id, exitId, companyId ?? s.company_id, userId, net, utr, net > 0 ? value_date : null, net > 0 ? bank_account_id : null, journalEntryId]);
  return { settlement: s, utr, journal_entry_id: journalEntryId };
}
