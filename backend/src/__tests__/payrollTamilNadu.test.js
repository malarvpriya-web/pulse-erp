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
