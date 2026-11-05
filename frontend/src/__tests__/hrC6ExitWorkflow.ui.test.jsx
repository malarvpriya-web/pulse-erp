/**
 * Containment C6 / MD-14 on screen: an employee leaves through Exit Management.
 *  - Add / Edit Employee no longer offers 'Left' (kept only for a record that is
 *    already Left, so editing an ex-employee is not forced into a change).
 *  - All Employees → Terminate hands off to Exit Management → Initiate Exit,
 *    which opens pre-filled from the URL (initiateHandOff).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../features/employees/pages/AddEmployee.css', () => ({}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ role: 'hr_manager', hasPermission: () => true }) }));
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
vi.mock('../features/_shared/exportUtils', () => ({ exportCSV: vi.fn() }));
vi.mock('../hooks/usePageAccess', () => ({ usePageAccess: () => ({ readOnly: false, canEdit: true }) }));
vi.mock('../features/employees/pages/EmployeesData.css', () => ({}));

import api from '../services/api/client';
import AddEmployee from '../features/employees/pages/AddEmployee.jsx';
import EditEmployee from '../features/employees/pages/EditEmployee.jsx';
import ExitManagement from '../features/hr/pages/ExitManagement.jsx';
import { initiateHandOff } from '../features/hr/exitHandOff';
import EmployeesData from '../features/employees/pages/EmployeesData.jsx';

const statusOptions = () => [...document.getElementById('ae-status').options].map(o => o.value);
const waitForForm = () => waitFor(() => expect(document.querySelector('form.add-employee-form')).toBeTruthy());
const REC = (status) => ({ id: 42, office_id: 'EMP042', first_name: 'Asha', last_name: 'Rao', company_email: 'asha@acme.in',
  department: 'Finance', designation: 'Analyst', status, joining_date: '2026-01-15',
  account_number: '123456789012', ifsc_code: 'HDFC0001234', current_address: '1 Lake Road' });

function mockApi(record) {
  api.get.mockImplementation(async (url) => {
    if (record && url === `/employees/${record.id}`) return { data: record };
    if (url === '/employees/next-code') return { data: { code: 'EMP043' } };
    return { data: [] };
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('Add / Edit Employee status field', () => {
  it('Add Employee does not offer Left', async () => {
    mockApi();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    fireEvent.click(screen.getByText('Job Information', { selector: '.accordion-header h2' }));
    expect(statusOptions()).toEqual(['Active', 'Probation', 'Notice']);
    expect(screen.getByText(/use Exit Management/)).toBeTruthy();
  });

  it('Edit of a current employee does not offer Left', async () => {
    mockApi(REC('Active'));
    render(<EditEmployee employee={{ id: 42 }} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    await waitForForm();
    fireEvent.click(screen.getByText('Job Information', { selector: '.accordion-header h2' }));
    expect(statusOptions()).not.toContain('Left');
  });

  it('Edit of an employee who has already Left keeps Left selectable and selected', async () => {
    mockApi(REC('Left'));
    render(<EditEmployee employee={{ id: 42 }} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    await waitForForm();
    fireEvent.click(screen.getByText('Job Information', { selector: '.accordion-header h2' }));
    expect(statusOptions()).toContain('Left');
    expect(document.getElementById('ae-status').value).toBe('Left');
  });
});

describe('Terminate → Exit Management hand-off', () => {
  it('maps the URL a Terminate hand-off sends', () => {
    expect(initiateHandOff('?tab=exit&initiate=7&lwd=2026-11-30&reason=Absconding&name=Zz%20Leaver')).toEqual({
      form: { employee_id: '7', separation_type: 'termination', last_working_date: '2026-11-30', reason: 'Absconding' },
      name: 'Zz Leaver', typeMapped: true,
    });
    expect(initiateHandOff('?initiate=7&reason=Contract%20End').typeMapped).toBe(false);
    expect(initiateHandOff('?initiate=abc')).toBeNull();
    expect(initiateHandOff('?tab=exit')).toBeNull();
    expect(initiateHandOff('?initiate=7&lwd=not-a-date').form.last_working_date).toBe('');
  });

  describe('Exit Management opened from a hand-off', () => {
    beforeEach(() => {
      window.history.pushState({}, '', '/ExitCenter?tab=exit&initiate=7&lwd=2026-11-30&reason=Termination&name=Zz%20Leaver');
      api.get.mockResolvedValue({ data: [] });
      api.post.mockResolvedValue({ data: { id: 99 } });
    });
    afterEach(() => { window.history.pushState({}, '', '/'); });

    it('opens Initiate Exit pre-filled and posts the exit through /exit/initiate', async () => {
      render(<ExitManagement />);
      expect(await screen.findByText(/Starting the exit of/)).toHaveTextContent('Zz Leaver');
      expect(screen.getByDisplayValue('7')).toBeTruthy();
      expect(screen.getByDisplayValue('2026-11-30')).toBeTruthy();
      // Both the separation type (mapped from the reason) and the reason text read "Termination".
      const shown = screen.getAllByDisplayValue('Termination');
      expect(shown.map(el => el.tagName).sort()).toEqual(['INPUT', 'SELECT']);
      fireEvent.click(screen.getByRole('button', { name: /^Initiate/ }));
      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/exit/initiate', {
        employee_id: '7', separation_type: 'termination', last_working_date: '2026-11-30', reason: 'Termination',
      }));
      expect(api.put).not.toHaveBeenCalled();
    });
  });

  it('All Employees → Terminate writes nothing and opens Exit Management pre-filled', async () => {
    const emp = { id: 7, office_id: 'EMP007', first_name: 'Zz', last_name: 'Leaver', status: 'Active',
      department: 'Finance', designation: 'Analyst', joining_date: '2025-01-01' };
    api.get.mockImplementation(async (url) => (url.startsWith('/employees') ? { data: [emp] } : { data: [] }));
    const setPage = vi.fn();
    render(<EmployeesData setPage={setPage} setSelectedEmployee={vi.fn()} />);
    fireEvent.click(await screen.findByTitle('Terminate employee'));
    const dialog = screen.getByText('Terminate Employee').closest('.ed-modal');
    fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: '2026-12-15' } });
    fireEvent.change(dialog.querySelector('select'), { target: { value: 'Absconding' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue in Exit Management' }));
    expect(setPage).toHaveBeenCalledWith('ExitCenter', {
      tab: 'exit', initiate: '7', lwd: '2026-12-15', reason: 'Absconding', name: 'Zz Leaver',
    });
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('without a hand-off, Initiate stays closed', async () => {
    api.get.mockResolvedValue({ data: [] });
    render(<ExitManagement />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByText('Initiate Employee Separation')).toBeNull();
  });
});
