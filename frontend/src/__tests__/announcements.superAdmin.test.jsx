/**
 * Super Admin and HR Announcements in the REAL AuthProvider (2026-10-21).
 *
 * Every other announcement UI test mocks useAuth, so the real hasPermission /
 * menuAccess wiring is never exercised. Here the session is seeded into
 * localStorage (as multiRoleGating.test.jsx does) with HOSTILE Page Access —
 * the HR and My Announcements sections set to 'hidden' and no permission rows —
 * and the real route guard (Layout), Sidebar and pages are asked:
 *
 *   - Super Admin opens both the HR administration page and My Announcements,
 *     sees both menu rows, and is offered Delete (archive) — Page Access and the
 *     permission list cannot take that away (AuthContext short-circuits both).
 *   - Admin is offered Delete, but Page Access CAN hide the HR page from admin
 *     (that is the designed difference: only super_admin is exempt).
 *   - HR Manager (announcements view/add/edit, no delete) is not offered Delete.
 *   - Employee cannot open the HR page; My Announcements still opens.
 *   - An empty My Announcements is the valid empty state, not an error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const api = vi.hoisted(() => ({ list: [] }));
vi.mock('@/services/api/client', () => ({
  default: {
    get: vi.fn((url) => {
      if (url === '/announcements') return Promise.resolve({ data: api.list });
      if (url === '/announcements/active') return Promise.resolve({ data: [] });
      if (url === '/probation-reviews/mine/summary') return Promise.resolve({ data: { linked: false, is_head: false } });
      if (url === '/intern-evaluations/mine/summary') return Promise.resolve({ data: { linked: false, is_mentor: false } });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));
vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));
vi.mock('../features/hr/pages/Announcements.css', () => ({}));
vi.mock('../features/hr/pages/MyAnnouncements.css', () => ({}));

const HOSTILE_PAGE_ACCESS = { HR: 'hidden', 'My Announcements': 'hidden' };
const ANNOUNCEMENTS_ROW = (canDelete) => ({ module: 'announcements', can_view: true, can_add: true, can_edit: true, can_delete: canDelete });

function seedSession(role, { permissions = [], menuOverrides = HOSTILE_PAGE_ACCESS } = {}) {
  localStorage.setItem('token', 'tok');
  localStorage.setItem('user', JSON.stringify({ name: 'Zz', email: 'zz@manifest.in', id: 848, role, roles: [role] }));
  localStorage.setItem('role', role);
  localStorage.setItem('roles', JSON.stringify([role]));
  localStorage.setItem('permissions', JSON.stringify(permissions));
  localStorage.setItem('menuOverrides', JSON.stringify(menuOverrides));
}

const { AuthProvider, useAuth } = await import('@/context/AuthContext');
const { canRenderPage } = await import('@/config/menuCatalog');
const { MERGED_ROUTES } = await import('@/config/autoRouter');
const { default: Announcements } = await import('../features/hr/pages/Announcements.jsx');
const { default: MyAnnouncements } = await import('../features/hr/pages/MyAnnouncements.jsx');

/** What the real route guard (Layout's canRenderPage) and the real context answer. */
async function gate(role, opts) {
  seedSession(role, opts);
  let seen;
  const Probe = () => {
    const { menuAccess, hasPermission } = useAuth();
    const ask = (page) => canRenderPage(role, page, { route: MERGED_ROUTES[page], menuAccess, hasPermission });
    seen = {
      adminPage: ask('Announcements'),
      reader: ask('MyAnnouncements'),
      archive: hasPermission('announcements', 'delete'),
      create: hasPermission('announcements', 'add'),
    };
    return null;
  };
  render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>);
  await waitFor(() => expect(seen).toBeDefined());
  return seen;
}

const renderPage = (ui, path = '/') => render(
  <MemoryRouter initialEntries={[path]}><AuthProvider><Routes><Route path="*" element={ui} /></Routes></AuthProvider></MemoryRouter>,
);

beforeEach(() => { localStorage.clear(); api.list = []; });
afterEach(() => { cleanup(); localStorage.clear(); });

describe('route guard + permissions, with hostile Page Access', () => {
  it('Super Admin: both pages open, create and archive allowed — Page Access cannot hide them', async () => {
    expect(await gate('super_admin')).toEqual({ adminPage: true, reader: true, archive: true, create: true });
  }, 20000);

  it('Admin: create and archive allowed; Page Access can hide the HR page (by design), and the reader still opens', async () => {
    expect(await gate('admin')).toEqual({ adminPage: false, reader: true, archive: true, create: true });
    cleanup(); localStorage.clear();
    expect(await gate('admin', { menuOverrides: {} })).toMatchObject({ adminPage: true, reader: true });
  }, 20000);

  it('HR Manager: manages but cannot archive (matrix unchanged)', async () => {
    const g = await gate('hr_manager', { permissions: [ANNOUNCEMENTS_ROW(false)], menuOverrides: {} });
    expect(g).toMatchObject({ adminPage: true, reader: true, archive: false, create: true });
  }, 20000);

  it('Employee: no HR page, no create/archive; the reader opens', async () => {
    const g = await gate('employee', {
      permissions: [{ module: 'announcements', can_view: true, can_add: false, can_edit: false, can_delete: false }],
      menuOverrides: {},
    });
    expect(g).toEqual({ adminPage: false, reader: true, archive: false, create: false });
  }, 20000);
});

