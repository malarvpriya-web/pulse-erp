/**
 * Employee Directory in the REAL Sidebar, and the menu structure behind it.
 *
 * One employee list per person (2026-10-20): the phonebook is a top-level row
 * beside Org Chart, shown only to the people who cannot open All Employees.
 * Its audience is exactly the six roles that held 'HR' when it was a row there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const env = vi.hoisted(() => ({ roles: ['employee'], grants: new Set() }));
vi.mock('@/services/api/client', () => ({ default: { get: vi.fn(async () => ({ data: {} })) } }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    roles: env.roles,
    role: env.roles[0],
    hasAnyRole: (...r) => r.some(x => env.roles.includes(x)),
    isEmployeeOnly: env.roles.length === 1 && env.roles[0] === 'employee',
    hasPermission: (m, a) => env.grants.has(`${m}:${a}`),
    menuAccess: () => null,
  }),
}));

import Sidebar from '@/components/Sidebar';
import { NAV_ITEMS, ROUTES } from '@/config/routes';
import {
  ROLE_SECTION_ALLOWLIST, getSectionForPage, canOpenEmployeeMaster, canRenderPage,
} from '@/config/menuCatalog';

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
// role → [sees 'Employees' menu, sees 'Employee Directory' row]
const EXPECTED = {
  super_admin:     [true,  false],
  admin:           [true,  false],
  hr:              [true,  false],
  manager:         [true,  false],
  department_head: [true,  false],
  employee:        [false, true],
  hr_manager:      [false, true],
  hr_exec:         [false, true],
  payroll_admin:   [false, true],
};

let n = 0;
async function railFor(role) {
  env.roles = [role]; env.grants = new Set(GRANTS[role]);
  localStorage.setItem('token', `zz-token-${(n += 1)}`);
  const view = render(<MemoryRouter><Sidebar /></MemoryRouter>);
  await waitFor(() => expect(view.container.querySelectorAll('.nav-item .label').length).toBeGreaterThan(0));
  return [...view.container.querySelectorAll('.nav-item .label')].map(l => l.textContent);
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('sidebar: one employee list per role', () => {
  it.each(Object.keys(EXPECTED))('%s', async (role) => {
    const [master, directory] = EXPECTED[role];
    const labels = await railFor(role);
    expect(labels.includes('Employees'), 'Employees menu').toBe(master);
    expect(labels.includes('Employee Directory'), 'Employee Directory row').toBe(directory);
    // Exactly one of the two, for every role.
    expect(master !== directory).toBe(true);
  });

  it.each(Object.keys(EXPECTED))('%s: the visible list is one the route gate actually opens', (role) => {
    const opts = { menuAccess: () => null, hasPermission: (m, a) => GRANTS[role].includes(`${m}:${a}`) };
    const [master] = EXPECTED[role];
    expect(canOpenEmployeeMaster(role, { ...opts, route: ROUTES.EmployeesData })).toBe(master);
    if (!master) {
      expect(canRenderPage(role, 'EmployeeDirectory', { ...opts, route: ROUTES.EmployeeDirectory })).toBe(true);
    }
  });
});

describe('menu structure', () => {
  const hr = NAV_ITEMS.find(g => g.name === 'HR');

  it('the HR menu no longer lists the phonebook', () => {
    expect(hr.submenu.some(s => s.page === 'EmployeeDirectory')).toBe(false);
  });

  it('the phonebook is its own top-level section, directly after Org Chart', () => {
    const items = NAV_ITEMS.filter(i => i && !i.divider);
    const at = items.findIndex(i => i.name === 'Org Chart');
    expect(items[at + 1]).toMatchObject({ name: 'Employee Directory', page: 'EmployeeDirectory' });
    expect(getSectionForPage('EmployeeDirectory')).toBe('Employee Directory');
  });

  it('its audience is exactly the roles that hold the HR section — none gained or lost', () => {
    const holders = (s) => Object.keys(ROLE_SECTION_ALLOWLIST).filter(r => ROLE_SECTION_ALLOWLIST[r].includes(s)).sort();
    expect(holders('Employee Directory')).toEqual(holders('HR'));
    expect(holders('Employee Directory')).toEqual(
      ['employee', 'hr', 'hr_exec', 'hr_manager', 'manager', 'payroll_admin']);
  });

  it('All Employees is still the Employees menu\'s master list, gated on employees:view', () => {
    const emp = NAV_ITEMS.find(g => g.name === 'Employees');
    expect(emp.submenu.find(s => s.page === 'EmployeesData')?.name).toBe('All Employees');
    expect(ROUTES.EmployeesData.module).toBe('employees');
  });

  it('Employee Records keeps its four tabs', async () => {
    const { TABS } = await import('@/features/hr/pages/EmployeeRecords');
    expect(TABS.map(t => t.page)).toEqual(['EmployeeDocuments', 'EmployeeAssets', 'Policies', 'Downloads']);
    expect(hr.submenu.some(s => s.page === 'EmployeeRecords')).toBe(true);
  });

  it('the HR Dashboard quick link that opens EmployeesData is labelled All Employees', () => {
    const src = readFileSync(resolve(__dirname, '../pages/HRDashboard.jsx'), 'utf8');
    // The Quick Actions entry (the KPI cards above it also open EmployeesData).
    const line = src.split('\n').find(l => l.includes("page:'EmployeesData'") && l.includes('hrOnly'));
    expect(line).toMatch(/label:'All Employees'/);
    expect(src).not.toMatch(/label:'Employee Records'/);
  });
});
