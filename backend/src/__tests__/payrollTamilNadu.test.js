/**
 * Tamil Nadu statutory configuration — PAYROLL_DATA_FLOW_AUDIT.md Part 7.
 * Synthetic employees; the release gate runs against a stub client (no DB).
 *
 * Sources: TN Urban Local Bodies Rules 2023 r.275(2) table and r.277(2)
 * (deduction in the August and January pay bills); G.O. Ms. No. 161 of
 * 2-Dec-2022 (LWF r.11-A: ₹20 employee / ₹40 employer).
 */
import { describe, it, expect } from 'vitest';
import { computePayroll, computePT, computeLWF } from '../modules/payroll/payrollEngine.js';
import { resolveRules, halfYearPtProblems } from '../modules/payroll/statutoryRules.js';
import { releaseReadiness } from '../modules/payroll/payrollReleaseGate.js';

const STANDARD = [
  { name: 'Basic', type: 'earning', value: 40, calculation_type: 'percentage_of_ctc' },
  { name: 'HRA', type: 'earning', value: 40, calculation_type: 'percentage_of_basic' },
  { name: 'Conveyance', type: 'earning', value: 1600, calculation_type: 'fixed' },
  { name: 'Medical', type: 'earning', value: 1250, calculation_type: 'fixed' },
  { name: 'Special Allowance', type: 'earning', value: 0, calculation_type: 'balancing' },
];
const pt = (date) => resolveRules(date).values['pt.slabs'];
const TN = 'Tamil Nadu';

describe('Tamil Nadu professional tax — half-yearly, urban local bodies', () => {
  it('the Rules 2023 table on half-year income (6 × monthly gross)', () => {
    const s = pt('2026-08-31');
    const at = (monthly) => computePT(monthly, TN, s, 8, { fullMonth: monthly });
    expect(at(3500)).toBe(0);       // 21,000 — "Upto Rs. 21,000/- Nil"
    expect(at(3501)).toBe(135);     // 21,006
    expect(at(5000)).toBe(135);     // 30,000
    expect(at(7500)).toBe(315);     // 45,000
    expect(at(10000)).toBe(690);    // 60,000
    expect(at(12500)).toBe(1025);   // 75,000
    expect(at(12501)).toBe(1250);
    expect(at(75000)).toBe(1250);
  });

  it('deducted only in the August and January pay bills — ₹2,500 a year at the top slab', () => {
    const s = pt('2026-08-31');
    const months = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map(m => computePT(75000, TN, s, m, { fullMonth: 75000 }));
    expect(months).toEqual([0, 0, 0, 0, 1250, 0, 0, 0, 0, 1250, 0, 0]);
  });

  it('only a person engaged on the first day of the half-year is liable', () => {
    const s = pt('2027-01-31');
    const o = (joiningDate, month, year) => computePT(75000, TN, s, month, { fullMonth: 75000, joiningDate, year });
    expect(o('2026-04-01', 8, 2026)).toBe(1250);   // in service on 1 April
    expect(o('2026-04-02', 8, 2026)).toBe(0);      // joined after 1 April → nothing for Apr–Sep
    expect(o('2026-04-02', 1, 2027)).toBe(1250);   // in service on 1 October → Oct–Mar
    expect(o('2026-10-02', 1, 2027)).toBe(0);
  });

  it('a Tamil Nadu payslip carries PT in August only; Karnataka is unchanged', () => {
    const emp = { id: 1, office_id: 'EMPTN', basic_salary: 30000, joining_date: '2024-04-01', state: TN };
    const run = (m, y, e = emp) => computePayroll(e, { month: m, year: y, rules: resolveRules(`${y}-${String(m).padStart(2, '0')}-28`).values, structureComponents: STANDARD, tds_auto_calculate: false });
    expect(run(8, 2026).professional_tax).toBe(1250);
    expect(run(9, 2026).professional_tax).toBe(0);
    expect(run(10, 2026).professional_tax).toBe(0);
    expect(run(10, 2026, { ...emp, state: 'Karnataka' }).professional_tax).toBe(200);
  });

  it('old-regime TDS counts the PT actually levied in the year (₹2,500)', () => {
    const s = pt('2026-08-31');
    const year = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].reduce((t, m) => t + computePT(75000, TN, s, m), 0);
    expect(year).toBe(2500);
  });
});

describe('Tamil Nadu labour welfare fund', () => {
  it('₹20 employee + ₹40 employer once a year (December) from 2-Dec-2022', () => {
    const r = resolveRules('2026-12-31').values['lwf.rates'];
    expect(computeLWF(TN, 12, r)).toEqual({ lwf_employee: 20, lwf_employer: 40 });
    expect(computeLWF(TN, 9, r)).toEqual({ lwf_employee: 0, lwf_employer: 0 });
    expect(computeLWF(TN, 3, r)).toEqual({ lwf_employee: 0, lwf_employer: 0 });
  });
});

