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
/**
 * The year's tax, item by item (Finance Act 2026, First Schedule Part III):
 *   slabs     Paragraph A — for the old regime, the age bands of items (II) and
 *             (III) (60–79: nil to ₹3,00,000; 80+: nil to ₹5,00,000) when the rule
 *             carries `age_slabs` and the employee's age is known
 *   rebate    s.156 (with marginal relief above the new-regime limit)
 *   surcharge Paragraph F Table 1 — rate by total income (`surcharge` bands),
 *             with the marginal relief of Table 2: tax + surcharge may not exceed
 *             the tax + surcharge at the band's start plus the income above it
 *   cess      4% of tax + surcharge
 * @param opts { age }  age at any time in the tax year (its last day)
 */
export function computeIncomeTaxDetail(annualTaxableIncome, regime = 'new', taxRule = null, opts = {}) {
  const rule = taxRule || resolveRules(new Date()).values[regime === 'old' ? 'tax.old' : 'tax.new'];
  const income = Math.max(0, num(annualTaxableIncome));
  const age = opts.age;
  const band = regime === 'old' && age != null && Array.isArray(rule.age_slabs)
    ? [...rule.age_slabs].sort((a, b) => b.min_age - a.min_age).find(b => age >= b.min_age) : null;
  const slabs = band ? band.slabs : rule.slabs;
  const baseTax = (x) => {
    let t = slabTax(x, slabs);
    if (x <= rule.rebate_limit) t = Math.max(0, t - rule.rebate_max);
    else if (rule.marginal_relief) t = Math.min(t, x - rule.rebate_limit);
    return t;
  };
  const tax = baseTax(income);
  const bands = Array.isArray(rule.surcharge) ? [...rule.surcharge].sort((a, b) => a.min - b.min) : [];
  const rateAt = (x) => bands.filter(b => x > b.min).reduce((r, b) => b.rate, 0);
  const withSurcharge = (x) => baseTax(x) * (1 + rateAt(x) / 100);
  let total = withSurcharge(income);
  const start = bands.filter(b => income > b.min).pop();
  if (start) total = Math.min(total, withSurcharge(start.min) + (income - start.min));
  const surcharge = Math.max(0, total - tax);
  const cess = (tax + surcharge) * rule.cess_pct / 100;
  return { tax: round(tax), surcharge: round(surcharge), cess: round(cess), total: round(tax + surcharge + cess),
    slabs_used: band ? `age ${band.min_age}+` : 'standard' };
}

export function computeIncomeTax(annualTaxableIncome, regime = 'new', taxRule = null, opts = {}) {
  return computeIncomeTaxDetail(annualTaxableIncome, regime, taxRule, opts).total;
}

/**
 * A loan at less than the benchmark rate is a taxable perquisite (Income-tax
 * Rules 2026, rule 15 Table IV): interest at the benchmark (SBI) rate for that
 * kind of loan on the month's highest balance, less the interest the employee
 * pays. Nothing when the employee's loans together do not exceed the limit, and
 * nothing on a medical loan. It is taxed, never paid.
 * @param loans  [{ balance, interest_rate, loan_type, purpose }]
 * @param rule   { exempt_limit, sbi_rates: { loan, advance } }
 * @returns { monthly, unpriced } — unpriced: a benchmark rate is missing
 */
