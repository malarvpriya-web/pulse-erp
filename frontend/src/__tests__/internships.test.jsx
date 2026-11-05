/**
 * Internships — the pages, driven in jsdom.
 *
 *  - Add Intern and Edit Intern are ONE form: Edit is seeded from the full
 *    record, opens every section with the same controls, and a save sends every
 *    field (clears included) — never the string "null".
 *  - The register's cards and report bars filter the list with exactly the
 *    filter the API published for them.
 *  - View Intern shows the record, its documents and the shared photo viewer.
 *  - The duration wording ("15 days", "6 months").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), head: vi.fn() },
}));
vi.mock('../features/employees/pages/AddEmployee.css', () => ({}));
// The register and View Intern read permissions (Templates tab, Convert to
// Employee). These page tests run as an HR user holding every grant.
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../features/internships/pages/Internships.css', () => ({}));
vi.mock('../components/ResultDialog', () => ({
  default: ({ dialog }) => (dialog ? <div role="dialog">{dialog.title}: {dialog.message}</div> : null),
}));
const { Picker } = vi.hoisted(() => ({
  Picker: ({ id, value, onChange }) => (
    <input id={id} data-picker="1" value={value ?? ''} onChange={e => onChange(e.target.value, null)} />
  ),
}));
vi.mock('../components/core/MasterSelect', () => ({ default: Picker }));
vi.mock('../components/core/VocabSelect', () => ({ default: Picker }));
vi.mock('../features/employees/shared/employeeFiles', () => ({
  loadEmployeeImage: vi.fn(async () => 'blob:photo'),
  isExternalUrl: () => false,
  openEmployeeFile: vi.fn(async () => null),
  downloadEmployeeFile: vi.fn(async () => null),
  probeEmployeeFiles: vi.fn(async (paths) => Object.fromEntries(paths.filter(Boolean).map(p => [p, true]))),
}));

import api from '../services/api/client';
import { formatDuration, inclusiveDays } from '../features/internships/internship.jsx';
import AddIntern from '../features/internships/pages/AddIntern.jsx';
import EditIntern from '../features/internships/pages/EditIntern.jsx';
import ViewIntern from '../features/internships/pages/ViewIntern.jsx';
import Internships from '../features/internships/pages/Internships.jsx';

const META = {
  statuses: ['Applied', 'Selected', 'Onboarding', 'Active', 'Completed', 'Cancelled', 'Terminated'],
  closed_statuses: ['Completed', 'Cancelled', 'Terminated'],
  stipend_frequencies: ['Monthly', 'Weekly', 'One-time', 'Unpaid'],
  doc_types: [
    { key: 'college_id', label: 'College ID' }, { key: 'institution_letter', label: 'Institution Letter' },
    { key: 'offer_letter', label: 'Offer Letter' }, { key: 'id_proof', label: 'ID Proof' },
    { key: 'resume', label: 'Resume' }, { key: 'nda', label: 'NDA' },
    { key: 'certificate', label: 'Certificate' }, { key: 'other', label: 'Other' },
  ],
  soon_days: 14, max_duration_days: 731,
  initial_statuses: ['Applied', 'Selected', 'Onboarding', 'Active'],
  transitions: {
    Applied: ['Selected', 'Cancelled'], Selected: ['Onboarding', 'Active', 'Cancelled', 'Applied'],
    Onboarding: ['Active', 'Cancelled', 'Terminated', 'Selected'], Active: ['Terminated'],
    Completed: [], Cancelled: [], Terminated: [],
  },
};
const MENTORS = [{ id: 7, name: 'Meera Nair', office_id: 'EMP007', designation: 'Lead' }, { id: 8, name: 'Arun K', office_id: 'EMP008' }];

const FULL = {
  id: 5, intern_code: 'INT005', first_name: 'Asha', last_name: 'Rao', photo_url: '/uploads/a.png',
  dob: '2004-05-06', gender: 'Female', personal_email: 'asha@x.in', phone: '9876543210', address: 'Pune',
  emergency_name: 'Ravi', emergency_phone: '9123456780', emergency_relationship: 'Father',
  college: 'COEP', course: 'B.Tech', specialization: 'CS', current_year: '3rd Year', graduation_year: 2027,
  department: 'Engineering', designation: 'Software Intern', mentor_employee_id: 7, mentor_name: 'Meera Nair',
  internship_type: 'Summer Internship', start_date: '2026-01-01', end_date: '2026-06-30', duration_days: 181,
  status: 'Active', status_reason: null, stipend: '10000.00', stipend_frequency: 'Monthly', other_benefits: 'Laptop',
  completed_on: null, certificate_issued: false, certificate_number: null, notes: 'Good start',
  completion: { eligible: true, reason: null, evaluation_id: 4 }, certificates: [], lifecycle_events: [],
  documents: [{ id: 91, doc_type: 'College ID', file_url: '/uploads/cid.pdf', original_name: 'cid.pdf', uploaded_at: '2026-01-02T00:00:00Z' }],
};

const SECTIONS = ['Personal Information', 'Education', 'Internship Information', 'Compensation',
  'Completion & Certificate', 'Documents', 'Notes'];

function routeGets(extra = {}) {
  api.get.mockImplementation(async (url) => {
    if (url === '/interns/meta') return { data: META };
    if (url === '/interns/mentor-options') return { data: MENTORS };
    if (url === '/interns/next-code') return { data: { code: 'INT006' } };
    if (url.startsWith('/interns/5')) return { data: FULL };
    for (const [k, v] of Object.entries(extra)) if (url.startsWith(k)) return { data: typeof v === 'function' ? v(url) : v };
    throw new Error(`unexpected GET ${url}`);
  });
}

/** Every control the form shows, section by section, as "section › label". */
async function controlsOf() {
  const out = [];
  for (const s of SECTIONS) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${s.replace(/[&]/g, '\\&')}`) }));
    await waitFor(() => expect(document.querySelector('.accordion-body')).toBeTruthy());
    for (const el of document.querySelectorAll('.accordion-body label[for]')) out.push(`${s} › ${el.textContent.replace('*', '').trim()}`);
  }
  return out;
}

/** The FormData a save sent, as a plain object (files by name). */
const sent = (fd) => Object.fromEntries([...fd.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]));

beforeEach(() => { cleanup(); vi.clearAllMocks(); });

describe('duration wording', () => {
  it.each([
    ['2026-11-01', '2026-11-15', '15 days', 15],
    ['2026-01-01', '2026-06-30', '6 months', 181],
    ['2026-03-01', '2026-03-31', '1 month', 31],
    ['2026-01-10', '2026-03-19', '2 months 10 days', 69],
    ['2026-02-01', '2026-02-01', '1 day', 1],
  ])('%s → %s is "%s"', (s, e, words, days) => {
    expect(formatDuration(s, e)).toBe(words);
    expect(inclusiveDays(s, e)).toBe(days);
  });
});

describe('Add Intern = Edit Intern', () => {
  // 15s: opens every section of two full forms; ~0.6s alone, slower under contention.
  it('Edit shows exactly the controls Add shows, in every section', async () => {
    routeGets();
    render(<AddIntern setPage={vi.fn()} />);
    await screen.findByDisplayValue('INT006');
    const add = await controlsOf();
    cleanup();

    routeGets();
    render(<EditIntern setPage={vi.fn()} urlParams={{ id: '5' }} />);
    await screen.findByDisplayValue('INT005');
    const edit = await controlsOf();
    // Completion fields appear only once the status is Completed — same in both modes.
    expect(edit).toEqual(add);
    expect(add.length).toBeGreaterThan(20);
  }, 15000);

  it('Edit is seeded from the FULL record and the Intern ID is read-only', async () => {
    routeGets();
    render(<EditIntern setPage={vi.fn()} urlParams={{ id: '5' }} />);
    const code = await screen.findByDisplayValue('INT005');
    expect(code).toBeDisabled();
    expect(screen.getByDisplayValue('Asha')).toBeTruthy();
    expect(screen.getByDisplayValue('2004-05-06')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Internship Information/ }));
    expect(screen.getByDisplayValue('Engineering')).toBeTruthy();
    expect(screen.getByLabelText('Mentor / Reporting Manager').value).toBe('7');
    expect(screen.getByLabelText('Duration').value).toBe('6 months (181 days)');
  });

  it('a save sends every field, clears as "", and never the string "null"', async () => {
    routeGets();
    api.put.mockResolvedValue({ data: { ...FULL, last_name: null } });
    const setPage = vi.fn();
    render(<EditIntern setPage={setPage} urlParams={{ id: '5' }} />);
    await screen.findByDisplayValue('INT005');
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [url, fd] = api.put.mock.calls[0];
    expect(url).toBe('/interns/5');
    const body = sent(fd);
    expect(body.last_name).toBe('');
    expect(body.first_name).toBe('Asha');
    expect(body.mentor_employee_id).toBe('7');
    expect(body.status_reason).toBe('');
    expect(Object.values(body)).not.toContain('null');
    expect(Object.keys(body)).toEqual(expect.arrayContaining([
      'dob', 'gender', 'personal_email', 'phone', 'address', 'emergency_name', 'emergency_phone',
      'emergency_relationship', 'college', 'course', 'specialization', 'current_year', 'graduation_year',
      'department', 'designation', 'internship_type', 'start_date', 'end_date', 'status', 'stipend',
      'stipend_frequency', 'other_benefits', 'notes',
    ]));
    // Completion and certificate details are not part of the form any more.
    for (const k of ['completed_on', 'certificate_issued', 'certificate_number']) expect(body).not.toHaveProperty(k);
  });

  it('offers only the allowed statuses: starting ones on Add, current + allowed moves on Edit, never Completed', async () => {
    routeGets();
    render(<AddIntern setPage={vi.fn()} />);
    await screen.findByDisplayValue('INT006');
    fireEvent.click(screen.getByRole('button', { name: /^Internship Information/ }));
    await waitFor(() => expect([...screen.getByLabelText(/^Status/).options].map(o => o.value))
      .toEqual(['Applied', 'Selected', 'Onboarding', 'Active']));
    cleanup();
    routeGets();
    render(<EditIntern setPage={vi.fn()} urlParams={{ id: '5' }} />);
    await screen.findByDisplayValue('INT005');
    fireEvent.click(screen.getByRole('button', { name: /^Internship Information/ }));
    // waitFor, like the Add half above: the options arrive with the record, and
    // a synchronous read raced the render under full-suite load (2026-10-29).
    await waitFor(() => expect([...screen.getByLabelText(/^Status/).options].map(o => o.value)).toEqual(['Active', 'Terminated']));
  });

  it('Add marks every missing required field and opens the first one', async () => {
    routeGets();
    render(<AddIntern setPage={vi.fn()} />);
    await screen.findByDisplayValue('INT006');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(await screen.findByText('First name is required.')).toBeTruthy();
    expect(screen.getByText('7 fields need attention.')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('Add posts a complete intern with documents and opens the new record', async () => {
    routeGets();
    api.post.mockResolvedValue({ data: { id: 9, intern_code: 'INT006', first_name: 'Ravi' } });
    const setPage = vi.fn();
    render(<AddIntern setPage={setPage} />);
    await screen.findByDisplayValue('INT006');
    fireEvent.change(screen.getByLabelText(/^First Name/), { target: { value: 'Ravi' } });
    fireEvent.click(screen.getByRole('button', { name: /^Education/ }));
    fireEvent.change(screen.getByLabelText(/^College \/ Institution/), { target: { value: 'COEP' } });
    fireEvent.change(screen.getByLabelText(/^Course \/ Degree/), { target: { value: 'B.Tech' } });
    fireEvent.click(screen.getByRole('button', { name: /^Internship Information/ }));
    fireEvent.change(screen.getByLabelText(/^Department/), { target: { value: 'Engineering' } });
    fireEvent.change(screen.getByLabelText(/^Internship Role/), { target: { value: 'Software Intern' } });
    fireEvent.change(screen.getByLabelText(/^Start Date/), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText(/^End Date/), { target: { value: '2026-11-15' } });
    expect(screen.getByLabelText('Duration').value).toBe('15 days');
    fireEvent.click(screen.getByRole('button', { name: /^Documents/ }));
    const file = new File(['%PDF'], 'letter.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Upload Institution Letter'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const body = sent(api.post.mock.calls[0][1]);
    expect(body).toMatchObject({ first_name: 'Ravi', college: 'COEP', department: 'Engineering',
      start_date: '2026-11-01', end_date: '2026-11-15', status: 'Selected', doc_institution_letter: 'letter.pdf' });
    expect(body.intern_code).toBeUndefined();
    await waitFor(() => expect(setPage).toHaveBeenCalledWith('ViewIntern', { id: 9 }), { timeout: 3000 });
  });

  it('puts a server field error on the field it names', async () => {
    routeGets();
    api.put.mockRejectedValue({ response: { status: 400, data: { error: '"X" is not a valid department.', field: 'department' } } });
    render(<EditIntern setPage={vi.fn()} urlParams={{ id: '5' }} />);
    await screen.findByDisplayValue('INT005');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(await screen.findByText('"X" is not a valid department.')).toBeTruthy();
    expect(screen.getByDisplayValue('Engineering')).toBeTruthy();   // Internship section opened
  });
});

describe('View Intern', () => {
  it('shows the record, documents and the shared photo viewer', async () => {
    routeGets();
    render(<ViewIntern setPage={vi.fn()} urlParams={{ id: '5' }} />);
    expect(await screen.findByText('Asha Rao')).toBeTruthy();
    expect(screen.getAllByText('INT005').length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole('button', { name: /photo full size/ }));
    expect(screen.getByRole('dialog', { name: 'Asha Rao photo' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Asha Rao photo' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(await screen.findByText('College ID')).toBeTruthy();
    expect(await screen.findAllByRole('button', { name: 'Download' })).toHaveLength(2);
  });

  it('Mark Completed calls the completion action with just the date', async () => {
    routeGets();
    api.post.mockResolvedValue({ data: { ...FULL, status: 'Completed', completed_on: '2026-06-30' } });
    render(<ViewIntern setPage={vi.fn()} urlParams={{ id: '5' }} />);
    fireEvent.click(await screen.findByRole('button', { name: /Mark Completed/ }));
    expect(screen.queryByLabelText('Certificate issued')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark Completed' }).at(-1));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/interns/5/complete', { completed_on: '2026-06-30' }));
    expect(api.put).not.toHaveBeenCalled();
  });

  it('Mark Completed is disabled, with the reason, until the internship is eligible', async () => {
    routeGets();
    api.get.mockImplementation(async (url) => {
      if (url.startsWith('/interns/5')) {
        return { data: { ...FULL, completion: { eligible: false, reason: 'The mentor\'s evaluation is Submitted; HR must approve it first.' } } };
      }
      throw new Error(url);
    });
    render(<ViewIntern setPage={vi.fn()} urlParams={{ id: '5' }} />);
    const btn = await screen.findByRole('button', { name: /Mark Completed/ });
    expect(btn).toBeDisabled();
    expect(btn.title).toMatch(/HR must approve it first/);
  });
});

describe('Internships register', () => {
  const SUMMARY = {
    soon_days: 14,
    cards: { active: 3, starting_soon: 1, ending_soon: 2, completed: 4, awaiting_completion: 1, total: 11 },
    card_filters: { active: { view: 'active' }, starting_soon: { view: 'starting_soon' }, ending_soon: { view: 'ending_soon' },
      completed: { view: 'completed' }, awaiting_completion: { view: 'awaiting_completion' }, total: {} },
    reports: {
      active_by_department: [{ label: 'Engineering', count: 3, filter: { view: 'active', department: 'Engineering' } }],
      by_college: [{ label: 'COEP', count: 5, filter: { college: 'COEP' } }],
      by_duration: [{ label: 'Up to 1 month', count: 2, filter: { duration: 'Up to 1 month' } }],
      by_status: [{ label: 'Active', count: 3, filter: { status: 'Active' } }],
      stipend: { monthly_run_rate: 30000, committed_total: 180000, paid: 3, unpaid: 0, all_time_total: 250000,
        by_department: [{ label: 'Engineering', count: 3, monthly: 30000, filter: { view: 'current', department: 'Engineering' } }] },
    },
  };
  const OPTIONS = { departments: ['Engineering'], colleges: ['COEP'], internship_types: [], mentors: [{ id: 7, name: 'Meera Nair' }],
    statuses: META.statuses, durations: ['Up to 1 month'] };
  const ROW = { id: 5, intern_code: 'INT005', name: 'Asha Rao', college: 'COEP', department: 'Engineering', designation: 'Software Intern',
    mentor_name: 'Meera Nair', start_date: '2026-01-01', end_date: '2026-06-30', duration_days: 181, status: 'Active',
    stipend: '10000.00', stipend_frequency: 'Monthly' };

  const mount = (urlParams = {}) => {
    routeGets({ '/interns/summary': SUMMARY, '/interns/filter-options': OPTIONS, '/interns?': [ROW] });
    const setPage = vi.fn();
    render(<Internships setPage={setPage} urlParams={urlParams} />);
    return setPage;
  };

  it('shows the five cards; each opens the register with its own filter', async () => {
    const setPage = mount();
    expect(await screen.findByText('Asha Rao')).toBeTruthy();
    for (const [label, filter] of [['Active Interns', { view: 'active' }], ['Starting Soon', { view: 'starting_soon' }],
      ['Ending Soon', { view: 'ending_soon' }], ['Completed', { view: 'completed' }], ['Total Interns', {}]]) {
      fireEvent.click(screen.getByText(label, { selector: '.plh-stat-label' }).closest('button'));
      expect(setPage).toHaveBeenLastCalledWith('Internships', filter);
    }
    expect(screen.getByText('6 months')).toBeTruthy();
    expect(screen.getByText('₹10,000 / month')).toBeTruthy();
  });

  it('sends the URL filters to the API and lists the columns the brief asks for', async () => {
    mount({ status: 'Active', college: 'COEP' });
    await screen.findByText('Asha Rao');
    expect(api.get).toHaveBeenCalledWith('/interns?college=COEP&status=Active');
    const heads = [...document.querySelectorAll('.in-table th')].map(th => th.textContent);
    expect(heads).toEqual(['#', 'Intern ID', 'Intern Name', 'College', 'Department', 'Internship Role', 'Mentor',
      'Start Date', 'End Date', 'Duration', 'Status', 'Stage', 'Stipend', 'Actions']);
  });

  it('View / Edit / + Add Intern / View Employees navigate', async () => {
    const setPage = mount();
    await screen.findByText('Asha Rao');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(setPage).toHaveBeenLastCalledWith('ViewIntern', { id: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(setPage).toHaveBeenLastCalledWith('EditIntern', { id: 5 });
    fireEvent.click(screen.getByRole('button', { name: '+ Add Intern' }));
    expect(setPage).toHaveBeenLastCalledWith('AddIntern');
    fireEvent.click(screen.getByRole('button', { name: 'View Employees →' }));
    expect(setPage).toHaveBeenLastCalledWith('EmployeesData');
  });

  it('report bars open the register filtered to what they counted', async () => {
    const setPage = mount({ tab: 'reports' });
    fireEvent.click(await screen.findByTitle(/^COEP: 5/));
    expect(setPage).toHaveBeenLastCalledWith('Internships', { college: 'COEP' });
    fireEvent.click(screen.getByTitle(/^Engineering: ₹30,000/));
    expect(setPage).toHaveBeenLastCalledWith('Internships', { view: 'current', department: 'Engineering' });
  });
});
