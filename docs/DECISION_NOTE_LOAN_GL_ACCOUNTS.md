# Decision note: GL accounts for employee loans and salary advances

**For:** Finance (finance:approve holder). **From:** Payroll/ERP review, 28 Oct 2026. **Status:** awaiting decision. No mapping is configured.

## Why a decision is needed now

Pulse now refuses to approve any payroll batch that recovers an employee loan or advance until Finance approves three accounts. Manifest has **no real loans today**, so nothing is blocked yet. The first real loan, however, will block that month's payroll approval until this is decided.

Once decided, the mapping is saved **only through the API call `PUT /finance/accounting/loan-gl-mapping`**, made by a user with `finance:approve` permission. **There is no screen for this setting in Pulse.** Pulse checks that each account exists, is active and is the right type, and records who approved it and when.

## Decisions required

| # | Decision | Required? | Candidates in the current chart of accounts |
|---|---|---|---|
| 1 | **Receivable**: the asset that holds what employees owe | Yes | `1013` Employee Advances (Asset). This is the only fitting account; no separate staff-loan account exists. |
| 2 | **Interest income**: revenue for interest on employee loans | Yes | `4006` Interest Income; `4005` / `4003` Other Income |
| 3 | **Disbursement**: the account a loan is paid out from | Recorded now, posting not built | `1120` Bank Account; `1001` Cash & Bank; `1110` Cash |

**Policy questions:**
- **a.** Should loans and salary advances share one receivable, or should a separate *Staff Loans* account be opened?
- **b.** Does creating a loan in Pulse mean the money has been paid? If not, which event or document triggers the disbursement entry?
- **c.** Should Pulse post disbursements automatically (a build item), or will Finance post them manually?
- **d.** Is interest on salary advances ever charged? Pulse treats advances as interest-free unless a rate is entered.

## Proposed accounting entries

The example uses a ₹60,000 loan at 12% p.a. over 12 months, with an EMI of ₹5,331. "Receivable", "Interest income" and "Bank" mean the accounts Finance chooses above.

**A. Loan paid out (not yet posted by Pulse; needs decision 3 and question b)**

| Account | Dr | Cr |
|---|---|---|
| Receivable | 60,000.00 | |
| Bank | | 60,000.00 |

**B. Monthly recovery through payroll.** Posted automatically when payroll is approved, as part of the payroll journal. Month 1: interest 60,000 × 1% = ₹600, principal ₹4,731.

| Account | Dr | Cr |
|---|---|---|
| Salaries & Wages (`5010`) | gross pay | |
| Statutory payables (PF, ESI, TDS, PT, LWF) | | as computed |
| Receivable | | 4,731.00 |
| Interest income | | 600.00 |
| Salary Payable (`2040`) | | net pay |

Net pay is already reduced by the full ₹5,331. Principal and interest come from the repayment record payroll writes, and Pulse refuses to post any entry that does not balance.

**C. Prepayment received from the employee outside payroll (not posted by Pulse today)**

| Account | Dr | Cr |
|---|---|---|
| Bank | amount | |
| Receivable | | amount |

**D. Balance waived (management-approved write-off; not posted by Pulse today)**

| Account | Dr | Cr |
|---|---|---|
| Expense (Finance to name, e.g. staff welfare or bad debts) | amount | |
| Receivable | | amount |

C and D are recorded in Pulse's loan register only. Finance should decide whether they are posted manually or added to Pulse.

**Net effect over the loan's life:** the receivable rises by ₹60,000 on payout (A) and falls by ₹60,000 through recoveries (B). Interest income totals ₹3,972, and the employee repays ₹63,972. Until entry A is posted, the receivable will show a **credit** balance equal to the principal recovered.

## Safest next actions

1. Finance answers decisions 1–2 and questions a–d.
2. A user with `finance:approve` saves the mapping via `PUT /finance/accounting/loan-gl-mapping` (no screen exists). Do this before the first real loan's first payroll month.
3. If entries A, C or D are to be automated, raise them as a separate build item.
