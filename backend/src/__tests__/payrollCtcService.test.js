/**
 * CTC service (pure) — PAYROLL_DATA_FLOW_AUDIT.md Part 5.
 *
 * Synthetic fixture "CTC-30K" (same as integration.ctcProposals.test.js):
 * Standard Structure, Basic ₹30,000/month, Karnataka, rules as of 1-Oct-2026.
 *   annual gross 9,00,000 + employer PF 36,000 + ESI 0 + LWF 100
 *   + gratuity round(37,500 × 15/26) = 21,635  →  9,57,735
 */
import { describe, it, expect } from 'vitest';
import { contractBreakdown, solveFromAnnualCtc, resolvePolicy, finalisationBlockers, BUILT_IN_POLICY, POLICY_KEY } from '../modules/payroll/ctcService.js';
import { computePayroll } from '../modules/payroll/payrollEngine.js';
import { resolveRules } from '../modules/payroll/statutoryRules.js';

const STANDARD = [
  { name: 'Basic', type: 'earning', value: 40, calculation_type: 'percentage_of_ctc' },
  { name: 'HRA', type: 'earning', value: 40, calculation_type: 'percentage_of_basic' },
  { name: 'Conveyance', type: 'earning', value: 1600, calculation_type: 'fixed' },
  { name: 'Medical', type: 'earning', value: 1250, calculation_type: 'fixed' },
  { name: 'Special Allowance', type: 'earning', value: 0, calculation_type: 'balancing' },
];
const POLICY = BUILT_IN_POLICY[0].value;
const ctx = { structureComponents: STANDARD, emp: { state: 'Karnataka' }, settings: { professional_tax: false },
  rules: resolveRules('2026-10-31').values, policy: POLICY, asOf: '2026-10-01' };
const at = (b, over = {}) => contractBreakdown({ ...ctx, ...over, basicMonthly: b });

describe('contract breakdown', () => {
  it('₹30,000 Basic: monthly gross ₹75,000 and annual CTC 9,57,735, each component once', () => {
    const b = at(30000);
    expect(b.monthly.gross).toBe(75000);
    expect(b.monthly.components.reduce((s, c) => s + c.amount, 0)).toBe(75000);
    expect(b.monthly.code_wages).toBe(37500);
    expect(b.annual).toEqual({ gross: 900000, employer_pf: 36000, employer_esi: 0, employer_lwf: 100, gratuity: 21635, ctc: 957735 });
    expect(b.monthly_ctc_equivalent).toBe(79811);
  });

  it('each policy inclusion adds exactly its own component — nothing is counted twice', () => {
    const all = at(30000).annual.ctc;
    for (const [k, field] of [['employer_pf', 'employer_pf'], ['employer_lwf', 'employer_lwf'], ['gratuity', 'gratuity']]) {
      const off = at(30000, { policy: { ...POLICY, include: { ...POLICY.include, [k]: false } } });
      expect(off.annual[field]).toBe(0);
      expect(all - off.annual.ctc).toBe(at(30000).annual[field]);
    }
  });

  it('gratuity on Basic instead of Code wages is a policy switch, not a hidden default', () => {
    expect(at(30000, { policy: { ...POLICY, gratuity: { ...POLICY.gratuity, base: 'basic' } } }).annual.gratuity).toBe(Math.round(30000 * 15 / 26));
  });

  it('an ESI-covered salary carries employer ESI in its CTC', () => {
    const b = at(8000);
    expect(b.esi_covered).toBe(true);
    expect(b.annual.employer_esi).toBe(b.monthly.employer.esi * 12);
    expect(b.annual.employer_esi).toBeGreaterThan(0);
  });
});

describe('annual CTC → monthly Basic', () => {
  it('round-trips the fixture exactly', () => {
    expect(solveFromAnnualCtc(957735, ctx)).toMatchObject({ basicMonthly: 30000, rounding_residual: 0 });
  });

  it('never exceeds the target, reports the gap, and is the LARGEST Basic that fits — across the ESI limit', () => {
    // CTC falls when ESI coverage ends, so a plain binary search would miss covered answers.
    let cliff = 8000; while (at(cliff + 1).esi_covered) cliff++;
    expect(at(cliff).annual.ctc).toBeGreaterThan(at(cliff + 1).annual.ctc);
    for (const target of [at(cliff).annual.ctc, at(cliff).annual.ctc - 1, at(cliff + 1).annual.ctc, at(cliff + 40).annual.ctc - 1, 300000]) {
      const r = solveFromAnnualCtc(target, ctx);
      expect(r.breakdown.annual.ctc).toBeLessThanOrEqual(target);
      expect(r.breakdown.annual.ctc + r.rounding_residual).toBe(target);
      let brute = 0;
      for (let b = 6000; b <= Math.ceil(target / 12); b++) if (at(b).annual.ctc <= target) brute = b;
      expect(r.basicMonthly).toBe(brute);
    }
  });

  it('refuses a target no Basic can reach', () => {
    expect(() => solveFromAnnualCtc(0, ctx)).toThrow(/greater than zero/);
    expect(() => solveFromAnnualCtc(1000, ctx)).toThrow(/too small/);
  });
});

