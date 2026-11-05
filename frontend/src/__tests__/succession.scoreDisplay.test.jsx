/**
 * Succession performance scores are numeric(3,2) (§209), which PostgreSQL
 * returns padded: "3.00", "3.50". fmtScore shows them as stored without the
 * padding — and without rounding away real decimals.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { fmtScore } from '@/utils/format';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/services/api/client', () => ({ default: api }));
// SuccessionReports reads succession:export to show its Export button (§210).
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

import SuccessionReports from '@/features/hr/pages/SuccessionReports';

describe('fmtScore', () => {
  it.each([
    ['3.00', '3'], ['3.50', '3.5'], ['3.75', '3.75'], ['4.30', '4.3'],
    [3, '3'], [4.25, '4.25'], ['1.05', '1.05'], ['5.00', '5'],
  ])('%j → %s', (v, out) => {
    expect(fmtScore(v)).toBe(out);
    expect(fmtScore(v, 5)).toBe(`${out}/5`);
  });

  it.each([null, undefined, '', 'abc'])('%j → —', (v) => {
    expect(fmtScore(v, 5)).toBe('—');
  });
});

describe('Succession Reports shows scores unpadded', () => {
  it('Talent Risk: whole and fractional performance scores', async () => {
    api.get.mockImplementation(async (url) => ({
      data: url.endsWith('/talent-risk')
        ? [
            { employee_name: 'Whole Wren',  performance_score: '3.00', potential_score: 4, flight_risk: 'low' },
            { employee_name: 'Half Hari',   performance_score: '3.50', potential_score: 3, flight_risk: 'low' },
            { employee_name: 'Quarter Uma', performance_score: '3.75', potential_score: 2, flight_risk: 'low' },
            { employee_name: 'Tenth Tara',  performance_score: '4.30', potential_score: 5, flight_risk: 'low' },
          ]
        : [],
    }));
    render(<MemoryRouter><SuccessionReports /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Talent Risk/ }));
    const perfOf = async (name) => {
      const row = (await screen.findByText(name)).closest('tr');
      return row.querySelectorAll('td')[3].textContent;
    };
    await waitFor(() => expect(screen.getByText('Whole Wren')).toBeTruthy());
    expect(await perfOf('Whole Wren')).toBe('3/5');
    expect(await perfOf('Half Hari')).toBe('3.5/5');
    expect(await perfOf('Quarter Uma')).toBe('3.75/5');
    expect(await perfOf('Tenth Tara')).toBe('4.3/5');
    expect(document.body.textContent).not.toMatch(/\d\.\d0\/5/);
  });
});
