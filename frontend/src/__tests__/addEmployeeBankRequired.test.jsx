/**
 * Add / Edit Employee — current address, bank account number and IFSC are
 * mandatory (§202). The form says so on the controls before anything is sent;
 * the server applies the same rule (employee.controller.js).
 *  - Add: all three required; account 9–18 digits; IFSC AAAA0XXXXXX.
 *  - Edit: an on-record value cannot be cleared, but a record that never had
 *    one can still be saved for other changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('../features/employees/pages/AddEmployee.css', () => ({}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), showToast: vi.fn() }),
}));
vi.mock('../components/ResultDialog', () => ({
  default: ({ dialog }) => (dialog ? <div role="dialog">{dialog.title}: {dialog.message}</div> : null),
}));
const { Picker } = vi.hoisted(() => ({
  Picker: ({ id, value, onChange }) => (
    <input id={id} data-picker="1" value={value ?? ''} onChange={e => onChange(e.target.value, null)} />
  ),
}));
vi.mock('../components/core/MasterSelect', () => ({ default: Picker }));
vi.mock('../components/core/VocabSelect', () => ({ default: Picker }));
vi.mock('../components/core/BranchSelect', () => ({ default: Picker }));
vi.mock('../features/employees/shared/employeeFiles', () => ({
  loadEmployeeImage: vi.fn(async () => null), isExternalUrl: () => false, openEmployeeFile: vi.fn(async () => null),
}));

import api from '../services/api/client';
import AddEmployee from '../features/employees/pages/AddEmployee.jsx';
import EditEmployee from '../features/employees/pages/EditEmployee.jsx';
import { fillBankAndAddress } from './helpers/addEmployeeRequired';

const SAVE = () => fireEvent.click(screen.getByRole('button', { name: /^(Save|Add Employee|Create)/ }));
const sent = () => Object.fromEntries([...api.post.mock.calls[0][1].entries()]);

function fillBasics() {
  fireEvent.change(document.getElementById('ae-first-name'), { target: { value: 'Ravi' } });
  fireEvent.change(document.getElementById('ae-last-name'), { target: { value: 'Kumar' } });
  fireEvent.change(document.getElementById('ae-company-email'), { target: { value: 'ravi@acme.in' } });
  fireEvent.click(screen.getByText('Job Information', { selector: '.accordion-header h2' }));
  fireEvent.change(document.getElementById('ae-department'), { target: { value: 'Finance' } });
  fireEvent.change(document.getElementById('ae-designation'), { target: { value: 'Analyst' } });
  fireEvent.change(document.getElementById('ae-joining-date'), { target: { value: '2026-06-01' } });
  fireEvent.change(document.getElementById('ae-status'), { target: { value: 'Active' } });
}

function mockApi(record) {
  api.get.mockImplementation(async (url) => {
    if (record && url === `/employees/${record.id}`) return { data: record };
    if (url === '/employees/next-code') return { data: { code: 'EMP043' } };
    return { data: [] };
  });
  api.post.mockResolvedValue({ data: { id: 43 } });
  api.put.mockResolvedValue({ data: { id: record?.id } });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('Add Employee', () => {
  it('without address, account number and IFSC nothing is sent, and the form opens the first one', async () => {
    mockApi();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    fillBasics();
    SAVE();
    expect(await screen.findByText('Current address is required.')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText(/3 fields need attention/)).toBeTruthy();
  });

  it('a malformed account number or IFSC is refused before sending', async () => {
    mockApi();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    fillBasics();
    fillBankAndAddress({ account: '12ab', ifsc: 'BAD' });
    SAVE();
    expect(await screen.findByText(/must be 9–18 digits/)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('with all three, the employee is sent with them', async () => {
    mockApi();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    fillBasics();
    fillBankAndAddress();
    SAVE();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(sent()).toMatchObject({ current_address: '1 Fixture Street', account_number: '123456789012', ifsc_code: 'HDFC0001234' });
  });

  it('says the bank details wait for a second HR person (§204)', async () => {
    mockApi();
    api.post.mockResolvedValue({ data: { id: 43, bank_change_request: { id: 9, status: 'pending' } } });
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    fillBasics();
    fillBankAndAddress();
    SAVE();
    expect(await screen.findByText(/sent to another HR person for approval/)).toBeTruthy();
  });
});

describe('Edit Employee', () => {
  const BASE = { id: 42, office_id: 'EMP042', first_name: 'Asha', last_name: 'Rao', company_email: 'asha@acme.in',
    department: 'Finance', designation: 'Analyst', status: 'Active', joining_date: '2026-01-15' };
  const waitForForm = () => waitFor(() => expect(document.querySelector('form.add-employee-form')).toBeTruthy());

  it('a record that never had bank details or an address can still be saved', async () => {
    mockApi(BASE);
    render(<EditEmployee employee={{ id: 42 }} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    await waitForForm();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
  });

  it('an on-record account number cannot be cleared', async () => {
    mockApi({ ...BASE, account_number: '123456789012', ifsc_code: 'HDFC0001234', current_address: '1 Lake Road' });
    render(<EditEmployee employee={{ id: 42 }} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    await waitForForm();
    fireEvent.click(screen.getByText('Bank Details', { selector: '.accordion-header h2' }));
    await waitFor(() => expect(document.getElementById('ae-account-number').value).toBe('123456789012'));
    fireEvent.change(document.getElementById('ae-account-number'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Bank account number is required.')).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe('verify as-is (§206)', () => {
  const waitForForm = () => waitFor(() => expect(document.querySelector('form.add-employee-form')).toBeTruthy());
  const REC = { id: 42, office_id: 'EMP042', first_name: 'Asha', last_name: 'Rao', company_email: 'asha@acme.in',
    department: 'Finance', designation: 'Analyst', status: 'Active', joining_date: '2026-01-15',
    account_number: '123456789012', ifsc_code: 'HDFC0001234', current_address: '1 Lake Road' };

  it('unverified details on record offer "Request verification", which asks the server and changes nothing', async () => {
    mockApi({ ...REC, bank_verified_at: null });
    api.post.mockResolvedValue({ data: { bank_change_request: { id: 5, status: 'pending', source: 'verify' } } });
    render(<EditEmployee employee={{ id: 42 }} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    await waitForForm();
    fireEvent.click(screen.getByText('Bank Details', { selector: '.accordion-header h2' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Request verification' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employees/42/bank-verification-request'));
    expect(await screen.findByText(/Nothing on the record changes/)).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('verified details offer no such button', async () => {
    mockApi({ ...REC, bank_verified_at: '2026-10-29T10:00:00Z' });
    render(<EditEmployee employee={{ id: 42 }} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    await waitForForm();
    fireEvent.click(screen.getByText('Bank Details', { selector: '.accordion-header h2' }));
    await screen.findByLabelText(/Account Number/);
    expect(screen.queryByRole('button', { name: 'Request verification' })).toBeNull();
  });
});
