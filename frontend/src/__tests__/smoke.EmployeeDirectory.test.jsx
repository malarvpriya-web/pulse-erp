import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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

beforeEach(() => vi.clearAllMocks());

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
