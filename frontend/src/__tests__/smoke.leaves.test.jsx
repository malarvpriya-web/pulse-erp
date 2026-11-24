import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── CSS mocks ─────────────────────────────────────────────────────────────────
vi.mock('../features/leaves/pages/ApplyLeave.css',       () => ({}));
vi.mock('../features/leaves/pages/AllLeaves.css',        () => ({}));
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

/**
 * The next Monday-to-Friday on or after today, as YYYY-MM-DD.
 *
 * ApplyLeave refuses a request whose range contains no WORKING day
 * ("Select at least one working day for leave"), so a hardcoded date would make
 * these tests pass or fail depending on the day of the week the suite happened to
 * run. Built from local date parts, never toISOString() — that is UTC midnight,
 * which in IST is the previous day.
 */
function nextWorkingDay() {
  const d = new Date();
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The date input under a given field label.
 *
 * ApplyLeave's date inputs carry no id and their labels no htmlFor, so
 * getByLabelText cannot reach them. Matching on the label text inside the field
 * wrapper is still better than indexing into every input[type=date] on the page,
 * which silently follows any reordering.
 */
function dateInputFor(labelText) {
  const field = [...document.querySelectorAll('.al-field')].find(
    (f) => f.querySelector('label')?.textContent.trim().startsWith(labelText));
  if (!field) throw new Error(`No leave form field labelled "${labelText}"`);
  return field.querySelector('input[type="date"]');
}

/** Fill everything ApplyLeave requires, for a one-working-day request. */
function fillValidLeave(reason = 'Fever') {
  const day = nextWorkingDay();
  fireEvent.change(dateInputFor('From Date'), { target: { value: day } });
  fireEvent.change(dateInputFor('To Date'),   { target: { value: day } });
  fireEvent.change(
    screen.getByPlaceholderText(/briefly describe the reason/i),
    { target: { value: reason } }
  );
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
    // The Hero Kit rollout replaced this page's own `.al-root` wrapper with the
    // shared PageShell, whose root is `.plh-page`. The assertion followed.
    expect(document.querySelector('.plh-page')).not.toBeNull();
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
    // The employee self-service path, which is what this describe block is about.
    // The default mock role is hr_manager, and ApplyLeave counts that as an ADMIN —
    // admins additionally have to pick WHOSE leave they are applying for, so with
    // the default role this submission is not valid and the form correctly refuses
    // it. That, plus the two missing dates, is why this test never called api.post.
    mockRoles = ['employee'];
    stubApis();
    render(<ApplyLeave />);
    await waitFor(() => expect(screen.getAllByText('Sick Leave').length).toBeGreaterThan(0));
    fillValidLeave();
    fireEvent.click(screen.getByText('Submit Request'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/leaves/apply',
        expect.objectContaining({ reason: 'Fever' })
      )
    );
  });

  it('shows success toast after submit', async () => {
    mockRoles = ['employee'];        // see the test above
    stubApis();
    render(<ApplyLeave />);
    await waitFor(() => expect(screen.getAllByText('Sick Leave').length).toBeGreaterThan(0));
    fillValidLeave();
    fireEvent.click(screen.getByText('Submit Request'));
    await waitFor(() =>
      expect(screen.getByText('Leave application submitted successfully!')).toBeDefined()
    );
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// MyLeaves — employee's own balance and leave history
// ─────────────────────────────────────────────────────────────────────────────
describe('MyLeaves — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MyLeaves />);
    expect(screen.getByText('My Leaves')).toBeDefined();
  });

  it('shows "Loading…" while fetching', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MyLeaves />);
    expect(screen.getByText(/loading/i)).toBeDefined();
  });

  it('shows empty state when no applications exist', async () => {
    stubApis({ leaves: [] });
    render(<MyLeaves />);
    await waitFor(() => expect(screen.getByText(/no leave requests/i)).toBeDefined());
  });

  it('shows the balance of each type', async () => {
    stubApis({ leaves: [] });
    render(<MyLeaves />);
    await waitFor(() => expect(screen.getByText('Sick Leave')).toBeDefined());
    expect(screen.getByText(/of 6 left/)).toBeDefined();
  });

  it('renders a leave with its reason and approval chain', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<MyLeaves />);
    await waitFor(() => expect(screen.getByText('Fever and flu')).toBeDefined());
    expect(screen.getByTitle('Manager: pending')).toBeDefined();
    expect(screen.getByTitle('HR: waiting')).toBeDefined();
    // No department-head step unless the type needs one.
    expect(screen.queryByTitle(/Department head/)).toBeNull();
  });

  it('shows the department-head step and HR\'s rejection reason', async () => {
    stubApis({ leaves: [{ ...PENDING_LEAVE, status: 'rejected', manager_status: 'approved', l2_required: true, l2_status: 'approved', hr_status: 'rejected', hr_comments: 'Quarter-end close' }] });
    render(<MyLeaves />);
    await waitFor(() => expect(screen.getByText('Quarter-end close')).toBeDefined());
    expect(screen.getByTitle('Department head: approved')).toBeDefined();
    expect(screen.getByTitle('HR: rejected')).toBeDefined();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// AllLeaves — company-wide register (filters, export, history; no decisions)
// ─────────────────────────────────────────────────────────────────────────────
describe('AllLeaves — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<AllLeaves />);
    expect(document.querySelector('.plh-page')).not.toBeNull();
    expect(screen.getByText('All Leaves')).toBeDefined();
  });

  it('shows empty state when no leave applications exist', async () => {
    stubApis({ leaves: [] });
    render(<AllLeaves />);
    await waitFor(() => expect(screen.getByText('No leave requests match these filters.')).toBeDefined());
  });

  it('renders leave row with employee name and reason', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<AllLeaves />);
    await waitFor(() => expect(screen.getByText('Priya Nair')).toBeDefined());
    expect(screen.getByText('Fever and flu')).toBeDefined();
  });

  it('does not decide leave here — Leave Approvals does, level by level', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<AllLeaves />);
    await waitFor(() => screen.getByText('Priya Nair'));
    expect(screen.queryByTitle('Approve')).toBeNull();
    expect(screen.queryByTitle('Reject')).toBeNull();
  });

  it('has no balance cards of the person logged in, and no own Apply drawer', async () => {
    stubApis({ leaves: [] });
    const setPage = vi.fn();
    render(<AllLeaves setPage={setPage} />);
    expect(screen.queryByText('Leave Balances')).toBeNull();
    fireEvent.click(screen.getByText('Apply on behalf'));
    expect(setPage).toHaveBeenCalledWith('ApplyLeave');
  });

  it('sends the filters to the server', async () => {
    stubApis({ leaves: [] });
    render(<AllLeaves />);
    await waitFor(() => screen.getByText('No leave requests match these filters.'));
    fireEvent.change(screen.getByDisplayValue('All status'), { target: { value: 'approved' } });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/leaves/applications',
      expect.objectContaining({ params: expect.objectContaining({ status: 'approved' }) })));
  });

  it('opens the approval history of a request', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<AllLeaves />);
    await waitFor(() => screen.getByText('Priya Nair'));
    fireEvent.click(screen.getByTitle('Approval history'));
    await waitFor(() => expect(screen.getByText('Approval history')).toBeDefined());
    expect(api.get).toHaveBeenCalledWith(`/leaves/applications/${PENDING_LEAVE.id}/history`);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// LeaveApprovals — Manager (L1) / Dept Head (L2) / HR (final) / Team View
