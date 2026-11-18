/**
 * Finance enters an employee's IT declaration (2026-11-11).
 *
 * Employees no longer file their own (Self-Service removed; self_service
 * add/edit off). Payroll Center → Tax & Statutory → IT declarations offers
 * "+ Add declaration" to it_declarations:add holders only; the form files the
 * SAME it_declarations row for the chosen employee (§264 HRA / 80D rules kept).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
let grants = [];
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => grants.includes(`${m}:${a}`) }),
}));

import api from '../services/api/client';
import AddDeclarationForm from '../features/hr/components/payroll/AddDeclarationForm';
import ITDeclarationReview from '../features/hr/pages/ITDeclarationReview';

const PEOPLE = [
  { employee_id: 3, name: 'Anu Natesh', employee_code: 'EMP003', department: 'IT', regime: 'old' },
  { employee_id: 2, name: 'Natesh Mayavel', employee_code: 'EMP002', department: 'Engineering', regime: 'new' },
];

beforeEach(() => {
  vi.clearAllMocks();
  grants = [];
  api.get.mockImplementation(url => Promise.resolve({ data: url === '/payroll/tax-setup' ? { data: { employees: PEOPLE } } : [] }));
  api.post.mockImplementation(url => Promise.resolve({ data: url === '/self-service/it-declarations' ? { id: 41 } : {} }));
});

async function openForm(onSaved = vi.fn()) {
  const view = render(<AddDeclarationForm financialYear="2026-2027" onSaved={onSaved} />);
  const emp = await screen.findByLabelText('Employee *');
  await waitFor(() => expect(emp.disabled).toBe(false));
  return { form: view.container.querySelector('form'), emp, onSaved };
}

describe('Add declaration (Finance)', () => {
  it('the employee list opens on click and says whether the declaration changes tax', async () => {
    const { emp } = await openForm();
    expect([...emp.options].map(o => o.textContent)).toEqual(['Choose an employee', 'Anu Natesh (EMP003) · IT', 'Natesh Mayavel (EMP002) · Engineering']);
    fireEvent.change(emp, { target: { value: '2' } });
    expect(screen.getByText(/New tax regime — declarations do not change their tax/)).toBeTruthy();
    fireEvent.change(emp, { target: { value: '3' } });
    expect(screen.getByText(/Old tax regime/)).toBeTruthy();
  });

  it('HRA: landlord (PAN above ₹1,00,000), metro, for the chosen employee; the proof is attached after filing', async () => {
    const { form, emp, onSaved } = await openForm();
    fireEvent.change(emp, { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Declaration type'), { target: { value: 'HRA' } });
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '150000' } });
    expect(screen.getByLabelText(/Landlord PAN \*/).required).toBe(true);
    fireEvent.change(screen.getByLabelText(/Landlord name/), { target: { value: 'R Owner' } });
    fireEvent.change(screen.getByLabelText(/Landlord PAN/), { target: { value: 'abcde1234f' } });
    fireEvent.click(screen.getByLabelText(/metro city/));
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Rent 2026' } });
    fireEvent.change(screen.getByLabelText(/Proof file/), { target: { files: [new File(['%PDF'], 'rent.pdf', { type: 'application/pdf' })] } });
    fireEvent.submit(form);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/self-service/it-declarations', expect.objectContaining({
      employee_id: 3, financial_year: '2026-2027', declaration_type: 'HRA', amount: '150000',
      landlord_name: 'R Owner', landlord_pan: 'ABCDE1234F', metro_city: true,
    })));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/self-service/it-declarations/41/proof', expect.any(FormData), expect.anything()));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ name: 'Anu Natesh', proofError: null }));
  });

  it('80D says whom the insurance is for; "60 or over" only for parents; no HRA fields sent', async () => {
    const { form, emp } = await openForm();
    fireEvent.change(emp, { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Declaration type'), { target: { value: '80D' } });
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '30000' } });
    expect(screen.queryByLabelText(/A parent covered is 60 or over/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Insurance is for'), { target: { value: 'parents' } });
    fireEvent.click(screen.getByLabelText(/A parent covered is 60 or over/));
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Parents policy' } });
    fireEvent.submit(form);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/self-service/it-declarations', expect.objectContaining({
      declaration_type: '80D', insured_for: 'parents', parents_senior: true,
    })));
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('landlord_name');
  });

  it('a server refusal is shown, nothing is reported saved', async () => {
    api.post.mockRejectedValueOnce({ response: { data: { message: 'This declaration is already on file (#7, submitted).' } } });
    const { form, emp, onSaved } = await openForm();
    fireEvent.change(emp, { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'PPF' } });
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This declaration is already on file (#7, submitted).');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('IT declarations screen', () => {
  it('offers "+ Add declaration" only to it_declarations:add holders', async () => {
    grants = ['it_declarations:view', 'it_declarations:approve'];          // hr_manager since 2026-11-11
    const { unmount } = render(<ITDeclarationReview embedded />);
    await screen.findByTestId('itdr-explainer');
    expect(screen.queryByRole('button', { name: /Add declaration/ })).toBeNull();
    unmount();

    grants = ['it_declarations:view', 'it_declarations:add'];              // finance_manager
    render(<ITDeclarationReview embedded />);
    fireEvent.click(await screen.findByRole('button', { name: /Add declaration/ }));
    expect(await screen.findByRole('form', { name: 'Add declaration for an employee' })).toBeTruthy();
  });
});
