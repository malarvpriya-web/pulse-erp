/**
 * The Add Employee success dialog after a sign-in account is auto-created.
 *
 * It used to print "Temporary password: <password>" from the API response. The
 * API no longer sends one; the dialog now points HR at the sign-in page's
 * "Forgot password?" flow. The second case feeds it a response that STILL
 * carries a password (an older backend) to prove the form never displays one.
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

// Pickers are plain inputs here; their own suites cover them.
const { Picker } = vi.hoisted(() => ({
  Picker: (props) => (
    <input id={props.id} data-picker="1" value={props.value ?? ''}
      onChange={e => props.onChange(e.target.value, null)} />
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
import { fillBankAndAddress } from './helpers/addEmployeeRequired';


async function submitNewHire(response) {
  api.get.mockResolvedValue({ data: [] });
  api.post.mockResolvedValue({ data: response });
  render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
  fireEvent.change(document.getElementById('ae-first-name'), { target: { value: 'Ravi' } });
  fireEvent.change(document.getElementById('ae-last-name'), { target: { value: 'Kumar' } });
  fireEvent.change(document.getElementById('ae-company-email'), { target: { value: 'ravi@acme.in' } });
  fireEvent.click(screen.getByText('Job Information', { selector: '.accordion-header h2' }));
  fireEvent.change(document.getElementById('ae-department'), { target: { value: 'Finance' } });
  fireEvent.change(document.getElementById('ae-designation'), { target: { value: 'Analyst' } });
  fireEvent.change(document.getElementById('ae-joining-date'), { target: { value: '2026-06-01' } });
  fireEvent.change(document.getElementById('ae-status'), { target: { value: 'Active' } });
  fillBankAndAddress();   // required since §202
  fireEvent.click(screen.getByRole('button', { name: /^(Save|Add Employee|Create)/ }));
  return waitFor(() => screen.getByRole('dialog'));
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  cleanup();
});

describe('Add Employee — login created dialog', () => {
  it('names the account and points to "Forgot password?" — no credential', async () => {
    const dialog = await submitNewHire({ id: 43, login: { email: 'ravi@acme.in', created: true } });
    expect(dialog.textContent).toMatch(/Login Created/);
    expect(dialog.textContent).toContain('ravi@acme.in');
    expect(dialog.textContent).toContain('Forgot password?');
    expect(dialog.textContent).not.toMatch(/temporary password|undefined/i);
  });

  it('never displays a password even if a response still carries one', async () => {
    const dialog = await submitNewHire({
      id: 43, login: { email: 'ravi@acme.in', created: true, password: 'Welcome@123' } });
    expect(dialog.textContent).not.toContain('Welcome@123');
    expect(dialog.textContent).toContain('ravi@acme.in');
  });

  it('with no login created, shows the plain success message', async () => {
    const dialog = await submitNewHire({ id: 43 });
    expect(dialog.textContent).toMatch(/Employee Added/);
    expect(dialog.textContent).not.toMatch(/password/i);
  });
});
