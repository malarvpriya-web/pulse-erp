/**
 * HR > Self Service > My Details (2026-11-11): the View Employee page HR uses,
 * opened on the employee's OWN record in self view.
 *   - same tabs as View Employee minus HR-only ones (Background Verification,
 *     Notes, Onboarding); no Offboard / Edit Employee;
 *   - statutory and bank numbers come masked from /home/my-record;
 *   - "Request change" raises a Record correction ticket to HR or Finance
 *     (Tax regime & IT declarations → Finance), and the requests with their
 *     answers are listed on Overview.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), head: vi.fn() } }));
vi.mock('../features/employees/pages/EmployeesData.css', () => ({}));
const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
vi.mock('../context/ToastContext', () => ({ useToast: () => toast }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { employee_id: 3 } }) }));

import api from '../services/api/client';
import MyEmployeeRecord from '../pages/MyEmployeeRecord.jsx';

const ROW = { id: 3, office_id: 'EMP003', first_name: 'Anu', last_name: 'Natesh', designation: 'Manager', department: 'IT', status: 'Active', blood_group: 'B+' };
const MASKED = { pan_number: 'XXXXXX234F', account_number: 'XXXXXXXX9012', ifsc_code: 'HDFC0001234', bank_name: 'HDFC' };

function mockApi({ linked = true, corrections = [] } = {}) {
  api.get.mockImplementation((url) => {
    if (url === '/home/my-record') return Promise.resolve({ data: linked ? { linked: true, employee_id: 3, masked: MASKED, sections: [] } : { linked: false } });
    if (url === '/employees/3') return Promise.resolve({ data: ROW });
    if (url === '/servicedesk/corrections/mine') return Promise.resolve({ data: corrections });
    if (url === '/payroll/my-tax-regime') return Promise.resolve({ data: { data: { regime: 'old', declared: true } } });
    if (url === '/self-service/it-declarations') return Promise.resolve({ data: [{ id: 7, declaration_type: '80C', description: 'PPF', claimed_amount: '150000', amount: '120000', status: 'approved' }] });
    return Promise.resolve({ data: [] });
  });
  api.post.mockResolvedValue({ data: { id: 9, ticket_number: 'TKT-0041' } });
}

beforeEach(() => { vi.clearAllMocks(); mockApi(); });

const tabs = () => [...document.querySelectorAll('.emp-profile-tabs button')].map(b => b.textContent.trim());

describe('My Details = View Employee in self view', () => {
  it('opens the employee\'s own record with the View Employee tabs, minus HR-only ones', async () => {
    render(<MyEmployeeRecord setPage={vi.fn()} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Anu Natesh' })).toBeTruthy();
    expect(tabs()).toEqual(['Overview', 'Personal', 'Job', 'Payroll', 'Documents', 'Assets', 'History']);
    expect(screen.getByText('My Details')).toBeTruthy();                       // eyebrow
    expect(screen.queryByText(/Offboard/)).toBeNull();
    expect(screen.queryByText(/Edit Employee/)).toBeNull();
    expect(api.get.mock.calls.map(([u]) => u)).not.toContain('/notes/3');      // HR notes never fetched
  });

  it('Payroll shows the masked numbers and the Finance-kept tax regime and declarations', async () => {
    render(<MyEmployeeRecord setPage={vi.fn()} />);
    await screen.findByRole('heading', { level: 1, name: 'Anu Natesh' });
    fireEvent.click(screen.getByRole('button', { name: 'Payroll' }));
    expect(screen.getByText('XXXXXXXX9012')).toBeTruthy();
    expect(screen.getByText('XXXXXX234F')).toBeTruthy();
    const tax = await screen.findByTestId('self-tax-card');
    expect(await within(tax).findByText('Old regime')).toBeTruthy();
    expect(within(tax).getByText('PPF')).toBeTruthy();
  });

  it('"Request change" sends a correction to HR, pre-set to the tab you are on; tax goes to Finance', async () => {
    render(<MyEmployeeRecord setPage={vi.fn()} />);
    await screen.findByRole('heading', { level: 1, name: 'Anu Natesh' });
    fireEvent.click(screen.getByRole('button', { name: 'Job' }));
    fireEvent.click(screen.getByRole('button', { name: /Request change/ }));
    const dialog = screen.getByRole('dialog', { name: 'Request change' });
    expect(within(dialog).getByLabelText('Section').value).toBe('Job');
    fireEvent.change(within(dialog).getByLabelText(/Which detail is wrong/), { target: { value: 'Designation' } });
    fireEvent.change(within(dialog).getByLabelText(/What should it be/), { target: { value: 'Senior Manager' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send to HR' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/servicedesk/corrections', expect.objectContaining({
      to: 'HR', section: 'Job', field: 'Designation', correct_value: 'Senior Manager',
    })));
    expect(toast.success).toHaveBeenCalledWith('Sent to HR — ticket TKT-0041.');

    fireEvent.click(screen.getByRole('button', { name: /Request change/ }));
    const d2 = screen.getByRole('dialog', { name: 'Request change' });
    fireEvent.change(within(d2).getByLabelText('Section'), { target: { value: 'Tax regime & IT declarations' } });
    expect(within(d2).getByRole('button', { name: 'Send to Finance' })).toBeTruthy();
  });

  it('lists the employee\'s change requests and the answers on Overview', async () => {
    mockApi({ corrections: [{ id: 3, ticket_number: 'TKT-0040', title: 'Correction: Mobile (EMP003)', team: 'HR Support', status: 'Resolved', created_at: '2026-11-10T05:00:00Z', reply: 'Corrected. Updated.' }] });
    render(<MyEmployeeRecord setPage={vi.fn()} />);
    const box = await screen.findByTestId('my-change-requests');
    expect(within(box).getByText(/Corrected\. Updated\./)).toBeTruthy();
    expect(within(box).getByText('Corrected')).toBeTruthy();
  });

  it('says so when the login has no employee record', async () => {
    mockApi({ linked: false });
    render(<MyEmployeeRecord setPage={vi.fn()} />);
    expect(await screen.findByText(/not linked to an employee record/)).toBeTruthy();
  });
});
