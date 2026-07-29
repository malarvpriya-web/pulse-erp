# Role → Navigation Visibility: Mechanism & Findings

## Methodology
How this was verified, and the role map used

Every claim below was traced through the code that actually renders the app for a
signed-in user — not inferred from naming or from the permissions the backend
grants. This is a static trace, not a click-through in a browser as each of the 26
roles; where a live QA pass would add confidence, that's called out. Nothing here
proposes a backend, database, or API change — only what a given login sees, can
reach, and is asked to think about.

## What actually decides visibility (traced end to end)

| Layer | File | Governs |
|---|---|---|
| Sidebar rendering | `components/Sidebar.jsx` | Which top-level sections + submenu items render, per role held |
| Section allowlist | `config/menuCatalog.js` | Explicit section list for manager / hr / finance / employee **and 20 other granular roles** — see correction below |
| Route guard | `components/Layout.jsx:63–118` | Blocks direct-URL access even when a section is hidden from the menu |
| Dashboard | `pages/Home.jsx` + backend `home.service.js` | What every role sees on landing (still binary: Employee vs everyone else, plus an extra console strip for super_admin) |
| Global search | `components/Topbar.jsx` / `components/GlobalSearch.jsx` | Page index surfaced to every role — **now filtered, see correction below** |
| Admin override | `menu_permissions` / `user_menu_permissions` tables | Per-role or per-user Hidden / View / Edit override — already built, zero-code to use |
| Unused registry | `config/moduleRegistry.js` + `hooks/useModuleRegistry.js` | A second, better-curated per-role map with no live consumer (F1) — **already deleted, see correction below** |

## Correction — two rows in the map above are stale as of today (2026-07-28)

Re-verifying the table against the current working tree turned up two rows that
have already moved since this map was drawn. Both are improvements, not new
problems, but the table above needs updating to reflect them rather than treating
them as still-open gaps:

- **F1 (unused registry) — already fixed, 2026-07-22.** `config/moduleRegistry.js`,
  `hooks/useModuleRegistry.js`, and `components/ModuleGuard.jsx` no longer exist —
  removed in commit `f69c17c` ("Remove dead module-registry access-control
  subsystem"), along with the one test that checked drift against it
  (`routeIntegrity.test.js`). The commit message confirms the read that led to F1:
  `ModuleGuard` was never rendered anywhere, so nothing at runtime ever consulted
  that second registry — real gating lived in `menuCatalog.js` the whole time. This
  matches [[project_nav_module_gating_audit]] in memory. Nothing left to fix here;
  the row exists in this table only as a citation for how F1 was originally found.
- **Global search — already filtered, not "unfiltered."** Both search surfaces now
  gate on role before advertising a page by name:
  - `Topbar.jsx:82-85` — `searchablePages = SEARCH_PAGES.filter(p =>
    canRoleOpenPage(role, p.page, { menuAccess }))`, with a comment noting it
    "mirrors the same check GlobalSearch.jsx runs for the command-palette search."
  - `GlobalSearch.jsx:190` — same `canRoleOpenPage(role, p.page, { menuAccess })`
    filter over `SEARCHABLE_PAGES`.

  `canRoleOpenPage()` (`menuCatalog.js:597-613`) is a single predicate that
  composes every page-name-level gate that exists elsewhere in the app — the
  Page-Access override, the employee/hr/finance/hr_exec/manager self-service
  scopings, admin-only, super-admin-only, and the section allowlist — specifically
  so a search surface can't advertise a page (Setup Wizard, Master Setup, Leave
  Approvals, …) that the viewer's own role could never open. This is a genuine,
  well-built fix for exactly the gap this table originally flagged; it is not
  currently reflected in `GlobalSearch.jsx`'s git status as committed — it's part
  of the same uncommitted working-tree change as the Talent→Recruitment merge
  below, so it hasn't shipped yet, but it exists and is correct.

## Discovered in the process: an in-flight refactor changes the role map's numbers

The working tree has an uncommitted rename of `frontend/src/features/talent/` →
`frontend/src/features/recruitment/` (staged) plus a `menuCatalog.js`/`routes.jsx`
edit (unstaged) that drops `'Talent'` as its own top-level NAV section and folds
those pages into `'Recruitment'`. Confirmed via `git diff`:

```
-    'Leaves', 'Timesheets', 'Performance', 'Recruitment', 'Talent', 'Reports',
+    'Leaves', 'Timesheets', 'Performance', 'Recruitment', 'Reports',
```

(same one-line removal repeated for `hr`, `hr_manager`, and `hr_exec`). Effects:

- Top-level `NAV_ITEMS` count: **33 today** (was 34 in the 2026-07-23 snapshot in
  `ROLE_SIDEBAR_REACHABILITY_AUDIT.md`) — Home + 32 configurable sections, not 33.
- `hr`, `hr_manager`, `hr_exec` each lose exactly one section count (Talent folded
  into Recruitment) versus that same snapshot: hr 19→18, hr_manager 15→14,
  hr_exec 13→12. No other role's count changed.
