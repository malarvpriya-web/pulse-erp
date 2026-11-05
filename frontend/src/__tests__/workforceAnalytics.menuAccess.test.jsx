/**
 * Workforce Analytics & Reports — menu visibility through the REAL Sidebar.
 *
 * The row lives in the HR group: hr:view opens the page, and HR is the section
 * hr_exec / hr_manager / payroll_admin hold. It used to sit under Employees,
 * which those three roles do not hold, so the menu hid it from them although
 * each has hr:view. Grants mirror the live role_permissions rows (2026-10-13);
 * see workforceAnalytics.routeAccess.test.jsx for the direct-URL half.
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
import { NAV_ITEMS } from '@/config/routes';
import { getSectionForPage } from '@/config/menuCatalog';

const ROW = 'Workforce Analytics & Reports';
const GRANTS = {
  hr:              ['hr:view', 'employees:view'],
  hr_exec:         ['hr:view'],
  hr_manager:      ['hr:view'],
  payroll_admin:   ['hr:view'],
  manager:         ['employees:view'],
  department_head: ['employees:view'],
  employee:        ['employees:view'],
  sales_exec:      [],
  zz_custom_hr_viewer:  ['hr:view'],
  zz_custom_emp_viewer: ['employees:view'],
};

/**
 * The row is on screen. Searched in the whole document, not the rail's
 * container: the flyout that lists a group's rows renders outside it.
 */
const rowOnScreen = () =>
  [...document.body.querySelectorAll('*')].some(el => el.textContent.trim() === ROW);

/** Render the rail, open each group a user could open, and report where the row appears. */
function groupsShowingRow(role) {
  auth.roles = [role];
  auth.grants = new Set(GRANTS[role]);
  const { container } = render(<MemoryRouter><Sidebar /></MemoryRouter>);
  const found = [];
  const groupButtons = [...container.querySelectorAll('.nav-item[aria-expanded]')];
  expect(groupButtons.length, 'the rail must render some groups to search').toBeGreaterThan(0);
  for (const btn of groupButtons) {
    const name = btn.querySelector('.label')?.textContent;
    // Each group is judged on its own: nothing left over from the last one.
    expect(rowOnScreen(), `row still on screen before opening ${name}`).toBe(false);
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded'), `${name} did not open`).toBe('true');
    if (rowOnScreen()) found.push(name);
    fireEvent.click(btn);   // close again
  }
  return found;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('where the row lives', () => {
  it('is in the HR group only, so the page resolves to the HR section', () => {
    const groups = NAV_ITEMS.filter(g => (g.submenu || []).some(s => s.page === 'EmployeeReports'));
    expect(groups.map(g => g.name)).toEqual(['HR']);
    expect(getSectionForPage('EmployeeReports')).toBe('HR');
  });
});

describe('menu visibility', () => {
  describe('1. HR access without employee-list access', () => {
    it.each(['hr_exec', 'hr_manager', 'payroll_admin', 'zz_custom_hr_viewer'])('%s sees the row under HR', (role) => {
      expect(groupsShowingRow(role)).toEqual(['HR']);
    });
  });

  describe('2. HR plus employee-list access', () => {
    it('hr sees the row under HR, and nowhere else', () => {
      expect(groupsShowingRow('hr')).toEqual(['HR']);
    });
  });

  describe('3. Employee-list access without HR access', () => {
    it.each(['manager', 'department_head', 'employee', 'zz_custom_emp_viewer'])('%s does not see the row', (role) => {
      expect(groupsShowingRow(role)).toEqual([]);
    });
  });

  describe('4. Neither permission', () => {
    it('sales_exec does not see the row', () => {
      expect(groupsShowingRow('sales_exec')).toEqual([]);
    });
  });
});
