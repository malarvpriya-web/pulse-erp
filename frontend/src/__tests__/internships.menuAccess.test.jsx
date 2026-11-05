/**
 * Internships — menu placement and visibility through the REAL Sidebar.
 *
 * Internships is a row inside the HR menu (not a top-level People item). The HR
 * section is also held by payroll_admin, manager and employee, none of whom hold
 * internships:view, so the row carries its own `module` and Sidebar drops it for
 * them. Grants mirror the live role_permissions rows (2026-10-13): internships
 * view for super_admin, admin, hr, hr_manager, hr_exec only.
 * The direct-URL half is internships.routeAccess.test.jsx.
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
import { getSectionForPage, ROLE_SECTION_ALLOWLIST } from '@/config/menuCatalog';

const ROW = 'Internships';
const GRANTS = {
  admin:         [],                       // admin is not permission-driven
  // payroll:view: the PC-01 matrix (Payroll Center row is module 'payroll').
  hr:            ['hr:view', 'employees:view', 'internships:view', 'payroll:view'],
  hr_manager:    ['hr:view', 'internships:view', 'payroll:view'],
  hr_exec:       ['hr:view', 'internships:view'],
  payroll_admin: ['hr:view', 'payroll:view'],
  manager:       ['employees:view'],
  employee:      ['employees:view'],
  sales_exec:    [],
};

const rowOnScreen = () =>
  [...document.body.querySelectorAll('*')].some(el => el.textContent.trim() === ROW);

/** Render the rail, open every group, and report which groups show the row. */
function groupsShowingRow(role) {
  auth.roles = [role];
  auth.grants = new Set(GRANTS[role]);
  const { container } = render(<MemoryRouter><Sidebar /></MemoryRouter>);
  const topLevel = [...container.querySelectorAll('.nav-item .label')].map(l => l.textContent);
  expect(topLevel, `${role}: Internships must not be a top-level item`).not.toContain(ROW);
  const found = [];
  for (const btn of [...container.querySelectorAll('.nav-item[aria-expanded]')]) {
    const name = btn.querySelector('.label')?.textContent;
    expect(rowOnScreen(), `row still on screen before opening ${name}`).toBe(false);
    fireEvent.click(btn);
    if (rowOnScreen()) found.push(name);
    fireEvent.click(btn);
  }
  return found;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('where Internships lives', () => {
  it('is a row of the HR menu only — no People/top-level duplicate', () => {
    expect(NAV_ITEMS.filter(g => g.page === 'Internships' || g.name === 'Internships')).toEqual([]);
    const groups = NAV_ITEMS.filter(g => (g.submenu || []).some(s => s.page === 'Internships'));
    expect(groups.map(g => g.name)).toEqual(['HR']);
    expect(getSectionForPage('Internships')).toBe('HR');
    const row = groups[0].submenu.find(s => s.page === 'Internships');
    expect(row).toMatchObject({ name: 'Internships', module: 'internships' });
  });

  it('is no longer a section of its own in any role allowlist', () => {
    for (const [role, sections] of Object.entries(ROLE_SECTION_ALLOWLIST)) {
      expect(sections, role).not.toContain('Internships');
    }
  });
});

describe('menu visibility', () => {
  // 15s: renders the whole rail and opens every group (admin sees them all).
  // ~0.4s alone, but it has blown the 5s default under 4-worker contention.
  it.each(['admin', 'hr', 'hr_manager', 'hr_exec'])('%s sees Internships under HR', (role) => {
    expect(groupsShowingRow(role)).toEqual(['HR']);
  }, 15000);

  it.each(['payroll_admin', 'manager', 'employee', 'sales_exec'])('%s does not see it', (role) => {
    expect(groupsShowingRow(role)).toEqual([]);
  });

  it('payroll_admin still sees the rest of the HR menu (only the Internships row is dropped)', () => {
    auth.roles = ['payroll_admin'];
    auth.grants = new Set(GRANTS.payroll_admin);
    const { container } = render(<MemoryRouter><Sidebar /></MemoryRouter>);
    const hr = [...container.querySelectorAll('.nav-item[aria-expanded]')]
      .find(b => b.querySelector('.label')?.textContent === 'HR');
    expect(hr, 'payroll_admin keeps the HR menu').toBeTruthy();
    fireEvent.click(hr);
    const text = document.body.textContent;
    expect(text).toContain('Payroll Center');
    expect(text).toContain('Workforce Analytics & Reports');
    expect(rowOnScreen()).toBe(false);
  });
});
