# Pulse ERP — Employee Exit Lifecycle: Permanent Implementation Design

**Date:** 03 Nov 26 · **Status:** DESIGN ONLY, awaiting approval. No code, database or configuration has been changed for this document.
**Builds on:**
- `HR_MODULE_FUNCTIONAL_AUDIT_2026-11-03.md` (findings F-nn, D-nn);
- `HR_P0_REMEDIATION_DESIGN_2026-11-03.md` (P0-1…P0-7, MD-1…MD-16; full worked examples and journal tables);
- `HR_P0_CONTAINMENT_REPORT_2026-11-03.md` (containment C1–C7 and round 2, now live in the working tree);
- `HR_C4_ACCOUNT_VERIFICATION_2026-11-03.md`;
- `HR_C7_TDS_DECLARATION_POLICY_2026-11-03.md`;
- manual §228.

**Evidence.** Everything described as *existing* was read in the code, or measured read-only in the dev database, during this session. Anything else is marked **NEW**. Decisions that are management's are marked **⚑ ED-n** (exit decision) and collected in §17. Points that need legal or tax confirmation are marked ⚖.

---

## 0. Summary

**Today**, an exit can be started from **6 places**, edited from **4 screens**, and finalised by **3 independent paths**. It is held in two disconnected checklists. Its settlement:
- is computed by an engine that reads columns that don't exist;
- is "paid" by an HR click with no accounting.

Exited employees keep working logins and keep receiving company alerts. Earlier employment periods are overwritten on rehire.

**The proposal** is **one Exit Case** per separation, owned by **Exit Management**, moving through **one state machine** run by **one service**:

```
DRAFT → SUBMITTED → ACCEPTED → SERVING_NOTICE → LWD_REACHED → CLEARANCE_COMPLETE
      → SETTLEMENT_APPROVED (Finance) → SETTLED (paid & reconciled) → CLOSED
(+ WITHDRAWN, REJECTED, CANCELLED as terminal side-exits)
```

- **One writer.** Every other screen (Employee Profile, Ex-Employees, All Employees, Probation, Self Service) becomes a *read view* or a *launcher* into this case.
- **Status changes stay in sync.** Employee status, access, payroll, attendance, leave, assets and Finance move only on the case's transitions, in the same database transaction or through an idempotent event.

Containment (§228) already blocks every *bypass*. The permanent design replaces the containment switches with the real workflow, and then retires them.

---

## 1. Current state

### 1.1 Entry points (all verified)

| # | Entry point | Screen | Writes | Gate today |
|---|---|---|---|---|
| EP-1 | `POST /exit/initiate` | Exit Management → Initiate Exit | `exit_requests` (status `active`); employee → `Notice` | HR role (single `req.user.role`, F-16) |
| EP-2 | `POST /exit/requests` | none (API only) | `exit_requests` | HR role |
| EP-3 | `POST /employees/:id/offboard` | Employee Profile → Offboard | `exit_requests`; employee → `Notice` | `allowRoles(HR_ROLES)` |
| EP-4 | `PATCH /employees/ex/:id/exit-details` | Ex-Employees; Employee Profile | `employees.exit_date/exit_reason`; **inserts `exit_requests` with status `closed`** when none exists | `allowRoles(HR_ROLES)` |
| EP-5 | `PUT /employees/:id` status `Left` | All Employees → Terminate; Edit Employee | employee → `Left` | **Blocked** (round 2, 409) |
| EP-6 | `POST /employees` status `Left` | Add Employee | creates a `Left` employee | **Blocked** (round 2) |
| EP-7 | `DELETE /employees/:id` | none | status `terminated` + `deleted_at` | **Blocked** for current employees (round 2) |
| EP-8 | `PATCH /employees/:id/status` → `Left` | none | employee → `Left` | **Blocked** (C6) |
| EP-9 | `PUT /exit/requests/:id` | none | any status except `closed` | HR role |
| EP-10 | `POST /exit/requests/:id/withdraw` | Exit Management → Withdraw | reverses an exit; re-enables login if this exit revoked it | HR role |
| EP-11 | `PUT /exit/clearance/:employee_id` | Exit Mgmt → Clearance Tracker; Employee Profile | `exit_clearance` (one row per **employee**); `access_revoked` → `users.is_active=false` | HR role; one person signs every NOC (F-15) |
| EP-12 | `POST /hr/offboarding/:id/complete` | Exit Management → Offboarding tab | closes the exit; employee → `Left` | **Gated** (C6): needs paid F&F |
| EP-13 | `POST /exit/fnf/compute`, `PUT …/approve`, `POST …/pay` | Exit Mgmt → F&F Calculator | `net_payable`, `fnf_status`; pay closes the exit, employee → `Left`, sets `exit_date` | **Suspended** (C1/C3) |
| EP-14 | `exitStatusSync.cron.js` (08:45 IST) | none | `Notice` → `Left`/`terminated` on the LWD; **no `exit_date`** | none |
| EP-15 | `fnfAutoTrigger.cron.js` (09:00 IST) | none | `net_payable` | **Suspended** (C1) |
| EP-16 | `POST /employees/ex/:id/rehire` | Ex-Employees → Rehire | same employee row → `Active`; **overwrites `joining_date`**, clears `exit_date`; closes open exits; **does not** re-enable the login | `allowRoles(HR_ROLES)` |
| EP-17 | Probation decision "Terminated" | Probation Management | text on a notification row only (F-11) | — |
| EP-18 | `POST /exit/interview` | Exit Mgmt → Exit Interviews | `exit_interviews` (linked to `exit_request_id`) | HR role |

### 1.2 Current workflow and its defects (cross-referenced)

```
EP-1/3/4  ──► exit_requests 'active' (no resignation date, no acceptance, no notice snapshot) ──► employee 'Notice'
                │                                    (EP-4 can even create it already 'closed')
                ├─ clearance (per employee, HR ticks all NOCs, save errors swallowed)      F-15
                ├─ offboarding checklist (separate tables, global SEED templates)          D-02
                ├─ exit interview (optional, unlinked to completion)
                ├─ F&F engine: leave ₹0, notice vs TODAY, wrong salary source,
                │              no final salary/loans/claims, invented PF                   F-01..F-03
                └─ finalise ×3: F&F pay | Offboarding complete | LWD cron (no exit_date)    D-03, F-04
                       └─ login stays active unless "access revoked" ticked                F-06
```

**Measured live today (company 1):**
- 5 exit requests: 1 cancelled, 4 `active`, of which 2 belong to Active employees.
- **4 exited employees with active logins.** One account receives maintenance alerts daily; the Admin deactivation can't reach 2 of them (`users.company_id` NULL).
- Exit vocabulary drift: `separation_type` holds Standard / General / Primary; `fnf_status` holds `active`.
- `employees.notice_period_days` is NULL everywhere.
- `employment_type` is NULL for 41 of 47 employees.
- Offboarding templates have **no `company_id`** and all 5 are SEED rows.

