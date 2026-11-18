# Decision note — September 2026 payroll drafts 43, 44, 53, 54

**For:** Management (payroll owner). **From:** Payroll/ERP review, 28 Oct 2026. **Status:** awaiting decision. Nothing has been changed.

## Decision required

Should September 2026 be treated as **not a valid payroll period** for EMP001, EMP002, EMP003 and EMP005? If yes, remove their four unapproved drafts using the targeted correction below.

## Evidence that September is not a valid payroll period for these four

| Evidence | Detail |
|---|---|
| **No salary record for September** | EMP001, EMP002 and EMP003 each have one salary record, created on 20 Oct 2026 and effective from 20 Oct 2026. EMP005 has no salary record at all. None of the four has a salary record effective by 30 Sep, so payroll marks all four ineligible for September (reason E5). |
| **No attendance** | There are no September attendance records or attendance summaries for any of the four. |
| **Payroll never went live** | Manifest has never approved or paid a payroll. All 35 real runs are drafts. |
| **Release check failing** | The September payroll release check is not ready, with 8 open blockers: jurisdiction unconfirmed, a mid-month PF ceiling change, two rule decisions, and four unverified rule sets. |
| **Deductions come from demo data** | Each draft deducts a demo (seed) loan in full: ₹1,25,000, ₹1,62,500, ₹2,00,000 and ₹2,75,000, ₹7,62,500 in total. These loans were created by the test-data seeder on 20 Aug 2026. They are marked as test data and have never had a repayment. |
| **Internally impossible figures** | For drafts 53 (EMP005) and 54 (EMP003), deductions exceed gross pay by ₹1,51,843 and ₹89,925, yet the stored net pay is ₹0. |
| **Test-activity context** | All four drafts were created in a single Run Payroll on 30 Sep 2026 at 19:24 (audit entry 72403, superadmin@manifest.in), alongside heavy test activity that day. EMP005 is a test record ("Test1 sdas"). |

**Status of the drafts:** none of them was approved or paid. None has a journal entry, a tax deduction record, an emailed payslip or a loan repayment. Approval is currently impossible anyway: no one is recorded as having prepared them, and their loan figures fail the approval check.

## Proposed targeted correction and its exact impact

**Action:** run Run Payroll for **September 2026** four times, once for each employee (`employee_id` 1, 2, 3, 5). Never run it company-wide.

**What it does:** payroll finds the employee ineligible and deletes that employee's **pending** September draft, in one transaction.

| Changes | Does not change |
|---|---|
| Deletes payroll runs 43, 44, 53 and 54 (draft status only) | Loans 21–25 and their balances |
| | Repayments: there are none, and none are created |
| | Journals: there are none, and none are created |
| | Any other employee's September draft. The other 28 stay as they are. |
| | Any approved or paid payroll: there is none |
| | Salary records, attendance, employee records |

⚠ **Do not run September company-wide.** It would delete 29 of the 32 September drafts and recompute 3. One of the three, EMP038, comes out at an implausible net pay of ₹13,52,543.

## Audit history after the correction

**What remains:**
- Audit entry **72403**, which records that the original September run created 32 drafts.
- One new audit entry per targeted run, recording who ran it, when, the month and employee, and "0 generated, 1 skipped".
- The seed loans 21–25, unchanged, so the source of the deducted amounts stays traceable.
- `PAYROLL_DATA_FLOW_AUDIT.md` Parts 13–14.

**What would be lost without a snapshot:** the new audit entries record counts only. They do **not** keep the deleted drafts' ids or amounts, and nothing else in the system keeps a copy. **A before-snapshot of the four rows is therefore required**: a full export of payroll runs 43, 44, 53 and 54, stored with this note and referenced in the audit trail, before any deletion.

## Alternative

If September **is** a real pay month for these four, do not delete anything yet. HR must first record their real September salaries and attendance, and the release blockers must be cleared. Only then should the four drafts be regenerated; each would come out with a ₹0 loan deduction. A different user would then approve them.

## Safest next action

1. Decide: September invalid (targeted correction) or valid (alternative).
2. If it is invalid: take and store the snapshot first. Then run the four targeted runs. Then verify that the four rows are gone, the other 28 are unchanged, and loans, repayments and journals are unchanged.
