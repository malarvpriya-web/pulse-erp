# Role → Sidebar Reachability Audit

Snapshot taken 2026-07-22, against the working tree including the same-day
"F16 role-reconciliation pass" (uncommitted at time of writing — see
`menuCatalog.js`, `approvals.authz.js`, `approvals.controller.js`, and
`backend/src/database/migrations/20260722000001_scope_granular_manager_approvals.js`).
Numbers below reflect that state, not the pre-F16 baseline. Updated
2026-07-23 with the "F17" pass that closes out this file's Open Items
(§ F17 below) — counts in the per-role table reflect the post-F17 state.

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

| Orphan group | Folder key | `module` tag | Page component |
|---|---|---|---|
| Asset Register · More | `assets` | `assets` | AssetRegister.jsx |
| IoT Fleet · More | `iot` | `iot` | FleetMonitor.jsx |
| R&D · More | `rd` | `rd` | RDHub.jsx |
| Compliance · More | `compliance` | `compliance` | ComplianceRegister.jsx |
| Tenders · More | `tenders` | `crm` | TenderWorkspace.jsx |

(Tenders is the one exception where the folder key and the `module` tag
diverge — `autoRouter.js:58` carries `module: 'crm'` through from
`FOLDER_CONFIG`, not `'tenders'`; `tenders.routes.js` is gated on that same
`crm` permission, "a tender IS an opportunity".)

`Sidebar.jsx`'s `ORPHAN_PARENT_ALIAS` (`Sidebar.jsx:19-28`) folds an orphan
into a matching curated parent by name (e.g. Warehouse → Inventory) when one
exists. None of these 5 have an alias match, so each renders as its own
top-level sidebar entry — and each is gated the same way as any other section:
by exact name in `ROLE_SECTION_ALLOWLIST`, or fallback for allowlist-less
roles. **`Tenders · More` was not listed in any role's allowlist as of
2026-07-22** — the same structural gap the other 4 orphans were in before the
F16 pass granted them out. Fixed in F17, § below.

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
| manager | 18 | — |
| department_head | 17 | — |
| production_manager | 15 | IoT Fleet, R&D, Compliance, Asset Register · More (all 4) |
| hr_manager | 15 | — |
| production_engineer | 14 | same 4 |
| qc_manager | 14 | same 4 |
| hr_exec | 13 | — |
| finance | 11 | — |
| design_engineer | 10 | IoT Fleet · More, R&D · More |
| sales_manager | 10 | Tenders · More |
| employee | 9 | — |
| payroll_admin | 9 | — |
| procurement_manager | 9 | Asset Register · More |
| qc_engineer | 9 | Compliance · More |
| store_keeper | 9 | Asset Register · More |
| procurement_exec | 8 | Asset Register · More |
| project_manager | 8 | R&D · More |
| sales_exec | 8 | Tenders · More |
| service_manager | 8 | IoT Fleet · More |
| service_engineer | 8 | IoT Fleet · More |
| finance_manager | 7 | — |
| accounts_exec | 7 | — |
| l2_approver | 6 | — |

Rows changed from the 2026-07-22 snapshot: `manager` (+2: Operations,
e-Signatures), `department_head` (+1: Operations), `hr_manager` (+1:
e-Signatures), `sales_manager` (+2: e-Signatures, Tenders · More),
`sales_exec` (+1: Tenders · More), `service_manager`/`service_engineer` (+1
each: Complaints) — see § F17 below.

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

## F17: closing out Operations, Complaints, e-Signatures, Tenders · More (2026-07-23)

As of 2026-07-22, `Operations`/`Complaints`/`e-Signatures` appeared **nowhere**
in `ROLE_SECTION_ALLOWLIST` and carried no `module:` key in `routes.jsx`, and
`Tenders · More` (the 5th orphan group) appeared in no allowlist either. Per
the priority order above, that meant all 4 resolved to `false` for every one
of the 24 allowlisted roles regardless of any `role_permissions` grant —
reachable only via `super_admin`, `admin`, or a manual `menu_permissions`
override. Each was investigated individually and fixed in `menuCatalog.js`
with no new migrations, since in every case the underlying backend access
already existed and just wasn't surfaced in the sidebar:

- **Operations** (`routes.jsx:813-820` — Workflow Center, Project Tracker,
  Dept Workload, Bottlenecks, Lifecycle Tracker, Post-Delivery). Backend
  (`operations.routes.js`, `lifecycle.routes.js`) mounts with `verifyToken`
  only — no `requirePermission` call, no `operations` key in the
  `role_permissions` `CODE_MODULES` list. Permission-less, same shape as QR
  Codes/Org Chart. Added to `manager` and `department_head` — the two
  existing broadest cross-departmental allowlists.
- **Complaints** (`routes.jsx:843-846` — CustomerComplaintsIPCS). Backend
  (`complaints.routes.js`) is gated on the **`servicedesk`** permission, not a
  dedicated `complaints` module ("IPCS is one half of the Service module's
  complaint→ticket loop"). `service_manager` (FULL servicedesk) and
  `service_engineer` (VAE servicedesk) already hold that grant — this was a
  missing sidebar-name entry only, identical shape to the F16 pass. Added to
  both.
- **e-Signatures** (`routes.jsx:891-894` — Sign & Send, Document Vault).
  Backend (`signatures.routes.js`, `documentMaster.routes.js`,
  `publicSign.routes.js`) has no `requirePermission` call anywhere — even the
  public countersigning route skips `verifyToken`. Permission-less. Used
  across HR (offer letters), Sales (contracts), and general management, not
  one department's tool, so added to `manager`, `department_head`,
  `hr_manager`, and `sales_manager`.
- **Tenders · More**: gated on `crm` (see the `module` tag correction above),
  which `sales_manager` (FULL) and `sales_exec` (VAE) already hold — added to
  both, the same "just add the orphan's exact name" fix as the F16 pass's
  4 other orphans.

No backend/migration changes were needed for any of the 4 — this was purely
closing `menuCatalog.js` allowlist gaps against permissions that already
exist. `frontend/src/config/menuCatalog.js` was edited directly (comments
tagged `F17 open-items pass` / `F17 pass` mark each change); syntax verified
with `node --check`.

## Notes

- This file supersedes the "31 sections" framing from the prior draft
  comparison matrix; `SIDEBAR_VISIBILITY_RULES.md` at the repo root is stale
  against the current `ROLE_SECTION_ALLOWLIST`/orphan-group architecture
  (it predates the Phase-42 granular roles and documents a superseded
  hardcoded-array approach) and should be treated as historical, not
  authoritative.
- No remaining sections are structurally unreachable for every role as of
  this update — `Operations`/`Complaints`/`e-Signatures`/`Tenders · More`
  were the last 4. If a genuinely new orphan or module-less NAV item is
  added in future, check it against the same priority chain before assuming
  a `role_permissions` grant alone will surface it.
