/**
 * Returns & RMA screen — speaks the API's actual contract (Phase 3F).
 *
 *  - Raising sends lines (item + quantity, or one line per serial) chosen from
 *    what the order can still return; more than returnable is stopped on the
 *    screen; a server refusal is shown and nothing claims success.
 *  - Receiving sends every line with an explicit disposition and QC result;
 *    missing ones are stopped on the screen; restock is not offered for a
 *    serialised unit; a warehouse is sent only for a restock.
 *  - Closing sends only credit_note_id (never a disposition) and shows the
 *    server's refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../context/ToastContext', () => ({ useToast: () => toast }));
vi.mock('../components/pulse-ui', () => ({
  PageShell: ({ dock, children }) => <div>{dock}{children}</div>,
  PageHero: ({ title }) => <h1>{title}</h1>,
}));

import api from '../services/api/client';
import ReturnsRMA from '../features/inventory/pages/ReturnsRMA.jsx';

const ORDERS = [{ id: 7, order_number: 'SO-7', customer_name: 'Acme' }];
const ELIGIBLE = {
  sales_order_id: 7,
  items: [
    { item_id: 11, item_name: 'Pump', serial_tracked: false, shipped_qty: 10, restocked_qty: 2, open_requested_qty: 1,
      requestable_qty: 7, serials: [] },
    { item_id: 12, item_name: 'Drive', serial_tracked: true, shipped_qty: 2, restocked_qty: 0, open_requested_qty: 0,
      requestable_qty: 2, serials: [{ id: 501, serial_number: 'SN-501' }, { id: 502, serial_number: 'SN-502' }] },
  ],
  warehouses: [{ id: 3, name: 'Main' }, { id: 4, name: 'Annex' }],
};
const RETURNS = [
  { id: 41, rma_number: 'RMA-000041', sales_order_id: 7, order_number: 'SO-7', status: 'requested', quantity: 3,
    items: [
      { id: 901, item_id: 11, item_name: 'Pump', quantity: 2, serial_id: null },
      { id: 902, item_id: 12, item_name: 'Drive', quantity: 1, serial_id: 501, serial_number: 'SN-501' },
    ] },
  { id: 42, rma_number: 'RMA-000042', sales_order_id: 7, order_number: 'SO-7', status: 'received', quantity: 1, items: [] },
];

function mockApi() {
  api.get.mockImplementation(async (url) => {
    if (url === '/scm/returns') return { data: RETURNS };
    if (url === '/sales/orders') return { data: { orders: ORDERS } };
    if (url === '/scm/returns/eligible') return { data: ELIGIBLE };
    if (url === '/finance/credit-notes') {
      return { data: { data: [{ id: 61, credit_note_number: 'CN-61', original_invoice_number: 'INV-9', status: 'issued' },
                              { id: 62, credit_note_number: 'CN-62', status: 'cancelled' }] } };
    }
    return { data: {} };
  });
}
const refusal = (status, error, code) => Object.assign(new Error('x'), { response: { status, data: { error, code } } });

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockApi();
});

async function chooseOrder() {
  render(<ReturnsRMA />);
  const select = await screen.findByLabelText('Against order');
  await waitFor(() => expect(within(select).getByText('SO-7 — Acme')).toBeTruthy());
  fireEvent.change(select, { target: { value: '7' } });
  await screen.findByText('Pump');
}

describe('raising a return', () => {
  it('sends the chosen lines — a quantity per item, one line per serial', async () => {
    api.post.mockResolvedValue({ data: { id: 50, rma_number: 'RMA-000050' } });
    await chooseOrder();
    fireEvent.change(screen.getByLabelText('Quantity of Pump'), { target: { value: '3' } });
    fireEvent.click(screen.getByLabelText('SN-502'));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Damaged' } });
    fireEvent.click(screen.getByText('Raise return'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/scm/returns', {
      sales_order_id: 7, reason: 'Damaged',
      lines: [{ item_id: 11, quantity: 3 }, { item_id: 12, serial_id: 502, quantity: 1 }],
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Return RMA-000050 raised'));
  });

  it('stops more than is returnable on the screen, and sends nothing', async () => {
    await chooseOrder();
    fireEvent.change(screen.getByLabelText('Quantity of Pump'), { target: { value: '8' } });
    fireEvent.click(screen.getByText('Raise return'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/only 7 returnable/);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("shows the server's refusal and never claims success", async () => {
    api.post.mockRejectedValue(refusal(409, 'Only 1 of item 11 can still be returned', 'RETURN_EXCEEDS_SHIPPED'));
    await chooseOrder();
    fireEvent.change(screen.getByLabelText('Quantity of Pump'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Raise return'));
    expect((await screen.findByRole('alert')).textContent)
      .toBe('Only 1 of item 11 can still be returned (RETURN_EXCEEDS_SHIPPED)');
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('receiving a return', () => {
  async function openReceipt() {
    render(<ReturnsRMA />);
    fireEvent.click(await screen.findByText('Receive'));
    await screen.findByText('Receive RMA-000041');
  }

  it('refuses to send a line without a disposition or a QC result', async () => {
    await openReceipt();
    fireEvent.click(screen.getByText('Record receipt'));
    const alert = (await screen.findByRole('alert')).textContent;
    expect(alert).toMatch(/Pump: choose a disposition/);
    expect(alert).toMatch(/Drive: record the QC result/);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('does not offer restock for a serialised unit', async () => {
    await openReceipt();
    const serialDisposition = screen.getByLabelText('Disposition, line 902');
    expect(within(serialDisposition).getByText(/^Restock/).disabled).toBe(true);
    expect(within(screen.getByLabelText('Disposition, line 901')).getByText(/^Restock/).disabled).toBe(false);
  });

  it('sends every line explicitly — the warehouse only for a restock — and reports what came back', async () => {
    api.post.mockResolvedValue({ data: { status: 'received', restocked: [{ item_id: 11, qty: 2 }] } });
    await openReceipt();
    await waitFor(() => expect(within(screen.getByLabelText('Warehouse, line 901')).getByText('Annex')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Disposition, line 901'), { target: { value: 'restock' } });
    fireEvent.change(screen.getByLabelText('QC result, line 901'), { target: { value: 'pass' } });
    fireEvent.change(screen.getByLabelText('Warehouse, line 901'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Disposition, line 902'), { target: { value: 'scrap' } });
    fireEvent.change(screen.getByLabelText('QC result, line 902'), { target: { value: 'fail' } });
    fireEvent.change(screen.getByLabelText('Warehouse, line 902'), { target: { value: '3' } });   // disabled for scrap; not sent
    fireEvent.click(screen.getByText('Record receipt'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/scm/returns/41/receive', { lines: [
      { id: 901, received_qty: 2, disposition: 'restock', qc_result: 'pass', warehouse_id: 4 },
      { id: 902, received_qty: 1, disposition: 'scrap', qc_result: 'fail' },
    ] });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Received — 2 unit(s) back in stock'));
  });

  it("shows the server's refusal and keeps the form open", async () => {
    api.post.mockRejectedValue(refusal(409, 'Item 11 left from 2 warehouses; name the one it returns to', 'WAREHOUSE_REQUIRED'));
    await openReceipt();
    for (const [id, d, q] of [[901, 'restock', 'pass'], [902, 'scrap', 'fail']]) {
      fireEvent.change(screen.getByLabelText(`Disposition, line ${id}`), { target: { value: d } });
      fireEvent.change(screen.getByLabelText(`QC result, line ${id}`), { target: { value: q } });
    }
    fireEvent.click(screen.getByText('Record receipt'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/WAREHOUSE_REQUIRED/);
    expect(screen.getByText('Receive RMA-000041')).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('closing a return', () => {
  it('sends only the credit note — never a disposition — and offers no cancelled note', async () => {
    api.post.mockResolvedValue({ data: { id: 42, status: 'closed' } });
    render(<ReturnsRMA />);
    fireEvent.click(await screen.findByText('Close'));
    const select = await screen.findByLabelText('Credit note');
    await waitFor(() => expect(within(select).getByText(/CN-61/)).toBeTruthy());
    expect(within(select).queryByText(/CN-62/)).toBeNull();
    fireEvent.change(select, { target: { value: '61' } });
    fireEvent.click(screen.getByText('Close return'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/scm/returns/42/close', { credit_note_id: 61 }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Return RMA-000042 closed'));
  });

  it("shows the server's refusal", async () => {
    api.post.mockRejectedValue(refusal(422, "That credit note was raised against another order's invoice.", 'CREDIT_NOTE_ORDER_MISMATCH'));
    render(<ReturnsRMA />);
    fireEvent.click(await screen.findByText('Close'));
    fireEvent.click(await screen.findByText('Close return'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/CREDIT_NOTE_ORDER_MISMATCH/);
    expect(api.post).toHaveBeenCalledWith('/scm/returns/42/close', {});
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('Phase 3G: partial receipts, withdrawal, issued notes only', () => {
  const PARTIAL = { id: 43, rma_number: 'RMA-000043', sales_order_id: 7, status: 'partially_received', quantity: 3,
    items: [
      { id: 911, item_id: 11, item_name: 'Pump', quantity: 2, received_qty: 2, disposition: 'scrap' },
      { id: 912, item_id: 11, item_name: 'Pump spare', quantity: 1, received_qty: null },
    ] };
  const withRows = (rows) => api.get.mockImplementation(async (url) => {
    if (url === '/scm/returns') return { data: rows };
    if (url === '/sales/orders') return { data: { orders: ORDERS } };
    if (url === '/scm/returns/eligible') return { data: ELIGIBLE };
    if (url === '/finance/credit-notes') {
      return { data: { data: [{ id: 61, credit_note_number: 'CN-61', status: 'issued' },
                              { id: 63, credit_note_number: 'CN-63', status: 'draft' }] } };
    }
    return { data: {} };
  });

  it('a partly received return receives only the lines still to come, and cannot be closed yet', async () => {
    withRows([PARTIAL]);
    render(<ReturnsRMA />);
    fireEvent.click(await screen.findByText('Receive'));
    await screen.findByText('Receive RMA-000043');
    expect(screen.queryByLabelText('Disposition, line 911')).toBeNull();
    expect(screen.getByLabelText('Disposition, line 912')).toBeTruthy();
    expect(screen.queryByText('Close')).toBeNull();
    expect(screen.queryByText('Withdraw')).toBeNull();                 // something has already come back
  });

  it('withdraws a requested return with a reason, and shows a refusal', async () => {
    withRows(RETURNS);
    api.post.mockRejectedValueOnce(refusal(403, 'Forbidden', undefined));
    render(<ReturnsRMA />);
    fireEvent.click(await screen.findByText('Withdraw'));
    fireEvent.click(await screen.findByText('Withdraw return'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/reason/);
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Withdrawal reason'), { target: { value: 'Customer kept the goods' } });
    fireEvent.click(screen.getByText('Withdraw return'));
    expect((await screen.findByRole('alert')).textContent).toBe('Forbidden');
    expect(toast.success).not.toHaveBeenCalled();
    api.post.mockResolvedValueOnce({ data: { id: 41, status: 'closed' } });
    fireEvent.click(screen.getByText('Withdraw return'));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/scm/returns/41/withdraw', { reason: 'Customer kept the goods' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Return RMA-000041 withdrawn'));
  });

  it('offers only issued credit notes at close', async () => {
    withRows(RETURNS);
    render(<ReturnsRMA />);
    fireEvent.click(await screen.findByText('Close'));
    const select = await screen.findByLabelText('Credit note');
    await waitFor(() => expect(within(select).getByText(/CN-61/)).toBeTruthy());
    expect(within(select).queryByText(/CN-63/)).toBeNull();
  });
});
