/**
 * "Incomplete" must mean one thing.
 *
 * Two definitions of it existed for the same employee row:
 *
 *   EmployeesData.jsx      REQUIRED_FIELDS  = Employee ID, Department, Role
 *   employeeListFilter.js  MISSING_FIELD_TESTS = joining date, department,
 *                          designation, skill_type, probation end
 *
 * Neither was wrong. Neither said which question it answered. And they gave
 * different counts for the same row, so the All Employees "Incomplete 26" badge
 * and the dashboard's "Records needing attention" tile could not be reconciled by
 * anyone looking at them.
 *
 * The page's definition is now `MANDATORY_FIELDS` in employeeListFilter.js, which
 * answers exactly one question: **would this row fail `POST /employees` today?**
 * That makes it derivable from the server's own rule rather than an independent
 * opinion — and this test is what keeps it derived. `REQUIRED_ON_CREATE` gaining
 * a field without the browser's copy gaining it fails here.
 *
 * `skill_type` is deliberately in neither list: it is not required to create an
 * employee. 27 live rows lack it as a seeding artefact, and folding that into the
 * page's badge would bury the records that actually block something. The
 * dashboard still counts it under its own, wider question.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_ON_CREATE } from '../employees/employee.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_FILE = path.resolve(
  here, '../../../frontend/src/features/employees/employeeListFilter.js',
);

/**
 * Evaluate the real browser module in node.
 *
 * ⚠ Read and evaluated, never `import`ed — a static `../../../frontend/src/...`
 * specifier escapes the sandbox root `check-module-graph.mjs` enforces, and
 * correctly so: the server must not depend on browser code at boot. Same pattern
 * as employeeDataQuality.contract.test.js.
 */
function loadFrontendModule() {
  const src = fs.readFileSync(FRONTEND_FILE, 'utf8');
  if (/^\s*import\s/m.test(src)) {
    throw new Error('employeeListFilter.js grew an import — parse it instead of evaluating it.');
  }
  const body = src
    .replace(/^export default[\s\S]*?};\s*$/m, '')
    .replace(/\bexport\s+(const|function)\b/g, '$1');
  return new Function(
    `${body}\nreturn { MANDATORY_FIELDS, missingMandatoryFields, MISSING_FIELD_TESTS };`,
  )();
}

const { MANDATORY_FIELDS, missingMandatoryFields, MISSING_FIELD_TESTS } = loadFrontendModule();

/** Server-generated, so it is mandatory on a record but never submitted. */
const SERVER_GENERATED = ['office_id'];

describe('mandatory employee fields', () => {
  it('the browser list is the server list plus the server-generated Employee ID', () => {
    const browser = MANDATORY_FIELDS.map(([k]) => k).sort();
    const server = [...REQUIRED_ON_CREATE.map(([k]) => k), ...SERVER_GENERATED].sort();
    expect(browser).toEqual(server);
  });

  it('every mandatory field has a human label for the badge', () => {
    for (const [key, label] of MANDATORY_FIELDS) {
      expect(typeof label, key).toBe('string');
      expect(label.length, key).toBeGreaterThan(1);
      // The badge prints these, so a raw column name would leak into the UI.
      expect(label, key).not.toBe(key);
    }
  });

  it('a complete row reports no gaps', () => {
    expect(missingMandatoryFields({
      office_id: 'EMP001', last_name: 'Kumar', department: 'IT', designation: 'Manager',
      status: 'Active', joining_date: '2026-01-01',
    })).toEqual([]);
  });

  it('names every gap on an empty row', () => {
    const gaps = missingMandatoryFields({});
    expect(gaps).toHaveLength(MANDATORY_FIELDS.length);
    expect(gaps).toContain('Employee ID');
    expect(gaps).toContain('Department');
    expect(gaps).toContain('Role');
    expect(gaps).toContain('Joining date');
    // Added to REQUIRED_ON_CREATE in the 2026-09-29 Add Employee pass: the
    // form had always required it and the API had not.
    expect(gaps).toContain('Last name');
  });

  it('treats the STRING "null" as missing, not as a value', () => {
    // The class of bug a truthiness check cannot catch: 'null' is truthy, so a
    // row whose department is the text 'null' would otherwise read as complete.
    expect(missingMandatoryFields({
      office_id: 'EMP001', last_name: 'Kumar', department: 'null', designation: 'undefined',
      status: 'Active', joining_date: '2026-01-01',
    })).toEqual(['Department', 'Role']);
  });

  it('treats whitespace-only and empty values as missing', () => {
    expect(missingMandatoryFields({
      office_id: '  ', last_name: 'Kumar', department: '', designation: 'Manager',
      status: 'Active', joining_date: '2026-01-01',
    })).toEqual(['Employee ID', 'Department']);
  });

  it('skill_type is in neither list', () => {
    // Asserted rather than assumed: if someone adds it to the mandatory list the
    // Incomplete badge jumps from a handful to 27 and stops meaning anything.
    expect(MANDATORY_FIELDS.map(([k]) => k)).not.toContain('skill_type');
    expect(REQUIRED_ON_CREATE.map(([k]) => k)).not.toContain('skill_type');
    // But the dashboard's wider question still covers it — that is the whole
    // reason the two counts legitimately differ.
    expect(Object.keys(MISSING_FIELD_TESTS)).toContain('skill_type');
  });
});
