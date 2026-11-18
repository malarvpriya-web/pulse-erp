/**
 * Engine rules added for paying real salaries (2026-11-09). Pure: no database.
 *   overtime at the statutory rate · ESI to the end of the contribution period ·
 *   a mid-month revision paid day by day · tax projected at the full-month rate
 *   and only up to the exit month · 80C and HRA declarations in the old regime ·
 *   employer EDLI and EPF administration · net pay is exactly gross − deductions ·
 *   loss of pay as a share of the days attendance counted.
 */
import { describe, it, expect } from 'vitest';
import { computePayroll, oldRegimeDeductions } from '../modules/payroll/payrollEngine.js';
import { resolveRules } from '../modules/payroll/statutoryRules.js';
import { validateWageLimits } from '../modules/payroll/payrollEligibility.js';

const STD = [
  { name: 'Basic', type: 'earning', calculation_type: 'percentage_of_ctc', value: 40 },
  { name: 'HRA', type: 'earning', calculation_type: 'percentage_of_basic', value: 40 },
  { name: 'Conveyance', type: 'earning', calculation_type: 'fixed', value: 1600 },
  { name: 'Medical', type: 'earning', calculation_type: 'fixed', value: 1250 },
  { name: 'Special Allowance', type: 'earning', calculation_type: 'balancing', value: 0 },
];
const rules = (over = {}) => ({ ...resolveRules('2026-11-30').values, ...over });
const base = (over = {}) => ({ month: 11, year: 2026, rules: rules(), state: 'TN', structureComponents: STD, months_remaining: 5, ytd: { gross: 0, tds: 0 }, ...over });
const emp = (basic, over = {}) => ({ id: 1, basic_salary: basic, joining_date: '2026-02-22', dob: '1990-01-01', ...over });

describe('overtime', () => {
  it('is paid at twice the ordinary rate, whatever lower multiple a record holds', () => {
    // Basic 26,000 is 40% of 65,000 a month; the Code's wages are half of all
    // pay, 32,500 — the overtime rate is on that, not on Basic (§261).
    const s = computePayroll(emp(26000), base({ overtime_hours: 10, ot_multiplier: 1.5 }));
    expect(s.overtime_wage_monthly).toBe(32500);
    expect(s.overtime_pay).toBe(Math.round(32500 / (26 * 8) * 10 * 2));   // 3,125 (Basic alone gave 2,500)
  });
  it('before the Code (no 50% rule) the overtime rate is on Basic', () => {
    const s = computePayroll(emp(26000), base({ overtime_hours: 10, rules: rules({ 'pf.wage_floor_pct': null }) }));
    expect(s.overtime_pay).toBe(Math.round(26000 / (26 * 8) * 10 * 2));   // 2,500
  });
  it('when Basic is already more than half of pay, the rate is on Basic', () => {
    const flat = [{ name: 'Basic', type: 'earning', calculation_type: 'percentage_of_ctc', value: 80 },
      { name: 'Special Allowance', type: 'earning', calculation_type: 'balancing', value: 0 }];
    const s = computePayroll(emp(40000), base({ overtime_hours: 4, structureComponents: flat }));
    expect(s.overtime_wage_monthly).toBe(40000);
  });
  it('a record above the statutory rate is bad data and stops the employee', () => {
    expect(() => computePayroll(emp(26000), base({ overtime_hours: 10, ot_multiplier: 89 }))).toThrow(/above the statutory/);
  });
});

describe('ESI contribution period', () => {
  const gross = base({ rules: rules({ 'esi.wage_basis': 'gross' }) });
  it('an employee over the limit is not covered…', () => {
    expect(computePayroll(emp(9000), gross).esi_applicable).toBe(false);   // gross 22,500
  });
  it('…unless they were contributing earlier in the same period: then on actual wages', () => {
    const s = computePayroll(emp(9000), { ...gross, esi_period_covered: true });
    expect(s.esi_applicable).toBe(true);
    expect(s.employee_esi).toBe(Math.ceil(22500 * 0.0075));
  });
});

