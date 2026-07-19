import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

// EmployeesData.css is imported by EmployeeProfile — stub it
vi.mock('../features/employees/pages/EmployeesData.css', () => ({}));

// EmployeeProfile calls useToast(), which throws outside <ToastProvider> — that
// alone failed all 5 tests here.
vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import api from '../services/api/client';
import EmployeeProfile from '../features/employees/pages/EmployeeProfile.jsx';

const mockEmployee = {
  id: 42,
  first_name: 'Arun',
  last_name: 'Kumar',
  department: 'Engineering',
  designation: 'Senior Developer',
  company_email: 'arun@manifest.in',
  status: 'Active',
  joining_date: '2022-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe('EmployeeProfile — smoke', () => {
  it('renders employee data when passed as prop', async () => {
    api.get.mockResolvedValue({ data: [] }); // notes call
    render(<EmployeeProfile employee={mockEmployee} setPage={() => {}} setSelectedEmployee={() => {}} />);
    // Multiple elements may contain the name (hero h1 + overview card)
    await waitFor(() => expect(screen.getAllByText('Arun Kumar').length).toBeGreaterThan(0));
  });

  it('shows error state when no employee and no sessionStorage', () => {
    render(<EmployeeProfile employee={null} setPage={() => {}} setSelectedEmployee={() => {}} />);
    expect(screen.getByText(/no employee selected/i)).toBeDefined();
  });

  it('loads employee from sessionStorage JSON when prop is missing', async () => {
    sessionStorage.setItem('selectedEmployee', JSON.stringify(mockEmployee));
    api.get.mockResolvedValue({ data: [] }); // notes call
    render(<EmployeeProfile employee={null} setPage={() => {}} setSelectedEmployee={() => {}} />);
    await waitFor(() => expect(screen.getAllByText('Arun Kumar').length).toBeGreaterThan(0));
  });

  it('fetches employee by id from backend when only selectedEmployeeId is in sessionStorage', async () => {
    sessionStorage.setItem('selectedEmployeeId', '42');
    api.get
      .mockResolvedValueOnce({ data: mockEmployee }) // GET /employees/42
      .mockResolvedValue({ data: [] });              // GET /notes/42

    render(<EmployeeProfile employee={null} setPage={() => {}} setSelectedEmployee={() => {}} />);

    // Loading state appears first
    expect(screen.getByText(/loading employee data/i)).toBeDefined();

    await waitFor(() => expect(screen.getAllByText('Arun Kumar').length).toBeGreaterThan(0));
    expect(api.get).toHaveBeenCalledWith('/employees/42');
  });

  it('shows error state when backend fetch fails', async () => {
    sessionStorage.setItem('selectedEmployeeId', '99');
    api.get.mockRejectedValueOnce(new Error('Network error'));

    render(<EmployeeProfile employee={null} setPage={() => {}} setSelectedEmployee={() => {}} />);

    await waitFor(() => expect(screen.getByText(/failed to load employee/i)).toBeDefined());
  });
});
