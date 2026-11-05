/**
 * Payroll Center shell (2026-10-28): six workflow sections, one hero, old
 * ?tab= deep links, and every page mounted `embedded` inside the click-safe
 * `.plh-tabpanel`. The section pages are probes here; their own states are in
 * payrollCenter.states.test.jsx and their access in payrollCenter.routeAccess.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { probe } = vi.hoisted(() => ({
  probe: (name) => ({ default: (props) => <div data-testid={`probe-${name}`} data-embedded={String(!!props.embedded)} /> }),
}));
vi.mock('../features/hr/pages/Payroll', () => probe('Payroll'));
vi.mock('../features/hr/pages/SalaryStructure', () => probe('SalaryStructure'));
vi.mock('../features/hr/pages/PayslipGenerator', () => probe('PayslipGenerator'));
vi.mock('../features/hr/pages/PayslipViewer', () => probe('PayslipViewer'));
vi.mock('../features/hr/pages/PayrollForm16', () => probe('PayrollForm16'));
vi.mock('../features/hr/pages/PayrollForm24Q', () => probe('PayrollForm24Q'));
vi.mock('../features/hr/pages/PayrollSettings', () => probe('PayrollSettings'));
vi.mock('../features/hr/components/payroll/PayrollOverview', () => probe('Overview'));
// Grants the hub reads (PC-01): Form 138's view needs payroll_tds_extract:export.
const auth = vi.hoisted(() => ({ denied: new Set() }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => !auth.denied.has(`${m}:${a}`) }),
}));
// Static imports: a cold dynamic import() inside a test hit the 5 s timeout
// under full-suite load.
import PayrollCenter from '../features/hr/pages/PayrollCenter';

// ── The hub shell ──────────────────────────────────────────────────────────
describe('PayrollCenter shell', () => {

  const renderHub = async (url, denied = []) => {
    auth.denied = new Set(denied);
    return render(<MemoryRouter initialEntries={[url]}><PayrollCenter setPage={vi.fn()} /></MemoryRouter>);
  };

  it('draws one hero and six section tabs; Overview is the default', async () => {
    await renderHub('/PayrollCenter');
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Payroll Center']);
    const tabs = within(screen.getByRole('tablist', { name: 'Payroll Center sections' })).getAllByRole('tab');
    expect(tabs.map(t => t.textContent)).toEqual(['Overview', 'Payroll Processing', 'Salary Structures & Loans', 'Payslips', 'Tax & Statutory', 'Settings']);
    expect(screen.getByTestId('probe-Overview')).toBeTruthy();
  });

  it('old deep link ?tab=form24q opens Tax & Statutory → Form 138, embedded', async () => {
    await renderHub('/PayrollCenter?tab=form24q');
    expect(screen.getByRole('tab', { name: 'Tax & Statutory' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Form 138 \/ Form 24Q/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('probe-PayrollForm24Q').dataset.embedded).toBe('true');
  });

  it('every section renders its page embedded inside the click-safe tab panel', async () => {
    await renderHub('/PayrollCenter?tab=processing');
    const panel = screen.getByRole('tabpanel');
    expect(panel.className).toContain('plh-tabpanel');
    for (const [tab, testid] of [['Payroll Processing', 'Payroll'], ['Salary Structures & Loans', 'SalaryStructure'], ['Payslips', 'PayslipGenerator'], ['Settings', 'PayrollSettings']]) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expect((await screen.findByTestId(`probe-${testid}`)).dataset.embedded).toBe('true');
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Payslips' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Payslip viewer' }));
    expect((await screen.findByTestId('probe-PayslipViewer')).dataset.embedded).toBe('true');
  });

  // payroll_admin, hr and hr_manager open the hub but not the 24Q extract API (PC-01 D6/Q4).
  it('without payroll_tds_extract:export Form 138 is not offered, and its deep link opens Form 16', async () => {
    await renderHub('/PayrollCenter?tab=form24q', ['payroll_tds_extract:export']);
    expect(screen.getByRole('tab', { name: 'Tax & Statutory' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: /Form 138 \/ Form 24Q/ })).toBeNull();
    expect(screen.queryByTestId('probe-PayrollForm24Q')).toBeNull();
    expect(screen.getByTestId('probe-PayrollForm16')).toBeTruthy();
  });
});