describe('release gate — statutory jurisdiction', () => {
  // A stub client answering the gate's queries.
  const client = (settings, empStates, companyState = TN, { gstin = null, ruleRows = [] } = {}) => ({
    async query(sql) {
      if (/FROM company_settings/.test(sql)) return { rows: [{ settings }] };
      if (/SELECT state, gstin FROM companies/.test(sql)) return { rows: [{ state: companyState, gstin }] };
      if (/FROM payroll_runs pr/.test(sql)) return { rows: empStates.map((state, i) => ({ office_id: `EMP00${i + 1}`, state })) };
      if (/FROM payroll_statutory_rules/.test(sql)) return { rows: ruleRows };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  });
  const base = { pay_day_of_month: 25, payroll_cutoff_day: 20 };
  const codes = async (settings, states, companyState = TN, extra = {}) =>
    (await releaseReadiness({ company_id: 1, month: 11, year: 2026, client: client({ ...base, ...settings }, states, companyState, extra) })).blockers.map(b => b.code);
  const gate = async (settings, states, extra = {}) =>
    releaseReadiness({ company_id: 1, month: 11, year: 2026, client: client({ ...base, ...settings }, states, TN, extra) });

  // A company-recorded panchayat table: a synthetic shape fixture, NOT real rates.
  const PANCHAYAT = {
    basis: 'half_year', deduct_months: [9, 3], local_body: 'village_panchayat', local_body_name: 'Test Panchayat',
    slabs: [{ min: 0, max: 10000, pt: 0 }, { min: 10001, max: null, pt: 7 }],
  };
  const ptRow = (TNvalue) => ({ rule_key: 'pt.slabs', company_id: 1, effective_from: '2026-04-01', value: { TN: TNvalue }, source_reference: 'test fixture' });
  const VP = { statutory_state: TN, pt_local_body: 'village_panchayat', pt_local_body_name: 'Test Panchayat' };

  // Gate queries answered with these draft rows instead of the employee states.
  const withDrafts = (settings, drafts, ruleRows = []) => {
    const inner = client({ ...base, ...settings }, [TN], TN, { ruleRows });
    return { async query(sql) { return /pr\.status = 'pending'/.test(sql) ? { rows: drafts } : inner.query(sql); } };
  };
  const TN_OK = { statutory_state: TN, pt_local_body: 'municipality' };
  const at = (settings, drafts, ruleRows) => releaseReadiness({ company_id: 1, month: 11, year: 2026, client: withDrafts(settings, drafts, ruleRows) });

  it('a TN company is told what to confirm for TN, not about Karnataka', async () => {
    const { blockers } = await gate(TN_OK, [TN]);
    const pt = blockers.find(b => b.key === 'pt.slabs'), lwf = blockers.find(b => b.key === 'lwf.rates');
    expect(pt.state).toBe('TN');
    expect(pt.message).toMatch(/council/);
    expect(pt.message).not.toMatch(/Karnataka|KA:/);
    expect(lwf.message).toMatch(/Rule 12 was NOT read/);
    expect(lwf.message).not.toMatch(/KLWB/);
  });

  it('every rule blocker says which date to record it on', async () => {
    const { blockers } = await gate(TN_OK, [TN]);
    const rule = blockers.filter(b => b.code.startsWith('RULE_'));
    expect(rule.length).toBeGreaterThan(0);
    for (const b of rule) expect(b.record_from, b.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a confirmation recorded on that date clears the blocker and changes no value', async () => {
    const { blockers } = await gate(TN_OK, [TN]);
    const b = blockers.find(x => x.key === 'lwf.rates');
    const ruleRows = [{ rule_key: b.key, company_id: 1, effective_from: b.record_from, value: b.value, source_reference: 'source' }];
    const after = await gate(TN_OK, [TN], { ruleRows });
    expect(after.blockers.some(x => x.key === 'lwf.rates')).toBe(false);
    expect(resolveRules('2026-11-30', ruleRows).values['lwf.rates']).toEqual(b.value);
  });

  // Surcharge and the old-regime senior slabs are computed since 2026-11-09
  // (payrollGoLiveEngine.test.js): such a draft no longer blocks approval.
  it('income above ₹50L and old-regime seniors no longer block: the engine computes them', async () => {
    const over = await at(TN_OK, [{ office_id: 'EMP038', annual_taxable_income: '5000001.00', tax_regime: 'new' }]);
    expect(over.blockers.some(b => b.code === 'TAX_NOT_MODELLED')).toBe(false);
    const senior = await at(TN_OK, [{ office_id: 'EMP002', annual_taxable_income: '900000', tax_regime: 'old', dob: '1966-11-30' }]);
    expect(senior.blockers.some(b => b.code === 'TAX_NOT_MODELLED')).toBe(false);
  });

  it('a rule change after the draft blocks; a confirmation of the same value does not', async () => {
    const drafts = [{ office_id: 'EMP001', generated_at: '2026-11-05T10:00:00Z', annual_taxable_income: '900000', tax_regime: 'new' }];
    const row = (value, created_at) => ({ rule_key: 'esi.wage_basis', company_id: 1, effective_from: '2025-11-21', value, source_reference: 'x', created_at });
    const code = async (rows) => (await at(TN_OK, drafts, rows)).blockers.some(b => b.code === 'DRAFT_PREDATES_RULE');
    expect(await code([row('code_wages', '2026-11-05T11:00:00Z')])).toBe(true);   // changed, after the draft
    expect(await code([row('code_wages', '2026-11-05T09:00:00Z')])).toBe(false);  // changed, before the draft
    expect(await code([row('gross', '2026-11-05T11:00:00Z')])).toBe(false);       // same value: no figure moves
    // Dated into the month but equal to what the period already used: no figure moves.
    const ceiling = { rule_key: 'pf.wage_ceiling', company_id: 1, effective_from: '2026-09-01', value: 25000, source_reference: 'x', created_at: '2026-11-05T11:00:00Z' };
    expect(await code([ceiling])).toBe(false);
    // jsonb reorders keys: a recorded table is the same table.
    const { values } = resolveRules('2025-04-15');
    const reorder = (v) => Object.fromEntries(Object.keys(v).reverse().map(k => [k, v[k]]));
    const lwf = { rule_key: 'lwf.rates', company_id: 1, effective_from: '2025-01-10', value: reorder(values['lwf.rates']), source_reference: 'x', created_at: '2026-11-05T11:00:00Z' };
    expect(await code([lwf])).toBe(false);
  });

  it('company state must match the state its GSTIN is registered in', async () => {
    expect(await codes({ statutory_state: TN, pt_local_body: 'municipality' }, [TN], TN, { gstin: '29AABCM1234A1Z5' })).toContain('COMPANY_GSTIN_STATE');
    expect(await codes({ statutory_state: TN, pt_local_body: 'municipality' }, [TN], TN, { gstin: '33AABCM1234A1Z5' })).not.toContain('COMPANY_GSTIN_STATE');
    expect(await codes({ statutory_state: TN, pt_local_body: 'municipality' }, [TN], TN)).not.toContain('COMPANY_GSTIN_STATE');   // no GSTIN: nothing to compare
  });

  it('a village panchayat without a recorded table stays blocked — the built-in URBAN table is never used', async () => {
    const r = await gate(VP, [TN]);
    const b = r.blockers.find(x => x.code === 'PT_LOCAL_BODY');
    expect(b.problems.join(' ')).toMatch(/no company pt\.slabs version/);
    expect(b.message).toMatch(/POST \/payroll\/statutory-rules/);
  });

  it('a recorded table that does not declare itself as that panchayat’s is refused', async () => {
    const { local_body: _lb, ...undeclared } = PANCHAYAT;
    void _lb;
    expect(await codes(VP, [TN], TN, { ruleRows: [ptRow(undeclared)] })).toContain('PT_LOCAL_BODY');
    expect(await codes({ ...VP, pt_local_body_name: 'Another Panchayat' }, [TN], TN, { ruleRows: [ptRow(PANCHAYAT)] })).toContain('PT_LOCAL_BODY');
    expect(await codes({ ...VP, pt_local_body_name: '' }, [TN], TN, { ruleRows: [ptRow(PANCHAYAT)] })).toContain('PT_LOCAL_BODY');
    const { deduct_months: _dm, ...noMonths } = PANCHAYAT;
    void _dm;
    expect(await codes(VP, [TN], TN, { ruleRows: [ptRow(noMonths)] })).toContain('PT_LOCAL_BODY');
  });

  it('a complete, declared panchayat table clears the local-body blocker — other blockers remain', async () => {
    const c = await codes(VP, [TN], TN, { ruleRows: [ptRow(PANCHAYAT)] });
    expect(c).not.toContain('PT_LOCAL_BODY');
    expect(c).toEqual(expect.arrayContaining(['RULE_DECISION', 'RULE_UNVERIFIED']));
  });

  it('an urban body may not run on a table declared for a panchayat', async () => {
    expect(await codes({ statutory_state: TN, pt_local_body: 'municipality' }, [TN], TN, { ruleRows: [ptRow(PANCHAYAT)] })).toContain('PT_LOCAL_BODY');
  });

  it('the engine applies a recorded panchayat table in its own months', () => {
    const s = { TN: PANCHAYAT };
    expect(computePT(5000, TN, s, 9, { fullMonth: 5000 })).toBe(7);    // half-year 30,000
    expect(computePT(5000, TN, s, 8, { fullMonth: 5000 })).toBe(0);    // August is an URBAN month, not this table's
  });

  it('rule recording refuses an incomplete half-yearly table', () => {
    expect(halfYearPtProblems(PANCHAYAT)).toEqual([]);
    expect(halfYearPtProblems({ ...PANCHAYAT, deduct_months: [] }).join()).toMatch(/deduct_months/);
    expect(halfYearPtProblems({ ...PANCHAYAT, slabs: [{ min: 0, max: 10000, pt: 0 }, { min: 10005, max: null, pt: 7 }] }).join()).toMatch(/must start at 10001/);
    expect(halfYearPtProblems({ ...PANCHAYAT, slabs: [{ min: 0, max: 100, pt: -1 }, { min: 101, max: 5, pt: 1 }] }).length).toBeGreaterThan(0);
  });

  it('blocks until the state is recorded', async () => {
    expect(await codes({}, [TN])).toContain('JURISDICTION_UNCONFIRMED');
  });

  it('blocks when employees resolve to another state (e.g. a TN company still recorded as Karnataka)', async () => {
    const c = await codes({ statutory_state: TN, pt_local_body: 'municipality' }, ['Karnataka', 'Karnataka']);
    expect(c).toContain('JURISDICTION_MISMATCH');
    expect(c).not.toContain('JURISDICTION_UNCONFIRMED');
  });

  it('in Tamil Nadu, needs an urban local body; a village panchayat stays blocked', async () => {
    expect(await codes({ statutory_state: TN }, [TN])).toContain('PT_LOCAL_BODY');
    expect(await codes({ statutory_state: TN, pt_local_body: 'village_panchayat' }, [TN])).toContain('PT_LOCAL_BODY');
    const ok = await codes({ statutory_state: TN, pt_local_body: 'municipality', pt_local_body_name: 'Srivilliputhur Municipality' }, [TN, 'TN']);
    expect(ok.filter(c => c.startsWith('JURISDICTION') || c === 'PT_LOCAL_BODY')).toEqual([]);
  });

  it('the Setup Wizard PT state must agree with the recorded jurisdiction — it is never copied', async () => {
    expect(await codes({ statutory_state: TN, pt_local_body: 'municipality', pt: { state: 'Karnataka', enabled: true } }, [TN])).toContain('JURISDICTION_CONFLICT');
    expect(await codes({ statutory_state: TN, pt_local_body: 'municipality', pt: { state: TN, enabled: true } }, [TN])).not.toContain('JURISDICTION_CONFLICT');
    // a wizard value alone does not confirm anything
    expect(await codes({ pt: { state: TN, enabled: true } }, [TN])).toContain('JURISDICTION_UNCONFIRMED');
  });

  it('the unconfirmed message names the current company and wizard states and where to fix them', async () => {
    const r = await releaseReadiness({ company_id: 1, month: 11, year: 2026,
      client: client({ ...base, pt: { state: TN, enabled: true } }, ['Karnataka'], 'Karnataka') });
    const b = r.blockers.find(x => x.code === 'JURISDICTION_UNCONFIRMED');
    expect(b).toMatchObject({ company_state: 'Karnataka', wizard_pt_state: TN });
    expect(b.message).toMatch(/company record "Karnataka", Setup Wizard PT state "Tamil Nadu"/);
    expect(b.message).toMatch(/Company Profile → State/);
  });

  it('employees resolve exactly as the engine does — a top-level payroll "state" setting overrides branch/company', async () => {
    expect(await codes({ statutory_state: TN, pt_local_body: 'municipality', state: 'Karnataka' }, [TN])).toContain('JURISDICTION_MISMATCH');
    expect(await codes({ statutory_state: TN, pt_local_body: 'municipality', state: TN }, ['Karnataka'])).not.toContain('JURISDICTION_MISMATCH');
  });

  it('rule blockers still apply after the jurisdiction is settled', async () => {
    const c = await codes({ statutory_state: TN, pt_local_body: 'municipality' }, [TN]);
    expect(c).toEqual(expect.arrayContaining(['RULE_UNVERIFIED', 'RULE_DECISION']));
  });
});
