/**
 * Probation on Add / Edit Employee, and on the Probation page.
 *
 * employees.probation_end_date is the ONE canonical end date and the server
 * calculates it (backend shared/probationDates.js). These tests pin what the
 * screens do with that:
 *
 *  - Edit Employee sends every field on every save, so the probation keys must
 *    travel ONLY when a probation field was changed — an unrelated edit must
 *    never rewrite a saved end date, including one set by hand.
 *  - A changed joining date does not silently move the end date; the form
 *    offers to recalculate.
 *  - The form shows the server's preview and sends the PERIOD; an end date is
 *    sent only when typed by hand.
 *  - The Probation page shows the STORED end date (it used to show joining +
 *    180 days) and opening it posts nothing (it used to auto-alert on load).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../features/employees/pages/AddEmployee.css', () => ({}));
vi.mock('../features/employees/pages/EmployeesData.css', () => ({}));
vi.mock('../features/hr/pages/Probation.css', () => ({}));
// The Probation page now hosts the Department Heads panel, which reads
// permissions through useAuth(); a viewer without hr:edit is enough here.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => false }),
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
  loadEmployeeImage: vi.fn(async () => null),
  isExternalUrl: () => false,
  openEmployeeFile: vi.fn(async () => null),
}));

import api from '../services/api/client';
import AddEmployee from '../features/employees/pages/AddEmployee.jsx';
import EditEmployee from '../features/employees/pages/EditEmployee.jsx';
import Probation from '../features/hr/pages/Probation.jsx';
import { fillBankAndAddress } from './helpers/addEmployeeRequired';

const ON_PROBATION = {
  id: 42, office_id: 'EMP042', first_name: 'Asha', last_name: 'Rao', company_email: 'asha@acme.in',
  department: 'Finance', designation: 'Analyst', status: 'Probation', joining_date: '2026-01-15',
  // Set by hand earlier: NOT what any month rule gives for 15-Jan.
  probation_end_date: '2026-09-30', probation_months: null,
};

/** Server-side preview stub: same rule as shared/probationDates.js for these cases. */
const PREVIEW = {
  '2026-01-15|6': '2026-07-14', '2026-01-15|3': '2026-04-14',
  '2026-06-01|6': '2026-11-30', '2026-03-01|6': '2026-08-31',
};

function mockApi(record = ON_PROBATION) {
  api.get.mockImplementation(async (url, cfg) => {
    if (url === `/employees/${record.id}`) return { data: record };
    if (url === `/employees/${record.id}/salary-revisions`) return { data: [] };
    if (url === '/employees/next-code') return { data: { code: 'EMP043' } };
    if (url === '/probation/calculate') {
      const months = cfg?.params?.months ?? '6';
      return {
        data: {
          joining_date: cfg.params.joining_date,
          probation_months: Number(months),
          probation_end_date: PREVIEW[`${cfg.params.joining_date}|${months}`] ?? '2099-01-01',
          policy: { probation_months: 6, reminder_days: 14 },
        },
      };
    }
    return { data: [] };
  });
  api.put.mockResolvedValue({ data: { id: record.id } });
  api.post.mockResolvedValue({ data: { id: 43 } });
}

const openJob = () => fireEvent.click(screen.getByText('Job Information', { selector: '.accordion-header h2' }));
const sent = (mock) => Object.fromEntries([...mock.mock.calls[0][1].entries()]);
const calcCalls = () => api.get.mock.calls.filter(([u]) => u === '/probation/calculate');
const renderEdit = () => render(<EditEmployee employee={{ id: 42 }} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
const waitForForm = () => waitFor(() => expect(document.querySelector('form.add-employee-form')).toBeTruthy());

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  cleanup();
});

