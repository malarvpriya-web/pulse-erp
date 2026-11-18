/**
 * Probation Management — a failed load is shown, not read as an empty page
 * (HR audit 2026-11-16, B5). Before, a rejected /employees call rendered
 * "no one on probation" with no hint that anything had failed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../features/hr/pages/Probation.css', () => ({}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../components/ResultDialog', () => ({ default: () => null }));

import api from '../services/api/client';
import Probation from '../features/hr/pages/Probation.jsx';

const EMP = { id: 1, office_id: 'EMP101', first_name: 'Neha', last_name: 'Iyer', status: 'Probation', department: 'Finance',
  joining_date: '2026-06-01', probation_end_date: '2026-11-30' };

beforeEach(() => { vi.clearAllMocks(); cleanup(); });

describe('Probation load failure', () => {
  it('names what did not load, and Try again reloads', async () => {
    let fail = true;
    api.get.mockImplementation(async (url, cfg) => {
      if (url === '/employees' && cfg?.params?.status === 'Probation') {
        if (fail) throw new Error('Network Error');
        return { data: [EMP] };
      }
      if (url === '/probation-reviews') throw new Error('500');
      if (url === '/probation/settings') return { data: { probation_months: 6, reminder_days: 14 } };
      return { data: [] };
    });
    render(<Probation setPage={() => {}} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Part of this page did not load/);
    expect(alert.textContent).toMatch(/employees on probation, reviews/);

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).not.toMatch(/employees on probation/));
    expect(screen.getByRole('alert').textContent).toMatch(/Could not load: reviews\./);
  });

  it('shows no banner when everything loads', async () => {
    api.get.mockImplementation(async (url, cfg) => {
      if (url === '/employees' && cfg?.params?.status === 'Probation') return { data: [EMP] };
      if (url === '/probation-reviews') return { data: { reviews: [], awaiting_request: [] } };
      return { data: [] };
    });
    render(<Probation setPage={() => {}} />);
    await screen.findAllByText(/Neha Iyer/);
    expect(screen.queryByText(/Part of this page did not load/)).toBeNull();
  });
});
