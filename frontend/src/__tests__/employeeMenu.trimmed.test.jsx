/**
 * The employee-only menu (owner's instruction, 2026-11-11).
 *
 *   Home · [Approvals only if they approve something] · My Tickets ·
 *   HR (My Dashboard, My Details) · My Attendance ·
 *   Leaves (My Leaves, Apply Leave, Holiday Calendar, Comp Off) · My Timesheet ·
 *   Performance (My Reviews, Goals & KPIs, 360° Feedback) ·
 *   Travel Desk (My Travel, Expenses, Visit Reports) · Org Chart · QR Codes
 *
 * Gone for employees: Employee Records, QR Attendance, Shift Calendar, Leave
 * Calendar, Leave Encashment, My Analytics, Employee Directory — menu AND URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const env = vi.hoisted(() => ({ roles: ['employee'], isApprover: false, onProject: true }));
vi.mock('@/services/api/client', () => ({
  default: {
    get: vi.fn(async (url) => {
      if (url === '/approvals/stats') return { data: { isApprover: env.isApprover } };
      if (url === '/timesheets/timesheets/eligibility') return { data: { on_project: env.onProject } };
      return { data: {} };
    }),
  },
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { employee_id: 7 },
    roles: env.roles,
    role: env.roles[0],
    hasAnyRole: (...r) => r.some(x => env.roles.includes(x)),
    isEmployeeOnly: env.roles.length === 1 && env.roles[0] === 'employee',
    hasPermission: () => false,
    menuAccess: () => null,
  }),
}));

import Sidebar from '@/components/Sidebar';
import { NAV_ITEMS } from '@/config/routes';
import { canEmployeeAccessPage, canRoleAccessPageBySection } from '@/config/menuCatalog';
import { __resetApproverStatus } from '@/features/approvals/approverStatus';
import { __resetTimesheetEligibility } from '@/features/timesheets/timesheetEligibility';

let n = 0;
async function railFor() {
  __resetApproverStatus();
  __resetTimesheetEligibility();
  localStorage.setItem('token', `emp-trim-${(n += 1)}`);
  const view = render(<MemoryRouter><Sidebar /></MemoryRouter>);
  await waitFor(() => expect(view.container.querySelectorAll('.nav-item .label').length).toBeGreaterThan(0));
  return view;
}
const labels = (view) => [...view.container.querySelectorAll('.nav-item .label')].map(l => l.textContent);

beforeEach(() => { document.body.innerHTML = ''; env.isApprover = false; env.onProject = true; });

describe('employee-only sidebar', () => {
  it('shows the trimmed top-level rows, single-page menus flattened', async () => {
    const view = await railFor();
    await waitFor(() => expect(labels(view)).toContain('My Timesheet'));
    const rail = labels(view);
    for (const row of ['Home', 'My Dashboard', 'My Details', 'My Gate Passes', 'My Tickets', 'My Attendance', 'Leaves',
      'My Timesheet', 'Performance', 'Travel Desk', 'Org Chart', 'QR Codes']) {
      expect(rail, row).toContain(row);
    }
    // My Dashboard, My Details and My Gate Passes (§272, 2026-11-12) sit directly under Home.
    expect(rail.slice(rail.indexOf('Home') + 1, rail.indexOf('Home') + 4)).toEqual(['My Dashboard', 'My Details', 'My Gate Passes']);
    for (const row of ['HR', 'Service Desk', 'Attendance', 'Timesheets', 'Employee Directory', 'Approvals']) {
      expect(rail, row).not.toContain(row);
    }
  });

  it('hides My Timesheet from an employee who is on no project', async () => {
    env.onProject = false;
    const view = await railFor();
    await waitFor(() => expect(labels(view)).toContain('My Attendance'));
    expect(labels(view)).not.toContain('My Timesheet');
  });

  it('shows Approvals to an employee who approves something (a team lead)', async () => {
    env.isApprover = true;
    const view = await railFor();
    await waitFor(() => expect(labels(view)).toContain('Approvals'));
  });
});

describe('employee self-service pages inside the shared menus', () => {
  const keep = (section) => NAV_ITEMS.find(g => g.name === section).submenu
    .filter(s => !s.separator && !s.inHub && canEmployeeAccessPage(s.page))
    .map(s => s.page);

  it.each([
    ['HR',          ['EmployeeDashboard', 'MyEmployeeRecord', 'MyGatePasses']],
    ['Attendance',  ['AttendanceDashboard']],
    ['Leaves',      ['MyLeaves', 'ApplyLeave', 'HolidayCalendar']],
    ['Timesheets',  ['MyTimesheet']],
    ['Performance', ['PerformanceReviews', 'Goals', 'Feedback360']],
    ['Travel Desk', ['MyTravel', 'TravelExpenseCenter', 'TravelVisits']],
    ['Service Desk', ['MyTickets']],
  ])('%s', (section, pages) => {
    expect(keep(section)).toEqual(pages);
  });

  it.each(['EmployeeRecords', 'Policies', 'Downloads', 'EmployeeAssets', 'QRAttendance',
    'ShiftCalendar', 'LeaveCalendar', 'LeaveEncashment', 'MyAnalytics', 'CompOff'])(
    '%s is refused by URL too', (page) => {
      expect(canEmployeeAccessPage(page)).toBe(false);
    });

  it('Employee Directory is refused by URL', () => {
    expect(canRoleAccessPageBySection('employee', 'EmployeeDirectory')).toBe(false);
  });
});
