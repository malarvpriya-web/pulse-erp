import { describe, it, vi, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/services/api/client', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: {} })),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

describe('permissions non-array does not crash Sidebar', () => {
  beforeEach(() => {
    // Simulate a legacy session where permissions was persisted as an object,
    // not an array — the shape that produced "permissions.find is not a function".
    localStorage.setItem('token', 'tok');
    localStorage.setItem('user', JSON.stringify({ name: 'John', email: 'john@pulse.com', role: 'employee' }));
    localStorage.setItem('role', 'employee');
    localStorage.setItem('permissions', JSON.stringify({ finance: { can_view: true } }));
    localStorage.setItem('menuOverrides', JSON.stringify({}));
  });

  // 20s, not the 5s default: this is the one test that dynamically imports the
  // REAL AuthProvider and the REAL Sidebar rather than mocking them, which pulls
  // in routes.jsx and the whole nav graph. Under full-suite parallelism that
  // import alone can exceed 5s and the test times out — it passes in isolation
  // and under --no-file-parallelism, so the timeout was starvation, not a hang.
  it('renders the real Sidebar under the real AuthProvider without throwing', async () => {
    const { AuthProvider } = await import('@/context/AuthContext');
    const Sidebar = (await import('@/components/Sidebar')).default;
    let container;
    expect(() => {
      ({ container } = render(
        <MemoryRouter>
          <AuthProvider>
            <Sidebar />
          </AuthProvider>
        </MemoryRouter>
      ));
    }).not.toThrow();
    await new Promise(r => setTimeout(r, 100));
    expect(container).toBeTruthy();
  }, 20000);
});
