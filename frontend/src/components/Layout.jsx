import { Suspense } from 'react';
import { useAuth } from '@/context/AuthContext';
import Sidebar from './Sidebar';
import Topbar from './Topbar';

import { ROUTES } from '@/config/routes';
import './Layout.css';

export default function Layout({ page, setPage, selectedEmployee, setSelectedEmployee }) {
  const { role, hasPermission } = useAuth();

  const ctx = { setPage, selectedEmployee, setSelectedEmployee, role };

  const renderPage = () => {
    const route = ROUTES[page];

    // Unknown page key — fall back to Home
    if (!route) {
      const Home = ROUTES['Home'].component;
      return <Home />;
    }
    


    // Permission check
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
      <Sidebar setPage={setPage} />
      <div className="main-content">
        <Topbar />
        <div className="page-content">
          <Suspense fallback={<div className="page-loading">Loading…</div>}>
            {renderPage()}
          </Suspense>
        </div>
      </div>
    </div>
  );
}
