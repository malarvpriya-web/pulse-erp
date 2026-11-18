# PC-02 — Payroll Payment Control: Phase 0 Audit

**Date:** 04 Nov 2026 · **Type:** read-only audit (no code, migration, permission, configuration or data change) · **Follows:** PC-01 (closed, `PC01_CLOSURE_VERIFICATION.md`)

**Environment checked before the audit:**

| | Value |
|---|---|
| Branch | `security/pulse-01-integration-config-authz` |
| Last commit | `f434736`, 27 Sep 2026 |
| Working tree | 1,084 uncommitted entries (410 modified, 671 untracked, 3 deleted) |
| Mode | `NODE_ENV=development` |
| Databases | dev `localhost:5432/Pulse` (read-only queries); test `pulse_e2e` (read-only) |

**Dev data state:** 35 non-test payroll runs, all `pending` (Aug–Sep 2026). No run has ever been approved or paid, so there are no payroll or salary-payment journals. Run #41 (EMP011, pending, ₹2,809) is unchanged.

---

## 1. Summary

Pulse has **no payroll payment workflow**. "Mark Paid" is a status flip that one finance_manager can perform per employee:
- no payment instruction, bank evidence or transaction reference is required;
- no amount is checked against the bank;
- there are no failed, partial or reversed states;
- salary payments are never linked to Finance's bank accounts, so they can never be reconciled.

The two GL postings (the accrual at approval, the clearing at Mark Paid) are both best-effort: when they fail, the payroll state still advances and the failure is only logged to the server console.

Finance already has the right building blocks: payment batches with maker ≠ checker, bank-file export, bank transactions, statement import, auto/manual matching and journal reversal. Payroll uses none of them.

| Severity | Count |
|---|---|
| P0 — can cause wrong, unauthorised or duplicate money movement or a wrong ledger | 6 |
| P1 — control gap with a credible path to loss or misstatement | 11 |
| P2 — hygiene, auditability, usability | 7 |

## 2. Current-state lifecycle

```
 HR / payroll_admin (payroll:add)                    Finance (payroll:approve) — also payroll_admin, admin
 ┌──────────────────────────────┐   leave / LOP /    ┌──────────────────────────────────────────────┐
 │ 1 GENERATE  POST /payroll/   │   encashment /     │ 2 APPROVE  POST /payroll/approve             │
 │   generate · status=pending  │◄─ attendance edit  │   release gate → maker-checker (≠ preparer)  │
 │   generated_by = preparer    │   the draft after  │   → status=approved, payslips released       │
 └──────────────┬───────────────┘   generation (F-12)│   → loans reduced, arrears marked 'paid'     │
                │ regenerate (drafts only)           │   AFTER COMMIT, best-effort:                 │
                └───────────────────────────────────►│   accrual JE  Dr 5010.. / Cr 2040, 20xx      │
                                                     └──────────────────┬───────────────────────────┘
                                                                        │
            ┌───────────────────────────────────────────────────────────┤ (nothing records an instruction)
            ▼                                                           ▼
 ┌──────────────────────────────┐                     ┌──────────────────────────────────────────────┐
 │ 3/4 "Export NEFT" (browser)  │  file to bank,      │ 6 MARK PAID  POST /payroll/:id/mark-paid     │
 │   CSV built client-side from │  OUTSIDE Pulse ───► │   payroll_payment:approve (finance_manager)  │
 │   the list; no server record │  5 bank executes    │   payer ≠ preparer; reference OPTIONAL       │
 │   no approval, no audit      │  (no confirmation   │   status=paid (own statement)                │
 └──────────────────────────────┘   comes back)       │   THEN best-effort: JE Dr 2040 / Cr 1001     │
                                                      │   THEN best-effort: TDS s.192 ledger row     │
                                                      └──────────────────┬───────────────────────────┘
                                                                         ▼
                                    7 BANK RECONCILIATION — NOT CONNECTED: no bank_transactions row is
                                    written for salary; Finance → Bank Accounts can never match it.
                                    9 FAILED / PARTIAL / RETURNED / REVERSED — NO STATE, NO PATH.
```

## 3. Route / API inventory

