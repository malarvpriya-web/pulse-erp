/**
 * Settlement Review (HR audit 2026-11-16): the F&F is read, never recomputed —
 * every earlier view recomputed it, which made the viewer its computer and so
 * unable to approve it. Approve is offered only when the server says so; when
 * not, the reason is shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
import api from '../services/api/client';
import SettlementReview from '../features/hr/pages/SettlementReview.jsx';

const BODY = (over = {}) => ({
  exit: { id: 9, employee_id: 4, office_id: 'EMP104', first_name: 'Ravi', last_name: 'Das', separation_type: 'resignation', last_working_date: '2026-11-30' },
  settlement: { id: 31, version: 2, net_payable: 45000, total_payable: 50000, total_recoverable: 5000, computed_at: '2026-11-16T10:00:00Z', computed_by_name: 'HR Lead',
    lines: [{ code: 'FINAL_SALARY', label: 'Final salary', basis: '30 days', tax: 'Taxable', amount: 50000, direction: 'payable' }], warnings: [], rules_unconfirmed: [] },
  approval: null, payment: null, clearance_blockers: [], suspended: false, can_approve: true, can_pay: false, why_not: null,
  ...over,
});
const open = () => render(<MemoryRouter initialEntries={['/SettlementReview?exit=9']}><SettlementReview /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); cleanup(); });

describe('Settlement Review', () => {
  it('shows the saved version and approves that version, without recomputing', async () => {
    api.get.mockResolvedValue({ data: BODY() });
    api.put.mockResolvedValue({ data: {} });
    open();
    await screen.findByText('Final salary');
    expect(api.get).toHaveBeenCalledWith('/exit/fnf/review/9');
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/exit/fnf/9/approve', { settlement_id: 31 }));
    expect(api.post).not.toHaveBeenCalled();   // no /exit/fnf/compute
  });

  it('says why it cannot be approved instead of offering the button', async () => {
    api.get.mockResolvedValue({ data: BODY({ can_approve: false, why_not: 'You computed this version, so someone else must approve it.' }) });
    open();
    await screen.findByText(/You computed this version/);
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });
});
