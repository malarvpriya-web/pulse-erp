/**
 * Bank-detail second approval (§204, §266). The separate HR → Bank Detail
 * Approvals page is gone; a waiting change is decided
 *  - on the employee's Edit page (BankChangePending), or
 *  - in the Approval Center (backend source `bank`, tested server-side).
 * The rules are unchanged: on-record vs proposed; approve; reject only with a
 * reason; the person who entered a change sees Withdraw, never Approve.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const auth = vi.hoisted(() => ({ grants: new Set(['employee_bank:view', 'employee_bank:edit']) }));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }) }));
vi.mock('../features/employees/shared/employeeFiles', () => ({ openEmployeeFile: vi.fn(() => Promise.resolve()) }));

import api from '../services/api/client';
import BankChangePending from '../features/employees/shared/BankChangePending.jsx';
import { ROUTES, NAV_ITEMS } from '../config/routes';

const OTHERS = { id: 7, employee_id: 1, status: 'pending', source: 'edit', fields_changed: ['account_number'],
  current_account_number: '123456789012', proposed_account_number: '555566667777', current_ifsc_code: 'HDFC0001234', proposed_ifsc_code: 'HDFC0001234',
  proposed_bank_name: 'HDFC Bank', proposed_branch_name: 'Anna Nagar',
  requested_by_name: 'HR One', requested_at: '2026-10-29', can_decide: true, can_withdraw: true };
const MINE = { ...OTHERS, id: 8, requested_by_name: 'Me', can_decide: false };

beforeEach(() => {
  vi.clearAllMocks();
  auth.grants = new Set(['employee_bank:view', 'employee_bank:edit']);
  api.get.mockResolvedValue({ data: [OTHERS] });
  api.post.mockResolvedValue({ data: {} });
});

describe('no separate page', () => {
  it('the HR menu has no Bank Detail Approvals row; the old URL goes to the Approval Center', () => {
    const hr = NAV_ITEMS.find(g => g.name === 'HR');
    expect(hr.submenu.find(s => s.page === 'BankChangeApprovals')).toBeUndefined();
    expect(ROUTES.BankChangeApprovals.module).toBeUndefined();
    const el = ROUTES.BankChangeApprovals.component();
    expect(el.props.to).toBe('/ApprovalCenter');
  });
});

describe('on the employee\'s Edit page', () => {
  it('shows nothing when no change waits', async () => {
    api.get.mockResolvedValue({ data: [] });
    const onPending = vi.fn();
    const { container } = render(<BankChangePending employeeId={1} onPendingChange={onPending} />);
    await waitFor(() => expect(onPending).toHaveBeenCalledWith(false));
    expect(container.textContent).toBe('');
  });

  it('shows on-record vs proposed for this employee; approve saves and hands the approved values to the form', async () => {
    const onApproved = vi.fn(); const onMessage = vi.fn();
    render(<BankChangePending employeeId={1} onApproved={onApproved} onMessage={onMessage} />);
    const box = await screen.findByTestId('bank-change-pending');
    expect(api.get).toHaveBeenCalledWith('/employees/bank-change-requests', { params: { status: 'pending', employee_id: 1 } });
    expect(box.textContent).toContain('123456789012');
    expect(box.textContent).toContain('555566667777');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employees/bank-change-requests/7/approve', {}));
    expect(onApproved).toHaveBeenCalledWith(expect.objectContaining({ account_number: '555566667777', bank_name: 'HDFC Bank' }));
    expect(onMessage).toHaveBeenCalledWith('ok', expect.stringMatching(/Accounts has been notified/));
    expect(screen.queryByTestId('bank-change-pending')).toBeNull();
  });

  it('reject needs a reason, then sends it', async () => {
    render(<BankChangePending employeeId={1} />);
    await screen.findByTestId('bank-change-pending');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const confirm = screen.getByRole('button', { name: 'Confirm rejection' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Cheque mismatch' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employees/bank-change-requests/7/reject', { reason: 'Cheque mismatch' }));
  });

  it('the person who entered it gets Withdraw, never Approve', async () => {
    api.get.mockResolvedValue({ data: [MINE] });
    render(<BankChangePending employeeId={1} />);
    const box = await screen.findByTestId('bank-change-pending');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(box.textContent).toContain('another HR person approves');
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employees/bank-change-requests/8/withdraw', {}));
  });

  it('without a bank-details grant nothing is asked for', async () => {
    auth.grants = new Set(['hr:view']);
    render(<BankChangePending employeeId={1} />);
    await new Promise(r => setTimeout(r, 0));
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('account-holder name and proof (§267)', () => {
  it('shows the name, warns when it differs from the employee, and opens the proof', async () => {
    const { openEmployeeFile } = await import('../features/employees/shared/employeeFiles');
    api.get.mockResolvedValue({ data: [{ ...OTHERS, proposed_account_holder_name: 'Suresh P', current_account_holder_name: null,
      holder_name_matches: false, proof_cheque_file: '/uploads/1_cheque.pdf', proof_statement_file: null }] });
    render(<BankChangePending employeeId={1} />);
    const box = await screen.findByTestId('bank-change-pending');
    expect(box.textContent).toContain('Suresh P');
    expect(screen.getByRole('alert').textContent).toMatch(/does not match the employee/);
    fireEvent.click(screen.getByRole('button', { name: 'Open cancelled cheque' }));
    expect(openEmployeeFile).toHaveBeenCalledWith('/uploads/1_cheque.pdf');
  });

  it('says when no proof is attached', async () => {
    api.get.mockResolvedValue({ data: [{ ...OTHERS, proposed_account_holder_name: 'Asha Rao', holder_name_matches: true, proof_cheque_file: null, proof_statement_file: null }] });
    render(<BankChangePending employeeId={1} />);
    const box = await screen.findByTestId('bank-change-pending');
    expect(box.textContent).toContain('none attached');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
