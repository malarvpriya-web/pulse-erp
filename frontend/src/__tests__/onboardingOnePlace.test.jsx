/**
 * Onboarding lives in ONE place (owner 18 Nov 26):
 *   - Employee Profile keeps its Onboarding tab, but has NO Manage Checklist
 *   - Recruitment → Offer & Onboarding → Onboarding lists every new joiner
 *     (hired through Recruitment or added directly) and gives HR Manage Checklist
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import AuthContext from '../context/AuthContext';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../services/api/client', () => ({ default: api }));
vi.mock('@/services/api/client', () => ({ default: api }));
vi.mock('../features/employees/pages/EmployeesData.css', () => ({}));
vi.mock('../context/ToastContext', () => {
  const t = Object.assign(() => {}, { success: () => {}, error: () => {}, warning: () => {}, info: () => {} });
  return { useToast: () => t };
});
vi.mock('@/context/ToastContext', () => {
  const t = Object.assign(() => {}, { success: () => {}, error: () => {}, warning: () => {}, info: () => {} });
  return { useToast: () => t };
});

const { default: EmployeeProfile } = await import('../features/employees/pages/EmployeeProfile.jsx');
const { default: OnboardingChecklist } = await import('../features/recruitment/pages/OnboardingChecklist');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const JOINERS = [
  { key: 'c1', source: 'recruitment', name: 'Asha', employee_id: 5, onboarding_total: 10, onboarding_done: 2, onboarding_pct: 20 },
  { key: 'e9', source: 'direct', name: 'Bala', employee_id: 9, onboarding_total: 10, onboarding_done: 0, onboarding_pct: 0 },
];

describe('Employee Profile', () => {
  it('keeps the Onboarding tab, without Manage Checklist', async () => {
    api.get.mockImplementation(async (url) => (url === '/onboarding/progress/42'
      ? { data: { employee_id: 42, total: 1, done: 0, pct: 0, items: [{ category: 'HR', item_label: 'Assign leave policy', done: false }], archived: [] } }
      : { data: [] }));
    render(<EmployeeProfile employee={{ id: 42, first_name: 'Arun', last_name: 'K', status: 'Active' }} setPage={() => {}} setSelectedEmployee={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Onboarding' }));
    expect(await screen.findByText('Assign leave policy')).toBeTruthy();
    expect(screen.queryByText(/Manage Checklist/)).toBeNull();
  });
});

describe('Offer & Onboarding → Onboarding', () => {
  const mount = (roles) => render(
    <AuthContext.Provider value={{ hasAnyRole: (...c) => c.some(r => roles.includes(r)) }}>
      <OnboardingChecklist embedded setPage={() => {}} />
    </AuthContext.Provider>);

  it('lists recruitment hires and people added directly, tagged', async () => {
    api.get.mockImplementation(async (url) => (url === '/recruitment/onboarding' ? { data: JOINERS } : { data: [] }));
    mount([]);
    expect(await screen.findByText('Asha')).toBeTruthy();
    expect(screen.getByText('Bala')).toBeTruthy();
    expect(screen.getByText('Recruitment')).toBeTruthy();
    expect(screen.getByText('Added directly')).toBeTruthy();
  });

  it('HR gets Manage Checklist, which opens the editor; others do not', async () => {
    api.get.mockImplementation(async (url) => (url === '/recruitment/onboarding' ? { data: JOINERS } : { data: [] }));
    mount(['hr']);
    fireEvent.click(await screen.findByRole('button', { name: /Manage Checklist/ }));
    expect(await screen.findByText('Manage Onboarding Checklist')).toBeTruthy();
    cleanup();
    mount(['recruiter']);
    await screen.findByText('Asha');
    expect(screen.queryByRole('button', { name: /Manage Checklist/ })).toBeNull();
  });
});
