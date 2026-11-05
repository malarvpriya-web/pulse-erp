/**
 * Loans, payslip shape and tax-component separation — PAYROLL_DATA_FLOW_AUDIT.md
 * Part 11. Pure functions only (no database). Every expected figure is worked
 * by hand in the comment beside it.
 */
import { describe, it, expect } from 'vitest';
import {
  standardEmi, installmentFor, buildSchedule, planLoan, remainingInstallments, LoanInputError,
} from '../modules/payroll/loanSchedule.js';
import { computePayroll, generateForm16Summary } from '../modules/payroll/payrollEngine.js';
import { shapePayslip } from '../modules/payroll/payroll.controller.js';
import { resolveRules } from '../modules/payroll/statutoryRules.js';

const STANDARD = [
  { name: 'Basic', type: 'earning', calculation_type: 'percentage_of_ctc', value: 40 },
  { name: 'HRA', type: 'earning', calculation_type: 'percentage_of_basic', value: 40 },
  { name: 'Conveyance', type: 'earning', calculation_type: 'fixed', value: 1600 },
  { name: 'Medical', type: 'earning', calculation_type: 'fixed', value: 1250 },
  { name: 'Special Allowance', type: 'earning', calculation_type: 'balancing', value: 0 },
  // statutory lines in a structure are display-only: payroll ignores them
  { name: 'Employee PF', type: 'statutory', calculation_type: 'percentage_of_basic', value: 12 },
  { name: 'Professional Tax', type: 'statutory', calculation_type: 'fixed', value: 200 },
];
const WITH_LTA = [
  ...STANDARD.slice(0, 4),
  { name: 'LTA', type: 'earning', calculation_type: 'percentage_of_basic', value: 8.33 },
  STANDARD[4],
];
const loanErr = (fn) => { try { fn(); } catch (e) { if (e instanceof LoanInputError) return e; throw e; } throw new Error('no error'); };

