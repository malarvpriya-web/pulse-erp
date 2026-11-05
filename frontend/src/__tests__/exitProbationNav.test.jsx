import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Probation Management and Exit Management are separate HR rows (2026-10-30).
// Before, one 'Exit & Probation' hub held Probation, Offboarding and Exit
// Management as tabs, and each tab drew its own banner under the hub's, so the
// screen read "Exit & Probation" over "Probation Management".

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() },
}));
vi.mock('../features/_shared/exportUtils', () => ({ exportCSV: vi.fn() }));

import api from '../services/api/client';
import { NAV_ITEMS } from '../config/routes';
import { TABS } from '../features/hr/pages/ExitCenter.jsx';
import ExitCenter from '../features/hr/pages/ExitCenter.jsx';
import ExitManagement from '../features/hr/pages/ExitManagement.jsx';
import Offboarding from '../features/hr/pages/Offboarding.jsx';

const hr = NAV_ITEMS.find(g => g.name === 'HR');
const visibleRows = hr.submenu.filter(s => s.page && !s.separator && !s.inHub);

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: [] });
});

describe('HR menu', () => {
  it('has distinct Probation Management and Exit Management rows, and no Exit & Probation row', () => {
    expect(visibleRows.find(r => r.page === 'Probation')?.name).toBe('Probation Management');
    expect(visibleRows.find(r => r.page === 'ExitCenter')?.name).toBe('Exit Management');
    expect(hr.submenu.some(s => /exit\s*&\s*probation/i.test(s.name || ''))).toBe(false);
  });

  it('keeps Offboarding and the exit desk inside Exit Management, and probation out of it', () => {
    expect(TABS.map(t => t.page)).toEqual(['ExitManagement', 'Offboarding']);
    const hubbed = hr.submenu.filter(s => s.inHub === 'ExitCenter').map(s => s.page).sort();
    expect(hubbed).toEqual(['ExitManagement', 'Offboarding']);
  });
});

describe('ExitCenter', () => {
  it('sends an old ?tab=probation link to the Probation page', () => {
    render(
      <MemoryRouter initialEntries={['/ExitCenter?tab=probation']}>
        <Routes>
          <Route path="/ExitCenter" element={<ExitCenter setPage={vi.fn()} />} />
          <Route path="/Probation" element={<div data-testid="probation-page" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('probation-page')).toBeTruthy();
  });
});

describe('pages inside the Exit Management hub draw no banner of their own', () => {
  it('ExitManagement: hero standalone, none embedded', () => {
    const { container, unmount } = render(<ExitManagement />);
    expect(container.querySelector('.plh-hero')).toBeTruthy();
    unmount();
    const embedded = render(<ExitManagement embedded />);
    expect(embedded.container.querySelector('.plh-hero')).toBeNull();
    // Its own workflow tabs are still there.
    expect(screen.getByText('F&F Calculator')).toBeTruthy();
  });

  it('Offboarding: actions survive embedding, and Initiate opens the exit tab', () => {
    const setPage = vi.fn();
    const { container } = render(<Offboarding embedded setPage={setPage} />);
    expect(container.querySelector('.plh-hero')).toBeNull();
    expect(screen.getByText('Template Config')).toBeTruthy();
    expect(screen.getByText(/Export CSV/)).toBeTruthy();
    fireEvent.click(screen.getByText('+ Initiate Offboarding'));
    expect(setPage).toHaveBeenCalledWith('ExitCenter', { tab: 'exit' });
  });

  it('Offboarding standalone keeps its hero and its old Initiate target', () => {
    const setPage = vi.fn();
    const { container } = render(<Offboarding setPage={setPage} />);
    expect(container.querySelector('.plh-hero')).toBeTruthy();
    fireEvent.click(screen.getByText('+ Initiate Offboarding'));
    expect(setPage).toHaveBeenCalledWith('ExitManagement');
  });
});
