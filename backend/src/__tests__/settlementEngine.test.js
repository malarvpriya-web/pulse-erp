/**
 * The Full & Final calculation, by hand-worked example (manual §253). No database.
 * Each expected figure is worked out in its comment, not copied from the engine's output.
 */
import { describe, it, expect } from 'vitest';
import { computeSettlement, serviceSpan } from '../modules/hr/settlementEngine.js';
import { resolveSettlementRules, unconfirmedRules, settlementRuleProblem, SETTLEMENT_RULE_KEYS } from '../modules/hr/settlementRules.js';
import { RULE_KEYS, resolveRules } from '../modules/payroll/statutoryRules.js';
import { computeIncomeTax } from '../modules/payroll/payrollEngine.js';

const rules = resolveSettlementRules('2026-11-01').values;
const wage = (w) => ({ gross: w * 2, basic: w, code_wages: w });
const base = (over = {}) => ({
  exit: { separation_type: 'resignation', last_working_date: '2026-10-31', notice_period: 30, created_at: '2026-10-01', ...over.exit },
  employee: { joining_date: '2020-04-01', employment_type: 'Permanent', ...over.employee },
  wage: over.wage === undefined ? wage(26000) : over.wage,
  options: { notice_start: '2026-10-02', ...over.options },
  leave: over.leave ?? [], loans: over.loans ?? [], advanceOutstanding: over.advanceOutstanding ?? 0,
  bonusPaidInYear: over.bonusPaidInYear ?? 0, finalSlip: over.finalSlip ?? null, finalRun: over.finalRun ?? null,
});
const line = (r, code) => r.lines.find((l) => l.code === code);

describe('service', () => {
  it('counts the last working day as served', () => {
    expect(serviceSpan('2020-04-01', '2025-03-31')).toMatchObject({ years: 5, months: 0 });
    expect(serviceSpan('2020-04-01', '2025-03-30')).toMatchObject({ years: 4, months: 11 });
    expect(serviceSpan('2020-04-15', '2020-05-14')).toMatchObject({ years: 0, months: 1 });
  });
});

describe('gratuity', () => {
  it('5 years exactly: 15/26 × 26,000 × 5 = 75,000', () => {
    const r = computeSettlement(base({ exit: { last_working_date: '2025-03-31' } }), rules);
    expect(line(r, 'GRATUITY')).toMatchObject({ amount: 75000, quantity: 5 });
  });
  it('under 5 years is nil, with the reason', () => {
    const g = line(computeSettlement(base({ exit: { last_working_date: '2024-03-31' } }), rules), 'GRATUITY');
    expect(g.amount).toBe(0);
    expect(g.basis).toMatch(/4 years 0 months/);
  });
  it('a part-year of more than 6 months counts as a year: 6y 7m → 7 years = 1,05,000', () => {
    const r = computeSettlement(base({ exit: { last_working_date: '2026-10-31' } }), rules); // Apr 2020 to Oct 2026
    expect(r.service).toEqual({ years: 6, months: 7 });
    expect(line(r, 'GRATUITY')).toMatchObject({ quantity: 7, amount: 105000 });
  });
  it('a part-year of exactly 6 months does not: 6y 6m → 6 years = 90,000', () => {
    const r = computeSettlement(base({ exit: { last_working_date: '2026-09-30' } }), rules);
    expect(r.service).toEqual({ years: 6, months: 6 });
    expect(line(r, 'GRATUITY')).toMatchObject({ quantity: 6, amount: 90000 });
  });
  it('one day past 6 months is more than six months: 6y 6m 1d → 7 years = 1,05,000', () => {
    const r = computeSettlement(base({ exit: { last_working_date: '2026-10-01' } }), rules);
    expect(line(r, 'GRATUITY')).toMatchObject({ quantity: 7, amount: 105000 });
  });
  it('fixed term: payable from 1 year, pro rata. 730 days → 2 years × 15,000 = 30,000', () => {
    const r = computeSettlement(base({ employee: { joining_date: '2024-11-01', employment_type: 'Fixed Term' }, exit: { last_working_date: '2026-10-31' } }), rules);
    expect(line(r, 'GRATUITY')).toMatchObject({ quantity: 2, amount: 30000 });
  });
  it('fixed term under 1 year is nil', () => {
    const r = computeSettlement(base({ employee: { joining_date: '2026-01-01', employment_type: 'Contract' } }), rules);
    expect(line(r, 'GRATUITY').amount).toBe(0);
  });
  it('death has no minimum service: 1 year = 15,000', () => {
    const r = computeSettlement(base({ employee: { joining_date: '2025-11-01' }, exit: { separation_type: 'death' } }), rules);
    expect(line(r, 'GRATUITY')).toMatchObject({ quantity: 1, amount: 15000 });
  });
  it('capped at the ceiling, with a warning', () => {
    const r = computeSettlement(base({ wage: wage(500000), employee: { joining_date: '1990-04-01' } }), rules);
    expect(line(r, 'GRATUITY').amount).toBe(2000000);
    expect(r.warnings.map((w) => w.code)).toContain('GRATUITY_CEILING');
  });
  it('interns get none', () => {
    expect(line(computeSettlement(base({ employee: { employment_type: 'Intern' } }), rules), 'GRATUITY').amount).toBe(0);
  });
  it('near the threshold it warns rather than deciding', () => {
    const r = computeSettlement(base({ exit: { last_working_date: '2025-01-31' } }), rules); // 4y 10m
    expect(line(r, 'GRATUITY').amount).toBe(0);
    expect(r.warnings.map((w) => w.code)).toContain('GRATUITY_NEAR_THRESHOLD');
  });
});

