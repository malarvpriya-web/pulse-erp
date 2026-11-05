/**
 * Payroll engine — PAYROLL_DATA_FLOW_AUDIT.md (2026-10-20).
 *
 * Pure tests on synthetic employees only. Each block pins one defect the audit
 * found in the live data, so the figure in the test name is the figure that was
 * wrong.
 */
import { describe, it, expect } from 'vitest';
import {
  computeIncomeTax, computePT, computeLWF, computePayroll, computeEarningsFromComponents,
  PayrollInputError, prorationFor, quarterOfMonth, monthsRemainingInFY, parseFinancialYear,
  indianFinancialYear, periodStartDate, periodEndDate,
} from '../modules/payroll/payrollEngine.js';
import { resolveRules } from '../modules/payroll/statutoryRules.js';

// The live "Standard Structure" (salary_structures id 1), verbatim.
const STANDARD = [
  { name: 'Basic', type: 'earning', value: 40, calculation_type: 'percentage_of_ctc', is_pf_applicable: true },
  { name: 'HRA', type: 'earning', value: 40, calculation_type: 'percentage_of_basic' },
  { name: 'Conveyance', type: 'earning', value: 1600, calculation_type: 'fixed' },
  { name: 'Medical', type: 'earning', value: 1250, calculation_type: 'fixed' },
  { name: 'Special Allowance', type: 'earning', value: 0, calculation_type: 'balancing' },
  { name: 'Employee PF', type: 'statutory', value: 12, calculation_type: 'percentage_of_basic' },
  { name: 'Professional Tax', type: 'statutory', value: 200, calculation_type: 'fixed' },
];
const emp = (over = {}) => ({ id: 1, office_id: 'EMPT01', first_name: 'Test', last_name: 'Person', basic_salary: 30000, joining_date: '2025-01-01', state: 'Karnataka', ...over });
const run = (e, cfg = {}) => computePayroll(emp(e), { month: 8, year: 2026, structureComponents: STANDARD, professional_tax: false, ...cfg });

describe('income tax — new regime, tax year 2026-27', () => {
  it('nil up to ₹12L via the 87A rebate', () => {
    expect(computeIncomeTax(700000)).toBe(0);
    expect(computeIncomeTax(1200000)).toBe(0);
  });
  it('marginal relief: ₹12,10,000 pays ₹10,000 + cess, not ₹61,500 + cess', () => {
    expect(computeIncomeTax(1210000)).toBe(10400);
  });
  it('relief stops once slab tax is below the excess (₹13,00,000 → ₹75,000 + cess)', () => {
    expect(computeIncomeTax(1300000)).toBe(78000);
  });
  it('₹15L: 4L×5% + 4L×10% + 3L×15% = 1,05,000, +4% cess', () => {
    expect(computeIncomeTax(1500000)).toBe(109200);
  });
  it('old regime keeps the ₹5L rebate and no marginal relief', () => {
    expect(computeIncomeTax(500000, 'old')).toBe(0);
    expect(computeIncomeTax(600000, 'old')).toBeGreaterThan(0);
  });
});

describe('state levies come from the rule table', () => {
  it('Maharashtra PT slabs', () => {
    expect(computePT(7500, 'MH')).toBe(0);
    expect(computePT(9000, 'MH')).toBe(175);
    expect(computePT(50000, 'Maharashtra')).toBe(200);
  });
  it('Karnataka LWF is annual (December), ₹50/₹100 since the 2024 amendment — not ₹20 every month', () => {
    const rules = resolveRules('2026-12-31').values['lwf.rates'];
    expect(computeLWF('Karnataka', 9, rules)).toEqual({ lwf_employee: 0, lwf_employer: 0 });
    expect(computeLWF('Karnataka', 12, rules)).toEqual({ lwf_employee: 50, lwf_employer: 100 });
  });
});

describe('Standard Structure gross (audit item 4)', () => {
  it('₹30,000 Basic at 40% of CTC → ₹75,000 gross (the UI showed ₹42,501 = 30,000 × 1.4167)', () => {
    const { gross, lines } = computeEarningsFromComponents(STANDARD, 30000);
    expect(gross).toBe(75000);
    expect(lines.find(l => l.name === 'Special Allowance').amount).toBe(30150);
  });
  it('₹7,50,000 Basic → ₹18,75,000 MONTHLY gross — the engine treats Basic as monthly', () => {
    expect(computeEarningsFromComponents(STANDARD, 750000).gross).toBe(1875000);
  });
});