describe('loan arithmetic (one function for schedule, draft and approval)', () => {
  it('standard EMI, rounded UP so the agreed tenure holds', () => {
    // 1,00,000 at 10% for 12 months: r = 0.1/12; EMI = 8,791.59 → 8,792
    expect(standardEmi(100000, 10, 12)).toBe(8792);
    // interest-free: 10,000 / 3 = 3,333.33 → 3,334 (3,334 + 3,334 + 3,332)
    expect(standardEmi(10000, 0, 3)).toBe(3334);
  });

  it('an installment pays this month\'s interest first, then principal', () => {
    // 1,00,000 × 10% / 12 = 833.33 interest; 8,792 − 833.33 = 7,958.67 principal
    expect(installmentFor({ outstanding_balance: 100000, emi_amount: 8792, interest_rate: 10 }))
      .toEqual({ amount: 8792, interest: 833.33, principal: 7958.67, balance_after: 92041.33 });
    // interest-free: min(EMI, outstanding) — the pre-existing behaviour
    expect(installmentFor({ outstanding_balance: 2000, emi_amount: 5000, interest_rate: 0 }))
      .toEqual({ amount: 2000, interest: 0, principal: 2000, balance_after: 0 });
    // nothing owed → nothing deducted
    expect(installmentFor({ outstanding_balance: 0, emi_amount: 5000 }).amount).toBe(0);
  });

  it('the schedule repays exactly the principal in the agreed tenure, interest on top', () => {
    const s = buildSchedule({ principal: 100000, emi: 8792, interest_rate: 10, startMonth: 8, startYear: 2026 });
    expect(s).toHaveLength(12);
    expect(s[0]).toMatchObject({ installment: 1, month: 8, year: 2026, emi: 8792 });
    expect(s[11]).toMatchObject({ month: 7, year: 2027, balance: 0 });
    expect(s[11].emi).toBeLessThanOrEqual(8792);   // the last one absorbs the rounding
    expect(Number.isInteger(s[11].emi)).toBe(true); // …in whole rupees, as payroll deducts it
    const principal = s.reduce((t, x) => t + x.principal, 0);
    expect(Math.round(principal * 100) / 100).toBe(100000);
    const interest = s.reduce((t, x) => t + x.interest, 0);
    expect(interest).toBeGreaterThan(5400);        // ≈ 12 × 8,791.59 − 1,00,000 = 5,499
    expect(interest).toBeLessThan(5600);
  });

  it('the server schedule no longer drops the interest the screen showed', () => {
    // Before Part 11: 1,00,000 / 8,792 → 12 rows totalling exactly 1,00,000.
    const plan = planLoan({ principal_amount: 100000, interest_rate: 10, tenure_months: 12, start_date: '2026-08-01' });
    expect(plan).toMatchObject({ emi: 8792, tenure_months: 12, interest_rate: 10 });
    expect(plan.total_repayable).toBeGreaterThan(105400);
    expect(plan.total_interest).toBeGreaterThan(5400);
  });

  it('EMI equal to the principal must be confirmed as a one-installment loan', () => {
    const e = loanErr(() => planLoan({ principal_amount: 125000, emi_amount: 125000, start_date: '2026-10-01' }));
    expect(e.code).toBe('SINGLE_INSTALLMENT_CONFIRM');
    expect(e.status).toBe(422);
    const ok = planLoan({ principal_amount: 125000, emi_amount: 125000, start_date: '2026-10-01', single_installment: true });
    expect(ok.tenure_months).toBe(1);
    // a salary advance recovered in one month is the same rule — confirmed, not assumed
    expect(loanErr(() => planLoan({ loan_type: 'advance', principal_amount: 5000, emi_amount: 6000, start_date: '2026-10-01' })).code)
      .toBe('SINGLE_INSTALLMENT_CONFIRM');
  });

  it('refuses inputs that cannot be a real loan', () => {
    expect(loanErr(() => planLoan({ loan_type: 'Standard', principal_amount: 1000, emi_amount: 100, start_date: '2026-10-01' })).code).toBe('LOAN_TYPE');
    expect(loanErr(() => planLoan({ principal_amount: 0, emi_amount: 100, start_date: '2026-10-01' })).code).toBe('PRINCIPAL');
    expect(loanErr(() => planLoan({ principal_amount: 1000, emi_amount: 100 })).code).toBe('START_DATE');
    // interest without a tenure: the EMI cannot be checked
    expect(loanErr(() => planLoan({ principal_amount: 100000, emi_amount: 9000, interest_rate: 10, start_date: '2026-10-01' })).code).toBe('TENURE');
    // EMI that disagrees with rate + tenure
    expect(loanErr(() => planLoan({ principal_amount: 100000, emi_amount: 9000, interest_rate: 10, tenure_months: 12, start_date: '2026-10-01' })).code).toBe('EMI_TENURE_MISMATCH');
    // EMI below the first month's interest never repays
    expect(loanErr(() => buildSchedule({ principal: 100000, emi: 500, interest_rate: 12, startMonth: 1, startYear: 2026 })).code).toBe('EMI_BELOW_INTEREST');
    expect(loanErr(() => planLoan({ principal_amount: 1000, emi_amount: 100, interest_rate: -1, start_date: '2026-10-01' })).code).toBe('INTEREST_RATE');
  });

  it('remaining installments follow the balance, not the original schedule', () => {
    expect(remainingInstallments({ outstanding_balance: 92041.33, emi_amount: 8792, interest_rate: 10 })).toBe(11);
    expect(remainingInstallments({ outstanding_balance: 7000, emi_amount: 5000, interest_rate: 0 })).toBe(2);
    expect(remainingInstallments({ outstanding_balance: 0, emi_amount: 5000 })).toBe(0);
  });
});

