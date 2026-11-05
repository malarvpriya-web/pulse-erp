import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

// Consolidating a sidebar row into a hub tab must not widen who can see it.
// The sidebar used to do that filtering per row — an employee's Travel Desk
// menu was cut down to the self-service pages, so Expense Review and Payment
// were never drawn. Now those pages are tabs inside TravelExpenseCenter, and
// the filtering has to happen again INSIDE the hub or the consolidation
// quietly hands every employee the finance queues.
//
// TabHub does that by running each tab through canRoleOpenPage — the same
// predicate Layout.jsx enforces at the route. These tests pin that behaviour
// on the two hubs where the blast radius is largest.

const { authState } = vi.hoisted(() => ({ authState: { role: 'employee' } }));

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    role: authState.role,
    roles: [authState.role],
    user: { id: 1, company_id: 1 },
    hasPermission: () => true,
    hasAnyRole: (...r) => r.includes(authState.role),
    isEmployeeOnly: authState.role === 'employee',
    menuAccess: () => null,
  }),
}));

import { TabHub } from '@/components/pulse-ui';
import { TABS as TRAVEL_EXPENSE_TABS } from '@/features/travel/pages/TravelExpenseCenter';
import { TABS as TRAVEL_VISIT_TABS } from '@/features/travel/pages/TravelVisits';
import { TABS as PLATFORM_TABS } from '@/features/admin/pages/PlatformCenter';
import { TABS as COMPANY_TABS } from '@/features/admin/pages/CompanySetup';
import { TABS as CATALOG_TABS } from '@/features/servicedesk/pages/ServiceCatalogCenter';

/** Tab labels TabHub actually draws for `role`. */
function tabsFor(role, tabs) {
  authState.role = role;
  render(<TabHub icon={null} eyebrow="x" title="x" subtitle="x" tabs={tabs} setPage={vi.fn()} />);
  return [...document.querySelectorAll('[role="tab"]')].map(b => b.textContent);
}

beforeEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('hub tabs respect the same gates the sidebar rows did', () => {
  it('gives an employee their own expense claims but not the finance queues', () => {
    // EMPLOYEE_SELF_SERVICE_PAGES lists ExpenseClaims and TravelExpenses;
    // ExpenseReview and TravelPayment are excluded as finance-only.
    expect(tabsFor('employee', TRAVEL_EXPENSE_TABS))
      .toEqual(['Expense Claims', 'Trip Expenses']);
  });

  it('gives an admin the full expense hub', () => {
    expect(tabsFor('admin', TRAVEL_EXPENSE_TABS))
      .toEqual(['Expense Claims', 'Trip Expenses', 'Expense Review', 'Payment']);
  });

  it('gives an employee visit reports but not the customer-visit register', () => {
    expect(tabsFor('employee', TRAVEL_VISIT_TABS)).toEqual(['Visit Reports']);
  });

  it('hides super-admin-only tabs from an admin', () => {
    // DatabaseTest and OrganizationSetup are SUPER_ADMIN_ONLY_PAGES. As rows
    // the sidebar stripped them for admin; as tabs TabHub must do the same.
    expect(tabsFor('admin', PLATFORM_TABS)).not.toContain('Database Test');
    expect(tabsFor('super_admin', PLATFORM_TABS)).toContain('Database Test');

    cleanup(); document.body.innerHTML = '';
    expect(tabsFor('admin', COMPANY_TABS)).not.toContain('Org Setup');
    cleanup(); document.body.innerHTML = '';
    expect(tabsFor('super_admin', COMPANY_TABS)).toContain('Org Setup');
  });

  it('hides admin-only Knowledge Base from a service engineer', () => {
    // ADMIN_ONLY_PAGES — the sidebar filtered this row for every non-admin.
    expect(tabsFor('service_engineer', CATALOG_TABS)).not.toContain('Knowledge Base');
    cleanup(); document.body.innerHTML = '';
    expect(tabsFor('admin', CATALOG_TABS)).toContain('Knowledge Base');
  });

  it('renders the first tab the viewer can open, not a blank shell', () => {
    // The default tab is tabs[0] — which for an employee on the expense hub is
    // Expense Claims, not the filtered-out Expense Review.
    authState.role = 'employee';
    render(<TabHub icon={null} eyebrow="x" title="Expenses" subtitle="x"
                   tabs={TRAVEL_EXPENSE_TABS} setPage={vi.fn()} />);
    const selected = [...document.querySelectorAll('[role="tab"]')]
      .find(b => b.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent).toBe('Expense Claims');
    expect(screen.getByText('Expenses')).toBeTruthy();
  });
});
