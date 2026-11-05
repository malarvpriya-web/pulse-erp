/**
 * Probation Reviews panel (HR → Exit & Probation → Probation) — Task 3E.
 *
 *  - lists OPEN reviews with employee, department, reviewer, due date, status;
 *  - flags a stale reviewer with the server's reason; "no eligible head" tells
 *    HR to assign a department head first;
 *  - Reassign appears only for hr:edit AND only when the server says the review
 *    is reassignable; it needs a reason and uses the existing endpoint;
 *  - success, no-op, 409 and malformed responses are handled and the list is
 *    reloaded after every action; a malformed or forbidden list never renders.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
const auth = vi.hoisted(() => ({ grants: new Set() }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }),
}));

import api from '../services/api/client';
import ProbationReviewsPanel from '../features/hr/components/ProbationReviewsPanel.jsx';
import { notificationTarget } from '../features/notifications/notificationTarget';

const base = {
  status: 'requested', office_id: 'EMP0', department: 'Finance', reviewer_due_date: '2026-11-30', is_overdue: false,
};
const REVIEWS = [
  { ...base, id: 41, employee: 'Neha Iyer', reviewer: 'Asha Rao', reviewer_state: 'current', reviewer_state_reason: null, current_head: null, reassignable: false },
  { ...base, id: 42, employee: 'Ravi Das', reviewer: 'Old Head', reviewer_state: 'reviewer_replaced',
    reviewer_state_reason: 'Old Head is no longer the head of Finance; the current head is Asha Rao.',
    current_head: { employee_id: 21, name: 'Asha Rao' }, reassignable: true },
  { ...base, id: 43, employee: 'Mani K', department: 'Sales', reviewer: 'Gone Person', reviewer_state: 'no_eligible_head',
    reviewer_state_reason: 'No department head is assigned for Sales. Assign one under Department Heads first.',
    current_head: null, reassignable: false },
];

function mockList(payload = { reviews: REVIEWS, awaiting_request: [] }, { status = 200 } = {}) {
  api.get.mockImplementation(async (url) => {
    if (url === '/probation-reviews') {
      if (status !== 200) { const e = new Error('x'); e.response = { status, data: { error: 'Forbidden' } }; throw e; }
      return { data: payload };
    }
    return { data: {} };
  });
}
const renderAs = (canEdit) => {
  auth.grants = new Set(canEdit ? ['hr:view', 'hr:edit'] : ['hr:view']);
  return render(<ProbationReviewsPanel />);
};
const rowOf = (id) => document.querySelector(`tr[data-review="${id}"]`);
const listCalls = () => api.get.mock.calls.filter(([u]) => u === '/probation-reviews').length;

beforeEach(() => { vi.clearAllMocks(); cleanup(); });

describe('the worklist', () => {
  it('asks for open reviews only and lists them with the details HR needs', async () => {
    mockList();
    renderAs(true);
    await screen.findByText('Neha Iyer');
    expect(api.get).toHaveBeenCalledWith('/probation-reviews', { params: { status: 'requested' } });
    const r = rowOf(41).textContent;
    expect(r).toMatch(/Neha Iyer/); expect(r).toMatch(/Finance/); expect(r).toMatch(/Asha Rao/);
    expect(r).toMatch(/30 Nov 26/); expect(r).toMatch(/Awaiting review/);
  });

  it('flags a replaced reviewer and a missing head with the server\'s reasons', async () => {
    mockList();
    renderAs(true);
    await screen.findByText('Ravi Das');
    expect(rowOf(41).textContent).not.toMatch(/no longer the head|No eligible head/);
    expect(rowOf(42).textContent).toMatch(/Reviewer is no longer the head/);
    expect(rowOf(42).textContent).toMatch(/the current head is Asha Rao/);
    expect(rowOf(43).textContent).toMatch(/No eligible head/);
    expect(rowOf(43).textContent).toMatch(/Assign a department head first/);
  });
});

describe('the reassign action', () => {
  it('appears only for hr:edit and only on a reassignable review', async () => {
    mockList();
    renderAs(true);
    await screen.findByText('Ravi Das');
    expect(within(rowOf(42)).getByRole('button', { name: 'Reassign to Asha Rao' })).toBeTruthy();
    expect(within(rowOf(41)).queryByRole('button', { name: /Reassign/ })).toBeNull();
    expect(within(rowOf(43)).queryByRole('button', { name: /Reassign/ })).toBeNull();
    cleanup();
    mockList();
    renderAs(false);
    await screen.findByText('Ravi Das');
    expect(screen.queryByRole('button', { name: /Reassign/ })).toBeNull();
  });

  it('requires a reason, then calls the existing endpoint and reloads the list', async () => {
    mockList();
    api.post.mockResolvedValue({ data: { changed: true, review: { id: 42, reviewer: 'Asha Rao' } } });
    renderAs(true);
    await screen.findByText('Ravi Das');
    fireEvent.click(within(rowOf(42)).getByRole('button', { name: 'Reassign to Asha Rao' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('A reason is required to reassign a review.')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Reason to reassign Ravi Das's review"), { target: { value: 'Finance head changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/probation-reviews/42/reassign', { reason: 'Finance head changed' }));
    expect(await screen.findByText("Ravi Das's review was reassigned to Asha Rao.")).toBeTruthy();
    await waitFor(() => expect(listCalls()).toBe(2));
  });

  it('a no-op is reported as no change', async () => {
    mockList();
    api.post.mockResolvedValue({ data: { changed: false, review: { id: 42, reviewer: 'Asha Rao' } } });
    renderAs(true);
    await screen.findByText('Ravi Das');
    fireEvent.click(within(rowOf(42)).getByRole('button', { name: 'Reassign to Asha Rao' }));
    fireEvent.change(screen.getByLabelText("Reason to reassign Ravi Das's review"), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('No change — Asha Rao is already the reviewer.')).toBeTruthy();
    await waitFor(() => expect(listCalls()).toBe(2));
  });

  it('a 409 conflict is shown as the server says, and the list is reloaded', async () => {
    mockList();
    api.post.mockRejectedValue({ response: { status: 409, data: { error: 'Only a review awaiting submission can be reassigned; this one is submitted.' } } });
    renderAs(true);
    await screen.findByText('Ravi Das');
    fireEvent.click(within(rowOf(42)).getByRole('button', { name: 'Reassign to Asha Rao' }));
    fireEvent.change(screen.getByLabelText("Reason to reassign Ravi Das's review"), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/this one is submitted/)).toBeTruthy();
    await waitFor(() => expect(listCalls()).toBe(2));
  });

  it('a malformed reassignment response is not reported as success', async () => {
    mockList();
    api.post.mockResolvedValue({ data: 'oops' });
    renderAs(true);
    await screen.findByText('Ravi Das');
    fireEvent.click(within(rowOf(42)).getByRole('button', { name: 'Reassign to Asha Rao' }));
    fireEvent.change(screen.getByLabelText("Reason to reassign Ravi Das's review"), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Unexpected response from the server/)).toBeTruthy();
    await waitFor(() => expect(listCalls()).toBe(2));
  });
});

describe('failures never render a table', () => {
  it('a malformed list payload is a load error', async () => {
    mockList([]);
    renderAs(true);
    expect(await screen.findByText('Could not load probation reviews.')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
  });

  it('a 403 shows an access message', async () => {
    mockList(undefined, { status: 403 });
    renderAs(true);
    expect(await screen.findByText('You do not have access to probation reviews.')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
  });

  it('no open reviews is said plainly', async () => {
    mockList({ reviews: [], awaiting_request: [] });
    renderAs(true);
    expect(await screen.findByText('No open probation reviews.')).toBeTruthy();
  });
});

describe('the former reviewer\'s notification', () => {
  it('opens My Probation Reviews with no review reference', () => {
    expect(notificationTarget({ notification_type: 'probation_review_reassigned', module_name: 'probation', reference_id: null }))
      .toEqual({ page: 'MyProbationReviews', params: {} });
  });
});
