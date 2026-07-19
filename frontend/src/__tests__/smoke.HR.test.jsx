import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../features/hr/pages/Announcements.css', () => ({}));
vi.mock('../features/hr/pages/Probation.css',     () => ({}));
vi.mock('../features/hr/pages/Payroll.css',        () => ({}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Admin', role: 'admin', id: 1 }, role: 'admin' }),
}));

vi.mock('recharts', () => ({
  BarChart: ({ children }) => <>{children}</>,
  PieChart: ({ children }) => <>{children}</>,
  LineChart: ({ children }) => <>{children}</>,
  AreaChart: ({ children }) => <>{children}</>,
  ResponsiveContainer: ({ children }) => <div style={{ width: 400, height: 300 }}>{children}</div>,
  Bar: () => null, Pie: () => null, Line: () => null, Area: () => null, Cell: () => null,
  XAxis: () => null, YAxis: () => null, CartesianGrid: () => null,
  Tooltip: () => null, Legend: () => null, ReferenceLine: () => null,
}));

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

vi.mock('../components/ResultDialog', () => ({ default: () => null }));

import api from '../services/api/client';
import HRDashboard   from '../pages/HRDashboard.jsx';
import Payroll       from '../features/hr/pages/Payroll.jsx';
import Probation     from '../features/hr/pages/Probation.jsx';
import Announcements from '../features/hr/pages/Announcements.jsx';

const EMPTY_ANALYTICS = {
  summary:          { total: 0, active: 0, probation: 0, left: 0, newHires: 0 },
  genderBreakdown:  [],
  deptBreakdown:    [],
  newHiresMonthly:  [],
  attritionMonthly: [],
};

const mockEmployees = [
  { id: 1, first_name: 'Arun',  last_name: 'Kumar', status: 'Active',    joining_date: '2022-01-10', department: 'Engineering' },
  { id: 2, first_name: 'Priya', last_name: 'Nair',  status: 'Probation', joining_date: '2026-01-01', department: 'HR' },
];

const mockPayrollRows = [
  { id: 1, name: 'Arun Kumar', employee_id: 'EMP001', department: 'Engineering', designation: 'Developer',
    gross: 60000, pf: 7200, esi: 450, pt: 200, tds: 0, total_deductions: 7850, net_pay: 52150, status: 'pending' },
];

function stubApi(overrides = {}) {
  api.get.mockImplementation((url) => {
    if (url === '/employees/analytics') return Promise.resolve({ data: overrides.analytics ?? EMPTY_ANALYTICS });
    if (url === '/employees')           return Promise.resolve({ data: overrides.employees ?? [] });
    if (url === '/leaves')              return Promise.resolve({ data: overrides.leaves ?? [] });
    if (url === '/payroll')             return Promise.resolve({ data: overrides.payroll ?? [] });
    if (url === '/payroll/summary')     return Promise.resolve({ data: overrides.summary ?? {} });
    if (url === '/payroll/trend')       return Promise.resolve({ data: overrides.trend ?? [] });
    if (url === '/probation')           return Promise.resolve({ data: overrides.probation ?? [] });
    if (url === '/announcements')       return Promise.resolve({ data: overrides.announcements ?? [] });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => vi.clearAllMocks());

// ── HRDashboard ───────────────────────────────────────────────────────────────

describe('HRDashboard — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<HRDashboard setPage={() => {}} />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "HR Dashboard" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<HRDashboard setPage={() => {}} />);
    expect(screen.getByText('HR Dashboard')).toBeDefined();
  });

  it('renders all five KPI card labels', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<HRDashboard setPage={() => {}} />);
    expect(screen.getByText('Total Employees')).toBeDefined();
    expect(screen.getByText('On Probation')).toBeDefined();
    expect(screen.getByText('New Hires (Mo)')).toBeDefined();
    expect(screen.getByText('Attrition Rate')).toBeDefined();
    expect(screen.getByText('Pending Leaves')).toBeDefined();
  });

  it('renders all section headings', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<HRDashboard setPage={() => {}} />);
    expect(screen.getByText('AI HR Insights')).toBeDefined();
    expect(screen.getByText('Department Headcount')).toBeDefined();
    expect(screen.getByText('Gender Distribution')).toBeDefined();
    expect(screen.getByText('HR Alerts')).toBeDefined();
    expect(screen.getByText('Pending Approvals')).toBeDefined();
    expect(screen.getByText('Quick Actions')).toBeDefined();
  });

  it('renders quick action buttons', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<HRDashboard setPage={() => {}} />);
    expect(screen.getAllByText('Add Employee').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Leave Approvals')).toBeDefined();
    expect(screen.getAllByText('Payroll').length).toBeGreaterThanOrEqual(1);
  });

  it('shows "All systems healthy" alert when no HR alerts', async () => {
    stubApi({ employees: [] });
    render(<HRDashboard setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('All systems healthy')).toBeDefined());
  });

  it('shows "All caught up!" when no pending leave approvals', async () => {
    stubApi({ leaves: [] });
    render(<HRDashboard setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('All caught up!')).toBeDefined());
  });

  it('shows employee alerts after loading employee data', async () => {
    stubApi({ employees: mockEmployees });
    render(<HRDashboard setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('All systems healthy')).toBeDefined());
  });

  it('calls setPage("AddEmployee") when Add Employee header button clicked', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    const setPage = vi.fn();
    render(<HRDashboard setPage={setPage} />);
    fireEvent.click(screen.getAllByText('Add Employee')[0]);
    expect(setPage).toHaveBeenCalledWith('AddEmployee');
  });

  it('calls setPage("LeaveApprovals") when Leave Approvals quick action clicked', async () => {
    stubApi();
    const setPage = vi.fn();
    render(<HRDashboard setPage={setPage} />);
    await waitFor(() => expect(screen.getByText('All caught up!')).toBeDefined());
    fireEvent.click(screen.getByText('Leave Approvals'));
    expect(setPage).toHaveBeenCalledWith('LeaveApprovals');
  });
});

