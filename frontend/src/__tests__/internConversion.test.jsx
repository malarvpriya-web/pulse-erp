/**
 * Convert to Employee — the screens. The server rules (eligibility, one
 * conversion, EMP id, file reuse, both-way links) are covered by
 * internConversionWorkflow.integration.test.js; this checks that:
 *  - Add Employee in conversion mode is the SAME form, pre-filled from the
 *    intern, with the employment fields left for HR, and sends from_intern_id;
 *  - an intern that cannot be converted gets the reason, not a form;
 *  - View Intern offers Convert only when eligible, and links a converted
 *    intern to its employee.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), head: vi.fn() },
}));
vi.mock('../features/employees/pages/AddEmployee.css', () => ({}));
vi.mock('../features/internships/pages/Internships.css', () => ({}));
vi.mock('../context/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../components/ResultDialog', () => ({
  default: ({ dialog }) => (dialog ? <div role="dialog">{dialog.title}: {dialog.message}</div> : null),
}));
const { Picker } = vi.hoisted(() => ({
  Picker: (props) => (
    <input id={props.id} data-picker="1" value={props.value ?? ''} onChange={e => props.onChange(e.target.value, null)} />
  ),
}));
vi.mock('../components/core/MasterSelect', () => ({ default: Picker }));
vi.mock('../components/core/VocabSelect', () => ({ default: Picker }));
vi.mock('../components/core/BranchSelect', () => ({ default: Picker }));
vi.mock('../features/employees/shared/employeeFiles', () => ({
  loadEmployeeImage: vi.fn(async () => 'blob:photo'),
  isExternalUrl: () => false,
  openEmployeeFile: vi.fn(async () => null),
  downloadEmployeeFile: vi.fn(async () => null),
  probeEmployeeFiles: vi.fn(async () => ({})),
}));

import api from '../services/api/client';
import AddEmployee from '../features/employees/pages/AddEmployee.jsx';
import ViewIntern from '../features/internships/pages/ViewIntern.jsx';
import { fillBankAndAddress } from './helpers/addEmployeeRequired';

const SOURCE = {
  intern: { id: 5, intern_code: 'INT005', name: 'Asha Rao', status: 'Completed', photo_url: '/uploads/p.png', resume_file: '/uploads/cv.pdf' },
  eligibility: { eligible: true, reason: null, evaluation_id: 4 },
  prefill: {
    first_name: 'Asha', last_name: 'Rao', dob: '2003-04-05', gender: 'Female', personal_email: 'asha@mail.in',
    phone: '9876543210', current_address: 'Pune', emergency_name: 'Ravi', emergency_phone: '9123456789',
    emergency_relationship: 'Father', highest_qualification: '', notes: 'Converted from internship INT005.',
  },
};

const routeGets = (source = SOURCE) => api.get.mockImplementation(async (url) => {
  if (url === '/interns/5/conversion') return { data: source };
  if (url === '/employees/next-code') return { data: { code: 'EMP047' } };
  return { data: [] };
});

beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); cleanup(); });

describe('Add Employee — conversion mode', () => {
  it('is the Add Employee form, pre-filled from the intern, employment fields left blank', async () => {
    routeGets();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} urlParams={{ fromIntern: '5' }} />);
    expect(await screen.findByText('Convert Intern to Employee')).toBeTruthy();
    expect(screen.getByText(/Converting Asha Rao \(INT005\)/)).toBeTruthy();
    expect(document.getElementById('ae-first-name').value).toBe('Asha');
    expect(document.getElementById('ae-last-name').value).toBe('Rao');
    expect(document.getElementById('ae-company-email').value).toBe('');
    fireEvent.click(screen.getByText('Job Information', { selector: '.accordion-header h2' }));
    expect(document.getElementById('ae-department').value).toBe('');
    expect(document.getElementById('ae-designation').value).toBe('');
    expect(api.get).toHaveBeenCalledWith('/employees/next-code');
  });

  it('sends from_intern_id with the employment details HR enters, then opens the new employee', async () => {
    routeGets();
    api.post.mockResolvedValue({ data: { id: 81, office_id: 'EMP047', source_intern_id: 5 } });
    const setPage = vi.fn();
    render(<AddEmployee employee={null} setPage={setPage} setSelectedEmployee={vi.fn()} urlParams={{ fromIntern: '5' }} />);
    await screen.findByText('Convert Intern to Employee');
    fireEvent.change(document.getElementById('ae-company-email'), { target: { value: 'asha.rao@acme.in' } });
    fireEvent.click(screen.getByText('Job Information', { selector: '.accordion-header h2' }));
    fireEvent.change(document.getElementById('ae-department'), { target: { value: 'Engineering' } });
    fireEvent.change(document.getElementById('ae-designation'), { target: { value: 'Software Engineer' } });
    fireEvent.change(document.getElementById('ae-joining-date'), { target: { value: '2026-10-20' } });
    fireEvent.change(document.getElementById('ae-status'), { target: { value: 'Active' } });
    fillBankAndAddress();   // required since §202
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Add Employee|Create)/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employees', expect.any(FormData)));
    const fd = api.post.mock.calls[0][1];
    expect(fd.get('from_intern_id')).toBe('5');
    expect(fd.get('first_name')).toBe('Asha');
    expect(fd.get('personal_email')).toBe('asha@mail.in');
    expect(fd.get('department')).toBe('Engineering');
    expect(fd.get('photo_file')).toBeNull();      // the intern's stored photo is reused server-side
    expect((await screen.findByRole('dialog')).textContent).toMatch(/INT005 is now employee EMP047/);
    await waitFor(() => expect(setPage).toHaveBeenCalledWith('EmployeeProfile', { id: 81 }), { timeout: 3000 });
  });

  it('an intern that cannot be converted gets the reason, never the form', async () => {
    routeGets({ ...SOURCE, eligibility: { eligible: false, reason: 'Mark the internship Completed first.' } });
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} urlParams={{ fromIntern: '5' }} />);
    expect(await screen.findByText(/cannot be converted: Mark the internship Completed first\./)).toBeTruthy();
    expect(screen.getByText('Cannot convert this intern')).toBeTruthy();
    expect(screen.queryByText('Could not load this')).toBeNull();
    expect(document.getElementById('ae-first-name')).toBeNull();
  });

  it('a failed load keeps the generic heading and offers a retry', async () => {
    api.get.mockImplementation(async (url) => {
      if (url === '/interns/5/conversion') throw Object.assign(new Error('x'), { response: { data: { error: 'Intern not found' } } });
      return { data: [] };
    });
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} urlParams={{ fromIntern: '5' }} />);
    expect(await screen.findByText('Intern not found')).toBeTruthy();
    expect(screen.getByText('Could not load this')).toBeTruthy();
    expect(screen.queryByText('Cannot convert this intern')).toBeNull();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
  });

  it('when a login is also created, the dialog uses conversion wording and still explains the sign-in', async () => {
    routeGets();
    api.post.mockResolvedValue({ data: { id: 81, office_id: 'EMP047', source_intern_id: 5,
      login: { email: 'asha.rao@acme.in', created: true } } });
    const setPage = vi.fn();
    render(<AddEmployee employee={null} setPage={setPage} setSelectedEmployee={vi.fn()} urlParams={{ fromIntern: '5' }} />);
    await screen.findByText('Convert Intern to Employee');
    fireEvent.change(document.getElementById('ae-company-email'), { target: { value: 'asha.rao@acme.in' } });
    fireEvent.click(screen.getByText('Job Information', { selector: '.accordion-header h2' }));
    fireEvent.change(document.getElementById('ae-department'), { target: { value: 'Engineering' } });
    fireEvent.change(document.getElementById('ae-designation'), { target: { value: 'Software Engineer' } });
    fireEvent.change(document.getElementById('ae-joining-date'), { target: { value: '2026-10-20' } });
    fireEvent.change(document.getElementById('ae-status'), { target: { value: 'Active' } });
    fillBankAndAddress();   // required since §202
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Add Employee|Create)/ }));
    const dialog = (await screen.findByRole('dialog')).textContent;
    expect(dialog).toMatch(/^Intern Converted to Employee — Login Created/);
    expect(dialog).not.toMatch(/Employee Added/);
    expect(dialog).toContain('INT005 is now employee EMP047');
    expect(dialog).toContain('asha.rao@acme.in');
    expect(dialog).toContain('Forgot password?');
    expect(dialog).not.toMatch(/password: |Welcome@/i);
  });

  it('without fromIntern it is the ordinary Add Employee form', async () => {
    routeGets();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} urlParams={{}} />);
    expect(screen.getByText('Add Employee')).toBeTruthy();
    expect(document.getElementById('ae-first-name').value).toBe('');
    expect(api.get).not.toHaveBeenCalledWith('/interns/5/conversion');
  });
});

describe('View Intern — conversion', () => {
  const INTERN = {
    id: 5, intern_code: 'INT005', first_name: 'Asha', last_name: 'Rao', status: 'Completed', completion_stage: 'Certificate Issued',
    department: 'Engineering', designation: 'Intern', start_date: '2026-04-01', end_date: '2026-09-30', duration_days: 183,
    documents: [], certificates: [], lifecycle_events: [], completion: { eligible: false }, completion_evaluation_id: 4,
  };
  const show = (intern) => api.get.mockImplementation(async () => ({ data: intern }));

  it('offers Convert to Employee when eligible, opening Add Employee in conversion mode', async () => {
    show({ ...INTERN, conversion: { eligible: true } });
    const setPage = vi.fn();
    render(<ViewIntern setPage={setPage} urlParams={{ id: '5' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert to Employee' }));
    expect(setPage).toHaveBeenCalledWith('AddEmployee', { fromIntern: 5 });
  });

  it('disables it with the reason when not eligible', async () => {
    show({ ...INTERN, conversion: { eligible: false, reason: 'Needs an HR-approved mentor evaluation recommending employment.' } });
    render(<ViewIntern setPage={vi.fn()} urlParams={{ id: '5' }} />);
    const btn = await screen.findByRole('button', { name: 'Convert to Employee' });
    expect(btn).toBeDisabled();
    expect(btn.title).toMatch(/recommending employment/);
  });

  it('a converted intern stays viewable and links to its employee', async () => {
    show({ ...INTERN, converted_employee_id: 81, converted_employee_code: 'EMP047', converted_at: '2026-10-13T10:00:00Z',
      conversion: { eligible: false, reason: 'Already converted to an employee.' } });
    const setPage = vi.fn();
    render(<ViewIntern setPage={setPage} urlParams={{ id: '5' }} />);
    expect(await screen.findByText('Converted to Employee:')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Convert to Employee' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'EMP047' }));
    expect(setPage).toHaveBeenCalledWith('EmployeeProfile', { id: 81 });
    expect(sessionStorage.getItem('selectedEmployeeId')).toBe('81');
  });
});
