/**
 * Succession Center sections (2026-11-12), against a mocked API.
 *
 *  - The old standalone page keys redirect to their hub tab (no second copy).
 *  - Planning: readiness is the 9-box rating (no readiness field on a
 *    candidacy; unrated = "Not rated"); people who left are marked and the
 *    count says "+1 left"; a rating that would replace one asks first; the
 *    rating history opens; Sync from performance previews before it writes.
 *  - Leadership Pipeline: with no levels the level manager is shown and adds one.
 *  - Development Plans: a plan and an action can be edited; an action can be
 *    cancelled; a mentoring session can be logged.
 *  - Talent Pools: a member who left is marked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/services/api/client', () => ({ default: api }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

import SuccessionPlanning from '../features/hr/succession/SuccessionPlanning';
import LeadershipPipeline from '../features/hr/succession/LeadershipPipeline';
import DevelopmentPlans from '../features/hr/succession/DevelopmentPlans';
import EmployeeSuccessionPools from '../features/hr/succession/EmployeeSuccessionPools';
import { ROUTES } from '../config/routes';

const EMPLOYEES = [
  { id: 1, name: 'Asha Rao', designation: 'Engineer' },
  { id: 2, name: 'Bala Iyer', designation: 'Lead' },
  { id: 3, name: 'Chitra N', designation: 'Analyst' },
];
const cell = (performance, potential, employees = []) => ({ performance, potential, employees });
const NINE_BOX = [
  cell(3, 3, [{ id: 11, employee_id: 1, name: 'Asha Rao', performance_score: '4.00', potential_score: 5, flight_risk: 'low', readiness: 'ready-now', employment_phase: 'notice' }]),
  ...[[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3], [3, 1], [3, 2]].map(([a, b]) => cell(a, b)),
];
const ROLES = [{ id: 7, role_title: 'Plant Head', risk_level: 'high', current_holder_id: 9, current_holder_name: 'Old Boss',
                 holder_phase: 'left', candidate_count: 1, left_candidate_count: 1, has_ready_now: false, has_any_successor: true }];
const CANDIDATES = [
  { id: 70, candidate_employee_id: 2, candidate_name: 'Bala Iyer', rank: 1, readiness: 'unclassified', is_rated: false, employment_phase: 'employed', development_actions: [] },
  { id: 71, candidate_employee_id: 9, candidate_name: 'Gone Guy', rank: 2, readiness: 'ready-now', is_rated: true, employment_phase: 'left', development_actions: [] },
];

function routes(url) {
  switch (url) {
    case '/employees': return { data: EMPLOYEES };
    case '/admin/config/departments': return { data: [] };
    case '/succession/nine-box': return { data: NINE_BOX };
    case '/succession/critical-roles': return { data: ROLES };
    case '/succession/dashboard': return { data: { unread_alerts: 0, readiness_summary: [] } };
    case '/succession/critical-roles/7/candidates': return { data: CANDIDATES };
    case '/succession/assessments/1/history': return { data: [
      { id: 5, change_action: 'reassessed', created_at: '2026-10-01T10:00:00Z', performance_score: '3.00', potential_score: 4, readiness: '1-2-years', flight_risk: 'low', assessment_date: '2026-04-01', assessed_by_name: 'Hema' }] };
    default: return { data: [] };
  }
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.get.mockImplementation(async (url) => routes(url));
  document.body.innerHTML = '';
});

/* ── Old page keys ── */
describe('old standalone Succession page keys', () => {
  function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}{l.search}</div>; }
  it.each([
    ['SuccessionPlanning', 'planning'], ['LeadershipPipeline', 'pipeline'], ['DevelopmentPlans', 'plans'],
    ['EmployeeSuccessionPools', 'pools'], ['SuccessionReports', 'reports'], ['SuccessionSettings', 'settings'],
  ])('%s → Succession Center tab %s, still behind succession:view', async (key, tab) => {
    expect(ROUTES[key].module).toBe('succession');
    const C = ROUTES[key].component;
    render(<MemoryRouter initialEntries={[`/${key}`]}>
      <Routes><Route path={`/${key}`} element={<C />} /><Route path="/SuccessionCenter" element={<Where />} /></Routes>
    </MemoryRouter>);
    expect((await screen.findByTestId('where')).textContent).toBe(`/SuccessionCenter?tab=${tab}`);
  });
});

