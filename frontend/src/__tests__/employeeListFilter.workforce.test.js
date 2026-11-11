/**
 * The `wf` drill-through filter: All Employees must list exactly the people a
 * Workforce Analytics bar counted. That only holds if the frontend labels a
 * value the way the backend's labelSql() does — NULL, blank, whitespace and the
 * strings 'null' / 'undefined' (any case) are 'Not recorded'; anything else is
 * trimmed.
 */
import { describe, it, expect } from 'vitest';
import {
  workforceLabel, matchesEmployeeFilter, NOT_RECORDED,
} from '../features/employees/employeeListFilter';

describe('workforceLabel', () => {
  it.each([[null], [undefined], [''], ['   '], ['null'], ['NULL'], ['undefined'], [' Undefined ']])(
    '%j is Not recorded', (v) => { expect(workforceLabel(v)).toBe(NOT_RECORDED); });

  it('trims real values and keeps their case', () => {
    expect(workforceLabel('  Finance ')).toBe('Finance');
    expect(workforceLabel('Semi Skilled')).toBe('Semi Skilled');
  });
});

describe('matchesEmployeeFilter with wf', () => {
  const emp = (o) => ({ id: 1, status: 'Active', ...o });

  it('matches each text dimension on the trimmed value', () => {
    const e = emp({ department: ' Finance ', designation: 'Driver', employment_type: 'Contract',
                    gender: 'Female', skill_type: 'Skilled', highest_qualification: 'Graduate' });
    expect(matchesEmployeeFilter(e, { wf: {
      department: 'Finance', designation: 'Driver', employmentType: 'Contract',
      gender: 'Female', skillType: 'Skilled', qualification: 'Graduate' } })).toBe(true);
    expect(matchesEmployeeFilter(e, { wf: { designation: 'Engineer' } })).toBe(false);
  });

  it('"Not recorded" selects every blank variety and nothing else', () => {
    const f = { wf: { gender: NOT_RECORDED } };
    for (const g of [null, '', '  ', 'null', 'undefined']) expect(matchesEmployeeFilter(emp({ gender: g }), f)).toBe(true);
    expect(matchesEmployeeFilter(emp({ gender: 'Male' }), f)).toBe(false);
  });

  it('branchId: an id, or null for no location', () => {
    expect(matchesEmployeeFilter(emp({ branch_id: 7 }), { wf: { branchId: '7' } })).toBe(true);
    expect(matchesEmployeeFilter(emp({ branch_id: 8 }), { wf: { branchId: '7' } })).toBe(false);
    expect(matchesEmployeeFilter(emp({ branch_id: null }), { wf: { branchId: null } })).toBe(true);
    expect(matchesEmployeeFilter(emp({ branch_id: 7 }), { wf: { branchId: null } })).toBe(false);
  });

  it('combines with the existing keys', () => {
    const e = emp({ department: 'Finance', joining_date: '2026-05-10' });
    expect(matchesEmployeeFilter(e, { wf: { department: 'Finance' }, joinedFrom: '2026-05-01', joinedTo: '2026-05-31' })).toBe(true);
    expect(matchesEmployeeFilter(e, { wf: { department: 'Finance' }, joinedFrom: '2026-06-01', joinedTo: '2026-06-30' })).toBe(false);
  });

  it('leaves the Employees Dashboard\'s own department key and labels alone', () => {
    expect(matchesEmployeeFilter(emp({ department: '' }), { department: 'Unassigned' })).toBe(true);
    expect(matchesEmployeeFilter(emp({ department: '' }), { department: NOT_RECORDED })).toBe(false);
  });
});

// 2026-11-10: All Employees reads the drill filter through peek, which ignored
// `wf` — every Workforce Analytics chart drill opened an unfiltered list.
import { setEmployeeListFilter, peekEmployeeListFilter } from '../features/employees/employeeListFilter';
describe('peekEmployeeListFilter keeps a wf-only filter', () => {
  it('a wf filter with status All is still a filter', () => {
    setEmployeeListFilter({ status: 'All', wf: { designation: 'Engineer' }, label: 'x' });
    expect(peekEmployeeListFilter()).toMatchObject({ wf: { designation: 'Engineer' } });
  });
  it('{ branchId: null } ("no location") is a real filter', () => {
    setEmployeeListFilter({ status: 'All', wf: { branchId: null }, label: 'x' });
    expect(peekEmployeeListFilter()).toMatchObject({ wf: { branchId: null } });
  });
  it('an empty wf object is not a filter', () => {
    setEmployeeListFilter({ status: 'All', wf: {}, label: 'x' });
    expect(peekEmployeeListFilter()).toBeNull();
  });
});
