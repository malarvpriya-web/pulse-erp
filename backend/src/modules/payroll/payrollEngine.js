/**
 * payrollEngine.js — Indian payroll computation engine (pure: no DB access).
 *
 * Every statutory number comes from statutoryRules.js, resolved for the LAST
 * DAY of the wage period — the engine holds no rates of its own. Callers that
 * pass no `rules` get the built-in versions for that date.
 *
 * Invariants this file guarantees (each one was broken before 2026-10-20):
 *   1. No salary on record → PayrollInputError('NO_SALARY'). It used to fall
 *      back to `ctc_monthly * 0.4 || 50000` — a fabricated ₹50,000 basic — and,
 *      when basic was the string "0", paid ₹2,850 of fixed allowances to people
 *      with no salary at all (24 rows in the Sep-2026 run).
 *   2. No salary structure → PayrollInputError('NO_STRUCTURE'). The old
 *      "legacy fallback" invented HRA 40% / Special 15% / ₹1,600 / ₹1,250.
 *   3. Employer PF / ESI / LWF are EMPLOYER COST. They are returned under
 *      `employer_contributions` and are never part of `total_deductions` or
 *      net pay.
 *   4. LOP and mid-month joining/exit prorate EVERY earning, not just Basic.
 *   5. One-time earnings (bonus, arrears, overtime, night shift) are not
 *      multiplied by 12 when projecting annual income for TDS.
 *   6. Net pay below zero is an error, not Math.max(0, …).
 */
import { resolveRules } from './statutoryRules.js';

export class PayrollInputError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'PayrollInputError'; }
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const round = (v) => Math.round(v);

