# UI/UX Polish Audit — Priority 5

Date: 2026-07-27. Scope: "look at Pulse as if you bought SAP" — beautiful spacing, empty states,
loading states, consistent buttons, breadcrumbs, keyboard shortcuts, filters, exports, search,
responsiveness. **Spacing, color, and button-class consistency are already handled** — a prior "UI
Formatting Consistency" initiative (completed 2026-07-06, see `Pulse/CLAUDE.md`'s UI conventions
section) removed 81 hardcoded `maxWidth` caps, swept blue→brand-purple, standardized
`.pulse-btn-primary`/`.pulse-btn-secondary`, and consolidated design tokens. This audit covers the
remaining 7 items plus responsiveness, which were never audited.

## The headline finding: infrastructure exists, adoption doesn't

Before going category by category, the single most important thing this audit found: for nearly every
criterion below, **a well-built, reusable component already exists in the codebase and is essentially
unused** — every individual page reinvented the same thing ad-hoc instead, each slightly differently. This
isn't "Pulse is missing polish infrastructure" — it's "Pulse built the infrastructure once, then every page
was written as if it hadn't." That changes the fix economics: most of this is a wiring problem, not a
build-from-scratch problem.

| Component that already exists | Real usage found |
|---|---|
| `components/core/EmptyStates.jsx` (`EmptyState`), `SmartEmptyState.jsx` | **0** imports under `features/` |
| `components/core/Skeletons.jsx` (Line/Card/Table/KPI/Chart/Avatar) | 4 consumers, none of them a routed page |
| `components/core/FilterBar.jsx` (select/date/daterange/search/multiselect/radio, documented API) | **0** external usages anywhere in `src/` |
| `components/GlobalSearch.jsx` (command-palette modal, category chips, arrow-key nav) | **0** — never rendered, only mentioned in comments |

---

## Empty states — exists, unused
`EmptyState`/`SmartEmptyState` are real, built components — zero pages import either one. Instead, 14
pages each hand-roll a local `EmptyState` function with a different signature: `AssetMaintenance.jsx:8`
takes `{icon,title,sub,action}`, `AttendanceReports.jsx:48` takes `{msg}`, `Customer360.jsx:144` takes
`{icon='📭', msg}` and reuses it 15+ times for both empty *and* loading states in the same file. ~318 files
show *some* "No X found" text, so the instinct to handle empty states is there — it just never converged on
one look. Visually confirmed in Priority 1's screenshots: Approval Center's "No pending approvals ✅" and
Purchase Requests' "No purchase requests found" both look polished individually, but neither shares markup
with the other.

## Loading states — exists, unused
`Skeletons.jsx` is a genuinely well-built set (line/card/table/KPI/chart/avatar skeletons) — its only 4
consumers are analytics widgets that are themselves never imported by any routed page, i.e. a dead cluster.
143 pages instead show ad-hoc `Loading...` text; 6 pages each define their own local `Spinner()`. Visually
confirmed: Sales Command Center's Executive tab was still showing "Loading Sales Intelligence…" a second
after landing — with no shared skeleton, a slow load just reads as a stuck page.

## Filters — exists, unused
`FilterBar.jsx` supports select/date/daterange/search/multiselect/radio behind one documented, controlled
API — zero external usages. 47 pages hand-roll filter state via local `useState`, each with its own markup:
`EmployeesData.jsx`, `AllLeaves.jsx:570`, `LeaveApprovals.jsx:323,497`, `TeamLeaves.jsx:127`,
`Reports.jsx:176` all build distinct filter rows for the same underlying idea.

## Search — two problems stacked: the good component is unused, and the used one is duplicated
`GlobalSearch.jsx` — a fully-built command-palette modal — is never rendered anywhere; referenced only in
comments (`autoRouter.js:414`, `Topbar.jsx:81`). What the topbar actually calls is `GET /global-search`
(a real, capable entity search across employees/BOMs/production orders/customers/projects/complaints/
invoices/inventory — `backend/src/modules/search/global-search.routes.js`). That endpoint itself overlaps
with a second, less-capable backend search found during the Priority 4 AI-opportunity research
(`GET /api/ai/smart-search`, covering only employees/invoices/projects/leads/inventory). Two competing
implementations of the same job, neither one retired — the identical "build one, then build a second, never
converge" pattern already seen repeatedly in the Priority 2 business-process research (duplicate ticket
tables, duplicate AMC-contract tables, duplicate warranty tables). Separately, 141 pages implement their own
local "Search..." input for filtering an on-page list/table — reasonable on its own, just uncoordinated with
the global search.

## Exports — no shared utility at all
Unlike the above, this isn't "built but unused" — there is genuinely no `utils/export*.js`. At least 10
files (`ERPIntelligence.jsx`, `AttendanceAnalytics.jsx`, `AttendanceReports.jsx`, `GeoViolationsReport.jsx`,
`OvertimeApprovals.jsx`, `PayrollSync.jsx`, `AuditLogs.jsx`, `CRMReports.jsx`, `EmployeesData.jsx`,
`ExEmployees.jsx`) each redefine `exportCSV`/`exportToCsv` from scratch, with the same blob-and-anchor
download logic copy-pasted each time. The Reports & Analytics catalog page's own subtitle promises
"Generate, filter and export business reports" — export is clearly an intended, expected capability, just
not backed by one implementation.