describe('bonus', () => {
  it('wage above 21,000 is not eligible', () => {
    const b = line(computeSettlement(base(), rules), 'BONUS');
    expect(b.amount).toBe(0);
    expect(b.basis).toMatch(/above the 21000 limit/);
  });
  it('eligible: calculated on 7,000. Apr 1 to Sep 30 = 183 days = 6.02 months; 7,000 × 6.02 × 8.33% = 3,510.26', () => {
    const r = computeSettlement(base({ wage: wage(18000), exit: { last_working_date: '2026-09-30' } }), rules);
    expect(line(r, 'BONUS')).toMatchObject({ quantity: 6.02, amount: 3510.26 });
  });
  it('a wage under 7,000 uses the wage itself', () => {
    const b = line(computeSettlement(base({ wage: wage(6000), exit: { last_working_date: '2026-09-30' } }), rules), 'BONUS');
    expect(b.amount).toBe(3008.8); // 6,000 × 6.02 × 8.33%
  });
  it('fewer than 30 days in the accounting year is nil', () => {
    const b = line(computeSettlement(base({ wage: wage(18000), exit: { last_working_date: '2026-04-20' } }), rules), 'BONUS');
    expect(b.amount).toBe(0);
    expect(b.basis).toMatch(/20 days/);
  });
  it('bonus already paid this year is taken off, never below nil', () => {
    const go = (paid) => line(computeSettlement(base({ wage: wage(18000), exit: { last_working_date: '2026-09-30' }, bonusPaidInYear: paid }), rules), 'BONUS').amount;
    expect(go(1000)).toBe(2510.26);
    expect(go(9000)).toBe(0);
  });
  it('joining mid-year counts from the joining date', () => {
    const r = computeSettlement(base({ wage: wage(18000), employee: { joining_date: '2026-08-01' }, exit: { last_working_date: '2026-09-30' } }), rules);
    expect(line(r, 'BONUS').quantity).toBe(2.01); // 61 days / 30.4167 = 2.005
  });
});