/* ── Planning ── */
describe('Planning', () => {
  it('has no hero of its own and marks someone serving notice on the grid', async () => {
    render(<SuccessionPlanning />);
    const chip = await screen.findByRole('button', { name: /Asha/ });
    expect(chip.getAttribute('title')).toMatch(/serving notice/);
    expect(document.querySelector('.plh-hero')).toBeNull();
  });

  it('a new rating for someone already rated asks before replacing', async () => {
    api.post.mockResolvedValue({ data: {} });
    render(<SuccessionPlanning />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add Assessment' }));
    const picker = screen.getByLabelText('Employee *');
    expect([...picker.options].map(o => o.textContent)).toContain('Asha Rao — Engineer (rated — will replace)');
    fireEvent.change(picker, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Assessment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace Rating' });
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/succession/assessments', expect.objectContaining({ employee_id: 1 })));
  });

  it('the rating history opens from the drawer', async () => {
    render(<SuccessionPlanning />);
    fireEvent.click(await screen.findByRole('button', { name: /Asha/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Rating History' }));
    expect(await screen.findByText('Re-rated')).toBeTruthy();
    expect(document.body.textContent).toMatch(/Rated 01 Apr 26 by Hema/);
  });

  it('Sync from performance previews, then writes only on confirm', async () => {
    api.post.mockImplementation(async (_url, body) => (body?.dry_run
      ? { data: { dry_run: true, would_update: 1, changes: [{ name: 'Asha Rao', current_score: '3.00', score: '4.50' }] } }
      : { data: { updated: 1 } }));
    render(<SuccessionPlanning />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sync from performance' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sync from Performance Reviews' });
    expect(dialog.textContent).toMatch(/Asha Rao 3\/5 → 4.5\/5/);
    expect(api.post).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync' }));
    expect(await screen.findByText('1 performance score updated from completed reviews')).toBeTruthy();
    expect(api.post).toHaveBeenLastCalledWith('/succession/assessments/sync-from-reviews', {});
  });

  it('critical roles: holder who left and left candidates are marked; readiness comes from the rating', async () => {
    api.put.mockResolvedValue({ data: {} });
    render(<SuccessionPlanning />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Critical Roles' }));
    const row = (await screen.findByText('Plant Head')).closest('tr');
    expect(row.textContent).toMatch(/Old Boss\s*Left/);
    expect(row.textContent).toMatch(/\+1 left/);
    fireEvent.click(within(row).getByRole('button', { name: 'Successors' }));
    const drawer = await screen.findByRole('dialog', { name: 'Plant Head successors' });
    await within(drawer).findByText(/Gone Guy/);
    expect(drawer.textContent).toMatch(/Not rated/);
    expect(drawer.textContent).toMatch(/Left/);
    fireEvent.click(within(drawer).getByRole('button', { name: '+ Add Candidate' }));
    expect(within(drawer).queryByLabelText(/Readiness Level/)).toBeNull();
    fireEvent.change(within(drawer).getByLabelText('Employee *'), { target: { value: '3' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add Candidate' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const sent = api.put.mock.calls[0][1].candidates;
    expect(sent.map(c => c.candidate_employee_id)).toEqual([2, 9, 3]);
    expect(sent.every(c => !('readiness_level' in c))).toBe(true);
  });
});

/* ── Leadership Pipeline ── */
describe('Leadership Pipeline', () => {
  it('with no levels, the level manager is shown and adds a level', async () => {
    api.post.mockResolvedValue({ data: { id: 1 } });
    render(<LeadershipPipeline />);
    expect(await screen.findByText('No leadership levels yet')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New level name *'), { target: { value: 'Manager' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Level' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/succession/pipeline/levels', expect.objectContaining({ level_name: 'Manager', level_order: 1 })));
    expect(screen.getByRole('button', { name: '+ Add to Pipeline' }).disabled).toBe(true);
  });
});

/* ── Development Plans ── */
describe('Development Plans', () => {
  const PLAN = { id: 4, employee_id: 1, employee_name: 'Asha Rao', plan_title: 'Lead track', status: 'active', overall_progress: 0,
                 action_count: 1, completed_count: 0, start_date: '2026-11-01', target_date: null, employment_phase: 'employed' };
  const DETAIL = { ...PLAN, actions: [{ id: 40, title: 'Shadow the head', action_type: 'task', status: 'pending' }], mentors: [] };
  const plansRoutes = (url) => (url === '/succession/development-plans' ? { data: [PLAN] }
    : url === '/succession/development-plans/4' ? { data: DETAIL }
    : url === '/succession/mentoring' ? { data: [{ id: 30, mentee_name: 'Asha Rao', mentor_name: 'Bala Iyer', status: 'active', session_count: 0, start_date: '2026-11-01' }] }
    : routes(url));

  it('a plan and an action can be edited, and an action cancelled', async () => {
    api.get.mockImplementation(async (url) => plansRoutes(url));
    api.patch.mockResolvedValue({ data: {} });
    render(<DevelopmentPlans />);
    fireEvent.click(await screen.findByRole('button', { name: /Lead track/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Plan' }));
    const title = screen.getByLabelText('Plan Title *');
    expect(title.value).toBe('Lead track');
    fireEvent.change(title, { target: { value: 'Lead track 2027' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Plan' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/succession/development-plans/4', expect.objectContaining({ plan_title: 'Lead track 2027' })));

    const status = await screen.findByLabelText('Status of Shadow the head');
    expect([...status.options].map(o => o.value)).toEqual(['pending', 'in_progress', 'completed', 'cancelled']);
    fireEvent.change(status, { target: { value: 'cancelled' } });
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/succession/development-plans/4/actions/40', { status: 'cancelled' }));

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const actionTitle = screen.getByLabelText('Title *');
    expect(actionTitle.value).toBe('Shadow the head');
    fireEvent.change(actionTitle, { target: { value: 'Shadow the plant head' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Action' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/succession/development-plans/4/actions/40', expect.objectContaining({ title: 'Shadow the plant head' })));
  });

  it('a mentoring session can be logged', async () => {
    api.get.mockImplementation(async (url) => plansRoutes(url));
    api.post.mockResolvedValue({ data: {} });
    render(<DevelopmentPlans />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Mentoring' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sessions' }));
    expect(await screen.findByText('No sessions logged yet.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Goals' } });
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log Session' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/succession/mentoring/30/sessions',
      expect.objectContaining({ topic: 'Goals', duration_minutes: 45 })));
  });
});

/* ── Talent Pools ── */
describe('Talent Pools', () => {
  it('a member who left is marked', async () => {
    api.get.mockImplementation(async (url) => (url === '/succession/pools'
      ? { data: [{ id: 5, pool_name: 'Future leaders', pool_type: 'leadership', member_count: 1 }] }
      : url === '/succession/pools/5/members'
        ? { data: [{ employee_id: 9, name: 'Gone Guy', employment_phase: 'left', added_date: '2026-10-01', readiness: null }] }
        : routes(url)));
    render(<EmployeeSuccessionPools />);
    fireEvent.click(await screen.findByRole('button', { name: /Future leaders/ }));
    const card = (await screen.findByText(/Gone Guy/)).closest('div');
    expect(card.textContent).toMatch(/Left/);
    expect(document.body.textContent).toMatch(/Not rated/);
  });
});
