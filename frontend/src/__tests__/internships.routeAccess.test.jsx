/**
 * Internships — direct-URL access through the REAL Layout guards.
 *
 * The route keys (Internships, AddIntern, ViewIntern, EditIntern) and their
 * `module: 'internships'` gate are unchanged by moving the menu row under HR;
 * what changed is the section the pages resolve to ('HR'), which brings the HR
 * section's per-role scopings into play. Everything that decides access is real:
 * menuCatalog's allowlists and scopings and the routes.jsx entries. Only the page
 * components are swapped for probes.
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
const PAGES = ['Internships', 'AddIntern', 'ViewIntern', 'EditIntern'];
vi.mock('../config/autoRouter', async () => {
  const { ROUTES } = await import('../config/routes');
  const probe = (k) => ({ ...ROUTES[k], component: () => <div data-testid="page">{k}</div> });
  return {
    MERGED_ROUTES: {
      ...ROUTES,
      Internships: probe('Internships'), AddIntern: probe('AddIntern'),
      ViewIntern: probe('ViewIntern'), EditIntern: probe('EditIntern'),
      MyInternEvaluations: probe('MyInternEvaluations'),
      Unauthorized: { component: () => <div data-testid="denied">unauthorized</div> },
    },
  };
});

const { default: Layout } = await import('../components/Layout');
const { ROUTES } = await import('../config/routes');

const GRANTS = {
  super_admin:   [],
  admin:         [],
  hr:            ['hr:view', 'employees:view', 'internships:view'],
  hr_manager:    ['hr:view', 'internships:view'],
  hr_exec:       ['hr:view', 'internships:view'],
  payroll_admin: ['hr:view'],
  manager:       ['employees:view'],
  employee:      ['employees:view'],
  sales_exec:    [],
  design_engineer: [],
  department_head: ['employees:view'],
};

async function outcome(role, page) {
  document.body.innerHTML = '';
  auth.role = role;
  auth.grants = new Set(GRANTS[role]);
  render(
    <MemoryRouter initialEntries={[`/${page}?id=1`]}>
      <Routes><Route path="/:page" element={<Layout />} /></Routes>
    </MemoryRouter>,
  );
  const hit = await screen.findByTestId(/^(page|denied)$/);
  return hit.dataset.testid;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('the routes are unchanged', () => {
  it.each(PAGES)('%s is still gated on the internships module', (page) => {
    expect(ROUTES[page]?.module).toBe('internships');
  });
});

describe('direct URL access', () => {
  for (const role of ['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec']) {
    it.each(PAGES)(`${role} can open %s`, async (page) => {
      expect(await outcome(role, page)).toBe('page');
    });
  }
  for (const role of ['payroll_admin', 'manager', 'employee', 'sales_exec']) {
    it.each(PAGES)(`${role} is blocked from %s`, async (page) => {
      expect(await outcome(role, page)).toBe('denied');
    });
  }
});

describe('My Intern Evaluations by direct URL', () => {
  // The route is open to every role (PERSONAL_PAGES, no module); whether there is
  // anything on it is decided per request by the mentor assignment on the
  // server. What it must NOT do is open the intern register alongside it.
  it.each(['employee', 'manager', 'department_head', 'sales_exec', 'design_engineer', 'payroll_admin', 'hr_exec', 'admin'])(
    '%s reaches the page; the Internships register stays as it was', async (role) => {
      expect(await outcome(role, 'MyInternEvaluations')).toBe('page');
      const register = await outcome(role, 'Internships');
      expect(register).toBe(['hr_exec', 'admin'].includes(role) ? 'page' : 'denied');
    });
});
