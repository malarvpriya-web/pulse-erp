/**
 * HR → Employee Records. The Employee Documents register was REMOVED on
 * 11 Nov 26 (owner): an employee's documents are collected on Add Employee and
 * uploaded by HR only. The old /EmployeeDocuments URL redirects to the hub and
 * keeps its employee_documents gate. Assets, Policies and HR Documents stay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const env = vi.hoisted(() => ({ role: 'employee', grants: new Set() }));
vi.mock('@/services/api/client', () => ({ default: { get: vi.fn(async () => ({ data: [] })) } }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    role: env.role,
    roles: [env.role],
    hasAnyRole: (...r) => r.includes(env.role),
    hasPermission: (m, a) => env.grants.has(`${m}:${a}`),
    menuAccess: () => null,
  }),
}));
// The tab bodies are not under test here, only which tabs are drawn.
vi.mock('@/features/hr/pages/EmployeeAssets', () => ({ default: () => null }));
vi.mock('@/features/hr/pages/Policies', () => ({ default: () => null }));
vi.mock('@/features/hr/pages/Downloads', () => ({ default: () => null }));

import EmployeeRecords from '@/features/hr/pages/EmployeeRecords';
import { ROUTES } from '@/config/routes';
import { canRenderPage, EMPLOYEE_SELF_SERVICE_PAGES } from '@/config/menuCatalog';

const GRANTS = {
  hr_manager:    ['hr:view', 'employee_documents:view', 'employee_documents:add', 'employee_documents:edit'],
  payroll_admin: ['hr:view'],
  employee:      ['self_service:view'],
};

const tabs = () => screen.queryAllByRole('tab').map(t => t.textContent.trim());

beforeEach(() => { env.role = 'employee'; env.grants = new Set(); });

describe('Employee Records without the Employee Documents register', () => {
  it.each(['hr_manager', 'payroll_admin'])('%s sees Assets, Policies and HR Documents — no register tab', (role) => {
    env.role = role; env.grants = new Set(GRANTS[role]);
    render(<MemoryRouter><EmployeeRecords /></MemoryRouter>);
    expect(tabs()).not.toContain('Employee Documents');
    expect(tabs()).toEqual(expect.arrayContaining(['Policies', 'HR Documents']));
  });

  it('employee gets no tab at all, and neither URL opens', () => {
    env.role = 'employee'; env.grants = new Set(GRANTS.employee);
    render(<MemoryRouter><EmployeeRecords /></MemoryRouter>);
    expect(tabs()).toEqual([]);
    expect(canRenderPage('employee', 'EmployeeDocuments', { route: ROUTES.EmployeeDocuments, hasPermission: () => false })).toBe(false);
    expect(EMPLOYEE_SELF_SERVICE_PAGES.has('EmployeeRecords')).toBe(false);
  });

  it('the old URL is a gated redirect, and no report links to it', async () => {
    expect(ROUTES.EmployeeDocuments.module).toBe('employee_documents');
    expect(EMPLOYEE_SELF_SERVICE_PAGES.has('EmployeeDocuments')).toBe(false);
    const { REPORT_LINKS } = await import('@/features/hr/pages/EmployeeReports');
    expect(REPORT_LINKS.some(l => l.page === 'EmployeeDocuments')).toBe(false);
  });
});
