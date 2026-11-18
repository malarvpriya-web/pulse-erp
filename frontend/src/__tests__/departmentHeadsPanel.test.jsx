/**
 * Department Heads panel — its own page, HR › Department Heads (was inside Probation).
 *
 *  - Editors (hr:edit) can assign, change (reason required) and remove (reason
 *    required); viewers see the list and history but no controls.
 *  - A 403 from the server shows an access message, never a table.
 *  - The head picker offers exactly the server's eligible list.
 *  - The page is its own row in the HR menu group gated on module 'hr' — the
 *    permission the department_head role does not hold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
// The grants the signed-in user holds, swapped per test.
const auth = vi.hoisted(() => ({ grants: new Set() }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }),
}));

import api from '../services/api/client';
import DepartmentHeadsPanel from '../features/hr/components/DepartmentHeadsPanel.jsx';
import { NAV_ITEMS } from '../config/routes';

const LIST = {
  departments: [
    { department_id: 1, department: 'Engineering', employee_count: 5, head: null },
    {
      department_id: 3, department: 'Finance', employee_count: 6,
      head: { assignment_id: 9, assigned_at: '2026-10-01T05:00:00Z', employee_id: 21, office_id: 'EMP021', name: 'Asha Rao', is_current: true, has_login: true },
    },
    {
      department_id: 4, department: 'Sales', employee_count: 2,
      head: { assignment_id: 10, assigned_at: '2026-09-01T05:00:00Z', employee_id: 30, office_id: 'EMP030', name: 'Gone Person', is_current: false, has_login: true },
    },
  ],
  eligible_heads: [
    { employee_id: 21, office_id: 'EMP021', name: 'Asha Rao', department: 'Finance' },
    { employee_id: 22, office_id: 'EMP022', name: 'Ravi Kumar', department: 'Engineering' },
  ],
};
const HISTORY = {
  department_id: 3, department: 'Finance',
  history: [
    { assignment_id: 9, head_name: 'Asha Rao', assigned_at: '2026-10-01T05:00:00Z', assigned_by: 'Zz hr', ended_at: null },
    { assignment_id: 7, head_name: 'Old Head', assigned_at: '2026-06-01T05:00:00Z', assigned_by: 'Zz hr', ended_at: '2026-10-01T05:00:00Z', ended_by: 'Zz hr', end_reason: 'Moved on' },
  ],
};

function mockApi({ listStatus = 200 } = {}) {
  api.get.mockImplementation(async (url) => {
    if (url === '/department-heads') {
      if (listStatus !== 200) { const e = new Error('x'); e.response = { status: listStatus, data: { error: 'Forbidden' } }; throw e; }
      return { data: LIST };
    }
    if (url === '/department-heads/3/history') return { data: HISTORY };
    return { data: {} };
  });
  api.put.mockResolvedValue({ data: { changed: true } });
  api.delete.mockResolvedValue({ data: { ended: true } });
}

const renderAs = (canEdit) => {
  auth.grants = new Set(canEdit ? ['hr:view', 'hr:edit'] : ['hr:view']);
  return render(<DepartmentHeadsPanel />);
};
const row = (name) => document.querySelector(`tr[data-department="${name}"]`);

beforeEach(() => { vi.clearAllMocks(); cleanup(); });

describe('editors (hr:edit)', () => {
  it('lists departments with their heads and flags a head who is no longer active', async () => {
    mockApi();
    renderAs(true);
    await screen.findByText('Engineering');
    expect(within(row('Engineering')).getByText('Not assigned')).toBeTruthy();
    expect(within(row('Finance')).getByText(/Asha Rao/)).toBeTruthy();
    expect(within(row('Sales')).getByText('No longer active')).toBeTruthy();
  });

  it('assigns a head from the eligible list only', async () => {
    mockApi();
    renderAs(true);
    await screen.findByText('Engineering');
    fireEvent.click(within(row('Engineering')).getByRole('button', { name: 'Assign' }));
    const select = screen.getByLabelText('Head for Engineering');
    expect([...select.options].map((o) => o.value).filter(Boolean)).toEqual(['21', '22']);
    fireEvent.change(select, { target: { value: '22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put).toHaveBeenCalledWith('/department-heads/1', { head_employee_id: 22 });
  });

  it('changing an existing head requires a reason before anything is sent', async () => {
    mockApi();
    renderAs(true);
    await screen.findByText('Finance');
    fireEvent.click(within(row('Finance')).getByRole('button', { name: 'Change' }));
    fireEvent.change(screen.getByLabelText('Head for Finance'), { target: { value: '22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A reason is required to change the head.')).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Reason for Finance'), { target: { value: 'Promoted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/department-heads/3', { head_employee_id: 22, reason: 'Promoted' }));
  });

  it('removing a head requires a reason and sends it', async () => {
    mockApi();
    renderAs(true);
    await screen.findByText('Finance');
    fireEvent.click(within(row('Finance')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove head' }));
    expect(await screen.findByText('A reason is required to remove a head.')).toBeTruthy();
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason for Finance'), { target: { value: 'Restructure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove head' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/department-heads/3', { data: { reason: 'Restructure' } }));
  });

  it('shows the assignment history, including who ended a head and why', async () => {
    mockApi();
    renderAs(true);
    await screen.findByText('Finance');
    fireEvent.click(screen.getByRole('button', { name: 'History for Finance' }));
    const list = await screen.findByRole('list', { name: 'Assignment history for Finance' });
    expect(list.textContent).toMatch(/Asha Rao.*current/);
    expect(list.textContent).toMatch(/Old Head.*by Zz hr.*Moved on/);
  });
});

describe('viewers and refused callers', () => {
  it('a viewer (no hr:edit) sees the list and history but no controls', async () => {
    mockApi();
    renderAs(false);
    await screen.findByText('Finance');
    expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.getByRole('button', { name: 'History for Finance' })).toBeTruthy();
  });

  it('an unexpected payload is a load error, not a crash', async () => {
    api.get.mockResolvedValue({ data: [] });
    renderAs(true);
    expect(await screen.findByText('Could not load department heads.')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
  });

  it('a 403 from the server shows an access message and no table', async () => {
    mockApi({ listStatus: 403 });
    renderAs(true);
    expect(await screen.findByText('You do not have access to department heads.')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
  });
});

describe('placement', () => {
  it('has exactly one menu row, in the HR group (module hr), and is no longer on Probation', () => {
    const all = NAV_ITEMS.flatMap((g) => (g.submenu || []).map((s) => ({ ...s, group: g })));
    const rows = all.filter((i) => i.page === 'DepartmentHeads');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Department Heads');
    expect(rows[0].group.module).toBe('hr');
    expect(rows[0].inHub).toBeUndefined();
  });
});

describe('a department retired in Master Data', () => {
  it('is flagged, offers no Assign/Change, and keeps Remove and History', async () => {
    api.get.mockImplementation(async (url) => (url === '/department-heads'
      ? { data: { ...LIST, departments: [...LIST.departments, {
          department_id: 9, department: 'Old Unit', department_active: false, employee_count: 0,
          head: { assignment_id: 11, assigned_at: '2026-08-01T05:00:00Z', employee_id: 21, office_id: 'EMP021', name: 'Asha Rao', is_current: true, has_login: true },
        }] } }
      : { data: {} }));
    renderAs(true);
    const row = await waitFor(() => {
      const r = document.querySelector('tr[data-department="Old Unit"]');
      if (!r) throw new Error('not yet');
      return r;
    });
    expect(row.textContent).toMatch(/Retired in Master Data/);
    expect(within(row).queryByRole('button', { name: 'Change' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Assign' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'History for Old Unit' })).toBeTruthy();
    // an active department still offers Change
    expect(within(document.querySelector('tr[data-department="Finance"]')).getByRole('button', { name: 'Change' })).toBeTruthy();
  });
});
