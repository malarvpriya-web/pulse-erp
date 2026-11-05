/**
 * Direct-URL access for My Probation Reviews (open to every role; the API
 * decides the content) and HR's probation pages (unchanged: HR roles only).
 * Harness as in internships.routeAccess.test.jsx: the real Layout guard, with
 * each page swapped for a probe so only the access decision is under test.
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
const HR_PAGES = ['Probation', 'ExitCenter'];
vi.mock('../config/autoRouter', async () => {
  const { ROUTES } = await import('../config/routes');
  const probe = (k) => ({ ...ROUTES[k], component: () => <div data-testid="page">{k}</div> });
  return {
    MERGED_ROUTES: {
      ...ROUTES,
      Probation: probe('Probation'), ExitCenter: probe('ExitCenter'),
      MyProbationReviews: probe('MyProbationReviews'),
      Unauthorized: { component: () => <div data-testid="denied">unauthorized</div> },
    },
  };
});

const { default: Layout } = await import('../components/Layout');
const { ROUTES } = await import('../config/routes');

const GRANTS = {
  super_admin:     [],
  admin:           [],
  hr:              ['hr:view', 'employees:view', 'internships:view'],
  hr_manager:      ['hr:view', 'internships:view'],
  hr_exec:         ['hr:view', 'internships:view'],
  manager:         ['employees:view'],
  employee:        ['employees:view'],
  sales_exec:      [],
  department_head: ['employees:view'],
};

async function outcome(role, page) {
  document.body.innerHTML = '';
  auth.role = role;
  auth.grants = new Set(GRANTS[role]);
  render(
    <MemoryRouter initialEntries={[`/${page}?ref=41`]}>
      <Routes><Route path="/:page" element={<Layout />} /></Routes>
    </MemoryRouter>,
  );
  const hit = await screen.findByTestId(/^(page|denied)$/);
  return hit.dataset.testid;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('My Probation Reviews by direct URL', () => {
  it('is registered without a module, so no HR permission is needed to reach it', () => {
    expect(ROUTES.MyProbationReviews).toBeTruthy();
    expect(ROUTES.MyProbationReviews.module).toBeUndefined();
  });

  // Open to every role; what it shows is decided by the server (head summary +
  // /mine). What it must NOT do is open HR's probation pages alongside it.
  it.each(['department_head', 'employee', 'manager', 'sales_exec', 'hr', 'hr_exec', 'admin'])(
    '%s reaches the page', async (role) => {
      expect(await outcome(role, 'MyProbationReviews')).toBe('page');
    });
});

describe("HR's probation pages are unchanged", () => {
  for (const role of ['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec']) {
    it.each(HR_PAGES)(`${role} can still open %s`, async (page) => {
      expect(await outcome(role, page)).toBe('page');
    });
  }
  for (const role of ['department_head', 'manager', 'employee', 'sales_exec']) {
    it.each(HR_PAGES)(`${role} is still blocked from %s`, async (page) => {
      expect(await outcome(role, page)).toBe('denied');
    });
  }
});
