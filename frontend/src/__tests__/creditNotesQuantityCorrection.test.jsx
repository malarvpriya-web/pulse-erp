/**
 * Credit Notes — the quantity-correction reason (Phase 3H).
 *
 *  - 'Quantity Correction' is offered; choosing it asks for the original
 *    invoice and the quantity billed in error per shipped-goods line, and the
 *    note is sent as release lines (released_qty = quantity).
 *  - It cannot be sent without an invoice and a quantity.
 *  - A price reason sends no lines and releases nothing.
 *  - Cancel is offered only on drafts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../context/ToastContext', () => ({ useToast: () => toast }));
vi.mock('../context/FYContext', () => ({ useFY: () => ({ availableFYs: [], selectedFY: 'all' }) }));
vi.mock('../components/pulse-ui', () => ({
  PageShell: ({ dock, children }) => <div>{dock}{children}</div>,
  PageHero: ({ title, actions }) => <div><h1>{title}</h1>{actions}</div>,
}));

import api from '../services/api/client';
import CreditNotes from '../features/finance/pages/CreditNotes.jsx';

const NOTES = [
  { id: 1, credit_note_number: 'CN-2026-0001', status: 'draft', reason: 'price_revision', party_name: 'Acme', taxable_value: 10, total_amount: 10, credit_note_date: '2026-10-01' },
  { id: 2, credit_note_number: 'CN-2026-0002', status: 'issued', reason: 'sales_return', party_name: 'Acme', taxable_value: 10, total_amount: 10, credit_note_date: '2026-10-02' },
];
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  api.get.mockImplementation(async (url) => {
    if (url.startsWith('/finance/credit-notes')) return { data: { data: NOTES, total: 2 } };
    if (url === '/finance/invoices') return { data: [{ id: 70, invoice_number: 'INV0070', party_name: 'Acme' }] };
    if (url === '/finance/invoices/70') {
      return { data: { id: 70, items: [
        { id: 701, description: 'Panel', quantity: 10, pick_list_line_id: 55 },
        { id: 702, description: 'Installation', quantity: 1, pick_list_line_id: null },
      ] } };
    }
    return { data: {} };
  });
  api.post.mockResolvedValue({ data: { success: true, data: { id: 9 } } });
});

async function openForm() {
  render(<CreditNotes />);
  fireEvent.click(await screen.findByText('+ New Credit Note'));
  fireEvent.change(screen.getByPlaceholderText('Customer name'), { target: { value: 'Acme' } });
  fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '300' } });   // Taxable Value, the first amount field
}
const reasonSelect = () => screen.getByDisplayValue('Sales Return');

describe('quantity correction', () => {
  it('asks for the invoice and the quantity billed in error, and sends release lines', async () => {
    await openForm();
    fireEvent.change(reasonSelect(), { target: { value: 'quantity_correction' } });
    const inv = await screen.findByLabelText('Original invoice');
    await waitFor(() => expect(within(inv).getByText(/INV0070/)).toBeTruthy());
    fireEvent.change(inv, { target: { value: '70' } });
    const qty = await screen.findByLabelText('Quantity to correct, line 701');
    expect(screen.queryByLabelText('Quantity to correct, line 702')).toBeNull();    // no shipped goods, nothing to correct
    fireEvent.change(qty, { target: { value: '2' } });
    fireEvent.click(screen.getByText('Create Credit Note'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe('/finance/credit-notes');
    expect(body).toMatchObject({ reason: 'quantity_correction', original_invoice_id: 70,
                                 items: [{ original_item_id: 701, quantity: 2, released_qty: 2 }] });
  });

  it('is not sent without an invoice and a quantity', async () => {
    await openForm();
    fireEvent.change(reasonSelect(), { target: { value: 'quantity_correction' } });
    fireEvent.click(screen.getByText('Create Credit Note'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/original invoice/)));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a price reason sends no lines', async () => {
    await openForm();
    fireEvent.change(reasonSelect(), { target: { value: 'price_revision' } });
    expect(screen.queryByLabelText('Original invoice')).toBeNull();
    fireEvent.click(screen.getByText('Create Credit Note'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1].items).toBeUndefined();
  });

  it('offers Cancel on drafts and on issued notes not yet filed in GSTR-1 — never on a filed one', async () => {
    NOTES.push({ id: 3, credit_note_number: 'CN-2026-0003', status: 'issued', gstr1_filed: true, reason: 'price_revision',
                 party_name: 'Acme', taxable_value: 10, total_amount: 10, credit_note_date: '2026-10-03' });
    try {
      render(<CreditNotes />);
      await screen.findByText('CN-2026-0003');
      expect(screen.getAllByText('Cancel')).toHaveLength(2);             // the draft and the unfiled issued note
      expect(screen.getAllByText('Mark filed')).toHaveLength(1);         // the unfiled issued note only
      expect(screen.getByText('GSTR-1 filed')).toBeTruthy();
    } finally { NOTES.pop(); }
  });

  it('cancelling an issued note asks for a reason and sends it; no reason, no request', async () => {
    render(<CreditNotes />);
    await screen.findByText('CN-2026-0002');
    const row = screen.getByText('CN-2026-0002').closest('tr');
    const prompt = vi.spyOn(window, 'prompt');
    prompt.mockReturnValueOnce('');
    fireEvent.click(within(row).getByText('Cancel'));
    expect(api.post).not.toHaveBeenCalled();
    prompt.mockReturnValueOnce('raised in error');
    fireEvent.click(within(row).getByText('Cancel'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/finance/credit-notes/2/cancel', { reason: 'raised in error' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Credit note cancelled and its journal reversed'));
    prompt.mockRestore();
  });
});
