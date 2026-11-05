/**
 * payroll.service.js — the one path from Employee → salary revision →
 * eligibility → monthly run → approval → payment.
 *
 * Every screen that shows a payroll figure goes through buildPeriodContext():
 * Run Payroll, Payslip Generator (preview), Payslip Viewer, Form 16, the
 * employee's own payslips. Before 2026-10-20 there were five: the Payslip
 * Generator, PDF, email and Form 16 paths each called the engine on
 * `employees.basic_salary` with no salary revision, no structure and no company
 * settings, so the same employee/month produced different numbers on different
 * screens — and `save-slip` wrote those numbers straight into payroll_runs.
 *
 * Finalised = status 'approved' or 'paid'. Only finalised, non-test runs feed
 * an employee's own payslip list, YTD for TDS, Form 16 and Form 138 / 24Q.
 */
import pool from '../shared/db.js';
import {
  computePayroll, getMonthName, generateForm16Summary, periodStartDate, periodEndDate,
  indianFinancialYear, monthsRemainingInFY, quarterOfMonth, parseFinancialYear, PayrollInputError,
} from './payrollEngine.js';
import { loadRules } from './statutoryRules.js';
import { installmentFor } from './loanSchedule.js';
import { getLoanGlMapping } from '../finance/services/loanGlMapping.service.js';
import { normalizePayrollSettings, payCycleFor } from './payrollSettings.js';
import {
  evaluateEligibility, validateStatutoryProfile, blockingIssues, ELIGIBILITY_RULE, isValidPAN, isValidTAN,
} from './payrollEligibility.js';
import journalRepo from '../finance/repositories/journal.repository.js';
import { postAccrualInTransaction, PayrollJournalError } from '../finance/services/payrollJournal.service.js';
import { releaseReadiness } from './payrollReleaseGate.js';

export class PayrollHttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export const FINAL_STATUSES = ['approved', 'paid'];
const EDITABLE_STATUSES = ['draft', 'pending'];
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

function requireCompany(company_id) {
  if (company_id == null) {
    throw new PayrollHttpError(400, 'Payroll is per company — sign in to (or select) a company first');
  }
  return company_id;
}

function period(month, year) {
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year) || new Date().getFullYear();
  if (m < 1 || m > 12) throw new PayrollHttpError(400, 'month must be between 1 and 12');
  return { month: m, year: y, start: periodStartDate(m, y), end: periodEndDate(m, y), label: `${getMonthName(m)} ${y}` };
}

/** Finalised months of the same FY strictly before `month` (for YTD). */
function fyMonthsBefore(month, year) {
  const out = [];
  const startYear = month >= 4 ? year : year - 1;
  let m = 4, y = startYear;
  while (!(m === month && y === year)) {
    out.push([m, y]);
    m += 1; if (m === 13) { m = 1; y += 1; }
    if (out.length > 12) break;
  }
  return out;
}

export async function fetchPayrollSettings(company_id) {
  const { rows } = await pool.query(
    `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'payroll' LIMIT 1`,
    [company_id ?? 0]
  ).catch(() => ({ rows: [] }));
  return normalizePayrollSettings(rows[0]?.settings || {});
}

/**
 * Everything needed to compute (or explain not computing) every employee of a
 * company for one wage month. Read-only.
 */
