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

const BAND_LABELS = NAV_ITEMS.filter(i => i.divider).map(i => i.section);

/** Band labels + submenu separators currently in the DOM. */
function renderedLabels(container) {
  return [
    ...container.querySelectorAll('.sidebar-band-label'),
    ...document.querySelectorAll('.nav-section-label'),
  ].map(el => el.textContent);
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

describe('auto-discovered orphan groups', () => {
  // Asset Register / Compliance / IoT Fleet / R&D / Tenders have no curated
  // NAV_ITEMS entry, so Sidebar.jsx appends them from ORPHAN_NAV_ITEMS. They
  // used to arrive with no `icon` (generic folder fallback) at the very bottom
  // of the rail, which after banding read as part of 'Administration'.
  it('gives every rail row a real icon — no generic folder fallback', () => {
    const container = renderAs(['super_admin']);
    const rows = [...container.querySelectorAll('.sidebar li:not(.sidebar-band)')];
    expect(rows.length).toBeGreaterThan(33);

    const iconless = rows
      .filter(li => !li.querySelector('.icon svg'))
      .map(li => li.textContent);
    expect(iconless).toEqual([]);
  });

  it('puts orphan groups in their own band, above Administration', () => {
    const container = renderAs(['super_admin']);
    const rows = [...container.querySelectorAll('.sidebar li')];
    const labelAt = i => rows[i].textContent;

    const moreBand = rows.findIndex(li =>
      li.classList.contains('sidebar-band') && li.textContent === 'More');
    const adminBand = rows.findIndex(li =>
      li.classList.contains('sidebar-band') && li.textContent === 'Administration');

    expect(moreBand).toBeGreaterThan(-1);
    expect(adminBand).toBeGreaterThan(moreBand);

    // Everything between the two bands is an orphan module, shown without the
    // "· More" disambiguation suffix that its permission key still carries.
    const between = rows.slice(moreBand + 1, adminBand).map((_, i) => labelAt(moreBand + 1 + i));
    expect(between.length).toBeGreaterThan(0);
    for (const label of between) expect(label).not.toContain('· More');

    // Administration itself holds only the three admin menus.
    const admin = rows.slice(adminBand + 1).map(li => li.textContent);
    expect(admin).toEqual(['User Management', 'Settings', 'Audit Logs']);
  });
});

describe('submenu separators', () => {
  // finance keeps only My Attendance + QR Attendance out of the 14-item
  // Attendance menu (FINANCE_SELF_SERVICE_PAGES) — every one of its four group
  // headings would otherwise be left labelling nothing.
  it('strips headings left empty by the finance self-service filter', async () => {
    const container = renderAs(['finance']);
    const attendance = [...container.querySelectorAll('.sidebar li')]
      .find(li => li.textContent.includes('Attendance'));
    expect(attendance).toBeTruthy();

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.mouseEnter(attendance);

    const panel = document.querySelector('.submenu-panel');
    expect(panel).toBeTruthy();
    const items = [...panel.querySelectorAll('.nav-item')].map(b => b.textContent);
    const heads = [...panel.querySelectorAll('.nav-section-label')].map(b => b.textContent);

    expect(items).toEqual(['My Attendance', 'QR Attendance']);
    expect(heads).toEqual([]);            // no 'Team & Monitoring' / 'Approvals' / …
    expect(screen.queryByText('Configuration')).toBeNull();
  });
});