describe('a salary revision inside the month', () => {
  it('pays the old rate up to the day before and the new rate from its date', () => {
    const s = computePayroll(emp(32000), base({ prior_revision: { effective_from: '2026-11-15', basic_salary: 30000, structureComponents: STD } }));
    expect(s.basic).toBe(Math.round(30000 * 14 / 30 + 32000 * 16 / 30));
    // later months are projected at the new rate
    const full = computePayroll(emp(32000), base());
    expect(s.earning_lines.find(l => l.name === 'Basic').full_month).toBe(full.earning_lines.find(l => l.name === 'Basic').full_month);
  });
});

describe('tax projection', () => {
  it('one month of loss of pay is not assumed to repeat for the rest of the year', () => {
    const plain = computePayroll(emp(100000), base({ month: 8, months_remaining: 8 }));
    const lop = computePayroll(emp(100000), base({ month: 8, months_remaining: 8, lop_days: 13 }));
    // the year's income falls by this month's lost pay only
    expect(plain.annual_taxable_income - lop.annual_taxable_income).toBe(plain.gross - lop.gross);
  });
  it('a leaver is projected only to the exit month', () => {
    const s = computePayroll(emp(100000, { exit_date: '2026-09-30' }), base({ month: 9, months_remaining: 7, ytd: { gross: 1250000, tds: 0 } }));
    expect(s.annual_taxable_income).toBe(1250000 + s.gross - 75000);
  });
  it('old regime: declared 80C and rent paid reduce taxable income', () => {
    const cfg = base({ regime: 'old' });
    const plain = computePayroll(emp(50000), cfg);
    const with80c = computePayroll(emp(50000), { ...cfg, deduction_80c: 100000 });
    expect(plain.annual_taxable_income - with80c.annual_taxable_income).toBe(Math.min(150000, plain.employee_pf * 5 + 100000) - plain.employee_pf * 5);
    const withRent = computePayroll(emp(50000), { ...cfg, rent_paid_annual: 300000 });
    expect(withRent.annual_taxable_income).toBeLessThan(plain.annual_taxable_income);
  });
});

describe('employer PF charges and net pay', () => {
  it('EDLI and EPF administration are employer cost, never deducted', () => {
    const s = computePayroll(emp(30000), base());
    expect(s.edli_employer).toBe(125);          // 0.5% of the ₹25,000 ceiling
    expect(s.pf_admin_employer).toBe(125);      // 0.5% of the contribution wage
    expect(s.net_pay).toBe(s.gross - s.total_deductions);
    expect(s.ctc_monthly).toBe(s.gross + s.employer_pf + s.employer_esi + s.lwf_employer + 250);
  });
  it('net pay is never rounded away from gross − deductions (the old ₹10 / ₹100 option)', () => {
    const s = computePayroll(emp(30123), base({ round_net_pay: 100 }));
    expect(s.net_pay).toBe(s.gross - s.total_deductions);
  });
});

describe('loss of pay', () => {
  it('is a share of the working days attendance counted, so a whole month absent pays nothing', () => {
    const s = computePayroll(emp(30000), base({ lop_days: 21, lop_base_days: 21 }));
    expect(s.gross).toBe(0 + s.overtime_pay + s.bonus);
  });
});

describe('Code on Wages limits', () => {
  it('deductions above half of gross block approval', () => {
    const issues = validateWageLimits({ gross: 10000, total_deductions: 6000, earning_lines: [] }, {});
    expect(issues.map(i => i.code)).toEqual(['DEDUCTIONS_OVER_LIMIT']);
  });
  it('pay below a recorded minimum wage blocks approval', () => {
    const issues = validateWageLimits({ gross: 9000, total_deductions: 0, earning_lines: [{ full_month: 9000 }] }, { 'wages.minimum_monthly': 12000 });
    expect(issues.map(i => i.code)).toEqual(['BELOW_MINIMUM_WAGE']);
  });
});

// ── 2026-11-09 (second pass): surcharge, senior slabs, loan perquisite, carried absence ──
import { computeIncomeTaxDetail, loanPerquisite } from '../modules/payroll/payrollEngine.js';

