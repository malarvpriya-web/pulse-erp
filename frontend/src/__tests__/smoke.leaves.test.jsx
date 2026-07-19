import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── CSS mocks ─────────────────────────────────────────────────────────────────
vi.mock('../features/leaves/pages/ApplyLeave.css',       () => ({}));
vi.mock('../features/leaves/pages/AllLeaves.css',        () => ({}));
vi.mock('../features/leaves/pages/TeamLeaves.css',       () => ({}));
vi.mock('../features/leaves/pages/LeaveSettings.css',    () => ({}));
vi.mock('../features/employees/pages/EmployeesData.css', () => ({}));
vi.mock('../features/crm/pages/Leads.css',               () => ({}));

// ── React Router ──────────────────────────────────────────────────────────────
// MyLeaves calls useNavigate(), which throws "may be used only in the context of
// a <Router>" without this — it took out every test in the MyLeaves and
// LeaveSettings blocks. Mocking beats wrapping each render in a MemoryRouter:
// these are render smoke tests and navigation targets are asserted via the spy.
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
}));

// ── API client ────────────────────────────────────────────────────────────────
vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// ── Auth context ──────────────────────────────────────────────────────────────
// `roles` is an array and hasAnyRole reads it — LeaveSettings gates its
// Add/Edit/Delete controls on hasAnyRole(...MANAGE_ROLES). The old mock supplied
// neither, so canManage was false and every LeaveSettings control test failed
// looking for a button the page was correctly hiding.
let mockRoles = ['hr_manager'];
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { userId: 4, id: 4, employee_id: 4, name: 'Arun Kumar', email: 'arun@manifest.in', role: mockRoles[0], roles: mockRoles },
    roles: mockRoles,
    hasPermission: () => true,
    hasAnyRole: (...codes) => codes.flat().some(c => mockRoles.includes(String(c).toLowerCase())),
  }),
}));

// ── Toast context (used by LeaveApprovals) ────────────────────────────────────
vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import api from '../services/api/client';

import ApplyLeave     from '../features/leaves/pages/ApplyLeave.jsx';
import MyLeaves       from '../features/leaves/pages/MyLeaves.jsx';
import AllLeaves      from '../features/leaves/pages/AllLeaves.jsx';
import LeaveApprovals from '../features/leaves/pages/LeaveApprovals.jsx';
import LeaveCalendar  from '../features/leaves/pages/LeaveCalendar.jsx';
import LeaveSettings  from '../features/leaves/pages/LeaveSettings.jsx';

// All legacy route keys now resolve to the unified LeaveApprovals component
const TeamLeaves           = LeaveApprovals;
const ManagerApprovalLeave = LeaveApprovals;
const HRApprovalLeave      = LeaveApprovals;

// ── Shared fixtures ───────────────────────────────────────────────────────────

const LEAVE_TYPES = [
  { id: 1, leave_name: 'Sick Leave',   default_days: 6,  description: 'For illness'    },
  { id: 2, leave_name: 'Casual Leave', default_days: 4,  description: 'Personal work'  },
];

const BALANCE = [
  { leave_name: 'Sick Leave',   allocated_days: 6, used_days: 2, available_days: 4 },
  { leave_name: 'Casual Leave', allocated_days: 4, used_days: 0, available_days: 4 },
];

const PENDING_LEAVE = {
  id: 10,
  employee_name: 'Priya Nair',
  department: 'Engineering',
  leave_name: 'Sick Leave',
  leave_type: 'Sick',
  start_date: '2026-05-01',
  end_date:   '2026-05-02',
  number_of_days: 2,
  reason: 'Fever and flu',
  status: 'pending',
  applied_at: '2026-04-28T10:00:00Z',
};

const EMPLOYEES = [
  { id: 1, first_name: 'Arun', last_name: 'Kumar', office_id: 'EMP001', status: 'Active' },
];

const ALLOCATIONS = [
  { id: 1, employee_id: 1, employee_name: 'Arun Kumar', leave_name: 'Sick Leave',
    leave_type_id: 1, allocated_days: 6, used_days: 2, remaining_days: 4, year: 2026 },
];

