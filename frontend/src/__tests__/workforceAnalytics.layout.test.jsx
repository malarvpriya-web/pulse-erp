/**
 * Workforce Analytics & Reports — layout regressions (2026-10-13).
 *
 * 1. THE DOCUMENT SCROLLED. The page's screen-reader-only labels (.wfa-sr — the
 *    data tables' caption and "Open" header) are `position: absolute`, and no
 *    ancestor inside `.page-content` (the app's scroll container, position:
 *    static) was positioned. Their containing block became <body>, so each was
 *    laid out against the DOCUMENT at its place deep in the scrolled content and
 *    the document grew past the viewport: a second, outer scrollbar and a blank
 *    strip under the page (measured 1164px at a 900px viewport). Fixed by
 *    positioning .wfa-table. Pinned here: every absolutely positioned element the
 *    page renders has an ancestor this page's CSS positions.
 *
 * 2. 8px SIDEWAYS AT PHONE WIDTH. styles/global-overrides.css (≤768px) sets
 *    .page-content's side padding to 12px !important while the shared .plh-page
 *    cancels 20px. This page cancels exactly what is there. Pinned here: the two
 *    numbers agree, so changing one without the other fails this test instead of
 *    bringing the scrollbar back.
 *
 * jsdom does no layout, so these are structural checks; the measured browser
 * behaviour is in the task report.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn() } }));
vi.mock('recharts', () => {
  const Pass = ({ children }) => <div>{children}</div>;
  return { ResponsiveContainer: Pass, BarChart: Pass, CartesianGrid: () => null, XAxis: () => null,
           YAxis: () => null, Tooltip: () => null, Cell: () => null, Bar: () => null };
});

import api from '../services/api/client';
import EmployeeReports from '../features/hr/pages/EmployeeReports.jsx';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_CSS = readFileSync(resolve(here, '../features/hr/pages/EmployeeReports.css'), 'utf8');
const GLOBAL_CSS = readFileSync(resolve(here, '../styles/global-overrides.css'), 'utf8');

/** Top-level `selector { body }` rules of a stylesheet, comments stripped. */
function rules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim(), body: m[2] }));
}
const selectorsWith = (css, re) => rules(css).filter(r => re.test(r.body)).flatMap(r => r.selector.split(',').map(s => s.trim()));

const bd = (buckets) => ({ total: 3, recorded: 3, notRecorded: 0, lowSample: true, buckets });
const DATA = {
  filters: {}, minSample: 5,
  period: { key: 'last12m', label: 'Last 12 Months', from: '2025-10-13', to: '2026-10-13', isAll: false },
  population: { basis: 'current', total: 3 },
  breakdowns: Object.fromEntries(['department', 'status', 'designation', 'employmentType', 'location', 'gender',
    'skillType', 'qualification', 'age', 'experience', 'workforceCategory'].map(k => [k, bd([{ value: 'A', count: 2 }, { value: 'B', count: 1 }])])),
  joiningTrend: { months: [{ monthKey: '2026-09', month: 'Sep 26', joins: 1 }], total: 1 },
  exits: { inPeriod: 0, byMonth: [{ monthKey: '2026-09', month: 'Sep 26', exits: 0 }], byReason: [], dateUnknown: { count: 0, byReason: [] }, allTime: 0 },
  completeness: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  sessionStorage.clear();
  api.get.mockResolvedValue({ data: DATA });
});

describe('screen-reader-only text stays inside the page', () => {
  it('this page\'s CSS gives .wfa-table a positioning context', () => {
    expect(selectorsWith(PAGE_CSS, /position:\s*relative/)).toContain('.wfa-table');
  });

  it('every absolutely positioned element the page renders has a positioned ancestor inside the page', async () => {
    render(<EmployeeReports setPage={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('.wfa-caption')).toBeTruthy());
    const absolute = selectorsWith(PAGE_CSS, /position:\s*absolute/);
    const positioned = selectorsWith(PAGE_CSS, /position:\s*(relative|absolute|fixed|sticky)/)
      .filter(s => !absolute.includes(s));
    expect(absolute).toContain('.wfa-sr');

    const page = document.querySelector('.wfa-page');
    const els = absolute.flatMap(sel => [...page.querySelectorAll(sel)]);
    expect(els.length, 'the low-sample data tables render .wfa-sr labels').toBeGreaterThan(0);
    const escaping = els.filter(el => {
      const anchor = el.parentElement?.closest(positioned.join(','));
      return !anchor || !page.contains(anchor);
    }).map(el => `${el.tagName.toLowerCase()}.${el.className}: "${el.textContent}"`);
    expect(escaping, 'absolutely positioned elements anchored to <body>').toEqual([]);
  });
});

describe('no sideways overflow at phone width', () => {
  /** px value of a declaration inside the first `@media (max-width: 768px)` block matching `selector`. */
  function mediaValue(css, selector, prop) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const m = [...clean.matchAll(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/g)].map(x => x[1]).join('\n');
    const rule = rules(m).find(r => r.selector.split(',').map(s => s.trim()).includes(selector));
    const v = rule?.body.match(new RegExp(`${prop}:\\s*(-?\\d+)px`));
    return v ? Number(v[1]) : null;
  }

  it('cancels exactly the side padding the global mobile rule gives .page-content', () => {
    const padding = mediaValue(GLOBAL_CSS, '.page-content', 'padding-left');
    const margin = mediaValue(PAGE_CSS, '.plh-page.wfa-shell', 'margin-left');
    expect(padding, 'global-overrides.css mobile .page-content padding').toBe(12);
    expect(margin).toBe(-padding);
    expect(mediaValue(PAGE_CSS, '.plh-page.wfa-shell', 'margin-right')).toBe(-padding);
  });

  it('the page renders its shell with the class that rule targets', async () => {
    render(<EmployeeReports setPage={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('.wfa-caption')).toBeTruthy());
    expect(document.querySelector('.plh-page').classList.contains('wfa-shell')).toBe(true);
  });
});