| Stage | Route | Gate (after PC-01) | File:line | Writes |
|---|---|---|---|---|
| Generate | `POST /payroll/generate`, `/run` | `payroll:add` | `modules/payroll/payroll.routes.js:168-169` → `payroll.service.js:290-389` | `payroll_runs` upsert (drafts only), `generated_by` |
| Draft edits by other modules | leave approval (LOP), encashment approval, attendance sync | `leaves:approve`, attendance routes | `modules/leaves/routes/leaves.routes.js:146`, `encashment.routes.js:229`, `attendance.routes.js:2691,2717` | `payroll_runs` drafts, after generation |
| Readiness | `GET /payroll/release-readiness` | `payroll:view` | `payroll.routes.js:139` | — |
| Approve | `POST /payroll/approve` | `payroll:approve` | `payroll.routes.js:165` → `payroll.service.js:574-716`; GL `payroll.controller.js:234-257` | status, `approved_by/at`, loan repayments, arrears, accrual JE |
| Register / statutory files | `GET /payroll/register`, PF ECR, ESI, bonus | `payroll:export` | `payroll.routes.js:200` | — |
| Bank instruction | *none on the server*; "Export NEFT" button | page access only | `frontend/src/features/hr/pages/Payroll.jsx:237-260` | — |
| Mark Paid | `POST /payroll/:id/mark-paid` | `payroll_payment:approve` + `validateMarkPaid` + `payerIsNotPreparer` | `payroll.routes.js:91-99, 108-130, 177` → `payroll.service.js:726-813`; audit `payroll.controller.js:261-266` | status, `payment_mode/reference`, payment JE, `tds_deductees/transactions` |
| Manual payroll JE | `POST /accounting/payroll-journal` | `finance:approve` | `modules/finance/accounting.routes.js:1509-1537` → `services/payrollJournal.service.js:41-189` | `journal_entries/lines` from request-body amounts |
| JE reversal | `POST /accounting/journal-entries/:id/reverse` | `finance:approve` | `accounting.routes.js:240` | reversing entry (`reversal_of_id`, one per entry) |
| Finance payment batches | create / submit / approve / reject / process / bank-file | `finance:add/edit/approve/approve/approve/view` | `modules/finance/routes/extended.routes.js:304-419`; `services/paymentBatch.service.js:51-310` | `payment_batches/_items`, `payments`, JE Dr AP/Cr Bank, `bank_transactions` |
| Bank reconciliation | bank accounts, statement lines, auto/manual match | `finance:view/edit` | `extended.routes.js:45-278`; `repositories/bankAccount.repository.js:271-370` | `bank_statement_lines`, `bank_transactions.reconciled` |

## 4. Frontend screens

| Screen | File | Payment-relevant behaviour |
|---|---|---|
| Payroll Center → Payroll Processing | `features/hr/pages/Payroll.jsx` | Generate / Approve (permission-gated, PC-01). **Pay** per row and **Mark All Paid** (only the `payroll_payment` grant): `Promise.all` of per-employee calls (`:195-212`), sends `payment_date` (ignored by the server) and **never a reference** (`:185-193`). **Export NEFT** (`:237-260`) builds a CSV in the browser from the list with full account numbers. |
| Finance → Payments | `features/finance/pages/PaymentBatch.jsx` | supplier payment batches; not used for salary |
| Finance → Bank Accounts | `features/finance/pages/BankAccounts.jsx` | statements, matching, reconciliation; salary never appears |
| Finance → Journal Entry | `features/finance/pages/JournalEntry.jsx` | manual JE and reversal |
| Finance → TDS | `features/finance/pages/TDSManagement.jsx` | s.192 rows come only from Mark Paid |

## 5. Role-permission matrix (dev, verified)

