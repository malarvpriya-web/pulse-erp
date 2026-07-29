# Role "Day in the Life" Validation — Priority 1

Date: 2026-07-27 (12th–26th personas — Admin, Project Manager, Service Manager, and the 12
remaining granular Phase-42 seats — added 2026-07-28). Scope: the 11 personas named in the
roadmap — HR, Finance, Manager, Employee, Store Keeper, Production Manager, QC, Service
Engineer, Sales, Purchase, CEO — plus `admin`, `project_manager`, `service_manager`, and
every remaining granular role that had zero live users
(`department_head`, `l2_approver`, `hr_manager`, `hr_exec`, `payroll_admin`,
`finance_manager`, `accounts_exec`, `sales_exec`, `procurement_exec`,
`production_engineer`, `qc_engineer`, `design_engineer`) — tested against the live local
dev stack (backend `:5000`, frontend `:5173`, local Postgres). Every granular Phase-42 role
in `menuCatalog.js`'s `ROLE_SECTION_ALLOWLIST` has now been walked at least once.

## Method

Each persona was logged in via a minted JWT for a real account in that role (no
passwords needed — `backend/scripts/e2e-mint-token.mjs`), with **real** permissions
fetched from `GET /api/auth/permissions` and seeded into the session (the existing
`tests/auth.setup.ts` harness always seeds an *empty* permissions array, which would
make every `hasPermission()`-gated button look broken for every non-admin role — that's
a test-harness artifact, not an app bug, so a fixed variant was used here; see
`tests/role-audit/crawl-role.mjs`). QC and Purchase had **zero active user accounts**
in the environment before this audit — nobody had ever exercised those two roles
end-to-end — so `pilot.qc@manifest.in` / `pilot.purchase@manifest.in` were created via
the existing `backend/scripts/security/pilot-provision.mjs` (extended with those two
roster entries) before testing.

For each persona: an automated crawl hovered every visible sidebar section and opened
one representative page per section, capturing console errors, network errors (4xx/5xx),
and a screenshot; then a manual pass judged dashboard usefulness and task quality via
those screenshots and a few deeper checks. **This is a coverage pass, not exhaustive** —
one landing page per section, not every leaf route — so "no errors found" means "no
errors found on the pages visited," not a full regression sweep. Raw results:
`tests/role-audit/results/*.json`, screenshots: `tests/role-audit/screenshots/`.

No sidebar-visibility drift was found: all 11 personas saw exactly the section count
documented in `ROLE_SIDEBAR_REACHABILITY_AUDIT.md` (HR 19, Manager 18, Production
Manager 15, QC 14, Finance 11, Purchase 9, Store Keeper 9, Employee 9, Sales 10, Service
Engineer 8, super_admin 39 [34 top-level incl. Home + 5 orphans]). The
`ROLE_SECTION_ALLOWLIST` in `menuCatalog.js` matches what's actually rendered today.

---

## Top findings, worst first

