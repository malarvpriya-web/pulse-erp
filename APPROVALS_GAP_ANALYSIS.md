# Approvals Module — Gap Analysis (2026-10-19)

Scope: `backend/src/modules/approvals/*`, `services/WorkflowService.js`,
`services/WorkflowNotificationService.js`, `jobs/workflowEscalation.cron.js`,
`jobs/leave.cron.js` (SLA sweep), `home/home.service.js` (pendingApprovalUnion),
every module approve/reject route the Approval Center touches, and the
frontend pages `ApprovalCenter.jsx` / `MyRequests.jsx` + nav.

## 1. What already exists (reused, not rebuilt)

| Capability | Where it lives | State |
|---|---|---|
| Per-module approval rules | leaves (L1 manager → L2 dept head → L3 HR, `leave_types.l2_required`, balance deduction), reimbursement (manager → accounts → management → payment, `expense_claim_approvals`), attendance (manager → HR per `attendance_workflow_config`), procurement (amount bands + segregation of duties), ECN (parallel approvers in `engineering_change_approvals`), payment batches, travel requests/advances | Correct and complete **in each module** |
| Hierarchy / delegate checks | `shared/managerApprovalAuthz.js`, `attendance.authz.js` `assertCanDecideFor` (+ `attendance_approval_delegations` absence delegation) | Correct |
| Per-record delegation | `POST /leaves/delegate/:id`, `/reimbursement/claims/:id/delegate`, `/travel/requests/:id/delegate`, `/travel/advances/:id/delegate`; attendance absence delegation screen | Correct |
| Withdraw / resubmit | leave `POST /leaves/:id/withdraw` (pending or approved); travel advance `PUT /advances/:id/resubmit`; requisition/offer reject = back to draft for resubmission | Exists only where listed |
| Configured SLA | `workflow_steps.sla_hours` = **72h** (leaves/projects/travel manager steps); leave cron = 3 days | Configured |
| SLA escalation | `workflowEscalation.cron.js` (engine steps), `leave.cron.js` (leave > 3 days) | Exists — see defect D11 |
| Notifications | `WorkflowNotificationService.notifyWorkflowEvent`, module-specific notifiers | Exists |
| Approval Center read model | `getPendingApprovals` (10 source queries), `getMyRequests`, history, stats | Exists — defective, see below |

## 2. Defects found in the Approval Center

| # | Defect | Effect |
|---|---|---|
| D1 | Approve/Reject on a source item **re-implemented** each module's transition instead of calling it | Leave approved here skipped L2/HR **and never deducted leave balance**, no attendance sync, no LOP; expense jumped `pending→Approved` skipping accounts/management; regularization skipped the HR level; PR skipped segregation-of-duties; ECN ignored the other parallel approvers |
| D2 | Expense queried `status='Pending'`; the live workflow uses `Submitted / Manager Approved / Accounts Verified` | **No expense claim ever appeared** |
| D3 | Payment batches queried `'Awaiting_Approval'`; module uses `pending_approval`. Query also had **no company filter** | Never appeared; cross-tenant if it had |
| D4 | Travel requests (139 pending) and travel advances not included | Largest pending pool invisible |
| D5 | "Pending" list showed every company row to manager/hr (`isSupervisor` read rule) with "View only" badges | Not "awaiting MY decision" |
| D6 | KPI `pending` counted central `approvals` rows that the list excludes; overdue the same | KPI ≠ list (6 seed rows) |
| D7 | Approved/Rejected Today + SLA compliance read only the central `approvals` table | Decisions made in the modules never counted |
| D8 | Overdue = hard-coded 48h (backend `172800000` + frontend), while the configured SLA is 72h | Disagreed with the escalation crons |
| D9 | Source approve/reject notified the **approver** ("Your request was approved") instead of the requester | Requester never told |
| D10 | Delegate wrote an `employees.id` into `approved_by` columns (PR/ECN/expense/payment) | PR looked "approved by" the delegate while still pending; wrong person for `users.id` columns |
| D11 | `leave.cron.js` called `await notifyWorkflowEvent(...).catch()` — the function is deliberately void (phase3 test) | TypeError after the first escalation; the rest of the sweep aborted |
| D12 | Escalate on a source item returned 200 and did nothing; on a central row it set `Escalated` with no new approver | Request silently vanished from every queue |
| D13 | Requisition/offer approve had no tenant filter on the id | Cross-tenant decision by id |
| D14 | `GET /:id/chain` unscoped; empty for every source item | No visible chain for leave/expense/ECN levels |
| D16 | Leave cancel/withdraw (module route) failed every time: `updateStatus` hit the `$1` type-inference error, then wrote `approval_level = 0` into a column CHECKed to 1–3 | Nobody could withdraw a pending leave; HR bulk-approve and status update hit the same statement. Fixed (cast + migration `20261019000002`) |
| D15 | My Requests lacked current approver, View/Track, travel/requisition/ECN/offer; Pending tab of MyRequests duplicated the Approval Center | — |

