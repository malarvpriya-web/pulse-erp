import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// HR → Gate Pass & Visitors and Self Service → My Gate Passes
// (MODULE_FEATURE_CONNECTION_MANUAL.md §272). These pin the page side:
//   * every button follows the server's per-row flags (can_approve, can_mark_out…);
//   * reject / cancel / close need a reason; mark-out records the vehicle;
//   * person and material forms validate before posting, and post the goods;
//   * returnable goods are returned line by line;
//   * Print prints the pass that was clicked, with its goods;
//   * visitors: check-in validation, returning-visitor lookup, the server's refusal;
//   * My Gate Passes asks for the caller's own rows and offers no employee/host picker;
//   * §273: security approves visitor entry; goods leaving with a visitor.

const auth = vi.hoisted(() => ({ grants: new Set(['view', 'add', 'edit', 'export', 'approve']), security: false, employee_id: 5 }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: (m, a) => (m === 'gate_access' && auth.grants.has(a)) || (m === 'gate_security' && a === 'approve' && auth.security),
    role: 'hr', roles: ['hr'], user: { id: 1, employee_id: auth.employee_id },
  }),
}));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../services/api/client', () => ({ default: api }));

import GatePassVisitors from '../features/hr/pages/GatePassVisitors';
import MyGatePasses from '../features/hr/pages/MyGatePasses';

const EMPLOYEES = [{ id: 7, name: 'Asha Rao', emp_code: 'EMP007' }, { id: 9, name: 'Bala K', emp_code: 'EMP009' }];
const SUMMARY = { pending: 3, approved: 1, people_out: 2, goods_out: 4, overdue: 1, inside: 6, overstay: 1, expected_today: 2 };
const base = { can_edit: false, can_approve: false, can_reject: false, can_cancel: false, can_mark_out: false, can_mark_in: false, can_return: false, can_close: false, can_print: false };
const PENDING = {
  ...base, id: 42, pass_number: 'GP-2026-00042', pass_type: 'person', category: 'official', employee_id: 9, employee_name: 'Bala K',
  purpose: 'Bank', valid_from: '2026-11-12T04:00:00Z', valid_to: '2026-11-12T06:00:00Z', effective_status: 'pending',
  awaiting: { kind: 'department_head', name: 'Hema Iyer', label: 'Department head' }, can_approve: true, can_reject: true,
};
const APPROVED = { ...PENDING, id: 43, pass_number: 'GP-2026-00043', effective_status: 'approved', awaiting: null, can_approve: false, can_reject: false, can_mark_out: true, can_cancel: true, can_print: true };
const LOCKED = { ...PENDING, id: 44, pass_number: 'GP-2026-00044', can_approve: false, can_reject: false };
const GOODS = {
  ...base, id: 61, pass_number: 'MGP-2026-00001', pass_type: 'material', returnable: true, employee_id: 7, employee_name: 'Asha Rao',
  purpose: 'Repair', destination: 'Vendor, Chennai', effective_status: 'out', out_at: '2026-11-12T05:00:00Z', expected_return_at: '2026-11-14T05:00:00Z',
  items_count: 2, qty_total: 3, qty_returned: 0, can_return: true, can_close: true, can_print: true,
};
const GOODS_DETAIL = {
  ...GOODS, items: [
    { id: 1, line_no: 1, description: 'Motor 5HP', quantity: 1, unit: 'Nos', returned_quantity: 0 },
    { id: 2, line_no: 2, description: 'Cable', quantity: 2, unit: 'm', returned_quantity: 0 },
  ],
  events: [{ id: 1, action: 'created', created_at: '2026-11-12T04:00:00Z', actor_name: 'Asha Rao' }, { id: 2, action: 'out', created_at: '2026-11-12T05:00:00Z', actor_name: 'Gate' }],
};
const INSIDE = { id: 51, name: 'Ravi', company: 'Acme', phone: '9840013601', host_name: 'Asha Rao', check_in_time: '2026-11-12T04:00:00Z', effective_status: 'inside', can_check_out: true, can_badge: true, can_edit: true };
const EXPECTED = { id: 52, name: 'Meena', expected_at: '2026-11-12T09:00:00Z', check_in_time: null, effective_status: 'approved', approved_at: '2026-11-12T03:00:00Z', pass_number: 'VP-2026-00001', can_check_in: true, can_cancel: true, can_edit: true };
const WAITING = { id: 53, name: 'Kumar', company: 'Volt', host_employee_id: 7, host_name: 'Asha Rao', expected_at: '2026-11-12T09:00:00Z', check_in_time: null, effective_status: 'pending_approval', can_approve: true, can_reject: true, can_approve_check_in: true, can_cancel: true, can_edit: true };
const WITH_GOODS = { ...INSIDE, id: 54, name: 'Suresh', host_employee_id: 7, can_goods: true, can_check_out: false, checkout_blocked: 'A goods pass for this visitor is still open — release or cancel it first.' };

