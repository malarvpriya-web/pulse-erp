/**
 * Payroll Center consolidation (2026-10-28) — the hub's sections, deep links,
 * and the empty / error / disabled states that used to mislead:
 *   - a failed read rendered "no records" (Run Payroll, Form 16) or defaults
 *     that Save would write over the real settings (Payroll Settings);
 *   - Form 138 said "the return file can be generated" for a data extract;
 *   - disabled actions explained themselves only in hover titles;
 *   - Form 16's bulk button printed its own source code as its label.
 * Stubs return the server's real envelopes (see the payroll audit: an
 * unwrapped stub once kept a broken screen green).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
// Payroll Processing shows each action to the grant its API checks (PC-01).
const auth = vi.hoisted(() => ({ denied: new Set(), permissions: [] }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => !auth.denied.has(`${m}:${a}`), permissions: auth.permissions }),
}));
import api from '../services/api/client';
// Static imports: a cold dynamic import() inside a test hit the 5 s timeout
// under full-suite load.
import { resolvePayrollTab, SECTIONS } from '../features/hr/components/payroll/payrollCenterTabs';
import PayrollOverview from '../features/hr/components/payroll/PayrollOverview';
import PayrollForm24Q from '../features/hr/pages/PayrollForm24Q';
import { statementName, certificateName, statementBasis, periodTerm } from '../features/hr/components/payroll/taxFormNames';
import PayrollForm16 from '../features/hr/pages/PayrollForm16';
import Payroll from '../features/hr/pages/Payroll';
import PayrollSettings from '../features/hr/pages/PayrollSettings';

const fail = (status, message) => Promise.reject({ response: { status, data: { message } }, message: `HTTP ${status}` });
const ok = (data) => Promise.resolve({ data });

beforeEach(() => { api.get.mockReset(); api.post.mockReset(); document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); });

// ── Tab resolution ─────────────────────────────────────────────────────────
describe('resolvePayrollTab', () => {

  it('has the six workflow sections in order', () => {
    expect(SECTIONS.map(s => s.id)).toEqual(['overview', 'processing', 'structures', 'payslips', 'statutory', 'settings']);
  });

  it.each([
    ['payroll', null, 'processing', null],
    ['structure', null, 'structures', null],
    ['generate', null, 'payslips', 'generator'],
    ['view', null, 'payslips', 'viewer'],
    ['form16', null, 'statutory', 'form16'],
    ['form24q', null, 'statutory', 'form138'],
    ['settings', null, 'settings', null],
    ['statutory', 'form138', 'statutory', 'form138'],
    ['statutory', 'nonsense', 'statutory', 'form16'],
    ['nonsense', null, 'overview', null],
    [null, null, 'overview', null],
  ])('?tab=%s&view=%s → %s / %s', (tab, view, section, v) => {
    expect(resolvePayrollTab(tab, view)).toEqual({ section, view: v });
  });
});

// ── Overview ───────────────────────────────────────────────────────────────
describe('PayrollOverview', () => {
  it('shows a failed read and the real blockers — never zeros', async () => {
    api.get.mockImplementation((url) => url === '/payroll/summary'
      ? fail(500, 'summary exploded')
      : ok({ success: true, data: { period: 'October 2026', ready: false, blockers: [{ code: 'JURISDICTION_UNCONFIRMED', message: 'Statutory state not confirmed' }] } }));
    const go = vi.fn();
    render(<PayrollOverview go={go} />);
    expect((await screen.findAllByText(/Could not load: summary exploded/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/JURISDICTION_UNCONFIRMED — Statutory state not confirmed/)).toBeTruthy();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
    fireEvent.click(within(screen.getByRole('region', { name: '4 · Approve & release' })).getByRole('button', { name: /Open/ }));
    expect(go).toHaveBeenCalledWith('processing');
  });

  it('names the missing prerequisite when nobody is eligible', async () => {
    api.get.mockImplementation((url) => url === '/payroll/summary'
      ? ok({ success: true, data: { payroll_period: 'October 2026', total_employees: 0, eligibility: { eligible: 0, active_headcount: 9, not_eligible: 9 }, cycle: { errors: [] }, settings_conflicts: [] } })
      : ok({ success: true, data: { period: 'October 2026', ready: true, blockers: [] } }));
    render(<PayrollOverview go={vi.fn()} />);
    expect(await screen.findByText(/No active employee is eligible for October 2026/)).toBeTruthy();
    expect(screen.getByText(/Assign a salary structure and revision/)).toBeTruthy();
    expect(screen.getByText(/October 2026 payroll has not been generated/)).toBeTruthy();
  });
});

// ── Form 138 / Form 24Q ────────────────────────────────────────────────────
describe('Form 138 statement screen', () => {
  const load = async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T10:00:00+05:30'));
    render(<PayrollForm24Q embedded />);
  };
  const download = () => screen.getByRole('button', { name: /Download data extract/ });

  it('before View Data: download is disabled with a visible reason', async () => {
    await load();
    expect(download().disabled).toBe(true);
    expect(screen.getByText(/run "View Data" first/)).toBeTruthy();
  });

  it('a failed load is an error, not "no approved salary TDS"', async () => {
    api.get.mockImplementation(() => fail(500, 'db down'));
    await load();
    fireEvent.click(screen.getByRole('button', { name: /View Data/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load Form 138 \(formerly Form 24Q\) data for Tax Year 2026-2027: db down/);
    expect(screen.queryByText(/No approved salary TDS/)).toBeNull();
    expect(download().disabled).toBe(true);
  });

  it('validation failures are listed; nothing implies the return is ready', async () => {
    api.get.mockImplementation(() => ok({
      financial_year: '2026-2027', form_label: 'Form 138 (formerly Form 24Q)', quarters: [], grand_total: { salary: 0, tds: 0 },
      validation: { ok: false, warnings: [], errors: [
        { code: 'TAN', message: 'Employer TAN is not configured (Company profile → TAN)' },
        { code: 'UNAPPROVED', quarter: 'Q2', message: 'Q2: 32 payroll record(s) are not approved — approve payroll before filing' },
      ] },
    }));
    await load();
    fireEvent.click(screen.getByRole('button', { name: /View Data/ }));
    expect(await screen.findByText(/Not ready to file: 2 validation error\(s\)/)).toBeTruthy();
    expect(screen.getByText(/Employer TAN is not configured/)).toBeTruthy();
    expect(screen.getByText(/UNAPPROVED · Q2:/)).toBeTruthy();
    expect(screen.queryByText(/can be generated/)).toBeNull();
    expect(download().disabled).toBe(true);
    expect(screen.getByText(/2 validation error\(s\) below must be fixed first/)).toBeTruthy();
  });

  it('a pass enables the extract but says it is not a filed return', async () => {
    api.get.mockImplementation(() => ok({
      financial_year: '2026-2027', form_label: 'Form 138 (formerly Form 24Q)', grand_total: { salary: 100, tds: 10 },
      quarters: [{ quarter: 'Q1', totals: { salary: 100, tds: 10 }, deductees: [] }],
      validation: { ok: true, errors: [], warnings: [] },
    }));
    await load();
    fireEvent.click(screen.getByRole('button', { name: /View Data/ }));
    expect(await screen.findByText(/Pulse validation passed/)).toBeTruthy();
    expect(screen.getByText(/This is not a filed return/)).toBeTruthy();
    expect(download().disabled).toBe(false);
  });

  it('a pass with no approved data still cannot download', async () => {
    api.get.mockImplementation(() => ok({ financial_year: '2026-2027', quarters: [], grand_total: {}, validation: { ok: true, errors: [], warnings: [] } }));
    await load();
    fireEvent.click(screen.getByRole('button', { name: /View Data/ }));
    expect(await screen.findByText(/there is no approved salary TDS in the selected period/)).toBeTruthy();
    expect(download().disabled).toBe(true);
  });

  it('names the form by tax year — Form 24Q before 2026-27', async () => {
    expect(statementName('2026-2027')).toBe('Form 138 (formerly Form 24Q)');
    expect(statementName('2025-2026')).toBe('Form 24Q');
    expect(certificateName('2026-27')).toBe('Form No. 130 (formerly Form 16)');
    expect(certificateName('2025-2026')).toBe('Form 16');
  });

  it('separates the s.392 deduction from the s.397(3)(b) statement; 2025-26 keeps s.192 / FY', async () => {
    expect(statementBasis('2026-2027')).toMatch(/s\.397\(3\)\(b\).*Rule 219.*deducted under s\.392/);
    expect(statementBasis('2025-2026')).toMatch(/s\.200\(3\).*Rule 31A.*deducted under s\.192/);
    expect(periodTerm('2026-27')).toBe('Tax Year');
    expect(periodTerm('2025-2026')).toBe('FY');
  });

  it('the page shows the server statute line and the Act section of each row', async () => {
    api.get.mockImplementation(() => ok({
      financial_year: '2026-2027', form_label: 'Form 138 (formerly Form 24Q)', period_term: 'Tax Year',
      statute: 'Quarterly statement under s.397(3)(b) of the Income-tax Act 2025 (Rule 219, Income-tax Rules 2026); salary TDS deducted under s.392',
      grand_total: { salary: 100, tds: 10 }, validation: { ok: true, errors: [], warnings: [] },
      quarters: [{ quarter: 'Q2', totals: { salary: 100, tds: 10 }, deductees: [{ sno: 1, employee_id: 7, employee_name: 'Asha K', employee_code: 'EMP007', employee_pan: 'ABCDE1234F', pan_valid: true, section: '392', total_salary: 100, total_tds: 10, total_deposited: 10 }] }],
    }));
    await load();
    expect(screen.getByRole('option', { name: 'Tax Year 2026-2027' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'FY 2025-2026' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /View Data/ }));
    // Embedded there is no hero, so the statute must be in the page body.
    expect(await screen.findByText(/^Quarterly statement under s\.397\(3\)\(b\) of the Income-tax Act 2025.*deducted under s\.392$/)).toBeTruthy();
    fireEvent.click(screen.getByText('Q2'));
    expect(screen.getByRole('columnheader', { name: 'Act section' })).toBeTruthy();
    expect(screen.getByText('392')).toBeTruthy();
  });
});

// ── Form 16 / Form No. 130 ─────────────────────────────────────────────────
describe('Form 16 / Form No. 130 certificate screen', () => {
  const load = async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T10:00:00+05:30'));
    render(<PayrollForm16 embedded />);
  };

  it('a failed load is an error with Retry, not "no approved payroll"', async () => {
    api.get.mockImplementation(() => fail(403, 'Forbidden'));
    await load();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load the Form No\. 130 \(formerly Form 16\) status for Tax Year 2026-2027: Forbidden/);
    expect(screen.queryByText(/No approved or paid payroll/)).toBeNull();
    api.get.mockImplementation(() => ok({ success: true, data: { fy_end: '2027-03-31', fy_ended: false, issue_due_by: '2027-06-15', tan_configured: true, employees: [] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No approved or paid payroll in Tax Year 2026-2027 yet/)).toBeTruthy();
  });

  it('shows every blocker while the FY is in progress, and a real count on the bulk button', async () => {
    api.get.mockImplementation(() => ok({ success: true, data: {
      financial_year: '2026-2027', fy_end: '2027-03-31', fy_ended: false, issue_due_by: '2027-06-15', tan_configured: false,
      employees: [{ employee_id: 7, employee_code: 'EMP007', name: 'Asha K', department: 'QA', months_finalised: 2, months_expected: 7,
        status: 'in_progress', can_generate: false,
        blockers: ['Tax year 2026-2027 ends on 2027-03-31; Form No. 130 is issued after year end (due by 2027-06-15)', 'Employee PAN missing or invalid', 'Employer TAN not configured (Company profile)'] }],
    } }));
    await load();
    expect(await screen.findByText(/Employee PAN missing or invalid/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download Ready (0)' }).disabled).toBe(true);
    expect(screen.getByText(/No certificate is ready to download/)).toBeTruthy();
    expect(screen.queryByText(/filtered\.filter/)).toBeNull();
  });
});

// ── Run Payroll (Payroll Processing) ───────────────────────────────────────
describe('Payroll Processing empty states', () => {
  const env = (data) => ok({ success: true, data });
  const render_ = async (overrides = {}) => {
    api.get.mockImplementation((url) => {
      if (url in overrides) return overrides[url]();
      if (url === '/payroll') return env([]);
      if (url === '/payroll/summary') return env({ total_employees: 0 });
      if (url === '/payroll/trend') return env([]);
      if (url === '/payroll/eligibility') return env({ period: 'October 2026', summary: { eligible: 3, active_headcount: 9, not_eligible: 6 }, employees: [] });
      if (url === '/payroll/release-readiness') return env({ period: 'October 2026', ready: true, blockers: [] });
      return env(null);
    });
    render(<Payroll embedded setPage={vi.fn()} />);
  };

  it('a failed list is reported, and no "Generate Payroll Now" is offered on a guess', async () => {
    await render_({ '/payroll': () => fail(500, 'list failed') });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Payroll records: list failed/);
    expect(screen.getByText(/could not be loaded, so it is not known whether a draft exists/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate Payroll Now' })).toBeNull();
  });

  it('with nobody eligible it names the prerequisite instead of a Generate button', async () => {
    await render_({ '/payroll/eligibility': () => env({ period: 'October 2026', summary: { eligible: 0, active_headcount: 9, not_eligible: 9 }, employees: [] }) });
    expect(await screen.findByText(/Payroll cannot be generated yet: none of the 9 active employees is eligible/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate Payroll Now' })).toBeNull();
    expect(screen.getByRole('button', { name: /Open Salary Structures/ })).toBeTruthy();
  });

  it('with eligible employees and no draft it still offers Generate', async () => {
    auth.denied = new Set();
    await render_();
    expect(await screen.findByRole('button', { name: 'Generate Payroll Now' })).toBeTruthy();
  });

  // hasPermission() is true for admin on everything; payment is finance_manager
  // only (Q1), so the Pay buttons read the payroll_payment grant itself.
  it('Pay is offered only to a payroll_payment:approve holder, even when hasPermission says yes to all', async () => {
    const approvedRow = { employee_id: 7, id: 7, name: 'Asha K', department: 'QA', status: 'approved', gross: 30000, net_pay: 30000 };
    auth.denied = new Set(); auth.permissions = [];
    await render_({ '/payroll': () => env([approvedRow]) });
    expect(await screen.findByText('Asha K')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pay$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark All/ })).toBeNull();
    document.body.innerHTML = '';
    auth.permissions = [{ module: 'payroll_payment', can_approve: true }];
    await render_({ '/payroll': () => env([approvedRow]) });
    expect(await screen.findByRole('button', { name: /Pay$/ })).toBeTruthy();
    auth.permissions = [];
  });

  it('without payroll:add (finance_manager) neither Generate button is offered', async () => {
    auth.denied = new Set(['payroll:add']);
    await render_();
    expect(await screen.findByText(/No payroll records for/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate Payroll Now' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Generate Payroll/ })).toBeNull();
    auth.denied = new Set();
  });
});

// ── Payroll Settings ───────────────────────────────────────────────────────
describe('Payroll Settings load failure', () => {
  // Generous timeouts: the settings module is heavy to import under full-suite load.
  it('a failed read shows no form and no Save — defaults are never presented as saved', async () => {
    api.get.mockImplementation(() => fail(500, 'Saved settings could not be read'));
    render(<PayrollSettings embedded setPage={vi.fn()} />);
    expect((await screen.findByRole('alert', {}, { timeout: 15000 })).textContent).toMatch(/Could not load the saved Payroll settings \(Saved settings could not be read\)/);
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
    expect(screen.queryByText('Round Net Pay to Nearest')).toBeNull();   // a default-valued field
    // Embedded: no second hero, no "Back to Settings" leaving the hub.
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByText(/Back to Settings/)).toBeNull();
  }, 30000);

  it('Retry loads the saved settings and only then offers Save', async () => {
    api.get.mockImplementationOnce(() => fail(500, 'Saved settings could not be read'))
      .mockImplementation(() => ok({ round_net_pay: '100' }));
    render(<PayrollSettings embedded setPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }, { timeout: 15000 }));
    expect(await screen.findByRole('button', { name: 'Save Changes' }, { timeout: 15000 })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Round Net Pay to Nearest')).toBeTruthy();
  }, 30000);

  it('a 200 that is not a settings object is treated as a failed load', async () => {
    api.get.mockImplementation(() => ok('<html>proxy error</html>'));
    render(<PayrollSettings embedded setPage={vi.fn()} />);
    expect((await screen.findByRole('alert', {}, { timeout: 15000 })).textContent).toMatch(/not a settings object/);
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
  }, 30000);

  it('a 404 / empty configuration is not an error and shows the form', async () => {
    api.get.mockImplementation(() => fail(404, 'not found'));
    render(<PayrollSettings setPage={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeTruthy(), { timeout: 15000 });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Back to Settings/)).toBeTruthy();
  }, 30000);
});
