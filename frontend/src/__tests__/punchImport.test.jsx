import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';

// Attendance → Punch Import (§272; was the Attendance Import tab of HR →
// Biometric & Access Control, MODULE_FEATURE_CONNECTION_MANUAL.md §197).
// These pin the page-side defects that were fixed:
//   * an empty answer clears a table (it used to keep the previous rows), and
//     every filter is SENT to the server — the dataset changes, not just the UI;
//   * device status is "Not verified" until a real test/sync set it;
//   * sync and every write show the SERVER's reason, never a bare "Failed";
//   * CSV import previews with a dry run and imports only on confirm.
// Gate passes and visitors: gateAccess.test.jsx.

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true, role: 'hr', roles: ['hr'] }),
}));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../services/api/client', () => ({ default: api }));

import PunchImport from '../features/attendance/pages/PunchImport';

const DASH = {
  date: '2026-10-28', non_working_day: null, total_employees: 32, on_leave: 2, expected: 30,
  punched_in_today: 12, not_yet_punched: 18, late_arrivals: 3, early_departures: 1,
  visitors_inside: 2, visitors_overdue: 1, rules: { work_start: '09:00:00', work_end: '18:00:00', grace_minutes: 10 },
};
const EMPLOYEES = [
  { id: 7, name: 'Asha Rao', emp_code: 'EMP007', department: 'Ops' },
  { id: 9, name: 'Bala K', emp_code: 'EMP009', department: 'Sales' },
];
const DEVICES = [
  { id: 1, device_name: 'Main Gate - In', ip_address: '192.168.1.101', port: 4370, status: 'online', status_checked_at: null, last_sync: '2026-04-05T07:42:53Z', total_punches_today: '0' },
  { id: 2, device_name: 'Plant Gate', ip_address: '10.0.0.5', port: 4370, status: 'offline', status_checked_at: new Date().toISOString(), last_error: 'ETIMEDOUT', last_sync: null, total_punches_today: '0' },
];
const LOG_ROW = { id: 31, employee_id: 7, employee_name: 'Asha Rao', emp_code: 'EMP007', department: 'Ops', punch_time: '2026-10-28T03:35:00Z', punch_type: 'in', device_name: 'Main Gate - In', source: 'csv_import' };

