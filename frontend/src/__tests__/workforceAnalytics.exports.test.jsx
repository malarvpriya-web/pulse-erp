/**
 * Workforce Analytics & Reports — the Reports & Exports section.
 *
 * Pins what the browser does with the three export endpoints: which parameters
 * each sends (headcount ignores the period; attrition uses it; documents need an
 * explicit window), the CSV actually written (shared writer: formula quoting and
 * Aadhaar masking), empty and error results, and that the existing navigation
 * cards are still there. Server-side filtering, dates, scope and authorization
 * are covered by backend/src/__tests__/integration.workforceExports.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';

const auth = vi.hoisted(() => ({ grants: new Set(['hr:view', 'employees:view', 'employee_documents:view']) }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }),
}));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn() } }));
vi.mock('recharts', () => {
  const Pass = ({ children }) => <div>{children}</div>;
  return { ResponsiveContainer: Pass, BarChart: Pass, CartesianGrid: () => null, XAxis: () => null,
           YAxis: () => null, Tooltip: () => null, Cell: () => null, Bar: () => null };
});

import api from '../services/api/client';
import EmployeeReports, { EXPORTS, REPORT_LINKS, exportErrorMessage } from '../features/hr/pages/EmployeeReports.jsx';

const empty = { total: 0, recorded: 0, notRecorded: 0, lowSample: true, buckets: [] };
const WORKFORCE = {
  filters: {}, minSample: 5,
  period: { key: 'last12m', label: 'Last 12 Months', from: '2025-10-13', to: '2026-10-13', isAll: false },
  population: { basis: 'current', total: 1 },
  breakdowns: Object.fromEntries(['department', 'status', 'designation', 'employmentType', 'location', 'gender',
    'skillType', 'qualification', 'age', 'experience', 'workforceCategory'].map(k => [k, empty])),
  joiningTrend: { months: [], total: 0 },
  exits: { inPeriod: 0, byMonth: [], byReason: [], dateUnknown: { count: 0, byReason: [] }, allTime: 0 },
  completeness: [],
};
WORKFORCE.breakdowns.department = { total: 1, recorded: 1, notRecorded: 0, lowSample: true, buckets: [{ value: 'Finance', count: 1 }] };

const EXPORT_DATA = {
  '/analytics/employee-reports/headcount': {
    columns: ['Emp Code', 'Employee', 'Department', 'Designation'],
    rows: [['EMP001', 'Asha Rao', 'Finance', '=HYPERLINK("http://evil","x")'],
           ['EMP002', 'Ravi Kumar', 'Finance', 'Analyst']],
    total: 2,
  },
  '/analytics/employee-reports/attrition': {
    columns: ['Emp Code', 'Exit Date', 'Exit Date Source', 'Period', 'Exit Reason'],
    rows: [['EMP010', '2026-06-30', 'Exit date', 'In period', 'Better offer'],
           ['EMP011', 'Unknown', 'Unknown — no exit date or last working day recorded', 'Date unknown — not placed in any period', 'Not recorded']],
    total: 2, dateUnknown: 1,
  },
  '/analytics/employee-reports/doc-expiry': {
    columns: ['Emp Code', 'Document Name', 'Expiry Date', 'Days Left'],
    rows: [['EMP001', 'Aadhar Card 2345 6789 0123', '2026-10-12', -1], ['EMP002', '@SUM(1+1)', '2026-11-01', 19]],
    total: 2,
  },
};

let exportsData;
let captured;
beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  sessionStorage.clear();
  auth.grants = new Set(['hr:view', 'employees:view', 'employee_documents:view']);
  exportsData = JSON.parse(JSON.stringify(EXPORT_DATA));
  captured = [];
  api.get.mockImplementation(async (url) => ({ data: url === '/analytics/workforce' ? WORKFORCE : exportsData[url] }));
  let blob;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b; return 'blob:test'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    captured.push({ blob, filename: this.download });
  });
});
afterEach(() => vi.restoreAllMocks());

const exportCard = (title) => screen.getByRole('article', { name: `${title} report` });
const exportCalls = (path) => api.get.mock.calls.filter(([u]) => u === path);
async function renderPage() {
  render(<EmployeeReports setPage={vi.fn()} />);
  await waitFor(() => expect(document.querySelector('.wfa-caption')).toBeTruthy());
}
async function csvText() {
  await waitFor(() => expect(captured.length).toBe(1));
  return (await captured[0].blob.text()).replace(/^\uFEFF/, '');
}
const selectFor = (label) => [...document.querySelectorAll('.pl-filterbar-field')]
  .find(l => l.querySelector('.pl-filterbar-label')?.textContent === label)?.querySelector('select');

describe('the section', () => {
  it('offers the three CSV exports and keeps the three navigation cards', async () => {
    await renderPage();
    for (const e of EXPORTS) expect(within(exportCard(e.title)).getByRole('button', { name: `Download ${e.title} CSV` })).toBeTruthy();
    for (const l of REPORT_LINKS) expect(screen.getByRole('button', { name: new RegExp(`^${l.label}`) })).toBeTruthy();
  });

  it('is available with hr:view alone (no employees:view needed to export)', async () => {
    auth.grants = new Set(['hr:view']);
    await renderPage();
    expect(within(exportCard('Headcount')).getByRole('button', { name: 'Download Headcount CSV' })).toBeTruthy();
  });
});

describe('Headcount CSV', () => {
  it('sends the page filters but not the period, and writes the rows', async () => {
    await renderPage();
    await waitFor(() => expect(selectFor('Department').options.length).toBeGreaterThan(1));
    fireEvent.change(selectFor('Department'), { target: { value: 'Finance' } });
    fireEvent.click(within(exportCard('Headcount')).getByRole('button', { name: 'Download Headcount CSV' }));
    const text = await csvText();
    const [, opts] = exportCalls('/analytics/employee-reports/headcount')[0];
    expect(opts.params).toMatchObject({ department: 'Finance' });
    expect(opts.params).not.toHaveProperty('period');
    expect(text.split('\r\n')[0]).toBe('"Emp Code","Employee","Department","Designation"');
    expect(text.split('\r\n')).toHaveLength(3);
    expect(captured[0].filename).toMatch(/^workforce-headcount-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(within(exportCard('Headcount')).getByRole('status').textContent).toBe('Downloaded 2 rows.');
  });

  it('quotes a formula-looking cell so a spreadsheet will not run it', async () => {
    await renderPage();
    fireEvent.click(within(exportCard('Headcount')).getByRole('button', { name: 'Download Headcount CSV' }));
    const text = await csvText();
    expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(text).not.toMatch(/(^|,)"=HYPERLINK/m);
  });
});

describe('Attrition CSV', () => {
  it('sends the period with the filters and keeps Unknown exit dates explicit', async () => {
    await renderPage();
    fireEvent.click(within(exportCard('Attrition')).getByRole('button', { name: 'Download Attrition CSV' }));
    const text = await csvText();
    expect(exportCalls('/analytics/employee-reports/attrition')[0][1].params).toMatchObject({ period: 'last12m' });
    expect(text).toContain('"EMP011","Unknown","Unknown — no exit date or last working day recorded"');
    expect(within(exportCard('Attrition')).getByRole('status').textContent)
      .toBe('Downloaded 2 rows. 1 with no recorded exit date is marked Unknown.');
  });
});

describe('Document expiry CSV', () => {
  it('cannot be downloaded until an expiry window is chosen', async () => {
    await renderPage();
    const btn = within(exportCard('Document expiry')).getByRole('button', { name: 'Download Document expiry CSV' });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(exportCalls('/analytics/employee-reports/doc-expiry')).toHaveLength(0);
  });

  it('sends the chosen window, masks Aadhaar in document names and quotes formulas', async () => {
    await renderPage();
    const card = exportCard('Document expiry');
    fireEvent.change(within(card).getByLabelText('Expiry window'), { target: { value: 'expired_or_30' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Download Document expiry CSV' }));
    const text = await csvText();
    expect(exportCalls('/analytics/employee-reports/doc-expiry')[0][1].params).toMatchObject({ window: 'expired_or_30' });
    expect(text).toContain('Aadhar Card ****0123');
    expect(text).not.toMatch(/2345\s?6789/);
    expect(text).toContain(`"'@SUM(1+1)"`);
    // A negative Days Left starts with '-', so the shared writer's formula guard
    // quotes it: shown as -1 in a spreadsheet, stored as text. Deliberate.
    expect(text).toContain(`"'-1"`);
    expect(captured[0].filename).toMatch(/^workforce-documents-expired_or_30-/);
  });
});

describe('empty and failed exports', () => {
  it('an empty result downloads nothing and says so', async () => {
    exportsData['/analytics/employee-reports/headcount'] = { columns: ['Emp Code'], rows: [], total: 0 };
    await renderPage();
    fireEvent.click(within(exportCard('Headcount')).getByRole('button', { name: 'Download Headcount CSV' }));
    await waitFor(() => expect(within(exportCard('Headcount')).getByRole('status').textContent)
      .toMatch(/No records match these filters — nothing was downloaded/));
    expect(captured).toEqual([]);
  });

  it.each([
    [403, /do not have access/],
    [404, /HTTP 404/],
    [500, /HTTP 500/],
  ])('HTTP %i is reported on the card and downloads nothing', async (status, msg) => {
    api.get.mockImplementation(async (url) => {
      if (url === '/analytics/workforce') return { data: WORKFORCE };
      const e = new Error('fail'); e.response = { status, data: { error: 'boom' } }; throw e;
    });
    await renderPage();
    fireEvent.click(within(exportCard('Attrition')).getByRole('button', { name: 'Download Attrition CSV' }));
    await waitFor(() => expect(within(exportCard('Attrition')).getByRole('status').textContent).toMatch(msg));
    expect(captured).toEqual([]);
  });

  it('exportErrorMessage covers a server that does not respond', () => {
    expect(exportErrorMessage(new Error('Network Error'))).toMatch(/did not respond/);
  });
});