describe('policy and finalisation', () => {
  it('the built-in direction is a proposal: it blocks finalisation until the company records its policy', () => {
    const builtIn = resolvePolicy('2026-10-01', []);
    expect(builtIn).toMatchObject({ origin: 'built-in', status: 'approval_required' });
    expect(finalisationBlockers({ policy: builtIn, rulesApplied: {} }).map(b => b.code)).toEqual(['CTC_POLICY_NOT_RECORDED']);
    const rows = [
      { rule_key: POLICY_KEY, company_id: null, effective_from: '2026-04-01', value: { ...POLICY, version: 'GLOBAL' } },
      { rule_key: POLICY_KEY, company_id: 7, effective_from: '2026-04-01', value: { ...POLICY, version: 'CO' } },
      { rule_key: POLICY_KEY, company_id: 7, effective_from: '2027-04-01', value: { ...POLICY, version: 'CO-FY28' } },
    ];
    expect(resolvePolicy('2026-10-01', rows)).toMatchObject({ origin: 'company', value: { version: 'CO' } });
    expect(resolvePolicy('2027-04-01', rows).value.version).toBe('CO-FY28');     // effective-date basis
    expect(finalisationBlockers({ policy: resolvePolicy('2026-10-01', rows), rulesApplied: { 'pf.wage_ceiling': { status: 'unverified' } } }))
      .toEqual([expect.objectContaining({ code: 'RULE_UNVERIFIED', key: 'pf.wage_ceiling' })]);
  });
});

describe('ESI rounding — Social Security (Central) Rules 2026 r.19(1)', () => {
  const slipFor = (basic) => computePayroll({ id: 2, office_id: 'EMPESI', basic_salary: basic, joining_date: '2024-04-01', state: 'Karnataka' },
    { month: 10, year: 2026, rules: ctx.rules, structureComponents: STANDARD, professional_tax: false, tds_auto_calculate: false });

  it('rounds BOTH shares up to the next rupee', () => {
    const s = slipFor(4004);                    // gross 10,010
    expect(s.gross).toBe(10010);
    expect(s.employer_contributions.esi).toBe(326);   // 3.25% = 325.325 → 326 (was 325)
    expect(s.employee_esi).toBe(76);                  // 0.75% = 75.075 → 76
  });

  it('does not add a rupee to an exact amount', () => {
    const s = slipFor(8000);                    // gross 20,000
    expect(s.employer_contributions.esi).toBe(650);
    expect(s.employee_esi).toBe(150);
  });
});

describe('payroll engine pays an approved breakdown', () => {
  const emp = { id: 1, office_id: 'EMPCTC', basic_salary: 30000, joining_date: '2024-04-01', state: 'Karnataka' };
  const cfg = { month: 10, year: 2026, rules: ctx.rules, professional_tax: false, tds_auto_calculate: false };

  it('uses the approved components, not the (edited) structure or the component toggles', () => {
    const breakdown = at(30000);
    const edited = STANDARD.map(c => (c.name === 'HRA' ? { ...c, value: 50 } : c));
    const slip = computePayroll({ ...emp, breakdown }, { ...cfg, structureComponents: edited, enable_hra: false });
    expect(slip).toMatchObject({ gross: 75000, salary_source: 'approved_breakdown' });
    expect(slip.earning_lines.find(l => l.name === 'HRA').full_month).toBe(12000);
    const legacy = computePayroll(emp, { ...cfg, structureComponents: edited, enable_hra: false });
    expect(legacy.salary_source).toBe('structure');
    expect(legacy.earning_lines.find(l => l.name === 'HRA')).toBeUndefined();
  });

  it('approved components are still prorated for LOP like structure components', () => {
    const fromBreakdown = computePayroll({ ...emp, breakdown: at(30000) }, { ...cfg, structureComponents: STANDARD, lop_days: 3 });
    const fromStructure = computePayroll(emp, { ...cfg, structureComponents: STANDARD, lop_days: 3 });
    expect(fromBreakdown.gross).toBeLessThan(75000);
    expect(fromBreakdown.gross).toBe(fromStructure.gross);
    expect(fromBreakdown.employee_pf).toBe(fromStructure.employee_pf);
  });

  it('pays without any structure when an approved breakdown exists', () => {
    const slip = computePayroll({ ...emp, breakdown: at(30000) }, { ...cfg, structureComponents: [] });
    expect(slip.gross).toBe(75000);
  });
});
