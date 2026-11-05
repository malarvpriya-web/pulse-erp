# PC-02 — Payroll Payment Control: Decision Register

**Date:** 04 Nov 2026 · **Status:** awaiting management decisions; nothing implemented · References: audit findings (F-nn) in `PAYROLL_PC02_PAYMENT_CONTROL_AUDIT.md`, design sections (§n) in `PAYROLL_PC02_PAYMENT_CONTROL_DESIGN.md`.

Each decision lists the options, a **recommended** option and what it implies. Implementation starts only after the decisions it depends on are recorded.

| ID | Decision | Options | Recommended | Implications |
|---|---|---|---|---|
| **PD-1** | What happens to today's per-employee **Mark Paid**? | A. Keep as is (status flip). B. Keep, but require a UTR and value date, post the clearing journal in the same transaction, and require payer ≠ approver (PC-02a). C. Retire it; payment only through Finance salary batches (PC-02b). | **B now, then C** | B closes F-01, F-02 and F-11 quickly, with little UI change. C needs the batch build. Until C, the evidence is keyed in by hand. |
| **PD-2** | Who **approves payroll**? | A. Keep today's set (admin, super_admin, payroll_admin, finance_manager). B. Finance and the administrators only: remove `payroll:approve` from payroll_admin. | **B** | Matches PC-01 D1 (Finance approves). HR still prepares. A one-row matrix change; companies where payroll_admin approves today need a Finance approver. |
| **PD-3** | Can **admin / super_admin authorise or confirm payments**? | A. No (finance_manager only, as today). B. Yes, under the same maker-checker rules. C. Only as an audited emergency path (PD-12). | **B** | Removes the single-payer dependency (F-14). The administrators are already trusted with payroll approval. |
| **PD-4** | Which **roles** prepare, authorise and confirm salary batches? | A. All finance_manager. B. Prepare: accounts_exec / finance; authorise: finance_manager (+ admin per PD-3); confirm: accounts_exec / finance. | **B** | Needs three new actions under `payroll_payment` (prepare / authorise / confirm); replaces the temporary PC-01 rule. |
| **PD-5** | How strict is **segregation**? | A. Preparer ≠ approver only (today). B. Also authoriser ≠ batch creator, authoriser ≠ payroll approver, confirmer ≠ authoriser. | **B** | Needs at least three distinct Finance users plus one HR preparer per company. Smaller companies need PD-12. |
| **PD-6** | When are **payslips released** to employees? | A. At approval (today). B. At payment confirmation. | **A** (and label "approved, payment pending" until paid) | Employees see what is owed on time. B delays payslips by the bank cycle and couples HR self-service to Finance. |
| **PD-7** | Are **partial salary payments** allowed? | A. No: a line is paid in full or failed. B. Yes, split lines with a balance carried. | **A** | Simpler control and journal. Genuine splits (two accounts) are a separate feature, if ever needed. |
| **PD-8** | **Bank file** handling | A. Client-side CSV (today). B. Server-generated once per release from the frozen batch, with a hash, an export audit and an identical re-download; the browser export is removed. | **B** | Closes F-07 and F-23. Finance's existing bank formats are reused. |
| **PD-9** | What counts as **payment evidence**? | A. A UTR per employee line. B. A bank batch reference plus the bank's response file (line-level status). C. Either, with the response file preferred. | **C** | Some banks give a UTR per line only in the response file. Keying in UTRs by hand is the fallback, with duplicate-UTR refusal. |
| **PD-10** | Does **"reconciled"** gate anything? | A. Informational only. B. Required before the payroll period can close or be archived. | **B** (period close only) | Keeps payment fast; reconciliation becomes a period-close control, not a payment blocker. |
| **PD-11** | **Payment holds** for individual employees (absconding, F&F dispute, account unverified) | A. None. B. `on_hold` at batch creation with a reason, released by Finance. | **B** | Uses the existing `on_hold` status; ties in with HR containment (F&F stays suspended). |
| **PD-12** | **Small-company / emergency** path when there aren't enough distinct users | A. None: payment waits. B. An audited override by super_admin with a reason, flagged for review. | **B** | Avoids missed salary dates; every override is reportable. |
| **PD-13** | **Clearing journal** granularity | A. One journal per employee line (today). B. One per confirmed batch, with lines per employee. | **B** | Fewer entries, and it matches the bank's single debit. Per-employee detail stays on the batch lines. |
| **PD-14** | **Reopening an approved period** | A. Not allowed; corrections through arrears in a later period. B. Allowed by Finance with accrual reversal. | **A** for PC-02 | Avoids reversing payslips that were already released. B can be a later item. |
| **PD-15** | **Manual payroll-journal route** (`POST /accounting/payroll-journal`) | A. Keep (amounts from the request). B. Restrict to "post the missing accrual for approved period X", recomputed, no amounts accepted. C. Remove. | **B** | Keeps a recovery path for F-03 without arbitrary amounts (F-04). |
| **PD-16** | **Bank details in the payroll list** | A. Keep full numbers for every `payroll:view` holder. B. Mask unless `employee_bank:view`; full numbers only in the authorised bank file. | **B** | Closes F-08. Finance sees the full numbers only where it needs them (the batch / bank file). |
| **PD-17** | **Leave encashment in payroll** (approved amounts are not paid today, F-12) | A. Add the encashment to the run's earnings and net pay. B. Pay encashment as its own salary-batch line, outside the payslip. | **A** | Taxed and accrued with salary. Needs PC-01 R-1 (encashment approval) resolved first. |
| **PD-18** | **Existing data** before go-live | A. No migration (dev has no approved or paid runs). B. Back-fill payment states for historical paid runs in other environments. | **A** for dev; **B** decided per environment | Dev has 35 pending runs and no journals, so nothing needs migrating there. |

## Dependencies

- **PC-02a** (integrity) needs PD-1 (B), PD-2, PD-3, PD-15 and PD-16.
- **PC-02b** (batches) needs PD-4, PD-5, PD-8, PD-9, PD-11, PD-12 and PD-13.
- **PC-02c** (exceptions and reconciliation) needs PD-7, PD-10 and PD-14.
- PD-17 depends on PC-01 R-1.
