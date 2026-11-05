/**
 * "My Announcements" is NOT a menu row (2026-10-21, reversed from §189).
 *
 * Home's Announcements card already lists every user's announcements, so a menu
 * row duplicated it — and Super Admins who opened it expected the management
 * page. The PAGE stays: it is where the bell opens an announcement in full and
 * records the read (notificationTarget.js), for every role (PERSONAL_PAGES).
 * Management stays at HR → Announcements.
 *
 * Checked in the REAL Sidebar for every role family, plus the route guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const env = vi.hoisted(() => ({ roles: ['employee'], grants: new Set(), calls: 0 }));
vi.mock('@/services/api/client', () => ({
  default: {
    get: vi.fn(async (url) => {
      env.calls += 1;
      if (url === '/probation-reviews/mine/summary') return { data: { linked: true, is_head: false, departments: [], needs_action: 0 } };
      if (url === '/intern-evaluations/mine/summary') return { data: { linked: true, is_mentor: false } };
      return { data: [] };
    }),
  },
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    roles: env.roles,
    role: env.roles[0],
    hasAnyRole: (...r) => r.some((x) => env.roles.includes(x)),
    isEmployeeOnly: env.roles.length === 1 && env.roles[0] === 'employee',
    hasPermission: (m, a) => env.grants.has(`${m}:${a}`),
    menuAccess: () => null,
  }),
}));

import Sidebar from '@/components/Sidebar';
import { __resetReviewerStatus } from '@/features/hr/probationReviewerStatus';
import { __resetMentorStatus } from '@/features/internships/mentorStatus';
import { NAV_ITEMS } from '@/config/routes';
import { ALWAYS_VISIBLE, PERSONAL_PAGES, getSectionForPage, canRoleOpenPage } from '@/config/menuCatalog';

let n = 0;
async function railFor({ roles, grants = [] }) {
  env.roles = roles; env.grants = new Set(grants); env.calls = 0;
  __resetReviewerStatus();
  __resetMentorStatus();
  localStorage.setItem('token', `zz-ann-nav-token-${(n += 1)}`);
  const view = render(<MemoryRouter><Sidebar /></MemoryRouter>);
  await waitFor(() => expect(env.calls).toBeGreaterThan(0));
  await act(async () => { await Promise.resolve(); });
  return [...view.container.querySelectorAll('.nav-item .label')].map((l) => l.textContent);
}

beforeEach(() => { document.body.innerHTML = ''; });

const ROLES = [
  ['employee', ['employee'], ['employees:view', 'announcements:view']],
  ['service_engineer', ['service_engineer'], []],
  ['manager', ['manager'], ['employees:view', 'announcements:view']],
  ['hr', ['hr'], ['hr:view', 'employees:view', 'announcements:view']],
  ['hr_manager', ['hr_manager'], ['hr:view', 'announcements:view']],
  ['admin', ['admin'], []],
  ['super_admin', ['super_admin'], []],
];

describe('My Announcements has no menu row', () => {
  it('is in no NAV_ITEMS entry and not ALWAYS_VISIBLE; the HR administration page is still under HR', () => {
    const anywhere = NAV_ITEMS.some((i) => i && (i.page === 'MyAnnouncements'
      || (i.submenu || i.children || []).some((s) => s && s.page === 'MyAnnouncements')));
    expect(anywhere).toBe(false);
    expect(ALWAYS_VISIBLE.has('My Announcements')).toBe(false);
    expect(getSectionForPage('MyAnnouncements')).toBeNull();
    expect(getSectionForPage('Announcements')).toBe('HR');
  });

  it.each(ROLES)('%s: no "My Announcements" row in the sidebar; Home is there', async (_label, roles, grants) => {
    const labels = await railFor({ roles, grants });
    expect(labels).toContain('Home');
    expect(labels).not.toContain('My Announcements');
  });

  it.each(ROLES)('%s: the page still opens (the bell lands there)', (_label, roles) => {
    expect(PERSONAL_PAGES.has('MyAnnouncements')).toBe(true);
    expect(canRoleOpenPage(roles[0], 'MyAnnouncements', { menuAccess: () => null })).toBe(true);
  });

  it('an employee still cannot open the HR administration page', () => {
    expect(canRoleOpenPage('employee', 'Announcements', { menuAccess: () => null })).toBe(false);
  });
});
