# HR Module: Production Readiness Check (2026-11-12)

Read-only. Nothing in code or data was changed. Sources: the code as it stands today, and the dev database `Pulse` read through a read-only session. The backend was not running, so no page was clicked through in a browser.

Scope: the 13 HR menu rows plus the Employees menu, with the 11-03 audit (`HR_MODULE_FUNCTIONAL_AUDIT_2026-11-03.md`, F-01 to F-40) re-checked against today's code.

## 1. Verdict

**Not ready for go-live yet.** The cause is mostly data, then a short list of workflow gaps; the code itself is in fair shape.

- The code has moved a long way since 11-03. The F&F engine was rebuilt, exited employees lose their login, policy acknowledgements can't be forged, probation decisions now update the employee, and hires start on Probation. No page uses demo fixtures or DEV fallbacks any more.
- Nearly all "live" HR data is seed, test or placeholder data, including the records of the 3 real employees (§2). Every HR screen would show it to users on day one.
- Three workflow gaps block a real exit: F&F approve and pay are switched off, no settlement rules are recorded, and no company bank account is linked to a ledger account (§3, §4). As a result, a leaver's final salary can't be paid in Pulse today.

## 2. Live data: what's real and what's junk (company 1)

| Area | What's there | Real? | Effect if left |
|---|---|---|---|
| Employees | 3 live: EMP001–003. 12 more "John Doe" rows sit in test companies 565–14065 | 3 real | Test-company rows are invisible to company 1 but are clutter in the DB |
| Real employee master data | IFSC "21312" / "2312", bank name "vdsf", branch "fdsa", PF no. "dfsadf", address "xzczx", nominee "vd"; EMP003 DOB **2012-06-29** (age 14); `notice_period_days` empty for all 3; no shift; no branch | Placeholder | Payroll bank file fails the IFSC check; F&F can't compute notice ("NOTICE_DAYS_UNKNOWN"); PF/ECR filings are wrong. The validation that now exists on Add/Edit Employee was added after these values were entered |
| Leave requests | **769** rows for 3 people, created 16–29 Mar 2026: 609 approved, 159 pending. **Every approved leave overlaps another**: 1,649 days approved in ~2 months | Generated | 159 pending items show in the Approval Center; leave history and Workforce Analytics are fiction. Balances show 0 used, so leave and balances already disagree |
| Leave balances | Rows for deleted leave types (Annual, Compensatory Leave, Maternity 180 days, "te1"). Allocated ≠ quota (Sick quota 7, allocated 1 or 6; Casual 7 vs 4; Paternity 7 vs 5) | Mixed | F&F encashment and the leave pages read inconsistent figures |
| Leave types | No active **Maternity** leave type (deleted); "Compensatory Off" active although Comp Off was removed from the menu on 11-11 | — | Statutory gap: the Maternity Benefit Act requires 26 weeks |
| Exit requests | 4 **open** exits (#15–18) on employees soft-deleted 05 Nov (EMP010/011/027/037). `GET /exit/active` and `/exit/requests` do not filter `deleted_at`, so these show on Exit Management | Test | HR sees 4 ghost leavers ("Pilot", "Test", "John", "Resume") |
| Exit interviews / clearance | 7 interviews, 4 clearance rows, mostly on deleted employees | Seed | Exit analytics charts show seed reasons |
| Policies | 4 rows: "test" + 3 "SEED Hr Policies…" with `example.invalid` links; 5 acknowledgements, 2 of them by deleted employees 4 and 5 | Junk | Home "Acknowledge" asks real staff to accept SEED policies |
| HR documents (Downloads) | 15 company documents; 10 brand-asset rows have **no file** | Real titles, missing files | The download buttons lead nowhere |
| Employee documents | 5 rows, all "SEED Employee Documents n" with `example.invalid` URLs | Seed | Show in the employee vault |
| Announcements | 1 row titled "TEST" | Test | — |
| Assets | 1 allocation: asset "a", tag "a", serial "a", to EMP002 | Test | — |
| Interns | 1: "test tet" | Test | — |
| Onboarding | `onboarding_records` / `onboarding_tasks` (5 seed each) still exist, unused; live checklist has 41 templates and 48 progress rows | Mixed | Dead tables (F-26 still open) |
| Probation notifications | 47 rows with no decision for EMP003, who was confirmed 27 Sep | Stale | Noise on the Probation page |
| Company bank accounts | 5 × "SEED Bank Accounts n", **none linked to a ledger account** | Seed | F&F pay refuses (BANK_ACCOUNT_NOT_MAPPED); payroll payment has no real source account |
| Payroll | 3 pending runs, nothing ever approved or paid | — | — |
| Logins | 6 active **admin** logins in test companies (`*@pulse.test`); 5 HR-role logins (hr, hr_manager, hr_exec, payroll_admin) with no employee link | Test / incomplete | Test admins are a security risk in production. HR staff without an employee link can't use My Details, My Gate Passes, leave or payslips for themselves |

Empty, waiting for real use: succession plans, gate passes, visitors, IT declarations, probation reviews, F&F settlements, intern evaluations.

**Data clean-up is the first go-live task.** It needs your list of which rows to keep. Nothing has been deleted.

## 3. 11-03 findings re-checked

| ID | Finding (short) | Today |
|---|---|---|
| F-01 | F&F leave encashment always ₹0 | **Fixed** (§253 engine reads the real `leave_balances` columns) |
| F-02 | Notice recovery measured against today | **Fixed** (counts from the notice start; warns when it's missing) |
| F-03 | F&F salary source differs from payroll | **Fixed** (uses the payroll engine and the salary revision) |
| F-04 | Exit cron sets Left but not `exit_date`; final month dropped by payroll | **By design now**: the final month is paid as F&F `FINAL_SALARY`. Still a gap, because F&F pay is switched off (C1/C3) and the cron still never writes `exit_date` |
| F-05 | F&F no segregation of duties / no GL | **Fixed in code** (approve = payroll:approve, pay = payroll_payment:approve, journal posted) but **switched off** by `hrContainment` until the settlement rules are confirmed. **0 `settlement.*` rules recorded** |
| F-06 | Exited employees keep logins | **Fixed**: 0 active logins on exited or deleted employees |
| F-07 | Policy acknowledgement forgeable | **Fixed** (caller's own employee id) |
| F-08 | Offboarding Complete ungated | **Fixed** (needs F&F paid) |
| F-11/F-12 | Probation decision no effect; hires without probation | **Fixed** 11-11 |
| F-13 | Any status transition allowed | **Mostly closed** for exits (409 USE_EXIT_WORKFLOW); not re-tested for other transitions |
| F-14 | No one-open-exit guard, no CHECKs, no `company_id` on `exit_requests` | **Open**: `/exit/initiate` inserts a second open exit freely; only a PK index exists |
| F-15 | Clearance unique per employee, not per exit; UI swallows save errors | **Open**: `UNIQUE (employee_id)` still; `ExitManagement.jsx:198` `catch (_) {}` |
| F-16 | Exit/onboarding gates read the single `req.user.role` | **Open** in `exit.routes.js:35-42`, `onboarding.routes.js:36,310,323,383`, and the L&D routes (assessments, certifications, competency, knowledge, learning-paths, lnd-settings, trainers, training). Latent today: no active user has 2 roles |
| F-17 | No resignation by employee, no manager acceptance | **Open**: no resign endpoint; no `resign` or F&F source in the Approval Center |
| F-19 | No "My assets" | Done 11-11 (Employee Records) |
| F-21 | Visitor ID unmasked | Rebuilt §272 (gate_access module) |
| F-22 | HR → Finance: intern stipend has no payment path | **Open**: stipend is stored on the intern and nothing in payroll or finance reads it |
| F-23/F-24 | Self Service declarations/uploads | Self Service removed 11-11; Finance enters IT declarations |
| F-25 | Dead alias mounts | **Open**: 5 remain, `server.js:964-970` |
| F-26 | Dead onboarding tables | **Open** |
| F-27 | Import-time DDL | Closed (§248) |
| F-29 | Announcement targeting | **Partly open**: all / department / employee only; no branch, designation or role; categories hardcoded (`Announcements.jsx:24`) |
| F-33 | New policy version doesn't need re-acknowledgement | **Open**: `ON CONFLICT (policy_id, employee_id) DO NOTHING` (`hr.routes.js:332`) |
| F-34 | Missing FKs | **Partly open**: `employee_documents`, `hr_policy_acknowledgements` still have no FK to employees (which is how the deleted-employee rows above survive) |
| F-35 | No tests for F&F / probation | Closed: settlement, probation, intern, asset, succession and department-head suites exist |
| F-36 | Approval Center sources | itdecl, bank, probd, ts, visitor, gate added; **resignation and F&F still missing** |

## 4. New findings

| # | Severity | Finding | Where |
|---|---|---|---|
| N-1 | P0 (go-live) | The data in §2 must be cleaned or replaced before go-live | §2 |
| N-2 | P0 | F&F can't complete: switch on, 0 settlement rules, no ledger-linked bank account. Final salary for any leaver is unpayable in Pulse | `shared/hrContainment.js`, `payroll_statutory_rules`, `bank_accounts` |
| N-3 | P1 | Ghost exits: `/exit/active` and `/exit/requests` join employees without `deleted_at IS NULL` | `exit.routes.js:164-180, 351-383` |
| N-4 | P1 | Exit details can't be corrected after initiation: PUT `/exit/requests/:id` updates only status and remarks. LWD, exit type and notice days are fixed; the only fix is withdraw and restart | `exit.routes.js:211-230` |
| N-5 | P1 | The Initiate Exit form asks for a typed **numeric Employee ID** (no picker), has no notice-period or resignation-date field, and notifies nobody | `ExitManagement.jsx:248`, `exit.routes.js:385-433` |
| N-6 | P1 | Exit types are only resignation / termination / retirement / death. No absconding, contract end or mutual separation, although the settlement engine has rules for more | `ExitManagement.jsx:249` |
| N-7 | P2 | Exit cron still sets the terminal status without `exit_date` (pay sets it later). If F&F is delayed, Ex-Employees and attrition reports miss the leaver | `jobs/exitStatusSync.cron.js:50` |
| N-8 | P2 | No relieving or experience letter generator (probation letters exist; the same pattern would work) | grep: none |
| N-9 | P2 | HR-role logins have no employee link (5 accounts) | `users` |

## 5. Page-by-page status

| Menu row | Real data | Inputs editable | Linked to | Status |
|---|---|---|---|---|
| Internships | 1 test intern | Yes (add/edit/evaluate/convert) | Employee conversion ✔; stipend → payroll ✘ | Usable; stipend pay missing |
| Payroll Center | 3 pending runs; statutory rules partly recorded | Yes | Attendance, leave, loans, GL ✔ | Fixed 11-10; blocked by the employee bank data above |
| Announcements | "TEST" only | Yes | Home feed ✔ | Usable; targeting limited |
| Workforce Analytics | Computed from the junk leave data | Settings editable | Employees, leave | Numbers wrong until data is cleaned |
| My Dashboard / My Details | 3 employees | HR-owned (by design) | Probation, notice, attendance ✔ | OK |
| My Gate Passes / Gate Pass & Visitors | Empty | Yes | Security role, Approval Center ✔ | Rebuilt 11-12, ready for use |
| Employee Records (Assets, Policies, HR Documents) | Test asset, SEED policies, 10 documents with no file | Yes | Exit clearance (assets) ✔ | Data clean-up needed; re-acknowledgement missing |
| Department Heads | 11 current assignments, real | Yes | Probation reviewer, gate pass ✔ | OK |
| Probation Management | Stale notifications | Yes | Employee status, Approval Center ✔ | Fixed 11-11 |
| Exit Management | 4 ghost exits | Initiate only; no edit (N-4) | Clearance, assets, login, F&F, GL (off) | **Not ready** (N-2 to N-6, F-14, F-15) |
| Succession Center | Empty (seed removed) | Yes | 9-box, employee-left trigger ✔ | Ready for use |
| Employees → All / Ex / BGV | 3 real records with placeholder values | Yes, validated | Login, payroll, leave ✔ | Correct the 3 records |

## 6. Missing features (for an Indian HR system at go-live)

1. Employee resignation from self-service, with manager acceptance and a resignation date (F-17), plus an Approval Center source.
2. An F&F step in the Approval Center.
3. Relieving and experience letters.
4. Maternity leave type (26 weeks), with gender restriction set on maternity/paternity.
5. Intern stipend payment (via payroll or a payment batch).
6. Re-acknowledgement on a new policy version.
7. Exit types: absconding, contract end, mutual separation.
8. Employment history on rehire (rehire overwrites the joining date, per 11-03).

## 6a. Fixed later on 11-12 (§274, not committed)

- **N-3** Ghost exits: `/exit/active` and `/exit/requests` skip deleted employees (dev: 4 → 0 shown).
- **F-14** One open exit per employee: all three create paths (`/exit/initiate`, `/exit/requests`, `/employees/:id/offboard`) use `modules/hr/exitCase.js`. Deleted employees → 404; already left → 409; second open exit → 409 `EXIT_ALREADY_OPEN`. Partial unique index `exit_requests_one_open_per_employee` (migration 20261112000006, applied to dev and pulse_e2e).
- **N-4** `PUT /exit/requests/:id` edits exit type, last working day, resignation date, notice days and reason until F&F is approved; it reports when a settlement must be recalculated, refuses `cancelled` (use Withdraw), and is audited. Exit Management has an Edit button.
- **N-5** Initiate uses an employee picker, adds resignation/notice date and notice days (default: the employee's contract), validates dates, and notifies the department head and reporting manager.
- **N-6** One exit-type list matching the F&F engine (adds retrenchment, contract end, absconding, disablement); Employee Profile no longer offers "Attrition" or "contract_end", which F&F settled as resignations.
- New `exit_requests.resignation_date`; F&F uses it as the notice start.
- **F-15** (part) A clearance save failure is shown and the tick is reverted. A new exit starts with a fresh clearance row instead of inheriting old ticks. Clearance is still one row per employee, not per exit.
- Ex-Employees "fix exit details" now refuses employees who haven't left.

## 6b. Same day, second round (§275, not committed)

- **N-7 fixed:** the exit job writes `exit_date` (= last working day). It now runs the morning after the last working day (it used to end employment on the morning of the last day), and skips deleted employees.
- **Notice period:**
  - Company default of 90 days in Workforce Analytics → Settings.
  - New "Notice Period (days)" field on Add/Edit Employee. It was not editable anywhere before, and empty means the company default.
  - EMP001–003 set to 90 (audit 190208–10).
  - Initiate Exit fills the last working day from resignation date + notice, counting the resignation day as served (the way F&F counts it), and flags an early release with the days F&F will recover.
- **Bank → ledger:** new Bank Accounts → **Ledger links** tab. Pick or create a bank ledger (Asset, sub-type bank, codes 1121–1199), then **Approve links**. Before this there was no screen and no ledger of sub-type bank, so no bank account could be linked.
- **Data:**
  - 5 SEED bank accounts deactivated (audit 190203–07).
  - Ledger 5015 Gratuity Expense created.
  - All 8 settlement rules recorded for company 1, effective 21 Nov 2025. Company 1 has two-person rule approval off, so they took effect immediately; they're editable in Exit Management → Settlement Rules.
  - Ledger codes: 5010 salary and leave, 5013 bonus, 5015 gratuity, 4005 notice and asset recovery, 2030 statutory, 2003 TDS, 1013 loans and advances.
- **Switch:** `HR_CONTAINMENT_FNF=off` in backend/.env (dev). The test runner now pins the switches to their shipped default.
- **F&F pay** now refuses an employee bank account or IFSC that is not valid (`EMPLOYEE_BANK_INVALID`). It used to check only that one was present, and EMP001–003 hold placeholder values.
- **F-17** (employee resignation in Pulse): dropped by the owner. Resignations come by email, and HR records the email date as the resignation date.

Still open:
- The real company bank account (owner to enter).
- Valid bank details for EMP001–003.
- Production: run migration 20261112000006 and set `HR_CONTAINMENT_FNF=off`.
- Retrenchment compensation (IR Code: 15 days' pay per year) is not computed.
- No reminder when F&F passes its 2-working-day due date.
- No relieving or experience letter.

## 6c. Same day, third round (§276, not committed)

- **Retrenchment compensation:**
  - New rule `settlement.retrenchment`: 15/26 × monthly wage × years (a part-year over 6 months counts), after a 1-year minimum, ₹5 lakh tax-exempt.
  - A `RETRENCHMENT` line in F&F, posted to the new ledger `retrenchment_expense`.
  - The re-skilling fund contribution (15 days) is shown as a warning, since the employer pays it to the fund. The "worker" test is flagged too.
  - Recorded rules gain fields added later as empty, so older records stay editable.
  - Company 1: rule recorded, and ledger 5016 Retrenchment Compensation created and mapped (audit 190220–22). No rule is unconfirmed.
- **F&F due date and reminder:**
  - `modules/hr/fnfDue.js` works out the due date: wages N working days after the last working day (Sundays and company or zone holidays skipped), gratuity 30 days.
  - Active Exits shows "Due DD Mon YY" or "N days late".
  - A daily 10:00 job (`jobs/fnfOverdueReminder.cron.js`) notifies Finance (payroll / payroll_payment approvers) and HR (hr:edit), at most once a day per exit.
- **Relieving and experience letters:**
  - `GET /exit/employee/:id/letter/relieving|experience` returns a PDF, available once the employee has left.
  - No relieving letter for absconding.
  - The wording is neutral, and the issue is audited.
  - Buttons on Active Exits (once the person has left) and on Ex-Employees.

## 7. Suggested order

1. **Data** (needs your keep/delete list): leave requests and balances, SEED policies/documents/bank accounts, ghost exits, test interns/assets/announcement, test-company admin logins, and the 3 employees' bank/PF/address/DOB/notice values.
2. **Make exits work end to end**: N-3, N-4, N-5, F-14, F-15; record the settlement rules; link a real bank account to its ledger; then lift the F&F switch (HR_CONTAINMENT_FNF=off).
3. **Resignation and the Approval Center sources** (F-17, F-36).
4. **Clean-up code**: F-16 multi-role gates, F-25 aliases, F-26 tables, F-33, F-34, N-7.
5. **Missing features** (§6), in whatever order the business needs.