describe('earned leave', () => {
  const el = (o) => ({ leave_name: 'Earned Leave', year: 2026, opening_balance: 2, allocated_days: 10, carried_forward_days: 3, used_days: 4, encashed_days: 1, ...o });
  it('balance × day rate: (2+10+3-4-1) = 10 days × 26,000/26 = 10,000', () => {
    const l = line(computeSettlement(base({ leave: [el()] }), rules), 'LEAVE');
    expect(l).toMatchObject({ quantity: 10, rate: 1000, amount: 10000, direction: 'payable' });
  });
  it('the yearly allowance is pro-rated: 12 a year, left 31 May = 5 months = 5 days, not 12', () => {
    const r = computeSettlement(base({ exit: { last_working_date: '2026-05-31' }, leave: [el({ opening_balance: 0, carried_forward_days: 0, used_days: 0, encashed_days: 0, allocated_days: 12, annual_quota: 12 })] }), rules);
    expect(line(r, 'LEAVE')).toMatchObject({ quantity: 5, amount: 5000 });
    expect(line(r, 'LEAVE').basis).toMatch(/5 of 12 days earned by 5 months/);
  });
  it('carried-forward leave is kept in full, and only this year is pro-rated: 3 + 5 − 1 = 7 days', () => {
    const r = computeSettlement(base({ exit: { last_working_date: '2026-05-31' }, leave: [el({ opening_balance: 0, carried_forward_days: 3, used_days: 1, encashed_days: 0, allocated_days: 12, annual_quota: 12 })] }), rules);
    expect(line(r, 'LEAVE').quantity).toBe(7);
  });
  it('joining mid-year counts only from joining: 1 Jul to 31 Oct = 4 months = 4 days', () => {
    const r = computeSettlement(base({ employee: { joining_date: '2026-07-01' }, leave: [el({ opening_balance: 0, carried_forward_days: 0, used_days: 0, encashed_days: 0, allocated_days: 12, annual_quota: 12 })] }), rules);
    expect(line(r, 'LEAVE').quantity).toBe(4);
  });
  it('a full year earns all of it, and a recorded rule can switch pro-rating off', () => {
    const row = el({ opening_balance: 0, carried_forward_days: 0, used_days: 0, encashed_days: 0, allocated_days: 12, annual_quota: 12 });
    expect(line(computeSettlement(base({ exit: { last_working_date: '2026-12-31' }, leave: [row] }), rules), 'LEAVE').quantity).toBe(12);
    const off = { ...rules, 'settlement.leave': { ...rules['settlement.leave'], prorate_allocation: false } };
    expect(line(computeSettlement(base({ exit: { last_working_date: '2026-05-31' }, leave: [row] }), off), 'LEAVE').quantity).toBe(12);
  });
  it('no joining date: bonus says it could not be worked out', () => {
    const r = computeSettlement(base({ employee: { joining_date: null }, wage: wage(18000) }), rules);
    expect(line(r, 'BONUS')).toMatchObject({ amount: 0, basis: 'Not worked out: no joining date.' });
  });
  it('a negative balance warns and is not recovered by default', () => {
    const r = computeSettlement(base({ leave: [el({ used_days: 20 })] }), rules);
    expect(line(r, 'LEAVE')).toBeUndefined();
    expect(r.warnings.map((w) => w.code)).toContain('LEAVE_NEGATIVE');
  });
  it('a recorded rule can recover it, or cap the days', () => {
    const r2 = { ...rules, 'settlement.leave': { max_days_at_exit: 5, recover_negative: true } };
    expect(line(computeSettlement(base({ leave: [el()] }), r2), 'LEAVE')).toMatchObject({ quantity: 5, amount: 5000 });
    expect(line(computeSettlement(base({ leave: [el({ used_days: 20 })] }), r2), 'LEAVE_NEGATIVE')).toMatchObject({ quantity: 6, amount: 6000, direction: 'recoverable' });
  });
});