function stubApis({
  leaves = [], types = LEAVE_TYPES, balance = BALANCE,
  allocations = ALLOCATIONS, employees = EMPLOYEES,
} = {}) {
  api.get.mockImplementation((url) => {
    if (/\/leaves\/balance\//.test(url)) return Promise.resolve({ data: balance });
    if (url === '/leaves/types')          return Promise.resolve({ data: types });
    if (url === '/leaves/applications')   return Promise.resolve({ data: leaves });
    if (url === '/leaves/my')             return Promise.resolve({ data: leaves });
    if (/\/leaves\/team/.test(url))       return Promise.resolve({ data: leaves });
    if (/\/leaves\/calendar/.test(url))   return Promise.resolve({ data: leaves });
    if (url === '/leaves/allocations')    return Promise.resolve({ data: allocations });
    if (url === '/employees')             return Promise.resolve({ data: employees });
    return Promise.resolve({ data: [] });
  });
  api.post.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window.localStorage, 'getItem').mockReturnValue(JSON.stringify({ id: 4 }));
  // Reset the role between tests — one test switches to 'manager' to prove the
  // approval endpoint forks, and it must not leak into the next.
  mockRoles = ['hr_manager'];
});

// ─────────────────────────────────────────────────────────────────────────────
// ApplyLeave — employee self-service application form
// ─────────────────────────────────────────────────────────────────────────────
describe('ApplyLeave — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<ApplyLeave />);
    expect(document.querySelector('.al-root')).not.toBeNull();
  });

  it('shows page heading and subtext', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<ApplyLeave />);
    expect(screen.getByText('Apply for Leave')).toBeDefined();
    expect(screen.getByText('Submit a leave request for manager approval')).toBeDefined();
  });

  it('shows "Submit Request" button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<ApplyLeave />);
    expect(screen.getByText('Submit Request')).toBeDefined();
  });

  it('shows balance section label while data is loading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<ApplyLeave />);
    expect(screen.getByText('Leave Balances — click a type to select it')).toBeDefined();
  });

  it('renders leave type balance cards after types load', async () => {
    stubApis();
    render(<ApplyLeave />);
    await waitFor(() => expect(screen.getAllByText('Sick Leave').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Casual Leave').length).toBeGreaterThan(0);
  });

  it('shows validation error when reason is empty on submit', async () => {
    stubApis();
    render(<ApplyLeave />);
    fireEvent.click(screen.getByText('Submit Request'));
    // Reported twice by design — inline under the field AND as a toast.
    await waitFor(() => expect(screen.getAllByText(/reason is required/i).length).toBeGreaterThan(0));
    expect(api.post).not.toHaveBeenCalledWith('/leaves/apply', expect.anything());
  });

  it('calls POST /leaves/apply on valid submission', async () => {
    stubApis();
    render(<ApplyLeave />);
    await waitFor(() => expect(screen.getAllByText('Sick Leave').length).toBeGreaterThan(0));
    fireEvent.change(
      screen.getByPlaceholderText(/briefly describe the reason/i),
      { target: { value: 'Fever' } }
    );
    fireEvent.click(screen.getByText('Submit Request'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/leaves/apply',
        expect.objectContaining({ reason: 'Fever' })
      )
    );
  });

  it('shows success toast after submit', async () => {
    stubApis();
    render(<ApplyLeave />);
    await waitFor(() => expect(screen.getAllByText('Sick Leave').length).toBeGreaterThan(0));
    fireEvent.change(
      screen.getByPlaceholderText(/briefly describe the reason/i),
      { target: { value: 'Fever' } }
    );
    fireEvent.click(screen.getByText('Submit Request'));
    await waitFor(() =>
      expect(screen.getByText('Leave application submitted successfully!')).toBeDefined()
    );
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// MyLeaves — employee's own leave history
// ─────────────────────────────────────────────────────────────────────────────
describe('MyLeaves — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MyLeaves />);
    expect(screen.getByText('My Leave Applications')).toBeDefined();
  });

  it('shows "Loading…" while fetching', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MyLeaves />);
    expect(screen.getByText(/loading/i)).toBeDefined();
  });

  it('shows empty state when no applications exist', async () => {
    stubApis({ leaves: [] });
    render(<MyLeaves />);
    await waitFor(() =>
      expect(screen.getByText(/no leave applications found/i)).toBeDefined()
    );
  });

  it('shows heading and table columns after data loads', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<MyLeaves />);
    await waitFor(() => expect(screen.getByText('My Leave Applications')).toBeDefined());
    expect(screen.getByText('Sick Leave')).toBeDefined();
    expect(screen.getByText('Fever and flu')).toBeDefined();
  });

  it('renders a leave row with correct data', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<MyLeaves />);
    await waitFor(() => expect(screen.getByText('Fever and flu')).toBeDefined());
    expect(screen.getByText('L1 Pending')).toBeDefined();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// AllLeaves — team/admin leave management with balance cards + approve actions
