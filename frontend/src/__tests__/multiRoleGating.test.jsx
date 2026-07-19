/**
 * multiRoleGating.test.jsx — the secondary-role regression guard.
 *
 * Every OTHER page test mocks useAuth, so `hasAnyRole` is a stub and the real
 * wiring is never exercised. These use the REAL AuthProvider with roles seeded
 * into localStorage (the same trick as permissions_shape.test.jsx), so they fail
 * if a page goes back to reading `user.role`.
 *
 * The scenario is the one that was broken: PRIMARY role `employee`, SECONDARY
 * role `hr_manager`. `users.role` is only the primary mirror of the many-to-many
 * user_roles set, so `user.role` reads 'employee' and any gate built on it hides
 * controls the person's second role grants. Gate on hasAnyRole() instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/services/api/client', () => ({
  default: {
    get:    vi.fn(() => Promise.resolve({ data: [] })),
    post:   vi.fn(() => Promise.resolve({ data: {} })),
    put:    vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

/** Seed the six keys AuthContext reads — missing any one silently degrades the UI. */
function seedSession(role, roles) {
  localStorage.setItem('token', 'tok');
  localStorage.setItem('user', JSON.stringify({
    name: 'Arun Kumar', email: 'arun@manifest.in', employee_id: 4, id: 4, role, roles,
  }));
  localStorage.setItem('role', role);
  localStorage.setItem('roles', JSON.stringify(roles));
  localStorage.setItem('permissions', JSON.stringify([]));
  localStorage.setItem('menuOverrides', JSON.stringify({}));
}

const renderWithAuth = async (ui) => {
  const { AuthProvider } = await import('@/context/AuthContext');
  return render(<MemoryRouter><AuthProvider>{ui}</AuthProvider></MemoryRouter>);
};

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

describe('AuthContext.hasAnyRole — the mechanism the pages rely on', () => {
  it('matches a SECONDARY role even though user.role is employee', async () => {
    seedSession('employee', ['employee', 'hr_manager']);
    const { useAuth, AuthProvider } = await import('@/context/AuthContext');

    let seen;
    const Probe = () => {
      const { hasAnyRole, user, roles } = useAuth();
      seen = { primary: user?.role, roles, isHR: hasAnyRole('hr', 'hr_manager', 'admin') };
      return null;
    };
    render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>);

    await waitFor(() => expect(seen).toBeDefined());
    // The exact shape of the bug: primary says employee, the role set says otherwise.
    expect(seen.primary).toBe('employee');
    expect(seen.roles).toContain('hr_manager');
    expect(seen.isHR).toBe(true);
  }, 20000);

  it('does not match a role the user does not hold', async () => {
    seedSession('employee', ['employee']);
    const { useAuth, AuthProvider } = await import('@/context/AuthContext');

    let isHR;
    const Probe = () => { isHR = useAuth().hasAnyRole('hr', 'hr_manager', 'admin'); return null; };
    render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>);

    await waitFor(() => expect(isHR).toBeDefined());
    expect(isHR).toBe(false);
  }, 20000);
});

describe('LeaveSettings — real AuthProvider', () => {
  it('shows the manage controls to a secondary-role hr_manager', async () => {
    seedSession('employee', ['employee', 'hr_manager']);
    const LeaveSettings = (await import('@/features/leaves/pages/LeaveSettings')).default;
    await renderWithAuth(<LeaveSettings />);
    // Gated on canManage — hidden entirely when the gate reads only user.role.
    await waitFor(() => expect(screen.getByText('Add Leave Type')).toBeDefined());
  }, 20000);

  it('hides the manage controls from a plain employee', async () => {
    seedSession('employee', ['employee']);
    const LeaveSettings = (await import('@/features/leaves/pages/LeaveSettings')).default;
    await renderWithAuth(<LeaveSettings />);
    await waitFor(() => expect(screen.getByText('Leave Settings')).toBeDefined());
    expect(screen.queryByText('Add Leave Type')).toBeNull();
  }, 20000);
});

describe('LeaveApprovals — queue visibility must fail CLOSED', () => {
  it('shows no approval queues to a plain employee, only Team View', async () => {
    seedSession('employee', ['employee']);
    const LeaveApprovals = (await import('@/features/leaves/pages/LeaveApprovals')).default;
    await renderWithAuth(<LeaveApprovals />);
    await waitFor(() => expect(screen.getByText('Leave Approvals')).toBeDefined());
    // Used to fail OPEN — an employee matching no queue role saw every queue.
    expect(screen.queryByText('L1 — Manager')).toBeNull();
    expect(screen.getByText('Team View')).toBeDefined();
  }, 20000);

  it('shows the manager queue to a secondary-role manager', async () => {
    seedSession('employee', ['employee', 'manager']);
    const LeaveApprovals = (await import('@/features/leaves/pages/LeaveApprovals')).default;
    await renderWithAuth(<LeaveApprovals />);
    await waitFor(() => expect(screen.getByText('L1 — Manager')).toBeDefined());
  }, 20000);
});

describe('Timesheets — real AuthProvider', () => {
  // PRIVILEGED_ROLES used to carry display names ('HR Manager', 'Finance Manager',
  // 'Project Manager') that match no roles.code, so these two never got the
  // privileged view even as their PRIMARY role.
  it.each([
    ['finance_manager'],
    ['project_manager'],
    ['hr_manager'],
  ])('treats %s as privileged', async (roleCode) => {
    seedSession(roleCode, [roleCode]);
    const { useAuth, AuthProvider } = await import('@/context/AuthContext');
    let ok;
    const Probe = () => {
      ok = useAuth().hasAnyRole('admin', 'super_admin', 'manager', 'hr', 'hr_manager',
        'finance_manager', 'project_manager');
      return null;
    };
    render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(ok).toBeDefined());
    expect(ok).toBe(true);
  }, 20000);
});