describe('income tax: surcharge with marginal relief, and the old-regime senior slabs (Finance Act 2026 Part III)', () => {
  const r27 = resolveRules('2027-03-31').values;
  it('no surcharge at ₹50,00,000; above it marginal relief caps the jump at the income above the threshold', () => {
    expect(computeIncomeTaxDetail(5000000, 'new', r27['tax.new']).surcharge).toBe(0);
    const just = computeIncomeTaxDetail(5050000, 'new', r27['tax.new']);
    // 10% would be ₹1,09,500; tax + surcharge may not exceed tax at ₹50L (₹10,80,000) + ₹50,000
    expect(just.tax + just.surcharge).toBe(1130000);
  });
  it('the new regime stops at 25%; the old regime reaches 37% above ₹5 crore', () => {
    const n = computeIncomeTaxDetail(60000000, 'new', r27['tax.new']);
    const o = computeIncomeTaxDetail(60000000, 'old', r27['tax.old']);
    expect(n.surcharge / n.tax).toBeCloseTo(0.25, 5);
    expect(o.surcharge / o.tax).toBeCloseTo(0.37, 5);
    expect(n.cess).toBe(Math.round((n.tax + n.surcharge) * 0.04));
  });
  it('old regime: nil to ₹3,00,000 at 60–79 and to ₹5,00,000 at 80+', () => {
    expect(computeIncomeTaxDetail(600000, 'old', r27['tax.old']).tax).toBe(32500);
    expect(computeIncomeTaxDetail(600000, 'old', r27['tax.old'], { age: 65 }).tax).toBe(30000);
    expect(computeIncomeTaxDetail(600000, 'old', r27['tax.old'], { age: 82 }).tax).toBe(20000);
    expect(computeIncomeTaxDetail(600000, 'new', r27['tax.new'], { age: 82 }).slabs_used).toBe('standard');
  });
});

describe('loan perquisite (Income-tax Rules 2026, rule 15 Table IV)', () => {
  const rule = { exempt_limit: 200000, sbi_rates: { loan: 9, advance: 10 } };
  it('interest at the SBI rate, less the interest charged, on the balance — taxed, never paid', () => {
    expect(loanPerquisite([{ balance: 500000, interest_rate: 0, loan_type: 'loan' }], rule)).toEqual({ monthly: 3750, unpriced: false });
    expect(loanPerquisite([{ balance: 500000, interest_rate: 6, loan_type: 'loan' }], rule).monthly).toBe(1250);
  });
  it('nothing when loans total the limit or less, or for a medical loan', () => {
    expect(loanPerquisite([{ balance: 200000, interest_rate: 0 }], rule).monthly).toBe(0);
    expect(loanPerquisite([{ balance: 500000, interest_rate: 0, purpose: 'medical' }], rule).monthly).toBe(0);
  });
  it('a missing SBI rate is reported, not guessed', () => {
    expect(loanPerquisite([{ balance: 500000, interest_rate: 0, loan_type: 'loan' }], { exempt_limit: 200000, sbi_rates: { loan: null } })).toEqual({ monthly: 0, unpriced: true });
  });
  it('raises the tax, not the gross', () => {
    const rules27 = { ...rules(), 'perq.loan': rule };
    const plain = computePayroll(emp(100000), base({ rules: rules27 }));
    const withLoan = computePayroll(emp(100000), base({ rules: rules27, perq_loans: [{ balance: 1000000, interest_rate: 0, loan_type: 'loan' }] }));
    expect(withLoan.gross).toBe(plain.gross);
    expect(withLoan.perquisite_value).toBe(7500);
    expect(withLoan.annual_taxable_income).toBe(plain.annual_taxable_income + 7500 * 5);
    expect(withLoan.tds).toBeGreaterThan(plain.tds);
  });
});

describe('absence after last month\'s cutoff', () => {
  it('reduces every line by that share of a full month, at last month\'s working days', () => {
    const plain = computePayroll(emp(30000), base());
    const s = computePayroll(emp(30000), base({ carried_lop_days: 2, carried_base_days: 20 }));
    expect(s.lop_carried_days).toBe(2);
    expect(Math.abs(plain.gross - s.gross - plain.gross * 2 / 20)).toBeLessThanOrEqual(3);
    expect(s.lop_carried_amount).toBe(plain.gross - s.gross);
    expect(s.basic).toBe(Math.round(30000 - 30000 * 2 / 20));
  });
});

