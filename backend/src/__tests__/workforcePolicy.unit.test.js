/**
 * shared/workforcePolicy.js — the editable workforce limits and the
 * date-of-birth rule (2026-11-10). Pure functions; no database.
 */
import { describe, it, expect } from 'vitest';
import {
  dobProblem, ageOn, validateWorkforcePolicyPatch, WORKFORCE_POLICY_DEFAULTS,
} from '../shared/workforcePolicy.js';

const POLICY = { min_employee_age: 18, max_employee_age: 80 };
const TODAY = '2026-11-10';

describe('ageOn', () => {
  it('is birthday-aware', () => {
    expect(ageOn('2000-11-10', TODAY)).toBe(26);
    expect(ageOn('2000-11-11', TODAY)).toBe(25);
    expect(ageOn('2008-02-29', '2026-02-28')).toBe(17);
  });
});

describe('dobProblem', () => {
  it('blank is not a problem (DOB is optional)', () => {
    for (const v of [null, undefined, '', '   ']) expect(dobProblem(v, POLICY, TODAY)).toBeNull();
  });
  it('EMP003 — 27 Feb 2026, 8 months old — is refused against the minimum', () => {
    expect(dobProblem('2026-02-27', POLICY, TODAY)).toMatch(/0 years old; the company minimum is 18/);
  });
  it('a future date is refused', () => {
    expect(dobProblem('2026-12-01', POLICY, TODAY)).toMatch(/in the future/);
  });
  it('over the maximum is refused (1906-for-1996 slip)', () => {
    expect(dobProblem('1906-05-01', POLICY, TODAY)).toMatch(/the company maximum is 80/);
  });
  it('exactly the minimum and the maximum are accepted', () => {
    expect(dobProblem('2008-11-10', POLICY, TODAY)).toBeNull();   // 18 today
    expect(dobProblem('1945-11-11', POLICY, TODAY)).toBeNull();   // 80
  });
  it('the limits are the company\'s, not fixed', () => {
    expect(dobProblem('2010-01-01', { min_employee_age: 16, max_employee_age: 80 }, TODAY)).toBeNull();
    expect(dobProblem('2010-01-01', POLICY, TODAY)).not.toBeNull();
  });
  it('malformed and impossible dates are refused', () => {
    expect(dobProblem('10/11/1990', POLICY, TODAY)).toMatch(/not a valid date of birth/);
    expect(dobProblem('1990-02-30', POLICY, TODAY)).toMatch(/not a valid date of birth/);
  });
  it('a full timestamp is read by its date part', () => {
    expect(dobProblem('1990-05-01T00:00:00.000Z', POLICY, TODAY)).toBeNull();
  });
});

describe('validateWorkforcePolicyPatch', () => {
  const current = { ...WORKFORCE_POLICY_DEFAULTS };
  it('accepts in-range whole numbers, including numeric strings', () => {
    expect(validateWorkforcePolicyPatch({ min_employee_age: '16', analytics_min_sample: 3 }, current))
      .toEqual({ min_employee_age: 16, analytics_min_sample: 3 });
  });
  it('refuses below the legal floor, decimals and blanks, listing each', () => {
    try {
      validateWorkforcePolicyPatch({ min_employee_age: 13, max_employee_age: 70.5, analytics_min_sample: '' }, current);
      throw new Error('expected a 400');
    } catch (e) {
      expect(e.status).toBe(400);
      expect(e.errors).toHaveLength(3);
    }
  });
  it('the ranges cannot cross: the highest minimum is below the lowest maximum', () => {
    expect(validateWorkforcePolicyPatch({ min_employee_age: 25, max_employee_age: 50 }, current))
      .toEqual({ min_employee_age: 25, max_employee_age: 50 });
    expect(() => validateWorkforcePolicyPatch({ max_employee_age: 49 }, current)).toThrow(/50 to 100/);
    expect(() => validateWorkforcePolicyPatch({ min_employee_age: 26 }, current)).toThrow(/14 to 25/);
  });
  it('refuses unknown keys rather than storing a setting nobody reads', () => {
    expect(() => validateWorkforcePolicyPatch({ min_age: 18 }, current)).toThrow(/not a workforce setting/);
  });
  it('ignores the read-only is_default echo a client may send back', () => {
    expect(validateWorkforcePolicyPatch({ is_default: {}, max_employee_age: 90 }, current))
      .toEqual({ max_employee_age: 90 });
  });
});
