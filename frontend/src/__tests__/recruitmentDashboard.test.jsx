/**
 * Recruitment Dashboard review 2026-11-17 — the page, with the API mocked:
 *   - No work-queue tiles (interviews today, offers awaiting answer) — those
 *     are on My Work only.
 *   - Hires say which period they cover (the label said "this month" for FY).
 *   - A failed request shows an error and "—", not zeros.
 *   - The positions table shows open and on-hold roles; closed on request.
 *   - A job title opens that job's pipeline.
 *   - Requests carry the period / department filters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({ fail: new Set(), calls: [] }));
const store = vi.hoisted(() => ({ setSelectedJobId: vi.fn() }));

vi.mock('@/services/api/client', () => {
  const DATA = {
    '/recruitment/filter-options': { departments: ['Engineering', 'Service'] },
    '/recruitment/dashboard-summary': {
      open_positions: 2, open_headcount: 4, active_candidates: 8, interviews_today: 1,
      pending_offers: 3, hired_in_period: 1, avg_time_to_hire: 12, period: 'fytd', period_label: 'This financial year',
    },
    '/recruitment/openings': [
      { id: 1, job_title: 'Design Engineer', department: 'Engineering', location: 'Coimbatore', status: 'open', number_of_positions: 3, positions_filled: 0, applicants_count: 5 },
      { id: 2, job_title: 'Service Tech', department: null, req_department: 'Service', status: 'on_hold', number_of_positions: 1, positions_filled: 0, applicants_count: 1 },
      { id: 3, job_title: 'Old Role', department: 'Service', status: 'closed', number_of_positions: 1, positions_filled: 1, applicants_count: 2 },
    ],
    '/recruitment/pipeline-summary': [{ stage: 'applied', count: 2 }],
    '/recruitment/analytics/source': [{ source: 'careers', count: '9' }],
  };
  return {
    default: {
      get: vi.fn((url, cfg) => {
        state.calls.push({ url, params: cfg?.params });
        if (state.fail.has(url)) return Promise.reject(new Error('boom'));
        return Promise.resolve({ data: DATA[url] ?? [] });
      }),
    },
  };
});
vi.mock('@/store/useAppStore', () => ({ default: (sel) => sel(store) }));
vi.mock('../features/recruitment/pages/RecruitmentDashboard.css', () => ({}));

const { default: RecruitmentDashboard } = await import('../features/recruitment/pages/RecruitmentDashboard');

function renderPage() {
  const setPage = vi.fn();
  render(<MemoryRouter><RecruitmentDashboard setPage={setPage} /></MemoryRouter>);
  return setPage;
}

beforeEach(() => { state.fail = new Set(); state.calls = []; store.setSelectedJobId.mockClear(); try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => cleanup());

describe('Recruitment Dashboard', () => {
  it('leaves the work-queue tiles (interviews today, offers awaiting answer) to My Work', async () => {
    const setPage = renderPage();
    const tile = (await screen.findByText('Active candidates')).closest('button');
    await waitFor(() => expect(within(tile).getByText('8')).toBeTruthy());
    expect(screen.queryByText('Interviews today')).toBeNull();
    expect(screen.queryByText('Offers awaiting answer')).toBeNull();
    fireEvent.click(tile);
    expect(setPage).toHaveBeenCalledWith('Candidates', { tab: 'all', status: 'active' });
  });

  it('labels hires with the period they cover and is not a link', async () => {
    renderPage();
    const label = await screen.findByText('Hired · This financial year');
    expect(label.closest('button')).toBeNull();
    expect(screen.getByText('Avg 12 days from application')).toBeTruthy();
  });

  it('shows an error, not zeros, when a request fails', async () => {
    state.fail.add('/recruitment/dashboard-summary');
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/headline numbers/);
    const tile = screen.getByText('Active candidates').closest('button');
    expect(within(tile).getByText('—')).toBeTruthy();
  });

  it('lists open and on-hold roles, closed ones on request, with the requisition department as fallback', async () => {
    renderPage();
    await screen.findByText('Design Engineer');
    const row = screen.getByText('Service Tech').closest('tr');
    expect(within(row).getByText('Service')).toBeTruthy();     // from req_department
    expect(screen.queryByText('Old Role')).toBeNull();
    fireEvent.click(screen.getByText('Show 1 closed / other'));
    expect(await screen.findByText('Old Role')).toBeTruthy();
  });

  it("opens a job's pipeline from its title", async () => {
    const setPage = renderPage();
    fireEvent.click(await screen.findByText('Design Engineer'));
    expect(store.setSelectedJobId).toHaveBeenCalledWith(1);
    expect(setPage).toHaveBeenCalledWith('Candidates', { tab: 'pipeline' });
  });

  it('sends the period to the summary and sources', async () => {
    renderPage();
    await screen.findByText('Design Engineer');
    const sum = state.calls.find(c => c.url === '/recruitment/dashboard-summary');
    const src = state.calls.find(c => c.url === '/recruitment/analytics/source');
    expect(sum.params.period).toBe('fytd');
    expect(src.params.period).toBe('fytd');
  });
});
