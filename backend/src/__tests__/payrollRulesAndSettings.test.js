/**
 * Payroll source-of-truth units — PAYROLL_DATA_FLOW_AUDIT.md (2026-10-20):
 * settings normalisation (PT on vs off), pay-cycle semantics (pay day 25 vs
 * cutoff 29), the eligibility rule E1–E6, statutory-data validation, and the
 * effective-dated rule resolver.
 */
import { describe, it, expect } from 'vitest';
import { normalizePayrollSettings, normalizeForSave, validatePayCycle, payCycleFor } from '../modules/payroll/payrollSettings.js';
import { evaluateEligibility, validateStatutoryProfile, blockingIssues, isValidPAN, isValidTAN } from '../modules/payroll/payrollEligibility.js';
import { resolveRules, BUILT_IN_RULES } from '../modules/payroll/statutoryRules.js';

// Company 1's stored blob on 2026-10-20 (both screens' keys, disagreeing).
const LIVE = {
  pf: { enabled: true }, pt: { state: 'Tamil Nadu', enabled: true }, esi: { enabled: true },
  pay_day: 1, cutoff_day: 25, tds_auto: true, frequency: 'Monthly',
  pay_day_of_month: 25, payroll_cutoff_day: 29, professional_tax: false,
  pf_enabled: true, esi_enabled: true, tds_auto_calculate: true, round_net_pay: '1',
};

describe('payroll settings — one reading', () => {
  it('the Payroll Settings key wins and every disagreement is reported', () => {
    const { settings, conflicts } = normalizePayrollSettings(LIVE);
    expect(settings.professional_tax).toBe(false);
    expect(settings.pay_day_of_month).toBe(25);
    expect(settings.payroll_cutoff_day).toBe(29);
    expect(settings.round_net_pay).toBe(1);
    expect(conflicts.map(c => c.key).sort()).toEqual(['pay_day_of_month', 'payroll_cutoff_day', 'professional_tax']);
  });
  it('a wizard-only blob is still read (legacy key used when canonical is absent)', () => {
    const { settings } = normalizePayrollSettings({ pt: { enabled: false }, pay_day: 5 });
    expect(settings.professional_tax).toBe(false);
    expect(settings.pay_day_of_month).toBe(5);
  });
  it('saving writes both copies with the value this request changed', () => {
    const saved = normalizeForSave({ ...LIVE, professional_tax: true }, LIVE);
    expect(saved.professional_tax).toBe(true);
    expect(saved.pt.enabled).toBe(true);
    expect(normalizePayrollSettings(saved).conflicts.find(c => c.key === 'professional_tax')).toBeUndefined();
    // the wizard re-posting its own unchanged keys does not undo the canonical value
    const wizard = normalizeForSave({ pay_day: 1, cutoff_day: 25, pt: { enabled: true } }, LIVE);
    expect(wizard.pay_day_of_month).toBe(25);
    expect(wizard.pay_day).toBe(25);
  });
});

describe('pay cycle (audit item 9)', () => {
  const s = (o) => normalizePayrollSettings(o).settings;
  it('cutoff on/after pay day in a same-month cycle is invalid — the live 25 / 29', () => {
    expect(validatePayCycle(s({ pay_day_of_month: 25, payroll_cutoff_day: 29 }))[0]).toMatch(/Cutoff day \(29\) must be before pay day \(25\)/);
    expect(validatePayCycle(s({ pay_day_of_month: 25, payroll_cutoff_day: 20 }))).toEqual([]);
  });
  it('pay in the following month: any cutoff, pay day no later than the 7th', () => {
    expect(validatePayCycle(s({ pay_in_following_month: true, pay_day_of_month: 7, payroll_cutoff_day: 31 }))).toEqual([]);
    expect(validatePayCycle(s({ pay_in_following_month: true, pay_day_of_month: 10, payroll_cutoff_day: 31 }))[0]).toMatch(/7th/);
  });
  it('"overdue" keys off the PAY date, never the cutoff', () => {
    const cfg = s({ pay_day_of_month: 25, payroll_cutoff_day: 20 });
    expect(payCycleFor(cfg, 9, 2026, { today: new Date('2026-09-19T06:00:00Z') }).state).toBe('open');
    expect(payCycleFor(cfg, 9, 2026, { today: new Date('2026-09-22T06:00:00Z') }).state).toBe('cutoff_passed');
    expect(payCycleFor(cfg, 9, 2026, { today: new Date('2026-09-26T06:00:00Z') }).state).toBe('overdue');
    expect(payCycleFor(cfg, 9, 2026, { today: new Date('2026-09-26T06:00:00Z'), runStatus: 'paid' }).state).toBe('paid');
  });
  it('following-month pay date rolls into January for December', () => {
    const cfg = s({ pay_in_following_month: true, pay_day_of_month: 5, payroll_cutoff_day: 31 });
    expect(payCycleFor(cfg, 12, 2026, { today: new Date('2026-12-01') })).toMatchObject({ pay_date: '2027-01-05', attendance_cutoff_date: '2026-12-31' });
  });
});

