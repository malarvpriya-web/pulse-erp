/**
 * Performance Settings — a failed read must never become a save (2026-10-29).
 *
 * POST /settings/performance REPLACES the stored blob. The page used to render
 * its form (and an enabled Save) with `{}` while loading and after a swallowed
 * load failure, so Save wiped every saved key. Now the form exists only after a
 * successful read; GET answers 200 {} for "nothing saved" and 500 for a failed
 * read (manual §200). Stubs return the api client's real shape: the axios
 * response, whose `data` is the settings object itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../context/ToastContext', () => ({ useToast: () => toast }));

import api from '../services/api/client';
import PerformanceSettings from '../features/performance/pages/PerformanceSettings';

const fail = (status, message) => Promise.reject({ response: { status, data: { message } }, message: `HTTP ${status}` });
const save = () => screen.queryByRole('button', { name: 'Save Settings' });

// GET /settings/performance answers `settingsResponse`; an existing cycle means
// Save does not try to create one.
function stub(settingsResponse) {
  api.get.mockImplementation((url) => (url === '/settings/performance'
    ? settingsResponse()
    : Promise.resolve({ data: [{ id: 1 }] })));
  api.post.mockResolvedValue({ data: { success: true } });
}

beforeEach(() => { api.get.mockReset(); api.post.mockReset(); toast.success.mockReset(); toast.error.mockReset(); });

describe('PerformanceSettings load', () => {
  it('while loading there is no form and no Save', () => {
    stub(() => new Promise(() => {}));   // never settles
    render(<PerformanceSettings />);
    expect(screen.getByText('Loading settings…')).toBeTruthy();
    expect(save()).toBeNull();
    expect(screen.queryByText('Review Cycle')).toBeNull();
  });

  it('an empty configuration (200 {}) shows the form and can be saved', async () => {
    stub(() => Promise.resolve({ data: {} }));
    render(<PerformanceSettings />);
    expect(await screen.findByText('Review Cycle')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(save());
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/settings/performance', {}));
  });

  it('a database/API failure (500) shows the error and Retry, hides the form, and offers no Save', async () => {
    stub(() => fail(500, 'Saved settings could not be read'));
    render(<PerformanceSettings />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load the saved Performance settings \(Saved settings could not be read\)/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('Review Cycle')).toBeNull();
    expect(save()).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([
    ['an HTML error page', '<html>502 Bad Gateway</html>'],
    ['an array', []],
  ])('a malformed 200 (%s) is a failed load', async (_label, body) => {
    stub(() => Promise.resolve({ data: body }));
    render(<PerformanceSettings />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/not a settings object/);
    expect(save()).toBeNull();
    expect(screen.queryByText('Review Cycle')).toBeNull();
  });

  it('Retry loads the saved settings and only then offers Save', async () => {
    let calls = 0;
    stub(() => (++calls === 1 ? fail(500, 'boom') : Promise.resolve({ data: { cycle_frequency: 'Quarterly' } })));
    render(<PerformanceSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Review Cycle')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByDisplayValue('Quarterly')).toBeTruthy();
    expect(save()).toBeTruthy();
  });
});

describe('PerformanceSettings save', () => {
  it('keeps every loaded key — including ones this screen does not show — and adds the edit', async () => {
    stub(() => Promise.resolve({ data: { cycle_frequency: 'Annual', pip_trigger_rating: '2', legacy_flag: true, other_screen_key: 'x' } }));
    render(<PerformanceSettings />);
    fireEvent.change(await screen.findByDisplayValue('Annual'), { target: { value: 'Quarterly' } });
    fireEvent.click(save());
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/settings/performance', {
      cycle_frequency: 'Quarterly', pip_trigger_rating: '2', legacy_flag: true, other_screen_key: 'x',
    }));
    expect(toast.success).toHaveBeenCalledWith('Performance settings saved');
  });

  it('after a failed read nothing can be saved: no Save control and no POST', async () => {
    stub(() => fail(500, 'boom'));
    render(<PerformanceSettings />);
    await screen.findByRole('alert');
    expect(save()).toBeNull();
    // Nothing on the page can post settings.
    for (const b of screen.getAllByRole('button')) fireEvent.click(b);   // only Retry exists
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));       // Retry re-read
    expect(api.post).not.toHaveBeenCalled();
  });
});
