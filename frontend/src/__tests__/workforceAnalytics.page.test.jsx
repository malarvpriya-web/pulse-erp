/**
 * Workforce Analytics & Reports page (features/hr/pages/EmployeeReports.jsx).
 *
 * Fed a response shaped exactly like GET /analytics/workforce. Pins:
 *   · access: hr:view required; employees:view decides drill-through;
 *   · filters: 7 dimensions + period, options from an unfiltered read, sent as params;
 *   · composition is "as of today", the period moves joins/exits only;
 *   · completeness, low-sample and not-recorded states instead of charts;
 *   · drill-through writes the All Employees filter with the active global filters;
 *   · no drill where the list cannot express the bucket (category, age,
 *     experience, Exited) — and none at all without employees:view;
 *   · no salary; the existing Reports & Exports links stay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';

const auth = vi.hoisted(() => ({ grants: new Set(['hr:view', 'employees:view', 'employee_documents:view']) }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }),
}));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn() } }));

// Recharts draws nothing in jsdom. Containers pass children through; each Bar
// records its props so a test can see whether it is clickable.
const bars = vi.hoisted(() => ({ props: [] }));
vi.mock('recharts', () => {
  const Pass = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass, BarChart: Pass, CartesianGrid: () => null,
    XAxis: () => null, YAxis: () => null, Tooltip: () => null, Cell: () => null,
    Bar: (props) => { bars.props.push(props); return <div data-testid={`bar-${props.dataKey}`} />; },
  };
});

import api from '../services/api/client';
import EmployeeReports, { REPORT_LINKS, COMPOSITION, workforceErrorMessage } from '../features/hr/pages/EmployeeReports.jsx';
import { ROUTES, NAV_ITEMS } from '@/config/routes';

const bd = (buckets, total = 31) => {
  const notRecorded = buckets.find(b => b.value === 'Not recorded')?.count ?? 0;
  return { total, recorded: total - notRecorded, notRecorded, lowSample: total - notRecorded < 5, buckets };
};

const DATA = {
  filters: {},
  period: { key: 'last12m', label: 'Last 12 Months', from: '2025-10-13', to: '2026-10-13', isAll: false, trendTruncated: false, trendMonths: 2 },
  population: { basis: 'current', total: 31 },
  minSample: 5,
  breakdowns: {
    department:     bd([{ value: 'Finance', count: 5 }, { value: 'HR', count: 5 }, { value: 'Engineering', count: 20 }, { value: 'Not recorded', count: 1 }]),
    status:         bd([{ value: 'Active', count: 27 }, { value: 'Probation', count: 2 }, { value: 'Notice', count: 2 }]),
    designation:    bd([{ value: 'Driver', count: 2 }, { value: 'Engineer', count: 1 }, { value: 'Not recorded', count: 28 }]),
    employmentType: bd([{ value: 'Permanent', count: 4 }, { value: 'Contract', count: 2 }, { value: 'Not recorded', count: 25 }]),
    location:       bd([{ value: 'North Plant', count: 6, branchId: 7 }, { value: 'Not recorded', count: 25, branchId: null }]),
    gender:         bd([{ value: 'Male', count: 3 }, { value: 'Female', count: 3 }, { value: 'Not recorded', count: 25 }]),
    skillType:      bd([{ value: 'Skilled', count: 6 }, { value: 'Not recorded', count: 25 }]),
    qualification:  bd([{ value: 'Graduate', count: 4 }, { value: 'Not recorded', count: 27 }]),
    age: bd(['Under 25', '25-29', '30-34', '35-39', '40-44', '45-49', '50+']
      .map((v, i) => ({ value: v, count: i === 2 ? 5 : 0 })).concat({ value: 'Not recorded', count: 26 })),
    experience: bd([{ value: '0-1 yr', count: 3 }, { value: '1-3 yrs', count: 4 }, { value: '3-5 yrs', count: 0 },
                    { value: '5-10 yrs', count: 0 }, { value: '10+ yrs', count: 0 }, { value: 'Not recorded', count: 24 }]),
    workforceCategory: bd([{ value: 'Not recorded', count: 31 }]),
  },
  joiningTrend: { months: [{ monthKey: '2026-08', month: 'Aug 26', joins: 2 }, { monthKey: '2026-09', month: 'Sep 26', joins: 3 }], total: 5 },
  exits: {
    inPeriod: 2,
    byMonth: [{ monthKey: '2026-08', month: 'Aug 26', exits: 1 }, { monthKey: '2026-09', month: 'Sep 26', exits: 1 }],
    byReason: [{ reason: 'Better offer', count: 1 }, { reason: 'Relocation', count: 1 }],
    dateUnknown: { count: 1, byReason: [{ reason: 'Not recorded', count: 1 }] },
    allTime: 3,
  },
  completeness: [
    { field: 'department', label: 'Department', recorded: 30, total: 31, pct: 96.8, lowSample: false },
    { field: 'designation', label: 'Designation', recorded: 3, total: 31, pct: 9.7, lowSample: true },
    { field: 'workforceCategory', label: 'Workforce Category', recorded: 0, total: 31, pct: 0, lowSample: true },
  ],
};

function mockApi(data = DATA) {
  api.get.mockImplementation(async () => ({ data }));
}
const workforceCalls = () => api.get.mock.calls.filter(([u]) => u === '/analytics/workforce');
const lastParams = () => workforceCalls().at(-1)[1].params;
const card = (title) => screen.getByRole('heading', { name: title, level: 3 }).closest('article');
const selectFor = (label) => [...document.querySelectorAll('.pl-filterbar-field')]
  .find(l => l.querySelector('.pl-filterbar-label')?.textContent === label)?.querySelector('select');

async function renderPage(setPage = vi.fn()) {
  render(<EmployeeReports setPage={setPage} />);
  await waitFor(() => expect(document.querySelector('.wfa-caption')).toBeTruthy());
  return setPage;
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  sessionStorage.clear();
  bars.props.length = 0;
  auth.grants = new Set(['hr:view', 'employees:view', 'employee_documents:view']);
  mockApi();
});

// ── Access ────────────────────────────────────────────────────────────────────
describe('access', () => {
  it('the route requires hr:view, and so does the menu row', () => {
    expect(ROUTES.EmployeeReports.module).toBe('hr');
    const row = NAV_ITEMS.flatMap(g => g.submenu || []).find(r => r.page === 'EmployeeReports');
    expect(row.module).toBe('hr');
  });

  it('without hr:view the page says so and requests nothing', () => {
    auth.grants = new Set(['employees:view']);
    render(<EmployeeReports setPage={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toMatch(/need HR access/);
    expect(api.get).not.toHaveBeenCalled();
  });
});

// ── Filters and the period ────────────────────────────────────────────────────
describe('global filters', () => {
  it('offers the seven dimensions and a period labelled for joins and exits', async () => {
    await renderPage();
    for (const label of ['Department', 'Location', 'Employment Type', 'Designation', 'Gender', 'Status', 'Skill Type']) {
      expect(selectFor(label), label).toBeTruthy();
    }
    expect(screen.getByText('Joins & exits period')).toBeTruthy();
  });

  it('options come from an unfiltered read, including Not recorded; location values are branch ids', async () => {
    await renderPage();
    expect(workforceCalls().some(([, o]) => o.params.period === 'all' && !o.params.department)).toBe(true);
    await waitFor(() => expect([...selectFor('Department').options].map(o => o.value))
      .toEqual(['all', 'Finance', 'HR', 'Engineering', 'Not recorded']));
    expect([...selectFor('Location').options].map(o => [o.value, o.text]))
      .toEqual([['all', 'All Location'], ['7', 'North Plant'], ['Not recorded', 'Not recorded']]);
    expect([...selectFor('Status').options].map(o => o.value))
      .toEqual(['all', 'Active', 'Probation', 'Notice', 'Other', 'Exited']);
  });

  it('a filter change re-queries with that parameter', async () => {
    await renderPage();
    await waitFor(() => expect(selectFor('Department').options.length).toBeGreaterThan(1));
    fireEvent.change(selectFor('Department'), { target: { value: 'Finance' } });
    fireEvent.change(selectFor('Location'), { target: { value: '7' } });
    await waitFor(() => expect(lastParams()).toMatchObject({ department: 'Finance', branch_id: '7' }));
  });

  it('says composition is as of today and the period moves joins and exits only', async () => {
    await renderPage();
    const caption = document.querySelector('.wfa-caption').textContent;
    expect(caption).toMatch(/current workforce/);
    expect(caption).toMatch(/31\s+employees/);
    expect(caption).toMatch(/period applies to joining and exit trends only/);
  });
});

// ── Completeness and honest states ────────────────────────────────────────────
describe('completeness and data states', () => {
  it('shows recorded counts for every field', async () => {
    await renderPage();
    const strip = screen.getByLabelText('Data completeness');
    expect(within(strip).getByText('30/31')).toBeTruthy();
    expect(within(strip).getByText('3/31')).toBeTruthy();
    expect(within(strip).getByText('0/31')).toBeTruthy();
  });

  it('every composition card states its denominator, and blanks are counted beside the chart, not drawn', async () => {
    await renderPage();
    for (const c of COMPOSITION) expect(card(c.title).textContent).toMatch(/\d+ of 31 recorded/);
    const dept = card('Department');
    expect(dept.textContent).toMatch(/30 of 31 recorded · 1 not recorded/);
    const rows = [...dept.querySelectorAll('tbody th')].map(th => th.textContent);
    expect(rows).toEqual(['Finance', 'HR', 'Engineering']);
  });

  it('fewer recorded values than minSample: a list, no chart', async () => {
    await renderPage();
    const c = card('Designation');
    expect(c.textContent).toMatch(/Too few records to chart: only 3 of 31 recorded/);
    expect(within(c).queryByTestId('bar-count')).toBeNull();
    expect([...c.querySelectorAll('tbody th')].map(t => t.textContent)).toEqual(['Driver', 'Engineer']);
  });

  it('nothing recorded: says so instead of an empty chart', async () => {
    await renderPage();
    const c = card('Workforce Category');
    expect(c.textContent).toMatch(/Not recorded for any of the 31 employees/);
    expect(within(c).queryByTestId('bar-count')).toBeNull();
  });

  it('enough data: a chart', async () => {
    await renderPage();
    expect(within(card('Department')).getByTestId('bar-count')).toBeTruthy();
    expect(within(card('Age')).getByTestId('bar-count')).toBeTruthy();
  });

  it('no employees match: says so', async () => {
    const empty = JSON.parse(JSON.stringify(DATA));
    for (const k of Object.keys(empty.breakdowns)) empty.breakdowns[k] = { total: 0, recorded: 0, notRecorded: 0, lowSample: true, buckets: [] };
    mockApi(empty);
    await renderPage();
    expect(card('Department').textContent).toMatch(/No employees match the current filters/);
  });

  it('attrition shows undated exits and reasons', async () => {
    await renderPage();
    const c = screen.getByRole('article', { name: 'Attrition' });
    expect(c.textContent).toMatch(/1 exit has no recorded exit date/);
    expect(c.textContent).toMatch(/Better offer/);
    expect(c.textContent).toMatch(/3 people have left in total/);
  });

  it('the 2026-10-13 failure — Express "Cannot GET" HTML 404 — names the status and the likely cause', async () => {
    api.get.mockRejectedValue({ response: {
      status: 404,
      data: '<!DOCTYPE html><html><body><pre>Cannot GET /api/analytics/workforce</pre></body></html>',
    } });
    render(<EmployeeReports setPage={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/HTTP 404/));
    const text = screen.getByRole('alert').textContent;
    expect(text).toMatch(/does not provide workforce analytics/);
    expect(text).toMatch(/older build/);
    expect(text).not.toMatch(/<html|DOCTYPE/);           // never echoes the HTML body
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('a server that does not respond says so', async () => {
    api.get.mockRejectedValue(new Error('Network Error'));
    render(<EmployeeReports setPage={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/server did not respond/));
  });

  it('workforceErrorMessage: one message per cause', () => {
    expect(workforceErrorMessage({ response: { status: 403 } })).toMatch(/do not have access/);
    expect(workforceErrorMessage({ response: { status: 404, data: '<html>' } })).toMatch(/HTTP 404/);
    expect(workforceErrorMessage({ response: { status: 500, data: { error: 'boom' } } }))
      .toBe('Workforce analytics could not be loaded (HTTP 500): boom');
    expect(workforceErrorMessage({ response: { status: 502, data: '<html>bad gateway</html>' } }))
      .toBe('Workforce analytics could not be loaded (HTTP 502).');
    expect(workforceErrorMessage({})).toMatch(/did not respond/);
  });

  it('an API failure shows an error with Retry', async () => {
    api.get.mockRejectedValue({ response: { status: 500, data: { error: 'boom' } } });
    render(<EmployeeReports setPage={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/boom/));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

// ── Drill-through ─────────────────────────────────────────────────────────────
describe('drill-through with employees:view', () => {
  const stored = () => JSON.parse(sessionStorage.getItem('pulse.employeeListFilter'));

  it('opens All Employees filtered to the clicked value', async () => {
    const setPage = await renderPage();
    fireEvent.click(within(card('Department')).getByRole('button', { name: /"Finance"/ }));
    expect(setPage).toHaveBeenCalledWith('EmployeesData');
    expect(stored()).toMatchObject({ status: 'All', wf: { department: 'Finance' }, origin: 'EmployeeReports' });
  });

  it('carries the active global filters with the click', async () => {
    await renderPage();
    await waitFor(() => expect(selectFor('Gender').options.length).toBeGreaterThan(1));
    fireEvent.change(selectFor('Gender'), { target: { value: 'Female' } });
    fireEvent.change(selectFor('Location'), { target: { value: 'Not recorded' } });
    await waitFor(() => expect(lastParams()).toMatchObject({ gender: 'Female' }));
    await waitFor(() => expect(within(card('Employment Type')).getByRole('button', { name: /"Permanent"/ })).toBeTruthy());
    fireEvent.click(within(card('Employment Type')).getByRole('button', { name: /"Permanent"/ }));
    expect(stored().wf).toEqual({ gender: 'Female', branchId: null, employmentType: 'Permanent' });
  });

  it('a status bar drills by status', async () => {
    await renderPage();
    fireEvent.click(within(card('Employee Status')).getByRole('button', { name: /"Probation"/ }));
    expect(stored()).toMatchObject({ status: 'Probation' });
  });

  it('a joining month drills to that month\'s joiners', async () => {
    await renderPage();
    const trend = screen.getByRole('article', { name: 'Joining trend' });
    fireEvent.click(within(trend).getByRole('button', { name: /joined in Sep 26/ }));
    expect(stored()).toMatchObject({ joinedFrom: '2026-09-01', joinedTo: '2026-09-30' });
  });

  it('bars are clickable where the list can express the bucket', async () => {
    await renderPage();
    expect(bars.props.find(p => p.dataKey === 'count').onClick).toEqual(expect.any(Function));
  });

  it.each(['Workforce Category', 'Age', 'Experience'])('%s has no drill (the list cannot filter it)', async (title) => {
    await renderPage();
    expect(within(card(title)).queryAllByRole('button', { name: /Open/ })).toEqual([]);
  });

  it('no drill while the population is the leavers (Status = Exited)', async () => {
    await renderPage();
    await waitFor(() => expect(selectFor('Status').options.length).toBeGreaterThan(1));
    fireEvent.change(selectFor('Status'), { target: { value: 'Exited' } });
    await waitFor(() => expect(lastParams()).toMatchObject({ status: 'Exited' }));
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /in All Employees/ })).toEqual([]));
  });
});

describe('without employees:view', () => {
  beforeEach(() => { auth.grants = new Set(['hr:view', 'employee_documents:view']); });

  it('charts render, read-only: no Open buttons and no clickable bars', async () => {
    await renderPage();
    expect(within(card('Department')).getByTestId('bar-count')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /in All Employees/ })).toEqual([]);
    expect(bars.props.every(p => p.onClick === undefined)).toBe(true);
    expect(document.querySelector('.wfa-caption').textContent).toMatch(/read-only for your role/);
  });

  it('All Employees and Ex-Employees links are hidden; Employee Documents stays', async () => {
    await renderPage();
    expect(screen.queryByRole('button', { name: /^All Employees/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Ex-Employees/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Employee Documents/ })).toBeTruthy();
  });
});

// ── Scope of this stage ───────────────────────────────────────────────────────
describe('scope', () => {
  it('requests only /analytics/workforce — no salary endpoint, no salary on the page', async () => {
    await renderPage();
    expect(api.get.mock.calls.every(([u]) => u === '/analytics/workforce')).toBe(true);
    expect(document.body.textContent).not.toMatch(/salary/i);
  });

  it('every Reports & Exports link targets a registered route, gated on that route\'s own module', () => {
    for (const link of REPORT_LINKS) {
      expect(ROUTES[link.page], `${link.page} must be a registered route`).toBeDefined();
      expect(link.module ?? null).toBe(ROUTES[link.page].module ?? null);
    }
  });

  it('keeps the existing Reports & Exports links', async () => {
    const setPage = await renderPage();
    for (const l of REPORT_LINKS) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${l.label}`) }));
      expect(setPage).toHaveBeenCalledWith(l.page);
    }
  });
});
