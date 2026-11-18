/**
 * Payroll is configured in one place, Payroll Center → Settings. First-Time Setup used to
 * write its own defaults (pay day 1, Maharashtra) into the same record.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';
import SetupCenter from '../features/admin/pages/SetupCenter';

vi.mock('@/features/settings/pages/SetupDashboard', () => ({ default: () => <div>overview</div> }));
vi.mock('@/features/settings/pages/SetupWizard', () => ({ default: () => <div>first time</div> }));
vi.mock('../features/admin/pages/AttendanceSetupWizard', () => ({ default: () => null }));
vi.mock('../features/admin/pages/InventorySetupWizard', () => ({ default: () => null }));
vi.mock('../features/admin/pages/EngineeringSetupWizard', () => ({ default: () => null }));

const Where = () => { const l = useLocation(); return <div data-testid="at">{l.pathname + l.search}</div>; };
const open = (url) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/SetupCenter" element={<SetupCenter />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);

describe('one home for payroll settings', () => {
  it('Setup Center has no payroll tab', () => {
    open('/SetupCenter');
    expect(screen.queryByRole('button', { name: /Payroll/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Attendance Setup/ })).toBeDefined();
  });

  it('an old Setup Center payroll link lands in Payroll Center Settings', () => {
    open('/SetupCenter?tab=payroll');
    expect(screen.getByTestId('at').textContent).toBe('/PayrollCenter?tab=settings');
  });

  it('First-Time Setup cannot write payroll settings', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../features/settings/pages/SetupWizard.jsx'), 'utf8');
    expect(src).not.toMatch(/settings\/payroll/);
    expect(src).toMatch(/PayrollCenter\?tab=settings/);
  });
});
