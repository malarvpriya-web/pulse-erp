import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import StatutoryRuleRecorder from '../features/hr/components/payroll/StatutoryRuleRecorder';
import api from '@/services/api/client';

vi.mock('@/services/api/client', () => ({ default: { post: vi.fn() } }));

const DECISION = { code: 'RULE_DECISION', key: 'esi.wage_basis', record_from: '2025-11-21', value: 'gross', options: ['gross', 'code_wages'] };
const UNVERIFIED = { code: 'RULE_UNVERIFIED', key: 'lwf.rates', record_from: '2025-01-10', state: 'TN',
  value: { TN: { employee: 20, employer: 40, months: [12] }, KA: { employee: 50, employer: 100, months: [12] } } };

const fill = (source) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: source } });
  fireEvent.click(screen.getByRole('checkbox'));
};

describe('StatutoryRuleRecorder', () => {
  beforeEach(() => { cleanup(); vi.mocked(api.post).mockReset(); });

  it('will not record without the confirmation tick; the source is optional', () => {
    render(<StatutoryRuleRecorder blocker={UNVERIFIED} onRecorded={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rule' }));
    const record = screen.getByRole('button', { name: 'Record' });
    expect(record.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(record.disabled).toBe(false);          // no source typed
  });

  it('confirms the value in force unchanged, on the date the blocker gives', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    const onRecorded = vi.fn();
    render(<StatutoryRuleRecorder blocker={UNVERIFIED} onRecorded={onRecorded} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rule' }));
    fill(' TN Gazette Ex. 538 ');
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/payroll/statutory-rules', {
      rule_key: 'lwf.rates', effective_from: '2025-01-10', value: UNVERIFIED.value, source_reference: 'TN Gazette Ex. 538',
    });
  });

  it('records the chosen option and warns that it changes figures', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    render(<StatutoryRuleRecorder blocker={DECISION} onRecorded={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record decision' }));
    expect(screen.queryByText(/must be regenerated/)).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'code_wages' } });
    expect(screen.getByText(/must be regenerated/)).toBeDefined();
    fill('Board note 12');
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(vi.mocked(api.post).mock.calls[0][1].value).toBe('code_wages');
  });

  it('shows the server refusal and does not report success', async () => {
    vi.mocked(api.post).mockRejectedValue({ response: { data: { message: 'Payroll on or after this date is already approved' } } });
    const onRecorded = vi.fn();
    render(<StatutoryRuleRecorder blocker={DECISION} onRecorded={onRecorded} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record decision' }));
    fill('Board note 12');
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already approved/);
    expect(onRecorded).not.toHaveBeenCalled();
  });
});
