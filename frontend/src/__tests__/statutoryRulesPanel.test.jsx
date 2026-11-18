import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import StatutoryRulesPanel from '../features/hr/components/payroll/StatutoryRulesPanel';
import api from '@/services/api/client';

let canEdit = true;
vi.mock('@/services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => canEdit }) }));

const TAX = {
  slabs: [{ min: 0, max: 400000, rate: 0 }, { min: 400000, max: 800000, rate: 0.05 }, { min: 800000, max: null, rate: 0.1 }],
  standard_deduction: 75000, rebate_limit: 1200000, rebate_max: 60000, marginal_relief: true, cess_pct: 4,
};
const PT = {
  KA: [{ min: 0, max: 24999, pt: 0 }, { min: 25000, max: null, pt: 200, month_pt: { 2: 300 } }],
  TN: { basis: 'half_year', deduct_months: [8, 1], slabs: [{ min: 0, max: 21000, pt: 0 }, { min: 21001, max: null, pt: 135 }] },
};
const LWF = { KA: { employee: 50, employer: 100, months: [12] }, TN: { employee: 20, employer: 40, months: [12] } };
const RESOLVED = {
  'pf.employee_rate': 12, 'pf.employer_rate': 12, 'pf.eps_rate': 8.33, 'pf.wage_ceiling': 25000, 'pf.wage_floor_pct': 50,
  'pf.wage_floor_basis': 'gross_excl_employer_contributions', 'pf.eps_age_limit': 58, 'esi.wage_threshold': 21000,
  'esi.wage_basis': 'gross', 'esi.employee_rate': 0.75, 'esi.employer_rate': 3.25, 'tax.new': TAX, 'tax.old': TAX,
  'ot.max_multiplier': 2, 'pt.slabs': PT, 'lwf.rates': LWF,
  'bonus.statutory': { wage_eligibility: 21000, calc_ceiling: 7000, min_pct: 8.33, max_pct: 20 },
  'bonus.plans': { plans: [{ name: 'Diwali', type: 'fixed', amount: 5000, months: [10], active: true }] },
};
const body = (over = {}) => ({
  resolved: RESOLVED,
  applied: Object.fromEntries(Object.keys(RESOLVED).map((k) => [k, { effective_from: '2025-04-15', source: 'Source', status: 'verified', origin: 'built-in' }])),
  built_in: Object.fromEntries(Object.keys(RESOLVED).map((k) => [k, [{
    effective_from: '2025-04-15', source: 'Source', value: RESOLVED[k],
    ...(k === 'esi.wage_basis' ? { options: ['gross', 'code_wages'] } : {}),
  }]])),
  custom_versions: [], jurisdiction: 'TN', state_gaps: {}, ...over,
});
const card = async (key) => {
  await screen.findByText('Provident Fund');
  const all = screen.queryByRole('button', { name: 'Open all' });
  if (all) fireEvent.click(all);
  return within(document.querySelector(`[data-rule="${key}"]`));
};
const saveWith = async (c, source = 'S.O. 1') => {
  fireEvent.change(c.getByLabelText(/Source, such as/), { target: { value: source } });
  fireEvent.click(c.getByRole('button', { name: 'Save and confirm' }));
  await waitFor(() => expect(api.post).toHaveBeenCalled());
  return vi.mocked(api.post).mock.calls[0][1];
};

describe('StatutoryRulesPanel', () => {
  beforeEach(() => {
    cleanup();
    canEdit = true;
    vi.mocked(api.get).mockReset().mockResolvedValue({ data: { data: body() } });
    vi.mocked(api.post).mockReset().mockResolvedValue({ data: {} });
  });

  it('a law change: new value, new date, sent as a number, then reloads', async () => {
    render(<StatutoryRulesPanel />);
    const c = await card('pf.wage_ceiling');
    fireEvent.change(c.getByLabelText(/Wage ceiling/), { target: { value: '30000' } });
    fireEvent.change(c.getByLabelText('Applies from'), { target: { value: '2027-04-01' } });
    const sent = await saveWith(c);
    expect(sent).toEqual({ rule_key: 'pf.wage_ceiling', effective_from: '2027-04-01', value: 30000, source_reference: 'S.O. 1' });
    // the panel also reads the pending rule changes on each load
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.filter((c) => c[0] === '/payroll/statutory-rules').length).toBe(2));
  });

  it('after saving, the inputs show the saved value, not the one from before', async () => {
    render(<StatutoryRulesPanel />);
    const c = await card('pf.wage_ceiling');
    fireEvent.change(c.getByLabelText(/Wage ceiling/), { target: { value: '30000' } });
    vi.mocked(api.get).mockResolvedValue({ data: { data: body({ resolved: { ...RESOLVED, 'pf.wage_ceiling': 30000 } }) } });
    await saveWith(c);
    await waitFor(() => expect(document.querySelector('[data-rule="pf.wage_ceiling"] input[type="number"]').value).toBe('30000'));
    expect(vi.mocked(api.get).mock.calls.filter((c) => c[0] === '/payroll/statutory-rules').length).toBe(2);
  });

  it('the date starts on the version in force, so saving corrects that version', async () => {
    render(<StatutoryRulesPanel />);
    const c = await card('esi.employee_rate');
    expect(c.getByLabelText('Applies from').value).toBe('2025-04-15');
  });

  it('warns when the date is earlier than the version in force', async () => {
    render(<StatutoryRulesPanel />);
    const c = await card('esi.employee_rate');
    expect(c.queryByText(/stays in force/)).toBeNull();
    fireEvent.change(c.getByLabelText('Applies from'), { target: { value: '2024-01-01' } });
    expect(c.getByText(/stays in force/)).toBeDefined();
  });

  it('LWF edits the company state only; other states are sent unchanged', async () => {
    render(<StatutoryRulesPanel />);
    const c = await card('lwf.rates');
    fireEvent.change(c.getByLabelText(/Wage months/), { target: { value: '6' } });
    const sent = await saveWith(c);
    expect(sent.value).toEqual({ KA: LWF.KA, TN: { employee: 20, employer: 40, months: [6] } });
  });

  it('half-yearly PT keeps its shape, and band minimums follow the upper limits', async () => {
    render(<StatutoryRulesPanel />);
    const c = await card('pt.slabs');
    fireEvent.change(c.getByLabelText('Band 1 up to'), { target: { value: '25000' } });
    const sent = await saveWith(c);
    expect(sent.value.TN).toEqual({ basis: 'half_year', deduct_months: [8, 1], slabs: [{ min: 0, max: 25000, pt: 0 }, { min: 25001, max: null, pt: 135 }] });
    expect(sent.value.KA).toEqual(PT.KA);
  });

  it('a monthly state keeps a one-month rate the inputs do not show', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: body({ jurisdiction: 'KA' }) } });
    render(<StatutoryRulesPanel />);
    const c = await card('pt.slabs');
    fireEvent.change(c.getByLabelText('Band 2 Tax (₹)'), { target: { value: '250' } });
    const sent = await saveWith(c);
    expect(sent.value.KA).toEqual([{ min: 0, max: 24999, pt: 0 }, { min: 25000, max: null, pt: 250, month_pt: { 2: 300 } }]);
  });

  it('tax rates are entered in percent and stored as fractions; a new band goes before the last', async () => {
    render(<StatutoryRulesPanel />);
    const c = await card('tax.new');
    expect(c.getByLabelText('Band 2 Rate (%)').value).toBe('5');
    fireEvent.click(c.getByRole('button', { name: 'Add band' }));
    fireEvent.change(c.getByLabelText('Band 3 up to'), { target: { value: '1000000' } });
    fireEvent.change(c.getByLabelText('Band 3 Rate (%)'), { target: { value: '7.5' } });
    const sent = await saveWith(c);
    expect(sent.value.slabs).toEqual([
      { min: 0, max: 400000, rate: 0 }, { min: 400000, max: 800000, rate: 0.05 },
      { min: 800000, max: 1000000, rate: 0.075 }, { min: 1000000, max: null, rate: 0.1 },
    ]);
  });

  it('an emptied minimum wages share is sent as none; a decision sends its option', async () => {
    render(<StatutoryRulesPanel />);
    const floor = await card('pf.wage_floor_pct');
    fireEvent.change(floor.getByLabelText(/empty = none/), { target: { value: '' } });
    expect((await saveWith(floor)).value).toBeNull();
    vi.mocked(api.post).mockClear();
    const basis = await card('esi.wage_basis');
    fireEvent.change(basis.getByRole('combobox'), { target: { value: 'code_wages' } });
    expect((await saveWith(basis)).value).toBe('code_wages');
  });

  // The source is optional (owner decision, 9 Nov 2026): a blank one is sent
  // blank and the server records "No source given".
  it('saves without a source, and a refusal is shown', async () => {
    vi.mocked(api.post).mockRejectedValue({ response: { data: { message: 'esi.employee_rate must be a number from 0 to 100' } } });
    render(<StatutoryRulesPanel />);
    const c = await card('esi.employee_rate');
    expect(c.getByLabelText(/Source, such as.*\(optional\)/)).toBeTruthy();
    fireEvent.click(c.getByRole('button', { name: 'Save and confirm' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(vi.mocked(api.post).mock.calls[0][1]).toMatchObject({ rule_key: 'esi.employee_rate', source_reference: '' });
    await waitFor(() => expect(c.getByRole('alert').textContent).toMatch(/from 0 to 100/));
  });

  it('without the permission the values are read-only with no save', async () => {
    canEdit = false;
    render(<StatutoryRulesPanel />);
    const c = await card('pf.wage_ceiling');
    expect(c.getByLabelText(/Wage ceiling/).disabled).toBe(true);
    expect(c.queryByRole('button', { name: 'Save and confirm' })).toBeNull();
  });

  it('the CTC definition is an input: unrecorded until saved, and keeps what the inputs do not show', async () => {
    const value = {
      version: 'A2', include: { employer_pf: true, employer_esi: true, employer_lwf: true, gratuity: true },
      gratuity: { base: 'code_wages', from: 'joining', days_per_year: 15, divisor: 26 },
      rules_basis: 'effective_date', rounding: 'component_rupee', residual: 'report', maker_checker: true,
    };
    vi.mocked(api.get).mockResolvedValue({ data: { data: body({ ctc_policy: { value, origin: 'built-in', effective_from: '2025-04-01', source: 'Proposal' } }) } });
    render(<StatutoryRulesPanel />);
    const c = await card('ctc.definition');
    expect(c.getByText('Your decision')).toBeDefined();
    fireEvent.change(c.getByLabelText('A different person must approve'), { target: { value: 'false' } });
    fireEvent.change(c.getByLabelText(/Source, such as/), { target: { value: 'Finance approval 5 Nov' } });
    fireEvent.click(c.getByRole('button', { name: 'Save and confirm' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(vi.mocked(api.post).mock.calls[0][1]).toEqual({
      rule_key: 'ctc.definition', effective_from: '2025-04-01', value: { ...value, maker_checker: false }, source_reference: 'Finance approval 5 Nov',
    });
  });

  it('a bonus plan is added with its type, amount and months; existing plans stay', async () => {
    render(<StatutoryRulesPanel />);
    const c = await card('bonus.plans');
    expect(c.getByText('Company setting')).toBeDefined();
    fireEvent.click(c.getByRole('button', { name: 'Add plan' }));
    fireEvent.change(c.getByLabelText('Plan 2 name'), { target: { value: ' Annual ' } });
    fireEvent.change(c.getByLabelText('Plan 2 type'), { target: { value: 'pct_basic' } });
    fireEvent.change(c.getByLabelText('Plan 2 amount'), { target: { value: '8.33' } });
    fireEvent.change(c.getByLabelText('Plan 2 months'), { target: { value: '3, 10' } });
    fireEvent.change(c.getByLabelText('Plan 1 active'), { target: { value: 'false' } });
    const sent = await saveWith(c, 'Management note 1');
    expect(sent.rule_key).toBe('bonus.plans');
    expect(sent.value.plans).toEqual([
      // A plan saved before the final-settlement fields existed gets their defaults.
      { name: 'Diwali', type: 'fixed', amount: 5000, months: [10], active: false, prorate_on_exit: true, counts_as_statutory: true, min_service_months: 0 },
      { name: 'Annual', type: 'pct_basic', amount: 8.33, months: [3, 10], active: true, prorate_on_exit: true, counts_as_statutory: true, min_service_months: 0 },
    ]);
  });

  it('a bonus plan can refuse a leaver a share and need minimum service', async () => {
    render(<StatutoryRulesPanel />);
    const c = await card('bonus.plans');
    fireEvent.change(c.getByLabelText('Plan 1 share on leaving'), { target: { value: 'false' } });
    fireEvent.change(c.getByLabelText('Plan 1 minimum service'), { target: { value: '6' } });
    fireEvent.change(c.getByLabelText('Plan 1 counts as statutory'), { target: { value: 'false' } });
    const sent = await saveWith(c, 'Management note 2');
    expect(sent.value.plans[0]).toMatchObject({ prorate_on_exit: false, min_service_months: 6, counts_as_statutory: false });
  });

  it('a company setting dates from this month until one is recorded, and removing a plan sends the rest', async () => {
    render(<StatutoryRulesPanel />);
    const c = await card('bonus.plans');
    expect(c.getByLabelText('Applies from').value).toMatch(/^\d{4}-\d{2}-01$/);
    fireEvent.click(c.getByRole('button', { name: 'Remove' }));
    expect((await saveWith(c)).value).toEqual({ plans: [] });
  });

  it('the statutory bonus figures are numbers', async () => {
    render(<StatutoryRulesPanel />);
    const c = await card('bonus.statutory');
    fireEvent.change(c.getByLabelText(/Eligible up to wage/), { target: { value: '30000' } });
    expect((await saveWith(c)).value).toEqual({ wage_eligibility: 30000, calc_ceiling: 7000, min_pct: 8.33, max_pct: 20 });
  });

  it('the CTC definition saves without a source; so does a statutory rule', async () => {
    const value = { version: 'A2', include: {}, gratuity: {}, rules_basis: 'effective_date', residual: 'report', maker_checker: true };
    vi.mocked(api.get).mockResolvedValue({ data: { data: body({ ctc_policy: { value, origin: 'built-in', effective_from: '2025-04-01', source: 'Proposal' } }) } });
    render(<StatutoryRulesPanel />);
    const c = await card('ctc.definition');
    fireEvent.click(c.getByRole('button', { name: 'Save and confirm' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(vi.mocked(api.post).mock.calls[0][1]).toMatchObject({ rule_key: 'ctc.definition', source_reference: '' });
    vi.mocked(api.post).mockClear();
    const rule = await card('esi.employee_rate');
    fireEvent.click(rule.getByRole('button', { name: 'Save and confirm' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(vi.mocked(api.post).mock.calls[0][1]).toMatchObject({ rule_key: 'esi.employee_rate', source_reference: '' });
  });

  it('a rule recorded without a source says so', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: body({
      applied: { ...body().applied, 'esi.employee_rate': { effective_from: '2026-11-01', source: 'No source given', status: 'verified', origin: 'company' } } }) } });
    render(<StatutoryRulesPanel />);
    const c = await card('esi.employee_rate');
    expect(c.getByText('Recorded — no source given')).toBeTruthy();
  });

  it('with no jurisdiction recorded, state levies ask for it instead of guessing a state', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: body({ jurisdiction: null }) } });
    render(<StatutoryRulesPanel />);
    const c = await card('lwf.rates');
    expect(c.getByText(/Record the statutory jurisdiction/)).toBeDefined();
    expect(c.queryByRole('button', { name: 'Save and confirm' })).toBeNull();
  });
});

describe('StatutoryRulesPanel — surcharge kept, and changes awaiting a second person (2026-11-09)', () => {
  const SUR = [{ min: 5000000, rate: 10 }, { min: 10000000, rate: 15 }, { min: 20000000, rate: 25 }];
  beforeEach(() => {
    cleanup();
    canEdit = true;
    vi.mocked(api.post).mockReset().mockResolvedValue({ data: {} });
  });

  it('saving the tax slabs keeps the surcharge bands the inputs do not show', async () => {
    const withSur = body({ resolved: { ...RESOLVED, 'tax.new': { ...TAX, surcharge: SUR } } });
    vi.mocked(api.get).mockReset().mockResolvedValue({ data: { data: withSur } });
    render(<StatutoryRulesPanel />);
    const sent = await saveWith(await card('tax.new'));
    expect(sent.value.surcharge).toEqual(SUR);
  });

  it('a pending change is listed with Confirm and Reject, and confirming sends the decision', async () => {
    const pending = [{ id: 9, rule_key: 'pf.edli_rate', effective_from: '2027-01-01', value: 0.6, source_reference: 'EPFO circular', status: 'pending', proposed_by: 3, proposed_by_name: 'Asha' }];
    vi.mocked(api.get).mockReset().mockImplementation((url) => Promise.resolve({ data: { data: url.endsWith('/changes') ? pending : body() } }));
    render(<StatutoryRulesPanel />);
    const box = within(await screen.findByRole('region', { name: 'Rule changes awaiting a second person' }));
    expect(box.getByText(/proposed by Asha/)).toBeTruthy();
    fireEvent.click(box.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payroll/statutory-rules/changes/9/confirm', {}));
  });

  it('a save the server holds as a proposal says so', async () => {
    vi.mocked(api.get).mockReset().mockResolvedValue({ data: { data: body() } });
    vi.mocked(api.post).mockResolvedValue({ data: { pending: true } });
    render(<StatutoryRulesPanel />);
    await saveWith(await card('pf.wage_ceiling'));
    expect(await screen.findByText(/saved as a proposal/)).toBeTruthy();
  });
});

describe('StatutoryRulesPanel headings', () => {
  it('each group starts closed; its arrow opens the rules under it', async () => {
    vi.mocked(api.get).mockReset().mockResolvedValue({ data: { data: body() } });
    render(<StatutoryRulesPanel />);
    const pf = await screen.findByRole('button', { name: /Provident Fund/ });
    expect(pf).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('button', { name: 'Save and confirm' })).toHaveLength(0);
    fireEvent.click(pf);
    expect(pf).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('button', { name: 'Save and confirm' }).length).toBeGreaterThan(0);
  });
});