export function periodEndDate(month, year) {
  // Built from integers, never from a local-time Date + toISOString(): that
  // shifted every period one day back in IST (Sep 2026 was stored as
  // 31-Aug .. 29-Sep).
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}
export function periodStartDate(month, year) {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function normalizeState(state) {
  if (!state) return null;
  const s = String(state).trim().toUpperCase();
  const MAP = {
    'MAHARASHTRA': 'MH', 'MH': 'MH', 'KARNATAKA': 'KA', 'KA': 'KA',
    'TAMIL NADU': 'TN', 'TAMILNADU': 'TN', 'TN': 'TN', 'TELANGANA': 'TS', 'TS': 'TS',
    'ANDHRA PRADESH': 'AP', 'AP': 'AP', 'KERALA': 'KL', 'KL': 'KL',
    'GUJARAT': 'GJ', 'GJ': 'GJ', 'WEST BENGAL': 'WB', 'WB': 'WB',
  };
  return MAP[s] ?? null;
}

function slabTax(income, slabs) {
  let tax = 0;
  for (const s of slabs) {
    const max = s.max == null ? Infinity : s.max;
    if (income <= s.min) break;
    tax += (Math.min(income, max) - s.min) * s.rate;
  }
  return tax;
}

/**
 * Annual income tax incl. 87A rebate (+ marginal relief in the new regime) and
 * 4% cess. `taxRule` is a resolved 'tax.new' / 'tax.old' value.
 */
export function computeIncomeTax(annualTaxableIncome, regime = 'new', taxRule = null) {
  const rule = taxRule || resolveRules(new Date()).values[regime === 'old' ? 'tax.old' : 'tax.new'];
  const income = Math.max(0, num(annualTaxableIncome));
  let tax = slabTax(income, rule.slabs);
  if (income <= rule.rebate_limit) {
    tax = Math.max(0, tax - rule.rebate_max);
  } else if (rule.marginal_relief) {
    // Finance Act 2025: tax above the rebate limit may not exceed the income
    // above it — ₹12,10,000 pays ₹10,000, not ₹61,500.
    tax = Math.min(tax, income - rule.rebate_limit);
  }
  return round(tax * (1 + rule.cess_pct / 100));
}

/**
 * Professional tax for one month.
 *   Monthly states: slabs = [{ min, max, pt, month_pt? }] on the month's gross.
 *   Half-yearly states (Tamil Nadu): { basis: 'half_year', deduct_months, slabs }
 *     — slabs on HALF-YEAR income (6 × the full-month regular gross), the whole
 *     half-year's tax deducted in one pay bill (TN ULB Rules 2023 r.277(2):
 *     August and January), and only from a person engaged on the FIRST DAY of
 *     the half-year (1 April / 1 October).
 * @param opts { fullMonth, joiningDate, year } — half-yearly states only
 */
export function computePT(monthlySalary, state, ptSlabs = null, month = null, opts = {}) {
  const slabsByState = ptSlabs || resolveRules(new Date()).values['pt.slabs'];
  const code = normalizeState(state);
  const entry = code && slabsByState[code];
  if (!entry) return 0;
  if (!Array.isArray(entry)) {
    if (entry.basis !== 'half_year' || !entry.deduct_months?.includes(month)) return 0;
    if (opts.joiningDate && opts.year) {
      const hy = month >= 4 && month <= 9 ? `${opts.year}-04-01` : (month >= 10 ? `${opts.year}-10-01` : `${opts.year - 1}-10-01`);
      if (String(opts.joiningDate).slice(0, 10) > hy) return 0;
    }
    const halfYear = (opts.fullMonth ?? monthlySalary) * 6;
    const hit = entry.slabs.find(s => halfYear >= s.min && halfYear <= (s.max == null ? Infinity : s.max));
    return hit ? hit.pt : entry.slabs[entry.slabs.length - 1].pt;
  }
  const slabs = entry;
  for (const s of slabs) {
    const max = s.max == null ? Infinity : s.max;
    if (monthlySalary >= s.min && monthlySalary <= max) return s.month_pt?.[month] ?? s.pt;
  }
  const last = slabs[slabs.length - 1];
  return last.month_pt?.[month] ?? last.pt;
}

export function computeLWF(state, month, lwfRates = null) {
  const rates = lwfRates || resolveRules(new Date()).values['lwf.rates'];
  const code = normalizeState(state);
  const r = code && rates[code];
  if (!r || (r.months.length > 0 && !r.months.includes(month))) return { lwf_employee: 0, lwf_employer: 0 };
  return { lwf_employee: r.employee, lwf_employer: r.employer };
}

/**
 * FULL-MONTH earnings from a salary structure. Basic is the employee's figure;
 * when Basic is defined as a % of CTC, CTC is derived from it (40% → basic/0.4)
 * and the balancing component tops earnings up to that CTC.
 *
 * NOTE: "CTC" in a structure is the monthly GROSS target. Employer PF/ESI are
 * added on top in ctc_monthly. That is how the engine has always behaved; whether
 * the business means CTC to include employer PF is recorded as a business
 * decision in PAYROLL_DATA_FLOW_AUDIT.md.
 */
export function computeEarningsFromComponents(components, basicMonthly) {
  const basicComp = components.find(c => c.name === 'Basic' && c.type === 'earning');
  const basicRatio = basicComp?.calculation_type === 'percentage_of_ctc' ? num(basicComp.value) / 100 : null;
  const ctc = basicRatio > 0 ? basicMonthly / basicRatio : null;

  const lines = [];
  let running = 0;
  for (const c of components) {
    if (c.type !== 'earning') continue;
    let amount = 0;
    if (c.name === 'Basic') amount = basicMonthly;
    else if (c.calculation_type === 'fixed') amount = num(c.value);
    else if (c.calculation_type === 'percentage_of_basic') amount = basicMonthly * num(c.value) / 100;
    else if (c.calculation_type === 'percentage_of_ctc') amount = ctc ? ctc * num(c.value) / 100 : 0;
    else if (c.calculation_type === 'percentage_of_gross') amount = running * num(c.value) / 100;
    if (c.calculation_type !== 'balancing') running += amount;
    lines.push({ name: c.name, calculation_type: c.calculation_type, amount, is_taxable: c.is_taxable !== false });
  }
  for (const l of lines) {
    if (l.calculation_type === 'balancing') {
      l.amount = ctc ? Math.max(0, ctc - running) : 0;
      running += l.amount;
    }
  }
  return { lines, gross: running };
}

// Which payroll-settings toggle governs a structure component (by name).
const TOGGLE_FOR = {
  'HRA': 'enable_hra',
  'Conveyance': 'enable_conveyance', 'Conveyance Allowance': 'enable_conveyance',
  'Medical': 'enable_medical_allowance', 'Medical Allowance': 'enable_medical_allowance',
  'Special Allowance': 'enable_special_allowance',
};
const LINE_KEY = {
  'Basic': 'basic', 'HRA': 'hra',
  'Conveyance': 'conveyance_allowance', 'Conveyance Allowance': 'conveyance_allowance',
  'Medical': 'medical_allowance', 'Medical Allowance': 'medical_allowance',
  'Special Allowance': 'special_allowance',
};

function ageOn(dob, isoDate) {
  if (!dob) return null;
  const d = new Date(dob); const t = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return null;
  let age = t.getUTCFullYear() - d.getUTCFullYear();
  const m = t.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && t.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

/** Calendar-day proration for a mid-month joiner / leaver. */
export function prorationFor(month, year, joiningDate, exitDate) {
  const start = periodStartDate(month, year), end = periodEndDate(month, year);
  const daysInMonth = Number(end.slice(8, 10));
  const iso = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
  const from = [start, iso(joiningDate)].filter(Boolean).sort().pop();
  const to = [end, iso(exitDate)].filter(Boolean).sort()[0];
  if (from > to) return { paid_days: 0, days_in_month: daysInMonth, factor: 0 };
  const paid = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  return { paid_days: paid, days_in_month: daysInMonth, factor: paid / daysInMonth };
}

/**
 * Compute one employee's payroll for one month.
 *
 * @param {Object} emp     basic_salary (monthly, from the salary revision in
 *                         force), joining_date, exit_date, dob, state/work_state
 * @param {Object} config  month, year, structureComponents, settings toggles,
 *                         rules (resolved values), lop_days, overtime_hours,
 *                         ot_multiplier, night_shift_days, bonus,
 *                         arrears {amount, employee_pf, employer_pf},
 *                         recoveries [{type, id, amount}],
 *                         ytd {gross, tds}  (FINALISED months of this FY before
 *                         this one), months_remaining (incl. this month)
 */
export function computePayroll(emp, config = {}) {
  const {
    month = new Date().getMonth() + 1,
    year = new Date().getFullYear(),
    lop_days = 0,
    overtime_hours = 0,
    ot_multiplier = 1.5,
    bonus = 0,
    night_shift_days = 0,
    night_shift_rate = 200,
    arrears = null,
    recoveries = [],
    ytd = null,
    months_remaining = null,
    deduction_80d = 0,
    deduction_nps_80ccd = 0,
    lta_claimed = 0,
    state: configState,
    working_days = 26,
    regime = 'new',
    pf_enabled = true,
    esi_enabled = true,
    professional_tax: pt_enabled = true,
    tds_auto_calculate = true,
    pf_restrict_to_ceiling = true,
    round_net_pay = 1,
    structureComponents,
  } = config;
  const togglesOn = (name) => config[TOGGLE_FOR[name]] !== false;

  const pEnd = periodEndDate(month, year);
  const rules = config.rules || resolveRules(pEnd).values;
  const state = configState || emp.state || emp.work_state || null;

  // ── Inputs that must exist ────────────────────────────────────────────────
  const basicMonthly = num(emp.basic_salary);
  if (!(basicMonthly > 0)) {
    throw new PayrollInputError('NO_SALARY', 'No salary revision in force for this period (basic salary is missing or zero)');
  }
  // An approved CTC revision carries the HR-approved monthly component amounts
  // (employee_salary_assignments.breakdown, written by ctcService). Payroll pays
  // those amounts; it never recomputes them from the structure, so a structure
  // edit cannot silently change an approved salary.
  const approvedComponents = Array.isArray(emp.breakdown?.monthly?.components) && emp.breakdown.monthly.components.length
    ? emp.breakdown.monthly.components : null;
  if (!approvedComponents && (!Array.isArray(structureComponents) || !structureComponents.length)) {
    throw new PayrollInputError('NO_STRUCTURE', 'No salary structure assigned and no default structure exists');
  }
  const wd = num(working_days) || 26;
  const lop = Math.min(Math.max(0, num(lop_days)), wd);
  const otMult = num(ot_multiplier) || 1.5;
  if (num(overtime_hours) > 0 && (otMult < 1 || otMult > rules['ot.max_multiplier'])) {
    throw new PayrollInputError('OT_MULTIPLIER',
      `Overtime multiplier ${otMult} is outside the allowed range 1–${rules['ot.max_multiplier']} — correct the OT record`);
  }

  // ── Earnings ─────────────────────────────────────────────────────────────
  const proration = prorationFor(month, year, emp.joining_date, emp.exit_date);
  const lopFactor = 1 - lop / wd;
  const payFactor = proration.factor * lopFactor;

  const { lines } = approvedComponents
    ? { lines: approvedComponents.map(c => ({ name: c.name, calculation_type: 'approved', amount: num(c.amount) })) }
    : computeEarningsFromComponents(structureComponents, basicMonthly);
  const earnings = {};
  const earningLines = [];
  let fullMonthRegular = 0;
  let regularGross = 0;
  for (const l of lines) {
    if (!approvedComponents && l.name !== 'Basic' && TOGGLE_FOR[l.name] && !togglesOn(l.name)) continue;
    const amount = round(l.amount * payFactor);
    fullMonthRegular += l.amount;
    regularGross += amount;
    const key = LINE_KEY[l.name];
    if (key) earnings[key] = (earnings[key] || 0) + amount;
    earningLines.push({ name: l.name, full_month: round(l.amount), amount });
  }
  const basic = earnings.basic || 0;

  const overtimePay = round((basicMonthly / (wd * 8)) * num(overtime_hours) * otMult);
  const nightShiftAllowance = round(num(night_shift_days) * (num(night_shift_rate) || 200));
  const bonusAmt = round(num(bonus));
  const arrearAmt = round(num(arrears?.amount));
  const oneTime = overtimePay + nightShiftAllowance + bonusAmt + arrearAmt;
  const gross = regularGross + oneTime;

  // ── Provident Fund ───────────────────────────────────────────────────────
  // Wages = Basic (+DA, none modelled). CoSS s.2(88) first proviso: if the
  // excluded payments exceed (100 − floor)% of all remuneration, the excess is
  // deemed wages. WHAT "all remuneration" contains is rule 'pf.wage_floor_basis':
  //   gross_excl_employer_contributions        regular pay + OT + night shift
  //                                            (the engine's original basis)
  //   include_employer_pf_and_statutory_bonus  + employer PF/pension contribution
  //                                            + bonus (MoLE FAQ 16-Mar-2026)
  // Arrears are outside the monthly test either way. Under the second basis the
  // employer contribution depends on the wage it helps determine, so the wage
  // is found by fixed-point iteration (it converges: each pass moves the wage
  // by ≤ 6% of the previous change).
  const ceiling = rules['pf.wage_ceiling'];
  const floorPct = rules['pf.wage_floor_pct'];
  const floorBasis = rules['pf.wage_floor_basis'] || 'gross_excl_employer_contributions';
  const contribWageOf = (w) => (pf_restrict_to_ceiling ? Math.min(w, ceiling) : w);
  const codeWage = (basicPart, remunerationPart, includeEmployerPf) => {
    let w = basicPart;
    if (floorPct == null || remunerationPart <= 0) return w;
    for (let i = 0; i < 8; i++) {
      const erPf = includeEmployerPf && pf_enabled ? contribWageOf(w) * rules['pf.employer_rate'] / 100 : 0;
      const next = Math.max(basicPart, (remunerationPart + erPf) * floorPct / 100);
      if (Math.abs(next - w) < 0.005) { w = next; break; }
      w = next;
    }
    return w;
  };
  const includeErPf = floorBasis === 'include_employer_pf_and_statutory_bonus';
  const remuneration = regularGross + overtimePay + nightShiftAllowance + (includeErPf ? bonusAmt : 0);
  const pfWage = round(codeWage(basic, remuneration, includeErPf));
  const pfContribWage = contribWageOf(pfWage);
  const age = ageOn(emp.dob ?? emp.date_of_birth, pEnd);
  const epsEligible = age == null || age < rules['pf.eps_age_limit'];
  const employeePF = pf_enabled ? round(pfContribWage * rules['pf.employee_rate'] / 100) : 0;
  const employerPFTotal = pf_enabled ? round(pfContribWage * rules['pf.employer_rate'] / 100) : 0;
  const eps = pf_enabled && epsEligible ? round(Math.min(pfWage, ceiling) * rules['pf.eps_rate'] / 100) : 0;
  const epfEmployer = employerPFTotal - eps;
  const arrearPfEmployee = pf_enabled ? round(num(arrears?.employee_pf)) : 0;
  const arrearPfEmployer = pf_enabled ? round(num(arrears?.employer_pf)) : 0;

  // ── ESI: coverage is decided on the monthly wage RATE (full month, before
  // LOP/proration); contribution is on wages actually earned. BOTH shares are
  // rounded UP to the next rupee — Social Security (Central) Rules 2026 r.19(1)
  // (G.S.R. 344(E), 8-May-2026): "a sum (rounded to the next higher rupee)" for
  // the employer's 3¼% and the employee's ¾%. The employer share used to be
  // rounded to the nearest rupee. Paise first, so float noise (650.0000001)
  // cannot add a rupee. Which wage, is rule 'esi.wage_basis':
  //   gross       gross pay excluding bonus (the engine's original basis)
  //   code_wages  CoSS s.2(88) wages — MoLE FAQ 16-Mar-2026 Q12
  const esiBasis = rules['esi.wage_basis'] || 'gross';
  const fullMonthBasic = basicMonthly;
  const esiCoverageWage = esiBasis === 'code_wages'
    ? codeWage(fullMonthBasic, fullMonthRegular, includeErPf)
    : fullMonthRegular;
  const esiApplicable = esi_enabled && esiCoverageWage <= rules['esi.wage_threshold'];
  const esiWage = esiBasis === 'code_wages' ? pfWage : gross - bonusAmt;
  const upToRupee = (v) => Math.ceil(Math.round(v * 100) / 100);
  const employeeESI = esiApplicable ? upToRupee(esiWage * rules['esi.employee_rate'] / 100) : 0;
  const employerESI = esiApplicable ? upToRupee(esiWage * rules['esi.employer_rate'] / 100) : 0;

  const professionalTax = pt_enabled
    ? computePT(gross, state, rules['pt.slabs'], month, { fullMonth: fullMonthRegular, joiningDate: emp.joining_date, year })
    : 0;
  const { lwf_employee, lwf_employer } = computeLWF(state, month, rules['lwf.rates']);

  // ── TDS (s.192): estimate of the year's salary income ────────────────────
  // = finalised earlier months + this month's regular pay for each remaining
  //   month + this month's one-time pay (once). Tax still due is spread over
  //   the remaining months; tax caused by one-time pay is deducted now.
  const taxRule = rules[regime === 'old' ? 'tax.old' : 'tax.new'];
  const remaining = Math.max(1, num(months_remaining) || 12);
  const ytdGross = num(ytd?.gross);
  const ytdTds = num(ytd?.tds);
  const projectedRegular = ytdGross + regularGross * remaining;
  const projectedAnnual = projectedRegular + oneTime;

  let otherDeductions = 0;
  if (regime === 'old') {
    const pf80C = Math.min(employeePF * remaining + num(ytd?.employee_pf), 150000);
    const d80D = Math.min(num(deduction_80d), 25000);
    const dNPS = Math.min(num(deduction_nps_80ccd), 50000);
    // the twelve months the state actually levies (KA: 11 × 200 + February 300), capped at
    // the Constitution art.276(2) maximum of 2,500
    const ptAnnual = pt_enabled
      ? Math.min([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].reduce((t, m) => t + computePT(gross, state, rules['pt.slabs'], m), 0), 2500)
      : 0;
    // LTA (s.10(5)): the exemption cannot exceed the travel concession the
    // employer pays — the structure's LTA component for the year. It used to be
    // capped at 2 × this month's HRA, which mixed the house-rent component into
    // an unrelated exemption (and allowed an LTA exemption with no LTA paid).
    // HRA exemption (s.10(13A)) is NOT computed: it needs rent paid and the
    // metro / non-metro city, which Pulse does not capture —
    // PAYROLL_DATA_FLOW_AUDIT.md Part 11, item 5.
    const ltaAnnual = earningLines.filter(l => /^(lta|leave travel)/i.test(l.name)).reduce((t, l) => t + l.full_month, 0) * 12;
    otherDeductions = pf80C + d80D + dNPS + ptAnnual + Math.min(num(lta_claimed), ltaAnnual);
  }
  const taxableOf = (income) => Math.max(0, income - taxRule.standard_deduction - otherDeductions);
  const annualTaxable = taxableOf(projectedAnnual);
  const annualTax = tds_auto_calculate ? computeIncomeTax(annualTaxable, regime, taxRule) : 0;
  const taxWithoutOneTime = tds_auto_calculate ? computeIncomeTax(taxableOf(projectedRegular), regime, taxRule) : 0;
  const tdsRegular = Math.max(0, round((taxWithoutOneTime - ytdTds) / remaining));
  const tdsOneTime = Math.max(0, annualTax - taxWithoutOneTime);
  const monthlyTDS = tds_auto_calculate ? tdsRegular + tdsOneTime : 0;

  // ── Recoveries (loan EMI / advance) ──────────────────────────────────────
  const loanDeduction = round(recoveries.filter(r => r.type === 'loan').reduce((s, r) => s + num(r.amount), 0));
  const advanceDeduction = round(recoveries.filter(r => r.type === 'advance').reduce((s, r) => s + num(r.amount), 0));

  // ── Net pay: EMPLOYEE deductions only ────────────────────────────────────
  const statutoryDeductions = employeePF + arrearPfEmployee + employeeESI + professionalTax + monthlyTDS + lwf_employee;
  const totalDeductions = statutoryDeductions + loanDeduction + advanceDeduction;
  const rawNet = gross - totalDeductions;
  if (rawNet < 0) {
    throw new PayrollInputError('NEGATIVE_NET',
      `Deductions (₹${totalDeductions}) exceed gross pay (₹${gross}) — check loan EMI / advance recovery`);
  }
  const roundTo = Math.max(1, parseInt(round_net_pay) || 1);
  const netPay = Math.round(rawNet / roundTo) * roundTo;

  const employerPF = employerPFTotal + arrearPfEmployer;
  const employerContributions = {
    pf_total: employerPF, eps, epf: epfEmployer + arrearPfEmployer,
    esi: employerESI, lwf: lwf_employer,
    total: employerPF + employerESI + lwf_employer,
  };

  // Gratuity PAYABLE if the employee left now (15/26 × monthly Basic × completed
  // years, ≥ 5 years). It is an accrued liability, not a monthly cost, and is
  // NOT part of any CTC figure here — whether CTC includes a gratuity accrual is
  // a company policy (PAYROLL_DATA_FLOW_AUDIT.md Part 3). Was mislabelled
  // gratuity_provision.
  const yearsOfService = num(emp.years_of_service);
  const gratuity = yearsOfService >= 5 ? round((basicMonthly * 15 / 26) * yearsOfService) : 0;
  // EMPLOYER COST OF THIS PAYROLL MONTH: gross actually earned this month
  // (after LOP/proration, including one-time pay) + employer PF/ESI/LWF.
  // Stored as payroll_runs.ctc_monthly and posted to the GL as the same total.
  // It is NOT a contractual CTC: a month with a bonus, arrears or the annual
  // LWF levy costs more than a normal month.
  const ctcMonthly = gross + employerContributions.total;

  return {
    employee_id: emp.id || emp.employee_id,
    employee_code: emp.office_id || emp.employee_code || null,
    name: emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
    department: emp.department,
    designation: emp.designation || emp.role,
    month, year,
    payroll_period: `${getMonthName(month)} ${year}`,
    working_days: wd,
    lop_days: lop,
    paid_days: proration.paid_days,
    days_in_month: proration.days_in_month,

    // Earnings
    basic,
    hra: earnings.hra || 0,
    conveyance_allowance: earnings.conveyance_allowance || 0,
    medical_allowance: earnings.medical_allowance || 0,
    special_allowance: earnings.special_allowance || 0,
    earning_lines: earningLines,
    salary_source: approvedComponents ? 'approved_breakdown' : 'structure',
    overtime_pay: overtimePay,
    night_shift_allowance: nightShiftAllowance,
    bonus: bonusAmt,
    arrears: arrearAmt,
    gross,

    // Employee deductions (these, and only these, reduce net pay)
    employee_pf: employeePF + arrearPfEmployee,
    employee_esi: employeeESI,
    professional_tax: professionalTax,
    lwf_employee,
    tds: monthlyTDS,
    loan_deduction: loanDeduction,
    advance_deduction: advanceDeduction,
    total_deductions: totalDeductions,
    net_pay: netPay,

    // Employer cost — NOT deducted from the employee
    employer_contributions: employerContributions,
    employer_pf: employerPF,
    eps,
    epf_employer: epfEmployer + arrearPfEmployer,
    employer_esi: employerESI,
    lwf_employer,

    // Statutory working
    pf_wage: pfWage,
    pf_wage_basis: floorBasis,
    esi_wage_basis: esiBasis,
    pf_contribution_wage: pfContribWage,
    eps_wage: pf_enabled && epsEligible ? Math.min(pfWage, ceiling) : 0,
    annual_taxable_income: round(annualTaxable),
    annual_tax: annualTax,
    tax_regime: regime,
    esi_applicable: esiApplicable,
    pf_applicable: !!pf_enabled,

    // ctc_monthly = employer cost of THIS month (see above). There is no
    // ctc_annual: it was this month × 12, which annualised bonuses, arrears,
    // overtime, LOP and a once-a-year LWF levy. A contractual annual CTC needs
    // the company's CTC definition — not implemented until that is decided.
    ctc_monthly: round(ctcMonthly),
    employer_cost_month: round(ctcMonthly),
    gratuity_payable_if_exit_now: gratuity,

    status: 'pending',
    generated_at: new Date().toISOString(),
  };
}

export function getMonthName(month) {
  return ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'][month];
}

export function computeBulkPayroll(employees, config = {}) {
  return employees.map(emp => {
    try { return { ...computePayroll(emp, config), error: null }; }
    catch (err) { return { employee_id: emp.id, error: err.message, error_code: err.code || null }; }
  });
}

/** Indian FY label for a payroll month: Apr..Mar. */
export function indianFinancialYear(month, year) {
  const m = parseInt(month), y = parseInt(year);
  if (!m || !y) { const d = new Date(); return indianFinancialYear(d.getMonth() + 1, d.getFullYear()); }
  return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** Statutory quarter of a payroll month: Q1 Apr–Jun … Q4 Jan–Mar. */
export function quarterOfMonth(month) {
  const m = parseInt(month);
  if (m >= 4 && m <= 6) return 'Q1';
  if (m >= 7 && m <= 9) return 'Q2';
  if (m >= 10 && m <= 12) return 'Q3';
  return 'Q4';
}

/** Months from `month` to March inclusive (the s.192 "remaining months"). */
export function monthsRemainingInFY(month) {
  const m = parseInt(month);
  return m >= 4 ? 12 - (m - 4) : 4 - m;
}

/**
 * Accepts '2026-2027', '2026-27' or '2026'; returns { startYear, endYear, label }.
 * '2026-27' used to parse its end year as 27, so Q4 (Jan–Mar) read year 27.
 */
export function parseFinancialYear(fy) {
  const [a, b] = String(fy || '').split('-');
  const start = parseInt(a);
  if (!start) return null;
  let end = parseInt(b);
  if (!end || end < 100) end = start + 1;
  if (end !== start + 1) return null;
  return { startYear: start, endYear: end, label: `${start}-${end}` };
}

/**
 * Form 16 Part B summary from FINALISED monthly runs only. `rules` = resolved
 * statutory values for the FY (its last day); the standard deduction comes from
 * the regime's tax rule, not a literal.
 */
export function generateForm16Summary(emp, payrollRecords, rules = null) {
  const sum = (k) => payrollRecords.reduce((s, r) => s + num(r[k]), 0);
  const last = payrollRecords[payrollRecords.length - 1];
  return {
    employee_name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.name,
    employee_pan: emp.pan_number || null,
    employee_code: emp.office_id || null,
    financial_year: last ? indianFinancialYear(last.month, last.year) : null,
    months_included: payrollRecords.length,
    gross_salary: sum('gross'),
    standard_deduction: (rules || resolveRules(last ? periodEndDate(last.month, last.year) : new Date()).values)[last?.tax_regime === 'old' ? 'tax.old' : 'tax.new'].standard_deduction,
    pf_deduction: sum('employee_pf'),
    professional_tax: sum('professional_tax'),
    taxable_income: num(last?.annual_taxable_income),
    tax_payable: num(last?.annual_tax),
    tds_deducted: sum('tds'),
    tax_regime: last?.tax_regime || 'new',
  };
}
