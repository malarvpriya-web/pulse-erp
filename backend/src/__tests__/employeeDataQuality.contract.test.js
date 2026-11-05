/**
 * employeeDataQuality.contract.test.js — the "Needs attention" tile and the
 * list it opens must count the same records.
 *
 * The tile's number comes from SQL in `getEmployeeAnalytics`. The list it
 * drills into is filtered in the browser by `MISSING_FIELD_TESTS` in
 * `frontend/src/features/employees/employeeListFilter.js`. Two
 * implementations of one definition: click a tile reading 2 and land on a
 * list of 5, and the dashboard has lied about something it was added to
 * police.
 *
 * ⚠ The frontend module is READ and evaluated, never `import`ed.
 * `check-module-graph.mjs` copies backend/ into a sandbox and asserts every
 * relative import resolves there; a static `../../../frontend/src/...`
 * specifier escapes that root and fails the guard — correctly, because it is
 * not a dependency the server may have at boot. Reading the file at test time
 * keeps one source of truth without creating that edge.
 *
 * The module has no imports of its own and touches `sessionStorage` only
 * inside function bodies we never call here, so it evaluates cleanly in node.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { getEmployeeAnalytics } = await import('../employees/employee.service.js');
const { bucketOf } = await import('../shared/employeeStatus.js');

/** Evaluate the real frontend module without becoming an import of it. */
function loadFrontendFilterModule() {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, '../../../frontend/src/features/employees/employeeListFilter.js');
  const src = readFileSync(file, 'utf8');
  if (/^\s*import\s/m.test(src)) {
    throw new Error('employeeListFilter.js grew an import — parse it instead of evaluating it.');
  }
  const body = src
    .replace(/^export default[\s\S]*?};\s*$/m, '')
    .replace(/\bexport\s+(const|function)\b/g, '$1');
   
  return new Function(`${body}\nreturn { MISSING_FIELD_TESTS, CRITICAL_MISSING, hasMissingField };`)();
}

const { MISSING_FIELD_TESTS, CRITICAL_MISSING, hasMissingField } = loadFrontendFilterModule();

const COMPANY_ID = 1;

describe('employee data quality', () => {
  let dq;
  let current;

  beforeAll(async () => {
    const analytics = await getEmployeeAnalytics({ period: 'fytd', company_id: COMPANY_ID });
    dq = analytics.dataQuality;

    // The same population the tile counts: current staff, not soft-deleted.
    const { rows } = await pool.query(
      `SELECT id, status, joining_date, probation_end_date, department, designation, skill_type,
              account_number, ifsc_code, current_address
         FROM employees
        WHERE deleted_at IS NULL AND company_id = $1`,
      [COMPANY_ID],
    );
    current = rows.filter(r => bucketOf(r.status) !== 'Exited');
  }, 30000);

  it('the two implementations agree field by field', () => {
    const count = (fn) => current.filter(fn).length;
    expect(count(MISSING_FIELD_TESTS.joining_date)).toBe(dq.missingJoiningDate);
    expect(count(MISSING_FIELD_TESTS.department)).toBe(dq.missingDepartment);
    expect(count(MISSING_FIELD_TESTS.designation)).toBe(dq.missingDesignation);
    expect(count(MISSING_FIELD_TESTS.skill_type)).toBe(dq.missingSkillType);
    expect(count(MISSING_FIELD_TESTS.probation_end)).toBe(dq.missingProbationEnd);
    expect(count(MISSING_FIELD_TESTS.bank_details)).toBe(dq.missingBankDetails);
    expect(count(MISSING_FIELD_TESTS.address)).toBe(dq.missingAddress);
  });

  it('the critical count matches what the drill-down will show', () => {
    // This is the number on the tile, and the number of rows the list renders.
    expect(current.filter(e => hasMissingField(e, 'critical')).length).toBe(dq.critical);
  });

  it('the any-gap count matches what the drill-down will show', () => {
    expect(current.filter(e => hasMissingField(e, 'any')).length).toBe(dq.recordsNeedingAttention);
  });

  it('critical is a subset of all records needing attention', () => {
    expect(dq.critical).toBeLessThanOrEqual(dq.recordsNeedingAttention);
    expect(dq.incomplete).toBeLessThanOrEqual(dq.recordsNeedingAttention);
  });

  it('a record can be missing several things without being counted twice', () => {
    // recordsNeedingAttention counts RECORDS, not gaps, so it can be smaller
    // than the sum of the per-field counts and never larger.
    const fieldSum = dq.missingJoiningDate + dq.missingDepartment + dq.missingDesignation
                   + dq.missingSkillType + dq.missingProbationEnd + dq.missingBankDetails + dq.missingAddress;
    expect(dq.recordsNeedingAttention).toBeLessThanOrEqual(fieldSum);
    expect(dq.recordsNeedingAttention).toBeLessThanOrEqual(current.length);
  });

  it('probation_end only counts employees actually on probation', () => {
    // An Active employee with no probation_end_date is not a gap — there is
    // nothing to confirm. Counting them would make the tile permanently red.
    const active = current.filter(e => bucketOf(e.status) === 'Active' && !e.probation_end_date);
    expect(active.every(e => !MISSING_FIELD_TESTS.probation_end(e))).toBe(true);
    expect(CRITICAL_MISSING).toContain('probation_end');
  });

  it('a whitespace-only value counts as missing on both sides', () => {
    // The SQL uses NULLIF(TRIM(col), ''); the JS must too, or "   " is a gap
    // on one surface and a value on the other.
    expect(MISSING_FIELD_TESTS.department({ department: '   ' })).toBe(true);
    expect(MISSING_FIELD_TESTS.designation({ designation: '' })).toBe(true);
    expect(MISSING_FIELD_TESTS.skill_type({ skill_type: null })).toBe(true);
    expect(MISSING_FIELD_TESTS.department({ department: 'HR' })).toBe(false);
  });
});