export function loanPerquisite(loans = [], rule = null) {
  const list = (loans || []).filter(l => num(l.balance) > 0 && l.purpose !== 'medical');
  if (!rule || !list.length) return { monthly: 0, unpriced: false };
  const total = list.reduce((s, l) => s + num(l.balance), 0);
  if (total <= num(rule.exempt_limit)) return { monthly: 0, unpriced: false };
  let monthly = 0, unpriced = false;
  for (const l of list) {
    const sbi = rule.sbi_rates?.[l.loan_type === 'advance' ? 'advance' : 'loan'];
    if (sbi == null) { unpriced = true; continue; }
    monthly += num(l.balance) * Math.max(0, num(sbi) - num(l.interest_rate)) / 100 / 12;
  }
  return { monthly: round(monthly), unpriced };
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
 *                         ot_multiplier, night_shift_days, night_shift_rate, bonus,
 *                         adjustments [{id, kind earning|deduction, label, amount, account_code}],
 *                         arrears {amount, employee_pf, employer_pf},
 *                         recoveries [{type, id, amount}],
 *                         ytd {gross, tds, employee_pf, months}  (opening balance
 *                         + FINALISED months of this FY before this one),
 *                         months_remaining (incl. this month),
 *                         prior_revision {effective_from, basic_salary, breakdown,
 *                         structureComponents} when a revision takes effect inside
 *                         the month, esi_period_covered, deduction_80c,
 *                         rent_paid_annual, hra_metro_city
 */
/**
 * What a company's bonus plans pay in a month. Percentages are of the month's earned
 * Basic or regular gross, so a month with loss of pay pays a smaller bonus.
 */
/** Whole months from a joining date to a period end (YYYY-MM-DD), or null when unknown. */
export function completedMonths(joining, end) {
  if (!joining || !end) return null;
  const parts = (d) => String(d instanceof Date ? d.toISOString() : d).slice(0, 10).split('-').map(Number);
  const j = parts(joining), e = parts(end);
  if (j.some(x => !Number.isFinite(x)) || e.some(x => !Number.isFinite(x))) return null;
  let m = (e[0] - j[0]) * 12 + (e[1] - j[1]);
  if (e[2] < j[2]) m -= 1;
  return Math.max(0, m);
}

export function planBonus(plans, month, { basic = 0, gross = 0, serviceMonths = null } = {}) {
  // min_service_months: a plan can require some service. An unknown joining date
  // (serviceMonths null) does not block it.
  const served = (p) => !(num(p.min_service_months) > 0) || serviceMonths == null || serviceMonths >= num(p.min_service_months);
  return (plans || []).filter(p => p.active && p.months.includes(month) && served(p)).reduce((sum, p) => {
    if (p.type === 'fixed') return sum + round(num(p.amount));
    return sum + round((p.type === 'pct_basic' ? basic : gross) * num(p.amount) / 100);
  }, 0);
}

/**
 * What an employee's declarations take off taxable salary under the OLD regime
 * (the new regime allows none of these against salary). One function for the
 * monthly TDS and the Form 138 annual figures (§262).
 *   80C              employee PF + declared 80C, together at most ₹1,50,000
 *   own NPS          declared '80CCD': the first ₹50,000 is the extra NPS deduction
 *                    (formerly 80CCD(1B)); the rest counts inside the ₹1,50,000 above,
 *                    up to 10% of Basic (formerly 80CCD(1))
 *   80D              health insurance: self / spouse / children at most ₹25,000, and
 *                    parents a further ₹25,000 — each ₹50,000 when that person is 60
 *                    or over (⚖ confirm the 2025 Act figures; §264)
 *   home-loan        declared 'HOME_LOAN' interest on a self-occupied house, at most
 *   interest         ₹2,00,000 (formerly s.24(b); an employer may allow it for TDS)
 * Employer NPS (formerly 80CCD(2)) is NOT here: it needs an employer NPS
 * contribution in the salary, which Pulse does not pay.
 * @param declarations  { '80c', '80d' (self/family), '80d_parents', '80ccd', 'home_loan' } annual amounts
 * @param self_senior   the employee is 60 or over at the end of the tax year
 * @param parents_senior a parent the 80D parents premium is for is 60 or over
 * @param employee_pf   employee PF of the whole year (paid + projected)
 * @param basic_year    Basic of the whole year (for the 10% NPS limit)
 */
export const OLD_REGIME_LIMITS = { c80: 150000, d80: 25000, d80_senior: 50000, nps_extra: 50000, nps_pct_of_basic: 10, home_loan_interest: 200000 };
export function oldRegimeDeductions({ declarations = {}, employee_pf = 0, basic_year = 0, self_senior = false, parents_senior = false } = {}) {
  const L = OLD_REGIME_LIMITS;
  const d = (k) => Math.max(0, num(declarations[k]));
  const c80Base = Math.min(num(employee_pf) + d('80c'), L.c80);
  const nps = d('80ccd');
  const npsExtra = Math.min(nps, L.nps_extra);
  const npsIn80C = Math.max(0, Math.min(nps - npsExtra, L.c80 - c80Base, num(basic_year) * L.nps_pct_of_basic / 100));
  const d80Self = Math.min(d('80d'), self_senior ? L.d80_senior : L.d80);
  const d80Parents = Math.min(d('80d_parents'), parents_senior ? L.d80_senior : L.d80);
  const d80 = d80Self + d80Parents;
  const homeLoan = Math.min(d('home_loan'), L.home_loan_interest);
  const c80 = c80Base + npsIn80C;
  return { c80, nps_in_80c: round(npsIn80C), nps_extra: npsExtra, d80, d80_self: d80Self, d80_parents: d80Parents, home_loan_interest: homeLoan, total: round(c80 + npsExtra + d80 + homeLoan) };
}

/**
 * HRA exemption for a whole year (old regime): the least of the HRA received,
 * rent paid above 10% of Basic, and 40% of Basic (50% in a metro city). Monthly
 * TDS (projected year) and the year-end salary details (actual year) both use it.
 */
export function hraExemption({ hra_received = 0, rent_paid = 0, basic = 0, metro = false } = {}) {
  if (!(num(rent_paid) > 0)) return 0;
  return Math.max(0, Math.min(num(hra_received), num(rent_paid) - 0.1 * num(basic), (metro ? 0.5 : 0.4) * num(basic)));
}

export function computePayroll(emp, config = {}) {
  const {
    month = new Date().getMonth() + 1,
    year = new Date().getFullYear(),
    lop_days = 0,
    overtime_hours = 0,
    ot_multiplier = null,
    bonus = 0,
    bonus_plans = null,
    night_shift_days = 0,
    night_shift_rate = null,
    adjustments = [],
    arrears = null,
    recoveries = [],
    ytd = null,
    months_remaining = null,
    deduction_80d = 0,
    deduction_80d_parents = 0,
    parents_senior = false,
    deduction_nps_80ccd = 0,
    home_loan_interest = 0,
    lta_claimed = 0,
    deduction_80c = 0,
    rent_paid_annual = 0,
    hra_metro_city = false,
    esi_period_covered = false,
    carried_lop_days = 0,
    carried_base_days = 0,
    perq_loans = [],
    prior_revision = null,
    state: configState,
    working_days = 26,
    regime = 'new',
    pf_enabled = true,
    esi_enabled = true,
    professional_tax: pt_enabled = true,
    tds_auto_calculate = true,
    pf_restrict_to_ceiling = true,
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
  // Loss of pay is a share of the working days attendance counted for this
  // employee (from joining, up to exit); a day valued at 1/26 while attendance
  // counted 22 working days paid 4/26 of a month to someone absent all month.
  const lopBase = num(config.lop_base_days) > 0 ? num(config.lop_base_days) : wd;
  const lop = Math.min(Math.max(0, num(lop_days)), lopBase);
  // Overtime is paid at the statutory rate (Factories Act s.59 / OSH Code s.27:
  // twice the ordinary rate), whatever lower multiple an attendance policy or an
  // old record holds. A record above that rate is bad data and stops the employee
  // rather than being paid (a seed row held 89).
  const otMult = rules['ot.max_multiplier'];
  const recordedOt = num(ot_multiplier);
  if (num(overtime_hours) > 0 && recordedOt > otMult) {
    throw new PayrollInputError('OT_MULTIPLIER',
      `Overtime multiplier ${recordedOt} is above the statutory ${otMult} — correct the OT record`);
  }

  // ── Earnings ─────────────────────────────────────────────────────────────
  const proration = prorationFor(month, year, emp.joining_date, emp.exit_date);
  const lopFactor = 1 - lop / lopBase;
  const payFactor = proration.factor * lopFactor;

  const linesOf = (components, breakdown, basic) => {
    const approved = Array.isArray(breakdown?.monthly?.components) && breakdown.monthly.components.length ? breakdown.monthly.components : null;
    return approved
      ? approved.map(c => ({ name: c.name, calculation_type: 'approved', amount: num(c.amount) }))
      : computeEarningsFromComponents(components, basic).lines;
  };
  const { lines } = { lines: linesOf(structureComponents, emp.breakdown, basicMonthly) };

  // A revision that takes effect inside the month is paid day by day: the old
  // rate up to the day before, the new rate from that day. `rate` stays the new
  // full-month figure, used for coverage tests and for projecting later months.
  let basicForRates = basicMonthly;
  for (const l of lines) l.rate = l.amount;
  if (prior_revision && proration.paid_days > 0) {
    const eff = String(prior_revision.effective_from).slice(0, 10);
    const toDate = [pEnd, emp.exit_date ? String(emp.exit_date).slice(0, 10) : null].filter(Boolean).sort()[0];
    const daysNew = Math.max(0, Math.min(proration.paid_days, Math.round((Date.parse(toDate) - Date.parse(eff)) / 86400000) + 1));
    const newShare = daysNew / proration.paid_days;
    const old = new Map(linesOf(prior_revision.structureComponents, prior_revision.breakdown, num(prior_revision.basic_salary)).map(l => [l.name, l]));
    for (const l of lines) {
      l.amount = l.rate * newShare + num(old.get(l.name)?.amount) * (1 - newShare);
      old.delete(l.name);
    }
    for (const l of old.values()) lines.push({ name: l.name, calculation_type: l.calculation_type, rate: 0, amount: num(l.amount) * (1 - newShare) });
    basicForRates = basicMonthly * newShare + num(prior_revision.basic_salary) * (1 - newShare);
  }
  const earnings = {};
  const earningLines = [];
  let fullMonthRegular = 0;
  let regularGross = 0;
  // Absence after LAST month's cutoff day (counted by this month's attendance
  // sync): each line loses that many days of a full month, at last month's
  // working-day count.
  const carriedDays = Math.max(0, num(carried_lop_days));
  const carriedShare = carriedDays > 0 ? carriedDays / (num(carried_base_days) > 0 ? num(carried_base_days) : wd) : 0;
  let carriedAmount = 0;
  for (const l of lines) {
    if (!approvedComponents && l.name !== 'Basic' && TOGGLE_FOR[l.name] && !togglesOn(l.name)) continue;
    const amount = Math.max(0, round(l.amount * payFactor - l.rate * carriedShare));
    carriedAmount += round(l.amount * payFactor) - amount;
    fullMonthRegular += l.rate;
    regularGross += amount;
    const key = LINE_KEY[l.name];
    if (key) earnings[key] = (earnings[key] || 0) + amount;
    earningLines.push({ name: l.name, full_month: round(l.rate), amount });
  }
  const basic = earnings.basic || 0;

  // ── Provident Fund ───────────────────────────────────────────────────────
  // Wages = Basic (+DA, none modelled). CoSS s.2(88) first proviso: if the
  // excluded payments exceed (100 − floor)% of all remuneration, the excess is
  // deemed wages. WHAT "all remuneration" contains is rule 'pf.wage_floor_basis':
  //   gross_excl_employer_contributions        regular pay + OT + night shift
  //                                            + one-time earnings (the engine's
  //                                            original basis)
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

  // ── One-time pay ──────────────────────────────────────────────────────────
  // Overtime (OSH Code s.27, Factories Act s.59): twice the rate of WAGES, and
  // wages are the Code's (CoSS / Code on Wages s.2: Basic, raised to the floor
  // % of all regular remuneration), not Basic alone (§261). Before the Code
  // (pf.wage_floor_pct null) this is Basic, as it always was. Overtime itself is
  // left out of the remuneration that sets its own rate.
  const otWageMonthly = codeWage(basicForRates, fullMonthRegular, includeErPf);
  const overtimePay = round((otWageMonthly / (wd * 8)) * num(overtime_hours) * otMult);
  // The rate is Payroll Settings → night_shift_rate (₹ per night); 0 pays nothing.
  const nightRate = night_shift_rate == null || night_shift_rate === '' ? 200 : num(night_shift_rate);
  const nightShiftAllowance = round(num(night_shift_days) * nightRate);
  const bonusAmt = round(num(bonus)) + planBonus(bonus_plans, month, { basic, gross: regularGross, serviceMonths: completedMonths(emp.joining_date, pEnd) });
  const arrearAmt = round(num(arrears?.amount));
  // HR's one-time amounts for this employee and month (payroll_adjustments).
  const adjustmentLines = (adjustments || []).filter(a => num(a.amount) > 0)
    .map(a => ({ id: a.id ?? null, kind: a.kind === 'deduction' ? 'deduction' : 'earning', label: String(a.label || '').trim() || 'Adjustment',
      amount: round(num(a.amount)), account_code: a.account_code || null }));
  const otherEarnings = adjustmentLines.filter(a => a.kind === 'earning').reduce((t, a) => t + a.amount, 0);
  const adjDeductions = adjustmentLines.filter(a => a.kind === 'deduction').reduce((t, a) => t + a.amount, 0);
  const oneTime = overtimePay + nightShiftAllowance + bonusAmt + arrearAmt + otherEarnings;
  const gross = regularGross + oneTime;

  const remuneration = regularGross + overtimePay + nightShiftAllowance + otherEarnings + (includeErPf ? bonusAmt : 0);
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
  // Employer-only PF charges, on top of the 12%: never deducted from the employee.
  const edliEmployer = pf_enabled ? round(Math.min(pfWage, ceiling) * num(rules['pf.edli_rate']) / 100) : 0;
  const pfAdminEmployer = pf_enabled ? round(pfContribWage * num(rules['pf.admin_rate']) / 100) : 0;

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
  // Coverage holds to the end of the contribution period (April–September,
  // October–March): someone already contributing in the period keeps contributing,
  // on actual wages, after a raise takes them over the limit.
  const esiApplicable = esi_enabled && (esiCoverageWage <= rules['esi.wage_threshold'] || !!esi_period_covered);
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
  // Months still to be paid stop at the exit month: someone leaving in September
  // has no October salary. Later months project at the full-month rate, so one
  // month of loss of pay or a mid-month joining date is not assumed to repeat.
  let remaining = Math.max(1, num(months_remaining) || 12);
  if (emp.exit_date) {
    const x = String(emp.exit_date instanceof Date ? emp.exit_date.toISOString() : emp.exit_date).slice(0, 7);
    const toExit = (Number(x.slice(0, 4)) - year) * 12 + Number(x.slice(5, 7)) - month + 1;
    if (toExit >= 1 && toExit < remaining) remaining = toExit;
  }
  const ytdGross = num(ytd?.gross);
  const ytdTds = num(ytd?.tds);
  const projectedRegular = ytdGross + regularGross + fullMonthRegular * (remaining - 1);
  const projectedAnnual = projectedRegular + oneTime;

  let otherDeductions = 0;
  let oldRegime = null;
  if (regime === 'old') {
    // 80C with PF, own NPS (extra ₹50,000, and inside 80C up to 10% of Basic), 80D, home-loan interest
    const viaYearMonths = num(ytd?.months) + remaining;
    oldRegime = oldRegimeDeductions({
      declarations: { '80c': deduction_80c, '80d': deduction_80d, '80d_parents': deduction_80d_parents, '80ccd': deduction_nps_80ccd, home_loan: home_loan_interest },
      self_senior: (ageOn(emp.dob ?? emp.date_of_birth, `${month >= 4 ? year + 1 : year}-03-31`) ?? 0) >= 60,
      parents_senior: parents_senior === true,
      employee_pf: employeePF * remaining + num(ytd?.employee_pf),
      basic_year: basicMonthly * viaYearMonths,
    });
    // the twelve months the state actually levies (KA: 11 × 200 + February 300), capped at
    // the Constitution art.276(2) maximum of 2,500
    const ptAnnual = pt_enabled
      ? Math.min([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].reduce((t, m) => t + computePT(gross, state, rules['pt.slabs'], m), 0), 2500)
      : 0;
    // LTA (s.10(5)): the exemption cannot exceed the travel concession the
    // employer pays — the structure's LTA component for the year. It used to be
    // capped at 2 × this month's HRA, which mixed the house-rent component into
    // an unrelated exemption (and allowed an LTA exemption with no LTA paid).
    // HRA exemption: the least of HRA received, rent paid above 10% of Basic, and
    // 40% of Basic (50% in a metro city), over the months of the year employed.
    const ltaAnnual = earningLines.filter(l => /^(lta|leave travel)/i.test(l.name)).reduce((t, l) => t + l.full_month, 0) * 12;
    const yearMonths = num(ytd?.months) + remaining;
    const hraRate = earningLines.filter(l => l.name === 'HRA').reduce((t, l) => t + l.full_month, 0);
    const hraExempt = hraExemption({ hra_received: hraRate * yearMonths, rent_paid: rent_paid_annual, basic: basicMonthly * yearMonths, metro: hra_metro_city });
    otherDeductions = oldRegime.total + ptAnnual + Math.min(num(lta_claimed), ltaAnnual) + hraExempt;
  }
  // Perquisites are income, never pay: they raise the tax, not the salary.
  const perq = loanPerquisite(perq_loans, rules['perq.loan']);
  const perquisiteYear = num(ytd?.perquisites) + perq.monthly * remaining;
  const taxableOf = (income) => Math.max(0, income + perquisiteYear - taxRule.standard_deduction - otherDeductions);
  // Age at any time in the tax year = on its last day (31 March).
  const fyEnd = `${month >= 4 ? year + 1 : year}-03-31`;
  const taxAge = ageOn(emp.dob ?? emp.date_of_birth, fyEnd);
  const annualTaxable = taxableOf(projectedAnnual);
  const taxDetail = tds_auto_calculate ? computeIncomeTaxDetail(annualTaxable, regime, taxRule, { age: taxAge }) : { tax: 0, surcharge: 0, cess: 0, total: 0 };
  const annualTax = taxDetail.total;
  const taxWithoutOneTime = tds_auto_calculate ? computeIncomeTax(taxableOf(projectedRegular), regime, taxRule, { age: taxAge }) : 0;
  const tdsRegular = Math.max(0, round((taxWithoutOneTime - ytdTds) / remaining));
  const tdsOneTime = Math.max(0, annualTax - taxWithoutOneTime);
  const monthlyTDS = tds_auto_calculate ? tdsRegular + tdsOneTime : 0;

  // ── Recoveries (loan EMI / advance) ──────────────────────────────────────
  const loanDeduction = round(recoveries.filter(r => r.type === 'loan').reduce((s, r) => s + num(r.amount), 0));
  const advanceDeduction = round(recoveries.filter(r => r.type === 'advance').reduce((s, r) => s + num(r.amount), 0));

  // ── Net pay: EMPLOYEE deductions only ────────────────────────────────────
  const statutoryDeductions = employeePF + arrearPfEmployee + employeeESI + professionalTax + monthlyTDS + lwf_employee;
  const totalDeductions = statutoryDeductions + loanDeduction + advanceDeduction + adjDeductions;
  const rawNet = gross - totalDeductions;
  if (rawNet < 0) {
    throw new PayrollInputError('NEGATIVE_NET',
      `Deductions (₹${totalDeductions}) exceed gross pay (₹${gross}) — check loan EMI / advance recovery and one-time deductions`);
  }
  // Whole rupees, and exactly gross minus deductions. Rounding to ₹10 or ₹100 left
  // a difference with no account to post to, so the accrual journal refused.
  const netPay = rawNet;

  const employerPF = employerPFTotal + arrearPfEmployer;
  const employerContributions = {
    pf_total: employerPF, eps, epf: epfEmployer + arrearPfEmployer,
    esi: employerESI, lwf: lwf_employer,
    edli: edliEmployer, pf_admin: pfAdminEmployer,
    total: employerPF + employerESI + lwf_employer + edliEmployer + pfAdminEmployer,
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
    lop_carried_days: carriedDays,
    lop_carried_amount: carriedAmount,
    perquisite_value: perq.monthly,
    perquisite_unpriced: perq.unpriced,
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
    overtime_wage_monthly: round(otWageMonthly),
    night_shift_allowance: nightShiftAllowance,
    other_earnings: otherEarnings,
    adjustment_lines: adjustmentLines,
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
    other_deductions: adjDeductions,
    total_deductions: totalDeductions,
    net_pay: netPay,

    // Employer cost — NOT deducted from the employee
    employer_contributions: employerContributions,
    employer_pf: employerPF,
    eps,
    epf_employer: epfEmployer + arrearPfEmployer,
    employer_esi: employerESI,
    lwf_employer,
    edli_employer: edliEmployer,
    pf_admin_employer: pfAdminEmployer,

    // Statutory working
    pf_wage: pfWage,
    pf_wage_basis: floorBasis,
    esi_wage_basis: esiBasis,
    pf_contribution_wage: pfContribWage,
    eps_wage: pf_enabled && epsEligible ? Math.min(pfWage, ceiling) : 0,
    annual_taxable_income: round(annualTaxable),
    // §262: the old-regime declarations as allowed (null under the new regime)
    tax_deductions: oldRegime,
    annual_tax: annualTax,
    annual_surcharge: taxDetail.surcharge,
    annual_cess: taxDetail.cess,
    tax_slabs_used: taxDetail.slabs_used,
    tax_regime: regime,
    esi_applicable: esiApplicable,
    esi_wage: esiApplicable ? round(esiWage) : 0,
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

/**
 * Statutory bonus for one employee and one accounting year (Payment of Bonus Act
 * 1965 s.8, s.10, s.12; Code on Wages 2019 s.26–s.27), from the year's FINALISED
 * months. §261 — the report used to take the average Basic × 12, which gave a full
 * year's bonus to someone paid for three months, and capped it at ₹7,000 even
 * where the minimum wage is higher.
 *   eligibility  average monthly wage ≤ rule.wage_eligibility, and at least 30
 *                working days in the year (when the months carry worked_days)
 *   bonus wage   each month: the wage, capped at rule.calc_ceiling OR that month's
 *                minimum wage, whichever is higher
 *   minimum      min_pct of the year's bonus wages, or ₹100, whichever is higher
 *   maximum      max_pct of the year's bonus wages
 * @param months      [{ month, year, wage, worked_days? }]
 * @param rule        resolved 'bonus.statutory' { wage_eligibility, calc_ceiling, min_pct, max_pct }
 * @param minWageOf   (month, year) => the minimum monthly wage in force, or null
 */
export function computeStatutoryBonus(months, rule, minWageOf = () => null) {
  const list = (months || []).filter(x => num(x.wage) > 0);
  const avg = list.length ? list.reduce((t, x) => t + num(x.wage), 0) / list.length : 0;
  const daysKnown = list.length > 0 && list.every(x => x.worked_days != null);
  const workedDays = daysKnown ? list.reduce((t, x) => t + num(x.worked_days), 0) : null;
  const reasons = [];
  if (!list.length) reasons.push('No finalised salary in the year');
  if (avg > num(rule.wage_eligibility)) reasons.push(`Average wage ₹${round(avg).toLocaleString('en-IN')} is above the ₹${num(rule.wage_eligibility).toLocaleString('en-IN')} limit`);
  if (daysKnown && workedDays < 30) reasons.push(`Worked ${workedDays} day(s) in the year; at least 30 are needed`);
  const eligible = reasons.length === 0;
  const perMonth = list.map(x => {
    const mw = minWageOf(x.month, x.year);
    const cap = Math.max(num(rule.calc_ceiling), mw != null ? num(mw) : 0);
    return { month: x.month, year: x.year, wage: num(x.wage), cap, bonus_wage: Math.min(num(x.wage), cap) };
  });
  const bonusWages = perMonth.reduce((t, x) => t + x.bonus_wage, 0);
  return {
    eligible, reasons,
    months_worked: list.length, worked_days: workedDays,
    avg_wage: round(avg),
    bonus_wages: round(bonusWages),
    min_bonus: eligible ? Math.max(100, round(bonusWages * num(rule.min_pct) / 100)) : 0,
    max_bonus: eligible ? round(bonusWages * num(rule.max_pct) / 100) : 0,
    per_month: perMonth,
  };
}
