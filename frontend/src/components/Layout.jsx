import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import ErrorBoundary from './ErrorBoundary';
import SessionTimeoutModal from './SessionTimeoutModal';
import useSessionManager from '@/hooks/useSessionManager';
// MERGED_ROUTES = auto-discovered page files overlaid with the manual ROUTES
// table (manual wins). Rendering from it makes every page reachable by URL,
// including pages that aren't hand-registered in routes.jsx.
import { MERGED_ROUTES as ROUTES } from '@/config/autoRouter';
import {
  getSectionForPage, canRenderPage, canOpenEmployeeMaster,
  EMPLOYEE_MASTER_PAGE, EMPLOYEE_DIRECTORY_PAGE,
  payrollHubRedirect, PAYROLL_HUB_PAGE,
} from '@/config/menuCatalog';
import './Layout.css';

// Once-a-day login overlay highlighting today's birthdays/anniversaries.
// Lazy so its confetti CSS + emoji logic never load on celebration-free days.
const CelebrationSpotlight = lazy(() => import('./dashboard/CelebrationSpotlight'));

export default function Layout({ selectedEmployee, setSelectedEmployee }) {
  const { page: routePage } = useParams();
  const navigate = useNavigate();
  const { search } = useLocation();
  const { role, user, hasPermission, menuAccess, logout } = useAuth();

  const { showWarning, sessionTimeRemaining, extendSession, forceLogout } =
    useSessionManager({ onLogout: logout });

  const page = routePage || 'Home';
  const urlParams = Object.fromEntries(new URLSearchParams(search));
  const [selectedProduction, setSelectedProduction] = useState(null);

  const setPage = useCallback((pg, params) => {
    const base = pg === 'Home' ? '/' : `/${pg}`;
    if (params && Object.keys(params).length > 0) {
      navigate(`${base}?${new URLSearchParams(params).toString()}`);
    } else {
      navigate(base);
    }
  }, [navigate]);

  const goBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  useEffect(() => {
    const handler = (e) => { if (e.detail?.page) setPage(e.detail.page); };
    window.addEventListener('pulse:navigate', handler);
    return () => window.removeEventListener('pulse:navigate', handler);
  }, [setPage]);

  // Admin-configured Page Access for the section this page belongs to.
  const section       = getSectionForPage(page);
  const sectionAccess = section ? menuAccess(section) : null; // 'hidden' | 'view' | 'edit' | null
  const readOnly      = sectionAccess === 'view';

  const ctx = { setPage, selectedEmployee, setSelectedEmployee, selectedProduction, setSelectedProduction, role, urlParams, readOnly, sectionAccess };

  const renderPage = () => {
    // Single, role-aware Home for every role. The Home Dashboard itself renders
    // a lighter, self-service-scoped variant for employees (no revenue / admin
    // widgets) — there is no separate employee/super-admin home route.
    const route = ROUTES[page];
    if (!route) {
      const Home = ROUTES['Home'].component;
      return <Home setPage={setPage} />;
    }
    // Every page-level gate — Page Access "Not Visible", the employee / hr /
    // finance / hr_exec / manager scopings, admin-only, super-admin-only, the
    // section allowlist and the route's module permission — lives in
    // canRenderPage() (menuCatalog.js), in the order it always ran here. It was
    // inline until 2026-10-20; it moved so that code which SENDS someone to a
    // page (the Employee Directory → All Employees redirect below, the sidebar
    // row it replaces) asks the very same question this route asks, and can
    // never send anyone to an Access Denied screen.
    // One employee list per person: whoever can open All Employees is sent
    // there instead of the read-only phonebook. Checked BEFORE the gate below,
    // because the target is what matters: a role that can open the master but
    // was never in the phonebook's audience (department_head) is still sent to
    // the list it can open, not refused. canOpenEmployeeMaster() is
    // canRenderPage() on EmployeesData, so the redirect can never land anyone
    // on Access Denied. Everyone else is gated on the phonebook as usual.
    if (page === EMPLOYEE_DIRECTORY_PAGE &&
        canOpenEmployeeMaster(role, { route: ROUTES[EMPLOYEE_MASTER_PAGE], menuAccess, hasPermission })) {
      return <Navigate to={`/${EMPLOYEE_MASTER_PAGE}`} replace />;
    }
    // The standalone payroll pages are sections of Payroll Center. Anyone who
    // can render the hub is sent to the matching section; the rest are gated
    // on the page as before (payrollHubRedirect in menuCatalog.js).
    const payrollHub = payrollHubRedirect(role, page, { route: ROUTES[PAYROLL_HUB_PAGE], menuAccess, hasPermission });
    if (payrollHub) return <Navigate to={payrollHub} replace />;
    if (!canRenderPage(role, page, { route, menuAccess, hasPermission })) {
      const Unauthorized = ROUTES['Unauthorized'].component;
      return <Unauthorized setPage={setPage} />;
    }
    const Page = route.component;
    // A route that declares no `props` function still needs the navigation
    // context. Defaulting to {} meant `setPage` arrived undefined on every
    // auto-discovered page and on manual entries written without a `props`
    // function: guarded call sites (`if (setPage)`, `setPage?.()`) silently
    // did nothing — a dead row click with no error — and unguarded ones threw
    // "setPage is not a function". An explicit `props` function still wins,
    // so nothing that already declares its own props changes.
    const extraProps = route.props ? route.props(ctx) : { setPage, urlParams };
    return <Page {...extraProps} />;
  };

  return (
    <div className="layout">
      <Sidebar />
      <div className="main-content">
        <Topbar goBack={goBack} currentPage={page} />
        <div className="page-content">
          {/* resetKey clears a caught error when the route changes — otherwise
              one crashing page renders the error screen for every page the
              user visits afterwards. */}
          <ErrorBoundary resetKey={page}>
            <Suspense fallback={<div className="page-loading">Loading…</div>}>
              {renderPage()}
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
      <Suspense fallback={null}>
        <CelebrationSpotlight />
      </Suspense>
      {showWarning && (
        <SessionTimeoutModal
          timeRemaining={sessionTimeRemaining}
          onExtend={extendSession}
          onLogout={forceLogout}
        />
      )}
    </div>
  );
}
