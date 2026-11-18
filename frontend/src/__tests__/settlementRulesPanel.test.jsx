import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettlementRulesPanel from '../features/hr/pages/SettlementRulesPanel';
import api from '../services/api/client';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const RULES = [
  { key: 'settlement.bonus', status: 'unverified', effective_from: '2025-11-21', source: 'S.O. 4710(E)', value: { wage_eligibility: 21000, calculation_wage: 7000, rate_pct: 8.33, max_pct: 20, min_days: 30 } },
  { key: 'settlement.gl', status: 'decision_required', effective_from: '2025-11-21', source: 'Finance decision', value: { salary_expense: null, tds_payable: null } },
  { key: 'settlement.notice', status: 'confirmed', effective_from: '2026-01-01', source: 'Letter', value: { recover_on: ['resignation', 'absconding'] } },
  { key: 'settlement.leave', status: 'unverified', effective_from: '2025-11-21', source: 'Company', value: { prorate_allocation: true } },
];

// Every rule starts closed under its heading; open them all as a user would.
const openAll = async () => fireEvent.click(await screen.findByRole('button', { name: 'Open all' }));

beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockResolvedValue({ data: { data: RULES, can_edit: true } });
  api.post.mockResolvedValue({ data: { success: true } });
});

describe('SettlementRulesPanel', () => {
  it('without the edit right the rules are read-only: no Save, inputs locked, and it says why', async () => {
    api.get.mockResolvedValue({ data: { data: RULES, can_edit: false } });
    render(<SettlementRulesPanel />);
    await openAll();
    expect(await screen.findByText(/Read only\. Changing a rule needs/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save and confirm' })).toBeNull();
    expect(screen.getByLabelText(/calculation wage/i)).toHaveAttribute('readonly');
    expect(screen.queryByLabelText(/Source, such as/)).toBeNull();
  });

  it('shows each rule, its status, and how many are still open', async () => {
    render(<SettlementRulesPanel />);
    expect(await screen.findByText('Statutory bonus')).toBeTruthy();
    expect(screen.getByText(/3 of 4 rules are not confirmed/)).toBeTruthy();
    expect(screen.getByText('Your decision')).toBeTruthy();
    expect(screen.getByText('Confirmed')).toBeTruthy();
  });

  it('saving sends numbers as numbers, with the source, and reloads', async () => {
    render(<SettlementRulesPanel />);
    await openAll();
    fireEvent.change(await screen.findByLabelText(/calculation wage/i), { target: { value: '8000' } });
    const sources = screen.getAllByLabelText(/Source, such as/);
    fireEvent.change(sources[0], { target: { value: 'Adviser letter 12 Nov' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save and confirm' })[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe('/payroll/statutory-rules');
    expect(body).toMatchObject({ rule_key: 'settlement.bonus', source_reference: 'Adviser letter 12 Nov' });
    expect(body.value).toEqual({ wage_eligibility: 21000, calculation_wage: 8000, rate_pct: 8.33, max_pct: 20, min_days: 30 });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it('account codes stay text, empty stays empty; lists and yes/no keep their types', async () => {
    render(<SettlementRulesPanel />);
    await openAll();
    fireEvent.change(await screen.findByLabelText(/salary expense/i), { target: { value: '5100' } });
    const sources = screen.getAllByLabelText(/Source, such as/);
    fireEvent.change(sources[1], { target: { value: 'Finance' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save and confirm' })[1]);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].value).toEqual({ salary_expense: '5100', tds_payable: null });

    api.post.mockClear();
    fireEvent.change(sources[2], { target: { value: 'Letter 2' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save and confirm' })[2]);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].value).toEqual({ recover_on: ['resignation', 'absconding'] });
  });

  it('saves without a source (optional), and a refusal is shown', async () => {
    api.post.mockRejectedValue({ response: { data: { message: 'rate_pct must be a number, not negative.' } } });
    render(<SettlementRulesPanel />);
    await openAll();
    const buttons = await screen.findAllByRole('button', { name: 'Save and confirm' });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].source_reference).toBe('');
    expect(await screen.findByText(/must be a number/)).toBeTruthy();
  });

  it('says so when the rules cannot be loaded', async () => {
    api.get.mockRejectedValue({ response: { data: { error: 'Exit data is confidential' } } });
    render(<SettlementRulesPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent?.('Exit data is confidential');
  });
});

describe('SettlementRulesPanel headings', () => {
  it('each rule starts closed and its arrow opens it', async () => {
    render(<SettlementRulesPanel />);
    const head = await screen.findByRole('button', { name: /Statutory bonus/ });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('button', { name: 'Save and confirm' })).toHaveLength(0);
    fireEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('button', { name: 'Save and confirm' })).toHaveLength(1);
  });
});