## 3. UX gaps

* Two menu rows (Approval Center, My Requests) + a "My Approval History" tab; employees without the Approvals section could only reach My Requests through the account menu.
* No explanation of where requests are raised.
* SLA Compliance showed "—" with no meaning when there was no data.

## 4. Missing — reported, not invented

* **Return / Send back** exists only for requisitions and offers (reject returns them to draft). No other module has a send-back state; adding one would be a new rule.
* **Withdraw** exists only for leave. Expense, PR, OT, regularization, ECN have no withdraw route.
* **Resubmit** after rejection: leave = apply again; expense/PR = new request; travel advance and requisition/offer = native resubmit.
* `approver_config` (3 rows) is still read by nothing — routing is per module (documented in `home.service.js`).
* Module-side defects found in passing (not part of the 2026-10-19 change; **fixed 2026-10-20, see §6** — except the `submitterUserId` id-space item outside travel): ECN approve/reject gated by `engineering:add` with no tenant check; payment batch approve/reject has no tenant check; travel `PUT /requests/:id/status` has no pending-state guard; several modules pass an `employees.id` as `submitterUserId` to notifications.

## 5. Changes made

See the final report in the session; summary:
1. Approval Center decisions now **call each module's own endpoint** (descriptor built server-side per row) — no re-implemented transitions (fixes D1). The generic `/approvals/<type>:<id>/approve|reject` returns 409 `USE_MODULE_ENDPOINT` for those types.
2. One source registry (`approvals.sources.js`) for pending / my requests / history: fixes D2–D7, D13–D15; adds travel requests, travel advances, ECN parallel approvals, leave stages.
3. "Awaiting my decision" mirrors each module's authorisation rule exactly; KPIs are computed from the same rows as the lists.
4. Overdue uses the configured `workflow_steps.sla_hours` where one exists, else the previous 48h default — the hours are shown in the UI. SLA compliance = `null` → "No data".
5. Notifications to the requester for requisition/offer/central decisions (D9); delegate restricted to native per-record delegation (D10); escalate button removed, endpoint fixed (D12); leave cron fixed (D11).
6. One sidebar entry **Approvals** (visible to every role) → Approval Center with tabs My Pending Approvals / My Requests / Approval History. `MyRequests` page key now opens the same page on the My Requests tab.

## 6. Security hardening of the module decision routes (2026-10-20)

Regression suite: `backend/src/__tests__/approvalsSecurity.integration.test.js` — 26 tests against
the real database (isolated tenants 999981/999982, real login tokens, real routers). 23 of the 26
fail when the pre-hardening route files are swapped back in; all 26 pass on the current code.
Route-level detail: `MODULE_FEATURE_CONNECTION_MANUAL.md` §179.2.