describe('ALWAYS_VISIBLE: a stray Page Access override cannot strand the reader', () => {
  it('an employee with "My Announcements: hidden" still opens it (route guard and bell), and still not the HR page', async () => {
    const perms = [{ module: 'announcements', can_view: true, can_add: false, can_edit: false, can_delete: false }];
    expect(await gate('employee', { permissions: perms })).toEqual({ adminPage: false, reader: true, archive: false, create: false });
    const { canRoleOpenPage } = await import('@/config/menuCatalog');
    const { notificationTarget } = await import('../features/notifications/notificationTarget');
    const hidden = (s) => HOSTILE_PAGE_ACCESS[s] ?? null;
    expect(canRoleOpenPage('employee', 'MyAnnouncements', { menuAccess: hidden })).toBe(true);
    expect(notificationTarget({ notification_type: 'announcement', reference_id: 3 },
      (pg) => canRoleOpenPage('employee', pg, { menuAccess: hidden }))).toEqual({ page: 'MyAnnouncements', params: { ref: '3' } });
  }, 20000);
});

describe('HR administration page — the archive control', () => {
  const ann = {
    id: 7, title: 'Zz notice', message: '<p>x</p>', from_date: '2026-10-01', to_date: '2099-01-01',
    target_type: 'all', is_active: true, is_pinned: false, priority: 'medium', category: 'General',
  };

  it('Super Admin is offered Edit, Pin, Hide and Delete', async () => {
    seedSession('super_admin');
    api.list = [ann];
    renderPage(<Announcements />);
    await screen.findByText('Zz notice');
    for (const label of [/^Edit$/, /^Pin$/, /^Hide$/, /^Delete$/]) {
      expect(screen.getByRole('button', { name: label })).toBeDefined();
    }
  }, 20000);

  it('HR Manager is offered Edit, Pin and Hide but not Delete', async () => {
    seedSession('hr_manager', { permissions: [ANNOUNCEMENTS_ROW(false)], menuOverrides: {} });
    api.list = [ann];
    renderPage(<Announcements />);
    await screen.findByText('Zz notice');
    expect(screen.getByRole('button', { name: /^Edit$/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).toBeNull();
  }, 20000);
});

describe('My Announcements → the administration page (navigation only)', () => {
  const routes = (
    <Routes>
      <Route path="/MyAnnouncements" element={<MyAnnouncements />} />
      <Route path="/Announcements" element={<div data-testid="admin-page">HR administration</div>} />
    </Routes>
  );
  const renderReader = () => render(
    <MemoryRouter initialEntries={['/MyAnnouncements']}><AuthProvider>{routes}</AuthProvider></MemoryRouter>,
  );
  const button = () => screen.queryByRole('button', { name: /manage announcements/i });

  it('Super Admin is shown "Manage announcements" and it opens HR → Announcements', async () => {
    seedSession('super_admin');
    renderReader();
    await screen.findByText('No announcements right now');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(button());
    expect(await screen.findByTestId('admin-page')).toBeDefined();
  }, 20000);

  it('HR Manager (announcements:add) is shown it', async () => {
    seedSession('hr_manager', { permissions: [ANNOUNCEMENTS_ROW(false)], menuOverrides: {} });
    renderReader();
    await screen.findByText('No announcements right now');
    expect(button()).not.toBeNull();
  }, 20000);

  it('an employee is not shown it', async () => {
    seedSession('employee', {
      permissions: [{ module: 'announcements', can_view: true, can_add: false, can_edit: false, can_delete: false }],
      menuOverrides: {},
    });
    renderReader();
    await screen.findByText('No announcements right now');
    expect(button()).toBeNull();
  }, 20000);

  it('an admin whom Page Access keeps out of HR is not shown a link to Access Denied', async () => {
    seedSession('admin');                       // HOSTILE_PAGE_ACCESS hides HR
    renderReader();
    await screen.findByText('No announcements right now');
    expect(button()).toBeNull();
  }, 20000);
});

describe('My Announcements — empty is a valid state', () => {
  it('shows the empty state (no error, no notice) when nothing is addressed to the Super Admin', async () => {
    seedSession('super_admin');
    renderPage(<MyAnnouncements />, '/MyAnnouncements');
    expect(await screen.findByText('No announcements right now')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  }, 20000);
});
