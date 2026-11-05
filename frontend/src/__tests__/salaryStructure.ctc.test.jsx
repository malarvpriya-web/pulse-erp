/**
 * CTC-driven salary entry (PAYROLL_DATA_FLOW_AUDIT.md Part 5): with the
 * company's ctc_mode on, Assign becomes Preview → Prepare proposal (a draft an
 * approver finalises); with it off the page is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock('../components/ResultDialog', () => ({ default: () => null }));

import api from '../services/api/client';
import SalaryStructure from '../features/hr/pages/SalaryStructure.jsx';

const STRUCTURES = [
  { id: 1, name: 'Standard Structure', is_default: true, shared: true, components: [] },
  { id: 2, name: 'Acme Standard', is_default: false, shared: false, company_id: 5, components: [] },
];
const ASSIGNMENTS = [{ id: 10, employee_id: 7, employee_name: 'Asha Rao', employee_code: 'EMP007', structure_id: 2, structure_name: 'Acme Standard', basic_salary: 30000, has_revision: true, effective_from: '2026-04-01', gross_estimate: 75000 }];
const PROPOSAL = { id: 3, employee_id: 7, employee_name: 'Asha Rao', employee_code: 'EMP007', effective_from: '2026-11-01', entry_mode: 'annual_ctc', annual_ctc: 957735, basic_monthly: 30000, breakdown: { monthly: { gross: 75000 } }, source_type: 'manual', status: 'draft' };
const PREVIEW = {
  basic_monthly: 30000, rounding_residual: 265, finalisable: false,
  blockers: [{ code: 'CTC_POLICY_NOT_RECORDED', message: 'The company has not recorded its CTC definition' }],
  breakdown: {
    monthly: { components: [{ name: 'Basic', amount: 30000 }, { name: 'HRA', amount: 12000 }], gross: 75000, take_home_before_tds: 71400 },
    annual: { gross: 900000, employer_pf: 36000, employer_esi: 0, employer_lwf: 100, gratuity: 21635, ctc: 957735 },
  },
};

function mockApi({ ctcMode, proposals = [] }) {
  api.get.mockImplementation((url) => {
    if (url === '/salary-structures') return Promise.resolve({ data: STRUCTURES });
    if (url === '/salary-structures/assignments') return Promise.resolve({ data: ASSIGNMENTS });
    if (url === '/salary-structures/proposals') return Promise.resolve({ data: proposals });
    if (url === '/settings/payroll') return Promise.resolve({ data: { ctc_mode: ctcMode } });
    return Promise.resolve({ data: [] });
  });
  api.post.mockImplementation((url) => {
    if (url === '/salary-structures/ctc-preview') return Promise.resolve({ data: PREVIEW });
    return Promise.resolve({ data: { proposal: PROPOSAL } });
  });
}

const openAssign = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Employee Assignments/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Assign' }));
};

beforeEach(() => { vi.clearAllMocks(); });

describe('Salary Structure — CTC mode', () => {
  it('marks shared templates and offers a copy into the company', async () => {
    mockApi({ ctcMode: false });
    render(<SalaryStructure />);
    expect(await screen.findByText('Shared template')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Copy to my company/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/salary-structures/1/copy', {}));
  });

  it('CTC mode off: the Assign modal writes a revision directly, as before', async () => {
    mockApi({ ctcMode: false });
    render(<SalaryStructure />);
    await openAssign();
    expect(screen.queryByLabelText(/Annual CTC/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Prepare proposal/ })).toBeNull();
  });

  it('CTC mode on: annual CTC is previewed with every component and blocker, then saved only as a draft', async () => {
    mockApi({ ctcMode: true });
    render(<SalaryStructure />);
    await openAssign();
    const prepare = await screen.findByRole('button', { name: /Prepare proposal/ });
    expect(prepare.disabled).toBe(true);                                   // preview first
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '958000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const panel = await screen.findByTestId('ctc-preview');
    expect(api.post).toHaveBeenCalledWith('/salary-structures/ctc-preview', expect.objectContaining({ annual_ctc: 958000, employee_id: 7 }));
    for (const label of ['Monthly gross', 'Employer PF', 'Gratuity accrual', 'Annual CTC', 'Unallocated rounding']) expect(within(panel).getByText(new RegExp(label))).toBeTruthy();
    expect(within(panel).getByText(/Cannot be finalised yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Prepare proposal/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/salary-structures/proposals', expect.objectContaining({ annual_ctc: 958000 })));
    expect(api.post.mock.calls.some(([u]) => /\/assign$/.test(u))).toBe(false);
  });

  it('lists draft proposals for an approver to approve or reject', async () => {
    mockApi({ ctcMode: true, proposals: [PROPOSAL] });
    render(<SalaryStructure />);
    fireEvent.click(await screen.findByRole('button', { name: /Employee Assignments/ }));
    const panel = await screen.findByTestId('salary-proposals');
    expect(within(panel).getByText(/Asha Rao/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/salary-structures/proposals/3/approve', {}));
    fireEvent.click(within(panel).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/salary-structures/proposals/3/reject', {}));
  });
});
