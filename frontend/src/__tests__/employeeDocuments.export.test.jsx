/**
 * Employee Documents → "Export filtered".
 *
 * Replaces the Document Expiry CSV card that sat on Employee Reports. The file
 * must hold exactly the rows the table shows under the current filters, with
 * Aadhaar numbers masked and formula-looking cells quoted — the same rules as
 * the All Employees export (features/employees/csvExport.js).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const authState = vi.hoisted(() => ({ canManage: true }));
vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 3, employee_id: 3, name: 'HR Admin', company_id: 1 },
    hasPermission: () => authState.canManage,
  }),
}));

import api from '../services/api/client';
import EmployeeDocuments, {
  DOCUMENT_EXPORT_HEADERS, documentExportRows,
} from '../features/hr/pages/EmployeeDocuments.jsx';

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const DOCS = [
  { id: 1, document_name: 'Aadhar Card 2345 6789 0123', document_type: 'Aadhar Card', status: 'verified',
    expiry_date: day(-10), uploaded_at: '2026-01-05', employee_name: '=HYPERLINK("http://evil","x")',
    employee_code: 'EMP001', employee_department: 'HR', file_url: '/f/1' },
  { id: 2, document_name: 'Passport', document_type: 'Passport', status: 'pending',
    expiry_date: day(200), uploaded_at: '2026-02-01', employee_name: 'Priya Nair',
    employee_code: 'EMP002', employee_department: 'Finance', notes: 'secret note' },
  { id: 3, document_name: '@SUM(1+1)', document_type: 'Other', status: 'rejected',
    expiry_date: null, uploaded_at: '2026-03-01', employee_name: 'Arun Kumar',
    employee_code: 'EMP003', employee_department: 'Engineering' },
];

let captured;   // { text, filename }

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  authState.canManage = true;
  captured = null;
  api.get.mockImplementation((url) => {
    if (url === '/employees') return Promise.resolve({ data: [] });
    if (url === '/self-service/documents') return Promise.resolve({ data: DOCS });
    return Promise.resolve({ data: [] });
  });
  let blob;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b; return 'blob:test'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    captured = { blob, filename: this.download };
  });
});

afterEach(() => vi.restoreAllMocks());

async function exportedText() {
  await waitFor(() => expect(captured).not.toBeNull());
  return (await captured.blob.text()).replace(/^\uFEFF/, '');
}

async function renderLoaded() {
  render(<EmployeeDocuments setPage={() => {}} />);
  await waitFor(() => expect(screen.getByText('Passport')).toBeDefined());
}

describe('Export filtered — only the rows on screen', () => {
  it('with the "expired" filter, exports exactly the one expired document', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('1 expired'));
    const btn = screen.getByRole('button', { name: /Export filtered \(1\)/ });
    fireEvent.click(btn);
    const text = await exportedText();
    const lines = text.split('\r\n');
    expect(lines).toHaveLength(2);                       // header + 1 row
    expect(lines[0]).toBe(DOCUMENT_EXPORT_HEADERS.map(h => `"${h}"`).join(','));
    expect(text).toContain('"EMP001"');
    expect(text).not.toContain('Passport');
    expect(text).not.toContain('EMP003');
    expect(captured.filename).toMatch(/^employee-documents-filtered-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('with no filter, exports every listed document and names the file "all"', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Export filtered \(3\)/ }));
    const text = await exportedText();
    expect(text.split('\r\n')).toHaveLength(4);
    expect(captured.filename).toMatch(/^employee-documents-all-/);
  });

  it('never exports what the table does not show (notes, file links)', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Export filtered/ }));
    const text = await exportedText();
    expect(text).not.toContain('secret note');
    expect(text).not.toContain('/f/1');
  });
});

describe('sensitive data and formula injection', () => {
  it('masks an Aadhaar number typed into a document name', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Export filtered/ }));
    const text = await exportedText();
    expect(text).toContain('Aadhar Card ****0123');
    expect(text).not.toMatch(/2345\s?6789/);
  });

  it('quotes formula-looking cells so a spreadsheet will not execute them', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Export filtered/ }));
    const text = await exportedText();
    expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(text).toContain(`"'@SUM(1+1)"`);
    expect(text).not.toMatch(/(^|,)"=HYPERLINK/m);
  });

  it('documentExportRows computes Days Left and leaves it blank with no expiry', () => {
    const rows = documentExportRows([
      { name: 'a', type: 'Other', source: '—', expiry_date: day(5), status: 'pending' },
      { name: 'b', type: 'Other', source: '—', expiry_date: null,   status: 'verified' },
    ]);
    expect(rows[0][7]).toBeGreaterThanOrEqual(4);
    expect(rows[0][7]).toBeLessThanOrEqual(5);
    expect(rows[1][7]).toBe('');
    expect(rows[1][9]).toBe('Verified');
  });
});

describe('who sees it', () => {
  it('an employee viewing their own documents gets no export button', async () => {
    authState.canManage = false;
    await renderLoaded();
    expect(screen.queryByRole('button', { name: /Export filtered/ })).toBeNull();
  });
});
