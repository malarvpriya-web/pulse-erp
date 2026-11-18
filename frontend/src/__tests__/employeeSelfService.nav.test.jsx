/**
 * Employee Self-Service — one menu row, drawn only for a login that IS an
 * employee, through the REAL Sidebar.
 *
 * The portal (Dashboard · IT Declaration · Document Vault · Reimbursements ·
 * Profile Update, all tabs of one page) has exactly one row: HR → Self Service.
 * It is the signed-in person's own records, so a login with no linked employee
 * (a system administrator) is not shown it, whatever its role. Manager was
 * refused the page outright before 2026-10-29 (MANAGER_HR_SCOPED_PAGES held
 * only My Dashboard). The direct-URL half is employeeSelfService.routeAccess.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = vi.hoisted(() => ({ roles: ['employee'], grants: new Set(), employeeId: 7 }));
vi.mock('@/services/api/client', () => ({ default: { get: vi.fn(async () => ({ data: [] })) } }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, employee_id: auth.employeeId },
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

const GRANTS = {
  super_admin: [], admin: [],
  // payroll:view: the PC-01 matrix (Payroll Center row is module 'payroll').
  hr: ['hr:view', 'employees:view', 'payroll:view'], hr_manager: ['hr:view', 'payroll:view'], hr_exec: ['hr:view'],
  payroll_admin: ['hr:view', 'payroll:view'], manager: ['employees:view'], employee: ['employees:view'],
};

/** Open the HR menu and return the names of its rows ([] if no HR menu). */
function hrRows(role, employeeId) {
  document.body.innerHTML = '';
  auth.roles = [role];
  auth.grants = new Set(GRANTS[role]);
  auth.employeeId = employeeId;
  const { container } = render(<MemoryRouter><Sidebar /></MemoryRouter>);
  const hr = [...container.querySelectorAll('.nav-item[aria-expanded]')]
    .find(b => b.querySelector('.label')?.textContent === 'HR');
  if (!hr) return [];
  fireEvent.click(hr);
  return [...document.body.querySelectorAll('.submenu-panel button.nav-item')].map(b => b.textContent.trim());
}

beforeEach(() => { document.body.innerHTML = ''; });

// 2026-11-11 (owner decision): the Employee Self-Service portal is removed.
// IT declarations are entered by Finance, documents and profile changes by HR,
// expense claims stay in Travel Desk → Expense Claims.
describe('no Self Service portal in the menu', () => {
  it('no row opens it, and none opens its old tabs as pages', () => {
    const rows = NAV_ITEMS.flatMap(g => [g, ...(g.submenu || [])]).filter(r => !r.separator);
    expect(rows.filter(r => r.page === 'EmployeeSelfService')).toEqual([]);
    for (const name of ['Self Service', 'IT Declaration', 'Reimbursements', 'Profile Update']) {
      expect(rows.some(r => r.name === name), name).toBe(false);
    }
    // e-Signatures' "Document Vault" is the company document register, a
    // different feature — recorded so a rename or a real duplicate shows up.
    expect(rows.filter(r => r.name === 'Document Vault').map(r => r.page)).toEqual(['DocumentMaster']);
  });

  it.each(['employee', 'manager', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'admin', 'super_admin'])(
    'a linked %s does not see a Self Service row under HR', (role) => {
      expect(hrRows(role, 7)).not.toContain('Self Service');
    }, 15000);

  it('a manager sees only their own pages in HR — never the HR management rows', () => {
    expect(hrRows('manager', 7)).toEqual(['My Dashboard', 'My Details', 'My Gate Passes', 'My Learning']);
  });

  // My Details (2026-11-11): every employee reads their own record there.
  it.each(['manager', 'hr', 'hr_manager', 'payroll_admin'])('a linked %s sees My Details under HR', (role) => {
    expect(hrRows(role, 7)).toContain('My Details');
  }, 15000);
  // An employee-only login has no HR menu: My Dashboard and My Details are
  // top-level rows (owner, 2026-11-11) — see employeeMenu.trimmed.test.jsx.
  it('a linked employee has no HR menu (its rows are top-level)', () => {
    expect(hrRows('employee', 7)).toEqual([]);
  }, 15000);
  it('a login with no employee does not (nothing to show)', () => {
    expect(hrRows('hr_manager', null)).not.toContain('My Details');
  }, 15000);
});
