# PC-02 — Payroll Payment Control: Target Design

**Date:** 04 Nov 2026 · **Status:** proposal; nothing implemented · **Input:** `PAYROLL_PC02_PAYMENT_CONTROL_AUDIT.md` (findings F-01 to F-24) · **Decisions:** `PAYROLL_PC02_DECISION_REGISTER.md` (PD-1 to PD-18)

## 1. Principles

1. **Three separate facts, three separate owners.**
   - *Approved*: payroll says what is owed.
   - *Paid*: Finance says the bank was instructed and confirmed it.
   - *Reconciled*: the bank statement shows it.
   No status may imply another (F-09).
2. **Money moves only through a recorded instruction.** Every payment belongs to exactly one approved, frozen payment batch, with a beneficiary snapshot (F-07).
3. **Evidence before "paid".** A bank reference (UTR) per line, or a bank-confirmed file reference per batch, is required (F-01).
4. **A state change and its ledger effect commit together, or neither does** (F-02, F-03). No best-effort postings, no `console.warn` as the only record.
5. **Payroll journals follow the same posting guards as every other journal**: lock date, open period, balanced entry, company-owned accounts (F-05, F-06).
6. **Reuse Finance's payment, bank and reconciliation modules**; don't build a second payment system inside HR.
7. **Four eyes at each money step:** preparer ≠ approver ≠ releaser, enforced on user ids across roles (F-11, F-13).

## 2. Target lifecycle

```
HR PAYROLL                                   FINANCE
──────────                                   ───────
1 PREPARE   draft → pending   (payroll:add)
   drafts frozen to the generator; any later
   input change marks the draft STALE → regenerate (F-12)
2 APPROVE   pending → approved (payroll:approve = Finance, PD-2)
   approver ≠ preparer
   ONE transaction: status + loans + arrears(→'settled_in_payslip')
   + ACCRUAL JE via postEntry/guards   (fails → nothing approved)
   payslips released (PD-6)
                              ── hand-off ──►  3 INSTRUCT  salary payment batch (draft)
                                                  built ONLY from approved, unpaid runs;
                                                  amount = run.net_pay; beneficiary
                                                  account SNAPSHOT; one open batch per run
                                               4 AUTHORISE batch draft → authorised
                                                  (payroll_payment:authorise, PD-4)
                                                  authoriser ≠ batch creator ≠ payroll approver
                                                  batch frozen (lines immutable)
                                               5 RELEASE   bank file generated once from the
                                                  frozen batch; file hash + export audit;
                                                  re-download = same file, logged (PD-8)
                                                  status → released (sent to bank)
                                               6 CONFIRM   per line: paid (UTR, value date) |
                                                  failed (bank reason) — from the bank's
                                                  response file or keyed with evidence
                                                  ONE transaction per confirmation:
                                                  run → paid, line → paid,
                                                  CLEARING JE Dr 2040 / Cr <batch bank GL>,
                                                  bank_transactions debit, TDS s.192 row
◄── status visible (read-only) in Payroll ───  7 RECONCILE bank statement import → match on
                                                  UTR first, then amount+date; run shows
                                                  'reconciled' only when matched (PD-10)
                                               9 EXCEPTIONS failed → returned to 'approved,
                                                  payment failed', re-batchable; returned
                                                  after paid → reversal JE + re-issue (§5)
```

## 3. States

**Payroll run** (`payroll_runs.status`, plus a separate `payment_status`):

| status | payment_status | Meaning |
|---|---|---|
| draft / pending | — | being prepared |
| approved | `unpaid` | owed; payslip released |
| approved | `in_batch` | on an authorised batch, not yet released |
| approved | `released` | file sent to the bank, awaiting confirmation |
| paid | `paid` | bank confirmed (UTR) |
| approved | `failed` | bank rejected or returned before credit; can be re-batched |
| paid | `returned` | credited then returned; reversal posted; re-issue pending |
| — | `reconciled` (flag + date, not a status) | matched to a bank statement line |
| on_hold | — | payment withheld (PD-11) |

**Salary batch:** `draft → authorised → released → partially_confirmed → confirmed` (all lines resolved) and `→ cancelled`. Cancellation is allowed only before release, and puts the lines' runs back to `unpaid`.

## 4. Controls (maker-checker)

| Step | Who | Must differ from |
|---|---|---|
| Prepare (generate) | `payroll:add` (HR / payroll_admin) | — |
| Approve payroll | `payroll:approve` (Finance, PD-2) | preparer (exists today) |
| Create salary batch | `payroll_payment:prepare` (Finance ops, e.g. accounts_exec) | — |
| Authorise batch | `payroll_payment:authorise` (finance_manager; admin per PD-3) | batch creator **and** payroll approver of any run in it (PD-5) |
| Release file | the authoriser or the creator (PD-8); the export is audited | — |
| Confirm paid / failed | `payroll_payment:confirm` (Finance ops) | authoriser (PD-5) |
| Reconcile | `finance:edit` (existing) | — |
| Reverse a returned payment | `finance:approve` + reason | confirmer |

- All comparisons use `users.id`, across every role held.
- A company with too few distinct authorised users is told so, with the list of eligible users (the pattern Finance batches already use), rather than the check being skipped.
- An emergency override is a decision (PD-12), never a silent bypass.

## 5. Evidence, failures and duplicates

