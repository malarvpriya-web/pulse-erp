/**
 * HR → Bank Detail Approvals (§204) — the checker side of the bank-detail
 * maker-checker:
 *  - reached through the employee_bank grant (menu row + URL), never a role;
 *  - shows on-record vs proposed details; approve; reject only with a reason;
 *  - the person who entered a change sees Withdraw, never Approve.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const auth = vi.hoisted(() => ({ grants: new Set(['employee_bank:view', 'employee_bank:edit']) }));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }) }));

import api from '../services/api/client';
import BankChangeApprovals from '../features/hr/pages/BankChangeApprovals.jsx';
import { ROUTES, NAV_ITEMS } from '../config/routes';
import { canRenderPage } from '../config/menuCatalog';

const ROWS = [
  { id: 7, employee_id: 1, employee_name: 'Asha Rao', employee_code: 'EMP001', status: 'pending', source: 'edit', fields_changed: ['account_number'],
    current_account_number: '123456789012', proposed_account_number: '555566667777', current_ifsc_code: 'HDFC0001234', proposed_ifsc_code: 'HDFC0001234',
    requested_by_name: 'HR One', requested_at: '2026-10-29', can_decide: true, can_withdraw: true },
  { id: 8, employee_id: 2, employee_name: 'Ravi Kumar', employee_code: 'EMP002', status: 'pending', source: 'create', fields_changed: ['account_number', 'ifsc_code'],
    proposed_account_number: '445566778899', proposed_ifsc_code: 'UTIB0001111', requested_by_name: 'Me', requested_at: '2026-10-29', can_decide: false, can_withdraw: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.grants = new Set(['employee_bank:view', 'employee_bank:edit']);
  api.get.mockResolvedValue({ data: ROWS });
  api.post.mockResolvedValue({ data: {} });
});

describe('who reaches the page', () => {
  it('is an HR row and a route gated on employee_bank', () => {
    const hr = NAV_ITEMS.find(g => g.name === 'HR');
    expect(hr.submenu.find(s => s.page === 'BankChangeApprovals')).toMatchObject({ module: 'employee_bank' });
    expect(ROUTES.BankChangeApprovals.module).toBe('employee_bank');
    const route = ROUTES.BankChangeApprovals;
    const has = (g) => (m, a) => g.includes(`${m}:${a}`);
    expect(canRenderPage('hr_manager', 'BankChangeApprovals', { route, hasPermission: has(['employee_bank:view']) })).toBe(true);
    for (const role of ['hr_exec', 'payroll_admin', 'employee', 'manager']) {
      expect(canRenderPage(role, 'BankChangeApprovals', { route, hasPermission: has(['hr:view']) }), role).toBe(false);
    }
  });
});

describe('deciding', () => {
  it('shows on-record vs proposed; the maker gets Withdraw, not Approve', async () => {
    render(<BankChangeApprovals />);
    const rows = await screen.findAllByTestId('bcr-row');
    expect(api.get).toHaveBeenCalledWith('/employees/bank-change-requests', { params: { status: 'pending' } });
    expect(rows[0].textContent).toContain('123456789012');
    expect(rows[0].textContent).toContain('555566667777');
    expect(rows[0].textContent).toContain('Approve');
    expect(rows[1].textContent).not.toContain('Approve');
    expect(rows[1].textContent).toContain('Withdraw');
    expect(rows[1].textContent).toContain('another HR person approves');
  });

  it('approve calls the approval endpoint and says Accounts was notified', async () => {
    render(<BankChangeApprovals />);
    await screen.findAllByTestId('bcr-row');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employees/bank-change-requests/7/approve', {}));
    expect(await screen.findByText(/Accounts has been notified/)).toBeTruthy();
  });

  it('reject needs a reason, then sends it', async () => {
    render(<BankChangeApprovals />);
    await screen.findAllByTestId('bcr-row');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const confirm = screen.getByRole('button', { name: 'Confirm rejection' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason for rejection/), { target: { value: 'Cheque mismatch' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employees/bank-change-requests/7/reject', { reason: 'Cheque mismatch' }));
  });
});

describe('propose-only and verify-as-is (§206)', () => {
  it('employee_bank:add alone opens the page (row + URL); no other grant does', () => {
    const route = ROUTES.BankChangeApprovals;
    const has = (g) => (m, a) => g.includes(`${m}:${a}`);
    expect(route.moduleActions).toEqual(['view', 'add']);
    expect(canRenderPage('hr_exec', 'BankChangeApprovals', { route, hasPermission: has(['employee_bank:add']) })).toBe(true);
    expect(canRenderPage('hr_exec', 'BankChangeApprovals', { route, hasPermission: has(['hr:view', 'employee_bank:delete']) })).toBe(false);
    const row = NAV_ITEMS.find(g => g.name === 'HR').submenu.find(s => s.page === 'BankChangeApprovals');
    expect(row.moduleActions).toEqual(['view', 'add']);
  });

  it('a propose-only viewer is told it sees only its own requests; verification rows are labelled', async () => {
    auth.grants = new Set(['employee_bank:add']);
    api.get.mockResolvedValue({ data: [{ ...ROWS[1], source: 'verify', fields_changed: [], proposed_account_number: 'XXXX8899' }] });
    render(<BankChangeApprovals />);
    const [row] = await screen.findAllByTestId('bcr-row');
    expect(screen.getByText(/only the bank-detail requests you entered/)).toBeTruthy();
    expect(row.textContent).toContain('Verification of the details on record');
    expect(row.textContent).not.toContain('Approve');
    expect(row.textContent).toContain('XXXX8899');
  });
});
