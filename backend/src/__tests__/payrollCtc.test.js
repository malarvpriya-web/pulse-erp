/**
 * CTC audit — PAYROLL_DATA_FLOW_AUDIT.md Part 3 (2026-10-20).
 *
 * Synthetic fixture only. Every expected figure is worked by hand from the
 * structure and the rule table. Pulse has NO contractual-CTC calculation yet:
 * the company has not chosen a CTC definition, so the "policy options" block
 * below documents what each option WOULD produce from the engine's own
 * components — it does not test production CTC code, because there is none.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePayroll, computeEarningsFromComponents } from '../modules/payroll/payrollEngine.js';
import { resolveRules } from '../modules/payroll/statutoryRules.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(resolve(here, p), 'utf8');

// FIXTURE "CTC-75K": Standard Structure, Basic ₹30,000/month, Karnataka,
// joined 2024, no LOP/OT/bonus/loans, PT off, TDS off.
const STANDARD = [
  { name: 'Basic', type: 'earning', value: 40, calculation_type: 'percentage_of_ctc' },
  { name: 'HRA', type: 'earning', value: 40, calculation_type: 'percentage_of_basic' },
  { name: 'Conveyance', type: 'earning', value: 1600, calculation_type: 'fixed' },
  { name: 'Medical', type: 'earning', value: 1250, calculation_type: 'fixed' },
  { name: 'Special Allowance', type: 'earning', value: 0, calculation_type: 'balancing' },
];
const FIXTURE = { id: 1, office_id: 'EMPCTC', basic_salary: 30000, joining_date: '2024-04-01', state: 'Karnataka', years_of_service: 2 };
const month = (m, y = 2026, cfg = {}) => computePayroll(FIXTURE, {
  month: m, year: y, structureComponents: STANDARD, professional_tax: false, tds_auto_calculate: false,
  rules: resolveRules(`${y}-${String(m).padStart(2, '0')}-28`).values, ...cfg,
});

describe('fixture CTC-75K: monthly and annual gross', () => {
  it('monthly gross = 30,000 + 12,000 + 1,600 + 1,250 + 30,150 = 75,000', () => {
    expect(computeEarningsFromComponents(STANDARD, 30000).gross).toBe(75000);
    expect(month(10).gross).toBe(75000);
  });
  it('annual gross = 12 × 75,000 = 9,00,000 (sum of twelve regular months)', () => {
    const fy = [4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => month(m, 2026)).concat([1, 2, 3].map(m => month(m, 2027)));
    expect(fy.reduce((s, x) => s + x.gross, 0)).toBe(900000);
  });
});

describe('employer contributions are separate from employee deductions', () => {
  it('October 2026: employer PF 12% × 25,000 = 3,000 (EPS 2,083 + EPF 917); ESI nil (gross > 21,000); LWF nil (not December)', () => {
    const s = month(10);
    expect(s.employer_contributions).toMatchObject({ pf_total: 3000, eps: 2083, epf: 917, esi: 0, lwf: 0, total: 3000 });
    expect(s.employee_pf).toBe(3000);
    expect(s.net_pay).toBe(75000 - 3000);           // employer PF never reduces take-home
  });
  it('August 2026 (₹15,000 ceiling): employer PF 1,800', () => {
    expect(month(8).employer_contributions.pf_total).toBe(1800);
  });
  it('December: Karnataka LWF employer ₹100 is part of that month\'s employer cost', () => {
    expect(month(12).employer_contributions).toMatchObject({ lwf: 100, total: 3100 });
  });
});

describe('employer cost of a month (stored as ctc_monthly) — not a contractual CTC', () => {
  it('= gross earned this month + employer PF/ESI/LWF', () => {
    const oct = month(10);
    expect(oct.ctc_monthly).toBe(78000);
    expect(oct.employer_cost_month).toBe(oct.ctc_monthly);
  });
  it('a one-time bonus raises that month\'s employer cost; no annual figure is extrapolated from it', () => {
    const withBonus = month(10, 2026, { bonus: 50000 });
    expect(withBonus.ctc_monthly).toBe(128000);
    // ctc_annual used to be ctc_monthly × 12 = 15,36,000 here — a bonus paid twelve times.
    expect(withBonus).not.toHaveProperty('ctc_annual');
  });
  it('gratuity is reported as payable-if-exit (≥ 5 years only) and is not in any cost figure', () => {
    expect(month(10).gratuity_payable_if_exit_now).toBe(0);  // 2 years of service
    const senior = computePayroll({ ...FIXTURE, years_of_service: 6 }, { month: 10, year: 2026, structureComponents: STANDARD, professional_tax: false, tds_auto_calculate: false });
    expect(senior.gratuity_payable_if_exit_now).toBe(Math.round(30000 * 15 / 26 * 6));   // 1,03,846
    expect(senior.ctc_monthly).toBe(78000);
    expect(senior).not.toHaveProperty('gratuity_provision');
  });
});

describe('CTC POLICY OPTIONS for fixture CTC-75K, tax year 2026-27 (documentation — no option is implemented)', () => {
  // Twelve months Apr-2026 … Mar-2027. Employer PF: Apr–Aug ₹1,800 × 5 (₹15,000
  // ceiling), Sep–Mar ₹3,000 × 7 (₹25,000) = 30,000. LWF ₹100 in December.
  const fy = [4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => month(m, 2026)).concat([1, 2, 3].map(m => month(m, 2027)));
  const annualGross = fy.reduce((s, x) => s + x.gross, 0);
  const erPf = fy.reduce((s, x) => s + x.employer_contributions.pf_total, 0);
  const erLwf = fy.reduce((s, x) => s + x.employer_contributions.lwf, 0);
  const gratuityAccrual = Math.round(30000 * 15 / 26);  // one year's accrual, IF policy includes it
  it('option B — CTC = annual gross: 9,00,000', () => {
    expect(annualGross).toBe(900000);
  });
  it('option A1 — annual gross + statutory employer contributions: 9,00,000 + 30,000 PF + 100 LWF = 9,30,100', () => {
    expect(erPf).toBe(30000);
    expect(erLwf).toBe(100);
    expect(annualGross + erPf + erLwf).toBe(930100);
  });
  it('option A2 — A1 + gratuity accrual (15/26 × monthly Basic per year): 9,30,100 + 17,308 = 9,47,408', () => {
    expect(gratuityAccrual).toBe(17308);
    expect(annualGross + erPf + erLwf + gratuityAccrual).toBe(947408);
  });
});

describe('unit and labelling contracts (source)', () => {
  it('a hire never turns the offer\'s annual CTC into a salary revision', () => {
    const repo = src('../modules/recruitment/repositories/recruitment.repository.js');
    const hire = repo.slice(repo.indexOf('async hireCandidate('), repo.indexOf('async hireCandidate(') + 12000);
    expect(hire).not.toMatch(/INSERT INTO employee_salary_assignments/);
  });
  it('the payslip modal does not call the month\'s employer cost "Cost to Company"', () => {
    expect(src('../../../frontend/src/features/hr/pages/Payroll.jsx')).not.toMatch(/Cost to Company \(month\)/);
  });
  it('the structure preview labels its input monthly gross, not CTC; Basic inputs state their unit', () => {
    const ss = src('../../../frontend/src/features/hr/pages/SalaryStructure.jsx');
    expect(ss).not.toMatch(/>Monthly CTC ₹</);
    expect(ss).toMatch(/Basic Salary \(₹ per month\)/);
  });
  it('the auto-creation queue shows the offer as an annual CTC, not "/mo"', () => {
    expect(src('../../../frontend/src/features/recruitment/pages/EmployeeAutoCreation.jsx')).toMatch(/\/yr \(annual CTC\)/);
  });
});