---

## 2. Target architecture

### 2.1 Principles

1. **One Exit Case per separation.** `exit_requests` is kept and extended (not replaced) so history and FKs stay valid. One open case per employee is enforced by the database.
2. **One writer.** NEW `modules/hr/exitLifecycle.service.js` is the only code that changes:
   - an exit case's state;
   - `employees.status` into or out of an exit status;
   - `employees.exit_date`;
   - exit-driven login state.

   Routes, crons and other modules call it.
3. **Transitions are guarded transactions.** Each is `UPDATE … WHERE status = <expected> RETURNING`, so a concurrent action gets a 409. Same pattern as §202 claims.
4. **Side effects are explicit:**
   - In-transaction for state that must agree: employee status, `exit_date`, login, clearance creation, leave cancellation.
   - Idempotent outbox events for notifications and cross-module tasks.
5. **Fail closed.** A check that cannot be evaluated (a query error) blocks the transition. It never passes it (fixes the `Promise.allSettled` clearance gate).
6. **No silent business rules.** Notice, day rate, gratuity, encashment and access-timing rules are effective-dated policy values. Hardcoded defaults are seeded as *unverified* and block settlement through the release-gate pattern, exactly as payroll does.
7. **History is never overwritten.** Employment periods, case versions, settlement versions and NOC sign-offs are append-only. Corrections are new rows.

### 2.2 Components

| Component | Status | Responsibility |
|---|---|---|
| `exitLifecycle.service.js` | **NEW** | State machine, transition guards, the single writer |
| `exitPolicy.service.js` | **NEW** | Resolves notice days, LWD rules, access timing, encashment and gratuity parameters per company / employment type / grade, effective-dated |
| `noticeCalculator.js` | **NEW** (pure) | Required notice end, served days, shortfall, buy-out |
| `exitClearance.service.js` | **NEW**, replaces `computeClearanceBlockers` and the offboarding checklist | Per-case templated checklist; department NOCs; computed blockers |
| `settlement.service.js` | **NEW**, replaces `fnf.service.js` | Versioned F&F with component lines (P0-1) |
| `fnfJournal.service.js` | **NEW** in finance | Recognition and payment journals (P0-3) |
| `shared/accessRevocation.js` | **NEW** | Logins, tokens, push devices, reset codes, delegations, alert recipients (P0-4) |
| `exitDocuments.service.js` | **NEW** | Letters from `document_templates` (owner_module `exit`, the internship pattern) + PDF |
| `exitEvents` outbox + dispatcher | **NEW** | Notifications and cross-module tasks, once only |
| `shared/hrContainment.js` | existing | Retired at the end (Phase 6) |

---

## 3. Separation types

The six requested types, using the existing `separation_type` column with a CHECK.

| Type | Initiated by | Acceptance | Notice | LWD | Settlement specifics | Access revoked | Rehire default |
|---|---|---|---|---|---|---|---|
| `resignation` | **Employee** (Self Service, NEW) or HR on their behalf | Reporting manager; HR when the employee has no active manager (the existing L1 rule, `managerApprovalAuthz.js`) | Policy notice (⚑ ED-1); waiver or buy-out by approval | Required notice end, or an earlier agreed LWD (shortfall recoverable unless waived) | Notice shortfall **recoverable** | End of LWD (⚑ ED-6) | Eligible |
| `termination` | HR (with the manager's or department head's reference) | HR approver ≠ initiator | Per contract and policy; pay in lieu possible | Set by HR | Notice not served → **payable** pay in lieu (⚑ ED-2, ⚖) | **Immediate** on acceptance (⚑ ED-6) | Not eligible by default (the existing rehire rule refuses `terminated`) |
| `retirement` | HR, or the system suggests it from `dob` + retirement age (⚑ ED-4; no age setting exists today) | HR | None | Retirement date | No notice line; gratuity per rule | End of LWD | Eligible (consultancy rehire) |
| `death` | HR | HR | None | Date of death | No recoveries without a decision; gratuity regardless of the 5-year rule (⚑ ED-3, ⚖); **payee = nominee/legal heir** (needs a nominee record, §16) | **Immediate** | n/a |
| `absconding` (**NEW** type; today it is "termination" + reason text) | HR, after N days of unauthorised absence detected from attendance (⚑ ED-5) | HR | Per policy; usually treated as notice not served | Last day present | Shortfall recoverable; settlement may be **held** pending enquiry | **Immediate** | Not eligible by default |
| `contract_expiry` (**NEW** type) | System, from a **NEW** `employees.contract_end_date` (none exists today); HR confirms | HR | None (the contract ends) | Contract end date | No notice line | End of LWD | Eligible |

**Employee status during and after an exit (⚑ ED-7).**
- **During:** `Notice` from acceptance to the LWD, for every type with a future LWD. For an immediate termination, death or absconding the status goes straight to the exit status at acceptance.
- **After:** **one exit status, `Left`**, for every type (the existing decision recorded at `exitStatusSync.cron.js:21-26`). The type lives on the case.

The cron currently writes `terminated` for terminations. That one inconsistency is aligned to `Left`; existing `terminated`/`resigned` rows are mapped in migration (§18).

---

## 4. Workflow

### 4.1 Current versus proposed

| Stage | Current | Proposed |
|---|---|---|
| Initiate | 3 creators (EP-1/2/3), plus EP-4 creating closed cases; HR only; raw employee-id box | **One** `POST /exit/cases`. Employee resignation from Self Service; HR initiation with an employee **picker**; system suggestions (contract expiry, retirement, absconding) need HR confirmation |
| Accept | none | Manager/HR acceptance (resignation) or HR approval (others); records `accepted_at/by`, LWD, notice snapshot |
| Notice | `notice_period` free number, default 60 in F&F | Policy-resolved notice snapshot; waiver and buy-out as approved actions; LWD changes versioned |
| Clearance | one row per employee; HR ticks every NOC; separate offboarding checklist | One checklist **per case**, from company templates; each department's NOC signed by a holder of that department's permission; computed blockers fail closed |
| Interview | optional, unlinked | Scheduled at acceptance; required or waivable by policy (⚑ ED-10) before closure |
| Settlement | broken engine; HR approves and pays | Versioned settlement (P0-1); final salary through payroll (P0-2); HR prepares → HR approver → Finance approves and posts → payment → reconciliation (P0-3) |
| Finalise | 3 paths | **One** `close` transition, gated on clearance + settlement (or an approved nil settlement) + LWD passed |
| Access | manual tick only | Automatic at the policy moment (§6), plus manual early revoke |
| Documents | none | Acceptance letter, relieving letter, experience letter, F&F statement, NOC certificate; generated from templates; stored in the employee's documents |
| History | rehire overwrites dates | `employment_periods` rows; a rehire opens a new period |

### 4.2 State machine