describe('employer contributions are not deducted from the employee (audit item 6)', () => {
  it('net = gross − EMPLOYEE deductions; employer PF sits apart', () => {
    const s = run({}, { tds_auto_calculate: false });
    expect(s.employer_pf).toBeGreaterThan(0);
    expect(s.total_deductions).toBe(s.employee_pf + s.employee_esi + s.professional_tax + s.tds + s.lwf_employee);
    expect(s.net_pay).toBe(s.gross - s.total_deductions);
    expect(s.employer_contributions.total).toBe(s.employer_pf + s.employer_esi + s.lwf_employer);
    expect(s.ctc_monthly).toBe(s.gross + s.employer_contributions.total);
  });
});

describe('PF (audit item 7): effective-dated ceiling + Code on SS wages', () => {
  it('August 2026 uses the ₹15,000 ceiling: 12% = ₹1,800', () => {
    const s = run({}, { month: 8 });
    expect(s.pf_contribution_wage).toBe(15000);
    expect(s.employee_pf).toBe(1800);
    expect(s.eps).toBe(1250);
    expect(s.epf_employer).toBe(550);
  });
  it('September 2026 uses ₹25,000 (S.O. 5109(E), 17-Sep-2026): 12% = ₹3,000, EPS ₹2,083', () => {
    const s = run({}, { month: 9 });
    expect(s.pf_contribution_wage).toBe(25000);
    expect(s.employee_pf).toBe(3000);
    expect(s.eps).toBe(2083);
    expect(s.epf_employer).toBe(917);
  });
  it('50% deeming: Basic ₹30,000 of ₹75,000 → PF wage ₹37,500', () => {
    expect(run({}, { month: 9 }).pf_wage).toBe(37500);
  });
  it('no deeming before the Code (Oct 2025): PF wage = Basic', () => {
    expect(run({}, { month: 10, year: 2025 }).pf_wage).toBe(30000);
  });
  it('unrestricted PF contributes on the full wage when the company opts in', () => {
    const s = run({ basic_salary: 40000 }, { month: 9, pf_restrict_to_ceiling: false });
    expect(s.pf_contribution_wage).toBe(50000);
    expect(s.employee_pf).toBe(6000);
    expect(s.eps).toBe(2083); // EPS stays capped at the ceiling
  });
  it('member aged 58+: no EPS, the whole 12% goes to EPF', () => {
    const s = run({ dob: '1960-01-01' }, { month: 9 });
    expect(s.eps).toBe(0);
    expect(s.epf_employer).toBe(3000);
  });
  it('a rule version added at runtime wins from its date', () => {
    const rules = resolveRules('2027-05-31', [{ rule_key: 'pf.wage_ceiling', effective_from: '2027-04-01', value: 30000, company_id: 1, source_reference: 'test' }]).values;
    expect(run({}, { month: 5, year: 2027, rules }).pf_contribution_wage).toBe(30000);
  });
  it('PF switched off in settings → no employee or employer PF', () => {
    const s = run({}, { pf_enabled: false });
    expect(s.employee_pf + s.employer_pf + s.eps).toBe(0);
  });
});

describe('ESI', () => {
  it('covered at ≤ ₹21,000 wage rate; employee share rounded up', () => {
    const struct = [{ name: 'Basic', type: 'earning', value: 0, calculation_type: 'fixed' }];
    const s = computePayroll(emp({ basic_salary: 15001 }), { month: 8, year: 2026, structureComponents: struct, professional_tax: false, tds_auto_calculate: false });
    expect(s.esi_applicable).toBe(true);
    expect(s.employee_esi).toBe(Math.ceil(15001 * 0.0075));
    expect(s.employer_esi).toBe(Math.round(15001 * 0.0325));
  });
  it('not covered above ₹21,000', () => {
    expect(run().esi_applicable).toBe(false);
  });
});

