/**
 * Loans & Advances tab (PAYROLL_DATA_FLOW_AUDIT.md Part 11): the rate and
 * tenure the EMI calculator shows reach the server; a one-month recovery is
 * confirmed, never assumed; Close never silently writes off a balance; and the
 * page holds no statutory figure of its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock('../components/ResultDialog', () => ({ default: () => null }));

import api from '../services/api/client';
import SalaryStructure from '../features/hr/pages/SalaryStructure.jsx';

const ASSIGNMENTS = [{ id: 10, employee_id: 7, employee_name: 'Asha Rao', employee_code: 'EMP007', structure_id: 1, basic_salary: 30000, has_revision: true }];
const LOAN = { id: 55, employee_id: 7, employee_name: 'Asha Rao', loan_type: 'loan', principal_amount: '20000', emi_amount: '5000',
  outstanding_balance: '15000', status: 'active', start_date: '2026-08-01', remaining_installments: 3 };

function mockApi(loans = []) {
  api.get.mockImplementation((url) => {
    if (url === '/salary-structures/assignments') return Promise.resolve({ data: ASSIGNMENTS });
    if (url === '/payroll/loan-advances') return Promise.resolve({ data: loans });
    if (url === '/settings/payroll') return Promise.resolve({ data: {} });
    return Promise.resolve({ data: [] });
  });
}
const reject = (data, status = 422) => Promise.reject(Object.assign(new Error('x'), { response: { status, data } }));

beforeEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

async function openLoanForm() {
  fireEvent.click(await screen.findByRole('button', { name: /Loans & Advances/ }));
  fireEvent.click(await screen.findByRole('button', { name: /New Loan \/ Advance/ }));
  const form = screen.getByRole('heading', { name: 'New Loan / Advance' }).closest('form');
  const [rate, tenure, principal, emi] = form.querySelectorAll('input[type="number"]');
  const [employee] = form.querySelectorAll('select');
  return { form, rate, tenure, principal, emi, employee, date: form.querySelector('input[type="date"]') };
}

describe('Loans & Advances', () => {
  it('sends the interest rate and tenure; a one-installment loan needs confirmation', async () => {
    mockApi();
    api.post.mockImplementationOnce(() => reject({ code: 'SINGLE_INSTALLMENT_CONFIRM', message: 'EMI recovers the whole amount in ONE month' }))
      .mockImplementationOnce(() => Promise.resolve({ data: { id: 1 } }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SalaryStructure />);
    const f = await openLoanForm();
    await waitFor(() => expect(f.employee.querySelectorAll('option').length).toBe(2));
    fireEvent.change(f.employee, { target: { value: '7' } });
    fireEvent.change(f.rate, { target: { value: '10' } });
    fireEvent.change(f.tenure, { target: { value: '1' } });
    fireEvent.change(f.principal, { target: { value: '20000' } });
    fireEvent.change(f.emi, { target: { value: '20167' } });
    fireEvent.change(f.date, { target: { value: '2026-11-01' } });
    fireEvent.submit(f.form);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls[0][1]).toMatchObject({ principal_amount: '20000', interest_rate: '10', tenure_months: '1' });
    expect(api.post.mock.calls[0][1].single_installment).toBeUndefined();
    expect(confirm).toHaveBeenCalledWith('EMI recovers the whole amount in ONE month');
    expect(api.post.mock.calls[1][1]).toMatchObject({ single_installment: true });
  });

  it('declining the one-installment confirmation creates nothing', async () => {
    mockApi();
    api.post.mockImplementationOnce(() => reject({ code: 'SINGLE_INSTALLMENT_CONFIRM', message: 'one month' }));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SalaryStructure />);
    const f = await openLoanForm();
    await waitFor(() => expect(f.employee.querySelectorAll('option').length).toBe(2));
    fireEvent.change(f.employee, { target: { value: '7' } });
    fireEvent.change(f.principal, { target: { value: '5000' } });
    fireEvent.change(f.emi, { target: { value: '5000' } });
    fireEvent.change(f.date, { target: { value: '2026-11-01' } });
    fireEvent.submit(f.form);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 20));
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('Close on a loan with a balance records a prepayment only after confirmation', async () => {
    mockApi([LOAN]);
    api.post.mockImplementation((url) => (url.endsWith('/close')
      ? reject({ code: 'LOAN_OUTSTANDING', outstanding: 15000, message: 'outstanding' }, 409)
      : Promise.resolve({ data: { success: true } })));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SalaryStructure />);
    fireEvent.click(await screen.findByRole('button', { name: /Loans & Advances/ }));
    expect(await screen.findByText(/3 installment\(s\) left/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payroll/loan-advances/55/prepay', expect.objectContaining({ amount: 15000 })));
    expect(confirm.mock.calls[0][0]).toMatch(/still outstanding/);
  });

  it('the button opens the form; Cancel closes it and clears what was typed', async () => {
    mockApi();
    render(<SalaryStructure />);
    let f = await openLoanForm();
    fireEvent.change(f.principal, { target: { value: '60000' } });
    fireEvent.change(f.rate, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(screen.queryByRole('heading', { name: 'New Loan / Advance' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /New Loan \/ Advance/ }));
    f = (() => { const form = screen.getByRole('heading', { name: 'New Loan / Advance' }).closest('form');
      const [rate, , principal] = form.querySelectorAll('input[type="number"]'); return { rate, principal }; })();
    expect(f.principal.value).toBe('');
    expect(f.rate.value).toBe('');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('employee, principal, EMI and start date are required; type, rate, tenure and reason are not', async () => {
    mockApi();
    render(<SalaryStructure />);
    const f = await openLoanForm();
    expect(f.employee.required).toBe(true);
    expect(f.principal.required).toBe(true);
    expect(f.emi.required).toBe(true);
    expect(f.date.required).toBe(true);
    expect(f.rate.required).toBe(false);
    expect(f.tenure.required).toBe(false);
    expect(f.form.checkValidity()).toBe(false);
    // whole rupees and whole months, as the server requires
    fireEvent.change(f.tenure, { target: { value: '2.5' } });
    expect(f.tenure.validity.valid).toBe(false);
    fireEvent.change(f.principal, { target: { value: '-5' } });
    expect(f.principal.validity.valid).toBe(false);
  });

  it('rate + tenure give the EMI: it need not be retyped, and the message shows the server\'s totals', async () => {
    mockApi();
    api.post.mockResolvedValue({ data: { id: 9, emi_amount: '5331.00', tenure_months: 12, total_interest: 3972, total_repayable: 63972 } });
    render(<SalaryStructure />);
    const f = await openLoanForm();
    await waitFor(() => expect(f.employee.querySelectorAll('option').length).toBe(2));
    fireEvent.change(f.employee, { target: { value: '7' } });
    fireEvent.change(f.principal, { target: { value: '60000' } });
    fireEvent.change(f.rate, { target: { value: '12' } });
    fireEvent.change(f.tenure, { target: { value: '12' } });
    fireEvent.change(f.date, { target: { value: '2026-11-01' } });
    // ₹60,000 at 12% for 12 months: 600 × 1.01^12 / (1.01^12 − 1) = 5,330.93 → ₹5,331
    expect(screen.getByText('₹5,331/mo')).toBeTruthy();
    expect(f.emi.required).toBe(false);
    expect(f.form.checkValidity()).toBe(true);
    fireEvent.submit(f.form);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1]).toMatchObject({ employee_id: '7', principal_amount: '60000', emi_amount: '5331', interest_rate: '12', tenure_months: '12', loan_type: 'loan' });
    expect(await screen.findByText(/12 installment\(s\) of ₹5,331; total repayable ₹63,972 \(interest ₹3,972\)/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'New Loan / Advance' })).toBeNull();
  });

  it('a server rejection is shown and the form stays open with its values', async () => {
    mockApi();
    api.post.mockImplementationOnce(() => reject({ code: 'TENURE', message: 'tenure_months must be a whole number of months greater than 0' }, 400));
    render(<SalaryStructure />);
    const f = await openLoanForm();
    await waitFor(() => expect(f.employee.querySelectorAll('option').length).toBe(2));
    fireEvent.change(f.employee, { target: { value: '7' } });
    fireEvent.change(f.principal, { target: { value: '60000' } });
    fireEvent.change(f.emi, { target: { value: '5000' } });
    fireEvent.change(f.date, { target: { value: '2026-11-01' } });
    fireEvent.submit(f.form);
    expect(await screen.findByText(/tenure_months must be a whole number/)).toBeTruthy();
    expect(f.principal.value).toBe('60000');
    expect(screen.getByRole('heading', { name: 'New Loan / Advance' })).toBeTruthy();
  });

  it('the page holds no statutory ceiling, rate or slab of its own', () => {
    const src = readFileSync(resolve(__dirname, '../features/hr/pages/SalaryStructure.jsx'), 'utf8');
    expect(src).not.toMatch(/\b15000\b|\b25000\b/);
    expect(src).not.toMatch(/Math\.min\(\s*basicAmount/);
  });
});
