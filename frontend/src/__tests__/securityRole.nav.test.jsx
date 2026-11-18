import { describe, it, expect } from 'vitest';
import {
  ROLE_SECTION_ALLOWLIST, SECURITY_HR_SCOPED_PAGES, canSecurityAccessPage, canRoleOpenPage, canRoleAccessPageBySection,
} from '@/config/menuCatalog';
import { ROLE_CATALOG_FALLBACK } from '@/config/roleCatalog';

// Security / Gate Desk (§273, migration 20261112000004): the gate register and
// visitor approvals — nothing else of HR.
describe('the security role', () => {
  it('is in the role catalogue', () => {
    expect(ROLE_CATALOG_FALLBACK.find((r) => r.code === 'security')?.label).toBe('Security / Gate Desk');
  });

  it('holds Home, Approvals and HR (scoped) — no Finance, Payroll or Inventory', () => {
    expect(ROLE_SECTION_ALLOWLIST.security).toEqual(expect.arrayContaining(['Home', 'Approvals', 'HR']));
    for (const s of ['Finance', 'Inventory', 'Procurement', 'Employees', 'Attendance']) {
      expect(ROLE_SECTION_ALLOWLIST.security).not.toContain(s);
    }
  });

  it('opens the gate register and its own pages, not the rest of HR', () => {
    expect([...SECURITY_HR_SCOPED_PAGES].sort()).toEqual(['EmployeeDashboard', 'GatePassVisitors', 'MyEmployeeRecord', 'MyGatePasses']);
    expect(canSecurityAccessPage('GatePassVisitors')).toBe(true);
    for (const page of ['PayrollCenter', 'Probation', 'ExitCenter', 'EmployeeRecords', 'DepartmentHeads', 'SuccessionCenter']) {
      expect(canSecurityAccessPage(page), page).toBe(false);
      expect(canRoleOpenPage('security', page), page).toBe(false);
    }
    expect(canRoleOpenPage('security', 'GatePassVisitors')).toBe(true);
    expect(canRoleAccessPageBySection('security', 'ApprovalCenter')).toBe(true);
  });
});
