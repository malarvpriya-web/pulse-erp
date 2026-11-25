/**
 * Joining letters card (owner 18 Nov 26): letters are issued at onboarding and
 * filed on the employee record; non-HR sees a note instead of buttons.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(() => Promise.resolve({ data: {} })) }));
vi.mock('@/services/api/client', () => ({ default: api }));
const { default: JoiningLetters } = await import('../features/recruitment/shared/components/JoiningLetters');
afterEach(() => { cleanup(); api.get.mockReset(); api.post.mockClear(); });

const LETTERS = {
  employee_id: 7, employee_code: 'EMP007', name: 'Asha',
  letters: [
    { type: 'offer', label: 'Offer Letter', file_url: null, source: null, can_issue: false, blocked_reason: 'No accepted offer in Recruitment', times_issued: 0 },
    { type: 'appointment', label: 'Appointment Letter', file_url: '/uploads/a.pdf', source: 'issued', last_issued_at: '2026-11-18T04:00:00Z', last_issued_by: 'Hema', can_issue: true, times_issued: 2 },
    { type: 'confidentiality', label: 'Confidentiality Letter', file_url: null, source: null, can_issue: true, times_issued: 0 },
  ],
};

describe('JoiningLetters', () => {
  it('shows each letter, blocks the offer letter without an accepted offer, and issues', async () => {
    api.get.mockResolvedValue({ data: LETTERS });
    const toast = vi.fn();
    render(<JoiningLetters employeeId={7} onToast={toast} />);
    expect(await screen.findByText('No accepted offer in Recruitment')).toBeTruthy();
    expect(screen.getByText(/Issued .* by Hema · issued 2 times/)).toBeTruthy();
    const issueBtns = screen.getAllByRole('button', { name: /Issue/ });
    expect(issueBtns[0].disabled).toBe(true);            // offer
    fireEvent.click(issueBtns[2]);                        // confidentiality, nothing on file → no confirm
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/onboarding/letters/7/confidentiality'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/saved to Asha's documents/)));
  });

  it('non-HR gets a note, not buttons', async () => {
    api.get.mockRejectedValue({ response: { status: 403 } });
    render(<JoiningLetters employeeId={7} />);
    expect(await screen.findByText(/HR issues the joining letters/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Issue/ })).toBeNull();
  });
});
