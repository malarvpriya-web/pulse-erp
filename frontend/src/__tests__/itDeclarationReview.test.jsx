/**
 * HR → IT Declaration Review (§203) — the reviewer side of Self-Service IT
 * declarations, over the SAME rows (no copy):
 *  - who reaches it: the it_declarations grant (menu row + URL), never a role;
 *  - it lists the queue, approves, rejects only with a reason, reopens, and
 *    shows the audit history; a reviewer's own declaration is not actionable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const auth = vi.hoisted(() => ({ grants: new Set(['it_declarations:view', 'it_declarations:approve']) }));
vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), put: vi.fn() } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }) }));

import api from '../services/api/client';
import ITDeclarationReview from '../features/hr/pages/ITDeclarationReview.jsx';
import { ROUTES, NAV_ITEMS } from '../config/routes';
import { canRenderPage } from '../config/menuCatalog';

const ROWS = [
  { id: 11, employee_id: 2, employee_name: 'Ravi Kumar', employee_code: 'EMP002', declaration_type: '80C', amount: '50000', description: 'PPF', proof_url: 'https://drive/ppf', status: 'submitted', can_review: true, created_at: '2026-10-01' },
  { id: 12, employee_id: 3, employee_name: 'Me Myself', employee_code: 'EMP003', declaration_type: 'HRA', amount: '24000', description: 'Rent', proof_url: 'javascript:alert(1)', status: 'submitted', can_review: false, created_at: '2026-10-02' },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.grants = new Set(['it_declarations:view', 'it_declarations:approve']);
  api.get.mockImplementation((url) => Promise.resolve({ data: url.endsWith('/history')
    ? { events: [{ id: 1, at: '2026-10-05', by_name: 'Pay Admin', action: 'reject', from_status: 'submitted', to_status: 'rejected', remarks: 'Proof missing' }] }
    : ROWS }));
  api.put.mockResolvedValue({ data: {} });
});

describe('who reaches the page', () => {
  it('is an HR row and a route gated on it_declarations', () => {
    const hr = NAV_ITEMS.find(g => g.name === 'HR');
    expect(hr.submenu.find(s => s.page === 'ITDeclarationReview')).toMatchObject({ module: 'it_declarations' });
    expect(ROUTES.ITDeclarationReview.module).toBe('it_declarations');
  });

  it('opens with the grant, refuses without it — whatever the HR role', () => {
    const route = ROUTES.ITDeclarationReview;
    const has = (g) => (m, a) => g.includes(`${m}:${a}`);
    expect(canRenderPage('hr_manager', 'ITDeclarationReview', { route, hasPermission: has(['it_declarations:view']) })).toBe(true);
    expect(canRenderPage('payroll_admin', 'ITDeclarationReview', { route, hasPermission: has(['it_declarations:view']) })).toBe(true);
    for (const role of ['hr', 'hr_exec', 'employee', 'manager']) {
      expect(canRenderPage(role, 'ITDeclarationReview', { route, hasPermission: has(['hr:view']) }), role).toBe(false);
    }
  });
});

describe('reviewing', () => {
  it('lists the queue; own declarations are not actionable; only web proof links open', async () => {
    render(<ITDeclarationReview />);
    const rows = await screen.findAllByTestId('itdr-row');
    expect(rows).toHaveLength(2);
    expect(api.get).toHaveBeenCalledWith('/self-service/it-declarations/review', { params: { financial_year: expect.stringMatching(/^\d{4}-\d{4}$/), status: 'submitted' } });
    expect(rows[0].textContent).toContain('Approve');
    expect(rows[1].textContent).not.toContain('Approve');
    expect(rows[1].textContent).toContain('another reviewer decides');
    expect(rows[0].querySelector('a[href="https://drive/ppf"]')).toBeTruthy();
    expect(rows[1].querySelector('a')).toBeNull();
  });

  it('approve moves the existing record', async () => {
    render(<ITDeclarationReview />);
    const [row] = await screen.findAllByTestId('itdr-row');
    fireEvent.click(row.querySelector('button'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/self-service/it-declarations/11', { status: 'approved' }));
  });

  it('reject needs a reason, then sends it', async () => {
    render(<ITDeclarationReview />);
    await screen.findAllByTestId('itdr-row');
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);
    const confirm = screen.getByRole('button', { name: 'Confirm rejection' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason for rejection/), { target: { value: 'Proof missing' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/self-service/it-declarations/11', { status: 'rejected', remarks: 'Proof missing' }));
  });

  it('shows the audit history', async () => {
    render(<ITDeclarationReview />);
    await screen.findAllByTestId('itdr-row');
    fireEvent.click(screen.getAllByRole('button', { name: 'History' })[0]);
    expect(await screen.findByText(/Pay Admin: submitted → rejected/)).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('/self-service/it-declarations/11/history');
  });

  it('view-only holders see the queue without decision buttons', async () => {
    auth.grants = new Set(['it_declarations:view']);
    render(<ITDeclarationReview />);
    await screen.findAllByTestId('itdr-row');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText(/View only/)).toBeTruthy();
  });
});
