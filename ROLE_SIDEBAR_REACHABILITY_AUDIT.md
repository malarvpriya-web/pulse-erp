# Role → Sidebar Reachability Audit

Snapshot taken 2026-07-22, against the working tree including the same-day
"F16 role-reconciliation pass" (uncommitted at time of writing — see
`menuCatalog.js`, `approvals.authz.js`, `approvals.controller.js`, and
`backend/src/database/migrations/20260722000001_scope_granular_manager_approvals.js`).
Numbers below reflect that state, not the pre-F16 baseline.

## What "reachable" means here

`Sidebar.jsx`'s `isMenuVisible()` (`frontend/src/components/Sidebar.jsx:102-126`)
decides per NAV item, in this priority order:

1. `super_admin` → everything.
2. A per-user `menu_permissions` row (hidden/view/edit) — DB override, wins
   next regardless of role.
3. `admin` → everything except `SUPER_ADMIN_ONLY_PAGES`
   (`menuCatalog.js:234-241`: AccessControl, RolesSetup, UserSetup,
   SecurityCenter, DatabaseTest, OrganizationSetup).
4. A hand-curated `ROLE_SECTION_ALLOWLIST` entry for the role
   (`menuCatalog.js:254-520`) — if the role has one, membership in that array
   is the only thing that matters for that item.
5. Fallback, only reached if the role has **no** allowlist entry at all:
   `item.module ? hasPermission(item.module, 'view') : false`.

The practical effect of (4): once a role is given a curated allowlist, the
module-permission fallback never runs for that role again. A `role_permissions`
grant for a module is necessary but not sufficient — if the section's name
isn't also in that role's array, the grant is inert.

## The ceiling is two numbers, not one

`routes.jsx`'s `NAV_ITEMS` (`frontend/src/config/routes.jsx:548-943`) has
**34 top-level entries**. `Home` is exempt from all gating
(`ALWAYS_VISIBLE`, `menuCatalog.js:15`), leaving **33 configurable sections**
— correcting the "31" figure used in the previous draft of this matrix.

Of those 33, **18 carry a `module:` key** (Approvals, Employees, HR,
Attendance, Leaves, Finance, Recruitment, Procurement, Inventory, Production,
Quality, Engineering, Projects, Timesheets, Performance, Service Desk,
Reports, Notifications) and **15 don't** (Analytics & AI, Learning Center,
Talent, CRM, Sales, Marketing, Operations, Complaints, Travel Desk,
e-Signatures, QR Codes, User Management, Settings, Org Chart, Audit Logs).

Separately, **5 more sections exist outside NAV_ITEMS entirely** — synthetic
`"<Label> · More"` orphan groups that `autoRouter.js`'s `ORPHAN_NAV_ITEMS`
(`autoRouter.js:365-411`) generates for page files that have no curated route:

| Orphan group | Folder key | Page component |
|---|---|---|
| Asset Register · More | `assets` | AssetRegister.jsx |
| IoT Fleet · More | `iot` | FleetMonitor.jsx |
| R&D · More | `rd` | RDHub.jsx |
| Compliance · More | `compliance` | ComplianceRegister.jsx |
| Tenders · More | `tenders` | TenderWorkspace.jsx |

`Sidebar.jsx`'s `ORPHAN_PARENT_ALIAS` (`Sidebar.jsx:19-28`) folds an orphan
into a matching curated parent by name (e.g. Warehouse → Inventory) when one
exists. None of these 5 have an alias match, so each renders as its own
top-level sidebar entry — and each is gated the same way as any other section:
by exact name in `ROLE_SECTION_ALLOWLIST`, or fallback for allowlist-less
roles. **`Tenders · More` is not listed in any role's allowlist** — it is
currently reachable only by `super_admin`/`admin`/a manual `menu_permissions`
override, the same structural gap the other 4 orphans were in before this
pass granted them out.

So: **33 curated sections + 5 orphan groups = 38 possible sidebar entries**,
under two different gating rules. Any future version of this matrix should
report both numbers rather than collapsing them into one ceiling.

## Current per-role allowlist sizes

