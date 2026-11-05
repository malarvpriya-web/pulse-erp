import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Mock api client
vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import api from '../services/api/client';
import EmployeeDirectory from '../features/hr/pages/EmployeeDirectory.jsx';

const mockEmployees = [
  { id: 1, name: 'Arun Kumar',  department: 'Engineering', designation: 'Senior Developer', email: 'arun@manifest.in',  status: 'active' },
  { id: 2, name: 'Priya Nair',  department: 'HR',          designation: 'HR Manager',        email: 'priya@manifest.in', status: 'active' },
  { id: 3, name: 'Suresh Kumar',department: 'Finance',     designation: 'Finance Manager',   email: 'suresh@manifest.in',status: 'active' },
];

beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });

describe('EmployeeDirectory — smoke', () => {
  it('renders loading state initially', () => {
    api.get.mockReturnValue(new Promise(() => {})); // never resolves
    render(<EmployeeDirectory setPage={() => {}} />);
    expect(screen.getByText(/loading/i)).toBeDefined();
  });

  it('renders employee cards after load', async () => {
    api.get.mockResolvedValue({ data: mockEmployees });
    render(<EmployeeDirectory setPage={() => {}} />);

    await waitFor(() => expect(screen.getByText('Arun Kumar')).toBeDefined());
    expect(screen.getByText('Priya Nair')).toBeDefined();
    expect(screen.getByText('Suresh Kumar')).toBeDefined();
  });

  it('shows page heading', async () => {
    api.get.mockResolvedValue({ data: [] });
    render(<EmployeeDirectory setPage={() => {}} />);

    await waitFor(() => expect(screen.getByText('Employee Directory')).toBeDefined());
  });

  it('shows empty state when no employees returned', async () => {
    api.get.mockResolvedValue({ data: [] });
    render(<EmployeeDirectory setPage={() => {}} />);

    await waitFor(() => expect(screen.getByText(/no employees/i)).toBeDefined());
  });
});

// 2026-10-20: cards used to open Employee Profile, which is gated on
// employees:view — hr_manager / hr_exec / payroll_admin landed on Access Denied.
describe('EmployeeDirectory — read-only detail', () => {
  const row = {
    id: 7, office_id: 'EMP007', name: 'Meena Iyer', designation: 'Engineer', department: 'Engineering',
    company_email: 'meena@corp.example', phone: null, location: 'Chennai', reporting_manager: 'R. Rao',
    status: 'Active', joining_date: '2024-02-01',
  };

  it('a card click opens a read-only panel and never navigates', async () => {
    api.get.mockResolvedValue({ data: [row] });
    const setPage = vi.fn();
    render(<EmployeeDirectory setPage={setPage} />);
    fireEvent.click(await screen.findByText('Meena Iyer'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('meena@corp.example');
    expect(dialog.textContent).toContain('Chennai');
    expect(dialog.textContent).toContain('R. Rao');
    expect(dialog.textContent).toContain('EMP007');
    expect(dialog.textContent).not.toContain('Phone');   // withheld by the API → no row at all
    expect(dialog.querySelector('input, select, textarea')).toBeNull();
    expect(setPage).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('selectedEmployeeId')).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(1);           // nothing fetched beyond the phonebook
  });

  it('closes on Escape and on the close button', async () => {
    api.get.mockResolvedValue({ data: [row] });
    render(<EmployeeDirectory />);
    fireEvent.click(await screen.findByText('Meena Iyer'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByText('Meena Iyer'));
    fireEvent.click(await screen.findByLabelText('Close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a failed phonebook load shows an error and never falls back to GET /employees', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('boom'), { response: { data: { error: 'Directory unavailable' } } }));
    render(<EmployeeDirectory />);
    expect(await screen.findByText('Directory unavailable')).toBeDefined();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/employees/directory');
  });
});
