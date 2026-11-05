/**
 * Probation "ending soon" windows on the client.
 *
 *  - Employees Dashboard → Confirmations tile: a deliberately broader 30-day
 *    overview (ALERT_WINDOW_DAYS, shared by every "next N days" tile). Its
 *    clicks must open EXACTLY the population its numbers counted. It used to
 *    count "due in 30 days" and open every probationer.
 *  - HR Analytics → Onboarding widget: "Confirming soon" is labelled with the
 *    company reminder window the server applied, and shown even when there are
 *    no recent hires (the count no longer depends on that cohort).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
const auth = vi.hoisted(() => ({ grants: new Set(['employee_documents:view']) }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }),
}));
vi.mock('../features/employees/pages/EmployeesDashboard.css', () => ({}));
vi.mock('../components/dashboard/dashkit.css', () => ({}));

import api from '../services/api/client';
import EmployeesDashboard from '../features/employees/pages/EmployeesDashboard.jsx';
import OnboardingWidget from '../features/hr-analytics/components/OnboardingWidget.jsx';
import { peekEmployeeListFilter, matchesEmployeeFilter } from '../features/employees/employeeListFilter';

/** The register the list page would filter (status Probation unless noted). */
const EMPLOYEES = [
  { id: 1, first_name: 'Due', last_name: 'Today', status: 'Probation', probation_end_date: '2026-10-14' },
  { id: 2, first_name: 'Due', last_name: 'Later', status: 'Probation', probation_end_date: '2026-11-10' },
  { id: 3, first_name: 'Over', last_name: 'Due', status: 'Probation', probation_end_date: '2026-10-01' },
  { id: 4, first_name: 'No', last_name: 'Date', status: 'Probation', probation_end_date: null },
  { id: 5, first_name: 'Far', last_name: 'Away', status: 'Probation', probation_end_date: '2027-03-01' },
  { id: 6, first_name: 'Act', last_name: 'Ive', status: 'Active', probation_end_date: null },
];
/** What GET /hr-widgets/pending-confirmations?days=30 returns for that register. */
const PENDING = [
  { id: 1, name: 'Due Today', probation_end_date: '2026-10-14', days_remaining: 0, confirmation_state: 'due' },
  { id: 2, name: 'Due Later', probation_end_date: '2026-11-10', days_remaining: 27, confirmation_state: 'due' },
  { id: 3, name: 'Over Due', probation_end_date: '2026-10-01', days_remaining: -13, confirmation_state: 'overdue' },
  { id: 4, name: 'No Date', probation_end_date: null, days_remaining: null, confirmation_state: 'undated' },
];

function mockDashboard(pending = PENDING) {
  api.get.mockImplementation(async (url) => {
    if (url === '/employees/analytics') {
      return { data: { summary: { total: 6, active: 1, probation: 5, notice: 0 }, statusBreakdown: [], deptBreakdown: [] } };
    }
    if (url === '/employees') return { data: EMPLOYEES };
    if (url === '/hr-widgets/pending-confirmations') return { data: pending };
    if (url === '/hr-widgets/upcoming-joinees') return { data: null };
    return { data: [] };
  });
}

/**
 * The LOADED tile. While the lists load, the whole tile is one <button>
 * carrying the title; once the attention badge exists it splits into two
 * targets. So wait for the badge, then query fresh.
 */
async function loadedTile() {
  const badge = await screen.findByTitle('Open the probations that need attention');
  const main = screen.getByTitle('Open the probations ending today or in the next 30 days');
  return { badge, main, tile: main.closest('.empdash-action') };
}

/** Apply the stored list filter exactly as the All Employees page does. */
const opened = () => {
  const f = peekEmployeeListFilter();
  return EMPLOYEES.filter((e) => matchesEmployeeFilter(e, f, () => null)).map((e) => e.id).sort();
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  cleanup();
  auth.grants = new Set(['employee_documents:view']);
});

describe('Employees Dashboard — Confirmations tile', () => {
  it('says which window it shows, and a click opens exactly the rows it counted', async () => {
    mockDashboard();
    const setPage = vi.fn();
    render(<EmployeesDashboard setPage={setPage} setSelectedEmployee={vi.fn()} />);
    const { main, tile } = await loadedTile();
    // count = ending today + ending within 30 days (ids 1 and 2) — today included
    expect(main.textContent).toBe('2');
    expect(tile.textContent).toMatch(/Confirmations/);
    expect(tile.textContent).toMatch(/Next 30 days/);

    fireEvent.click(main);
    expect(setPage).toHaveBeenCalledWith('EmployeesData');
    expect(opened()).toEqual([1, 2]);
    expect(opened()).toHaveLength(Number(main.textContent));
    expect(peekEmployeeListFilter().label).toBe('Probation ends today or in the next 30 days');
  });

  it('the attention badge opens overdue + undated, and nothing else', async () => {
    mockDashboard();
    render(<EmployeesDashboard setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    const { badge } = await loadedTile();
    expect(badge.textContent).toMatch(/^2 /);
    fireEvent.click(badge);
    expect(opened()).toEqual([3, 4]);
    expect(peekEmployeeListFilter().label).toBe('Probation overdue or with no end date set');
  });

  it('with nothing due, a click opens nobody — not the whole register', async () => {
    mockDashboard(PENDING.filter((p) => p.confirmation_state !== 'due'));
    render(<EmployeesDashboard setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    const { main } = await loadedTile();
    expect(main.textContent).toBe('0');
    fireEvent.click(main);
    expect(peekEmployeeListFilter()).toMatchObject({ ids: [] });
    expect(opened()).toEqual([]);
  });
});

describe('HR Analytics — Onboarding widget', () => {
  it('labels "confirming" with the company reminder window it was counted over', () => {
    render(<OnboardingWidget data={{ total: 3, joined7d: 1, joined30d: 2, confirmingSoon: 4, confirmingSoonWindowDays: 10, recentHires: [] }} />);
    expect(screen.getByText('Confirming ≤ 10d')).toBeTruthy();
    expect(screen.getByTitle(/today or within the next 10 days/)).toBeTruthy();
  });

  it('still shows probations ending soon when there are no recent hires', () => {
    render(<OnboardingWidget data={{ total: 0, confirmingSoon: 2, confirmingSoonWindowDays: 14, recentHires: [] }} />);
    expect(screen.getByText('2 probations ending within 14 days')).toBeTruthy();
  });
});

// §207: the Documents tile opens HR's register (employee_documents). The
// dashboard itself is gated on employees:view, which managers also hold.
describe('Employees Dashboard — Documents tile', () => {
  it('is drawn for employee_documents:view and opens the register', async () => {
    mockDashboard();
    const setPage = vi.fn();
    render(<EmployeesDashboard setPage={setPage} setSelectedEmployee={vi.fn()} />);
    await loadedTile();
    fireEvent.click(screen.getByTitle('Open documents expiring soon'));
    expect(setPage).toHaveBeenCalledWith('EmployeeDocuments');
  });

  it('is not drawn without the grant; the other tiles stay', async () => {
    auth.grants = new Set();
    mockDashboard();
    render(<EmployeesDashboard setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    await loadedTile();
    expect(screen.queryByTitle('Open documents expiring soon')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Documents/);
    expect(document.body.textContent).toMatch(/Exits/);
  });
});
