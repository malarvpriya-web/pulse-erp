/**
 * The approved least-privilege policy (§202), pinned on the seed itself —
 * migration 20261029000001's GRANTS — so an edit that widens a grant has to
 * change this test too.
 */
import { describe, it, expect } from 'vitest';
import { GRANTS, MODULES, rowFor } from '../database/migrations/20261029000001_self_service_explicit_permissions.js';

const holders = (module, flag) => Object.keys(GRANTS).filter(r => (GRANTS[r][module] || '').includes(flag)).sort();

describe('self-service and HR-sensitive grants', () => {
  it('self_service is held by exactly the roles that hold the HR menu', () => {
    expect(holders('self_service', 'v')).toEqual(['admin', 'employee', 'hr', 'hr_exec', 'hr_manager', 'manager', 'payroll_admin', 'super_admin']);
  });

  it('identity documents: no payroll or finance role, hr_exec cannot delete', () => {
    expect(holders('employee_documents', 'v')).toEqual(['admin', 'hr', 'hr_exec', 'hr_manager', 'super_admin']);
    expect(holders('employee_documents', 'd')).toEqual(['admin', 'hr', 'hr_manager', 'super_admin']);
  });

  it('bank details: changed only by authorised HR (and admins)', () => {
    expect(holders('employee_bank', 'e')).toEqual(['admin', 'hr', 'hr_manager', 'super_admin']);
  });

  it('a colleague\'s IT declarations: no manager, no finance role', () => {
    expect(holders('it_declarations', 'v')).toEqual(['admin', 'hr_manager', 'payroll_admin', 'super_admin']);
  });

  it('claims: accounts verify, management approve, payment — three separate grants', () => {
    expect(holders('expense_claims', 'e')).toEqual(['accounts_exec', 'admin', 'finance', 'finance_manager', 'super_admin']);
    expect(holders('expense_claims', 'p')).toEqual(['admin', 'super_admin']);
    expect(holders('expense_payments', 'p')).toEqual(['admin', 'finance', 'finance_manager', 'super_admin']);
  });

  it('a role with no entry gets an explicit all-false row for every module', () => {
    for (const m of MODULES) {
      expect(Object.values(rowFor('sales_exec', m)).every(v => v === false)).toBe(true);
    }
    expect(rowFor('hr_exec', 'employee_documents')).toMatchObject({ can_view: true, can_edit: true, can_delete: false });
  });
});
