/**
 * Lifecycle-authority UI (P1_PROJECT_LIFECYCLE_PLAN.md Phase 6): Project
 * Master, Project Pipeline and Lifecycle Tracker only DISPLAY the stage the
 * backend derives from each lifecycle, never set it; projects without a
 * lifecycle stay visible as "Unavailable stage"; stage changes go through the
 * lifecycle's authorised, audited actions. The server enforces every rule
 * (integration.projectStageAuthority / integration.lifecycleStages); these
 * check that the screens send the right calls and offer the right controls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('@/services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() } }));
const auth = vi.hoisted(() => ({ grants: new Set() }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/context/ToastContext', () => ({ useToast: () => toast }));
vi.mock('@/components/pulse-ui', () => ({
  PageShell: ({ dock, children }) => <div>{dock}{children}</div>,
  PageHero: ({ title, actions }) => <header><h1>{title}</h1>{actions}</header>,
}));
vi.mock('@/components/core/VocabSelect', () => ({ default: () => <select aria-label="Project type" /> }));

import api from '@/services/api/client';
import ProductionDeliveryTracker from '@/features/projects/pages/ProductionDeliveryTracker.jsx';
import ProjectPipelineBoard from '@/features/projects/pages/ProjectPipelineBoard.jsx';
import LifecycleTracker from '@/features/operations/pages/LifecycleTracker.jsx';
import { lifecycleErrorMessage, projectStageOf } from '@/features/projects/shared/projectStage';
import { ROUTES } from '@/config/routes';

const grant = (...g) => { auth.grants = new Set(g); };
const httpError = (status, data) => Object.assign(new Error('http'), { response: { status, data } });

const STAGED = {
  project_id: 11, ipp: 'IPP-000011', project_code: 'PRJ-0011', description: 'Staged project', customer_name: 'Acme',
  production_stage: 'production', stored_production_stage: 'dispatched', stage_source: 'lifecycle',
  lifecycle_id: 501, lifecycle_stage: 'testing', lifecycle_status: 'active', status: 'In Progress',
};
const UNSTAGED = {
  project_id: 12, ipp: 'IPP-000012', project_code: 'PRJ-0012', description: 'No lifecycle project',
  production_stage: null, stored_production_stage: 'dispatched', stage_source: 'unavailable',
  lifecycle_id: null, lifecycle_stage: null, lifecycle_status: null, status: 'In Progress',
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  grant();
});

// ── shared helper ───────────────────────────────────────────────────────────
describe('stage display and error messages', () => {
  it('shows the derived stage, and "Unavailable stage" (never a guess) without a lifecycle', () => {
    expect(projectStageOf(STAGED).label).toBe('Production');
    expect(projectStageOf(UNSTAGED).label).toBe('Unavailable stage');
    expect(projectStageOf({ production_stage: 'created' }).label).toBe('Unavailable stage');
  });

  it('turns backend codes into useful messages', () => {
    expect(lifecycleErrorMessage(httpError(409, { code: 'STAGE_FOLLOWS_LIFECYCLE' }))).toMatch(/follows its lifecycle/);
    expect(lifecycleErrorMessage(httpError(422, { code: 'GATE_NOT_SATISFIED', failing: ['fat_passed', 'no_open_ncrs'] })))
      .toBe('Not ready to move on — still needed: FAT passed for every production order; No open NCRs.');
    expect(lifecycleErrorMessage(httpError(422, { code: 'CLOSURE_BLOCKED', blockers: [{ type: 'open_tasks', count: 2 }] })))
      .toBe('The project is not ready to close: 2 open task(s).');
    expect(lifecycleErrorMessage(httpError(403, { error: 'Forbidden' }), 'advance lifecycles')).toBe("You don't have permission to advance lifecycles.");
    expect(lifecycleErrorMessage(httpError(422, { error: 'Validation failed', errors: [{ message: 'Name is required' }] }))).toBe('Name is required');
  });
});

// ── Project Master ──────────────────────────────────────────────────────────
describe('Project Master (ProductionDeliveryTracker)', () => {
  const mount = (setPage = vi.fn()) => {
    api.get.mockImplementation((url) => {
      if (url === '/delivery-tracker') return Promise.resolve({ data: { data: [STAGED, UNSTAGED], total: 2 } });
      if (url === '/projects/projects/11') return Promise.resolve({ data: { ...STAGED, id: 11, project_name: 'Staged', status: 'active' } });
      return Promise.resolve({ data: [] });
    });
    render(<ProductionDeliveryTracker setPage={setPage} />);
    return setPage;
  };

  it('shows the derived stage read-only, and unavailable projects as "Unavailable stage"', async () => {
    mount();
    const badges = await screen.findAllByTestId('stage-badge');
    expect(badges.map(b => b.textContent)).toEqual(['Production', 'Unavailable stage']);
    expect(badges[0].textContent).not.toMatch(/Dispatched/);      // the stale stored value is not shown as the stage
  });

  it('offers "Unavailable stage" as a filter and sends it; there is no "Created" stage', async () => {
    mount();
    await screen.findAllByTestId('stage-badge');
    fireEvent.click(screen.getByRole('button', { name: /All Stages/ }));
    expect(screen.queryByLabelText('Created')).toBeNull();
    fireEvent.click(screen.getByLabelText('Unavailable stage'));
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/delivery-tracker', expect.objectContaining({
      params: expect.objectContaining({ status: 'unavailable' }),
    })));
  });

  it('the edit form shows the stage read-only and never submits production_stage', async () => {
    grant('projects:view', 'projects:edit');
    api.put.mockResolvedValue({ data: {} });
    mount();
    fireEvent.click((await screen.findAllByTestId('stage-badge'))[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Staged')).toBeTruthy());
    expect(screen.getByTestId('stage-readonly').textContent).toBe('Production');
    expect(screen.queryByRole('combobox', { name: /Production Stage/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe('/projects/projects/11');
    expect(body).not.toHaveProperty('production_stage');
  });

  it('a new project never submits production_stage either', async () => {
    grant('projects:view', 'projects:add');
    api.post.mockResolvedValue({ data: {} });
    mount();
    await screen.findAllByTestId('stage-badge');
    fireEvent.click(screen.getByRole('button', { name: /New/ }));
    fireEvent.change(await screen.findByPlaceholderText('Project name…'), { target: { value: 'Fresh' } });
    expect(screen.getByTestId('stage-readonly').textContent).toMatch(/Set by the lifecycle/);
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('production_stage');
  });

  it('a save refused for lack of permission says so', async () => {
    grant('projects:view', 'projects:edit');
    api.put.mockRejectedValue(httpError(403, { error: 'Forbidden' }));
    mount();
    fireEvent.click((await screen.findAllByTestId('stage-badge'))[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Staged')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText("You don't have permission to edit this project.")).toBeTruthy();
  });

  it('the expanded row opens the lifecycle, or says there is none', async () => {
    grant('projects:view', 'servicedesk:view');   // opening a lifecycle needs servicedesk:view
    const setPage = mount();
    const expanders = await screen.findAllByTitle('Expand');
    fireEvent.click(expanders[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Open lifecycle to change stage' }));
    expect(setPage).toHaveBeenCalledWith('LifecycleTracker', { lifecycleId: 501 });
    fireEvent.click(screen.getAllByTitle('Expand')[0]);
    expect(await screen.findByText(/No lifecycle — the stage is unavailable/)).toBeTruthy();
  });
});

// ── Project Pipeline ────────────────────────────────────────────────────────
describe('Project Pipeline board', () => {
  const mount = (setPage = vi.fn()) => {
    api.get.mockResolvedValue({ data: {
      columns: { production: [STAGED], dispatched: [], handover: [] },
      unavailable: [UNSTAGED], unavailable_count: 1,
    } });
    grant('projects:view', 'projects:edit', 'servicedesk:view');   // opening a lifecycle needs servicedesk:view
    render(<ProjectPipelineBoard setPage={setPage} />);
    return setPage;
  };

  it('has no dragging and no stage arrows; it never sets a stage', async () => {
    mount();
    const cards = await screen.findAllByTestId('pipeline-card');
    for (const c of cards) expect(c.getAttribute('draggable')).not.toBe('true');
    expect(screen.queryByTitle('Next stage')).toBeNull();
    expect(screen.queryByTitle('Previous stage')).toBeNull();
    expect(screen.getByRole('note').textContent).toMatch(/open its lifecycle and advance it/);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('shows projects without a lifecycle in their own "Unavailable stage" column', async () => {
    mount();
    const col = await screen.findByRole('region', { name: 'Unavailable stage' });
    expect(within(col).getByText('No lifecycle project')).toBeTruthy();
    expect(within(col).getByText(/No lifecycle — stage unavailable/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Production' })).getByText('Staged project')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Created' })).toBeNull();
  });

  it('opens the lifecycle from a card', async () => {
    const setPage = mount();
    fireEvent.click(await screen.findByRole('button', { name: /Open lifecycle/ }));
    expect(setPage).toHaveBeenCalledWith('LifecycleTracker', { lifecycleId: 501 });
  });

  it('a permission failure loading the board is explained', async () => {
    api.get.mockRejectedValue(httpError(403, { error: 'Forbidden' }));
    render(<ProjectPipelineBoard setPage={vi.fn()} />);
    expect(await screen.findByText("You don't have permission to view the project pipeline.")).toBeTruthy();
  });
});

// ── Lifecycle Tracker ───────────────────────────────────────────────────────
const MODEL = {
  stages: [
    { key: 'order', label: 'Order / Handover' }, { key: 'design', label: 'Design / Engineering' },
    { key: 'procurement', label: 'Procurement' }, { key: 'production', label: 'Production' },
    { key: 'testing', label: 'Testing / FAT' }, { key: 'clearing', label: 'Clearing', reserved: true },
    { key: 'dispatch', label: 'Dispatch' }, { key: 'installation', label: 'Installation' },
    { key: 'pre_commissioning', label: 'Pre-commissioning', reserved: true },
    { key: 'commissioning', label: 'Commissioning' }, { key: 'sat', label: 'SAT (Site Acceptance)' },
    { key: 'closure', label: 'Closure' },
  ],
  final_stage: 'closure',
};
const lifecycle = (over = {}) => ({
  id: 501, lifecycle_number: 'LC-000501', current_stage: 'testing', status: 'active',
  next_stage: 'dispatch', next_stage_gates: ['fat_passed', 'no_open_ncrs', 'no_open_punch_points'],
  gates: { fat_passed: false, no_open_ncrs: true, no_open_punch_points: true },
  history: [{ id: 1, action: 'advance', from_stage: 'service', to_stage: 'amc', actor_name: 'Old', created_at: '2026-01-01T00:00:00Z' }],
  ...over,
});
function mountTracker(detail) {
  api.get.mockImplementation((url) => {
    if (url === '/lifecycle/stages') return Promise.resolve({ data: MODEL });
    if (url === '/lifecycle/instances') return Promise.resolve({ data: [{ id: 501, lifecycle_number: 'LC-000501', current_stage: detail.current_stage, status: detail.status }] });
    if (url === '/lifecycle/instances/501') return Promise.resolve({ data: detail });
    return Promise.resolve({ data: [] });
  });
  render(<LifecycleTracker pageParams={{ lifecycleId: 501 }} />);
}

describe('Lifecycle Tracker', () => {
  it('opens the lifecycle it was sent to, and offers no Service / AMC stage while still reading old history', async () => {
    grant('servicedesk:view');
    mountTracker(lifecycle());
    expect(await screen.findByRole('heading', { name: 'LC-000501' })).toBeTruthy();
    const filter = screen.getByLabelText('Stage filter');
    const options = within(filter).getAllByRole('option').map(o => o.textContent);
    expect(options).not.toContain('Service');
    expect(options).not.toContain('AMC');
    expect(options).not.toContain('Clearing');
    expect(screen.queryByTestId('pipeline-stage-service')).toBeNull();
    expect(screen.getByText('Service (legacy) → AMC (legacy)')).toBeTruthy();
  });

  it('a view-only user sees no Advance, Rollback, Cancel or Complete', async () => {
    grant('servicedesk:view');
    mountTracker(lifecycle());
    await screen.findByRole('heading', { name: 'LC-000501' });
    expect(screen.queryByRole('button', { name: /Advance to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Roll back/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Cancel$/ })).toBeNull();
    expect(screen.getByText(/You don't have permission to advance lifecycles/)).toBeTruthy();
  });

  it('a refused advance lists exactly what is missing', async () => {
    grant('servicedesk:view', 'servicedesk:edit');
    api.post.mockRejectedValue(httpError(422, {
      code: 'GATE_NOT_SATISFIED', failing: ['fat_passed'],
      gates: { fat_passed: false }, gate_details: { fat_passed: { without_passed_fat: [7] } },
    }));
    mountTracker(lifecycle());
    fireEvent.click(await screen.findByRole('button', { name: 'Advance to Dispatch' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/lifecycle/instances/501/advance', { remarks: '', to_stage: 'dispatch' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/FAT passed for every production order/);
    expect(toast.error).toHaveBeenCalledWith('Not ready to move on — still needed: FAT passed for every production order.');
    // An editor without approve still has no rollback / cancel.
    expect(screen.queryByRole('button', { name: /Roll back/ })).toBeNull();
  });

  it('rollback needs a reason before it can be confirmed, then posts the chosen stage and reason', async () => {
    grant('servicedesk:view', 'servicedesk:edit', 'servicedesk:approve');
    api.post.mockResolvedValue({ data: {} });
    mountTracker(lifecycle());
    fireEvent.click(await screen.findByRole('button', { name: /Roll back/ }));
    const dialog = screen.getByRole('dialog', { name: 'Move lifecycle back' });
    const confirm = within(dialog).getByRole('button', { name: 'Move back' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Move back to'), { target: { value: 'design' } });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Redo' } });
    expect(confirm).toBeDisabled();                                   // under 5 characters
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Customer changed the design' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/lifecycle/instances/501/rollback',
      { reason: 'Customer changed the design', to_stage: 'design' }));
  });

  it('cancel asks for confirmation with a reason', async () => {
    grant('servicedesk:view', 'servicedesk:edit', 'servicedesk:approve');
    api.post.mockResolvedValue({ data: {} });
    mountTracker(lifecycle());
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/ }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel lifecycle' });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Order withdrawn' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel lifecycle' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/lifecycle/instances/501/cancel', { reason: 'Order withdrawn' }));
  });

  it('a completed lifecycle offers Reopen (with a reason), not Resume', async () => {
    grant('servicedesk:view', 'servicedesk:edit', 'servicedesk:approve');
    api.post.mockResolvedValue({ data: {} });
    mountTracker(lifecycle({ status: 'completed', current_stage: 'closure', next_stage: null, next_stage_gates: [] }));
    await screen.findByRole('heading', { name: 'LC-000501' });
    expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reopen/ }));
    const dialog = screen.getByRole('dialog', { name: 'Reopen lifecycle' });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Snag found on site' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/lifecycle/instances/501/reopen', { reason: 'Snag found on site' }));
  });

  it('complete at Closure shows the blockers and then asks for an override reason', async () => {
    grant('servicedesk:view', 'servicedesk:edit', 'servicedesk:approve');
    api.post
      .mockRejectedValueOnce(httpError(422, { code: 'CLOSURE_BLOCKED', blockers: [{ type: 'open_tasks', count: 1 }] }))
      .mockResolvedValueOnce({ data: {} });
    mountTracker(lifecycle({ current_stage: 'closure', next_stage: null, next_stage_gates: [] }));
    fireEvent.click(await screen.findByRole('button', { name: /Complete/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Complete lifecycle' })).getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/lifecycle/instances/501/complete', {}));
    const dialog = await screen.findByRole('dialog', { name: 'Complete lifecycle' });
    expect(await within(dialog).findByText('1 open task(s)')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Complete with override' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Override reason/), { target: { value: 'Snags handed to O&M' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/lifecycle/instances/501/complete', { override_reason: 'Snags handed to O&M' }));
  });

  it('the route hands the page its parameters', () => {
    const props = ROUTES.LifecycleTracker.props({ setPage: 'sp', pageParams: { lifecycleId: 9 } });
    expect(props).toEqual({ setPage: 'sp', pageParams: { lifecycleId: 9 } });
  });
});