// §261 — HR's one-time amounts, the night-shift rate setting, the bonus report.
describe('one-time adjustments', () => {
  const plain = computePayroll(emp(26000), base());
  it('an earning is part of gross and taxed in its month; a deduction comes off net pay', () => {
    const s = computePayroll(emp(26000), base({ adjustments: [
      { id: 1, kind: 'earning', label: 'Sales incentive', amount: 10000 },
      { id: 2, kind: 'deduction', label: 'Canteen', amount: 1500, account_code: '4003' },
    ] }));
    expect(s.other_earnings).toBe(10000);
    expect(s.other_deductions).toBe(1500);
    expect(s.gross).toBe(plain.gross + 10000);
    expect(s.tds).toBeGreaterThanOrEqual(plain.tds);
    expect(s.total_deductions).toBe(s.employee_pf + s.employee_esi + s.professional_tax + s.lwf_employee + s.tds + 1500);
    expect(s.net_pay).toBe(s.gross - s.total_deductions);
    expect(s.adjustment_lines).toEqual([
      { id: 1, kind: 'earning', label: 'Sales incentive', amount: 10000, account_code: null },
      { id: 2, kind: 'deduction', label: 'Canteen', amount: 1500, account_code: '4003' },
    ]);
  });
  it('a deduction larger than pay is refused, never paid as a negative salary', () => {
    expect(() => computePayroll(emp(26000), base({ adjustments: [{ kind: 'deduction', label: 'x', amount: 10000000, account_code: '4003' }] })))
      .toThrow(/one-time deductions/);
  });
  it('an earning counts in "all remuneration" for the PF wage', () => {
    // all-Basic structure: Basic is the whole regular pay, so a big incentive pushes the 50% wage above it
    const flat = [{ name: 'Basic', type: 'earning', calculation_type: 'percentage_of_ctc', value: 100 }];
    const s = computePayroll(emp(10000), base({ structureComponents: flat, adjustments: [{ kind: 'earning', label: 'Incentive', amount: 30000 }] }));
    expect(s.pf_wage).toBe(20000);
  });
});

describe('night-shift allowance rate', () => {
  it('uses the configured rate, and 0 pays nothing', () => {
    expect(computePayroll(emp(26000), base({ night_shift_days: 4, night_shift_rate: 350 })).night_shift_allowance).toBe(1400);
    expect(computePayroll(emp(26000), base({ night_shift_days: 4, night_shift_rate: 0 })).night_shift_allowance).toBe(0);
    expect(computePayroll(emp(26000), base({ night_shift_days: 4 })).night_shift_allowance).toBe(800);
  });
});

describe('own NPS and home-loan interest (§262)', () => {
  it('own NPS: ₹50,000 extra, the rest inside the ₹1,50,000 80C limit and 10% of Basic', () => {
    // 80C room 1,50,000 − 60,000 = 90,000; 10% of 6,00,000 Basic = 60,000
    const d = oldRegimeDeductions({ declarations: { '80c': 40000, '80ccd': 150000 }, employee_pf: 20000, basic_year: 600000 });
    expect(d).toMatchObject({ nps_extra: 50000, nps_in_80c: 60000, c80: 120000 });
    // 80C already full: only the extra ₹50,000 counts
    expect(oldRegimeDeductions({ declarations: { '80c': 200000, '80ccd': 80000 }, basic_year: 600000 }).total).toBe(150000 + 50000);
  });
  it('home-loan interest at most ₹2,00,000; 80D at most ₹25,000', () => {
    expect(oldRegimeDeductions({ declarations: { home_loan: 260000, '80d': 40000 } })).toMatchObject({ home_loan_interest: 200000, d80: 25000, total: 225000 });
    expect(oldRegimeDeductions({ declarations: { home_loan: -5 } }).total).toBe(0);
  });
  it('reduce taxable income in the old regime only', () => {
    const old = base({ regime: 'old' });
    const plain = computePayroll(emp(50000), old);
    const both = computePayroll(emp(50000), { ...old, home_loan_interest: 180000, deduction_nps_80ccd: 50000 });
    expect(plain.annual_taxable_income - both.annual_taxable_income).toBe(230000);
    expect(both.tax_deductions).toMatchObject({ home_loan_interest: 180000, nps_extra: 50000 });
    const newRegime = computePayroll(emp(50000), base({ home_loan_interest: 180000, deduction_nps_80ccd: 50000 }));
    expect(newRegime.annual_taxable_income).toBe(computePayroll(emp(50000), base()).annual_taxable_income);
    expect(newRegime.tax_deductions).toBeNull();
  });
});

