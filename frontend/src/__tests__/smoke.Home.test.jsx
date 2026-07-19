/**
 * smoke.Home.test.jsx — render smoke tests for the consolidated Home dashboard.
 *
 * REWRITTEN 2026-07-17. This file was asserting against a Home that no longer
 * exists and had 13 of 22 tests failing. Home was consolidated to a single
 * role-aware `GET /home/summary` (see the Home dashboard consolidation work),
 * but the tests still stubbed five endpoints the page had stopped calling
 * (/projects/tasks, /approvals/pending, /announcements/active,
 * /dashboard/live-kpis, /attendance/today) and looked for a quick-access button
 * row, a "Live Activity Feed" and an "Attendance Today"/"Revenue YTD" metrics bar
 * that were all removed in the redesign.
 *
 * The page itself is LOCKED — these tests were brought to the page, not the other
 * way round.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock CSS to avoid import errors
vi.mock('../pages/Home.css', () => ({}));

// Mock API client
vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

// CelebrationsBoard is lazy-loaded and fetches on its own; the celebrations slot
// is its own concern, so stub it to keep these tests about Home.
vi.mock('../components/dashboard/CelebrationsBoard', () => ({
  default: () => <div data-testid="celebrations-board" />,
}));

// FaceClockModal pulls in camera/geolocation APIs jsdom doesn't have.
vi.mock('../components/attendance/FaceClockModal', () => ({
  default: () => <div data-testid="face-clock-modal" />,
  getLocationString: () => Promise.resolve('12.97,77.59'),
}));

// Home reads BOTH `user` and `role` off the auth context.
let mockAuth = { user: { name: 'Arun Kumar', email: 'arun@manifest.in' }, role: 'admin' };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

import api from '../services/api/client';
import Home from '../pages/Home.jsx';

// ── /home/summary payload ─────────────────────────────────────────────────────
const summary = (over = {}) => ({
  identity: { name: 'Arun Kumar', email: 'arun@manifest.in' },
  management: {
    attendance: { rate: 92 },
    revenue: { mtd: 500000 },
    pendingApprovalsCount: 3,
    openTasksCount: 2,
    openTasks: [],
    approvalsQueue: [],
  },
  myTasks: [],
  myApprovals: { awaitingMyAction: [], awaitingOthers: [] },
  announcements: [],
  policies: [],
  brandAssets: [],
  myAttendance: null,
  ...over,
});

const mockTasks = [
  { id: 1, task_title: 'Fix login bug',    status: 'in_progress', priority: 'high',   project_name: 'ERP', due_date: '2026-05-20' },
  { id: 2, task_title: 'Write unit tests', status: 'todo',        priority: 'medium', project_name: 'ERP', due_date: '2026-05-25' },
];
const mockApprovals = [
  { id: 1, requested_by: 'Priya Nair', request_title: 'Leave request', request_type: 'Leave', priority: 'low', request_date: new Date().toISOString() },
];
const mockAnnouncements = [
  { id: 1, title: 'Office closed on Friday', message: 'Company holiday', created_at: new Date().toISOString() },
];

function stubApi(data = summary()) {
  api.get.mockImplementation((url) => {
    if (url === '/home/summary') return Promise.resolve({ data });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth = { user: { name: 'Arun Kumar', email: 'arun@manifest.in' }, role: 'admin' };
});

describe('Home — smoke', () => {

  // ── Render ────────────────────────────────────────────────────────────────

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Home setPage={() => {}} />);
    expect(document.querySelector('.hm-root')).not.toBeNull();
  });

  it('displays greeting and user name', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Home setPage={() => {}} />);
    expect(screen.getByText('Arun 👋')).toBeDefined();
  });

  it('displays the role badge', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Home setPage={() => {}} />);
    // The role label renders twice: the hero badge and the identity line.
    expect(document.querySelector('.hm-role-badge').textContent).toBe('Administrator');
    expect(document.querySelector('.hm-identity-role').textContent).toBe('Administrator');
  });

  it('renders the identity line from the summary payload', async () => {
    stubApi();
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(document.querySelector('.hm-identity-name').textContent).toBe('Arun Kumar'));
    expect(document.querySelector('.hm-identity-email').textContent).toBe('arun@manifest.in');
  });

  it('renders all 6 body slots', async () => {
    stubApi();
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Open Tasks', { selector: '.hm-card-title' })).toBeDefined());
    ['Pending Approvals', 'Announcements', 'Policies', 'Brand Vault', "Today's Celebrations"]
      .forEach(t => expect(screen.getByText(t, { selector: '.hm-card-title' })).toBeDefined());
  });

  it('renders the management hero KPIs', async () => {
    stubApi();
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Attendance')).toBeDefined());
    expect(screen.getByText('Approvals')).toBeDefined();
    expect(screen.getByText('Open Tasks', { selector: '.hm-kpi-label' })).toBeDefined();
    expect(screen.getByText('Revenue MTD')).toBeDefined();
  });

  // ── Loading state ─────────────────────────────────────────────────────────

  it('shows KPI dashes while the summary is loading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Home setPage={() => {}} />);
    expect(document.querySelectorAll('.hm-kpi-val').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  // ── Empty states ──────────────────────────────────────────────────────────

  it('shows "All caught up!" when no open tasks', async () => {
    stubApi();
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('All caught up!')).toBeDefined());
  });

  it('shows "No pending approvals." when the approvals queue is empty', async () => {
    stubApi();
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('No pending approvals.')).toBeDefined());
  });

  it('shows "No active announcements." when announcements list is empty', async () => {
    stubApi();
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('No active announcements.')).toBeDefined());
  });

  it('shows "No policy documents yet." when policies list is empty', async () => {
    stubApi();
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('No policy documents yet.')).toBeDefined());
  });

  it('shows "No templates yet." when the brand vault is empty', async () => {
    stubApi();
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('No templates yet.')).toBeDefined());
  });

  // ── Data population ───────────────────────────────────────────────────────

  it('renders task rows after data loads', async () => {
    stubApi(summary({ management: { ...summary().management, openTasks: mockTasks } }));
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Fix login bug')).toBeDefined());
    expect(screen.getByText('Write unit tests')).toBeDefined();
  });

  it('renders approval rows after data loads', async () => {
    stubApi(summary({ management: { ...summary().management, approvalsQueue: mockApprovals } }));
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Priya Nair')).toBeDefined());
    expect(screen.getByText('Leave request')).toBeDefined();
  });

  it('renders announcement rows after data loads', async () => {
    stubApi(summary({ announcements: mockAnnouncements }));
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Office closed on Friday')).toBeDefined());
    expect(screen.getByText('Company holiday')).toBeDefined();
  });

  it('renders the attendance rate after load', async () => {
    stubApi();
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('92%')).toBeDefined());
  });

  // ── Navigation ────────────────────────────────────────────────────────────

  it('calls setPage("ApprovalCenter") when the Approvals KPI is clicked', async () => {
    stubApi();
    const setPage = vi.fn();
    render(<Home setPage={setPage} />);
    await waitFor(() => expect(screen.getByText('Approvals')).toBeDefined());
    fireEvent.click(screen.getByText('Approvals'));
    expect(setPage).toHaveBeenCalledWith('ApprovalCenter');
  });

  it('calls setPage("KanbanBoard") when Task Board is clicked', async () => {
    stubApi();
    const setPage = vi.fn();
    render(<Home setPage={setPage} />);
    await waitFor(() => expect(screen.getByText('Task Board')).toBeDefined());
    fireEvent.click(screen.getByText('Task Board'));
    expect(setPage).toHaveBeenCalledWith('KanbanBoard');
  });

  it('calls setPage("ApprovalCenter") when View All approvals clicked', async () => {
    stubApi();
    const setPage = vi.fn();
    render(<Home setPage={setPage} />);
    await waitFor(() => expect(screen.getByText('No pending approvals.')).toBeDefined());
    // Two "View All" buttons exist: [0] = Approvals, [1] = Announcements
    fireEvent.click(screen.getAllByText('View All')[0]);
    expect(setPage).toHaveBeenCalledWith('ApprovalCenter');
  });

  it('calls setPage("Announcements") when View All announcements clicked', async () => {
    stubApi();
    const setPage = vi.fn();
    render(<Home setPage={setPage} />);
    await waitFor(() => expect(screen.getByText('No active announcements.')).toBeDefined());
    fireEvent.click(screen.getAllByText('View All')[1]);
    expect(setPage).toHaveBeenCalledWith('Announcements');
  });

  // ── Refresh ───────────────────────────────────────────────────────────────

  it('re-fetches the summary when Refresh is clicked', async () => {
    stubApi();
    render(<Home setPage={() => {}} />);
    // The refresh control is icon-only — reachable by its accessible name.
    const refresh = screen.getByLabelText('Refresh');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/home/summary', expect.anything()));
    const before = api.get.mock.calls.length;
    fireEvent.click(refresh);
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before));
  });

  // ── Role gating ───────────────────────────────────────────────────────────

  it('hides the Revenue MTD KPI when the summary has no revenue', async () => {
    stubApi(summary({ management: { ...summary().management, revenue: null } }));
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Attendance')).toBeDefined());
    expect(screen.queryByText('Revenue MTD')).toBeNull();
  });

  it('shows employee-shaped KPIs and hides management ones for an employee', async () => {
    mockAuth = { user: { name: 'Ravi', email: 'ravi@manifest.in', employee_id: 7 }, role: 'employee' };
    stubApi(summary({ myTasks: mockTasks }));
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('My Tasks')).toBeDefined());
    expect(screen.getByText('To Action')).toBeDefined();
    expect(screen.getByText('My Requests')).toBeDefined();
    // Revenue is management-only and must never reach an employee's Home.
    expect(screen.queryByText('Revenue MTD')).toBeNull();
  });

  it('renders the clock-in strip for a linked employee', async () => {
    mockAuth = { user: { name: 'Ravi', email: 'ravi@manifest.in', employee_id: 7 }, role: 'employee' };
    stubApi();
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Not clocked in yet')).toBeDefined());
    expect(screen.getByText('Clock In')).toBeDefined();
  });

  it('disables clock-in when the login has no linked employee record', async () => {
    mockAuth = { user: { name: 'Ghost', email: 'ghost@manifest.in' }, role: 'employee' };
    stubApi();
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Clock In')).toBeDefined());
    expect(screen.getByText('Clock In').closest('button').disabled).toBe(true);
  });

});