- This plausibly addresses the P1 finding in `ROLE_DAY_IN_LIFE_AUDIT.md`
  ("`ResumeDatabase` → `GET /api/talent/resumes` → 500") — a folder rename alone
  wouldn't fix a 500 by itself, so treat that as a hypothesis to re-verify after
  the merge lands, not a confirmed fix.
- This change is **uncommitted**. The per-role table below reflects the working
  tree as it stands right now (post-merge numbers), not the last commit — worth
  knowing before quoting these counts anywhere durable.

## Current per-role reachability (26 roles — 24 allowlisted + super_admin + admin)

Recomputed directly from `ROLE_SECTION_ALLOWLIST` in `menuCatalog.js` (working
tree, 2026-07-28), cross-checked against `ROLE_SIDEBAR_REACHABILITY_AUDIT.md`'s
07-23 snapshot and `ROLE_DAY_IN_LIFE_AUDIT.md`'s 07-27 functional pass. "Home
type" reflects `Home.jsx`'s actual branching, not a section count: only the pure
`employee` persona gets a tailored dashboard; everyone else — including
department heads and finance — gets the identical generic "Business Pulse"
widget set (Revenue Trend, Headcount, Sales Pipeline, Receivables Aging, Top
Customers), per the P0 finding in `ROLE_DAY_IN_LIFE_AUDIT.md`, still open.

| Role | Sections | Orphan groups | Home type |
|---|---|---|---|
| super_admin | 32 + 5 orphans (all) | all 5 | Generic + Super Admin console strip |
| admin | 32 + 5 orphans (all sections; 6 pages blocked within Settings/User Mgmt) | all 5 | Generic |
| hr | 18 | Compliance · More, Asset Register · More | Generic |
| manager | 18 | — | Generic |
| department_head | 17 | — | Generic |
| production_manager | 15 | IoT Fleet, R&D, Compliance, Asset Register · More (all 4) | Generic |
| hr_manager | 14 | — | Generic |
| production_engineer | 14 | same 4 | Generic |
| qc_manager | 14 | same 4 | Generic |
| hr_exec | 12 | — | Generic |
| finance | 11 | — | Generic (topically relevant by coincidence) |
| design_engineer | 10 | IoT Fleet · More, R&D · More | Generic |
| sales_manager | 10 | Tenders · More | Generic |
| employee | 9 | — | **Tailored** (My Open Tasks, My Pending Approvals, Policies, Brand Vault) |
| payroll_admin | 9 | — | Generic |
| procurement_manager | 9 | Asset Register · More | Generic |
| qc_engineer | 9 | Compliance · More | Generic |
| store_keeper | 9 | Asset Register · More | Generic |
| procurement_exec | 8 | Asset Register · More | Generic |
| project_manager | 8 | R&D · More | Generic |
| sales_exec | 8 | Tenders · More | Generic |
| service_manager | 8 | IoT Fleet · More | Generic |
| service_engineer | 8 | IoT Fleet · More | Generic |
| finance_manager | 7 | — | Generic |
| accounts_exec | 7 | — | Generic |
| l2_approver | 6 | — | Generic |

## What's still genuinely open

Cross-referencing rather than re-deriving, since both are recent and already
verified end-to-end:

- **Home dashboard is generic for 25 of 26 roles** — `ROLE_DAY_IN_LIFE_AUDIT.md`'s
  P0, unfixed. The fix direction it proposes (route each persona to the
  section-specific dashboard that already exists — Inventory, Quality, Production
  dashboards are all good) still stands and is the single highest-leverage item in
  either audit.
- **Orphan groups remain a structurally fragile pattern.** The 5 `"<Label> ·
  More"` groups (`autoRouter.js`'s `ORPHAN_NAV_ITEMS`) are reachable only if a
  role's allowlist names the exact synthetic string — a real `role_permissions`
  grant is not sufficient on its own, the same trap F16/F17 closed for the 4
  existing gaps. Any newly-added page with no curated route will silently repeat
  this unless someone remembers to allowlist its orphan name too.
- **Cross-department API access was not re-tested here** — sidebar-level
  segregation matches the documented allowlist for every persona checked, but
  whether a role can reach another department's data via a direct API call is
  the existing, separately-tracked authorization-coverage gap
  ([[project_authz_coverage_gap]] — ~76 privileged routes still open even with
  the fail-closed default).

## Notes

- `ROLE_SIDEBAR_REACHABILITY_AUDIT.md` (07-22/07-23) is the source for the
  mechanism's priority order and the F16/F17 fix history; treat its per-role
  counts as superseded by the table above where they disagree (hr/hr_manager/
  hr_exec, due to the in-flight Talent merge).
- `ROLE_DAY_IN_LIFE_AUDIT.md` (07-27) is the source for functional/dashboard
  findings; nothing in this pass contradicts it.
- This file is the "mechanism + correction" layer connecting the two — it does
  not repeat their full findings lists.