describe('notice', () => {
  it('resignation: 30 required, 20 served, 10 short × 1,000 = 10,000 recovered', () => {
    const n = line(computeSettlement(base({ options: { notice_start: '2026-10-12' } }), rules), 'NOTICE');
    expect(n).toMatchObject({ direction: 'recoverable', quantity: 10, amount: 10000 });
  });
  it('the result does not change with the day it is computed: the old engine measured against today', () => {
    const a = computeSettlement(base(), rules);
    expect(line(a, 'NOTICE').quantity).toBe(0); // Oct 2 to Oct 31 = 30 days
  });
  it('termination pays in lieu instead', () => {
    const n = line(computeSettlement(base({ exit: { separation_type: 'termination' } }), rules), 'NOTICE');
    expect(n).toMatchObject({ direction: 'payable', quantity: 30, amount: 30000 });
  });
  it.each(['death', 'retirement', 'contract_expiry', 'disablement'])('%s has no notice amount', (t) => {
    expect(line(computeSettlement(base({ exit: { separation_type: t } }), rules), 'NOTICE').amount).toBe(0);
  });
  it('a waiver reduces it and is shown', () => {
    const n = line(computeSettlement(base({ options: { notice_start: '2026-10-12', waive_notice_days: 4, waive_reason: 'agreed by HR' } }), rules), 'NOTICE');
    expect(n).toMatchObject({ quantity: 6, amount: 6000 });
    expect(n.basis).toContain('agreed by HR');
  });
  it('no notice period on record: nothing assumed, and it warns. The old engine assumed 60 days', () => {
    const r = computeSettlement(base({ exit: { notice_period: null } }), rules);
    expect(line(r, 'NOTICE').amount).toBe(0);
    expect(r.warnings.map((w) => w.code)).toContain('NOTICE_DAYS_UNKNOWN');
  });
  it('falls back to the employee record', () => {
    const n = line(computeSettlement(base({ exit: { notice_period: null }, employee: { notice_period_days: 45 } }), rules), 'NOTICE');
    expect(n.quantity).toBe(15);
  });
  it('an unknown exit type warns', () => {
    expect(computeSettlement(base({ exit: { separation_type: 'General' } }), rules).warnings.map((w) => w.code)).toContain('SEPARATION_TYPE_UNKNOWN');
  });
});