| # | Finding | Status |
|---|---|---|
| S1 | ECN `/changes/:id` routes (read, edit, items, submit, approve, reject, implement, documents, signatures) loaded by id only — cross-company read and decision | **Fixed** — `loadEcn()` company gate; tested (404 for another company, forged body company ignored) |
| S2 | ECN approve returned `success:true` for a caller who is not an approver; reject let any `engineering:add` holder reject the whole change | **Fixed** — caller must hold a pending approver row (403); locked; tested incl. concurrent double-click |
| S3 | ECN parallel approvers | **Verified preserved** — one approval leaves it `submitted` (1 pending), last approver completes it; tested |
| S4 | Payment batch read / bank-file / submit / approve / reject / process had no company check | **Fixed** — company-scoped lock in the service; tested |
| S5 | Payment batch reject had no state check; submit could push an approved/processed batch back to pending (re-payable); concurrent process could pay twice | **Fixed** — transitions draft/rejected→pending→approved/rejected, approved→processed under row lock; concurrent process tested (200 + 409) |
| S6 | Travel status route: no company check, no transition guard (approved/rejected/cancelled could be overwritten or reopened), no concurrency control | **Fixed** — company 404, transition table, compare-and-set update; concurrent approve/reject tested (one wins, one audit row, ≤1 booking stub) |
| S7 | Travel level-approve, delegate, finance-post, advances (finance/manager review, resubmit, delegate, disburse), expense reimburse, approval trail — id-only | **Fixed** — company-scoped, status-conditional; level-approve/finance-post/trail/delegate tested |
| S8 | Travel configured levels and 72h SLA | **Verified unchanged** — tested (`workflow_steps` 72h; Approval Center row `sla_source: configured`) |
| S9 | Leave L2 decision needed only `leaves:approve` (any manager); HR-final likewise | **Fixed** — L2 / HR role sets enforced in the route (the roles the LeaveApprovals queues already used); tested |
| S10 | Leave delegate: any `leaves:approve` holder could re-point any company's leave at anyone (incl. the requester) | **Fixed** — `authorizeManagerApproval` + same-company active delegate, not the requester, L1 open; tested |
| S11 | Leave decision/read routes had no company check (HR override is company-less) | **Fixed** — `loadLeaveInCompany()` on 15 call sites; tested on L1, L2, HR, delegate, withdraw, single read, history |
| S12 | Leave generic status route: a decided leave could be reopened to pending and re-approved (balance deducted twice); a non-HR caller could cancel anyone's leave; no lock | **Fixed** — FOR UPDATE + transition table; owner-only cancel; concurrent HR approve tested (balance +1 once) |
| S13 | Leave history endpoint had no visibility check | **Fixed** — company + `canSeeApplication`; tested |
| S14 | Leave balance, 3-level history, requester notification after hardening | **Verified** — tested |
| S15 | Approval Center registry/queues/history tenant-scoped; generic endpoint still refuses module records | **Verified** — tested; ECN `canAct` mirror updated for changes with no named approvers |

### Policy gaps — final disposition (2026-10-20)

Tests: `backend/src/__tests__/approvalPolicies.integration.test.js` — 14 tests, real DB (tenants
999983/999984). 10 fail against the pre-policy code; the 4 that pass assert unchanged behaviour
(normal 3-level leave approval, withdraw, ECN parallel approval, batch processing). Route detail:
`MODULE_FEATURE_CONNECTION_MANUAL.md` §179.3.

| # | Gap | Status |
|---|---|---|
| P1 | Leave self-approval — HR/admin override, L2 and HR roles were identity-free, so a requester holding them could decide their own leave | **Closed** — 403 `SELF_APPROVAL_BLOCKED` on L1, L2, HR-final, generic status + aliases, bulk approve, workflow advance and delegate; actor resolved from `users.employee_id`. Leave stays pending; error reports the number of eligible alternates and, when 0, that an administrator must assign one. Department head's own leave routes to another L2-eligible user (tested: blocked for dh1, decided by dh2; Approval Center inbox follows). Tested: L1/L2/HR/status/alias/bulk/workflow/delegate, no-alternate company stays pending, normal approval + balance unchanged, withdraw unchanged |
| P2 | ECN with no named approvers approvable by any `engineering:add` holder | **Closed (fail closed; UI picker added so the BOM-change flow still works)** — submit refused (400 `APPROVERS_REQUIRED`); approve/reject of one already submitted refused (409 `APPROVER_CONFIGURATION_REQUIRED`, state unchanged); resolution via `PUT /changes/:id { approvers }` while none exist; named approvers vetted (same company, active, `engineering:add`, not the requester). Parallel approval unchanged. Registry offers it to nobody. All tested |
| P3 | Payment-batch creator could approve their own batch | **Closed** — 403 `SELF_APPROVAL_BLOCKED` under the row lock before any write; tested: status/approved_by unchanged, no payment, no approval notification or audit row; a different finance approver succeeds once under a double click; no-alternate company stays pending with an administrator message; tenant isolation and once-only processing still hold |

