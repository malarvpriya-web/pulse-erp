import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';

// Attendance → Settings → Devices (§198): a device needs only its address, its
// status is only what a real check said, and Test reports what the server said.

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../services/api/client', () => ({ default: api }));

import DeviceManagement from '../features/attendance/pages/DeviceManagement';

const SEEDED = { id: 1, device_name: 'Main Gate - In', ip_address: '192.168.1.101', port: 4370, status: 'online', status_checked_at: null, last_sync: '2026-04-05T07:42:53Z', total_punches_today: '0' };
const CHECKED = { id: 2, device_name: 'Plant Gate', ip_address: '10.0.0.5', port: 4370, status: 'offline', status_checked_at: new Date().toISOString(), last_error: 'connect ETIMEDOUT', last_sync: null, total_punches_today: '0' };

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: [SEEDED, CHECKED] });
});

describe('Device Management', () => {
  it('a seeded "online" that no check confirmed reads Not verified — and is not counted online', async () => {
    render(<DeviceManagement />);
    const row = await screen.findByTestId('device-row-1');
    expect(within(row).getByText('Not verified')).toBeTruthy();
    const kpis = screen.getByTestId('device-kpis');
    const count = (label) => within(kpis).getByText(label).previousSibling.textContent;
    expect(count('Online')).toBe('0');
    expect(count('Not verified')).toBe('1');
    expect(count('Offline')).toBe('1');
    expect(within(screen.getByTestId('device-row-2')).getByText(/Last check: connect ETIMEDOUT/)).toBeTruthy();
  });

  it('⚠ Test Conn reports a device that answered as connected (it read a field the server never sends)', async () => {
    api.post.mockResolvedValueOnce({ data: { connected: true, status: 'online', ip_address: '10.0.0.5', port: 4370, latency_ms: 12 } });
    render(<DeviceManagement />);
    const row = await screen.findByTestId('device-row-2');
    fireEvent.click(within(row).getByText('Test Conn'));
    expect(await screen.findByText(/Connected to 10.0.0.5:4370 — 12ms response/)).toBeTruthy();
    await waitFor(() => expect(within(screen.getByTestId('device-row-2')).getByText('Online')).toBeTruthy());
  });

  it('registering needs only the IP: port and name fill themselves in, and Test works before saving', async () => {
    render(<DeviceManagement />);
    await screen.findByTestId('device-row-1');
    fireEvent.click(screen.getAllByText('Register Device')[0]);
    fireEvent.change(screen.getByLabelText('DEVICE IP ADDRESS *'), { target: { value: '192.168.1.50' } });

    api.post.mockResolvedValueOnce({ data: { connected: false, message: '192.168.1.50:4370 did not answer: ETIMEDOUT' } });
    fireEvent.click(screen.getByText('Test connection'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/biometric/devices/probe', { ip_address: '192.168.1.50', port: 4370 }));
    expect(await screen.findByText(/did not answer: ETIMEDOUT/)).toBeTruthy();
    // Said in the form, and in the page's setup hint.
    expect(screen.getAllByText(/Comm Key/).length).toBeGreaterThanOrEqual(2);

    api.post.mockResolvedValueOnce({ data: { id: 9, device_name: 'Device 192.168.1.50', ip_address: '192.168.1.50', port: 4370, status_checked_at: null } });
    fireEvent.click(screen.getAllByText('Register Device').at(-1));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/biometric/devices', expect.objectContaining({
      ip_address: '192.168.1.50', port: 4370, device_name: 'Device 192.168.1.50',
    })));
  });

  it('a vendor sync cannot read says so instead of claiming support', async () => {
    render(<DeviceManagement />);
    await screen.findByTestId('device-row-1');
    fireEvent.click(screen.getAllByText('Register Device')[0]);
    fireEvent.click(screen.getByText(/More details/));
    fireEvent.change(screen.getByLabelText('VENDOR'), { target: { value: 'Suprema' } });
    expect(screen.getByText(/Suprema devices cannot be synced from Pulse yet/)).toBeTruthy();
  });
});
