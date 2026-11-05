/**
 * Intern evaluation UI — the mentor's page and HR's review panel.
 * The server enforces every rule (internEvaluations.integration.test.js); these
 * check that the screens send the right calls and offer the right controls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

vi.mock('@/services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
const auth = vi.hoisted(() => ({ grants: new Set() }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }),
}));
vi.mock('@/features/internships/pages/Internships.css', () => ({}));

import api from '@/services/api/client';
import MyInternEvaluations from '@/features/internships/pages/MyInternEvaluations.jsx';
import InternEvaluationPanel from '@/features/internships/pages/InternEvaluationPanel.jsx';
import { ROUTES, NAV_ITEMS } from '@/config/routes';
import {
  PERSONAL_PAGES, canEmployeeAccessPage, canManagerAccessPage, canRoleAccessPageBySection, getSectionForPage,
} from '@/config/menuCatalog';

const RECS = ['Recommended for Employment', 'Not Recommended', 'Extend Internship', 'Need Further Review'];
const RATINGS = [
  { key: 'technical_skills', label: 'Technical Skills' }, { key: 'communication', label: 'Communication' },
  { key: 'teamwork', label: 'Teamwork' }, { key: 'discipline_attendance', label: 'Discipline / Attendance' },
  { key: 'learning_ability', label: 'Learning Ability' }, { key: 'overall_performance', label: 'Overall Performance' },
];
const SCALE = [1, 2, 3, 4, 5].map(v => ({ value: v, label: `L${v}` }));
const META = { recommendations: RECS, ratings: RATINGS, scale: SCALE };
const SCORES = Object.fromEntries(RATINGS.map(r => [r.key, 4]));
const INTERN = { id: 7, intern_code: 'INT007', first_name: 'Asha', last_name: 'Rao', department: 'Engineering',
  designation: 'Software Intern', start_date: '2026-07-01', end_date: '2026-09-30', status: 'Active', mentor_employee_id: 3 };
const mine = (evaluation) => ({ data: { linked: true, recommendations: RECS, ratings: RATINGS, scale: SCALE, interns: [{ ...INTERN, evaluation }] } });
const rateAll = (score = 4) => { for (const r of RATINGS) fireEvent.change(screen.getByLabelText(new RegExp(r.label)), { target: { value: String(score) } }); };

beforeEach(() => { cleanup(); vi.clearAllMocks(); auth.grants = new Set(); });

describe('My Intern Evaluations (mentor)', () => {
  it('needs all six ratings, comments and a recommendation; saves and submits them', async () => {
    api.get.mockResolvedValue(mine({ id: 1, status: 'Draft', request_status: 'Sent' }));
    api.put.mockResolvedValue({ data: { id: 1, status: 'Draft', comments: 'Good', recommendation: RECS[0], ...SCORES } });
    api.post.mockResolvedValue({ data: { id: 1, status: 'Submitted', comments: 'Good', recommendation: RECS[0], ...SCORES, submitted_at: '2026-10-13T10:00:00Z' } });
    render(<MyInternEvaluations />);
    const comments = await screen.findByLabelText(/Mentor comments/);
    const submit = screen.getByRole('button', { name: 'Submit for review' });
    fireEvent.change(comments, { target: { value: 'Good' } });
    fireEvent.change(screen.getByLabelText(/^Recommendation/), { target: { value: RECS[0] } });
    expect(submit).toBeDisabled();            // not rated yet
    rateAll(4);
    expect(submit).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/intern-evaluations/mine/7', { comments: 'Good', recommendation: RECS[0], ...SCORES }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/intern-evaluations/mine/7/submit', { comments: 'Good', recommendation: RECS[0], ...SCORES }));
    expect(await screen.findByText(/waiting for HR review/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
  });

  it('offers the evaluation letter for an evaluation HR has sent', async () => {
    api.get.mockResolvedValue(mine({ id: 1, status: 'Draft', request_status: 'Sent' }));
    render(<MyInternEvaluations />);
    expect(await screen.findByRole('button', { name: /Download evaluation letter/ })).toBeTruthy();
  });

  it('shows the HR return reason and offers a resubmit', async () => {
    api.get.mockResolvedValue(mine({ id: 1, status: 'Returned', comments: 'v1', recommendation: 'Extend Internship', ...SCORES,
      return_reason: 'Comment on attendance.', reviewed_by_name: 'HR One' }));
    render(<MyInternEvaluations />);
    expect(await screen.findByText(/Comment on attendance\./)).toBeTruthy();
    expect(screen.getByDisplayValue('v1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resubmit for review' })).toBeEnabled();
  });

  it('a submitted or approved evaluation is read-only, ratings shown', async () => {
    api.get.mockResolvedValue(mine({ id: 1, status: 'Approved', comments: 'Done', recommendation: RECS[0], ...SCORES, reviewed_at: '2026-10-13' }));
    render(<MyInternEvaluations />);
    expect(await screen.findByText(/Approved by HR/)).toBeTruthy();
    expect(screen.getByText('Teamwork')).toBeTruthy();
    expect(screen.queryByLabelText(/Mentor comments/)).toBeNull();
  });

  it('explains an unlinked login and an empty list', async () => {
    api.get.mockResolvedValue({ data: { linked: false, interns: [], recommendations: RECS } });
    render(<MyInternEvaluations />);
    expect(await screen.findByText(/not linked to an employee record/)).toBeTruthy();
  });

  it('tells a user who mentors nobody that the page is for assigned mentors, and shows no data', async () => {
    api.get.mockResolvedValue({ data: { linked: true, interns: [], recommendations: RECS } });
    render(<MyInternEvaluations />);
    expect(await screen.findByText(/not currently assigned as the mentor of any intern/)).toBeTruthy();
    expect(screen.queryByLabelText(/Mentor comments/)).toBeNull();
  });
});

describe('Evaluation panel (HR)', () => {
  const SUBMITTED = { id: 9, status: 'Submitted', request_status: 'Received', mentor_name: 'Meera Nair', comments: 'Solid',
    recommendation: RECS[0], ...SCORES, submitted_at: '2026-10-13T10:00:00Z', received_at: '2026-10-13T10:00:00Z',
    received_via: 'Online', request_sent_at: '2026-10-01T09:00:00Z', reminder_count: 0, is_own: false,
    events: [{ id: 1, action: 'submitted', created_at: '2026-10-13T10:00:00Z', actor_name: 'Meera Nair' }] };
  /** GET routing: the panel loads the evaluations, the vocabularies and (for a request) the mentor list. */
  const routeGets = (evals) => api.get.mockImplementation(async (url) => {
    if (url === '/intern-evaluations/meta') return { data: META };
    if (url === '/interns/mentor-options') return { data: [{ id: 3, name: 'Meera Nair', office_id: 'EMP003' }, { id: 4, name: 'Ravi K' }] };
    if (url.startsWith('/intern-evaluations/intern/')) return { data: evals };
    throw new Error(url);
  });

  it('an approver can approve', async () => {
    auth.grants = new Set(['internships:approve']);
    routeGets([SUBMITTED]);
    api.post.mockResolvedValue({ data: {} });
    render(<InternEvaluationPanel intern={INTERN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/intern-evaluations/9/review', { decision: 'Approve' }));
  });

  it('a return needs a reason, which is sent', async () => {
    auth.grants = new Set(['internships:approve']);
    routeGets([SUBMITTED]);
    api.post.mockResolvedValue({ data: {} });
    render(<InternEvaluationPanel intern={INTERN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Return…' }));
    const send = screen.getByRole('button', { name: 'Return to mentor' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason for returning/), { target: { value: 'Add attendance.' } });
    fireEvent.click(send);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/intern-evaluations/9/review', { decision: 'Return', reason: 'Add attendance.' }));
  });

  it('offers no decision on your own evaluation, or without the approve permission', async () => {
    auth.grants = new Set(['internships:approve']);
    routeGets([{ ...SUBMITTED, is_own: true }]);
    render(<InternEvaluationPanel intern={INTERN} />);
    expect(await screen.findByText(/another HR reviewer must approve/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    cleanup();
    auth.grants = new Set(['internships:view']);
    routeGets([SUBMITTED]);
    render(<InternEvaluationPanel intern={INTERN} />);
    expect(await screen.findByText(/Waiting for review by HR/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('shows the ratings, the received date and the history trail', async () => {
    routeGets([{ ...SUBMITTED, status: 'Approved', request_status: 'Completed', reviewed_at: '2026-10-13T11:00:00Z', reviewed_by_name: 'HR One',
      events: [...SUBMITTED.events, { id: 2, action: 'approved', created_at: '2026-10-13T11:00:00Z', actor_name: 'HR One' }] }]);
    render(<InternEvaluationPanel intern={INTERN} />);
    expect(await screen.findByText('History (2)')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('Discipline / Attendance')).toBeTruthy();
    expect(screen.getByText(/Received: .* online/)).toBeTruthy();
  });

  it('Request Mentor Evaluation picks the mentor (assigned one by default) and sends', async () => {
    auth.grants = new Set(['internships:edit']);
    routeGets([]);
    api.post.mockResolvedValue({ data: { id: 11, request_sent_at: '2026-10-13T12:00:00Z', notified_logins: 1 } });
    render(<InternEvaluationPanel intern={INTERN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Request Mentor Evaluation' }));
    const picker = await screen.findByLabelText(/^Mentor/);
    await waitFor(() => expect(screen.getByRole('option', { name: /Meera Nair .*assigned mentor/ })).toBeTruthy());
    expect(picker.value).toBe('3');
    fireEvent.change(picker, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to mentor' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/intern-evaluations/request', { intern_id: 7, mentor_employee_id: 4, send: true }));
    expect(await screen.findByText('Sent to the mentor.')).toBeTruthy();
  });

  it('no request is offered without edit rights, while one is open, or for a closed internship', async () => {
    auth.grants = new Set(['internships:view']);
    routeGets([]);
    render(<InternEvaluationPanel intern={INTERN} />);
    expect(await screen.findByText(/No evaluation yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request Mentor Evaluation' })).toBeNull();
    cleanup();
    auth.grants = new Set(['internships:edit']);
    routeGets([{ ...SUBMITTED, status: 'Draft', request_status: 'Sent' }]);
    render(<InternEvaluationPanel intern={INTERN} />);
    expect(await screen.findByRole('button', { name: 'Send reminder' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request Mentor Evaluation' })).toBeNull();
    cleanup();
    routeGets([]);
    render(<InternEvaluationPanel intern={{ ...INTERN, status: 'Completed' }} />);
    expect(await screen.findByText(/This internship is Completed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request Mentor Evaluation' })).toBeNull();
  });

  it('a draft is sent, a sent one is reminded', async () => {
    auth.grants = new Set(['internships:edit']);
    routeGets([{ ...SUBMITTED, id: 12, status: 'Draft', request_status: 'Draft', request_sent_at: null }]);
    api.post.mockResolvedValue({ data: { notified_logins: 0 } });
    render(<InternEvaluationPanel intern={INTERN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send to mentor' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/intern-evaluations/12/send'));
    expect(await screen.findByText(/nobody was notified in-app/)).toBeTruthy();
    cleanup();
    routeGets([{ ...SUBMITTED, id: 12, status: 'Draft', request_status: 'Reminder', reminder_count: 1, last_reminder_at: '2026-10-12T09:00:00Z' }]);
    render(<InternEvaluationPanel intern={INTERN} />);
    expect(await screen.findByText(/Reminders: 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send reminder' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/intern-evaluations/12/remind'));
  });

  it('records a returned paper evaluation only with ratings, recommendation, comments AND the document', async () => {
    auth.grants = new Set(['internships:edit']);
    routeGets([{ ...SUBMITTED, id: 13, status: 'Draft', request_status: 'Sent' }]);
    api.post.mockResolvedValue({ data: {} });
    render(<InternEvaluationPanel intern={INTERN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record returned evaluation…' }));
    const save = screen.getByRole('button', { name: 'Record evaluation' });
    rateAll(3);
    fireEvent.change(screen.getByLabelText(/^Recommendation/), { target: { value: 'Not Recommended' } });
    fireEvent.change(screen.getByLabelText(/^Mentor comments/), { target: { value: 'On paper' } });
    expect(save).toBeDisabled();             // no document yet
    const file = new File(['%PDF'], 'form.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText(/Returned evaluation document/), { target: { files: [file] } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/intern-evaluations/13/receive', expect.any(FormData)));
    const fd = api.post.mock.calls.at(-1)[1];
    expect(fd.get('teamwork')).toBe('3');
    expect(fd.get('recommendation')).toBe('Not Recommended');
    expect(fd.get('evaluation_file')).toBe(file);
  });
});

describe('the mentor page is reachable without internship access', () => {
  it('has no module gate, is a personal page, and has no menu row (Home → My Pending Approvals opens it)', () => {
    expect(ROUTES.MyInternEvaluations.module).toBeUndefined();
    expect(PERSONAL_PAGES.has('MyInternEvaluations')).toBe(true);
    expect(NAV_ITEMS.find(g => g.page === 'MyInternEvaluations')).toBeUndefined();
    const hr = NAV_ITEMS.find(g => g.name === 'HR');
    expect(hr.submenu.some(s => s.page === 'MyInternEvaluations')).toBe(false);
    expect(getSectionForPage('MyInternEvaluations')).toBeNull();
  });

  it.each(['employee', 'manager', 'department_head', 'sales_exec', 'design_engineer', 'hr_exec', 'finance'])('the route admits %s (the API decides by assignment)', (role) => {
    expect(canRoleAccessPageBySection(role, 'MyInternEvaluations')).toBe(true);
    expect(canEmployeeAccessPage('MyInternEvaluations')).toBe(true);
    expect(canManagerAccessPage('MyInternEvaluations')).toBe(true);
  });

  it('giving mentors this page did not open the intern register to them', () => {
    expect(ROUTES.Internships.module).toBe('internships');
    expect(canEmployeeAccessPage('Internships')).toBe(false);
    expect(canManagerAccessPage('Internships')).toBe(false);
  });
});
