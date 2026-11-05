/**
 * Succession Center — direct-URL access through the REAL Layout guards (§209).
 *
 * The route entry's `module: 'succession'` decides it: succession:view opens
 * the page, its absence shows Unauthorized whatever section the role holds.
 * Only the page component is swapped for a probe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const auth = vi.hoisted(() => ({ role: 'hr', grants: new Set() }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    role: auth.role,
    user: { id: 1 },
    hasPermission: (m, a) => auth.grants.has(`${m}:${a}`),
    menuAccess: () => null,
    logout: vi.fn(),
  }),
}));
vi.mock('../components/Layout.css', () => ({}));
vi.mock('../components/Sidebar', () => ({ default: () => <div /> }));
vi.mock('../components/Topbar', () => ({ default: () => <div /> }));
vi.mock('../components/ErrorBoundary', () => ({ default: ({ children }) => children }));
vi.mock('../components/SessionTimeoutModal', () => ({ default: () => <div /> }));
vi.mock('../components/dashboard/CelebrationSpotlight', () => ({ default: () => <div /> }));
vi.mock('../hooks/useSessionManager', () => ({
  default: () => ({ showWarning: false, sessionTimeRemaining: 0, extendSession: vi.fn(), forceLogout: vi.fn() }),
}));
vi.mock('../config/autoRouter', async () => {
  const { ROUTES } = await import('../config/routes');
  return {
    MERGED_ROUTES: {
      ...ROUTES,
      SuccessionCenter: { ...ROUTES.SuccessionCenter, component: () => <div data-testid="page">succession</div> },
      Unauthorized:     { component: () => <div data-testid="denied">unauthorized</div> },
    },
  };
});

const { default: Layout } = await import('../components/Layout');

function openAs(role, grants) {
  auth.role = role;
  auth.grants = new Set(grants);
  render(
    <MemoryRouter initialEntries={['/SuccessionCenter']}>
      <Routes><Route path="/:page" element={<Layout />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('direct URL /SuccessionCenter', () => {
  it.each(['hr', 'hr_manager'])('%s with succession:view opens the page', async (role) => {
    openAs(role, ['hr:view', 'employees:view', 'succession:view']);
    expect(await screen.findByTestId('page')).toBeTruthy();
    expect(screen.queryByTestId('denied')).toBeNull();
  });

  it.each([
    ['employee', ['employees:view', 'hr:view']],
    ['manager', ['employees:view', 'hr:view']],
    ['department_head', ['employees:view', 'hr:view']],
    ['hr_exec', ['hr:view']],
    ['hr', ['hr:view', 'employees:view']],
  ])('%s without succession:view is denied', async (role, grants) => {
    openAs(role, grants);
    expect(await screen.findByTestId('denied')).toBeTruthy();
    expect(screen.queryByTestId('page')).toBeNull();
  });
});