describe('eligibility rule (audit items 1–3)', () => {
  const period = { start: '2026-09-01', end: '2026-09-30' };
  const ok = { status: 'Active', joining_date: '2026-01-01', revision_basic: '30000', structure_components: [{ name: 'Basic', type: 'earning' }] };
  const codes = (r) => evaluateEligibility(r, period).reasons.map(x => x.code);
  it('a current employee with a revision and a structure is eligible', () => {
    expect(evaluateEligibility(ok, period)).toEqual({ eligible: true, reasons: [] });
  });
  it('status alone is not enough — no revision → E5 (the 24 employees paid ₹2,850)', () => {
    expect(codes({ ...ok, revision_basic: null })).toEqual(['E5']);
    expect(codes({ ...ok, revision_basic: '0' })).toEqual(['E5']);
  });
  it('the employee master Basic is named in the reason but does not make anyone payable', () => {
    const r = evaluateEligibility({ ...ok, revision_basic: null, master_basic: '75000' }, period);
    expect(r.eligible).toBe(false);
    expect(r.reasons[0].message).toMatch(/Employee master shows Basic ₹75,000/);
  });
  it('E2 status, E3 joining, E4 exit, E6 structure, E1 deleted', () => {
    expect(codes({ ...ok, status: 'Left' })).toEqual(['E2']);
    expect(codes({ ...ok, joining_date: '2026-10-01' })).toEqual(['E3']);
    expect(codes({ ...ok, joining_date: null })).toEqual(['E3']);
    expect(codes({ ...ok, exit_date: '2026-08-31' })).toEqual(['E4']);
    expect(codes({ ...ok, exit_date: '2026-09-10' })).toEqual([]);
    expect(codes({ ...ok, structure_components: null })).toEqual(['E6']);
    expect(codes({ ...ok, deleted_at: '2026-09-01' })).toEqual(['E1']);
    expect(codes({ ...ok, status: 'notice' })).toEqual([]);
  });
});

describe('statutory data validation (audit item 11)', () => {
  const good = { pan_number: 'ABCDE1234F', account_number: '123456789012', ifsc_code: 'HDFC0001234', uan_number: '100200300400' };
  it('valid data has no issues', () => {
    expect(validateStatutoryProfile(good, { tds: 100, employee_pf: 1800 })).toEqual([]);
  });
  it("Anu's record (PAN 'adasd', IFSC '1231', account '12312', UAN '121') blocks approval", () => {
    const issues = validateStatutoryProfile({ pan_number: 'adasd', account_number: '12312', ifsc_code: '1231', uan_number: '121' }, { tds: 7205, employee_pf: 1800 });
    expect(blockingIssues(issues).map(i => i.field).sort()).toEqual(['account_number', 'ifsc_code', 'pan_number']);
    expect(issues.find(i => i.field === 'uan_number').severity).toBe('warning');
  });
  it('a missing PAN blocks only when TDS is deducted', () => {
    expect(blockingIssues(validateStatutoryProfile({ ...good, pan_number: null }, { tds: 0 }))).toEqual([]);
    expect(blockingIssues(validateStatutoryProfile({ ...good, pan_number: null }, { tds: 1 }))).toHaveLength(1);
  });
  it('PAN / TAN formats', () => {
    expect(isValidPAN('abcde1234f')).toBe(true);
    expect(isValidPAN('9808987809')).toBe(false);   // company 1's stored PAN
    expect(isValidTAN('BLRM12345A')).toBe(true);
    expect(isValidTAN(null)).toBe(false);
  });
});

describe('statutory rules are effective-dated (audit item 7)', () => {
  it('PF ceiling: ₹15,000 to 16-Sep-2026, ₹25,000 from 17-Sep-2026', () => {
    expect(resolveRules('2026-09-16').values['pf.wage_ceiling']).toBe(15000);
    expect(resolveRules('2026-09-17').values['pf.wage_ceiling']).toBe(25000);
    expect(resolveRules('2026-09-17').applied['pf.wage_ceiling'].source).toMatch(/5109/);
  });
  it('every built-in version cites a source', () => {
    for (const versions of Object.values(BUILT_IN_RULES)) for (const v of versions) expect(String(v.source || '').length).toBeGreaterThan(5);
  });
  it('same date: company beats global beats built-in; later dates beat earlier', () => {
    const db = [
      { rule_key: 'esi.wage_threshold', effective_from: '2027-01-01', value: 25000, company_id: null, source_reference: 'g' },
      { rule_key: 'esi.wage_threshold', effective_from: '2027-01-01', value: 26000, company_id: 7, source_reference: 'c' },
    ];
    expect(resolveRules('2026-12-31', db).values['esi.wage_threshold']).toBe(21000);
    expect(resolveRules('2027-01-01', db).values['esi.wage_threshold']).toBe(26000);
    expect(resolveRules('2027-01-01', db.slice(0, 1)).applied['esi.wage_threshold'].origin).toBe('global');
  });
});

describe('statutory verification status (primary-source pass, 2026-10-20)', () => {
  it('every built-in version declares a status and the evidence behind it', () => {
    for (const [key, versions] of Object.entries(BUILT_IN_RULES)) {
      for (const v of versions) {
        expect(['verified', 'unverified', 'decision_required'], key).toContain(v.status);
        expect(String(v.evidence || '').length, key).toBeGreaterThan(10);
      }
    }
  });
  it('the Gazette-verified PF ceilings are verified; unconfirmed tax parts are not', () => {
    const at = (d) => resolveRules(d).applied;
    expect(at('2026-09-30')['pf.wage_ceiling']).toMatchObject({ status: 'verified', effective_from: '2026-09-17' });
    expect(at('2026-08-31')['pf.wage_ceiling']).toMatchObject({ status: 'verified', effective_from: '2026-05-29' });
    expect(at('2026-09-30')['tax.new'].status).toBe('unverified');
    expect(at('2026-09-30')['pf.wage_floor_basis'].status).toBe('decision_required');
    expect(at('2026-09-30')['esi.wage_basis'].status).toBe('decision_required');
  });
  it('a recorded company version is a confirmation and wins on the same date', () => {
    const rows = [{ rule_key: 'tax.new', effective_from: '2025-04-01', value: BUILT_IN_RULES['tax.new'][0].value, company_id: 1, source_reference: 'CBDT ref' }];
    expect(resolveRules('2026-09-30', rows).applied['tax.new']).toMatchObject({ origin: 'company', status: 'verified' });
  });
});