export async function buildPeriodContext({ company_id, month, year, employee_id = null, department = null, client = pool }) {
  requireCompany(company_id);
  const p = period(month, year);
  const [{ settings, conflicts }, { values: rules, applied: rulesApplied }] = await Promise.all([
    fetchPayrollSettings(company_id),
    loadRules(client, company_id, p.end),
  ]);

  const params = [p.end, company_id];
  let filter = '';
  if (employee_id != null) { params.push(parseInt(employee_id)); filter += ` AND e.id = $${params.length}`; }
  if (department && department !== 'All') { params.push(department); filter += ` AND e.department = $${params.length}`; }
  const { rows: emps } = await client.query(`
    SELECT e.id, e.office_id, e.first_name, e.last_name, e.department, e.designation, e.status,
           e.joining_date, e.exit_date, e.deleted_at, e.dob, e.company_id,
           e.pan_number, e.account_number, e.ifsc_code, e.bank_name, e.uan_number,
           e.company_email, e.personal_email,
           e.basic_salary AS master_basic,
           -- The accepted offer's ANNUAL CTC, shown to HR beside a missing
           -- revision; never used as a salary (it is annual and policy-bound).
           (SELECT o.offered_salary FROM offer_letters o
             WHERE o.candidate_id = e.source_candidate_id AND o.company_id = e.company_id
               AND o.offer_status = 'accepted'
             ORDER BY o.created_at DESC LIMIT 1) AS offer_annual_ctc,
           (SELECT b.state FROM branches  b WHERE b.id = e.branch_id)  AS state,
           (SELECT c.state FROM companies c WHERE c.id = e.company_id) AS work_state,
           esa.id AS revision_id, esa.basic_salary AS revision_basic, esa.effective_from AS revision_effective_from,
           esa.breakdown AS revision_breakdown, esa.annual_ctc AS revision_annual_ctc, esa.entry_mode AS revision_entry_mode,
           COALESCE(ss.id, ds.id)                 AS structure_id,
           COALESCE(ss.name, ds.name)             AS structure_name,
           COALESCE(ss.components, ds.components) AS structure_components,
           EXTRACT(YEAR FROM AGE($1::date, e.joining_date)) AS years_of_service
      FROM employees e
      -- The revision IN FORCE on the period's last day (a future-dated
      -- increment stays inert until its date — see 2026-09-30 note in git
      -- history of this query).
      LEFT JOIN LATERAL (
        SELECT id, basic_salary, structure_id, effective_from, breakdown, annual_ctc, entry_mode
          FROM employee_salary_assignments
         WHERE employee_id = e.id AND effective_from <= $1::date
         ORDER BY effective_from DESC, created_at DESC
         LIMIT 1
      ) esa ON true
      LEFT JOIN salary_structures ss ON ss.id = esa.structure_id
      LEFT JOIN LATERAL (
        -- the company's own default structure first, else the shared template default
        SELECT id, name, components FROM salary_structures
         WHERE is_default = true AND (company_id = e.company_id OR company_id IS NULL)
         ORDER BY company_id NULLS LAST, id LIMIT 1
      ) ds ON true
     WHERE e.company_id = $2 ${filter}
     ORDER BY e.department NULLS LAST, e.first_name
  `, params);

  const ids = emps.map(e => e.id);
  const empty = { rows: [] };
  const fyBefore = fyMonthsBefore(p.month, p.year);
  const [ot, lop, loans, arrears, ytd, decl, runs] = ids.length ? await Promise.all([
    client.query(`
      SELECT employee_id, SUM(ot_hours) AS total_hours,
             SUM(ot_hours * multiplier) / NULLIF(SUM(ot_hours), 0) AS weighted_multiplier
        FROM attendance_ot_records
       WHERE attendance_date BETWEEN $1::date AND $2::date
         AND status IN ('approved', 'auto_approved')
         AND employee_id = ANY($3::int[])
       GROUP BY employee_id`, [p.start, p.end, ids]).catch(() => empty),
    client.query(`
      SELECT employee_id, lop_days, COALESCE(night_shift_days, 0) AS night_shift_days
        FROM payroll_attendance_summary
       WHERE month = $1 AND year = $2 AND employee_id = ANY($3::int[])`, [p.month, p.year, ids]).catch(() => empty),
    client.query(`
      SELECT id, employee_id, loan_type, emi_amount, outstanding_balance, interest_rate
        FROM payroll_loans
       WHERE status = 'active' AND is_test = false AND outstanding_balance > 0
         AND start_date <= $1::date AND employee_id = ANY($2::int[])
       ORDER BY id`, [p.end, ids]),
    client.query(`
      SELECT id, employee_id, arrear_amount, employee_pf_diff, employer_pf_diff
        FROM payroll_arrears
       WHERE status = 'approved' AND is_test = false
         AND paid_in_month = $1 AND paid_in_year = $2 AND employee_id = ANY($3::int[])`,
      [p.month, p.year, ids]),
    fyBefore.length ? client.query(`
      SELECT employee_id, SUM(gross) AS gross, SUM(tds) AS tds, SUM(employee_pf) AS employee_pf
        FROM payroll_runs
       WHERE employee_id = ANY($1::int[]) AND is_test = false AND status = ANY($2::text[])
         AND (year * 100 + month) = ANY($3::int[])
       GROUP BY employee_id`, [ids, FINAL_STATUSES, fyBefore.map(([m, y]) => y * 100 + m)]) : empty,
    client.query(`
      SELECT employee_id, declaration_type, SUM(amount) AS total_amount
        FROM it_declarations
       WHERE financial_year = $1 AND status IN ('approved', 'submitted') AND employee_id = ANY($2::int[])
       GROUP BY employee_id, declaration_type`, [indianFinancialYear(p.month, p.year), ids]).catch(() => empty),
    client.query(`
      SELECT id, employee_id, status FROM payroll_runs
       WHERE month = $1 AND year = $2 AND employee_id = ANY($3::int[]) AND is_test = false`,
      [p.month, p.year, ids]),
  ]) : [empty, empty, empty, empty, empty, empty, empty];

  const by = (rows) => { const m = new Map(); for (const r of rows) { const k = String(r.employee_id); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const otM = by(ot.rows), lopM = by(lop.rows), loanM = by(loans.rows), arrM = by(arrears.rows),
    ytdM = by(ytd.rows), declM = by(decl.rows), runM = by(runs.rows);

  const items = emps.map(emp => {
    const k = String(emp.id);
    const elig = evaluateEligibility(emp, p);
    const o = otM.get(k)?.[0];
    const l = lopM.get(k)?.[0];
    const y = ytdM.get(k)?.[0];
    const declarations = Object.fromEntries((declM.get(k) || []).map(d => [String(d.declaration_type).toLowerCase(), num(d.total_amount)]));
    const recoveries = (loanM.get(k) || []).map(r => ({
      type: r.loan_type === 'advance' ? 'advance' : 'loan',
      loan_id: r.id,
      // loanSchedule.installmentFor: EMI, never more than principal + this
      // month's interest — the same figure approval records
      amount: installmentFor(r).amount,
    }));
    const arr = arrM.get(k) || [];
    const config = {
      ...settings,
      month: p.month, year: p.year, rules,
      structureComponents: emp.structure_components || null,
      overtime_hours: num(o?.total_hours),
      ot_multiplier: o?.weighted_multiplier != null ? num(o.weighted_multiplier) : 1.5,
      lop_days: num(l?.lop_days),
      night_shift_days: parseInt(l?.night_shift_days || 0),
      night_shift_rate: settings.night_shift_rate || 200,
      recoveries,
      arrears: arr.length ? {
        amount: arr.reduce((s, a) => s + num(a.arrear_amount), 0),
        employee_pf: arr.reduce((s, a) => s + num(a.employee_pf_diff), 0),
        employer_pf: arr.reduce((s, a) => s + num(a.employer_pf_diff), 0),
        ids: arr.map(a => a.id),
      } : null,
      ytd: { gross: num(y?.gross), tds: num(y?.tds), employee_pf: num(y?.employee_pf) },
      months_remaining: monthsRemainingInFY(p.month),
      deduction_80d: declarations['80d'] || 0,
      deduction_nps_80ccd: declarations['80ccd'] || 0,
      lta_claimed: declarations['lta'] || 0,
    };
    const run = runM.get(k)?.[0] || null;
    return { emp: { ...emp, basic_salary: emp.revision_basic, breakdown: emp.revision_breakdown || null }, eligibility: elig, config, run };
  });

  return { period: p, settings, conflicts, rules, rulesApplied, items };
}

const isoDay = (d) => (d == null ? null : (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10));

/**
 * A salary revision that takes effect AFTER the first day of the wage month
 * (and not on the joining date, which proration already handles) is applied
 * by the engine to the WHOLE month — EMP003's revision effective 20-Oct-2026
 * would pay the new Basic for 1–19 Oct too. Whether to pro-rate by days or
 * apply from the next month with arrears is an open business decision, so
 * until it is made the draft carries a blocking issue and approval refuses.
 */
export function midPeriodRevisionIssue(emp, period) {
  const eff = isoDay(emp.revision_effective_from);
  const doj = isoDay(emp.joining_date);
  if (!eff || eff <= period.start || eff === doj) return null;
  return { field: 'salary_revision', severity: 'error', code: 'REVISION_MID_PERIOD',
    message: `Salary revision effective ${eff} falls inside the month; the draft applies it to the whole month. Decide the mid-month revision treatment before approval.` };
}

function computeItem(item, overrides = {}, period = null) {
  const config = { ...item.config, ...overrides };
  const slip = computePayroll(item.emp, config);
  const validation = validateStatutoryProfile(item.emp, slip);
  const mid = period ? midPeriodRevisionIssue(item.emp, period) : null;
  if (mid) validation.push(mid);
  return { slip, validation };
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export async function getEligibility({ company_id, month, year }) {
  const ctx = await buildPeriodContext({ company_id, month, year });
  const employees = ctx.items
    .filter(i => !i.emp.deleted_at || i.run)
    .map(i => ({
      employee_id: i.emp.id,
      employee_code: i.emp.office_id,
      name: `${i.emp.first_name || ''} ${i.emp.last_name || ''}`.trim(),
      department: i.emp.department,
      status: i.emp.status,
      eligible: i.eligibility.eligible,
      reasons: i.eligibility.reasons,
      revision_basic: i.emp.revision_basic != null ? num(i.emp.revision_basic) : null,
      revision_effective_from: i.emp.revision_effective_from,
      structure_name: i.emp.structure_name,
      run_status: i.run?.status || null,
    }));
  const isCurrent = (e) => ['active', 'probation', 'notice'].includes(String(e.status).toLowerCase());
  const headcount = employees.filter(isCurrent).length;
  const eligible = employees.filter(e => e.eligible).length;
  // not_eligible counts CURRENT employees only (headcount − eligible): an exited
  // employee is not a payroll gap. Exited ones stay in `employees` with E2.
  return {
    period: ctx.period.label, month: ctx.period.month, year: ctx.period.year,
    rule: ELIGIBILITY_RULE,
    summary: {
      active_headcount: headcount, eligible,
      not_eligible: employees.filter(e => isCurrent(e) && !e.eligible).length,
      exited_or_inactive: employees.filter(e => !isCurrent(e)).length,
    },
    employees,
  };
}

// ── Generate (the official monthly run) ────────────────────────────────────

export async function generatePayroll({ month, year, department, employee_id, company_id, userId = null } = {}) {
  requireCompany(company_id);
  const p = period(month, year);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One generator per company-period at a time.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`payroll:${company_id}:${p.year}:${p.month}`]);
    const ctx = await buildPeriodContext({ company_id, month: p.month, year: p.year, employee_id, department, client });

    const saved = [], skipped = [], errors = [];
    for (const item of ctx.items) {
      const { emp, run } = item;
      const who = { employee_id: emp.id, employee_code: emp.office_id, name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() };
      if (run && FINAL_STATUSES.includes(run.status)) {
        skipped.push({ ...who, reason: `Already ${run.status} — finalised runs are not recalculated` });
        continue;
      }
      if (!item.eligibility.eligible) {
        if (run) await client.query(`DELETE FROM payroll_runs WHERE id = $1 AND status = ANY($2::text[])`, [run.id, EDITABLE_STATUSES]);
        if (!emp.deleted_at && ['active', 'probation', 'notice'].includes(String(emp.status).toLowerCase())) {
          skipped.push({ ...who, reason: item.eligibility.reasons.map(r => r.message).join('; '), reasons: item.eligibility.reasons });
        }
        continue;
      }
      let result;
      try { result = computeItem(item, {}, p); }
      catch (e) {
        if (!(e instanceof PayrollInputError)) throw e;
        if (run) await client.query(`DELETE FROM payroll_runs WHERE id = $1 AND status = ANY($2::text[])`, [run.id, EDITABLE_STATUSES]);
        errors.push({ ...who, error: e.message, error_code: e.code });
        continue;
      }
      const { slip, validation } = result;
      await client.query(
        `INSERT INTO payroll_runs
           (period_label, period_start, period_end, status, employee_id, month, year,
            gross, net_pay, total_deductions, employee_pf, employer_pf, eps, epf_employer,
            employee_esi, employer_esi, tds, professional_tax, lwf_employee, lwf_employer,
            ctc_monthly, tax_regime, annual_taxable_income, annual_tax,
            basic, hra, conveyance_allowance, medical_allowance, special_allowance,
            lop_days, bonus, overtime_pay, overtime_hours, night_shift_days,
            loan_deduction, advance_deduction, arrears_amount, validation_issues,
            pf_wage, pf_contribution_wage, eps_wage, generated_by, earning_lines, generated_at)
         VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
                 $24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37::jsonb,$38,$39,$40,$41,$42::jsonb,NOW())
         ON CONFLICT (employee_id, month, year)
         WHERE employee_id IS NOT NULL AND month IS NOT NULL AND year IS NOT NULL
         DO UPDATE SET
           period_label=EXCLUDED.period_label, period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end,
           gross=EXCLUDED.gross, net_pay=EXCLUDED.net_pay, total_deductions=EXCLUDED.total_deductions,
           employee_pf=EXCLUDED.employee_pf, employer_pf=EXCLUDED.employer_pf, eps=EXCLUDED.eps, epf_employer=EXCLUDED.epf_employer,
           employee_esi=EXCLUDED.employee_esi, employer_esi=EXCLUDED.employer_esi, tds=EXCLUDED.tds,
           professional_tax=EXCLUDED.professional_tax, lwf_employee=EXCLUDED.lwf_employee, lwf_employer=EXCLUDED.lwf_employer,
           ctc_monthly=EXCLUDED.ctc_monthly, tax_regime=EXCLUDED.tax_regime,
           annual_taxable_income=EXCLUDED.annual_taxable_income, annual_tax=EXCLUDED.annual_tax,
           basic=EXCLUDED.basic, hra=EXCLUDED.hra, conveyance_allowance=EXCLUDED.conveyance_allowance,
           medical_allowance=EXCLUDED.medical_allowance, special_allowance=EXCLUDED.special_allowance,
           lop_days=EXCLUDED.lop_days, bonus=EXCLUDED.bonus, overtime_pay=EXCLUDED.overtime_pay,
           overtime_hours=EXCLUDED.overtime_hours, night_shift_days=EXCLUDED.night_shift_days,
           loan_deduction=EXCLUDED.loan_deduction, advance_deduction=EXCLUDED.advance_deduction,
           arrears_amount=EXCLUDED.arrears_amount, validation_issues=EXCLUDED.validation_issues,
           pf_wage=EXCLUDED.pf_wage, pf_contribution_wage=EXCLUDED.pf_contribution_wage, eps_wage=EXCLUDED.eps_wage,
           generated_by=EXCLUDED.generated_by, earning_lines=EXCLUDED.earning_lines, generated_at=NOW(), updated_at=NOW()
         -- Only a draft may be recalculated. This used to be status != 'paid',
         -- so a regenerate after APPROVAL silently changed amounts that had
         -- already been posted to the GL.
         WHERE payroll_runs.status IN ('draft', 'pending')`,
        [
          p.label, p.start, p.end, emp.id, p.month, p.year,
          slip.gross, slip.net_pay, slip.total_deductions, slip.employee_pf, slip.employer_pf, slip.eps, slip.epf_employer,
          slip.employee_esi, slip.employer_esi, slip.tds, slip.professional_tax, slip.lwf_employee, slip.lwf_employer,
          slip.ctc_monthly, slip.tax_regime, slip.annual_taxable_income, slip.annual_tax,
          slip.basic, slip.hra, slip.conveyance_allowance, slip.medical_allowance, slip.special_allowance,
          slip.lop_days, slip.bonus, slip.overtime_pay, item.config.overtime_hours, item.config.night_shift_days,
          slip.loan_deduction, slip.advance_deduction, slip.arrears, JSON.stringify(validation),
          slip.pf_wage, slip.pf_contribution_wage, slip.eps_wage, userId,
          JSON.stringify(slip.earning_lines || []),
        ]
      );
      saved.push({ ...slip, status: 'pending', validation_issues: validation });
    }
    await client.query('COMMIT');
    const blocked = saved.filter(s => blockingIssues(s.validation_issues).length).length;
    return {
      message: `Payroll draft generated for ${saved.length} employee(s)` +
        (skipped.length ? `; ${skipped.length} not eligible or locked` : '') +
        (errors.length ? `; ${errors.length} with errors` : '') +
        (blocked ? `; ${blocked} have data issues that will block approval` : ''),
      count: saved.length,
      skipped, errors, data: saved,
      rules_applied: ctx.rulesApplied,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Preview (Payslip Generator / what-if) — never writes ───────────────────

export async function previewEmployeePayslip({ employee_id, month, year, company_id, overrides = {} }) {
  const ctx = await buildPeriodContext({ company_id, month, year, employee_id });
  const item = ctx.items[0];
  if (!item || item.emp.deleted_at) throw new PayrollHttpError(404, 'Employee not found');
  const base = {
    preview: true, period: ctx.period.label, run_status: item.run?.status || 'not_generated',
    eligible: item.eligibility.eligible, reasons: item.eligibility.reasons,
    settings_conflicts: ctx.conflicts, rules_applied: ctx.rulesApplied,
  };
  if (!item.eligibility.eligible) return { ...base, slip: null, validation: [] };
  const o = {};
  if (overrides.lop_days != null) o.lop_days = num(overrides.lop_days);
  if (overrides.bonus != null) o.bonus = num(overrides.bonus);
  if (overrides.loan_deduction != null || overrides.advance_deduction != null) {
    o.recoveries = [
      { type: 'loan', amount: overrides.loan_deduction != null ? num(overrides.loan_deduction) : item.config.recoveries.filter(r => r.type === 'loan').reduce((s, r) => s + r.amount, 0) },
      { type: 'advance', amount: overrides.advance_deduction != null ? num(overrides.advance_deduction) : item.config.recoveries.filter(r => r.type === 'advance').reduce((s, r) => s + r.amount, 0) },
    ];
  }
  try {
    const { slip, validation } = computeItem(item, o, ctx.period);
    return { ...base, slip: { ...slip, employee_code: item.emp.office_id }, validation, emp: item.emp };
  } catch (e) {
    if (!(e instanceof PayrollInputError)) throw e;
    return { ...base, eligible: false, reasons: [{ code: e.code, message: e.message }], slip: null, validation: [] };
  }
}

// ── Reads over saved runs (all tenant-scoped, test rows excluded) ──────────

const RUN_COLUMNS = `
  pr.id AS run_id, pr.employee_id, pr.month, pr.year, pr.period_label, pr.status,
  pr.gross, pr.net_pay, pr.total_deductions, pr.employee_pf, pr.employer_pf, pr.eps, pr.epf_employer,
  pr.employee_esi, pr.employer_esi, pr.tds, pr.professional_tax, pr.lwf_employee, pr.lwf_employer,
  pr.ctc_monthly, pr.tax_regime, pr.annual_taxable_income, pr.annual_tax,
  pr.basic, pr.hra, pr.conveyance_allowance, pr.medical_allowance, pr.special_allowance,
  pr.lop_days, pr.bonus, pr.overtime_pay, pr.overtime_hours, pr.night_shift_days,
  pr.loan_deduction, pr.advance_deduction, pr.arrears_amount, pr.validation_issues,
  pr.approved_at, pr.payment_mode, pr.payment_reference, pr.generated_at, pr.earning_lines,
  e.office_id AS employee_code,
  TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS name,
  e.department, e.designation, e.pan_number, e.account_number AS bank_account, e.ifsc_code, e.uan_number,
  -- Contract figures of the revision in force for the month — ONLY for a
  -- CTC-mode revision. Shown apart from the month's gross and employer cost;
  -- a payroll month's cost is never labelled as the annual CTC.
  (SELECT CASE WHEN a.annual_ctc IS NULL THEN NULL
               ELSE json_build_object('annual_ctc', a.annual_ctc, 'effective_from', a.effective_from, 'policy_version', a.ctc_policy_version) END
     FROM employee_salary_assignments a
    WHERE a.employee_id = pr.employee_id
      AND a.effective_from <= (make_date(pr.year, pr.month, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date
    ORDER BY a.effective_from DESC, a.created_at DESC LIMIT 1) AS contract`;

const NUMERIC_RUN_FIELDS = ['gross', 'net_pay', 'total_deductions', 'employee_pf', 'employer_pf', 'eps', 'epf_employer',
  'employee_esi', 'employer_esi', 'tds', 'professional_tax', 'lwf_employee', 'lwf_employer', 'ctc_monthly',
  'annual_taxable_income', 'annual_tax', 'basic', 'hra', 'conveyance_allowance', 'medical_allowance',
  'special_allowance', 'lop_days', 'bonus', 'overtime_pay', 'overtime_hours', 'loan_deduction',
  'advance_deduction', 'arrears_amount'];

export function normalizeRun(r) {
  const out = { ...r };
  for (const f of NUMERIC_RUN_FIELDS) out[f] = num(r[f]);
  out.employer_contributions = {
    pf_total: out.employer_pf, eps: out.eps, epf: out.epf_employer,
    esi: out.employer_esi, lwf: out.lwf_employer,
    total: out.employer_pf + out.employer_esi + out.lwf_employer,
  };
  out.arrears = out.arrears_amount;
  return out;
}

export async function listPayroll({ month, year, department, page, limit: limitParam, company_id } = {}) {
  requireCompany(company_id);
  const p = period(month, year);
  const pageNum = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(limitParam) || 200));
  const params = [p.month, p.year, company_id];
  let where = `pr.month = $1 AND pr.year = $2 AND e.company_id = $3 AND pr.is_test = false`;
  if (department && department !== 'All') { params.push(department); where += ` AND e.department = $${params.length}`; }
  const { rows: [{ total }] } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id WHERE ${where}`, params);
  params.push(pageSize, (pageNum - 1) * pageSize);
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS} FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
      WHERE ${where} ORDER BY e.department NULLS LAST, e.first_name
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return {
    data: rows.map(normalizeRun),
    pagination: { page: pageNum, limit: pageSize, total, pages: Math.ceil(total / pageSize) },
  };
}

export async function getSummary({ month, year, company_id } = {}) {
  requireCompany(company_id);
  const p = period(month, year);
  const [elig, { rows: [s] }] = await Promise.all([
    getEligibility({ company_id, month: p.month, year: p.year }),
    pool.query(`
      SELECT COUNT(*)::int AS total_employees,
             COALESCE(SUM(pr.gross), 0)            AS total_gross,
             COALESCE(SUM(pr.net_pay), 0)          AS total_net,
             COALESCE(SUM(pr.total_deductions), 0) AS total_deductions,
             COALESCE(SUM(pr.employee_pf), 0)      AS employee_pf,
             COALESCE(SUM(pr.employer_pf), 0)      AS employer_pf,
             COALESCE(SUM(pr.employee_esi), 0)     AS employee_esi,
             COALESCE(SUM(pr.employer_esi), 0)     AS employer_esi,
             COALESCE(SUM(pr.tds), 0)              AS total_tds,
             COALESCE(SUM(pr.professional_tax), 0) AS total_pt,
             COALESCE(SUM(pr.employer_pf + pr.employer_esi + pr.lwf_employer), 0) AS employer_cost,
             COALESCE(SUM(pr.ctc_monthly), 0)      AS ctc_monthly,
             COUNT(*) FILTER (WHERE pr.status = 'pending')::int  AS pending_count,
             COUNT(*) FILTER (WHERE pr.status = 'approved')::int AS approved_count,
             COUNT(*) FILTER (WHERE pr.status = 'paid')::int     AS paid_count,
             COUNT(*) FILTER (WHERE jsonb_path_exists(pr.validation_issues, '$[*] ? (@.severity == "error")'))::int AS blocked_count
        FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
       WHERE pr.month = $1 AND pr.year = $2 AND e.company_id = $3 AND pr.is_test = false`,
    [p.month, p.year, company_id]),
  ]);
  const { settings, conflicts } = await fetchPayrollSettings(company_id);
  const runStatus = s.total_employees === 0 ? null
    : s.paid_count === s.total_employees ? 'paid'
      : s.pending_count === 0 ? 'approved' : 'pending';
  const out = {};
  for (const [k, v] of Object.entries(s)) out[k] = typeof v === 'string' ? num(v) : v;
  return {
    ...out,
    total_pf: out.employee_pf + out.employer_pf,
    total_esi: out.employee_esi + out.employer_esi,
    month: p.month, year: p.year, payroll_period: p.label,
    run_status: runStatus,
    is_locked: out.approved_count + out.paid_count > 0,
    source: out.total_employees > 0 ? 'saved_records' : 'not_generated',
    eligibility: elig.summary,
    cycle: payCycleFor(settings, p.month, p.year, { runStatus }),
    settings_conflicts: conflicts,
  };
}

export async function getPayrollTrend({ company_id } = {}) {
  requireCompany(company_id);
  // Real totals only. The old query COALESCEd an empty month to
  // SUM(basic_salary) and SUM(basic_salary) * 0.85 — an invented "net".
  const { rows } = await pool.query(`
    WITH months AS (
      SELECT EXTRACT(YEAR FROM gs)::int AS y, EXTRACT(MONTH FROM gs)::int AS m, TO_CHAR(gs, 'Mon') AS label
        FROM generate_series(DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months', DATE_TRUNC('month', CURRENT_DATE), INTERVAL '1 month') gs
    )
    SELECT mo.label AS month, mo.y AS year, mo.m AS month_number,
           SUM(pr.gross) AS gross, SUM(pr.net_pay) AS net, COUNT(pr.id)::int AS employees
      FROM months mo
      LEFT JOIN (payroll_runs pr JOIN employees e ON e.id = pr.employee_id AND e.company_id = $1)
        ON pr.year = mo.y AND pr.month = mo.m AND pr.is_test = false
     GROUP BY mo.y, mo.m, mo.label ORDER BY mo.y, mo.m`, [company_id]);
  return rows.map(r => ({
    month: r.month, year: r.year, month_number: r.month_number, employees: r.employees,
    gross: r.gross == null ? null : Math.round(num(r.gross)),
    net: r.net == null ? null : Math.round(num(r.net)),
  }));
}

export async function getSavedRun({ employee_id, month, year, company_id }) {
  requireCompany(company_id);
  const p = period(month, year);
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS} FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
      WHERE pr.employee_id = $1 AND pr.month = $2 AND pr.year = $3 AND e.company_id = $4 AND pr.is_test = false
      LIMIT 1`, [parseInt(employee_id), p.month, p.year, company_id]);
  return rows[0] ? normalizeRun(rows[0]) : null;
}

/** Saved run if there is one, else a clearly-labelled preview. */
export async function getEmployeePayslip(employeeId, { month, year, company_id } = {}) {
  const saved = await getSavedRun({ employee_id: employeeId, month, year, company_id });
  if (saved) return { ...saved, preview: false };
  const pv = await previewEmployeePayslip({ employee_id: employeeId, month, year, company_id });
  return pv.slip
    ? { ...pv.slip, preview: true, status: 'not_generated', validation_issues: pv.validation }
    : { preview: true, status: 'not_generated', eligible: false, reasons: pv.reasons };
}

// ── Approval → payment ──────────────────────────────────────────────────────

export async function approvePayroll({ month, year, company_id, userId }) {
  requireCompany(company_id);
  const p = period(month, year);
  // Release gate: configuration and statutory rules must be settled first.
  const readiness = await releaseReadiness({ company_id, month: p.month, year: p.year });
  if (!readiness.ready) {
    throw new PayrollHttpError(422,
      `Approval blocked: ${readiness.blockers.length} payroll release prerequisite(s) are not met for ${p.label}`,
      { release_blockers: readiness.blockers });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: runs } = await client.query(`
      SELECT pr.id, pr.employee_id, pr.generated_by, pr.gross, pr.net_pay, pr.tds, pr.employee_pf, pr.employer_pf,
             pr.employee_esi, pr.employer_esi, pr.professional_tax, pr.lwf_employee, pr.lwf_employer,
             pr.loan_deduction, pr.advance_deduction,
             e.office_id, e.first_name, e.last_name, e.pan_number, e.account_number, e.ifsc_code, e.uan_number
        FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
       WHERE pr.month = $1 AND pr.year = $2 AND e.company_id = $3 AND pr.is_test = false AND pr.status = 'pending'
       FOR UPDATE OF pr`, [p.month, p.year, company_id]);
    if (!runs.length) throw new PayrollHttpError(400, 'No pending payroll records for this period (not generated, or already approved/paid)');

    // Maker-checker (PAYROLL_DATA_FLOW_AUDIT.md Part 10): the approver must not
    // be the person who prepared (last generated) any draft in the batch —
    // compared on users.id, whatever roles either holds. A draft with no
    // recorded preparer cannot be checked, so it is refused until regenerated.
    if (userId == null) throw new PayrollHttpError(403, 'Approval needs an identified user');
    const noPreparer = runs.filter(r => r.generated_by == null);
    if (noPreparer.length) {
      throw new PayrollHttpError(422,
        `Approval blocked: ${noPreparer.length} draft(s) have no recorded preparer (generated before maker-checker). Regenerate the draft; a different authorised user then approves.`,
        { code: 'PREPARER_UNKNOWN', employees: noPreparer.slice(0, 20).map(r => r.office_id) });
    }
    const own = runs.filter(r => Number(r.generated_by) === Number(userId));
    if (own.length) {
      throw new PayrollHttpError(403,
        `Maker-checker: you prepared ${own.length} of these ${runs.length} draft(s). A different authorised user must approve them.`,
        { code: 'MAKER_CHECKER', employees: own.slice(0, 20).map(r => r.office_id) });
    }

    // Validate against the employee data AS IT IS NOW — HR may have fixed a
    // PAN since the draft was generated, or broken one.
    const blocked = [];
    const { rows: revs } = await client.query(`
      SELECT DISTINCT ON (a.employee_id) a.employee_id, a.effective_from AS revision_effective_from, e.joining_date
        FROM employee_salary_assignments a JOIN employees e ON e.id = a.employee_id
       WHERE a.employee_id = ANY($1::int[]) AND a.effective_from <= $2::date
       ORDER BY a.employee_id, a.effective_from DESC, a.created_at DESC`, [runs.map(r => r.employee_id), p.end]);
    const revBy = new Map(revs.map(r => [r.employee_id, r]));
    for (const r of runs) {
      const issues = blockingIssues(validateStatutoryProfile(r, { tds: num(r.tds), employee_pf: num(r.employee_pf) }));
      const mid = revBy.has(r.employee_id) ? midPeriodRevisionIssue(revBy.get(r.employee_id), p) : null;
      if (mid) issues.push(mid);
      if (issues.length) blocked.push({ employee_id: r.employee_id, employee_code: r.office_id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), issues });
    }
    if (blocked.length) {
      throw new PayrollHttpError(422,
        `Approval blocked: ${blocked.length} employee(s) have missing or invalid bank / PAN data. Fix the employee records and approve again.`,
        { blocked });
    }

    // Loan recoveries: the draft deducted min(EMI, outstanding) per active loan.
    // Re-derive the same allocation now and refuse if a loan changed meanwhile.
    const loanRuns = runs.filter(r => num(r.loan_deduction) + num(r.advance_deduction) > 0);
    const repayments = [];
    if (loanRuns.length) {
      const { rows: loans } = await client.query(`
        SELECT id, employee_id, loan_type, emi_amount, outstanding_balance, interest_rate FROM payroll_loans
         WHERE status = 'active' AND is_test = false AND outstanding_balance > 0
           AND start_date <= $1::date AND employee_id = ANY($2::int[])
         ORDER BY id FOR UPDATE`, [p.end, loanRuns.map(r => r.employee_id)]);
      for (const r of loanRuns) {
        const mine = loans.filter(l => l.employee_id === r.employee_id);
        const alloc = mine.map(l => ({ loan: l, ...installmentFor(l) }));
        const expected = num(r.loan_deduction) + num(r.advance_deduction);
        const got = alloc.reduce((s, a) => s + Math.round(a.amount), 0);
        if (Math.round(expected) !== got) {
          throw new PayrollHttpError(409, `Loans for ${r.office_id} changed after the draft was generated (draft ₹${expected}, loans now ₹${got}). Regenerate the payroll, then approve.`);
        }
        for (const a of alloc) repayments.push({ run: r, ...a });
      }
    }

    // GL safety (PAYROLL_DATA_FLOW_AUDIT.md Part 14): a batch that recovers a
    // loan is not approved until Finance has approved the accounts its
    // principal and interest post to. Refused here — before any row changes —
    // so the payslips, the repayment ledger and the GL cannot drift apart.
    if (repayments.some(x => x.amount > 0)) {
      const mapping = await getLoanGlMapping(company_id, client);
      if (mapping.status !== 'approved') {
        throw new PayrollHttpError(422,
          `Approval blocked: this batch recovers employee loans / advances, but Finance has not approved the GL accounts for them (${mapping.problems.join('; ')}). Ask Finance to set them in Accounting → Loan account mapping, then approve.`,
          { code: 'LOAN_GL_MAPPING_REQUIRED', problems: mapping.problems });
      }
    }

    await client.query(
      `UPDATE payroll_runs SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
        WHERE id = ANY($2::int[])`, [userId ?? null, runs.map(r => r.id)]);

    // outstanding_balance is PRINCIPAL: it falls by the installment's principal
    // part; the interest part is income of the loan, not a balance reduction.
    for (const { run, loan, amount, interest, principal, balance_after: after } of repayments) {
      const { rowCount } = await client.query(
        `INSERT INTO payroll_loan_repayments
           (loan_id, payroll_run_id, month, year, amount, balance_after, source, interest_component, principal_component, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,'payroll',$7,$8,$9)
         ON CONFLICT (loan_id, month, year) WHERE source = 'payroll' DO NOTHING`,
        [loan.id, run.id, p.month, p.year, amount, after, interest, principal, userId ?? null]);
      if (rowCount) {
        await client.query(
          `UPDATE payroll_loans SET outstanding_balance = $2, updated_at = NOW(),
                  status = CASE WHEN $2::numeric <= 0 THEN 'closed' ELSE status END,
                  closed_at = CASE WHEN $2::numeric <= 0 THEN NOW() ELSE closed_at END,
                  closure_type = CASE WHEN $2::numeric <= 0 THEN 'repaid' ELSE closure_type END
            WHERE id = $1`, [loan.id, after]);
      }
    }

    await client.query(`
      UPDATE payroll_arrears a SET status = 'paid', paid_run_id = pr.id, updated_at = NOW()
        FROM payroll_runs pr
       WHERE pr.id = ANY($1::int[]) AND a.employee_id = pr.employee_id
         AND a.status = 'approved' AND a.is_test = false
         AND a.paid_in_month = $2 AND a.paid_in_year = $3`, [runs.map(r => r.id), p.month, p.year]);

    // Accrual journal — IN this transaction (F-03, 04 Nov 26). It used to be
    // posted by the controller after COMMIT, best-effort: a refused or failed
    // journal left the period approved and its payslips released with no
    // expense or Salary Payable in the GL. Now a refusal (accounts missing,
    // unbalanced, locked or closed period, journal already present) rolls the
    // whole approval back — no status, loan, arrears or journal change — and is
    // returned as the reason. Amounts are the locked runs' own; the loan lines
    // come from the repayment rows written above (principal reduces the
    // receivable, interest is income). The reference is the batch's lowest run
    // id, the same one recoverPayrollJournals derives.
    const cent2 = (v) => Math.round(v * 100) / 100;
    const loanPrincipal = cent2(repayments.reduce((s, x) => s + x.principal, 0));
    const loanInterest = cent2(repayments.reduce((s, x) => s + x.interest, 0));
    const t = runs.reduce((a, r) => {
      for (const k of ['gross', 'net_pay', 'employer_pf', 'employer_esi', 'employee_pf', 'employee_esi', 'tds', 'professional_tax', 'lwf_employee', 'lwf_employer']) a[k] = (a[k] || 0) + num(r[k]);
      return a;
    }, {});
    const tag = `${p.year}-${String(p.month).padStart(2, '0')}`;
    let gl;
    try {
      gl = await postAccrualInTransaction(client, {
        payroll_run_id: `${tag}:${Math.min(...runs.map(r => r.id))}`, payroll_month: tag,
        gross_salary: t.gross, net_salary: t.net_pay, pf_employer: t.employer_pf, esi_employer: t.employer_esi,
        pf_employee: t.employee_pf, esi_employee: t.employee_esi, tds: t.tds, professional_tax: t.professional_tax,
        lwf_employee: t.lwf_employee, lwf_employer: t.lwf_employer, loan_principal: loanPrincipal, loan_interest: loanInterest,
        companyId: company_id, userId,
      });
    } catch (e) {
      if (e instanceof PayrollJournalError) {
        throw new PayrollHttpError(e.status === 409 ? 409 : 422,
          `Approval not completed — the payroll accrual journal could not be posted: ${e.message}. Nothing was approved; fix the cause and approve again.`,
          { code: 'ACCRUAL_JOURNAL_REFUSED', journal_code: e.code });
      }
      throw e;
    }

    await client.query('COMMIT');
    return {
      approvedRows: runs, approved_count: runs.length, loan_repayments: repayments.length,
      loan_principal: loanPrincipal, loan_interest: loanInterest,
      gl_posting: gl.posted
        ? { success: true, journal_entry: gl.journal_entry, summary: gl.summary }
        : { skipped: true, reason: gl.reason },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function findDefaultAccount(client, companyId, codes) {
  const { rows } = await client.query(
    `SELECT id FROM chart_of_accounts
      WHERE code = ANY($1) AND (company_id = $2 OR company_id IS NULL) AND is_active = true
      ORDER BY company_id DESC NULLS LAST LIMIT 1`, [codes, companyId ?? null]);
  return rows[0]?.id ?? null;
}

// ── Payment confirmation (PC-02a, PD-1 / PD-3) ─────────────────────────────
// A run is recorded as PAID only with bank evidence — a UTR / bank transaction
// reference and the value date — and in ONE transaction with everything the
// payment books: the status, the salary-clearing journal (Dr 2040 Salary
// Payable / Cr Bank, through journalRepo.postEntry and its posting guards) and
// the s.192 TDS ledger row. If any of them is refused (accounts missing, period
// locked or closed, reference already used) nothing is written and the run
// stays approved. It used to flip the status first and post the journal
// "best-effort" afterwards, so a run could read "paid" with Salary Payable never
// cleared, and with no reference at all.
//
// Paid is NOT reconciled: the UTR is evidence of a transfer; payroll_runs
// .reconciled_at is set only by bank reconciliation.
//
// Idempotent: the same run confirmed again with the same reference returns
// "already paid" and writes nothing; a different reference is refused.
const UTR_RE = /^[A-Z0-9][A-Z0-9/-]{5,34}$/;
export const PAYMENT_MODES = ['bank_transfer', 'neft', 'rtgs', 'imps', 'cheque'];

/** The reference in its stored form (trimmed, upper case), or null when it is not a usable UTR. */
export function normaliseUtr(v) {
  const s = String(v ?? '').trim().toUpperCase();
  return UTR_RE.test(s) ? s : null;
}

export async function markPaid(employeeId, { month, year, payment_mode = 'bank_transfer', reference, value_date, company_id, userId = null } = {}) {
  requireCompany(company_id);
  const p = period(month, year);
  const utr = normaliseUtr(reference);
  if (!utr) {
    throw new PayrollHttpError(400, 'A bank transaction reference (UTR) is required to record a payment: 6–35 letters or digits ("-" and "/" allowed).', { code: 'UTR_REQUIRED' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value_date ?? ''))) {
    throw new PayrollHttpError(400, 'The bank value date (YYYY-MM-DD) is required to record a payment.', { code: 'VALUE_DATE_REQUIRED' });
  }
  if (!PAYMENT_MODES.includes(payment_mode)) {
    throw new PayrollHttpError(400, `payment_mode must be one of: ${PAYMENT_MODES.join(', ')}`, { code: 'PAYMENT_MODE_INVALID' });
  }
  const mm = String(p.month).padStart(2, '0');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The row lock serialises two confirmations of the same run.
    const { rows: [run] } = await client.query(`
      SELECT pr.id, pr.status, pr.net_pay, pr.tds, pr.gross, pr.payment_reference, pr.approved_at,
             e.first_name, e.last_name, e.pan_number, e.account_number, e.ifsc_code
        FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
       WHERE pr.employee_id = $1 AND pr.month = $2 AND pr.year = $3 AND e.company_id = $4 AND pr.is_test = false
       FOR UPDATE OF pr`, [employeeId, p.month, p.year, company_id]);
    if (!run) throw new PayrollHttpError(404, 'No payroll record for this employee and period');
    if (run.status === 'paid') {
      if (String(run.payment_reference || '').toUpperCase() === utr) {
        await client.query('ROLLBACK');
        return { success: true, already_paid: true, run_id: run.id, reference: utr, message: 'Already recorded as paid with this reference — nothing changed' };
      }
      throw new PayrollHttpError(409, 'This payroll is already recorded as paid with a different bank reference. A wrong reference is corrected through Finance, not by paying again.', { code: 'ALREADY_PAID' });
    }
    if (run.status !== 'approved') {
      throw new PayrollHttpError(409, `Payroll is "${run.status}" — it must be approved before it can be paid`);
    }
    // Bank details are re-checked at payment: they may have been edited since
    // approval, and a payment to an invalid account cannot be recalled by HR.
    const bankIssues = validateStatutoryProfile(run, {}).filter(i => i.severity === 'error' && ['account_number', 'ifsc_code'].includes(i.field));
    if (bankIssues.length) {
      throw new PayrollHttpError(422, `Payment blocked: ${bankIssues.map(i => i.message).join('; ')}`, { issues: bankIssues });
    }
    const { rows: [d] } = await client.query(
      `SELECT ($1::date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS future,
              ($1::date < ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date) AS before_approval`, [value_date, run.approved_at]);
    if (d.future) throw new PayrollHttpError(400, 'The value date cannot be in the future', { code: 'VALUE_DATE_FUTURE' });
    if (d.before_approval) throw new PayrollHttpError(400, 'The value date cannot be before the payroll was approved', { code: 'VALUE_DATE_BEFORE_APPROVAL' });
    const { rows: used } = await client.query(
      `SELECT id FROM payroll_runs WHERE UPPER(payment_reference) = $1 AND id <> $2 LIMIT 1`, [utr, run.id]);
    if (used.length) throw new PayrollHttpError(409, 'This bank reference is already recorded against another payroll payment', { code: 'UTR_ALREADY_USED' });

    await client.query(
      `UPDATE payroll_runs
          SET status = 'paid', payment_mode = $2, payment_reference = $3, value_date = $4::date,
              paid_at = NOW(), paid_by = $5, updated_at = NOW()
        WHERE id = $1 AND status = 'approved'`, [run.id, payment_mode, utr, value_date, userId]);

    // Salary clearing: Dr 2040 Salary Payable (credited at approval) / Cr Bank.
    const netPay = num(run.net_pay);
    let journalEntryId = null;
    if (netPay > 0) {
      const salaryPayableId = await findDefaultAccount(client, company_id, ['2040']);
      const bankAccountId = await findDefaultAccount(client, company_id, ['1001']);
      if (!salaryPayableId || !bankAccountId) {
        throw new PayrollHttpError(422, 'Payment not recorded: the salary-clearing accounts (2040 Salary Payable, 1001 Bank) are not in the chart of accounts.', { code: 'CLEARING_ACCOUNTS_MISSING' });
      }
      const ref = `${employeeId}-${p.year}-${mm}`;
      const { rows: dup } = await client.query(
        `SELECT id FROM journal_entries WHERE company_id = $1 AND reference_type = 'salary_disbursement' AND reference_id = $2
            AND deleted_at IS NULL AND reversal_of_id IS NULL LIMIT 1`, [company_id, ref]);
      if (dup.length) {
        throw new PayrollHttpError(409, 'A salary-clearing journal already exists for this payment; nothing was changed.', { code: 'CLEARING_JOURNAL_EXISTS', journal_entry_id: dup[0].id });
      }
      try {
        const je = await journalRepo.createEntry(client, {
          entry_number: await journalRepo.getNextEntryNumber(client), entry_date: value_date, entry_type: 'Payment',
          reference_type: 'salary_disbursement', reference_id: ref,
          description: `Salary disbursed — employee ${employeeId}, ${p.year}-${mm}, UTR ${utr}`, created_by: userId, company_id,
        });
        await journalRepo.createLine(client, { journal_entry_id: je.id, account_id: salaryPayableId, description: 'Salary payable cleared', debit: netPay, credit: 0, company_id });
        await journalRepo.createLine(client, { journal_entry_id: je.id, account_id: bankAccountId, description: `Salary disbursed via ${payment_mode} (UTR ${utr})`, debit: 0, credit: netPay, company_id });
        await journalRepo.postEntry(client, je.id);
        journalEntryId = je.id;
      } catch (jeErr) {
        if (jeErr instanceof PayrollHttpError) throw jeErr;
        if (jeErr.code === '23505') throw new PayrollHttpError(409, 'A salary-clearing journal already exists for this payment; nothing was changed.', { code: 'CLEARING_JOURNAL_EXISTS' });
        throw new PayrollHttpError(422, `Payment not recorded: the salary-clearing journal could not be posted — ${jeErr.message}`, { code: 'CLEARING_JOURNAL_REFUSED' });
      }
    }

    // Section 192 TDS ledger row (deposit/challan recorded separately in Finance → TDS).
    const tdsAmount = num(run.tds);
    if (tdsAmount > 0) {
      const fy = indianFinancialYear(p.month, p.year);
      const { rows: [deductee] } = await client.query(
        `INSERT INTO tds_deductees (party_name, pan, deductee_type, section, threshold_limit, rate_with_pan, rate_without_pan, employee_id)
         VALUES ($1,$2,'individual','192',250000,0,20,$3)
         ON CONFLICT (employee_id) WHERE employee_id IS NOT NULL DO UPDATE SET party_name=EXCLUDED.party_name, pan=EXCLUDED.pan
         RETURNING id`,
        [`${run.first_name || ''} ${run.last_name || ''}`.trim(), run.pan_number || null, employeeId]);
      await client.query(
        `INSERT INTO tds_transactions (deductee_id, section, payment_date, payment_amount, tds_rate, tds_amount,
            surcharge, education_cess, total_tds, quarter, financial_year, employee_id, payroll_month, payroll_year, company_id)
         SELECT $1,'192',$2,$3,0,$4,0,0,$4,$5,$6,$7,$8,$9,$10
          WHERE NOT EXISTS (SELECT 1 FROM tds_transactions WHERE employee_id=$7 AND payroll_month=$8 AND payroll_year=$9 AND section='192')`,
        [deductee.id, p.end, num(run.gross), tdsAmount, quarterOfMonth(p.month), fy, employeeId, p.month, p.year, company_id]);
    }

    await client.query('COMMIT');
    return {
      success: true, run_id: run.id, reference: utr, value_date, amount: netPay, journal_entry_id: journalEntryId,
      reconciled: false, message: 'Payment recorded (bank reference captured; not yet reconciled with the bank statement)',
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505' && /payment_reference/.test(err.constraint || '')) {
      throw new PayrollHttpError(409, 'This bank reference is already recorded against another payroll payment', { code: 'UTR_ALREADY_USED' });
    }
    throw err;
  } finally {
    client.release();
  }
}


// ── Employee self-service ──────────────────────────────────────────────────

// ⚠ "My" payslips = the employee the LOGIN is linked to (token employee_id) —
// see 2026-10-12. Only FINALISED runs: an employee used to see a computed
// figure for every one of the last 12 months, including months never run.
export async function getMyPayslipList(_email, employeeId) {
  const id = parseInt(employeeId, 10);
  if (!Number.isInteger(id)) return [];
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS} FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
      WHERE pr.employee_id = $1 AND pr.status = ANY($2::text[]) AND pr.is_test = false
      ORDER BY pr.year DESC, pr.month DESC LIMIT 12`, [id, FINAL_STATUSES]);
  return rows.map(r => {
    const run = normalizeRun(r);
    return {
      month: run.month, year: run.year, period_label: run.period_label || `${getMonthName(run.month)} ${run.year}`,
      employee_id: run.employee_id, employee_code: run.employee_code, employee_name: run.name,
      department: run.department, designation: run.designation,
      net_pay: Math.round(run.net_pay), gross_pay: Math.round(run.gross), status: run.status, slip: run,
    };
  });
}

// ── Form 16 (annual) ───────────────────────────────────────────────────────

function fyBounds(financial_year) {
  const fy = parseFinancialYear(financial_year) || parseFinancialYear(indianFinancialYear());
  return { ...fy, start: `${fy.startYear}-04-01`, end: `${fy.endYear}-03-31` };
}

function expectedMonths(fy, joining, exit, today = new Date()) {
  const iso = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
  const t = today.toISOString().slice(0, 10);
  const from = [fy.start, iso(joining)].filter(Boolean).sort().pop();
  const to = [fy.end, iso(exit), t].filter(Boolean).sort()[0];
  const out = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  while (`${y}-${String(m).padStart(2, '0')}` <= to.slice(0, 7)) {
    out.push(y * 100 + m);
    m += 1; if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Lifecycle of each employee's Form 16 for a FY:
 *   in_progress   FY has not ended — no certificate can be final yet
 *   awaiting_data FY ended but months are unfinalised, PAN or TAN invalid
 *   ready         Part B can be generated (Part A still comes from TRACES)
 *   no_salary     no finalised salary in the FY
 */
export async function getForm16Status({ company_id, financial_year, employee_id = null, today = new Date() }) {
  requireCompany(company_id);
  const fy = fyBounds(financial_year);
  const params = [company_id, fy.startYear, fy.endYear, FINAL_STATUSES];
  let filter = '';
  if (employee_id != null) { params.push(parseInt(employee_id)); filter = ` AND e.id = $${params.length}`; }
  const { rows: emps } = await pool.query(`
    SELECT e.id, e.office_id, e.first_name, e.last_name, e.department, e.designation, e.pan_number,
           e.joining_date, e.exit_date,
           COALESCE(json_agg(json_build_object('month', pr.month, 'year', pr.year, 'status', pr.status))
                    FILTER (WHERE pr.id IS NOT NULL), '[]') AS runs
      FROM employees e
      LEFT JOIN payroll_runs pr ON pr.employee_id = e.id AND pr.is_test = false
           AND ((pr.year = $2 AND pr.month >= 4) OR (pr.year = $3 AND pr.month <= 3))
     WHERE e.company_id = $1 AND e.deleted_at IS NULL ${filter}
     GROUP BY e.id
    HAVING COUNT(pr.id) FILTER (WHERE pr.status = ANY($4::text[])) > 0 ${employee_id != null ? 'OR TRUE' : ''}
     ORDER BY e.first_name`, params);

  const fyEnded = today.toISOString().slice(0, 10) > fy.end;
  const { rows: [co] } = await pool.query(`SELECT tan FROM companies WHERE id = $1`, [company_id]);
  const tan = co?.tan || process.env.EMPLOYER_TAN || null;
  return {
    financial_year: fy.label, fy_end: fy.end, fy_ended: fyEnded,
    issue_due_by: `${fy.endYear}-06-15`,
    tan_configured: isValidTAN(tan),
    employees: emps.map(e => {
      const finals = new Set(e.runs.filter(r => FINAL_STATUSES.includes(r.status)).map(r => r.year * 100 + r.month));
      const expected = expectedMonths(fy, e.joining_date, e.exit_date, fyEnded ? new Date(`${fy.end}T12:00:00Z`) : today);
      const missing = expected.filter(k => !finals.has(k)).map(k => `${getMonthName(k % 100)} ${Math.floor(k / 100)}`);
      const blockers = [];
      // Tax years from 2026-27 are "Tax Year" and the certificate is Form No. 130 (§200).
      if (!fyEnded) blockers.push(fy.startYear >= 2026
        ? `Tax year ${fy.label} ends on ${fy.end}; Form No. 130 is issued after year end (due by ${fy.endYear}-06-15)`
        : `Financial year ${fy.label} ends on ${fy.end}; Form 16 is issued after year end (due by ${fy.endYear}-06-15)`);
      if (missing.length) blockers.push(`Payroll not finalised for: ${missing.join(', ')}`);
      if (!isValidPAN(e.pan_number)) blockers.push('Employee PAN missing or invalid');
      if (!isValidTAN(tan)) blockers.push('Employer TAN not configured (Company profile)');
      const status = finals.size === 0 ? 'no_salary' : !fyEnded ? 'in_progress' : blockers.length ? 'awaiting_data' : 'ready';
      return {
        employee_id: e.id, employee_code: e.office_id,
        name: `${e.first_name || ''} ${e.last_name || ''}`.trim(), department: e.department, designation: e.designation,
        months_finalised: finals.size, months_expected: expected.length,
        status, blockers, can_generate: status === 'ready',
      };
    }),
  };
}

export async function getForm16(employeeId, { company_id, financial_year } = {}) {
  requireCompany(company_id);
  const fy = fyBounds(financial_year);
  const status = await getForm16Status({ company_id, financial_year: fy.label, employee_id: employeeId });
  const st = status.employees[0];
  if (!st) return null;
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS} FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
      WHERE pr.employee_id = $1 AND e.company_id = $2 AND pr.is_test = false AND pr.status = ANY($3::text[])
        AND ((pr.year = $4 AND pr.month >= 4) OR (pr.year = $5 AND pr.month <= 3))
      ORDER BY pr.year, pr.month`, [parseInt(employeeId), company_id, FINAL_STATUSES, fy.startYear, fy.endYear]);
  const { rows: [emp] } = await pool.query(
    `SELECT id, office_id, first_name, last_name, pan_number FROM employees WHERE id = $1 AND company_id = $2`,
    [parseInt(employeeId), company_id]);
  // Finalised months ONLY. This used to fill every month without a run with a
  // freshly computed slip, so Form 16 reported a full year of salary for
  // employees who had been paid for two months.
  return {
    ...generateForm16Summary(emp, rows.map(normalizeRun), (await loadRules(pool, company_id, `${fy.endYear}-03-31`)).values),
    financial_year: fy.label,
    lifecycle: { status: st.status, blockers: st.blockers, can_generate: st.can_generate,
      months_finalised: st.months_finalised, months_expected: st.months_expected, fy_ended: status.fy_ended },
    monthly: rows.map(r => ({ month: r.month, year: r.year, gross: num(r.gross), tds: num(r.tds), employee_pf: num(r.employee_pf) })),
  };
}

