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
import ExitClearanceBlock from '../features/hr/components/ExitClearanceBlock';
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
      // §274: absconding is its own exit type (the F&F engine treats it differently).
      form: { employee_id: '7', separation_type: 'absconding', last_working_date: '2026-11-30', reason: 'Absconding' },
      name: 'Zz Leaver', typeMapped: true,
    });
    expect(initiateHandOff('?initiate=7&reason=Contract%20End').form.separation_type).toBe('contract_expiry');
    expect(initiateHandOff('?initiate=7&reason=Other').typeMapped).toBe(false);
    expect(initiateHandOff('?initiate=abc')).toBeNull();
    expect(initiateHandOff('?tab=exit')).toBeNull();
    expect(initiateHandOff('?initiate=7&lwd=not-a-date').form.last_working_date).toBe('');
  });

  describe('Exit Management opened from a hand-off', () => {
    beforeEach(() => {
      window.history.pushState({}, '', '/ExitCenter?tab=exit&initiate=7&lwd=2026-11-30&reason=Termination&name=Zz%20Leaver');
      api.get.mockImplementation(async (url) => (url.startsWith('/employees')
        ? { data: [{ id: 7, office_id: 'EMP007', first_name: 'Zz', last_name: 'Leaver', notice_period_days: 30 }] }
        : { data: [] }));
      api.post.mockResolvedValue({ data: { id: 99, notified: 1 } });
    });
    afterEach(() => { window.history.pushState({}, '', '/'); });

    it('opens Initiate Exit pre-filled and posts the exit through /exit/initiate', async () => {
      render(<ExitManagement />);
      expect(await screen.findByText(/Starting the exit of/)).toHaveTextContent('Zz Leaver');
      // The employee is chosen from a list, not typed as an id (§274).
      await waitFor(() => expect(screen.getByLabelText('Employee *')).toHaveDisplayValue('Zz Leaver (EMP007)'));
      expect(screen.getByLabelText('Employee *').value).toBe('7');
      expect(screen.getByDisplayValue('2026-11-30')).toBeTruthy();
      expect(screen.getByLabelText('Notice period (days)')).toHaveAttribute('placeholder', '30 (contract)');
      // Both the separation type (mapped from the reason) and the reason text read "Termination".
      const shown = screen.getAllByDisplayValue('Termination');
      expect(shown.map(el => el.tagName).sort()).toEqual(['INPUT', 'SELECT']);
      fireEvent.click(screen.getByRole('button', { name: /^Initiate/ }));
      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/exit/initiate', {
        employee_id: '7', separation_type: 'termination', last_working_date: '2026-11-30', reason: 'Termination',
        resignation_date: null, notice_period: null,
      }));
      expect(await screen.findByText('Exit started. 1 manager notified.')).toBeTruthy();
      expect(api.put).not.toHaveBeenCalled();
    });

    it('refuses to send without a last working day and shows the server reason on failure', async () => {
      window.history.pushState({}, '', '/ExitCenter?tab=exit&initiate=7&reason=Termination&name=Zz%20Leaver');
      render(<ExitManagement />);
      await waitFor(() => expect(screen.getByLabelText('Employee *').value).toBe('7'));
      fireEvent.click(screen.getByRole('button', { name: /^Initiate/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Enter the last working day.');
      expect(api.post).not.toHaveBeenCalled();

      api.post.mockRejectedValueOnce({ response: { data: { error: 'Zz Leaver already has an open exit (#5, active).' } } });
      fireEvent.change(screen.getByLabelText('Last working day *'), { target: { value: '2026-12-31' } });
      fireEvent.click(screen.getByRole('button', { name: /^Initiate/ }));
      expect(await screen.findByText(/already has an open exit/)).toBeTruthy();
    });
  });

  describe('notice period on Initiate (§275)', () => {
    beforeEach(() => {
      window.history.pushState({}, '', '/ExitCenter');
      api.get.mockImplementation(async (url) => {
        if (url.startsWith('/employees')) return { data: [{ id: 8, office_id: 'EMP008', first_name: 'Ravi', last_name: 'K', notice_period_days: 90 }] };
        if (url === '/analytics/workforce-settings') return { data: { settings: { default_notice_period_days: 90 } } };
        return { data: [] };
      });
    });

    it('fills the last working day from the resignation date and notice, and flags an early release', async () => {
      render(<ExitManagement />);
      fireEvent.click(screen.getByRole('button', { name: '+ Initiate Exit' }));
      await waitFor(() => expect(screen.getByLabelText('Employee *')).toHaveTextContent('Ravi K (EMP008)'));
      fireEvent.change(screen.getByLabelText('Employee *'), { target: { value: '8' } });
      fireEvent.change(screen.getByLabelText('Resignation / notice date'), { target: { value: '2026-11-12' } });
      // 90 days, the resignation day counted as served (as F&F counts it): 12 Nov + 89.
      expect(screen.getByLabelText('Last working day *')).toHaveValue('2027-02-09');
      expect(screen.getByText(/Full 90-day notice served/)).toBeTruthy();

      fireEvent.change(screen.getByLabelText('Last working day *'), { target: { value: '2027-01-31' } });
      expect(screen.getByText(/Released 9 days early/)).toBeTruthy();
      // Once typed, the date is HR's: changing the notice no longer moves it.
      fireEvent.change(screen.getByLabelText('Notice period (days)'), { target: { value: '30' } });
      expect(screen.getByLabelText('Last working day *')).toHaveValue('2027-01-31');
    });

    it('a one-month notice moves the suggested date', async () => {
      render(<ExitManagement />);
      fireEvent.click(screen.getByRole('button', { name: '+ Initiate Exit' }));
      await waitFor(() => expect(screen.getByLabelText('Employee *')).toHaveTextContent('Ravi K (EMP008)'));
      fireEvent.change(screen.getByLabelText('Employee *'), { target: { value: '8' } });
      fireEvent.change(screen.getByLabelText('Notice period (days)'), { target: { value: '30' } });
      fireEvent.change(screen.getByLabelText('Resignation / notice date'), { target: { value: '2026-11-12' } });
      expect(screen.getByLabelText('Last working day *')).toHaveValue('2026-12-11');
    });
  });

  describe('Active exits: edit and clearance', () => {
    const EXIT = { id: 5, employee_id: 7, employee_name: 'Zz Leaver', employee_code: 'EMP007', department: 'Finance',
      separation_type: 'resignation', last_working_date: '2026-12-31', resignation_date: '2026-12-01', notice_period: 30,
      reason: 'Moving', status: 'active', fnf_status: 'draft', days_remaining: 40 };
    beforeEach(() => { window.history.pushState({}, '', '/ExitCenter'); });

    it('edits the exit details through PUT /exit/requests/:id', async () => {
      api.get.mockImplementation(async (url) => (url === '/exit/active' ? { data: [EXIT] } : { data: [] }));
      api.put.mockResolvedValue({ data: { id: 5, fnf_recompute_needed: true } });
      render(<ExitManagement />);
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText('Last working day *'), { target: { value: '2027-01-15' } });
      fireEvent.change(screen.getByLabelText('Exit type *'), { target: { value: 'retrenchment' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledWith('/exit/requests/5', {
        separation_type: 'retrenchment', last_working_date: '2027-01-15', resignation_date: '2026-12-01', notice_period: 30, reason: 'Moving',
      }));
      expect(await screen.findByText(/recalculate/)).toBeTruthy();
    });

    it('shows when the F&F is due, or how late it is (§276)', async () => {
      api.get.mockImplementation(async (url) => (url === '/exit/active' ? { data: [
        { ...EXIT, fnf_due_date: '2027-01-02', gratuity_due_date: '2027-01-30', fnf_days_late: 0 },
        { ...EXIT, id: 6, employee_id: 9, employee_name: 'Late Leaver', fnf_due_date: '2026-11-03', fnf_days_late: 9 },
      ] } : { data: [] }));
      render(<ExitManagement />);
      expect(await screen.findByText('Due 02 Jan 27')).toBeTruthy();
      expect(screen.getByText('9 days late')).toBeTruthy();
    });

    it('once the employee has left: letter buttons, no Withdraw (§276)', async () => {
      URL.createObjectURL = vi.fn(() => 'blob:x');
      URL.revokeObjectURL = vi.fn();
      api.get.mockImplementation(async (url) => {
        if (url === '/exit/active') return { data: [{ ...EXIT, employee_status: 'Left' }] };
        if (url.includes('/letter/')) return { data: new Blob(['%PDF']), headers: { 'content-disposition': 'attachment; filename="Relieving_Letter_EMP007.pdf"' } };
        return { data: [] };
      });
      render(<ExitManagement />);
      fireEvent.click(await screen.findByRole('button', { name: 'Relieving' }));
      await waitFor(() => expect(api.get).toHaveBeenCalledWith('/exit/employee/7/letter/relieving', { responseType: 'blob' }));
      expect(screen.getByRole('button', { name: 'Experience' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    });

    it('a refused letter shows the server reason', async () => {
      api.get.mockImplementation(async (url) => {
        if (url === '/exit/active') return { data: [{ ...EXIT, employee_status: 'Left' }] };
        if (url.includes('/letter/')) {
          throw { response: { status: 409, data: new Blob([JSON.stringify({ error: 'The exit has no last working day.' })], { type: 'application/json' }) } };
        }
        return { data: [] };
      });
      render(<ExitManagement />);
      fireEvent.click(await screen.findByRole('button', { name: 'Experience' }));
      expect(await screen.findByText('The exit has no last working day.')).toBeTruthy();
    });

    it('does not offer Edit once F&F is approved', async () => {
      api.get.mockImplementation(async (url) => (url === '/exit/active' ? { data: [{ ...EXIT, fnf_status: 'approved' }] } : { data: [] }));
      render(<ExitManagement />);
      expect(await screen.findByRole('button', { name: 'Edit' })).toBeDisabled();
    });

    // Clearance moved into the one Exit Checklist (owner decision 2026-11-17):
    // the sign-offs are in ExitClearanceBlock, on the Exit Checklist tab.
    it('puts a sign-off tick back when the save fails (Exit Checklist)', async () => {
      api.get.mockImplementation(async (url) => {
        if (url === '/exit/clearance/7') return { data: { noc_hr: false } };
        if (url === '/exit/clearance/7/status') return { data: { blockers: [{ key: 'hr', cleared: false }], can_settle: false } };
        return { data: [] };
      });
      api.put.mockRejectedValueOnce({ response: { data: { error: 'HR admin access required for this operation' } } });
      const onNotice = vi.fn();
      render(<ExitClearanceBlock employee={{ id: 7 }} onNotice={onNotice} />);
      const box = await screen.findByRole('checkbox', { name: /HR sign-off/ });
      expect(box).not.toBeChecked();
      fireEvent.click(box);
      await waitFor(() => expect(onNotice).toHaveBeenCalledWith('HR admin access required for this operation', 'error'));
      await waitFor(() => expect(box).not.toBeChecked());
    });

    it('Exit Management has no Clearance Tracker tab any more', async () => {
      api.get.mockImplementation(async (url) => (url === '/exit/active' ? { data: [EXIT] } : { data: [] }));
      render(<ExitManagement />);
      await screen.findByText('Zz Leaver');
      expect(screen.queryByRole('button', { name: 'Clearance Tracker' })).toBeNull();
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
