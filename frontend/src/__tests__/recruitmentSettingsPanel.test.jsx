/**
 * Recruitment → Reports & Setup → Settings (review 2026-11-18):
 *   - no empty band above Save Changes; screening questions sit above the bar
 *   - only this page's fields are sent (Probation shares the blob)
 *   - out-of-range numbers block Save
 *   - candidate data retention is editable
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(() => Promise.resolve({ data: {} })), delete: vi.fn() }));
api.get.mockImplementation((url) => Promise.resolve({ data: url === '/settings/recruitment'
  ? { offer_validity_days: 7, probation_months: 3, interview_stages: 'x' }
  : [{ code: 'Q1', prompt: 'Why?', answer_type: 'text', options: [], competency: 'learning', is_active: true }] }));
vi.mock('@/services/api/client', () => ({ default: api }));
vi.mock('@/context/ToastContext', () => ({ useToast: () => () => {} }));

const { default: RecruitmentSettings } = await import('../features/recruitment/pages/RecruitmentSettings');
afterEach(() => { cleanup(); api.post.mockClear(); });

describe('Recruitment Settings', () => {
  it('draws the screening questions above the Save bar with no 120px gap', async () => {
    const { container } = render(<RecruitmentSettings embedded />);
    const save = await screen.findByRole('button', { name: 'Save Changes' });
    const q = await screen.findByText('Stage-1 screening questions');
    // question card comes before the Save bar in document order
    expect(q.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/120px/);
  });

  it('sends only its own fields and offers retention months', async () => {
    render(<RecruitmentSettings embedded />);
    const ret = await screen.findByLabelText('Keep candidate data for (months)');
    fireEvent.change(ret, { target: { value: '36' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const body = api.post.mock.calls[0][1];
    expect(body.candidate_retention_months).toBe(36);
    expect(body.offer_validity_days).toBe(7);
    expect(body).not.toHaveProperty('probation_months');
    expect(body).not.toHaveProperty('interview_stages');
  });

  it('blocks Save on an out-of-range number', async () => {
    render(<RecruitmentSettings embedded />);
    const v = await screen.findByLabelText('Default Offer Validity (days)');
    fireEvent.change(v, { target: { value: '0' } });
    expect(await screen.findByText('At least 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Changes' }).disabled).toBe(true);
  });
});
