import { describe, it, expect } from 'vitest';
import { NAV_ITEMS } from '@/config/routes';

/**
 * Every page must be listed in the menu, or be one of a named handful that
 * deliberately is not.
 *
 * autoRouter.js already ships a backstop for this (ORPHAN_NAV_ITEMS, asserted
 * empty in nav.structure.test.jsx), but it cannot see three whole classes of
 * orphan, and all three were occupied when this test was written:
 *
 *   1. `isNavigableOrphan()` exempts every key in the manual ROUTES map
 *      (`manualRouteKeys.has(key)`). A page hand-registered in routes.jsx and
 *      then left out of NAV_ITEMS is therefore invisible to it — which is most
 *      of this codebase's pages.
 *   2. It scans FEATURE_PAGES only. Nothing under `src/pages/*.jsx` is ever
 *      considered.
 *   3. It drops any key matching add/edit/profile/detail/unauthorized/fixture
 *      by name, so a real page named that way is skipped on spelling alone.
 *
 * It also only ever asked "is this page in NAV_ITEMS", which understates
 * coverage: this app reaches ~144 pages as hub TABS and dozens more as a tab
 * rendered by direct component import inside a hub (PayrollCenter renders
 * PayrollForm16 that way — a real, clickable tab with no menu row of its own).
 *
 * So this test walks the actual click graph instead. Roots are the rows the
 * Sidebar draws; edges are the ways one page hands off to another. A page that
 * cannot be reached from any drawn row is unreachable by clicking, however well
 * it is routed.
 */

// Same predicate autoRouter.js uses to decide what is a page module at all.
const NON_PAGE_SUFFIX = /(Panel|Widget|Heatmap|Trend)$/;
const NON_PAGE_FILES = new Set([
  'GenericListPage', 'SetupTable', 'SetupMaster', 'MenuPermissions',
  'VendorProjectImpact', 'PublicSigning', 'CareersPortal',
]);
function isPageModule(key) {
  if (key === 'index' || key.startsWith('_')) return false;
  if (NON_PAGE_SUFFIX.test(key) || NON_PAGE_FILES.has(key)) return false;
  return !/(Utils|Helpers|Constants|Context|Hook)$/.test(key);
}

const keyOf = p => p.split('/').pop().replace(/\.jsx?$/, '');

// Source text, not modules: the graph is built by reading each page's code.
// Importing them for real would execute 490 page modules.
const PAGE_SRC = import.meta.glob(['../features/**/pages/*.jsx', '../pages/*.jsx'], {
  eager: true, query: '?raw', import: 'default',
});
const ROUTES_SRC = import.meta.glob('../config/routes.jsx', {
  eager: true, query: '?raw', import: 'default',
})['../config/routes.jsx'];

const pageFiles = new Map();          // page key -> glob path
for (const path of Object.keys(PAGE_SRC).sort()) {
  const key = keyOf(path);
  if (isPageModule(key) && !pageFiles.has(key)) pageFiles.set(key, path);
}

/**
 * A NAV row names a ROUTES key, and a ROUTES key may load a file of another
 * name — 'TaxManagement' loads TaxPage.jsx, 'TeamLeaves' loads LeaveApprovals.
 * Reachability is a property of the file, so every key is resolved to one.
 */
const routeFile = new Map();
for (const m of ROUTES_SRC.matchAll(/^\s*([A-Za-z0-9_]+):\s*\{[^\n]*?import\(['"]([^'"]+)['"]\)/gm)) {
  routeFile.set(m[1], keyOf(m[2]));
}
const resolveKey = k => routeFile.get(k) || k;

// ── roots: the rows the Sidebar actually draws ───────────────────────────────
// `inHub` rows are skipped by Sidebar.jsx, so they are not roots; they are
// reached through their hub, which this graph has to demonstrate.
const drawnRows = [];
for (const item of NAV_ITEMS) {
  if (item.divider) continue;
  if (item.page) drawnRows.push(item.page);
  for (const sub of item.submenu || []) {
    if (sub.separator || sub.inHub || !sub.page) continue;
    drawnRows.push(sub.page);
  }
}

// ── edges ───────────────────────────────────────────────────────────────────
// Comment lines are stripped first. A page name written in prose is not a link,
// and counting one would let this test pass on the strength of a comment.
function stripComments(src) {
  const kept = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    kept.push(line.replace(/\/\/.*$/, ''));
  }
  return kept.join('\n');
}

const edges = new Map();
function addEdge(from, to) {
  if (to === from || !pageFiles.has(to)) return;
  if (!edges.has(from)) edges.set(from, new Set());
  edges.get(from).add(to);
}

/**
 * A bare page key in quotes is only a link when the line around it is doing
 * navigation. `{ key: 'login', label: 'Login' }` in RolesSetup is a table
 * column, and counting it made the Login screen look reachable from the menu.
 * Imports and `/Path` strings need no such test — neither has an innocent
 * reading.
 */