let logsResponse;
function serve() {
  logsResponse = { rows: [LOG_ROW], total: 1, page: 1, page_size: 50 };
  api.get.mockImplementation((url, cfg) => {
    if (url === '/biometric/dashboard') return Promise.resolve({ data: DASH });
    if (url === '/biometric/employees/options') return Promise.resolve({ data: EMPLOYEES });
    if (url === '/biometric/devices') return Promise.resolve({ data: DEVICES });
    if (url === '/biometric/logs') {
      return Promise.resolve({ data: cfg?.params?.employee_id ? { rows: [], total: 0, page: 1, page_size: 50 } : logsResponse });
    }
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  serve();
});

const lastGetParams = (url) => [...api.get.mock.calls].reverse().find(([u]) => u === url)?.[1]?.params;

describe('cards and devices', () => {
  it('cards read the dashboard, with the population they are measured against', async () => {
    render(<PunchImport />);
    const cards = await screen.findByTestId('bio-cards');
    await waitFor(() => expect(within(cards).getByText('18')).toBeTruthy());
    expect(within(cards).getByText('of 30 expected')).toBeTruthy();
    expect(within(cards).getByText('2 on approved leave')).toBeTruthy();
    expect(within(cards).getByText('after 09:00 + 10 min')).toBeTruthy();
  });

  it('on a holiday, Not Punched says so instead of counting everyone', async () => {
    api.get.mockImplementation((url) => url === '/biometric/dashboard'
      ? Promise.resolve({ data: { ...DASH, non_working_day: 'Holiday — Diwali', not_yet_punched: null } })
      : Promise.resolve({ data: url === '/biometric/devices' ? [] : { rows: [], total: 0 } }));
    render(<PunchImport />);
    expect((await screen.findAllByText('Holiday — Diwali')).length).toBeGreaterThan(0);
  });

  it('a device no test or sync has checked reads "Not verified", not a green "online"', async () => {
    render(<PunchImport />);
    const seeded = await screen.findByTestId('device-1');
    expect(within(seeded).getByText('Not verified')).toBeTruthy();
    expect(within(seeded).queryByText('Online')).toBeNull();
    const checked = screen.getByTestId('device-2');
    expect(within(checked).getByText('Offline')).toBeTruthy();
    expect(within(checked).getByText(/ETIMEDOUT/)).toBeTruthy();
    expect(within(checked).getByText(/Last sync: Never/)).toBeTruthy();
  });

  it('sync shows the server\'s own outcome — success and failure', async () => {
    api.post.mockResolvedValueOnce({ data: { message: 'Main Gate - In: 4 punch(es) received — 3 applied to attendance' } });
    render(<PunchImport />);
    const dev = await screen.findByTestId('device-1');
    fireEvent.click(within(dev).getByText('↻ Sync Now'));
    expect(await within(dev).findByText(/3 applied to attendance/)).toBeTruthy();

    api.post.mockRejectedValueOnce({ response: { status: 502, data: { message: 'Could not read Plant Gate at 10.0.0.5:4370 — ETIMEDOUT. No punches were imported.' } } });
    const dev2 = screen.getByTestId('device-2');
    fireEvent.click(within(dev2).getByText('↻ Sync Now'));
    expect(await within(dev2).findByText(/No punches were imported/)).toBeTruthy();
  });
});

describe('punch log filters', () => {
  it('sends the filter to the server, and an empty answer CLEARS the table', async () => {
    render(<PunchImport />);
    const table = await screen.findByTestId('punch-log');
    await within(table).findByText('Asha Rao');
    const bar = screen.getByTestId('log-filters');
    fireEvent.change(within(bar).getAllByRole('combobox')[0], { target: { value: '9' } });
    await waitFor(() => expect(lastGetParams('/biometric/logs')).toMatchObject({ employee_id: '9' }));
    expect(await within(table).findByText(/No punches match these filters/)).toBeTruthy();
    expect(within(table).queryByText('Asha Rao')).toBeNull();

    fireEvent.click(within(table).getByText('Clear filters'));
    await within(table).findByText('Asha Rao');
    expect(lastGetParams('/biometric/logs').employee_id).toBeUndefined();
  });

  it('defaults to today and sends the date range', async () => {
    render(<PunchImport />);
    await screen.findByTestId('punch-log');
    const p = lastGetParams('/biometric/logs');
    expect(p.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.to).toBe(p.from);
  });
});

describe('CSV import', () => {
  const pick = (name, text, type = 'text/csv') => {
    const input = document.getElementById('csv-upload');
    fireEvent.change(input, { target: { files: [new File([text], name, { type })] } });
  };

  it('refuses a non-CSV file before reading it', async () => {
    render(<PunchImport />);
    await screen.findByTestId('csv-drop');
    pick('photo.png', 'x', 'image/png');
    expect(await screen.findByText(/is not a CSV file/)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('previews with a dry run, then imports on confirm', async () => {
    api.post.mockResolvedValueOnce({ data: {
      dry_run: true, total_rows: 3, valid_rows: 2, attendance_updated: 2, duplicates: 0, attendance_locked: 0,
      errors: ['Row 3: unknown employee EMP999'],
      preview: [{ row: 1, employee_id: 7, employee_key: 'EMP007', punch_time: '2026-10-27T03:35:00Z', punch_type: 'in', outcome: 'applied' }],
    } });
    render(<PunchImport />);
    await screen.findByTestId('csv-drop');
    pick('punches.csv', 'employee_id,punch_time,punch_type\nEMP007,2026-10-27 09:05,in\n');
    const preview = await screen.findByTestId('import-preview');
    expect(api.post).toHaveBeenLastCalledWith('/biometric/logs/import', expect.objectContaining({ dry_run: true }));
    expect(within(preview).getByText('Row 3: unknown employee EMP999')).toBeTruthy();
    expect(within(preview).getByText('Updates attendance')).toBeTruthy();

    api.post.mockResolvedValueOnce({ data: { imported: 2, attendance_updated: 2, duplicates: 0, attendance_locked: 0, errors: ['Row 3: unknown employee EMP999'] } });
    fireEvent.click(within(preview).getByText('✓ Import 2 punch(es)'));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/biometric/logs/import', expect.objectContaining({ dry_run: false })));
    expect(await screen.findByText(/Imported 2 punch\(es\): 2 applied to attendance, 1 row\(s\) skipped/)).toBeTruthy();
  });

  it('shows the server\'s reason when the file is rejected outright', async () => {
    api.post.mockRejectedValueOnce({ response: { status: 400, data: { message: 'CSV must have employee_id, punch_time and punch_type columns — missing: punch_type' } } });
    render(<PunchImport />);
    await screen.findByTestId('csv-drop');
    pick('bad.csv', 'employee_id,punch_time\nEMP007,2026-10-27 09:05\n');
    expect(await screen.findByText(/missing: punch_type/)).toBeTruthy();
  });
});
