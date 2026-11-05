/**
 * Add Employee fields = Edit Employee fields.
 *
 * Edit Employee was an 841-line second copy of the Add form and the two had
 * drifted — compensation, grade, band, the location/zone masters, the photo
 * preview and the field-employee flag existed on one and not the other. It is
 * now a loader that mounts the SAME AddEmployee component in edit mode. This
 * suite is the acceptance test for that: it opens every section of both
 * screens and requires the same labels and the same controls, then proves the
 * edit screen is seeded from the FULL record (not the list row it was opened
 * from) and that a save sends what was changed — including clears, a salary
 * correction naming its revision, and a document removal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';

// Add / Edit Employee read the caller's grants (PC-01 closure: the salary is payroll:edit).
// An HR user holding it, as the form was written for.
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../features/employees/pages/AddEmployee.css', () => ({}));
vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));
vi.mock('../features/employees/pages/EmployeesData.css', () => ({}));
vi.mock('../components/ResultDialog', () => ({
  default: ({ dialog }) => (dialog ? <div role="dialog">{dialog.title}: {dialog.message}</div> : null),
}));
// The master pickers own their own fetches and menus (covered by their own
// suites). Here they only need to be a labelled control carrying a value.
const { Picker } = vi.hoisted(() => ({
  Picker: ({ id, value, onChange }) => (
    <input id={id} data-picker="1" value={value ?? ''} onChange={e => onChange(e.target.value, null)} />
  ),
}));
vi.mock('../components/core/MasterSelect', () => ({ default: Picker }));
vi.mock('../components/core/VocabSelect', () => ({ default: Picker }));
vi.mock('../components/core/BranchSelect', () => ({
  default: ({ id, value, onChange }) => (
    <input id={id} data-picker="1" value={value ?? ''} onChange={e => onChange(e.target.value, { name: 'Branch ' + e.target.value })} />
  ),
}));
vi.mock('../features/employees/shared/employeeFiles', () => ({
  loadEmployeeImage: vi.fn(async () => null),
  isExternalUrl: () => false,
  openEmployeeFile: vi.fn(async () => null),
}));

import api from '../services/api/client';
import AddEmployee from '../features/employees/pages/AddEmployee.jsx';
import EditEmployee from '../features/employees/pages/EditEmployee.jsx';

const SECTIONS = [
  'Basic Information', 'Family Information', 'Address', 'Education', 'Job Information',
  'Previous Experience', 'Bank Details', 'Compliance Documents', 'Emergency Contact',
  'Assets Allocated', 'Upload Documents', 'Notes',
];

/** The full record GET /employees/:id returns — every field the form has. */
const FULL = {
  id: 42, office_id: 'EMP042', first_name: 'Asha', last_name: 'Rao',
  company_email: 'asha@acme.in', personal_email: 'asha@home.in', phone: '9876543210', company_phone: '9123456780',
  gender: 'Female', blood_group: 'O+', dob: '1990-05-06', marital_status: 'Married',
  father_name: 'Ravi', mother_name: 'Lata', spouse_name: 'Wrong Spouse', anniversary_date: '2015-02-03',
  current_address: '1 Current St', permanent_address: '2 Permanent Rd',
  highest_qualification: 'MBA', basic_qualification: 'B.Com',
  department: 'Finance', designation: 'Analyst', grade: 'G3', band: 'B2', employee_role: 'Employee',
  reporting_manager_id: 7, reporting_manager: 'Former Boss', branch_id: 3, location: 'Pune',
  employment_type: 'Permanent', skill_type: 'Skilled', is_field_employee: true, zone: 'West', zone_id: 2,
  status: 'Active', joining_date: '2024-04-01',
  previous_company_1: 'Prev One', previous_role_1: 'Clerk', previous_years_1: 3,
  previous_company_2: 'Prev Two', previous_role_2: 'Lead', previous_years_2: 2,
  bank_name: 'State Bank of India', branch_name: 'Main', account_number: '000111222333', ifsc_code: 'SBIN0000001',
  nominee_name: 'Nom', emergency_name: 'Em', emergency_phone: '9000000000', emergency_relationship: 'Spouse',
  pan_number: 'ABCDE1234F', aadhaar_number: '123412341234', pf_number: 'PF9', uan_number: 'UAN9', esic_number: 'ES9',
  notes: 'hr notes', basic_salary: '4500.00',
  photo_url: '/uploads/p.jpg', pan_file: '/uploads/pan.pdf', aadhaar_file: '/uploads/a.pdf',
  cancelled_cheque_file: null, bank_statement_file: null, resume_file: '/uploads/cv.pdf', offer_letter_file: null,
};
// Two revisions: the hire figure (in force today) and a booked future increment.
const REVISIONS = [
  { id: 900, effective_from: '2099-01-01', basic_salary: '90000.00', special_allowance: '0.00' },
  { id: 501, effective_from: '2024-04-01', basic_salary: '4500.00', special_allowance: '500.00' },
];