| From | Action (API) | To | Who | Guards | In-transaction effects | Events |
|---|---|---|---|---|---|---|
| — | create (`POST /exit/cases`) | `DRAFT` (HR) / `SUBMITTED` (employee) | employee (own, resignation only) or `exit:add` | no open case; employee current; type allowed for initiator | case row, `version 1` | `exit.submitted` |
| DRAFT | submit | SUBMITTED | `exit:add` | required fields | — | `exit.submitted` |
| SUBMITTED | accept | ACCEPTED → SERVING_NOTICE (future LWD) or LWD_REACHED (LWD ≤ today) | acceptor per type (§3); ≠ initiator for HR-initiated | LWD ≥ resignation date; notice snapshot resolved (policy verified) | employee → `Notice` (or the exit status if immediate); clearance checklist instantiated; leave after the LWD auto-cancelled (§10); interview scheduled; immediate types → `revokeEmployeeAccess` | `exit.accepted` |
| SUBMITTED | reject | REJECTED | acceptor | reason required | — | `exit.rejected` |
| DRAFT/SUBMITTED/ACCEPTED/SERVING_NOTICE | withdraw | WITHDRAWN | employee (own resignation, before acceptance) or `exit:edit` | before the LWD; settlement not posted | employee back to the prior status (Active, or Probation inside its window: the existing EP-10 rule); clearance voided; leave cancellations reversed only if still future; access re-enabled **only** if this case revoked it | `exit.withdrawn` |
| SERVING_NOTICE | change LWD | SERVING_NOTICE | `exit:edit` (+ approval when shortening below notice) | new LWD ≥ today | case version +1, reason, approver | `exit.lwd_changed` |
| SERVING_NOTICE | LWD passed (cron, 00:05 IST next day) | LWD_REACHED | system | — | `employees.status = Left`, `exit_date = LWD`, employment period closed, `revokeEmployeeAccess` (per ⚑ ED-6) | `exit.lwd_reached` |
| LWD_REACHED | all mandatory clearance items signed | CLEARANCE_COMPLETE | system (on the last sign-off) | every computed blocker clear (fail closed) | — | `exit.clearance_complete` |
| CLEARANCE_COMPLETE | settlement Finance-approved and posted | SETTLEMENT_APPROVED | Finance (P0-3) | settlement version current | journal posted | `exit.settlement_approved` |
| SETTLEMENT_APPROVED | payment recorded / reconciled | SETTLED | Finance | payment ref (UTR) | payment journal | `exit.settled` |
| SETTLED | close | CLOSED | `exit:edit` (or automatic) | interview done/waived; letters issued (⚑ ED-10) | relieving letter issued if not yet; case locked | `exit.closed` |
| any non-terminal | cancel (data error only) | CANCELLED | `exit:delete` + reason | nothing posted to Finance | full reversal as withdraw | `exit.cancelled` |

**Settlement may run in parallel with clearance.** HR may prepare it from LWD_REACHED; Finance approval waits for CLEARANCE_COMPLETE. Absconding cases may be put **ON_HOLD** (NEW flag, with reason) at any state before SETTLED.

---

## 5. Notice period and last working day

**Policy resolution (⚑ ED-1).** NEW `exit_policies`, effective-dated per company, holds notice days by employment type / grade / probation status, with a default. Today's code has two values, neither approved: the F&F default of 60, and a free-typed `notice_period`. This design does **not** pick a value.

**Fields snapshotted on the case at acceptance:**
- `resignation_date` (the date it was tendered);
- `accepted_at`, `accepted_by`;
- `notice_days_required`, `notice_rule_ref`;
- `notice_start` (⚑ ED-1: tender date, next day, or acceptance date);
- `required_notice_end = notice_start + notice_days_required − 1` (calendar days; working-day counting is an ED-1 option);
- `last_working_date` (agreed);
- `waived_days`, `waiver_reason`, `waived_by` (approval);
- `buyout_requested` (employee pays the shortfall instead of serving).

**Calculation (pure, `noticeCalculator.js`):**
- `served_days = max(0, min(LWD, required_notice_end) − notice_start + 1)`
- `shortfall_days = max(0, required_notice_end − LWD − waived_days)`
- Direction (recoverable / payable / none) comes from the separation type (§3).
- **It never reads today's date.** That fixes F-02.

**Example** (resignation tendered and accepted 01 Oct 26, 60 days from the next day, agreed LWD 31 Oct 26):

| Field | Value |
|---|---|
| Notice start | 02 Oct 26 |
| Required notice end | 30 Nov 26 |
| Served | 30 days |
| **Shortfall** | **30 days** |

This is the same result whenever it is computed. Today's code gives 0, 15 or 60 days depending on the click date (P0-1 §10).

**Changes after acceptance** are versioned (`exit_case_versions`, NEW): old and new LWD, reason, approver. The settlement is marked stale on any change.

---

## 6. Access revocation (sessions and tokens)

**What exists** (verified):
- JWTs live 8 h, or 30 days with remember-me, and are refreshable for 7 days after expiry.
- Every request and refresh re-checks `users.is_active` and `logout_at`.
- No server-side session list (`active_sessions` / `revoked_tokens` are SEED-only).
- The only revocation path is the clearance tick, matched through `users.employee_id`.
- The Admin deactivation cannot reach logins with `users.company_id` NULL.

**Design: `revokeEmployeeAccess(client, { employeeId, companyId, caseId, reason, actor })`**, called inside the state transition:
1. **Find every login** linked to the person through `users.employee_id`. Logins matched only by email are **reported** to HR, never revoked automatically.
2. Set `is_active = false` and `logout_at = now()`, and record a NEW `deactivated_reason` with the case id. Every issued token is refused on its next use, including refresh.
3. **Delete `device_push_tokens`** for those logins. The count goes into the audit entry; the tokens themselves are not audit data.
4. **Invalidate unused `password_reset_otps`.**
5. **End delegations** granted *to* the person (`attendance_approval_delegations` and approval delegates).
6. **Create HR tasks** for:
   - pending approvals where they are the approver;
   - direct reports (reassign the reporting manager);
   - department-head mappings;
   - **role-targeted alert subscriptions.** EMP034 is still receiving maintenance alerts today.

   Approval routing already skips exited managers (`approvals.sources.js:98`), so nothing is blocked meanwhile; the tasks only correct ownership.
7. **Write one audit entry**, and set `exit_clearance.access_revoked_at/by`.

**When it runs (⚑ ED-6, proposal):**
- resignation, retirement, contract expiry: the LWD job at 00:05 IST on the day **after** the LWD;
- termination, absconding, death: at acceptance;
- HR may revoke early at any time.

**Defence in depth:** `verifyToken` also refuses a login whose linked employee is exited with `exit_date < today`, so a missed step still fails closed. The DB-error fallback in `verifyToken` (which accepts the token alone) becomes **fail-closed for employee-linked logins**. That is an availability trade-off (⚑ ED-12).

**Not automatable today:**
- removal from biometric devices (node-zklib user deletion is not implemented) — a clearance item for IT;
- physical access cards — none modelled.

