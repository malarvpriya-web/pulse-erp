/**
 * Succession Center — menu visibility through the REAL Sidebar (§209).
 *
 * Talent ratings are confidential. The row used to carry no `module`, so every
 * role holding the HR section — employee and manager included — saw it. It now
 * needs succession:view, which migration 20261029000004 grants to hr,
 * hr_manager, admin and super_admin only; any other role needs an explicit
 * grant in Roles Setup. See succession.routeAccess.test.jsx for the URL half.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = vi.hoisted(() => ({ roles: ['hr'], grants: new Set() }));
vi.mock('@/services/api/client', () => ({ default: { get: vi.fn(async () => ({ data: [] })) } }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    roles: auth.roles,
    role: auth.roles[0],
    hasAnyRole: (...r) => r.some(x => auth.roles.includes(x)),
    isEmployeeOnly: auth.roles.length === 1 && auth.roles[0] === 'employee',
    hasPermission: (m, a) => auth.grants.has(`${m}:${a}`),
    menuAccess: () => null,
  }),
}));

import Sidebar from '@/components/Sidebar';
import { NAV_ITEMS, ROUTES } from '@/config/routes';

const ROW = 'Succession Center';
const HR_SECTION = ['hr:view', 'employees:view'];

const rowOnScreen = () =>
  [...document.body.querySelectorAll('*')].some(el => el.textContent.trim() === ROW);

function groupsShowingRow(roles, grants) {
  auth.roles = roles;
  auth.grants = new Set(grants);
  const { container } = render(<MemoryRouter><Sidebar /></MemoryRouter>);
  const found = [];
  const groupButtons = [...container.querySelectorAll('.nav-item[aria-expanded]')];
  expect(groupButtons.length, 'the rail must render some groups to search').toBeGreaterThan(0);
  for (const btn of groupButtons) {
    const name = btn.querySelector('.label')?.textContent;
    expect(rowOnScreen(), `row still on screen before opening ${name}`).toBe(false);
    fireEvent.click(btn);
    if (rowOnScreen()) found.push(name);
    fireEvent.click(btn);
  }
  return found;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('wiring', () => {
  it('the menu row and every succession page require the succession module', () => {
    const row = NAV_ITEMS.flatMap(g => g.submenu || []).find(s => s.page === 'SuccessionCenter');
    expect(row?.module).toBe('succession');
    for (const page of ['SuccessionCenter', 'SuccessionPlanning', 'LeadershipPipeline', 'DevelopmentPlans',
      'EmployeeSuccessionPools', 'SuccessionReports', 'SuccessionSettings']) {
      expect(ROUTES[page]?.module, page).toBe('succession');
    }
  });
});

describe('menu visibility', () => {
  it('hr with succession:view sees the row under HR', () => {
    expect(groupsShowingRow(['hr'], [...HR_SECTION, 'succession:view'])).toEqual(['HR']);
  });

  it('a user whose NON-primary role grants succession:view sees it (union of roles)', () => {
    expect(groupsShowingRow(['employee', 'hr'], [...HR_SECTION, 'succession:view'])).toEqual(['HR']);
  });

  it.each([
    ['employee', ['employees:view', 'hr:view']],
    ['manager', ['employees:view', 'hr:view']],
    ['department_head', ['employees:view']],
    ['hr_exec', ['hr:view']],
  ])('%s without succession:view does not see the row', (role, grants) => {
    expect(groupsShowingRow([role], grants)).toEqual([]);
  });

  it('hr with succession:view revoked in Roles Setup does not see it', () => {
    expect(groupsShowingRow(['hr'], HR_SECTION)).toEqual([]);
  });

  // A role with no section allowlist is permission-driven: the grant alone
  // decides. This is how a leadership role is enabled when Manifest is ready.
  it('a custom role given succession:view in Roles Setup sees it', () => {
    expect(groupsShowingRow(['zz_custom_talent'], ['hr:view', 'succession:view'])).toEqual(['HR']);
  });

  // Unchanged: manager's HR section is scoped to its own pages
  // (MANAGER_HR_SCOPED_PAGES), so a grant alone does not add the row for it.
  it('manager stays without the row even with a grant (HR section page scoping)', () => {
    expect(groupsShowingRow(['manager'], ['employees:view', 'hr:view', 'succession:view'])).toEqual([]);
  });
});
