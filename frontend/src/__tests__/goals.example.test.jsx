/**
 * Goals & KPIs (2026-11-11): a worked example for a super admin with no goals —
 * shown only on request, never saved — and the delete button, which used to
 * do nothing (its confirm dialog was never rendered).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/services/api/client', () => ({ default: api }));
const auth = vi.hoisted(() => ({ roles: ['super_admin'] }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ hasAnyRole: (...r) => r.some(x => auth.roles.includes(x)) }),
}));

import Goals from '@/features/performance/pages/Goals';

beforeEach(() => { Object.values(api).forEach(f => f.mockReset()); document.body.innerHTML = ''; auth.roles = ['super_admin']; });

describe('Goals & KPIs', () => {
  it('offers an example to someone with no goals, saves nothing, and prefills a goal from it', async () => {
    api.get.mockResolvedValue({ data: [] });
    render(<Goals />);
    fireEvent.click(await screen.findByRole('button', { name: /see an example/i }));
    expect(screen.getByText(/Example — not saved/)).toBeTruthy();
    expect(screen.getAllByText('Example')).toHaveLength(4);
    expect(screen.getByText('Deliver project milestones on time')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: /use as template/i })[0]);
    expect(screen.getByDisplayValue('Deliver project milestones on time')).toBeTruthy();
    expect(screen.getByDisplayValue('milestones')).toBeTruthy();
  });

  it('is not offered to an employee — they see only their own goals', async () => {
    auth.roles = ['employee'];
    api.get.mockResolvedValue({ data: [] });
    render(<Goals />);
    expect(await screen.findByText('No goals set yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /see an example/i })).toBeNull();
  });

  it('never shows the example next to real goals: for a super admin it replaces the list, and Hide brings it back', async () => {
    api.get.mockResolvedValue({ data: [{ id: 5, goal_title: 'My real KPI', target_value: 10, achieved_value: 5, status: 'active' }] });
    render(<Goals />);
    expect(await screen.findByText('My real KPI')).toBeTruthy();
    expect(screen.queryByText('Example')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /see an example/i }));
    expect(screen.getAllByText('Example')).toHaveLength(4);
    expect(screen.queryByText('My real KPI')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /hide example/i })[0]);
    expect(screen.getByText('My real KPI')).toBeTruthy();
  });

  it('an employee with goals gets no example button either', async () => {
    auth.roles = ['employee'];
    api.get.mockResolvedValue({ data: [{ id: 5, goal_title: 'My real KPI', target_value: 10, achieved_value: 5, status: 'active' }] });
    render(<Goals />);
    expect(await screen.findByText('My real KPI')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /see an example/i })).toBeNull();
  });

  // 2026-11-11: goals are set by the manager.
  const MEMBER = { id: 9, name: 'Divya', designation: 'Engineer' };
  const asManager = (goals) => api.get.mockImplementation(async (url, cfg) => {
    if (url === '/performance/my-team') return { data: [MEMBER] };
    if (url === '/performance/goals') return { data: cfg?.params?.employee_id === '9' ? goals : [] };
    return { data: [] };
  });

  it('an employee sees their goals with Check In only, and a note that the manager sets them', async () => {
    auth.roles = ['employee'];
    api.get.mockImplementation(async (url) => (url === '/performance/goals'
      ? { data: [{ id: 5, goal_title: 'My real KPI', target_value: 10, achieved_value: 5, status: 'active' }] }
      : { data: [] }));
    const { container } = render(<Goals />);
    expect(await screen.findByText('My real KPI')).toBeTruthy();
    expect(screen.getByText(/Your goals are set by your manager/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /check in/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add goal/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(container.querySelector('.gl-btn-del')).toBeNull();
  });

  it("a manager picks a team member, adds a goal for them, and can delete one after confirming", async () => {
    auth.roles = ['employee'];   // a team lead on the plain employee role
    asManager([{ id: 5, goal_title: 'Team KPI', target_value: 10, achieved_value: 5, status: 'active', employee_id: 9 }]);
    api.post.mockResolvedValue({ data: { id: 6 } });
    api.delete.mockResolvedValue({ data: { success: true } });
    const { container } = render(<Goals />);
    const viewing = await screen.findByLabelText('Viewing');
    await waitFor(() => expect(viewing.querySelectorAll('option')).toHaveLength(2));
    fireEvent.change(viewing, { target: { value: '9' } });
    expect(await screen.findByText('Team KPI')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /add goal/i }));
    expect(screen.getByLabelText('For team member *').value).toBe('9');
    fireEvent.change(screen.getByPlaceholderText(/Increase revenue/), { target: { value: 'Close 5 defects' } });
    fireEvent.click(screen.getByRole('button', { name: /create goal/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/performance/goals', expect.objectContaining({ goal_title: 'Close 5 defects', employee_id: '9' })));

    fireEvent.click(container.querySelector('.gl-btn-del'));
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/performance/goals/5'));
  });
});
