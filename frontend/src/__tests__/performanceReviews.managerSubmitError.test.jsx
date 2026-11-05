/**
 * Performance Reviews — what a failed manager-review submit tells the user (§209).
 *
 * The catch used to show "Failed to submit manager review" for everything, so a
 * manager whose login has no employee record (400 NO_LINKED_EMPLOYEE) or who
 * sent an unsupported rating (400 INVALID_RATING) could not tell why. A 4xx now
 * shows the server's message; a 5xx or network failure keeps the fallback, since
 * its text can be raw internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/services/api/client', () => ({ default: api }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { name: 'Mgr' } }) }));
const drawerToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/context/ToastContext', () => ({ useToast: () => drawerToast }));

import PerformanceReviews from '@/features/performance/pages/PerformanceReviews';
import { submitErrorMessage } from '@/features/performance/submitErrorMessage';

const FALLBACK = 'Failed to submit manager review';
const axiosError = (status, data) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
// The api client wraps 403 and 5xx into an Error carrying `status`.
const wrapped = (status, message, data) => Object.assign(new Error(message), { status, response: { status, data } });

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(async (url) => (url === '/performance/review/current'
    ? { data: { id: 77, status: 'self_submitted', employee_name: 'Divya', cycle_name: 'FY26' } }
    : { data: [] }));
});

async function submitWith(error) {
  api.post.mockRejectedValueOnce(error);
  const { container } = render(<MemoryRouter><PerformanceReviews /></MemoryRouter>);
  fireEvent.click((await screen.findAllByRole('button', { name: /Submit Manager Review/ }))[0]);
  const stars = container.querySelectorAll('.prf-mgr-modal .prf-star');
  expect(stars).toHaveLength(10);
  fireEvent.click(stars[3]);        // manager rating 4
  fireEvent.click(stars[5 + 3]);    // final rating 4
  const buttons = screen.getAllByRole('button', { name: /Submit Manager Review/ });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/performance/reviews/77/manager-review',
    expect.objectContaining({ manager_rating: 4, final_rating: 4 })));
  return container;
}

const toastText = async (container) => {
  await waitFor(() => expect(container.querySelector('.prf-toast-error')).not.toBeNull());
  return container.querySelector('.prf-toast-error').textContent.trim();
};

describe('manager-review submit error shown to the user', () => {
  it.each([
    ['400 NO_LINKED_EMPLOYEE', axiosError(400, {
      error: 'Your login is not linked to an employee record, so it cannot submit a manager review.', code: 'NO_LINKED_EMPLOYEE' }),
     'Your login is not linked to an employee record, so it cannot submit a manager review.'],
    ['400 INVALID_RATING', axiosError(400, { error: 'Final rating can have at most 1 decimal place', code: 'INVALID_RATING', field: 'final_rating' }),
     'Final rating can have at most 1 decimal place'],
    ['409 ASSESSMENT_OTHER_COMPANY', axiosError(409, {
      error: 'This employee\'s talent assessment is held under another company, so the review was not saved.', code: 'ASSESSMENT_OTHER_COMPANY' }),
     'This employee\'s talent assessment is held under another company, so the review was not saved.'],
    ['404 with no message', axiosError(404, {}), FALLBACK],
    ['500 with raw internals', wrapped(500, 'invalid input syntax for type integer: "4.0"', { error: 'invalid input syntax for type integer: "4.0"' }), FALLBACK],
    ['network failure', new Error('Network Error'), FALLBACK],
  ])('%s', async (_name, error, expected) => {
    const container = await submitWith(error);
    expect(await toastText(container)).toBe(expected);
    // The form stays open so the manager can correct and resubmit.
    expect(container.querySelector('.prf-mgr-modal')).not.toBeNull();
  });
});

// The self-assessment drawer used to swallow every error and report success.
describe('self-assessment submit', () => {
  async function openDrawerAndSubmit() {
    api.get.mockImplementation(async (url) => (url === '/performance/review/current'
      ? { data: { id: 88, status: 'self_review_pending', employee_name: 'Uma', cycle_name: 'FY26' } }
      : { data: [] }));
    const { container } = render(<MemoryRouter><PerformanceReviews /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Start Self Assessment/ }));
    const stars = container.querySelectorAll('.prf-drawer .prf-star');
    expect(stars).toHaveLength(5);
    fireEvent.click(stars[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Submit Self Assessment' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/performance/reviews/88/self-review',
      expect.objectContaining({ self_rating: 4 })));
    return container;
  }
  beforeEach(() => { drawerToast.error.mockReset(); });

  it.each([
    ['403 NOT_REVIEW_OWNER', wrapped(403, 'You can only submit your own self-review',
      { error: 'You can only submit your own self-review', message: 'You can only submit your own self-review', code: 'NOT_REVIEW_OWNER' }),
     'You can only submit your own self-review'],
    ['403 NO_LINKED_EMPLOYEE', wrapped(403, 'Your login is not linked to an employee record, so it cannot submit a self-review.', {
      code: 'NO_LINKED_EMPLOYEE' }),
     'Your login is not linked to an employee record, so it cannot submit a self-review.'],
    ['400 INVALID_RATING', axiosError(400, { error: 'Self rating can have at most 1 decimal place', code: 'INVALID_RATING' }),
     'Self rating can have at most 1 decimal place'],
    ['500', wrapped(500, 'relation "x" does not exist', {}), 'Failed to submit self assessment'],
  ])('%s: the error is shown and nothing is reported as submitted', async (_n, error, expected) => {
    api.post.mockRejectedValueOnce(error);
    const container = await openDrawerAndSubmit();
    await waitFor(() => expect(drawerToast.error).toHaveBeenCalledWith(expected));
    expect(container.querySelector('.prf-drawer')).not.toBeNull();
    expect(container.textContent).not.toContain('Self assessment submitted successfully');
  });

  it('a successful submit still closes the drawer and confirms', async () => {
    api.post.mockResolvedValueOnce({ data: {} });
    const container = await openDrawerAndSubmit();
    await waitFor(() => expect(container.textContent).toContain('Self assessment submitted successfully'));
    expect(container.querySelector('.prf-drawer')).toBeNull();
    expect(drawerToast.error).not.toHaveBeenCalled();
  });
});

describe('submitErrorMessage', () => {
  it('uses the api client\'s friendly 403 text, and the succession-style `message` key', () => {
    expect(submitErrorMessage(wrapped(403, 'You do not have permission to perform this action.', { error: 'Forbidden' }), FALLBACK))
      .toBe('You do not have permission to perform this action.');
    expect(submitErrorMessage(axiosError(400, { message: 'performance_score can have at most 2 decimal places' }), FALLBACK))
      .toBe('performance_score can have at most 2 decimal places');
    expect(submitErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
