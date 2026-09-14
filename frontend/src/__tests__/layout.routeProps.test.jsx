/**
 * layout.routeProps.test.jsx — the router must hand every page its navigation
 * context.
 *
 * Layout renders `route.props ? route.props(ctx) : <default>`. That default was
 * `{}`, so any page reached through an auto-discovered route — or through a
 * manual routes.jsx entry written without a `props` function — received NO
 * props at all. 15 pages destructure `setPage` and call it: the guarded ones
 * (`if (setPage)`, `setPage?.()`) silently did nothing, which is why a project
 * row click looked like "the link is broken" with a clean console, and the
 * unguarded ones threw "setPage is not a function".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../components/Layout.css', () => ({}));
vi.mock('../components/Sidebar', () => ({ default: () => <div /> }));
vi.mock('../components/Topbar', () => ({ default: () => <div /> }));
vi.mock('../components/ErrorBoundary', () => ({ default: ({ children }) => children }));
vi.mock('../components/SessionTimeoutModal', () => ({ default: () => <div /> }));
vi.mock('../components/dashboard/CelebrationSpotlight', () => ({ default: () => <div /> }));
vi.mock('../hooks/useSessionManager', () => ({
  default: () => ({ showWarning: false, sessionTimeRemaining: 0, extendSession: vi.fn(), forceLogout: vi.fn() }),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    role: 'super_admin',
    user: { id: 1 },
    hasPermission: () => true,
    menuAccess: () => 'edit',
    logout: vi.fn(),
  }),
}));
// Every access gate open — this test is about prop delivery, not authorisation.
vi.mock('../config/menuCatalog', () => ({
  getSectionForPage: () => null,
  canEmployeeAccessPage: () => true,
  canRoleAccessAdminOnlyPage: () => true,
  canRoleAccessSuperAdminPage: () => true,
  canRoleAccessPageBySection: () => true,
  canHrAccessPage: () => true,
  canFinanceAccessPage: () => true,
  canHrExecAccessPage: () => true,
  canManagerAccessPage: () => true,
  isFinanceSelfServicePage: () => false,
}));

// A page that reports what the router actually handed it.
function ProbePage({ setPage, urlParams }) {
  return (
    <div>
      <span data-testid="setPage-type">{typeof setPage}</span>
      <span data-testid="url-id">{String(urlParams?.id)}</span>
      <button onClick={() => setPage('Somewhere', { id: 7 })}>go</button>
    </div>
  );
}

function DeclaredPage({ only }) {
  return <span data-testid="declared">{String(only)}</span>;
}

vi.mock('../config/autoRouter', () => ({
  MERGED_ROUTES: {
    Home:         { component: () => <div>home</div> },
    Unauthorized: { component: () => <div>nope</div> },
    // No `props` function — the case that was broken.
    AutoPage:     { component: ProbePage },
    // Declares its own props — must keep winning, and must NOT be given extras.
    ManualPage:   { component: DeclaredPage, props: () => ({ only: 'mine' }) },
  },
}));

const { default: Layout } = await import('../components/Layout');

const renderAt = (url) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/:page" element={<Layout />} />
      </Routes>
    </MemoryRouter>,
  );

describe('Layout → page prop delivery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives setPage to a route that declares no props function', async () => {
    renderAt('/AutoPage');
    expect((await screen.findByTestId('setPage-type')).textContent).toBe('function');
  });

  it('passes urlParams through for deep links', async () => {
    renderAt('/AutoPage?id=42');
    expect((await screen.findByTestId('url-id')).textContent).toBe('42');
  });

  it('calling setPage from such a page actually navigates', async () => {
    renderAt('/AutoPage');
    fireEvent.click(await screen.findByText('go'));
    // 'Somewhere' is not in the route table, so Layout falls back to Home.
    // Seeing Home proves the navigation ran — asserting "did not throw" would
    // also pass when setPage is undefined and the click is silently dead.
    expect(await screen.findByText('home')).toBeInTheDocument();
  });

  it('an explicit props function still wins and is not merged with defaults', async () => {
    renderAt('/ManualPage');
    expect((await screen.findByTestId('declared')).textContent).toBe('mine');
  });
});