describe('representative loans — checked against the closed-form EMI, worked here', () => {
  // EMI = P·r·(1+r)^n / ((1+r)^n − 1), computed independently of loanSchedule.js
  const closedForm = (P, annual, n) => { const r = annual / 1200; return r === 0 ? P / n : P * r * (1 + r) ** n / ((1 + r) ** n - 1); };
  const plan = (b) => planLoan({ start_date: '2026-11-01', ...b });
  const sum = (rows, k) => Math.round(rows.reduce((t, x) => t + x[k], 0) * 100) / 100;

  it('₹60,000 over 12 months at 0%: twelve installments of ₹5,000, no interest', () => {
    const p = plan({ principal_amount: 60000, tenure_months: 12 });
    expect(closedForm(60000, 0, 12)).toBe(5000);
    expect(p).toMatchObject({ emi: 5000, tenure_months: 12, total_interest: 0, total_repayable: 60000 });
    expect(p.schedule.map(x => x.emi)).toEqual(Array(12).fill(5000));
    expect(p.schedule.map(x => x.balance)).toEqual([55000, 50000, 45000, 40000, 35000, 30000, 25000, 20000, 15000, 10000, 5000, 0]);
  });

  it('₹60,000 over 12 months at 12% p.a. reducing balance: EMI ₹5,331', () => {
    // r = 0.01; (1.01)^12 = 1.126825; 600 × 1.126825 / 0.126825 = 5,330.93 → rounded up 5,331
    expect(closedForm(60000, 12, 12)).toBeCloseTo(5330.93, 2);
    const p = plan({ principal_amount: 60000, tenure_months: 12, interest_rate: 12 });
    expect(p.emi).toBe(5331);
    expect(p.tenure_months).toBe(12);
    // month 1: interest 60,000 × 1% = 600; principal 4,731; balance 55,269
    expect(p.schedule[0]).toMatchObject({ emi: 5331, interest: 600, principal: 4731, balance: 55269 });
    // the last installment pays the balance and its interest, rounded UP to a whole rupee
    const last = p.schedule[11];
    expect(last.balance).toBe(0);
    expect(Number.isInteger(last.emi)).toBe(true);
    // principal repaid is exactly the loan; total = installments; interest = total − principal
    expect(sum(p.schedule, 'principal')).toBe(60000);
    expect(p.total_repayable).toBe(sum(p.schedule, 'emi'));
    expect(p.total_interest).toBe(Math.round((p.total_repayable - 60000) * 100) / 100);
    // exact closed-form interest is 12 × 5,330.93 − 60,000 = 3,971.2; rounding up EMIs adds < ₹1
    expect(p.total_interest).toBeGreaterThan(3971);
    expect(p.total_interest).toBeLessThan(3973);
  });

  it('interest-free rounding: the LAST installment is the smaller one, total = principal', () => {
    const p = plan({ principal_amount: 10000, tenure_months: 3 });
    expect(p.schedule.map(x => x.emi)).toEqual([3334, 3334, 3332]);
    expect(p.total_repayable).toBe(10000);
    const q = plan({ principal_amount: 60001, tenure_months: 12 });   // 5,000.08 → 5,001
    expect(q.schedule.slice(0, 11).every(x => x.emi === 5001)).toBe(true);
    expect(q.schedule[11].emi).toBe(60001 - 11 * 5001);               // 4,990
  });

  it('every installment payroll deducts is a whole rupee — the payslip and the ledger cannot differ', () => {
    // payrollEngine rounds the recovery to the rupee; an installment with paise
    // was deducted as one figure and recorded as another (3,630 vs 3,629.67)
    for (const b of [
      { principal_amount: 60000, tenure_months: 12, interest_rate: 12 },
      { principal_amount: 100000, tenure_months: 12, interest_rate: 10 },
      { principal_amount: 75000, tenure_months: 7, interest_rate: 13.5 },
    ]) {
      expect(plan(b).schedule.every(x => Number.isInteger(x.emi))).toBe(true);
    }
    // a final installment of 3,599.67 + 30.00 interest is recovered as 3,630, the paise as interest
    expect(installmentFor({ outstanding_balance: 3599.67, emi_amount: 8792, interest_rate: 10 }))
      .toEqual({ amount: 3630, interest: 30.33, principal: 3599.67, balance_after: 0 });
  });

  it('refuses invalid principal, tenure, rate and paise amounts', () => {
    const code = (b) => loanErr(() => plan(b)).code;
    expect(code({ principal_amount: -60000, tenure_months: 12 })).toBe('PRINCIPAL');
    expect(code({ principal_amount: 'abc', tenure_months: 12 })).toBe('PRINCIPAL');
    expect(code({ principal_amount: 1000.5, tenure_months: 3 })).toBe('PRINCIPAL');
    expect(code({ principal_amount: 60000, tenure_months: 0 })).toBe('TENURE');
    expect(code({ principal_amount: 60000, tenure_months: -12 })).toBe('TENURE');
    // parseInt('2.5') was 2: a 2.5-month request silently became a 2-month loan
    expect(code({ principal_amount: 60000, tenure_months: 2.5 })).toBe('TENURE');
    expect(code({ principal_amount: 60000, tenure_months: '12abc' })).toBe('TENURE');
    expect(code({ principal_amount: 60000, tenure_months: 12, interest_rate: 100 })).toBe('INTEREST_RATE');
    expect(code({ principal_amount: 60000, tenure_months: 12, interest_rate: 'abc' })).toBe('INTEREST_RATE');
    expect(code({ principal_amount: 60000, emi_amount: 0 })).toBe('EMI');
    expect(code({ principal_amount: 60000, emi_amount: 3333.33 })).toBe('EMI');
    // an advance is interest-free unless a rate is given — no rate is assumed
    expect(plan({ loan_type: 'advance', principal_amount: 60000, tenure_months: 12 })).toMatchObject({ interest_rate: 0, total_interest: 0 });
  });
});

