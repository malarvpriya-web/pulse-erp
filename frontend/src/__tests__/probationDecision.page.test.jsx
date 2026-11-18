/**
 * Probation Management — the one decision path (2026-11-11).
 *
 *  - An employee with no open review gets "Request review" (hr:add); it posts
 *    to /probation-reviews and the page reloads. A department with no usable
 *    head disables it and says why, with a banner pointing to Department Heads.
 *  - A SUBMITTED review shows the head's recommendation and "Record decision"
 *    (hr:edit). The form starts on the head's recommendation, needs a reason
 *    to extend or not confirm, and posts to /probation-reviews/:id/decide.
 *  - Decided reviews are listed under History.
 *  - The reminder log no longer offers "Record Decision".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../features/hr/pages/Probation.css', () => ({}));
const auth = vi.hoisted(() => ({ grants: new Set() }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }),
}));
vi.mock('../components/ResultDialog', () => ({
  default: ({ dialog }) => (dialog ? <div role="status" data-dialog="1">{dialog.title}: {dialog.message}</div> : null),
}));

import api from '../services/api/client';
import Probation from '../features/hr/pages/Probation.jsx';

const EMPS = [
  { id: 1, office_id: 'EMP101', first_name: 'Neha', last_name: 'Iyer', status: 'Probation', department: 'Finance',
    joining_date: '2026-06-01', probation_end_date: '2026-11-30' },
  { id: 2, office_id: 'EMP102', first_name: 'Ravi', last_name: 'Das', status: 'Probation', department: 'Sales',
    joining_date: '2026-06-01', probation_end_date: '2026-11-30' },
  { id: 3, office_id: 'EMP103', first_name: 'Sita', last_name: 'Pai', status: 'Probation', department: 'Finance',
    joining_date: '2026-06-01', probation_end_date: '2026-12-31' },
];
const SUBMITTED = {
  id: 77, employee_id: 3, employee: 'Sita Pai', office_id: 'EMP103', status: 'submitted', reviewer: 'Asha Rao',
  rating: 3, recommendation: 'extend', comments: 'Needs more time on month-end close.',
  original_end_date: '2026-12-31', submitted_at: '2026-11-10T10:00:00Z', reviewer_due_date: '2026-12-31',
};
const DECIDED = {
  id: 70, employee_id: 9, employee: 'Old Hire', office_id: 'EMP090', status: 'decided', reviewer: 'Asha Rao', cycle_no: 1,
  rating: 5, recommendation: 'confirm', decision: 'confirmed', decided_at: '2026-10-01T09:00:00Z', decided_by: 'HR Lead',
};
const AWAITING = [
  { employee_id: 1, employee: 'Neha Iyer', reviewer: { employee_id: 50, name: 'Asha Rao' }, blocked: null },
  { employee_id: 2, employee: 'Ravi Das', reviewer: null, blocked: 'No department head is assigned for Sales. Assign one under Department Heads first.' },
];

function mockPage() {
  api.get.mockImplementation(async (url, cfg) => {
    if (url === '/employees' && cfg?.params?.status === 'Probation') return { data: EMPS };
    if (url === '/probation/settings') return { data: { probation_months: 6, reminder_days: 14 } };
    if (url === '/probation-reviews') return { data: { reviews: [SUBMITTED, DECIDED], awaiting_request: AWAITING } };
    if (url === '/probation/calculate') return { data: { probation_end_date: '2027-03-31' } };
    if (url === '/probation') return { data: [{ id: 5, employee_id: 1, first_name: 'Neha', last_name: 'Iyer', notified_to: 'HR', notification_type: 'probation_due', created_at: '2026-10-01T00:00:00Z', status: 'closed' }] };
    return { data: [] };
  });
}
const card = (name) => screen.getByText(name, { selector: '.prob-card-name' }).closest('.prob-card');

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  auth.grants = new Set(['hr:view', 'hr:add', 'hr:edit']);
});

describe('requesting a review', () => {
  it('posts the request for an employee whose department has a head', async () => {
    mockPage();
    api.post.mockResolvedValue({ data: { created: true, review: { id: 80, reviewer: 'Asha Rao' } } });
    render(<Probation />);
    await screen.findByText('Neha Iyer', { selector: '.prob-card-name' });
    fireEvent.click(within(card('Neha Iyer')).getByRole('button', { name: 'Request review' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/probation-reviews', { employee_id: 1 }));
    expect(await screen.findByText(/Asha Rao has been asked to review Neha Iyer/)).toBeTruthy();
  });

  it('disables it, says why, and points to Department Heads when there is no head', async () => {
    mockPage();
    const setPage = vi.fn();
    render(<Probation setPage={setPage} />);
    await screen.findByText('Ravi Das', { selector: '.prob-card-name' });
    const btn = within(card('Ravi Das')).getByRole('button', { name: 'Request review' });
    expect(btn.disabled).toBe(true);
    expect(card('Ravi Das').textContent).toMatch(/No department head is assigned for Sales/);
    expect(screen.getByText(/1 employee cannot be sent for review/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Department Heads' }));
    expect(setPage).toHaveBeenCalledWith('DepartmentHeads');
  });

  it('is not offered without hr:add', async () => {
    auth.grants = new Set(['hr:view']);
    mockPage();
    render(<Probation />);
    await screen.findByText('Neha Iyer', { selector: '.prob-card-name' });
    expect(within(card('Neha Iyer')).queryByRole('button', { name: 'Request review' })).toBeNull();
    expect(within(card('Sita Pai')).queryByRole('button', { name: 'Record decision' })).toBeNull();
  });
});

describe('the HR decision', () => {
  it('starts on the head\'s recommendation and posts an extension with its reason', async () => {
    mockPage();
    api.post.mockResolvedValue({ data: { decided: true, new_end_date: '2027-03-31' } });
    render(<Probation />);
    await screen.findByText('Sita Pai', { selector: '.prob-card-name' });
    expect(card('Sita Pai').textContent).toMatch(/Head recommends: Extend · 3\/5/);
    fireEvent.click(within(card('Sita Pai')).getByRole('button', { name: 'Record decision' }));

    const dlg = screen.getByRole('dialog', { name: 'Record probation decision' });
    expect(dlg.textContent).toMatch(/Needs more time on month-end close/);
    expect(within(dlg).getByLabelText('Decision *').value).toBe('extended');
    await waitFor(() => expect(dlg.textContent).toMatch(/New end date: 31 Mar 27/));
    expect(api.get).toHaveBeenCalledWith('/probation/calculate', { params: { joining_date: '2027-01-01', months: 3 } });

    // A reason is required to extend.
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save Decision' }));
    expect(await screen.findByText(/Give a reason/)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.change(within(dlg).getByLabelText('Reason *'), { target: { value: 'Close process not yet owned' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save Decision' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/probation-reviews/77/decide',
      { decision: 'extended', notes: 'Close process not yet owned', extension_months: 3 }));
    expect(await screen.findByText(/probation now ends on 31 Mar 27/)).toBeTruthy();
  });

  it('not confirmed needs a last working date and posts it', async () => {
    mockPage();
    api.post.mockResolvedValue({ data: { decided: true, exit_request_id: 9 } });
    render(<Probation />);
    await screen.findByText('Sita Pai', { selector: '.prob-card-name' });
    fireEvent.click(within(card('Sita Pai')).getByRole('button', { name: 'Record decision' }));
    const dlg = screen.getByRole('dialog', { name: 'Record probation decision' });
    fireEvent.change(within(dlg).getByLabelText('Decision *'), { target: { value: 'not_confirmed' } });
    fireEvent.change(within(dlg).getByLabelText('Reason *'), { target: { value: 'Missed targets' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save Decision' }));
    expect(await screen.findByText(/Enter the last working date/)).toBeTruthy();

    fireEvent.change(within(dlg).getByLabelText('Last working date *'), { target: { value: '2099-01-15' } });
    fireEvent.change(within(dlg).getByLabelText('Notice period (days)'), { target: { value: '15' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save Decision' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/probation-reviews/77/decide',
      { decision: 'not_confirmed', notes: 'Missed targets', last_working_date: '2099-01-15', notice_days: 15 }));
    expect(await screen.findByText(/An exit request was opened for Sita Pai/)).toBeTruthy();
  });
});

describe('history and the reminder log', () => {
  it('lists decided reviews under History', async () => {
    mockPage();
    render(<Probation />);
    await screen.findByText('Sita Pai', { selector: '.prob-card-name' });
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    const row = document.querySelector('tr[data-history="70"]');
    expect(row.textContent).toMatch(/Old Hire/);
    expect(row.textContent).toMatch(/Confirmed/);
    expect(row.textContent).toMatch(/HR Lead/);
  });

  it('the reminder log has no decision button', async () => {
    mockPage();
    render(<Probation />);
    await screen.findByText('Sita Pai', { selector: '.prob-card-name' });
    fireEvent.click(screen.getByRole('button', { name: /Reminder Log/ }));
    expect(screen.getByText('Reminder Log', { selector: 'h3' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record Decision' })).toBeNull();
  });
});

describe('letters, cancelled reviews and the Approval Center link', () => {
  const CANCELLED = {
    id: 71, employee_id: 8, employee: 'Gone Soon', office_id: 'EMP080', status: 'cancelled', reviewer: 'Asha Rao', cycle_no: 1,
    cancelled_at: '2026-10-05T09:00:00Z', cancelled_by: 'HR Lead', cancel_reason: 'Resigned before review',
  };
  const mockWith = (reviews) => {
    mockPage();
    const base = api.get.getMockImplementation();
    api.get.mockImplementation(async (url, cfg) => (url === '/probation-reviews'
      ? { data: { reviews, awaiting_request: AWAITING } }
      : base(url, cfg)));
  };

  it('History shows a cancelled review with its reason, and a letter button only on confirmed/extended', async () => {
    mockWith([SUBMITTED, DECIDED, CANCELLED]);
    render(<Probation />);
    await screen.findByText('Sita Pai', { selector: '.prob-card-name' });
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    const cx = document.querySelector('tr[data-history="71"]');
    expect(cx.textContent).toMatch(/Cancelled/);
    expect(cx.textContent).toMatch(/Resigned before review/);
    expect(within(cx).queryByRole('button')).toBeNull();
    expect(within(document.querySelector('tr[data-history="70"]')).getByRole('button', { name: /Confirmation letter/ })).toBeTruthy();
  });

  it('downloads the letter as a PDF', async () => {
    mockWith([DECIDED]);
    const blob = new Blob(['%PDF-'], { type: 'application/pdf' });
    const base = api.get.getMockImplementation();
    api.get.mockImplementation(async (url, cfg) => (url === '/probation-reviews/70/letter' ? { data: blob } : base(url, cfg)));
    const createUrl = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    globalThis.URL.createObjectURL = createUrl;
    globalThis.URL.revokeObjectURL = revoke;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<Probation />);
    await screen.findByRole('tab', { name: /History/ });
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirmation letter/ }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/probation-reviews/70/letter', { responseType: 'blob' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(createUrl).toHaveBeenCalledWith(blob);
    click.mockRestore();
  });

  it('opens the decision form when arriving from the Approval Center (?review=<id>)', async () => {
    window.history.pushState({}, '', '/Probation?review=77');
    try {
      mockWith([SUBMITTED]);
      render(<Probation />);
      const dlg = await screen.findByRole('dialog', { name: 'Record probation decision' });
      expect(dlg.textContent).toMatch(/Sita Pai/);
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});