const lastGet = (url) => [...api.get.mock.calls].reverse().find(([u]) => u === url);

function serve({ passes = [PENDING, APPROVED, LOCKED], goods = [GOODS], visitors = [INSIDE, EXPECTED] } = {}) {
  api.get.mockImplementation((url, cfg) => {
    const p = cfg?.params || {};
    if (url === '/gate-access/summary') return Promise.resolve({ data: SUMMARY });
    if (url === '/biometric/employees/options') return Promise.resolve({ data: EMPLOYEES });
    if (url === '/gate-passes') {
      let rows = p.pass_type === 'material' ? goods : passes;
      if (p.status) rows = rows.filter(r => r.effective_status === p.status);
      return Promise.resolve({ data: { rows, total: rows.length, page: 1, page_size: 25, counts: { pending: 2, approved: 1 }, scope: p.scope } });
    }
    if (url === '/gate-passes/61') return Promise.resolve({ data: GOODS_DETAIL });
    if (url === '/gate-passes/export') return Promise.resolve({ data: new Blob(['a,b']), headers: { 'content-disposition': 'attachment; filename="gate-passes.csv"' } });
    if (url === '/visitors') return Promise.resolve({ data: { rows: visitors, total: visitors.length, page: 1, page_size: 25, counts: { inside: 1, expected: 1 }, inside_total: 1 } });
    if (url === '/visitors/lookup') return Promise.resolve({ data: { found: true, name: 'Ravi Kumar', company: 'Acme', visits: 3, last_visit_at: '2026-10-01T04:00:00Z', id_type: 'PAN', id_number_on_file: 'XXXXXX234F' } });
    return Promise.resolve({ data: [] });
  });
}

const renderAt = (Page, path = '/GatePassVisitors') => render(<MemoryRouter initialEntries={[path]}><Page setPage={vi.fn()} /></MemoryRouter>);

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.grants = new Set(['view', 'add', 'edit', 'export', 'approve']);
  auth.employee_id = 5;
  auth.security = false;
  serve();
  api.put.mockResolvedValue({ data: {} });
});

