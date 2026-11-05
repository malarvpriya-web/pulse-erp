/**
 * Intern education dropdowns, through the REAL VocabSelect / MasterSelect.
 *
 * internships.test.jsx swaps the pickers for plain inputs to test the form's
 * plumbing. This file keeps them real, because what is under test is the
 * pickers' own behaviour inside this form:
 *
 *  - Course / Specialization / Year-Semester are <select>s fed by the
 *    'courses' / 'specializations' / 'academic-years' vocabularies, the same in
 *    Add and Edit.
 *  - A stored value that is not in the list (pre-dropdown free text, or a value
 *    since deactivated) is SHOWN as the selected option and saved back
 *    unchanged — never rendered blank and wiped.
 *  - The optional two can be cleared back to blank; the required one cannot be
 *    saved blank.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

vi.mock('@/services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), head: vi.fn() },
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { userId: 1 }, roles: ['hr'], hasAnyRole: (...r) => r.includes('hr') }),
}));
vi.mock('@/features/employees/pages/AddEmployee.css', () => ({}));
vi.mock('@/features/internships/pages/Internships.css', () => ({}));
vi.mock('@/components/ResultDialog', () => ({
  default: ({ dialog }) => (dialog ? <div role="dialog">{dialog.title}</div> : null),
}));
vi.mock('@/features/employees/shared/employeeFiles', () => ({
  loadEmployeeImage: vi.fn(async () => null), isExternalUrl: () => false, openEmployeeFile: vi.fn(async () => null),
}));

import api from '@/services/api/client';
import { __resetVocabRegistry } from '@/components/core/VocabSelect';
import AddIntern, { EDUCATION_PICKERS } from '@/features/internships/pages/AddIntern.jsx';

const rows = (...names) => names.map((name, i) => ({ id: i + 1, name }));
const VOCAB = {
  courses:          rows('BE/BTech', 'MBA', 'BCom'),
  specializations:  rows('Computer Science', 'Finance'),
  'academic-years': rows('1st Year - Semester 1', '3rd Year - Semester 5', 'Final Year'),
  'internship-types': rows('Summer Internship'),
};
const META = {
  statuses: ['Applied', 'Selected', 'Onboarding', 'Active', 'Completed', 'Cancelled', 'Terminated'],
  stipend_frequencies: ['Monthly'], doc_types: [], max_duration_days: 731,
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  __resetVocabRegistry();
  api.get.mockImplementation(async (url) => {
    if (url === '/master/v') {
      return { data: Object.keys(VOCAB).map(key => ({ key, label: key, roles: ['hr'], endpoint: `/master/v/${key}` })) };
    }
    const m = url.match(/^\/master\/v\/([\w-]+)/);
    if (m) return { data: VOCAB[m[1]] || [] };
    if (url.startsWith('/master/')) return { data: rows('Engineering', 'Software Intern') };
    if (url === '/interns/meta') return { data: META };
    if (url === '/interns/mentor-options') return { data: [] };
    if (url === '/interns/next-code') return { data: { code: 'INT010' } };
    throw new Error(`unexpected GET ${url}`);
  });
});

/** Open the Education section and wait for all three dropdowns to load. */
async function openEducation() {
  fireEvent.click(screen.getByRole('button', { name: /^Education/ }));
  for (const p of EDUCATION_PICKERS) {
    await waitFor(() => {
      const el = document.getElementById(`ai-${p.k.replace(/_/g, '-')}`);
      expect(el?.tagName, p.k).toBe('SELECT');
      expect(el.disabled, `${p.k} still loading`).toBe(false);
    });
  }
}
const select = (k) => document.getElementById(`ai-${k.replace(/_/g, '-')}`);
const optionTexts = (k) => [...select(k).options].map(o => o.textContent);
const sent = (fd) => Object.fromEntries([...fd.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]));

const STORED = {
  id: 3, intern_code: 'INT003', first_name: 'Legacy', last_name: 'Row', college: 'COEP',
  course: 'B.Tech (Hons)', specialization: 'Robotics & AI', current_year: '3rd Year - Semester 5',
  department: 'Engineering', designation: 'Software Intern', start_date: '2026-01-01', end_date: '2026-03-31',
  status: 'Active', documents: [],
};