describe('an employee excluded from PF (§262)', () => {
  it('pays and earns no PF, EPS, EDLI or EPF administration; gross is unchanged', () => {
    const on = computePayroll(emp(30000), base()), off = computePayroll(emp(30000), base({ pf_enabled: false }));
    expect(off).toMatchObject({ employee_pf: 0, employer_pf: 0, eps: 0, edli_employer: 0, pf_admin_employer: 0, pf_applicable: false });
    expect(off.gross).toBe(on.gross);
    expect(off.net_pay).toBe(on.net_pay + on.employee_pf + (on.tds - off.tds));
  });
});

describe('80D self / parents, HRA exemption, declaration cut-off (§264)', () => {
  it('80D: self and parents each have a limit, ₹50,000 for someone 60 or over', async () => {
    expect(oldRegimeDeductions({ declarations: { '80d': 40000, '80d_parents': 60000 } })).toMatchObject({ d80_self: 25000, d80_parents: 25000, d80: 50000 });
    expect(oldRegimeDeductions({ declarations: { '80d': 40000, '80d_parents': 60000 }, self_senior: true, parents_senior: true }))
      .toMatchObject({ d80_self: 40000, d80_parents: 50000, d80: 90000 });
  });
  it('HRA exemption: the least of HRA received, rent above 10% of Basic, 40% / 50% of Basic', async () => {
    const { hraExemption } = await import('../modules/payroll/payrollEngine.js');
    expect(hraExemption({ hra_received: 200000, rent_paid: 240000, basic: 600000 })).toBe(180000);              // rent − 60,000
    expect(hraExemption({ hra_received: 200000, rent_paid: 400000, basic: 600000 })).toBe(200000);              // HRA received
    expect(hraExemption({ hra_received: 400000, rent_paid: 400000, basic: 600000 })).toBe(240000);              // 40% of Basic
    expect(hraExemption({ hra_received: 400000, rent_paid: 400000, basic: 600000, metro: true })).toBe(300000); // 50%
    expect(hraExemption({ hra_received: 400000, rent_paid: 0, basic: 600000 })).toBe(0);
  });
  it('before the cut-off month waiting declarations count; from it on only approved ones', async () => {
    const { declarationStatusesFor } = await import('../modules/payroll/payrollSettings.js');
    expect(declarationStatusesFor(12, 1)).toEqual(['approved', 'submitted']);   // December, cut-off January
    expect(declarationStatusesFor(1, 1)).toEqual(['approved']);
    expect(declarationStatusesFor(3, 1)).toEqual(['approved']);
    expect(declarationStatusesFor(4, 1)).toEqual(['approved', 'submitted']);    // a new tax year starts again
    expect(declarationStatusesFor(4, 4)).toEqual(['approved']);                 // April = approved only all year
    expect(declarationStatusesFor(2, 0)).toEqual(['approved', 'submitted']);    // never
  });
  it('a senior employee gets the higher 80D limit in monthly TDS', () => {
    const cfg = base({ regime: 'old', deduction_80d: 45000 });
    const young = computePayroll(emp(40000, { dob: '1990-01-01' }), cfg);
    const senior = computePayroll(emp(40000, { dob: '1955-01-01' }), cfg);
    expect(senior.annual_taxable_income).toBeLessThan(young.annual_taxable_income);
  });
});
