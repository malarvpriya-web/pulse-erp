import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';

// Approval Center — one page, three tabs. These pin the behaviours the
// consolidation exists for:
//   * a non-approver sees only My Requests, with help text naming where
//     requests are raised (there is no request form here);
//   * SLA compliance with no decisions reads "No data", never 100%;
//   * Approve/Reject run the ORIGINATING MODULE's endpoint handed back by the
//     server (e.g. PUT /travel/requests/9/status), never /approvals/<id>/approve;
//   * a rejection reason is mandatory and travels in the module's own field.

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: '/ApprovalCenter', search: '', hash: '', state: null }),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ role: 'manager', roles: ['manager'], menuAccess: () => null, hasPermission: () => true }),
}));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../services/api/client', () => ({ default: api }));

import ApprovalCenter from '../features/approvals/pages/ApprovalCenter';

const STATS_APPROVER = {
  pending: 1, overdue: 0, approvedToday: 0, rejectedToday: 0, slaCompliance: null, slaDecisions: 0,
  sla: { default_hours: 48, configured: [{ type: 'travel', label: 'Travel', hours: 72 }] }, isApprover: true,
};
const TRAVEL_ROW = {
  id: 'travel:9', type: 'travel', request_type: 'Travel', request_title: 'Travel TR-9 · Pune (20 Nov)',
  requested_by: 'Asha Rao', request_date: '2026-10-18T10:00:00Z', amount: null, stage: 'Reporting manager',
  sla_hours: 72, sla_source: 'configured', waiting_hours: 5, overdue: false, link_page: 'TravelApprovals', can_act: true,
  actions: {
    approve: { method: 'put', url: '/travel/requests/9/status', body: { status: 'Approved' }, commentKey: 'comments' },
    reject:  { method: 'put', url: '/travel/requests/9/status', body: { status: 'Rejected' }, commentKey: 'comments', commentRequired: true },
  },
};

function serve({ stats, pending = [], mine = [], history = [] }) {
  api.get.mockImplementation((url) => {
    if (url === '/approvals/stats') return Promise.resolve({ data: stats });
    if (url === '/approvals/pending') return Promise.resolve({ data: pending });
    if (url === '/approvals/my-requests') return Promise.resolve({ data: { submitted: mine } });
    if (url === '/approvals/history') return Promise.resolve({ data: history });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  api.put.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: {} });
});

describe('Approval Center', () => {
  it('a non-approver gets only My Requests, with where-to-submit help and an explanatory empty state', async () => {
    serve({ stats: { ...STATS_APPROVER, pending: 0, isApprover: false } });
    render(<ApprovalCenter />);

    await screen.findByText(/haven't submitted any requests yet/i);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['My Requests']);
    expect(screen.getByText(/raised in their own modules/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(screen.getByText(/There is no form here/i)).toBeTruthy();
    // No KPI band for someone who approves nothing.
    expect(screen.queryByText('SLA compliance')).toBeNull();
  });

  it('shows all three tabs to an approver and "No data" — not 100% — when there are no decisions', async () => {
    serve({ stats: STATS_APPROVER, pending: [TRAVEL_ROW] });
    render(<ApprovalCenter />);

    await screen.findByText(TRAVEL_ROW.request_title);
    expect(screen.getAllByRole('tab').map((t) => t.textContent.replace(/\d+$/, ''))).toEqual(
      ['My Pending Approvals', 'My Requests', 'Approval History']);
    expect(screen.getByText('No data')).toBeTruthy();
    expect(screen.queryByText('100%')).toBeNull();
  });

  it('Approve runs the originating module endpoint, not /approvals', async () => {
    serve({ stats: STATS_APPROVER, pending: [TRAVEL_ROW] });
    render(<ApprovalCenter />);

    const row = (await screen.findByText(TRAVEL_ROW.request_title)).closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/travel/requests/9/status', { status: 'Approved' }));
    expect(api.post).not.toHaveBeenCalledWith(expect.stringMatching(/^\/approvals\//), expect.anything());
  });

  it('Reject requires a reason and sends it in the module\'s own field', async () => {
    serve({ stats: STATS_APPROVER, pending: [TRAVEL_ROW] });
    render(<ApprovalCenter />);

    const row = (await screen.findByText(TRAVEL_ROW.request_title)).closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: 'Reject' }));

    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reject' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Combine with the Mumbai trip' } });
    fireEvent.click(confirm);

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/travel/requests/9/status',
      { status: 'Rejected', comments: 'Combine with the Mumbai trip' }));
  });

  it('an intern evaluation / probation review is listed with Open (its own form), not Approve/Reject', async () => {
    const PROB_ROW = {
      id: 'prob:41', type: 'prob', request_type: 'Probation Review', request_title: 'Probation review · Meena S (EMP041)',
      requested_by: 'HR', request_date: '2026-10-18T10:00:00Z', amount: null, stage: 'Department head',
      sla_hours: 48, sla_source: 'default', waiting_hours: 5, overdue: false, link_page: 'MyProbationReviews', can_act: true,
      actions: { open: { page: 'MyProbationReviews', params: { ref: '41' } } },
    };
    serve({ stats: STATS_APPROVER, pending: [TRAVEL_ROW, PROB_ROW] });
    render(<ApprovalCenter />);

    const row = (await screen.findByText(PROB_ROW.request_title)).closest('tr');
    expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(within(row).queryByRole('checkbox')).toBeNull();   // never in a bulk approve
    fireEvent.click(within(row).getByRole('button', { name: 'Open' }));
    expect(navigate).toHaveBeenCalledWith('/MyProbationReviews?ref=41');
  });

  it('My Requests shows status, who it is waiting on, and Withdraw where the module supports it', async () => {
    serve({
      stats: { ...STATS_APPROVER, isApprover: false },
      mine: [{
        id: 'leave:4', type: 'leave', request_type: 'Leave', request_title: 'Casual Leave · 02 Nov 26',
        request_date: '2026-10-18T09:00:00Z', amount: 1, amount_unit: 'days', status: 'Pending',
        current_approver: 'Ravi Kumar', link_page: 'MyLeaves',
        actions: { withdraw: { method: 'post', url: '/leaves/4/withdraw', body: {}, commentKey: 'reason', commentRequired: true } },
      }],
    });
    render(<ApprovalCenter />);

    const row = (await screen.findByText('Casual Leave · 02 Nov 26')).closest('tr');
    expect(within(row).getByText('Pending')).toBeTruthy();
    expect(within(row).getByText('Ravi Kumar')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Plans changed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leaves/4/withdraw', { reason: 'Plans changed' }));
  });
});