| Capability | Grant | Roles holding it |
|---|---|---|
| Generate / regenerate drafts | `payroll:add` | super_admin, admin, payroll_admin, hr_manager, hr |
| Approve payroll | `payroll:approve` | super_admin, admin, **payroll_admin**, finance_manager |
| Register and statutory exports | `payroll:export` | super_admin, admin, payroll_admin, hr_manager, hr, finance_manager |
| See bank account / PAN / UAN in the payroll list | `payroll:view` | super_admin, admin, payroll_admin, hr_manager, hr, finance_manager |
| "Export NEFT" | page access | everyone who can open Payroll Center (`payroll:view`) |
| Mark Paid | `payroll_payment:approve` | **finance_manager only** |
| Manual payroll journal, JE reversal | `finance:approve` | super_admin, admin, finance, finance_manager |
| Payment batch create / submit | `finance:add` / `finance:edit` | super_admin, admin, finance, finance_manager, accounts_exec |
| Payment batch approve / process | `finance:approve` | super_admin, admin, finance, finance_manager |
| Bank statement import and matching | `finance:edit` | super_admin, admin, finance, finance_manager, accounts_exec |

**Same person, several stages:** one finance_manager may approve a period and then mark it paid; the only rule is payer ≠ *preparer*. payroll_admin may generate *and* (as a different user) approve, so a period can be approved with no Finance involvement. A company with one finance_manager has a single person who can pay; admins cannot.

## 6. Database and posting flow

| Table | Role in payment | Gap |
|---|---|---|
| `payroll_runs` | the only payment record: `status` (draft/pending/approved/paid/on_hold), `payment_mode`, `payment_reference`, `approved_by/at`, `generated_by` | no paid-at, paid-by, payment date, bank account, instruction / batch link, or failed / returned / reversed state; the status check is `NOT VALID` |
| `journal_entries` / `journal_lines` | accrual (`reference_type='payroll_run'`, ref `YYYY-MM:<min run id>`, numbered `JE-YYYY-nnnn`); clearing (`'salary_disbursement'`, ref `<emp>-YYYY-MM`, numbered `JEnnnn`) | **no unique constraint on (company, reference_type, reference_id)**; duplicates are prevented only in code |
| `tds_transactions` / `tds_deductees` | s.192 row written at Mark Paid, deduplicated by `NOT EXISTS` | written only if Mark Paid runs; best-effort |
| `payroll_loan_repayments` / `payroll_arrears` | loans reduced and arrears set to **'paid'** at *approval* | "paid" before any payment |
| `bank_accounts` / `bank_transactions` / `bank_statement_lines` | Finance bank book and reconciliation | **no payroll writer** |
| `payment_batches` / `payment_batch_items` (with `status`, `utr`) | Finance payment execution | supplier-only (`supplier_id`, `bill_id`) |

**Accrual at approval** (`payrollJournal.service.js`): Dr 5010 gross, 5011 / 5012 / 5014 employer share; Cr 2030 PF, 2031 ESI, 2033 LWF, 2003 TDS, 2032 PT, loan accounts, 2040 net salary payable.

**Clearing at Mark Paid** (`payroll.service.js:756-789`): Dr 2040 / Cr 1001 "Cash & Bank" (one generic account) for each employee's net pay, dated by the server's date.

## 7. Findings

### P0

