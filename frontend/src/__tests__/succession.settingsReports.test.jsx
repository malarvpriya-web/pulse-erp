/**
 * Succession Settings and Reports screens (§210), against a mocked API.
 *
 *  - Settings shows the SAVED HiPo thresholds after a reload. The server now
 *    returns hiPo_threshold_*; this pins that the screen reads exactly those.
 *  - A failed settings load shows an error and offers no Save (it used to show
 *    the defaults as if saved, and Save wrote them back).
 *  - Reports: coverage reads Ready Now / Developing / No Successor, never
 *    "Covered"; the Talent Risk highlight follows the saved threshold; Export
 *    is server-only, so a refused export produces no file and shows the reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
const auth = vi.hoisted(() => ({ canExport: true }));
vi.mock('@/services/api/client', () => ({ default: api }));
vi.mock('@/config/roleCatalog', () => ({ useRoleCatalog: () => [{ code: 'hr', label: 'HR' }] }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => m === 'succession' && (a !== 'export' || auth.canExport) }),
}));

import SuccessionSettings from '../features/hr/pages/SuccessionSettings';
import SuccessionReports from '../features/hr/pages/SuccessionReports';
import { downloadSuccessionCsv } from '../features/hr/utils/successionCsv';

const SAVED = {
  zero_successor_alert: false, single_successor_alert: true, flight_risk_threshold: 'medium',
  review_frequency: 'monthly', notify_roles: ['hr'], hiPo_threshold_potential: 5, hiPo_threshold_performance: 2,
};

beforeEach(() => { api.get.mockReset(); api.put.mockReset(); auth.canExport = true; document.body.innerHTML = ''; });

describe('SuccessionSettings', () => {
  it('shows the saved thresholds and selections after a reload', async () => {
    api.get.mockResolvedValue({ data: SAVED });
    render(<SuccessionSettings />);
    expect(await screen.findByText(/Potential Score ≥ 5/)).toBeTruthy();
    expect(screen.getByText(/Performance Score ≥ 2/)).toBeTruthy();
    expect(screen.getByDisplayValue('Medium (medium + high)')).toBeTruthy();
    expect(screen.getByDisplayValue('Monthly')).toBeTruthy();
  });

  it('saves the whole screen and then shows what the server stored', async () => {
    api.get.mockResolvedValue({ data: SAVED });
    api.put.mockImplementation(async (_url, body) => ({ data: body }));
    render(<SuccessionSettings />);
    await screen.findByText(/Potential Score ≥ 5/);
    fireEvent.change(screen.getByDisplayValue('Monthly'), { target: { value: 'annually' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put.mock.calls[0][1]).toMatchObject({ ...SAVED, review_frequency: 'annually' });
    expect(await screen.findByText('Settings saved')).toBeTruthy();
  });

  it('an alert switch toggles from its label text and is a real switch', async () => {
    api.get.mockResolvedValue({ data: SAVED });
    api.put.mockImplementation(async (_url, body) => ({ data: body }));
    render(<SuccessionSettings />);
    await screen.findByText(/Potential Score ≥ 5/);
    const sw = screen.getByRole('switch', { name: /Single Successor Alert/ });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('Single Successor Alert'));
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put.mock.calls[0][1]).toMatchObject({ single_successor_alert: false, zero_successor_alert: false });
  });

  it('a failed load says so and offers no Save', async () => {
    api.get.mockRejectedValue({ response: { data: { message: 'Succession data needs a company' } } });
    render(<SuccessionSettings />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Succession data needs a company/);
    expect(screen.queryByRole('button', { name: 'Save Settings' })).toBeNull();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('does not claim that alerts are sent', async () => {
    api.get.mockResolvedValue({ data: SAVED });
    render(<SuccessionSettings />);
    await screen.findByText(/Potential Score ≥ 5/);
    expect(document.body.textContent).not.toMatch(/receive succession alerts|will not be sent to anyone/);
    expect(document.body.textContent).toMatch(/no message is sent/i);
    expect(document.body.textContent).not.toMatch(/when notifications are switched on|notification preferences/);
  });
});

describe('SuccessionReports', () => {
  const BENCH = [
    { role_title: 'CFO', risk_level: 'high', successor_count: 2, ready_now: 1, ready_1_2yr: 0, ready_3_5yr: 1, coverage_status: 'Ready Now' },
    { role_title: 'Head Eng', risk_level: 'high', successor_count: 1, ready_now: 0, ready_1_2yr: 0, ready_3_5yr: 0, not_ready: 0, ready_unclassified: 1, coverage_status: 'Developing' },
    { role_title: 'VP Sales', risk_level: 'medium', successor_count: 0, ready_now: 0, ready_1_2yr: 0, ready_3_5yr: 0, coverage_status: 'No Successor' },
  ];
  const RISK = [
    { employee_name: 'Asha', flight_risk: 'medium', performance_score: '3.00', potential_score: 3 },
    { employee_name: 'Bala', flight_risk: 'low', performance_score: '3.00', potential_score: 3 },
  ];
  const routes = (url) => {
    if (url === '/succession/settings') return { data: SAVED };
    if (url === '/succession/reports/bench-strength') return { data: BENCH };
    if (url === '/succession/reports/talent-risk') return { data: RISK };
    return { data: [] };
  };

  it('coverage is the three states, never "Covered"', async () => {
    api.get.mockImplementation(async (url) => routes(url));
    render(<SuccessionReports />);
    await screen.findByText('CFO');
    const badges = [...document.querySelectorAll('td span')].map(el => el.textContent);
    expect(badges).toEqual(expect.arrayContaining(['Ready Now', 'Developing', 'No Successor']));
    expect(screen.queryByText('Covered')).toBeNull();
  });

  it('Bench Strength shows Not Ready and Unclassified columns, so the readiness columns add up', async () => {
    api.get.mockImplementation(async (url) => routes(url));
    render(<SuccessionReports />);
    await screen.findByText('CFO');
    const heads = [...document.querySelectorAll('th')].map(th => th.textContent);
    expect(heads).toEqual(expect.arrayContaining(['Not Ready', 'Unclassified']));
    const cells = [...screen.getByText('Head Eng').closest('tr').querySelectorAll('td')].map(td => td.textContent);
    const at = (h) => cells[heads.indexOf(h)];
    expect([at('Successors'), at('Ready Now'), at('Unclassified')]).toEqual(['1', '0', '1']);
  });

  it('an invalid stored readiness reads Unclassified, not the raw value', async () => {
    api.get.mockImplementation(async (url) => (url === '/succession/reports/talent-risk'
      ? { data: [{ employee_name: 'Esha', flight_risk: 'low', readiness: 'SEED readiness level', performance_score: '3.00', potential_score: 3 }] }
      : routes(url)));
    render(<SuccessionReports />);
    fireEvent.click(await screen.findByText('Talent Risk'));
    const row = (await screen.findByText('Esha')).closest('tr');
    expect(row.textContent).toContain('Unclassified');
    expect(row.textContent).not.toContain('SEED readiness level');
  });

  it('Talent Risk highlights rows at or above the saved threshold (medium)', async () => {
    api.get.mockImplementation(async (url) => routes(url));
    render(<SuccessionReports />);
    fireEvent.click(await screen.findByText('Talent Risk'));
    const asha = (await screen.findByText('Asha')).closest('tr');
    const bala = screen.getByText('Bala').closest('tr');
    await waitFor(() => expect(asha.style.background).not.toBe('transparent'));
    expect(bala.style.background).toBe('transparent');
  });

  it('Export CSV is hidden without succession:export', async () => {
    auth.canExport = false;
    api.get.mockImplementation(async (url) => routes(url));
    render(<SuccessionReports />);
    await screen.findByText('CFO');
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });

  it('a refused export shows the reason and builds no file in the browser', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn();
    api.get.mockImplementation(async (url, cfg) => {
      if (cfg?.params?.format === 'csv') {
        throw { response: { status: 403, data: new Blob([JSON.stringify({ message: 'Permission denied: succession export' })]) } };
      }
      return routes(url);
    });
    render(<SuccessionReports />);
    await screen.findByText('CFO');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Permission denied: succession export')).toBeTruthy();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe('downloadSuccessionCsv', () => {
  it('asks the server for format=csv as a blob', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();
    api.get.mockResolvedValue({ data: new Blob(['a,b']) });
    await downloadSuccessionCsv('bench-strength', 'bench_strength.csv');
    expect(api.get).toHaveBeenCalledWith('/succession/reports/bench-strength', { params: { format: 'csv' }, responseType: 'blob' });
  });
});
