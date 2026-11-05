/**
 * Succession Center shell (§210). Every tab body is a full PageShell page whose
 * dock is sticky and opaque. Mounted bare, that dock froze over the hub's tab
 * strip once the body scrolled; measured in Chromium at 1366×768,
 * elementFromPoint at Planning's centre returned the child's `.plh-hero`, so
 * Planning did nothing. The host-side `.plh-tabpanel` guard is what keeps the
 * strip clickable, so the test pins it, along with the selected-tab state. The
 * section pages are probes here.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { probe } = vi.hoisted(() => ({
  probe: (name) => ({ default: () => <div data-testid={`probe-${name}`} /> }),
}));
vi.mock('../features/hr/pages/SuccessionPlanning', () => probe('SuccessionPlanning'));
vi.mock('../features/hr/pages/LeadershipPipeline', () => probe('LeadershipPipeline'));
vi.mock('../features/hr/pages/DevelopmentPlans', () => probe('DevelopmentPlans'));
vi.mock('../features/hr/pages/EmployeeSuccessionPools', () => probe('EmployeeSuccessionPools'));
vi.mock('../features/hr/pages/SuccessionReports', () => probe('SuccessionReports'));
vi.mock('../features/hr/pages/SuccessionSettings', () => probe('SuccessionSettings'));
import SuccessionCenter from '../features/hr/pages/SuccessionCenter';

const TABS = [
  ['Planning', 'SuccessionPlanning'],
  ['Leadership Pipeline', 'LeadershipPipeline'],
  ['Development Plans', 'DevelopmentPlans'],
  ['Talent Pools', 'EmployeeSuccessionPools'],
  ['Reports', 'SuccessionReports'],
  ['Settings', 'SuccessionSettings'],
];

const renderHub = (url) => render(<MemoryRouter initialEntries={[url]}><SuccessionCenter /></MemoryRouter>);

describe('SuccessionCenter shell', () => {
  it('opens on Planning, and the body sits inside the click-safe tab panel', () => {
    renderHub('/SuccessionCenter');
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(TABS.map(([l]) => l));
    expect(screen.getByRole('tab', { name: 'Planning' }).getAttribute('aria-selected')).toBe('true');
    const panel = screen.getByRole('tabpanel');
    expect(panel.className).toContain('plh-tabpanel');
    expect(panel.contains(screen.getByTestId('probe-SuccessionPlanning'))).toBe(true);
  });

  it('every tab, Planning included after leaving it, renders its page in the panel', () => {
    renderHub('/SuccessionCenter?tab=pools');
    for (const [label, testid] of [...TABS.slice(1), TABS[0]]) {
      fireEvent.click(screen.getByRole('tab', { name: label }));
      expect(screen.getByRole('tab', { name: label }).getAttribute('aria-selected')).toBe('true');
      expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1);
      expect(screen.getByRole('tabpanel').contains(screen.getByTestId(`probe-${testid}`))).toBe(true);
    }
  });

  it('a deep link selects its tab; an unknown tab falls back to Planning', () => {
    renderHub('/SuccessionCenter?tab=settings');
    expect(screen.getByTestId('probe-SuccessionSettings')).toBeTruthy();
    document.body.innerHTML = '';
    renderHub('/SuccessionCenter?tab=nope');
    expect(screen.getByTestId('probe-SuccessionPlanning')).toBeTruthy();
  });
});
