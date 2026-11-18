/**
 * Only the Finance Manager records a tax regime (2026-11-11, tax_regime:edit).
 * Tax setup's regime picker reads the grant itself — hasPermission() answers
 * true for admins on every module, and the server gives admins no bypass here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), put: vi.fn() } }));
let auth;
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));

import api from '../services/api/client';
import TaxSetupPanel from '../features/hr/components/payroll/TaxSetupPanel';

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: { data: { employees: [{ employee_id: 3, name: 'Anu Natesh', employee_code: 'EMP003', regime: 'new', regime_declared: false }] } } });
});

describe('Tax setup — regime picker', () => {
  it('stays locked for an admin (hasPermission true everywhere) without tax_regime:edit', async () => {
    auth = { hasPermission: () => true, permissions: [{ module: 'payroll', can_edit: true }] };
    render(<TaxSetupPanel />);
    const pick = await screen.findByLabelText('Tax regime of Anu Natesh');
    expect(pick.disabled).toBe(true);
    expect(screen.getByText(/only the Finance Manager can record it/)).toBeTruthy();
  });

  it('opens for the Finance Manager', async () => {
    auth = { hasPermission: () => false, permissions: [{ module: 'tax_regime', can_view: true, can_edit: true }] };
    render(<TaxSetupPanel />);
    expect((await screen.findByLabelText('Tax regime of Anu Natesh')).disabled).toBe(false);
  });
});
