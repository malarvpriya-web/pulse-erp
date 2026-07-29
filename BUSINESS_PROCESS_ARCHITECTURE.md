# Business Process Architecture — Priority 2

Date: 2026-07-27. Maps the two end-to-end business-process chains named in the roadmap,
link by link, marking each ✓ working / ⚠ partial / ✗ missing. A polished visual version of
this document is published as an Artifact (see bottom for the link).

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

**Employee ↔ Travel**: ⚠ **partial — real data link, not an enforced gate**
- Travel policy resolves dynamically at claim time from grade/designation/department — no
  broken link here.
- **Approval is a role-gate, not manager-routing.** `travel.routes.js:1097`
  (`level-approve`) and `travel-reimbursement.routes.js`'s manager-approve check only
  `req.user.role === 'manager'` — there is no query against a `reporting_manager_id` on
  `employees` anywhere in either file. **Any user holding the `manager` role can approve any
  employee's travel request, advance, or claim** — not just their own reports.
- **Exit never checks outstanding travel advances.** `exit.routes.js`'s F&F compute/pay
  (`POST /fnf/compute/:employee_id`, `POST /fnf/:id/pay`) has zero references to `travel`.
  The codebase already has the right pattern for this — `travel-reimbursement.routes.js:598`
  and `travel.routes.js:1162` both expose a `GET /closure-check` used to gate project/PO
  closure — it was simply never applied to employee exit.

**Employee ↔ Asset**: ⚠ **partial — allocation wired at hire, return not enforced at exit**
- `AddEmployee.jsx`/`EditEmployee.jsx` do POST to `/employee-assets` on save
  (best-effort/non-blocking by design — reasonable).
- **Exit's asset-return checkbox is cosmetic.** The clearance form's `it_assets_returned`
  boolean is only ever read/written inside `exit.routes.js` itself and the frontend
  checklist label — nothing blocks `/fnf/:id/pay` or the `employees.status='left'`
  transition on it. **Contrast: the sibling `access_revoked` checkbox in the same form *is*
  enforced** — it genuinely deactivates the user's login. The enforcement pattern exists in
  this exact file; it just wasn't extended to assets.
- Net effect: `employee_asset_allocations` rows can sit at `status='allocated'`,
  `return_date IS NULL` indefinitely after an employee is marked `left`/`terminated`.

**→ Exit**: ✓ per the existing audit (access-revoke fixed and confirmed still true
2026-07-27) — but see above: exit completes today without checking travel or asset state.

**Chain 1 bottom line**: the HR core (hire through payroll) is genuinely solid and verified
multiple times over. The two links the roadmap explicitly called out — Travel and Asset —
are exactly where the chain is weakest: both are real, queryable associations that were never
wired into the one moment (Exit) where they matter most.

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

**→ Installation**: ✗ **not a real, distinct step.** "Installation" exists only as a checklist
*category* inside Commissioning (`commissioning.routes.js:39-42`) — no separate table,
status, or route. (A similarly-named `InstallationDashboard.jsx` is unrelated — it's a
project-geography map view, not a lifecycle step. Worth knowing so nobody mistakes it for
this.)

**→ Warranty**: ⚠ **partial — activation trigger is solid, but 3 disconnected stores.**
`POST /commissioning/:id/activate-warranty` genuinely fires on sign-off, correctly computing
and setting `customer_equipment.warranty_status`. But there are **three separate warranty
tables with no cross-linking**: `customer_equipment` (written by commissioning),
`warranty_registrations` (read by one "expiring warranty" screen, under Operations), and
`product_warranties` (read by a *second*, separately-named "expiring warranty" screen, under
Projects). **A warranty activated via commissioning sign-off won't surface in either expiry
screen** unless someone separately registers it in one of the other two tables.

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

**→ Upsell**: ✗ **missing an operational path.** `ceo-intelligence.routes.js` computes a
real `upsell_opportunity` label (AMC Upsell / Expand Account) per customer, but its only
frontend consumer (`CEOIntelligenceDashboard.jsx`) renders it as a plain, unclickable
`<div>`. **Nothing turns the signal into an action** — no CRM opportunity, task, or
notification is ever created from it.

**→ Renewal**: ⚠ **a second, fully siloed mechanism exists beyond AMC.**
`sales.routes.js` has a complete, separate `subscriptions` table (plan/billing-cycle/
auto-renew/next-billing-date) with its own frontend page and manual pause/cancel/renew
endpoints — **wired to zero cron jobs** and not linked to `amc_contracts`, sales orders, or
Customer 360 at all. Two independent renewal mechanisms, not one unified pipeline.

**Chain 2 bottom line**: the transactional spine (CRM through Dispatch, and separately
Complaint through Service) is solid and already verified. The weak links are exactly the ones
that turn a completed sale into repeat revenue — Warranty visibility is fragmented, Upsell is
a label nobody can act on, and Renewal quietly runs on two disconnected tracks.

---

## Sources
- Existing scores/chain segments: `project_enterprise_workflow_audit` memory (Pass 7,
  2026-07-24) and its published artifact, `https://claude.ai/code/artifact/e78ffbd4-40cd-49ea-919c-f11e4cfa62e8`.
- Fresh findings (Travel/Asset/Installation/Warranty/Feedback/Upsell/Renewal): this session's
  research, 2026-07-27, against the live working tree.
- Visual version of this document: see the published Artifact linked from this session
  (title "Pulse Business Process Architecture").