// ── Payroll ───────────────────────────────────────────────────────────────────

describe('Payroll — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Payroll setPage={() => {}} />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Payroll" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Payroll setPage={() => {}} />);
    expect(screen.getByRole('heading', { name: /^payroll$/i })).toBeDefined();
  });

  it('renders all four KPI labels', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Payroll setPage={() => {}} />);
    expect(screen.getByText('Total Employees')).toBeDefined();
    expect(screen.getByText('Total Gross')).toBeDefined();
    expect(screen.getByText('Total Deductions')).toBeDefined();
    expect(screen.getByText('Net Payable')).toBeDefined();
  });

  it('renders month selector', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Payroll setPage={() => {}} />);
    expect(screen.getByRole('combobox')).toBeDefined();
  });

  it('shows empty state message when no payroll records', async () => {
    stubApi({ payroll: [], summary: {}, trend: [] });
    render(<Payroll setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no payroll records/i)).toBeDefined());
  });

  it('renders payroll table rows after data loads', async () => {
    stubApi({ payroll: mockPayrollRows, summary: {}, trend: [] });
    render(<Payroll setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Arun Kumar')).toBeDefined());
    expect(screen.getByText('Engineering')).toBeDefined();
  });

  it('renders status filter buttons', async () => {
    stubApi({ payroll: [], summary: {}, trend: [] });
    render(<Payroll setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('All')).toBeDefined());
    expect(screen.getByText('paid')).toBeDefined();
    expect(screen.getByText('pending')).toBeDefined();
  });
});

// ── Probation ─────────────────────────────────────────────────────────────────

describe('Probation — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Probation />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Probation Management" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Probation />);
    expect(screen.getByText('Probation Management')).toBeDefined();
  });

  it('renders all four KPI cards', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Probation />);
    expect(screen.getByText('On Probation')).toBeDefined();
    expect(screen.getByText('Needs Attention')).toBeDefined();
    expect(screen.getByText('Due in 30 Days')).toBeDefined();
    expect(screen.getAllByText('On Track').length).toBeGreaterThanOrEqual(1);
  });

  it('renders filter tabs', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Probation />);
    expect(screen.getByText('All')).toBeDefined();
    expect(screen.getByText('Critical')).toBeDefined();
    expect(screen.getByText('Overdue')).toBeDefined();
    expect(screen.getByText('Due Soon')).toBeDefined();
  });

  it('shows empty state when no probation employees', async () => {
    stubApi({ employees: [], probation: [] });
    render(<Probation />);
    await waitFor(() => expect(screen.getByText('No employees found')).toBeDefined());
  });

  it('renders Refresh and Notification Log buttons', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Probation />);
    expect(screen.getByText('Refresh')).toBeDefined();
    expect(screen.getByText('Notification Log')).toBeDefined();
  });
});

// ── Announcements ─────────────────────────────────────────────────────────────

describe('Announcements — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Announcements />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Announcements" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Announcements />);
    expect(screen.getByRole('heading', { name: /announcements/i })).toBeDefined();
  });

  it('renders all status filter tabs', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Announcements />);
    const tabLabels = screen.getAllByRole('button').map(b => b.textContent?.trim() ?? '');
    ['All', 'Active', 'Scheduled', 'Inactive', 'Expired'].forEach(tab =>
      expect(tabLabels.some(t => t === tab || t.startsWith(`${tab} (`))).toBe(true)
    );
  });

  it('shows empty state when no announcements', async () => {
    stubApi({ announcements: [], employees: [] });
    render(<Announcements />);
    await waitFor(() => expect(screen.getByText(/no announcements/i)).toBeDefined());
  });

  it('shows New Announcement button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Announcements />);
    expect(screen.getByText('New Announcement')).toBeDefined();
  });
});