## Breadcrumbs — genuinely missing
No component, no convention — zero mentions anywhere in `Layout.jsx`/`Topbar.jsx`/`Sidebar.jsx`. Confirmed
visually across every page sampled in Priority 1: the only wayfinding device on any page is a plain
"← Back" button. That's fine for one level of nesting but gives no sense of place on anything deeper
(e.g. `EmployeeProfile`, `Customer360`) — there's no trail back to "Home › HR › Employees" the way an
SAP-style breadcrumb would show.

## Keyboard shortcuts — genuinely missing
No shortcut library in `package.json` (no hotkeys-js/Mousetrap-equivalent), no global keydown dispatcher,
no command-palette trigger. The only 8 `keydown` listeners in the whole frontend are narrow, local
Escape-to-close handlers (`ChartWrapper.jsx`, `ConfirmDialog.jsx`, `DashCard.jsx`, `OvertimeApprovals.jsx`,
`EmployeeDocuments.jsx`, `Shifts.jsx`) plus arrow-key photo navigation in one celebrations widget. Nothing
resembling Cmd/Ctrl-K, "g then h" navigation, or any of the shortcut conventions "SAP-grade" implies.

## Responsiveness — desktop-only in practice, and it undercuts a feature you've already shipped
- The viewport meta tag is correct, and 90 of 145 CSS files have *some* `@media` query — mostly page-level
  grid reflow via generic rules in `global-overrides.css`.
- But the **app shell has none**: `Layout.css` and `Sidebar.css` — zero `@media` queries. `Topbar.css` has
  exactly 2, both purely cosmetic (hide the brand wordmark at 640px, shrink the logo at 480px) — no actual
  nav restructuring at any width.
- **The sidebar's hover-triggered flyout menu has no touch fallback whatsoever** — it's driven entirely by
  `onMouseEnter`/`onMouseLeave` (confirmed during Priority 1's crawler build, where this same hover-only
  design caused real automation flakiness). There's no `onTouchStart`, no hamburger-menu alternative, no
  `matchMedia`/`isMobile` check anywhere in `components/`. A touch device has no hover state at all — every
  submenu, i.e. almost the entire app beyond the 10-20 top-level sidebar icons, is structurally unreachable.
- Table overflow is incidental, not systemic: pages following a `*-table-wrap`/`*-table-scroll` naming
  convention get `overflow-x:auto` for free from a generic rule, but `Reports.jsx`'s own Trial
  Balance/Aging tables sit inside a container explicitly set to `overflow:hidden` — those would clip, not
  scroll, on a narrow screen.
- **This matters more than a typical responsiveness gap because a native mobile app already exists and
  depends on the opposite being true.** The Capacitor wrapper (`frontend/capacitor.config.ts`,
  `frontend/MOBILE.md`) is this same web frontend running in a native WebView — not a separate mobile
  build. Its own documentation justifies skipping a dedicated mobile UI with "Because Pulse is already
  responsive..." This audit shows that premise doesn't hold for the primary navigation. Anyone using the
  already-shipped native app on a phone likely can't reach most of the app's functionality today.

## Two concrete bugs spotted while looking (not part of the 9 criteria, but real)
- **Stacked, mislabeled toast notifications**: a screenshot of the My Timesheet page showed two overlapping
  error toasts reading "Failed to load candidates" — on closer inspection (while fixing the `MyTimesheet`
  404 below) this text doesn't come from the Timesheet page itself; it's a leftover toast from Talent/
  Resume Database (the previous page visited in that crawl), still on screen after navigating away. Toast
  state isn't cleared/scoped per route change, so a slow-to-dismiss toast from one page can visually
  overlap whatever page the user has since moved to. Corrected from the original framing in this doc, which
  attributed it to the Timesheet page itself.
- **Unguarded division by zero**: a Projects dashboard card literally displays "NaN%" for a project with
  0 total tasks, instead of falling back to "0%" or "—".

---

## Suggested priority order
1. **The touch-hostile shell nav** — this isn't cosmetic, it silently undermines a feature (the native
   mobile app) that's already been built and shipped. Worth flagging to leadership even before scoping a
   fix, since the fix (a real mobile nav pattern, not just CSS tweaks) is a bigger piece of work than
   anything else on this list.
2. **Wire up what already exists** — rendering `<GlobalSearch/>` behind a Cmd/Ctrl-K binding, and adopting
   `EmptyState`/`Skeletons`/`FilterBar` on a handful of the highest-traffic pages, is a small, contained
   change per page precisely because the hard part (building the component) is already done. A good pilot
   set: Employees, Leaves, Inventory, Reports — all already sampled in this audit.
3. **Consolidate the two competing search backends** (`/global-search` vs `/api/ai/smart-search`) before
   building anything new on top of either.
4. **Breadcrumbs and a shared export utility** — genuinely net-new builds, sized accordingly; not urgent
   enough to go before item 1 or 2.
5. **Keyboard shortcuts** — lowest user-facing urgency of the 9 criteria; reasonable to defer until after
   the above.
6. Fix the two spotted bugs (toast stacking/mislabeling, NaN%) opportunistically alongside whichever page
   they live on gets touched next.

This pass is an audit, not a rebuild — consistent with how the automation and AI-opportunity priorities
were scoped earlier. Rolling any of the above out across all ~259 pages is a multi-week effort; the
adoption-wiring pilot in item 2 is offered as a natural, bounded next step once this is reviewed.