const NAVIGATIONAL = /\bpage:|\bsetPage\b|\bnavigate\b|\bnavigateTo\b|\bnavPage:|\bwizard:|\bgo\(|\bnav\(|\bto=|\bhref=/;

for (const [key, path] of pageFiles) {
  const src = stripComments(PAGE_SRC[path]);
  // A hub that renders a child page as a tab, statically or lazily.
  for (const m of src.matchAll(/^\s*import\s+[A-Za-z0-9_]+[^'"]*from\s+['"]([^'"]+)['"]/gm)) addEdge(key, keyOf(m[1]));
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g))                          addEdge(key, keyOf(m[1]));
  // navigate(`/ItemDetail?id=${id}`) — the URL form.
  for (const m of src.matchAll(/[`'"]\/([A-Za-z0-9_]+)(?:[?#`'"])/g))                         addEdge(key, resolveKey(m[1]));
  // A page key handed to setPage(), or carried by a tab or tile descriptor
  // ({ page: 'X' }) — only where the line is navigating.
  for (const line of src.split('\n')) {
    if (!NAVIGATIONAL.test(line)) continue;
    for (const m of line.matchAll(/['"`]([A-Z][A-Za-z0-9_]*)['"`]/g))                         addEdge(key, resolveKey(m[1]));
  }
}

const roots = new Set(drawnRows.map(resolveKey).filter(k => pageFiles.has(k)));
const reachable = new Set(roots);
const queue = [...roots];
while (queue.length) {
  for (const next of edges.get(queue.shift()) || []) {
    if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
  }
}

/**
 * The pages that are deliberately not reachable by clicking a menu row, each
 * with the reason. Anything not on this list has to be in the menu.
 *
 * Every entry is asserted below to still exist AND to still be unreachable, so
 * the list cannot quietly rot into a licence for new orphans.
 */
const NOT_IN_MENU = {
  // Rendered by App.jsx / Layout.jsx around the shell, never navigated to.
  Login:                   'login screen — App.jsx renders it when signed out',
  NotFound:                'App.jsx catch-all for an unknown path',
  Unauthorized:            'Layout.jsx renders it when a route gate denies',
  ForcePasswordChange:     'App.jsx forces it when must_change_password is set',

  // Fullscreen routes outside the authenticated shell — a menu row cannot lead
  // to them, because whoever opens them is not signed into the ERP.
  VendorRegistration:      'public vendor self-registration, App.jsx /VendorRegistration',
  CustomerPortalDashboard: 'public customer portal, App.jsx /CustomerPortalDashboard',

  // The menu points at a ROUTES key that loads a DIFFERENT file, so this file
  // is a legacy re-export kept only so old links and bookmarks resolve.
  NativeSignature:         'route key loads DocumentSigning.jsx',
  FieldService:            'route key loads FieldVisitScheduler.jsx',
  TeamLeaves:             "route key loads LeaveApprovals.jsx with initialQueue:'team'",
  MasterConfig:            'merged into MasterSetup; file is a re-export',
  ReportPDC:               're-export of PDCOutstanding',
  PDCOutstanding:          'subset of PDCManagement, live as PaymentBatch → PDC Management',

  // Superseded by a page that covers them; the old URL redirects there
  // (App.jsx). Each target was checked to actually carry the feature — a
  // redirect to a page that does NOT cover the source is how gate passes and
  // visitor management went missing, see the /BiometricAccess note in App.jsx.
  BudgetVsActuals:         'redirects to BudgetManagement, which calls the same /budgets/report/vs-actuals',
  DebitNotes:              "redirects to PayablesPage, which has the 'Debit Notes' tab",
  JournalEntry:            "redirects to AccountingEngine, which has the 'Journal Entries' tab",
  PaymentGateway:          "redirects to PaymentBatch, whose 'Payment Collection' tab renders it",
  PurchaseDashboard:       'redirects to PayablesPage — Supplier Outstanding ages the same bills in more buckets',
  Tickets:                 'redirects to SupportDashboard — same support_tickets table, and it already reads /finance/ticket-categories; SLA policy CRUD is its own menu row',

  // Superseded in place, documented at its ROUTES entry.
  AllCandidates:           'superseded by CandidateWorkbench; kept routable for old links',

  // (MyAnnouncements has no menu row but IS reachable: Home's Announcements card
  // opens it — setPage('MyAnnouncements', { ref }) — as does the bell.)

  // Approved navigation (no menu row by design, 2026-10-22): a pending intern
  // evaluation / probation review is one row of My Pending Approvals — on
  // Home's card and in the Approval Center — and clicking it opens this page.
  // The target is SERVER data (open.page from approvals.sources.js, via
  // /home/summary and /approvals), so no page source names it and this graph
  // cannot draw the edge. The bell reaches both too (notificationTarget.js).
  MyInternEvaluations:     "opened from an approvals row: open.page 'MyInternEvaluations' (approvals.sources.js), and the bell",
  MyProbationReviews:      "opened from an approvals row: open.page 'MyProbationReviews' (approvals.sources.js), and the bell",

};

describe('every page is listed in the menu', () => {
  it('reaches a meaningful share of the app from the drawn rows', () => {
    // Guards the graph itself. If the edge-building above ever silently stops
    // matching, every page becomes "unreachable" and the real assertion below
    // turns into noise instead of a failure worth reading.
    expect(roots.size).toBeGreaterThan(200);
    expect(reachable.size).toBeGreaterThan(450);
  });

  it('leaves no page unreachable from the menu', () => {
    const orphans = [...pageFiles.keys()]
      .filter(k => !reachable.has(k) && !(k in NOT_IN_MENU))
      .sort()
      .map(k => `${k}  (${pageFiles.get(k)})`);
    expect(orphans).toEqual([]);
  });

  it('keeps the not-in-menu list honest — every entry still exists', () => {
    expect(Object.keys(NOT_IN_MENU).filter(k => !pageFiles.has(k))).toEqual([]);
  });

  it('keeps the not-in-menu list honest — no entry is reachable after all', () => {
    // An entry that became reachable is no longer an exception. Leaving it here
    // would exempt that page from this test forever.
    expect(Object.keys(NOT_IN_MENU).filter(k => reachable.has(k))).toEqual([]);
  });

  it('gives every not-in-menu page a reason, not just a name', () => {
    const vague = Object.entries(NOT_IN_MENU).filter(([, why]) => !why || why.length < 20);
    expect(vague.map(([k]) => k)).toEqual([]);
  });
});
