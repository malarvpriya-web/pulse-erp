/**
 * PC-01 closure decisions 3 and 5 on the screens (manual §231).
 *
 *   Add Employee — without payroll:edit the salary is not an input and is never
 *   sent (the server refuses one with 403 SALARY_PERMISSION); with it, it is.
 *   Leave Encashment — without payroll:edit the claim picker offers only the
 *   signed-in employee; withheld amounts never add up to a ₹0 total.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const auth = vi.hoisted(() => ({ grants: new Set(), user: { id: 1, employee_id: 7 } }));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('../features/employees/pages/AddEmployee.css', () => ({}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }),
}));
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
import LeaveEncashmentPage from '../features/leaves/pages/LeaveEncashmentPage.jsx';
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

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(async (url) => (url === '/employees/next-code' ? { data: { code: 'EMP043' } } : { data: [] }));
  api.post.mockResolvedValue({ data: { id: 43 } });
});

describe('Add Employee — the first salary (decision 5)', () => {
  it('without payroll:edit the salary is not editable and nothing salary-shaped is sent', async () => {
    auth.grants = new Set(['payroll:view']);
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    fillBasics();
    const basic = document.getElementById('ae-basic-salary');
    expect(basic.readOnly).toBe(true);
    expect(basic.value).toBe('Recorded by Payroll');
    expect(screen.getByText(/recorded by Payroll \(it needs payroll edit permission\)/)).toBeTruthy();
    fillBankAndAddress();
    SAVE();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('basic_salary');
    expect(sent()).not.toHaveProperty('special_allowance');
  });

  it('with payroll:edit the first salary is entered and sent', async () => {
    auth.grants = new Set(['payroll:view', 'payroll:edit']);
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    fillBasics();
    const basic = document.getElementById('ae-basic-salary');
    expect(basic.readOnly).toBe(false);
    fireEvent.change(basic, { target: { value: '30000' } });
    fillBankAndAddress();
    SAVE();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(sent()).toMatchObject({ basic_salary: '30000' });
  });
});

describe('Leave Encashment — claims and amounts (decision 3)', () => {
  const EMPLOYEES = [
    { id: 7, first_name: 'Asha', last_name: 'K', employee_code: 'EMP007', status: 'Active' },
    { id: 8, first_name: 'Ravi', last_name: 'M', employee_code: 'EMP008', status: 'Active' },
  ];
  const withRecords = (records) => api.get.mockImplementation(async (url) => {
    if (url === '/leave-encashment') return { data: records };
    if (url === '/employees') return { data: EMPLOYEES };
    return { data: [] };
  });
  const pickerOptions = async () => {
    fireEvent.click(screen.getByRole('button', { name: /New Encashment/ }));
    const select = (await screen.findByText('Select employee…')).closest('select');
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
    return within(select).getAllByRole('option').slice(1).map(o => o.textContent);
  };

  it('without payroll:edit the claim can be only for yourself', async () => {
    auth.grants = new Set(); auth.user = { id: 1, employee_id: 7 };
    withRecords([]);
    render(<LeaveEncashmentPage />);
    expect(await pickerOptions()).toEqual(['Asha K (EMP007)']);
  });

  it('with payroll:edit any employee can be chosen', async () => {
    auth.grants = new Set(['payroll:edit']);
    withRecords([]);
    render(<LeaveEncashmentPage />);
    expect(await pickerOptions()).toEqual(['Asha K (EMP007)', 'Ravi M (EMP008)']);
  });

  it('withheld amounts are not totalled as ₹0', async () => {
    auth.grants = new Set();
    withRecords([{ id: 1, employee_id: 8, employee_name: 'Ravi M', status: 'approved', days_encashed: 2, year: new Date().getFullYear() }]);
    render(<LeaveEncashmentPage />);
    expect(await screen.findByText(/Total Days/)).toBeTruthy();
    expect(screen.queryByText('Gross Encashment')).toBeNull();
    expect(screen.queryByText('Net Payable')).toBeNull();
  });
});
