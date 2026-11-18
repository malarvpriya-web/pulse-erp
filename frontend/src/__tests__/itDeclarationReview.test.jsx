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
vi.mock('../features/employees/shared/employeeFiles', () => ({ openEmployeeFile: vi.fn(() => Promise.resolve()) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }) }));

import api from '../services/api/client';
import { openEmployeeFile } from '../features/employees/shared/employeeFiles';
import ITDeclarationReview from '../features/hr/pages/ITDeclarationReview.jsx';
import { ROUTES, NAV_ITEMS } from '../config/routes';
import { canRenderPage, payrollHubRedirect } from '../config/menuCatalog';
import { SECTIONS } from '../features/hr/components/payroll/payrollCenterTabs';

const ROWS = [
  { id: 11, employee_id: 2, employee_name: 'Ravi Kumar', employee_code: 'EMP002', declaration_type: '80C', amount: '50000', claimed_amount: '50000', regime: 'new', regime_source: 'company', counts_for_tax: false, section_total: '50000', section_limit: 150000, description: 'PPF', proof_url: 'https://drive/ppf', status: 'submitted', can_review: true, created_at: '2026-10-01' },
  { id: 12, employee_id: 3, employee_name: 'Me Myself', employee_code: 'EMP003', declaration_type: 'HRA', amount: '24000', claimed_amount: '24000', metro_city: true, regime: 'new', regime_source: 'company', counts_for_tax: false, section_total: '24000', section_limit: null, description: 'Rent', proof_url: 'javascript:alert(1)', status: 'submitted', can_review: false, created_at: '2026-10-02' },
];

let POLICY = { cutoff_month: 1, cutoff_label: 'January', counts_now: ['approved', 'submitted'] };

beforeEach(() => {
  POLICY = { cutoff_month: 1, cutoff_label: 'January', counts_now: ['approved', 'submitted'] };
  vi.clearAllMocks();
  auth.grants = new Set(['it_declarations:view', 'it_declarations:approve']);
  api.get.mockImplementation((url) => Promise.resolve({ data: url.endsWith('/policy') ? POLICY : url.endsWith('/history')
    ? { events: [{ id: 1, at: '2026-10-05', by_name: 'Pay Admin', action: 'reject', from_status: 'submitted', to_status: 'rejected', from_amount: '50000', to_amount: '50000', remarks: 'Proof missing' }, { id: 2, at: '2026-10-06', by_name: 'Pay Admin', action: 'approve', from_status: 'submitted', to_status: 'approved', from_amount: '50000', to_amount: '30000', remarks: 'Part proved' }] }
    : ROWS }));
  api.put.mockResolvedValue({ data: {} });
});

