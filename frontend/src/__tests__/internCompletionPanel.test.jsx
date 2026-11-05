/**
 * Completion & certificate card (View Intern → Internship). The API enforces the
 * rules (internshipCompletion.integration.test.js); this checks the card offers
 * only the actions that can succeed and sends the right calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

vi.mock('@/services/api/client', () => ({ default: { post: vi.fn() } }));
const auth = vi.hoisted(() => ({ grants: new Set() }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ hasPermission: (m, a) => auth.grants.has(`${m}:${a}`) }) }));
vi.mock('@/features/employees/shared/employeeFiles', () => ({ openEmployeeFile: vi.fn() }));

import api from '@/services/api/client';
import InternCompletionPanel from '@/features/internships/pages/InternCompletionPanel.jsx';

const BASE = { id: 5, status: 'Completed', completed_on: '2026-09-30', completion_evaluation_id: 4, certificates: [], lifecycle_events: [] };
const ACTIVE_CERT = { id: 1, certificate_number: 'C-1', issued_at: '2026-10-01T00:00:00Z', revoked_at: null };

beforeEach(() => { cleanup(); vi.clearAllMocks(); auth.grants = new Set(['internships:edit']); });

describe('InternCompletionPanel', () => {
  it('by default generates the certificate from the template, auto-numbered when the number is blank', async () => {
    api.post.mockResolvedValue({ data: BASE });
    const onChanged = vi.fn();
    render(<InternCompletionPanel intern={{ ...BASE, intern_code: 'INT005' }} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Issue certificate' }));
    expect(screen.getByLabelText(/Certificate number/).placeholder).toMatch(/INT005\/CERT\//);
    expect(screen.getByRole('button', { name: /Preview certificate/ })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Issue certificate' }).at(-1));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, fd] = api.post.mock.calls[0];
    expect(url).toBe('/interns/5/certificate');
    expect(fd.get('generate')).toBe('true');
    expect(fd.has('certificate_number')).toBe(false);
    expect(fd.has('certificate_file')).toBe(false);
    expect(onChanged).toHaveBeenCalledWith(BASE);
  });

  it('can instead upload a signed certificate, with a typed number', async () => {
    api.post.mockResolvedValue({ data: BASE });
    render(<InternCompletionPanel intern={BASE} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Issue certificate' }));
    fireEvent.click(screen.getByLabelText(/Upload a signed certificate/));
    const send = screen.getAllByRole('button', { name: 'Issue certificate' }).at(-1);
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Certificate number/), { target: { value: ' C-9 ' } });
    const file = new File(['%PDF'], 'c.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Certificate file'), { target: { files: [file] } });
    fireEvent.click(send);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, fd] = api.post.mock.calls[0];
    expect(fd.get('certificate_number')).toBe('C-9');
    expect(fd.get('certificate_file')).toBe(file);
    expect(fd.has('generate')).toBe(false);
  });

  it('offers no issue for an internship not completed through the gate, or with an active certificate', () => {
    render(<InternCompletionPanel intern={{ ...BASE, status: 'Active', completion: { eligible: false, reason: 'No evaluation.' } }} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Issue certificate' })).toBeNull();
    expect(screen.getByText('No evaluation.')).toBeTruthy();
    cleanup();
    render(<InternCompletionPanel intern={{ ...BASE, completion_evaluation_id: null }} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Issue certificate' })).toBeNull();
    cleanup();
    render(<InternCompletionPanel intern={{ ...BASE, certificates: [ACTIVE_CERT] }} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Issue certificate' })).toBeNull();
  });

  it('revoke needs the approve permission and a reason', async () => {
    render(<InternCompletionPanel intern={{ ...BASE, certificates: [ACTIVE_CERT] }} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Revoke certificate/ })).toBeNull();
    cleanup();
    auth.grants = new Set(['internships:edit', 'internships:approve']);
    api.post.mockResolvedValue({ data: BASE });
    render(<InternCompletionPanel intern={{ ...BASE, certificates: [ACTIVE_CERT] }} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke certificate…' }));
    const send = screen.getByRole('button', { name: 'Revoke certificate' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason for revoking C-1/), { target: { value: 'Wrong name' } });
    fireEvent.click(send);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/interns/5/certificate/revoke', { reason: 'Wrong name' }));
  });
});
