/**
 * HR → Employee Records (§207): Employee Documents is HR's register across
 * employees, so it follows employee_documents — tab AND direct URL. Everyone's
 * own documents are Self Service → Document Vault. Assets, Policies and HR
 * Documents (company forms) are unchanged.
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
vi.mock('@/features/hr/pages/EmployeeDocuments', () => ({ default: () => null }));
vi.mock('@/features/hr/pages/EmployeeAssets', () => ({ default: () => null }));
vi.mock('@/features/hr/pages/Policies', () => ({ default: () => null }));
vi.mock('@/features/hr/pages/Downloads', () => ({ default: () => null }));

import EmployeeRecords from '@/features/hr/pages/EmployeeRecords';
import { ROUTES } from '@/config/routes';
import { canRenderPage, EMPLOYEE_SELF_SERVICE_PAGES } from '@/config/menuCatalog';

// As seeded by migration 20261029000001 (employee_documents) plus each role's hr grant.
const GRANTS = {
  hr_manager:    ['hr:view', 'employee_documents:view', 'employee_documents:add', 'employee_documents:edit'],
  hr_exec:       ['hr:view', 'employee_documents:view', 'employee_documents:add'],
  payroll_admin: ['hr:view'],
  employee:      ['self_service:view'],
};

const tabs = () => screen.queryAllByRole('tab').map(t => t.textContent.trim());

beforeEach(() => { env.role = 'employee'; env.grants = new Set(); });

describe('Employee Documents follows employee_documents', () => {
  it.each(['hr_manager', 'hr_exec'])('%s sees the register tab and may open the URL', (role) => {
    env.role = role; env.grants = new Set(GRANTS[role]);
    render(<MemoryRouter><EmployeeRecords /></MemoryRouter>);
    expect(tabs()).toContain('Employee Documents');
    expect(canRenderPage(role, 'EmployeeDocuments', { route: ROUTES.EmployeeDocuments, hasPermission: (m, a) => env.grants.has(`${m}:${a}`) })).toBe(true);
  });

  it.each(['payroll_admin', 'employee'])('%s gets no register tab and the URL is refused; HR Documents stays', (role) => {
    env.role = role; env.grants = new Set(GRANTS[role]);
    render(<MemoryRouter><EmployeeRecords /></MemoryRouter>);
    expect(tabs()).not.toContain('Employee Documents');
    expect(tabs()).toContain('HR Documents');
    expect(tabs()).toContain('Policies');
    expect(canRenderPage(role, 'EmployeeDocuments', { route: ROUTES.EmployeeDocuments, hasPermission: (m, a) => env.grants.has(`${m}:${a}`) })).toBe(false);
  });

  it('the route carries the gate; admins pass it', () => {
    expect(ROUTES.EmployeeDocuments.module).toBe('employee_documents');
    expect(canRenderPage('admin', 'EmployeeDocuments', { route: ROUTES.EmployeeDocuments, hasPermission: () => false })).toBe(true);
    expect(EMPLOYEE_SELF_SERVICE_PAGES.has('EmployeeDocuments')).toBe(false);
    expect(EMPLOYEE_SELF_SERVICE_PAGES.has('EmployeeSelfService')).toBe(true);
  });

  it('the Workforce Analytics link to the register asks for the same grant', async () => {
    const { REPORT_LINKS } = await import('@/features/hr/pages/EmployeeReports');
    expect(REPORT_LINKS.find(l => l.page === 'EmployeeDocuments').module).toBe('employee_documents');
  });
});
