/**
 * Statutory verification pass 3 — PAYROLL_DATA_FLOW_AUDIT.md Part 6.
 * Synthetic employees only; rules resolved from the built-in table.
 */
import { describe, it, expect } from 'vitest';
import { computePayroll, computePT } from '../modules/payroll/payrollEngine.js';
import { resolveRules, BUILT_IN_RULES } from '../modules/payroll/statutoryRules.js';

const STANDARD = [
  { name: 'Basic', type: 'earning', value: 40, calculation_type: 'percentage_of_ctc' },
  { name: 'HRA', type: 'earning', value: 40, calculation_type: 'percentage_of_basic' },
  { name: 'Conveyance', type: 'earning', value: 1600, calculation_type: 'fixed' },
  { name: 'Medical', type: 'earning', value: 1250, calculation_type: 'fixed' },
  { name: 'Special Allowance', type: 'earning', value: 0, calculation_type: 'balancing' },
];
const ptOn = (date) => resolveRules(date).values['pt.slabs'];

describe('Karnataka professional tax', () => {
  it('nothing below ₹25,000 a month (KA Act 2023, from 1-Apr-2023)', () => {
    expect(computePT(15000, 'Karnataka', ptOn('2026-10-31'), 10)).toBe(0);
    expect(computePT(24999, 'Karnataka', ptOn('2026-10-31'), 10)).toBe(0);
    expect(computePT(25000, 'Karnataka', ptOn('2026-10-31'), 10)).toBe(200);
  });

  it('₹300 in February from the 2025 amendment — ₹2,500 a year', () => {
    const slabs = ptOn('2027-02-28');
    expect(computePT(40000, 'Karnataka', slabs, 2)).toBe(300);
    const year = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].reduce((t, m) => t + computePT(40000, 'Karnataka', slabs, m), 0);
    expect(year).toBe(2500);
  });

  it('a February before the amendment stays ₹200', () => {
    const slabs = BUILT_IN_RULES['pt.slabs'].find(v => v.effective_from === '2023-04-01').value;
    expect(computePT(40000, 'Karnataka', slabs, 2)).toBe(200);
  });

  it('payroll deducts the February amount in a February payslip', () => {
    const emp = { id: 1, office_id: 'EMPPT', basic_salary: 30000, joining_date: '2024-04-01', state: 'Karnataka' };
    const feb = computePayroll(emp, { month: 2, year: 2027, rules: resolveRules('2027-02-28').values, structureComponents: STANDARD, tds_auto_calculate: false });
    expect(feb.professional_tax).toBe(300);
    const oct = computePayroll(emp, { month: 10, year: 2026, rules: resolveRules('2026-10-31').values, structureComponents: STANDARD, tds_auto_calculate: false });
    expect(oct.professional_tax).toBe(200);
  });

  it('an employee on ₹20,000 gross is no longer charged PT', () => {
    const emp = { id: 2, office_id: 'EMPPT2', basic_salary: 8000, joining_date: '2024-04-01', state: 'Karnataka' };
    const s = computePayroll(emp, { month: 10, year: 2026, rules: resolveRules('2026-10-31').values, structureComponents: STANDARD, tds_auto_calculate: false });
    expect(s.gross).toBe(20000);
    expect(s.professional_tax).toBe(0);
  });
});

describe('verification status is honest', () => {
  const applied = resolveRules('2026-10-31').applied;
  it('rules verified from primary text in this pass', () => {
    for (const k of ['esi.employee_rate', 'esi.employer_rate', 'pf.eps_age_limit', 'ot.max_multiplier']) expect(applied[k].status, k).toBe('verified');
    expect(applied['esi.employer_rate'].source).toMatch(/G\.S\.R\. 344\(E\)/);
  });
  it('rules still blocking — not cleared by this pass', () => {
    expect(applied['pt.slabs'].status).toBe('unverified');        // other states unchecked
    expect(applied['lwf.rates'].status).toBe('unverified');       // deduction month, applicability
    expect(applied['tax.new'].status).toBe('unverified');         // enacted Finance Act 2026 not read
    expect(applied['tax.old'].status).toBe('unverified');
    expect(applied['pf.wage_floor_basis'].status).toBe('decision_required');
    expect(applied['esi.wage_basis'].status).toBe('decision_required');
  });
});
