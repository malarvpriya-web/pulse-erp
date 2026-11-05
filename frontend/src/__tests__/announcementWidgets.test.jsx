/**
 * Announcement widgets — field mapping, sanitising, read receipts, Manager
 * quick-post (2026-10-21 safety pass).
 *
 *   - Home printed the message's HTML tags as text; the Employee Dashboard and
 *     Self Service read `description` / `date`, which the API never sends.
 *     All three now go through features/hr/announcementFeed.js.
 *   - Showing an announcement in a widget records NOTHING: an impression is not
 *     a read. Reads are recorded only by a deliberate open (My Announcements).
 *   - The Manager quick-post sent no dates and no audience, so every post was a
 *     400. It now sends a 7-day window addressed to the manager's department.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../pages/Home.css', () => ({}));
vi.mock('../pages/ManagerDashboard.css', () => ({}));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../components/dashboard/CelebrationsBoard', () => ({ default: () => <div /> }));
vi.mock('../components/attendance/CameraClockModal', () => ({ default: () => <div /> }));
vi.mock('../components/attendance/geo', () => ({ getLocationString: () => Promise.resolve('0,0') }));
vi.mock('recharts', () => {
  const Pass = ({ children }) => <div>{children}</div>;
  return { BarChart: Pass, Bar: Pass, XAxis: Pass, YAxis: Pass, CartesianGrid: Pass, Tooltip: Pass, ResponsiveContainer: Pass, Cell: Pass };
});

let mockAuth = { user: { name: 'Arun Kumar', email: 'arun@manifest.in', department: 'Operations' }, role: 'manager' };
vi.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }));

import api from '../services/api/client';
import { announcementText, announcementDate, announcementHtml } from '../features/hr/announcementFeed';
import Home from '../pages/Home.jsx';
import ManagerDashboard from '../pages/ManagerDashboard.jsx';

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth = { user: { name: 'Arun Kumar', email: 'arun@manifest.in', department: 'Operations' }, role: 'manager' };
  api.post.mockResolvedValue({ data: { success: true } });
});

describe('announcementFeed helpers', () => {
  it('reduces rich text to sanitised plain text', () => {
    const html = '<p>Office <b>closed</b> Friday</p><p>Canteen&nbsp;&amp; gym open</p>'
      + '<script>window.__x = 1</script><img src="x" onerror="window.__y = 1">';
    expect(announcementText(html)).toBe('Office closed Friday Canteen & gym open');
    expect(window.__x).toBeUndefined();
    expect(window.__y).toBeUndefined();
    expect(announcementText(null)).toBe('');
  });

  it('strips script and event handlers from HTML', () => {
    const out = announcementHtml('<p onclick="x()">Hi</p><script>bad()</script>');
    expect(out).toBe('<p>Hi</p>');
  });

  it('dates by publish time, else From date', () => {
    expect(announcementDate({ published_at: '2026-10-21T04:30:00.000Z' })).toMatch(/21 Oct 26/);
    expect(announcementDate({ from_date: '2026-10-25T00:00:00' })).toMatch(/25 Oct 26/);
    expect(announcementDate({})).toBe('');
  });
});

describe('Home announcements card', () => {
  const summary = (announcements) => ({
    identity: { name: 'Arun Kumar', email: 'arun@manifest.in' },
    myTasks: [], myApprovals: { awaitingMyAction: [], awaitingOthers: [] },
    announcements, policies: [], brandAssets: [], myAttendance: null,
  });

  it('renders the message as text (no tags) and records no read receipt for merely showing it', async () => {
    api.get.mockImplementation((url) => Promise.resolve({
      data: url === '/home/summary' ? summary([
        { id: 7, title: 'Holiday notice', message: '<p>Office <b>closed</b> Friday</p>', is_read: false, created_at: '2026-10-20T00:00:00Z' },
        { id: 8, title: 'Canteen', message: '<p>Already seen</p>', is_read: true, created_at: '2026-10-19T00:00:00Z' },
      ]) : [],
    }));
    render(<Home setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Office closed Friday')).toBeDefined());
    expect(screen.queryByText(/<p>|<b>/)).toBeNull();
    await new Promise(r => setTimeout(r, 50));
    expect(api.post.mock.calls.filter(([url]) => /^\/announcements\/\d+\/read$/.test(url))).toEqual([]);
  });

  it('clicking an announcement opens it in full on My Announcements (?ref), like the bell', async () => {
    api.get.mockImplementation((url) => Promise.resolve({
      data: url === '/home/summary' ? summary([
        { id: 7, title: 'Holiday notice', message: '<p>Office closed Friday</p>', is_read: false, created_at: '2026-10-20T00:00:00Z' },
        { id: 8, title: 'Canteen', message: '<p>New menu</p>', is_read: true, created_at: '2026-10-19T00:00:00Z' },
      ]) : [],
    }));
    const setPage = vi.fn();
    render(<Home setPage={setPage} />);
    const row = (await screen.findByText('Holiday notice')).closest('[role="button"]');
    expect(row).not.toBeNull();
    fireEvent.click(row);
    expect(setPage).toHaveBeenLastCalledWith('MyAnnouncements', { ref: 7 });

    // Keyboard: Enter and Space open it too.
    const other = screen.getByText('Canteen').closest('[role="button"]');
    fireEvent.keyDown(other, { key: 'Enter' });
    expect(setPage).toHaveBeenLastCalledWith('MyAnnouncements', { ref: 8 });
    fireEvent.keyDown(row, { key: ' ' });
    expect(setPage).toHaveBeenLastCalledWith('MyAnnouncements', { ref: 7 });
    expect(setPage).toHaveBeenCalledTimes(3);
    // Home itself still records nothing — the read happens on the page it opens.
    expect(api.post.mock.calls.filter(([url]) => /^\/announcements\/\d+\/read$/.test(url))).toEqual([]);
  });

  it('"View all" opens My Announcements — shown even when there are no active announcements', async () => {
    api.get.mockImplementation((url) => Promise.resolve({
      data: url === '/home/summary' ? summary([]) : [],
    }));
    const setPage = vi.fn();
    render(<Home setPage={setPage} />);
    await screen.findByText('No active announcements.');
    fireEvent.click(screen.getByRole('button', { name: /^view all$/i }));
    expect(setPage).toHaveBeenLastCalledWith('MyAnnouncements');
  });
});

describe('Manager quick-post', () => {
  beforeEach(() => { api.get.mockResolvedValue({ data: [] }); });

  const post = async (text) => {
    render(<ManagerDashboard setPage={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /^announcement$/i }));
    fireEvent.change(screen.getByPlaceholderText(/type your announcement/i), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: /post announcement/i }));
  };

  it('sends valid dates and addresses the manager\'s own department', async () => {
    await post('Shift change <tomorrow> & briefing');
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/announcements', expect.any(Object)));
    const [, payload] = api.post.mock.calls.find(([url]) => url === '/announcements');
    expect(payload).toMatchObject({ target_type: 'department', target_value: 'Operations', is_active: true });
    expect(payload.from_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.to_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.to_date > payload.from_date).toBe(true);
    expect(payload.message).toBe('<p>Shift change &lt;tomorrow&gt; &amp; briefing</p>');
  });

  it('does not post when the manager has no department on record', async () => {
    mockAuth = { user: { name: 'No Dept', email: 'nd@manifest.in' }, role: 'manager' };
    await post('Hello');
    await new Promise(r => setTimeout(r, 50));
    expect(api.post.mock.calls.filter(([url]) => url === '/announcements')).toHaveLength(0);
  });
});
