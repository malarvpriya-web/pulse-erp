/**
 * Workforce Analytics & Reports — direct-URL access through the REAL Layout guards.
 *
 * Approved policy: hr:view opens the page; employees:view is additionally
 * needed only for employee-list drill-through (tested in
 * workforceAnalytics.page.test.jsx). No new grants.
 *
 * Everything that decides access is real here: menuCatalog's section allowlists
 * and per-role scopings, and the Employee Reports route entry from routes.jsx
 * (its `module`). Only the page component is swapped for a probe, so "rendered"
 * vs "Unauthorized" is the whole assertion.
 *
 * Grants mirror the live role_permissions rows for hr / employees view
 * (2026-10-13): hr ✓✓ · hr_exec, hr_manager, payroll_admin ✓✗ ·
 * manager, department_head, employee ✗✓ · sales_exec ✗✗.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const auth = vi.hoisted(() => ({ role: 'hr', grants: new Set() }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    role: auth.role,
    user: { id: 1 },
    hasPermission: (m, a) => auth.grants.has(`${m}:${a}`),
    menuAccess: () => null,          // no admin Page-Access override
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
// The real route table, with the two components this test renders replaced by probes.
vi.mock('../config/autoRouter', async () => {
  const { ROUTES } = await import('../config/routes');
  return {
    MERGED_ROUTES: {
      ...ROUTES,
      EmployeeReports: { ...ROUTES.EmployeeReports, component: () => <div data-testid="page">workforce analytics</div> },
      Unauthorized:    { component: () => <div data-testid="denied">unauthorized</div> },
    },
  };
});

const { default: Layout } = await import('../components/Layout');

const GRANTS = {
  hr:              ['hr:view', 'employees:view'],
  hr_exec:         ['hr:view'],
  hr_manager:      ['hr:view'],
  payroll_admin:   ['hr:view'],
  manager:         ['employees:view'],
  department_head: ['employees:view'],
  employee:        ['employees:view'],
  sales_exec:      [],
  // Roles with NO section allowlist — the permission-driven path.
  zz_custom_hr_viewer:  ['hr:view'],
  zz_custom_emp_viewer: ['employees:view'],
};

function openAs(role) {
  auth.role = role;
  auth.grants = new Set(GRANTS[role]);
  render(
    <MemoryRouter initialEntries={['/EmployeeReports']}>
      <Routes><Route path="/:page" element={<Layout />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('direct URL /EmployeeReports', () => {
  describe('1. HR access without employee-list access', () => {
    it.each(['hr_exec', 'hr_manager', 'payroll_admin', 'zz_custom_hr_viewer'])('%s opens the page', async (role) => {
      openAs(role);
      expect(await screen.findByTestId('page')).toBeTruthy();
      expect(screen.queryByTestId('denied')).toBeNull();
    });
  });

  describe('2. HR plus employee-list access', () => {
    it('hr opens the page', async () => {
      openAs('hr');
      expect(await screen.findByTestId('page')).toBeTruthy();
    });
  });

  describe('3. Employee-list access without HR access', () => {
    it.each(['manager', 'department_head', 'employee', 'zz_custom_emp_viewer'])('%s is denied', async (role) => {
      openAs(role);
      expect(await screen.findByTestId('denied')).toBeTruthy();
      expect(screen.queryByTestId('page')).toBeNull();
    });
  });

  describe('4. Neither permission', () => {
    it('sales_exec is denied', async () => {
      openAs('sales_exec');
      expect(await screen.findByTestId('denied')).toBeTruthy();
      expect(screen.queryByTestId('page')).toBeNull();
    });
  });
});
