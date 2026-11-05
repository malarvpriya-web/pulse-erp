/**
 * PC-02a on Payroll Processing (manual §232).
 *
 *   PD-1  "Pay" opens Record payment: the bank reference (UTR) and value date are
 *         required and sent; a refused payment keeps the dialog open with the
 *         server's reason (nothing was recorded). There is no bulk "Mark All Paid".
 *   PD-16 Export NEFT (full account numbers) only for employee_bank:view holders.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
const auth = vi.hoisted(() => ({ denied: new Set(), permissions: [] }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => !auth.denied.has(`${m}:${a}`), permissions: auth.permissions }),
}));
import api from '../services/api/client';
import Payroll from '../features/hr/pages/Payroll';

const env = (data) => Promise.resolve({ data: { success: true, data } });
const ROW = { employee_id: 7, id: 7, name: 'Asha K', employee_code: 'EMP007', department: 'QA', status: 'approved', gross: 30000, net_pay: 27000 };

function renderPayroll(rows = [ROW]) {
  api.get.mockImplementation((url) => {
    if (url === '/payroll') return env(rows);
    if (url === '/payroll/summary') return env({});
    if (url === '/payroll/trend') return env([]);
    if (url === '/payroll/eligibility') return env({ period: 'January 2030', summary: { eligible: 1, active_headcount: 1, not_eligible: 0 }, employees: [] });
    if (url === '/payroll/release-readiness') return env({ period: 'January 2030', ready: true, blockers: [] });
    return env(null);
  });
  render(<Payroll embedded setPage={vi.fn()} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  auth.denied = new Set();
  auth.permissions = [{ module: 'payroll_payment', can_approve: true }];
});

describe('Record payment (PD-1)', () => {
  it('needs the UTR before anything is sent, then sends reference, value date and mode', async () => {
    renderPayroll();
    fireEvent.click(await screen.findByRole('button', { name: /Pay$/ }));
    expect(screen.getByRole('dialog', { name: 'Record payment' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(screen.getByRole('alert').textContent).toMatch(/UTR/);
    expect(api.post).not.toHaveBeenCalled();

    api.post.mockResolvedValue({ data: { success: true, data: { reference: 'HDFCN52030010101' } } });
    fireEvent.change(document.getElementById('pay-utr'), { target: { value: 'HDFCN52030010101' } });
    fireEvent.change(document.getElementById('pay-mode'), { target: { value: 'rtgs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe('/payroll/7/mark-paid');
    expect(body).toMatchObject({ reference: 'HDFCN52030010101', payment_mode: 'rtgs' });
    expect(body.value_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Record payment' })).toBeNull());
  }, 15000);   // the Payroll page is heavy to mount under full-suite load

  it('a refused payment keeps the dialog open with the reason', async () => {
    api.post.mockRejectedValue({ response: { status: 422, data: { message: 'Payment not recorded: the salary-clearing journal could not be posted — period locked' } } });
    renderPayroll();
    fireEvent.click(await screen.findByRole('button', { name: /Pay$/ }));
    fireEvent.change(document.getElementById('pay-utr'), { target: { value: 'SBINN52030030303' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/period locked/);
    expect(screen.getByRole('dialog', { name: 'Record payment' })).toBeTruthy();
  });

  it('offers no bulk "Mark All Paid"', async () => {
    renderPayroll([ROW, { ...ROW, employee_id: 8, id: 8, name: 'Ravi M' }]);
    await screen.findByText('Ravi M');
    expect(screen.queryByRole('button', { name: /Mark All/ })).toBeNull();
  });
});

describe('Export NEFT (PD-16)', () => {
  it('is offered only with employee_bank:view', async () => {
    renderPayroll();
    expect(await screen.findByRole('button', { name: /Export NEFT/ })).toBeTruthy();
    document.body.innerHTML = '';
    auth.denied = new Set(['employee_bank:view']);
    renderPayroll();
    await screen.findByText('Asha K');
    expect(screen.queryByRole('button', { name: /Export NEFT/ })).toBeNull();
  });
});