| Case | Rule |
|---|---|
| **Paid** | Requires a bank reference (UTR, or the bank batch reference plus a line number per PD-9) and a value date. A UTR is unique per company: a reused UTR is refused. |
| **Amount** | The confirmed amount must equal the line amount (= the approved `net_pay` snapshot). Any difference is refused; a partial credit is recorded as `failed` plus an exception note (PD-7: no partial salary payments). |
| **Failed (not credited)** | Line → `failed` with the bank's reason. No journal (nothing left the bank). The run returns to `approved / failed` and appears in "to re-batch". |
| **Returned (after credit)** | Line → `returned`. A reversal of the clearing journal (Dr Bank / Cr 2040) is posted through `journal-entries/:id/reverse` (one reversal per entry, existing rule). A bank transaction credit is recorded. The run goes back to `approved / failed`. A re-issue is a new batch line linked to the original. |
| **Duplicate instruction** | A run can sit on at most one non-cancelled, non-failed line, enforced by a partial unique index. The bank file is generated once per release; a re-download returns the same file (hash) and is audited. |
| **Duplicate confirmation** | Confirming an already-paid line is idempotent: no second journal, and an audit "already paid". |
| **Mark Paid (current endpoint)** | Retired, or limited to recording a confirmation *with* a UTR against a batch line (PD-1). The bare status flip is removed. |
| **Account changed after the snapshot** | Release is refused if a beneficiary's master bank details differ from the snapshot, or have a pending bank-change request; the batch must be re-snapshotted and re-authorised. |

## 6. Accounting

| Event | Entry | Posting rule |
|---|---|---|
| Approval | accrual: Dr 5010 / 5011 / 5012 / 5014, Cr 2030 / 2031 / 2033 / 2003 / 2032 / loan accounts / 2040 | in the approval transaction, through `postEntry` + `postingGuards`; company-scoped accounts; refusal = approval refused (F-03, F-05, F-06) |
| Paid (confirmed) | clearing: Dr 2040 / Cr the GL account of the batch's bank account (not a generic 1001) | in the confirmation transaction; per line or per batch (PD-13); value date = bank value date |
| Returned after credit | reversal of the clearing entry | Finance reversal route; reason required |
| Payroll reopened after approval | not supported in PC-02 (PD-14); corrections go through arrears in a later period | — |

- **DB guard:** a unique index on `journal_entries (company_id, reference_type, reference_id) WHERE deleted_at IS NULL AND reversal_of_id IS NULL` for payroll reference types.
- **Manual `POST /accounting/payroll-journal`:** removed, or reduced to "post the missing accrual for approved period X", which takes no amounts (it recomputes from the runs) (F-04).
- **Exceptions register:** any posting that can't complete blocks the state change, and the reason is shown on the payroll period ("GL posting refused: period locked"). Nothing is console-only.

## 7. HR Payroll vs Finance

| Area | Owner | Notes |
|---|---|---|
| Inputs, generation, validation, payslip content | **HR Payroll** | drafts become stale on later input changes (F-12) |
| Payroll approval | **Finance** (PD-2) | payroll_admin approval removed if PD-2 is accepted |
| Accrual journal | system, at approval | Finance owns the accounts mapping |
| Payment batch, authorisation, bank file | **Finance** (extend `payment_batches` with `item_type='salary'`, `payroll_run_id`, beneficiary snapshot) | reuse the existing screens and bank formats |
| Bank confirmation, failures, returns | **Finance** | UTR evidence |
| Bank reconciliation | **Finance** (existing module) | salary lines appear as bank transactions |
| Payment status display | Payroll Center, read-only | "paid" / "reconciled" come from Finance |
| Statutory outputs (TDS 24Q, PF, ESI) | HR Payroll produces, Finance files | s.192 rows on confirmation |

## 8. Data model changes (for the implementation phase; not now)

- `payroll_runs`: `payment_status`, `paid_at`, `paid_by`, `value_date`, `payment_batch_item_id`, `reconciled_at`; validate the status check.
- `payment_batches` / `payment_batch_items`:
  - `item_type` (supplier | salary), `payroll_run_id` (FK);
  - beneficiary snapshot columns (name, account, IFSC);
  - `utr` (exists, made required at confirmation), `value_date`, `failure_reason`, `returned_at`;
  - `released_at` / `released_by`, `file_hash`;
  - a partial unique index (one live line per run).
- `journal_entries`: a unique reference index for payroll types (above).

## 9. Fixes needed before or with PC-02

| Fix | Findings |
|---|---|
| Accrual: company-scoped accounts, `postEntry` guards, atomic with approval | F-03, F-05, F-06 |
| Stop exposing raw bank account / PAN / UAN in the payroll list beyond `employee_bank:view` (mask) | F-08 |
| Encashment amount included in net pay, or encashment moved to the batch as its own line | F-12 |
| Finance batch: status gate on bank-file download, maker ≠ processor, UTR at processing | F-17 |
| Draft staleness when leave / attendance / encashment change a generated draft | F-12 |

## 10. Phasing (for planning)

| Phase | Content |
|---|---|
| **PC-02a** — integrity, no new workflow | atomic, guarded, company-scoped accrual; Mark Paid requires a reference and value date and posts its clearing in the same transaction (failure = not paid); records paid-by / paid-at; payer ≠ approver; DB journal uniqueness; manual payroll-journal route restricted; payroll list masks bank details |
| **PC-02b** — Finance salary batches | instruction → authorise → release (file once, hashed) → confirm with UTR → bank transaction; retire bare Mark Paid |
| **PC-02c** — exceptions and reconciliation | failed / returned / re-issue, reversal, reconciliation status in Payroll, UTR-first matching |

Each phase needs: migrations (snapshot dev first, because the dev server auto-applies migrations), tests that fail on the old code, and isolated test-DB runs only.
