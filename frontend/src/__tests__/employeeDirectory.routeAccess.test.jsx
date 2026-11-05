/**
 * Employee Directory ↔ All Employees — direct URLs through the REAL Layout gates.
 *
 * 2026-10-20: the phonebook left the HR menu. Anyone who can open All Employees
 * (EmployeesData) is redirected there from /EmployeeDirectory; everyone else
 * keeps the phonebook. The invariant this file exists for: NOBODY is sent to an
 * Access Denied screen by that redirect — it fires only when canRenderPage()
 * (the very function Layout gates every route with) says the master will open.
 *
 * Everything that decides access is real: menuCatalog's allowlists and
 * scopings, and the route entries from routes.jsx (their `module`). Only the
 * two page components and Unauthorized are swapped for probes.
 *
 * Grants mirror the live role_permissions rows (2026-10-20):
 *   employees:view — super_admin, admin, hr, manager, department_head, employee
 *   hr:view        — super_admin, admin, hr, hr_manager, hr_exec, payroll_admin
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const auth = vi.hoisted(() => ({ role: 'hr', grants: new Set(), overrides: {} }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    role: auth.role,
    user: { id: 1 },
    hasPermission: (m, a) => auth.grants.has(`${m}:${a}`),
    menuAccess: (section) => auth.overrides[section] ?? null,
    logout: vi.fn(),
  }),
}));
vi.mock('../components/Layout.css', () => ({}));
vi.mock('../components/Sidebar', () => ({ default: () => <div /> }));
vi.mock('../components/Topbar', () => ({ default: () => <div /> }));
vi.mock('../components/ErrorBoundary', () => ({ default: ({ children }) => children }));
vi.mock('../components/SessionTimeoutModal', () => ({ default: () => <div /> }));
vi.mock('../components/dashboard/CelebrationSpotlight', () => ({ default: () => <div /> }));
vi.mock('../hooks/useSessionManager', () => ({
  default: () => ({ showWarning: false, sessionTimeRemaining: 0, extendSession: vi.fn(), forceLogout: vi.fn() }),
}));
vi.mock('../config/autoRouter', async () => {
  const { ROUTES } = await import('../config/routes');
  return {
    MERGED_ROUTES: {
      ...ROUTES,
      EmployeeDirectory: { ...ROUTES.EmployeeDirectory, component: () => <div data-testid="directory">phonebook</div> },
      EmployeesData:     { ...ROUTES.EmployeesData,     component: () => <div data-testid="master">all employees</div> },
      Unauthorized:      { component: () => <div data-testid="denied">unauthorized</div> },
    },
  };
});

const { default: Layout } = await import('../components/Layout');

const GRANTS = {
  super_admin:     ['employees:view', 'hr:view'],
  admin:           ['employees:view', 'hr:view'],
  hr:              ['employees:view', 'hr:view'],
  manager:         ['employees:view'],
  department_head: ['employees:view'],
  employee:        ['employees:view'],
  hr_manager:      ['hr:view'],
  hr_exec:         ['hr:view'],
  payroll_admin:   ['hr:view'],
};
const MASTER_ROLES    = ['super_admin', 'admin', 'hr', 'manager', 'department_head'];
const DIRECTORY_ROLES = ['employee', 'hr_manager', 'hr_exec', 'payroll_admin'];

function openAs(role, url, overrides = {}) {
  auth.role = role;
  auth.grants = new Set(GRANTS[role]);
  auth.overrides = overrides;
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes><Route path="/:page" element={<Layout />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('/EmployeeDirectory', () => {
  it.each(MASTER_ROLES)('%s is redirected to All Employees', async (role) => {
    openAs(role, '/EmployeeDirectory');
    expect(await screen.findByTestId('master')).toBeTruthy();
    expect(screen.queryByTestId('directory')).toBeNull();
    expect(screen.queryByTestId('denied')).toBeNull();
  });

  it.each(DIRECTORY_ROLES)('%s keeps the read-only phonebook (never Access Denied)', async (role) => {
    openAs(role, '/EmployeeDirectory');
    expect(await screen.findByTestId('directory')).toBeTruthy();
    expect(screen.queryByTestId('denied')).toBeNull();
    expect(screen.queryByTestId('master')).toBeNull();
  });
});

describe('/EmployeesData — why those four are not redirected', () => {
  it.each(DIRECTORY_ROLES)('%s cannot open All Employees', async (role) => {
    openAs(role, '/EmployeesData');
    expect(await screen.findByTestId('denied')).toBeTruthy();
  });

  it.each(MASTER_ROLES)('%s can', async (role) => {
    openAs(role, '/EmployeesData');
    expect(await screen.findByTestId('master')).toBeTruthy();
  });
});

describe('Page Access overrides never turn the redirect into Access Denied', () => {
  it('hr with Employees set to Not Visible stays on the phonebook', async () => {
    openAs('hr', '/EmployeeDirectory', { Employees: 'hidden' });
    expect(await screen.findByTestId('directory')).toBeTruthy();
    expect(screen.queryByTestId('denied')).toBeNull();
  });

  // canRoleOpenPage() treats a 'view' grant as decisive, but Layout still
  // applies hr_manager's section allowlist (no 'Employees') — a redirect built
  // on the looser predicate would land here on Access Denied.
  it('hr_manager granted View on Employees still stays on the phonebook', async () => {
    openAs('hr_manager', '/EmployeeDirectory', { Employees: 'view' });
    expect(await screen.findByTestId('directory')).toBeTruthy();
    expect(screen.queryByTestId('denied')).toBeNull();
  });

  it('a role whose Employee Directory section is Not Visible is refused it, as any hidden section is', async () => {
    openAs('employee', '/EmployeeDirectory', { 'Employee Directory': 'hidden' });
    expect(await screen.findByTestId('denied')).toBeTruthy();
  });
});
