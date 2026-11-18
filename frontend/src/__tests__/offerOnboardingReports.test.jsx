/**
 * Offer & Onboarding + Reports & Setup tabs (review 2026-11-17), API mocked:
 *   - every tab renders inside its hub with no second hero (embedded)
 *   - Offer Management: one status filter row with counts (the stat cards
 *     were a duplicate), above-budget + expired flags, Approve only for an
 *     approver, decline asks for a reason, sent-back comment shown
 *   - Employee Creation: no promises of things that are not created
 *   - Reports: the Offers tab exists; "Hire by source" is gone
 *   - Forecasts: requisition demand is shown; the rate is editable
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(() => Promise.resolve({ data: {} })), post: vi.fn(() => Promise.resolve({ data: {} })), delete: vi.fn() }));

const OFFERS = [
  { id: 'o1', offer_no: 'OFR-0001', candidate_id: 1, candidate_name: 'Asha', designation: 'Engineer', department: 'Engineering',
    offered_salary: '900000', budget_max: '800000', offer_status: 'pending_approval' },
  { id: 'o2', offer_no: 'OFR-0002', candidate_id: 2, candidate_name: 'Bala', designation: 'Engineer', department: 'Engineering',
    offered_salary: '600000', budget_max: '800000', offer_status: 'sent', offer_sent_date: '2026-11-01', offer_expiry_date: '2026-11-10', is_expired: true },
  { id: 'o4', offer_no: 'OFR-0004', candidate_id: 4, candidate_name: 'Dinesh', designation: 'Engineer', department: 'Engineering',
    offered_salary: '700000', offer_status: 'accepted' },
  { id: 'o3', offer_no: 'OFR-0003', candidate_id: 3, candidate_name: 'Chitra', designation: 'Accountant', department: 'Finance',
    offered_salary: '500000', offer_status: 'draft', last_decision_status: 'Rejected', last_decision_comment: 'Lower the CTC' },
];

const DATA = {
  '/recruitment/offers': OFFERS,
  '/recruitment/candidates': { data: [] },
  '/recruitment/openings': [],
  '/approvals/pending': [{ id: 'offer:o1', type: 'offer', can_act: false }],
  '/recruitment/onboarding': [],
  '/recruitment/auto-creation/pending': [],
  '/recruitment/auto-creation/log': [],
  '/recruitment/reports/summary': { total_candidates: 4, active_pipeline: 2, total_hired: 1, total_rejected: 1, hired_in_period: 1, avg_time_to_hire: 12,
    offers: { accepted: 1, declined: 1, sent: 0, acceptance_rate: 50 } },
  '/recruitment/reports/vacancy-aging': [],
  '/recruitment/reports/source-effectiveness': [],
  '/recruitment/reports/department-pipeline': [],
  '/recruitment/reports/offers': { totals: { accepted: 1, declined: 1, acceptance_rate: 50 }, rows: [] },
  '/recruitment/reports/forecast': { rows: [{ department: 'Service', open_roles: 0, open_seats: 0, pipeline: 0, offers_out: 0, approved_not_posted: 2, awaiting_approval: 4, soonest_closing: null }],
    rates: { interview_to_hire_pct: null, offer_acceptance_pct: null, avg_days_to_hire: null, interviewed: 0 } },
  '/admin/config/departments': [],
  '/recruitment/setup-status': { email_configured: false, ctc_mode: false, dept_scope: null, can_manage_setup: true },
};
api.get.mockImplementation((url) => Promise.resolve({ data: DATA[url] ?? [] }));

vi.mock('@/services/api/client', () => ({ default: api }));
vi.mock('@/context/ToastContext', () => {
  const t = () => {}; t.success = () => {}; t.error = () => {};
  return { useToast: () => t };
});

const { default: OfferManagement } = await import('../features/recruitment/pages/OfferManagement');
const { default: EmployeeAutoCreation } = await import('../features/recruitment/pages/EmployeeAutoCreation');
const { default: OnboardingChecklist } = await import('../features/recruitment/pages/OnboardingChecklist');
const { default: RecruitmentReports } = await import('../features/recruitment/pages/RecruitmentReports');
const { default: HiringForecasts } = await import('../features/recruitment/pages/HiringForecasts');
const { buildCareersEmbed } = await import('../features/recruitment/shared/careersEmbed');

const mount = (el, url = '/') => render(<MemoryRouter initialEntries={[url]}>{el}</MemoryRouter>);
afterEach(() => cleanup());

describe('tabs render inside their hub without a second hero', () => {
  for (const [name, El] of [['Offers', OfferManagement], ['Onboarding', OnboardingChecklist], ['Creation', EmployeeAutoCreation],
    ['Reports', RecruitmentReports], ['Forecasts', HiringForecasts]]) {
    it(name, async () => {
      const { container } = mount(<El embedded setPage={vi.fn()} />);
      await screen.findAllByRole('button');
      expect(container.querySelector('.plh-hero')).toBeNull();
    });
  }
});

describe('Offer Management', () => {
  it('has one status filter row with counts, and flags budget, expiry and send-backs', async () => {
    mount(<OfferManagement embedded />);
    const tabs = await screen.findByRole('tablist', { name: 'Offer status' });
    expect(within(tabs).getByRole('tab', { name: /Awaiting answer\s*3/ })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toMatch(/not getting e-mails/);
    // CTC-driven salary entry is off → no proposal button, a pointer to Payroll instead.
    expect(screen.queryByRole('button', { name: /Prepare salary proposal/ })).toBeNull();
    expect(screen.getByText(/Set the salary in Payroll/)).toBeTruthy();
    expect(await screen.findByText(/Above budget/)).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getByText(/Sent back: Lower the CTC/)).toBeTruthy();
  });

  it('shows Approve only to someone who can approve', async () => {
    mount(<OfferManagement embedded />);
    await screen.findByText('Asha');
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.getByText('With the approver')).toBeTruthy();
  });

  it('asks why the candidate declined before recording it', async () => {
    mount(<OfferManagement embedded />);
    fireEvent.click(await screen.findByRole('button', { name: /Declined/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'CTC too low' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record decline' }));
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledWith('/recruitment/offers/o2', { offer_status: 'declined', close_reason: 'CTC too low' }));
  });
});

describe('Employee Creation', () => {
  it('no longer lists set-up steps the server does not do', async () => {
    mount(<EmployeeAutoCreation embedded />);
    await screen.findByText(/Nobody is waiting/);
    expect(screen.queryByText('What Gets Auto-Created')).toBeNull();
    expect(screen.queryByText('Document Folder')).toBeNull();
  });
});

describe('Reports', () => {
  it('has an Offers tab and no "Hire by Source" table', async () => {
    mount(<RecruitmentReports embedded />);
    expect(await screen.findByRole('tab', { name: 'Offers' })).toBeTruthy();
    expect(screen.queryByText('Hire by Source')).toBeNull();
  });
});

describe('Hiring Forecasts', () => {
  it('counts approved requisitions not yet posted, and takes a what-if rate', async () => {
    mount(<HiringForecasts embedded />);
    expect(await screen.findByText('Not posted yet')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Conversion rate (%)'), { target: { value: '25' } });
    expect(screen.getByText(/what-if rate of 25%/)).toBeTruthy();
  });
});

describe('Website careers code', () => {
  it('lists from and posts to the portal, and never writes API text as HTML', () => {
    const code = buildCareersEmbed({ listUrl: 'https://pulse.example.com/api/v1/public/careers/KEY', heading: 'Careers' });
    expect(code).toContain('"listUrl":"https://pulse.example.com/api/v1/public/careers/KEY"');
    expect(code).toContain("CFG.listUrl + '/apply/'");
    expect(code).toContain("t.name = 'website'");      // the server's bot trap
    expect(code).not.toMatch(/innerHTML/);
  });
});
