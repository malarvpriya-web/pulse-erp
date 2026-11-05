import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// HR P0 containment C1/C3/C5 on screen (HR_P0_REMEDIATION_DESIGN_2026-11-03.md).
//   C1  a failed F&F compute shows the error — never invented figures (the page
//       used to fill in a made-up ₹1,45,200 settlement);
//   C1/C3  a provisional (suspended) settlement offers no Approve / Mark as Paid;
//   C5  Acknowledge sends no identity — the server decides who is acknowledging.

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../features/_shared/exportUtils', () => ({ exportCSV: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => false }) }));

import api from '../services/api/client';
import ExitManagement from '../features/hr/pages/ExitManagement.jsx';
import Policies from '../features/hr/pages/Policies.jsx';

const EXIT = { id: 41, employee_id: 7, employee_name: 'Zz Leaver', employee_code: 'EMP007', status: 'active', fnf_status: 'draft' };
const COMPUTED = {
  id: 41, status: 'draft', net_payable: 1234,
  computation_details: {
    basic_salary: 30000, daily_basic: 1153.85, service_years: 2.1, service_years_complete: 2,
    notice: { period_days: 30, served_days: 30, shortfall_days: 0, recovery: 0 },
    leave_encashment: { balance_days: 0, amount: 0, formula: '0 days' },
    gratuity: { eligible: false, amount: 0, formula: 'n/a' },
    pf: { balance: 0, tds_applicable: false, tds_amount: 0 },
    tds: { tds_on_fnf: 0 },
    summary: { total_payable: 1234, total_recoverable: 0, tds_on_fnf: 0 },
  },
};

function mockExitGets() {
  api.get.mockImplementation((url) => {
    if (url === '/exit/active') return Promise.resolve({ data: [EXIT] });
    if (url.startsWith('/exit/clearance/')) return Promise.resolve({ data: { blockers: [], can_settle: true } });
    return Promise.resolve({ data: [] });
  });
}

async function openCalculatorFor(empId) {
  render(<ExitManagement />);
  await screen.findByText(/Zz Leaver/);
  fireEvent.click(screen.getByRole('button', { name: 'F&F Calculator' }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: String(empId) } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExitGets();
});

describe('ExitManagement F&F calculator (C1/C3)', () => {
  it('a failed compute shows the server error and no settlement figures', async () => {
    api.post.mockRejectedValue({ response: { status: 500, data: { error: 'leave balance query failed' } } });
    await openCalculatorFor(7);
    expect(await screen.findByRole('alert')).toHaveTextContent('leave balance query failed');
    expect(screen.queryByText(/1,45,200/)).toBeNull();
    expect(screen.queryByText(/Net Payable to Employee/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve Settlement/ })).toBeNull();
  });

  it('a provisional (suspended) settlement shows the notice and offers no Approve', async () => {
    api.post.mockResolvedValue({ data: { ...COMPUTED, provisional: true, settlement_actions_suspended: true,
      containment_notice: 'F&F settlement approval and payment are suspended.' } });
    await openCalculatorFor(7);
    expect(await screen.findByText(/Provisional figures/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve Settlement/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark as Paid/ })).toBeNull();
  });

  it('without the suspension flag Approve is offered, and a refusal shows the server message', async () => {
    api.post.mockResolvedValue({ data: COMPUTED });
    api.put.mockRejectedValue({ response: { status: 423, data: { error: 'F&F settlement approval and payment are suspended.' } } });
    await openCalculatorFor(7);
    fireEvent.click(await screen.findByRole('button', { name: /Approve Settlement/ }));
    expect(await screen.findByText(/approval and payment are suspended/)).toBeTruthy();
  });
});

describe('Policies acknowledgement (C5)', () => {
  beforeEach(() => {
    api.get.mockImplementation((url) => {
      if (url === '/hr/policies') return Promise.resolve({ data: [{ id: 5, title: 'Code of Conduct', category: 'General', version: 'v1', is_active: true, applicable_to: 'all', requires_acknowledgement: true }] });
      if (url === '/hr/policies/acknowledgement-counts') return Promise.resolve({ data: { counts: {}, total_employees: 0 } });
      return Promise.resolve({ data: [] });
    });
  });

  it('Acknowledge posts no employee_id — the server records the signed-in person', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 873, employee_id: 10 }));
    api.post.mockResolvedValue({ data: { policy_id: 5, employee_id: 10 } });
    render(<Policies />);
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/hr/policies/5/acknowledge');
    localStorage.removeItem('user');
  });

  it('a refusal shows the server\'s reason', async () => {
    api.post.mockRejectedValue({ response: { status: 403, data: { error: 'No employee record is linked to this account' } } });
    render(<Policies />);
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('No employee record is linked to this account')).toBeTruthy();
  });
});
