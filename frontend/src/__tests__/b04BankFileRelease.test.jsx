/**
 * PC-02b-0 B-04 on Payment Batches (manual §237).
 *
 *   An approved batch offers Release Bank File, not Process; a released one offers
 *   Process and the download of the stored file, with no format to choose. A role
 *   without finance approval sees neither. A refused release shows each reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock('../features/finance/pages/PDCManagement', () => ({ default: () => null }));
import api from '../services/api/client';
import PaymentBatch from '../features/finance/pages/PaymentBatch';

const FILE = { format: 'sbi', file_name: 'batch-PB1-sbi.csv', sha256: 'a'.repeat(64), line_count: 1, total_amount: '100.00' };
const batchOf = (over = {}) => ({
  id: 7, batch_number: 'PB1', status: 'approved', total_amount: '100.00', batch_date: new Date().toISOString().slice(0, 10), payment_count: 1, ...over,
});

function renderPage(batch, role = 'finance_manager') {
  localStorage.setItem('role', role);
  api.get.mockImplementation((url) => {
    if (url === '/finance/payment-batches') return Promise.resolve({ data: [batch] });
    if (url.endsWith('/bank-file')) return Promise.resolve({ data: new Blob(['stored']) });
    return Promise.resolve({ data: [] });
  });
  render(<PaymentBatch />);
  return screen.findByText('PB1');
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('Payment Batches bank file', () => {
  it('an approved batch without a file offers release only, and sends the chosen format', async () => {
    await renderPage(batchOf());
    expect(screen.queryByRole('button', { name: /^Process$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Bank File$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Release Bank File/ }));
    fireEvent.click(screen.getByRole('button', { name: 'SBI' }));
    api.post.mockResolvedValueOnce({ data: FILE });
    fireEvent.click(screen.getByRole('button', { name: 'Release file' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/finance/payment-batches/7/release', { format: 'sbi' }));
  });

  it('a refused release keeps the dialog open and shows each line\'s reason', async () => {
    await renderPage(batchOf());
    fireEvent.click(screen.getByRole('button', { name: /Release Bank File/ }));
    api.post.mockRejectedValueOnce({ response: { data: {
      error: 'Release refused: 1 line(s) cannot be paid from verified bank details',
      problems: [{ item_id: 1, supplier: 'Acme', reason: 'No Finance-verified bank detail in this company' }],
    } } });
    fireEvent.click(screen.getByRole('button', { name: 'Release file' }));
    expect(await screen.findByText(/Acme: No Finance-verified bank detail/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Release file' })).toBeTruthy();
  });

  it('a released batch offers Process and the stored file, with no format parameter', async () => {
    await renderPage(batchOf({ bank_file: FILE }));
    expect(screen.getByRole('button', { name: /^Process$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Release Bank File/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Bank File$/ }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/finance/payment-batches/7/bank-file', { responseType: 'blob' }));
  });

  it('a role without finance approval sees neither release nor download', async () => {
    await renderPage(batchOf({ status: 'processed', bank_file: FILE }), 'accounts_exec');
    expect(screen.queryByRole('button', { name: /Bank File/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Advice/ })).toBeTruthy();
  });
});
