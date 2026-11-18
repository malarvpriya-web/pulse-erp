/**
 * Talent Bank merge 2026-11-17 — the page, with the API mocked:
 *   - "Everyone" and "in the bank" show the whole bank, not the filtered count.
 *   - The Skills box sends `skills` (candidate skills OR tags), not `tags`.
 *   - Rarely used filters sit behind "More filters".
 *   - Each card can Put forward (opens the open jobs) and remove a category.
 *   - Due reminders offer Put forward / Contacted / Remind later — no
 *     "bring back" that set people active with no job.
 *   - Manage categories lists categories, including switched-off ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({ calls: [], posts: [], deletes: [] }));
const store = vi.hoisted(() => ({ setSelectedCandidateId: vi.fn() }));

vi.mock('@/services/api/client', () => {
  const ROW = {
    id: 7, full_name: 'Lakshmi N', disposition: 'talent_bank', current_stage: 'future_use',
    current_designation: 'Graduate Engineer', current_company: 'Su-Kam', experience_years: '2.0',
    location: 'Coimbatore', skills: ['Power electronics'], application_count: 1,
    pools: ['Power Electronics'], pool_list: [{ id: 91, name: 'Power Electronics' }], bank_tags: ['AHF'],
    suitable_departments: [],
  };
  const DATA = {
    '/recruitment/talent-bank/pools': [
      { id: 91, pool_name: 'Power Electronics', category: 'engineering', member_count: 1 },
      { id: 8190, pool_name: 'STATCOM', category: 'product', member_count: 0 },
    ],
    '/recruitment/meta/candidate-workbench': { departments: ['Engineering'] },
    '/recruitment/recontacts': [
      { id: 55, candidate_id: 7, full_name: 'Lakshmi N', potential_role: 'Design Engineer', recontact_on: '2026-11-16', days_until_due: -1 },
    ],
    '/recruitment/openings': [{ id: 300, job_title: 'Design Engineer', department: 'Engineering', status: 'open' }],
    '/talent/pools': { data: [
      { id: 91, pool_name: 'Power Electronics', category: 'engineering', member_count: 1, is_active: true, is_seeded: true },
      { id: 92, pool_name: 'Old Bench', category: 'other', member_count: 0, is_active: false, is_seeded: false },
    ] },
  };
  return {
    default: {
      get: vi.fn((url, cfg) => {
        state.calls.push({ url, params: cfg?.params });
        if (url.startsWith('/recruitment/talent-bank?')) {
          return Promise.resolve({ data: { rows: [ROW], total: 1, bank_size: 9 } });
        }
        return Promise.resolve({ data: DATA[url] ?? [] });
      }),
      post: vi.fn((url, body) => { state.posts.push({ url, body }); return Promise.resolve({ data: { message: 'ok' } }); }),
      put: vi.fn(() => Promise.resolve({ data: {} })),
      delete: vi.fn((url, cfg) => { state.deletes.push({ url, params: cfg?.params }); return Promise.resolve({ data: { message: 'ok' } }); }),
    },
  };
});
vi.mock('@/store/useAppStore', () => ({ default: (sel) => sel(store) }));
const toastFn = vi.hoisted(() => () => {});
vi.mock('@/context/ToastContext', () => ({ useToast: () => toastFn }));
vi.mock('../features/recruitment/pages/talent-bank.css', () => ({}));
vi.mock('../features/recruitment/shared/components/candidate-actions.css', () => ({}));

const { default: TalentBank } = await import('../features/recruitment/pages/TalentBank');

function renderPage(path = '/TalentBank') {
  const setPage = vi.fn();
  render(<MemoryRouter initialEntries={[path]}><TalentBank setPage={setPage} /></MemoryRouter>);
  return setPage;
}
const lastSearch = () => [...state.calls].reverse().find(c => c.url.startsWith('/recruitment/talent-bank?'))?.url || '';

beforeEach(() => { state.calls = []; state.posts = []; state.deletes = []; });
afterEach(() => cleanup());

describe('Talent Bank', () => {
  it('shows the whole bank size on "Everyone", not the filtered count', async () => {
    renderPage('/TalentBank?skills=AHF');
    const everyone = (await screen.findByText('Everyone')).closest('button');
    await waitFor(() => expect(within(everyone).getByText('9')).toBeTruthy());
    expect(await screen.findByText('1 of 9 in the Talent Bank match')).toBeTruthy();
  });

  it('sends the Skills box as `skills`, not `tags`', async () => {
    renderPage();
    const box = await screen.findByPlaceholderText('AHF, STATCOM');
    fireEvent.change(box, { target: { value: 'Power electronics' } });
    await waitFor(() => expect(lastSearch()).toContain('skills=Power+electronics'));
    expect(lastSearch()).not.toContain('tags=');
  });

  it('keeps the rarely used filters behind "More filters"', async () => {
    renderPage();
    await screen.findByPlaceholderText('AHF, STATCOM');
    expect(screen.queryByText('Résumé content')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /More filters/ }));
    expect(screen.getByText('Résumé content')).toBeTruthy();
  });

  it('puts a card forward for an open job', async () => {
    renderPage();
    const card = await screen.findByRole('article');
    fireEvent.click(within(card).getByRole('button', { name: /Put forward/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Design Engineer · Engineering/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Put forward$/ }));
    await waitFor(() => expect(state.posts).toContainEqual({
      url: '/recruitment/candidates/7/recommend', body: { job_opening_ids: [300], notes: undefined },
    }));
  });

  it('removes a card from one category', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from Power Electronics' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(state.deletes).toContainEqual({
      url: '/recruitment/candidates/7/talent-bank', params: { pool_id: 91 },
    }));
  });

  it('offers Put forward / Contacted / Remind later on due reminders, and Contacted does not re-engage', async () => {
    renderPage();
    const due = await screen.findByRole('region', { name: 'Recontacts due' });
    expect(within(due).getByRole('button', { name: /Remind later/ })).toBeTruthy();
    expect(within(due).queryByText(/Bring back/)).toBeNull();
    fireEvent.click(within(due).getByRole('button', { name: /Contacted/ }));
    await waitFor(() => expect(state.posts).toContainEqual({
      url: '/recruitment/recontacts/55/complete', body: { status: 'done', reengage: false },
    }));
  });

  it('manages categories, including switched-off ones', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Manage categories/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Talent Bank categories' });
    await within(dialog).findByText('Old Bench');
    expect(within(dialog).getByText(/switched off/)).toBeTruthy();
    // In use → cannot be deleted.
    expect(within(dialog).getByRole('button', { name: 'Delete Power Electronics' }).disabled).toBe(true);
  });
});