describe('retrenchment compensation (§276)', () => {
  const retrench = (over = {}) => base({ ...over, exit: { separation_type: 'retrenchment', ...over.exit } });
  it('Apr 2020 to Oct 2026 = 6y 7m → 7 years × 15/26 × 26,000 = 1,05,000, beside gratuity', () => {
    const r = computeSettlement(retrench(), rules);
    expect(line(r, 'RETRENCHMENT')).toMatchObject({ quantity: 7, rate: 15000, amount: 105000 });
    expect(line(r, 'GRATUITY').amount).toBe(105000);
  });
  it('exactly 6 months over does not count: 6y 6m → 6 years = 90,000', () => {
    expect(line(computeSettlement(retrench({ exit: { last_working_date: '2026-09-30' } }), rules), 'RETRENCHMENT').amount).toBe(90000);
  });
  it('under one year of service is nil, with the reason', () => {
    const l = line(computeSettlement(retrench({ employee: { joining_date: '2026-01-01' } }), rules), 'RETRENCHMENT');
    expect(l.amount).toBe(0);
    expect(l.basis).toMatch(/1 needed/);
  });
  it('the re-skilling fund (15 days = 15,000) is a warning, not a line, and the worker test is flagged', () => {
    const r = computeSettlement(retrench(), rules);
    expect(r.warnings.find((w) => w.code === 'RESKILLING_FUND').message).toMatch(/15000 \(15 days' wages\)/);
    expect(r.warnings.map((w) => w.code)).toContain('RETRENCHMENT_WORKER');
    expect(r.lines.map((l) => l.code)).not.toContain('RESKILLING_FUND');
  });
  it('no line for any other exit type', () => {
    expect(line(computeSettlement(base(), rules), 'RETRENCHMENT')).toBeUndefined();
    expect(line(computeSettlement(base({ exit: { separation_type: 'termination' } }), rules), 'RETRENCHMENT')).toBeUndefined();
  });
  it('tax: only the part above Rs 5 lakh is taxable', () => {
    const taxOf = (income) => income;   // tax = taxable income, so the line shows what was counted
    const big = retrench({ wage: wage(260000) });   // 15/26 × 2,60,000 × 7 = 10,50,000
    const r = computeSettlement({ ...big, tax: { ytd_gross: 0, ytd_tds: 0, standard_deduction: 0, taxOf } }, rules);
    expect(line(r, 'RETRENCHMENT').amount).toBe(1050000);
    // Gratuity (also 10,50,000) is under its 20 lakh limit; retrenchment's taxable part is 5,50,000; plus notice pay in lieu.
    const notice = line(r, 'NOTICE').amount;
    expect(line(r, 'SETTLEMENT_TDS').amount).toBe(550000 + notice);
  });
});

describe('final wages and totals', () => {
  const slip = { gross: 40000, paid_days: 31, days_in_month: 31, lop_days: 0, employee_pf: 3120, employee_esi: 0, professional_tax: 200, lwf_employee: 0, tds: 1500 };
  it('salary, statutory deductions and TDS are separate lines', () => {
    const r = computeSettlement(base({ finalSlip: slip }), rules);
    expect(line(r, 'FINAL_SALARY').amount).toBe(40000);
    expect(line(r, 'FINAL_STATUTORY').amount).toBe(3320);
    expect(line(r, 'FINAL_TDS').amount).toBe(1500);
  });
  it('a month already in an approved payroll run is not paid twice', () => {
    const r = computeSettlement(base({ finalSlip: slip, finalRun: { id: 9, status: 'approved' } }), rules);
    expect(line(r, 'FINAL_SALARY').amount).toBe(0);
    expect(line(r, 'FINAL_TDS')).toBeUndefined();
  });
  it('a draft run warns that approving it would pay twice', () => {
    const r = computeSettlement(base({ finalSlip: slip, finalRun: { id: 9, status: 'pending' } }), rules);
    expect(line(r, 'FINAL_SALARY').amount).toBe(40000);
    expect(r.warnings.map((w) => w.code)).toContain('FINAL_RUN_DRAFT');
  });
  it('net = payable − recoverable, including loans and advances', () => {
    // salary 40,000 + gratuity 1,05,000 = 1,45,000. Recover 3,320 + 1,500 + 5,000 + 2,000 = 11,820. Net 1,33,180.
    const r = computeSettlement(base({ finalSlip: slip, loans: [{ id: 1, loan_type: 'Salary advance', outstanding_balance: 5000 }], advanceOutstanding: 2000 }), rules);
    expect(r).toMatchObject({ total_payable: 145000, total_recoverable: 11820, net_payable: 133180 });
  });
  it('an employee who owes more than is due is flagged', () => {
    const r = computeSettlement(base({ employee: { joining_date: '2026-01-01' }, loans: [{ id: 1, outstanding_balance: 9000 }] }), rules);
    expect(r.net_payable).toBe(-9000);
    expect(r.warnings.map((w) => w.code)).toContain('EMPLOYEE_OWES');
  });
  it('no salary on record warns, and invents nothing', () => {
    const r = computeSettlement(base({ wage: null }), rules);
    expect(r.net_payable).toBe(0);
    expect(r.warnings.map((w) => w.code)).toContain('SALARY_MISSING');
  });
  it('the invented PF balance and TDS on PF are gone', () => {
    expect(JSON.stringify(computeSettlement(base(), rules))).not.toMatch(/pf_balance|tds_on_pf|tds_on_fnf/i);
  });
});

describe('inputs HR decides', () => {
  it('a forfeiture reason makes gratuity nil and is shown', () => {
    const g = line(computeSettlement(base({ options: { forfeit_gratuity_reason: 'Dismissed for theft, order 12' } }), rules), 'GRATUITY');
    expect(g.amount).toBe(0);
    expect(g.basis).toContain('order 12');
  });
  it('a disqualification reason makes bonus nil and is shown', () => {
    const b = line(computeSettlement(base({ wage: wage(18000), options: { bonus_disqualified_reason: 'Fraud finding' } }), rules), 'BONUS');
    expect(b.amount).toBe(0);
    expect(b.basis).toContain('Fraud finding');
  });
  it('an agreed asset value is recovered, with its reason', () => {
    const a = line(computeSettlement(base({ options: { asset_recovery_amount: 4500, asset_recovery_reason: 'Laptop not returned' } }), rules), 'ASSET_RECOVERY');
    expect(a).toMatchObject({ amount: 4500, direction: 'recoverable' });
  });
});

describe('TDS on the whole settlement', () => {
  // New regime slabs: to 4L nil; 4-8L 5% = 20,000; 8-12L 10% = 40,000; 12-16L 15% = 60,000; 16-20L 20% = 80,000. Sum 2,00,000.
  const taxOf = (income) => computeIncomeTax(income, 'new', { ...resolveRules('2026-11-01').values['tax.new'] });
  const tax = (o) => ({ ytd_gross: 2035000, ytd_tds: 100000, standard_deduction: 75000, taxOf, ...o });
  it('tax on 20,00,000 is 2,00,000 + 4% cess = 2,08,000; less 1,00,000 already deducted = 1,08,000', () => {
    // 20,35,000 paid + 1,05,000 gratuity (exempt) + 40,000 salary − 75,000 standard = 20,00,000
    const slip = { gross: 40000, paid_days: 31, days_in_month: 31, employee_pf: 0, employee_esi: 0, professional_tax: 0, lwf_employee: 0, tds: 999 };
    const r = computeSettlement(base({ finalSlip: slip, tax: undefined }), rules);
    void r;
    const t = computeSettlement({ ...base({ finalSlip: slip }), tax: tax() }, rules);
    expect(line(t, 'SETTLEMENT_TDS').amount).toBe(108000);
    expect(line(t, 'FINAL_TDS')).toBeUndefined();
  });
  it('gratuity above the limit is taxed: 1,05,000 with a 5,000 limit adds 1,00,000 of income', () => {
    const r2 = { ...rules, 'settlement.tax': { ...rules['settlement.tax'], gratuity_exempt_limit: 5000 } };
    const t = computeSettlement({ ...base(), tax: tax({ ytd_gross: 1975000, ytd_tds: 0 }) }, r2);
    expect(line(t, 'SETTLEMENT_TDS').basis).toContain('Tax on 2000000');
    expect(line(t, 'SETTLEMENT_TDS').amount).toBe(208000);
  });
  it('leave is exempt within the limit on resignation, and fully taxable on an exit not listed', () => {
    const el = { leave_name: 'EL', year: 2026, opening_balance: 10 };
    const go = (sep) => computeSettlement({ ...base({ leave: [el], exit: { separation_type: sep } }), tax: tax({ ytd_gross: 75000, ytd_tds: 0 }) }, rules);
    expect(line(go('resignation'), 'SETTLEMENT_TDS').basis).toContain('including 0 taxable');
    expect(line(go('absconding'), 'SETTLEMENT_TDS').basis).toContain('including 10000 taxable');
  });
  it('tax already deducted above what is due never turns into a negative line', () => {
    expect(line(computeSettlement({ ...base(), tax: tax({ ytd_tds: 9000000 }) }, rules), 'SETTLEMENT_TDS').amount).toBe(0);
  });
  it('below the rebate limit there is no tax', () => {
    expect(line(computeSettlement({ ...base(), tax: tax({ ytd_gross: 500000, ytd_tds: 0 }) }, rules), 'SETTLEMENT_TDS').amount).toBe(0);
  });
});

describe('recording a rule', () => {
  const v = { wage_eligibility: 21000, calculation_wage: 7000, rate_pct: 8.33, max_pct: 20, min_days: 30 };
  it('takes a complete value', () => {
    expect(settlementRuleProblem('settlement.bonus', { ...v, rate_pct: 10 })).toBeNull();
    expect(settlementRuleProblem('settlement.gl', { salary_expense: '5100', leave_expense: null, bonus_expense: null, gratuity_expense: null, notice_recovery_income: null, asset_recovery_income: null, statutory_payable: null, tds_payable: null, loan_receivable: null, advance_receivable: null, retrenchment_expense: null })).toBeNull();
  });
  it('a version recorded before a field existed reads the new field as empty (§276)', () => {
    const old = { salary_expense: '5010', leave_expense: '5010', bonus_expense: '5013', gratuity_expense: '5015', notice_recovery_income: '4005',
      asset_recovery_income: '4005', statutory_payable: '2030', tds_payable: '2003', loan_receivable: '1013', advance_receivable: '1013' };
    const { values, applied } = resolveSettlementRules('2026-11-01', [{ rule_key: 'settlement.gl', effective_from: '2025-11-21', value: old, company_id: 1, source_reference: 'x' }]);
    expect(values['settlement.gl']).toEqual({ ...old, retrenchment_expense: null });
    expect(applied['settlement.gl'].status).toBe('confirmed');
    expect(settlementRuleProblem('settlement.gl', values['settlement.gl'])).toBeNull();
  });
  it('refuses a missing field, an extra field, text for a number and a negative', () => {
    const { rate_pct, ...short } = v;
    void rate_pct;
    expect(settlementRuleProblem('settlement.bonus', short)).toMatch(/Missing: rate_pct/);
    expect(settlementRuleProblem('settlement.bonus', { ...v, x: 1 })).toMatch(/Not part/);
    expect(settlementRuleProblem('settlement.bonus', { ...v, rate_pct: '8' })).toMatch(/must be a number/);
    expect(settlementRuleProblem('settlement.bonus', { ...v, rate_pct: -1 })).toMatch(/must be a number/);
    expect(settlementRuleProblem('settlement.nope', v)).toMatch(/Unknown/);
  });
});

describe('rules', () => {
  it('every built-in is unconfirmed until someone records a version, and the settlement says so', () => {
    const { applied } = resolveSettlementRules('2026-11-01');
    expect(unconfirmedRules(applied).map((r) => r.key).sort()).toEqual([...SETTLEMENT_RULE_KEYS].sort());
  });
  it('a recorded version wins and counts as confirmed; a company version beats a global one', () => {
    const rows = [
      { rule_key: 'settlement.bonus', effective_from: '2026-04-01', company_id: null, source_reference: 'global', value: { ...rules['settlement.bonus'], rate_pct: 10 } },
      { rule_key: 'settlement.bonus', effective_from: '2026-04-01', company_id: 1, source_reference: 'adviser letter', value: { ...rules['settlement.bonus'], rate_pct: 12 } },
    ];
    const { values, applied } = resolveSettlementRules('2026-11-01', rows);
    expect(values['settlement.bonus'].rate_pct).toBe(12);
    expect(unconfirmedRules(applied).map((r) => r.key)).not.toContain('settlement.bonus');
    expect(resolveSettlementRules('2026-03-31', rows).values['settlement.bonus'].rate_pct).toBe(8.33);
  });
  it('none of them can block payroll approval', () => {
    for (const k of SETTLEMENT_RULE_KEYS) expect(RULE_KEYS).not.toContain(k);
  });
});
