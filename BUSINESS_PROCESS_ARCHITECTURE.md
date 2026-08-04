# Business Process Architecture — Priority 2

Date: 2026-07-27, **re-verified and updated 2026-08-03**. Maps the two end-to-end
business-process chains named in the roadmap, link by link, marking each ✓ working /
⚠ partial / ✗ missing. A polished visual version of this document is published as an
Artifact (see bottom for the link).

**2026-08-03 update — all 7 gaps this document originally flagged (2 in Chain 1, 5 in
Chain 2) are now closed.** None of the fixes happened in this pass — they were built by
other sessions between 2026-07-28 and 2026-07-29 (`MODULE_FEATURE_CONNECTION_MANUAL.md`,
last updated 2026-07-29, already documents all of them under §18.1 #1/#2/#3/#6/#7/#8/#13).
This document itself was simply stale — a repeat of the pattern this whole audit series
has hit before: **findings go stale within days, always re-verify against live code before
treating a prior pass's ✗/⚠ as still open.** Every item below was independently
re-confirmed against current code on 2026-08-03 (route file, exact call site, and — for the
two auto-creation triggers — the calling code, not just the callee) before being marked ✓.

## Relationship to the existing Enterprise Workflow Audit

An extensive prior audit already exists — `PULSE_ENTERPRISE_WORKFLOW_AUDIT` (not a file in
this repo; tracked across assistant memory, 8 passes, 2026-07-20→2026-07-24) — covering 8
business-process chains (Hire-to-Retire, Lead-to-Cash, Procure-to-Pay, Plan-to-Produce,
Inventory, Service, Project, Finance Lifecycle), each independently scored and re-verified
multiple times (avg 85/100, 4 of 8 "Ready"), published as an HTML artifact. **This document
does not repeat that work.** It reuses those verified findings for the segments the two named
chains have in common with the existing 8, and adds fresh, newly-verified research only for
the specific links the existing audit never named: **Travel, Asset** (chain 1) and
**Installation, Warranty, Feedback, Upsell, Renewal** (chain 2). All 4 spot-checked headline
claims from that prior audit were re-verified against current code on 2026-07-27 and still
hold — safe to cite directly.

---

## Chain 1 — Hire to Retire (+ Travel, Asset)

`Recruitment → Employee → Attendance → Leave → Payroll → Travel → Asset → Exit`

**Recruitment → Employee → Attendance → Leave → Payroll**: ✓ — this is the existing audit's
"Hire to Retire" workflow, scored **84/100, "Ready," nothing structural open**. Payroll
auto-enrollment reaches all 3 employee-creation paths (direct add, recruitment hire,
auto-creation trigger); the `notify(userId)` bug is closed everywhere; promotion/increment
and exit access-revoke are solid. One architectural note carried over: 3 separate
employee-creation code paths still exist with no shared source of truth (payroll now reaches
all of them individually, but a future change could drift again).

**Employee ↔ Travel**: ✓ **fixed 2026-07-28 — real manager-routing + exit gate (re-verified 2026-08-03)**
- Travel policy resolves dynamically at claim time from grade/designation/department — no
  broken link here (unchanged).
- **Approval is now identity-gated, not role-gated.** `travelApprovalAuthz.js` replaces the
  old `req.user.role === 'manager'` check with a real hierarchy — reporting manager →
  delegate → HR override → admin override. `travel.routes.js`'s actual Approve/Reject
  endpoint (the one the Travel Approvals screen calls — not the unused `/level-approve`
  multi-level flow) and `travel-reimbursement.routes.js`'s `PUT /claims/:id/manager-approve`
  both use it. A bare `manager`-role user can no longer approve an arbitrary employee's
  travel.
- **Exit now checks outstanding travel advances before final settlement.** `exit.routes.js`'s
  `computeClearanceBlockers()` (lines 55–115) sums unsettled `travel_advances` per employee
  (resolved through `users.employee_id`, since `travel_advances.employee_id` actually stores
  a `users.id`) and includes it as a named blocker (`travel_advances`). `POST /fnf/:id/pay`
  calls this and hard-blocks (`can_settle` must be true) before paying final settlement.

**Employee ↔ Asset**: ✓ **fixed 2026-07-28 — asset-return now enforced at exit (re-verified 2026-08-03)**
- `AddEmployee.jsx`/`EditEmployee.jsx` still POST to `/employee-assets` on save
  (best-effort/non-blocking by design — unchanged, reasonable).
- **Exit's asset-return check is no longer cosmetic.** The same `computeClearanceBlockers()`
  queries `employee_asset_allocations` directly (`status NOT IN ('returned','disposed')`) as
  a live blocker (`assets`) — not the old disconnected `it_assets_returned` checkbox. This
  now sits alongside `access_revoked`, `it_access`, and finance/manager/HR sign-off as one of
  six conditions `POST /fnf/:id/pay` gates on (`can_settle = blockers.every(b => b.cleared)`).
- Net effect (fixed): an `employee_asset_allocations` row sitting at `status='allocated'`
  now blocks final settlement until it's returned or disposed — the gap the roadmap flagged
  no longer exists.

**→ Exit**: ✓ — the "Exit Clearance Engine" (`computeClearanceBlockers()` +
`POST /fnf/:id/pay`) is the single gate for all of this now: assets, travel advances, IT
access, and finance/manager/HR sign-off all block final settlement together, not just
access-revoke in isolation.

**Chain 1 bottom line**: the HR core (hire through payroll) is genuinely solid and verified
multiple times over. The two links the roadmap explicitly called out as weakest — Travel and
Asset — are now both wired into the one moment (Exit) where they matter most; nothing
structural remains open in this chain as of 2026-08-03.

---

## Chain 2 — CRM to Renewal

`CRM → Quotation → Sales Order → Production → Dispatch → Installation → Warranty → AMC →
Complaint → Service → Feedback → Upsell → Renewal`

**CRM → Quotation → Sales Order → Dispatch**: ✓ — existing audit's "Lead to Cash," scored
**83/100, Needs Minor Fixes**. Dispatch hard-gates on production completion (409 unless
`force:true`, re-verified still true 2026-07-27); credit-check covers both quotation
conversion and invoice creation. One deliberately-deferred gap: discount-approval still has
no schema link to quotations.

**→ Production**: ✓ — existing audit's "Plan to Produce," scored **90/100, "Ready."** The
quality stop-ship hold is airtight; `routingCopy.service.js` correctly copies the
`is_inspection` flag through (re-verified still true 2026-07-27).

**→ Installation**: ✓ **fixed 2026-07-29 — first-class module (re-verified 2026-08-03).**
"Installation" is now a real `installation_requests` table (migration
`20260729000001_installation_requests.js`) with its own lifecycle (`requested` →
`engineer_assigned` → `travel_planned` → `in_progress` → `completed`/`cancelled`), a full
route file (`installation.routes.js`: assign-engineer, plan-travel, start, complete,
customer-acceptance, cancel), and a frontend page (`InstallationRequests.jsx`, mounted at
`/installation-requests`). Rows are **auto-created on Sales Order dispatch** —
`sales.routes.js`'s `PUT /orders/:id/dispatch` calls the exported `createInstallationRequest()`
when a project can be resolved (line ~1088), idempotent via a partial unique index on
`(sales_order_id) WHERE status NOT IN ('cancelled')`. Deliberately links to (not duplicates)
`travel_requests` for the Travel Planning step and `commissioning_workflows` for the handoff
at completion. (The similarly-named `InstallationDashboard.jsx` remains unrelated — it's a
project-geography map view, not this lifecycle step. Still worth knowing so nobody confuses
the two.)

**→ Warranty**: ✓ **fixed 2026-07-28 — Unified Warranty Engine (re-verified 2026-08-03).**
`POST /commissioning/:id/activate-warranty` now writes a real `warranty_registrations` row
(idempotent on `commissioning_workflow_id`) instead of only setting
`customer_equipment.warranty_status`. Migration `20260728000006_unified_warranty_engine.js`
added `project_id`/`commissioning_workflow_id`/`equipment_id`/`amc_contract_id` columns to
`warranty_registrations`, converging all three previously-disconnected sources onto it (the
most feature-complete of the three — it already had a `warranty_claims` child table and
coverage flags). `customer_equipment` and `product_warranties` were confirmed empty in the
live DB before the migration (zero backfill risk); `product_warranties` is left in place
but application code stops writing to it. **A warranty activated via commissioning sign-off
now surfaces correctly** in Customer 360, the Warranty Expiry dashboards, and AMC.

**→ AMC → Complaint → Service**: ✓/⚠ — existing audit's "Service Lifecycle," scored
**82/100, Needs Minor Fixes**. Real signature capture, ticket-closure gating, and the
Maintenance-inventory bridge are all solid. `amcRenewal.cron.js` correctly checks both AMC
table variants (`service_contracts` and `amc_contracts`). Remaining architectural item: 3
ticket tables (`support_tickets`, a separate Finance-module helpdesk `tickets` table, and
`customer_portal_tickets`) and 2 AMC-contract tables stay genuinely separate — a real
consolidation project, not a quick fix.

**→ Feedback**: ✓ **working, genuinely automatic.** `servicedesk.routes.js:604-611`
auto-creates a CSAT-request notification the instant a ticket transitions to
resolved/closed — the trigger side is solid and needs no fix. (Actual capture still depends
on the agent/customer acting on that notification — a soft gap, not a broken link.)

**→ Upsell**: ✓ **fixed — real operational path (re-verified 2026-08-03).**
`ceo-intelligence.routes.js` still computes the real `upsell_opportunity` label (AMC Upsell
/ Expand Account) per customer, but `CEOIntelligenceDashboard.jsx` now renders it as an
actionable "Convert →" button, not an inert `<div>`. It calls
`POST /ceo-intelligence/customers/:partyId/convert-upsell`, which resolves (or best-effort
creates) the CRM `accounts` row bridging the Finance `parties` record and creates a real CRM
opportunity from the signal. **The signal now turns into an action**, not just a label.

**→ Renewal**: ✓ **fixed 2026-07-29 — Renewal Engine, Priority 5 (re-verified 2026-08-03).**
The `subscriptions` mechanism and `amc_contracts` remain two separate record types by design
(they represent genuinely different commercial models — recurring billing vs. service
contracts) — this was **not** collapsed into one table. What was fixed is the actual
complaint: "wired to zero cron jobs" and no approval gate. `subscriptionRenewal.cron.js`
(new, daily 09:15, mirrors `amcRenewal.cron.js`'s reminder pattern) is started in
`server.js` alongside the AMC cron. A shared `renewalApproval.js` gate (threshold-based,
`admin`/`super_admin`/`finance`/`finance_manager` only) now covers **both** AMC and
Subscription renewals, closing the "anyone could renew at any value" gap neither mechanism
had a check for before. Two tracks by design, but both now function correctly on their own.

**Chain 2 bottom line (updated 2026-08-03)**: the transactional spine (CRM through Dispatch,
and separately Complaint through Service) was already solid. As of this update, the five
links that turn a completed sale into repeat revenue are now closed too — Installation is a
real, dispatch-triggered lifecycle step; Warranty converges on one table read by every
consumer; Upsell signals convert into real CRM opportunities; and Renewal reminders + an
approval gate cover both AMC and Subscriptions. Nothing from this chain's original findings
remains open.

---

## Sources
- Existing scores/chain segments: `project_enterprise_workflow_audit` memory (Pass 7,
  2026-07-24) and its published artifact, `https://claude.ai/code/artifact/e78ffbd4-40cd-49ea-919c-f11e4cfa62e8`.
- Original findings (Travel/Asset/Installation/Warranty/Feedback/Upsell/Renewal): 2026-07-27,
  against the live working tree at that time.
- **2026-08-03 update**: all 7 original gaps re-verified as fixed, directly against current
  code (not against `MODULE_FEATURE_CONNECTION_MANUAL.md`'s claims, though its 2026-07-29
  §18.1 entries independently corroborate every fix below): `travelApprovalAuthz.js` +
  `exit.routes.js`'s `computeClearanceBlockers()`/`POST /fnf/:id/pay` (Chain 1, both items);
  `installation.routes.js` + `installation_requests` + `sales.routes.js`'s dispatch handler;
  `20260728000006_unified_warranty_engine.js` + `commissioning.routes.js`'s
  `activate-warranty`; `CEOIntelligenceDashboard.jsx`'s convert button +
  `ceo-intelligence.routes.js`'s `convert-upsell`; `subscriptionRenewal.cron.js` +
  `renewalApproval.js` (Chain 2, all five items). No code changes were made this pass — the
  fixes already existed, this document was simply out of date.
- Visual version of this document: see the published Artifact linked from this session
  (title "Pulse Business Process Architecture").
