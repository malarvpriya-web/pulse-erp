/**
 * Workforce Category on Add Employee and Edit Employee (one form, two modes).
 *
 * The category is stored as an id (employees.workforce_category_id), like
 * branch_id. These tests pin the picker's wiring and the payload: select on
 * Add, prefill / change / clear on Edit, and the label of a category that has
 * since been deactivated. Server-side validation and persistence are covered by
 * backend/src/__tests__/integration.workforceCategory.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

// Add / Edit Employee read the caller's grants (PC-01 closure: the salary is payroll:edit).
// An HR user holding it, as the form was written for.
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../features/employees/pages/AddEmployee.css', () => ({}));
vi.mock('../context/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../components/ResultDialog', () => ({
  default: ({ dialog }) => (dialog ? <div role="dialog">{dialog.title}: {dialog.message}</div> : null),
}));

// Pickers are stubbed as plain inputs; the category picker's props are recorded
// so the test can see HOW it is configured, not just what it holds.
const { Picker, pickerProps } = vi.hoisted(() => {
  const pickerProps = {};
  const Picker = (props) => {
    pickerProps[props.id] = props;
    return (
      <input id={props.id} data-picker="1" value={props.value ?? ''}
        onChange={e => props.onChange(e.target.value, null)} />
    );
  };
  return { Picker, pickerProps };
});
vi.mock('../components/core/MasterSelect', () => ({ default: Picker }));
vi.mock('../components/core/VocabSelect', () => ({ default: Picker }));
vi.mock('../components/core/BranchSelect', () => ({ default: Picker }));
vi.mock('../features/employees/shared/employeeFiles', () => ({
  loadEmployeeImage: vi.fn(async () => null),
  isExternalUrl: () => false,
  openEmployeeFile: vi.fn(async () => null),
}));

import api from '../services/api/client';
import AddEmployee from '../features/employees/pages/AddEmployee.jsx';
import EditEmployee from '../features/employees/pages/EditEmployee.jsx';
import { fillBankAndAddress } from './helpers/addEmployeeRequired';

const RECORD = {
  id: 42, office_id: 'EMP042', first_name: 'Asha', last_name: 'Rao', company_email: 'asha@acme.in',
  department: 'Finance', designation: 'Analyst', status: 'Active', joining_date: '2024-04-01',
  workforce_category_id: 8, workforce_category_name: 'Security', workforce_category_active: true,
};

function mockApi(record = RECORD) {
  api.get.mockImplementation(async (url) => {
    if (url === '/employees/42') return { data: record };
    if (url === '/employees/42/salary-revisions') return { data: [] };
    if (url === '/employees/next-code') return { data: { code: 'EMP043' } };
    return { data: [] };
  });
  api.put.mockResolvedValue({ data: { id: 42 } });
  api.post.mockResolvedValue({ data: { id: 43 } });
}

const openSection = (name) => fireEvent.click(screen.getByText(name, { selector: '.accordion-header h2' }));
const sentBy = (fn) => Object.fromEntries([...fn.mock.calls[0][1].entries()]);
const CATEGORY = 'ae-workforce-category';
const setCategory = (v) => fireEvent.change(document.getElementById(CATEGORY), { target: { value: v } });

const renderEdit = async (record) => {
  mockApi(record);
  render(<EditEmployee employee={{ id: 42 }} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
  await waitFor(() => expect(document.querySelector('form.add-employee-form')).toBeTruthy());
  openSection('Job Information');
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  cleanup();
  for (const k of Object.keys(pickerProps)) delete pickerProps[k];
});

describe('the Workforce Category picker', () => {
  it('is a labelled, id-keyed, clearable picker over the workforce-categories master', async () => {
    mockApi();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    openSection('Job Information');
    expect(screen.getByLabelText('Workforce Category')).toBeTruthy();
    const p = pickerProps[CATEGORY];
    expect(p).toMatchObject({ vocab: 'workforce-categories', optionValue: 'id', searchable: false, value: '' });
  });
});

describe('Add Employee', () => {
  it('sends the chosen category id with the new employee', async () => {
    mockApi();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    fireEvent.change(document.getElementById('ae-first-name'), { target: { value: 'Ravi' } });
    fireEvent.change(document.getElementById('ae-last-name'), { target: { value: 'Kumar' } });
    fireEvent.change(document.getElementById('ae-company-email'), { target: { value: 'ravi@acme.in' } });
    openSection('Job Information');
    fireEvent.change(document.getElementById('ae-department'), { target: { value: 'Finance' } });
    fireEvent.change(document.getElementById('ae-designation'), { target: { value: 'Analyst' } });
    fireEvent.change(document.getElementById('ae-joining-date'), { target: { value: '2026-06-01' } });
    fireEvent.change(document.getElementById('ae-status'), { target: { value: 'Active' } });
    setCategory('3');

    fillBankAndAddress();   // required since §202
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Add Employee|Create)/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employees', expect.anything()));
    expect(sentBy(api.post).workforce_category_id).toBe('3');
  });
});

describe('Edit Employee', () => {
  it('pre-fills the stored category', async () => {
    await renderEdit();
    expect(pickerProps[CATEGORY].value).toBe('8');
  });

  it('sends a changed category', async () => {
    await renderEdit();
    setCategory('2');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(sentBy(api.put).workforce_category_id).toBe('2');
  });

  it('clearing sends an empty value — the server reads that as "none"', async () => {
    await renderEdit();
    setCategory('');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(sentBy(api.put).workforce_category_id).toBe('');
  });

  it('an untouched category is sent back unchanged', async () => {
    await renderEdit();
    fireEvent.change(document.getElementById('ae-designation'), { target: { value: 'Senior Analyst' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(sentBy(api.put).workforce_category_id).toBe('8');
  });

  it('an employee with no category sends an empty value, never the string "null"', async () => {
    await renderEdit({ ...RECORD, workforce_category_id: null, workforce_category_name: null });
    expect(pickerProps[CATEGORY].value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(sentBy(api.put).workforce_category_id).toBe('');
  });

  it('names a deactivated category instead of showing its bare id', async () => {
    await renderEdit({ ...RECORD, workforce_category_active: false });
    expect(pickerProps[CATEGORY].orphanLabel).toBe('Security (inactive)');
  });

  it('does not call an active category inactive', async () => {
    await renderEdit();
    expect(pickerProps[CATEGORY].orphanLabel).toBe('Security');
  });
});
