/**
 * Document links (PAYROLL_DATA_FLOW_AUDIT.md Part 12): a stored document is
 * fetched through the authenticated GET /files/<name> route — never linked as
 * its raw '/uploads/…' path, which the server does not serve and a plain link
 * cannot authenticate. The file name is reduced to one encoded path segment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), head: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 9, employee_id: 7, name: 'Asha Rao', company_id: 1 }, hasPermission: () => true }),
}));
vi.mock('../hooks/usePunchMode', () => ({ default: () => ({ mode: 'manual', loading: false }) }));
vi.mock('../components/attendance/CameraClockModal', () => ({ default: () => null }));
vi.mock('../components/attendance/PunchModeNotice', () => ({ default: () => null }));
vi.mock('../components/core/VocabSelect', () => ({ default: () => null }));

import api from '../services/api/client';
import { storedFilename, downloadEmployeeFile, openEmployeeFile } from '../features/employees/shared/employeeFiles';
import EmployeeSelfService from '../features/hr/pages/EmployeeSelfService.jsx';
import EmployeeDocuments from '../features/hr/pages/EmployeeDocuments.jsx';

const DOC = { id: 5, employee_id: 7, document_type: 'PAN Card', document_name: 'pan.pdf', file_url: '/uploads/1772020686985_pan card#1.pdf',
  status: 'pending', verified: false, uploaded_at: '2026-10-01T00:00:00Z', employee_name: 'Asha Rao', employee_code: 'EMP007' };
const ENCODED = '/files/1772020686985_pan%20card%231.pdf';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  api.get.mockImplementation((url) => {
    if (url.startsWith('/self-service/documents')) return Promise.resolve({ data: [DOC] });
    if (url.startsWith('/files/')) return Promise.resolve({ data: new Blob(['x']) });
    return Promise.resolve({ data: [] });
  });
});

describe('stored file name → one safe path segment', () => {
  it('keeps only the last segment and encodes it', async () => {
    expect(storedFilename('/uploads/a.pdf')).toBe('a.pdf');
    expect(storedFilename('/uploads/../../etc/passwd')).toBe('passwd');
    expect(storedFilename('..\\..\\secret.pdf')).toBe('secret.pdf');
    for (const bad of ['/uploads/..', '/uploads/.', '..', '', null, '/uploads/']) expect(storedFilename(bad)).toBeNull();
    await downloadEmployeeFile('/uploads/x?y=1&z/../a b.pdf');
    expect(api.get).toHaveBeenLastCalledWith('/files/a%20b.pdf', { responseType: 'blob' });
  });

  it('a name that is only dots never reaches the API', async () => {
    expect(await downloadEmployeeFile('/uploads/..')).toBe('This record has no file attached.');
    expect(await openEmployeeFile('/uploads/.')).toBe('This record has no file attached.');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('a refused download is reported, not opened', async () => {
    api.get.mockRejectedValueOnce({ response: { status: 403 } });
    expect(await downloadEmployeeFile(DOC.file_url)).toBe('You do not have permission to open this file.');
  });
});

describe('Self-service Document Vault', () => {
  it('the ⬇ control downloads through /files/<encoded name>; no raw /uploads link is rendered', async () => {
    const { container } = render(<EmployeeSelfService />);
    fireEvent.click(await screen.findByRole('button', { name: 'Document Vault' }));
    const btn = await screen.findByRole('button', { name: 'Download pan.pdf' });
    expect(container.querySelector('a[href*="/uploads/"]')).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(ENCODED, { responseType: 'blob' }));
  });

  it('a refused download shows the server\'s answer instead of a broken tab', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/self-service/documents')) return Promise.resolve({ data: [DOC] });
      if (url.startsWith('/files/')) return Promise.reject({ response: { status: 403 } });
      return Promise.resolve({ data: [] });
    });
    render(<EmployeeSelfService />);
    fireEvent.click(await screen.findByRole('button', { name: 'Document Vault' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download pan.pdf' }));
    expect(await screen.findByText('You do not have permission to open this file.')).toBeTruthy();
  });
});

describe('HR Employee Documents', () => {
  it('View opens an uploaded file through /files (inline), and a Drive link as-is', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({});
    api.get.mockImplementation((url) => {
      if (url === '/self-service/documents') return Promise.resolve({ data: [DOC, { ...DOC, id: 6, file_url: null, drive_url: 'https://drive.google.com/file/d/abc' }] });
      if (url.startsWith('/files/')) return Promise.resolve({ data: new Blob(['x']) });
      return Promise.resolve({ data: [] });
    });
    render(<EmployeeDocuments />);
    const views = await screen.findAllByTitle('View / Open');
    fireEvent.click(views[0]);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`${ENCODED}?disposition=inline`, { responseType: 'blob' }));
    expect(open).toHaveBeenCalledWith('blob:test', '_blank', 'noopener,noreferrer');
    fireEvent.click(views[1]);
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://drive.google.com/file/d/abc', '_blank', 'noopener,noreferrer'));
    expect(open.mock.calls.some(([u]) => String(u).includes('/uploads/'))).toBe(false);
  });
});
