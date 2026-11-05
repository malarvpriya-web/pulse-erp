/**
 * My Probation Reviews page, and the notification that leads to it.
 *
 *  - not a current head (never, reassigned, left, unlinked): a notice, and the
 *    review list is never requested;
 *  - a head sees only what GET /mine returns (the server scopes it to their
 *    linked employee and company) with the details needed to act;
 *  - ?ref= highlights that review; a ref that is not theirs shows an
 *    "unavailable" notice and nothing about that review;
 *  - submission posts once and shows the server's verdict as-is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/features/hr/pages/MyProbationReviews.css', () => ({}));

import api from '@/services/api/client';
import MyProbationReviews from '@/features/hr/pages/MyProbationReviews.jsx';
import { __resetReviewerStatus } from '@/features/hr/probationReviewerStatus';
import { notificationTarget } from '@/features/notifications/notificationTarget';

const OPEN = {
  id: 41, employee_id: 7, employee: 'Neha Iyer', office_id: 'EMP007', department: 'Finance', cycle_no: 1,
  period_start: '2026-06-01', original_end_date: '2026-11-30', status: 'requested', requested_at: '2026-10-14T05:00:00Z',
  requested_by: 'Zz HR', reviewer_due_date: '2026-11-30', is_overdue: false,
};
const DONE = {
  ...OPEN, id: 42, employee_id: 8, employee: 'Ravi Das', office_id: 'EMP008', status: 'submitted',
  rating: 4, recommendation: 'extend', comments: 'Needs more time on reporting.', submitted_at: '2026-10-13T05:00:00Z',
};

function mockApi({ head = true, reviews = [OPEN, DONE], linked = true } = {}) {
  api.get.mockImplementation(async (url) => {
    if (url === '/probation-reviews/mine/summary') return { data: { linked, is_head: head, departments: head ? ['Finance'] : [], needs_action: 1 } };
    if (url === '/probation-reviews/mine') return { data: { reviews, recommendations: ['confirm', 'extend', 'not_confirm'] } };
    return { data: {} };
  });
}
const renderAt = (path = '/MyProbationReviews') => {
  localStorage.setItem('token', `zz-page-${Math.random()}`);
  return render(<MemoryRouter initialEntries={[path]}><MyProbationReviews /></MemoryRouter>);
};
const card = (name) => screen.getByRole('article', { name: `Probation review for ${name}` });
const mineCalls = () => api.get.mock.calls.filter(([u]) => u === '/probation-reviews/mine').length;

beforeEach(() => { vi.clearAllMocks(); cleanup(); __resetReviewerStatus(); });

describe('who sees what', () => {
  it('someone who is not a current head gets a notice and no review data is requested', async () => {
    mockApi({ head: false });
    renderAt();
    expect(await screen.findByText('Available to department heads')).toBeTruthy();
    expect(mineCalls()).toBe(0);
    expect(screen.queryByText('Neha Iyer')).toBeNull();
  });

  it('a reassigned head opening an old notification sees "unavailable" and no data', async () => {
    mockApi({ head: false });
    renderAt('/MyProbationReviews?ref=41');
    expect(await screen.findByRole('alert')).toHaveTextContent(/not available to you/);
    expect(mineCalls()).toBe(0);
    expect(screen.queryByText('Neha Iyer')).toBeNull();
  });

  it('a head sees each assigned review with what they need to act', async () => {
    mockApi();
    renderAt();
    const open = await screen.findByRole('article', { name: 'Probation review for Neha Iyer' });
    const text = open.textContent;
    expect(text).toMatch(/EMP007/);
    expect(text).toMatch(/Finance/);
    // The app date standard, DD Mon YY (§198).
    expect(text).toMatch(/Probation ends\s*30 Nov 26/);
    expect(text).toMatch(/Review due\s*30 Nov 26/);
    expect(text).toMatch(/Awaiting your review/);
    expect(within(open).getByRole('button', { name: 'Submit review' })).toBeTruthy();

    const done = card('Ravi Das');
    expect(done.textContent).toMatch(/Submitted/);
    expect(done.textContent).toMatch(/Rating:\s*4/);
    expect(done.textContent).toMatch(/Extend probation/);
    expect(within(done).queryByRole('button', { name: 'Submit review' })).toBeNull();
  });

  it('a head with nothing assigned is told so', async () => {
    mockApi({ reviews: [] });
    renderAt();
    expect(await screen.findByText('No probation reviews assigned to you')).toBeTruthy();
  });
});

describe('notification link (?ref=)', () => {
  it('highlights the referenced review', async () => {
    mockApi();
    renderAt('/MyProbationReviews?ref=41');
    const open = await screen.findByRole('article', { name: 'Probation review for Neha Iyer' });
    expect(open.getAttribute('aria-current')).toBe('true');
    expect(card('Ravi Das').getAttribute('aria-current')).toBeNull();
  });

  it('a ref that is not one of yours (another company, reassigned, unknown) is "unavailable" — nothing about it is shown', async () => {
    mockApi();
    renderAt('/MyProbationReviews?ref=999');
    expect(await screen.findByRole('alert')).toHaveTextContent(/not available to you/);
    // Only the caller's own reviews are listed.
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('the bell sends the review request to this page, carrying the review id', () => {
    const n = { notification_type: 'probation_review_request', module_name: 'probation', reference_id: 41 };
    expect(notificationTarget(n)).toEqual({ page: 'MyProbationReviews', params: { ref: '41' } });
    // ...and HR's own probation notifications still go to the HR page.
    expect(notificationTarget({ notification_type: 'probation_due', module_name: 'probation' })?.page).toBe('Probation');
  });
});

describe('submission', () => {
  it('posts the rating, comments and recommendation once, then shows it as submitted', async () => {
    mockApi();
    api.post.mockResolvedValue({ data: { submitted: true, review: { ...OPEN, status: 'submitted', rating: 5, recommendation: 'confirm', comments: 'Excellent.', submitted_at: '2026-10-15T05:00:00Z' } } });
    renderAt();
    const open = await screen.findByRole('article', { name: 'Probation review for Neha Iyer' });
    fireEvent.click(within(open).getByLabelText(/5 — Excellent/));
    fireEvent.change(within(open).getByLabelText('Comments for Neha Iyer'), { target: { value: 'Excellent.' } });
    fireEvent.change(within(open).getByLabelText('Recommendation for Neha Iyer'), { target: { value: 'confirm' } });
    fireEvent.click(within(open).getByRole('button', { name: 'Submit review' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/probation-reviews/mine/41/submit', { rating: 5, comments: 'Excellent.', recommendation: 'confirm' });
    await waitFor(() => expect(card('Neha Iyer').textContent).toMatch(/Submitted/));
    expect(within(card('Neha Iyer')).queryByRole('button', { name: 'Submit review' })).toBeNull();
  });

  it('shows the server\'s refusal as-is and keeps the review open', async () => {
    mockApi();
    api.post.mockRejectedValue({ response: { status: 403, data: { error: 'This review is not assigned to you.' } } });
    renderAt();
    const open = await screen.findByRole('article', { name: 'Probation review for Neha Iyer' });
    fireEvent.click(within(open).getByRole('button', { name: 'Submit review' }));
    expect(await within(open).findByRole('alert')).toHaveTextContent('This review is not assigned to you.');
    expect(card('Neha Iyer').textContent).toMatch(/Awaiting your review/);
  });

  it('sends what was entered and leaves validation to the server', async () => {
    mockApi();
    api.post.mockRejectedValue({ response: { status: 400, data: { error: 'rating must be a whole number from 1 to 5.' } } });
    renderAt();
    const open = await screen.findByRole('article', { name: 'Probation review for Neha Iyer' });
    fireEvent.click(within(open).getByRole('button', { name: 'Submit review' }));
    expect(await within(open).findByRole('alert')).toHaveTextContent('rating must be a whole number from 1 to 5.');
    expect(api.post).toHaveBeenCalledWith('/probation-reviews/mine/41/submit', { rating: undefined, comments: '', recommendation: '' });
  });
});