| ID | Finding | Evidence | Consequence |
|---|---|---|---|
| F-01 | **Mark Paid needs no bank evidence.** `payment_reference` is optional (`reference \|\| null`), `validateMarkPaid` checks only month/year/id, and the UI never sends a reference. | `payroll.service.js:741-746`; `payroll.routes.js:91-99`; `Payroll.jsx:185-193` | Runs are recorded as paid with nothing tying them to a real transfer. Unpaid salary looks paid; a paid salary can be paid again outside Pulse without detection. |
| F-02 | **Payment status and the clearing journal are not atomic.** `paid` is committed by its own statement; the Dr 2040 / Cr 1001 entry runs afterwards in a separate transaction whose failure is swallowed (`console.warn`). That happens when accounts are missing, the period is locked or closed, or the posting guards refuse. | `payroll.service.js:739-789` | The run reads "paid" while Salary Payable stays uncleared, with no flag and no retry (a paid run can't be marked paid again). |
| F-03 | **The approval accrual is best-effort and outside the approval transaction.** It is posted by the controller after COMMIT; any `skipped` result (missing accounts, unbalanced, loan mapping) or exception only reaches the console and a `gl_posting` field in the response. | `payroll.controller.js:234-257`; `payrollJournal.service.js:69-71, 95, 111, 123, 133` | Approved and released payroll with no expense or liability in the GL; nothing records that the journal is missing. |
| F-04 | **The manual payroll journal takes amounts from the request body.** `POST /accounting/payroll-journal` accepts gross/net/PF/… and any `payroll_run_id` string. The duplicate check is that string only, and nothing compares the amounts to approved runs. | `accounting.routes.js:1509-1537`; `payrollJournal.service.js:78-86` | A `finance:approve` holder can post a second accrual for the same month under a new reference, or a journal with arbitrary amounts. |
| F-05 | **The accrual journal bypasses the posting guards.** It is inserted directly as `status='posted'`, not through `journalRepo.postEntry`, so the lock date, open-period and account-usable checks that guard every other automatic posting do not apply. | `payrollJournal.service.js:144-148`; `services/postingGuards.js:1-22` | Payroll can post into a locked or closed accounting period. |
| F-06 | **The accrual uses another company's accounts.** The chart-of-accounts lookup has no company filter (`WHERE code IN (...) AND is_active`). | `payrollJournal.service.js:101-104` | A tenant's payroll journal can be posted against another tenant's account ids. |

### P1

| ID | Finding | Evidence |
|---|---|---|
| F-07 | **No payment instruction exists.** "Export NEFT" is a browser CSV with no server record, approval, audit entry, or snapshot of beneficiary accounts. The account used at Mark Paid is re-read *later* from the employee master, which may have changed in between (bank-change approval). | `Payroll.jsx:237-260`; `payroll.service.js:731-736` |
| F-08 | **The payroll list returns full bank account numbers, PAN and UAN to every `payroll:view` holder** (finance_manager, hr, hr_manager, payroll_admin). The employee APIs mask the account unless the caller holds `employee_bank:view` (admin, hr, hr_manager, super_admin), so finance_manager and payroll_admin see more here than the bank-detail policy allows. | `payroll.service.js:434` (`e.account_number AS bank_account`) |
| F-09 | **Salary payments never reach Finance's bank book.** No `bank_transactions` row is written, the credit goes to a generic `1001`, and bank reconciliation can never match a salary debit. Payment status and reconciliation are treated as the same thing by default. | `payroll.service.js:763-776`; `bankAccount.repository.js:312-347` |
| F-10 | **No failed / partial / returned / reversed handling.** The status vocabulary has no such states, a returned NEFT has no path back, nothing un-pays a run, and nothing reverses the clearing journal. Mark All Paid is a `Promise.all` of independent calls: a partial failure leaves a mixed period with one generic error. | `payroll_runs_status_vocab`; `Payroll.jsx:195-212` |
| F-11 | **Approver and payer may be the same person.** The payment check compares the payer only with `generated_by`, not with `approved_by`, so one finance_manager approves and pays. | `payroll.routes.js:108-130` |
| F-12 | **Drafts are changed after generation by other modules, with no re-attribution.** Leave approval (LOP), encashment approval and attendance sync update `payroll_runs` drafts. The preparer stays the generator, so maker-checker checks the wrong person. The LOP update changes `lop_amount` without `net_pay`; the encashment amount goes to `leave_encashment_amount`, **which payroll never reads, so approved encashments are never paid**. | `leaves.routes.js:146`; `encashment.routes.js:215-233`; `attendance.routes.js:2691, 2717` |
| F-13 | **Approval is not Finance-only.** payroll_admin holds `payroll:approve`, so HR can generate (one user) and approve (another) with no Finance step, contrary to the intent of PC-01 D1. | dev matrix |
| F-14 | **Single-payer dependency (temporary PC-01 rule).** Only finance_manager can pay. A company with one finance_manager has one possible payer, who is also usually the approver (F-11); if that person is absent, nobody can record payment. | `payroll_payment` matrix |
| F-15 | **No duplicate-journal guard in the database.** `journal_entries` has no unique key on (company, reference_type, reference_id). The accrual's existence check runs outside its transaction (`payrollJournal.service.js:78-86`). | DB indexes |
| F-16 | **Statutory records follow Mark Paid, not payment.** The s.192 TDS row is written only by Mark Paid, best-effort, dated at period end with `payment_amount = gross`. Salary paid outside Pulse, or a swallowed error, leaves 24Q / Form 16 inputs missing. | `payroll.service.js:791-811` |
| F-17 | **Finance batch controls are incomplete for reuse.** The bank file downloads for a batch in any status with `finance:view`; `process` has no maker ≠ processor rule and no UTR / bank evidence; the journal `created_by` is the batch creator, not the processor. | `extended.routes.js:409, 419`; `paymentBatch.service.js:177-288` |

### P2

| ID | Finding | Evidence |
|---|---|---|
| F-18 | Mark Paid on an already-paid run returns success *and* writes another "update → paid" audit row. | `payroll.controller.js:261-266`; `payroll.service.js:750` |
| F-19 | The audit for Mark Paid records no reference, amount or bank account; `payroll_runs` stores no paid-by or paid-at. | `payroll.controller.js:263-264` |
| F-20 | The clearing journal is dated by the server's date (UTC, `toISOString`), not the bank value date; `created_by` is null. | `payroll.service.js:768-770` |
| F-21 | Two journal number series for payroll (`JE-YYYY-nnnn` accrual, `JEnnnn` clearing). | `shared/docNumber.js:203-213` |
| F-22 | Arrears are set to `'paid'` and loan balances reduced at *approval*. They are deductions or additions in a payslip that may not be paid yet (the wording misleads reconciliation). | `payroll.service.js:671-699` |
| F-23 | NEFT CSV: names are quoted but formula characters are not escaped (Finance's bank file uses `csvCell`); the column set is not a bank's format. | `Payroll.jsx:240-251` |
| F-24 | Auto-match pairs on amount ± 0.01 and date ± 3 days only, so identical salary amounts would match an arbitrary transaction. | `bankAccount.repository.js:312-347` |

## 8. Existing capabilities versus missing

| Need | Exists | Missing |
|---|---|---|
| Preparer ≠ approver | ✓ payroll approval (`MAKER_CHECKER`) | approval limited to Finance (F-13) |
| Approver ≠ payer | — | F-11 |
| Payment instruction / batch | ✓ Finance `payment_batches` (supplier) | salary item type, beneficiary snapshot, link to runs |
| Bank file | ✓ Finance bank-file (escaped, bank formats) | status gate, export audit, salary use |
| Execution evidence | partial: `payment_batch_items.utr` column | required UTR / bank reference per item |
| Bank book entry | ✓ `bank_transactions` from batches | salary path |
| Reconciliation | ✓ statement import, auto/manual match, completion | salary entries, a stronger match key (F-24) |
| GL posting with guards | ✓ `postEntry` + `postingGuards` | the payroll accrual uses neither (F-05); atomic with state (F-02, F-03) |
| Journal reversal | ✓ one reversal per entry | payroll-driven reversal on a returned payment |
| Failed / partial / returned | — | states, workflow, re-issue |

## 9. Risk scenarios

| Risk | How it happens today |
|---|---|
| **Duplicate payment** | (a) A NEFT file is uploaded twice, or re-exported after some rows were paid: nothing records what was instructed (F-07). (b) Salary is paid outside Pulse while the run is still "approved", then paid again from a later export (F-01). (c) A returned payment is re-sent with no record linking the two (F-10). |
| **Unauthorised payment** | (a) The export is available to every `payroll:view` holder and contains full account numbers (F-07, F-08). (b) An account changed between export and payment is not detected (F-07). (c) One finance_manager approves and pays (F-11); HR can approve without Finance (F-13). |
| **Incorrect journal** | (a) Approved payroll with no accrual (F-03). (b) Paid runs with Salary Payable never cleared (F-02). (c) A second accrual via the manual route (F-04, F-15). (d) Posting into a locked period (F-05). (e) Another company's accounts (F-06). (f) Approved encashments never paid or accrued (F-12). |

## 10. Out of scope (carried forward, not re-audited)

PC-01 R-1 (encashment approval permissions; overlaps F-12), R-2 (leave-balance visibility), R-3 (unscoped `/ai/anomalies`), R-4 (hr_exec employee creation). PC-07 is not started.
