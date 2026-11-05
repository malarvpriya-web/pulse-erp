import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Guards the two invariants the domain-banded sidebar depends on, both of which
// only show up per-role and so are invisible to a super_admin spot-check:
//   1. A band label ('Insights', 'Supply Chain', …) whose every menu is gated
//      away for the viewer must not render — otherwise an employee sees an
//      'Administration' heading over nothing.
//   2. A submenu `separator` whose whole group was filtered out must not
//      render — the role filters in Sidebar.jsx deliberately keep separators
//      (`sub.separator || …`) because they can't know whether a later item in
//      the group survives, so the cleanup has to happen after filtering.

vi.mock('@/services/api/client', () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: {} })), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

const { authState } = vi.hoisted(() => ({ authState: { roles: ['employee'] } }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    roles: authState.roles,
    hasAnyRole: (...r) => r.some(x => authState.roles.includes(x)),
    isEmployeeOnly: authState.roles.length === 1 && authState.roles[0] === 'employee',
    hasPermission: () => false,
    menuAccess: () => null,
  }),
}));

import Sidebar from '@/components/Sidebar';
import { NAV_ITEMS } from '@/config/routes';
import { ORPHAN_NAV_ITEMS, MERGED_ROUTES } from '@/config/autoRouter';
import { PERSONAL_PAGES, ROLE_SECTION_ALLOWLIST, canRoleOpenPage } from '@/config/menuCatalog';

const BAND_LABELS = NAV_ITEMS.filter(i => i.divider).map(i => i.section);

/** Band labels currently in the DOM. Submenu `separator` rows order the
 *  groups inside a flyout but are not rendered, so there is nothing to read. */
function renderedLabels(container) {
  return [...container.querySelectorAll('.sidebar-band-label')].map(el => el.textContent);
}