describe('the gate register', () => {
  it('shows the server\'s live summary, and asks for person passes on the first tab', async () => {
    renderAt(GatePassVisitors);
    const tiles = await screen.findByTestId('gate-summary');
    await waitFor(() => expect(within(tiles).getByText('4')).toBeTruthy());
    expect(within(tiles).getByText('1 since an earlier day')).toBeTruthy();
    await waitFor(() => expect(lastGet('/gate-passes')?.[1]?.params).toMatchObject({ scope: 'all', pass_type: 'person' }));
  });

  it('buttons follow the server\'s per-row flags', async () => {
    renderAt(GatePassVisitors);
    const table = await screen.findByTestId('pass-table');
    await within(table).findByText('GP-2026-00042');
    const row = (n) => within(table).getByText(n).closest('tr');
    expect(within(row('GP-2026-00042')).getByText('Approve')).toBeTruthy();
    expect(within(row('GP-2026-00042')).getByText('Awaiting Hema Iyer (Department head)', { exact: false })).toBeTruthy();
    expect(within(row('GP-2026-00044')).queryByText('Approve')).toBeNull();
    expect(within(row('GP-2026-00043')).getByText('Mark out')).toBeTruthy();
    expect(within(row('GP-2026-00043')).queryByText('Approve')).toBeNull();

    fireEvent.click(within(row('GP-2026-00042')).getByText('Approve'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/gate-passes/42/approve', {}));
  });

  it('reject needs a reason and sends it to the cancel route', async () => {
    renderAt(GatePassVisitors);
    const table = await screen.findByTestId('pass-table');
    fireEvent.click(within(within(table).getByText('GP-2026-00042').closest('tr')).getByText('Reject'));
    const dialog = await screen.findByRole('dialog', { name: /Reject GP-2026-00042/ });
    const confirm = within(dialog).getByText('Reject pass');
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason *'), { target: { value: 'Busy day' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/gate-passes/42/cancel', { reason: 'Busy day' }));
  });

  it('a refused action shows the server\'s reason in the dialog', async () => {
    api.put.mockRejectedValueOnce({ response: { status: 409, data: { message: 'This pass starts at 12 Nov, 15:00; the gate can record it from 30 minutes before.' } } });
    renderAt(GatePassVisitors);
    const table = await screen.findByTestId('pass-table');
    fireEvent.click(within(within(table).getByText('GP-2026-00043').closest('tr')).getByText('Mark out'));
    const dialog = await screen.findByRole('dialog', { name: /Mark out GP-2026-00043/ });
    fireEvent.change(within(dialog).getByLabelText('Vehicle number'), { target: { value: 'tn01ab1234' } });
    fireEvent.click(within(dialog).getByText('Record exit now'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/gate-passes/43/out', { vehicle_number: 'TN01AB1234', note: '' }));
    expect(await within(dialog).findByText(/30 minutes before/)).toBeTruthy();
  });

  it('the status filter changes the dataset the server returns, and clears', async () => {
    renderAt(GatePassVisitors);
    const table = await screen.findByTestId('pass-table');
    await within(table).findByText('GP-2026-00043');
    fireEvent.change(within(screen.getByTestId('pass-filters')).getByLabelText('Status'), { target: { value: 'pending' } });
    await waitFor(() => expect(lastGet('/gate-passes')[1].params).toMatchObject({ status: 'pending' }));
    await waitFor(() => expect(within(table).queryByText('GP-2026-00043')).toBeNull());
    fireEvent.click(within(screen.getByTestId('pass-filters')).getByText('Clear filters'));
    await within(table).findByText('GP-2026-00043');
  });

  it('a person pass is validated before posting, then posted with the chosen employee', async () => {
    api.post.mockResolvedValueOnce({ data: { ...PENDING, id: 70, pass_number: 'GP-2026-00070' } });
    renderAt(GatePassVisitors);
    fireEvent.click(await screen.findByText('+ New gate pass'));
    const form = await screen.findByTestId('pass-form');
    fireEvent.click(within(form).getByText('Submit for approval'));
    expect(await within(form).findByText('Choose the type of pass.')).toBeTruthy();
    expect(within(form).getByText('Give the reason for the pass.')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText('Employee'), { target: { value: '9' } });
    fireEvent.change(within(form).getByLabelText('Type of pass *'), { target: { value: 'medical' } });
    fireEvent.change(within(form).getByLabelText('Reason *'), { target: { value: 'Clinic' } });
    fireEvent.click(within(form).getByText('Submit for approval'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/gate-passes', expect.objectContaining({
      pass_type: 'person', employee_id: '9', category: 'medical', purpose: 'Clinic',
    })));
    expect(await screen.findByText(/GP-2026-00070 submitted — Hema Iyer has been notified/)).toBeTruthy();
  });

  it('a material pass needs goods, a destination and a return date, and posts the items', async () => {
    api.post.mockResolvedValueOnce({ data: { ...GOODS, id: 80, pass_number: 'MGP-2026-00080', awaiting: { kind: 'hr' } } });
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=material');
    fireEvent.click(await screen.findByText('+ New material pass'));
    const form = await screen.findByTestId('pass-form');
    fireEvent.change(within(form).getByLabelText('Purpose *'), { target: { value: 'Rewinding' } });
    fireEvent.click(within(form).getByText('Submit for approval'));
    expect(await within(form).findByText('Say whether the goods are coming back.')).toBeTruthy();
    expect(within(form).getByText('Enter where the goods are going.')).toBeTruthy();
    expect(within(form).getByText('Add at least one item.')).toBeTruthy();

    fireEvent.change(within(form).getByLabelText('Goods *'), { target: { value: 'true' } });
    fireEvent.change(within(form).getByLabelText('Destination *'), { target: { value: 'Vendor, Chennai' } });
    fireEvent.change(within(form).getByLabelText('Goods due back *'), { target: { value: '2099-01-10T10:00' } });
    fireEvent.change(within(form).getByLabelText('Item 1 description'), { target: { value: 'Motor 5HP' } });
    fireEvent.change(within(form).getByLabelText('Item 1 quantity'), { target: { value: '2' } });
    fireEvent.click(within(form).getByText('+ Add item'));
    fireEvent.change(within(form).getByLabelText('Item 2 description'), { target: { value: 'Cable' } });
    fireEvent.change(within(form).getByLabelText('Item 2 quantity'), { target: { value: '12.5' } });
    fireEvent.change(within(form).getByLabelText('Item 2 unit'), { target: { value: 'm' } });
    fireEvent.click(within(form).getByText('Submit for approval'));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const body = api.post.mock.calls[0][1];
    expect(body).toMatchObject({ pass_type: 'material', returnable: true, destination: 'Vendor, Chennai', purpose: 'Rewinding' });
    expect(body.items).toEqual([
      expect.objectContaining({ description: 'Motor 5HP', quantity: 2, unit: 'Nos' }),
      expect.objectContaining({ description: 'Cable', quantity: 12.5, unit: 'm' }),
    ]);
    expect(body.expected_return_at).toMatch(/^2099-01-10T/);
  });

  it('returnable goods are returned line by line', async () => {
    api.put.mockResolvedValueOnce({ data: { ...GOODS, effective_status: 'completed' } });
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=material');
    const table = await screen.findByTestId('pass-table');
    fireEvent.click(within(within(table).getByText('MGP-2026-00001').closest('tr')).getByText('Record return'));
    const dialog = await screen.findByRole('dialog', { name: /Record returned goods/ });
    fireEvent.change(within(dialog).getByLabelText('Returned now: Motor 5HP'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByText('Record return'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/gate-passes/61/return', { items: [{ item_id: 1, quantity: 1 }], note: '' }));
    expect(await screen.findByText(/all goods back — completed/)).toBeTruthy();
  });

  it('Print opens THIS pass, with its goods, in its own window', async () => {
    const doc = { write: vi.fn(), close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue({ document: doc });
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=material');
    const table = await screen.findByTestId('pass-table');
    fireEvent.click(within(within(table).getByText('MGP-2026-00001').closest('tr')).getByText('Print'));
    await waitFor(() => expect(doc.write).toHaveBeenCalled());
    const html = doc.write.mock.calls[0][0];
    expect(html).toMatch(/MGP-2026-00001/);
    expect(html).toMatch(/Returnable \(RGP\)/);
    expect(html).toMatch(/Motor 5HP/);
    open.mockRestore();
  });

  it('the detail view shows the goods and the history', async () => {
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=material');
    const table = await screen.findByTestId('pass-table');
    fireEvent.click(within(table).getByText('MGP-2026-00001'));
    const history = await screen.findByTestId('history');
    expect(within(history).getByText('Requested')).toBeTruthy();
    expect(within(history).getByText('Went out')).toBeTruthy();
    expect(within(screen.getByTestId('detail-items')).getByText('Cable')).toBeTruthy();
  });

  it('Export CSV downloads the filtered register; without the grant there is no button', async () => {
    const url = vi.fn(() => 'blob:x'); URL.createObjectURL = url; URL.revokeObjectURL = vi.fn();
    renderAt(GatePassVisitors);
    fireEvent.click(await screen.findByText('Export CSV'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/gate-passes/export', { params: { pass_type: 'person' }, responseType: 'blob' }));
    cleanup();
    auth.grants = new Set(['view']);
    renderAt(GatePassVisitors);
    await screen.findByTestId('pass-table');
    expect(screen.queryByText('Export CSV')).toBeNull();
    expect(screen.queryByText('+ New gate pass')).toBeNull();
  });
});

describe('visitors at the gate', () => {
  it('a walk-in with a bad number never reaches the server; a returning visitor is filled in by phone', async () => {
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=visitors');
    fireEvent.click(await screen.findByText('+ Register walk-in'));
    const form = await screen.findByTestId('visitor-form');
    fireEvent.change(within(form).getByLabelText('Contact number'), { target: { value: '12ab' } });
    fireEvent.change(within(form).getByLabelText('Visitor name *'), { target: { value: 'X' } });
    fireEvent.click(within(form).getByText('Register for approval'));
    expect(await within(form).findByText(/valid contact number/)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText('Visitor name *'), { target: { value: '' } });
    fireEvent.change(within(form).getByLabelText('Contact number'), { target: { value: '98400 13601' } });
    fireEvent.blur(within(form).getByLabelText('Contact number'));
    await waitFor(() => expect(within(form).getByLabelText('Visitor name *').value).toBe('Ravi Kumar'));
    expect(within(form).getByTestId('returning').textContent).toMatch(/3 earlier visits/);
    expect(within(form).getByLabelText('ID number').getAttribute('placeholder')).toBe('On file: XXXXXX234F');
  });

  it('a repeated check-in shows the server\'s refusal', async () => {
    api.post.mockRejectedValueOnce({ response: { status: 409, data: { message: 'Ravi is already checked in with this contact number. Check them out first.' } } });
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=visitors');
    fireEvent.click(await screen.findByText('+ Register walk-in'));
    const form = await screen.findByTestId('visitor-form');
    fireEvent.change(within(form).getByLabelText('Visitor name *'), { target: { value: 'Ravi' } });
    fireEvent.change(within(form).getByLabelText('Contact number'), { target: { value: '9840013601' } });
    fireEvent.click(within(form).getByText('Register for approval'));
    expect(await within(form).findByText(/already checked in/)).toBeTruthy();
  });

  it('check-out and arrival call their routes; buttons follow the flags', async () => {
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=visitors');
    const table = await screen.findByTestId('visitor-table');
    const ravi = (await within(table).findByText('Ravi')).closest('tr');
    const meena = within(table).getByText('Meena').closest('tr');
    expect(within(ravi).queryByText('Check in')).toBeNull();
    expect(within(meena).queryByText('Check out')).toBeNull();
    fireEvent.click(within(ravi).getByText('Check out'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/visitors/51/checkout', {}));

    api.put.mockResolvedValueOnce({ data: { ...EXPECTED, name: 'Meena', host_name: 'Asha Rao' } });
    fireEvent.click(within(meena).getByText('Check in'));
    const form = await screen.findByTestId('visitor-form');
    fireEvent.change(within(form).getByLabelText('ID type'), { target: { value: 'Aadhaar' } });
    fireEvent.change(within(form).getByLabelText('ID number'), { target: { value: '1234 5678 9012' } });
    fireEvent.click(within(form).getByText('Check in now'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/visitors/52/check-in', expect.objectContaining({ id_type: 'Aadhaar', id_number: '1234 5678 9012' })));
    expect(await screen.findByText(/Meena checked in — Asha Rao has been notified/)).toBeTruthy();
  });
});

describe('security approves visitor entry (§273)', () => {
  it('security sees Approve / Refuse; refusing needs a reason', async () => {
    auth.security = true;
    serve({ visitors: [WAITING] });
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=visitors');
    const row = (await within(await screen.findByTestId('visitor-table')).findByText('Kumar')).closest('tr');
    expect(within(row).getByText('Awaiting security')).toBeTruthy();
    fireEvent.click(within(row).getByText('Approve entry'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/visitors/53/approve', {}));
    fireEvent.click(within(row).getByText('Refuse'));
    const dialog = await screen.findByRole('dialog', { name: /Refuse entry to Kumar/ });
    expect(within(dialog).getByText('Refuse entry').disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason *'), { target: { value: 'No appointment' } });
    fireEvent.click(within(dialog).getByText('Refuse entry'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/visitors/53/reject', { reason: 'No appointment' }));
  });

  it("the server's flags decide: a row without can_approve shows no Approve and no check-in", async () => {
    serve({ visitors: [{ ...WAITING, can_approve: false, can_reject: false, can_approve_check_in: false }] });
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=visitors');
    const row = (await within(await screen.findByTestId('visitor-table')).findByText('Kumar')).closest('tr');
    expect(within(row).queryByText('Approve entry')).toBeNull();
    expect(within(row).queryByText(/check in/i)).toBeNull();
  });

  it('a walk-in is registered for approval; security can approve and check in at once', async () => {
    api.post.mockResolvedValue({ data: { ...WAITING, id: 60, name: 'Walk' } });
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=visitors');
    fireEvent.click(await screen.findByText('+ Register walk-in'));
    let form = await screen.findByTestId('visitor-form');
    expect(within(form).queryByLabelText(/Approve entry and check in now/)).toBeNull();
    fireEvent.change(within(form).getByLabelText('Visitor name *'), { target: { value: 'Walk' } });
    fireEvent.click(within(form).getByText('Register for approval'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1].approve_and_check_in).toBeUndefined();
    expect(await screen.findByText(/waiting for security to approve entry/)).toBeTruthy();

    cleanup(); auth.security = true;
    api.post.mockResolvedValueOnce({ data: { ...INSIDE, id: 61, name: 'Fast', pass_number: 'VP-2026-00009' } });
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=visitors');
    fireEvent.click(await screen.findByText('+ Register walk-in'));
    form = await screen.findByTestId('visitor-form');
    expect(within(form).getByLabelText(/Approve entry and check in now/).checked).toBe(true);
    fireEvent.change(within(form).getByLabelText('Visitor name *'), { target: { value: 'Fast' } });
    fireEvent.click(within(form).getByText('Approve & check in'));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/visitors', expect.objectContaining({ name: 'Fast', approve_and_check_in: true })));
    expect(await screen.findByText(/Fast checked in — pass VP-2026-00009/)).toBeTruthy();
  });

  it('goods out: the form names the visitor and posts visitor_id; check-out waits for the goods', async () => {
    api.post.mockResolvedValueOnce({ data: { ...GOODS, id: 71, pass_number: 'MGP-2026-00071', effective_status: 'approved' } });
    serve({ visitors: [WITH_GOODS] });
    renderAt(GatePassVisitors, '/GatePassVisitors?tab=visitors');
    const row = (await within(await screen.findByTestId('visitor-table')).findByText('Suresh')).closest('tr');
    expect(within(row).queryByText('Check out')).toBeNull();
    expect(within(row).getByText('Goods pass open')).toBeTruthy();
    fireEvent.click(within(row).getByText('Goods out'));
    const form = await screen.findByTestId('pass-form');
    expect(within(form).getByTestId('pf-visitor').textContent).toMatch(/Suresh/);
    expect(within(form).queryByLabelText('Responsible employee')).toBeNull();
    expect(within(form).getByLabelText('Carried by').value).toBe('Suresh (Acme)');
    fireEvent.change(within(form).getByLabelText('Purpose *'), { target: { value: 'Returned relay' } });
    fireEvent.change(within(form).getByLabelText('Goods *'), { target: { value: 'false' } });
    fireEvent.change(within(form).getByLabelText('Item 1 description'), { target: { value: 'Relay' } });
    fireEvent.change(within(form).getByLabelText('Item 1 quantity'), { target: { value: '4' } });
    fireEvent.click(within(form).getByText('Submit for approval'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/gate-passes',
      expect.objectContaining({ visitor_id: 54, pass_type: 'material', returnable: false, destination: 'Acme' })));
    expect(await screen.findByText(/MGP-2026-00071 approved — security releases the goods/)).toBeTruthy();
  });
});

describe('My Gate Passes', () => {
  it('asks for the caller\'s own passes and offers no employee picker', async () => {
    auth.grants = new Set();
    api.post.mockResolvedValueOnce({ data: { ...PENDING, id: 90, pass_number: 'GP-2026-00090' } });
    renderAt(MyGatePasses, '/MyGatePasses');
    await screen.findByTestId('pass-table');
    expect(lastGet('/gate-passes')[1].params).toMatchObject({ scope: 'mine' });
    expect(lastGet('/gate-passes')[1].params.pass_type).toBeUndefined();
    fireEvent.click(screen.getByText('+ Request gate pass'));
    const form = await screen.findByTestId('pass-form');
    expect(within(form).queryByLabelText('Employee')).toBeNull();
    fireEvent.change(within(form).getByLabelText('Type of pass *'), { target: { value: 'personal' } });
    fireEvent.change(within(form).getByLabelText('Reason *'), { target: { value: 'Bank' } });
    fireEvent.click(within(form).getByText('Submit for approval'));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].employee_id).toBeUndefined();
    expect(screen.queryByText('Export CSV')).toBeNull();
  });

  it('pre-registers the caller\'s own visitor, with no host picker', async () => {
    auth.grants = new Set();
    api.post.mockResolvedValueOnce({ data: { ...EXPECTED, id: 91, name: 'Kiran' } });
    renderAt(MyGatePasses, '/MyGatePasses?tab=visitors');
    await screen.findByTestId('visitor-table');
    expect(lastGet('/visitors')[1].params).toMatchObject({ scope: 'mine' });
    expect(screen.queryByText('+ Register walk-in')).toBeNull();
    fireEvent.click(screen.getByText('+ Pre-register visitor'));
    const form = await screen.findByTestId('visitor-form');
    expect(within(form).queryByLabelText(/Host employee/)).toBeNull();
    fireEvent.change(within(form).getByLabelText('Visitor name *'), { target: { value: 'Kiran' } });
    fireEvent.click(within(form).getByText('Pre-register'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/visitors', expect.objectContaining({ name: 'Kiran', pre_register: true })));
    expect(api.post.mock.calls[0][1].host_employee_id).toBeUndefined();
    expect(await screen.findByText('Kiran pre-registered')).toBeTruthy();
  });

  it('a login with no employee record is told so, and nothing is loaded', async () => {
    auth.employee_id = null;
    renderAt(MyGatePasses, '/MyGatePasses');
    expect(await screen.findByText(/not linked to an employee record/)).toBeTruthy();
    expect(api.get).not.toHaveBeenCalledWith('/gate-passes', expect.anything());
  });
});