// ─────────────────────────────────────────────────────────────────────────────
describe('LeaveApprovals — smoke', () => {

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveApprovals />);
    expect(screen.getByText('Leave Approvals')).toBeDefined();
  });

  it('shows the queue tabs an hr_manager works', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveApprovals />);
    expect(screen.getByText('Manager (L1)')).toBeDefined();
    expect(screen.getByText('Dept Head (L2)')).toBeDefined();
    expect(screen.getByText('HR (final)')).toBeDefined();
    expect(screen.getByText('Team View')).toBeDefined();
  });

  it('shows empty state when nothing is waiting', async () => {
    stubApis({ leaves: [] });
    render(<LeaveApprovals />);
    await waitFor(() => expect(screen.getByText('Nothing waiting for you here')).toBeDefined());
  });

  it('renders leave row with the applicant\'s balance after the leave', async () => {
    stubApis({ leaves: [{ ...PENDING_LEAVE, employee_id: 7, leave_type_id: 1 }],
      balance: [{ leave_type_id: 1, leave_name: 'Sick Leave', allocated_days: 6, used_days: 2, pending_days: 2, available_days: 2 }] });
    render(<LeaveApprovals />);
    await waitFor(() => expect(screen.getByText('Priya Nair')).toBeDefined());
    expect(screen.getByText('Fever and flu')).toBeDefined();
    await waitFor(() => expect(screen.getByText('2 left after')).toBeDefined());
  });

  it('calls the manager approve endpoint on the L1 tab', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<LeaveApprovals />);
    await waitFor(() => screen.getByText('Priya Nair'));
    fireEvent.click(screen.getAllByText('Approve')[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/leaves/approve/manager/${PENDING_LEAVE.id}`, expect.any(Object)));
  });

  it('a rejection needs a comment (no call without one)', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<LeaveApprovals />);
    await waitFor(() => screen.getByText('Priya Nair'));
    fireEvent.click(screen.getAllByText('Reject')[0]);
    await waitFor(() => expect(api.post).not.toHaveBeenCalled());
  });

  it('the L2 and HR tabs load their own server queues', async () => {
    stubApis({ leaves: [] });
    render(<LeaveApprovals />);
    fireEvent.click(screen.getByText('Dept Head (L2)'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/leaves/applications', expect.objectContaining({ params: expect.objectContaining({ queue: 'l2' }) })));
    fireEvent.click(screen.getByText('HR (final)'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/leaves/applications', expect.objectContaining({ params: expect.objectContaining({ queue: 'hr' }) })));
  });

  it('calls the HR approve endpoint on the HR tab', async () => {
    stubApis({ leaves: [{ ...PENDING_LEAVE, manager_status: 'approved' }] });
    render(<LeaveApprovals initialQueue="hr" />);
    await waitFor(() => screen.getByText('Priya Nair'));
    fireEvent.click(screen.getAllByText('Approve')[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/leaves/approve/hr/${PENDING_LEAVE.id}`, expect.any(Object)));
  });

  it('filters rows by search input', async () => {
    const another = { ...PENDING_LEAVE, id: 20, employee_name: 'Rahul Sharma', reason: 'Travel' };
    stubApis({ leaves: [PENDING_LEAVE, another] });
    render(<LeaveApprovals />);
    await waitFor(() => screen.getByText('Priya Nair'));
    fireEvent.change(screen.getByPlaceholderText(/search employee/i), { target: { value: 'Rahul' } });
    await waitFor(() => expect(screen.queryByText('Priya Nair')).toBeNull());
    expect(screen.getByText('Rahul Sharma')).toBeDefined();
  });

  it('Team View (the old Team Leaves page) lists the team with month and year filters', async () => {
    stubApis({ leaves: [PENDING_LEAVE] });
    render(<LeaveApprovals initialQueue="team" />);
    await waitFor(() => expect(screen.getByText('Priya Nair')).toBeDefined());
    expect(screen.getByText('All months')).toBeDefined();
  });

  it('a plain employee with no approve right sees only Team View', () => {
    mockRoles = ['employee'];
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveApprovals />);
    expect(screen.queryByText('HR (final)')).toBeNull();
    expect(screen.queryByText('Dept Head (L2)')).toBeNull();
    expect(screen.getByText('Team View')).toBeDefined();
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

  it('shows a legend entry for each type taken this month, and only those', async () => {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    stubApis({ leaves: [{ ...PENDING_LEAVE, status: 'approved', start_date: day, end_date: day }] });
    render(<LeaveCalendar />);
    await waitFor(() => expect(screen.getAllByText('Sick Leave').length).toBeGreaterThan(0));
    expect(screen.queryByText('Casual Leave')).toBeNull();
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

  it('keeps the same input while typing (no remount, so focus stays put)', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LeaveSettings />);
    fireEvent.click(screen.getByText('Add Leave Type'));
    const days = screen.getByPlaceholderText('e.g. 12');
    fireEvent.change(days, { target: { value: '1' } });
    // A Field component declared inside the modal remounted every input on
    // each keystroke (2026-11-24): the node here was a different element.
    expect(screen.getByPlaceholderText('e.g. 12')).toBe(days);
    expect(days.value).toBe('1');
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
