/**
 * Payroll calculation reconciliation — PAYROLL_DATA_FLOW_AUDIT.md §R3.
 *
 * Every expected figure below is worked by hand in the comment beside it from
 * the statute / rule table, NOT taken from the engine's output. Synthetic
 * employees only.
 */
import { describe, it, expect } from 'vitest';
import { computePayroll } from '../modules/payroll/payrollEngine.js';
import { resolveRules } from '../modules/payroll/statutoryRules.js';

const STANDARD = [
  { name: 'Basic', type: 'earning', value: 40, calculation_type: 'percentage_of_ctc' },
  { name: 'HRA', type: 'earning', value: 40, calculation_type: 'percentage_of_basic' },
  { name: 'Conveyance', type: 'earning', value: 1600, calculation_type: 'fixed' },
  { name: 'Medical', type: 'earning', value: 1250, calculation_type: 'fixed' },
  { name: 'Special Allowance', type: 'earning', value: 0, calculation_type: 'balancing' },
];
const rulesWith = (date, over) => ({ ...resolveRules(date).values, ...over });
const run = (basic, { month = 10, year = 2026, rules, ...cfg } = {}) => computePayroll(
  { id: 1, office_id: 'EMPR01', basic_salary: basic, joining_date: '2025-01-01', state: 'Karnataka' },
  { month, year, structureComponents: STANDARD, tds_auto_calculate: false, rules: rules || resolveRules(`${year}-${String(month).padStart(2, '0')}-28`).values, ...cfg });

describe('structure totals', () => {
  it('Basic 20,000 → CTC 50,000: HRA 8,000 + 1,600 + 1,250 + Special 19,150', () => {
    const s = run(20000, { professional_tax: false });
    expect([s.basic, s.hra, s.conveyance_allowance, s.medical_allowance, s.special_allowance, s.gross])
      .toEqual([20000, 8000, 1600, 1250, 19150, 50000]);
  });
});

describe('PF wage under each 50% basis (Oct 2026, ceiling ₹25,000)', () => {
  it('gross basis: 50% of 50,000 = 25,000 > Basic 20,000 → PF wage 25,000; 12% = 3,000; EPS 8.33% = 2,083; EPF 917', () => {
    const s = run(20000, { professional_tax: false });
    expect([s.pf_wage, s.employee_pf, s.employer_pf, s.eps, s.epf_employer]).toEqual([25000, 3000, 3000, 2083, 917]);
  });
  it('MoLE-FAQ basis (employer PF in remuneration): W = ½(50,000 + 12%·min(W, 25,000)) = 26,500; contribution still capped at 25,000', () => {
    const rules = rulesWith('2026-10-31', { 'pf.wage_floor_basis': 'include_employer_pf_and_statutory_bonus' });
    const s = run(20000, { rules, professional_tax: false });
    expect([s.pf_wage, s.pf_contribution_wage, s.employee_pf]).toEqual([26500, 25000, 3000]);
  });
  it('MoLE-FAQ basis, unrestricted PF: W = 25,000 / 0.94 = 26,595.74 → 26,596; 12% = 3,192', () => {
    const rules = rulesWith('2026-10-31', { 'pf.wage_floor_basis': 'include_employer_pf_and_statutory_bonus' });
    const s = run(20000, { rules, professional_tax: false, pf_restrict_to_ceiling: false });
    expect([s.pf_wage, s.employee_pf]).toEqual([26596, 3192]);
  });
});

describe('ESI under each wage basis', () => {
  it('gross basis: gross 20,000 ≤ 21,000 → covered; 0.75% = 150, 3.25% = 650', () => {
    const s = run(8000, { professional_tax: false });
    expect([s.esi_applicable, s.employee_esi, s.employer_esi]).toEqual([true, 150, 650]);
  });
  it('gross basis: gross 30,000 → not covered', () => {
    expect(run(12000, { professional_tax: false }).esi_applicable).toBe(false);
  });
  it('Code-wages basis (MoLE FAQ Q12): Basic 12,000 of 30,000 → Code wages 15,000 ≤ 21,000 → covered; 0.75% ↑ = 113, 3.25% = 488', () => {
    const rules = rulesWith('2026-10-31', { 'esi.wage_basis': 'code_wages' });
    const s = run(12000, { rules, professional_tax: false });
    expect([s.esi_applicable, s.employee_esi, s.employer_esi]).toEqual([true, 113, 488]);
  });
});

describe('state levies and the September transition', () => {
  it('Karnataka PT ₹200 on gross ≥ 15,000; LWF only in December (₹50 / ₹100)', () => {
    const oct = run(20000, { professional_tax: true });
    expect([oct.professional_tax, oct.lwf_employee]).toEqual([200, 0]);
    const dec = run(20000, { month: 12, professional_tax: true });
    expect([dec.lwf_employee, dec.lwf_employer]).toEqual([50, 100]);
  });
  it('September 2026 applies the ceiling in force on 30 Sep (₹25,000) to the whole month — the treatment the release gate asks the company to confirm', () => {
    expect(run(30000, { month: 9 }).pf_contribution_wage).toBe(25000);
    expect(run(30000, { month: 8 }).pf_contribution_wage).toBe(15000);
  });
  it('employer contributions never reduce net pay', () => {
    const s = run(20000, { professional_tax: true });
    expect(s.net_pay).toBe(s.gross - s.employee_pf - s.employee_esi - s.professional_tax - s.lwf_employee);
  });
});

describe('monthly units', () => {
  it('Basic is monthly: ₹7,50,000 Basic is ₹18,75,000 gross for ONE month — Assign asks for confirmation above ₹5,00,000', () => {
    expect(run(750000, { professional_tax: false }).gross).toBe(1875000);
  });
});
