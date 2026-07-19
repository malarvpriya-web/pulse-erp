import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
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
  getSectionForPage, canEmployeeAccessPage, canRoleAccessAdminOnlyPage,
  canRoleAccessSuperAdminPage, canRoleAccessPageBySection,
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
    // Page Access override: a section set to "Not Visible" is blocked even via direct URL.
    if (sectionAccess === 'hidden') {
      const Unauthorized = ROUTES['Unauthorized'].component;
      return <Unauthorized setPage={setPage} />;
    }
    // Employees may only reach self-service pages inside shared menus (HR,
    // Service Desk, Travel Desk, Attendance, Leaves, Timesheets) — management
    // pages are blocked even via direct URL, not just hidden from the menu.
    if (role === 'employee' && !canEmployeeAccessPage(page)) {
      const Unauthorized = ROUTES['Unauthorized'].component;
      return <Unauthorized setPage={setPage} />;
    }
    // Admin-only pages (e.g. Knowledge Base) are blocked for every role except
    // super_admin/admin, even via direct URL or global search.
    if (!canRoleAccessAdminOnlyPage(role, page)) {
      const Unauthorized = ROUTES['Unauthorized'].component;
      return <Unauthorized setPage={setPage} />;
    }
    // Super-admin-only pages (roles/users/security/system tooling) are blocked
    // for every other role — admin included — even via direct URL.
    if (!canRoleAccessSuperAdminPage(role, page)) {
      const Unauthorized = ROUTES['Unauthorized'].component;
      return <Unauthorized setPage={setPage} />;
    }
    // Allowlisted roles (manager/hr/finance/employee) may only reach pages whose
    // NAV section is in their allowlist — sections hidden from the menu are also
    // blocked by direct URL, not merely absent from the sidebar.
    if (!canRoleAccessPageBySection(role, page)) {
      const Unauthorized = ROUTES['Unauthorized'].component;
      return <Unauthorized setPage={setPage} />;
    }
    if (route.module) {
      const allowed = role === 'super_admin' || role === 'admin' || hasPermission(route.module, 'view');
      if (!allowed) {
        const Unauthorized = ROUTES['Unauthorized'].component;
        return <Unauthorized setPage={setPage} />;
      }
    }
    const Page = route.component;
    const extraProps = route.props ? route.props(ctx) : {};
    return <Page {...extraProps} />;
  };

  return (
    <div className="layout">
      <Sidebar />
      <div className="main-content">
        <Topbar goBack={goBack} currentPage={page} />
        <div className="page-content">
          <ErrorBoundary>
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