// ─────────────────────────────────────────────────────────────────────────────
describe('AllLeaves — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    api.post.mockReturnValue(new Promise(() => {}));
    render(<AllLeaves />);
    expect(document.querySelector('.al-root')).not.toBeNull();
  });

  it('shows "Leave Management" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    api.post.mockReturnValue(new Promise(() => {}));
    render(<AllLeaves />);
    expect(screen.getByText('Leave Management')).toBeDefined();
  });

  it('shows Leave Balances section with live data types', async () => {
    stubApis();
    render(<AllLeaves />);
    await waitFor(() => expect(screen.getByText('Sick Leave')).toBeDefined());
    expect(screen.getByText('Leave Balances')).toBeDefined();
  });

  it('shows "Apply Leave" button when canAdd is true', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    api.post.mockReturnValue(new Promise(() => {}));
    render(<AllLeaves />);
    expect(screen.getByText('Apply Leave')).toBeDefined();
  });

  it('shows empty state when no leave applications exist', async () => {
    stubApis({ leaves: [] });
    render(<AllLeaves />);
    await waitFor(() =>
      expect(screen.getByText('No leave applications found.')).toBeDefined()
    );
  });

  it('renders leave row with employee name and reason', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<AllLeaves />);
    await waitFor(() => expect(screen.getByText('Priya Nair')).toBeDefined());
    expect(screen.getByText('Fever and flu')).toBeDefined();
  });

  // Approve/reject go to the role-appropriate endpoint — POST /leaves/{approve,
  // reject}/{hr,manager}/:id. The old PUT /leaves/applications/:id/status these
  // tests asserted has not existed for some time.
  it('posts to the HR approve endpoint when Approve is clicked as HR', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<AllLeaves />);
    await waitFor(() => screen.getByTitle('Approve'));
    fireEvent.click(screen.getByTitle('Approve'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`/leaves/approve/hr/${PENDING_LEAVE.id}`, { comments: '' })
    );
  });

  it('posts to the manager approve endpoint when the approver is not HR', async () => {
    mockRoles = ['manager'];
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<AllLeaves />);
    await waitFor(() => screen.getByTitle('Approve'));
    fireEvent.click(screen.getByTitle('Approve'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`/leaves/approve/manager/${PENDING_LEAVE.id}`, { comments: '' })
    );
  });

  // Reject requires a reason. The button opens a prompt rather than firing a
  // call the API is guaranteed to refuse.
  it('opens the reject reason prompt instead of rejecting immediately', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<AllLeaves />);
    await waitFor(() => screen.getByTitle('Reject'));
    fireEvent.click(screen.getByTitle('Reject'));
    expect(screen.getByText('Reject leave')).toBeDefined();
    expect(api.post).not.toHaveBeenCalledWith(
      expect.stringContaining('/leaves/reject/'), expect.anything()
    );
  });

  it('keeps Reject Leave disabled until a reason is typed', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<AllLeaves />);
    await waitFor(() => screen.getByTitle('Reject'));
    fireEvent.click(screen.getByTitle('Reject'));
    expect(screen.getByText('Reject Leave').disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Tell the applicant why this is being rejected'), {
      target: { value: 'Insufficient balance' },
    });
    expect(screen.getByText('Reject Leave').disabled).toBe(false);
  });

  it('posts the reason to the HR reject endpoint on confirm', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<AllLeaves />);
    await waitFor(() => screen.getByTitle('Reject'));
    fireEvent.click(screen.getByTitle('Reject'));
    fireEvent.change(screen.getByPlaceholderText('Tell the applicant why this is being rejected'), {
      target: { value: 'Insufficient balance' },
    });
    fireEvent.click(screen.getByText('Reject Leave'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/leaves/reject/hr/${PENDING_LEAVE.id}`,
        { comments: 'Insufficient balance' }
      )
    );
  });

  it('shows Team Leave This Week section', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    api.post.mockReturnValue(new Promise(() => {}));
    render(<AllLeaves />);
    expect(screen.getByText('Team Leave This Week')).toBeDefined();
  });

  it('opens Apply drawer when "Apply Leave" button clicked', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    api.post.mockReturnValue(new Promise(() => {}));
    render(<AllLeaves />);
    fireEvent.click(screen.getByText('Apply Leave'));
    expect(screen.getByText('Apply for Leave')).toBeDefined();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// LeaveApprovals — unified role-aware approval queue (L1/L2/L3/Team tabs)
// ─────────────────────────────────────────────────────────────────────────────
describe('LeaveApprovals — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveApprovals />);
    expect(screen.getByText('Leave Approvals')).toBeDefined();
  });

  it('shows pending count subtitle', async () => {
    stubApis({ leaves: [] });
    render(<LeaveApprovals />);
    await waitFor(() => expect(screen.getByText(/pending requests/i)).toBeDefined());
  });

  it('shows L1 Manager queue tab', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveApprovals />);
    expect(screen.getByText('L1 — Manager')).toBeDefined();
  });

  it('shows empty state when no pending leaves', async () => {
    stubApis({ leaves: [] });
    render(<LeaveApprovals />);
    await waitFor(() =>
      expect(screen.getByText('No pending requests in this queue')).toBeDefined()
    );
  });

  it('renders leave row after data loads', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<LeaveApprovals />);
    await waitFor(() => expect(screen.getByText('Priya Nair')).toBeDefined());
    expect(screen.getByText('Fever and flu')).toBeDefined();
  });

  it('calls POST with approve endpoint when Approve clicked', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<LeaveApprovals />);
    await waitFor(() => screen.getByText('Priya Nair'));
    fireEvent.click(screen.getAllByText('Approve')[0]);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/leaves/approve/manager/${PENDING_LEAVE.id}`,
        expect.any(Object)
      )
    );
  });

  it('shows rejection requires a comment (error toast on empty)', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<LeaveApprovals />);
    await waitFor(() => screen.getByText('Priya Nair'));
    // Reject without a comment should show error via toast (not call API)
    fireEvent.click(screen.getAllByText('Reject')[0]);
    await waitFor(() => expect(api.post).not.toHaveBeenCalled());
  });

  it('filters rows by search input', async () => {
    const anotherLeave = { ...PENDING_LEAVE, id: 20, employee_name: 'Rahul Sharma', reason: 'Travel' };
    stubApis({ leaves: [PENDING_LEAVE, anotherLeave] });
    render(<LeaveApprovals />);
    await waitFor(() => screen.getByText('Priya Nair'));
    fireEvent.change(
      screen.getByPlaceholderText(/search employee/i),
      { target: { value: 'Rahul' } }
    );
    await waitFor(() => expect(screen.queryByText('Priya Nair')).toBeNull());
    expect(screen.getByText('Rahul Sharma')).toBeDefined();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// TeamLeaves — unified page, shows Team View tab with leave summary
// ─────────────────────────────────────────────────────────────────────────────
describe('TeamLeaves — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<TeamLeaves />);
    // The unified page renders "Leave Approvals" heading
    expect(screen.getByText('Leave Approvals')).toBeDefined();
  });

  it('shows Team View tab', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<TeamLeaves />);
    expect(screen.getByText('Team View')).toBeDefined();
  });

  it('shows All Months filter when Team View tab is active', async () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<TeamLeaves />);
    fireEvent.click(screen.getByText('Team View'));
    await waitFor(() => expect(screen.getByText('All Months')).toBeDefined());
  });

  it('shows empty state in Team View when no leaves', async () => {
    stubApis({ leaves: [] });
    render(<TeamLeaves />);
    fireEvent.click(screen.getByText('Team View'));
    await waitFor(() =>
      expect(screen.getByText('No leave requests found')).toBeDefined()
    );
  });

  it('renders leave row in Team View after data loads', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<TeamLeaves />);
    fireEvent.click(screen.getByText('Team View'));
    await waitFor(() => expect(screen.getByText('Priya Nair')).toBeDefined());
    expect(screen.getAllByText('Sick Leave').length).toBeGreaterThan(0);
  });

  it('shows Refresh button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<TeamLeaves />);
    expect(screen.getByText('Refresh')).toBeDefined();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// ManagerApprovalLeave — unified page defaulting to L1 Manager queue
// ─────────────────────────────────────────────────────────────────────────────
describe('ManagerApprovalLeave — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<ManagerApprovalLeave />);
    expect(screen.getByText('Leave Approvals')).toBeDefined();
  });

  it('shows L1 Manager queue tab (active by default)', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<ManagerApprovalLeave />);
    expect(screen.getByText('L1 — Manager')).toBeDefined();
  });

  it('shows request count subtitle', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<ManagerApprovalLeave />);
    expect(screen.getByText(/requests/i)).toBeDefined();
  });

  it('shows empty state when no pending leaves', async () => {
    stubApis({ leaves: [] });
    render(<ManagerApprovalLeave />);
    await waitFor(() =>
      expect(screen.getByText('No pending requests in this queue')).toBeDefined()
    );
  });

  it('renders leave row after data loads', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<ManagerApprovalLeave />);
    await waitFor(() => expect(screen.getByText('Priya Nair')).toBeDefined());
    expect(screen.getByText('Fever and flu')).toBeDefined();
  });

  it('shows Refresh button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<ManagerApprovalLeave />);
    expect(screen.getByText('Refresh')).toBeDefined();
  });

  it('calls POST /leaves/approve/manager/:id when Approve clicked', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<ManagerApprovalLeave />);
    await waitFor(() => screen.getByText('Priya Nair'));
    fireEvent.click(screen.getAllByText('Approve')[0]);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/leaves/approve/manager/${PENDING_LEAVE.id}`,
        expect.any(Object)
      )
    );
  });

  it('filters rows by search input', async () => {
    const another = { ...PENDING_LEAVE, id: 20, employee_name: 'Rahul Mehta', reason: 'Travel' };
    stubApis({ leaves: [PENDING_LEAVE, another] });
    render(<ManagerApprovalLeave />);
    await waitFor(() => screen.getByText('Priya Nair'));
    fireEvent.change(
      screen.getByPlaceholderText(/search employee/i),
      { target: { value: 'Rahul' } }
    );
    await waitFor(() => expect(screen.queryByText('Priya Nair')).toBeNull());
    expect(screen.getByText('Rahul Mehta')).toBeDefined();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// HRApprovalLeave — unified page; L3 HR Final queue selectable via tab
// ─────────────────────────────────────────────────────────────────────────────
describe('HRApprovalLeave — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<HRApprovalLeave />);
    expect(screen.getByText('Leave Approvals')).toBeDefined();
  });

  it('shows L3 HR Final queue tab', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<HRApprovalLeave />);
    expect(screen.getByText('L3 — HR Final')).toBeDefined();
  });

  it('shows empty state in L3 queue when no leaves awaiting HR', async () => {
    stubApis({ leaves: [] });
    render(<HRApprovalLeave />);
    // Switch to the L3 HR tab
    fireEvent.click(screen.getByText('L3 — HR Final'));
    await waitFor(() =>
      expect(screen.getByText('No pending requests in this queue')).toBeDefined()
    );
  });

  it('shows Refresh button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<HRApprovalLeave />);
    expect(screen.getByText('Refresh')).toBeDefined();
  });

  it('calls POST /leaves/approve/hr/:id when Approve clicked on L3 queue', async () => {
    const hrPending = { ...PENDING_LEAVE, manager_status: 'approved', hr_status: 'pending' };
    stubApis({ leaves: [hrPending] });
    render(<HRApprovalLeave />);
    // Switch to L3 HR Final tab
    fireEvent.click(screen.getByText('L3 — HR Final'));
    await waitFor(() => screen.getByText('Priya Nair'));
    fireEvent.click(screen.getAllByText('Approve')[0]);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/leaves/approve/hr/${PENDING_LEAVE.id}`,
        expect.any(Object)
      )
    );
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// LeaveCalendar — month grid showing approved leaves per day
// ─────────────────────────────────────────────────────────────────────────────
describe('LeaveCalendar — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveCalendar />);
    expect(screen.getByText('Leave Calendar')).toBeDefined();
  });

  it('shows all 7 weekday column headers', async () => {
    stubApis();
    render(<LeaveCalendar />);
    await waitFor(() =>
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d =>
        expect(screen.getByText(d)).toBeDefined()
      )
    );
  });

  it('shows month/year in nav bar', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveCalendar />);
    const now = new Date();
    const MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    expect(screen.getByText(`${MONTHS[now.getMonth()]} ${now.getFullYear()}`)).toBeDefined();
  });

  it('shows color legend entries', async () => {
    stubApis();
    render(<LeaveCalendar />);
    await waitFor(() => expect(screen.getByText('Sick Leave')).toBeDefined());
    expect(screen.getByText('Casual Leave')).toBeDefined();
  });

  it('fetches calendar data for current month on mount', () => {
    api.get.mockResolvedValue({ data: [] });
    render(<LeaveCalendar />);
    expect(api.get).toHaveBeenCalledWith(
      '/leaves/calendar',
      expect.objectContaining({ params: expect.any(Object) })
    );
  });

  it('advances to next month when chevron-right clicked', () => {
    api.get.mockResolvedValue({ data: [] });
    render(<LeaveCalendar />);
    const now    = new Date();
    const MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    const nextIdx = (now.getMonth() + 1) % 12;
    const nextYear = nextIdx === 0 ? now.getFullYear() + 1 : now.getFullYear();
    const [, nextBtn] = document.querySelectorAll('button');
    fireEvent.click(nextBtn);
    expect(screen.getByText(`${MONTHS[nextIdx]} ${nextYear}`)).toBeDefined();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// LeaveSettings — HR admin: manage leave types and per-employee allocations
// ─────────────────────────────────────────────────────────────────────────────
describe('LeaveSettings — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveSettings />);
    expect(screen.getByText('Leave Settings')).toBeDefined();
  });

  it('shows all three action buttons', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveSettings />);
    expect(screen.getByText('Add Leave Type')).toBeDefined();
    fireEvent.click(screen.getByText('Allocations'));
    expect(screen.getByText('Allocate Leave')).toBeDefined();
    expect(screen.getByText('Bulk Allocate')).toBeDefined();
  });

  it('shows leave types table section heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveSettings />);
    expect(screen.getByText('Leave Types')).toBeDefined();
  });

  it('renders leave type rows after data loads', async () => {
    stubApis();
    render(<LeaveSettings />);
    await waitFor(() =>
      expect(screen.getAllByText('Sick Leave').length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText('Casual Leave').length).toBeGreaterThan(0);
  });

  it('renders allocation rows after data loads', async () => {
    stubApis();
    render(<LeaveSettings />);
    fireEvent.click(screen.getByText('Allocations'));
    await waitFor(() => expect(screen.getByText('Arun Kumar')).toBeDefined());
  });

  it('opens Add Leave Type modal with correct fields', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveSettings />);
    fireEvent.click(screen.getByText('Add Leave Type'));
    expect(screen.getByPlaceholderText('e.g. Earned Leave')).toBeDefined();
    expect(screen.getByPlaceholderText('e.g. 12')).toBeDefined();
    expect(screen.getByPlaceholderText('Optional description')).toBeDefined();
  });

  it('shows validation error when leave name is empty', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveSettings />);
    fireEvent.click(screen.getByText('Add Leave Type'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Leave Type' })[1]);
    expect(screen.getByText('Leave name must be at least 2 characters')).toBeDefined();
  });

  it('calls POST /leaves/types on valid type creation', async () => {
    stubApis();
    render(<LeaveSettings />);
    fireEvent.click(screen.getByText('Add Leave Type'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Earned Leave'), { target: { value: 'Earned Leave' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 12'), { target: { value: '10' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Leave Type' })[1]);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/leaves/types', expect.objectContaining({ leave_name: 'Earned Leave' }))
    );
  });

});
