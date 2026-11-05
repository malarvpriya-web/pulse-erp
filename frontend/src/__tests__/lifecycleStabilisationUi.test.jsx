/**
 * Lifecycle workstream stabilisation (UI):
 *  - Lifecycle Tracker access follows servicedesk:view in the menu, the route
 *    and the page; a refusal is an explicit "Access denied", never an empty list.
 *  - "Open lifecycle" is disabled for users who cannot view lifecycles.
 *  - Project Workflow Tracker and Project Reports show the stage the backend
 *    derives from the lifecycle, and "Unavailable stage" without one — never the
 *    administrative status or a raw/guessed value.
 * The server enforces the rules (integration.lifecycleStabilisation and
 * integration.lifecycleStages); these check what the screens do with them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() } }));
const auth = vi.hoisted(() => ({ roles: ['manager'], grants: new Set() }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    roles: auth.roles,
    role: auth.roles[0],
    hasAnyRole: (...r) => r.some(x => auth.roles.includes(x)),
    isEmployeeOnly: auth.roles.length === 1 && auth.roles[0] === 'employee',
    hasPermission: (m, a) => auth.grants.has(`${m}:${a}`),
    menuAccess: () => null,
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/context/ToastContext', () => ({ useToast: () => toast }));
vi.mock('@/components/core/VocabSelect', () => ({ default: () => <select aria-label="Project type" /> }));
vi.mock('@/features/operations/pages/ProjectWorkflowTracker.css', () => ({}));

import api from '@/services/api/client';
import Sidebar from '@/components/Sidebar';
import { ROUTES, NAV_ITEMS } from '@/config/routes';
import LifecycleTracker from '@/features/operations/pages/LifecycleTracker.jsx';
import ProjectWorkflowTracker from '@/features/operations/pages/ProjectWorkflowTracker.jsx';
import ProjectReports from '@/features/projects/pages/ProjectReports.jsx';
import ProjectPipelineBoard from '@/features/projects/pages/ProjectPipelineBoard.jsx';

const grant = (roles, ...g) => { auth.roles = roles; auth.grants = new Set(g); };
const httpError = (status, data) => Object.assign(new Error('http'), { response: { status, data } });

beforeEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: [] });
});

// ── access alignment ────────────────────────────────────────────────────────
describe('Lifecycle Tracker access follows servicedesk:view', () => {
  it('the route and the menu row both declare servicedesk', () => {
    expect(ROUTES.LifecycleTracker.module).toBe('servicedesk');
    const row = NAV_ITEMS.find(g => g.name === 'Operations').submenu.find(s => s.page === 'LifecycleTracker');
    expect(row.module).toBe('servicedesk');
  });

  /** Open the Operations group in the REAL sidebar and return its row labels. */
  const operationsRows = () => {
    const { container } = render(<MemoryRouter><Sidebar /></MemoryRouter>);
    const ops = [...container.querySelectorAll('.nav-item[aria-expanded]')].find(b => b.querySelector('.label')?.textContent === 'Operations');
    expect(ops, 'Operations group is shown to a manager').toBeTruthy();
    fireEvent.click(ops);
    return [...document.body.querySelectorAll('*')].filter(el => el.children.length === 0).map(el => el.textContent.trim());
  };

  it('a manager with servicedesk:view sees the row', () => {
    grant(['manager'], 'servicedesk:view');
    const rows = operationsRows();
    expect(rows).toContain('Lifecycle Tracker');
    expect(rows).toContain('Project Tracker');
  });

  it('a manager without servicedesk:view does not — the rest of Operations is unchanged', () => {
    grant(['manager']);
    const rows = operationsRows();
    expect(rows).not.toContain('Lifecycle Tracker');
    expect(rows).toContain('Project Tracker');
  });

  it('the page shows Access denied without the grant, and asks the server for nothing', () => {
    grant(['manager']);
    render(<LifecycleTracker />);
    expect(screen.getByRole('alert').textContent).toMatch(/Access denied/);
    expect(api.get).not.toHaveBeenCalledWith('/lifecycle/instances', expect.anything());
  });

  it('a server refusal (403) is Access denied too, not an empty list', async () => {
    grant(['manager'], 'servicedesk:view');
    api.get.mockImplementation((url) => (url === '/lifecycle/instances'
      ? Promise.reject(httpError(403, { error: 'Forbidden' }))
      : Promise.resolve({ data: { stages: [] } })));
    render(<LifecycleTracker />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Access denied/);
    expect(screen.queryByText('No lifecycle instances found')).toBeNull();
  });

  it('"Open lifecycle" is disabled, with a reason, for someone who cannot view lifecycles', async () => {
    grant(['manager'], 'projects:view');
    api.get.mockResolvedValue({ data: { columns: { production: [{ project_id: 1, ipp: 'IPP-1', description: 'P', production_stage: 'production', stage_source: 'lifecycle', lifecycle_id: 7 }] }, unavailable: [] } });
    const setPage = vi.fn();
    render(<ProjectPipelineBoard setPage={setPage} />);
    const btn = await screen.findByRole('button', { name: /Open lifecycle/ });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/Service Desk view access/);
    fireEvent.click(btn);
    expect(setPage).not.toHaveBeenCalled();
  });
});

// ── Project Workflow Tracker ────────────────────────────────────────────────
describe('Project Workflow Tracker stage', () => {
  it('shows the lifecycle-derived stage, and "Unavailable stage" — never the administrative status', async () => {
    api.get.mockImplementation((url) => Promise.resolve({ data: url === '/operations/project-tracker' ? [
      { id: 1, project_name: 'Staged', status: 'active', production_stage: 'dr_approval', stage_source: 'lifecycle', stored_production_stage: 'dispatched' },
      { id: 2, project_name: 'No lifecycle', status: 'planning', production_stage: null, stage_source: 'unavailable', stored_production_stage: 'production' },
    ] : [] }));
    render(<ProjectWorkflowTracker />);
    const stages = await screen.findAllByTestId('pwt-stage');
    expect(stages.map(s => s.textContent)).toEqual(['DR Approval', 'Unavailable stage']);
    expect(stages.map(s => s.textContent)).not.toContain('planning');
    expect(stages.map(s => s.textContent)).not.toContain('Dispatched');
  });
});

// ── Project Reports ─────────────────────────────────────────────────────────
describe('Project Reports status report stage', () => {
  const open = async (report) => {
    api.get.mockImplementation((url) => {
      if (url === '/projects/projects') return Promise.resolve({ data: [{ id: 5, project_code: 'PRJ-5', project_name: 'Five' }] });
      if (url === '/projects/projects/5/status-report') return Promise.resolve({ data: { report } });
      return Promise.resolve({ data: [] });
    });
    render(<ProjectReports />);
    await waitFor(() => expect(screen.getByRole('option', { name: /PRJ-5/ })).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '5' } });
    return screen.findByTestId('report-stage');
  };

  it('shows the derived stage from the shared mapping', async () => {
    const el = await open({ current_stage: 'installation', lifecycle_stage: 'installation', production_stage: 'dispatched', stage_source: 'lifecycle' });
    expect(el.textContent).toBe('Dispatched');
  });

  it('shows "Unavailable stage" when the project has no lifecycle — no raw value, no "N/A"', async () => {
    const el = await open({ current_stage: null, production_stage: null, stage_source: 'unavailable' });
    expect(el.textContent).toBe('Unavailable stage');
  });
});
