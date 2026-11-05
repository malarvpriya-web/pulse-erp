/**
 * Employee Self-Service page — what it does with the signed-in account.
 *
 *  - A login with no linked employee (e.g. a Super Admin) gets a notice, no
 *    tabs, no forms and no self-service calls — it is not treated as an employee.
 *  - The profile tab shows the employee row's real columns (current_address,
 *    emergency_name, account_number masked) and a save sends ONLY the fields
 *    the employee changed.
 *  - Bank details are read-only here — maintained by HR (§202).
 *  - Reimbursements are filed on the ONE claim workflow (/reimbursement/claims):
 *    created as a Draft, then submitted; the list shows where each claim waits
 *    and its payment. The retired /self-service/reimbursements is never called.
 *  - "Apply Leave" opens the Apply Leave page (it set a tab that did not exist).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const auth = vi.hoisted(() => ({ user: { id: 9, employee_id: 7, name: 'Asha Rao' } }));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user, hasPermission: () => false }) }));
vi.mock('../hooks/usePunchMode', () => ({ default: () => ({ loading: false, canPunch: false }) }));
vi.mock('../components/attendance/CameraClockModal', () => ({ default: () => null }));
vi.mock('../components/attendance/PunchModeNotice', () => ({ default: () => null }));
vi.mock('../components/core/VocabSelect', () => ({ default: () => null }));

import api from '../services/api/client';
import EmployeeSelfService from '../features/hr/pages/EmployeeSelfService.jsx';

const EMP = { id: 7, first_name: 'Asha', last_name: 'Rao', current_address: '12 Lake Road', emergency_name: 'Ravi Rao',
  blood_group: 'O+', account_number: '123456789012', ifsc_code: 'HDFC0001234', bank_name: 'HDFC Bank' };

const CLAIMS = [
  { id: 1, employee_id: 7, claim_number: 'EC-2026-0001', expense_type: 'Medical', remarks: 'Clinic', expense_date: '2026-10-01', total_amount: 500, status: 'Submitted' },
  { id: 2, employee_id: 7, claim_number: 'EC-2026-0002', expense_type: 'Internet', remarks: 'Broadband', expense_date: '2026-09-01', total_amount: 900, net_payable: 900,
    status: 'Paid', payment_ref: 'NEFT123', payment_mode: 'NEFT', payment_date: '2026-09-20' },
  // a direct report's claim — the list endpoint returns it to a manager; this tab is one's own
  { id: 3, employee_id: 99, claim_number: 'EC-2026-0003', expense_type: 'Travel', total_amount: 100, status: 'Submitted' },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { id: 9, employee_id: 7, name: 'Asha Rao' };
  api.get.mockImplementation((url) => Promise.resolve({ data: url === '/employees/7' ? EMP : url === '/reimbursement/claims' ? CLAIMS : [] }));
  api.put.mockImplementation((_url, body) => Promise.resolve({ data: {
    address: body.address ?? EMP.current_address, emergency_contact: body.emergency_contact ?? EMP.emergency_name,
    blood_group: body.blood_group ?? EMP.blood_group, masked_bank: 'XXXX9012', ifsc_code: EMP.ifsc_code, bank_name: EMP.bank_name } }));
  api.post.mockImplementation((url) => Promise.resolve({ data: url === '/reimbursement/claims' ? { id: 41, status: 'Draft' } : { id: 41, status: 'Submitted' } }));
});

describe('a login with no linked employee', () => {
  it('sees a notice instead of the portal, and nothing is loaded or filed', async () => {
    auth.user = { id: 1, employee_id: null, name: 'Super Admin', role: 'super_admin' };
    render(<EmployeeSelfService setPage={vi.fn()} />);
    expect(await screen.findByText('No employee record is linked to this login')).toBeTruthy();
    for (const tab of ['Dashboard', 'IT Declaration', 'Document Vault', 'Reimbursements', 'Profile Update']) {
      expect(screen.queryByRole('button', { name: tab })).toBeNull();
    }
    expect(screen.queryByText(/Welcome,/)).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('profile update', () => {
  async function openProfile() {
    render(<EmployeeSelfService setPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Profile Update' }));
    await screen.findByText('12 Lake Road');
  }

  it("shows the record's own fields, with the account number masked", async () => {
    await openProfile();
    expect(screen.getByText('Ravi Rao')).toBeTruthy();
    expect(screen.getByText('XXXX9012')).toBeTruthy();
    expect(document.body.textContent).not.toContain('123456789012');
  });

  it('a save sends only what changed', async () => {
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText('Emergency Contact'), { target: { value: 'Meena Rao' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith('/self-service/employees/7/profile', { emergency_contact: 'Meena Rao' });
  });

  it('bank details are read-only, even while editing — HR maintains them', async () => {
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect(screen.queryByLabelText('Account Number')).toBeNull();
    expect(screen.queryByLabelText('IFSC Code')).toBeNull();
    expect(screen.getByText('XXXX9012')).toBeTruthy();
    expect(screen.getByText(/contact HR/)).toBeTruthy();
  });

  it('nothing changed → nothing sent', async () => {
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe('reimbursements — the one claim workflow', () => {
  it("lists the caller's own claims, with where each waits and its payment", async () => {
    render(<EmployeeSelfService setPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reimbursements' }));
    const rows = await screen.findAllByTestId('ess-claim');
    expect(rows).toHaveLength(2);
    expect(screen.getByText(/Waiting for your reporting manager/)).toBeTruthy();
    expect(screen.getByText(/ref NEFT123/)).toBeTruthy();
    expect(screen.queryByText(/EC-2026-0003/)).toBeNull();
    expect(api.get).toHaveBeenCalledWith('/reimbursement/claims', { params: { employee_id: 7 } });
    expect(api.get.mock.calls.some(([u]) => String(u).includes('/self-service/reimbursements'))).toBe(false);
  });

  it('a new claim is created as a Draft and then submitted — on the same record', async () => {
    render(<EmployeeSelfService setPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reimbursements' }));
    fireEvent.click(screen.getByRole('button', { name: /New Claim/ }));
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '250' } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Medicines' } });
    fireEvent.submit(screen.getByLabelText(/Description/).closest('form'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/reimbursement/claims/41/submit'));
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe('/reimbursement/claims');
    expect(body).toMatchObject({ amount: 250, remarks: 'Medicines', expense_category: 'Reimbursement' });
    expect(body).not.toHaveProperty('employee_id');
  });

  it('a failed submit keeps the Draft and says so — a retry submits it, never files it twice', async () => {
    api.post.mockImplementation((url) => url === '/reimbursement/claims'
      ? Promise.resolve({ data: { id: 41, status: 'Draft' } })
      : Promise.reject({ response: { data: { error: 'Network down' } } }));
    render(<EmployeeSelfService setPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reimbursements' }));
    fireEvent.click(screen.getByRole('button', { name: /New Claim/ }));
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '250' } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Medicines' } });
    fireEvent.submit(screen.getByLabelText(/Description/).closest('form'));
    expect(await screen.findByText(/Saved as a draft but not submitted: Network down/)).toBeTruthy();
    expect(api.post.mock.calls.filter(([u]) => u === '/reimbursement/claims')).toHaveLength(1);
  });
});

describe('quick actions', () => {
  it('Apply Leave opens the Apply Leave page', async () => {
    const setPage = vi.fn();
    render(<EmployeeSelfService setPage={setPage} />);
    fireEvent.click(await screen.findByRole('button', { name: /Apply Leave/ }));
    expect(setPage).toHaveBeenCalledWith('ApplyLeave');
  });
});
