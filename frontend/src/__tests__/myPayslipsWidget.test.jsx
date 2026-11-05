/**
 * Home → My Payslips (PAYROLL_DATA_FLOW_AUDIT.md Part 12): the printed payslip
 * is the official one — the server's earnings / deductions / employer lists —
 * never a rebuild from a few fixed columns (which dropped loan EMI, LWF and
 * arrears, so the deduction lines did not add up to Total Deductions).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn() } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { employee_id: 7 } }) }));

import api from '../services/api/client';
import MyPayslipsWidget from '../components/dashboard/widgets/MyPayslipsWidget.jsx';

const OFFICIAL = {
  gross: 54000, total_deductions: 5525, net_pay: 48475,
  // raw columns that the old widget read — deliberately different labels/values
  basic: 30000, hra: 12000, special_allowance: 10000, employee_pf: 3000, tds: 0,
  earnings: [
    { label: 'Basic Salary', amount: 30000 }, { label: 'HRA', amount: 12000 },
    { label: 'Special Allowance', amount: 10000 }, { label: 'Arrears', amount: 2000 },
  ],
  deductions: [
    { label: 'Provident Fund (Employee)', amount: 3000 }, { label: 'Labour Welfare Fund (Employee)', amount: 25 },
    { label: 'Loan EMI', amount: 2000 }, { label: 'Advance Recovery', amount: 500 },
  ],
  employer_contributions_list: [{ label: 'Provident Fund (Employer) — EPS', amount: 1250 }],
};
const ENTRY = { month: 9, year: 2026, period_label: 'September 2026', employee_id: 7, employee_name: 'Asha Rao', net_pay: 48475, status: 'approved' };

let written;
beforeEach(() => {
  vi.clearAllMocks();
  written = null;
  vi.spyOn(window, 'open').mockReturnValue({ document: { write: (h) => { written = h; }, close: () => {} } });
});

const cellsOf = (html, section) => {
  const part = html.split(`<h4>${section}</h4>`)[1].split('</table>')[0];
  return [...part.matchAll(/<td style="padding:6px 10px;color:#374151;">([^<]+)<\/td>\s*<td[^>]*>\s*₹([\d,]+)/g)]
    .map(m => [m[1], Number(m[2].replace(/,/g, ''))]);
};

describe('My Payslips widget', () => {
  it('prints the official lists: loan EMI, LWF, arrears included; lines add up to the totals', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: [{ ...ENTRY, slip: OFFICIAL }] } });
    render(<MyPayslipsWidget />);
    fireEvent.click(await screen.findByTitle('Download September 2026 payslip'));
    await waitFor(() => expect(written).toBeTruthy());
    const ded = cellsOf(written, 'Deductions');
    expect(ded.map(([l]) => l)).toEqual(['Provident Fund (Employee)', 'Labour Welfare Fund (Employee)', 'Loan EMI', 'Advance Recovery']);
    expect(ded.reduce((t, [, v]) => t + v, 0)).toBe(OFFICIAL.total_deductions);
    const earn = cellsOf(written, 'Earnings');
    expect(earn.map(([l]) => l)).toContain('Arrears');
    expect(earn.reduce((t, [, v]) => t + v, 0)).toBe(OFFICIAL.gross);
    expect(written).toContain('₹48,475');                      // net = server net
    expect(written).toMatch(/Employer contributions \(not deducted from your pay\)/);
    expect(api.get).toHaveBeenCalledTimes(1);                  // nothing re-fetched or recomputed
  });

  it('a slip without the official lists is replaced by the official payslip before printing', async () => {
    api.get.mockImplementation((url) => (url === '/payroll/my-payslips'
      ? Promise.resolve({ data: { data: [{ ...ENTRY, slip: { gross: 1, net_pay: 1 } }] } })
      : Promise.resolve({ data: { success: true, data: OFFICIAL } })));
    render(<MyPayslipsWidget />);
    fireEvent.click(await screen.findByTitle('Download September 2026 payslip'));
    await waitFor(() => expect(written).toBeTruthy());
    expect(api.get).toHaveBeenCalledWith('/payroll/payslips', { params: { employee_id: 7, month: 9, year: 2026 } });
    expect(written).toContain('Loan EMI');
  });

  it('when the official payslip cannot be loaded, nothing partial is printed', async () => {
    api.get.mockImplementation((url) => (url === '/payroll/my-payslips'
      ? Promise.resolve({ data: { data: [{ ...ENTRY, slip: { gross: 1, net_pay: 1 } }] } })
      : Promise.reject(new Error('network'))));
    render(<MyPayslipsWidget />);
    fireEvent.click(await screen.findByTitle('Download September 2026 payslip'));
    expect(await screen.findByText(/official payslip could not be loaded/)).toBeTruthy();
    expect(window.open).not.toHaveBeenCalled();
  });
});
