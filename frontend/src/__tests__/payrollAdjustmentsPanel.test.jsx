/**
 * Payroll Processing → One-time earnings & deductions (manual §261).
 *   - the month's entries are listed; an approved month's are locked (no remove)
 *   - a deduction cannot be added without the account it is credited to
 *   - what is sent is the server's shape; the server's refusal is shown
 *   - without payroll:edit the panel is read-only
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
import api from '../services/api/client';
import PayrollAdjustmentsPanel from '../features/hr/components/payroll/PayrollAdjustmentsPanel';

const env = (data, message) => Promise.resolve({ data: { success: true, data, message } });
const ROWS = [
  { id: 1, employee_id: 7, employee_name: 'Asha K', employee_code: 'EMP007', kind: 'earning', label: 'Sales incentive', amount: 5000, reason: 'Q2 target', locked: false },
  { id: 2, employee_id: 8, employee_name: 'Ravi M', employee_code: 'EMP008', kind: 'deduction', label: 'Canteen', amount: 900, account_code: '4003', account_name: 'Other Income', reason: 'Sept bill', locked: true, run_status: 'approved' },
];
const EMPLOYEES = [{ employee_id: 7, name: 'Asha K', employee_code: 'EMP007', eligible: true }];

function renderPanel(props = {}) {
  api.get.mockImplementation((url) => {
    if (url === '/payroll/adjustments') return env(ROWS);
    if (url === '/payroll/adjustments/accounts') return env([{ code: '4003', name: 'Other Income', account_type: 'Revenue' }]);
    return env(null);
  });
  const notify = vi.fn(), onChanged = vi.fn();
  render(<PayrollAdjustmentsPanel month={9} year={2026} period="September 2026" employees={EMPLOYEES} canEdit notify={notify} onChanged={onChanged} {...props} />);
  return { notify, onChanged };
}

beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ''; });

describe('one-time adjustments panel', () => {
  it('lists the month and locks an approved entry', async () => {
    renderPanel();
    expect(await screen.findByText('Sales incentive')).toBeTruthy();
    expect(screen.getByText('Locked (approved)')).toBeTruthy();
    expect(screen.getAllByTitle('Remove')).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith('/payroll/adjustments', { params: { month: 9, year: 2026 } });
  });

  it('a deduction needs the account it is credited to, then sends the server shape', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: {}, message: 'Saved. Generate the payroll again for this month so the draft includes it.' } });
    const { notify, onChanged } = renderPanel();
    await screen.findByText('Sales incentive');
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'deduction' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Canteen recovery'), { target: { value: 'Uniform' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '300' } });
    fireEvent.change(screen.getByPlaceholderText('Why this amount, for the approver'), { target: { value: 'Second uniform set' } });
    const add = screen.getByRole('button', { name: /Add/ });
    expect(add.disabled).toBe(true);
    await waitFor(() => expect(screen.getByRole('option', { name: '4003 — Other Income' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Credit to account'), { target: { value: '4003' } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payroll/adjustments', {
      employee_id: '7', kind: 'deduction', label: 'Uniform', amount: 300, account_code: '4003', reason: 'Second uniform set', month: 9, year: 2026,
    }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Generate the payroll again/)));
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    api.post.mockRejectedValue({ response: { data: { message: 'Payroll for September 2026 is already approved for this employee.' } } });
    renderPanel();
    await screen.findByText('Sales incentive');
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Sales incentive'), { target: { value: 'Late incentive' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    fireEvent.change(screen.getByPlaceholderText('Why this amount, for the approver'), { target: { value: 'Missed last time' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already approved/);
  });

  it('is read-only without payroll:edit', async () => {
    renderPanel({ canEdit: false });
    await screen.findByText('Sales incentive');
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull();
    expect(screen.queryAllByTitle('Remove')).toHaveLength(0);
  });
});