describe('the three education fields are vocabulary dropdowns', () => {
  it('maps each field to its vocabulary', () => {
    expect(EDUCATION_PICKERS.map(p => [p.k, p.vocab, p.required])).toEqual([
      ['course', 'courses', true],
      ['specialization', 'specializations', false],
      ['current_year', 'academic-years', false],
    ]);
  });

  it('Add and Edit render the same dropdowns with the same options', async () => {
    render(<AddIntern setPage={vi.fn()} />);
    await screen.findByDisplayValue('INT010');
    await openEducation();
    const add = EDUCATION_PICKERS.map(p => optionTexts(p.k));
    cleanup();

    render(<AddIntern setPage={vi.fn()} intern={{ ...STORED, course: 'MBA', specialization: 'Finance', current_year: 'Final Year' }} />);
    await openEducation();
    const edit = EDUCATION_PICKERS.map(p => optionTexts(p.k));
    expect(edit).toEqual(add);
    expect(add[0]).toEqual(['-- Select Course / Degree --', 'BE/BTech', 'MBA', 'BCom', expect.stringMatching(/^\+ Add new/)]);
    expect(select('course').value).toBe('MBA');
    expect(select('specialization').value).toBe('Finance');
    expect(select('current_year').value).toBe('Final Year');
  });
});

describe('existing values are kept', () => {
  it('shows a stored value that is not in the list, and saves it back unchanged', async () => {
    api.put.mockResolvedValue({ data: { ...STORED } });
    render(<AddIntern setPage={vi.fn()} intern={STORED} />);
    await openEducation();
    expect(select('course').value).toBe('B.Tech (Hons)');
    expect(select('course').selectedOptions[0].textContent).toBe('B.Tech (Hons) (not in list)');
    expect(select('specialization').value).toBe('Robotics & AI');
    expect(select('current_year').value).toBe('3rd Year - Semester 5');   // in the list: no orphan

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(sent(api.put.mock.calls[0][1])).toMatchObject({
      course: 'B.Tech (Hons)', specialization: 'Robotics & AI', current_year: '3rd Year - Semester 5',
    });
  });

  it('a picked value replaces the stored one', async () => {
    api.put.mockResolvedValue({ data: { ...STORED } });
    render(<AddIntern setPage={vi.fn()} intern={STORED} />);
    await openEducation();
    fireEvent.change(select('course'), { target: { value: 'BE/BTech' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(sent(api.put.mock.calls[0][1]).course).toBe('BE/BTech');
  });
});

describe('clearing and required', () => {
  it('Specialization and Year / Semester can be cleared; the clear is sent as ""', async () => {
    api.put.mockResolvedValue({ data: { ...STORED } });
    render(<AddIntern setPage={vi.fn()} intern={{ ...STORED, course: 'MBA', specialization: 'Finance', current_year: 'Final Year' }} />);
    await openEducation();
    fireEvent.change(select('specialization'), { target: { value: '' } });
    fireEvent.change(select('current_year'), { target: { value: '' } });
    expect(select('specialization').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = sent(api.put.mock.calls[0][1]);
    expect(body).toMatchObject({ course: 'MBA', specialization: '', current_year: '' });
    expect(Object.values(body)).not.toContain('null');
  });

  it('Course is required', async () => {
    render(<AddIntern setPage={vi.fn()} intern={{ ...STORED, course: 'MBA' }} />);
    await openEducation();
    fireEvent.change(select('course'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(await screen.findByText('Course / degree is required.')).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('a server rejection of a value lands on its field', async () => {
    api.put.mockRejectedValue({ response: { status: 400, data: { field: 'specialization',
      error: '"Robotics & AI" is not in the Specialization list. Select a value from the list, or add it with "+ Add new".' } } });
    render(<AddIntern setPage={vi.fn()} intern={STORED} />);
    await screen.findByDisplayValue('INT003');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(await screen.findByText(/is not in the Specialization list/)).toBeTruthy();
    expect(select('specialization')).toBeTruthy();   // the Education section was opened to show it
  });
});
