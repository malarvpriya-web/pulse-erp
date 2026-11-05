import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// An ECN is decided only by its named approvers (policy 2026-10-20). A change
// with none — e.g. the one a BOM version raises — shows a picker, Submit is
// disabled until an approver is saved, and the save goes to the ECN's own
// PUT route with LOGIN ids (approver_id is a users.id).

vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../services/api/client', () => ({ default: api }));

import ECNManagement from '../features/engineering/pages/ECNManagement';

const ECN = { id: 7, ecn_number: 'ECN-00007', title: 'BOM v2 for Pump', status: 'draft', severity: 'medium', change_type: 'ECN', impacted_items: 1 };

function serve(approvals) {
  api.get.mockImplementation((url) => {
    if (url === '/engineering/ecn/changes') return Promise.resolve({ data: [ECN] });
    if (url === '/engineering/ecn/changes/7') return Promise.resolve({ data: { ...ECN, approvals, items: [], events: [] } });
    if (url === '/approvals/delegates') return Promise.resolve({ data: [
      { id: 21, user_id: 892, name: 'Priya Menon', designation: 'QA Lead' },
      { id: 22, user_id: 893, name: 'Ravi Kumar', designation: 'Design Lead' },
    ] });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => { cleanup(); vi.clearAllMocks(); api.put.mockResolvedValue({ data: {} }); });

describe('ECN approver picker', () => {
  it('a change with no approvers cannot be submitted until one is named, and saves login ids', async () => {
    serve([]);
    render(<ECNManagement />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

    await screen.findByText(/No approvers named/);
    expect(screen.getByRole('button', { name: /Submit for Approval/ }).disabled).toBe(true);

    // The list is browsable without typing.
    fireEvent.click(await screen.findByLabelText(/Priya Menon/));
    fireEvent.click(screen.getByRole('button', { name: /Save 1 approver/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/engineering/ecn/changes/7', {
      approvers: [{ approver_id: 892, approver_name: 'Priya Menon' }],
    }));
  // 15s: renders the whole ECN page; ~0.4s alone, but it overran the 5s default
  // under full-suite load (2026-10-29).
  }, 15000);

  it('a change that already has approvers shows no picker and can be submitted', async () => {
    serve([{ id: 1, approver_name: 'Priya Menon', status: 'pending' }]);
    render(<ECNManagement />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await screen.findByText('Priya Menon');
    expect(screen.queryByText(/No approvers named/)).toBeNull();
    expect(screen.getByRole('button', { name: /Submit for Approval/ }).disabled).toBe(false);
  });
});
