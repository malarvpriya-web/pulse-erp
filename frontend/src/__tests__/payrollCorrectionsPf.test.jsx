/**
 * Manual §262 screens.
 *   Tax & Statutory → Dues: a recorded payment can be cancelled (with a reason)
 *   by whoever may record payments; the cancelled record stays visible, struck through
 *   Tax regime & opening balances: an employee can be recorded as not a PF member
 *   (Form 11 reference required), and a non-member can join PF
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

let canPay = true;
vi.mock('@/services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ permissions: {}, hasPermission: () => true }) }));
vi.mock('@/config/menuCatalog', () => ({ heldGrant: () => canPay }));
import api from '@/services/api/client';
import StatutoryDuesPanel from '../features/hr/components/payroll/StatutoryDuesPanel';
import TaxSetupPanel from '../features/hr/components/payroll/TaxSetupPanel';

const ok = (data, message) => Promise.resolve({ data: { success: true, data, message } });
beforeEach(() => { vi.clearAllMocks(); canPay = true; document.body.innerHTML = ''; });

describe('cancelling a recorded statutory payment', () => {
  const DUES = { period: 'September 2026', items: [
    { kind: 'pf', amount: 7650, due_date: '2026-10-15', due_basis: 'EPF: 15th of the following month', status: 'paid',
      remittance: { id: 41, challan_reference: 'EPFWRONG001', paid_on: '2026-10-10', amount: 7650 },
      cancelled: [{ id: 40, challan_reference: 'EPFOLD0001', paid_on: '2026-10-09', amount: 7650, cancel_reason: 'Typed the wrong month' }] },
    { kind: 'tds', amount: 0, due_date: '2026-10-07', due_basis: 'x', status: 'nothing_due', deposited: 0, recorded_in: 'Finance → TDS' },
  ] };

  it('asks for the reason, sends it, and shows the earlier cancelled record', async () => {
    api.get.mockImplementation(() => ok(DUES));
    api.put.mockImplementation(() => ok({}, 'PF for September 2026 payment record cancelled and its journal reversed. Record the correct payment now.'));
    vi.spyOn(window, 'prompt').mockReturnValue('Wrong TRRN copied from another month');
    render(<StatutoryDuesPanel />);
    expect(await screen.findByText(/EPFOLD0001/)).toBeTruthy();
    expect(screen.getByText('Cancelled: Typed the wrong month')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel record' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/payroll/remittances/41/cancel', { reason: 'Wrong TRRN copied from another month' }));
    expect(await screen.findByText(/journal reversed/)).toBeTruthy();
  });

  it('is not offered without the payment permission', async () => {
    canPay = false;
    api.get.mockImplementation(() => ok(DUES));
    render(<StatutoryDuesPanel />);
    await screen.findByText(/EPFWRONG001/);
    expect(screen.queryByRole('button', { name: 'Cancel record' })).toBeNull();
  });
});

describe('PF membership on the tax setup', () => {
  const ROWS = [
    { employee_id: 7, name: 'Asha K', employee_code: 'EMP007', regime: 'new', pf_excluded_from: null },
    { employee_id: 8, name: 'Ravi M', employee_code: 'EMP008', regime: 'new', pf_excluded_from: '2026-04-01', pf_declaration_reference: 'Form 11 01-Apr' },
  ];

  it('records a non-member with the Form 11 reference, and lets a non-member join PF', async () => {
    api.get.mockImplementation(() => ok({ employees: ROWS }));
    api.put.mockImplementation(() => ok({}, 'Recorded: no PF from 2026-04-01.'));
    render(<TaxSetupPanel />);
    expect(await screen.findByText('Not a member from 2026-04-01')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not a PF member…' }));
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.change(document.querySelector('[aria-label="PF membership"] input[type="date"]'), { target: { value: '2026-04-01' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('e.g. Form 11 signed 01-Feb-2026'), { target: { value: 'Form 11 signed 01-Apr-2026' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/payroll/pf-exclusions/7',
      { effective_from: '2026-04-01', declaration_reference: 'Form 11 signed 01-Apr-2026', reason: '' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Join PF' }));
    fireEvent.change(document.querySelector('[aria-label="PF membership"] input[type="date"]'), { target: { value: '2026-11-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/payroll/pf-exclusions/8/end', { ended_on: '2026-11-01', reason: '' }));
  });

  it("shows the server's refusal", async () => {
    api.get.mockImplementation(() => ok({ employees: ROWS }));
    api.put.mockRejectedValue({ response: { data: { message: 'A UAN (100200300400) is on file, so this employee has been a PF member before' } } });
    render(<TaxSetupPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not a PF member…' }));
    fireEvent.change(document.querySelector('[aria-label="PF membership"] input[type="date"]'), { target: { value: '2026-04-01' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Form 11 signed 01-Feb-2026'), { target: { value: 'Form 11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/UAN/);
  });
});