describe('inputs that must exist (no fabricated salary)', () => {
  it('no Basic → NO_SALARY (used to become ₹50,000, or ₹2,850 of allowances for "0")', () => {
    for (const b of [0, '0', null, undefined, '']) {
      expect(() => run({ basic_salary: b })).toThrow(PayrollInputError);
    }
    try { run({ basic_salary: '0' }); } catch (e) { expect(e.code).toBe('NO_SALARY'); }
  });
  it('no structure → NO_STRUCTURE (used to invent HRA 40% / Special 15% / ₹1,600 / ₹1,250)', () => {
    try { computePayroll(emp(), { month: 8, year: 2026 }); throw new Error('no throw'); }
    catch (e) { expect(e.code).toBe('NO_STRUCTURE'); }
  });
  it('OT multiplier 89 (the seeded value) is refused, not paid', () => {
    try { run({}, { overtime_hours: 10, ot_multiplier: 89 }); throw new Error('no throw'); }
    catch (e) { expect(e.code).toBe('OT_MULTIPLIER'); }
    expect(run({}, { overtime_hours: 10, ot_multiplier: 2 }).overtime_pay).toBe(Math.round(30000 / 208 * 10 * 2));
  });
  it('EMI larger than pay → NEGATIVE_NET (it used to clamp net to ₹0 silently)', () => {
    try { run({}, { recoveries: [{ type: 'loan', amount: 200000 }] }); throw new Error('no throw'); }
    catch (e) { expect(e.code).toBe('NEGATIVE_NET'); }
  });
  it('loan EMI reduces net and is itemised', () => {
    const s = run({}, { recoveries: [{ type: 'loan', amount: 5000 }], tds_auto_calculate: false });
    expect(s.loan_deduction).toBe(5000);
    expect(s.net_pay).toBe(s.gross - s.employee_pf - 5000);
  });
});

describe('proration', () => {
  it('LOP prorates every earning, not just Basic', () => {
    const s = run({}, { lop_days: 13, working_days: 26 });
    expect(s.basic).toBe(15000);
    expect(s.conveyance_allowance).toBe(800);
    expect(s.gross).toBe(37500);
  });
  it('a joiner on 21 Aug is paid 11/31 of the month', () => {
    expect(prorationFor(8, 2026, '2026-08-21', null)).toMatchObject({ paid_days: 11, days_in_month: 31 });
    expect(run({ joining_date: '2026-08-21' }).gross).toBe(Math.round(30000 * 11 / 31) + Math.round(12000 * 11 / 31) + Math.round(1600 * 11 / 31) + Math.round(1250 * 11 / 31) + Math.round(30150 * 11 / 31));
  });
  it('an exit on 10 Sep is paid 10/30', () => {
    expect(prorationFor(9, 2026, '2020-01-01', '2026-09-10').paid_days).toBe(10);
  });
});

describe('TDS projection (s.192)', () => {
  it('a ₹1,00,000 bonus is taxed once, not ×12', () => {
    const base = run({ basic_salary: 60000 }, { month: 4, months_remaining: 12 });
    const withBonus = run({ basic_salary: 60000 }, { month: 4, months_remaining: 12, bonus: 100000 });
    // annual income rises by 1,00,000 — not 12,00,000
    expect(withBonus.annual_taxable_income - base.annual_taxable_income).toBe(100000);
    expect(withBonus.tds - base.tds).toBe(withBonus.annual_tax - base.annual_tax);
  });
  it('tax already deducted this FY is spread over the remaining months', () => {
    const s = run({ basic_salary: 60000 }, { month: 10, months_remaining: 6, ytd: { gross: 6 * 150000, tds: 60000 } });
    const annual = computeIncomeTax(12 * 150000 - 75000);
    expect(s.tds).toBe(Math.round((annual - 60000) / 6));
  });
});

describe('periods, quarters and financial years (audit item 18)', () => {
  it('period dates are built from integers — no IST one-day shift', () => {
    expect(periodStartDate(9, 2026)).toBe('2026-09-01');
    expect(periodEndDate(9, 2026)).toBe('2026-09-30');
    expect(periodEndDate(2, 2028)).toBe('2028-02-29');
  });
  it('Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar', () => {
    expect([4, 5, 6].map(quarterOfMonth)).toEqual(['Q1', 'Q1', 'Q1']);
    expect([7, 8, 9].map(quarterOfMonth)).toEqual(['Q2', 'Q2', 'Q2']);
    expect([10, 11, 12].map(quarterOfMonth)).toEqual(['Q3', 'Q3', 'Q3']);
    expect([1, 2, 3].map(quarterOfMonth)).toEqual(['Q4', 'Q4', 'Q4']);
  });
  it('remaining months to March', () => {
    expect(monthsRemainingInFY(4)).toBe(12);
    expect(monthsRemainingInFY(10)).toBe(6);
    expect(monthsRemainingInFY(3)).toBe(1);
  });
  it("'2026-27' parses to 2026–2027 (it used to read the end year as 27)", () => {
    expect(parseFinancialYear('2026-27')).toMatchObject({ startYear: 2026, endYear: 2027 });
    expect(parseFinancialYear('2026-2027').label).toBe('2026-2027');
    expect(parseFinancialYear('2026-2029')).toBeNull();
    expect(indianFinancialYear(3, 2027)).toBe('2026-2027');
    expect(indianFinancialYear(4, 2026)).toBe('2026-2027');
  });
});