export async function getCompliance({ month, year, company_id } = {}) {
  requireCompany(company_id);
  const p = period(month, year);
  const { rows: [r] } = await pool.query(`
    SELECT COUNT(DISTINCT pr.employee_id)::int AS total_employees,
           COALESCE(SUM(pr.employee_pf),0) emp_pf, COALESCE(SUM(pr.employer_pf),0) emr_pf,
           COALESCE(SUM(pr.employee_esi),0) emp_esi, COALESCE(SUM(pr.employer_esi),0) emr_esi,
           COALESCE(SUM(pr.professional_tax),0) pt, COALESCE(SUM(pr.tds),0) tds,
           COUNT(*) FILTER (WHERE pr.employee_esi > 0)::int AS esi_eligible
      FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
     WHERE pr.month = $1 AND pr.year = $2 AND e.company_id = $3 AND pr.is_test = false
       AND pr.status = ANY($4::text[])`, [p.month, p.year, company_id, FINAL_STATUSES]);
  return {
    period: p.label,
    finalised_only: true,
    total_employees: r.total_employees,
    esi_eligible: r.esi_eligible,
    pf_contribution: { employee: num(r.emp_pf), employer: num(r.emr_pf), total: num(r.emp_pf) + num(r.emr_pf) },
    esi_contribution: { employee: num(r.emp_esi), employer: num(r.emr_esi), total: num(r.emp_esi) + num(r.emr_esi) },
    professional_tax: num(r.pt),
    tds_deducted: num(r.tds),
    note: r.total_employees ? undefined : 'No approved payroll for this period',
  };
}

export async function getPayrollCycle({ company_id, month, year }) {
  requireCompany(company_id);
  const p = period(month, year);
  const { settings, conflicts } = await fetchPayrollSettings(company_id);
  const summary = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE pr.status='pending')::int pending, COUNT(*) FILTER (WHERE pr.status='approved')::int approved,
           COUNT(*) FILTER (WHERE pr.status='paid')::int paid, COUNT(*)::int total
      FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
     WHERE pr.month=$1 AND pr.year=$2 AND e.company_id=$3 AND pr.is_test=false`, [p.month, p.year, company_id]);
  const s = summary.rows[0];
  const runStatus = s.total === 0 ? null : s.paid === s.total ? 'paid' : s.pending === 0 ? 'approved' : 'pending';
  return { period: p.label, run_status: runStatus, ...payCycleFor(settings, p.month, p.year, { runStatus }),
    pay_day_of_month: settings.pay_day_of_month, payroll_cutoff_day: settings.payroll_cutoff_day,
    pay_in_following_month: settings.pay_in_following_month, settings_conflicts: conflicts };
}