function mockApi({ revisions = REVISIONS } = {}) {
  api.get.mockImplementation(async (url) => {
    if (url === '/employees/42') return { data: FULL };
    if (url === '/employees/42/salary-revisions') {
      if (revisions === 'forbidden') { const e = new Error('403'); e.response = { status: 403 }; throw e; }
      return { data: revisions };
    }
    if (url === '/employees/next-code') return { data: { code: 'EMP043' } };
    return { data: [] };
  });
  api.put.mockResolvedValue({ data: { id: 42 } });
  api.post.mockResolvedValue({ data: { id: 43 } });
}

const openSection = (name) => fireEvent.click(screen.getByText(name, { selector: '.accordion-header h2' }));

/** Every label and every control in every section, section by section. */
async function inventory() {
  const out = {};
  for (const name of SECTIONS) {
    openSection(name);
    const body = document.querySelector('.accordion-body');
    const labels = [
      ...[...body.querySelectorAll('label')].map(l => l.textContent),
      ...[...body.querySelectorAll('.upload-box > span:first-child')].map(s => s.textContent),
    ].map(t => t.replace(/[✓*]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const controls = [...body.querySelectorAll('input, select, textarea')]
      .map(c => `${c.tagName.toLowerCase()}:${c.type || ''}`);
    out[name] = { labels: labels.sort(), controls: controls.sort() };
  }
  return out;
}

const renderEdit = (employee = { id: 42, first_name: 'List Row Only' }) =>
  render(<EditEmployee employee={employee} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);

const waitForForm = () => waitFor(() => expect(document.querySelector('form.add-employee-form')).toBeTruthy());

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  cleanup();
});

describe('Edit Employee is the Add Employee form', () => {
  it('every section has the same labels and the same controls in Add and Edit', async () => {
    mockApi();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    const add = await inventory();
    cleanup();

    renderEdit();
    await waitForForm();
    const edit = await inventory();

    for (const name of SECTIONS) {
      // Edit may additionally show what is ON FILE (existing assets, stored
      // documents) — but every label and control Add has must be in Edit.
      for (const l of add[name].labels) expect(edit[name].labels, `${name}: "${l}" missing from Edit`).toContain(l);
      const editControls = [...edit[name].controls];
      for (const c of add[name].controls) {
        const i = editControls.indexOf(c);
        expect(i, `${name}: control ${c} missing from Edit`).toBeGreaterThanOrEqual(0);
        editControls.splice(i, 1);
      }
    }
    expect(Object.keys(edit)).toEqual(Object.keys(add));
  });

  it('salary is an editable input in Edit, not read-only', async () => {
    mockApi();
    renderEdit();
    await waitForForm();
    openSection('Job Information');
    const basic = document.getElementById('ae-basic-salary');
    expect(basic.disabled).toBe(false);
    expect(basic.readOnly).toBe(false);
    expect(document.getElementById('ae-special-allowance')).toBeTruthy();
  });
});

