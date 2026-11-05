import { describe, it, expect } from 'vitest';
import { NAV_ITEMS } from '@/config/routes';
import { MERGED_ROUTES } from '@/config/autoRouter';
import { getSectionForPage } from '@/config/menuCatalog';

// The 2026-09-16 IA pass collapsed 136 submenu rows into 34 tabbed hub pages.
// Each absorbed page keeps its NAV_ITEMS entry marked `inHub: '<HubKey>'`, so
// getSectionForPage() still resolves it, and the sidebar simply does not draw
// the row.
//
// That arrangement has one failure mode, and it is silent: mark a row `inHub`
// and forget to add it to the hub's TABS, and the page is no longer reachable
// by ANY click — it is not in the sidebar and not in the hub either. It would
// still resolve by URL, so nothing else in the suite would notice. These tests
// close that loop from both directions.

// Eager so the assertions can read each hub's TABS synchronously; the app
// itself still lazy-loads them through routes.jsx.
const HUB_MODULES = import.meta.glob('../features/*/pages/*.jsx', { eager: true });

function hubTabs(hubKey) {
  const entry = Object.entries(HUB_MODULES).find(([p]) => p.endsWith(`/${hubKey}.jsx`));
  return entry?.[1]?.TABS ?? null;
}

const rows = NAV_ITEMS.flatMap(item =>
  item.divider ? [] : (item.submenu || [])
    .filter(s => !s.separator && s.page)
    .map(s => ({ ...s, group: item.name })));

const hubbed = rows.filter(r => r.inHub);
const visible = rows.filter(r => !r.inHub);

describe('hub consolidation', () => {
  it('absorbs a meaningful number of rows', () => {
    // Guards against the whole `inHub` mechanism being silently dropped.
    expect(hubbed.length).toBeGreaterThan(100);
  });

  it.each(hubbed.map(r => [r.page, r.inHub]))(
    '%s is an actual tab of %s',
    (page, hub) => {
      const tabs = hubTabs(hub);
      expect(tabs, `${hub} exports no TABS`).toBeTruthy();
      expect(tabs.map(t => t.page)).toContain(page);
    });

  it('every hub named by a row is itself a visible row in the same group', () => {
    // This is what keeps the path to a consolidated page at two clicks: open
    // the hub from the sidebar, then its tab.
    const orphanHubs = hubbed.filter(r =>
      !visible.some(v => v.page === r.inHub && v.group === r.group));
    expect(orphanHubs.map(r => `${r.group} > ${r.page} -> ${r.inHub}`)).toEqual([]);
  });

  it('every hub tab has a NAV entry, so its section still resolves', () => {
    // The mirror of the test above. A tab with no NAV_ITEMS row resolves to
    // section `null`, and canRoleAccessPageBySection then waves it through for
    // every role — the exact gate-loosening this design exists to avoid.
    const hubKeys = [...new Set(hubbed.map(r => r.inHub))];
    const missing = [];
    for (const hub of hubKeys) {
      for (const tab of hubTabs(hub) || []) {
        if (!getSectionForPage(tab.page)) missing.push(`${hub} > ${tab.page}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('routes every hub with its module key', () => {
    // An auto-discovered route carries no `module`, so Layout.jsx's module gate
    // would never fire for the hub even though every page inside it has one.
    const hubKeys = [...new Set(hubbed.map(r => r.inHub))];
    const unrouted = hubKeys.filter(k => !MERGED_ROUTES[k]);
    expect(unrouted).toEqual([]);
  });

  it('never gates a hub more strictly than the pages it absorbs', () => {
    // A hub renders its children directly, so Layout's module gate runs on the
    // HUB's route, not theirs. Give the hub a `module` that any child lacks and
    // that child becomes unreachable for roles that could open it on its own —
    // EmployeeRecords with module:'hr' locked employees out of Documents,
    // Assets, Policies and HR Documents, none of which is module-gated.
    // TabHub re-applies each tab's own module, so this costs no protection.
    const offenders = [];
    for (const hub of [...new Set(hubbed.map(r => r.inHub))]) {
      const hubModule = MERGED_ROUTES[hub]?.module;
      if (!hubModule) continue;
      for (const tab of hubTabs(hub) || []) {
        if (MERGED_ROUTES[tab.page]?.module !== hubModule) {
          offenders.push(`${hub} (module: ${hubModule}) > ${tab.page} (module: ${MERGED_ROUTES[tab.page]?.module ?? 'none'})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every visible submenu scannable', () => {
    const oversized = NAV_ITEMS
      .filter(i => !i.divider && Array.isArray(i.submenu))
      .map(i => [i.name, i.submenu.filter(s => !s.separator && !s.inHub).length])
      // 13, not 12: HR reached 13 when Probation Management and Exit
      // Management were split into separate rows (2026-10-30) — two distinct
      // workflows sharing one hub row confused people more than a 13th row does.
      .filter(([, n]) => n > 13);
    expect(oversized).toEqual([]);
  });
});
