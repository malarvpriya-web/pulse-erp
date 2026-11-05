/**
 * masterAdminLinks.test.jsx — "where do I edit this?" is answered correctly
 * (2026-09-29).
 *
 * TWO FIXTURES THAT GO STALE SILENTLY
 * -----------------------------------
 * 1. `masterAdminLinks.js` maps a picker endpoint to a Master Data TAB. If
 *    someone renames a tab key, the link keeps rendering and lands on the
 *    wrong tab — or on the fallback — and nothing in a diff says so.
 * 2. `pagesWithOwnBack.js` tells the Topbar to suppress its Back button. A page
 *    that grows or loses its own back control leaves the list wrong, and the
 *    symptom is either two Back buttons or none.
 *
 * Both are checked against the SOURCE rather than against a second copy of the
 * expectation — the same guard `nav.fixture.test.jsx` puts on the sidebar
 * fixture, for the same reason.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { masterAdminFor, MASTER_ADMIN, pluralise, ADMIN_GROUP, MASTER_DATA_PATH,
         EMPLOYEE_MASTERS_PATH } from '@/components/core/masterAdminLinks';
import { NAV_ITEMS } from '@/config/routes';
import { EMPLOYEE_MASTER_TABS } from '@/features/admin/pages/MasterSetup';

const SRC = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const SETUP   = read('features/admin/pages/MasterSetup.jsx');
const TOPBAR  = read('components/Topbar.jsx');
const SELECT  = read('components/core/MasterSelect.jsx');

/** Tab keys MasterSetup declares statically. Vocabulary tabs are `v:<key>`. */
const staticTabKeys = [...SETUP.matchAll(/\{\s*key:\s*'([^']+)'/g)].map(m => m[1]);

// ═════════════════════════════════════════════════════════════════════════════
describe('every mapped tab exists in Master Data Setup', () => {
  it('found the tab list it means to check', () => {
    // A refactor that made this test parse nothing would otherwise pass.
    expect(staticTabKeys).toEqual(expect.arrayContaining(
      ['departments', 'designations', 'zones', 'grades', 'bands']));
  });

  // ⚠ The title stays on the `it.each(...)` line. Broken onto the next line it
  // reads as `it.each(...)` followed by a separate parenthesised expression —
  // eslint's no-unexpected-multiline, and the exact shape ASI hazards take.
  it.each(Object.entries(MASTER_ADMIN).filter(([, v]) => v.page === 'MasterSetup'))(
    '%s -> a real MasterSetup tab',
    (_endpoint, target) => {
      expect(staticTabKeys, `no tab keyed "${target.tab}"`).toContain(target.tab);
    },
  );

  it('vocabularies resolve by RULE, so a new one needs no edit here', () => {
    // MasterSetup keys vocabulary tabs `v:<registry key>` and builds them from
    // GET /master/v. Hard-coding each one here would reintroduce the second
    // copy this whole module exists to avoid.
    // ⚠ Banks and asset types are EMPLOYEE masters, so they route to the
    // Employees-area door. The rule under test is the TAB KEY derivation,
    // which is identical either way.
    expect(masterAdminFor('/master/v/banks', 'Bank')).toMatchObject({
      page: 'EmployeeMasters', tab: 'v:banks', plural: 'Banks',
    });
    expect(masterAdminFor('/master/v/asset-types', 'Asset Type')).toMatchObject({
      tab: 'v:asset-types', plural: 'Asset Types',
    });
    // A non-employee vocabulary derives its key the same way, via Settings.
    expect(masterAdminFor('/master/v/industries', 'Industry')).toMatchObject({
      page: 'MasterSetup', tab: 'v:industries', plural: 'Industries',
    });
    // …and MasterSetup really does key them that way.
    expect(SETUP).toMatch(/key: 'v:' \+ v\.key/);
  });

  it('a two-level vocabulary keeps its parent query out of the tab key', () => {
    expect(masterAdminFor('/master/v/expense-categories?parent=Travel', 'Expense Category'))
      .toMatchObject({ tab: 'v:expense-categories' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the path we tell users to follow is the path that exists', () => {
  /** The sidebar group that actually contains Master Data. */
  const groupContaining = (page) =>
    NAV_ITEMS.find(g => g.page === page || g.submenu?.some(i => i.page === page))?.name;

  it('names the real sidebar group', () => {
    // ⚠ The pages' heroes said "Administration" while the sidebar group is
    // "Settings", so every link read "Administration → Master Data" — a menu
    // that does not exist. The group could not be renamed to match: NAV_ITEMS
    // group names are permission keys.
    expect(groupContaining('MasterDataCenter')).toBe(ADMIN_GROUP);
    expect(MASTER_DATA_PATH).toBe(`${ADMIN_GROUP} → Master Data`);
  });

  it('Master Data really is a row in that group', () => {
    const group = NAV_ITEMS.find(g => g.name === ADMIN_GROUP);
    expect(group, `no sidebar group named "${ADMIN_GROUP}"`).toBeTruthy();
    expect(group.submenu.some(i => i.name === 'Master Data' && i.page === 'MasterDataCenter')).toBe(true);
  });

  it('Branches really is reached through Company Setup', () => {
    const t = masterAdminFor('/branches', 'Location');
    expect(t.where).toBe('Settings → Company Setup → Branch Management');
    // BranchManagement is a tab of the CompanySetup hub, which is a row in the
    // same group — so every hop in that sentence is real.
    const group = NAV_ITEMS.find(g => g.name === ADMIN_GROUP);
    expect(group.submenu.some(i => i.page === 'CompanySetup')).toBe(true);
    const branchRow = group.submenu.find(i => i.page === 'BranchManagement');
    expect(branchRow?.inHub).toBe('CompanySetup');
  });

  it('no link text mentions a group that does not exist', () => {
    const names = NAV_ITEMS.map(g => g.name);
    for (const endpoint of [...Object.keys(MASTER_ADMIN), '/master/v/banks']) {
      const where = masterAdminFor(endpoint, 'Bank').where;
      const head = where.split(' → ')[0];
      expect(names, `"${where}" starts with a group that is not in the sidebar`).toContain(head);
    }
  });

  it("the screens' own heroes agree with the sidebar", () => {
    // A hero reading "Administration" over a page reached from "Settings" is
    // the inconsistency that produced the wrong link text in the first place.
    // MasterSetup's hero is overridable now (Employee Masters supplies its
    // own), so the assertion is on the DEFAULT.
    expect(SETUP).toMatch(/eyebrow=\{hero\?\.eyebrow \?\? "Settings"\}/);
    expect(SETUP).not.toMatch(/"Administration"/);
    const BRANCH_UI = read('features/admin/pages/BranchManagement.jsx');
    expect(BRANCH_UI).toMatch(/eyebrow="Settings"/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Branch is routed to its own screen, not a vocabulary tab', () => {
  it('points at Settings → Company Setup → Branch Management', () => {
    const t = masterAdminFor('/branches', 'Location');
    expect(t).toMatchObject({ page: 'BranchManagement', tab: null, plural: 'Locations' });
    expect(t.where).toBe('Settings → Company Setup → Branch Management');
  });

  it('has no MasterSetup tab claiming to edit branches', () => {
    // There IS a "Branches / Locations" tab, but it is a POINTER — a
    // SimpleListTab over /branches would offer a rename that drops the code,
    // address, type and contact details.
    expect(SETUP).toMatch(/function BranchesPointer/);
    expect(SETUP).not.toMatch(/SimpleListTab endpoint="\/branches"/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('pluralisation reads like English', () => {
  it.each([
    ['Bank', 'Banks'],
    ['Department', 'Departments'],
    ['Designation', 'Designations'],
    ['Qualification', 'Qualifications'],
    ['Skill Type', 'Skill Types'],
    ['Asset Type', 'Asset Types'],
    ['Employment Type', 'Employment Types'],
    ['Industry', 'Industries'],
    ['Expense Category', 'Expense Categories'],
    ['Class', 'Classes'],
  ])('%s -> %s', (one, many) => expect(pluralise(one)).toBe(many));
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the picker renders a real navigation control', () => {
  it('uses a <button>, not an <a href>', () => {
    // The app navigates with setPage; an <a href> would full-page reload out of
    // the SPA. A <div onClick> would lose Enter/Space.
    expect(SELECT).toMatch(/function ManageLink/);
    const block = SELECT.slice(SELECT.indexOf('function ManageLink'), SELECT.indexOf('const S = {'));
    expect(block).toMatch(/<button\s/);
    expect(block).not.toMatch(/<a\s+href/);
  });

  it('degrades to prose when no navigator is supplied', () => {
    // Dropping the line entirely would hide the answer from exactly the screens
    // least likely to make it obvious.
    const block = SELECT.slice(SELECT.indexOf('function ManageLink'), SELECT.indexOf('const S = {'));
    expect(block).toMatch(/if \(!onNavigate\)/);
    expect(block).toMatch(/DEGRADES TO PROSE/);
  });

  it('carries a stable hook for the browser tests', () => {
    expect(SELECT).toMatch(/data-master-manage=/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('exactly one Back button — the standard Topbar one', () => {
  /** Page components that draw their own back control. */
  const pagesRenderingOwnBack = () => {
    const found = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.jsx')) continue;
        if (/className="add-page-back-btn"/.test(fs.readFileSync(full, 'utf8'))) {
          found.add(entry.name.replace(/\.jsx$/, ''));
        }
      }
    };
    walk(path.join(SRC, 'features'));
    return found;
  };

  it('the Topbar back button is unconditional, as it is on every other page', () => {
    // ⚠ REVERTED 2026-09-29. An earlier attempt suppressed the Topbar button on
    // pages that drew their own; that was backwards. The Topbar's IS the
    // standard control in Pulse — the page-level duplicate was the thing to go.
    expect(TOPBAR).toMatch(/currentPage && currentPage !== 'Home' && \(/);
    expect(TOPBAR).not.toMatch(/topbarShowsBack/);
    expect(TOPBAR).not.toMatch(/pagesWithOwnBack/);
  });

  it('no page-level back-button exception module survives', () => {
    expect(fs.existsSync(path.join(SRC, 'config/pagesWithOwnBack.js'))).toBe(false);
  });

  it('the employee forms draw NO back button of their own', () => {
    const own = pagesRenderingOwnBack();
    expect([...own], 'a page still renders a duplicate Back button').toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('employee masters are managed from the Employees area', () => {
  it('"Manage X" sends HR to Employee Masters, not into Settings', () => {
    // The point of the second door: HR fixing a mistyped designation should not
    // be sent into an administrator's Settings menu.
    for (const [endpoint, label, tab] of [
      ['/master/departments',        'Department',      'departments'],
      ['/master/designations',       'Designation',     'designations'],
      ['/master/zones',              'Zone',            'zones'],
      ['/master/grades',             'Grade',           'grades'],
      ['/master/bands',              'Band',            'bands'],
      ['/master/v/employment-types', 'Employment Type', 'v:employment-types'],
      ['/master/v/asset-types',      'Asset Type',      'v:asset-types'],
      ['/master/v/banks',            'Bank',            'v:banks'],
      ['/master/v/qualifications',   'Qualification',   'v:qualifications'],
      ['/master/v/skill-types',      'Skill Type',      'v:skill-types'],
    ]) {
      const t = masterAdminFor(endpoint, label);
      expect(t.page, endpoint).toBe('EmployeeMasters');
      expect(t.tab, endpoint).toBe(tab);
      expect(t.where, endpoint).toContain(EMPLOYEE_MASTERS_PATH);
    }
  });

  it('a NON-employee master still routes to Settings', () => {
    // HSN/SAC and UOM belong to Items & Tax, not to HR.
    expect(masterAdminFor('/master/hsn', 'HSN').page).toBe('MasterSetup');
    expect(masterAdminFor('/master/hsn', 'HSN').where).toContain(MASTER_DATA_PATH);
    expect(masterAdminFor('/master/v/industries', 'Industry').page).toBe('MasterSetup');
  });

  it('Employee Masters is NOT a row in the Employees menu, but All Employees links to it', () => {
    // Removed from the sidebar on request; the page is reached from the
    // All Employees "Manage Employee Masters" button instead.
    const emp = NAV_ITEMS.find(g => g.name === 'Employees');
    expect(emp, 'no Employees menu group').toBeTruthy();
    expect(emp.submenu.some(i => i.page === 'EmployeeMasters')).toBe(false);
    expect(emp.submenu.some(i => i.page === 'EmployeesData')).toBe(true);
    const ED = read('features/employees/pages/EmployeesData.jsx');
    expect(ED).toMatch(/setPage\('EmployeeMasters'\)/);
    expect(ED).toMatch(/Manage Employee Masters/);
  });

  it('every tab it claims to show is a real MasterSetup tab', () => {
    const vocabKeys = EMPLOYEE_MASTER_TABS.filter(k => k.startsWith('v:'));
    const staticKeys = EMPLOYEE_MASTER_TABS.filter(k => !k.startsWith('v:'));
    for (const k of staticKeys) expect(staticTabKeys, k).toContain(k);
    // Vocabulary tabs are built from GET /master/v at runtime, so the contract
    // is the KEY SHAPE, which MasterSetup constructs as `v:<registry key>`.
    for (const k of vocabKeys) expect(k).toMatch(/^v:[a-z-]+$/);
    expect(SETUP).toMatch(/key: 'v:' \+ v\.key/);
  });

  it('it REUSES MasterSetup rather than reimplementing it', () => {
    // ⚠ The one thing that must never happen here: a second master editor.
    const EM = read('features/employees/pages/EmployeeMasters.jsx');
    expect(EM).toMatch(/import MasterSetup/);
    expect(EM).toMatch(/only=\{EMPLOYEE_MASTER_TABS\}/);
    // No API calls, no list rendering, no state of its own.
    expect(EM).not.toMatch(/api\./);
    expect(EM).not.toMatch(/useState|useEffect/);
  });

  it('Branches stay out of it — they are an entity', () => {
    expect(EMPLOYEE_MASTER_TABS).not.toContain('branches');
    expect(masterAdminFor('/branches', 'Location').page).toBe('BranchManagement');
  });

  it('Settings → Master Data still shows everything', () => {
    // Departments, designations, zones, grades and bands are consumed by
    // recruitment, projects, CRM and travel policy too. Removing their tabs
    // from the administrator's screen would take the UI away from those owners.
    expect(SETUP).toMatch(/const TABS = only/);
    expect(staticTabKeys).toEqual(expect.arrayContaining(['departments', 'uom', 'hsn']));
  });
});
