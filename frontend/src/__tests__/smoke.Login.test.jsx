import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../assets/logo.png', () => ({ default: 'logo.png' }));
vi.mock('../pages/Login.css', () => ({}));

const mockLogin = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login: mockLogin, user: null, role: null }),
}));

import Login from '../pages/Login.jsx';

beforeEach(() => vi.clearAllMocks());

describe('Login — smoke', () => {
  it('renders without crashing', () => {
    render(<MemoryRouter><Login setPage={() => {}} /></MemoryRouter>);
    expect(screen.getByText('Sign in')).toBeDefined();
  });

  it('renders email and password fields', () => {
    render(<MemoryRouter><Login setPage={() => {}} /></MemoryRouter>);
    expect(screen.getByPlaceholderText('you@manifest.com')).toBeDefined();
    expect(screen.getByPlaceholderText('••••••••')).toBeDefined();
  });

  it('calls login() with credentials on submit', async () => {
    mockLogin.mockResolvedValue({ id: 1, role: 'admin', last_login: null });
    render(<MemoryRouter><Login /></MemoryRouter>);

    fireEvent.change(screen.getByPlaceholderText('you@manifest.com'), { target: { value: 'admin@manifest.in' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'),          { target: { value: 'pass123' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('admin@manifest.in', 'pass123', false));
  });

  it('shows error message on failed login', async () => {
    mockLogin.mockRejectedValue({ response: { data: { error: 'Invalid credentials. Please try again.' } } });
    render(<MemoryRouter><Login setPage={() => {}} /></MemoryRouter>);

    fireEvent.change(screen.getByPlaceholderText('you@manifest.com'), { target: { value: 'bad@test.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'),          { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(screen.getByText('Invalid credentials. Please try again.')).toBeDefined());
  });

  it('shows "Signing in…" and disables button while loading', async () => {
    let resolveFn;
    mockLogin.mockReturnValue(new Promise(r => { resolveFn = r; }));
    render(<MemoryRouter><Login setPage={() => {}} /></MemoryRouter>);

    fireEvent.change(screen.getByPlaceholderText('you@manifest.com'), { target: { value: 'admin@manifest.in' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'),          { target: { value: 'pass123' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => {
      const btn = screen.getByText('Signing in…').closest('button');
      expect(btn.disabled).toBe(true);
    });
    resolveFn();
  });
});
