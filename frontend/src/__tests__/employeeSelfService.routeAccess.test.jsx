/**
 * Employee Self-Service — direct-URL access through the REAL Layout guards.
 *
 * The portal belongs to the roles that hold the HR menu — by menu AND by URL
 * (management decision 2026-10-29, §202). It is NOT a PERSONAL_PAGES entry, so
 * roles without the HR section are refused it by address; the server enforces
 * the same boundary with the self_service grant. HR management screens stay
 * closed to employees and managers. Only the page components are probes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const auth = vi.hoisted(() => ({ role: 'employee', grants: new Set() }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    role: auth.role,
    user: { id: 1, employee_id: 7 },
    hasPermission: (m, a) => auth.grants.has(`${m}:${a}`),
    menuAccess: () => null,
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
const PROBED = ['EmployeeSelfService', 'EmployeeDashboard', 'PayrollCenter', 'ExitCenter'];
vi.mock('../config/autoRouter', async () => {
  const { ROUTES } = await import('../config/routes');
  const probes = Object.fromEntries(PROBED.map(k => [k, { ...ROUTES[k], component: () => <div data-testid="page">{k}</div> }]));
  return {
    MERGED_ROUTES: {
      ...ROUTES, ...probes,
      Unauthorized: { component: () => <div data-testid="denied">unauthorized</div> },
    },
  };
});

const { default: Layout } = await import('../components/Layout');

const GRANTS = {
  super_admin: [], admin: [],
  hr: ['hr:view', 'employees:view', 'payroll:view'], hr_manager: ['hr:view', 'payroll:view'], hr_exec: ['hr:view'],
  payroll_admin: ['hr:view', 'payroll:view'], manager: ['employees:view'], employee: ['employees:view'],
  department_head: ['employees:view'], sales_exec: [], finance_manager: ['payroll:view'],
};

async function outcome(role, page) {
  document.body.innerHTML = '';
  auth.role = role;
  auth.grants = new Set(GRANTS[role]);
  render(
    <MemoryRouter initialEntries={[`/${page}`]}>
      <Routes><Route path="/:page" element={<Layout />} /></Routes>
    </MemoryRouter>,
  );
  const hit = await screen.findByTestId(/^(page|denied)$/);
  return hit.dataset.testid;
}

beforeEach(() => { document.body.innerHTML = ''; });

const HR_MENU_ROLES = ['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'manager', 'employee'];

describe('the portal by direct URL', () => {
  it.each(HR_MENU_ROLES)('%s can open Employee Self-Service', async (role) => {
    expect(await outcome(role, 'EmployeeSelfService')).toBe('page');
  });
  it.each(['department_head', 'sales_exec', 'finance_manager'])('%s (no HR menu) is refused it by address too', async (role) => {
    expect(await outcome(role, 'EmployeeSelfService')).toBe('denied');
  });
  it('My Dashboard stays open to every role (PERSONAL_PAGES)', async () => {
    expect(await outcome('sales_exec', 'EmployeeDashboard')).toBe('page');
  });
});

describe('HR management pages stay separate', () => {
  it.each(['employee', 'manager', 'department_head', 'sales_exec'])('%s is still refused Payroll Center and Exit & Probation', async (role) => {
    expect(await outcome(role, 'PayrollCenter')).toBe('denied');
    expect(await outcome(role, 'ExitCenter')).toBe('denied');
  });

  it('HR keeps them', async () => {
    expect(await outcome('hr_manager', 'PayrollCenter')).toBe('page');
    expect(await outcome('hr', 'ExitCenter')).toBe('page');
  });
});
