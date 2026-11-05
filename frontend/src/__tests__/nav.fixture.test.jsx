import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NAV_ITEMS } from '@/config/routes';

/**
 * `tests/nav-verify/nav.json` must match NAV_ITEMS.
 *
 * That file is the snapshot the browser sweep asserts against: it drives which
 * sidebar rows get clicked, so a row missing from it is a row nobody checks. Its
 * README says "Regenerate it after changing NAV_ITEMS … or the sweep will check a
 * stale structure and miss newly added rows — exactly how a page added by a
 * parallel session went unchecked until its crash surfaced by accident."
 *
 * There was no generator, and no check either, so "regenerate" was an instruction
 * with nothing behind it. The 2026-09-27 recruitment pass renamed one row and added
 * two, and the drift surfaced only as a 15-minute browser crawl failing on its very
 * last assertion.
 *
 * This closes that loop in the cheap place. It runs in two seconds with the unit
 * suite, and when it fails it prints exactly which rows differ — which is also the
 * text you need to paste into nav.json.
 */

// Derived, not hardcoded: reading it out of NAV_ITEMS is the whole point.
function deriveMenus() {
  const out = [];
  let band = '(workspace)';
  for (const item of NAV_ITEMS) {
    if (!item) continue;
    if (item.divider) { band = item.section || band; continue; }
    if (!item.name) continue;

    const subs = item.submenu || item.children || [];
    out.push({
      name: item.name,
      band,
      page: item.page ?? null,
      // A separator is a heading inside the panel, not a row; an `inHub` row is
      // deliberately not drawn in the sidebar (Sidebar.jsx skips it).
      rows: subs
        .filter(s => s && !s.separator && s.page && !s.inHub)
        .map(s => ({ label: s.name, page: s.page })),
      hubbed: subs
        .filter(s => s && s.inHub && s.page)
        .map(s => ({ page: s.page, hub: s.inHub })),
    });
  }
  return out;
}

const FIXTURE = path.resolve(__dirname, '../../../../tests/nav-verify/nav.json');

describe('nav.json fixture', () => {
  it('exists where the browser sweep looks for it', () => {
    expect(fs.existsSync(FIXTURE), `missing: ${FIXTURE}`).toBe(true);
  });

  it('lists exactly the menus NAV_ITEMS declares, in order', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    expect(fixture.menus.map(m => m.name)).toEqual(deriveMenus().map(m => m.name));
  });

  it('lists exactly the visible ROWS of each menu, in order', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const byName = new Map(fixture.menus.map(m => [m.name, m]));

    // Compared per menu rather than as one big object so a failure names the menu
    // that drifted instead of printing the whole tree.
    for (const want of deriveMenus()) {
      const got = byName.get(want.name);
      expect(got, `nav.json has no menu "${want.name}"`).toBeTruthy();
      expect(
        got.rows.map(r => `${r.label} → ${r.page}`),
        `rows drifted for the "${want.name}" menu`
      ).toEqual(want.rows.map(r => `${r.label} → ${r.page}`));
    }
  });

  it('lists exactly the hub-absorbed pages of each menu', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const byName = new Map(fixture.menus.map(m => [m.name, m]));

    for (const want of deriveMenus()) {
      const got = byName.get(want.name);
      expect(
        got.hubbed.map(h => `${h.page} @ ${h.hub}`).sort(),
        `hub-absorbed pages drifted for the "${want.name}" menu`
      ).toEqual(want.hubbed.map(h => `${h.page} @ ${h.hub}`).sort());
    }
  });

  it('records each menu under the band NAV_ITEMS puts it in', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const byName = new Map(fixture.menus.map(m => [m.name, m]));
    for (const want of deriveMenus()) {
      expect(byName.get(want.name)?.band, `band drifted for "${want.name}"`).toBe(want.band);
    }
  });
});
