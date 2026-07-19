import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

// EmployeeDocuments calls useAuth(), which throws outside <AuthProvider> — that
// alone failed all 7 tests here. Permissions are granted: this is a render smoke
// suite, and canManage gates the Add/Delete controls the tests assert on.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 3, employee_id: 3, name: 'HR Admin', company_id: 1 },
    hasPermission: () => true,
    hasAnyRole: () => true,
  }),
}));

import api from '../services/api/client';
import EmployeeDocuments from '../features/hr/pages/EmployeeDocuments.jsx';

const mockEmployees = [
  { id: 1, first_name: 'Arun',  last_name: 'Kumar', office_id: 'EMP001', department: 'Engineering', status: 'Active' },
  { id: 2, first_name: 'Priya', last_name: 'Nair',  office_id: 'EMP002', department: 'HR',          status: 'Active' },
];

const mockDocs = [
  { id: 10, document_name: 'Offer_Letter_2025', document_type: 'Offer Letter', file_size: '120KB', status: 'verified', uploaded_at: '2025-01-15', verified_by_name: 'HR Admin', file_url: '' },
];

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe('EmployeeDocuments — no employee selected', () => {
  it('renders Employee Documents heading and add button', async () => {
    api.get.mockResolvedValue({ data: [] });
    render(<EmployeeDocuments setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Employee Documents')).toBeDefined());
    expect(screen.getByText(/Add Document Record/)).toBeDefined();
  });

  it('shows loading state while fetching documents', () => {
    api.get.mockReturnValue(new Promise(() => {})); // never resolves
    render(<EmployeeDocuments setPage={() => {}} />);
    expect(screen.getByText('Loading documents…')).toBeDefined();
  });

  it('shows empty state when no documents exist', async () => {
    api.get.mockResolvedValue({ data: [] });
    render(<EmployeeDocuments setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('No document records found')).toBeDefined());
  });

  it('renders document rows after data loads', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/employees') return Promise.resolve({ data: mockEmployees });
      return Promise.resolve({ data: mockDocs });
    });
    render(<EmployeeDocuments setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Offer_Letter_2025')).toBeDefined());
  });
});

describe('EmployeeDocuments — employee already selected', () => {
  beforeEach(() => {
    sessionStorage.setItem('selectedEmployee', JSON.stringify(mockEmployees[0]));
  });

  it('skips selector and shows documents page heading', async () => {
    api.get.mockResolvedValueOnce({ data: [] });
    render(<EmployeeDocuments setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Employee Documents')).toBeDefined());
    expect(screen.queryByText(/select an employee/i)).toBeNull();
  });

  it('shows Add Document Record button (not Upload Document)', async () => {
    api.get.mockResolvedValueOnce({ data: [] });
    render(<EmployeeDocuments setPage={() => {}} />);
    // Button text is "+ Add Document Record"
    await waitFor(() => expect(screen.getByText(/Add Document Record/)).toBeDefined());
    expect(screen.queryByText(/Upload Document/)).toBeNull();
  });

  it('opens drawer with Add Document Record title when button clicked', async () => {
    api.get.mockResolvedValueOnce({ data: [] });
    render(<EmployeeDocuments setPage={() => {}} />);
    await waitFor(() => screen.getByText(/Add Document Record/));
    // Click the header button to open drawer
    fireEvent.click(screen.getByText(/Add Document Record/));
    // Drawer title
    await waitFor(() => expect(screen.getAllByText(/Add Document Record/).length).toBeGreaterThanOrEqual(2));
  });
});
