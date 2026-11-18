/**
 * Jobs page (Requisitions + Careers Website), with the API mocked:
 *   - the Job Openings tab is gone (11-17): the job is posted / edited from its
 *     requisition, in place of the requisition view
 *   - the Careers Website tab holds the website address input
 *   - both tabs render inside the Jobs hub with no second page shell
 *   - a requisition opens IN PLACE of the list (no overlay), with its timeline
 *   - ?opening=<id> opens that job in place, with the same timeline
 *     (this path crashed once on a hook ordering bug that no test rendered)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const store = vi.hoisted(() => ({ setSelectedJobId: vi.fn(), setSelectedCandidateId: vi.fn() }));

vi.mock('@/services/api/client', () => {
  const REQ = {
    id: 910, job_title: 'Power Electronics Engineer', department: 'Engineering', status: 'open',
    number_of_positions: 2, priority: 'high', opening_id: 2490, opening_status: 'open',
    applicants_count: 1, positions_filled: 0, last_decision: 'Approved', last_decision_comment: 'Go ahead',
  };
  const TIMELINE = [
    { key: '1', at: '2026-11-17T10:00:00Z', event: 'raised' },
    { key: '2', at: '2026-11-17T10:05:00Z', event: 'approved', comment: 'Go ahead', actor: 'Super Admin' },
    { key: '3', at: '2026-11-17T10:06:00Z', event: 'job_posted' },
    { key: 'app1', at: '2026-11-17T11:00:00Z', event: 'application', candidate: 'Priya', candidate_id: 5 },
  ];
  const DATA = {
    '/recruitment/requisitions': [REQ],
    '/recruitment/requisitions/910': REQ,
    '/recruitment/requisitions/910/timeline': TIMELINE,
    '/recruitment/openings': [{ id: 2490, requisition_id: 910, job_title: 'Power Electronics Engineer', department: 'Engineering', status: 'open', number_of_positions: 2, positions_filled: 0, applicants_count: 1 }],
    '/recruitment/meta/candidate-workbench': { employees: [] },
    '/recruitment/careers-portal': { id: 1, portal_key: 'KEY123', website_url: 'https://www.example.com/careers', allowed_origins: [], stats: null },
    '/recruitment/careers-portal/submissions': [],
  };
  return { default: { get: vi.fn((url) => Promise.resolve({ data: DATA[url] ?? [] })), put: vi.fn(), post: vi.fn(), delete: vi.fn() } };
});
vi.mock('@/store/useAppStore', () => ({ default: (sel) => sel(store) }));
vi.mock('@/context/ToastContext', () => ({ useToast: () => () => {} }));
vi.mock('@/context/AuthContext',() => ({ useAuth: () => ({ user: { employee_id: 1 } }) }));
vi.mock('@/components/core/MasterSelect', () => ({ default: () => <select aria-label="Department" /> }));

const { default: Jobs } = await import('../features/recruitment/pages/Jobs');

const renderAt = (url) => render(<MemoryRouter initialEntries={[url]}><Jobs setPage={vi.fn()} /></MemoryRouter>);

afterEach(() => cleanup());

describe('Jobs page', () => {
  it('opens a requisition in place of the list, with its timeline', async () => {
    const { container } = renderAt('/Jobs?tab=requisitions');
    fireEvent.click(await screen.findByText('REQ-910'));
    expect(await screen.findByText('Timeline')).toBeTruthy();
    expect(await screen.findByText('Requisition raised')).toBeTruthy();
    expect(screen.getByText('Job opening posted')).toBeTruthy();
    expect(container.querySelector('.jrp-overlay')).toBeNull();   // not over the page
    expect(container.querySelector('.jrp-table')).toBeNull();     // replaces the list
    fireEvent.click(screen.getAllByRole('button', { name: /Requisitions/ }).find(b => b.classList.contains('jrp-back')));
    expect(await screen.findByText('REQ-910')).toBeTruthy();
  });

  it('?opening=<id> opens that job in place, with the timeline', async () => {
    const { container } = renderAt('/Jobs?tab=openings&opening=2490');
    expect(await screen.findByText('Timeline')).toBeTruthy();
    expect(await screen.findByText('Requisition raised')).toBeTruthy();
    expect(container.querySelector('.jo-panel')).not.toBeNull();
    expect(container.querySelector('.jo-overlay')).toBeNull();
    expect(container.querySelector('.jo-card')).toBeNull();
  });

  it('has no Job Openings tab; Edit job opens the job inside the requisition and Back returns to it', async () => {
    const { container } = renderAt('/Jobs');
    expect(screen.queryByRole('tab', { name: /Job Openings/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /Careers Website/ })).toBeTruthy();
    fireEvent.click(await screen.findByText('REQ-910'));
    expect(await screen.findByText(/live on the careers website/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Edit job/ }));
    expect(await screen.findByRole('region', { name: 'Job opening' })).toBeTruthy();
    expect(container.querySelector('.jrp-detail-grid')).toBeNull();   // replaces the requisition view
    fireEvent.click(container.querySelector('.jo-back'));
    expect(await screen.findByText(/live on the careers website/)).toBeTruthy();
  });

  it('Careers Website tab has the website address box and the developer links', async () => {
    renderAt('/Jobs?tab=website');
    const box = await screen.findByLabelText('Website careers page address');
    expect(box.value).toBe('https://www.example.com/careers');
    expect(screen.getByText(/For your website developer/)).toBeTruthy();
    expect(screen.getByText(/public\/careers\/KEY123\/apply/)).toBeTruthy();
  });

  it('shows one header — the tabs do not add their own page shell', async () => {
    renderAt('/Jobs?tab=website');
    expect(await screen.findByText(/Your careers page on the website/)).toBeTruthy();
    expect(screen.queryByText('Requisition Pipeline')).toBeNull();
    expect(screen.getAllByText('Jobs').length).toBe(1);
  });
});
