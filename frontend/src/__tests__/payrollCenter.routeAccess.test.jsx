/**
 * Payroll Center consolidation — direct URLs through the REAL Layout gates.
 *
 * 2026-10-28: the six payroll pages are sections of Payroll Center. Whoever
 * can render the hub is redirected from the old page key to the matching
 * section; everyone else is gated on the old page exactly as before. The
 * invariant: the redirect neither grants nor removes access — for every role
 * and page, the outcome is either the hub (which that role could already
 * open) or precisely what canRenderPage() gave the page before.
 *
 * Everything that decides access is real: menuCatalog's allowlists and
 * scopings and the route entries from routes.jsx (their `module`). Only the
 * page components and Unauthorized are swapped for probes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

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

const PAGES = ['Payroll', 'SalaryStructure', 'PayslipGenerator', 'PayrollSettings', 'PayrollForm16', 'PayrollForm24Q', 'PayslipViewer'];

vi.mock('../config/autoRouter', async () => {
  const { ROUTES } = await import('../config/routes');
  const Hub = () => { const { search } = useLocation(); return <div data-testid="hub">{search}</div>; };
  const probes = Object.fromEntries(
    ['Payroll', 'SalaryStructure', 'PayslipGenerator', 'PayrollSettings', 'PayrollForm16', 'PayrollForm24Q', 'PayslipViewer']
      .map(p => [p, { ...ROUTES[p], component: () => <div data-testid={`page-${p}`}>{p}</div> }]),
  );
  return {
    MERGED_ROUTES: {
      ...ROUTES,
      ...probes,
      PayrollCenter: { ...ROUTES.PayrollCenter, component: Hub },
      Unauthorized:  { component: () => <div data-testid="denied">unauthorized</div> },
    },
  };
});

const { default: Layout } = await import('../components/Layout');
const { ROUTES } = await import('../config/routes');
const { canRenderPage, PAYROLL_HUB_PAGES } = await import('../config/menuCatalog');

// hr:view mirrors the live role_permissions rows used by the other routeAccess suites;
// payroll:view and payroll_tds_extract:export the PC-01 matrix (migration 20261104000001)
// that the payroll routes are now gated on.
const GRANTS = {
  super_admin:     ['employees:view', 'hr:view', 'payroll:view', 'payroll_tds_extract:export'],
  admin:           ['employees:view', 'hr:view', 'payroll:view', 'payroll_tds_extract:export'],
  hr:              ['employees:view', 'hr:view', 'payroll:view'],
  hr_manager:      ['hr:view', 'payroll:view'],
  hr_exec:         ['hr:view'],
  payroll_admin:   ['hr:view', 'payroll:view'],
  manager:         ['employees:view'],
  department_head: ['employees:view'],
  employee:        ['employees:view'],
  finance_manager: ['payroll:view', 'payroll_tds_extract:export'],
  finance:         ['payroll_tds_extract:export'],
  accounts_exec:   ['payroll_tds_extract:export'],
};

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

const gate = (role, page, overrides = {}) => canRenderPage(role, page, {
  route: ROUTES[page],
  menuAccess: (s) => overrides[s] ?? null,
  hasPermission: (m, a) => new Set(GRANTS[role]).has(`${m}:${a}`),
});

beforeEach(() => { document.body.innerHTML = ''; });

describe('old payroll page keys', () => {
  const cases = Object.keys(GRANTS).flatMap(role => PAGES.map(page => [role, page]));

  it.each(cases)('%s opening /%s: the hub section, or exactly the old outcome', async (role, page) => {
    openAs(role, `/${page}`);
    const target = PAYROLL_HUB_PAGES[page];
    if (target && gate(role, 'PayrollCenter')) {
      const hub = await screen.findByTestId('hub');
      expect(hub.textContent).toBe(`?${new URLSearchParams(target).toString()}`);
    } else if (gate(role, page)) {
      expect(await screen.findByTestId(`page-${page}`)).toBeTruthy();
    } else {
      expect(await screen.findByTestId('denied')).toBeTruthy();
    }
  });

  it('the hub audience is redirected: hr → /Payroll lands on Payroll Processing', async () => {
    openAs('hr', '/Payroll');
    expect((await screen.findByTestId('hub')).textContent).toBe('?tab=processing');
  });

  it('Form 24Q page key lands on the Form 138 view', async () => {
    openAs('payroll_admin', '/PayrollForm24Q');
    expect((await screen.findByTestId('hub')).textContent).toBe('?tab=statutory&view=form138');
  });

  it('hr_exec (no Payroll Center) is never redirected into the hub', async () => {
    expect(gate('hr_exec', 'PayrollCenter')).toBe(false);
    openAs('hr_exec', '/Payroll');
    await screen.findByTestId(gate('hr_exec', 'Payroll') ? 'page-Payroll' : 'denied');
    expect(screen.queryByTestId('hub')).toBeNull();
  });

  it('a Page Access "hidden" HR section stops the redirect (the hub would refuse)', async () => {
    const hidden = { HR: 'hidden' };
    expect(gate('hr', 'PayrollCenter', hidden)).toBe(false);
    openAs('hr', '/SalaryStructure', hidden);
    await screen.findByTestId(gate('hr', 'SalaryStructure', hidden) ? 'page-SalaryStructure' : 'denied');
    expect(screen.queryByTestId('hub')).toBeNull();
  });
});

describe('My Payslip stays a standalone page', () => {
  it.each(Object.keys(GRANTS))('%s opening /PayslipViewer is never redirected', async (role) => {
    openAs(role, '/PayslipViewer');
    await screen.findByTestId(gate(role, 'PayslipViewer') ? 'page-PayslipViewer' : 'denied');
    expect(screen.queryByTestId('hub')).toBeNull();
  });
  // NOTE (pre-existing, reported 2026-10-28, not changed here): PayslipViewer's
  // only menu row is Finance → My Payslip, and 'Finance' is not in the employee
  // allowlist, so canRenderPage refuses it for `employee` — Employee
  // Dashboard's "View payslip" buttons open Access Denied. Granting it is an
  // access decision; this suite only asserts the consolidation left it as is.
});
