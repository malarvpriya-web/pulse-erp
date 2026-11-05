/**
 * Home's My Pending Approvals card is a short preview of the Approval Center's
 * My Pending Approvals (GET /home/summary → myApprovals.awaitingMyAction is the
 * first few rows of that same list, every module included). "View all" opens
 * the full list.
 *
 * My Intern Evaluations / My Probation Reviews have no sidebar row and no
 * separate block on Home: a pending evaluation or review is simply one of the
 * rows, and clicking it opens its own form.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../pages/Home.css', () => ({}));
vi.mock('../components/dashboard/CelebrationsBoard', () => ({ default: () => null }));
vi.mock('../components/attendance/CameraClockModal', () => ({ default: () => null }));
vi.mock('../components/attendance/geo', () => ({ getLocationString: () => Promise.resolve('') }));

const env = vi.hoisted(() => ({ myApprovals: null, roles: ['manager'] }));

vi.mock('@/services/api/client', () => ({
  default: {
    get: vi.fn(async (url) => {
      if (url === '/home/summary') {
        return { data: { myTasks: [], myApprovals: env.myApprovals,
          announcements: [], policies: [], brandAssets: [] } };
      }
      if (url === '/attendance/punch-mode') return { data: { can_punch_in_app: false, reason: 'device_only' } };
      if (url === '/intern-evaluations/mine/summary') return { data: { linked: true, is_mentor: true, needs_action: 1 } };
      if (url === '/probation-reviews/mine/summary') return { data: { linked: true, is_head: true, departments: ['Sales'], needs_action: 1 } };
      return { data: [] };
    }),
  },
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Test User', email: 't@manifest.in' },
    roles: env.roles, role: env.roles[0],
    hasAnyRole: (...r) => r.some((x) => env.roles.includes(x)),
    isEmployeeOnly: false,
    hasPermission: () => true,
    menuAccess: () => null,
  }),
}));

import Home from '@/pages/Home.jsx';
import Sidebar from '@/components/Sidebar';

const LEAVE = { id: 'leave:4', request_type: 'Leave', request_title: 'Casual Leave · 02 Nov', requested_by: 'Asha Rao',
  request_date: '2026-10-20T09:00:00Z', open: null };
const INTERN = { id: 'ieval:56:1', request_type: 'Intern Evaluation', request_title: 'Evaluate intern Priya (INT001)',
  requested_by: 'HR', request_date: '2026-10-19T09:00:00Z', open: { page: 'MyInternEvaluations', params: {} } };
const PROB = { id: 'prob:41', request_type: 'Probation Review', request_title: 'Probation review · Meena S (EMP041)',
  requested_by: 'HR', request_date: '2026-10-18T09:00:00Z', open: { page: 'MyProbationReviews', params: { ref: '41' } } };

async function homeWith(myApprovals) {
  env.myApprovals = myApprovals;
  const setPage = vi.fn();
  render(<Home setPage={setPage} />);
  await waitFor(() => expect(document.querySelector('.hm-skeleton-list')).toBeNull());
  return setPage;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('Home — My Pending Approvals card', () => {
  it('lists the pending rows of every type — intern and probation reviews among them — with no sub-sections', async () => {
    await homeWith({ awaitingMyAction: [PROB, INTERN, LEAVE], awaitingMyActionTotal: 3, awaitingOthers: [] });
    expect(screen.getByText(PROB.request_title)).toBeDefined();
    expect(screen.getByText(INTERN.request_title)).toBeDefined();
    expect(screen.getByText(LEAVE.request_title)).toBeDefined();
    for (const gone of ['My reviews', 'Awaiting my action', 'Awaiting others',
      'You have no requests pending sign-off.', 'My Intern Evaluations', 'My Probation Reviews']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it('a review opens its own form; any other request opens the Approval Center', async () => {
    const setPage = await homeWith({ awaitingMyAction: [PROB, LEAVE], awaitingMyActionTotal: 2, awaitingOthers: [] });
    fireEvent.click(screen.getByText(PROB.request_title));
    expect(setPage).toHaveBeenLastCalledWith('MyProbationReviews', { ref: '41' });
    fireEvent.click(screen.getByText(LEAVE.request_title));
    expect(setPage).toHaveBeenLastCalledWith('ApprovalCenter');
  });

  it('View all opens the Approval Center, and says how many more it holds', async () => {
    const setPage = await homeWith({ awaitingMyAction: [PROB, INTERN, LEAVE], awaitingMyActionTotal: 9, awaitingOthers: [] });
    expect(screen.getByText('+6 more in View all')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'View all approvals' }));
    expect(setPage).toHaveBeenCalledWith('ApprovalCenter');
  });

  it('To Action counts everything waiting, not just the preview, and opens the Approval Center', async () => {
    const setPage = await homeWith({ awaitingMyAction: [LEAVE], awaitingMyActionTotal: 9, awaitingOthers: [] });
    const kpi = screen.getByText('To Action').closest('button');
    expect(kpi.textContent).toContain('9');
    fireEvent.click(kpi);
    expect(setPage).toHaveBeenCalledWith('ApprovalCenter');
  });

  it('says so when nothing is waiting', async () => {
    await homeWith({ awaitingMyAction: [], awaitingMyActionTotal: 0, awaitingOthers: [] });
    expect(screen.getByText('Nothing needs your sign-off.')).toBeDefined();
  });
});

describe('the sidebar no longer carries the review pages', () => {
  it('even an admin (who sees every menu) has neither in the rail; Approvals stays', async () => {
    env.roles = ['admin'];   // admins see every menu — the strongest case
    const view = render(<MemoryRouter><Sidebar /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    const labels = [...view.container.querySelectorAll('.nav-item .label')].map((l) => l.textContent);
    expect(labels).toContain('Approvals');
    expect(labels).not.toContain('My Intern Evaluations');
    expect(labels).not.toContain('My Probation Reviews');
    env.roles = ['manager'];
  });
});