### P0 — The Home dashboard doesn't help 10 of the 11 personas
`Home.jsx` only branches on two things: `isEmployee` (true only if *every* held role is
plain `employee`) and `isSuperAdmin`. Every other persona — HR, Finance, Manager, Store
Keeper, Production Manager, QC, Service Engineer, Sales, Purchase, and admin/super_admin
— lands on the **identical generic "Business Pulse" widget set**: Revenue Trend,
Headcount by Department, Sales Pipeline, Receivables Aging, Top Customers. Confirmed by
screenshot for HR, Store Keeper, and Service Engineer (`hr__Home.png`,
`store_keeper__Home.png`, `service_engineer__Home.png` — pixel-identical layout, only
the clock differs). A Store Keeper's first screen shows "Top Customers by paid revenue"
and "Receivables Aging" — nothing about low-stock items, pending GRNs, or reorder
alerts, despite `InventoryDashboard` (one click away) having exactly those widgets done
well. Same story for Service Engineer (no "my tickets today" / SLA-breach widget, despite
`Service Desk` existing). Only the pure `employee` persona gets a tailored view ("My
Open Tasks", "My Pending Approvals", Policies, Brand Vault — `employee__Home.png`).
**Fix direction**: route each non-employee persona to (or compose Home from) the
section-specific dashboard that already exists for their primary role — the raw
material (Inventory, Quality, Production, Sales dashboards below) is good; Home just
doesn't use it.

**Sharper sub-finding, added 2026-07-28**: the shared Home's amber "Approvals" KPI tile
(`Home.jsx:352-357`, `onClick={() => go('ApprovalCenter')}`) is worse than merely generic —
it's actively misleading for at least three roles. `apprCount` comes from
`mgmt?.pendingApprovalsCount`, which `getManagementMetrics(companyId)`
(`backend/src/home/home.service.js:324-359`) computes as `pendingApprovalUnion(companyId).length`
— a **raw company-wide count with no user or role filtering at all**, reused identically
for every non-employee persona (admin, manager, hr, finance, department_head, and every
granular manager role). Confirmed live for `service_manager`: Home showed **"7 Approvals"**
in the urgent-amber color (implying 7 items need this user's attention), but clicking
through to `ApprovalCenter` — the same page the tile links to — shows **"0 Pending"**,
because that page correctly applies `canClaimCategory`/`APPROVER_CATEGORY_SCOPE`
(`approvals.authz.js`) and `service_manager` was deliberately removed from
`APPROVER_ROLES` entirely in the 2026-07-22 F16 fix. Same structural mismatch would apply
to `project_manager`, `sales_manager` (the other two F16-removed roles), and likely to the
category-scoped roles (`procurement_manager`/`production_manager`/`qc_manager`) whenever
the company-wide queue contains items outside their scoped categories. **Not fixed here**:
properly scoping this number means threading the same category-scope logic from
`approvals.authz.js` into `home.service.js`, which is shared by every non-employee
dashboard — a real, contained follow-up task, not a one-line guard like the
`ProjectsDashboard` NaN fix below.

### ~~P0 — `MyTimesheet` is broken for every role that can reach it~~ — FIXED 2026-07-27
`GET /api/timesheets/my-timesheet?week_start=...&week_end=...` 404d unconditionally.
Reproduced for HR, Manager, Employee, Production Manager, and super_admin (every
persona whose sidebar includes Timesheets). Root cause: the timesheets router is
mounted at `/timesheets` in `server.js`, but every route inside
`timesheets.routes.js` *also* starts with `/timesheets` internally — so the real,
working path is `/api/timesheets/timesheets/...`, not `/api/timesheets/...`. Other
calls in the same frontend file already knew this (`/timesheets/timesheets` for
add-entry/submit-week); `MyTimesheet.jsx`'s load call, clock-in, and clock-out did
not. Fixed all three call sites in `frontend/src/features/timesheets/pages/
MyTimesheet.jsx` to use the correct double-segment path. Verified live: the API
returns 200 for all three endpoints (confirmed a full clock-in/clock-out cycle
completes), and the page loads with zero console/network errors.

### P1 — Two more real backend bugs, both pre-existing (not caused by this audit)
- `LearningDashboard` → `GET /api/training/cost-by-type` → 500 (HR, super_admin — anyone
  with Learning Center access).
- `ResumeDatabase` → `GET /api/talent/resumes` and `/api/talent/resumes/stats` → 500,
  ×2 each (same audience — Talent section).

### P1 — Manager's own Executive Dashboard has a broken widget
`Analytics & AI → ExecutiveDashboard` (the Manager persona's scoped analytics page)
calls `GET /api/finance/reports/profit-loss` and gets **403** — the manager role is
blocked from a report their own dashboard tries to render. Either the widget shouldn't
be on a manager-facing page, or the manager-scoped P&L read should be allowed;
today it's neither — it's a visibly broken tile.

### P2 — `InventoryDashboard` fires 40–60 duplicate-React-key console warnings
*"Encountered two children with the same key... Non-unique keys may cause children to
be duplicated and/or omitted"* — reproduced for Production Manager, QC, Purchase, Store
Keeper, and super_admin (everyone who lands there). Purely a console warning in this
pass, but the Low Stock Alerts list on that same page shows the identical item
("Office Paper A4 · 0/10") repeated 4 times across different stores
(`store_keeper__Inventory.png`) — plausibly the same underlying list-rendering issue;
worth a real look rather than dismissing as cosmetic.

### P2 — The hover-driven flyout submenu is fragile under fast interaction
Confirmed via direct reproduction (`tests/role-audit/debug-nav2.mjs`): after ~4-5 rapid
client-side navigations in a row, the SPA can update the URL via the router while the
*visible* page content stays on the previous route — the click registers, the address
bar changes, but the screen doesn't. This didn't happen on the first few navigations of
a session, only after several in quick succession, so an impatient user clicking around
quickly (not unrealistic for someone doing repetitive data entry) could genuinely land
"nowhere" and not notice until they act on stale content. The sidebar itself is
`onMouseEnter`/`onMouseLeave`-driven with a debounced collapse (`Sidebar.jsx`) rather
than click-to-pin, which is inherently less robust than a static menu — this class of
bug is a plausible side effect of that design, not just a test-harness quirk.

### P2/info — "CEO" is not a real, distinct persona
No `ceo` role exists anywhere in `role_permissions`/`user_roles` — `'ceo'` only appears
as a job-title seed value. Testing "CEO" here means testing `super_admin`/`admin`
viewing `CeoDashboard`/`CEOIntelligenceDashboard`. If the business wants a real
CEO seat that sees company-wide dashboards but *not* User Management, Security Center,
or Database Test, that persona doesn't exist today — it's all-or-nothing via
`super_admin`/`admin`.

### P2/info — QC and Purchase had never been used end-to-end before this audit
Zero active `qc_manager`/`qc_engineer` or `procurement_manager`/`procurement_exec`
users existed in the environment. Once provisioned, both roles worked cleanly in this
pass (Quality Dashboard and Purchase Requests both render sensibly, no errors) — this
is a process/coverage gap (nobody had checked), not a code defect, but worth noting
since it means these two departments' workflows have effectively never been
dogfooded.

### Cross-department access — not re-tested at the API layer here
Sidebar-level segregation matches the documented allowlist exactly for all 11 personas
(no extra sections visible for anyone). Whether a role can reach another department's
*data* via a direct API call (not through the UI) is a broader, already-tracked concern
— see the existing authorization-coverage audit (~76 privileged routes still open even
with the fail-closed default) — this pass didn't re-verify that surface and isn't a
substitute for it.

---

## Per-role notes

### HR (`hr`, 19 sections)
Can complete a normal day (Announcements, Employee Directory, Attendance, Leaves,
Recruitment all load cleanly). Hits both P1 backend bugs (Learning Center, Talent) and
the P0 Timesheets 404. Dashboard: generic Business Pulse (P0 above) — nothing
HR-specific (headcount trend is present but it's a company-wide widget, not framed as
"your" HR metrics).

### Finance (`finance`, 11 sections)
Cleanest run of all 11 — zero console/network errors on every page visited. Dashboard
is the same generic Business Pulse widget set, but for Finance those widgets (Revenue,
Receivables) are at least topically relevant — the only persona for whom the generic
Home accidentally makes sense.

### Manager (`manager`, 18 sections)
Can complete a day, but their own Executive Dashboard has a broken P&L tile (P1 above)
and also hits the Timesheets 404. Otherwise clean.

### Employee (`employee`, 9 sections)
Best-served persona. Tailored Home (My Open Tasks / My Pending Approvals / Policies /
Brand Vault / Today's Celebrations) — no irrelevant company financials. Hits the same
Timesheets 404 as everyone else with that section.

### Store Keeper (`store_keeper`, 9 sections)
Zero errors. `InventoryDashboard` itself is well-built for this role (Total Items, Low
Stock, Pending POs, Low Stock Alerts, EOQ Planner, ABC Analysis —
`store_keeper__Inventory.png`) — but the user never sees it by default; Home shows
Top Customers/Receivables instead (P0). Also hits the duplicate-key console warning.

### Production Manager (`production_manager`, 15 sections)
Zero network errors on Production itself — `Advanced Production Dashboard`
(`production_manager__Production.png`) is genuinely good: live overdue-batch alert with
a named, dated PO, status/quality distributions. Hits Timesheets 404 and the
Inventory duplicate-key warning.

### QC (`qc_manager`, 14 sections)
First-ever end-to-end run for this role (see P2/info above). `Quality Dashboard`
(`qc_manager__Quality.png`) is reasonable — Pass Rate, Open NCRs, Overdue CAPAs,
Calibration Due, NCRs by Severity — though "8 Open NCRs" alongside "0 inspections
(MTD)" is an internal inconsistency worth a data/query check, not just thin seed data.
Hits the Inventory duplicate-key warning (Inventory is in this role's allowlist too).

### Service Engineer (`service_engineer`, 8 sections)
Zero errors. Smallest, most focused menu of the 11 (Approvals, Complaints, Service
Desk, IoT Fleet, QR Codes) — genuinely hard to reach another department's work from
here, which is a good sign for "can't accidentally do someone else's job." Cosmetic:
the greeting banner labels this user "Employee" rather than a role-appropriate title —
likely because the test account's `designation` field was never set; worth confirming
against a real service engineer's profile rather than assuming it's an app bug.

### Sales (`sales_manager`, 10 sections)
Zero recorded errors, but `Sales Command Center`'s Executive tab was still showing
"Loading Sales Intelligence…" ~1 second after landing (`sales_manager__Sales.png`) —
not confirmed broken (no error fired), but worth a manual timing check since a
slow-loading landing tab reads as broken to a real user.

### Purchase (`procurement_manager`, 9 sections)
First-ever end-to-end run for this role (see P2/info above). `Purchase Requests` has a
clean, good empty state ("No purchase requests found" + a clear "New Request" CTA —
`procurement_manager__Procurement.png`). Zero network errors; hits the Inventory
duplicate-key warning.

### Admin (`admin`, 38 sections — added 2026-07-28)
Crawled live via `admin@manifest.in` (users.id=849). Sees all 20 operational domains plus
every setup screen except the six `SUPER_ADMIN_ONLY_PAGES` (AccessControl, RolesSetup,
UserSetup, SecurityCenter, DatabaseTest, OrganizationSetup) — confirmed absent from the
crawl, correctly stripped. Same generic Business Pulse Home as every non-employee persona
(P0 above), including the Revenue MTD KPI tile (`admin__Home.png`). Hits the same two
pre-existing bugs every other persona with that reach hits: the `Learning Center` →
`/api/training/cost-by-type` 500, and the `InventoryDashboard` duplicate-React-key
warnings — no *new* defects found.

**A pasted UX-audit note claimed the sidebar's old "User Management" folder (Users/Roles/
Approver) survives for admin as a folder-with-one-item once Users/Roles are stripped
("a folder that opens to reveal one item... reads as broken"). Verified against the live
crawl and it does not reproduce**: the JSON shows a flat top-level item named literally
`"Approver"` (`submenu: []`, lands directly on `/ApproverSetup`, no intermediate flyout
click) — `routes.jsx` no longer even has a "User Management" NAV_ITEMS group by that name
surviving to render. `Sidebar.jsx:143-151`'s `visibleItems` reduce already has exactly this
collapse rule: when filtering `SUPER_ADMIN_ONLY_PAGES` out of a submenu leaves exactly one
surviving entry, it replaces the whole item with a flat `{name, icon, page}` node instead of
a one-item folder — with a comment (`routes.jsx:899-903`) describing this precise scenario.
Whoever/whatever produced that pasted note was looking at a stale build or a doc, not
current code — don't re-file it as an open issue.

### Project Manager (`project_manager`, 8 sections — added 2026-07-28)
No live account existed for this role before this pass (like QC/Purchase before it) — added
`pilot.project@manifest.in` to `backend/scripts/security/pilot-provision.mjs`'s ROSTER and
ran `--apply` (user=896, employee=31). Sidebar matches `ROLE_SECTION_ALLOWLIST` exactly
(Home, Projects, Timesheets, Reports, Notifications, Org Chart, QR Codes, R&D · More) — no
`Approvals`, confirming the 2026-07-22 F16 fix (project_manager removed from
`APPROVER_ROLES` and from this allowlist) holds in the live UI, not just the code. Zero
console/network errors on the crawl. Same "Employee" mislabel in the Home greeting badge as
Service Engineer above — this account's `employees.designation` was never set by the
provisioning script, so it's the same known cosmetic gap, not a new bug.

**P1 found and fixed**: `ProjectsDashboard.jsx` displayed literal **`"NaN%"`** as the task
progress on any project with zero tasks (`SST Install Coimbatore 48894`, screenshot
`project_manager__Projects.png` before the fix). Root cause: `total_tasks`/
`completed_tasks` come from `COUNT(DISTINCT t.id)` in
`project.repository.js:34-35` — Postgres bigint COUNT results arrive at the frontend as
**strings**, and three spots in `ProjectsDashboard.jsx` (lines ~58, ~120, ~199) guarded
with a bare truthy check (`p.total_tasks ? ... : 0`), which doesn't catch the string `"0"`
(non-empty ⇒ truthy) — so it divided `"0"/"0"` and JS coerced that to `0/0 = NaN`. One line
in the same file (`totalTasks` reduce, line 117) already had the correct guard
(`parseInt(p.total_tasks) || 0`) — the other three just hadn't been written the same way.
Fixed all three to parse first, matching the existing correct pattern. Side effect
confirmed live: the zero-task project's health badge changed from a false "On Track"
(green) to the correct "At Risk" (orange), since `NaN < 30` was silently false before.
**Not fixed, out of scope**: the "Project Health" donut/bar widget's aggregate counts
(0 on-track/0 at-risk/1 delayed) don't match the sum of the three individual card badges
shown on the same screen (1 on-track/1 at-risk/1 delayed) — looks like a second,
independent aggregation bug in whatever computes that widget's totals, worth a follow-up
but not chased down in this pass.

### Service Manager (`service_manager`, 8 sections — added 2026-07-28)
No live account existed for this role either — added `pilot.servicemgr@manifest.in` to the
same ROSTER (user=897, employee=32). Sidebar matches `ROLE_SECTION_ALLOWLIST` exactly (Home,
Complaints, Service Desk, Reports, Notifications, Org Chart, QR Codes, IoT Fleet · More) —
no `Approvals`, confirming the F16 fix holds for this second of the three roles it removed
from `APPROVER_ROLES` (see `project_manager` above for the first). Zero console/network
errors across every page visited; `Service Desk`'s own dashboard (SLA/ticket-category/team-
workload widgets) renders cleanly with real data. Same generic Business Pulse Home and same
"Employee" designation-badge gap as every other persona above — nothing new there. This
persona is what surfaced the sharper Approvals-KPI-mismatch sub-finding under the P0 Home
item above (the live "7 Approvals" vs. "0 Pending" click-through was reproduced here).

### Remaining 12 granular roles (added 2026-07-28) — clean sweep, zero nav drift
No live account existed for any of these — extended `pilot-provision.mjs`'s ROSTER with all
12 in one batch (`pilot.depthead`, `pilot.l2approver`, `pilot.hrmgr`, `pilot.hrexec`,
`pilot.payroll`, `pilot.financemgr`, `pilot.accountsexec`, `pilot.salesexec`,
`pilot.procurementexec`, `pilot.prodeng`, `pilot.qceng`, `pilot.designeng`, all
`@manifest.in`, users 898–909) and crawled each. Three (`department_head`, `hr_exec`,
`design_engineer`) came back `AUTH_FAILED — no sidebar / redirected to login` on the first
pass; all three succeeded cleanly on an immediate retry with no code change, so this was a
transient flake in the automated crawl (likely a race between the mint/permissions fetch and
the SPA's first render under batch load), not a real bug — worth knowing if this script
reports a false failure again.

**Sidebar match, every role, zero drift**: cross-checked each crawled top-level section list
against `menuCatalog.js`'s `ROLE_SECTION_ALLOWLIST` entry for that role — every single one
matches exactly, including counts (`department_head` 17, `l2_approver` 6, `hr_manager` 14,
`hr_exec` 12, `payroll_admin` 9, `finance_manager` 7, `accounts_exec` 7, `sales_exec` 8,
`procurement_exec` 8, `production_engineer` 14, `qc_engineer` 9, `design_engineer` 10). This
is the best evidence yet that the `module:` key / allowlist nav-gating system
([[project_nav_module_gating_audit]]) is solid across the full granular-role roster, not
just the handful spot-checked before.

**Errors seen are all already-tracked, nothing new**: `hr_manager`/`hr_exec` hit the known
`Learning Center` → `/api/training/cost-by-type` 500 (2 network errors each, same as HR/
super_admin before them). `department_head`/`procurement_exec`/`production_engineer`/
`qc_engineer` hit the known `InventoryDashboard` duplicate-React-key console warnings
(40–60 each, same pattern as every prior role that lands there). No new backend 500s, no new
console errors, no new network failures across all 12 roles.

**Open question, not a confirmed bug**: `hr_exec`, `accounts_exec`, `sales_exec`,
`procurement_exec`, `production_engineer`, `qc_engineer`, and `design_engineer` all have
`'Approvals'` in their `ROLE_SECTION_ALLOWLIST` (sidebar-visible), but **none of the seven
are in the backend's `APPROVER_ROLES`** (`approvals.authz.js:50-62`) — meaning
`isApproverRole(req)` is `false` for all of them, so they can never claim an unassigned item
from the shared pool. Screenshot evidence (`procurement_exec__Approvals.png` etc.) shows the
page renders a clean, correct-looking empty state ("0 Pending", "No pending approvals ✅")
with no crash or error — **not** the confirmed broken pattern found for `service_manager`
above (where the Home KPI tile actively disagreed with the page). But these fresh pilot
accounts have zero items directly assigned to them either, so this pass can't tell whether
the page would work correctly for an item genuinely assigned to one of these users (allowed
per `canActOnApproval`'s "already assigned to me" branch, independent of `APPROVER_ROLES`)
or whether `'Approvals'` simply shouldn't be in these seven roles' allowlists at all, the way
it was deliberately removed from `project_manager`/`sales_manager`/`service_manager` in F16.
Flagging for a follow-up with real assigned data rather than asserting either way. By
contrast, `department_head`/`hr_manager`/`payroll_admin`/`finance_manager` being unscoped
(any category) in `APPROVER_ROLES` is explicitly BY DESIGN — the code comment at
`approvals.authz.js:66-67` says so directly, and F16 only ever scoped/removed the
`*_manager`/`*_engineer` tier below it, not these four.

Home dashboard for all 12: identical generic Business Pulse widget set (P0 above), same
"Employee" designation-badge cosmetic gap, same company-wide unscoped Approvals-KPI-tile
mismatch already documented above for `service_manager` — not re-verified per-role since the
root cause (`getManagementMetrics` takes no role/user context) already explains why it would
reproduce identically for every one of them.

### CEO (`super_admin`, 39 sections)
See the P2/info note above — this is really "admin sees everything," not a distinct
CEO experience. Hits all three backend bugs (Learning, Talent, Timesheets) since
super_admin's reach is a superset of everyone else's, plus the Inventory warning.
No *new* errors beyond what smaller roles already hit — the extra surface area
(console-only admin pages) is otherwise clean.

---

## Suggested fix order
1. ~~`MyTimesheet` 404~~ — **fixed 2026-07-27**, see above.
2. Route non-employee Home dashboards to their existing section-specific dashboard
   instead of the generic Business Pulse widget (P0, biggest UX gap, and the target
   dashboards — Inventory, Quality, Production — already exist and are good).
3. Manager's Executive Dashboard P&L 403 (P1) — decide scope, don't leave it broken.
4. Learning/Talent 500s (P1).
5. Inventory duplicate-key warning + the repeated low-stock row (P2) — check whether
   it's cosmetic or a real duplicate in the underlying list.
6. Flyout-menu robustness under fast navigation (P2) — lower priority, but note it
   before deciding the sidebar interaction model is "done."