describe('Edit Employee is seeded from the FULL record', () => {
  it('loads GET /employees/:id rather than trusting the list row', async () => {
    mockApi();
    renderEdit({ id: 42, first_name: 'List Row Only' });
    await waitForForm();
    expect(api.get).toHaveBeenCalledWith('/employees/42');
    expect(document.getElementById('ae-first-name').value).toBe('Asha');
  });

  it('pre-populates values in every section', async () => {
    mockApi();
    renderEdit();
    await waitForForm();
    const v = (id) => document.getElementById(id).value;

    expect(v('ae-employee-id')).toBe('EMP042');
    expect(v('ae-personal-email')).toBe('asha@home.in');
    expect(v('ae-dob')).toBe('1990-05-06');

    openSection('Family Information');
    expect(screen.getByDisplayValue('Wrong Spouse')).toBeTruthy();
    openSection('Address');
    expect(screen.getByDisplayValue('2 Permanent Rd')).toBeTruthy();
    openSection('Education');
    expect(v('ae-highest-qualification')).toBe('MBA');

    openSection('Job Information');
    expect(v('ae-department')).toBe('Finance');
    expect(v('ae-grade')).toBe('G3');
    expect(v('ae-band')).toBe('B2');
    expect(v('ae-location')).toBe('3');
    expect(v('ae-zone')).toBe('West');
    expect(v('ae-joining-date')).toBe('2024-04-01');
    // A manager who is not in the active list is still offered, not dropped.
    expect(v('ae-reporting-manager')).toBe('7');
    // The revision IN FORCE today, not the booked future increment.
    expect(v('ae-basic-salary')).toBe('4500');
    expect(v('ae-special-allowance')).toBe('500');
    expect(screen.getByText(/Correcting the salary revision effective 2024-04-01/)).toBeTruthy();

    openSection('Previous Experience');
    expect(screen.getByDisplayValue('Prev Two')).toBeTruthy();
    openSection('Bank Details');
    expect(screen.getByDisplayValue('000111222333')).toBeTruthy();
    openSection('Compliance Documents');
    expect(v('ae-pan')).toBe('ABCDE1234F');
    expect(v('ae-aadhaar')).toBe('123412341234');
    openSection('Emergency Contact');
    expect(v('ae-emergency-relationship')).toBe('Spouse');
    openSection('Notes');
    expect(screen.getByDisplayValue('hr notes')).toBeTruthy();
  });

  it('shows the documents already on file', async () => {
    mockApi();
    renderEdit();
    await waitForForm();
    openSection('Upload Documents');
    const boxes = [...document.querySelectorAll('.upload-box')];
    const onFile = boxes.filter(b => /On file/.test(b.textContent)).map(b => b.querySelector('span').textContent.replace('✓', '').trim());
    expect(onFile.sort()).toEqual(['Aadhaar', 'PAN', 'Photo', 'Resume']);
  });
});

describe('saving Edit sends what changed', () => {
  const sent = () => {
    const fd = api.put.mock.calls[0][1];
    return Object.fromEntries([...fd.entries()]);
  };

  it('a clear, a salary correction naming its revision, and a document removal', async () => {
    mockApi();
    renderEdit();
    await waitForForm();

    openSection('Family Information');
    fireEvent.change(screen.getByDisplayValue('Wrong Spouse'), { target: { value: '' } });
    openSection('Job Information');
    fireEvent.change(document.getElementById('ae-basic-salary'), { target: { value: '45000' } });
    fireEvent.change(document.getElementById('ae-reporting-manager'), { target: { value: '' } });
    openSection('Upload Documents');
    fireEvent.click(screen.getByRole('button', { name: 'Remove PAN' }));
    expect(screen.getByText('Will be removed on save.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());

    expect(api.put.mock.calls[0][0]).toBe('/employees/42');
    const body = sent();
    expect(body.spouse_name).toBe('');
    expect(body.basic_salary).toBe('45000');
    expect(body.special_allowance).toBe('500');
    expect(body.salary_revision_id).toBe('501');
    expect(body.reporting_manager_id).toBe('');
    expect(body.remove_files).toBe('pan_file');
    // Untouched values travel unchanged.
    expect(body.aadhaar_number).toBe('123412341234');
    expect(body.grade).toBe('G3');
  });

  it('an unchanged salary sends no salary at all', async () => {
    mockApi();
    renderEdit();
    await waitForForm();
    fireEvent.change(document.getElementById('ae-first-name'), { target: { value: 'Asha K' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = sent();
    expect(body.first_name).toBe('Asha K');
    expect(body).not.toHaveProperty('basic_salary');
    expect(body).not.toHaveProperty('salary_revision_id');
    expect(body).not.toHaveProperty('remove_files');
  });

  it('refuses to clear an existing salary on the client, with the message on the field', async () => {
    mockApi();
    renderEdit();
    await waitForForm();
    openSection('Job Information');
    fireEvent.change(document.getElementById('ae-basic-salary'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/Basic salary cannot be cleared/)).toBeTruthy());
    expect(api.put).not.toHaveBeenCalled();
  });

  it('when salary history cannot be read, the salary is shown read-only and never sent', async () => {
    mockApi({ revisions: 'forbidden' });
    renderEdit();
    await waitForForm();
    openSection('Job Information');
    expect(document.getElementById('ae-basic-salary').disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('basic_salary');
  });
});

describe('Add Employee stays Add', () => {
  it('a fresh Add form posts, with no edit-only keys', async () => {
    mockApi();
    render(<AddEmployee employee={null} setPage={vi.fn()} setSelectedEmployee={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Add Employee' })).toBeTruthy();
    expect(within(document.querySelector('form')).queryByText(/On file/)).toBeNull();
  });
});