**Ex-employee access to payslips and Form 130/16:**
- delivered by email from Payroll (the existing payslip email path);
- or a time-boxed, read-only download link (⚑ ED-11).

The employee login is never kept alive for this.

**Rehire or reversal:** re-enabling happens only through withdraw (this case's revocation) or rehire (NEW: an explicit "re-enable login" step), and is audited.

---

## 7. Clearance

**Replaces** `exit_clearance` booleans, the separate `hr_offboarding_checklist_*` tables, and `computeClearanceBlockers` (D-02).

- **Templates (NEW `exit_clearance_templates`, per company):**
  - department (`IT`, `Admin`, `Finance`, `HR`, `Reporting Manager`, plus any company-defined departments such as Stores and Projects);
  - item label; mandatory flag; applicable separation types;
  - due-day offset from the LWD;
  - **owner permission** (e.g. `exit_clearance_it:approve`) — who may sign.

  The 5 existing global SEED templates are not migrated (§18).
- **Instance (NEW `exit_clearance_items`, per case):** created at acceptance from the templates. Each item has:
  - status (`pending` / `cleared` / `not_applicable` / `blocked`);
  - signer (`employees.id` via `employeeOf`) and signed time;
  - remarks; optional evidence file;
  - a recovery amount (e.g. an unreturned asset valued for recovery, flowing to the settlement).
- **Computed items.** System-checked, they cannot be ticked by hand. Each re-evaluates **fail-closed**:

| Computed item | Cleared when |
|---|---|
| Assets | no `employee_asset_allocations` row in status ≠ `returned`/`disposed` |
| Travel advances | settled, or carried into the settlement as a recovery (⚑ ED-8) |
| Payroll loans | carried into the settlement (P0-1) or settled |
| Expense claims | none pending (⚑ ED-8: pay through the claims flow or carry into the settlement) |
| Access | access revoked (§6) |
| Final payroll | the final month's run is approved (§9) |

- **NOCs are signed by the right person.** The reporting manager's item can only be signed by the current reporting manager (or HR when there is none, the existing rule). Finance's item can only be signed by a Finance permission holder. That fixes F-15: today one HR save records every NOC under the HR person's name.
- **SLA and reminders:** due date from the template offset; reminders through the outbox (§12).
- **UI:** one Clearance view per case, grouped by department. Each department also sees a **"My clearance queue"** (NEW) listing the cases waiting on it.

---

## 8. Final settlement

The full formulas, edge cases and worked examples are in **P0-1** of the remediation design. This section fixes how settlement fits the lifecycle.

| Component | Source | Notes |
|---|---|---|
| **Final month's salary** | **Payroll**, never the settlement | Leaver's month generated with proration to the LWD (P0-2: eligibility E2 made date-based; `exit_date` set at LWD_REACHED; proration also honours a pending LWD while in Notice). Off-cycle single-employee final run if ⚑ ED-9 (⚖ Code on Wages s.17(2) two-working-day rule to be confirmed) |
| Leave encashment | `leave_balances` (encashable types; balance = opening + allocated + carried forward − used − encashed) at the LWD | Caps and pro-rating per ⚑ ED-13; `encashed_days` updated **only** when Finance approves |
| Gratuity | NEW `gratuity.*` effective-dated rule | Eligibility, part-year rounding, wage base, ceiling (⚑ ED-3, ⚖) |
| Notice | `noticeCalculator.js` (§5) | Direction by separation type |
| Recoveries | loans (`outstanding_balance` after the final payroll), travel advances, unreturned assets (clearance recovery amounts), notice shortfall | ⚑ ED-8 |
| Payables | approved, unpaid claims (if ⚑ ED-8 = carry into settlement), bonus/arrears due | — |
| Tax | final-month TDS through payroll; settlement components taxed per ⚖ ED-14 | No separate tax engine in the settlement |

**Versioned.** `fnf_settlements` + `fnf_settlement_lines` (P0-1 §6). Any change to an input after HR approval creates a new version. A posted version is reversed, never edited.

**Day rate** is an approved policy value. The current `basic/26`, used both here and in leave encashment, is seeded as unverified (⚑ MD-1).

---

## 9. Finance approval, accounting and payment

This is P0-3, unchanged in substance.

```
DRAFT (HR) → SUBMITTED → HR_APPROVED (≠ preparer) → FINANCE_APPROVED + POSTED (JE-1, same txn)
          → PAYMENT_SCHEDULED (payment batch item, payee = employee / nominee)
          → PAID (UTR, date, bank a/c; JE-2) → RECONCILED (bank statement line matched)
negative net → RECEIVABLE → RECOVERED | WRITTEN_OFF (approval)    correction → REVERSED (reversal_of_id) + new version
```

**Lifecycle coupling:**
- `FINANCE_APPROVED` moves the case to SETTLEMENT_APPROVED.
- `PAID` (or `RECONCILED`, per ⚑ ED-15) moves it to SETTLED.
- A **nil settlement** still passes Finance approval: one click, recorded, no journal.

**Accounts.** Finance creates or names the accounts (⚑ MD-10). The COA has none today for gratuity, leave encashment, notice recovery, F&F payable, employee receivable or rounding.

**Payee:**
- the employee's **verified** bank account;
- for death, the nominee or legal heir with Finance-approved bank details (needs the NEW nominee record).

`payment_batch_items` gains an employee payee (P0-3).

**Posting must be atomic.** A posting failure aborts the approval. This is unlike payroll approval today, which logs "GL posting skipped" and continues.

---

## 10. Integrations

| Module | Today | Proposed | Trigger |
|---|---|---|---|
| **Attendance** | Auto-absent job covers only `active`/`probation`, **not `Notice`** (`attendance.cron.js:68`), so unmarked notice-period days never become absent/LOP. Biometric import maps current statuses only. No clock-in check for exited employees (login revocation is the only stop). | Auto-absent includes `Notice` (⚑ ED-16, it changes pay). The attendance clock refuses an employee after `exit_date`. Absconding detection: N consecutive unauthorised absences raise an HR suggestion (⚑ ED-5) | daily job; `exit.lwd_reached` |
| **Leave** | Accrual excludes only `Left`. Approved leave after the LWD is untouched. | At acceptance, approved or pending leave dated after the LWD is cancelled (balance restored; employee notified). New applications beyond the LWD are refused. Accrual stops at `exit_date` (pro-rated per ⚑ ED-13). The settlement reads the closing balance. | `exit.accepted`, `exit.lwd_changed` |
| **Payroll** | Leaver dropped by E2; draft deleted on regeneration; full month paid while in Notice | P0-2: E2 date-based; proration end = `COALESCE(exit_date, pending LWD)`; release-gate blocker `LEAVER_NOT_IN_RUN`; "Leavers this period" panel; settlement waits for the final run | `exit.accepted` sets the pending LWD |
| **Finance** | Nothing | §9 | settlement transitions |
| **Assets** | Exit blocker reads open allocations (works) | Computed clearance item; allocation `returned` updates the item live; unreturned asset → recovery line (value per ⚑ ED-8) | allocation status change |
| **Travel / Expense** | Travel advance blocks pay; claims ignored | Computed items + settlement lines (⚑ ED-8) | — |
| **Employee Records** | Exit fields edited in 3 places | Employee Profile "Exit" tab and Ex-Employees become **read-only views** of the case, with a link to it. Letters stored in `employee_documents` (document type `exit_*`). Rehire creates a new `employment_periods` row. | case transitions |
| **Approvals Center** | No exit source | NEW sources `exit` (acceptance), `exit_clearance` (department sign-offs, per signer) and `fnf` (HR approval and Finance approval) | — |
| **Org / Reporting** | Exited managers are skipped in approval routing | HR task to reassign direct reports and department head at acceptance; Org Chart shows "leaving on <LWD>" | `exit.accepted` |
| **Probation** | "Terminated" decision has no effect (F-11) | The HR "Not confirmed" decision creates an exit case of type `termination` in DRAFT for HR to submit | probation decision (P1) |
| **Succession** | — | `exit.accepted` raises a succession alert when the employee holds or is a successor for a critical role | `exit.accepted` |
| **Recruitment** | — | Optional "raise backfill requisition" action on acceptance (⚑ ED-17); not automatic | manual |
| **Notifications / alerts** | Role-targeted alerts keep going to exited logins | Alert recipient resolution excludes inactive logins (one shared filter) | — |

---

## 11. Employee status and history

**The only status writes** go through `exitLifecycle.service`:

| Transition | When |
|---|---|
| current → `Notice` | ACCEPTED with a future LWD |
| `Notice` → `Left` | LWD_REACHED |
| current → `Left` | immediate types at ACCEPTED |
| `Notice` → previous status | WITHDRAWN |
| `Left` → `Active` / `Probation` | **rehire** (moves into the lifecycle service; see below) |

**The containment guards become permanent.** The route-level guards from round 2 (PUT/POST/DELETE/PATCH refusing exit statuses) remain. A **DB trigger** on `employees` refuses a change into or out of an exit status unless the transaction set `pulse.exit_lifecycle = on` (`SET LOCAL`), as `trg_interns_completion_guard` does for interns.

**Employment history: NEW `employment_periods`.**
- Columns: `employee_id, company_id, start_date, end_date, exit_case_id, separation_type, rehire_of_period_id`.
- **Backfilled:** one open period per employee from `joining_date`; closed periods for exited employees from `exit_date`.
- **Rehire** closes nothing, opens a new period, and **no longer overwrites history**. `employees.joining_date` stays the *current* period's start for backward compatibility, and earlier periods remain queryable.
- **Service-dependent rules** (gratuity years, leave accrual) read the *current* period unless policy says continuous service counts (⚑ ED-18).

**Audit.** Every transition writes `audit_logs` with before/after, using `logAudit` with masking. **Case versions** (`exit_case_versions`) record every changed field: LWD, notice, type, waiver.

---

## 12. Notifications and audit trail

**Mechanism.** NEW `exit_events` outbox, written in the transition's transaction. A dispatcher sends through the existing `notificationsRepository` + `dispatchSideEffects`, once only by event id (the announcement `notified_at` pattern). Recipient logins are resolved through the employee's company, because `users.company_id` is NULL for 24 of 37 employee-linked logins (measured 03 Nov 26).

| Event | Recipients | Channel (⚑ ED-19) |
|---|---|---|
| `exit.submitted` | acceptor (manager or HR); HR | in-app (+ email) |
| `exit.accepted` | employee; HR; IT; Admin; Finance; manager; each clearance department | in-app + email |
| `exit.rejected` / `exit.withdrawn` / `exit.cancelled` | employee; acceptor; HR; departments with open items | in-app |
| `exit.lwd_changed` | employee; departments; Payroll | in-app |
| clearance item due / overdue | the item's department signers | in-app (daily digest) |
| `exit.lwd_reached` | HR; IT (access revoked confirmation); Payroll | in-app |
| `exit.clearance_complete` | HR; Payroll/Finance (settlement can be approved) | in-app |
| settlement submitted / HR-approved / Finance-approved / paid | next actor; HR; employee (statement on approval; payment advice on paid, to **personal email** after revocation) | in-app / email |
| `exit.closed` | employee (relieving letter, personal email); HR | email |
| access revoked | HR; IT | in-app |

**Audit coverage:**
- every transition (who, when, before/after);
- each NOC sign-off;
- each settlement version and Finance action;
- each access revocation (user ids, tokens and push devices removed);
- each letter issued (template version, file hash).

Nothing in the lifecycle is hard-deleted.

---

## 13. Exit interview and documents

**Exit interview:**
- `exit_interviews` exists, linked by `exit_request_id`.
- **Scheduled** at acceptance, interviewer default HR.
- Employees may fill a **self-service questionnaire** (NEW) before the LWD.
- Required, or waivable with reason, before CLOSED (⚑ ED-10).
- Confidential: HR-only read, as today.
- Analytics stay on the existing `/exit/interviews/analytics`.

**Documents**, generated from **`document_templates`** (owner_module `exit`, per company, `{{placeholder}}` validation, following the existing `shared/internshipTemplates.js` + PDF pattern):

| Document | When | Content source |
|---|---|---|
| Resignation letter (upload) | submission | employee upload (real file; the multipart path exists) |
| Acceptance letter | ACCEPTED | case: LWD, notice, waiver |
| No-dues / clearance certificate | CLEARANCE_COMPLETE | clearance sign-offs |
| F&F statement | Finance approval | settlement lines (version) |
| Relieving letter | CLOSED (or LWD for policy) | case |
| Experience / service certificate | CLOSED, or on request | employment periods, designation |

- **Storage.** Stored as `employee_documents` rows (document type `exit_*`, `exit_case_id`), visible to the employee in the document vault until access ends. They are sent to the personal email at closure (⚑ ED-11).
- **Retention** per the existing document policy (⚑ ED-20).
- **Signatures.** If e-signature is required, the existing Zoho Sign integration can be used (⚑ ED-21; not verified for this flow).

---

## 14. Page-level changes

| Page | Change |
|---|---|
| **Exit Management** (`ExitCenter` → `ExitManagement`) | Becomes the **case workspace**. A list of cases with state, type, LWD, blockers and settlement state. Filters: state, type, department, LWD range. A case detail with a stage stepper: Overview · Notice · Clearance · Interview · Settlement · Documents · History. "Initiate Exit" uses an employee **picker** (replacing the raw id box) and all six types. The F&F Calculator and Clearance Tracker tabs fold into the case detail. |
| **Offboarding tab** | **Removed.** Its templates move to Exit Settings, and its per-employee checklist becomes the case's clearance. The `ExitCenter?tab=offboarding` URL redirects to the case list. |
| **Exit Settings** (NEW, inside Exit Management, `exit:edit`) | Policies (notice, access timing, interview requirement), clearance templates, letter templates |
| **Self Service** | NEW **Resignation** tab: tender (date, reason, resignation letter upload, proposed LWD), see status, withdraw before acceptance, fill the exit questionnaire, download issued letters |
| **Approval Center** | NEW sources `exit`, `exit_clearance`, `fnf` |
| **"My clearance queue"** (NEW, or a filter of Approval Center) | Department signers' pending items |
| **All Employees** | Terminate keeps the hand-off (round 2). Row badge "Leaving <LWD>" for cases in notice. |
| **Add / Edit Employee** | `Left` not offered (round 2). NEW fields: `contract_end_date`, nominee details (if ⚑ ED-3 adopts a nominee record), `notice_period_days` if policy is per employee (⚑ ED-1). |
| **Employee Profile** | The Exit tab becomes **read-only** with "Open exit case" (removes EP-3 and the EP-11 profile copy). Clearance buttons removed. |
| **Ex-Employees** | Read-only exit details from the case (removes EP-4). Rehire moves to the lifecycle service (new employment period; explicit re-enable-login step). |
| **Probation Management** | "Not confirmed" opens a DRAFT termination case (P1 integration) |
| **Payroll Center → Processing** | "Leavers this period" panel (P0-2) |
| **Finance** | NEW "F&F settlements" queue: approve/reject, post, schedule payment; reconciliation status |
| **Workforce Analytics** | Attrition from cases (type, reason, notice served). Lifecycle KPIs: open exits, overdue clearance, settlements pending Finance. |

---

## 15. API changes

**New** (all under `/exit/cases`; `requirePermission` with multi-role `rolesOf`; `companyOf` fail-closed):

| Method & path | Purpose |
|---|---|
| `GET /exit/cases` · `GET /exit/cases/:id` | list / detail (with blockers, settlement summary, history) |
| `POST /exit/cases` | create (HR); `POST /self-service/resignation` (employee, own) |
| `POST /exit/cases/:id/{submit,accept,reject,withdraw,cancel,close,hold,release}` | transitions |
| `PUT /exit/cases/:id/lwd` · `POST /exit/cases/:id/notice-waiver` | LWD change (versioned) / waiver (approval) |
| `GET /exit/cases/:id/clearance` · `POST /exit/clearance-items/:itemId/{clear,not-applicable,block}` | clearance per case; sign-off by department permission |
| `GET /exit/clearance-queue` | my department's pending items |
| `POST /exit/cases/:id/settlement` (compute → new version) · `POST /exit/settlements/:id/{submit,hr-approve,reject}` | HR side |
| `POST /finance/fnf-settlements/:id/{approve,reject,schedule-payment,record-payment,reverse}` · `GET /finance/fnf-settlements` | Finance side (`fnf_settlement:approve`, payment permission) |
| `POST /exit/cases/:id/revoke-access` | early manual revoke |
| `GET/PUT /exit/settings/{policies,clearance-templates,letter-templates}` | Exit Settings |
| `POST /exit/cases/:id/documents/:key` · `GET …/documents` | generate / list letters |
| `POST /exit/cases/:id/interview` · `GET /self-service/exit-questionnaire` | interview |

**Changed:**
- `POST /employees/ex/:id/rehire` → delegates to the lifecycle service (new employment period; optional login re-enable).
- `GET /exit/active`, `GET /exit/employee/:id` → read from cases (same shape plus new fields).
- Payroll eligibility and proration (P0-2).
- Attendance auto-absent filter (⚑ ED-16).
- Leave application validation (no leave beyond the LWD).
- `verifyToken` (§6).

**Retired.** Each keeps its route with **410 `EXIT_MOVED`** (body naming the new endpoint) for one release, then is removed:

| Retired | Replaced by |
|---|---|
| `POST /exit/initiate`, `POST /exit/requests` | `POST /exit/cases` |
| `PUT /exit/requests/:id` | transitions |
| `POST /employees/:id/offboard` | `POST /exit/cases` |
| `PATCH /employees/ex/:id/exit-details` | case LWD/type (read-only elsewhere) |
| `PUT /exit/clearance/:employee_id`, `GET /exit/clearance/:employee_id[/status]` | case clearance |
| `/hr/offboarding/*` (6 routes) | case clearance + Exit Settings |
| `POST /exit/fnf/compute/:employee_id`, `PUT /exit/fnf/:id/approve`, `POST /exit/fnf/:id/pay` | settlement + Finance routes |
| `POST /exit/requests/:id/withdraw` | `POST /exit/cases/:id/withdraw` (same rules) |

**Crons:**
- `exitStatusSync` → the LWD transition (00:05 IST, next day).
- `fnfAutoTrigger` → "settlement not started N days after LWD" reminder (no computation, no write).
- NEW clearance-due digest.
- NEW contract-expiry / retirement suggestions (⚑ ED-4).

---

## 16. Database changes

All additive, in migration order. Pre-checks run before every constraint.

1. **`exit_requests`** (kept as the case table):
   - columns: `company_id` (backfilled from `employees`), `case_status` (new vocabulary; `status` kept as a mirror, §18), `resignation_date`, `submitted_at/by`, `accepted_at/by`, `rejected_at/by`, `reject_reason`, `notice_days_required`, `notice_rule_ref`, `notice_start`, `required_notice_end`, `waived_days`, `waiver_reason`, `waived_by`, `buyout_requested`, `on_hold`, `hold_reason`, `closed_at/by`, `version`;
   - CHECKs on `case_status` and `separation_type` (6 values);
   - **partial unique index** — one open case per employee.
2. **`exit_case_versions`** (NEW): case id, version, changed fields jsonb, reason, actor, at.
3. **`exit_policies`** (NEW): company, effective_from, scope (employment type / grade / probation), notice days, notice start rule, access timing per type, interview requirement, status (`unverified` / `verified`), evidence.
4. **`exit_clearance_templates`** (NEW, per company) and **`exit_clearance_items`** (NEW, per case).
5. **`fnf_settlements`, `fnf_settlement_lines`** (NEW; P0-1/P0-3 columns).
6. **`payment_batch_items`**: `payee_type`, `employee_id`, `source_type`, `source_id`, with a CHECK (P0-3).
7. **`exit_events`** (NEW outbox): id, case id, type, payload, created_at, dispatched_at.
8. **`employment_periods`** (NEW), backfilled.
9. **`employees`**: `contract_end_date`, `retirement_date` (or derived, ⚑ ED-4); nominee (NEW `employee_nominees` table, ⚑ ED-3); guard trigger (§11).
10. **`exit_clearance`**: `access_revoked_at/by` (P0-4). The table becomes read-only legacy after migration.
11. **`users`**: `deactivated_reason`.
12. **`employee_documents`**: `exit_case_id` (nullable FK).
13. **`statutoryRules`**: `gratuity.*` rule keys (code, not schema).
14. **Permission matrix:**
    - `exit` (vaedx);
    - `exit_clearance_<dept>` (approve);
    - `fnf_settlement` (add/edit/approve);

    seeded for the HR, Finance, IT and Admin roles (⚑ ED-22).
15. **FKs added `NOT VALID`, then validated after reconciliation:** `exit_requests.employee_id` (exists), `exit_interviews` (exists), new tables' FKs, `hr_policy_acknowledgements.employee_id` (out of scope here).

**Not created:** a second case table. **Not dropped** in this programme: `exit_clearance`, `hr_offboarding_checklist_*`, `onboarding_records` / `onboarding_tasks` (any drop is a separate approved migration after a retention window).

---

## 17. Business decisions required (⚑)

These are consolidated, deliberately without defaults. Where an MD-n from the P0 design applies, it is referenced.

| ID | Decision | Today |
|---|---|---|
| ED-1 | Notice days by employment type / grade / probation; notice start (tender / next day / acceptance); calendar vs working days; buy-out allowed? (= MD-3, MD-4) | 60 default in F&F; free-typed value; `notice_period_days` NULL everywhere |
| ED-2 | Termination without notice served: pay in lieu basis (Basic / Gross; days) ⚖ (= MD-5) | Always recovered |
| ED-3 | Gratuity eligibility, rounding, wage base, ceiling, death/disablement; nominee record ⚖ (= MD-7) | Floors years; Basic; ₹20 L |
| ED-4 | Retirement age; system suggestions for retirement and contract expiry | none; no contract end date |
| ED-5 | Absconding: N days of unauthorised absence, enquiry/show-cause procedure, settlement hold | recorded as termination + reason |
| ED-6 | Access timing per type (end of LWD vs immediate) (= MD-12) | manual |
| ED-7 | Single exit status `Left` for all types (cron's `terminated` aligned)? | mixed |
| ED-8 | Loans, advances, claims, unreturned assets: recover through settlement, or block until settled; asset valuation basis (= MD-8) | advance blocks; others ignored |
| ED-9 | Off-cycle final salary run; final-wage timing ⚖ (= MD-9) | monthly batch only |
| ED-10 | Exit interview mandatory or waivable; letters mandatory before closure | optional |
| ED-11 | Ex-employee delivery of payslips, Form 130 and letters (email vs time-boxed link) (= MD-12) | — |
| ED-12 | `verifyToken` fail-closed for employee logins on DB error (availability trade-off) | fail-open |
| ED-13 | Leave encashment at exit: types, caps, pro-rating, negative balance (= MD-6); accrual after LWD | broken |
| ED-14 | Taxability of settlement components ⚖ (= MD-16) | — |
| ED-15 | Case SETTLED at PAID or at RECONCILED | — |
| ED-16 | Auto-absent for employees in Notice (affects pay) | excluded |
| ED-17 | Backfill requisition prompt on acceptance | — |
| ED-18 | Rehire: continuous service or new service for gratuity/leave | overwrites dates |
| ED-19 | Email on which events; to personal email after exit | in-app only today |
| ED-20 | Retention of exit documents and interview data | — |
| ED-21 | E-signature on letters | — |
| ED-22 | Permission grants for the new modules per role | — |
| MD-1, MD-2, MD-10, MD-11 | Day rate; salary source; GL accounts; Finance approvers, bank account, write-offs | (P0 design) |

---

## 18. Migration and backward compatibility

**Data mapping (live counts measured today; each step is a dry-run report first, then a guarded and audited transaction, with approval):**

| Current | Proposed |
|---|---|
| `exit_requests` #1 (cancelled) | `case_status = CANCELLED` |
| #15 EMP010 (`active`, F&F `approved` ₹0, LWD 18 Aug, employee `resigned`) | `LWD_REACHED`; settlement "legacy, invalid" (P0-1 §9); employee status → `Left` |
| #16 EMP027, #17 EMP037 (open exits on Active employees) | HR decides per case: cancel, or SERVING_NOTICE/LWD_REACHED |
| #18 EMP011 (`active`, employee `Left`) | `LWD_REACHED` |
| EMP014, EMP034 (`Left`, **no case**) | retrospective case (type absconding / termination; LWD = `exit_date`), created in `LWD_REACHED` with an audit note, so clearance and settlement can run |
| `separation_type` Standard / General / Primary | mapped per case by HR (no automatic guess) |
| `exit_clearance` rows (4) | read-only legacy; values copied into the new case items as "migrated" sign-offs attributed to the original actor where recorded |
| `hr_offboarding_checklist_progress` (5) / templates (5, global SEED) | not migrated; the tables are kept read-only |
| `employees.status` values `resigned` / `terminated` | → `Left`; the original value is kept in `employment_periods.separation_type` |
| employment periods | backfilled from `joining_date` / `exit_date` |

**Compatibility:**
- `exit_requests.status` and `fnf_status` keep being written as a **mirror** of the new state for one release, for the Ex-Employees list, Workforce attrition CSV, `GET /exit/active`, `exitWithdraw` and similar readers. Then readers are switched and the mirror is dropped (separate approval).
- Retired endpoints return **410 `EXIT_MOVED`** naming the replacement. This is announced to API users before removal.
- **Containment switches stay ON** until each phase's replacement is live. Then:
  - `HR_CONTAINMENT_FNF` is removed when Phase 4 ships;
  - `HR_CONTAINMENT_EXIT_STATUS` is removed when Phase 1 ships, with its guard made permanent and the DB trigger added.
- **Migrations ship before the code that depends on them.** The dev server auto-applies migrations on save, so snapshot the affected tables first.
- **Playwright** `23-all-employees-acceptance` (Terminate dialog) and `nav.json` / nav tests are updated in the same phase as the page changes.

---

## 19. Test scenarios

All run on `pulse_e2e`. Each suite also asserts tenant isolation (another company's case → 404) and multi-role gates (HR as a secondary role is honoured).

**Lifecycle, per type**

| # | Scenario | Expected |
|---|---|---|
| L1 | Employee resigns in Self Service → manager accepts → notice → LWD → clearance → settlement → Finance → paid → close | every transition, status, event and audit in order; employee `Notice` then `Left`; `exit_date = LWD`; login off the day after the LWD |
| L2 | Resignation by an employee with **no active manager** | HR is the acceptor (L1 rule) |
| L3 | Termination, immediate | `Left` and access revoked at acceptance; notice pay in lieu line payable |
| L4 | Retirement on the retirement date | no notice line; gratuity per rule |
| L5 | Death | access revoked immediately; payee = nominee; no recovery without decision |
| L6 | Absconding after N absences (suggestion → HR confirms) | case created; settlement ON_HOLD until released |
| L7 | Contract expiry from `contract_end_date` | suggestion; no notice line |
| L8 | Withdraw before acceptance (employee) / after acceptance before LWD (HR) | prior status restored; leave cancellations reversed only for future dates; access restored only if this case revoked it |
| L9 | Withdraw after LWD | 409 |
| L10 | Reject resignation | REJECTED; employee unchanged |
| L11 | LWD shortened below notice without waiver approval | 409; with approval → version +1, shortfall recalculated, settlement stale |
| L12 | Rehire after CLOSED | new employment period; earlier period intact; login re-enabled only if chosen; gratuity years per ED-18 |

**Notice calculator:**
- the Example in §5;
- the same inputs computed on LWD / LWD+15 / LWD+60 → identical;
- LWD after the required end → shortfall 0;
- waiver;
- working-day mode (if ED-1);
- leap year;
- LWD equal to the notice start.

**Access:**
- tokens refused after revocation (request and refresh);
- push tokens removed;
- OTPs invalidated;
- delegations ended;
- HR tasks created for approvals, direct reports and alerts;
- a login with `users.company_id` NULL is revoked (via the employee's company);
- an email-only matched login is reported, not revoked;
- defence in depth: `is_active` left true by an injected bug → refused because exited;
- withdraw re-enables only its own revocation.

**Clearance:**
- the manager's NOC refused for a non-manager;
- Finance's NOC refused for HR;
- a computed item cannot be ticked by hand;
- an asset returned → item clears;
- a computed check query fails → blocker (fail closed);
- not-applicable needs a reason;
- items per case, so a second case for the same person gets fresh items.

**Settlement and Finance:**
- all P0-1 T1–T23 and P0-3 T1–T16;
- final payroll must be approved before Finance approval;
- a nil settlement goes through Finance;
- a negative net → receivable;
- reversal after posting.

**Integration:**

| Module | Test |
|---|---|
| Payroll | leaver prorated; draft not deleted; release-gate `LEAVER_NOT_IN_RUN` |
| Attendance | clock refused after `exit_date`; auto-absent in Notice (if ED-16) |
| Leave | leave after the LWD cancelled; new application beyond the LWD refused; accrual stops |
| Assets | — |
| Approvals | sources appear for the right approvers only |
| Org | direct-report task |
| Succession | alert raised |
| Probation | "Not confirmed" creates a DRAFT termination case |

**Bypass (regression of containment):**
- PUT / POST / DELETE / PATCH to `Left` refused;
- a direct SQL UPDATE refused by the trigger;
- the retired endpoints return 410;
- the Offboarding URL redirects.

**Concurrency:**
- two acceptors at once → one wins (409 to the other);
- LWD cron vs manual withdraw at the same moment → one consistent outcome;
- double Finance approval → one journal.

**Migration:**
- dry run on a copy of each live exit row;
- mapping per the §18 table;
- mirror columns consistent;
- re-run idempotent;
- the down migration restores read paths.

**UI** (Vitest + Playwright):
- case list filters;
- stepper states;
- Self Service resignation;
- the Terminate hand-off;
- the department queue;
- Finance queue actions;
- read-only Profile and Ex-Employees exit views;
- error states shown, never invented figures.

**Regression:**
- full backend `npm run test:db -- --maxWorkers=2` (current baseline 5,485 passed, 0 failed);
- full frontend `npx vitest run` (1,538 passed);
- Playwright Exit, All Employees, Payroll and Login suites;
- `check:manual`.

---

## 20. Phased implementation plan

Each phase ends with its tests green, the manual updated, and **your approval before the next phase**. Dependencies are shown; Phases 3 and 5 can overlap others.

| Phase | Scope | Depends on | Exit criteria | Containment |
|---|---|---|---|---|
| **0. Decisions & data** | ED-1…ED-22 answered; C4 account decisions executed; legacy exit rows reviewed with HR | — | signed decision register; data mapping approved | all switches ON |
| **1. Case core & single writer** | `exit_requests` extension, versions, policies (unverified defaults), state machine, the six types, `POST /exit/cases` + transitions, notice calculator, DB guard trigger, retire EP-1/2/3/4/9 (410), Exit Management case list/detail, Employee Profile/Ex-Employees read-only, rehire via service + `employment_periods` | Phase 0 | L1–L12 (without settlement/finance), bypass tests, migration dry run | `HR_CONTAINMENT_EXIT_STATUS` replaced by the permanent guard + trigger |
| **2. Access revocation** | `revokeEmployeeAccess`, the LWD job, `verifyToken` defence (ED-12), alert-recipient filter, HR tasks | Phase 1 | access tests; EMP-style fixtures with NULL `users.company_id` | — |
| **3. Clearance & documents** | templates per company, items per case, department NOCs + queue, computed fail-closed items, Approval Center `exit_clearance`, letters from `document_templates`, Self Service resignation + questionnaire, exit interview scheduling | Phase 1 | clearance tests; letters render with validated placeholders | Offboarding tab removed (redirect) |
| **4. Final salary & settlement** | P0-2 payroll changes; `settlement.service` (P0-1), gratuity rule, leave encashment, recoveries; Finance lifecycle (P0-3): journals, employee payee, payment, reconciliation; Finance queue | Phase 1, 3; MD-10 accounts created by Finance | P0-1/P0-3/P0-2 tests; end-to-end L1 including Finance | `HR_CONTAINMENT_FNF` removed; old F&F routes 410 |
| **5. Integrations** | Attendance (ED-16), Leave cancellation and accrual stop, Probation link, Succession alert, Recruitment prompt, Workforce Analytics lifecycle KPIs, Approval Center `exit`/`fnf` | Phases 1–4 as relevant | integration tests | — |
| **6. Clean-up** | Drop mirror writes after readers are switched; remove the containment module; remove retired routes after one release; propose (separately) archiving the legacy clearance/offboarding tables | all | full regression; manual §… updated | switches deleted |

---

## 21. Risks

| Risk | Mitigation |
|---|---|
| **Business rules wrong** (notice, gratuity, final-wage timing, tax) | ED register + ⚖ legal/tax sign-off; unverified policies block settlement (release-gate pattern) |
| **HR workload rises** (more steps, department sign-offs) | department queues; computed items; Approval Center; nil-settlement fast path |
| **Locking out the wrong person** at the LWD | the case must be ACCEPTED with an LWD; the detection report before enabling; withdraw restores |
| **Data migration of messy legacy rows** | per-row HR decisions; dry runs; mirror columns for one release |
| **Finance accounts / bank data not ready** (4 live bank records fail format; no F&F accounts) | Phase 4 cannot start until MD-10 and bank verification are done; nil settlements unaffected |
| **Concurrent sessions editing the same files and the manual** (observed in this repo) | bounded edits; snapshot and diff per phase; manual section per phase |
| **Trigger blocks legitimate scripts or seeds** | scripts must use the service; the trigger names the session flag in its error |
| **Large change surface** (Employees, Exit, Payroll, Finance, Attendance, Leave, Auth) | phases with approval gates; containment stays on until each replacement is live |

---

*Architecture Impact: ✅ None. This is a design document only. Each approved phase will update `MODULE_FEATURE_CONNECTION_MANUAL.md` (Employee Lifecycle, Exit, Payroll, Finance, Auth, Notifications) and retire the matching parts of §228.*