### Remaining limitations

- **ECN approvers in the UI:** the BOM-version flow (BOM Builder raises an ECN with an item but no
  approvers) would have stopped at Submit under P2, so the ECN page gained a narrowly scoped
  approver picker (shown only for a change with none; Submit disabled until one is saved). The
  page still has no impacted-items editor, so a hand-made ECN without a BOM link can only be given
  items through the API — pre-existing, unchanged.
- **"Eligible alternates" counts are informational** — they approximate each level's rule from
  roles/permissions (no module aliases, no Page-Access overrides). The routes still enforce the
  real rule for whoever acts.
- **Travel advances `employee_id` stores a users.id** (pre-existing data model), unchanged.

## 7. Final verification (2026-10-20)

| Workflow | Evidence (real DB unless noted) | Result |
|---|---|---|
| 1. Leave L1 → L2 → HR → requester status + balance | `approvalPolicies` (status, balance +1, My Requests "Approved", trail L1/L2/L3), `approvalsSecurity` | Pass |
| 2. Leave self-approval blocked at every level | `approvalPolicies` (L1, L2, HR, status + alias, bulk, workflow, delegate, no-alternate) | Pass |
| 3. ECN create → name approvers → submit → parallel → implement | `approvalPolicies` full path; picker eligibility (same-company user without engineering access → 400; dedupe); frontend `ecnApproverPicker` (Submit disabled until saved; saves login ids) | Pass |
| 4. BOM version → ECN → approver → submit → approve → implement → BOM promoted | `integration.planToProduce` | Pass |
| 5. Payment batch → independent approval → processing, no duplicate payment | `approvalPolicies` (2 lines → 2 payments, concurrent process 200/409) | Pass |
| 6. Cross-company denied: leave, ECN, travel, payment batch | `approvalsSecurity` | Pass |
| 7. Approval Center queues / My Requests / history / notifications / KPIs | `approvalsInbox`, `approvalsSecurity`, `approvalPolicies`, `smoke.approvals` | Pass |

Workflow suites together: 101/101. Full backend: 3,929 passed, 2 failed, 27 skipped (159 files).
Full frontend: 1,093/1,093. Production build: succeeds (3,408 modules).

Baseline (not caused by approvals work, unchanged): `employeeWriteScope` (`internConversion.js`
unscoped write), `testCleanupScoping` (`employeeEmailLoginSeparation` cleanup),
`internConversionWorkflow` (its beforeAll cleanup deletes companies before the
`interview_questions` rows another router seeds → FK error → vitest skips all 18 tests; a test-fixture
defect, not a runner problem). The other 9 skips are `phase1.test.js` migration smoke tests that
`skipIf(NODE_ENV === 'test')` by design.

**Browser check of the ECN approver picker (2026-10-20)** — isolated tenant 999985 with four
temporary users, logged in through the real login page: ECN created in the UI → picker shown,
Submit disabled → same-company HR user (no engineering access) rejected by the server with
"Every approver must be an active user in this company with engineering access." (toast; picker
stays, nothing saved) → two engineers saved as login ids → Submit enabled → submitted → first
approver leaves it submitted, second approves → requester marks it implemented. 17/17 checks.
Two picker defects found and fixed: the list showed "No matching colleagues." while still loading
(now "Loading colleagues…"), and the disabled Submit kept full styling (now dimmed, not-allowed
cursor). Tenant, users, ECN and its rows deleted afterwards (0 left). The impacted item was added
as a fixture because the page has no items editor (pre-existing, out of scope).