describe('payslip earnings add up to gross', () => {
  const emp = { id: 1, basic_salary: 30000, joining_date: '2024-01-01', dob: '1990-01-01' };

  it('every structure component is itemised — LTA was in gross but on no line', () => {
    const slip = computePayroll(emp, { month: 10, year: 2026, structureComponents: WITH_LTA, state: 'TN', tds_auto_calculate: false });
    const shaped = shapePayslip(slip);
    expect(shaped.earnings.map(e => e.label)).toContain('LTA');
    // LTA 8.33% × 30,000 = 2,499
    expect(shaped.earnings.find(e => e.label === 'LTA').amount).toBe(2499);
    expect(shaped.earnings.reduce((t, e) => t + e.amount, 0)).toBe(slip.gross);
    expect(shaped.deductions.reduce((t, d) => t + d.amount, 0)).toBe(slip.total_deductions);
  });

  it('a run saved before earning_lines existed shows the unexplained remainder on one line', () => {
    // legacy row: gross 77,499 but only the five fixed columns (75,000) stored
    const legacy = { gross: 77499, basic: 30000, hra: 12000, conveyance_allowance: 1600, medical_allowance: 1250, special_allowance: 30150, total_deductions: 0 };
    const shaped = shapePayslip(legacy);
    expect(shaped.earnings.at(-1)).toEqual({ label: 'Other earnings (not itemised on this run)', amount: 2499 });
    expect(shaped.earnings.reduce((t, e) => t + e.amount, 0)).toBe(77499);
  });

  it('employer PF is listed apart and never inside deductions or net', () => {
    const slip = computePayroll(emp, { month: 10, year: 2026, structureComponents: STANDARD, state: 'TN', tds_auto_calculate: false });
    const shaped = shapePayslip(slip);
    expect(shaped.deductions.map(d => d.label).join('|')).not.toMatch(/Employer/);
    expect(shaped.employer_contributions_list.length).toBeGreaterThan(0);
    expect(slip.net_pay).toBe(slip.gross - slip.total_deductions);
    // structure "Employee PF" / "Professional Tax ₹200" lines are not priced by payroll:
    // PF = 12% × min(code wage 37,500, ceiling 25,000) = 3,000; TN PT is not due in October
    expect(slip).toMatchObject({ employee_pf: 3000, professional_tax: 0 });
  });
});

describe('HRA component is separate from income-tax exemptions', () => {
  const emp = { id: 1, basic_salary: 30000, joining_date: '2024-01-01', dob: '1990-01-01' };
  const base = { month: 10, year: 2026, state: 'TN', regime: 'old', structureComponents: STANDARD };

  it('an LTA claim is not capped by (or granted because of) HRA', () => {
    // Standard Structure has no LTA component: an LTA claim exempts nothing.
    // It used to be capped at 2 × HRA (2 × 12,000 = 24,000) and reduce tax.
    const none = computePayroll(emp, { ...base });
    const claimed = computePayroll(emp, { ...base, lta_claimed: 20000 });
    expect(claimed.annual_taxable_income).toBe(none.annual_taxable_income);
  });

  it('an LTA claim is capped by the LTA the structure pays', () => {
    // LTA 2,499 × 12 = 29,988 a year: a 40,000 claim exempts 29,988.
    const none = computePayroll(emp, { ...base, structureComponents: WITH_LTA });
    const claimed = computePayroll(emp, { ...base, structureComponents: WITH_LTA, lta_claimed: 40000 });
    expect(none.annual_taxable_income - claimed.annual_taxable_income).toBe(29988);
  });

  it('the HRA earning is paid in full whatever the tax regime', () => {
    expect(computePayroll(emp, { ...base }).hra).toBe(12000);
    expect(computePayroll(emp, { ...base, regime: 'new' }).hra).toBe(12000);
  });
});

describe('Form 16 standard deduction comes from the tax rule, not a literal', () => {
  it('uses the rule passed for the FY', () => {
    const rules = resolveRules('2027-03-31').values;
    const custom = { ...rules, 'tax.new': { ...rules['tax.new'], standard_deduction: 12345 } };
    const r = generateForm16Summary({ first_name: 'A' }, [{ month: 3, year: 2027, gross: 1, tax_regime: 'new' }], custom);
    expect(r.standard_deduction).toBe(12345);
    const old = generateForm16Summary({ first_name: 'A' }, [{ month: 3, year: 2027, gross: 1, tax_regime: 'old' }], rules);
    expect(old.standard_deduction).toBe(rules['tax.old'].standard_deduction);
  });
});
