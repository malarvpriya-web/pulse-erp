/**
 * The buttons follow the explicit grants the server checks (§202) — never a
 * role list, and never on one's own record.
 *
 *  - Travel → Payment: "Pay" needs expense_payments:approve, and is not offered
 *    on the payer's own claim (PUT /reimbursement/claims/:id/pay refuses both).
 *  - HR → Employee Documents: the HR register (employee filter, Add, Verify)
 *    needs employee_documents — no longer the broad 'hr' module, which
 *    payroll_admin holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const auth = vi.hoisted(() => ({ grants: new Set(), user: { id: 5, employee_id: 70, name: 'Payer' } }));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, hasPermission: (m, a) => auth.grants.has(`${m}:${a}`), hasAnyRole: () => false }),
}));
vi.mock('../context/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }), useToastContext: () => ({ showToast: vi.fn() }) }));

import api from '../services/api/client';
import TravelPayment from '../features/travel/pages/TravelPayment.jsx';
import EmployeeDocuments from '../features/hr/pages/EmployeeDocuments.jsx';

const CLAIMS = [
  { id: 1, claim_number: 'EC-1', employee_id: 11, employee_name: 'Asha', status: 'Mgmt Approved', total_amount: 500, amount: 500 },
  { id: 2, claim_number: 'EC-2', employee_id: 70, employee_name: 'Payer', status: 'Mgmt Approved', total_amount: 900, amount: 900 },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.grants = new Set();
  api.get.mockImplementation((url) => Promise.resolve({ data: url === '/reimbursement/claims' ? CLAIMS : [] }));
});

describe('Travel → Payment', () => {
  it('without expense_payments:approve, no Pay button at all', async () => {
    render(<TravelPayment />);
    expect(await screen.findByText('EC-1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pay$/ })).toBeNull();
  });

  it("with it, Pay is offered on a colleague's claim and never on one's own", async () => {
    auth.grants = new Set(['expense_payments:approve']);
    render(<TravelPayment />);
    expect(await screen.findByText('EC-1')).toBeTruthy();
    const pay = screen.getAllByRole('button', { name: /Pay$/ });
    expect(pay).toHaveLength(1);
    expect(pay[0].closest('tr').textContent).toContain('EC-1');
  });
});

describe('HR → Employee Documents', () => {
  it('the broad hr grant alone (payroll_admin) no longer opens the HR register', async () => {
    auth.grants = new Set(['hr:view', 'hr:add', 'hr:edit']);
    render(<EmployeeDocuments />);
    expect(await screen.findByText('My Documents')).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('/self-service/documents', expect.objectContaining({ params: { employee_id: '70' } }));
  });

  it('employee_documents opens it', async () => {
    auth.grants = new Set(['employee_documents:view', 'employee_documents:add', 'employee_documents:edit']);
    render(<EmployeeDocuments />);
    expect(await screen.findByText('Employee Documents')).toBeTruthy();
  });
});
