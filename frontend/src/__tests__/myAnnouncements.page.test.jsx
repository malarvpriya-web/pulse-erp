/**
 * My Announcements (read = a deliberate open) and useAnnouncements' cache
 * isolation across identities (2026-10-21).
 *
 *   - Listing announcements records nothing. Expanding one, or arriving from the
 *     bell with ?ref=<id>, records the caller's read — once.
 *   - A ?ref the caller cannot see shows a notice and nothing else.
 *   - useAnnouncements' 30 s cache belongs to one identity (user, company, roles,
 *     token). Switching identity in the same tab — no reload, module state
 *     survives — must never show the previous user's list, including from a
 *     request that was still in flight when the switch happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../features/hr/pages/MyAnnouncements.css', () => ({}));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const authState = vi.hoisted(() => ({ value: null }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => authState.value }));

import api from '../services/api/client';
import MyAnnouncements from '../features/hr/pages/MyAnnouncements.jsx';
import { useAnnouncements, clearAnnouncementCache, announcementCacheKey } from '../hooks/useAnnouncements';

const ANN = [
  { id: 7, title: 'Holiday notice', message: '<p>Office <b>closed</b> Friday</p>', is_read: false, priority: 'high', from_date: '2026-10-20T00:00:00' },
  { id: 8, title: 'Canteen menu', message: '<p>New menu</p>', is_read: true, priority: 'medium', from_date: '2026-10-19T00:00:00' },
];
const readCalls = () => api.post.mock.calls.filter(([url]) => /^\/announcements\/\d+\/read$/.test(url)).map(([url]) => url);

const renderPage = (search = '') => render(
  <MemoryRouter initialEntries={[`/MyAnnouncements${search}`]}><MyAnnouncements /></MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: ANN });
  api.post.mockResolvedValue({ data: { success: true } });
});

describe('My Announcements — read means opened', () => {
  it('lists without recording any read, and keeps bodies closed', async () => {
    renderPage();
    await screen.findByText('Holiday notice');
    expect(screen.getByText('Canteen menu')).toBeDefined();
    expect(screen.queryByText(/Office/)).toBeNull();
    await new Promise(r => setTimeout(r, 30));
    expect(readCalls()).toEqual([]);
  });

  it('opening an unread one shows the sanitised body and records the read once', async () => {
    renderPage();
    const head = await screen.findByRole('button', { name: /Holiday notice/ });
    fireEvent.click(head);
    expect(await screen.findByText(/Office/)).toBeDefined();
    await waitFor(() => expect(readCalls()).toEqual(['/announcements/7/read']));
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head); fireEvent.click(head);            // close + reopen
    await new Promise(r => setTimeout(r, 30));
    expect(readCalls()).toEqual(['/announcements/7/read']);   // now read: not sent again
  });

  it('opening an already-read one records nothing', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Canteen menu/ }));
    await screen.findByText('New menu');
    await new Promise(r => setTimeout(r, 30));
    expect(readCalls()).toEqual([]);
  });

  it('arriving from the bell (?ref) opens it and records the read once', async () => {
    renderPage('?ref=7');
    expect(await screen.findByText(/Office/)).toBeDefined();
    await waitFor(() => expect(readCalls()).toEqual(['/announcements/7/read']));
    await new Promise(r => setTimeout(r, 30));
    expect(readCalls()).toHaveLength(1);
  });

  it('a ref the caller cannot see shows a notice and records nothing', async () => {
    renderPage('?ref=99');
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(readCalls()).toEqual([]);
  });

  it('a failing read receipt does not break the page', async () => {
    api.post.mockRejectedValue(new Error('offline'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Holiday notice/ }));
    expect(await screen.findByText(/Office/)).toBeDefined();
  });
});

// ── cache isolation ──────────────────────────────────────────────────────────

function Probe() {
  const { items, loading } = useAnnouncements(5);
  return <div data-testid="probe">{loading ? 'loading' : items.map(i => i.title).join('|') || 'empty'}</div>;
}
const userA = { user: { id: 11, name: 'A' }, roles: ['employee'], token: 'tok-A' };
const userB = { user: { id: 22, name: 'B' }, roles: ['employee'], token: 'tok-B' };
const listFor = (who) => [{ id: who === 'A' ? 1 : 2, title: `For ${who}` }];

describe('useAnnouncements cache is per identity', () => {
  beforeEach(() => { clearAnnouncementCache(); });

  it('the key separates user, roles and session', () => {
    const k = announcementCacheKey;
    expect(k(userA.user, ['employee'], 'tok-A')).not.toBe(k(userB.user, ['employee'], 'tok-B'));
    expect(k(userA.user, ['employee'], 'tok-A')).not.toBe(k(userA.user, ['hr'], 'tok-A'));
    expect(k(userA.user, ['employee'], 'tok-A')).not.toBe(k(userA.user, ['employee'], 'tok-A2'));
    expect(k(null, [], null)).toBeNull();
  });

  it('switching identity in the same tab refetches and never shows the previous list', async () => {
    api.get.mockImplementation(() => Promise.resolve({ data: listFor(authState.value.token === 'tok-A' ? 'A' : 'B') }));
    authState.value = userA;
    const { rerender } = render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('For A'));

    authState.value = userB;                       // sign-out / sign-in, no reload
    rerender(<Probe />);
    expect(screen.getByTestId('probe').textContent).not.toContain('For A');
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('For B'));
    expect(api.get).toHaveBeenCalledTimes(2);

    // A fresh mount for B inside the TTL reuses B's entry — and only B's.
    render(<Probe />);
    await waitFor(() => expect(screen.getAllByTestId('probe')[1].textContent).toBe('For B'));
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('a response for A that lands after switching to B is discarded', async () => {
    let releaseA;
    api.get.mockImplementationOnce(() => new Promise(r => { releaseA = () => r({ data: listFor('A') }); }))
           .mockImplementationOnce(() => Promise.resolve({ data: listFor('B') }));
    authState.value = userA;
    const { rerender } = render(<Probe />);
    authState.value = userB;
    rerender(<Probe />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('For B'));
    await act(async () => { releaseA(); await Promise.resolve(); });
    expect(screen.getByTestId('probe').textContent).toBe('For B');

    // …and it did not poison the slot: another B mount sees B without a refetch.
    render(<Probe />);
    await waitFor(() => expect(screen.getAllByTestId('probe')[1].textContent).toBe('For B'));
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('a signed-out state shows nothing and fetches nothing', async () => {
    authState.value = { user: null, roles: [], token: null };
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('empty');
    expect(api.get).not.toHaveBeenCalled();
  });
});