describe('Edit Employee keeps a saved probation end date', () => {
  it('shows the stored date and sends NO probation keys on an unrelated edit', async () => {
    mockApi();
    renderEdit();
    await waitForForm();
    // Basic Information is the open section; opening Job closes it, so edit first.
    fireEvent.change(document.getElementById('ae-first-name'), { target: { value: 'Asha K' } });
    openJob();
    expect(document.getElementById('ae-probation-end').value).toBe('2026-09-30');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());

    const body = sent(api.put);
    expect(body.first_name).toBe('Asha K');
    expect(body).not.toHaveProperty('probation_end_date');
    expect(body).not.toHaveProperty('probation_months');
    expect(calcCalls()).toHaveLength(0);   // nothing was recalculated behind the user's back
  });

  it('with a stored PERIOD too, an unrelated edit still sends neither key (the server would recalculate)', async () => {
    // probation_months is stored AND the end date was later set by hand. If
    // the form re-sent the period, the server would recalculate the end date
    // from it and silently replace the hand-set one.
    mockApi({ ...ON_PROBATION, probation_months: 6 });
    renderEdit();
    await waitForForm();
    fireEvent.change(document.getElementById('ae-first-name'), { target: { value: 'Asha K' } });
    openJob();
    expect(document.getElementById('ae-probation-months').value).toBe('6');
    expect(document.getElementById('ae-probation-end').value).toBe('2026-09-30');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = sent(api.put);
    expect(body).not.toHaveProperty('probation_months');
    expect(body).not.toHaveProperty('probation_end_date');
  });

  it('a changed joining date does not move the end date silently — it offers a recalculation', async () => {
    mockApi();
    renderEdit();
    await waitForForm();
    openJob();
    fireEvent.change(document.getElementById('ae-joining-date'), { target: { value: '2026-03-01' } });
    expect(document.getElementById('ae-probation-end').value).toBe('2026-09-30');
    expect(screen.getByRole('button', { name: 'Recalculate the end date' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = sent(api.put);
    expect(body.joining_date).toBe('2026-03-01');
    expect(body).not.toHaveProperty('probation_end_date');
    expect(body).not.toHaveProperty('probation_months');
  });

  it('Recalculate shows the server date for the new joining date and sends the period', async () => {
    mockApi();
    renderEdit();
    await waitForForm();
    openJob();
    fireEvent.change(document.getElementById('ae-joining-date'), { target: { value: '2026-03-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate the end date' }));
    await waitFor(() => expect(document.getElementById('ae-probation-end').value).toBe('2026-08-31'));
    expect(document.getElementById('ae-probation-months').value).toBe('6');   // company default made explicit

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = sent(api.put);
    expect(body.probation_months).toBe('6');
    expect(body).not.toHaveProperty('probation_end_date');   // the server calculates it
  });

  it('changing the period previews the server date and sends only the period', async () => {
    mockApi();
    renderEdit();
    await waitForForm();
    openJob();
    fireEvent.change(document.getElementById('ae-probation-months'), { target: { value: '3' } });
    await waitFor(() => expect(document.getElementById('ae-probation-end').value).toBe('2026-04-14'));
    expect(calcCalls().at(-1)[1].params).toEqual({ joining_date: '2026-01-15', months: '3' });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = sent(api.put);
    expect(body.probation_months).toBe('3');
    expect(body).not.toHaveProperty('probation_end_date');
  });

  it('an end date typed by hand is sent exactly', async () => {
    mockApi();
    renderEdit();
    await waitForForm();
    openJob();
    fireEvent.change(document.getElementById('ae-probation-end'), { target: { value: '2026-10-31' } });
    expect(screen.getByText('Set by hand — saved exactly as entered.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(sent(api.put).probation_end_date).toBe('2026-10-31');
  });

  it('refuses an end date before the joining date, on the field', async () => {
    mockApi();
    renderEdit();
    await waitForForm();
    openJob();
    fireEvent.change(document.getElementById('ae-probation-end'), { target: { value: '2025-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Probation end date cannot be before the joining date.')).toBeTruthy());
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe('Add Employee', () => {
  const fillRequired = (status) => {
    fireEvent.change(document.getElementById('ae-first-name'), { target: { value: 'Ravi' } });
    fireEvent.change(document.getElementById('ae-last-name'), { target: { value: 'Kumar' } });
    fireEvent.change(document.getElementById('ae-company-email'), { target: { value: 'ravi@acme.in' } });
    openJob();
    fireEvent.change(document.getElementById('ae-department'), { target: { value: 'Finance' } });
    fireEvent.change(document.getElementById('ae-designation'), { target: { value: 'Analyst' } });
    fireEvent.change(document.getElementById('ae-joining-date'), { target: { value: '2026-06-01' } });
    fireEvent.change(document.getElementById('ae-status'), { target: { value: status } });
  };

  it('a Probation hire shows the company-default period and its server end date, and sends the period', async () => {
    mockApi();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    fillRequired('Probation');
    await waitFor(() => expect(document.getElementById('ae-probation-end').value).toBe('2026-11-30'));
    expect(document.getElementById('ae-probation-months').value).toBe('6');

    fillBankAndAddress();   // required since §202
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Add Employee|Create)/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const body = sent(api.post);
    expect(body.status).toBe('Probation');
    expect(body.probation_months).toBe('6');
    expect(body).not.toHaveProperty('probation_end_date');
  });

  it('an Active hire shows no probation fields and sends none', async () => {
    mockApi();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    fillRequired('Active');
    expect(document.getElementById('ae-probation-months')).toBeNull();
    fillBankAndAddress();   // required since §202
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Add Employee|Create)/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const body = sent(api.post);
    expect(body).not.toHaveProperty('probation_months');
    expect(body).not.toHaveProperty('probation_end_date');
  });
});

describe('Probation page reads the stored end date', () => {
  const probationer = {
    id: 7, office_id: 'EMP007', first_name: 'Neha', last_name: 'Iyer', department: 'Sales',
    status: 'Probation', joining_date: '2026-01-01',
    // joining + 180 days would be 30-Jun; the stored date is what must show.
    probation_end_date: '2026-03-31',
  };
  const undated = { id: 8, office_id: 'EMP008', first_name: 'Ravi', last_name: 'Das', status: 'Probation',
    joining_date: '2026-02-26', probation_end_date: null };

  function mockPage() {
    api.get.mockImplementation(async (url, cfg) => {
      if (url === '/employees' && cfg?.params?.status === 'Probation') return { data: [probationer, undated] };
      if (url === '/probation/settings') {
        return { data: { probation_months: 6, reminder_days: 14, months_is_default: true, reminder_days_is_default: true } };
      }
      return { data: [] };
    });
  }

  it('shows the stored date, flags the undated one, and posts nothing on load', async () => {
    mockPage();
    render(<Probation />);
    await waitFor(() => expect(screen.getByText('Neha Iyer')).toBeTruthy());
    expect(screen.getByText('31 Mar 26')).toBeTruthy();
    expect(screen.queryByText('30 Jun 26')).toBeNull();
    expect(screen.getByText('No end date')).toBeTruthy();
    expect(screen.getByText('Not set — edit the employee')).toBeTruthy();
    expect(screen.getByText(/Default probation/).textContent).toMatch(/6 months/);
    // Give any effect a chance to fire, then prove nothing was sent.
    await new Promise((r) => setTimeout(r, 50));
    expect(api.post).not.toHaveBeenCalled();
  });
});
