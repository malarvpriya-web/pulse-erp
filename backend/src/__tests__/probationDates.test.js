/**
 * The one probation date rule (shared/probationDates.js) — pure, no database.
 *
 * Rule: the end date is the LAST day of probation, inclusive — the day before
 * the same calendar date N months later; when that date does not exist in the
 * target month, the last day of that month.
 */
import { describe, it, expect } from 'vitest';
import {
  probationEndDate, parseProbationMonths, parseReminderDays, toIsoDate, parseIsoDate,
  resolveProbationWrite, DEFAULT_PROBATION_MONTHS, DEFAULT_REMINDER_DAYS,
} from '../shared/probationDates.js';

describe('probationEndDate — calendar months, inclusive end', () => {
  it.each([
    // ordinary days: the day before the same date N months on
    ['2026-01-15', 6, '2026-07-14'],
    ['2026-03-10', 3, '2026-06-09'],
    ['2026-01-02', 1, '2026-02-01'],
    // the 1st: the last day of the month before the anniversary month
    ['2026-01-01', 6, '2026-06-30'],
    ['2026-03-01', 1, '2026-03-31'],
    ['2026-07-01', 6, '2026-12-31'],
    // year rollover
    ['2026-09-28', 6, '2027-03-27'],
    ['2026-12-01', 1, '2026-12-31'],
    ['2026-12-15', 1, '2027-01-14'],
    ['2026-08-01', 6, '2027-01-31'],
    // month-end clamping: the anniversary day-1 does not exist in the month
    ['2026-08-31', 6, '2027-02-28'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-05-31', 1, '2026-06-30'],
    ['2026-10-31', 4, '2027-02-28'],
    // leap years: 29-Feb exists in 2028, not in 2027 or 2029
    ['2027-08-31', 6, '2028-02-29'],
    ['2027-08-30', 6, '2028-02-29'],
    ['2026-08-30', 6, '2027-02-28'],
    ['2027-08-29', 6, '2028-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    // starting ON 29-Feb
    ['2028-02-29', 12, '2029-02-28'],
    ['2028-02-29', 6, '2028-08-28'],
    ['2028-02-29', 1, '2028-03-28'],
    // long periods
    ['2026-02-15', 24, '2028-02-14'],
    ['2026-03-01', 12, '2027-02-28'],
    ['2027-03-01', 12, '2028-02-29'],
  ])('%s + %i months → %s', (start, months, end) => {
    expect(probationEndDate(start, months)).toBe(end);
  });

  it('is never the old +90 / +180 day rule', () => {
    // 2026-03-01 + 180 days would be 2026-08-28; six calendar months end 08-31.
    expect(probationEndDate('2026-03-01', 6)).toBe('2026-08-31');
    // 2026-09-29 + 180 days would be 2027-03-28 by luck; + 90 days (the old
    // create rule) was 2026-12-28. Six months:
    expect(probationEndDate('2026-09-29', 6)).toBe('2027-03-28');
    expect(probationEndDate('2026-09-29', 6)).not.toBe('2026-12-28');
  });

  it('accepts a Date and a longer ISO string, read as a calendar date', () => {
    expect(probationEndDate(new Date('2026-01-15T00:00:00Z'), 6)).toBe('2026-07-14');
    expect(probationEndDate('2026-01-15T18:30:00.000Z', 6)).toBe('2026-07-14');
  });

  it.each([
    ['2026-02-30', 6], ['2026-13-01', 6], ['not a date', 6], ['', 6], [null, 6],
    ['2026-01-15', 0], ['2026-01-15', 25], ['2026-01-15', '6.5'], ['2026-01-15', -1], ['2026-01-15', 'six'],
  ])('throws on bad input (%s, %s) rather than guessing', (start, months) => {
    expect(() => probationEndDate(start, months)).toThrow(RangeError);
  });
});

describe('parsers', () => {
  it('months: whole numbers 1..24 only', () => {
    expect(parseProbationMonths(6)).toBe(6);
    expect(parseProbationMonths('6')).toBe(6);
    expect(parseProbationMonths(' 12 ')).toBe(12);
    for (const bad of [0, 25, '6.5', '', null, undefined, 'abc', true, -3]) {
      expect(parseProbationMonths(bad), String(bad)).toBeNull();
    }
  });

  it('reminder days: whole numbers 0..90 only', () => {
    expect(parseReminderDays(14)).toBe(14);
    expect(parseReminderDays('0')).toBe(0);
    for (const bad of [91, '-1', '1.5', '', null, 'x']) expect(parseReminderDays(bad), String(bad)).toBeNull();
  });

  it('dates: real calendar dates only', () => {
    expect(toIsoDate('2028-02-29')).toBe('2028-02-29');
    expect(toIsoDate('2027-02-29')).toBeNull();
    expect(parseIsoDate('2026-04-31')).toBeNull();
  });

  it('defaults are six months and fourteen days', () => {
    expect(DEFAULT_PROBATION_MONTHS).toBe(6);
    expect(DEFAULT_REMINDER_DAYS).toBe(14);
  });
});

describe('resolveProbationWrite — what an employee write stores', () => {
  it('nothing sent (and no default) → untouched, so an unrelated edit keeps the saved date', () => {
    expect(resolveProbationWrite({ joiningDate: '2026-01-15' })).toEqual({ touched: false });
    expect(resolveProbationWrite({ joiningDate: '2026-01-15', months: '', endDate: '' })).toEqual({ touched: false });
    // FormData turns a null into the text "null" — still "not sent"
    expect(resolveProbationWrite({ joiningDate: '2026-01-15', months: 'null', endDate: 'undefined' })).toEqual({ touched: false });
  });

  it('a period → calculated from the joining date', () => {
    expect(resolveProbationWrite({ joiningDate: '2026-01-15', months: '3' }))
      .toEqual({ touched: true, probation_months: 3, probation_end_date: '2026-04-14' });
  });

  it('the default period is used only when the caller asks for it', () => {
    expect(resolveProbationWrite({ joiningDate: '2026-01-15', defaultMonths: 6 }))
      .toEqual({ touched: true, probation_months: 6, probation_end_date: '2026-07-14' });
    // an invalid default falls back to six months, never to garbage
    expect(resolveProbationWrite({ joiningDate: '2026-01-15', defaultMonths: 'x' }).probation_end_date).toBe('2026-07-14');
  });

  it('an explicit end date is stored exactly; months left alone unless also sent', () => {
    expect(resolveProbationWrite({ joiningDate: '2026-01-15', endDate: '2026-09-30' }))
      .toEqual({ touched: true, probation_months: undefined, probation_end_date: '2026-09-30' });
    expect(resolveProbationWrite({ joiningDate: '2026-01-15', endDate: '2026-09-30', months: 6, defaultMonths: 3 }))
      .toEqual({ touched: true, probation_months: 6, probation_end_date: '2026-09-30' });
  });

  it('refuses bad input with a message, never a silent substitute', () => {
    expect(() => resolveProbationWrite({ joiningDate: '2026-01-15', months: '0' })).toThrow(/whole number of months/);
    expect(() => resolveProbationWrite({ joiningDate: '2026-01-15', endDate: '2026-02-30' })).toThrow(/not a valid/);
    expect(() => resolveProbationWrite({ joiningDate: '2026-01-15', endDate: '2025-12-31' })).toThrow(/before the joining date/);
    expect(() => resolveProbationWrite({ joiningDate: null, months: 6 })).toThrow(/without a valid joining date/);
  });
});
