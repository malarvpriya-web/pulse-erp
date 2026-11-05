/**
 * addEmployeeMasterData.contract.test.js — the Add Employee master-data and
 * tenant contract (2026-09-29).
 *
 * WHAT THIS PINS, AND WHY EACH ONE
 * --------------------------------
 * 1. LOCATION is `branches`, not a new master and not free text. The table,
 *    the company_id on it and the `employees.branch_id` FK all already
 *    existed; nothing had ever written the FK (NULL on all 46 live rows)
 *    because the only Location control was a text box writing the `location`
 *    VARCHAR beside it — which is why that column holds 'Srivil', 'Srivi' and
 *    'czxzx'.
 *
 * 2. BANK is the `BANK` vocabulary in master_values, registered in
 *    modules/master/vocabularies.js. Open, not closed: `+ Add new…` is the
 *    "Other" path, so a co-operative bank the RBI seed does not carry is one
 *    click rather than a rejected save.
 *
 * 3. TENANT ISOLATION on every id the Add Employee form can send. The form
 *    posts four references — reporting_manager_id, branch_id, and (via
 *    POST /employee-assets) employee_id plus asset_type. Three of the four
 *    were unverified.
 *
 * 4. The EMPLOYEE ID format, which an earlier pass got backwards. The live
 *    rows are `EMP001`…`EMP039` with NO hyphen, and live data that predates
 *    the code is the spec. See shared/employeeCode.js.
 *
 * ⚠ These are contract tests over the SOURCE, not integration tests against a
 * live server. `employeeTenantScope.integration.test.js` drives the database.
 * Running both against the same DB while a Playwright crawl is going is what
 * turns a green suite into "8 files failed, 200 skipped".
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_ON_CREATE } from '../employees/employee.service.js';
import { REGISTRY, BY_KEY, writeRoles } from '../modules/master/vocabularies.js';
import { CODE_RE, formatEmployeeCode, codeSeq } from '../shared/employeeCode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

const SERVICE  = src('employees/employee.service.js');
const MASTER   = src('modules/master/master.routes.js');
const BRANCHES = src('modules/admin/branchManagement.routes.js');
const ASSETS   = src('modules/hr/employee-assets.routes.js');

// ─────────────────────────────────────────────────────────────────────────────
describe('required fields — front and back say the same thing', () => {
  it('lists exactly the fields the Add Employee form marks with an asterisk', () => {
    // The form's own guard checks first name, last name, company email,
    // department, designation, status and joining date. First name and company
    // email are checked by their own earlier throw in addEmployee(), so they
    // are legitimately absent from this list; the other five must be here.
    const keys = REQUIRED_ON_CREATE.map(([k]) => k);
    expect(keys).toEqual(expect.arrayContaining([
      'last_name', 'department', 'designation', 'status', 'joining_date',
    ]));
  });

  it('every entry carries a human label, because the 400 quotes it', () => {
    for (const [key, label] of REQUIRED_ON_CREATE) {
      expect(typeof label, key).toBe('string');
      expect(label, key).not.toBe(key);
    }
  });

  it('first name and company email are still rejected when blank', () => {
    // They are guarded by a separate throw above the REQUIRED_ON_CREATE loop.
    // Asserted so that moving one list does not silently drop the other.
    expect(SERVICE).toMatch(/if \(!first_name \|\| !company_email\)/);
  });

  it('does NOT require location or manager', () => {
    // The brief said not to invent mandatory fields. `branch_id` is NULL on
    // every live row and `reporting_manager_id` is NULL on most — requiring
    // either would make the form refuse to save the records the business
    // already keeps.
    const keys = REQUIRED_ON_CREATE.map(([k]) => k);
    expect(keys).not.toContain('branch_id');
    expect(keys).not.toContain('location');
    expect(keys).not.toContain('reporting_manager_id');
    expect(keys).not.toContain('bank_name');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('employee ID — the canonical EMP001 format', () => {
  it('accepts the live shape and rejects every hyphenated one', () => {
    // The live register is EMP001..EMP039. An earlier pass read the dashed
    // form out of three peripheral code paths, concluded that was the
    // convention, and backfilled 35 rows as EMP-0013..EMP-0036. Two of those
    // three code paths had no callers at all.
    for (const good of ['EMP001', 'EMP012', 'EMP039', 'EMP100', 'EMP1000']) {
      expect(CODE_RE.test(good), good).toBe(true);
    }
    for (const bad of ['EMP-0001', 'EMP-001', 'EMP01', 'EMP1', 'emp001', 'E001']) {
      expect(CODE_RE.test(bad), bad).toBe(false);
    }
  });

  it('pads to three digits and does not cap at 999', () => {
    expect(formatEmployeeCode(1)).toBe('EMP001');
    expect(formatEmployeeCode(39)).toBe('EMP039');
    expect(formatEmployeeCode(1000)).toBe('EMP1000');
  });

  it('reads a suffix without slicing at a fixed offset', () => {
    // `parseInt('EMP-0002'.substring(3))` is -2, and the old generator then
    // produced 'EMP0-1' — a string that is not a code at all.
    expect(codeSeq('EMP039')).toBe(39);
    expect(codeSeq('EMP-0002')).toBe(2);
    expect(codeSeq(null)).toBeNull();
  });

  it('is minted under a company-scoped advisory lock inside the transaction', () => {
    // MAX()+1 is check-then-act. Two simultaneous hires read the same max and
    // mint the same code without this.
    const code = src('shared/employeeCode.js');
    expect(code).toMatch(/pg_advisory_xact_lock/);
    expect(code).toMatch(/company_id = \$1/);
    // And the unique index underneath, because a lock only holds in one process.
    expect(SERVICE).toMatch(/assertCodeAvailable/);
  });

  it('the frontend never invents one', () => {
    const form = fs.readFileSync(
      path.join(HERE, '../../../frontend/src/features/employees/pages/AddEmployee.jsx'),
      'utf8',
    );
    // It may READ a preview from /employees/next-code; it must not build one.
    expect(form).toMatch(/employees\/next-code/);
    expect(form).not.toMatch(/padStart\(\s*[34]\s*,\s*['"]0['"]\s*\)/);
    expect(form).not.toMatch(/['"`]EMP-/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('LOCATION — the branch master', () => {
  it('resolves and tenant-checks branch_id before writing it', () => {
    expect(SERVICE).toMatch(/export async function assertValidBranch/);
    // The check that makes it a tenant boundary rather than an existence test.
    expect(SERVICE).toMatch(/FROM branches[\s\S]{0,200}company_id = \$2/);
    expect(SERVICE).toMatch(/assertValidBranch\(client, branch_id, company_id/);
  });

  it('derives the location TEXT from the branch, never from the request', () => {
    // Otherwise branch_id and location can disagree, and the register's
    // Location column would show something the FK does not.
    expect(SERVICE).toMatch(/resolvedBranch \? resolvedBranch\.name : \(location \|\| ""\)/);
  });

  it('GET /branches is scoped to the caller, not to a query parameter', () => {
    expect(BRANCHES).toMatch(/import \{ companyOf \}/);
    expect(BRANCHES).toMatch(/const scopeBranches/);
    // The exact hole: company_id was read off req.query and used as the filter.
    expect(BRANCHES).not.toMatch(/const \{ company_id, is_active \} = req\.query/);
    expect(BRANCHES).not.toMatch(/params\.push\(parseInt\(company_id\)\)/);
  });

  it('the deleted_at fallback keeps the tenant filter', () => {
    // It used to re-run the query with no WHERE clause at all, so ANY error
    // turned the endpoint into an unscoped dump.
    const fallback = BRANCHES.slice(BRANCHES.indexOf('may not have deleted_at'));
    expect(fallback).toMatch(/WHERE TRUE\$\{scoped\.where\}/);
  });

  it('HR can read it — the roles that may create an employee', () => {
    // A Location picker that 403s for the role the page exists for is not a
    // picker. `hr` and `payroll_admin` were both missing.
    const roles = BRANCHES.slice(BRANCHES.indexOf('const READ_ROLES'), BRANCHES.indexOf('const scopeBranches'));
    for (const r of ['hr', 'hr_manager', 'hr_exec', 'payroll_admin']) {
      expect(roles, r).toContain(`'${r}'`);
    }
  });

  it('is NOT re-modelled as a master_values vocabulary', () => {
    // A branch is an entity with an address and a phone number that other
    // modules join to, not a word in a list. Two sources of truth for the
    // same office is the failure vocabularies.js exists to prevent.
    expect(REGISTRY.map(v => v.key)).not.toContain('locations');
    expect(REGISTRY.map(v => v.key)).not.toContain('work-locations');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('BANK NAME — the BANK vocabulary', () => {
  const bank = BY_KEY.banks;

  it('is registered, and bound to the column it actually fills', () => {
    expect(bank).toBeTruthy();
    expect(bank.type).toBe('BANK');
    expect(bank.columns).toContain('employees.bank_name');
  });

  it('is writable by the roles that fill the form in', () => {
    // MasterSelect hides "+ Add new…" for anyone outside this list, so getting
    // it wrong offers the option to someone whose POST comes back 403.
    const allowed = writeRoles(bank);
    for (const r of ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin']) {
      expect(allowed, r).toContain(r);
    }
  });

  it('is NOT enforced as a closed list on save', () => {
    // Deliberate. Banks merge and co-operative banks are legitimate salary
    // accounts, and four live rows already hold free text that a hard reject
    // would make un-editable. The master standardises what is OFFERED; the
    // "+ Add new…" path handles the rest.
    expect(SERVICE).not.toMatch(/validateMasterValue\(\s*bank_name/);
  });

  it('does not duplicate an existing bank table', () => {
    // bank_accounts / vendor_bank_details hold ACCOUNTS, not a vocabulary of
    // bank names. Binding an employee's bank to either would be the
    // unrelated-duplicate trap.
    expect(bank.columns.every(c => !c.startsWith('bank_accounts.'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('master-data reads and writes are tenant-scoped', () => {
  it('the employees-derived fallback is scoped on the READ side', () => {
    expect(MASTER).toMatch(/export async function employeeDerivedValues/);
    expect(MASTER).toMatch(/company_id = \$1/);
    // The exact former statement, which had no predicate at all.
    expect(MASTER).not.toMatch(
      /SELECT DISTINCT \$\{empCol\} AS name FROM employees\s*\n\s*WHERE \$\{empCol\} IS NOT NULL AND TRIM\(\$\{empCol\}\) <> ''\s*\n\s*ORDER BY/,
    );
  });

  it('…and on the WRITE side, so validator and picker agree', () => {
    // A validator wider than its own dropdown is how a value the picker would
    // never offer still saves.
    expect(SERVICE).toMatch(/async function validateMasterValue\(value, table, companyId = null\)/);
    expect(SERVICE).toMatch(/FROM employees\s*\n\s*WHERE LOWER\(TRIM\(COALESCE\(\$\{empCol\},''\)\)\) = \$1[\s\S]{0,160}company_id = \$2/);
  });

  it('every validateMasterValue call passes the company', () => {
    // An omitted third argument defaults to null, which means "no company" —
    // safe — but a caller that MEANT to pass one and didn't is the bug.
    const calls = SERVICE.match(/validateMasterValue\([^)]*\)/g) || [];
    // Exclude the declaration itself: the regex above matches it too, and its
    // parameter list reads `(value, table, companyId = null)`.
    const invocations = calls.filter(c => !c.includes('value, table'));
    expect(invocations.length).toBeGreaterThanOrEqual(8);
    for (const c of invocations) {
      expect(c, c).toMatch(/company_id \?\? null/);
    }
  });

  it('GET /master/:type is role-gated', () => {
    // It was the only read in the file with no allowRoles, and it is the one
    // that returns the company's department and job-title vocabulary.
    const line = MASTER.match(/router\.get\('\/:type',[^\n]*/)[0];
    expect(line).toContain('allowRoles(...READ_ROLES)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cross-tenant references the Add Employee form can send', () => {
  it('reporting manager must be in the same company', () => {
    expect(SERVICE).toMatch(/assertValidManager\(client, \{[\s\S]{0,200}companyId: company_id/);
  });

  it('asset allocation verifies the employee belongs to the caller', () => {
    // employee_id came off the body and went into the INSERT unverified, while
    // company_id was stamped from the caller's scope — so the row claimed one
    // tenant and pointed at a person in another.
    expect(ASSETS).toMatch(/import \{ companyOf \}/);
    expect(ASSETS).toMatch(/SELECT id FROM employees[\s\S]{0,160}company_id = \$2/);
    expect(ASSETS).toMatch(/Employee not found in this company/);
  });

  it('asset type must come from the ASSET_TYPE master', () => {
    expect(ASSETS).toMatch(/type = 'ASSET_TYPE'/);
    expect(ASSETS).toMatch(/is not a valid asset type/);
  });

  it('asset type accepts the shared seed AND the tenant\'s own additions', () => {
    // company_id IS NULL is the shared seed; = $1 is this tenant's. Dropping
    // either half breaks a real case.
    expect(ASSETS).toMatch(/company_id IS NULL OR company_id = \$1/);
  });

  it('the asset-type master being empty does not block allocation', () => {
    // Same rule validateMasterValue uses for department: an unseeded master
    // must not stop every write.
    expect(ASSETS).toMatch(/if \(seeded\.length\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('duplicate company email', () => {
  it('is rejected with a 409 that names the holder', () => {
    expect(SERVICE).toMatch(/already belongs to employee/);
    expect(SERVICE).toMatch(/badRequest\(`\$\{company_email\} already belongs to employee \$\{held\}\.`, 409\)/);
  });

  it('is scoped per company, because two tenants may both employ an address', () => {
    expect(SERVICE).toMatch(/LOWER\(company_email\) = LOWER\(\$1\)[\s\S]{0,120}company_id = \$2/);
  });
});