24 roles have a `ROLE_SECTION_ALLOWLIST` entry (everyone else falls through
to the module-permission-only path, which for practical purposes means "sees
almost nothing" since most sections lack a `module` key).

| Role | Sections | Orphan groups included |
|---|---|---|
| hr | 19 | Compliance · More, Asset Register · More |
| manager | 16 | — |
| department_head | 16 | — |
| production_manager | 15 | IoT Fleet, R&D, Compliance, Asset Register · More (all 4) |
| production_engineer | 14 | same 4 |
| qc_manager | 14 | same 4 |
| hr_manager | 14 | — |
| hr_exec | 13 | — |
| finance | 11 | — |
| design_engineer | 10 | IoT Fleet · More, R&D · More |
| employee | 9 | — |
| payroll_admin | 9 | — |
| procurement_manager | 9 | Asset Register · More |
| qc_engineer | 9 | Compliance · More |
| store_keeper | 9 | Asset Register · More |
| project_manager | 8 | R&D · More |
| sales_manager | 8 | — |
| procurement_exec | 8 | Asset Register · More |
| finance_manager | 7 | — |
| accounts_exec | 7 | — |
| sales_exec | 7 | — |
| service_manager | 7 | IoT Fleet · More |
| service_engineer | 7 | IoT Fleet · More |
| l2_approver | 6 | — |

## The F16 approvals reconciliation (same-day change)

`approvals.authz.js`'s `APPROVER_ROLES` (`approvals.authz.js:50-61`) dropped
`project_manager`, `sales_manager`, and `service_manager` — the stated reason
in the code comment is that none of the shared Approval Center pool's
categories (leave / regularization / OT / purchase request / expense / ECN /
payment) belong to any of those three roles' domain, so membership only ever
let them claim work that wasn't theirs. `menuCatalog.js` correspondingly
removed `'Approvals'` from those three roles' sidebar arrays — a section that
previously dead-ended every action button on `Unauthorized` for them.

In its place, a new `APPROVER_CATEGORY_SCOPE` map
(`approvals.authz.js:70-76`) narrows the roles that remain approvers to
specific categories when claiming from the shared (unassigned) pool:

```js
{
  procurement_manager: ['pr', 'purchase_request', 'purchase'],
  production_manager: ['ecn'],
  qc_manager: ['ecn'],
}
```

`canClaimCategory()` (`approvals.authz.js:78-90`) enforces this in
`canActOnApproval`, `bulkApprove`, and `bulkReject`
(`approvals.controller.js`). Roles absent from the scope map (`manager`,
`hr`, `finance`, `hr_manager`, `payroll_admin`, `department_head`) remain
unrestricted across all categories. The paired migration,
`backend/src/database/migrations/20260722000001_scope_granular_manager_approvals.js`,
flips `can_edit`/`can_approve` to `false` on the `approvals` module's
`role_permissions` rows for the three demoted roles (down migration restores
`true`; no rows inserted or deleted).

## Structural gap unaffected by F16: Operations, Complaints, e-Signatures

Confirmed by direct search — these 3 strings appear **nowhere** in
`ROLE_SECTION_ALLOWLIST`, and none of the 3 carry a `module:` key in
`routes.jsx`. Per the priority order above, that means the fallback at
priority (5) never fires for them (no `module` to check) and no allowlist
lists them, so they resolve to `false` for every one of the 24 allowlisted
roles regardless of any `role_permissions` grant. They are reachable today
only via `super_admin`, `admin`, or a manual per-user `menu_permissions`
override — the same shape as `Tenders · More` above, just via the curated
path instead of the orphan path.

## Open items

- **Tenders · More** has no owning role — worth a similar treatment to the
  F16 pass once a role is identified as the intended owner (Sales? CRM
  already owns most tender-adjacent work per `project_tender_workspace`
  memory — needs a product decision, not a code fix).
- **Operations / Complaints / e-Signatures** are the last 3 curated sections
  with no owning role at all. Same fix shape as F16: pick an owning role,
  add a `module` key or an allowlist entry.
- This file supersedes the "31 sections" framing from the prior draft
  comparison matrix; `SIDEBAR_VISIBILITY_RULES.md` at the repo root is stale
  against the current `ROLE_SECTION_ALLOWLIST`/orphan-group architecture
  (it predates the Phase-42 granular roles and documents a superseded
  hardcoded-array approach) and should be treated as historical, not
  authoritative.
