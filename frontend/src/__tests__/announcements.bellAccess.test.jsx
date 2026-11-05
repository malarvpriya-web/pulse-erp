/**
 * Announcement bell destination + direct-URL access (2026-10-21).
 *
 * The bell resolved an announcement notification to the HR administration page
 * (Announcements), which employees cannot open — and notificationTarget skips a
 * page the role cannot open, so for an employee the click went nowhere. It now
 * opens My Announcements (PERSONAL_PAGES, every role), whose API returns only
 * the caller's company and audience. The HR page stays closed to employees.
 *
 * Harness as in probationReviews.routeAccess.test.jsx: the real Layout guard,
 * each page swapped for a probe so only the access decision is under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const auth = vi.hoisted(() => ({ role: 'employee', grants: new Set() }));
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
  const probe = (k) => ({ ...ROUTES[k], component: () => <div data-testid="page">{k}</div> });
  return {
    MERGED_ROUTES: {
      ...ROUTES,
      Announcements: probe('Announcements'),
      MyAnnouncements: probe('MyAnnouncements'),
      Unauthorized: { component: () => <div data-testid="denied">unauthorized</div> },
    },
  };
});

const { default: Layout } = await import('../components/Layout');
const { ROUTES } = await import('../config/routes');
const { PERSONAL_PAGES, canRoleOpenPage } = await import('../config/menuCatalog');
const { notificationTarget } = await import('../features/notifications/notificationTarget');

const GRANTS = {
  super_admin: [], admin: [],
  hr: ['hr:view', 'employees:view'], hr_manager: ['hr:view'], hr_exec: ['hr:view'],
  manager: ['employees:view'], department_head: ['employees:view'],
  employee: ['employees:view'], service_engineer: [], sales_exec: [],
};

async function outcome(role, page) {
  document.body.innerHTML = '';
  auth.role = role;
  auth.grants = new Set(GRANTS[role]);
  render(
    <MemoryRouter initialEntries={[`/${page}?ref=7`]}>
      <Routes><Route path="/:page" element={<Layout />} /></Routes>
    </MemoryRouter>,
  );
  const hit = await screen.findByTestId(/^(page|denied)$/);
  return hit.dataset.testid;
}

beforeEach(() => { document.body.innerHTML = ''; });

const ROLES = ['employee', 'service_engineer', 'sales_exec', 'manager', 'department_head', 'hr', 'hr_manager', 'hr_exec', 'admin'];
// What the publisher writes (announcement.publisher.js), and the 5 legacy rows' shape.
const published = { notification_type: 'announcement', module_name: 'Announcements', reference_id: 7 };
const legacy = { notification_type: 'info', module_name: 'announcements', reference_id: null };

describe('bell destination for an announcement', () => {
  it.each(ROLES)('%s: resolves to My Announcements with the ref, never the HR page', (role) => {
    const gate = (pg) => canRoleOpenPage(role, pg, { menuAccess: () => null });
    expect(notificationTarget(published, gate)).toEqual({ page: 'MyAnnouncements', params: { ref: '7' } });
    expect(notificationTarget(legacy, gate)?.page).toBe('MyAnnouncements');
  });

  it('is a personal page with no module, so opening it grants nothing', () => {
    expect(PERSONAL_PAGES.has('MyAnnouncements')).toBe(true);
    expect(ROUTES.MyAnnouncements).toBeTruthy();
    expect(ROUTES.MyAnnouncements.module).toBeUndefined();
  });
});

describe('direct-URL access', () => {
  it.each(ROLES)('%s reaches My Announcements (where the bell lands)', async (role) => {
    expect(await outcome(role, 'MyAnnouncements')).toBe('page');
  });

  it('an employee is still refused the HR administration page', async () => {
    expect(await outcome('employee', 'Announcements')).toBe('denied');
  });
});