describe('who reaches the page', () => {
  it('is a Payroll Center view (Tax & Statutory), not an HR menu row; the old key stays routed', () => {
    const hr = NAV_ITEMS.find(g => g.name === 'HR');
    expect(hr.submenu.find(s => s.page === 'ITDeclarationReview')).toBeUndefined();
    const statutory = SECTIONS.find(s => s.id === 'statutory');
    expect(statutory.views.find(v => v.id === 'declarations')).toMatchObject({ grant: ['it_declarations', 'view'] });
    expect(ROUTES.ITDeclarationReview.module).toBe('it_declarations');
  });

  it('the old page key sends grant holders to the view, and nobody else', () => {
    const route = ROUTES.PayrollCenter;
    const has = (g) => (m, a) => g.includes(`${m}:${a}`);
    expect(payrollHubRedirect('payroll_admin', 'ITDeclarationReview', { route, hasPermission: has(['payroll:view', 'it_declarations:view']) }))
      .toBe('/PayrollCenter?tab=statutory&view=declarations');
    expect(payrollHubRedirect('hr', 'ITDeclarationReview', { route, hasPermission: has(['payroll:view']) })).toBeNull();
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
    expect(await screen.findByText(/Pay Admin: rejected \(“Proof missing”\)/)).toBeTruthy();
    expect(screen.getByText(/Pay Admin: approved, amount ₹50,000 → ₹30,000/)).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('/self-service/it-declarations/11/history');
  });

  it('view-only holders see the queue without decision buttons', async () => {
    auth.grants = new Set(['it_declarations:view']);
    render(<ITDeclarationReview />);
    await screen.findAllByTestId('itdr-row');
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByText(/View only/)).toBeTruthy();
  });

  it('approve less than declared needs an amount below the claim and a reason', async () => {
    render(<ITDeclarationReview />);
    await screen.findAllByTestId('itdr-row');
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve less…' })[0]);
    const amount = screen.getByLabelText(/Approved amount/);
    const go = () => screen.getAllByRole('button', { name: /^Approve/ }).find(b => b.closest('td')?.colSpan === 9);
    fireEvent.change(amount, { target: { value: '60000' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Part proved' } });
    expect(go().disabled).toBe(true);                       // more than declared
    fireEvent.change(amount, { target: { value: '30000' } });
    expect(go().disabled).toBe(false);
    fireEvent.click(go());
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/self-service/it-declarations/11', { status: 'approved', remarks: 'Part proved', amount: 30000 }));
  });

  it('says plainly when nobody listed is on the old regime, and shows limits and the HRA metro fact', async () => {
    render(<ITDeclarationReview />);
    const rows = await screen.findAllByTestId('itdr-row');
    expect(screen.getByRole('note').textContent).toMatch(/new regime/);
    expect(rows[0].textContent).toContain('section total ₹50,000 of ₹1,50,000');
    expect(rows[0].textContent).toContain('Waiting for review');
    expect(rows[1].textContent).toContain('Metro city');
  });

  it('filters by employee and section on the page', async () => {
    render(<ITDeclarationReview />);
    await screen.findAllByTestId('itdr-row');
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'ravi' } });
    expect(screen.getAllByTestId('itdr-row')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'HRA' } });
    expect(screen.getAllByTestId('itdr-row')[0].textContent).toContain('Me Myself');
    expect(screen.getAllByTestId('itdr-row')).toHaveLength(1);
  });

  it('approves the ticked declarations in full, one request each, and reports the outcome', async () => {
    const more = [...ROWS, { ...ROWS[0], id: 13, employee_name: 'Asha', declaration_type: '80D', insured_for: 'parents', parents_senior: true, proof_file: '/uploads/1_itdecl_13.pdf', proof_url: null }];
    api.get.mockImplementation((url) => Promise.resolve({ data: url.endsWith('/policy') ? POLICY : more }));
    render(<ITDeclarationReview />);
    const rows = await screen.findAllByTestId('itdr-row');
    expect(rows[1].querySelector('input[type=checkbox]')).toBeNull();          // own declaration: not selectable
    expect(rows[2].textContent).toContain('Parents (60 or over)');
    fireEvent.click(screen.getByLabelText('Select all waiting declarations'));
    fireEvent.click(screen.getByRole('button', { name: /Approve selected in full \(2\)/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(api.put).toHaveBeenCalledWith('/self-service/it-declarations/11', { status: 'approved' });
    expect(api.put).toHaveBeenCalledWith('/self-service/it-declarations/13', { status: 'approved' });
    expect(await screen.findByText(/2 declarations approved in full/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open file' })[0]);
    expect(openEmployeeFile).toHaveBeenCalledWith('/uploads/1_itdecl_13.pdf');
  });

  it('says which declarations reduce TDS this month', async () => {
    render(<ITDeclarationReview />);
    expect((await screen.findByTestId('itdr-policy')).textContent).toMatch(/waiting for review.*From the January payroll only approved/);
  });

  it('after the cut-off it says only approved declarations count', async () => {
    POLICY = { cutoff_month: 1, cutoff_label: 'January', counts_now: ['approved'] };
    render(<ITDeclarationReview />);
    expect((await screen.findByTestId('itdr-policy')).textContent).toMatch(/Only approved declarations reduce TDS now/);
  });
});