function renderAs(roles) {
  authState.roles = roles;
  return render(<Sidebar />).container;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('sidebar domain bands', () => {
  it('drops band labels whose every menu is gated away for the role', () => {
    const container = renderAs(['employee']);
    const shown = renderedLabels(container);

    // Employees hold no Insights/Revenue/Supply Chain/Finance/Administration
    // menu at all, so those headings must be absent.
    for (const gone of ['Insights', 'Revenue', 'Supply Chain', 'Finance', 'Administration']) {
      expect(BAND_LABELS).toContain(gone);       // still defined in NAV_ITEMS…
      expect(shown).not.toContain(gone);         // …but not rendered for this role
    }
    // 'People' survives — employees keep HR / Attendance / Leaves / Timesheets.
    expect(shown).toContain('People');
  });

  it('renders every band for super_admin, and never two in a row', () => {
    const container = renderAs(['super_admin']);
    expect(renderedLabels(container).filter(l => BAND_LABELS.includes(l)))
      .toEqual(BAND_LABELS);

    const rows = [...container.querySelectorAll('.sidebar li')];
    rows.forEach((row, i) => {
      if (!row.classList.contains('sidebar-band')) return;
      const next = rows[i + 1];
      expect(next, `band "${row.textContent}" is the last row`).toBeTruthy();
      expect(next.classList.contains('sidebar-band')).toBe(false);
    });
  });
});

describe('curated coverage of every page', () => {
  // Asset Register / Compliance / IoT Fleet / R&D / Tenders had no curated
  // NAV_ITEMS entry and were appended by Sidebar.jsx from ORPHAN_NAV_ITEMS,
  // arriving iconless at the bottom of the rail under a synthetic 'More' band.
  // All five were folded into the curated menu 2026-09-16 (Tenders into CRM;
  // the other four promoted to sections of their own), so ORPHAN_NAV_ITEMS is
  // now empty and the 'More' band is gone. The auto-discovery mechanism stays
  // in place as the backstop: the first test below fails the moment a NEW page
  // file lands with no curated home, which is exactly how ~20 pages went
  // unreachable before.
  it('leaves no page to the auto-discovered orphan fallback', () => {
    expect(ORPHAN_NAV_ITEMS.flatMap(g => g.submenu?.map(s => s.page) ?? [])).toEqual([]);
  });

  it('gives every rail row a real icon — no generic folder fallback', () => {
    const container = renderAs(['super_admin']);
    const rows = [...container.querySelectorAll('.sidebar li:not(.sidebar-band)')];
    expect(rows.length).toBeGreaterThan(33);

    const iconless = rows
      .filter(li => !li.querySelector('.icon svg'))
      .map(li => li.textContent);
    expect(iconless).toEqual([]);
  });

  it('renders no synthetic "· More" group and keeps Administration last', () => {
    const container = renderAs(['super_admin']);
    const rows = [...container.querySelectorAll('.sidebar li')];

    for (const li of rows) expect(li.textContent).not.toContain('· More');
    expect(rows.findIndex(li =>
      li.classList.contains('sidebar-band') && li.textContent === 'More')).toBe(-1);

    const adminBand = rows.findIndex(li =>
      li.classList.contains('sidebar-band') && li.textContent === 'Administration');
    expect(adminBand).toBeGreaterThan(-1);

    // Administration holds two menus. 'User Management' was removed: Users,
    // Roles and Approver Chains are tabs of Settings → Access Control, and the
    // group mounted those same three components a second time.
    const admin = rows.slice(adminBand + 1).map(li => li.textContent);
    expect(admin).toEqual(['Settings', 'Audit Logs']);
  });

  it('points every menu row at a page the router can resolve', () => {
    const rows = NAV_ITEMS.flatMap(item => {
      if (item.divider) return [];
      const own = item.page ? [[item.name, item.page]] : [];
      const subs = (item.submenu || [])
        .filter(s => !s.separator)
        .map(s => [`${item.name} > ${s.name}`, s.page]);
      return [...own, ...subs];
    });
    const dead = rows.filter(([, page]) => !page || !MERGED_ROUTES[page]);
    expect(dead).toEqual([]);
  });

  it('never lists the same page under two menu rows', () => {
    const seen = new Map();
    for (const item of NAV_ITEMS) {
      if (item.divider) continue;
      if (item.page && !item.submenu) seen.set(item.page, [...(seen.get(item.page) || []), item.name]);
      for (const s of item.submenu || []) {
        if (s.separator || !s.page) continue;
        seen.set(s.page, [...(seen.get(s.page) || []), `${item.name} > ${s.name}`]);
      }
    }
    expect([...seen].filter(([, where]) => where.length > 1)).toEqual([]);
  });
});

describe('personal pages stay open to every role', () => {
  // A page that belongs to no NAV section is waved through by
  // canRoleAccessPageBySection ("not part of any section -> defer to other
  // gates"). Give that page a menu row and it inherits that section's
  // allowlist, so a role without the section starts getting Unauthorized on
  // its own profile / requests / dashboard. That is exactly what happened when
  // EmployeeDashboard moved into the 'HR' submenu, and it is invisible until
  // you log in as the one role that lost it — hence this test.
  //
  // PERSONAL_PAGES covers canRoleAccessPageBySection, but NOT the per-role
  // section scopings (canEmployeeAccessPage / canManagerAccessPage / …), which
  // each need the page in their own allowlist. canRoleOpenPage composes all of
  // them, so asserting through it catches whichever one was missed.
  it.each([...PERSONAL_PAGES])('%s opens for every allowlisted role', (page) => {
    const blocked = Object.keys(ROLE_SECTION_ALLOWLIST)
      .filter(role => !canRoleOpenPage(role, page, { menuAccess: () => null }));
    expect(blocked).toEqual([]);
  });
});

describe('submenu separators', () => {
  // finance keeps only My Attendance + QR Attendance out of the 14-item
  // Attendance menu (FINANCE_SELF_SERVICE_PAGES). Separators order the groups
  // in NAV_ITEMS but are never drawn, so the panel holds pages and nothing else.
  it('renders only pages — no group headings — under the finance filter', async () => {
    const container = renderAs(['finance']);
    const attendance = [...container.querySelectorAll('.sidebar li')]
      .find(li => li.textContent.includes('Attendance'));
    expect(attendance).toBeTruthy();

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.mouseEnter(attendance);

    const panel = document.querySelector('.submenu-panel');
    expect(panel).toBeTruthy();
    const items = [...panel.querySelectorAll('.nav-item')].map(b => b.textContent);

    expect(items).toEqual(['My Attendance', 'QR Attendance']);
    // Headings are not rendered at all — the panel is pages only.
    expect(panel.querySelectorAll('.nav-section-label')).toHaveLength(0);
    expect(screen.queryByText('Configuration')).toBeNull();
  });
});
