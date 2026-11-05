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

describe('one entry point', () => {
  it('exactly one menu row opens the portal, and none opens its tabs as pages', () => {
    const rows = NAV_ITEMS.flatMap(g => [g, ...(g.submenu || [])]).filter(r => !r.separator);
    expect(rows.filter(r => r.page === 'EmployeeSelfService').map(r => r.name)).toEqual(['Self Service']);
    for (const name of ['IT Declaration', 'Reimbursements', 'Profile Update']) {
      expect(rows.some(r => r.name === name), name).toBe(false);
    }
    // e-Signatures has a row with the same label for a DIFFERENT feature (the
    // company document register, DocumentMaster) — not a second way into the
    // employee's vault. Recorded so a rename or a real duplicate shows up here.
    expect(rows.filter(r => r.name === 'Document Vault').map(r => r.page)).toEqual(['DocumentMaster']);
  });
});

describe('who sees the Self Service row', () => {
  it.each(['employee', 'manager', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'admin', 'super_admin'])(
    'a linked %s sees it under HR', (role) => {
      expect(hrRows(role, 7)).toContain('Self Service');
    }, 15000);

  it.each(['super_admin', 'admin', 'hr_manager'])('a %s login with no employee link does not', (role) => {
    const rows = hrRows(role, null);
    expect(rows).not.toContain('Self Service');
    // only that row goes — the HR management rows stay
    expect(rows).toContain('Payroll Center');
  }, 15000);

  it('a manager sees only their own pages in HR — never the HR management rows', () => {
    expect(hrRows('manager', 7).sort()).toEqual(['My Dashboard', 'Self Service']);
  });
});
