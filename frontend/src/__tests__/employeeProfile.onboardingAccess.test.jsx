/**
 * Employee Profile → Onboarding tab: an empty checklist is not the same thing as
 * a refused one (2026-10-20).
 *
 * GET /onboarding/progress/:id answers 403 to anyone who is not HR, the
 * employee, or one of the employee's managers. The tab used to swallow every
 * error and fall through to "No onboarding checklist yet — Initialize", which
 * told a refused viewer something false and offered them an HR-only action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('../features/employees/pages/EmployeesData.css', () => ({}));
vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import api from '../services/api/client';
import EmployeeProfile from '../features/employees/pages/EmployeeProfile.jsx';

const employee = { id: 42, first_name: 'Arun', last_name: 'Kumar', department: 'Engineering', status: 'Active' };
const PROGRESS = '/onboarding/progress/42';
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { message: 'x' } } });

function openOnboarding(progress) {
  api.get.mockImplementation(async (url) => {
    if (url === PROGRESS) return progress();
    return { data: [] };
  });
  render(<EmployeeProfile employee={employee} setPage={() => {}} setSelectedEmployee={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Onboarding' }));
}

beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });

describe('Onboarding tab', () => {
  it('a genuinely empty checklist keeps the empty state and Initialize', async () => {
    openOnboarding(async () => ({ data: { employee_id: 42, total: 0, done: 0, pct: 0, items: [], archived: [] } }));
    expect(await screen.findByText('No onboarding checklist yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Initialize Onboarding Checklist/ })).toBeTruthy();
    expect(screen.queryByTestId('onboarding-denied')).toBeNull();
  });

  it('HTTP 403 shows access denied — not the empty state, and no Initialize', async () => {
    openOnboarding(async () => { throw httpError(403); });
    const denied = await screen.findByTestId('onboarding-denied');
    expect(denied.textContent).toMatch(/don.t have access to this onboarding checklist/);
    expect(screen.queryByText('No onboarding checklist yet')).toBeNull();
    expect(screen.queryByRole('button', { name: /Initialize Onboarding Checklist/ })).toBeNull();
    // Says nothing about whether this employee HAS a checklist.
    expect(denied.textContent).not.toMatch(/no checklist|not started|exists|items? completed|\d+%/i);
  });

  it.each([500, 404])('HTTP %i keeps the previous handling (not the access-denied message)', async (status) => {
    openOnboarding(async () => { throw httpError(status); });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(PROGRESS));
    expect(await screen.findByText('No onboarding checklist yet')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-denied')).toBeNull();
  });

  it('a network failure (no response) is not treated as a denial either', async () => {
    openOnboarding(async () => { throw new Error('Network Error'); });
    expect(await screen.findByText('No onboarding checklist yet')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-denied')).toBeNull();
  });

  it('a checklist with items renders its progress', async () => {
    openOnboarding(async () => ({ data: {
      employee_id: 42, total: 2, done: 1, pct: 50, archived: [],
      items: [
        { id: 1, category: 'IT', item_label: 'Laptop issued', done: true },
        { id: 2, category: 'IT', item_label: 'Email created', done: false },
      ],
    } }));
    expect(await screen.findByText('Onboarding Progress')).toBeTruthy();
    expect(screen.getByText('1 of 2 items completed')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-denied')).toBeNull();
  });
});
