/**
 * HR > My Dashboard (pages/EmployeeDashboard.jsx), 2026-11-11.
 *
 * The employee's OWN HR record, on the standard page kit:
 *   - nothing Home already shows (clock-in, tasks, approvals, announcements,
 *     celebrations) is repeated;
 *   - each figure appears once (no KPI + card + chart for the same number);
 *   - every source is read with its real shape: /leaves/balance is a LIST of
 *     leave types (the old page read `.annual` / `.sick` and always showed
 *     nothing), /holidays is the whole year (only upcoming ones are listed),
 *     timesheet entries carry work_date / hours_worked;
 *   - links are offered only where Layout would open the page for the role.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('../pages/EmployeeDashboard.css', () => ({}));
vi.mock('../components/dashboard/widgets/MyPayslipsWidget', () => ({ default: () => <div data-testid="payslips" /> }));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../config/autoRouter', async () => {
  const { ROUTES } = await import('../config/routes');
  return { MERGED_ROUTES: ROUTES };
});

let mockAuth;
vi.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }));

import api from '../services/api/client';
import EmployeeDashboard from '../pages/EmployeeDashboard.jsx';

const base = {
  linked: true,
  employee: { office_id: 'EMP005', designation: 'Engineer', department: 'IT', joining_date: '2026-09-01', reporting_manager: 'Asha R', employment_type: 'Permanent', status: 'Active', notice_period_days: 30 },
  probation: { state: 'on_probation', probation_end_date: '2026-12-01', days_left: 20 },
  exit: null,
  attendance: { present: 7, absent: 1, leave: 2, half_day: 0, holiday: 2, other: 0, late_days: 1, late_minutes: 12 },
  attention: { pending_leave_requests: 2, expiring_documents: 0, assets_held: 0 },
  team_on_leave_today: [{ name: 'Ravi K', designation: 'Analyst', back_after: '2026-11-12' }],
  degraded: [],
};
const BALANCES = [
  { leave_name: 'Casual Leave', available_days: 4, used_days: '1', pending_days: '0' },
  { leave_name: 'Sick Leave', available_days: 6.5, used_days: '0', pending_days: '1' },
  { leave_name: 'Compensatory Off', available_days: 0, used_days: '0', pending_days: '0' },
];
const HOLIDAYS = [
  { id: 1, name: 'Pongal (past)', date: '2020-01-14', type: 'Regional' },
  { id: 2, name: 'Far Future Day', date: '2099-12-25', type: 'National' },
];

function mockApi(employment = base, extra = {}) {
  const data = {
    '/home/my-employment': employment,
    '/leaves/balance': BALANCES,
    '/leaves/my': [{ id: 9, leave_name: 'Casual Leave', start_date: '2026-11-03', end_date: '2026-11-04', days: 2, status: 'Approved' }],
    '/holidays': HOLIDAYS,
    '/timesheets/timesheets': [{ id: 4, project_name: 'Pulse ERP', work_date: '2026-11-10', hours_worked: '7.5', status: 'submitted' }],
    ...extra,
  };
  api.get.mockImplementation(url => Promise.resolve({ data: data[url] ?? [] }));
}

// The grants an employee is seeded with (leaves, timesheets, performance, self_service).
const EMPLOYEE_GRANTS = ['leaves', 'timesheets', 'performance', 'self_service'];
const employee = () => ({ user: { name: 'Zz Emp', employee_id: 5 }, role: 'employee', hasPermission: m => EMPLOYEE_GRANTS.includes(m), menuAccess: () => null });

beforeEach(() => { vi.clearAllMocks(); mockAuth = employee(); });

describe('My Dashboard — the employee’s own HR record', () => {
  it('uses the standard page hero', async () => {
    mockApi();
    const { container } = render(<EmployeeDashboard setPage={vi.fn()} />);
    await screen.findByText('My Employment');
    expect(container.querySelector('.plh-hero')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Zz Emp' })).toBeTruthy();
  });

  it('reads the leave balance LIST: totals available days, hides empty types', async () => {
    mockApi();
    render(<EmployeeDashboard setPage={vi.fn()} />);
    expect(await screen.findByText('10.5 days')).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Casual Leave')).toBeTruthy();
    expect(within(table).getByText('Sick Leave')).toBeTruthy();
    expect(within(table).queryByText('Compensatory Off')).toBeNull();
  });

  it('lists only upcoming holidays', async () => {
    mockApi();
    render(<EmployeeDashboard setPage={vi.fn()} />);
    expect(await screen.findByText('Far Future Day')).toBeTruthy();
    expect(screen.queryByText('Pongal (past)')).toBeNull();
  });

  it('shows probation, team on leave, timesheet fields — no notice period without a resignation', async () => {
    mockApi();
    render(<EmployeeDashboard setPage={vi.fn()} />);
    expect(await screen.findByText('On probation · 20 days left')).toBeTruthy();
    expect(screen.getByText('Asha R')).toBeTruthy();
    expect(screen.getByText('Ravi K')).toBeTruthy();
    expect(screen.getByText(/7\.5h/)).toBeTruthy();
    expect(screen.queryByText('Notice period')).toBeNull();
    expect(screen.queryByText('Resignation & Notice')).toBeNull();
  });

  it('hides probation once the employee is confirmed', async () => {
    mockApi({ ...base, probation: { state: 'confirmed', confirmation_date: '2026-09-28', probation_end_date: '2026-05-26' } });
    render(<EmployeeDashboard setPage={vi.fn()} />);
    await screen.findByText('My Employment');
    expect(screen.queryByText(/probation/i)).toBeNull();
    expect(screen.queryByText('Confirmation date')).toBeNull();
  });

  it('shows each figure once — no duplicate leave / payslip / probation tiles', async () => {
    mockApi();
    render(<EmployeeDashboard setPage={vi.fn()} />);
    await screen.findByText('My Employment');
    expect(screen.getAllByText('Leave available')).toHaveLength(1);
    expect(screen.queryByText('Latest Payslip')).toBeNull();
    expect(screen.queryByText(/leave requests? awaiting approval/i)).toBeNull(); // the stat says it
  });

  it('does not repeat Home: no clock-in, tasks, announcements or celebrations', async () => {
    mockApi();
    render(<EmployeeDashboard setPage={vi.fn()} />);
    await screen.findByText('My Employment');
    for (const t of [/clock in/i, /today's tasks/i, /announcements/i, /celebrations/i]) {
      expect(screen.queryByText(t)).toBeNull();
    }
    const urls = api.get.mock.calls.map(([u]) => u);
    for (const u of ['/announcements/active', '/tasks/today', '/notifications/unread-count', '/leaves/team']) {
      expect(urls).not.toContain(u);
    }
    expect(urls.some(u => /^\/attendance\/today|^\/payroll\/employee\//.test(u))).toBe(false);
  });

  it('every link opens a page the employee can open', async () => {
    mockApi();
    const setPage = vi.fn();
    render(<EmployeeDashboard setPage={setPage} />);
    await screen.findByText('My Employment');
    screen.getByRole('button', { name: /open my payslip/i }).click();
    expect(setPage).toHaveBeenLastCalledWith('PayslipViewer');
    screen.getByRole('button', { name: /apply leave/i }).click();
    expect(setPage).toHaveBeenLastCalledWith('ApplyLeave');
    screen.getByRole('button', { name: /holiday calendar/i }).click();
    expect(setPage).toHaveBeenLastCalledWith('HolidayCalendar');
  });

  // Own leave works for everyone (owner, 2026-11-25): a linked sales_exec
  // with no leaves grant still gets Apply Leave / Holiday Calendar; the
  // timesheet card stays hidden (no timesheets grant).
  it('hides links and cards a role cannot open (sales_exec: own leave yes, timesheets no)', async () => {
    mockAuth = { ...employee(), role: 'sales_exec', hasPermission: () => false };
    mockApi();
    render(<EmployeeDashboard setPage={vi.fn()} />);
    await screen.findByText('My Employment');
    expect(screen.queryByRole('button', { name: /holiday calendar/i })).toBeTruthy();
    expect(screen.queryByText('My Recent Timesheet Entries')).toBeNull();
    expect(api.get.mock.calls.map(([u]) => u)).not.toContain('/timesheets/timesheets');
  });

  it('shows the notice period only once a resignation is in progress', async () => {
    mockApi({ ...base, probation: { state: 'confirmed', confirmation_date: '2026-09-28' }, exit: { separation_type: 'resignation', status: 'active', submitted_on: '2026-11-01T05:00:00Z', last_working_date: '2026-12-10', days_left: 29, notice_period_days: 30, clearance_done: 3, clearance_total: 9 } });
    render(<EmployeeDashboard setPage={vi.fn()} />);
    expect(await screen.findByText(/Serving notice · Resignation/)).toBeTruthy();
    expect(screen.getByText('Resignation & Notice')).toBeTruthy();
    expect(screen.getByText('30 days')).toBeTruthy();
    expect(screen.getByText('3 of 9 done')).toBeTruthy();
    expect(screen.queryByText(/probation/i)).toBeNull();
  });

  it('says so when the login has no employee record', async () => {
    mockApi({ linked: false });
    render(<EmployeeDashboard setPage={vi.fn()} />);
    expect(await screen.findByText(/not linked to an employee record/i)).toBeTruthy();
  });

  it('flags a missing notice period on a resignation instead of showing a number', async () => {
    mockApi({ ...base, employee: { ...base.employee, notice_period_days: null }, exit: { separation_type: 'resignation', status: 'active', last_working_date: null, notice_period_days: null, clearance_done: 0, clearance_total: 9 } });
    render(<EmployeeDashboard setPage={vi.fn()} />);
    expect(await screen.findByText(/Not recorded — ask HR/)).toBeTruthy();
  });
});
