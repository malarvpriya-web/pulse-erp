/**
 * My Timesheet, pre-filled from attendance (2026-11-11).
 * The page shows the server's pre-fill, lets the employee change a figure, and
 * submits the week in one call; a submitted week is read-only; someone on no
 * project is told why the page is empty. No Clock In any more.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@/services/api/client', () => ({ default: api }));

import MyTimesheet from '@/features/timesheets/pages/MyTimesheet';

const day = (date, hours, source, split = {}) => ({ date, weekday: '', hours, source, split });
const WEEK = {
  week_start: '2031-03-03', week_end: '2031-03-09', full_day_hours: 8, auto_submit_on: '2031-03-10',
  projects: [{ id: 11, project_code: 'PA', project_name: 'Plant A', allocation_pct: 100 }],
  days: [
    day('2031-03-03', 9.5, 'punch', { 11: 9.5 }), day('2031-03-04', 8, 'standard', { 11: 8 }),
    day('2031-03-05', 0, 'leave'), day('2031-03-06', 8, 'standard', { 11: 8 }), day('2031-03-07', 0, 'holiday'),
    day('2031-03-08', 0, 'weekend'), day('2031-03-09', 0, 'weekend'),
  ],
  entries: [], status: 'not_started',
};

beforeEach(() => { api.get.mockReset(); api.put.mockReset(); document.body.innerHTML = ''; });

describe('My Timesheet', () => {
  it('shows the pre-fill and submits the week, with the employee\'s change', async () => {
    api.get.mockResolvedValue({ data: WEEK });
    api.put.mockImplementation(async (_url, body) => ({ data: { ...WEEK, status: 'submitted', entries: body.rows.map((r, i) => ({ id: i + 1, work_date: r.work_date, project_id: r.project_id, hours_worked: r.hours, status: 'submitted' })) } }));
    render(<MyTimesheet />);
    const tue = await screen.findByLabelText('Plant A hours on 2031-03-04');
    expect(tue.value).toBe('8');
    expect(screen.getByText('Punched')).toBeTruthy();
    expect(screen.getByText('On leave')).toBeTruthy();
    expect(screen.queryByText(/clock in/i)).toBeNull();

    fireEvent.change(tue, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /submit week/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe('/timesheets/timesheets/my-week');
    expect(body.submit).toBe(true);
    expect(body.week_start).toBe('2031-03-03');
    expect(body.rows).toEqual([
      { work_date: '2031-03-03', project_id: 11, hours: 9.5 },
      { work_date: '2031-03-04', project_id: 11, hours: 6 },
      { work_date: '2031-03-06', project_id: 11, hours: 8 },
    ]);
    // Submitted: read-only, no submit button.
    await screen.findByText(/waiting for your manager/i);
    expect(screen.queryByLabelText('Plant A hours on 2031-03-04')).toBeNull();
    expect(screen.queryByRole('button', { name: /submit week/i })).toBeNull();
  });

  it('tells someone on no project why the page is empty', async () => {
    api.get.mockResolvedValue({ data: { ...WEEK, projects: [] } });
    render(<MyTimesheet />);
    expect(await screen.findByText(/not on a project this week/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /submit week/i })).toBeNull();
  });

  it('shows the manager\'s reason on a sent-back week and lets it be edited again', async () => {
    api.get.mockResolvedValue({ data: { ...WEEK, status: 'rejected', rejection_reason: 'Tue was on B',
      entries: [{ id: 1, work_date: '2031-03-04', project_id: 11, hours_worked: 8, status: 'rejected' }] } });
    render(<MyTimesheet />);
    expect(await screen.findByText(/Reason: Tue was on B/)).toBeTruthy();
    // Saved entries win over the pre-fill: only Tuesday has hours.
    expect(screen.getByLabelText('Plant A hours on 2031-03-04').value).toBe('8');
    expect(screen.getByLabelText('Plant A hours on 2031-03-03').value).toBe('');
  });
});
