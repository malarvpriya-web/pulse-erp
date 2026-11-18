import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// HR P0 containment C1/C3/C5 on screen (HR_P0_REMEDIATION_DESIGN_2026-11-03.md).
//   C1  a failed F&F compute shows the error — never invented figures (the page
//       used to fill in a made-up ₹1,45,200 settlement);
//   C1/C3  a provisional (suspended) settlement offers no Approve / Mark as Paid;
//   (exit review 2026-11-17) the calculator opens the saved version and never approves;
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
    service: { years: 2, months: 1 }, day_rate: 1153.85, wage_payment_days: 2,
    lines: [
      { code: 'LEAVE', label: 'Earned Leave encashment', direction: 'payable', amount: 1234, basis: '1 day × day rate', tax: 'Adviser to confirm.' },
      { code: 'NOTICE', label: 'Notice shortfall', direction: 'recoverable', amount: 500, basis: '30 days required', tax: 'None.' },
    ],
    warnings: [{ code: 'NOTICE_START_UNKNOWN', message: 'The date notice started is not recorded.' }],
    rules_unconfirmed: [{ key: 'settlement.gratuity', status: 'unverified', source: 'Code on Social Security' }],
    summary: { total_payable: 1234, total_recoverable: 500, net_payable: 734 },
  },
};

function mockExitGets() {
  api.get.mockImplementation((url) => {
    if (url === '/exit/active') return Promise.resolve({ data: [EXIT] });
    if (url.startsWith('/exit/clearance/')) return Promise.resolve({ data: { blockers: [], can_settle: true } });
    return Promise.resolve({ data: [] });
  });
}

// Choosing the exit opens its SAVED settlement (GET /exit/fnf/review); only
// Calculate computes a new version (exit review 2026-11-17).
async function openCalculatorFor(exitId, { calculate = true } = {}) {
  render(<ExitManagement />);
  await screen.findByText(/Zz Leaver/);
  fireEvent.click(screen.getByRole('button', { name: 'F&F Calculator' }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: String(exitId) } });
  if (calculate) fireEvent.click(await screen.findByRole('button', { name: 'Calculate' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExitGets();
});

describe('ExitManagement F&F calculator (C1/C3)', () => {
  it('a failed compute shows the server error and no settlement figures', async () => {
    api.post.mockRejectedValue({ response: { status: 500, data: { error: 'leave balance query failed' } } });
    await openCalculatorFor(41);
    expect(await screen.findByRole('alert')).toHaveTextContent('leave balance query failed');
    expect(screen.queryByText(/1,45,200/)).toBeNull();
    expect(screen.queryByText(/Net Payable to Employee/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Settlement Review/ })).toBeNull();
  });

  it('a provisional (suspended) settlement shows the notice and offers no way to approve or pay', async () => {
    api.post.mockResolvedValue({ data: { ...COMPUTED, provisional: true, settlement_actions_suspended: true,
      containment_notice: 'F&F settlement approval and payment are suspended.' } });
    await openCalculatorFor(41);
    expect(await screen.findByText(/Provisional figures/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark as Paid/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Settlement Review/ })).toBeNull();
  });

  it('the calculator never approves: a new version links to Settlement Review', async () => {
    api.post.mockResolvedValue({ data: COMPUTED });
    await openCalculatorFor(41);
    const link = await screen.findByRole('link', { name: 'Open Settlement Review for approval' });
    expect(link.getAttribute('href')).toBe('/SettlementReview?exit=41');
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(api.post).toHaveBeenCalledWith('/exit/fnf/compute/7', expect.not.objectContaining({ notice_start: expect.anything() }));
    expect(api.put).not.toHaveBeenCalled();
  });

  it('opening an exit shows its saved settlement and does not recompute', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/exit/active') return Promise.resolve({ data: [EXIT] });
      if (url === '/exit/fnf/review/41') return Promise.resolve({ data: {
        exit: { id: 41, employee_id: 7 }, approval: null, payment: null,
        settlement: { id: 90, version: 3, net_payable: '734.00', total_payable: '1234.00', total_recoverable: '500.00',
          lines: COMPUTED.computation_details.lines, warnings: [], rules_unconfirmed: [],
          computed_at: '2026-11-16T10:00:00Z', computed_by_name: 'Zz HR', options: { lop_days: 2 } },
      } });
      if (url.startsWith('/exit/clearance/')) return Promise.resolve({ data: { blockers: [], can_settle: true } });
      return Promise.resolve({ data: [] });
    });
    await openCalculatorFor(41, { calculate: false });
    expect(await screen.findByText(/Settlement, version 3 \(saved\)/)).toBeTruthy();
    expect(screen.getByText(/by Zz HR/)).toBeTruthy();
    expect(screen.getByLabelText(/Loss of pay days/)).toHaveValue(2);
    expect(api.post).not.toHaveBeenCalled();
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
