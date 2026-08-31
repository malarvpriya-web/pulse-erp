/**
 * Dashboard filter helper tests (shared/dashboardFilters.js)
 *
 * These bounds feed straight into every dashboard endpoint's WHERE clause, so
 * an off-by-one here silently mis-states KPIs across the app.
 *
 *   1.  Each preset resolves to the documented window
 *   2.  Indian FY (Apr–Mar) boundary handling for fytd
 *   3.  Unknown / missing period falls back to the default
 *   4.  defaultPeriod option is honoured
 *   5.  period=all yields null bounds (the "no filter" sentinel)
 *   6.  Explicit from/to wins and is honoured without period=custom
 *   7.  Inverted custom ranges are swapped, not returned empty
 *   8.  Malformed dates are rejected rather than reaching SQL
 *   9.  dimension() maps blank / "all" to null and enforces an allow-list
 *   10. idDimension() coerces to int and rejects non-numerics
 *
 * Run:  npx vitest run src/__tests__/dashboardFilters.test.js
 */

import { describe, test, expect } from 'vitest';
import {
  resolveRange, dimension, idDimension, PERIOD_PRESETS, DEFAULT_PERIOD,
} from '../shared/dashboardFilters.js';

// Thursday 13 Aug 2026 — inside FY2026-27 (Apr 2026 – Mar 2027), Q3 of the
// calendar year, so every preset lands on a distinct window.
const now = new Date(2026, 7, 13);

describe('resolveRange — presets', () => {
  test.each([
    ['mtd',     '2026-08-01', '2026-08-13'],
    ['qtd',     '2026-07-01', '2026-08-13'],
    ['ytd',     '2026-01-01', '2026-08-13'],
    ['fytd',    '2026-04-01', '2026-08-13'],
    ['last7',   '2026-08-07', '2026-08-13'],
    ['last30',  '2026-07-15', '2026-08-13'],
    ['last90',  '2026-05-16', '2026-08-13'],
    ['last6m',  '2026-02-13', '2026-08-13'],
    ['last12m', '2025-08-13', '2026-08-13'],
  ])('%s → %s..%s', (period, from, to) => {
    const r = resolveRange({ period }, { now });
    expect(r.period).toBe(period);
    expect(r.from).toBe(from);
    expect(r.to).toBe(to);
    expect(r.isAll).toBe(false);
  });

  test('last7 is inclusive of both ends (7 days, not 8)', () => {
    const { from, to } = resolveRange({ period: 'last7' }, { now });
    const days = (new Date(to) - new Date(from)) / 86400000 + 1;
    expect(days).toBe(7);
  });
});

describe('resolveRange — Indian financial year', () => {
  test('Jan–Mar belongs to the FY that started the previous April', () => {
    const r = resolveRange({ period: 'fytd' }, { now: new Date(2027, 1, 10) });
    expect(r.from).toBe('2026-04-01');
  });

  test('April 1 opens a new FY', () => {
    const r = resolveRange({ period: 'fytd' }, { now: new Date(2027, 3, 1) });
    expect(r.from).toBe('2027-04-01');
    expect(r.to).toBe('2027-04-01');
  });
});

describe('resolveRange — fallbacks', () => {
  test('unknown period falls back to the default', () => {
    expect(resolveRange({ period: 'nonsense' }, { now }).period).toBe(DEFAULT_PERIOD);
  });

  test('empty query falls back to the default', () => {
    expect(resolveRange({}, { now }).period).toBe(DEFAULT_PERIOD);
  });

  test('defaultPeriod option overrides the module default', () => {
    const r = resolveRange({}, { now, defaultPeriod: 'all' });
    expect(r.period).toBe('all');
    expect(r.isAll).toBe(true);
  });

  test('period=custom with no usable dates falls back rather than sending null bounds as custom', () => {
    const r = resolveRange({ period: 'custom' }, { now });
    expect(r.period).toBe(DEFAULT_PERIOD);
    expect(r.from).toBe('2026-04-01');
  });

  test('every advertised preset is resolvable', () => {
    for (const p of PERIOD_PRESETS) {
      expect(() => resolveRange({ period: p }, { now })).not.toThrow();
    }
  });
});

describe('resolveRange — all time', () => {
  test('null bounds are the "no filter" sentinel for ($n::date IS NULL OR …)', () => {
    const r = resolveRange({ period: 'all' }, { now });
    expect(r.from).toBeNull();
    expect(r.to).toBeNull();
    expect(r.isAll).toBe(true);
  });
});

describe('resolveRange — custom ranges', () => {
  test('explicit from/to is honoured without period=custom', () => {
    const r = resolveRange({ from: '2026-01-01', to: '2026-03-31' }, { now });
    expect(r.period).toBe('custom');
    expect(r.from).toBe('2026-01-01');
    expect(r.to).toBe('2026-03-31');
  });

  test('a single open-ended bound is preserved', () => {
    expect(resolveRange({ from: '2026-01-01' }, { now }).to).toBeNull();
    expect(resolveRange({ to: '2026-01-01' }, { now }).from).toBeNull();
  });

  test('inverted range is swapped, not returned as an empty window', () => {
    const r = resolveRange({ from: '2026-06-30', to: '2026-05-01' }, { now });
    expect(r.from).toBe('2026-05-01');
    expect(r.to).toBe('2026-06-30');
  });

  test('malformed dates never reach SQL', () => {
    for (const bad of ['13-08-2026', "2026-08-13'; DROP TABLE ncr_reports--", '2026/08/13', 'NOW()']) {
      const r = resolveRange({ period: 'custom', from: bad }, { now });
      expect(r.from).not.toBe(bad);
      expect(r.period).toBe(DEFAULT_PERIOD);
    }
  });
});

describe('dimension / idDimension', () => {
  test('blank, missing and "all" mean unfiltered', () => {
    expect(dimension({}, 'department')).toBeNull();
    expect(dimension({ department: '' }, 'department')).toBeNull();
    expect(dimension({ department: 'all' }, 'department')).toBeNull();
    expect(dimension({ department: 'ALL' }, 'department')).toBeNull();
  });

  test('a real value is trimmed and passed through', () => {
    expect(dimension({ department: ' Engineering ' }, 'department')).toBe('Engineering');
  });

  test('allow-list rejects values outside it', () => {
    expect(dimension({ status: 'open' }, 'status', ['open', 'closed'])).toBe('open');
    expect(dimension({ status: 'DROP' }, 'status', ['open', 'closed'])).toBeNull();
  });

  test('idDimension coerces to int and rejects non-numerics', () => {
    expect(idDimension({ project_id: '42' }, 'project_id')).toBe(42);
    expect(idDimension({ project_id: 'abc' }, 'project_id')).toBeNull();
    expect(idDimension({ project_id: 'all' }, 'project_id')).toBeNull();
  });
});
